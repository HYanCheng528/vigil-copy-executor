import { type HexString, type TargetTransactionWire } from "./core/messages.js";
export interface RpcReceipt {
    transactionHash: HexString;
    blockHash: HexString;
    blockNumber: number;
    transactionIndex: number;
    status: number;
    gasUsed: bigint;
    effectiveGasPrice: bigint;
}
export interface RpcMinedTargetTransaction {
    transaction: TargetTransactionWire;
    blockNumber: number;
    blockHash: HexString;
}
export declare class ExecutorRpcClient {
    private readonly url;
    private readonly timeoutMs;
    private readonly fetchImpl;
    private id;
    constructor(url: string, timeoutMs?: number, fetchImpl?: typeof fetch);
    request(method: string, params: unknown[], timeoutMs?: number): Promise<unknown>;
    nonce(address: string, blockTag: "latest" | "pending"): Promise<number>;
    latestNonce(address: string): Promise<number>;
    pendingNonce(address: string): Promise<number>;
    balance(address: string): Promise<bigint>;
    tokenBalance(token: string, owner: string): Promise<bigint>;
    tokenMetadata(token: string): Promise<{
        symbol: string | null;
        decimals: number | null;
    }>;
    blockNumber(): Promise<number>;
    assertBscChain(): Promise<void>;
    receipt(hash: string): Promise<RpcReceipt | null>;
    transactionValue(hash: string): Promise<bigint | null>;
    /**
     * Hydrates one already-mined legacy transaction after a strict Router log.
     * It intentionally performs no receipt/metadata/quote reads.
     */
    minedTargetTransaction(hash: string, timeoutMs?: number): Promise<RpcMinedTargetTransaction | null>;
    assertAtomicExecutor(address: string, expectedOwner: string): Promise<void>;
}
