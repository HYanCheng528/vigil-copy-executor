import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PositionLedger } from "../src/position-ledger.js";

const TOKEN = "0x0000000000000000000000000000000000007777";
const ED = "0x0000000000000000000000000000000000001001";
const KUZUO = "0x0000000000000000000000000000000000001002";
const HASH1 = `0x${"11".repeat(32)}`;
const HASH2 = `0x${"22".repeat(32)}`;

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("positions survive restart, add-on updates one token, and identical tokens stay lane-isolated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "position-ledger-"));
  const path = join(directory, "positions.json");
  const balances = new Map<string, bigint>();
  const key = (token: string, owner: string) => `${token.toLowerCase()}:${owner.toLowerCase()}`;
  const reader = {
    tokenBalance: async (token: string, owner: string) => balances.get(key(token, owner)) ?? 0n,
    tokenMetadata: async () => ({ symbol: "AI", decimals: 18 }),
  };
  try {
    const ledger = new PositionLedger(path, reader, { ed: ED, kuzuo: KUZUO }, 100_000);
    await ledger.start();
    balances.set(key(TOKEN, ED), 100n);
    ledger.recordIncluded({ strategy: "ed", tokenAddress: TOKEN, sourceTxHash: HASH1 });
    await eventually(() => ledger.snapshot().positions[0]?.balanceRaw === "100");
    const acquiredAt = ledger.snapshot().positions[0]!.acquiredAt;

    balances.set(key(TOKEN, ED), 175n);
    ledger.recordIncluded({ strategy: "ed", tokenAddress: TOKEN, sourceTxHash: HASH2 });
    balances.set(key(TOKEN, KUZUO), 50n);
    ledger.recordIncluded({ strategy: "kuzuo", tokenAddress: TOKEN, sourceTxHash: HASH1 });
    await eventually(() => ledger.snapshot().positions.length === 2
      && ledger.snapshot().positions.some((position) => position.strategy === "ed" && position.balanceRaw === "175"));
    assert.equal(ledger.snapshot().positions.find((position) => position.strategy === "ed")?.acquiredAt, acquiredAt);
    assert.equal(ledger.snapshot().positions.find((position) => position.strategy === "ed")?.sourceTxHash, HASH2);
    await ledger.stop();

    const restarted = new PositionLedger(path, reader, { ed: ED, kuzuo: KUZUO }, 100_000);
    await restarted.start();
    assert.equal(restarted.snapshot().positions.length, 2);
    await restarted.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("background reconcile removes a manually sold zero balance from active positions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "position-reconcile-"));
  const path = join(directory, "positions.json");
  let balance = 100n;
  const reader = {
    tokenBalance: async () => balance,
    tokenMetadata: async () => ({ symbol: null, decimals: null }),
  };
  try {
    const ledger = new PositionLedger(path, reader, { ed: ED, kuzuo: KUZUO }, 10);
    await ledger.start();
    ledger.recordIncluded({ strategy: "ed", tokenAddress: TOKEN, sourceTxHash: HASH1 });
    await eventually(() => ledger.snapshot().positions.length === 1);
    balance = 0n;
    await eventually(() => ledger.snapshot().positions.length === 0);
    await ledger.stop();

    const restarted = new PositionLedger(path, reader, { ed: ED, kuzuo: KUZUO }, 100_000);
    await restarted.start();
    assert.equal(restarted.snapshot().positions.length, 0);
    await restarted.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("slow position RPC returns control immediately and cannot block dispatch callers", async () => {
  let release!: (value: bigint) => void;
  const balance = new Promise<bigint>((resolve) => { release = resolve; });
  const ledger = new PositionLedger("memory", {
    tokenBalance: async () => balance,
    tokenMetadata: async () => ({ symbol: "AI", decimals: 18 }),
  }, { ed: ED, kuzuo: KUZUO }, 100_000, { writeDocument: async () => undefined });
  await ledger.start();
  const started = process.hrtime.bigint();
  ledger.recordIncluded({ strategy: "ed", tokenAddress: TOKEN, sourceTxHash: HASH1 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 5, `recordIncluded blocked for ${String(elapsedMs)}ms`);
  assert.equal(ledger.snapshot().positions.length, 0);
  release(100n);
  await eventually(() => ledger.snapshot().positions.length === 1);
  await ledger.stop();
});

test("reconcile uses bounded all-settled batches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "position-cap-"));
  const path = join(directory, "positions.json");
  const tokens = Array.from({ length: 6 }, (_, index) => `0x${(0x7800 + index).toString(16).padStart(40, "0")}`);
  const seedReader = {
    tokenBalance: async () => 100n,
    tokenMetadata: async () => ({ symbol: null, decimals: null }),
  };
  try {
    const seed = new PositionLedger(path, seedReader, { ed: ED, kuzuo: KUZUO }, 100_000);
    await seed.start();
    tokens.forEach((token, index) => seed.recordIncluded({
      strategy: "ed",
      tokenAddress: token,
      sourceTxHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    }));
    await eventually(() => seed.snapshot().positions.length === tokens.length);
    await seed.stop();

    let active = 0;
    let maximum = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reader = {
      tokenBalance: async () => {
        calls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        await gate;
        active -= 1;
        return 100n;
      },
      tokenMetadata: async () => ({ symbol: null, decimals: null }),
    };
    const ledger = new PositionLedger(path, reader, { ed: ED, kuzuo: KUZUO }, 100_000, {
      reconcileConcurrency: 2,
    });
    await ledger.start();
    await eventually(() => calls === 2);
    assert.equal(active, 2);
    assert.equal(maximum, 2);
    release();
    await eventually(() => calls === tokens.length && active === 0);
    assert.equal(maximum, 2, "position calls must never exceed the configured cap");
    await ledger.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one broken token cannot prevent another manually sold position from closing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "position-all-settled-"));
  const path = join(directory, "positions.json");
  const brokenToken = "0x0000000000000000000000000000000000007901";
  const soldToken = "0x0000000000000000000000000000000000007902";
  const seedReader = {
    tokenBalance: async () => 100n,
    tokenMetadata: async () => ({ symbol: null, decimals: null }),
  };
  try {
    const seed = new PositionLedger(path, seedReader, { ed: ED, kuzuo: KUZUO }, 100_000);
    await seed.start();
    seed.recordIncluded({ strategy: "ed", tokenAddress: brokenToken, sourceTxHash: HASH1 });
    seed.recordIncluded({ strategy: "ed", tokenAddress: soldToken, sourceTxHash: HASH2 });
    await eventually(() => seed.snapshot().positions.length === 2);
    await seed.stop();

    const errors: string[] = [];
    const ledger = new PositionLedger(path, {
      tokenBalance: async (token) => {
        if (token.toLowerCase() === brokenToken.toLowerCase()) throw new Error("bad token balanceOf");
        return 0n;
      },
      tokenMetadata: async () => ({ symbol: null, decimals: null }),
    }, { ed: ED, kuzuo: KUZUO }, 100_000, {
      reconcileConcurrency: 2,
      onError: (reason) => errors.push(reason),
    });
    await ledger.start();
    await eventually(() => ledger.snapshot().positions.length === 1 && errors.length === 1);
    assert.equal(ledger.snapshot().positions[0]?.tokenAddress, brokenToken.toLowerCase());
    assert.match(errors[0] ?? "", /bad token balanceOf/);
    await ledger.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
