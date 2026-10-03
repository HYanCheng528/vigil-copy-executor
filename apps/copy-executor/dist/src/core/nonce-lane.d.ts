export type NonceLaneState = "unsynchronized" | "ready" | "reserved" | "submitted" | "external_pending" | "needs_sync";
export type NonceSpan = 1 | 2;
export interface NonceLease {
    laneId: string;
    targetHash: string;
    startNonce: number;
    span: NonceSpan;
    reservedAtMonoNs: string;
    validUntilBlock: number;
    submittedBuilders: string[];
}
export interface NonceLaneSnapshot {
    laneId: string;
    state: NonceLaneState;
    nextNonce: number | null;
    lease: NonceLease | null;
    generation: number;
    externalPending: {
        nonce: number;
        hash: string | null;
    } | null;
}
export interface NonceRefreshResult {
    applied: boolean;
    snapshot: NonceLaneSnapshot;
}
/**
 * A lane is one funded signing wallet. All builders for one target share the
 * same lease; a different target can never reuse or leapfrog that nonce span.
 * Expiry intentionally requires a fresh pending-nonce sync instead of guessing
 * whether a private builder retained the candidate.
 */
export declare class NonceLane {
    readonly laneId: string;
    private currentState;
    private nextNonce;
    private lease;
    private generation;
    private externalPending;
    constructor(laneId: string);
    snapshot(): NonceLaneSnapshot;
    /** Captures the exact in-memory lane generation before an asynchronous RPC read. */
    refreshGuard(): number;
    /** Apply an asynchronous refresh only while the lane is still the same ready generation. */
    synchronizeIfUnchanged(latestNonce: number, pendingNonce: number, guard: number): NonceRefreshResult;
    /**
     * Routine head/pending observations may move an optimistically allocated
     * signing frontier forward, never backward. A later authoritative enable or
     * explicit recovery can still use synchronizeIfUnchanged for exact reset.
     */
    advanceIfUnchanged(latestNonce: number, pendingNonce: number, guard: number): NonceRefreshResult;
    /** A verified external pending transaction blocks reuse until latest catches pending. */
    observeExternalPending(transactionNonce: number, hash?: string | null): NonceLaneSnapshot;
    synchronize(pendingNonce: number): NonceLaneSnapshot;
    reserve(targetHash: string, validUntilBlock: number, nowMonoNs: string, span?: NonceSpan): NonceLease;
    markSubmitted(targetHash: string, builder: string): NonceLaneSnapshot;
    /** Release a candidate that was prepared locally but never sent anywhere. */
    releaseUnsubmitted(targetHash: string): NonceLaneSnapshot;
    markIncluded(targetHash: string): NonceLaneSnapshot;
    /**
     * A real dispatch has synchronously started for this exact signed span. Move
     * only the local signing frontier so later targets can be pipelined; chain
     * inclusion and risk finality remain the caller's independent background
     * responsibility.
     */
    optimisticCommit(targetHash: string): NonceLaneSnapshot;
    markExpired(targetHash: string): NonceLaneSnapshot;
    markNonceConflict(): NonceLaneSnapshot;
    private requireLease;
}
