import { getAddress } from "ethers";
import {
  BSC_CHAIN_ID,
  ED_TARGET_ADDRESS,
  EXECUTION_SIGNAL_VERSION,
  KUZUO_TARGET_ADDRESS,
  brandSourceVerifiedTargetSignal,
  validateTargetSignal,
  type BlockRazorPrivateBundleContext,
  type BlockRazorPrivateRegion,
  type BlockRazorPrivateTransactionWire,
  type HexString,
  type TargetSignal,
  type TargetStrategy,
} from "./core/messages.js";
import { GMGN_ROUTER_ADDRESS, GMGN_SWAP_SELECTOR } from "./core/gmgn-calldata.js";

/**
 * Official region pairs. BlockRazor requires a private bundle to be submitted
 * to the same regional domain from which its SSE dependency was received.
 *
 * https://docs.blockrazor.io/streams/mempool/bsc/private-mempool
 */
export const BLOCKRAZOR_PRIVATE_REGIONS: Readonly<Record<
  BlockRazorPrivateRegion,
  { streamUrl: string; submitUrl: string }
>> = {
  tokyo: {
    streamUrl: "https://jp-bscscutum.blockrazor.xyz/stream",
    submitUrl: "https://jp-bscscutum.blockrazor.xyz",
  },
  "new-york": {
    streamUrl: "https://us-bscscutum.blockrazor.xyz/stream",
    submitUrl: "https://us-bscscutum.blockrazor.xyz",
  },
  frankfurt: {
    streamUrl: "https://ger-bscscutum.blockrazor.xyz/stream",
    submitUrl: "https://ger-bscscutum.blockrazor.xyz",
  },
  dublin: {
    streamUrl: "https://ire-bscscutum.blockrazor.xyz/stream",
    submitUrl: "https://ire-bscscutum.blockrazor.xyz",
  },
};

export const BLOCKRAZOR_PROXY_BID_SELECTOR = "0xbd69ffca";
export const GMGN_ROUTER_SWAP_TOPIC = "0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_SSE_BUFFER_BYTES = 1_048_576;
const MAX_CALLDATA_BYTES = 262_144;
const MAX_LOGS = 2_048;
const MAX_TOPICS_PER_LOG = 16;
const DEDUPE_TTL_NS = 86_400_000_000_000n;
const WALL_CLOCK_OFFSET_NS = (BigInt(Date.now()) * 1_000_000n) - process.hrtime.bigint();

type JsonObject = Record<string, unknown>;

export interface BlockRazorPrivateTargetMatch {
  strategy: TargetStrategy;
  transaction: BlockRazorPrivateTransactionWire;
  bundle: BlockRazorPrivateBundleContext;
}

export interface BlockRazorPrivateFeedMetrics {
  connected: boolean;
  connectionState: "stopped" | "connecting" | "streaming" | "backoff";
  reconnects: number;
  notifications: number;
  decodedEvents: number;
  invalidEvents: number;
  ignoredEvents: number;
  targetMatches: number;
  duplicateTargets: number;
  lastError: string | null;
  lastMessageAt: string | null;
  lastTargetAt: string | null;
  lastTargetDecodeUs: number | null;
}

interface PrivateFeedCounters extends Omit<
  BlockRazorPrivateFeedMetrics,
  "lastMessageAt" | "lastTargetAt"
> {}

export interface BlockRazorPrivateFeedOptions {
  name: string;
  region: BlockRazorPrivateRegion;
  streamUrl: string;
  token: string;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  onTarget: (signal: TargetSignal, timing: {
    socketSeenMonoNs: bigint;
    parsedMonoNs: bigint;
    matchedMonoNs: bigint;
  }) => void;
  onState?: (name: string, metrics: BlockRazorPrivateFeedMetrics) => void;
}

export interface BlockRazorPrivateFeedDependencies {
  fetchImpl?: typeof fetch;
  deduper?: BlockRazorPrivateFirstSeenDeduper;
  targetAddresses?: { ed: string; kuzuo: string };
  /** Test-only escape hatch; production configuration never sets this. */
  allowInsecureLoopback?: boolean;
}

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(field + " must be an object");
  }
  return value as JsonObject;
}

