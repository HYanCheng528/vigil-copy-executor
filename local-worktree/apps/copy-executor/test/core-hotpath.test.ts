import assert from "node:assert/strict";
import test from "node:test";
import { Interface, ZeroAddress, ZeroHash } from "ethers";
import {
  BSC_WBNB_ADDRESS,
  GMGN_ROUTER_ADDRESS,
  deriveEdMinReturn,
  fastGmgnBuyTemplate,
  rewriteGmgnSwapCalldata,
} from "../src/core/gmgn-calldata.js";
import {
  BSC_CHAIN_ID,
  ED_TARGET_ADDRESS,
  EXECUTION_SIGNAL_VERSION,
  validateTargetSignal,
  type HexString,
  type TargetSignal,
} from "../src/core/messages.js";
import { NonceLane } from "../src/core/nonce-lane.js";

const SWAP_INTERFACE = new Interface([
  "function swap((uint8 swapType,address tokenIn,address tokenOut,address poolAddress,uint24 fee,int24 tickSpacing,address hooks,bytes hookData,address poolManager,bytes32 parameters)[] descs,address feeToken,uint256 amountIn,uint256 minReturn,uint256 userFeeRate) payable",
]);
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const TOKEN = "0x4c01062455F91EBd41E74CCb2DC969a176cF7777";
const STOCK_TOKEN = "0x1111111111111111111111111111111111111111";
const POOL_A = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE";
const POOL_B = "0x977DaFFC095b33872E2741c19568925015C35b4d";
const POOL_C = "0x3333333333333333333333333333333333333333";

function encodedSwap(amountIn: bigint, minReturn: bigint, hookData = "0x", deadline = 0n): HexString {
  return SWAP_INTERFACE.encodeFunctionData("swap", [[
    [0, BSC_WBNB_ADDRESS, USDT, POOL_A, 2_500, 50, ZeroAddress, "0x", ZeroAddress, ZeroHash],
    [1, USDT, TOKEN, POOL_B, 2_500, 50, ZeroAddress, hookData, ZeroAddress, ZeroHash],
  ], ZeroAddress, amountIn, minReturn, deadline]) as HexString;
}

function encodedStockBaseSwap(amountIn: bigint, minReturn: bigint): HexString {
  return SWAP_INTERFACE.encodeFunctionData("swap", [[
    [0, BSC_WBNB_ADDRESS, USDT, POOL_A, 2_500, 50, ZeroAddress, "0x", ZeroAddress, ZeroHash],
    [1, USDT, STOCK_TOKEN, POOL_B, 2_500, 50, ZeroAddress, "0x123456", ZeroAddress, ZeroHash],
    [1, STOCK_TOKEN, TOKEN, POOL_C, 2_500, 50, ZeroAddress, "0xabcdef", ZeroAddress, ZeroHash],
  ], ZeroAddress, amountIn, minReturn, 0]) as HexString;
}

function encodedNativeDirectSwap(amountIn: bigint, minReturn: bigint): HexString {
  return SWAP_INTERFACE.encodeFunctionData("swap", [[
    [6, ZeroAddress, TOKEN, TOKEN, 0, 0, ZeroAddress, "0x", ZeroAddress, ZeroHash],
  ], ZeroAddress, amountIn, minReturn, 0]) as HexString;
}

function replaceHeadWordForAssertion(input: HexString, index: number, value: bigint): HexString {
  const start = 10 + (index * 64);
  return `${input.slice(0, start)}${value.toString(16).padStart(64, "0")}${input.slice(start + 64)}` as HexString;
}

