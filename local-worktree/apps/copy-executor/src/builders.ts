import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { HexString } from "./core/messages.js";

export type BuilderName = "club48" | "blockrazor" | "jet";

export type TargetReference =
  | {
      kind: "rawTx";
      hash: HexString;
      raw: HexString;
      requiredPredecessorRaws: HexString[];
    }
  | { kind: "blockrazorPrivateBundleHash"; hash: HexString }
  | { kind: "club48AuctionId"; id: HexString }
  /** Target is already confirmed in block N; submit only buy+tip for N+1. */
  | { kind: "confirmedNextBlock"; targetHash: HexString; targetBlock: number };

export interface SubmitIntent {
  target: TargetReference;
  strategyTxs: HexString[];
  maxBlockNumber?: number;
  minTimestamp?: number;
  maxTimestamp?: number;
  noMerge: boolean;
  positionFirst: boolean;
}

export interface BuilderEndpointConfig {
  name: BuilderName;
  url: string;
  authorization?: string;
  tipRecipient: string;
  requestTimeoutMs: number;
  /** Idle target for each of the two owned keep-alive channels. */
  prewarmIntervalMs: number;
}

export interface PreparedBuilderSubmission {
  builder: BuilderName;
  url: string;
  headers: Record<string, string>;
  body: string;
  preparedMonoNs: bigint;
}

export interface BuilderAck {
  builder: BuilderName;
  accepted: boolean;
  bundleId: string | null;
  httpStatus: number | null;
  startedMonoNs: bigint;
  responseMonoNs: bigint;
  latencyMs: number;
  error: string | null;
}

export interface BuilderAckSnapshot extends Omit<BuilderAck, "startedMonoNs" | "responseMonoNs"> {
  startedMonoNs: string;
  responseMonoNs: string;
}