function hash(value: unknown, field: string): HexString {
  if (typeof value !== "string" || !HASH_RE.test(value)) throw new Error(field + " is not a hash");
  return value.toLowerCase() as HexString;
}

function address(value: unknown, field: string): string {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) throw new Error(field + " is not an address");
  const normalized = getAddress(value);
  if (normalized === "0x0000000000000000000000000000000000000000") {
    throw new Error(field + " must not be zero");
  }
  return normalized;
}

function safeUnsigned(value: unknown, field: string, allowZero = true): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && DECIMAL_RE.test(value)) {
    parsed = Number(value);
  } else {
    throw new Error(field + " is not an unsigned integer");
  }
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(field + " is outside the safe integer range");
  }
  return parsed;
}

function uint256Decimal(value: unknown, field: string): string {
  let parsed: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(field + " is not a safe unsigned integer");
    parsed = BigInt(value);
  } else if (typeof value === "string" && DECIMAL_RE.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new Error(field + " is not an unsigned integer");
  }
  if (parsed > MAX_UINT256) throw new Error(field + " exceeds uint256");
  return parsed.toString();
}

function hexValueToDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x(?:0|[0-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error(field + " is not a hexadecimal quantity");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) throw new Error(field + " exceeds uint256");
  return parsed.toString();
}

function calldata(value: unknown): HexString {
  if (typeof value !== "string" || !HEX_RE.test(value) || value.length < 10) {
    throw new Error("private tx calldata is invalid");
  }
  if ((value.length - 2) / 2 > MAX_CALLDATA_BYTES) throw new Error("private tx calldata is too large");
  return value.toLowerCase() as HexString;
}

function addressTopic(value: string): string {
  return "0x" + "0".repeat(24) + value.slice(2).toLowerCase();
}

function validateLogs(value: unknown, targetSender: string): number {
  if (!Array.isArray(value) || value.length > MAX_LOGS) throw new Error("private tx logs are invalid");
  const expectedTargetTopic = addressTopic(targetSender);
  let matchingRouterSwap = false;
  for (const [logIndex, entry] of value.entries()) {
    const log = object(entry, `logs[${String(logIndex)}]`);
    const logAddress = address(log.address, `logs[${String(logIndex)}].address`);
    if (!Array.isArray(log.topics) || log.topics.length > MAX_TOPICS_PER_LOG) {
      throw new Error("private tx log topics are invalid");
    }
    for (const topic of log.topics) hash(topic, "private tx log topic");
    if (typeof log.data !== "string" || !HEX_RE.test(log.data)) {
      throw new Error("private tx log data is invalid");
    }
    if (logAddress.toLowerCase() === GMGN_ROUTER_ADDRESS
      && typeof log.topics[0] === "string"
      && typeof log.topics[1] === "string"
      && typeof log.topics[2] === "string"
      && log.topics[0].toLowerCase() === GMGN_ROUTER_SWAP_TOPIC
      && log.topics[1].toLowerCase() === expectedTargetTopic
      && log.topics[2].toLowerCase() === expectedTargetTopic) {
      matchingRouterSwap = true;
    }
  }
  if (!matchingRouterSwap) throw new Error("private target lacks a matching GMGN Router Swap log");
  return value.length;
}

function normalizedTargets(addresses: { ed: string; kuzuo: string }): Map<string, TargetStrategy> {
  return new Map([
    [getAddress(addresses.ed).toLowerCase(), "ed"],
    [getAddress(addresses.kuzuo).toLowerCase(), "kuzuo"],
  ]);
}

/**
 * Strictly validates a disclosed bundle and returns only complete GMGN target
 * transactions. No signed raw transaction or gas envelope is synthesized.
 */
