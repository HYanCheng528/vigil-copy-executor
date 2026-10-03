import {
  ChannelCredentials,
  Client,
  Metadata,
  status,
  type ClientReadableStream,
  type MethodDefinition,
} from "@grpc/grpc-js";
import { Transaction, getAddress, hexlify } from "ethers";
import { parse, type Type } from "protobufjs";
import {
  BSC_CHAIN_ID,
  ED_TARGET_ADDRESS,
  EXECUTION_SIGNAL_VERSION,
  KNOWN_BUILDER_TIP_RECIPIENTS,
  KUZUO_TARGET_ADDRESS,
  brandSourceVerifiedTargetSignal,
  type HexString,
  type TargetSignal,
  type TargetStrategy,
  type TargetTransactionWire,
} from "./core/messages.js";
import { GMGN_ROUTER_ADDRESS, GMGN_SWAP_SELECTOR } from "./core/gmgn-calldata.js";

/** Official Tokyo endpoint documented for the BSC Public Mempool stream. */
export const BLOCKRAZOR_PUBLIC_MEMPOOL_TOKYO_ENDPOINT = "63.254.162.18:50051";

const MAX_GRPC_MESSAGE_BYTES = 1_048_576;
const MAX_RAW_TRANSACTION_BYTES = 262_144;
const PREDECESSOR_TTL_NS = 10_000_000_000n;
// Feed-local out-of-order retention only; this is not a signed-transaction,
// Builder bundle, block, or rolling-dispatch validity window.
const ORPHAN_TARGET_TTL_NS = PREDECESSOR_TTL_NS;
const PREDECESSOR_CAPACITY = 64;
const ORPHAN_TARGET_CAPACITY = 64;
const WALL_CLOCK_OFFSET_NS = (BigInt(Date.now()) * 1_000_000n) - process.hrtime.bigint();

/*
 * Audited against BlockRazor's official relay.proto on 2026-08-08:
 * https://github.com/BlockRazorinc/relay_example/blob/main/protobuf/relay.proto
 *
 * Only the Public Mempool method and the messages on its wire path are embedded
 * here. Keeping the schema in the executable avoids a runtime .proto lookup and
 * makes the deployed dist directory self-contained.
 */
const PUBLIC_MEMPOOL_PROTO = `
syntax = "proto3";
package blockchain;

service Gateway {
  rpc NewTxs (TxsRequest) returns (stream TxsReply) {}
}

message TxsRequest {
  bool node_validation = 1;
}

message Tx {
  bytes from = 1;
  int64 timestamp = 2;
  bytes raw_tx = 3;
}

message TxsReply {
  Tx tx = 1;
}
`;

export interface RelayTxsRequest {
  nodeValidation: false;
}

export interface RelayTransaction {
  from: Uint8Array;
  timestamp: string;
  rawTx: Uint8Array;
}

export interface RelayTxsReply {
  tx?: RelayTransaction;
}

const relayRoot = parse(PUBLIC_MEMPOOL_PROTO).root;
const requestType = relayRoot.lookupType("blockchain.TxsRequest") as Type;
const replyType = relayRoot.lookupType("blockchain.TxsReply") as Type;

function serializeRequest(value: RelayTxsRequest): Buffer {
  if (value.nodeValidation !== false) {
    throw new Error("BlockRazor Public Mempool requires node_validation=false");
  }
  return Buffer.from(requestType.encode(requestType.fromObject({ nodeValidation: false })).finish());
}

function deserializeRequest(bytes: Buffer): RelayTxsRequest {
  const decoded = requestType.toObject(requestType.decode(bytes), { defaults: true }) as {
    nodeValidation?: unknown;
  };
  if (decoded.nodeValidation !== false) {
    throw new Error("BlockRazor request attempted node validation");
  }
  return { nodeValidation: false };
}

function serializeReply(value: RelayTxsReply): Buffer {
  const message = value.tx
    ? {
        tx: {
          from: value.tx.from,
          timestamp: value.tx.timestamp,
          rawTx: value.tx.rawTx,
        },
      }
    : {};
  return Buffer.from(replyType.encode(replyType.fromObject(message)).finish());
}

