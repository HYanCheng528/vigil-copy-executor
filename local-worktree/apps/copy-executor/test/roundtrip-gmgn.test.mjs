import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Interface, Wallet, ZeroAddress, id, zeroPadValue } from "ethers";
import {
  GMGN_ROUTER,
  TEST_BUY_WEI,
  TEST_TOKEN,
  assertPinnedContracts,
  assertRoundtripTemplates,
  acquiredFromBuyReceipt,
  bufferedGas,
  inspectRoute,
  patchHistoricalSwap,
  persistTransactionIntent,
  readHeadWord,
  sanitizeError,
  simulateAndEstimateGas,
  settlePersistedIntent,
  validateRoundtripState,
  writeState,
} from "../scripts/roundtrip-gmgn.mjs";

const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const STOCK = "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436";
const SWAP = new Interface([
  "function swap((uint8 swapType,address tokenIn,address tokenOut,address poolAddress,uint24 fee,int24 tickSpacing,address hooks,bytes hookData,address poolManager,bytes32 parameters)[] descs,address feeToken,uint256 amountIn,uint256 minReturn,uint256 userFeeRate) payable",
]);
const poolA = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE";
const poolB = "0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C";
const poolC = "0xEcd7B2983ABC7615aB6aAe2BE3D9Cab2F9d59331";
const desc = (tokenIn, tokenOut, pool) => [0, tokenIn, tokenOut, pool, 2500, 50, ZeroAddress, "0x", ZeroAddress, `0x${"00".repeat(32)}`];

function swap(route, amount, min, deadline) {
  return SWAP.encodeFunctionData("swap", [route, ZeroAddress, amount, min, deadline]);
}

test("historical clone changes only amount, minReturn and expired deadline", () => {
  const original = swap([
    desc(WBNB, USDT, poolA),
    desc(USDT, STOCK, poolB),
    desc(STOCK, TEST_TOKEN, poolC),
  ], 250n, 999n, 1_786_205_540n);
  const patched = patchHistoricalSwap(original, 1n);
  assert.equal(readHeadWord(patched, 2), 1n);
  assert.equal(readHeadWord(patched, 3), 0n);
  assert.equal(readHeadWord(patched, 4), 0n);
  assert.equal(inspectRoute(patched).descriptors.length, 3);
  const restored = patchHistoricalSwap(patched, 250n)
    .replace("0".repeat(64), "0".repeat(64));
  assert.equal(restored.length, original.length);
  for (let index = 0; index < original.length; index += 1) {
    const inMutableHead = index >= 10 + (2 * 64) && index < 10 + (5 * 64);
    if (!inMutableHead) assert.equal(patched[index], original[index]);
  }
});

test("contract pin gate rejects any audited bytecode change", async () => {
  const implementation = "9d82e6fe9ad22b1e793ae557bb55e3ea08482fcb";
  await assert.rejects(() => assertPinnedContracts({
    getStorage: async () => `0x${"0".repeat(24)}${implementation}`,
    getCode: async () => "0x00",
  }), /audited contract code changed/);
});

test("roundtrip template gate accepts stock-base buy and reverse sell only", () => {
  const buyData = swap([
    desc(WBNB, USDT, poolA),
    desc(USDT, STOCK, poolB),
    desc(STOCK, TEST_TOKEN, poolC),
  ], 250n, 10n, 100n);
  const sellData = swap([
    desc(TEST_TOKEN, STOCK, poolC),
    desc(STOCK, USDT, poolB),
    desc(USDT, WBNB, poolA),
  ], 1_000n, 1n, 0n);
  const result = assertRoundtripTemplates(
    { to: GMGN_ROUTER, data: buyData, value: 250n },
    { to: GMGN_ROUTER, data: sellData, value: 0n },
    "0x1111111111111111111111111111111111111111",
  );
  assert.equal(result.buy.descriptors.at(-1).tokenOut.toLowerCase(), TEST_TOKEN);
  assert.equal(result.sell.descriptors[0].tokenIn.toLowerCase(), TEST_TOKEN);
  assert.throws(() => assertRoundtripTemplates(
    { to: GMGN_ROUTER, data: sellData, value: 0n },
    { to: GMGN_ROUTER, data: buyData, value: 250n },
    "0x1111111111111111111111111111111111111111",
  ), /buy template is not native BNB input|does not end/);
});

