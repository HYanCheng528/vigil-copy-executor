import assert from "node:assert/strict";
import test from "node:test";
import { Interface, Transaction, getAddress, keccak256 } from "ethers";
import {
  HotSigner,
  atomicExecutorSelector,
  legacyAtomicExecutorSelector,
  privateAtomicExecutorSelector,
} from "../src/hot-signer.js";
import { GMGN_ROUTER_ADDRESS } from "../src/core/gmgn-calldata.js";
import type { HexString } from "../src/core/messages.js";

const EXECUTOR_INTERFACE = new Interface([
  "function executeCopyBuy(address tokenOut,uint256 swapValueWei,uint256 minimumTokenOut,address tipRecipient,uint256 builderTipWei,bytes routerCalldata) payable returns (uint256 tokenAmountOut)",
  "function executeCopyBuyV2(address tokenOut,uint256 swapValueWei,uint256 minimumTokenOut,address tipRecipient,uint256 builderTipWei,uint256 validUntilBlock,bytes routerCalldata) payable returns (uint256 tokenAmountOut)",
  "function executePrivateCopyBuy(address tokenOut,uint256 swapValueWei,uint256 minimumOwnerTokenOut,address proxyBidContract,address refundAddress,uint256 refundCfg,uint256 proxyBidWei,uint256 validUntilBlock,bytes routerCalldata) payable returns (uint256 ownerTokenAmountOut)",
]);

test("single atomic copy transaction binds selector, msg.value, copy-wallet nonce, and Builder tip", () => {
  const signer = new HotSigner(`0x${"35".repeat(32)}`);
  const executor = "0x0000000000000000000000000000000000001000";
  const token = "0x0000000000000000000000000000000000002000";
  const tipRecipient = "0x4848489f0b2BEdd788c696e2D79b6b69D7484848";
  const routerCalldata = "0x4d819a2a1234" as HexString;
  const swapValueWei = 10_000_000_000_000_000n;
  const builderTipWei = 1_000_000_000_000_000n;
  const signed = signer.signAtomicCopy({
    executorAddress: executor,
    tokenOut: token,
    routerCalldata,
    swapValueWei,
    minimumTokenOut: 123_456n,
    tipRecipient,
    builderTipWei,
    validUntilBlock: 114_700_001,
    nonce: 42,
    gasPriceWei: 1_000_000_000n,
    gasLimit: 1_750_000n,
  });
  const transaction = Transaction.from(signed.rawTransaction);

  assert.equal(transaction.chainId, 56n);
  assert.equal(transaction.type, 0);
  assert.equal(transaction.from, signer.address);
  assert.equal(transaction.to, getAddress(executor));
  assert.equal(transaction.nonce, 42);
  assert.equal(transaction.value, swapValueWei + builderTipWei);
  assert.equal(signed.valueWei, transaction.value);
  assert.equal(signed.hash, transaction.hash);
  assert.equal(signed.hash, keccak256(signed.rawTransaction));
  assert.equal(signed.data.slice(0, 10), atomicExecutorSelector());
  assert.notEqual(atomicExecutorSelector(), legacyAtomicExecutorSelector());

  const decoded = EXECUTOR_INTERFACE.decodeFunctionData("executeCopyBuyV2", signed.data);
  assert.equal(decoded.tokenOut, getAddress(token));
  assert.equal(decoded.swapValueWei, swapValueWei);
  assert.equal(decoded.minimumTokenOut, 123_456n);
  assert.equal(decoded.tipRecipient, getAddress(tipRecipient));
  assert.equal(decoded.builderTipWei, builderTipWei);
  assert.equal(decoded.validUntilBlock, 114_700_001n);
  assert.equal(decoded.routerCalldata, routerCalldata);
});

test("atomic signer rejects values that could break nonce or funding invariants", () => {
  const signer = new HotSigner(`0x${"36".repeat(32)}`);
  const base = {
    executorAddress: "0x0000000000000000000000000000000000001000",
    tokenOut: "0x0000000000000000000000000000000000002000",
    routerCalldata: "0x4d819a2a" as HexString,
    swapValueWei: 1n,
    minimumTokenOut: 0n,
    tipRecipient: "0x0000000000000000000000000000000000003000",
    builderTipWei: 0n,
    validUntilBlock: 114_700_001,
    nonce: 0,
    gasPriceWei: 1n,
    gasLimit: 21_000n,
  };

  assert.throws(() => signer.signAtomicCopy({ ...base, nonce: -1 }), /nonce is invalid/);
  assert.throws(() => signer.signAtomicCopy({ ...base, swapValueWei: 0n }), /value\/tip is invalid/);
  assert.throws(() => signer.signAtomicCopy({ ...base, builderTipWei: -1n }), /value\/tip is invalid/);
  assert.throws(() => signer.signAtomicCopy({ ...base, minimumTokenOut: -1n }), /minimumTokenOut/);
  assert.throws(() => signer.signAtomicCopy({ ...base, validUntilBlock: 0 }), /validUntilBlock/);
  assert.throws(() => signer.signAtomicCopy({ ...base, gasLimit: 20_999n }), /gas settings/);
});