function deserializeReply(bytes: Buffer): RelayTxsReply {
  const decoded = replyType.toObject(replyType.decode(bytes), {
    bytes: Buffer,
    longs: String,
    defaults: false,
  }) as {
    tx?: { from?: unknown; timestamp?: unknown; rawTx?: unknown };
  };
  if (!decoded.tx) return {};
  return {
    tx: {
      from: Buffer.isBuffer(decoded.tx.from) ? decoded.tx.from : new Uint8Array(),
      timestamp: typeof decoded.tx.timestamp === "string" ? decoded.tx.timestamp : "0",
      rawTx: Buffer.isBuffer(decoded.tx.rawTx) ? decoded.tx.rawTx : new Uint8Array(),
    },
  };
}

/** Exported so loopback tests can exercise the exact production gRPC codec. */
export const BLOCKRAZOR_GATEWAY_NEW_TXS_METHOD: MethodDefinition<RelayTxsRequest, RelayTxsReply> = {
  path: "/blockchain.Gateway/NewTxs",
  requestStream: false,
  responseStream: true,
  requestSerialize: serializeRequest,
  requestDeserialize: deserializeRequest,
  responseSerialize: serializeReply,
  responseDeserialize: deserializeReply,
  originalName: "NewTxs",
};

export interface BlockRazorTargetAddresses {
  ed: string;
  kuzuo: string;
}

const DEFAULT_TARGET_ADDRESSES: BlockRazorTargetAddresses = {
  ed: ED_TARGET_ADDRESS,
  kuzuo: KUZUO_TARGET_ADDRESS,
};

type TargetMap = ReadonlyMap<string, TargetStrategy>;

export type BlockRazorRawInspection =
  | { kind: "ignore"; reason: "not_candidate" | "unsupported_envelope" | "unmonitored_sender" }
  | { kind: "predecessor"; strategy: "kuzuo"; transaction: TargetTransactionWire }
  | { kind: "target"; strategy: TargetStrategy; transaction: TargetTransactionWire };

function normalizedTargetMap(addresses: BlockRazorTargetAddresses): TargetMap {
  return new Map([
    [getAddress(addresses.ed).toLowerCase(), "ed"],
    [getAddress(addresses.kuzuo).toLowerCase(), "kuzuo"],
  ]);
}

function rawHex(raw: Uint8Array | HexString): HexString {
  const encoded = typeof raw === "string" ? raw : hexlify(raw);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(encoded)) {
    throw new Error("BlockRazor raw_tx is not complete hexadecimal bytes");
  }
  const byteLength = (encoded.length - 2) / 2;
  if (byteLength < 1 || byteLength > MAX_RAW_TRANSACTION_BYTES) {
    throw new Error("BlockRazor raw_tx is outside the accepted size limit");
  }
  return encoded as HexString;
}

function wireFromParsed(
  transaction: Transaction,
  encoded: HexString,
): TargetTransactionWire {
  if (transaction.type !== 0 || transaction.chainId !== BigInt(BSC_CHAIN_ID)) {
    throw new Error("BlockRazor candidate is not an audited BSC legacy transaction");
  }
  if (!transaction.isSigned() || !transaction.hash || !transaction.from || !transaction.to) {
    throw new Error("BlockRazor candidate is not a fully signed transaction");
  }
  if (transaction.gasPrice === null) {
    throw new Error("BlockRazor legacy candidate is missing gasPrice");
  }
  if (transaction.serialized.toLowerCase() !== encoded.toLowerCase()) {
    throw new Error("BlockRazor raw_tx is not the canonical signed encoding");
  }
  if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0) {
    throw new Error("BlockRazor candidate nonce is unsafe");
  }
  const recoveredSender = getAddress(transaction.from);
  return {
    hash: transaction.hash as HexString,
    rawTransaction: encoded,
    chainId: BSC_CHAIN_ID,
    type: 0,
    from: recoveredSender,
    to: getAddress(transaction.to),
    nonce: transaction.nonce,
    gasPriceWei: transaction.gasPrice.toString(),
    gasLimit: transaction.gasLimit.toString(),
    valueWei: transaction.value.toString(),
    input: transaction.data as HexString,
  };
}

