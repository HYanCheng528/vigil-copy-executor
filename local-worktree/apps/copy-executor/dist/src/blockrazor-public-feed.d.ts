import { type MethodDefinition } from "@grpc/grpc-js";
import { type HexString, type TargetSignal, type TargetStrategy, type TargetTransactionWire } from "./core/messages.js";
/** Official Tokyo endpoint documented for the BSC Public Mempool stream. */
export declare const BLOCKRAZOR_PUBLIC_MEMPOOL_TOKYO_ENDPOINT = "63.254.162.18:50051";
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
/** Exported so loopback tests can exercise the exact production gRPC codec. */
export declare const BLOCKRAZOR_GATEWAY_NEW_TXS_METHOD: MethodDefinition<RelayTxsRequest, RelayTxsReply>;
export interface BlockRazorTargetAddresses {
    ed: string;
    kuzuo: string;
}
export type BlockRazorRawInspection = {
    kind: "ignore";
    reason: "not_candidate" | "unsupported_envelope" | "unmonitored_sender";
} | {
    kind: "predecessor";
    strategy: "kuzuo";
    transaction: TargetTransactionWire;
} | {
    kind: "target";
    strategy: TargetStrategy;
    transaction: TargetTransactionWire;
};
/**
 * Fully recovers a signed legacy transaction and verifies its canonical raw
 * envelope. This helper is intentionally strict and is useful for fixtures and
 * any future trusted raw source.
 */
export declare function blockRazorRawTransactionToWire(raw: Uint8Array | HexString): TargetTransactionWire;
/** Pure local classifier used by the live adapter and deterministic tests. */
export declare function inspectBlockRazorRawTransaction(raw: Uint8Array | HexString, targetAddresses?: BlockRazorTargetAddresses): BlockRazorRawInspection;
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
/**
 * Persistent BlockRazor BSC Public Mempool client. It never sends a transaction
 * and its only RPC is the documented server-streaming Gateway/NewTxs method.
 */
export declare class BlockRazorPublicMempoolFeed {
    private readonly options;
    private client;
    private stream;
    private reconnectTimer;
    private metricsTimer;
    private stopped;
    private generation;
    private sequence;
    private reconnectDelayMs;
    private lastMessageUnixMs;
    private lastTargetUnixMs;
    private readonly targetMap;
    private readonly predecessors;
    private readonly orphanTargets;
    private readonly emittedTargetHashes;
    private readonly orphanTargetTtlNs;
    private readonly orphanTargetCapacity;
    private readonly monotonicNow;
    private readonly counters;
    constructor(options: BlockRazorPublicFeedOptions, dependencies?: BlockRazorPublicFeedDependencies);
    start(): void;
    stop(): void;
    snapshot(): BlockRazorPublicFeedMetrics;
    private connect;
    private scheduleReconnect;
    private handleReply;
    private rememberOrphanTarget;
    private recoverOrphanTarget;
    private emitTarget;
    private wasTargetEmitted;
    private pruneTargetCorrelationState;
    private trimOldest;
    private resetTargetCorrelationState;
    private publishState;
}