export function inspectBlockRazorPrivateBundle(
  payload: unknown,
  region: BlockRazorPrivateRegion,
  targetAddresses = { ed: ED_TARGET_ADDRESS, kuzuo: KUZUO_TARGET_ADDRESS },
): BlockRazorPrivateTargetMatch[] {
  const bundle = object(payload, "private bundle");
  if (!(bundle.chainID === String(BSC_CHAIN_ID) || bundle.chainID === BSC_CHAIN_ID)) {
    throw new Error("private bundle is not BSC");
  }
  const bundleHash = hash(bundle.hash, "private bundle hash");
  const nextBlockNumber = safeUnsigned(bundle.nextBlockNumber, "nextBlockNumber", false);
  const maxBlockNumber = safeUnsigned(bundle.maxBlockNumber, "maxBlockNumber", false);
  if (maxBlockNumber < nextBlockNumber) throw new Error("private bundle block window is inverted");
  const proxyBidContract = address(bundle.proxyBidContract, "proxyBidContract");
  const refundAddress = address(bundle.refundAddress, "refundAddress");
  const refundCfg = uint256Decimal(bundle.refundCfg, "refundCfg");
  if (!Array.isArray(bundle.txs) || bundle.txs.length < 1 || bundle.txs.length > 50) {
    throw new Error("private bundle tx count is invalid");
  }

  const targets = normalizedTargets(targetAddresses);
  const matches: BlockRazorPrivateTargetMatch[] = [];
  for (const [index, candidate] of bundle.txs.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const tx = candidate as JsonObject;
    if (typeof tx.from !== "string") continue;
    let sender: string;
    try {
      sender = getAddress(tx.from);
    } catch {
      continue;
    }
    const strategy = targets.get(sender.toLowerCase());
    if (!strategy) continue;

    const recipient = address(tx.to, "private tx to");
    const input = calldata(tx.calldata);
    if (recipient.toLowerCase() !== GMGN_ROUTER_ADDRESS || input.slice(0, 10) !== GMGN_SWAP_SELECTOR) {
      continue;
    }
    if (typeof tx.functionSelector !== "string" || !SELECTOR_RE.test(tx.functionSelector)
      || tx.functionSelector.toLowerCase() !== GMGN_SWAP_SELECTOR
      || tx.functionSelector.toLowerCase() !== input.slice(0, 10)) {
      throw new Error("private tx functionSelector does not match calldata");
    }
    const transaction: BlockRazorPrivateTransactionWire = {
      disclosure: "blockrazor_private",
      hash: hash(tx.hash, "private tx hash"),
      chainId: BSC_CHAIN_ID,
      from: sender,
      to: recipient,
      nonce: safeUnsigned(tx.nonce, "private tx nonce"),
      valueWei: hexValueToDecimal(tx.value, "private tx value"),
      input,
      functionSelector: tx.functionSelector.toLowerCase() as HexString,
      logCount: validateLogs(tx.logs, sender),
    };
    matches.push({
      strategy,
      transaction,
      bundle: {
        bundleHash,
        region,
        nextBlockNumber,
        maxBlockNumber,
        proxyBidContract,
        refundAddress,
        refundCfg,
        targetIndex: index,
        transactionCount: bundle.txs.length,
        logsVerified: true,
        routerSwapVerified: true,
      },
    });
  }
  return matches;
}

/** Bounded process-local first-wins dedupe shared by all configured regions. */
export class BlockRazorPrivateFirstSeenDeduper {
  private readonly targets = new Map<string, bigint>();

  claim(targetHash: string, seenMonoNs: bigint): boolean {
    const key = targetHash.toLowerCase();
    if (this.targets.has(key)) return false;
    this.targets.set(key, seenMonoNs);
    if (this.targets.size > 5_000) {
      for (const [hashKey, firstSeen] of this.targets) {
        if (seenMonoNs - firstSeen > DEDUPE_TTL_NS) this.targets.delete(hashKey);
      }
    }
    return true;
  }
}

/** Minimal bounded SSE decoder with support for chunk splits and multiline data. */
export class SseDataDecoder {
  private buffer = "";
  private readonly dataLines: string[] = [];
  private dataBytes = 0;

