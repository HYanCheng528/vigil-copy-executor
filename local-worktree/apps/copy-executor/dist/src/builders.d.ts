import type { HexString } from "./core/messages.js";
export type BuilderName = "club48" | "blockrazor" | "jet";
export type TargetReference = {
    kind: "rawTx";
    hash: HexString;
    raw: HexString;
    requiredPredecessorRaws: HexString[];
} | {
    kind: "blockrazorPrivateBundleHash";
    hash: HexString;
} | {
    kind: "club48AuctionId";
    id: HexString;
}
/** Target is already confirmed in block N; submit only buy+tip for N+1. */
 | {
    kind: "confirmedNextBlock";
    targetHash: HexString;
    targetBlock: number;
};
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
export declare class BuilderClient {
    readonly config: BuilderEndpointConfig;
    private requestId;
    private lastAck;
    private lastPrewarmMonoNs;
    private prewarmInFlight;
    private initialPrewarmComplete;
    private activeProbeChannel;
    private readonly endpoint;
    private readonly channels;
    private closeRequested;
    private transportsClosed;
    private closePromise;
    private closeResolve;
    constructor(config: BuilderEndpointConfig, channelFactory?: BuilderChannelFactory);
    snapshot(): {
        name: BuilderName;
        host: string;
        lastAck: BuilderAckSnapshot | null;
        lastPrewarmMonoNs: string | null;
        prewarmIntervalMs: number;
        readyChannels: number;
    };
    isFresh(now?: bigint): boolean;
    private channelIsFresh;
    private markHealthy;
    prepare(intent: SubmitIntent): PreparedBuilderSubmission;
    /**
     * Call without awaiting the returned promise. The owned channel write starts
     * before the next provider candidate is signed, removing the old barrier.
     */
    dispatch(prepared: PreparedBuilderSubmission): Promise<BuilderAck>;
    private requestOnChannel;
    private dispatchChannel;
    private prewarmConnection;
    private prewarmConnections;
    private cancelProbe;
    private scheduleProbe;
    private runProbe;
    /**
     * Keeps two owned single-socket HTTPS sessions warm using only eth_chainId.
     * Concurrent ticks share one flight and each socket is probed in turn.
     */
    prewarm(): Promise<void>;
    close(): Promise<void>;
    private closeTransportsIfIdle;
}
export declare const DEFAULT_BUILDERS: Readonly<Record<BuilderName, Omit<BuilderEndpointConfig, "authorization">>>;