interface JsonRpcEnvelope {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

const HEX_ID = /^0x[0-9a-fA-F]{64}$/;

function assertIntent(intent: SubmitIntent): void {
  const expectedCount = intent.target.kind === "blockrazorPrivateBundleHash" ? 1 : 2;
  if (intent.strategyTxs.length !== expectedCount) {
    throw new Error(intent.target.kind === "blockrazorPrivateBundleHash"
      ? "the private proxyBid path requires exactly one strategy transaction"
      : "the public copy path requires exactly buy and separate tip transactions");
  }
  if (intent.maxBlockNumber !== undefined
    && (!Number.isSafeInteger(intent.maxBlockNumber) || intent.maxBlockNumber <= 0)) {
    throw new Error("maxBlockNumber must be positive when provided");
  }
  if (intent.minTimestamp !== undefined
    && (!Number.isSafeInteger(intent.minTimestamp) || intent.minTimestamp < 0)) {
    throw new Error("minTimestamp must be non-negative when provided");
  }
  if (intent.maxTimestamp !== undefined
    && (!Number.isSafeInteger(intent.maxTimestamp) || intent.maxTimestamp <= 0)) {
    throw new Error("maxTimestamp must be positive when provided");
  }
}

function rawTargetTransactions(target: Extract<TargetReference, { kind: "rawTx" }>): HexString[] {
  return [...target.requiredPredecessorRaws, target.raw];
}

function rpcBody(name: BuilderName, id: number, intent: SubmitIntent): object {
  assertIntent(intent);
  if (name === "club48") {
    if (intent.target.kind === "blockrazorPrivateBundleHash") {
      throw new Error("48Club cannot consume a BlockRazor private bundle hash");
    }
    const params: Record<string, unknown> = {
      txs: intent.strategyTxs,
      maxBlockNumber: intent.maxBlockNumber,
      maxTimestamp: intent.maxTimestamp,
      revertingTxHashes: [],
      noMerge: intent.noMerge,
      positionFirst: intent.positionFirst,
    };
    if (intent.target.kind === "club48AuctionId") {
      params.backrunTarget = intent.target.id;
    } else if (intent.target.kind === "confirmedNextBlock") {
      // The target is already canonical in N. Re-including it would make the
      // bundle invalid; N+1 carries only the independently signed buy and tip.
    } else {
      params.txs = [...rawTargetTransactions(intent.target), ...intent.strategyTxs];
    }
    return { jsonrpc: "2.0", id, method: "eth_sendBundle", params: [params] };
  }

  if (name === "blockrazor") {
    if (intent.target.kind === "club48AuctionId") {
      throw new Error("BlockRazor cannot consume a 48Club auction target");
    }
    if (intent.target.kind === "blockrazorPrivateBundleHash") {
      if (intent.maxBlockNumber === undefined) {
        throw new Error("BlockRazor private eth_sendMevBundle requires maxBlockNumber");
      }
      return {
        jsonrpc: "2.0",
        id,
        method: "eth_sendMevBundle",
        params: [{
          hash: intent.target.hash,
          txs: intent.strategyTxs,
          maxBlockNumber: intent.maxBlockNumber,
          revertingTxHashes: [],
        }],
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      method: "eth_sendBundle",
      params: [{
        txs: intent.target.kind === "confirmedNextBlock"
          ? intent.strategyTxs
          : [...rawTargetTransactions(intent.target), ...intent.strategyTxs],
        maxBlockNumber: intent.maxBlockNumber,
        minTimestamp: intent.minTimestamp,
        maxTimestamp: intent.maxTimestamp,
        revertingTxHashes: [],
        noMerge: intent.noMerge,
        positionFirst: intent.positionFirst,
      }],
    };
  }

  if (intent.target.kind !== "rawTx" && intent.target.kind !== "confirmedNextBlock") {
    throw new Error("Jet requires the complete signed target transaction unless the target is already confirmed for N+1");
  }
  return {
    jsonrpc: "2.0",
    id,
    method: "eth_sendBundle",
    params: [{
      txs: intent.target.kind === "confirmedNextBlock"
        ? intent.strategyTxs
        : [...rawTargetTransactions(intent.target), ...intent.strategyTxs],
      maxBlockNumber: intent.maxBlockNumber,
      minTimestamp: intent.minTimestamp,
      maxTimestamp: intent.maxTimestamp,
      revertingTxHashes: [],
    }],
  };
}

function parseAck(builder: BuilderName, status: number, body: unknown): {
  accepted: boolean;
  bundleId: string | null;
  error: string | null;
} {
  if (!body || typeof body !== "object") {
    return { accepted: false, bundleId: null, error: "Builder returned a non-JSON response" };
  }
  const envelope = body as JsonRpcEnvelope;
  if (envelope.error) {
    const numericCode = typeof envelope.error.code === "number" && Number.isSafeInteger(envelope.error.code)
      ? String(envelope.error.code)
      : null;
    return {
      accepted: false,
      bundleId: null,
      // Never reflect an upstream message: a hostile response could include
      // signed raw transactions, authorization data, or arbitrary text.
      error: numericCode ? `Builder JSON-RPC error (${numericCode})` : "Builder JSON-RPC error",
    };
  }
  const candidate = typeof envelope.result === "string"
    ? envelope.result
    : envelope.result && typeof envelope.result === "object"
      ? (envelope.result as { bundleHash?: unknown; hash?: unknown }).bundleHash
        ?? (envelope.result as { bundleHash?: unknown; hash?: unknown }).hash
      : null;
  const bundleId = typeof candidate === "string" && HEX_ID.test(candidate) ? candidate : null;
  const accepted = status >= 200 && status < 300 && bundleId !== null;
  return {
    accepted,
    bundleId,
    error: accepted ? null : "Builder did not return a valid bundle id",
  };
}

export interface BuilderChannelRequest {
  url: URL;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
}

export interface BuilderChannelResponse {
  status: number;
  body: string;
}

export interface BuilderChannelTransport {
  request(value: BuilderChannelRequest): Promise<BuilderChannelResponse>;
  close(): void;
}

export type BuilderChannelFactory = (channelIndex: number, endpoint: URL) => BuilderChannelTransport;

class BuilderChannelFailure extends Error {
  constructor(readonly timedOut: boolean) {
    super(timedOut ? "Builder channel timed out" : "Builder channel failed");
  }
}

/** One owned keep-alive Agent with exactly one socket and no overflow socket. */
class HttpsBuilderChannel implements BuilderChannelTransport {
  private readonly agent = new HttpsAgent({
    keepAlive: true,
    keepAliveMsecs: 1_000,
    maxSockets: 1,
    maxFreeSockets: 1,
    scheduling: "lifo",
  });

  async request(value: BuilderChannelRequest): Promise<BuilderChannelResponse> {
    return new Promise<BuilderChannelResponse>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (error: BuilderChannelFailure | null, response?: BuilderChannelResponse): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(response!);
      };
      const request = httpsRequest(value.url, {
        method: "POST",
        agent: this.agent,
        headers: {
          ...value.headers,
          "content-length": Buffer.byteLength(value.body).toString(),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | Uint8Array | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > 8_192) {
            response.destroy();
            request.destroy();
            finish(new BuilderChannelFailure(false));
            return;
          }
          chunks.push(bytes);
        });
        response.once("aborted", () => finish(new BuilderChannelFailure(false)));
        response.once("error", () => finish(new BuilderChannelFailure(false)));
        response.once("end", () => finish(null, {
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks, total).toString("utf8"),
        }));
      });
      request.once("error", () => finish(new BuilderChannelFailure(timedOut)));
      timer = setTimeout(() => {
        timedOut = true;
        request.destroy();
        finish(new BuilderChannelFailure(true));
      }, value.timeoutMs);
      timer.unref();
      request.end(value.body);
    });
  }

  close(): void {
    this.agent.destroy();
  }
}

