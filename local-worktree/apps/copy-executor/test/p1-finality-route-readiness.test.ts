import assert from "node:assert/strict";
import test from "node:test";
import type { BuilderEndpointConfig } from "../src/builders.js";
import type { CopyExecutorConfig, StrategyLaneConfig } from "../src/config.js";
import type { HexString, TargetStrategy } from "../src/core/messages.js";
import { CopyExecutionEngine } from "../src/engine.js";
import { HotSigner } from "../src/hot-signer.js";
import type { RpcReceipt } from "../src/rpc-client.js";
import type { RiskLedger } from "../src/risk-ledger.js";

const TARGET_HASH = `0x${"71".repeat(32)}` as HexString;
const COPY_HASH = `0x${"72".repeat(32)}` as HexString;
const TIP_HASH = `0x${"73".repeat(32)}` as HexString;
const EXTERNAL_SUCCESSOR_HASH = `0x${"74".repeat(32)}` as HexString;
const TARGET_BLOCK_HASH = `0x${"81".repeat(32)}` as HexString;
const COPY_BLOCK_HASH = `0x${"82".repeat(32)}` as HexString;
const TIP_BLOCK_HASH = `0x${"83".repeat(32)}` as HexString;
const EXTERNAL_BLOCK_HASH = `0x${"84".repeat(32)}` as HexString;

function lane(strategy: TargetStrategy, enabled: boolean): StrategyLaneConfig {
  return {
    strategy,
    label: strategy,
    enabled,
    signer: enabled ? new HotSigner(`0x${(strategy === "ed" ? "51" : "52").repeat(32)}`) : null,
    executorAddress: enabled ? "0x0000000000000000000000000000000000001001" : null,
    followAmountWei: 10n,
    builderTipWei: 1n,
    gasPriceWei: 1n,
    gasLimit: 1n,
    edMinReturnRetentionBps: 10_000,
    allowZeroMinReturnInLive: true,
  };
}

function liveConfig(): CopyExecutorConfig {
  return {
    mode: "live",
    liveConfirmed: true,
    fullPendingCostConfirmed: true,
    pendingWssUrls: [],
    headWssUrls: [],
    headReadyTimeoutMs: 5_000,
    blockRazorPublicMempool: {
      enabled: false,
      plaintextTransportConfirmed: false,
      name: "blockrazor-public-tokyo",
      endpoint: "63.254.162.18:50051",
      apiKey: null,
    },
    blockRazorPrivateMempool: {
      enabled: false,
      token: null,
      regions: ["tokyo"],
      connectTimeoutMs: 1_000,
      idleTimeoutMs: 60_000,
      submitTimeoutMs: 250,
      prewarmIntervalMs: 15_000,
    },
    httpRpcUrl: null,
    host: "127.0.0.1",
    port: 8770,
    riskLedgerPath: null,
    armFilePath: null,
    builders: [],
    lanes: { ed: lane("ed", true), kuzuo: lane("kuzuo", false) },
  };
}

interface ReceiptFixtureInternals {
  stopped: boolean;
  latestHead: { number: number; hash: HexString; timestamp: number; source: string; seenMonoNs: bigint } | null;
  rpc: {
    receipt(hash: string): Promise<RpcReceipt | null>;
    blockNumber(): Promise<number>;
    latestNonce(address: string): Promise<number>;
    pendingNonce(address: string): Promise<number>;
  };
  activeRaces: Map<string, Record<string, unknown>>;
  lanes: Record<TargetStrategy, { nonce: {
    synchronize(value: number): unknown;
    reserve(hash: string, block: number, time: string, span?: 1 | 2): unknown;
    markSubmitted(hash: string, builder: string): unknown;
    optimisticCommit(hash: string): unknown;
    snapshot(): {
      state: string;
      nextNonce: number | null;
      externalPending?: { nonce: number; hash: string | null } | null;
    };
  }; config: StrategyLaneConfig }>;
  ledger: RiskLedger;
  globalLedger: RiskLedger;
  reconcileRace(race: Record<string, unknown>): Promise<void>;
  handleCopyWalletPending(transaction: Record<string, unknown>): void;
}

function receipt(transactionHash: HexString, blockHash: HexString, transactionIndex: number): RpcReceipt {
  return {
    transactionHash,
    blockHash,
    blockNumber: 100,
    transactionIndex,
    status: 1,
    gasUsed: 1n,
    effectiveGasPrice: 1n,
  };
}

