import { ExecutorRpcClient } from "./rpc-client.js";
import type { PositionReader } from "./position-ledger.js";
interface PositionRpcEndpoint {
    client: Pick<ExecutorRpcClient, "tokenBalance" | "tokenMetadata">;
    close(): void;
}
export interface PositionRpcReaderDependencies {
    endpointFactory?: (url: string, timeoutMs: number, permits: RpcPermitPool) => PositionRpcEndpoint;
}
/** A single cap shared by every preferred and fallback HTTP endpoint. */
export declare class RpcPermitPool {
    readonly limit: number;
    private active;
    private readonly waiters;
    constructor(limit: number);
    run<T>(operation: () => Promise<T>): Promise<T>;
}
export declare class PositionRpcReader implements PositionReader {
    private readonly endpoints;
    private closed;
    constructor(preferredUrls: readonly string[], fallbackUrl: string | null, timeoutMs: number, concurrency: number, dependencies?: PositionRpcReaderDependencies);
    tokenBalance(token: string, owner: string): Promise<bigint>;
    tokenMetadata(token: string): Promise<{
        symbol: string | null;
        decimals: number | null;
    }>;
    close(): void;
    private firstAvailable;
}
export {};
