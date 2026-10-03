import { BuilderClient } from "./builders.js";
import { type HexString, type TargetStrategy } from "./core/messages.js";
import { HotSigner } from "./hot-signer.js";
import { type RpcMinedTargetTransaction, type RpcReceipt } from "./rpc-client.js";
export declare const BLOCKRAZOR_ONEOFF_CONFIRMATION = "I_ACCEPT_ONE_BLOCKRAZOR_0.001_BNB_BUY_PLUS_EXPLICIT_TIP";
export declare const BLOCKRAZOR_ONEOFF_AMOUNT_WEI: bigint;
export declare const BLOCKRAZOR_ONEOFF_EXPECTED_TOKEN: string;
type OneOffStage = "prepared" | "submitted" | "included" | "not_included" | "unresolved";
interface StoredReceipt {
    transactionHash: HexString;
    blockHash: HexString;
    blockNumber: number;
    transactionIndex: number;
    status: number;
    gasUsed: string;
    effectiveGasPrice: string;
}
export interface BlockRazorOneOffState {
    version: 1;
    kind: "blockrazor_oneoff_public_buy";
    stage: OneOffStage;
    strategy: TargetStrategy;
    signer: string;
    targetHash: HexString;
    targetBlock: number;
    targetBlockHash: HexString;
    amountWei: string;
    tipWei: string;
    gasPriceWei: string;
    gasLimit: string;
    nonce: number;
    tokenOut: string;
    calldataHash: HexString;
    buyHash: HexString;
    tipHash: HexString;
    envelopeMaxBlock: number;
    envelopeMaxTimestamp: number;
    envelopeBodyHash: HexString;
    dispatchAttempts: number;
    bundleIds: string[];
    lastAckHttpStatus: number | null;
    buyReceipt: StoredReceipt | null;
    tipReceipt: StoredReceipt | null;
    actualCostWei: string | null;
    reason: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface BlockRazorOneOffRpc {
    assertBscChain(): Promise<void>;
    minedTargetTransaction(hash: string, timeoutMs?: number): Promise<RpcMinedTargetTransaction | null>;
    latestNonce(address: string): Promise<number>;
    pendingNonce(address: string): Promise<number>;
    balance(address: string): Promise<bigint>;
    blockNumber(): Promise<number>;
    receipt(hash: string): Promise<RpcReceipt | null>;
    request(method: string, params: unknown[], timeoutMs?: number): Promise<unknown>;
}
export interface BlockRazorOneOffOptions {
    confirmation: string;
    strategy: TargetStrategy;
    targetHash: HexString;
    amountWei: bigint;
    tipWei: bigint;
    expectedToken: string;
    expectedSigner: string;
    gasPriceWei: bigint;
    gasLimit: bigint;
    preflightOnly: boolean;
    stateFile: string | null;
    signer: HotSigner;
    rpc: BlockRazorOneOffRpc;
    builder: BuilderClient;
    now?: () => Date;
    waitForBlock?: (minimumBlock: number, rpc: BlockRazorOneOffRpc) => Promise<number>;
    totalTimeoutMs?: number;
}
export interface BlockRazorOneOffResult {
    mode: "preflight-only" | "broadcast";
    stage: OneOffStage | "preflight";
    strategy: TargetStrategy;
    signer: string;
    targetHash: HexString;
    targetBlock: number;
    tokenOut: string;
    nonce: number;
    buyHash: HexString;
    tipHash: HexString;
    envelopeMaxBlock: number;
    gasEstimate: string;
    maximumCostWei: string;
    dispatchAttempts: number;
    bundleIds: string[];
    actualCostWei: string | null;
    reason: string | null;
}
/** First publication is O_EXCL+fsync, so no network write can precede the journal. */
export declare function createOneOffStateExclusive(path: string, state: BlockRazorOneOffState): void;
export declare function persistOneOffState(path: string, state: BlockRazorOneOffState): void;
export declare function readOneOffState(path: string): BlockRazorOneOffState;
export declare function runBlockRazorOneOff(options: BlockRazorOneOffOptions): Promise<BlockRazorOneOffResult>;
export {};
