import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  RiskLedger,
  riskAttemptKey,
  riskLedgerPaths,
  type RiskLedgerIdentity,
  type RiskAttemptReservation,
} from "../src/risk-ledger.js";

const SIGNER = "0x1111111111111111111111111111111111111111";
const TARGET = `0x${"aa".repeat(32)}`;
const CANDIDATE_A = `0x${"bb".repeat(32)}`;
const CANDIDATE_B = `0x${"cc".repeat(32)}`;
const EXECUTOR = "0x2222222222222222222222222222222222222222";

const IDENTITY: RiskLedgerIdentity = {
  chainId: 56,
  lanes: {
    ed: { signer: SIGNER, executor: EXECUTOR },
    kuzuo: null,
  },
};

function reservation(overrides: Partial<RiskAttemptReservation> = {}): RiskAttemptReservation {
  return {
    chainId: 56,
    signer: SIGNER,
    nonce: 42,
    strategy: "ed",
    targetHash: TARGET,
    candidateHashes: [CANDIDATE_A],
    maxBlock: 114_700_001,
    worstCostWei: 100n,
    ...overrides,
  };
}

function temporaryLedger(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "copy-executor-risk-ledger-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "risk-ledger.json");
}

test("attempt reservations are idempotent, nonce-bound and included in risk totals", async () => {
  const ledger = new RiskLedger(null);
  const first = await ledger.reserveAttempt(reservation());
  const key = riskAttemptKey(reservation());
  assert.equal(first.key, key);
  assert.equal(ledger.spent("ed"), 100n);
  assert.equal(ledger.trades("ed"), 1);

  const repeated = await ledger.reserveAttempt(reservation({ candidateHashes: [CANDIDATE_A, CANDIDATE_B] }));
  assert.deepEqual(repeated.candidateHashes, [CANDIDATE_A, CANDIDATE_B].sort());
  assert.equal(ledger.spent("ed"), 100n, "an idempotent reservation must not reserve twice");
  assert.equal(ledger.trades("ed"), 1);

  const rolled = await ledger.reserveAttempt(reservation({
    candidateHashes: [CANDIDATE_B],
    maxBlock: 114_700_009,
    orderingMode: "any_block_after",
  }));
  assert.equal(rolled.lastSubmittedBlock, 114_700_009);
  assert.equal(rolled.maxBlock, 114_700_009);
  assert.equal(rolled.orderingMode, "any_block_after");
  assert.ok(rolled.lastSubmissionAt);
  assert.throws(
    () => ledger.reserveAttempt(reservation({ maxBlock: 114_700_008 })),
    /submission block cannot regress/,
  );

  assert.throws(
    () => ledger.reserveAttempt(reservation({ targetHash: `0x${"dd".repeat(32)}` })),
    /different immutable trade data/,
  );
});

test("a durably not-included nonce can be rebound to a causally newer target", async () => {
  const ledger = new RiskLedger(null);
  const first = await ledger.reserveAttempt(reservation());
  await ledger.releaseConfirmedNotIncluded(first.key);
  const replacementHash = `0x${"de".repeat(32)}`;
  const replacementCandidate = `0x${"df".repeat(32)}`;
  const replacement = await ledger.reserveAttempt(reservation({
    targetHash: replacementHash,
    candidateHashes: [replacementCandidate],
    maxBlock: 114_700_010,
  }));
  assert.equal(replacement.key, first.key);
  assert.equal(replacement.state, "reserved");
  assert.equal(replacement.targetHash, replacementHash);
  assert.deepEqual(replacement.candidateHashes, [replacementCandidate]);
});

test("an unresolved reservation survives process restart", async (t) => {
  const path = temporaryLedger(t);
  const now = () => new Date("2026-08-08T12:00:00.000Z");
  const first = new RiskLedger(path, { now });
  const attempt = await first.reserveAttempt(reservation());
  await first.close();

  const restarted = new RiskLedger(path, { now });
  await restarted.load();
  assert.equal(restarted.attempt(attempt.key)?.state, "reserved");
  assert.equal(restarted.spent("ed"), 100n);
  assert.equal(restarted.trades("ed"), 1);
});