test("P1: a candidate receipt is provisional until both head/RPC finality and a stable second read", async (t) => {
  const engine = new CopyExecutionEngine(liveConfig());
  t.after(async () => engine.stop());
  const internals = engine as unknown as ReceiptFixtureInternals;
  internals.stopped = false;
  internals.latestHead = {
    number: 100,
    hash: TARGET_BLOCK_HASH,
    timestamp: Math.floor(Date.now() / 1_000),
    source: "test-head",
    seenMonoNs: process.hrtime.bigint(),
  };
  internals.lanes.ed.nonce.synchronize(7);
  internals.lanes.ed.nonce.reserve(TARGET_HASH, 100, "1", 2);
  internals.lanes.ed.nonce.markSubmitted(TARGET_HASH, "club48:raw");
  internals.lanes.ed.nonce.optimisticCommit(TARGET_HASH);
  const attempt = await internals.ledger.reserveAttempt({
    chainId: 56,
    signer: internals.lanes.ed.config.signer!.address,
    nonce: 7,
    strategy: "ed",
    targetHash: TARGET_HASH,
    candidateHashes: [COPY_HASH],
    tipCandidateHashes: [TIP_HASH],
    maxBlock: 100,
    worstCostWei: 20n,
  });
  const race: Record<string, unknown> = {
    targetHash: TARGET_HASH,
    strategy: "ed",
    validUntilBlock: 100,
    targetFirstSeenMonoNs: process.hrtime.bigint(),
    candidates: new Map([[COPY_HASH.toLowerCase(), {
      hash: COPY_HASH,
      valueWei: 10n,
      builders: ["club48:raw"],
      tipCandidates: new Map([[TIP_HASH.toLowerCase(), { hash: TIP_HASH, valueWei: 1n }]]),
    }]]),
    plannedRoutes: new Set(["club48:raw"]),
    persistedCandidateHashes: new Set([COPY_HASH.toLowerCase()]),
    riskAttemptKey: attempt.key,
    riskReservationPromise: null,
    nonce: 7,
    nonceSpan: 2,
    frontierCommitted: true,
    checkAttempts: 0,
    checking: true,
  };
  internals.activeRaces.set(`ed:${TARGET_HASH.toLowerCase()}`, race);
  let rpcBlock = 100;
  let targetReads = 0;
  let candidateReads = 0;
  let tipReads = 0;
  internals.rpc = {
    async receipt(hash) {
      if (hash.toLowerCase() === TARGET_HASH.toLowerCase()) {
        targetReads += 1;
        return receipt(TARGET_HASH, TARGET_BLOCK_HASH, 10);
      }
      if (hash.toLowerCase() === TIP_HASH.toLowerCase()) {
        tipReads += 1;
        return receipt(TIP_HASH, TIP_BLOCK_HASH, 12);
      }
      candidateReads += 1;
      return receipt(COPY_HASH, COPY_BLOCK_HASH, 11);
    },
    async blockNumber() { return rpcBlock; },
    async latestNonce() { return 9; },
    async pendingNonce() { return 9; },
  };

  await internals.reconcileRace(race);
  assert.equal(internals.ledger.attempt(attempt.key)?.state, "reserved", "the first receipt read must not settle risk");
  assert.equal(internals.lanes.ed.nonce.snapshot().state, "ready", "receipt audit must not reclaim the committed frontier");
  assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 9);
  assert.equal(internals.activeRaces.has(`ed:${TARGET_HASH.toLowerCase()}`), true, "the race must remain outstanding");
  assert.deepEqual([targetReads, candidateReads, tipReads], [1, 1, 1]);

  internals.latestHead.number = 102;
  rpcBlock = 102;
  await internals.reconcileRace(race);
  assert.equal(internals.ledger.attempt(attempt.key)?.state, "settled");
  assert.deepEqual([targetReads, candidateReads, tipReads], [2, 2, 2],
    "finality must trigger independent stable buy and tip receipt reads");
  assert.equal(internals.activeRaces.has(`ed:${TARGET_HASH.toLowerCase()}`), false);
  assert.equal(internals.lanes.ed.nonce.snapshot().state, "ready");
  assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 9,
    "finality accounting must not move the already committed signing frontier");
});

interface MutableReceiptRiskFixture {
  engine: CopyExecutionEngine;
  internals: ReceiptFixtureInternals;
  race: Record<string, unknown>;
  attemptKey: string;
  setCandidate(value: RpcReceipt | null): void;
  setHead(value: number): void;
}

