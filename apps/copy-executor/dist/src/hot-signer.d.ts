import type { HexString } from "./core/messages.js";
export interface AtomicCopyTransactionRequest {
    executorAddress: string;
    tokenOut: string;
    routerCalldata: HexString;
    swapValueWei: bigint;
    minimumTokenOut: bigint;
    tipRecipient: string;
    builderTipWei: bigint;
    validUntilBlock: number;
    nonce: number;
    gasPriceWei: bigint;
    gasLimit: bigint;
}
export interface PrivateAtomicCopyTransactionRequest {
    executorAddress: string;
    tokenOut: string;
    routerCalldata: HexString;
    swapValueWei: bigint;
    minimumOwnerTokenOut: bigint;
    proxyBidContract: string;
    refundAddress: string;
    refundCfg: bigint;
    proxyBidWei: bigint;
    validUntilBlock: number;
    nonce: number;
    gasPriceWei: bigint;
    gasLimit: bigint;
}
export interface DirectGmgnBuyTransactionRequest {
    routerCalldata: HexString;
    swapValueWei: bigint;
    nonce: number;
    gasPriceWei: bigint;
    gasLimit: bigint;
}
export interface BuilderTipTransactionRequest {
    tipRecipient: string;
    builderTipWei: bigint;
    nonce: number;
    gasPriceWei: bigint;
}
export interface SignedAtomicCopyTransaction {
    rawTransaction: HexString;
    hash: HexString;
    data: HexString;
    valueWei: bigint;
    signedMonoNs: bigint;
}
/**
 * SigningKey signs the already-materialized legacy transaction synchronously.
 * No Promise, RPC, ENS lookup, worker hop, or filesystem access exists here.
 */
export declare class HotSigner {
    readonly address: string;
    private readonly key;
    private warmed;
    constructor(privateKey: string);
    /**
     * Pays the secp256k1/ABI/JIT cold-start cost before any target feed starts.
     * The deterministic dummy transaction is never returned or submitted.
     */
    prewarm(): void;
    /**
     * Public-orderflow fast path: call the audited GMGN Router directly from the
     * dedicated copy wallet. No executor wrapper, token metadata, quote or RPC is
     * needed between first-seen and signing.
     */
    signDirectGmgnBuy(request: DirectGmgnBuyTransactionRequest): SignedAtomicCopyTransaction;
    /** A provider-specific, plain 21k BNB transfer at copy nonce N+1. */
    signBuilderTip(request: BuilderTipTransactionRequest): SignedAtomicCopyTransaction;
    signAtomicCopy(request: AtomicCopyTransactionRequest): SignedAtomicCopyTransaction;
    /** Signs the dedicated BlockRazor proxyBid path synchronously. */
    signPrivateAtomicCopy(request: PrivateAtomicCopyTransactionRequest): SignedAtomicCopyTransaction;
}
export declare function atomicExecutorSelector(): string;
export declare function legacyAtomicExecutorSelector(): string;
export declare function privateAtomicExecutorSelector(): string;