test("Ed private clone changes only amountIn and explicitly zeros minReturn", () => {
  const targetAmount = 200_000_000_000_000_000n;
  const followAmount = 300_000_000_000_000_000n;
  const targetMinReturn = 2_000_000n;
  const rewritten = rewriteGmgnSwapCalldata({
    executionMode: "shadow",
    strategy: "ed",
    targetSender: ED_TARGET_ADDRESS,
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput: encodedSwap(targetAmount, targetMinReturn),
    targetValueWei: targetAmount,
    followAmountInWei: followAmount,
    edMinReturnRetentionBps: 9_000,
  });

  assert.equal(rewritten.amountIn, followAmount);
  assert.equal(rewritten.minReturn, 0n);
  assert.deepEqual(rewritten.differingWordIndexes, [2, 3]);
  assert.equal(rewritten.targetTokenAddress, TOKEN.toLowerCase());
  const decoded = SWAP_INTERFACE.decodeFunctionData("swap", rewritten.calldata);
  assert.equal(decoded.amountIn, followAmount);
  assert.equal(decoded.minReturn, 0n);
});

test("枯坐 clone changes only amountIn and supports audited zero minReturn behind a live gate", () => {
  const targetAmount = 190_000_000_000_000_000n;
  const followAmount = 500_000_000_000_000_000n;
  const targetMinReturn = 0n;
  const rewritten = rewriteGmgnSwapCalldata({
    executionMode: "shadow",
    strategy: "kuzuo",
    targetSender: "0x2cE9D43d1CBA6ae31D7f07BfE0098DFa2D833373",
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput: encodedSwap(targetAmount, targetMinReturn),
    targetValueWei: targetAmount,
    followAmountInWei: followAmount,
  });

  assert.equal(rewritten.minReturn, targetMinReturn);
  assert.deepEqual(rewritten.differingWordIndexes, [2]);
  const liveRequest = {
    executionMode: "live" as const,
    strategy: "kuzuo" as const,
    targetSender: "0x2cE9D43d1CBA6ae31D7f07BfE0098DFa2D833373",
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput: encodedSwap(targetAmount, targetMinReturn),
    targetValueWei: targetAmount,
    followAmountInWei: followAmount,
  };
  assert.throws(() => rewriteGmgnSwapCalldata(liveRequest), /ALLOW_ZERO_MIN_RETURN/);
  assert.equal(rewriteGmgnSwapCalldata({ ...liveRequest, allowZeroMinReturnInLive: true }).minReturn, 0n);
});

test("private parser accepts GMGN one-hop native BNB encoded as the zero address", () => {
  const targetAmount = 100_000_000_000_000_000n;
  const followAmount = 120_000_000_000_000_000n;
  const rewritten = rewriteGmgnSwapCalldata({
    executionMode: "shadow",
    strategy: "ed",
    targetSender: ED_TARGET_ADDRESS,
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput: encodedNativeDirectSwap(targetAmount, 123n),
    targetValueWei: targetAmount,
    followAmountInWei: followAmount,
  });
  assert.equal(rewritten.tokenIn, ZeroAddress.toLowerCase());
  assert.equal(rewritten.tokenOut, TOKEN.toLowerCase());
  assert.equal(rewritten.minReturn, 0n);
  assert.deepEqual(rewritten.differingWordIndexes, [2, 3]);
});

test("clone policy rejects calldata tied to the original sender", () => {
  const amount = 100_000_000_000_000_000n;
  assert.throws(() => rewriteGmgnSwapCalldata({
    executionMode: "shadow",
    strategy: "ed",
    targetSender: ED_TARGET_ADDRESS,
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput: encodedSwap(amount, 1_000n, ED_TARGET_ADDRESS),
    targetValueWei: amount,
    followAmountInWei: amount,
  }), /embeds the original sender/);
});

test("clone policy rejects a non-native amount and invalid minReturn scaling", () => {
  const amount = 100_000_000_000_000_000n;
  assert.throws(() => rewriteGmgnSwapCalldata({
    executionMode: "shadow",
    strategy: "ed",
    targetSender: ED_TARGET_ADDRESS,
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput: encodedSwap(amount, 1_000n),
    targetValueWei: amount - 1n,
    followAmountInWei: amount,
  }), /msg.value equals amountIn/);
  assert.throws(() => deriveEdMinReturn(amount, 1_000n, amount, 10_001), /between 1 and 10000/);
});

