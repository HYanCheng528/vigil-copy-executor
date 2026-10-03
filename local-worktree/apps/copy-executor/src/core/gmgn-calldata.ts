import type { ExecutionMode, HexString, TargetStrategy } from "./messages.js";

export const GMGN_ROUTER_ADDRESS = "0x1de460f363af910f51726def188f9004276bf4bc";
export const GMGN_SWAP_SELECTOR = "0x4d819a2a";
export const BSC_WBNB_ADDRESS = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

const BSC_QUOTE_ASSETS = new Set([
  BSC_WBNB_ADDRESS,
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
  "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
  "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", // FDUSD
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UINT24_MAX = (1n << 24n) - 1n;
const INT24_MAX = (1n << 23n) - 1n;
const INT24_SIGN_EXTENDED_MIN = (1n << 256n) - (1n << 23n);

interface DecodedDescriptor {
  swapType: bigint;
  tokenIn: string;
  tokenOut: string;
  poolAddress: string;
  hookDataLength: number;
}

interface DecodedGmgnSwap {
  descs: readonly DecodedDescriptor[];
  feeToken: string;
  amountIn: bigint;
  minReturn: bigint;
  deadline: bigint;
}

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

function parseCanonicalSwap(input: HexString): DecodedGmgnSwap {
  if (!/^0x[0-9a-fA-F]+$/.test(input) || (input.length - 2) % 2 !== 0) {
    throw new Error("GMGN calldata must be complete hexadecimal bytes");
  }
  if (input.slice(0, 10).toLowerCase() !== GMGN_SWAP_SELECTOR) {
    throw new Error("GMGN calldata selector is not the audited swap function");
  }
  const bodyCharacters = input.length - 10;
  if (bodyCharacters < 5 * 64 || bodyCharacters % 64 !== 0) {
    throw new Error("GMGN calldata is not canonical 32-byte ABI words");
  }
  const bodyWordCount = bodyCharacters / 64;
  const word = (index: number): bigint => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= bodyWordCount) {
      throw new Error("GMGN calldata ABI offset is out of bounds");
    }
    return BigInt(`0x${input.slice(10 + (index * 64), 10 + ((index + 1) * 64))}`);
  };
  const wordHex = (index: number): string => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= bodyWordCount) {
      throw new Error("GMGN calldata ABI offset is out of bounds");
    }
    return input.slice(10 + (index * 64), 10 + ((index + 1) * 64)).toLowerCase();
  };
  const addressWord = (index: number): string => {
    const encoded = wordHex(index);
    if (!/^0{24}[0-9a-f]{40}$/.test(encoded)) throw new Error("GMGN calldata contains a non-canonical address word");
    return `0x${encoded.slice(24)}`;
  };
  const safeNumber = (value: bigint, field: string): number => {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field} is outside the safe integer range`);
    return Number(value);
  };

  // The top-level tuple[] is the only dynamic argument, so canonical ABI puts
  // its data immediately after the five-word head at byte offset 0xa0.
  if (word(0) !== 160n) throw new Error("GMGN descriptor array is not at its canonical ABI offset");
  const feeToken = addressWord(1);
  const amountIn = word(2);
  const minReturn = word(3);
  const deadline = word(4);
  const arrayStartWord = 5;
  const descriptorCount = safeNumber(word(arrayStartWord), "GMGN descriptor count");
  if (descriptorCount < 1 || descriptorCount > 8) throw new Error("GMGN route length is outside the audited range");

  // Dynamic tuple offsets are relative to the first offset word (the byte just
  // after array length), not to the function head.
  const offsetBaseWord = arrayStartWord + 1;
  const descriptorStarts: number[] = [];
  for (let index = 0; index < descriptorCount; index += 1) {
    const offsetBytes = word(offsetBaseWord + index);
    if (offsetBytes % 32n !== 0n) throw new Error("GMGN descriptor offset is not word-aligned");
    const offsetWords = safeNumber(offsetBytes / 32n, "GMGN descriptor offset");
    if (index === 0 && offsetWords !== descriptorCount) {
      throw new Error("GMGN first descriptor is not at its canonical ABI offset");
    }
    const start = offsetBaseWord + offsetWords;
    if (start < offsetBaseWord + descriptorCount || start + 10 > bodyWordCount) {
      throw new Error("GMGN descriptor offset is out of bounds");
    }
    if (descriptorStarts.length > 0 && start <= descriptorStarts.at(-1)!) {
      throw new Error("GMGN descriptor offsets are not strictly increasing");
    }
    descriptorStarts.push(start);
  }

  const descriptors: DecodedDescriptor[] = [];
  for (let index = 0; index < descriptorStarts.length; index += 1) {
    const start = descriptorStarts[index]!;
    const swapType = word(start);
    const fee = word(start + 4);
    const tickSpacing = word(start + 5);
    if (swapType > 255n || fee > UINT24_MAX) throw new Error("GMGN descriptor integer exceeds its ABI width");
    if (tickSpacing > INT24_MAX && tickSpacing < INT24_SIGN_EXTENDED_MIN) {
      throw new Error("GMGN tickSpacing is not a canonical int24");
    }
    const tokenIn = addressWord(start + 1);
    const tokenOut = addressWord(start + 2);
    const poolAddress = addressWord(start + 3);
    addressWord(start + 6); // hooks
    addressWord(start + 8); // poolManager

    const hookOffsetBytes = word(start + 7);
    if (hookOffsetBytes !== 320n) throw new Error("GMGN hookData is not at its canonical tuple offset");
    const hookLengthWord = start + 10;
    const hookDataLength = safeNumber(word(hookLengthWord), "GMGN hookData length");
    if (hookDataLength > 4_096) throw new Error("GMGN hook data is outside the audited size limit");
    const hookDataWords = Math.ceil(hookDataLength / 32);
    const descriptorEnd = hookLengthWord + 1 + hookDataWords;
    const expectedEnd = index + 1 < descriptorStarts.length ? descriptorStarts[index + 1]! : bodyWordCount;
    if (descriptorEnd !== expectedEnd) throw new Error("GMGN descriptor has non-canonical dynamic length or trailing data");
    if (hookDataLength % 32 !== 0 && hookDataWords > 0) {
      const usedHexCharacters = (hookDataLength % 32) * 2;
      const padding = wordHex(descriptorEnd - 1).slice(usedHexCharacters);
      if (!/^0*$/.test(padding)) throw new Error("GMGN hookData has non-zero ABI padding");
    }
    descriptors.push({ swapType, tokenIn, tokenOut, poolAddress, hookDataLength });
  }

  return { descs: descriptors, feeToken, amountIn, minReturn, deadline };
}

/** Deferred bookkeeping helper; never called by the pending-to-dispatch path. */
export function finalTokenFromGmgnCalldata(input: HexString): string {
  const route = parseCanonicalSwap(input).descs;
  for (let index = 1; index < route.length; index += 1) {
    if (route[index - 1]!.tokenOut !== route[index]!.tokenIn) {
      throw new Error("GMGN route is not token-continuous");
    }
  }
  const token = route.at(-1)?.tokenOut;
  if (!token || BSC_QUOTE_ASSETS.has(token.toLowerCase())) throw new Error("GMGN route does not end in a bought token");
  return token.toLowerCase();
}

function normalizeAddress(value: string, field: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${field} is not an EVM address`);
  return value.toLowerCase();
}

