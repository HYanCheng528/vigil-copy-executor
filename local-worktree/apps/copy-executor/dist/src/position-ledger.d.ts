import type { TargetStrategy } from "./core/messages.js";
export interface PositionSnapshot {
    strategy: TargetStrategy;
    tokenAddress: string;
    symbol: string | null;
    decimals: number | null;
    balanceRaw: string;
    acquiredAt: string;
    updatedAt: string;
    sourceTxHash: string;
    status: "open" | "closed";
}
export interface PositionReader {
    tokenBalance(token: string, owner: string): Promise<bigint>;
    tokenMetadata(token: string): Promise<{
        symbol: string | null;
        decimals: number | null;
    }>;
    close?(): void | Promise<void>;
}
export interface PositionLedgerDependencies {
    writeDocument?: (path: string, contents: string) => Promise<void>;
    now?: () => Date;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
    onError?: (reason: string) => void;
    reconcileConcurrency?: number;
}
export declare class PositionLedger {
    private readonly path;
    private readonly reader;
    private readonly wallets;
    private readonly reconcileIntervalMs;
    private readonly positions;
    private readonly writeDocument;
    private readonly now;
    private readonly setIntervalImpl;
    private readonly clearIntervalImpl;
    private readonly onError;
    private readonly reconcileConcurrency;
    private writes;
    private work;
    private timer;
    private stopped;
    private reconciling;
    constructor(path: string | null, reader: PositionReader | null, wallets: Record<TargetStrategy, string | null>, reconcileIntervalMs: number, dependencies?: PositionLedgerDependencies);
    start(): Promise<void>;
    get enabled(): boolean;
    stop(): Promise<void>;
    snapshot(): {
        positions: PositionSnapshot[];
    };
    recordIncluded(request: {
        strategy: TargetStrategy;
        tokenAddress: string;
        sourceTxHash: string;
        acquiredAt?: string;
    }): void;
    private track;
    private record;
    private reconcile;
    private load;
    private mutate;
    private persist;
    private currentTimestamp;
}