test("clone policy rejects a non-canonical dynamic ABI offset", () => {
  const amount = 100_000_000_000_000_000n;
  const original = encodedSwap(amount, 1_000n);
  const malformed = `${original.slice(0, 10)}${(192n).toString(16).padStart(64, "0")}${original.slice(74)}` as HexString;
  assert.throws(() => rewriteGmgnSwapCalldata({
    executionMode: "shadow",
    strategy: "ed",
    targetSender: ED_TARGET_ADDRESS,
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput: malformed,
    targetValueWei: amount,
    followAmountInWei: amount,
  }), /canonical ABI offset/);
});

test("fast public template keeps a stock-token three-hop route opaque and zeros minReturn", () => {
  const targetAmount = 190_000_000_000_000_000n;
  const followAmount = 420_000_000_000_000_000n;
  const targetMinReturn = 8_765_432_100n;
  const targetInput = encodedStockBaseSwap(targetAmount, targetMinReturn);
  const rewritten = fastGmgnBuyTemplate({
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput,
    targetValueWei: targetAmount,
    followAmountInWei: followAmount,
  });

  assert.equal(rewritten.valueWei, followAmount);
  assert.equal(rewritten.originalAmountIn, targetAmount);
  assert.equal(rewritten.originalMinReturn, targetMinReturn);
  assert.equal(rewritten.amountIn, followAmount);
  assert.equal(rewritten.minReturn, 0n);
  assert.deepEqual(rewritten.differingWordIndexes, [2, 3]);

  // Restoring only head words 2/3 must reproduce every byte of the target's
  // dynamic WBNB -> USDT -> stock token -> meme route.
  const restored = replaceHeadWordForAssertion(
    replaceHeadWordForAssertion(rewritten.calldata, 2, targetAmount),
    3,
    targetMinReturn,
  );
  assert.equal(restored.toLowerCase(), targetInput.toLowerCase());

  const decoded = SWAP_INTERFACE.decodeFunctionData("swap", rewritten.calldata);
  assert.equal(decoded.amountIn, followAmount);
  assert.equal(decoded.minReturn, 0n);
  assert.equal(decoded.descs.length, 3);
  assert.equal(decoded.descs[0].tokenIn.toLowerCase(), BSC_WBNB_ADDRESS);
  assert.equal(decoded.descs[0].tokenOut.toLowerCase(), USDT.toLowerCase());
  assert.equal(decoded.descs[1].tokenOut.toLowerCase(), STOCK_TOKEN);
  assert.equal(decoded.descs[2].tokenIn.toLowerCase(), STOCK_TOKEN);
  assert.equal(decoded.descs[2].tokenOut.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(decoded.descs[1].hookData, "0x123456");
  assert.equal(decoded.descs[2].hookData, "0xabcdef");
});

test("public and private clones zero a non-zero target deadline without touching dynamic route bytes", () => {
  const targetAmount = 190_000_000_000_000_000n;
  const followAmount = 420_000_000_000_000_000n;
  const targetInput = encodedSwap(targetAmount, 9_999n, "0x1234", 1_786_205_540n);
  const publicClone = fastGmgnBuyTemplate({
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput,
    targetValueWei: targetAmount,
    followAmountInWei: followAmount,
  });
  const privateClone = rewriteGmgnSwapCalldata({
    executionMode: "shadow",
    strategy: "ed",
    targetSender: ED_TARGET_ADDRESS,
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput,
    targetValueWei: targetAmount,
    followAmountInWei: followAmount,
  });

  for (const clone of [publicClone, privateClone]) {
    assert.deepEqual(clone.differingWordIndexes, [2, 3, 4]);
    const decoded = SWAP_INTERFACE.decodeFunctionData("swap", clone.calldata);
    assert.equal(decoded.userFeeRate, 0n);
    assert.equal(decoded.descs[1].hookData, "0x1234");
  }
});

test("an already-zero deadline is not reported as a changed word", () => {
  const amount = 10n;
  const clone = fastGmgnBuyTemplate({
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput: encodedSwap(amount, 0n, "0x", 0n),
    targetValueWei: amount,
    followAmountInWei: amount,
  });
  assert.deepEqual(clone.differingWordIndexes, []);
});

test("fast public template accepts uint256-max follow amount and rejects protocol overflow", () => {
  const targetAmount = 1n;
  const uint256Max = (1n << 256n) - 1n;
  const request = {
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput: encodedStockBaseSwap(targetAmount, 1n),
    targetValueWei: targetAmount,
    followAmountInWei: uint256Max,
  };
  const rewritten = fastGmgnBuyTemplate(request);
  assert.equal(rewritten.amountIn, uint256Max);
  assert.equal(rewritten.valueWei, uint256Max);
  assert.throws(
    () => fastGmgnBuyTemplate({ ...request, followAmountInWei: uint256Max + 1n }),
    /positive uint256/,
  );
});

test("target signal validation keeps object-only orderflow explicitly unverified", () => {
  const signal: TargetSignal = {
    version: EXECUTION_SIGNAL_VERSION,
    source: "club48_auction",
    sourceSequence: "auction-42",
    firstSeenUnixNs: "1786179919000000000",
    firstSeenMonoNs: "991900000000",
    strategy: "ed",
    transaction: {
      hash: `0x${"ab".repeat(32)}`,
      chainId: BSC_CHAIN_ID,
      type: 0,
      from: ED_TARGET_ADDRESS,
      to: GMGN_ROUTER_ADDRESS,
      nonce: 29_558,
      gasPriceWei: "10000000000",
      gasLimit: "700000",
      valueWei: "100000000000000000",
      input: encodedSwap(100_000_000_000_000_000n, 1_000n),
    },
  };
  assert.equal(validateTargetSignal(signal).rawTransactionVerified, false);
  assert.throws(() => validateTargetSignal({
    ...signal,
    transaction: { ...signal.transaction, from: "0x0000000000000000000000000000000000000001" },
  }), /does not match target sender/);
});

test("nonce lane shares one lease across builders and advances only after inclusion", () => {
  const target = `0x${"12".repeat(32)}`;
  const lane = new NonceLane("lane-ed-1");
  lane.synchronize(88);
  const first = lane.reserve(target, 114_700_001, "123456789");
  const duplicate = lane.reserve(target, 114_700_001, "123456790");
  assert.equal(first.startNonce, 88);
  assert.equal(first.span, 1);
  assert.deepEqual(duplicate, first);
  lane.markSubmitted(target, "club48");
  lane.markSubmitted(target, "blockrazor");
  assert.deepEqual(lane.snapshot().lease?.submittedBuilders, ["club48", "blockrazor"]);
  assert.throws(() => lane.reserve(`0x${"34".repeat(32)}`, 114_700_001, "123456791"), /another target/);
  assert.equal(lane.markIncluded(target).nextNonce, 89);
  assert.equal(lane.snapshot().state, "ready");
});

test("expired private candidates require a pending nonce resync", () => {
  const target = `0x${"56".repeat(32)}`;
  const lane = new NonceLane("lane-kuzuo-1");
  lane.synchronize(10);
  lane.reserve(target, 114_700_001, "555");
  lane.markSubmitted(target, "jet");
  assert.equal(lane.markExpired(target).state, "needs_sync");
  assert.throws(() => lane.reserve(target, 114_700_002, "556"), /not synchronized and ready/);
  lane.synchronize(10);
  assert.equal(lane.reserve(target, 114_700_002, "557").startNonce, 10);
});