function replaceHeadWord(input: HexString, wordIndex: number, value: bigint): HexString {
  if (value < 0n || value >= (1n << 256n)) throw new Error("replacement word does not fit uint256");
  const start = 10 + (wordIndex * 64);
  const encoded = value.toString(16).padStart(64, "0");
  return `${input.slice(0, start)}${encoded}${input.slice(start + 64)}` as HexString;
}

function readHeadWord(input: HexString, wordIndex: number): bigint {
  const start = 10 + (wordIndex * 64);
  const end = start + 64;
  if (end > input.length) throw new Error("GMGN calldata head is truncated");
  return BigInt(`0x${input.slice(start, end)}`);
}

function differingWordIndexes(before: HexString, after: HexString): number[] {
  if (before.length !== after.length) throw new Error("calldata rewrite changed byte length");
  const beforeWords = before.slice(10).match(/.{64}/g) ?? [];
  const afterWords = after.slice(10).match(/.{64}/g) ?? [];
  const differences: number[] = [];
  for (let index = 0; index < beforeWords.length; index += 1) {
    if (beforeWords[index] !== afterWords[index]) differences.push(index);
  }
  return differences;
}

export function deriveEdMinReturn(
  originalAmountIn: bigint,
  originalMinReturn: bigint,
  followAmountIn: bigint,
  retentionBps = 10_000,
): bigint {
  if (originalAmountIn <= 0n || originalMinReturn <= 0n || followAmountIn <= 0n) {
    throw new Error("Ed minReturn scaling requires positive values");
  }
  if (!Number.isSafeInteger(retentionBps) || retentionBps < 1 || retentionBps > 10_000) {
    throw new Error("Ed minReturn retention must be between 1 and 10000 bps");
  }
  const scaled = (originalMinReturn * followAmountIn) / originalAmountIn;
  const retained = (scaled * BigInt(retentionBps)) / 10_000n;
  if (retained <= 0n) throw new Error("derived Ed minReturn rounded to zero");
  return retained;
}

/**
 * Minimal public-orderflow clone. The target's dynamic GMGN route remains an
 * opaque byte template: amountIn (head word 2), minReturn (head word 3), and
 * the source deadline (head word 4) change. Token metadata, pool decoding, quotes and recipient extraction are
 * deliberately absent from the machine-first path.
 */