  push(chunk: string): string[] {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_SSE_BUFFER_BYTES) throw new Error("SSE line buffer exceeded limit");
    const events: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.dataLines.length > 0) events.push(this.dispatch());
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") {
        this.dataBytes += Buffer.byteLength(value) + 1;
        if (this.dataBytes > MAX_SSE_BUFFER_BYTES) throw new Error("SSE event exceeded limit");
        this.dataLines.push(value);
      }
    }
    return events;
  }

  private dispatch(): string {
    const value = this.dataLines.join("\n");
    this.dataLines.length = 0;
    this.dataBytes = 0;
    return value;
  }
}

function wallNsFor(monotonicNs: bigint): bigint {
  return WALL_CLOCK_OFFSET_NS + monotonicNs;
}

function sanitizedHttpFailure(response: Response): string {
  return "http_" + String(response.status);
}

function isAllowedEndpoint(url: URL, allowInsecureLoopback: boolean): boolean {
  if (url.protocol === "https:") return true;
  return allowInsecureLoopback && url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1" || url.hostname === "localhost");
}

/**
 * Optional paid BlockRazor Private Mempool input. The adapter only receives and
 * validates SSE disclosures; it never submits a transaction or contacts a
 * Builder. Authorization is sent in a header and redirects are rejected.
 */
export class BlockRazorPrivateMempoolFeed {
  private readonly fetchImpl: typeof fetch;
  private readonly deduper: BlockRazorPrivateFirstSeenDeduper;
  private readonly targetAddresses: { ed: string; kuzuo: string };
  private controller: AbortController | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private generation = 0;
  private sequence = 0;
  private reconnectDelayMs = 250;
  private lastMessageUnixMs: number | null = null;
  private lastTargetUnixMs: number | null = null;
  private readonly counters: PrivateFeedCounters = {
    connected: false,
    connectionState: "stopped",
    reconnects: 0,
    notifications: 0,
    decodedEvents: 0,
    invalidEvents: 0,
    ignoredEvents: 0,
    targetMatches: 0,
    duplicateTargets: 0,
    lastError: null,
    lastTargetDecodeUs: null,
  };

  constructor(
    private readonly options: BlockRazorPrivateFeedOptions,
    dependencies: BlockRazorPrivateFeedDependencies = {},
  ) {
    if (!options.name.trim()) throw new Error("BlockRazor Private feed name is required");
    if (!(options.region in BLOCKRAZOR_PRIVATE_REGIONS)) throw new Error("unsupported BlockRazor Private region");
    const parsed = new URL(options.streamUrl);
    if (!isAllowedEndpoint(parsed, dependencies.allowInsecureLoopback === true)) {
      throw new Error("BlockRazor Private stream must use HTTPS");
    }
    if (!/^[\x21-\x7e]{8,512}$/.test(options.token)) {
      throw new Error("BlockRazor Private token must be 8-512 visible ASCII characters");
    }
    if (!Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs < 1_000 || options.connectTimeoutMs > 30_000) {
      throw new Error("BlockRazor Private connect timeout is invalid");
    }
    if (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 5_000 || options.idleTimeoutMs > 300_000) {
      throw new Error("BlockRazor Private idle timeout is invalid");
    }
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.deduper = dependencies.deduper ?? new BlockRazorPrivateFirstSeenDeduper();
    this.targetAddresses = dependencies.targetAddresses ?? { ed: ED_TARGET_ADDRESS, kuzuo: KUZUO_TARGET_ADDRESS };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.metricsTimer = setInterval(() => this.publishState(), 1_000);
    this.metricsTimer.unref();
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.reconnectTimer = null;
    this.metricsTimer = null;
    this.controller?.abort();
    this.controller = null;
    this.counters.connected = false;
    this.counters.connectionState = "stopped";
    this.publishState();
  }