test("live load fails closed if the ledger was deleted, and dry-sign identity initialization is exact", async (t) => {
  const path = temporaryLedger(t);
  const missing = new RiskLedger(path);
  await assert.rejects(
    missing.load({ requireExisting: true }),
    /pre-initialized risk ledger/,
  );

  const initialized = new RiskLedger(path);
  await initialized.load();
  await initialized.ensureIdentity(IDENTITY, true);
  await initialized.close();

  const matching = new RiskLedger(path);
  await matching.load({ requireExisting: true });
  await matching.ensureIdentity(IDENTITY, false);
  assert.deepEqual(matching.snapshot().identity, {
    chainId: 56,
    lanes: {
      ed: { signer: SIGNER.toLowerCase(), executor: EXECUTOR.toLowerCase() },
      kuzuo: null,
    },
  });
  assert.throws(
    () => matching.ensureIdentity({
      ...IDENTITY,
      lanes: {
        ...IDENTITY.lanes,
        ed: { ...IDENTITY.lanes.ed!, executor: "0x3333333333333333333333333333333333333333" },
      },
    }, false),
    /identity does not match/,
  );
});

test("one base path deterministically derives independent global and lane ledgers", () => {
  assert.deepEqual(riskLedgerPaths("/var/lib/vigil/risk-ledger.json"), {
    global: "/var/lib/vigil/risk-ledger.json",
    ed: "/var/lib/vigil/risk-ledger.ed.json",
    kuzuo: "/var/lib/vigil/risk-ledger.kuzuo.json",
  });
  assert.deepEqual(riskLedgerPaths("risk-ledger"), {
    global: "risk-ledger",
    ed: "risk-ledger.ed",
    kuzuo: "risk-ledger.kuzuo",
  });
  assert.throws(() => riskLedgerPaths("   "), /base path/);
});