async function mutableReceiptRiskFixture(): Promise<MutableReceiptRiskFixture> {
  const engine = new CopyExecutionEngine(liveConfig());
  const internals = engine as unknown as ReceiptFixtureInternals;
  internals.stopped = false;
  internals.latestHead = {
    number: 100,
    hash: TARGET_BLOCK_HASH,
    timestamp: Math.floor(Date.now() / 1_000),
    source: "test-head",
    seenMonoNs: process.hrtime.bigint(),
  };
  internals.lanes.ed.nonce.synchronize(7);
  internals.lanes.ed.nonce.reserve(TARGET_HASH, 100, "1", 2);
  internals.lanes.ed.nonce.markSubmitted(TARGET_HASH, "club48:raw");
  internals.lanes.ed.nonce.optimisticCommit(TARGET_HASH);
  const attempt = await internals.ledger.reserveAttempt({
    chainId: 56,
    signer: internals.lanes.ed.config.signer!.address,
    nonce: 7,
    strategy: "ed",
    targetHash: TARGET_HASH,
    candidateHashes: [COPY_HASH],
    tipCandidateHashes: [TIP_HASH],
    maxBlock: 100,
    worstCostWei: 20n,
  });
  const race: Record<string, unknown> = {
    targetHash: TARGET_HASH,
    strategy: "ed",
    validUntilBlock: 100,
    targetFirstSeenMonoNs: process.hrtime.bigint(),
    candidates: new Map([[COPY_HASH.toLowerCase(), {
      hash: COPY_HASH,
      valueWei: 10n,
      builders: ["club48:raw"],
      tipCandidates: new Map([[TIP_HASH.toLowerCase(), { hash: TIP_HASH, valueWei: 1n }]]),
    }]]),
    plannedRoutes: new Set(["club48:raw"]),
    persistedCandidateHashes: new Set([COPY_HASH.toLowerCase()]),
    riskAttemptKey: attempt.key,
    riskReservationPromise: null,
    nonce: 7,
    nonceSpan: 2,
    frontierCommitted: true,
    checkAttempts: 0,
    checking: true,
  };
  internals.activeRaces.set(`ed:${TARGET_HASH.toLowerCase()}`, race);
  let candidateReceipt: RpcReceipt | null = receipt(COPY_HASH, COPY_BLOCK_HASH, 11);
  internals.rpc = {
    async receipt(hash) {
      if (hash.toLowerCase() === TARGET_HASH.toLowerCase()) {
        return receipt(TARGET_HASH, TARGET_BLOCK_HASH, 10);
      }
      if (hash.toLowerCase() === TIP_HASH.toLowerCase()) {
        return receipt(TIP_HASH, TIP_BLOCK_HASH, 12);
      }
      return candidateReceipt;
    },
    async blockNumber() { return 102; },
    async latestNonce() { return 9; },
    async pendingNonce() { return 9; },
  };
  return {
    engine,
    internals,
    race,
    attemptKey: attempt.key,
    setCandidate(value) { candidateReceipt = value; },
    setHead(value) { internals.latestHead!.number = value; },
  };
}

function assertUnresolvedReceiptRisk(fixture: MutableReceiptRiskFixture): void {
  assert.equal(
    fixture.internals.ledger.attempt(fixture.attemptKey)?.state,
    "reserved",
    "an unstable receipt must never settle or release the reserved risk",
  );
  assert.equal(fixture.internals.lanes.ed.nonce.snapshot().state, "ready");
  assert.equal(fixture.internals.lanes.ed.nonce.snapshot().nextNonce, 9,
    "receipt uncertainty must trip the circuit without rewinding the committed frontier");
  assert.equal(fixture.engine.snapshot().circuitBroken, true);
  assert.equal(fixture.internals.globalLedger.circuitState().tripped, true, "the global circuit trip must be durable");
}

test("P1: a provisional candidate receipt that disappears at the +2 confirmation read stays unresolved", async (t) => {
  const fixture = await mutableReceiptRiskFixture();
  t.after(async () => fixture.engine.stop());

  await fixture.internals.reconcileRace(fixture.race);
  assert.equal(fixture.internals.ledger.attempt(fixture.attemptKey)?.state, "reserved");
  fixture.setCandidate(null);
  fixture.setHead(102);
  await fixture.internals.reconcileRace(fixture.race);

  assertUnresolvedReceiptRisk(fixture);
});

