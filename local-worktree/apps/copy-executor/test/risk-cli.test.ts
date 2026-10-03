import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CLEAR_CONFIRMATION, runRiskCommand } from "../src/risk-cli.js";
import { RiskLedger, riskLedgerPaths, type RiskLedgerIdentity } from "../src/risk-ledger.js";

const ED_SIGNER = "0x1111111111111111111111111111111111111111";
const ED_EXECUTOR = "0x2222222222222222222222222222222222222222";
const KUZUO_SIGNER = "0x3333333333333333333333333333333333333333";
const KUZUO_EXECUTOR = "0x4444444444444444444444444444444444444444";

function temporaryBase(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "copy-executor-risk-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "risk-ledger.json");
}

async function initialize(path: string, identity: RiskLedgerIdentity): Promise<RiskLedger> {
  const ledger = new RiskLedger(path);
  await ledger.load();
  await ledger.ensureIdentity(identity, true);
  return ledger;
}

test("risk status aggregates global, Ed and kuzuo files without exposing identities or paths", async (t) => {
  const basePath = temporaryBase(t);
  const paths = riskLedgerPaths(basePath);
  const global = await initialize(paths.global, { chainId: 56, lanes: { ed: null, kuzuo: null } });
  const ed = await initialize(paths.ed, {
    chainId: 56,
    lanes: { ed: { signer: ED_SIGNER, executor: ED_EXECUTOR }, kuzuo: null },
  });
  const kuzuo = await initialize(paths.kuzuo, {
    chainId: 56,
    lanes: { ed: null, kuzuo: { signer: KUZUO_SIGNER, executor: KUZUO_EXECUTOR } },
  });
  await global.tripCircuit("shared canonical integrity fault");
  const settled = await ed.reserveAttempt({
    chainId: 56,
    signer: ED_SIGNER,
    nonce: 1,
    strategy: "ed",
    targetHash: `0x${"11".repeat(32)}`,
    candidateHashes: [`0x${"12".repeat(32)}`],
    maxBlock: 100,
    worstCostWei: 10n,
  });
  await ed.settleAttemptActual(settled.key, 7n);
  const unresolved = await kuzuo.reserveAttempt({
    chainId: 56,
    signer: KUZUO_SIGNER,
    nonce: 2,
    strategy: "kuzuo",
    targetHash: `0x${"21".repeat(32)}`,
    candidateHashes: [`0x${"22".repeat(32)}`],
    maxBlock: 100,
    worstCostWei: 11n,
  });
  await Promise.all([global.close(), ed.close(), kuzuo.close()]);

  const status = await runRiskCommand({ command: "status", basePath });
  assert.equal(status.globalCircuit.tripped, true);
  assert.equal(status.unresolvedAttempts, 1);
  assert.equal(status.settledAttempts, 1);
  assert.equal(status.ledgers.ed.settledAttempts, 1);
  assert.equal(status.ledgers.kuzuo.unresolvedAttempts, 1);
  const output = JSON.stringify(status);
  assert.equal(output.includes(basePath), false);
  assert.equal(output.toLowerCase().includes(ED_SIGNER.slice(2).toLowerCase()), false);
  assert.equal(output.toLowerCase().includes(KUZUO_EXECUTOR.slice(2).toLowerCase()), false);

  const lane = new RiskLedger(paths.kuzuo);
  await lane.load({ requireExisting: true });
  assert.equal(lane.attempt(unresolved.key)?.state, "reserved");
  await lane.close();
});

test("clear-circuit refuses any lane risk and clears lanes before the global maintenance latch", async (t) => {
  const basePath = temporaryBase(t);
  const paths = riskLedgerPaths(basePath);
  const global = await initialize(paths.global, { chainId: 56, lanes: { ed: null, kuzuo: null } });
  const ed = await initialize(paths.ed, {
    chainId: 56,
    lanes: { ed: { signer: ED_SIGNER, executor: ED_EXECUTOR }, kuzuo: null },
  });
  const kuzuo = await initialize(paths.kuzuo, {
    chainId: 56,
    lanes: { ed: null, kuzuo: { signer: KUZUO_SIGNER, executor: KUZUO_EXECUTOR } },
  });
  await Promise.all([
    global.tripCircuit("global stop"),
    ed.tripCircuit("Ed stop"),
    kuzuo.tripCircuit("kuzuo stop"),
  ]);
  const attempt = await kuzuo.reserveAttempt({
    chainId: 56,
    signer: KUZUO_SIGNER,
    nonce: 9,
    strategy: "kuzuo",
    targetHash: `0x${"31".repeat(32)}`,
    candidateHashes: [`0x${"32".repeat(32)}`],
    maxBlock: 100,
    worstCostWei: 20n,
  });
  await Promise.all([global.close(), ed.close(), kuzuo.close()]);

  await assert.rejects(
    runRiskCommand({ command: "clear-circuit", basePath, confirmation: CLEAR_CONFIRMATION }),
    /any global or lane ledger has an unresolved attempt/,
  );
  const stillBlocked = await runRiskCommand({ command: "status", basePath });
  assert.equal(stillBlocked.globalCircuit.tripped, true);
  assert.equal(stillBlocked.ledgers.ed.circuit.tripped, true);
  assert.equal(stillBlocked.ledgers.kuzuo.circuit.tripped, true);

  const reconciled = new RiskLedger(paths.kuzuo);
  await reconciled.load({ requireExisting: true });
  await reconciled.releaseConfirmedNotIncluded(attempt.key);
  await reconciled.close();
  const cleared = await runRiskCommand({
    command: "clear-circuit",
    basePath,
    confirmation: CLEAR_CONFIRMATION,
  });
  assert.equal(cleared.unresolvedAttempts, 0);
  assert.equal(cleared.globalCircuit.tripped, false);
  assert.equal(cleared.ledgers.ed.circuit.tripped, false);
  assert.equal(cleared.ledgers.kuzuo.circuit.tripped, false);
});

test("risk status fails closed when any deterministically derived lane file is absent", async (t) => {
  const basePath = temporaryBase(t);
  const paths = riskLedgerPaths(basePath);
  const global = await initialize(paths.global, { chainId: 56, lanes: { ed: null, kuzuo: null } });
  await global.close();
  await assert.rejects(
    runRiskCommand({ command: "status", basePath }),
    /pre-initialized risk ledger/,
  );
});
