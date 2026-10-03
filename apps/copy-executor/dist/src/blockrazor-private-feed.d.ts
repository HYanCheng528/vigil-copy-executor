import { type BlockRazorPrivateBundleContext, type BlockRazorPrivateRegion, type BlockRazorPrivateTransactionWire, type TargetSignal, type TargetStrategy } from "./core/messages.js";
/**
 * Official region pairs. BlockRazor requires a private bundle to be submitted
 * to the same regional domain from which its SSE dependency was received.
 *
 * https://docs.blockrazor.io/streams/mempool/bsc/private-mempool
 */
export declare const BLOCKRAZOR_PRIVATE_REGIONS: Readonly<Record<BlockRazorPrivateRegion, {
    streamUrl: string;
    submitUrl: string;
}>>;
export declare const BLOCKRAZOR_PROXY_BID_SELECTOR = "0xbd69ffca";
export declare const GMGN_ROUTER_SWAP_TOPIC = "0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a";
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
    targetAddresses?: {
        ed: string;
        kuzuo: string;
    };
    /** Test-only escape hatch; production configuration never sets this. */
    allowInsecureLoopback?: boolean;
}
/**
 * Strictly validates a disclosed bundle and returns only complete GMGN target
 * transactions. No signed raw transaction or gas envelope is synthesized.
 */
export declare function inspectBlockRazorPrivateBundle(payload: unknown, region: BlockRazorPrivateRegion, targetAddresses?: {
    ed: string;
    kuzuo: string;
}): BlockRazorPrivateTargetMatch[];
/** Bounded process-local first-wins dedupe shared by all configured regions. */
export declare class BlockRazorPrivateFirstSeenDeduper {
    private readonly targets;
    claim(targetHash: string, seenMonoNs: bigint): boolean;
}
/** Minimal bounded SSE decoder with support for chunk splits and multiline data. */
export declare class SseDataDecoder {
    private buffer;
    private readonly dataLines;
    private dataBytes;
    push(chunk: string): string[];
    private dispatch;
}
/**
 * Optional paid BlockRazor Private Mempool input. The adapter only receives and
 * validates SSE disclosures; it never submits a transaction or contacts a
 * Builder. Authorization is sent in a header and redirects are rejected.
 */
export declare class BlockRazorPrivateMempoolFeed {
    private readonly options;
    private readonly fetchImpl;
    private readonly deduper;
    private readonly targetAddresses;
    private controller;
    private reconnectTimer;
    private metricsTimer;
    private stopped;
    private generation;
    private sequence;
    private reconnectDelayMs;
    private lastMessageUnixMs;
    private lastTargetUnixMs;
    private readonly counters;
    constructor(options: BlockRazorPrivateFeedOptions, dependencies?: BlockRazorPrivateFeedDependencies);
    start(): void;
    stop(): void;
    snapshot(): BlockRazorPrivateFeedMetrics;
    private connect;
    private handleEvent;
    private scheduleReconnect;
    private publishState;
}