test("P1: any candidate blockHash/status/index drift before finality stays unresolved", async (t) => {
  const mutations: Array<[string, (value: RpcReceipt) => RpcReceipt]> = [
    ["blockHash", (value) => ({ ...value, blockHash: `0x${"83".repeat(32)}` as HexString })],
    ["status", (value) => ({ ...value, status: 0 })],
    ["transactionIndex", (value) => ({ ...value, transactionIndex: 12 })],
  ];

  for (const [field, mutate] of mutations) {
    const fixture = await mutableReceiptRiskFixture();
    t.after(async () => fixture.engine.stop());
    await fixture.internals.reconcileRace(fixture.race);
    fixture.setCandidate(mutate(receipt(COPY_HASH, COPY_BLOCK_HASH, 11)));
    fixture.setHead(101);
    await fixture.internals.reconcileRace(fixture.race);
    try {
      assertUnresolvedReceiptRisk(fixture);
    } catch (error) {
      assert.fail(`${field} drift did not fail closed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});

interface ReadinessInternals {
  stopped: boolean;
  broadcastClosed: boolean;
  circuitBroken: boolean;
  armGate: { armedState: boolean };
  latestHead: { number: number; hash: HexString; timestamp: number; source: string; seenMonoNs: bigint } | null;
  feedMetrics: Map<string, Record<string, unknown>>;
  builders: Array<{ config: BuilderEndpointConfig; snapshot(): { lastPrewarmMonoNs: string | null } }>;
  privateBuilders: Map<string, { config: BuilderEndpointConfig; snapshot(): { lastPrewarmMonoNs: string | null } }>;
  lanes: Record<TargetStrategy, { nonce: { synchronize(value: number): unknown } }>;
}

function freshBuilder(name: BuilderEndpointConfig["name"]) {
  const prewarmedAt = process.hrtime.bigint() - 1_000_000n;
  return {
    config: {
      name,
      url: `https://${name}.example/`,
      tipRecipient: "0x0000000000000000000000000000000000000001",
      requestTimeoutMs: 250,
      prewarmIntervalMs: name === "club48" ? 30_000 : 15_000,
    } satisfies BuilderEndpointConfig,
    snapshot: () => ({ lastPrewarmMonoNs: prewarmedAt.toString() }),
  };
}

test("P1: connected-but-non-actionable pending transport is not healthy", async (t) => {
  const actual: boolean[] = [];
  const reasons: string[][] = [];
  for (const metrics of [
    { connected: true, headsSubscriptionReady: false, pendingSubscriptionReady: false, actionable: false },
    { connected: true, headsSubscriptionReady: true, pendingSubscriptionReady: false, actionable: false },
    { connected: true, headsSubscriptionReady: true, pendingSubscriptionReady: true, actionable: false, hashOnlyNotifications: 1 },
  ]) {
    const engine = new CopyExecutionEngine(liveConfig());
    t.after(async () => engine.stop());
    const internals = engine as unknown as ReadinessInternals;
    internals.stopped = false;
    internals.broadcastClosed = false;
    internals.circuitBroken = false;
    internals.armGate.armedState = true;
    internals.latestHead = {
      number: 100,
      hash: TARGET_BLOCK_HASH,
      timestamp: Math.floor(Date.now() / 1_000),
      source: "test-head",
      seenMonoNs: process.hrtime.bigint(),
    };
    internals.lanes.ed.nonce.synchronize(7);
    internals.builders = [freshBuilder("club48")];
    internals.feedMetrics.set("pending-test", metrics);
    const snapshot = engine.snapshot();
    actual.push(snapshot.ok === true);
    reasons.push(snapshot.readinessReasons as string[]);
  }
  assert.deepEqual(actual, [false, false, false], "TCP-only, unacknowledged, and hash-only feeds are not actionable routes");
  assert.equal(
    reasons.every((entry) => entry.includes("target_source_not_actionable")),
    true,
    JSON.stringify(reasons),
  );
});

test("P1: Jet is a valid public race route while cross-region Private prewarm still fails closed", async (t) => {
  const results: boolean[] = [];
  const reasons: string[][] = [];
  for (const setup of [
    (internals: ReadinessInternals) => {
      internals.feedMetrics.set("pending-test", { connected: true, actionable: true });
      internals.builders = [freshBuilder("jet")];
    },
    (internals: ReadinessInternals) => {
      internals.feedMetrics.set("blockrazor-private-tokyo", { connected: true, connectionState: "streaming" });
      internals.privateBuilders.set("new-york", freshBuilder("blockrazor"));
    },
  ]) {
    const engine = new CopyExecutionEngine(liveConfig());
    t.after(async () => engine.stop());
    const internals = engine as unknown as ReadinessInternals;
    internals.stopped = false;
    internals.broadcastClosed = false;
    internals.circuitBroken = false;
    internals.armGate.armedState = true;
    internals.latestHead = {
      number: 100,
      hash: TARGET_BLOCK_HASH,
      timestamp: Math.floor(Date.now() / 1_000),
      source: "test-head",
      seenMonoNs: process.hrtime.bigint(),
    };
    internals.lanes.ed.nonce.synchronize(7);
    setup(internals);
    const snapshot = engine.snapshot();
    results.push(snapshot.ok === true);
    reasons.push(snapshot.readinessReasons as string[]);
  }
  assert.deepEqual(results, [true, false], "public Jet races, but Private must stay pinned to the matching region");
  assert.equal(reasons[0]?.includes("compatible_route_not_ready"), false, JSON.stringify(reasons));
  assert.equal(reasons[1]?.includes("compatible_route_not_ready"), true, JSON.stringify(reasons));
});
