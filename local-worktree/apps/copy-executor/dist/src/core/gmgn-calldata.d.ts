import type { ExecutionMode, HexString, TargetStrategy } from "./messages.js";
export declare const GMGN_ROUTER_ADDRESS = "0x1de460f363af910f51726def188f9004276bf4bc";
export declare const GMGN_SWAP_SELECTOR = "0x4d819a2a";
export declare const BSC_WBNB_ADDRESS = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
export interface RewriteGmgnSwapRequest {
    executionMode: ExecutionMode;
    strategy: TargetStrategy;
    targetSender: string;
    targetTo: string;
    targetInput: HexString;
    targetValueWei: bigint;
    followAmountInWei: bigint;
    /** 10_000 reproduces the exact proportional Ed clone seen in history. */
    edMinReturnRetentionBps?: number;
    allowNonZeroFeeToken?: boolean;
    /** Required in live mode for audited 枯坐 calls whose minReturn is zero. */
    allowZeroMinReturnInLive?: boolean;
}
export interface RewrittenGmgnSwap {
    calldata: HexString;
    valueWei: bigint;
    originalAmountIn: bigint;
    amountIn: bigint;
    originalMinReturn: bigint;
    minReturn: bigint;
    tokenIn: string;
    tokenOut: string;
    targetTokenAddress: string;
    routeLength: number;
    differingWordIndexes: number[];
}
export interface FastGmgnBuyTemplateRequest {
    targetTo: string;
    targetInput: HexString;
    targetValueWei: bigint;
    followAmountInWei: bigint;
}
export interface FastGmgnBuyTemplate {
    calldata: HexString;
    valueWei: bigint;
    originalAmountIn: bigint;
    originalMinReturn: bigint;
    amountIn: bigint;
    minReturn: 0n;
    differingWordIndexes: number[];
}
/** Deferred bookkeeping helper; never called by the pending-to-dispatch path. */
export declare function finalTokenFromGmgnCalldata(input: HexString): string;
export declare function deriveEdMinReturn(originalAmountIn: bigint, originalMinReturn: bigint, followAmountIn: bigint, retentionBps?: number): bigint;
/**
 * Minimal public-orderflow clone. The target's dynamic GMGN route remains an
 * opaque byte template: amountIn (head word 2), minReturn (head word 3), and
 * the source deadline (head word 4) change. Token metadata, pool decoding, quotes and recipient extraction are
 * deliberately absent from the machine-first path.
 */
export declare function fastGmgnBuyTemplate(request: FastGmgnBuyTemplateRequest): FastGmgnBuyTemplate;
/**
 * Clones only the audited GMGN native-BNB buy shape. The dynamic route bytes are
 * preserved byte-for-byte. Both dedicated follower wallets change only head
 * words 2/3/4: fixed BNB input, zero minReturn, and no inherited deadline.
 * Any other mutation is treated as a programming error.
 */
export declare function rewriteGmgnSwapCalldata(request: RewriteGmgnSwapRequest): RewrittenGmgnSwap;