export function fastGmgnBuyTemplate(request: FastGmgnBuyTemplateRequest): FastGmgnBuyTemplate {
  if (normalizeAddress(request.targetTo, "targetTo") !== GMGN_ROUTER_ADDRESS) {
    throw new Error("target transaction does not call the GMGN router");
  }
  const input = request.targetInput;
  if (!/^0x[0-9a-fA-F]+$/.test(input) || (input.length - 2) % 2 !== 0) {
    throw new Error("GMGN calldata must be complete hexadecimal bytes");
  }
  if (input.slice(0, 10).toLowerCase() !== GMGN_SWAP_SELECTOR) {
    throw new Error("GMGN calldata selector is not the swap function");
  }
  if (input.length < 10 + (5 * 64)) throw new Error("GMGN calldata head is truncated");
  if (request.followAmountInWei <= 0n || request.followAmountInWei >= (1n << 256n)) {
    throw new Error("follow amount must be a positive uint256");
  }

  const originalAmountIn = readHeadWord(input, 2);
  const originalMinReturn = readHeadWord(input, 3);
  if (originalAmountIn <= 0n || request.targetValueWei !== originalAmountIn) {
    throw new Error("GMGN target is not a native-BNB amountIn template");
  }

  let calldata = replaceHeadWord(input, 2, request.followAmountInWei);
  calldata = replaceHeadWord(calldata, 3, 0n);
  calldata = replaceHeadWord(calldata, 4, 0n);
  const differences = differingWordIndexes(input, calldata);
  if (differences.some((index) => index !== 2 && index !== 3 && index !== 4)) {
    throw new Error("GMGN fast clone changed an unexpected calldata word");
  }
  return {
    calldata,
    valueWei: request.followAmountInWei,
    originalAmountIn,
    originalMinReturn,
    amountIn: request.followAmountInWei,
    minReturn: 0n,
    differingWordIndexes: differences,
  };
}

/**
 * Clones only the audited GMGN native-BNB buy shape. The dynamic route bytes are
 * preserved byte-for-byte. Both dedicated follower wallets change only head
 * words 2/3/4: fixed BNB input, zero minReturn, and no inherited deadline.
 * Any other mutation is treated as a programming error.
 */
export function rewriteGmgnSwapCalldata(request: RewriteGmgnSwapRequest): RewrittenGmgnSwap {
  if (normalizeAddress(request.targetTo, "targetTo") !== GMGN_ROUTER_ADDRESS) {
    throw new Error("target transaction does not call the audited GMGN router");
  }
  if (request.followAmountInWei <= 0n || request.followAmountInWei >= (1n << 256n)) {
    throw new Error("follow amount must be a positive uint256");
  }

  const targetSenderHex = normalizeAddress(request.targetSender, "targetSender").slice(2);
  if (request.targetInput.toLowerCase().includes(targetSenderHex)) {
    throw new Error("target calldata embeds the original sender and cannot be safely cloned");
  }

  const decoded = parseCanonicalSwap(request.targetInput);
  if (decoded.amountIn <= 0n) throw new Error("target amountIn must be positive");
  if (request.executionMode === "live" && request.allowZeroMinReturnInLive !== true) {
    throw new Error("live zero-minReturn clone requires the explicit ALLOW_ZERO_MIN_RETURN safety gate");
  }
  if (request.targetValueWei !== decoded.amountIn) {
    throw new Error("only native-BNB swaps whose msg.value equals amountIn are allowed");
  }
  if (!request.allowNonZeroFeeToken && decoded.feeToken !== ZERO_ADDRESS) {
    throw new Error("non-zero GMGN feeToken is outside the audited clone policy");
  }

  const route = decoded.descs;
  for (let index = 1; index < route.length; index += 1) {
    if (route[index - 1]!.tokenOut !== route[index]!.tokenIn) throw new Error("GMGN route is not token-continuous");
  }
  if (!new Set([BSC_WBNB_ADDRESS, ZERO_ADDRESS]).has(route[0]!.tokenIn.toLowerCase())) {
    throw new Error("only an audited native-BNB or WBNB-input route is allowed");
  }
  const tokenOut = route.at(-1)!.tokenOut;
  if (BSC_QUOTE_ASSETS.has(tokenOut.toLowerCase())) throw new Error("target route is not a token buy");
  for (const descriptor of route) {
    if (descriptor.hookDataLength > 4_096) throw new Error("GMGN hook data is outside the audited size limit");
  }

  const minReturn = 0n;
  let calldata = replaceHeadWord(request.targetInput, 2, request.followAmountInWei);
  calldata = replaceHeadWord(calldata, 3, minReturn);
  calldata = replaceHeadWord(calldata, 4, 0n);

  const differences = differingWordIndexes(request.targetInput, calldata);
  const allowed = new Set([2, 3, 4]);
  if (differences.some((index) => !allowed.has(index))) {
    throw new Error("GMGN clone changed an unaudited calldata word");
  }
  if (!differences.includes(2) && request.followAmountInWei !== decoded.amountIn) {
    throw new Error("GMGN clone did not apply the requested amountIn");
  }

  return {
    calldata,
    valueWei: request.followAmountInWei,
    originalAmountIn: decoded.amountIn,
    amountIn: request.followAmountInWei,
    originalMinReturn: decoded.minReturn,
    minReturn,
    tokenIn: route[0]!.tokenIn,
    tokenOut,
    targetTokenAddress: tokenOut,
    routeLength: route.length,
    differingWordIndexes: differences,
  };
}
