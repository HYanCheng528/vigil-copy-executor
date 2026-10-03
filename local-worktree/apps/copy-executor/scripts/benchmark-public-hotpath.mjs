import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BuilderClient } from "../dist/src/builders.js";
import { fastGmgnBuyTemplate, GMGN_ROUTER_ADDRESS } from "../dist/src/core/gmgn-calldata.js";
import { HotSigner } from "../dist/src/hot-signer.js";

const iterations = Number.parseInt(process.argv[2] ?? "2000", 10);
if (!Number.isSafeInteger(iterations) || iterations < 100 || iterations > 100_000) {
  throw new Error("iterations must be an integer between 100 and 100000");
}

const fixtureSource = readFileSync(
  fileURLToPath(new URL("../test/engine-hotpath.test.ts", import.meta.url)),
  "utf8",
);
const inputMatch = /const ED_INPUT = "(0x[0-9a-f]+)";/.exec(fixtureSource);
if (!inputMatch) throw new Error("historical three-hop GMGN fixture is missing");
const targetInput = inputMatch[1];
const amountWordStart = 10 + (2 * 64);
const targetAmountWei = BigInt(`0x${targetInput.slice(amountWordStart, amountWordStart + 64)}`);
const followAmountWei = 10_000_000_000_000_000n;
const gasPriceWei = 1_000_000_000n;
const gasLimit = 1_750_000n;
const builderTipWei = 100_000_000_000_000n;
const buyNonce = 42;
const targetHash = `0x${"ab".repeat(32)}`;
const targetRaw = `0x02${targetInput.slice(2)}`;

const signer = new HotSigner(`0x${"11".repeat(32)}`);
const builders = [
  ["club48", "https://puissant-builder.48.club/", "0x4848489f0b2BEdd788c696e2D79b6b69D7484848"],
  ["blockrazor", "https://rpc.blockrazor.builders/", "0x1266c6be60392a8ff346e8d5eccd3e69dd9c5f20"],
  ["jet", "https://rpc.bsc.jetbldr.xyz/", "0xe89c42bc188c993273ab34231e12ae60c73042e4"],
].map(([name, url, tipRecipient]) => new BuilderClient({
  name,
  url,
  tipRecipient,
  authorization: null,
  requestTimeoutMs: 250,
  prewarmIntervalMs: name === "club48" ? 30_000 : 15_000,
}));
const tips = builders.map((builder) => signer.signBuilderTip({
  tipRecipient: builder.config.tipRecipient,
  builderTipWei,
  nonce: buyNonce + 1,
  gasPriceWei,
}));

function quantile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50Ms: Number(quantile(sorted, 0.5).toFixed(4)),
    p95Ms: Number(quantile(sorted, 0.95).toFixed(4)),
    p99Ms: Number(quantile(sorted, 0.99).toFixed(4)),
    maxMs: Number(sorted.at(-1).toFixed(4)),
  };
}

function runOnce() {
  const patchedAt = process.hrtime.bigint();
  const template = fastGmgnBuyTemplate({
    targetTo: GMGN_ROUTER_ADDRESS,
    targetInput,
    targetValueWei: targetAmountWei,
    followAmountInWei: followAmountWei,
  });
  const signedAt = process.hrtime.bigint();
  const buy = signer.signDirectGmgnBuy({
    routerCalldata: template.calldata,
    swapValueWei: template.valueWei,
    nonce: buyNonce,
    gasPriceWei,
    gasLimit,
  });
  const preparedAt = process.hrtime.bigint();
  for (let index = 0; index < builders.length; index += 1) {
    builders[index].prepare({
      target: { kind: "rawTx", hash: targetHash, raw: targetRaw, requiredPredecessorRaws: [] },
      strategyTxs: [buy.rawTransaction, tips[index].rawTransaction],
      maxBlockNumber: 114_700_001,
      minTimestamp: 1_786_180_000,
      maxTimestamp: 1_786_180_003,
      noMerge: builders[index].config.name !== "jet",
      positionFirst: false,
    });
  }
  const finishedAt = process.hrtime.bigint();
  return {
    patchMs: Number(signedAt - patchedAt) / 1e6,
    signMs: Number(preparedAt - signedAt) / 1e6,
    prepareThreeMs: Number(finishedAt - preparedAt) / 1e6,
    totalMs: Number(finishedAt - patchedAt) / 1e6,
  };
}

for (let index = 0; index < 200; index += 1) runOnce();
const samples = Array.from({ length: iterations }, runOnce);
process.stdout.write(JSON.stringify({
  benchmark: "public_pending_to_three_builder_payloads_no_network",
  iterations,
  fixtureBytes: (targetInput.length - 2) / 2,
  tipMode: "pre_signed_independent_n_plus_1",
  patch: summarize(samples.map((sample) => sample.patchMs)),
  signBuy: summarize(samples.map((sample) => sample.signMs)),
  prepareThree: summarize(samples.map((sample) => sample.prepareThreeMs)),
  total: summarize(samples.map((sample) => sample.totalMs)),
}) + "\n");