function parseRawTransaction(encoded: HexString): Transaction {
  try {
    return Transaction.from(encoded);
  } catch {
    throw new Error("BlockRazor raw_tx cannot be decoded as a signed EVM transaction");
  }
}

/**
 * Fully recovers a signed legacy transaction and verifies its canonical raw
 * envelope. This helper is intentionally strict and is useful for fixtures and
 * any future trusted raw source.
 */
export function blockRazorRawTransactionToWire(raw: Uint8Array | HexString): TargetTransactionWire {
  const encoded = rawHex(raw);
  return wireFromParsed(parseRawTransaction(encoded), encoded);
}

function inspectWithTargetMap(
  raw: Uint8Array | HexString,
  targets: TargetMap,
): BlockRazorRawInspection {
  const encoded = rawHex(raw);
  const parsed = parseRawTransaction(encoded);
  if (parsed.type !== 0 || parsed.chainId !== BigInt(BSC_CHAIN_ID)) {
    return { kind: "ignore", reason: "unsupported_envelope" };
  }

  // `to`, `data`, value and gas limit do not require sender recovery. Gate on
  // those cheap fields before touching `from`, so the global stream does not do
  // ECDSA recovery for every unrelated BSC transaction.
  const recipient = parsed.to?.toLowerCase() ?? null;
  const calldata = parsed.data.toLowerCase();
  const targetCandidate = recipient === GMGN_ROUTER_ADDRESS
    && calldata.slice(0, 10) === GMGN_SWAP_SELECTOR;
  const predecessorCandidate = recipient !== null
    && KNOWN_BUILDER_TIP_RECIPIENTS.has(recipient)
    && calldata === "0x"
    && parsed.gasLimit === 21_000n
    && parsed.value > 0n;
  if (!targetCandidate && !predecessorCandidate) {
    return { kind: "ignore", reason: "not_candidate" };
  }

  const transaction = wireFromParsed(parsed, encoded);
  const strategy = targets.get(transaction.from.toLowerCase());
  if (!strategy) return { kind: "ignore", reason: "unmonitored_sender" };
  if (targetCandidate) return { kind: "target", strategy, transaction };
  if (strategy === "kuzuo") return { kind: "predecessor", strategy, transaction };
  return { kind: "ignore", reason: "not_candidate" };
}

/** Pure local classifier used by the live adapter and deterministic tests. */
export function inspectBlockRazorRawTransaction(
  raw: Uint8Array | HexString,
  targetAddresses: BlockRazorTargetAddresses = DEFAULT_TARGET_ADDRESSES,
): BlockRazorRawInspection {
  return inspectWithTargetMap(raw, normalizedTargetMap(targetAddresses));
}

export interface BlockRazorPublicFeedMetrics {
  connected: boolean;
  connectionState: "stopped" | "connecting" | "streaming" | "backoff";
  reconnects: number;
  notifications: number;
  decodedMessages: number;
  invalidMessages: number;
  invalidTransactions: number;
  unsupportedTransactions: number;
  targetMatches: number;
  predecessorMatches: number;
  senderHintMismatches: number;
  senderFallbackRecoveries: number;
  lastError: string | null;
  lastMessageAt: string | null;
  lastTargetAt: string | null;
  lastTargetDecodeUs: number | null;
}

interface BlockRazorFeedCounters extends Omit<
  BlockRazorPublicFeedMetrics,
  "lastMessageAt" | "lastTargetAt"
> {}

export interface BlockRazorPublicFeedOptions {
  name: string;
  endpoint: string;
  apiKey: string;
  onTarget: (signal: TargetSignal, timing: {
    socketSeenMonoNs: bigint;
    parsedMonoNs: bigint;
    matchedMonoNs: bigint;
  }) => void;
  onState?: (name: string, metrics: BlockRazorPublicFeedMetrics) => void;
}

export interface BlockRazorPublicFeedDependencies {
  targetAddresses?: BlockRazorTargetAddresses;
  /** Deterministic loopback-test controls; production uses bounded defaults. */
  orphanTargetTtlNs?: bigint;
  orphanTargetCapacity?: number;
  monotonicNow?: () => bigint;
}

