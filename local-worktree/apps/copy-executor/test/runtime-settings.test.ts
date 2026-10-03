import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { StrategyLaneConfig } from "../src/config.js";
import { RuntimeSettingsError, RuntimeSettingsStore } from "../src/runtime-settings.js";

function lane(strategy: "ed" | "kuzuo"): StrategyLaneConfig {
  return {
    strategy,
    label: strategy,
    enabled: true,
    signer: null,
    executorAddress: null,
    followAmountWei: 10_000_000_000_000_000n,
    builderTipWei: 1_000_000_000_000_000n,
    gasPriceWei: 1_000_000_000n,
    gasLimit: 1_000_000n,
    edMinReturnRetentionBps: 10_000,
    allowZeroMinReturnInLive: true,
  };
}

const lanes = { ed: lane("ed"), kuzuo: lane("kuzuo") };

test("runtime lane tuple persists atomically and survives restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-settings-"));
  const path = join(directory, "settings.json");
  try {
    const first = new RuntimeSettingsStore(path, lanes);
    await first.load();
    await first.update({
      strategy: "ed",
      followAmountBnb: "0.0125",
      gasPriceGwei: "2.25",
      builderTipBnb: "0.0015",
    });
    const restarted = new RuntimeSettingsStore(path, lanes);
    await restarted.load();
    assert.deepEqual(restarted.lane("ed"), {
      followAmountWei: 12_500_000_000_000_000n,
      gasPriceWei: 2_250_000_000n,
      builderTipWei: 1_500_000_000_000_000n,
    });
    assert.equal((restarted.snapshot().lanes as Array<Record<string, unknown>>)[0]?.followAmountBnb, "0.0125");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime values reject exponent notation, signs, leading zeros, excess precision and uint256 overflow", async () => {
  const store = new RuntimeSettingsStore("memory", lanes, { writeDocument: async () => undefined });
  await store.load();
  for (const invalid of ["1e-3", "+1", "01", "0.0000000000000000001", " 1"] ) {
    await assert.rejects(store.update({
      strategy: "ed",
      followAmountBnb: invalid,
      gasPriceGwei: "1",
      builderTipBnb: "0.001",
    }), (error: unknown) => error instanceof RuntimeSettingsError && error.code === "invalid_value");
  }
  const uint256PlusOneBnb = "115792089237316195423570985008687907853269984665640564039457.584007913129639936";
  const uint256PlusOneGwei = "115792089237316195423570985008687907853269984665640564039457584007913.129639936";
  for (const request of [
    { followAmountBnb: uint256PlusOneBnb, gasPriceGwei: "1", builderTipBnb: "0.001" },
    { followAmountBnb: "0.01", gasPriceGwei: uint256PlusOneGwei, builderTipBnb: "0.001" },
    { followAmountBnb: "0.01", gasPriceGwei: "1", builderTipBnb: uint256PlusOneBnb },
  ]) {
    await assert.rejects(store.update({ strategy: "ed", ...request }), (error: unknown) => (
      error instanceof RuntimeSettingsError && error.code === "invalid_value"
    ));
  }
  await assert.rejects(store.update({
    strategy: "ed",
    followAmountBnb: "1",
    gasPriceGwei: "1",
    builderTipBnb: "0",
  }), (error: unknown) => error instanceof RuntimeSettingsError && error.code === "invalid_value");
});

test("runtime settings persist protocol-maximum values without product caps", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-settings-uint256-"));
  const path = join(directory, "settings.json");
  const maxBnb = "115792089237316195423570985008687907853269984665640564039457.584007913129639935";
  const maxGwei = "115792089237316195423570985008687907853269984665640564039457584007913.129639935";
  try {
    const store = new RuntimeSettingsStore(path, lanes);
    await store.load();
    await store.update({
      strategy: "ed",
      followAmountBnb: maxBnb,
      gasPriceGwei: maxGwei,
      builderTipBnb: maxBnb,
    });
    await store.update({
      strategy: "kuzuo",
      followAmountBnb: "1",
      gasPriceGwei: "1",
      builderTipBnb: "0.000000000000000001",
    });
    const restarted = new RuntimeSettingsStore(path, lanes);
    await restarted.load();
    const uint256Max = (1n << 256n) - 1n;
    assert.deepEqual(restarted.lane("ed"), {
      followAmountWei: uint256Max,
      gasPriceWei: uint256Max,
      builderTipWei: uint256Max,
    });
    assert.equal(restarted.lane("kuzuo").builderTipWei, 1n);
    const edControl = (restarted.snapshot().lanes as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(Object.keys(edControl).sort(), ["builderTipBnb", "followAmountBnb", "gasPriceGwei", "strategy"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed persistence never publishes a partial lane tuple", async () => {
  let writes = 0;
  const store = new RuntimeSettingsStore("memory", lanes, {
    writeDocument: async () => {
      writes += 1;
      if (writes > 1) throw new Error("disk full");
    },
  });
  await store.load();
  const before = store.lane("kuzuo");
  await assert.rejects(store.update({
    strategy: "kuzuo",
    followAmountBnb: "0.015",
    gasPriceGwei: "2",
    builderTipBnb: "0.0015",
  }), /disk full/);
  assert.deepEqual(store.lane("kuzuo"), before);
});

test("concurrent runtime writes serialize complete tuples", async () => {
  const persisted: string[] = [];
  const store = new RuntimeSettingsStore("memory", lanes, {
    writeDocument: async (_path, contents) => { persisted.push(contents); },
  });
  await store.load();
  await Promise.all([
    store.update({ strategy: "ed", followAmountBnb: "0.011", gasPriceGwei: "2", builderTipBnb: "0.0011" }),
    store.update({ strategy: "kuzuo", followAmountBnb: "0.012", gasPriceGwei: "3", builderTipBnb: "0.0012" }),
  ]);
  assert.equal(persisted.length, 3);
  assert.equal(store.lane("ed").followAmountWei, 11_000_000_000_000_000n);
  assert.equal(store.lane("kuzuo").followAmountWei, 12_000_000_000_000_000n);
});
