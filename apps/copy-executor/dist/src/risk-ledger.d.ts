import type { TargetStrategy } from "./core/messages.js";
export interface RiskLedgerPaths {
    global: string;
    ed: string;
    kuzuo: string;
}
/**
 * One operator-facing base path deterministically names three independent
 * durability domains. The base file is the global emergency circuit; each
 * wallet lane gets its own file and therefore its own fsync queue.
 */
export declare function riskLedgerPaths(basePath: string): RiskLedgerPaths;
export type RiskAttemptState = "reserved" | "settled" | "not_included" | "unknown_charged";
export type RiskOrderingMode = "same_block_after" | "next_block_after" | "any_block_after";
export interface RiskAttemptReservation {
    chainId: number;
    signer: string;
    nonce: number;
    strategy: TargetStrategy;
    targetHash: string;
    candidateHashes: readonly string[];
    /** Separate nonce N+1 Builder payments; never infer their inclusion from the buy. */
    tipCandidateHashes?: readonly string[];
    maxBlock: number;
    worstCostWei: bigint;
    orderingMode?: RiskOrderingMode;
    /** One atomic copy transaction increments the daily audit counter. */
    reservedTrades?: 1;
}
export interface RiskAttemptSnapshot {
    key: string;
    chainId: number;
    signer: string;
    nonce: number;
    strategy: TargetStrategy;
    targetHash: string;
    candidateHashes: string[];
    tipCandidateHashes: string[];
    maxBlock: number;
    /** Latest Builder maxBlockNumber that was actually handed to dispatch. */
    lastSubmittedBlock: number;
    worstCostWei: string;
    orderingMode: RiskOrderingMode;
    reservedTrades: 1;
    state: RiskAttemptState;
    actualCostWei: string | null;
    accountedUtcDate: string | null;
    reservedAt: string;
    lastSubmissionAt: string;
    resolvedAt: string | null;
}
export interface RiskCircuitState {
    tripped: boolean;
    reason: string | null;
    trippedAt: string | null;
}
export interface RiskLedgerLaneIdentity {
    signer: string;
    executor: string;
}
export interface RiskLedgerIdentity {
    chainId: number;
    lanes: Record<TargetStrategy, RiskLedgerLaneIdentity | null>;
}
export interface RiskLedgerSnapshot {
    version: 2;
    identity: RiskLedgerIdentity | null;
    utcDate: string;
    spentWei: Record<TargetStrategy, string>;
    includedTrades: Record<TargetStrategy, number>;
    attempts: Record<string, RiskAttemptSnapshot>;
    circuit: RiskCircuitState;
}
export interface RiskLedgerDependencies {
    now?: () => Date;
    writeDocument?: (path: string, contents: string) => Promise<void>;
}
export declare function riskAttemptKey(identity: Pick<RiskAttemptReservation, "chainId" | "signer" | "nonce">): string;
export declare class RiskLedger {
    private readonly path;
    private document;
    private readonly now;
    private readonly writeDocument;
    private writeTail;
    private latestPersist;
    private loaded;
    private existedAtLoad;
    constructor(path: string | null, dependencies?: RiskLedgerDependencies);
    load(options?: {
        requireExisting?: boolean;
    }): Promise<void>;
    /**
     * Bind the durable ledger to the exact BSC signer/Executor topology.
     * Only dry-sign may initialize a brand-new path. Live must match an existing
     * identity, so deleting or redirecting the file cannot erase attempt history
     * or bypass circuit reconciliation.
     */
    ensureIdentity(identity: RiskLedgerIdentity, initializeMissing: boolean): Promise<void>;
    /** Confirmed daily spend plus worst-case cost of every unresolved attempt. */
    spent(strategy: TargetStrategy): bigint;
    /** Confirmed daily trades plus the slot reserved by every unresolved attempt. */
    trades(strategy: TargetStrategy): number;
    attempt(key: string): RiskAttemptSnapshot | null;
    circuitState(): RiskCircuitState;
    /**
     * Persistently reserves worst-case spend and one trade before submission.
     * Repeating the same identity is idempotent; candidate hashes may only grow.
     */
    reserveAttempt(reservation: RiskAttemptReservation): Promise<RiskAttemptSnapshot>;
    /** Settle a known inclusion. Unknown conservative charge is adjusted, never added twice. */
    settleAttemptActual(key: string, actualCostWei: bigint): Promise<RiskAttemptSnapshot>;
    /** Release only after authoritative proof that no candidate was included. */
    releaseConfirmedNotIncluded(key: string): Promise<RiskAttemptSnapshot>;
    /**
     * If nonce consumption cannot be reconciled, charge worst cost and one trade.
     * A later receipt may call settleAttemptActual to adjust this same attempt.
     */
    chargeUnknownConsumption(key: string): Promise<RiskAttemptSnapshot>;
    /** Legacy inclusion API retained until Engine adopts attempt settlement. */
    recordIncluded(strategy: TargetStrategy, costWei: bigint): Promise<void>;
    /** First trip wins and survives UTC rotation/restart until clearCircuit is called. */
    tripCircuit(reason: string): Promise<RiskCircuitState>;
    /** Deliberately explicit operator/application action; no startup or date path calls it. */
    clearCircuit(): Promise<RiskCircuitState>;
    snapshot(): RiskLedgerSnapshot;
    /** Explicit retry/barrier for callers that need durable-before-submit semantics. */
    persist(): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
    private persistReturning;
    private requireAttempt;
    private addConfirmed;
    private rotateIfNeeded;
    private rotateReadIfNeeded;
}