interface ManagedBuilderChannel {
  index: number;
  transport: BuilderChannelTransport;
  load: number;
  busySinceMonoNs: bigint;
  /** Any completed I/O, including an error response; used only for idle timing. */
  lastIoMonoNs: bigint;
  /** A validated chainId or accepted dispatch; the sole freshness watermark. */
  lastHealthyMonoNs: bigint;
  ready: boolean;
  submitCapable: boolean;
  capabilityValidated: boolean;
  probePending: boolean;
  probeTimer: NodeJS.Timeout | null;
}

export class BuilderClient {
  private requestId = 1;
  private lastAck: BuilderAck | null = null;
  private lastPrewarmMonoNs = 0n;
  private prewarmInFlight: Promise<void> | null = null;
  private initialPrewarmComplete = false;
  private activeProbeChannel: ManagedBuilderChannel | null = null;
  private readonly endpoint: URL;
  private readonly channels: [ManagedBuilderChannel, ManagedBuilderChannel];
  private closeRequested = false;
  private transportsClosed = false;
  private closePromise: Promise<void> | null = null;
  private closeResolve: (() => void) | null = null;

  constructor(
    readonly config: BuilderEndpointConfig,
    channelFactory: BuilderChannelFactory = () => new HttpsBuilderChannel(),
  ) {
    const parsed = new URL(config.url);
    if (parsed.protocol !== "https:") throw new Error("Builder endpoint must use HTTPS");
    if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 50) {
      throw new Error("Builder timeout must be at least 50ms");
    }
    if (!Number.isSafeInteger(config.prewarmIntervalMs) || config.prewarmIntervalMs < 50) {
      throw new Error("Builder prewarm interval must be at least 50ms");
    }
    this.endpoint = parsed;
    const state = (index: number): ManagedBuilderChannel => ({
      index,
      transport: channelFactory(index, new URL(parsed)),
      load: 0,
      busySinceMonoNs: 0n,
      lastIoMonoNs: 0n,
      lastHealthyMonoNs: 0n,
      ready: false,
      submitCapable: false,
      capabilityValidated: false,
      probePending: false,
      probeTimer: null,
    });
    this.channels = [state(0), state(1)];
  }

  snapshot(): {
    name: BuilderName;
    host: string;
    lastAck: BuilderAckSnapshot | null;
    lastPrewarmMonoNs: string | null;
    prewarmIntervalMs: number;
    readyChannels: number;
  } {
    const now = process.hrtime.bigint();
    return {
      name: this.config.name,
      host: this.endpoint.host,
      lastAck: this.lastAck ? {
        ...this.lastAck,
        startedMonoNs: this.lastAck.startedMonoNs.toString(),
        responseMonoNs: this.lastAck.responseMonoNs.toString(),
      } : null,
      lastPrewarmMonoNs: this.lastPrewarmMonoNs === 0n ? null : this.lastPrewarmMonoNs.toString(),
      prewarmIntervalMs: this.config.prewarmIntervalMs,
      readyChannels: this.channels.filter((channel) => this.channelIsFresh(channel, now)).length,
    };
  }

  isFresh(now = process.hrtime.bigint()): boolean {
    return this.channels.some((channel) => this.channelIsFresh(channel, now));
  }

  private channelIsFresh(channel: ManagedBuilderChannel, now: bigint): boolean {
    if (!channel.ready || !channel.submitCapable || channel.lastHealthyMonoNs === 0n) return false;
    const age = now - channel.lastHealthyMonoNs;
    const maximumAgeNs = BigInt(this.config.prewarmIntervalMs * 3) * 1_000_000n;
    return age >= 0n && age <= maximumAgeNs;
  }

  private markHealthy(channel: ManagedBuilderChannel, atMonoNs = process.hrtime.bigint(), submitCapable = true): void {
    channel.ready = true;
    if (submitCapable) channel.submitCapable = true;
    channel.lastHealthyMonoNs = atMonoNs;
  }

  prepare(intent: SubmitIntent): PreparedBuilderSubmission {
    const id = this.requestId++;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.authorization) headers.authorization = this.config.authorization;
    return {
      builder: this.config.name,
      url: this.config.url,
      headers,
      body: JSON.stringify(rpcBody(this.config.name, id, intent)),
      preparedMonoNs: process.hrtime.bigint(),
    };
  }

  /**
   * Call without awaiting the returned promise. The owned channel write starts
   * before the next provider candidate is signed, removing the old barrier.
   */
  async dispatch(prepared: PreparedBuilderSubmission): Promise<BuilderAck> {
    if (prepared.builder !== this.config.name) throw new Error("prepared request belongs to another Builder");
    if (prepared.url !== this.config.url) throw new Error("prepared request has an unexpected Builder URL");
    const startedMonoNs = process.hrtime.bigint();
    let httpStatus: number | null = null;
    let channel: ManagedBuilderChannel | null = null;
    try {
      channel = this.dispatchChannel(startedMonoNs);
      if (!channel) throw new BuilderChannelFailure(false);
      const response = await this.requestOnChannel(
        channel,
        prepared.headers,
        prepared.body,
        this.config.requestTimeoutMs,
      );
      httpStatus = response.status;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        // parseAck emits a generic error and never returns raw response text.
      }
      const responseMonoNs = process.hrtime.bigint();
      const result = parseAck(this.config.name, response.status, parsed);
      if (result.accepted) this.markHealthy(channel, responseMonoNs);
      else if (response.status === 401
        || response.status === 402
        || response.status === 403
        || response.status === 407) {
        channel.ready = false;
        channel.submitCapable = false;
      } else if (
        response.status >= 500
        || !parsed
        || typeof parsed !== "object"
      ) {
        channel.ready = false;
      }
      const ack: BuilderAck = {
        builder: this.config.name,
        accepted: result.accepted,
        bundleId: result.bundleId,
        httpStatus,
        startedMonoNs,
        responseMonoNs,
        latencyMs: Number(responseMonoNs - startedMonoNs) / 1e6,
        error: result.error,
      };
      this.lastAck = ack;
      return ack;
    } catch (error) {
      if (channel) channel.ready = false;
      const responseMonoNs = process.hrtime.bigint();
      const ack: BuilderAck = {
        builder: this.config.name,
        accepted: false,
        bundleId: null,
        httpStatus,
        startedMonoNs,
        responseMonoNs,
        latencyMs: Number(responseMonoNs - startedMonoNs) / 1e6,
        error: error instanceof BuilderChannelFailure && error.timedOut
          ? "Builder request timed out"
          : "Builder request failed",
      };
      this.lastAck = ack;
      return ack;
    }
  }

  private async requestOnChannel(
    channel: ManagedBuilderChannel,
    headers: Readonly<Record<string, string>>,
    body: string,
    timeoutMs: number,
  ): Promise<BuilderChannelResponse> {
    if (this.closeRequested) throw new BuilderChannelFailure(false);
    this.cancelProbe(channel);
    channel.probePending = false;
    const now = process.hrtime.bigint();
    if (channel.load === 0) channel.busySinceMonoNs = now;
    channel.load += 1;
    try {
      const response = await channel.transport.request({
        url: this.endpoint,
        headers,
        body,
        timeoutMs,
      });
      return response;
    } finally {
      channel.load -= 1;
      if (channel.load === 0) {
        channel.busySinceMonoNs = 0n;
        channel.lastIoMonoNs = process.hrtime.bigint();
        channel.probePending = false;
      }
      if (this.initialPrewarmComplete && !this.closeRequested) this.scheduleProbe(channel);
      this.closeTransportsIfIdle();
    }
  }

  private dispatchChannel(now = process.hrtime.bigint()): ManagedBuilderChannel | null {
    const fresh = this.channels.filter((channel) => this.channelIsFresh(channel, now));
    // Warmth is a latency preference, never an authorization gate. A real
    // target must still open/write the least-loaded owned channel when both
    // sessions are cold; the resulting ACK updates health in the usual way.
    const candidates = fresh.length > 0 ? fresh : [...this.channels];
    const first = candidates[0]!;
    const second = candidates[1];
    if (!second) return first;
    if (first.load !== second.load) return first.load < second.load ? first : second;
    if (first.load > 0) {
      // With equal queues, the channel whose active request started first is
      // the best bounded estimate of which one will become available first.
      return first.busySinceMonoNs <= second.busySinceMonoNs ? first : second;
    }
    // Alternate idle use by choosing the least recently completed channel.
    return first.lastIoMonoNs <= second.lastIoMonoNs ? first : second;
  }

  private async prewarmConnection(channel: ManagedBuilderChannel): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.authorization) headers.authorization = this.config.authorization;
    const blockRazorCapabilityProbe = this.config.name === "blockrazor" && !channel.capabilityValidated;
    const response = await this.requestOnChannel(
      channel,
      headers,
      blockRazorCapabilityProbe
        ? '{"jsonrpc":"2.0","id":"warm","method":"eth_sendBundle","params":[{"txs":[]}]}'
        : '{"jsonrpc":"2.0","id":"warm","method":"eth_chainId","params":[]}',
      Math.min(this.config.requestTimeoutMs, 1_000),
    );
    if (this.config.name === "blockrazor" && !blockRazorCapabilityProbe
      && channel.submitCapable && response.status === 402) {
      // Tokyo can return a non-JSON Payment Required body for eth_chainId
      // even after this exact channel proved eth_sendBundle capability. The
      // completed HTTPS exchange is sufficient to keep the owned socket warm;
      // only a real dispatch auth response may revoke submit capability.
      this.markHealthy(channel, process.hrtime.bigint(), false);
      this.lastPrewarmMonoNs = channel.lastHealthyMonoNs;
      return;
    }
    let envelope: JsonRpcEnvelope;
    try {
      envelope = JSON.parse(response.body) as JsonRpcEnvelope;
    } catch {
      throw new Error("Builder warmup returned invalid JSON");
    }
    if (blockRazorCapabilityProbe) {
      const code = envelope.error?.code;
      const message = typeof envelope.error?.message === "string" ? envelope.error.message : "";
      if (response.status !== 200 || code !== -38_000
        || !/(?:missing|empty|require)[^\n]{0,40}(?:tx|transaction)|(?:tx|transaction)[^\n]{0,40}(?:missing|empty|required)/i.test(message)) {
        throw new Error("BlockRazor submit capability probe was not recognized");
      }
      channel.capabilityValidated = true;
      this.markHealthy(channel);
      this.lastPrewarmMonoNs = channel.lastHealthyMonoNs;
      return;
    }
    if (response.status < 200 || response.status >= 300 || envelope.error || envelope.result !== "0x38") {
      throw new Error("Builder warmup did not confirm BSC chainId 56");
    }
    channel.capabilityValidated = true;
    const healthyAt = process.hrtime.bigint();
    this.markHealthy(channel, healthyAt);
    this.lastPrewarmMonoNs = healthyAt;
  }

  private async prewarmConnections(): Promise<void> {
    // Stagger the two probes. While one owned socket carries eth_chainId, the
    // other remains idle and immediately available to dispatch a real target.
    for (const channel of this.channels) {
      try {
        await this.prewarmConnection(channel);
      } catch {
        channel.ready = false;
      }
    }
    this.initialPrewarmComplete = true;
    if (this.closeRequested) return;
    // The second session stays completely idle while the first heartbeat is
    // in flight. Later activity on either session pushes only its own deadline.
    this.scheduleProbe(this.channels[0], Math.ceil(this.config.prewarmIntervalMs / 2));
    this.scheduleProbe(this.channels[1], this.config.prewarmIntervalMs);
  }

  private cancelProbe(channel: ManagedBuilderChannel): void {
    if (!channel.probeTimer) return;
    clearTimeout(channel.probeTimer);
    channel.probeTimer = null;
  }

  private scheduleProbe(channel: ManagedBuilderChannel, delayMs = this.config.prewarmIntervalMs): void {
    this.cancelProbe(channel);
    if (this.closeRequested) return;
    channel.probeTimer = setTimeout(() => {
      channel.probeTimer = null;
      void this.runProbe(channel);
    }, delayMs);
    channel.probeTimer.unref();
  }

  private async runProbe(channel: ManagedBuilderChannel): Promise<void> {
    if (this.closeRequested) return;
    if (channel.load > 0 || this.activeProbeChannel) {
      channel.probePending = true;
      return;
    }
    this.activeProbeChannel = channel;
    try {
      await this.prewarmConnection(channel);
    } catch {
      channel.ready = false;
    } finally {
      if (this.activeProbeChannel === channel) this.activeProbeChannel = null;
      if (this.closeRequested) return;
      // requestOnChannel already scheduled this channel from its actual
      // completion time. Service one collided deadline only after it finished.
      const pending = this.channels.find((candidate) => candidate.probePending && candidate.load === 0);
      if (pending) {
        pending.probePending = false;
        void this.runProbe(pending);
      }
    }
  }

  /**
   * Keeps two owned single-socket HTTPS sessions warm using only eth_chainId.
   * Concurrent ticks share one flight and each socket is probed in turn.
   */
  prewarm(): Promise<void> {
    if (this.closeRequested) return Promise.resolve();
    if (this.prewarmInFlight) return this.prewarmInFlight;
    if (this.initialPrewarmComplete) return Promise.resolve();
    const operation = Promise.resolve().then(() => this.prewarmConnections());
    this.prewarmInFlight = operation;
    void operation.then(() => {
      if (this.prewarmInFlight === operation) this.prewarmInFlight = null;
    });
    return operation;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    this.closePromise = new Promise<void>((resolve) => { this.closeResolve = resolve; });
    for (const channel of this.channels) {
      this.cancelProbe(channel);
      channel.probePending = false;
    }
    this.closeTransportsIfIdle();
    return this.closePromise;
  }

  private closeTransportsIfIdle(): void {
    if (!this.closeRequested || this.transportsClosed || this.channels.some((channel) => channel.load > 0)) return;
    this.transportsClosed = true;
    for (const channel of this.channels) {
      try {
        channel.transport.close();
      } catch {
        // Continue closing the sibling and always settle shutdown.
      }
    }
    this.closeResolve?.();
    this.closeResolve = null;
  }
}

export const DEFAULT_BUILDERS: Readonly<Record<BuilderName, Omit<BuilderEndpointConfig, "authorization">>> = {
  club48: {
    name: "club48",
    url: "https://puissant-builder.48.club/",
    tipRecipient: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
    requestTimeoutMs: 450,
    prewarmIntervalMs: 30_000,
  },
  blockrazor: {
    name: "blockrazor",
    url: "https://tokyo.builder.blockrazor.io/",
    tipRecipient: "0x1266c6be60392a8ff346e8d5eccd3e69dd9c5f20",
    requestTimeoutMs: 450,
    // The Tokyo endpoint reused the same TLS socket through 45s of idle time
    // and closed it near 60s in the production network path. Keep each owned
    // channel alive at 45s; the two channels are staggered by 22.5s. A real
    // dispatch resets only the channel it used, and reconnect happens only
    // after an actual close/failure rather than on this timer.
    prewarmIntervalMs: 45_000,
  },
  jet: {
    name: "jet",
    url: "https://rpc.bsc.jetbldr.xyz/",
    tipRecipient: "0xe89c42bc188c993273ab34231e12ae60c73042e4",
    requestTimeoutMs: 450,
    prewarmIntervalMs: 15_000,
  },
};