interface BlockRazorTargetTiming {
  socketSeenMonoNs: bigint;
  parsedMonoNs: bigint;
  matchedMonoNs: bigint;
}

interface BlockRazorOrphanTarget {
  generation: number;
  strategy: "kuzuo";
  transaction: TargetTransactionWire;
  timing: BlockRazorTargetTiming;
  expiresMonoNs: bigint;
}

function wallNsFor(monotonicNs: bigint): bigint {
  return WALL_CLOCK_OFFSET_NS + monotonicNs;
}

function isFresh(nowMonoNs: bigint, seenMonoNs: bigint, ttlNs: bigint): boolean {
  return nowMonoNs >= seenMonoNs && nowMonoNs - seenMonoNs <= ttlNs;
}

function grpcStatusName(code: number): string {
  switch (code) {
    case status.OK: return "OK";
    case status.CANCELLED: return "CANCELLED";
    case status.UNKNOWN: return "UNKNOWN";
    case status.INVALID_ARGUMENT: return "INVALID_ARGUMENT";
    case status.DEADLINE_EXCEEDED: return "DEADLINE_EXCEEDED";
    case status.NOT_FOUND: return "NOT_FOUND";
    case status.ALREADY_EXISTS: return "ALREADY_EXISTS";
    case status.PERMISSION_DENIED: return "PERMISSION_DENIED";
    case status.RESOURCE_EXHAUSTED: return "RESOURCE_EXHAUSTED";
    case status.FAILED_PRECONDITION: return "FAILED_PRECONDITION";
    case status.ABORTED: return "ABORTED";
    case status.OUT_OF_RANGE: return "OUT_OF_RANGE";
    case status.UNIMPLEMENTED: return "UNIMPLEMENTED";
    case status.INTERNAL: return "INTERNAL";
    case status.UNAVAILABLE: return "UNAVAILABLE";
    case status.DATA_LOSS: return "DATA_LOSS";
    case status.UNAUTHENTICATED: return "UNAUTHENTICATED";
    default: return "UNRECOGNIZED";
  }
}

function sanitizedGrpcError(error: unknown): string {
  const candidate = error as { code?: unknown } | null;
  const code = typeof candidate?.code === "number" ? candidate.code : status.UNKNOWN;
  // Do not retain server details: an upstream can echo request metadata, and
  // provider credentials must never enter status JSON or logs.
  return "grpc_" + grpcStatusName(code);
}

/**
 * Persistent BlockRazor BSC Public Mempool client. It never sends a transaction
 * and its only RPC is the documented server-streaming Gateway/NewTxs method.
 */
export class BlockRazorPublicMempoolFeed {
  private client: Client | null = null;
  private stream: ClientReadableStream<RelayTxsReply> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private generation = 0;
  private sequence = 0;
  private reconnectDelayMs = 250;
  private lastMessageUnixMs: number | null = null;
  private lastTargetUnixMs: number | null = null;
  private readonly targetMap: TargetMap;
  private readonly predecessors = new Map<string, { wire: TargetTransactionWire; seenMonoNs: bigint }>();
  private readonly orphanTargets = new Map<string, BlockRazorOrphanTarget>();
  private readonly emittedTargetHashes = new Set<string>();
  private readonly orphanTargetTtlNs: bigint;
  private readonly orphanTargetCapacity: number;
  private readonly monotonicNow: () => bigint;
  private readonly counters: BlockRazorFeedCounters = {
    connected: false,
    connectionState: "stopped",
    reconnects: 0,
    notifications: 0,
    decodedMessages: 0,
    invalidMessages: 0,
    invalidTransactions: 0,
    unsupportedTransactions: 0,
    targetMatches: 0,
    predecessorMatches: 0,
    senderHintMismatches: 0,
    senderFallbackRecoveries: 0,
    lastError: null,
    lastTargetDecodeUs: null,
  };

