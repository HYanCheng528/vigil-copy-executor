export type HexString = `0x${string}`;
export declare const EXECUTION_SIGNAL_VERSION: 1;
export declare const BSC_CHAIN_ID: 56;
export declare const ED_TARGET_ADDRESS: string;
export declare const KUZUO_TARGET_ADDRESS: string;
export declare const KNOWN_BUILDER_TIP_RECIPIENTS: Set<string>;
export type TargetStrategy = "ed" | "kuzuo";
export type ExecutionMode = "observe" | "shadow" | "dry-sign" | "live";
export type TargetSignalSource = "bsc_pending_full" | "blockrazor_public_mempool" | "blockrazor_private_mempool" | "club48_auction" | "blockrazor_orderflow" | "jet_orderflow" | "confirmed_log_fallback";
export interface TargetTransactionWire {
    hash: HexString;
    rawTransaction?: HexString;
    chainId: typeof BSC_CHAIN_ID;
    type: 0;
    from: string;
    to: string;
    nonce: number;
    gasPriceWei: string;
    gasLimit: string;
    valueWei: string;
    input: HexString;
}
export type BlockRazorPrivateRegion = "tokyo" | "new-york" | "frankfurt" | "dublin";
/**
 * BlockRazor's Private Mempool deliberately discloses selected transaction
 * fields, not the signed raw transaction or its gas envelope. Keeping this as
 * a separate wire type prevents callers from inventing gas/raw values merely
 * to fit TargetTransactionWire.
 */
export interface BlockRazorPrivateTransactionWire {
    disclosure: "blockrazor_private";
    hash: HexString;
    chainId: typeof BSC_CHAIN_ID;
    from: string;
    to: string;
    nonce: number;
    valueWei: string;
    input: HexString;
    functionSelector: HexString;
    logCount: number;
}
export interface BlockRazorPrivateBundleContext {
    bundleHash: HexString;
    region: BlockRazorPrivateRegion;
    nextBlockNumber: number;
    maxBlockNumber: number;
    proxyBidContract: string;
    refundAddress: string;
    /** Normalized unsigned integer. The stream calls this `int`; proxyBid uses uint256. */
    refundCfg: string;
    targetIndex: number;
    transactionCount: number;
    logsVerified: true;
    routerSwapVerified: true;
}
export type TargetTransactionSignal = TargetTransactionWire | BlockRazorPrivateTransactionWire;
/**
 * In-memory contract between a pre-inclusion source adapter and the execution
 * planner. It is deliberately independent from MonitorEvent: no database or UI
 * serialization is allowed before this message reaches the planner.
 */
export interface TargetSignal {
    version: typeof EXECUTION_SIGNAL_VERSION;
    source: TargetSignalSource;
    sourceSequence: string;
    firstSeenUnixNs: string;
    firstSeenMonoNs: string;
    strategy: TargetStrategy;
    transaction: TargetTransactionSignal;
    /**
     * Same-sender contiguous nonce transactions required before the swap. The
     * audited kuzuo flow uses one nonce-1 plain Builder-tip transfer.
     */
    requiredPredecessors?: TargetTransactionWire[];
    sourceBlockHint?: number;
    blockRazorPrivateBundle?: BlockRazorPrivateBundleContext;
}
/** Small loopback envelope emitted directly by the strict Router-log monitor. */
export interface ConfirmedTargetHint {
    version: 1;
    strategy: TargetStrategy;
    txHash: HexString;
    payer: string;
    blockNumber: number;
    blockHash: HexString;
    logIndex: number;
    observedUnixNs: string;
}
export interface ValidatedTargetSignal extends TargetSignal {
    rawTransactionVerified: boolean;
    predecessorsVerified: boolean;
}
declare const SOURCE_VERIFIED_SIGNAL: unique symbol;
/**
 * Runtime brand for adapters that already performed their source-specific
 * validation: signed-raw recovery for raw feeds, or strict disclosed-field
 * validation for BlockRazor Private. Plain JSON cannot forge this symbol, so
 * external signals still take the full validateTargetSignal path in the engine.
 */
export type SourceVerifiedTargetSignal = ValidatedTargetSignal & {
    readonly [SOURCE_VERIFIED_SIGNAL]: true;
};
export declare function brandSourceVerifiedTargetSignal(signal: ValidatedTargetSignal): SourceVerifiedTargetSignal;
export declare function isSourceVerifiedTargetSignal(signal: TargetSignal): signal is SourceVerifiedTargetSignal;
export interface ExecutionIntent {
    version: typeof EXECUTION_SIGNAL_VERSION;
    mode: ExecutionMode;
    targetHash: HexString;
    targetStrategy: TargetStrategy;
    source: TargetSignalSource;
    laneId: string;
    nonceStart: number;
    nonceSpan: 1 | 2;
    targetTokenAddress: string;
    calldata: HexString;
    valueWei: string;
    amountInWei: string;
    minReturn: string;
    validFromBlock: number;
    validUntilBlock: number;
    createdMonoNs: string;
}
export interface BuilderSubmissionCandidate {
    intent: ExecutionIntent;
    builder: "club48" | "blockrazor" | "jet" | "nodereal";
    targetDependency: {
        kind: "hash";
        hash: HexString;
    } | {
        kind: "raw";
        rawTransaction: HexString;
    };
    executorRawTransaction: HexString;
}
export declare function isBlockRazorPrivateTransaction(transaction: TargetTransactionSignal): transaction is BlockRazorPrivateTransactionWire;
/**
 * Rejects malformed or spoofed target envelopes before calldata planning. If a
 * source supplies the signed raw transaction, every duplicated field is checked
 * against the recovered transaction. Object-only feeds remain explicitly marked
 * unverified so live policy can require a trusted source.
 */
export declare function validateTargetSignal(signal: TargetSignal): ValidatedTargetSignal;
export {};