function baseState(wallet) {
  return {
    version: 2,
    wallet,
    token: TEST_TOKEN,
    buyWei: TEST_BUY_WEI.toString(),
    startingTokenBalance: "0",
    stage: "buy_intent",
    transactions: {},
  };
}

test("broadcast intent is durably recorded by nonce/hash without raw, calldata, key or RPC URL", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundtrip-intent-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "state.json");
  const privateKey = `0x${"11".repeat(32)}`;
  const wallet = new Wallet(privateKey);
  const request = {
    to: GMGN_ROUTER,
    value: TEST_BUY_WEI,
    data: "0x12345678",
    gasPrice: 100_000_000n,
    gasLimit: 500_000n,
  };
  const result = await persistTransactionIntent({
    wallet,
    stateFile,
    state: baseState(wallet.address),
    kind: "buy",
    request,
    nonce: 7,
  });
  const persistedText = fs.readFileSync(stateFile, "utf8");
  const persisted = JSON.parse(persistedText);
  validateRoundtripState(persisted, wallet.address);
  assert.equal(persisted.transactions.buy.nonce, "7");
  assert.equal(persisted.transactions.buy.hash, result.hash);
  assert.equal(persisted.transactions.buy.status, "intent");
  assert.equal(persistedText.includes(result.signedTransaction), false);
  assert.equal(persistedText.includes(request.data), false);
  assert.equal(persistedText.includes(privateKey), false);
  assert.equal(persistedText.includes("https://"), false);
});

test("intent gate enforces an exact 0.0001 BNB buy hard cap before state creation", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundtrip-cap-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "state.json");
  const wallet = new Wallet(`0x${"22".repeat(32)}`);
  await assert.rejects(() => persistTransactionIntent({
    wallet,
    stateFile,
    state: baseState(wallet.address),
    kind: "buy",
    request: {
      to: GMGN_ROUTER,
      value: TEST_BUY_WEI + 1n,
      data: "0x12345678",
      gasPrice: 100_000_000n,
      gasLimit: 500_000n,
    },
    nonce: 0,
  }), /exact 0\.0001 BNB hard cap/);
  assert.equal(fs.existsSync(stateFile), false);
});

test("SELL_ONLY dry recovery signs locally but never broadcasts without the exact confirmation gate", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundtrip-dry-recovery-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "state.json");
  const wallet = new Wallet(`0x${"33".repeat(32)}`);
  const request = {
    to: GMGN_ROUTER,
    value: TEST_BUY_WEI,
    data: "0x12345678",
    gasPrice: 100_000_000n,
    gasLimit: 500_000n,
  };
  const prepared = await persistTransactionIntent({
    wallet,
    stateFile,
    state: baseState(wallet.address),
    kind: "buy",
    request,
    nonce: 0,
  });
  let broadcasts = 0;
  const settled = await settlePersistedIntent({
    provider: {
      getTransactionReceipt: async () => null,
      broadcastTransaction: async () => { broadcasts += 1; throw new Error("must not run"); },
    },
    wallet,
    stateFile,
    state: prepared.state,
    kind: "buy",
    request,
    broadcast: false,
  });
  assert.equal(settled.receipt, null);
  assert.equal(broadcasts, 0);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).transactions.buy.status, "intent");
});

test("state validation prevents selling a pre-existing or inflated token balance", async () => {
  const wallet = new Wallet(`0x${"44".repeat(32)}`);
  const state = baseState(wallet.address);
  state.startingTokenBalance = "1";
  assert.throws(() => validateRoundtripState(state, wallet.address), /isolated-wallet hard cap/);
  state.startingTokenBalance = "0";
  state.buyWei = (TEST_BUY_WEI + 1n).toString();
  assert.throws(() => validateRoundtripState(state, wallet.address), /isolated-wallet hard cap/);
});