  constructor(
    private readonly options: BlockRazorPublicFeedOptions,
    dependencies: BlockRazorPublicFeedDependencies = {},
  ) {
    if (!options.name.trim()) throw new Error("BlockRazor feed name is required");
    if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):[1-9][0-9]{0,4}$/.test(options.endpoint)) {
      throw new Error("BlockRazor endpoint must be a host:port without a URL scheme");
    }
    const port = Number(options.endpoint.slice(options.endpoint.lastIndexOf(":") + 1));
    if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("BlockRazor endpoint port is invalid");
    if (!/^[\x21-\x7e]{8,512}$/.test(options.apiKey)) {
      throw new Error("BlockRazor apiKey must be 8-512 visible ASCII characters");
    }
    this.targetMap = normalizedTargetMap(dependencies.targetAddresses ?? DEFAULT_TARGET_ADDRESSES);
    this.orphanTargetTtlNs = dependencies.orphanTargetTtlNs ?? ORPHAN_TARGET_TTL_NS;
    if (this.orphanTargetTtlNs <= 0n || this.orphanTargetTtlNs > PREDECESSOR_TTL_NS) {
      throw new Error("BlockRazor orphan target TTL must be positive and no longer than the predecessor TTL");
    }
    this.orphanTargetCapacity = dependencies.orphanTargetCapacity ?? ORPHAN_TARGET_CAPACITY;
    if (!Number.isSafeInteger(this.orphanTargetCapacity) || this.orphanTargetCapacity < 1
      || this.orphanTargetCapacity > 1_024) {
      throw new Error("BlockRazor orphan target capacity must be an integer between 1 and 1024");
    }
    this.monotonicNow = dependencies.monotonicNow ?? (() => process.hrtime.bigint());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.metricsTimer = setInterval(() => this.publishState(), 1_000);
    this.metricsTimer.unref();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.resetTargetCorrelationState();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.reconnectTimer = null;
    this.metricsTimer = null;
    this.stream?.cancel();
    this.stream = null;
    this.client?.close();
    this.client = null;
    this.counters.connected = false;
    this.counters.connectionState = "stopped";
    this.publishState();
  }

  snapshot(): BlockRazorPublicFeedMetrics {
    return {
      ...this.counters,
      lastMessageAt: this.lastMessageUnixMs === null ? null : new Date(this.lastMessageUnixMs).toISOString(),
      lastTargetAt: this.lastTargetUnixMs === null ? null : new Date(this.lastTargetUnixMs).toISOString(),
    };
  }

  private connect(): void {
    const generation = ++this.generation;
    this.resetTargetCorrelationState();
    this.counters.connected = false;
    this.counters.connectionState = "connecting";
    this.publishState();

    const client = new Client(this.options.endpoint, ChannelCredentials.createInsecure(), {
      "grpc.keepalive_time_ms": 10_000,
      "grpc.keepalive_timeout_ms": 2_000,
      "grpc.keepalive_permit_without_calls": 1,
      "grpc.initial_reconnect_backoff_ms": 250,
      "grpc.max_reconnect_backoff_ms": 5_000,
      "grpc.max_receive_message_length": MAX_GRPC_MESSAGE_BYTES,
      "grpc.max_send_message_length": 1_024,
    });
    this.client = client;
    client.waitForReady(Date.now() + 5_000, (readyError) => {
      if (this.stopped || generation !== this.generation) {
        client.close();
        return;
      }
      if (readyError) {
        this.scheduleReconnect(generation, sanitizedGrpcError(readyError));
        return;
      }

      const metadata = new Metadata();
      metadata.set("apiKey", this.options.apiKey);
      const stream = client.makeServerStreamRequest(
        BLOCKRAZOR_GATEWAY_NEW_TXS_METHOD.path,
        BLOCKRAZOR_GATEWAY_NEW_TXS_METHOD.requestSerialize,
        BLOCKRAZOR_GATEWAY_NEW_TXS_METHOD.responseDeserialize,
        { nodeValidation: false },
        metadata,
      );
      this.stream = stream;
      this.reconnectDelayMs = 250;
      this.counters.connected = true;
      this.counters.connectionState = "streaming";
      this.counters.lastError = null;
      this.publishState();

      let finished = false;
      const finish = (reason: string): void => {
        if (finished) return;
        finished = true;
        if (this.stopped || generation !== this.generation) return;
        this.scheduleReconnect(generation, reason);
      };
      stream.on("data", (reply) => {
        if (this.stopped || generation !== this.generation || this.stream !== stream) return;
        this.handleReply(reply, generation);
      });
      stream.on("error", (error) => finish(sanitizedGrpcError(error)));
      stream.on("end", () => finish("grpc_stream_ended"));
      stream.on("status", (result) => {
        if (result.code !== status.OK) finish("grpc_" + grpcStatusName(result.code));
      });
    });
  }

  private scheduleReconnect(generation: number, reason: string): void {
    if (this.stopped || generation !== this.generation) return;
    this.resetTargetCorrelationState();
    this.stream?.cancel();
    this.stream = null;
    this.client?.close();
    this.client = null;
    this.counters.connected = false;
    this.counters.connectionState = "backoff";
    this.counters.lastError = reason;
    this.counters.reconnects += 1;
    this.publishState();
    const delay = this.reconnectDelayMs + Math.floor(Math.random() * 100);
    this.reconnectDelayMs = Math.min(5_000, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref();
  }

  private handleReply(reply: RelayTxsReply, generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    const socketSeenMonoNs = this.monotonicNow();
    this.counters.notifications += 1;
    this.lastMessageUnixMs = Date.now();
    const raw = reply.tx?.rawTx;
    if (!(raw instanceof Uint8Array) || raw.byteLength === 0) {
      this.counters.invalidMessages += 1;
      return;
    }
    this.counters.decodedMessages += 1;

    // Parse the signed raw envelope first. inspectWithTargetMap checks chain,
    // recipient/calldata/value/gas before it ever touches Transaction.from, so
    // unrelated traffic still avoids ECDSA recovery. The relay proto's `from`
    // is untrusted metadata: it may be observed, but it can neither admit nor
    // reject a transaction and never participates in source verification.
    let inspection: BlockRazorRawInspection;
    try {
      inspection = inspectWithTargetMap(raw, this.targetMap);
    } catch {
      this.counters.invalidTransactions += 1;
      return;
    }
    const parsedMonoNs = this.monotonicNow();
    if (inspection.kind === "ignore") {
      if (inspection.reason === "unsupported_envelope") this.counters.unsupportedTransactions += 1;
      return;
    }
    let relaySender: string | undefined;
    const relayFrom = reply.tx?.from;
    if (relayFrom instanceof Uint8Array && relayFrom.byteLength === 20) {
      try {
        relaySender = getAddress(hexlify(relayFrom));
      } catch {
        relaySender = undefined;
      }
    }
    if (!relaySender) {
      this.counters.senderFallbackRecoveries += 1;
    } else if (relaySender.toLowerCase() !== inspection.transaction.from.toLowerCase()) {
      this.counters.senderHintMismatches += 1;
    }
    if (inspection.kind === "predecessor") {
      this.counters.predecessorMatches += 1;
      this.predecessors.set(
        inspection.transaction.from.toLowerCase() + ":" + String(inspection.transaction.nonce),
        { wire: inspection.transaction, seenMonoNs: socketSeenMonoNs },
      );
      this.pruneTargetCorrelationState(socketSeenMonoNs);
      this.recoverOrphanTarget(inspection.transaction, socketSeenMonoNs);
      return;
    }

    const matchedMonoNs = parsedMonoNs;
    const transaction = inspection.transaction;
    const timing = { socketSeenMonoNs, parsedMonoNs, matchedMonoNs };
    this.pruneTargetCorrelationState(socketSeenMonoNs);
    if (this.wasTargetEmitted(transaction)) return;
    const predecessor = inspection.strategy === "kuzuo"
      ? this.predecessors.get(transaction.from.toLowerCase() + ":" + String(transaction.nonce - 1))
      : undefined;
    const predecessorFresh = predecessor && isFresh(
      socketSeenMonoNs,
      predecessor.seenMonoNs,
      PREDECESSOR_TTL_NS,
    ) ? predecessor.wire : null;
    if (inspection.strategy === "kuzuo" && !predecessorFresh) {
      this.rememberOrphanTarget(transaction, timing);
      return;
    }
    this.emitTarget(inspection.strategy, transaction, timing, predecessorFresh, socketSeenMonoNs);
  }

  private rememberOrphanTarget(
    transaction: TargetTransactionWire,
    timing: BlockRazorTargetTiming,
  ): void {
    const key = transaction.from.toLowerCase() + ":" + String(transaction.nonce - 1);
    const existing = this.orphanTargets.get(key);
    this.orphanTargets.set(key, {
      generation: this.generation,
      strategy: "kuzuo",
      transaction,
      timing,
      expiresMonoNs: existing?.generation === this.generation
        ? existing.expiresMonoNs
        : timing.socketSeenMonoNs + this.orphanTargetTtlNs,
    });
    this.trimOldest(this.orphanTargets, this.orphanTargetCapacity);
  }

  private recoverOrphanTarget(predecessor: TargetTransactionWire, nowMonoNs: bigint): void {
    const key = predecessor.from.toLowerCase() + ":" + String(predecessor.nonce);
    const orphan = this.orphanTargets.get(key);
    if (!orphan) return;
    if (orphan.generation !== this.generation || nowMonoNs > orphan.expiresMonoNs
      || predecessor.nonce + 1 !== orphan.transaction.nonce
      || predecessor.from.toLowerCase() !== orphan.transaction.from.toLowerCase()) {
      this.orphanTargets.delete(key);
      return;
    }
    this.orphanTargets.delete(key);
    this.emitTarget(orphan.strategy, orphan.transaction, orphan.timing, predecessor, nowMonoNs);
  }

  private emitTarget(
    strategy: TargetStrategy,
    transaction: TargetTransactionWire,
    timing: BlockRazorTargetTiming,
    predecessor: TargetTransactionWire | null,
    emittedMonoNs: bigint,
  ): void {
    if (this.wasTargetEmitted(transaction)) return;
    this.emittedTargetHashes.add(transaction.hash.toLowerCase());
    this.sequence += 1;
    // Planner entry stays ahead of state publication, date formatting, UI and
    // logs. This callback is the machine-first handoff.
    this.options.onTarget(brandSourceVerifiedTargetSignal({
      version: EXECUTION_SIGNAL_VERSION,
      source: "blockrazor_public_mempool",
      sourceSequence: this.options.name + ":" + String(this.sequence),
      firstSeenUnixNs: wallNsFor(timing.socketSeenMonoNs).toString(),
      firstSeenMonoNs: timing.socketSeenMonoNs.toString(),
      strategy,
      transaction,
      ...(predecessor ? { requiredPredecessors: [predecessor] } : {}),
      rawTransactionVerified: true,
      predecessorsVerified: true,
    }), timing);
    this.counters.targetMatches += 1;
    this.lastTargetUnixMs = Date.now();
    this.counters.lastTargetDecodeUs = Number(emittedMonoNs - timing.socketSeenMonoNs) / 1e3;
  }

  private wasTargetEmitted(transaction: TargetTransactionWire): boolean {
    return this.emittedTargetHashes.has(transaction.hash.toLowerCase());
  }

  private pruneTargetCorrelationState(nowMonoNs: bigint): void {
    for (const [key, entry] of this.predecessors) {
      if (!isFresh(nowMonoNs, entry.seenMonoNs, PREDECESSOR_TTL_NS)) this.predecessors.delete(key);
    }
    for (const [key, entry] of this.orphanTargets) {
      if (entry.generation !== this.generation || nowMonoNs > entry.expiresMonoNs) {
        this.orphanTargets.delete(key);
      }
    }
    this.trimOldest(this.predecessors, PREDECESSOR_CAPACITY);
    this.trimOldest(this.orphanTargets, this.orphanTargetCapacity);
  }

  private trimOldest<K, V>(map: Map<K, V>, capacity: number): void {
    while (map.size > capacity) {
      const oldest = map.keys().next();
      if (oldest.done) return;
      map.delete(oldest.value);
    }
  }

  private resetTargetCorrelationState(): void {
    this.predecessors.clear();
    this.orphanTargets.clear();
    this.emittedTargetHashes.clear();
  }

  private publishState(): void {
    this.options.onState?.(this.options.name, this.snapshot());
  }
}