test("private signer binds the fixed proxyBid path and never double-pays the ordinary Builder tip", () => {
  const signer = new HotSigner(`0x${"38".repeat(32)}`);
  const swapValueWei = 10_000_000_000_000_000n;
  const proxyBidWei = 1_000_000_000_000_000n;
  const signed = signer.signPrivateAtomicCopy({
    executorAddress: "0x0000000000000000000000000000000000001000",
    tokenOut: "0x0000000000000000000000000000000000002000",
    routerCalldata: "0x4d819a2a1234",
    swapValueWei,
    minimumOwnerTokenOut: 456n,
    proxyBidContract: "0x0000000000000000000000000000000000003000",
    refundAddress: "0x0000000000000000000000000000000000004000",
    refundCfg: 10_380_050n,
    proxyBidWei,
    validUntilBlock: 114_700_001,
    nonce: 43,
    gasPriceWei: 1_000_000_000n,
    gasLimit: 1_750_000n,
  });
  const transaction = Transaction.from(signed.rawTransaction);
  assert.equal(transaction.value, swapValueWei + proxyBidWei);
  assert.equal(signed.data.slice(0, 10), privateAtomicExecutorSelector());
  const decoded = EXECUTOR_INTERFACE.decodeFunctionData("executePrivateCopyBuy", signed.data);
  assert.equal(decoded.minimumOwnerTokenOut, 456n);
  assert.equal(decoded.proxyBidWei, proxyBidWei);
  assert.equal(decoded.refundCfg, 10_380_050n);
  assert.equal(decoded.validUntilBlock, 114_700_001n);
  assert.equal(decoded.routerCalldata, "0x4d819a2a1234");

  const base = {
    executorAddress: "0x0000000000000000000000000000000000001000",
    tokenOut: "0x0000000000000000000000000000000000002000",
    routerCalldata: "0x4d819a2a" as HexString,
    swapValueWei: 1n,
    minimumOwnerTokenOut: 0n,
    proxyBidContract: "0x0000000000000000000000000000000000003000",
    refundAddress: "0x0000000000000000000000000000000000004000",
    refundCfg: 0n,
    proxyBidWei: 1n,
    validUntilBlock: 1,
    nonce: 0,
    gasPriceWei: 1n,
    gasLimit: 21_000n,
  };
  assert.throws(() => signer.signPrivateAtomicCopy({ ...base, proxyBidWei: 0n }), /proxy bid/);
  assert.throws(() => signer.signPrivateAtomicCopy({ ...base, refundCfg: -1n }), /refundCfg/);
  assert.throws(() => signer.signPrivateAtomicCopy({ ...base, validUntilBlock: 0 }), /validUntilBlock/);
});

test("public Builder race reuses one direct GMGN buy and signs an independent N+1 tip per Builder", () => {
  const signer = new HotSigner(`0x${"39".repeat(32)}`);
  const routerCalldata = `0x4d819a2a${"12".repeat(160)}` as HexString;
  const swapValueWei = 250_000_000_000_000_000n;
  const buyRequest = {
    routerCalldata,
    swapValueWei,
    nonce: 73,
    gasPriceWei: 1_000_000_000n,
    gasLimit: 700_000n,
  };

  // Every public Builder receives the exact same copy transaction. Only the
  // following tip transaction is provider-specific.
  const club48Buy = signer.signDirectGmgnBuy(buyRequest);
  const blockRazorBuy = signer.signDirectGmgnBuy(buyRequest);
  assert.equal(club48Buy.rawTransaction, blockRazorBuy.rawTransaction);
  assert.equal(club48Buy.hash, blockRazorBuy.hash);
  assert.equal(new Set([club48Buy.hash, blockRazorBuy.hash]).size, 1);

  const buy = Transaction.from(club48Buy.rawTransaction);
  assert.equal(buy.chainId, 56n);
  assert.equal(buy.type, 0);
  assert.equal(buy.from, signer.address);
  assert.equal(buy.to, getAddress(GMGN_ROUTER_ADDRESS));
  assert.equal(buy.nonce, 73);
  assert.equal(buy.value, swapValueWei);
  assert.equal(buy.data, routerCalldata);
  assert.equal(club48Buy.data, routerCalldata);
  assert.equal(club48Buy.valueWei, swapValueWei);
  assert.equal(club48Buy.hash, keccak256(club48Buy.rawTransaction));

  const builderTipWei = 1_500_000_000_000_000n;
  const recipients = {
    club48: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
    blockrazor: "0x1266c6be60392a8ff346e8d5eccd3e69dd9c5f20",
  } as const;
  const tips = Object.entries(recipients).map(([builder, tipRecipient]) => ({
    builder,
    tipRecipient,
    signed: signer.signBuilderTip({
      tipRecipient,
      builderTipWei,
      nonce: buy.nonce + 1,
      gasPriceWei: 1_000_000_000n,
    }),
  }));

  for (const { tipRecipient, signed } of tips) {
    const tip = Transaction.from(signed.rawTransaction);
    assert.equal(tip.chainId, 56n);
    assert.equal(tip.type, 0);
    assert.equal(tip.from, signer.address);
    assert.equal(tip.to, getAddress(tipRecipient));
    assert.equal(tip.nonce, 74);
    assert.equal(tip.gasLimit, 21_000n);
    assert.equal(tip.value, builderTipWei);
    assert.equal(tip.data, "0x");
    assert.equal(signed.data, "0x");
    assert.equal(signed.hash, keccak256(signed.rawTransaction));
  }
  assert.equal(new Set(tips.map(({ signed }) => signed.hash)).size, tips.length);
  assert.notEqual(tips[0]!.signed.hash, club48Buy.hash);
});

test("signer cold path can be paid once before target feeds start", () => {
  const signer = new HotSigner(`0x${"37".repeat(32)}`);
  assert.doesNotThrow(() => signer.prewarm());
  assert.doesNotThrow(() => signer.prewarm());
});