test("independent lane ledgers persist concurrent reservations without sharing a write tail", async () => {
  let active = 0;
  let maxActive = 0;
  let arrivals = 0;
  let bothEntered!: () => void;
  const entered = new Promise<void>((resolve) => { bothEntered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writeDocument = async (): Promise<void> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    arrivals += 1;
    if (arrivals === 2) bothEntered();
    await gate;
    active -= 1;
  };
  const ed = new RiskLedger("ed-ledger", { writeDocument });
  const kuzuo = new RiskLedger("kuzuo-ledger", { writeDocument });

  const writes = Promise.all([
    ed.reserveAttempt(reservation()),
    kuzuo.reserveAttempt(reservation({
      signer: "0x3333333333333333333333333333333333333333",
      nonce: 7,
      strategy: "kuzuo",
      targetHash: `0x${"dd".repeat(32)}`,
      candidateHashes: [`0x${"ee".repeat(32)}`],
    })),
  ]);
  await entered;
  assert.equal(maxActive, 2, "Ed and kuzuo fsync queues must overlap instead of serializing");
  release();
  await writes;
});

test("UTC rotation resets confirmed counters but never drops an outstanding attempt", async (t) => {
  const path = temporaryLedger(t);
  let instant = new Date("2026-08-08T23:59:59.000Z");
  const now = () => new Date(instant);
  const ledger = new RiskLedger(path, { now });
  const attempt = await ledger.reserveAttempt(reservation());

  instant = new Date("2026-08-09T00:00:01.000Z");
  assert.equal(ledger.spent("ed"), 100n, "the old-day reservation still consumes today's risk room");
  assert.equal(ledger.trades("ed"), 1);
  await ledger.flush();

  const restarted = new RiskLedger(path, { now });
  await restarted.load();
  assert.equal(restarted.snapshot().utcDate, "2026-08-09");
  assert.equal(restarted.attempt(attempt.key)?.state, "reserved");
  assert.equal(restarted.spent("ed"), 100n);
});

test("unknown nonce consumption charges worst case once and later settlement adjusts the same attempt", async (t) => {
  const path = temporaryLedger(t);
  const now = () => new Date("2026-08-08T12:00:00.000Z");
  const ledger = new RiskLedger(path, { now });
  const attempt = await ledger.reserveAttempt(reservation());

  await ledger.chargeUnknownConsumption(attempt.key);
  await ledger.chargeUnknownConsumption(attempt.key);
  assert.equal(ledger.spent("ed"), 100n);
  assert.equal(ledger.trades("ed"), 1);
  assert.equal(ledger.attempt(attempt.key)?.state, "unknown_charged");

  await ledger.settleAttemptActual(attempt.key, 60n);
  await ledger.settleAttemptActual(attempt.key, 60n);
  assert.equal(ledger.spent("ed"), 60n);
  assert.equal(ledger.trades("ed"), 1);
  assert.throws(() => ledger.settleAttemptActual(attempt.key, 61n), /different actual cost/);

  const restarted = new RiskLedger(path, { now });
  await restarted.load();
  assert.equal(restarted.attempt(attempt.key)?.state, "settled");
  assert.equal(restarted.spent("ed"), 60n);
  assert.equal(restarted.trades("ed"), 1);
});

test("an unresolved unknown charge cannot be manually cleared", async () => {
  const ledger = new RiskLedger(null);
  const attempt = await ledger.reserveAttempt(reservation());
  await ledger.chargeUnknownConsumption(attempt.key);
  await ledger.tripCircuit("unknown nonce consumption");
  assert.throws(
    () => ledger.clearCircuit(),
    /unresolved attempt/,
  );
});

test("known settlement and confirmed-not-included release cannot double account", async () => {
  const settledLedger = new RiskLedger(null);
  const settled = await settledLedger.reserveAttempt(reservation());
  await settledLedger.settleAttemptActual(settled.key, 75n);
  await settledLedger.settleAttemptActual(settled.key, 75n);
  assert.equal(settledLedger.spent("ed"), 75n);
  assert.equal(settledLedger.trades("ed"), 1);
  assert.throws(() => settledLedger.releaseConfirmedNotIncluded(settled.key), /cannot be released/);

  const releasedLedger = new RiskLedger(null);
  const released = await releasedLedger.reserveAttempt(reservation({ nonce: 43 }));
  await releasedLedger.releaseConfirmedNotIncluded(released.key);
  await releasedLedger.releaseConfirmedNotIncluded(released.key);
  assert.equal(releasedLedger.spent("ed"), 0n);
  assert.equal(releasedLedger.trades("ed"), 0);
  assert.throws(() => releasedLedger.chargeUnknownConsumption(released.key), /cannot consume nonce/);
});

test("v1 is migrated durably without weakening current-day counters", async (t) => {
  const path = temporaryLedger(t);
  writeFileSync(path, JSON.stringify({
    version: 1,
    utcDate: "2026-08-08",
    spentWei: { ed: "123", kuzuo: "456" },
    includedTrades: { ed: 2, kuzuo: 3 },
  }) + "\n", { encoding: "utf8", mode: 0o600 });

  const ledger = new RiskLedger(path, { now: () => new Date("2026-08-08T12:00:00.000Z") });
  await ledger.load();
  assert.equal(ledger.spent("ed"), 123n);
  assert.equal(ledger.trades("kuzuo"), 3);
  const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.version, 2);
  assert.deepEqual(persisted.attempts, {});
  assert.deepEqual(persisted.circuit, { tripped: false, reason: null, trippedAt: null });
});

test("live verification rejects legacy and unbound ledgers without changing one byte", async (t) => {
  const path = temporaryLedger(t);
  const legacyBytes = JSON.stringify({
    version: 1,
    utcDate: "2026-08-07",
    spentWei: { ed: "123", kuzuo: "456" },
    includedTrades: { ed: 2, kuzuo: 3 },
  }, null, 2) + "\n";
  writeFileSync(path, legacyBytes, { encoding: "utf8", mode: 0o600 });
  const legacy = new RiskLedger(path, { now: () => new Date("2026-08-08T12:00:00.000Z") });
  await assert.rejects(legacy.load({ requireExisting: true }), /version 2 identity-bound/);
  assert.equal(readFileSync(path, "utf8"), legacyBytes, "live load must not migrate a v1 file");

  const unbound = new RiskLedger(path, { now: () => new Date("2026-08-07T12:00:00.000Z") });
  await unbound.load();
  await unbound.recordIncluded("ed", 9n);
  await unbound.close();
  const unboundBytes = readFileSync(path, "utf8");
  const live = new RiskLedger(path, { now: () => new Date("2026-08-08T12:00:00.000Z") });
  await assert.rejects(live.load({ requireExisting: true }), /identity-bound/);
  assert.equal(readFileSync(path, "utf8"), unboundBytes, "live load must reject before UTC rotation or any write");
});