test("entrypoint error sanitizer removes RPC URLs, keys and signed payloads", () => {
  const key = `0x${"55".repeat(32)}`;
  const raw = `0x${"aa".repeat(256)}`;
  const sanitized = sanitizeError(new Error(`https://secret.rpc.invalid/token/${key} ${raw}`));
  assert.equal(sanitized.includes("secret.rpc.invalid"), false);
  assert.equal(sanitized.includes(key), false);
  assert.equal(sanitized.includes(raw), false);
});

test("QuickNode simulation carries a strict gas ceiling while the signed request uses buffered actual gas", async () => {
  const original = {
    from: "0x1111111111111111111111111111111111111111",
    to: GMGN_ROUTER,
    value: TEST_BUY_WEI,
    data: "0x12345678",
    gasPrice: 100_000_000n,
  };
  const actualEstimate = 486_594n;
  let callRequest;
  let estimateRequest;
  const finalGasLimit = await simulateAndEstimateGas({
    call: async (request) => { callRequest = request; },
    estimateGas: async (request) => { estimateRequest = request; return actualEstimate; },
  }, original, 2_000_000n);

  assert.equal(callRequest.gasLimit, 2_000_000n);
  assert.equal(estimateRequest, original);
  assert.equal("gasLimit" in estimateRequest, false);
  assert.equal(finalGasLimit, bufferedGas(actualEstimate, 2_000_000n));
  assert.equal(finalGasLimit, 642_572n);
  assert.notEqual(finalGasLimit, 2_000_000n);

  const finalSignedRequest = { ...original, gasLimit: finalGasLimit };
  assert.equal(finalSignedRequest.gasLimit, 642_572n);
  assert.equal(original.gasLimit, undefined);
});

test("buy_broadcast recovery skips same-token non-Transfer logs and proves the exact acquired amount", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundtrip-buy-recovery-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "state.json");
  const wallet = new Wallet(`0x${"66".repeat(32)}`);
  const request = {
    to: GMGN_ROUTER,
    value: TEST_BUY_WEI,
    data: "0x12345678",
    gasPrice: 100_000_000n,
    gasLimit: 500_000n,
  };
  const prepared = await persistTransactionIntent({
    wallet,
    stateFile,
    state: baseState(wallet.address),
    kind: "buy",
    request,
    nonce: 0,
  });
  const broadcastState = {
    ...prepared.state,
    stage: "buy_broadcast",
    transactions: {
      ...prepared.state.transactions,
      buy: { ...prepared.state.transactions.buy, status: "broadcast" },
    },
  };
  writeState(stateFile, broadcastState);

  const acquired = 4_031_430_111_902_822_871_597n;
  const transfer = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
  const encodedTransfer = transfer.encodeEventLog(transfer.getEvent("Transfer"), [
    "0x7777777777777777777777777777777777777777",
    wallet.address,
    acquired,
  ]);
  const receipt = {
    status: 1,
    blockNumber: 114_794_577,
    logs: [
      {
        address: TEST_TOKEN,
        topics: [id("TaxCollected(address,uint256)"), zeroPadValue(wallet.address, 32)],
        data: `0x${acquired.toString(16).padStart(64, "0")}`,
      },
      { address: TEST_TOKEN, topics: encodedTransfer.topics, data: encodedTransfer.data },
    ],
  };
  let broadcasts = 0;
  const settled = await settlePersistedIntent({
    provider: {
      getTransactionReceipt: async () => receipt,
      getTransaction: async () => ({
        from: wallet.address,
        nonce: 0,
        to: GMGN_ROUTER,
        value: TEST_BUY_WEI,
        data: request.data,
      }),
      broadcastTransaction: async () => { broadcasts += 1; throw new Error("must not rebroadcast confirmed buy"); },
    },
    wallet,
    stateFile,
    state: broadcastState,
    kind: "buy",
    request,
    broadcast: true,
  });
  assert.equal(settled.receipt, receipt);
  assert.equal(broadcasts, 0);
  assert.equal(acquiredFromBuyReceipt(settled.receipt, wallet.address), acquired);
});
