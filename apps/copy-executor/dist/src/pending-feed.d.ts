import { type HexString, type TargetSignal, type TargetTransactionWire } from "./core/messages.js";
export interface HeadSnapshot {
    number: number;
    hash: HexString;
    timestamp: number;
    source: string;
    seenMonoNs: bigint;
}
export interface PendingFeedMetrics {
    connected: boolean;
    headsSubscriptionReady: boolean;
    pendingSubscriptionReady: boolean;
    pendingObjectCapability: "unknown" | "full" | "hash_only";
    actionable: boolean;
    reconnects: number;
    /** Pending-subscription notifications only; newHeads are intentionally excluded. */
    notifications: number;
    /** Pending notifications with a valid transaction-object hash shape. */
    objectNotifications: number;
    hashOnlyNotifications: number;
    targetMatches: number;
    invalidTargets: number;
    lastError: string | null;
    lastMessageAt: string | null;
}
export interface PendingFeedOptions {
    name: string;
    url: string;
    /** False creates a cheap newHeads-only socket with no pending firehose. */
    subscribePending?: boolean;
    /** False creates a pending-only socket so full objects can never queue heads. */
    subscribeHeads?: boolean;
    /** Reject and reconnect before publishing a head outside this wall-clock window. */
    maxHeadTimestampLagMs?: number;
    /** Maximum ACK-to-first-valid-full-object proof window. Defaults to 5s. */
    fullObjectCapabilityTimeoutMs?: number;
    onTarget: (signal: TargetSignal, timing: {
        socketSeenMonoNs: bigint;
        parsedMonoNs: bigint;
        matchedMonoNs: bigint;
    }) => void;
    onHead: (head: HeadSnapshot) => void;
    /**
     * Optional signing-wallet observer. The advertised `from` is only a cheap
     * prefilter; the callback receives a canonical wire transaction whose raw
     * signature has recovered the same sender.
     */
    copyWalletAddresses?: readonly string[];
    onCopyWalletPending?: (transaction: TargetTransactionWire) => void;
    onState?: (name: string, metrics: PendingFeedMetrics) => void;
}
export interface PendingFeedTargetAddresses {
    ed: string;
    kuzuo: string;
}
/** Injectable only for deterministic loopback tests; production uses the safe defaults. */
export interface PendingFeedDependencies {
    targetAddresses?: PendingFeedTargetAddresses;
    orphanTargetTtlNs?: bigint;
    orphanTargetCapacity?: number;
    monotonicNow?: () => bigint;
    wallClockNow?: () => number;
}
export declare const DEFAULT_AUTHORITY_HEAD_MAX_TIMESTAMP_LAG_MS = 15000;
/**
 * Rebuild the exact signed legacy RLP bytes from QuickNode's full-pending
 * object. This avoids an eth_getTransactionByHash round trip on the hot path.
 */
export declare function pendingObjectToWire(value: unknown): TargetTransactionWire;
/**
 * One persistent socket carries full pending objects and new heads. The first
 * address/router/selector test happens before RLP reconstruction or ABI decode.
 */
export declare class FullPendingFeed {
    private readonly options;
    private socket;
    private reconnectTimer;
    private metricsPublishTimer;
    private capabilityTimer;
    private stopped;
    private generation;
    private sequence;
    private reconnectDelayMs;
    private pendingRequested;
    private readonly targetPredecessors;
    private readonly orphanTargets;
    private readonly emittedTargetHashes;
    private readonly subscriptions;
    private readonly copyWalletAddresses;
    private readonly targetMap;
    private readonly orphanTargetTtlNs;
    private readonly orphanTargetCapacity;
    private readonly monotonicNow;
    private readonly wallClockNow;
    private readonly metricsState;
    constructor(options: PendingFeedOptions, dependencies?: PendingFeedDependencies);
    start(): void;
    stop(): void;
    snapshot(): PendingFeedMetrics;
    private connect;
    private handleMessage;
    private publishState;
    private resetSubscriptionReadiness;
    private refreshActionable;
    private armCapabilityTimer;
    private clearCapabilityTimer;
    private scheduleMetricsPublish;
    private clearMetricsPublishTimer;
    private requestPendingSubscription;
    private rememberOrphanTarget;
    private recoverOrphanTarget;
    private emitTarget;
    private wasTargetEmitted;
    private pruneTargetCorrelationState;
    private trimOldest;
    private resetTargetCorrelationState;
}