test("UTC rotation prunes all resolved attempts while preserving unresolved risk over long runtimes", async () => {
  let instant = new Date("2026-01-01T12:00:00.000Z");
  const ledger = new RiskLedger(null, { now: () => new Date(instant) });
  const reserved = await ledger.reserveAttempt(reservation({ nonce: 1 }));
  const unknown = await ledger.reserveAttempt(reservation({ nonce: 2 }));
  await ledger.chargeUnknownConsumption(unknown.key);

  for (let day = 0; day < 40; day += 1) {
    for (let index = 0; index < 8; index += 1) {
      const nonce = 100 + day * 16 + index * 2;
      const settled = await ledger.reserveAttempt(reservation({
        nonce,
        targetHash: `0x${nonce.toString(16).padStart(64, "0")}`,
        candidateHashes: [`0x${(nonce + 1).toString(16).padStart(64, "0")}`],
      }));
      await ledger.settleAttemptActual(settled.key, 50n);
      const released = await ledger.reserveAttempt(reservation({
        nonce: nonce + 1,
        targetHash: `0x${(nonce + 2).toString(16).padStart(64, "0")}`,
        candidateHashes: [`0x${(nonce + 3).toString(16).padStart(64, "0")}`],
      }));
      await ledger.releaseConfirmedNotIncluded(released.key);
    }
    instant = new Date(instant.getTime() + 24 * 60 * 60 * 1_000);
    const attempts = ledger.snapshot().attempts;
    assert.deepEqual(Object.keys(attempts).sort(), [reserved.key, unknown.key].sort());
    assert.equal(attempts[reserved.key]?.state, "reserved");
    assert.equal(attempts[unknown.key]?.state, "unknown_charged");
  }
});

test("circuit trip survives restart and UTC rotation until explicit clear", async (t) => {
  const path = temporaryLedger(t);
  let instant = new Date("2026-08-08T23:59:59.000Z");
  const now = () => new Date(instant);
  const first = new RiskLedger(path, { now });
  await first.tripCircuit("receipt reconciliation failed closed");

  instant = new Date("2026-08-09T00:00:01.000Z");
  const restarted = new RiskLedger(path, { now });
  await restarted.load();
  assert.deepEqual(restarted.circuitState(), {
    tripped: true,
    reason: "receipt reconciliation failed closed",
    trippedAt: "2026-08-08T23:59:59.000Z",
  });
  await restarted.clearCircuit();

  const cleared = new RiskLedger(path, { now });
  await cleared.load();
  assert.deepEqual(cleared.circuitState(), { tripped: false, reason: null, trippedAt: null });
});

test("persistence failures reject the mutating call and an idempotent retry can recover", async () => {
  let writes = 0;
  let fail = true;
  let durable = "";
  const ledger = new RiskLedger("ignored-by-injected-writer", {
    writeDocument: async (_path, contents) => {
      writes += 1;
      if (fail) throw new Error("injected durable write failure");
      durable = contents;
    },
  });

  await assert.rejects(ledger.reserveAttempt(reservation()), /injected durable write failure/);
  await assert.rejects(ledger.flush(), /injected durable write failure/);
  assert.equal(ledger.spent("ed"), 100n, "failed persistence must not silently release in-memory risk");

  fail = false;
  await ledger.reserveAttempt(reservation());
  await ledger.flush();
  assert.equal(writes, 2);
  assert.equal((JSON.parse(durable) as { version: number }).version, 2);
});