  snapshot(): BlockRazorPrivateFeedMetrics {
    return {
      ...this.counters,
      lastMessageAt: this.lastMessageUnixMs === null ? null : new Date(this.lastMessageUnixMs).toISOString(),
      lastTargetAt: this.lastTargetUnixMs === null ? null : new Date(this.lastTargetUnixMs).toISOString(),
    };
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.counters.connected = false;
    this.counters.connectionState = "connecting";
    this.publishState();
    let failure = "transport_error";
    let idleExpired = false;
    const connectTimer = setTimeout(() => controller.abort(), this.options.connectTimeoutMs);
    connectTimer.unref();
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleExpired = true;
        controller.abort();
      }, this.options.idleTimeoutMs);
      idleTimer.unref();
    };

    try {
      const response = await this.fetchImpl(this.options.streamUrl, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: "Bearer " + this.options.token,
          "content-type": "application/json",
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      clearTimeout(connectTimer);
      if (!response.ok) {
        failure = sanitizedHttpFailure(response);
        return;
      }
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
        failure = "content_type_invalid";
        return;
      }
      if (!response.body) {
        failure = "response_body_missing";
        return;
      }
      this.reconnectDelayMs = 250;
      this.counters.connected = true;
      this.counters.connectionState = "streaming";
      this.counters.lastError = null;
      this.publishState();
      resetIdle();

      const decoder = new TextDecoder();
      const sse = new SseDataDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          failure = "stream_ended";
          break;
        }
        if (this.stopped || generation !== this.generation) return;
        resetIdle();
        this.lastMessageUnixMs = Date.now();
        let events: string[];
        try {
          events = sse.push(decoder.decode(result.value, { stream: true }));
        } catch {
          failure = "sse_frame_invalid";
          break;
        }
        for (const data of events) this.handleEvent(data);
      }
    } catch {
      failure = idleExpired ? "sse_idle_timeout" : "transport_error";
    } finally {
      clearTimeout(connectTimer);
      if (idleTimer) clearTimeout(idleTimer);
      controller.abort();
      if (this.controller === controller) this.controller = null;
      if (!this.stopped && generation === this.generation) this.scheduleReconnect(generation, failure);
    }
  }

  private handleEvent(data: string): void {
    const socketSeenMonoNs = process.hrtime.bigint();
    this.counters.notifications += 1;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      this.counters.invalidEvents += 1;
      return;
    }
    this.counters.decodedEvents += 1;
    let matches: BlockRazorPrivateTargetMatch[];
    try {
      matches = inspectBlockRazorPrivateBundle(payload, this.options.region, this.targetAddresses);
    } catch {
      this.counters.invalidEvents += 1;
      return;
    }
    const parsedMonoNs = process.hrtime.bigint();
    if (matches.length === 0) {
      this.counters.ignoredEvents += 1;
      return;
    }

    for (const match of matches) {
      if (!this.deduper.claim(match.transaction.hash, socketSeenMonoNs)) {
        this.counters.duplicateTargets += 1;
        continue;
      }
      this.sequence += 1;
      const signal = validateTargetSignal({
        version: EXECUTION_SIGNAL_VERSION,
        source: "blockrazor_private_mempool",
        sourceSequence: this.options.name + ":" + String(this.sequence),
        firstSeenUnixNs: wallNsFor(socketSeenMonoNs).toString(),
        firstSeenMonoNs: socketSeenMonoNs.toString(),
        strategy: match.strategy,
        transaction: match.transaction,
        sourceBlockHint: match.bundle.nextBlockNumber,
        blockRazorPrivateBundle: match.bundle,
      });
      const matchedMonoNs = process.hrtime.bigint();
      // Machine-first handoff stays ahead of status timestamps and metrics.
      this.options.onTarget(brandSourceVerifiedTargetSignal(signal), {
        socketSeenMonoNs,
        parsedMonoNs,
        matchedMonoNs,
      });
      this.counters.targetMatches += 1;
      this.lastTargetUnixMs = Date.now();
      this.counters.lastTargetDecodeUs = Number(matchedMonoNs - socketSeenMonoNs) / 1e3;
    }
  }

  private scheduleReconnect(generation: number, reason: string): void {
    if (this.stopped || generation !== this.generation) return;
    this.controller?.abort();
    this.controller = null;
    this.counters.connected = false;
    this.counters.connectionState = "backoff";
    this.counters.lastError = reason;
    this.counters.reconnects += 1;
    this.publishState();
    const delay = this.reconnectDelayMs + Math.floor(Math.random() * 100);
    this.reconnectDelayMs = Math.min(5_000, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    this.reconnectTimer.unref();
  }

  private publishState(): void {
    this.options.onState?.(this.options.name, this.snapshot());
  }
}
