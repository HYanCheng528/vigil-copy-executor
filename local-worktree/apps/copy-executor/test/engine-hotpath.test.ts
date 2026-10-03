import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Transaction } from "ethers";
import {
  BuilderClient,
  type BuilderAck,
  type BuilderEndpointConfig,
  type PreparedBuilderSubmission,
  type SubmitIntent,
} from "../src/builders.js";
import type { CopyExecutorConfig, StrategyLaneConfig } from "../src/config.js";
import {
  brandSourceVerifiedTargetSignal,
  validateTargetSignal,
  type HexString,
  type TargetSignal,
  type TargetStrategy,
  type TargetTransactionWire,
} from "../src/core/messages.js";
import { CopyExecutionEngine } from "../src/engine.js";
import { HotSigner } from "../src/hot-signer.js";
import type { DetachedMachineDispatchNotifier } from "../src/machine-dispatch-notifier.js";
import { pendingObjectToWire, type HeadSnapshot } from "../src/pending-feed.js";
import type { RpcReceipt } from "../src/rpc-client.js";
import { RiskLedger, riskAttemptKey, riskLedgerPaths, type RiskAttemptReservation } from "../src/risk-ledger.js";

const ED_INPUT = "0x4d819a2a00000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002c8f1317859033b000000000000000000000000000000000000000000074c1456e5d34ccb5367b700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000003200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00000000000000000000000055d398326f99059ff775485246999027b319795500000000000000000000000016b9a82891338f9ba80e2d6970fdda79d1eb0dae00000000000000000000000000000000000000000000000000000000000009c4000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000055d398326f99059ff775485246999027b319795500000000000000000000000002fca66c1d1afb4e2a7884261eb00f63598a74360000000000000000000000008fb4243b553ac29ba088acf00b9b7da24bd6690c00000000000000000000000000000000000000000000000000000000000009c4000000000000000000000000000000000000000000000000000000000000003200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000002fca66c1d1afb4e2a7884261eb00f63598a7436000000000000000000000000b02a6508fbfb98fce8f10ca33976017409ce7777000000000000000000000000b02a6508fbfb98fce8f10ca33976017409ce77770000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
const KUZUO_INPUT = "0x4d819a2a00000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009935f581f0500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006a74a5cb0000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000003200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00000000000000000000000055d398326f99059ff775485246999027b3197955000000000000000000000000172fcd41e0913e95784454622d1c3724f546f8490000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000055d398326f99059ff775485246999027b319795500000000000000000000000080106cb3ead06659a5ad19df39d9b4733863b9b00000000000000000000000005018b018ceb7645c927c5cf246786f89ebcbe7ea00000000000000000000000000000000000000000000000000000000000009c4000000000000000000000000000000000000000000000000000000000000003200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000080106cb3ead06659a5ad19df39d9b4733863b9b000000000000000000000000099391685c25fce9f6bf10979bebb0e113205777700000000000000000000000099391685c25fce9f6bf10979bebb0e11320577770000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

const BUILDER_CONFIGS: BuilderEndpointConfig[] = [
  { name: "club48", url: "https://club48.example/", tipRecipient: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848", requestTimeoutMs: 250, prewarmIntervalMs: 30_000 },
  { name: "blockrazor", url: "https://blockrazor.example/", authorization: "Bearer test-blockrazor", tipRecipient: "0x1266c6be60392a8ff346e8d5eccd3e69dd9c5f20", requestTimeoutMs: 250, prewarmIntervalMs: 15_000 },
  { name: "jet", url: "https://jet.example/", tipRecipient: "0xe89c42bc188c993273ab34231e12ae60c73042e4", requestTimeoutMs: 250, prewarmIntervalMs: 15_000 },
];

function rpcFixture(strategy: TargetStrategy): Record<string, unknown> {
  if (strategy === "ed") {
    return {
      hash: "0x48863743e19ed223bc7e570eeb65f0151a51f35e5cb0b16ebbcf581a5cc40bf1",
      chainId: "0x38",
      type: "0x0",
      from: "0xc2c6acd377458010713e733e1b21dd6f670d091c",
      to: "0x1de460f363af910f51726def188f9004276bf4bc",
      nonce: "0x7a90",
      gas: "0x162010",
      gasPrice: "0x2540be400",
      value: "0x2c8f1317859033b",
      input: ED_INPUT,
      v: "0x94",
      r: "0x296d79c02bac90de3a9237faf85e958c7d6deb341c06f17917ebd131804ef99a",
      s: "0x6e4529f423fd7433c5cd7787acecdb3a872ee55eebfb762a68c70c4ee42bde7b",
    };
  }
  return {
    hash: "0xd3c430b3a02f8dccf7509caa7cb22276f782b1d8d2008c91632fe2a7b0b6deb5",
    chainId: "0x38",
    type: "0x0",
    from: "0x2ce9d43d1cba6ae31d7f07bfe0098dfa2d833373",
    to: "0x1de460f363af910f51726def188f9004276bf4bc",
    nonce: "0x9a4f",
    gas: "0x162010",
    gasPrice: "0xcce416600",
    value: "0x9935f581f050000",
    input: KUZUO_INPUT,
    v: "0x94",
    r: "0x414ae9a04cb225af5127c3d0aa98822d3f5202408725f53a5c7053a307b34f47",
    s: "0x3680cceecd0a07889c276d34193d1871110719e8ffb0738c6ddafa94af986c25",
  };
}

function targetSignal(strategy: TargetStrategy, source: TargetSignal["source"] = "bsc_pending_full"): TargetSignal {
  return {
    version: 1,
    source,
    sourceSequence: `fixture:${source}:${strategy}`,
    firstSeenUnixNs: "1786180000000000000",
    firstSeenMonoNs: "123456789000",
    strategy,
    transaction: pendingObjectToWire(rpcFixture(strategy)),
  };
}

function privateTargetSignal(strategy: TargetStrategy = "ed", inputOverride?: HexString): TargetSignal {
  const ordinary = targetSignal(strategy);
  const tx = ordinary.transaction as ReturnType<typeof pendingObjectToWire>;
  return {
    ...ordinary,
    source: "blockrazor_private_mempool",
    sourceSequence: "blockrazor-private-tokyo:1",
    transaction: {
      disclosure: "blockrazor_private",
      hash: tx.hash,
      chainId: 56,
      from: tx.from,
      to: tx.to,
      nonce: tx.nonce,
      valueWei: tx.valueWei,
      input: inputOverride ?? tx.input,
      functionSelector: "0x4d819a2a",
      logCount: 1,
    },
    sourceBlockHint: 114_700_001,
    blockRazorPrivateBundle: {
      bundleHash: `0x${(strategy === "ed" ? "91" : "92").repeat(32)}` as HexString,
      region: "tokyo",
      nextBlockNumber: 114_700_001,
      maxBlockNumber: 114_700_001,
      proxyBidContract: "0x74Ce839c6aDff544139f27C1257D34944B794605",
      refundAddress: "0x9abae1b279a4be25aeae49a33e807cdd3ccffa0c",
      refundCfg: "10380050",
      targetIndex: 0,
      transactionCount: 1,
      logsVerified: true,
      routerSwapVerified: true,
    },
  };
}

function lane(strategy: TargetStrategy, signer: HotSigner): StrategyLaneConfig {
  return {
    strategy,
    label: strategy,
    enabled: true,
    signer,
    executorAddress: strategy === "ed"
      ? "0x0000000000000000000000000000000000001001"
      : "0x0000000000000000000000000000000000001002",
    followAmountWei: 10_000_000_000_000_000n,
    builderTipWei: 1_000_000_000_000_000n,
    gasPriceWei: 1_000_000_000n,
    gasLimit: 1_750_000n,
    edMinReturnRetentionBps: 10_000,
    allowZeroMinReturnInLive: true,
  };
}

function config(mode: "shadow" | "live"): CopyExecutorConfig {
  return {
    mode,
    liveConfirmed: mode === "live",
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
    builders: BUILDER_CONFIGS.map((entry) => ({ ...entry })),
    lanes: {
      ed: lane("ed", new HotSigner(`0x${"51".repeat(32)}`)),
      kuzuo: lane("kuzuo", new HotSigner(`0x${"52".repeat(32)}`)),
    },
  };
}

interface EngineInternals {
  builders: unknown[];
  privateBuilders: Map<string, unknown>;
  feedMetrics: Map<string, Record<string, unknown>>;
  armGate: { armedState: boolean };
  stopped: boolean;
  broadcastClosed: boolean;
  circuitBroken: boolean;
  activeRaces: Map<string, Record<string, unknown>>;
  lanes: Record<TargetStrategy, { nonce: {
    synchronize(value: number): unknown;
    reserve(hash: string, validUntilBlock: number, nowMonoNs: string): unknown;
    snapshot(): { state: string; nextNonce: number | null; lease: unknown };
  }; config: StrategyLaneConfig; ledger: RiskLedger; circuitBroken: boolean; circuitReason: string | null }>;
  ledger: RiskLedger;
  globalLedger: RiskLedger;
  rpc: {
    minedTargetTransaction(hash: string): Promise<unknown>;
    latestNonce(address: string): Promise<number>;
    pendingNonce(address: string): Promise<number>;
    receipt(hash: string): Promise<RpcReceipt | null>;
    blockNumber(): Promise<number>;
  } | null;
  handleHead(head: HeadSnapshot): void;
  handleTarget(signal: TargetSignal, timing: { socketSeenMonoNs: bigint; parsedMonoNs: bigint; matchedMonoNs: bigint }): Promise<void>;
  handleCopyWalletPending(transaction: TargetTransactionWire): void;
  cancelBeforeBroadcast(context: Record<string, unknown>, reason: string): Promise<void>;
  builderIsFresh(builder: unknown, now: bigint): boolean;
  orderingAccepted(receipt: RpcReceipt, targetReceipt: RpcReceipt | null, mode?: "same_block_after" | "next_block_after" | "any_block_after"): boolean;
}

function readyEngine(engine: CopyExecutionEngine, strategy: TargetStrategy): { internals: EngineInternals; timing: { socketSeenMonoNs: bigint; parsedMonoNs: bigint; matchedMonoNs: bigint } } {
  const internals = engine as unknown as EngineInternals;
  internals.stopped = false;
  internals.broadcastClosed = modeIsLive(engine) ? false : true;
  internals.feedMetrics.set("pending-test", {
    connected: true,
    headsSubscriptionReady: true,
    pendingSubscriptionReady: true,
    actionable: true,
  });
  const socketSeenMonoNs = process.hrtime.bigint();
  internals.handleHead({
    number: 114_700_000,
    hash: `0x${"ab".repeat(32)}` as HexString,
    timestamp: Math.floor(Date.now() / 1_000),
    source: "test-head",
    seenMonoNs: socketSeenMonoNs - 1_000_000n,
  });
  internals.lanes[strategy].nonce.synchronize(12);
  return {
    internals,
    timing: { socketSeenMonoNs, parsedMonoNs: socketSeenMonoNs, matchedMonoNs: socketSeenMonoNs },
  };
}

function modeIsLive(engine: CopyExecutionEngine): boolean {
  return engine.config.mode === "live";
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 500): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function eventually(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(label + " timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function capturingBuilderRace(
  prepared: Array<{ builder: string; intent: SubmitIntent }>,
  dispatched: string[],
): EngineInternals["builders"] {
  const fresh = (process.hrtime.bigint() - 1_000_000n).toString();
  return BUILDER_CONFIGS.map((builderConfig) => ({
    config: builderConfig,
    snapshot: () => ({ lastPrewarmMonoNs: fresh }),
    prepare(intent: SubmitIntent): PreparedBuilderSubmission {
      prepared.push({ builder: builderConfig.name, intent });
      return {
        builder: builderConfig.name,
        url: builderConfig.url,
        headers: {},
        body: "{}",
        preparedMonoNs: process.hrtime.bigint(),
      };
    },
    async dispatch(): Promise<BuilderAck> {
      dispatched.push(builderConfig.name);
      const now = process.hrtime.bigint();
      return {
        builder: builderConfig.name,
        accepted: true,
        bundleId: `0x${"ef".repeat(32)}`,
        httpStatus: 200,
        startedMonoNs: now,
        responseMonoNs: now,
        latencyMs: 0,
        error: null,
      };
    },
  })) as EngineInternals["builders"];
}

test("live public hot path starts every Builder race before microtask risk persistence", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  const order: string[] = [];
  const preparedIntents: SubmitIntent[] = [];
  const signer = {
    address: "0x0000000000000000000000000000000000009001",
    signDirectGmgnBuy(request: { routerCalldata: HexString; swapValueWei: bigint }) {
      order.push("sign:buy");
      return {
        rawTransaction: "0x61" as HexString,
        hash: `0x${"61".repeat(32)}` as HexString,
        data: request.routerCalldata,
        valueWei: request.swapValueWei,
        signedMonoNs: process.hrtime.bigint(),
      };
    },
    signBuilderTip(request: { tipRecipient: string; builderTipWei: bigint }) {
      const name = BUILDER_CONFIGS.find((builder) => builder.tipRecipient.toLowerCase() === request.tipRecipient.toLowerCase())!.name;
      order.push(`sign:tip:${name}`);
      const byte = name === "club48" ? "71" : name === "blockrazor" ? "72" : "73";
      return {
        rawTransaction: `0x${byte}` as HexString,
        hash: `0x${byte.repeat(32)}` as HexString,
        data: "0x" as HexString,
        valueWei: request.builderTipWei,
        signedMonoNs: process.hrtime.bigint(),
      };
    },
  };
  internals.lanes.ed.config.signer = signer as unknown as HotSigner;

  const prewarmedMonoNs = process.hrtime.bigint() - 1_000_000n;
  internals.builders = BUILDER_CONFIGS.map((builderConfig) => ({
    config: builderConfig,
    snapshot() {
      return {
        name: builderConfig.name,
        host: new URL(builderConfig.url).host,
        lastAck: null,
        lastPrewarmMonoNs: prewarmedMonoNs.toString(),
      };
    },
    prepare(intent: SubmitIntent): PreparedBuilderSubmission {
      preparedIntents.push(intent);
      order.push(`prepare:${builderConfig.name}:${intent.target.kind}`);
      return {
        builder: builderConfig.name,
        url: builderConfig.url,
        headers: {},
        body: "{}",
        preparedMonoNs: process.hrtime.bigint(),
      };
    },
    dispatch(): Promise<BuilderAck> {
      order.push(`dispatch:${builderConfig.name}`);
      const now = process.hrtime.bigint();
      return Promise.resolve({
        builder: builderConfig.name,
        accepted: true,
        bundleId: `0x${"ef".repeat(32)}`,
        httpStatus: 200,
        startedMonoNs: now,
        responseMonoNs: now,
        latencyMs: 0,
        error: null,
      });
    },
  }));

  const signal = targetSignal("ed");
  const originalReserve = internals.ledger.reserveAttempt.bind(internals.ledger);
  let reservationRequest: RiskAttemptReservation | null = null;
  let releasePersist!: () => void;
  const persistGate = new Promise<void>((resolve) => { releasePersist = resolve; });
  internals.ledger.reserveAttempt = async (request: RiskAttemptReservation) => {
    reservationRequest = request;
    order.push("reserve:start");
    await persistGate;
    const result = await originalReserve(request);
    order.push("reserve:done");
    return result;
  };

  await internals.handleTarget(signal, timing);
  assert.deepEqual(order.filter((entry) => entry.startsWith("dispatch:")), [
    "dispatch:club48",
    "dispatch:blockrazor",
    "dispatch:jet",
  ]);
  assert.equal(order.includes("reserve:start"), true,
    `risk persistence did not start in the first post-dispatch microtask: ${order.join(", ")}`);
  const lastDispatch = Math.max(...order.map((entry, index) => entry.startsWith("dispatch:") ? index : -1));
  assert.ok(lastDispatch < order.indexOf("reserve:start"), `risk I/O blocked a Builder: ${order.join(", ")}`);
  releasePersist();
  const race = [...internals.activeRaces.values()][0] as { riskReservationPromise: Promise<void> };
  await race.riskReservationPromise;
  assert.deepEqual(reservationRequest?.candidateHashes, [`0x${"61".repeat(32)}`]);
  assert.deepEqual(reservationRequest?.tipCandidateHashes, [
    `0x${"71".repeat(32)}`,
    `0x${"72".repeat(32)}`,
    `0x${"73".repeat(32)}`,
  ]);
  const firstDispatch = order.indexOf("dispatch:club48");
  assert.ok(firstDispatch >= 0);
  assert.equal(order.filter((entry) => entry === "sign:buy").length, 1, "the common GMGN buy must be signed once");
  assert.equal(preparedIntents.length, 3);
  assert.ok(preparedIntents.every((intent) => intent.strategyTxs.length === 2));
  assert.ok(preparedIntents.every((intent) => intent.strategyTxs[0] === "0x61"));
  assert.deepEqual(preparedIntents.map((intent) => intent.strategyTxs[1]), ["0x71", "0x72", "0x73"]);
  assert.ok(preparedIntents.every((intent) => !("maxBlockNumber" in intent)),
    "the public hot path must not impose an application block deadline");
  assert.ok(preparedIntents.every((intent) => !("minTimestamp" in intent) && !("maxTimestamp" in intent)),
    "the public hot path must not impose application timestamp bounds");

  const beforeDuplicate = order.length;
  await internals.handleTarget(signal, timing);
  assert.equal(order.length, beforeDuplicate);
  assert.equal((engine.snapshot().recentEvents as Array<{ type: string }>)[0]?.type, "target_duplicate");
  await engine.stop();
});

test("a public signal fans out immediately once without a local Builder window and later heads never resubmit it", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  internals.lanes.ed.config.signer = signingDouble();
  const prepared: Array<{ builder: string; intent: SubmitIntent }> = [];
  const dispatched: string[] = [];
  internals.builders = capturingBuilderRace(prepared, dispatched);
  const originalReserve = internals.ledger.reserveAttempt.bind(internals.ledger);
  let riskWrites = 0;
  internals.ledger.reserveAttempt = async (request) => {
    riskWrites += 1;
    return originalReserve(request);
  };

  await internals.handleTarget(targetSignal("ed"), timing);
  for (const number of [114_700_001, 114_700_002, 114_700_003]) {
    internals.handleHead({
      number,
      hash: `0x${number.toString(16).padStart(64, "0")}` as HexString,
      timestamp: Math.floor(Date.now() / 1_000),
      source: "rolling-test",
      seenMonoNs: process.hrtime.bigint(),
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  const race = [...internals.activeRaces.values()][0] as {
    riskReservationPromise: Promise<void>;
    candidates: Map<string, { builders: string[] }>;
    plannedRoutes: Set<string>;
    lastSubmittedBlock: number;
  };
  await race.riskReservationPromise;

  assert.equal(dispatched.length, 3);
  assert.ok(prepared.every(({ intent }) => !("maxBlockNumber" in intent)));
  const buyRaws = new Set(prepared.map(({ intent }) => intent.strategyTxs[0]));
  assert.equal(buyRaws.size, 1, "all Builders must share the exact signed buy hash/raw");
  assert.ok(prepared.every(({ intent }) => !("minTimestamp" in intent) && !("maxTimestamp" in intent)));
  assert.equal(riskWrites, 1, "the one-shot three-Builder fanout needs one durable risk reservation");
  assert.equal(race.lastSubmittedBlock, 114_700_100,
    "internal cleanup remains conservative for the Builders' documented current+100 default");
  assert.deepEqual([...race.plannedRoutes].sort(), [
    "blockrazor:raw",
    "club48:raw",
    "jet:raw",
  ], "public route identity must not imply a head+1 envelope");
  assert.deepEqual([...race.candidates.values()][0]?.builders.sort(), [
    "blockrazor:raw",
    "club48:raw",
    "jet:raw",
  ]);
  await engine.stop();
});

test("live target fails closed before signing when the authority head timestamp is stale", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  const prepared: Array<{ builder: string; intent: SubmitIntent }> = [];
  const dispatched: string[] = [];
  internals.builders = capturingBuilderRace(prepared, dispatched);
  internals.handleHead({
    number: 114_700_100,
    hash: `0x${"cd".repeat(32)}` as HexString,
    timestamp: Math.floor(Date.now() / 1_000) - 30,
    source: "stale-authority-test",
    seenMonoNs: process.hrtime.bigint(),
  });

  const before = engine.snapshot();
  assert.ok((before.readinessReasons as string[]).includes("head_stale"));
  await internals.handleTarget(targetSignal("ed"), timing);
  assert.equal(prepared.length, 0);
  assert.equal(dispatched.length, 0);
  const queued = (engine.snapshot().recentEvents as Array<{ type: string; reason?: string }>)[0];
  assert.deepEqual({ type: queued?.type, reason: queued?.reason }, {
    type: "target_rejected",
    reason: "head_stale",
  });
  await engine.stop();
});

test("two watched-wallet signals pipeline immutable N/N+1 then N+2/N+3 without waiting for receipts", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  const prepared: Array<{ builder: string; intent: SubmitIntent }> = [];
  const dispatched: string[] = [];
  internals.builders = capturingBuilderRace(prepared, dispatched);
  internals.rpc = {
    async minedTargetTransaction() { return null; },
    async receipt() { return null; },
    async blockNumber() { return 114_700_000; },
    async latestNonce() { return 12; },
    async pendingNonce() { return 12; },
  };
  const first = targetSignal("ed");
  await internals.handleTarget(first, timing);
  assert.equal(dispatched.length, 3);
  assert.equal(internals.lanes.ed.nonce.snapshot().state, "ready");
  assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 14);

  const laterTransaction = { ...first.transaction };
  delete laterTransaction.rawTransaction;
  laterTransaction.hash = `0x${"9a".repeat(32)}` as HexString;
  laterTransaction.nonce += 1;
  const later = brandSourceVerifiedTargetSignal(validateTargetSignal({
    ...first,
    source: "confirmed_log_fallback",
    sourceSequence: "confirmed-loopback:114700000:9",
    transaction: laterTransaction,
    sourceBlockHint: 114_700_000,
  }));
  await internals.handleTarget(later, timing);
  assert.equal(dispatched.length, 6, "the second target must not wait for any receipt or nonce RPC");
  assert.equal(internals.lanes.ed.nonce.snapshot().state, "ready");
  assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 16);
  assert.equal(internals.activeRaces.size, 2);
  assert.deepEqual(
    prepared.map(({ intent }) => intent.strategyTxs.map((raw) => Transaction.from(raw).nonce)),
    [[12, 13], [12, 13], [12, 13], [14, 15], [14, 15], [14, 15]],
  );

  internals.handleHead({
    number: 114_700_001,
    hash: `0x${"9b".repeat(32)}` as HexString,
    timestamp: Math.floor(Date.now() / 1_000),
    source: "pipeline-rolling-test",
    seenMonoNs: process.hrtime.bigint(),
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(dispatched.length, 6, "a new head must not resubmit either one-shot public race");
  assert.equal(prepared.length, 6);
  assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 16, "head processing must not allocate another nonce span");
  await engine.stop();
});

test("confirmed and pending echoes cannot retrigger an already-submitted public race", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  internals.lanes.ed.config.signer = signingDouble();
  const prepared: Array<{ builder: string; intent: SubmitIntent }> = [];
  const dispatched: string[] = [];
  internals.builders = capturingBuilderRace(prepared, dispatched);
  const pending = targetSignal("ed");
  await internals.handleTarget(pending, timing);

  const confirmed = brandSourceVerifiedTargetSignal(validateTargetSignal({
    ...pending,
    source: "confirmed_log_fallback",
    sourceSequence: "confirmed-loopback:114700000:1",
    sourceBlockHint: 114_700_000,
  }));
  await internals.handleTarget(confirmed, timing);
  assert.equal(dispatched.length, 3);
  assert.ok(prepared.every(({ intent }) => intent.target.kind === "rawTx"));
  assert.ok(prepared.every(({ intent }) => intent.strategyTxs.length === 2));
  const race = [...internals.activeRaces.values()][0] as { latestSignal: TargetSignal; orderingMode: string };
  assert.equal(race.latestSignal.source, "bsc_pending_full");
  assert.equal(race.orderingMode, "same_block_after");

  await internals.handleTarget(pending, timing);
  assert.equal(dispatched.length, 3);
  assert.equal(race.latestSignal.source, "bsc_pending_full");
  await engine.stop();
});

test("private span-1 remains immutable while a same-hash confirmed span-2 waits for finality", async () => {
  const privateConfig = config("live");
  privateConfig.blockRazorPrivateMempool = {
    enabled: true,
    token: "private-token-regression",
    regions: ["tokyo"],
    connectTimeoutMs: 1_000,
    idleTimeoutMs: 60_000,
    submitTimeoutMs: 250,
    prewarmIntervalMs: 15_000,
  };
  const engine = new CopyExecutionEngine(privateConfig);
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  let privateDispatches = 0;
  const privatePrepared: SubmitIntent[] = [];
  const privateBuilder = {
    config: BUILDER_CONFIGS[1]!,
    snapshot: () => ({ lastPrewarmMonoNs: process.hrtime.bigint().toString() }),
    prepare(intent: SubmitIntent): PreparedBuilderSubmission {
      privatePrepared.push(intent);
      return {
        builder: "blockrazor",
        url: BUILDER_CONFIGS[1]!.url,
        headers: {},
        body: "{}",
        preparedMonoNs: process.hrtime.bigint(),
      };
    },
    async dispatch(): Promise<BuilderAck> {
      privateDispatches += 1;
      const now = process.hrtime.bigint();
      return {
        builder: "blockrazor",
        accepted: true,
        bundleId: `0x${"ef".repeat(32)}`,
        httpStatus: 200,
        startedMonoNs: now,
        responseMonoNs: now,
        latencyMs: 0,
        error: null,
      };
    },
  };
  internals.privateBuilders = new Map([["tokyo", privateBuilder]]);
  const publicPrepared: Array<{ builder: string; intent: SubmitIntent }> = [];
  const publicDispatches: string[] = [];
  internals.builders = capturingBuilderRace(publicPrepared, publicDispatches);
  let rpcBlock = 114_700_000;
  internals.rpc = {
    async minedTargetTransaction() { return null; },
    async receipt() { return null; },
    async blockNumber() { return rpcBlock; },
    async latestNonce() { return 12; },
    async pendingNonce() { return 12; },
  };

  const privateSignal = brandSourceVerifiedTargetSignal(validateTargetSignal(privateTargetSignal()));
  await internals.handleTarget(privateSignal, timing);
  assert.equal(privateDispatches, 1);
  assert.equal(internals.lanes.ed.nonce.snapshot().state, "ready");
  assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 13);
  const publicSignal = targetSignal("ed");
  const confirmed = brandSourceVerifiedTargetSignal(validateTargetSignal({
    ...publicSignal,
    source: "confirmed_log_fallback",
    sourceSequence: "confirmed-loopback:114700000:private-upgrade",
    sourceBlockHint: 114_700_000,
  }));
  await internals.handleTarget(confirmed, timing);
  assert.equal(publicDispatches.length, 0, "span-1 must never be mutated into span-2 in place");
  assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 13);

  for (const number of [114_700_001, 114_700_002, 114_700_003]) {
    rpcBlock = number;
    internals.handleHead({
      number,
      hash: `0x${number.toString(16).padStart(64, "0")}` as HexString,
      timestamp: Math.floor(Date.now() / 1_000),
      source: "private-upgrade-test",
      seenMonoNs: process.hrtime.bigint(),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  await eventually(
    () => publicDispatches.length >= 3,
    "deferred confirmed upgrade dispatch",
  );
  assert.equal(privatePrepared.length, 1, "confirmed priority stops private rolling immediately");
  assert.equal(publicDispatches.length, 3);
  assert.ok(publicPrepared.every(({ intent }) => intent.target.kind === "confirmedNextBlock"));
  assert.ok(publicPrepared.every(({ intent }) => intent.strategyTxs.length === 2),
    "the deferred public form must always remain a complete buy+tip pair");
  assert.equal(internals.lanes.ed.nonce.snapshot().state, "ready");
  assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 15);
  await engine.stop();
});

test("a higher source nonce does not discard a deferred lower-nonce confirmed upgrade before reconciliation", async () => {
  const privateConfig = config("live");
  privateConfig.blockRazorPrivateMempool = {
    enabled: true,
    token: "private-token-regression",
    regions: ["tokyo"],
    connectTimeoutMs: 1_000,
    idleTimeoutMs: 60_000,
    submitTimeoutMs: 250,
    prewarmIntervalMs: 15_000,
  };
  const engine = new CopyExecutionEngine(privateConfig);
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  const privateBuilder = {
    config: BUILDER_CONFIGS[1]!,
    snapshot: () => ({ lastPrewarmMonoNs: process.hrtime.bigint().toString() }),
    prepare: (): PreparedBuilderSubmission => ({
      builder: "blockrazor",
      url: BUILDER_CONFIGS[1]!.url,
      headers: {},
      body: "{}",
      preparedMonoNs: process.hrtime.bigint(),
    }),
    async dispatch(): Promise<BuilderAck> {
      const now = process.hrtime.bigint();
      return { builder: "blockrazor", accepted: true, bundleId: null, httpStatus: 200,
        startedMonoNs: now, responseMonoNs: now, latencyMs: 0, error: null };
    },
  };
  internals.privateBuilders = new Map([["tokyo", privateBuilder]]);
  const publicPrepared: Array<{ builder: string; intent: SubmitIntent }> = [];
  const publicDispatches: string[] = [];
  internals.builders = capturingBuilderRace(publicPrepared, publicDispatches);
  let rpcBlock = 114_700_000;
  internals.rpc = {
    async minedTargetTransaction() { return null; },
    async receipt() { return null; },
    async blockNumber() { return rpcBlock; },
    async latestNonce() { return 12; },
    async pendingNonce() { return 12; },
  };
  await internals.handleTarget(
    brandSourceVerifiedTargetSignal(validateTargetSignal(privateTargetSignal())),
    timing,
  );
  const ordinary = targetSignal("ed");
  await internals.handleTarget(brandSourceVerifiedTargetSignal(validateTargetSignal({
    ...ordinary,
    source: "confirmed_log_fallback",
    sourceSequence: "confirmed-loopback:114700000:deferred-old",
    sourceBlockHint: 114_700_000,
  })), timing);
  const laterTransaction = { ...(ordinary.transaction as ReturnType<typeof pendingObjectToWire>) };
  delete laterTransaction.rawTransaction;
  laterTransaction.hash = `0x${"bc".repeat(32)}`;
  laterTransaction.nonce += 1;
  const dominant = brandSourceVerifiedTargetSignal(validateTargetSignal({
    ...ordinary,
    source: "confirmed_log_fallback",
    sourceSequence: "confirmed-loopback:114700000:dominant",
    transaction: laterTransaction,
    sourceBlockHint: 114_700_000,
  }));
  await internals.handleTarget(dominant, timing);

  const privateRace = internals.activeRaces.get(`ed:${ordinary.transaction.hash.toLowerCase()}`) as {
    deferredConfirmedUpgrade?: { signal: TargetSignal };
  } | undefined;
  assert.equal(
    privateRace?.deferredConfirmedUpgrade?.signal.transaction.hash.toLowerCase(),
    ordinary.transaction.hash.toLowerCase(),
  );
  const dominantPrepared = publicPrepared.filter(({ intent }) => intent.target.kind === "confirmedNextBlock"
    && intent.target.targetHash.toLowerCase() === dominant.transaction.hash.toLowerCase());
  const deferredPrepared = publicPrepared.filter(({ intent }) => intent.target.kind === "confirmedNextBlock"
    && intent.target.targetHash.toLowerCase() === ordinary.transaction.hash.toLowerCase());
  assert.equal(publicDispatches.length, publicPrepared.length);
  assert.equal(dominantPrepared.length, 3, "the higher source nonce gets exactly one three-Builder fanout");
  assert.equal(deferredPrepared.length, 0, "the lower source nonce remains deferred rather than being duplicated");
  assert.ok(publicPrepared.every(({ intent }) => intent.strategyTxs.length === 2));
  await engine.stop();
});

test("disable clears queued work and permanently stops rolling the old target after re-arm", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  internals.lanes.ed.config.signer = signingDouble();
  const prepared: Array<{ builder: string; intent: SubmitIntent }> = [];
  const dispatched: string[] = [];
  internals.builders = capturingBuilderRace(prepared, dispatched);
  await internals.handleTarget(targetSignal("ed"), timing);
  assert.equal(dispatched.length, 3);

  await engine.disableLive();
  internals.broadcastClosed = false;
  internals.armGate.armedState = true;
  for (const number of [114_700_001, 114_700_002]) {
    internals.handleHead({
      number,
      hash: `0x${number.toString(16).padStart(64, "0")}` as HexString,
      timestamp: Math.floor(Date.now() / 1_000),
      source: "disable-test",
      seenMonoNs: process.hrtime.bigint(),
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(dispatched.length, 3, "re-arm must not resurrect a pre-disable target");
  await engine.stop();
});

test("machine notification hook runs only after real Builder dispatch and stop drains it", async () => {
  const liveNotices: string[] = [];
  let liveStops = 0;
  const liveNotifier = {
    afterBuilderDispatchStarted(strategy: TargetStrategy, targetHash: string) {
      liveNotices.push(`${strategy}:${targetHash.toLowerCase()}`);
    },
    async stop() { liveStops += 1; },
  } as unknown as DetachedMachineDispatchNotifier;
  const live = new CopyExecutionEngine(config("live"), liveNotifier);
  const ready = readyEngine(live, "ed");
  ready.internals.armGate.armedState = true;
  ready.internals.lanes.ed.config.signer = signingDouble();
  ready.internals.builders = capturingBuilderRace([], []);
  await ready.internals.handleTarget(targetSignal("ed"), ready.timing);
  ready.internals.handleHead({
    number: 114_700_001,
    hash: `0x${"c1".repeat(32)}`,
    timestamp: Math.floor(Date.now() / 1_000),
    source: "notifier-rolling-test",
    seenMonoNs: process.hrtime.bigint(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(liveNotices.length, 3, "only the three initial one-shot Builder writes cross the hook");
  await live.stop();
  assert.equal(liveStops, 1);

  for (const mode of ["shadow", "live"] as const) {
    const notices: string[] = [];
    const notifier = {
      afterBuilderDispatchStarted(strategy: TargetStrategy, targetHash: string) {
        notices.push(`${strategy}:${targetHash}`);
      },
      async stop() { /* test double */ },
    } as unknown as DetachedMachineDispatchNotifier;
    const engine = new CopyExecutionEngine(config(mode), notifier);
    const fixture = readyEngine(engine, "ed");
    fixture.internals.lanes.ed.config.signer = signingDouble();
    fixture.internals.builders = capturingBuilderRace([], []);
    // Shadow prepares but never calls dispatch; live remains deliberately unarmed.
    await fixture.internals.handleTarget(targetSignal("ed"), fixture.timing);
    assert.equal(notices.length, 0, `${mode} must not notify without a real Builder write`);
    await engine.stop();
  }
});

test("verified external copy-wallet pending queues targets until latest catches pending", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  internals.lanes.ed.config.signer = signingDouble();
  const prepared: Array<{ builder: string; intent: SubmitIntent }> = [];
  const dispatched: string[] = [];
  internals.builders = capturingBuilderRace(prepared, dispatched);
  let latest = 12;
  let pending = 13;
  internals.rpc = {
    async minedTargetTransaction() { return null; },
    async receipt() { return null; },
    async blockNumber() { return 114_700_002; },
    async latestNonce() { return latest; },
    async pendingNonce() { return pending; },
  };
  const external: TargetTransactionWire = {
    hash: `0x${"b1".repeat(32)}`,
    chainId: 56,
    type: 0,
    from: internals.lanes.ed.config.signer!.address,
    to: "0x000000000000000000000000000000000000bEEF",
    nonce: 12,
    gasPriceWei: "1",
    gasLimit: "21000",
    valueWei: "1",
    input: "0x",
  };
  internals.handleCopyWalletPending(external);
  await internals.handleTarget(targetSignal("ed"), timing);
  assert.equal(dispatched.length, 0);
  assert.equal(internals.lanes.ed.nonce.snapshot().state, "external_pending");

  internals.handleHead({
    number: 114_700_001,
    hash: `0x${"b2".repeat(32)}`,
    timestamp: Math.floor(Date.now() / 1_000),
    source: "external-pending-test",
    seenMonoNs: process.hrtime.bigint(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatched.length, 0);

  latest = 13;
  pending = 13;
  internals.handleHead({
    number: 114_700_002,
    hash: `0x${"b3".repeat(32)}`,
    timestamp: Math.floor(Date.now() / 1_000),
    source: "external-confirmed-test",
    seenMonoNs: process.hrtime.bigint(),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dispatched.length, 3);
  assert.equal(internals.lanes.ed.nonce.snapshot().state, "ready");
  assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 15);
  await engine.stop();
});

test("copy-wallet pending observer ignores active and delayed own echoes but blocks a genuine different hash", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  internals.lanes.ed.config.signer = signingDouble();
  const prepared: Array<{ builder: string; intent: SubmitIntent }> = [];
  const dispatched: string[] = [];
  internals.builders = capturingBuilderRace(prepared, dispatched);
  const target = targetSignal("ed");
  await internals.handleTarget(target, timing);
  const ownEcho: TargetTransactionWire = {
    hash: `0x${"61".repeat(32)}`,
    chainId: 56,
    type: 0,
    from: internals.lanes.ed.config.signer!.address,
    to: target.transaction.to,
    nonce: 12,
    gasPriceWei: "1",
    gasLimit: "500000",
    valueWei: "1",
    input: "0x",
  };
  internals.handleCopyWalletPending(ownEcho);
  assert.equal(internals.lanes.ed.nonce.snapshot().externalPending, null);

  internals.activeRaces.clear();
  internals.handleCopyWalletPending(ownEcho);
  assert.equal(internals.lanes.ed.nonce.snapshot().state, "ready", "late own echo must remain ignored");

  internals.handleCopyWalletPending({
    ...ownEcho,
    hash: `0x${"b4".repeat(32)}`,
    nonce: 14,
  });
  assert.equal(internals.lanes.ed.nonce.snapshot().state, "external_pending");
  assert.equal(internals.lanes.ed.nonce.snapshot().externalPending?.hash, `0x${"b4".repeat(32)}`);
  await engine.stop();
});

test("large runtime value still plans when the risk ledger already has prior spend and trades", async () => {
  const unlimitedConfig = config("shadow");
  unlimitedConfig.lanes.ed.followAmountWei = 2_000_000_000_000_000_000n;
  const engine = new CopyExecutionEngine(unlimitedConfig);
  const { internals, timing } = readyEngine(engine, "ed");
  const signer = unlimitedConfig.lanes.ed.signer!;
  await internals.ledger.reserveAttempt({
    chainId: 56,
    signer: signer.address,
    nonce: 1,
    strategy: "ed",
    targetHash: `0x${"41".repeat(32)}`,
    candidateHashes: [`0x${"42".repeat(32)}`],
    maxBlock: 114_699_999,
    worstCostWei: 5_000_000_000_000_000_000n,
  });
  assert.equal(internals.ledger.spent("ed"), 5_000_000_000_000_000_000n);
  assert.equal(internals.ledger.trades("ed"), 1);

  const prepared: SubmitIntent[] = [];
  internals.builders = BUILDER_CONFIGS.map((builderConfig) => ({
    config: builderConfig,
    snapshot: () => ({ lastPrewarmMonoNs: process.hrtime.bigint().toString() }),
    prepare(intent: SubmitIntent) {
      prepared.push(intent);
      return {
        builder: builderConfig.name,
        url: builderConfig.url,
        headers: {},
        body: "{}",
        preparedMonoNs: process.hrtime.bigint(),
      };
    },
  }));

  await internals.handleTarget(targetSignal("ed"), timing);
  assert.equal(prepared.length, 3, "prior cumulative ledger values must not cap a new plan");
  assert.equal(internals.ledger.spent("ed"), 5_000_000_000_000_000_000n,
    "shadow planning must not mutate durable risk accounting");
  assert.equal(internals.ledger.trades("ed"), 1);
  assert.ok((engine.snapshot().recentEvents as Array<{ type: string }>).some((event) => event.type === "target_planned"));
  await engine.stop();
});

test("process-branded confirmed Router buy races buy plus separate tip for source block N+1", async () => {
  const engine = new CopyExecutionEngine(config("shadow"));
  const { internals, timing } = readyEngine(engine, "ed");
  const prepared: SubmitIntent[] = [];
  internals.builders = BUILDER_CONFIGS.map((builderConfig) => ({
    config: builderConfig,
    snapshot: () => ({ lastPrewarmMonoNs: process.hrtime.bigint().toString() }),
    prepare(intent: SubmitIntent) {
      prepared.push(intent);
      return {
        builder: builderConfig.name,
        url: builderConfig.url,
        headers: {},
        body: "{}",
        preparedMonoNs: process.hrtime.bigint(),
      };
    },
  }));
  const ordinary = targetSignal("ed");
  const transaction = { ...ordinary.transaction } as typeof ordinary.transaction & { rawTransaction?: HexString };
  delete transaction.rawTransaction;
  const signal = brandSourceVerifiedTargetSignal(validateTargetSignal({
    ...ordinary,
    source: "confirmed_log_fallback",
    sourceSequence: "confirmed-loopback:114700000:2:" + transaction.hash,
    transaction,
    sourceBlockHint: 114_700_000,
  }));

  await internals.handleTarget(signal, timing);
  assert.equal(prepared.length, 3);
  assert.ok(prepared.every((intent) => intent.target.kind === "confirmedNextBlock"));
  assert.ok(prepared.every((intent) => !("maxBlockNumber" in intent)));
  assert.ok(prepared.every((intent) => !("minTimestamp" in intent) && !("maxTimestamp" in intent)));
  assert.ok(prepared.every((intent) => intent.strategyTxs.length === 2));
  const ready = (engine.snapshot().recentEvents as Array<Record<string, unknown>>)
    .filter((event) => event.type === "builder_candidate_ready");
  assert.equal(ready.length, 3);
  assert.ok(ready.every((event) => event.variant === "next-block"));
  await engine.stop();
});

test("plain JSON cannot forge the confirmed-log N+1 source", async () => {
  const engine = new CopyExecutionEngine(config("shadow"));
  const { internals, timing } = readyEngine(engine, "ed");
  const ordinary = targetSignal("ed");
  const transaction = { ...ordinary.transaction } as typeof ordinary.transaction & { rawTransaction?: HexString };
  delete transaction.rawTransaction;
  await internals.handleTarget({
    ...ordinary,
    source: "confirmed_log_fallback",
    transaction,
    sourceBlockHint: 114_700_000,
  }, timing);
  const latest = (engine.snapshot().recentEvents as Array<Record<string, unknown>>)[0];
  assert.equal(latest?.type, "target_rejected");
  assert.equal(latest?.reason, "confirmed_log_source_not_process_verified");
  await engine.stop();
});

test("confirmed hint hydrates only its matching Ed lane and claims duplicate hash synchronously", async () => {
  const engine = new CopyExecutionEngine(config("shadow"));
  const { internals } = readyEngine(engine, "ed");
  const wire = pendingObjectToWire(rpcFixture("ed"));
  const transaction = { ...wire };
  delete transaction.rawTransaction;
  let hydrationCalls = 0;
  internals.rpc = {
    async minedTargetTransaction(hash: string) {
      hydrationCalls += 1;
      assert.equal(hash.toLowerCase(), transaction.hash.toLowerCase());
      return {
        transaction,
        blockNumber: 114_700_000,
        blockHash: `0x${"ab".repeat(32)}`,
      };
    },
    async latestNonce() { return 12; },
    async pendingNonce() { return 12; },
    async receipt() { return null; },
    async blockNumber() { return 114_700_000; },
  };
  const hint = {
    version: 1 as const,
    strategy: "ed" as const,
    txHash: transaction.hash,
    payer: transaction.from,
    blockNumber: 114_700_000,
    blockHash: `0x${"ab".repeat(32)}` as HexString,
    logIndex: 2,
    observedUnixNs: (BigInt(Date.now()) * 1_000_000n).toString(),
  };
  assert.equal(engine.acceptConfirmedTargetHint(hint), true);
  assert.equal(engine.acceptConfirmedTargetHint(hint), false);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hydrationCalls, 1);
  const planned = (engine.snapshot().recentEvents as Array<Record<string, unknown>>)
    .find((event) => event.type === "target_planned");
  assert.equal(planned?.strategy, "ed");
  assert.equal(planned?.source, "confirmed_log_fallback");
  assert.equal(planned?.validUntilBlock, 114_700_100);
  await engine.stop();
});

test("confirmed reconciliation accepts any later block without a hidden one-block window", () => {
  const engine = new CopyExecutionEngine(config("shadow"));
  const internals = engine as unknown as EngineInternals;
  const target: RpcReceipt = {
    transactionHash: `0x${"31".repeat(32)}` as HexString,
    blockHash: `0x${"32".repeat(32)}` as HexString,
    blockNumber: 100,
    transactionIndex: 7,
    status: 1,
    gasUsed: 21_000n,
    effectiveGasPrice: 1n,
  };
  const copy = (blockNumber: number): RpcReceipt => ({
    ...target,
    transactionHash: `0x${"33".repeat(32)}` as HexString,
    blockHash: `0x${"34".repeat(32)}` as HexString,
    blockNumber,
    transactionIndex: 0,
  });
  assert.equal(internals.orderingAccepted(copy(101), target, "any_block_after"), true);
  assert.equal(internals.orderingAccepted(copy(100), target, "any_block_after"), false);
  assert.equal(internals.orderingAccepted(copy(102), target, "any_block_after"), true);
});

test("plain-object BlockRazor Private disclosures fail closed before signing", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  let signed = 0;
  let prepared = 0;
  internals.lanes.ed.config.signer = {
    address: "0x0000000000000000000000000000000000009001",
    signAtomicCopy() {
      signed += 1;
      throw new Error("private disclosure must not be signed");
    },
  } as unknown as HotSigner;
  internals.builders = [{
    config: BUILDER_CONFIGS[1]!,
    prepare() {
      prepared += 1;
      throw new Error("private disclosure must not reach Builder preparation");
    },
    snapshot() { return { lastPrewarmMonoNs: process.hrtime.bigint().toString() }; },
  }];

  await internals.handleTarget(privateTargetSignal(), timing);
  assert.equal(signed, 0);
  assert.equal(prepared, 0);
  const latest = (engine.snapshot().recentEvents as Array<Record<string, unknown>>)[0];
  assert.equal(latest?.type, "target_rejected");
  assert.equal(latest?.reason, "blockrazor_private_source_not_process_verified");
  await engine.stop();
});

test("source-branded Private target signs proxyBid and dispatches only to the matching regional endpoint", async () => {
  const privateConfig = config("live");
  privateConfig.blockRazorPrivateMempool = {
    enabled: true,
    token: "private-token-regression",
    regions: ["tokyo"],
    connectTimeoutMs: 1_000,
    idleTimeoutMs: 60_000,
    submitTimeoutMs: 250,
  };
  const engine = new CopyExecutionEngine(privateConfig);
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  internals.feedMetrics.set("blockrazor-private-tokyo", {
    connected: true,
    connectionState: "streaming",
  });
  const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  const configuredPrivateBuilder = internals.privateBuilders.get("tokyo") as unknown as BuilderClient | undefined;
  assert.ok(configuredPrivateBuilder);
  const privateBuilder = new BuilderClient(configuredPrivateBuilder.config, () => ({
    async request(value) {
      const headers = new Headers(value.headers);
      const body = JSON.parse(value.body) as Record<string, unknown>;
      requests.push({
        url: value.url.origin,
        authorization: headers.get("authorization"),
        body,
      });
      return {
        status: 200,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: body.method === "eth_chainId" ? "0x38" : `0x${"ef".repeat(32)}`,
        }),
      };
    },
    close() {},
  }));
  await privateBuilder.prewarm();
  requests.length = 0;
  (internals.privateBuilders as unknown as Map<string, BuilderClient>).set("tokyo", privateBuilder);
  try {
    const signal = brandSourceVerifiedTargetSignal(validateTargetSignal(privateTargetSignal()));
    await internals.handleTarget(signal, timing);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1, "Private hash must never fan out to public Builders");
    assert.equal(requests[0]?.url, "https://jp-bscscutum.blockrazor.xyz");
    assert.equal(requests[0]?.authorization, "Bearer private-token-regression");
    assert.doesNotMatch(requests[0]?.url ?? "", /private-token-regression/);
    const body = requests[0]?.body ?? {};
    assert.equal(body.method, "eth_sendMevBundle");
    const params = (body.params as Array<Record<string, unknown>>)[0]!;
    assert.equal(params.hash, signal.blockRazorPrivateBundle?.bundleHash);
    assert.equal(params.maxBlockNumber, 114_700_001);
    assert.equal((params.txs as string[]).length, 1);
    const ready = (engine.snapshot().recentEvents as Array<Record<string, unknown>>)
      .find((event) => event.type === "builder_candidate_ready");
    assert.equal(ready?.variant, "private:tokyo");
  } finally {
    await privateBuilder.close();
    await engine.stop();
  }
});

test("the same reported hash can independently trigger Ed and kuzuo follower wallets", async () => {
  const liveConfig = config("live");
  liveConfig.blockRazorPrivateMempool = {
    enabled: true,
    token: "private-token-regression",
    regions: ["tokyo"],
    connectTimeoutMs: 1_000,
    idleTimeoutMs: 60_000,
    submitTimeoutMs: 250,
  };
  const engine = new CopyExecutionEngine(liveConfig);
  const { internals, timing } = readyEngine(engine, "ed");
  internals.lanes.kuzuo.nonce.synchronize(12);
  internals.armGate.armedState = true;
  internals.feedMetrics.set("blockrazor-private-tokyo", {
    connected: true,
    connectionState: "streaming",
  });

  const prewarmedAt = (process.hrtime.bigint() - 1_000_000n).toString();
  let publicDispatches = 0;
  let privateDispatches = 0;
  const publicConfig = BUILDER_CONFIGS[0]!;
  internals.builders = [{
    config: publicConfig,
    snapshot: () => ({ lastPrewarmMonoNs: prewarmedAt }),
    prepare: (): PreparedBuilderSubmission => ({
      builder: publicConfig.name,
      url: publicConfig.url,
      headers: {},
      body: "{}",
      preparedMonoNs: process.hrtime.bigint(),
    }),
    dispatch: async (): Promise<BuilderAck> => {
      publicDispatches += 1;
      const now = process.hrtime.bigint();
      return {
        builder: publicConfig.name,
        accepted: true,
        bundleId: `0x${"ef".repeat(32)}`,
        httpStatus: 200,
        startedMonoNs: now,
        responseMonoNs: now,
        latencyMs: 0,
        error: null,
      };
    },
  }];
  const privateConfig = {
    name: "blockrazor" as const,
    url: "https://jp-bscscutum.blockrazor.xyz",
    tipRecipient: "0x0000000000000000000000000000000000000000",
    requestTimeoutMs: 250,
  };
  const privateBuilder = {
    config: privateConfig,
    snapshot: () => ({ lastPrewarmMonoNs: prewarmedAt }),
    prepare: (): PreparedBuilderSubmission => ({
      builder: "blockrazor",
      url: privateConfig.url,
      headers: {},
      body: "{}",
      preparedMonoNs: process.hrtime.bigint(),
    }),
    dispatch: async (): Promise<BuilderAck> => {
      privateDispatches += 1;
      const now = process.hrtime.bigint();
      return {
        builder: "blockrazor",
        accepted: true,
        bundleId: `0x${"ee".repeat(32)}`,
        httpStatus: 200,
        startedMonoNs: now,
        responseMonoNs: now,
        latencyMs: 0,
        error: null,
      };
    },
  };
  (internals.privateBuilders as unknown as Map<string, unknown>).set("tokyo", privateBuilder);

  try {
    const first = targetSignal("ed");
    await internals.handleTarget(first, timing);
    const targetHash = first.transaction.hash.toLowerCase();
    const raceBefore = internals.activeRaces.get(`ed:${targetHash}`) as ({ riskReservationPromise: Promise<void> } & Record<string, unknown>) | undefined;
    assert.ok(raceBefore);
    await raceBefore.riskReservationPromise;
    const attemptsBefore = Object.values(internals.ledger.snapshot().attempts);
    assert.equal(publicDispatches, 1);
    assert.equal(internals.lanes.ed.nonce.snapshot().state, "ready");
    assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 14);
    assert.equal(attemptsBefore.length, 1);
    assert.equal(attemptsBefore[0]?.strategy, "ed");
    assert.equal(attemptsBefore[0]?.state, "reserved");

    const conflicting = privateTargetSignal("kuzuo");
    conflicting.transaction.hash = first.transaction.hash;
    const brandedConflict = brandSourceVerifiedTargetSignal(validateTargetSignal(conflicting));
    await internals.handleTarget(brandedConflict, {
      socketSeenMonoNs: process.hrtime.bigint(),
      parsedMonoNs: process.hrtime.bigint(),
      matchedMonoNs: process.hrtime.bigint(),
    });

    const attemptsAfter = Object.values(internals.ledger.snapshot().attempts);
    const kuzuoRace = internals.activeRaces.get(`kuzuo:${targetHash}`) as { riskReservationPromise: Promise<void> } & Record<string, unknown>;
    assert.ok(kuzuoRace, "the second wallet needs its own race even when a source reports the same hash");
    await kuzuoRace.riskReservationPromise;
    const kuzuoAttempts = Object.values(internals.lanes.kuzuo.ledger.snapshot().attempts);
    assert.equal(privateDispatches, 1, "the second monitored wallet must independently reach its Builder");
    assert.strictEqual(internals.activeRaces.get(`ed:${targetHash}`), raceBefore, "the first submitted race must remain tracked");
    assert.equal(internals.lanes.ed.nonce.snapshot().state, "ready");
    assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 14);
    assert.equal(internals.lanes.kuzuo.nonce.snapshot().state, "ready");
    assert.equal(internals.lanes.kuzuo.nonce.snapshot().nextNonce, 13);
    assert.equal(attemptsAfter.length, 1, "Ed keeps its own risk attempt");
    assert.equal(attemptsAfter[0]?.strategy, "ed");
    assert.equal(attemptsAfter[0]?.state, "reserved");
    assert.equal(kuzuoAttempts.length, 1, "kuzuo gets a separate risk attempt");
    assert.equal(kuzuoAttempts[0]?.strategy, "kuzuo");
    assert.equal(kuzuoAttempts[0]?.state, "reserved");
    assert.equal(engine.snapshot().circuitBroken, false);
    assert.equal((engine.snapshot().recentEvents as Array<Record<string, unknown>>)
      .some((event) => event.type === "target_rejected" && event.reason === "target_identity_conflict"), false);
  } finally {
    await engine.stop();
  }
});

test("the same token under different Ed and kuzuo target hashes plans once on each isolated lane", async () => {
  const liveConfig = config("live");
  liveConfig.blockRazorPrivateMempool = {
    enabled: true,
    token: "private-token-regression",
    regions: ["tokyo"],
    connectTimeoutMs: 1_000,
    idleTimeoutMs: 60_000,
    submitTimeoutMs: 250,
  };
  const engine = new CopyExecutionEngine(liveConfig);
  const { internals, timing } = readyEngine(engine, "ed");
  internals.lanes.kuzuo.nonce.synchronize(37);
  internals.armGate.armedState = true;
  internals.feedMetrics.set("blockrazor-private-tokyo", {
    connected: true,
    connectionState: "streaming",
  });

  const prewarmedAt = (process.hrtime.bigint() - 1_000_000n).toString();
  let dispatches = 0;
  const privateConfig = {
    name: "blockrazor" as const,
    url: "https://jp-bscscutum.blockrazor.xyz",
    tipRecipient: "0x0000000000000000000000000000000000000000",
    requestTimeoutMs: 250,
  };
  (internals.privateBuilders as unknown as Map<string, unknown>).set("tokyo", {
    config: privateConfig,
    snapshot: () => ({ lastPrewarmMonoNs: prewarmedAt }),
    prepare: (): PreparedBuilderSubmission => ({
      builder: "blockrazor",
      url: privateConfig.url,
      headers: {},
      body: "{}",
      preparedMonoNs: process.hrtime.bigint(),
    }),
    dispatch: async (): Promise<BuilderAck> => {
      dispatches += 1;
      const now = process.hrtime.bigint();
      return {
        builder: "blockrazor",
        accepted: true,
        bundleId: `0x${"ed".repeat(32)}`,
        httpStatus: 200,
        startedMonoNs: now,
        responseMonoNs: now,
        latencyMs: 0,
        error: null,
      };
    },
  });

  const sharedToken = "b02a6508fbfb98fce8f10ca33976017409ce7777";
  const kuzuoSharedTokenInput = KUZUO_INPUT.replaceAll(
    "99391685c25fce9f6bf10979bebb0e1132057777",
    sharedToken,
  ) as HexString;
  const edSignal = brandSourceVerifiedTargetSignal(validateTargetSignal(privateTargetSignal("ed")));
  const kuzuoSignal = brandSourceVerifiedTargetSignal(
    validateTargetSignal(privateTargetSignal("kuzuo", kuzuoSharedTokenInput)),
  );
  assert.notEqual(edSignal.transaction.hash, kuzuoSignal.transaction.hash);

  let activeReservations = 0;
  let maxActiveReservations = 0;
  let reservationArrivals = 0;
  let bothReservationsReached!: () => void;
  const bothReservations = new Promise<void>((resolve) => { bothReservationsReached = resolve; });
  let releaseReservations!: () => void;
  const reservationGate = new Promise<void>((resolve) => { releaseReservations = resolve; });
  for (const strategy of ["ed", "kuzuo"] as const) {
    const laneLedger = internals.lanes[strategy].ledger;
    const originalReserve = laneLedger.reserveAttempt.bind(laneLedger);
    laneLedger.reserveAttempt = async (request: RiskAttemptReservation) => {
      activeReservations += 1;
      maxActiveReservations = Math.max(maxActiveReservations, activeReservations);
      reservationArrivals += 1;
      if (reservationArrivals === 2) bothReservationsReached();
      await reservationGate;
      try {
        return await originalReserve(request);
      } finally {
        activeReservations -= 1;
      }
    };
  }

  try {
    const handling = Promise.all([
      internals.handleTarget(edSignal, timing),
      internals.handleTarget(kuzuoSignal, {
        socketSeenMonoNs: process.hrtime.bigint(),
        parsedMonoNs: process.hrtime.bigint(),
        matchedMonoNs: process.hrtime.bigint(),
      }),
    ]);
    await bothReservations;
    assert.equal(maxActiveReservations, 2, "both lane reservations must enter concurrently");
    releaseReservations();
    await handling;

    const attempts = [
      ...Object.values(internals.lanes.ed.ledger.snapshot().attempts),
      ...Object.values(internals.lanes.kuzuo.ledger.snapshot().attempts),
    ];
    const planned = (engine.snapshot().recentEvents as Array<Record<string, unknown>>)
      .filter((event) => event.type === "target_planned");
    assert.equal(dispatches, 2, "token equality must not dedupe two different target transactions");
    assert.equal(internals.activeRaces.size, 2);
    assert.equal(internals.lanes.ed.nonce.snapshot().state, "ready");
    assert.equal(internals.lanes.ed.nonce.snapshot().nextNonce, 13);
    assert.equal(internals.lanes.kuzuo.nonce.snapshot().state, "ready");
    assert.equal(internals.lanes.kuzuo.nonce.snapshot().nextNonce, 38);
    assert.deepEqual(attempts.map((attempt) => attempt.strategy).sort(), ["ed", "kuzuo"]);
    assert.equal(new Set(planned.map((event) => event.tokenOut)).size, 1, "both lanes must resolve the same token");
    assert.equal(String(planned[0]?.tokenOut).toLowerCase(), `0x${sharedToken}`);
  } finally {
    releaseReservations();
    await engine.stop();
  }
});

test("Private planning does not impose adjacency but still honors the disclosed Builder window", async () => {
  const privateConfig = config("shadow");
  privateConfig.blockRazorPrivateMempool = {
    enabled: true,
    token: "private-token-regression",
    regions: ["tokyo"],
    connectTimeoutMs: 1_000,
    idleTimeoutMs: 60_000,
    submitTimeoutMs: 250,
  };
  const tailEngine = new CopyExecutionEngine(privateConfig);
  const first = readyEngine(tailEngine, "ed");
  const nonTail = privateTargetSignal();
  nonTail.blockRazorPrivateBundle = { ...nonTail.blockRazorPrivateBundle!, transactionCount: 2 };
  await first.internals.handleTarget(brandSourceVerifiedTargetSignal(validateTargetSignal(nonTail)), first.timing);
  assert.equal(
    (tailEngine.snapshot().recentEvents as Array<Record<string, unknown>>)
      .some((event) => event.type === "target_planned"),
    true,
  );
  await tailEngine.stop();

  const windowEngine = new CopyExecutionEngine(privateConfig);
  const second = readyEngine(windowEngine, "ed");
  const future = privateTargetSignal();
  future.blockRazorPrivateBundle = {
    ...future.blockRazorPrivateBundle!,
    nextBlockNumber: 114_700_002,
    maxBlockNumber: 114_700_002,
  };
  await second.internals.handleTarget(brandSourceVerifiedTargetSignal(validateTargetSignal(future)), second.timing);
  assert.equal(
    (windowEngine.snapshot().recentEvents as Array<Record<string, unknown>>)[0]?.reason,
    "blockrazor_private_head_outside_bundle_window",
  );
  await windowEngine.stop();
});

test("shadow never broadcasts and a later 48 auction can enrich kuzuo pending-without-predecessor", async () => {
  const engine = new CopyExecutionEngine(config("shadow"));
  const { internals, timing } = readyEngine(engine, "kuzuo");
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    throw new Error("shadow mode attempted network I/O");
  }) as typeof fetch;
  try {
    // The unfiltered pending feed can beat the Builder feed but lacks kuzuo's
    // nonce-1 payment. It must not permanently dedupe the later usable source.
    await internals.handleTarget(targetSignal("kuzuo", "bsc_pending_full"), timing);
    await internals.handleTarget(targetSignal("kuzuo", "club48_auction"), timing);
    assert.equal(fetchCount, 0);
    const events = engine.snapshot().recentEvents as Array<Record<string, unknown>>;
    const ready = events.filter((event) => event.type === "builder_candidate_ready");
    assert.deepEqual(ready.map((event) => [event.builder, event.variant]), [["club48", "backrun"]]);
    const planned = events.find((event) => event.type === "target_planned" && event.dispatchCount === 1);
    assert.equal(planned?.predecessorCount, 0);
    assert.equal(planned?.dispatchCount, 1);
    const laneSnapshot = (engine.snapshot().lanes as Array<Record<string, unknown>>)
      .find((entry) => entry.strategy === "kuzuo");
    assert.equal((laneSnapshot?.nonce as { nextNonce: number }).nextNonce, 14,
      "the usable public buy+tip bundle consumes exactly N and N+1; the zero-candidate source consumes neither");
  } finally {
    globalThis.fetch = originalFetch;
    await engine.stop();
  }
});

test("starting shadow mode performs no Builder prewarm fetch", async () => {
  const shadowConfig = config("shadow");
  shadowConfig.builders = [shadowConfig.builders[0]!];
  const engine = new CopyExecutionEngine(shadowConfig);
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await engine.start();
    assert.equal(fetchCount, 0, "shadow startup must not contact a Builder endpoint");
  } finally {
    globalThis.fetch = originalFetch;
    await engine.stop();
  }
});

test("a same-block copy after the target settles even when another transaction is between them", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const targetHash = `0x${"71".repeat(32)}` as HexString;
  const copyHash = `0x${"72".repeat(32)}` as HexString;
  const internals = engine as unknown as {
    lanes: Record<TargetStrategy, { nonce: {
      synchronize(value: number): unknown;
      reserve(hash: string, block: number, time: string): unknown;
      markSubmitted(hash: string, builder: string): unknown;
    } }>;
    finishIncludedRace(
      race: unknown,
      candidate: unknown,
      receipt: RpcReceipt,
      targetReceipt: RpcReceipt,
      tipCandidate: null,
      tipReceipt: null,
    ): Promise<void>;
  };
  internals.lanes.ed.nonce.synchronize(5);
  internals.lanes.ed.nonce.reserve(targetHash, 114_700_001, "1");
  internals.lanes.ed.nonce.markSubmitted(targetHash, "club48:raw");
  const race = {
    targetHash,
    strategy: "ed" as const,
    validUntilBlock: 114_700_001,
    targetFirstSeenMonoNs: process.hrtime.bigint(),
    candidates: new Map(),
    checkAttempts: 1,
    checking: true,
    nonceSpan: 1,
    orderingMode: "same_block_after",
  };
  const common = {
    blockNumber: 114_700_001,
    status: 1,
    gasUsed: 100_000n,
    effectiveGasPrice: 1_000_000_000n,
  };
  await internals.finishIncludedRace(
    race,
    { hash: copyHash, valueWei: 11_000_000_000_000_000n, builders: ["club48:raw"], tipCandidates: new Map() },
    { transactionHash: copyHash, transactionIndex: 12, ...common },
    { transactionHash: targetHash, transactionIndex: 10, ...common },
    null,
    null,
  );

  assert.equal(engine.snapshot().circuitBroken, false, "one Builder/lane ordering fault must not halt the other wallet");
  assert.equal(internals.lanes.ed.circuitBroken, false);
  assert.equal(internals.lanes.kuzuo.circuitBroken, false);
  await engine.stop();
});

function signingDouble(byte = "61"): HotSigner {
  return {
    address: "0x0000000000000000000000000000000000009001",
    signDirectGmgnBuy(request: { routerCalldata: HexString; swapValueWei: bigint }) {
      return {
        rawTransaction: `0x${byte}` as HexString,
        hash: `0x${byte.repeat(32)}` as HexString,
        data: request.routerCalldata,
        valueWei: request.swapValueWei,
        signedMonoNs: process.hrtime.bigint(),
      };
    },
    signBuilderTip(request: { builderTipWei: bigint }) {
      const tipByte = byte === "61" ? "71" : "73";
      return {
        rawTransaction: `0x${tipByte}` as HexString,
        hash: `0x${tipByte.repeat(32)}` as HexString,
        data: "0x" as HexString,
        valueWei: request.builderTipWei,
        signedMonoNs: process.hrtime.bigint(),
      };
    },
  } as unknown as HotSigner;
}

function builderDouble(onDispatch: () => void): {
  config: BuilderEndpointConfig;
  prepare(intent: SubmitIntent): PreparedBuilderSubmission;
  dispatch(prepared: PreparedBuilderSubmission): Promise<BuilderAck>;
  snapshot(): Record<string, unknown>;
} {
  const builderConfig = BUILDER_CONFIGS[0]!;
  return {
    config: builderConfig,
    prepare(): PreparedBuilderSubmission {
      return {
        builder: builderConfig.name,
        url: builderConfig.url,
        headers: {},
        body: "{}",
        preparedMonoNs: process.hrtime.bigint(),
      };
    },
    dispatch(): Promise<BuilderAck> {
      onDispatch();
      const now = process.hrtime.bigint();
      return Promise.resolve({
        builder: builderConfig.name,
        accepted: true,
        bundleId: `0x${"ef".repeat(32)}`,
        httpStatus: 200,
        startedMonoNs: now,
        responseMonoNs: now,
        latencyMs: 0,
        error: null,
      });
    },
    snapshot() {
      return {
        name: builderConfig.name,
        host: "club48.example",
        lastAck: null,
        lastPrewarmMonoNs: (process.hrtime.bigint() - 1_000_000n).toString(),
      };
    },
  };
}

test("a post-dispatch reservation failure cannot erase the send and persistently trips only its lane", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  internals.lanes.ed.config.signer = signingDouble();
  let dispatches = 0;
  internals.builders = [builderDouble(() => { dispatches += 1; })];
  internals.ledger.reserveAttempt = async () => {
    throw new Error("injected fsync failure");
  };

  await internals.handleTarget(targetSignal("ed"), timing);
  const race = [...internals.activeRaces.values()][0] as { riskReservationPromise: Promise<void> };
  await race.riskReservationPromise;

  assert.equal(dispatches, 1, "machine-first dispatch must start before deferred filesystem accounting");
  assert.equal(engine.snapshot().circuitBroken, false);
  assert.equal(internals.lanes.ed.circuitBroken, true);
  assert.match(internals.lanes.ed.circuitReason ?? "", /post-dispatch risk reservation failed/i);
  assert.equal(internals.lanes.kuzuo.circuitBroken, false);
  assert.equal(internals.ledger.circuitState().tripped, true);
  assert.match(internals.ledger.circuitState().reason ?? "", /post-dispatch risk reservation failed/i);
  assert.ok(internals.ledger.circuitState().trippedAt);
  await engine.stop();
});

test("an already verified target dispatches even if transport readiness telemetry is degraded", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  internals.lanes.ed.config.signer = signingDouble();
  internals.feedMetrics.set("pending-test", {
    connected: true,
    headsSubscriptionReady: true,
    pendingSubscriptionReady: false,
    actionable: false,
  });
  let dispatches = 0;
  internals.builders = [builderDouble(() => { dispatches += 1; })];

  await internals.handleTarget(targetSignal("ed"), timing);

  assert.equal(dispatches, 1);
  const events = engine.snapshot().recentEvents as Array<Record<string, unknown>>;
  assert.equal(events.some((event) => event.type === "target_planned" && event.dispatchCount === 1), true);
  await engine.stop();
});

test("a cold Builder still races while warmth remains telemetry only", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  internals.lanes.ed.config.signer = signingDouble();
  const dispatched: string[] = [];
  const fresh = (process.hrtime.bigint() - 1_000_000n).toString();
  internals.builders = BUILDER_CONFIGS.map((builderConfig) => ({
    config: builderConfig,
    snapshot: () => ({
      lastPrewarmMonoNs: builderConfig.name === "blockrazor" ? null : fresh,
    }),
    prepare: (): PreparedBuilderSubmission => ({
      builder: builderConfig.name,
      url: builderConfig.url,
      headers: {},
      body: "{}",
      preparedMonoNs: process.hrtime.bigint(),
    }),
    dispatch: async (): Promise<BuilderAck> => {
      dispatched.push(builderConfig.name);
      const now = process.hrtime.bigint();
      return {
        builder: builderConfig.name,
        accepted: true,
        bundleId: `0x${"ef".repeat(32)}`,
        httpStatus: 200,
        startedMonoNs: now,
        responseMonoNs: now,
        latencyMs: 0,
        error: null,
      };
    },
  }));

  await internals.handleTarget(targetSignal("ed"), timing);

  assert.deepEqual(dispatched, ["club48", "jet", "blockrazor"]);
  const events = engine.snapshot().recentEvents as Array<Record<string, unknown>>;
  assert.equal(events.some((event) => event.type === "builder_cold_dispatch"
    && event.builder === "blockrazor"), true);
  const planned = events.find((event) => event.type === "target_planned");
  assert.equal(planned?.dispatchCount, 3);
  const nonce = internals.lanes.ed.nonce.snapshot();
  assert.equal(nonce.state, "ready", "warmth telemetry must not delay the next signing allocation");
  assert.equal(nonce.nextNonce, 14);
  assert.equal(nonce.lease, null);
  await engine.stop();
});

test("structural Builder freshness uses that route's interval instead of a global value", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const internals = engine as unknown as EngineInternals;
  const now = process.hrtime.bigint();
  const twentySecondsOld = (now - 20_000_000_000n).toString();
  const route = (name: BuilderEndpointConfig["name"], prewarmIntervalMs: number) => ({
    config: {
      name,
      url: `https://${name}.example/`,
      tipRecipient: "0x0000000000000000000000000000000000000001",
      requestTimeoutMs: 250,
      prewarmIntervalMs,
    },
    snapshot: () => ({ lastPrewarmMonoNs: twentySecondsOld }),
  });
  try {
    assert.equal(internals.builderIsFresh(route("club48", 10_000), now), true);
    assert.equal(internals.builderIsFresh(route("jet", 5_000), now), false);
  } finally {
    await engine.stop();
  }
});

test("engine stop waits for an already-issued Builder heartbeat to drain", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const internals = engine as unknown as EngineInternals;
  await Promise.all((internals.builders as BuilderClient[]).map((builder) => builder.close()));
  let blockHeartbeat = false;
  let heartbeatStarted!: () => void;
  const started = new Promise<void>((resolve) => { heartbeatStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const builder = new BuilderClient({
    name: "jet",
    url: "https://jet.example/",
    tipRecipient: "0x0000000000000000000000000000000000000001",
    requestTimeoutMs: 250,
    prewarmIntervalMs: 100,
  }, (channelIndex) => ({
    async request() {
      if (blockHeartbeat && channelIndex === 0) {
        heartbeatStarted();
        await gate;
      }
      return { status: 200, body: '{"jsonrpc":"2.0","id":"warm","result":"0x38"}' };
    },
    close() {},
  }));
  internals.builders = [builder];
  try {
    await builder.prewarm();
    blockHeartbeat = true;
    await within(started, "engine heartbeat");
    let stopped = false;
    const stopping = engine.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(stopped, false);
    release();
    await within(stopping, "engine stop drain");
    assert.equal(stopped, true);
  } finally {
    release();
    await engine.stop();
  }
});

interface DelayedReservationFixture {
  engine: CopyExecutionEngine;
  internals: EngineInternals;
  handling: Promise<void>;
  durableReservationReached: Promise<void>;
  releaseReservation(): void;
  dispatches(): number;
}

function delayedReservationFixture(): DelayedReservationFixture {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "ed");
  internals.armGate.armedState = true;
  internals.lanes.ed.config.signer = signingDouble();
  let dispatchCount = 0;
  internals.builders = [builderDouble(() => { dispatchCount += 1; })];

  let reservationReached!: () => void;
  const durableReservationReached = new Promise<void>((resolveReached) => {
    reservationReached = resolveReached;
  });
  let releaseReservation!: () => void;
  const reservationGate = new Promise<void>((resolveReservation) => {
    releaseReservation = resolveReservation;
  });
  const originalReserve = internals.ledger.reserveAttempt.bind(internals.ledger);
  internals.ledger.reserveAttempt = async (request: RiskAttemptReservation) => {
    // The Builder write has already started. Delay only the post-dispatch
    // bookkeeping continuation so lifecycle controls cannot pretend to unsend it.
    const result = await originalReserve(request);
    reservationReached();
    await reservationGate;
    return result;
  };

  return {
    engine,
    internals,
    handling: internals.handleTarget(targetSignal("ed"), timing),
    durableReservationReached,
    releaseReservation,
    dispatches: () => dispatchCount,
  };
}

function assertAlreadyDispatchedRetained(fixture: DelayedReservationFixture): void {
  assert.equal(fixture.dispatches(), 1, "a completed Builder write cannot be retroactively cancelled");
  const attempts = Object.values(fixture.internals.ledger.snapshot().attempts);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.state, "reserved");
  const nonce = fixture.internals.lanes.ed.nonce.snapshot();
  assert.equal(nonce.state, "ready");
  assert.equal(nonce.nextNonce, 14);
  assert.equal(nonce.lease, null);
}

test("stop after network dispatch waits for deferred accounting and retains the submitted attempt", async () => {
  const fixture = delayedReservationFixture();
  await fixture.durableReservationReached;

  let stopResolved = false;
  const stopping = fixture.engine.stop().then(() => { stopResolved = true; });
  await Promise.resolve();
  assert.equal(stopResolved, false, "stop must wait for the delayed tracked planner before closing its ledger");
  assert.equal(fixture.dispatches(), 1);

  fixture.releaseReservation();
  await Promise.all([fixture.handling, stopping]);
  assertAlreadyDispatchedRetained(fixture);
});

test("disarm after network dispatch does not rewrite history as an unsent attempt", async () => {
  const fixture = delayedReservationFixture();
  try {
    await fixture.durableReservationReached;
    fixture.internals.armGate.armedState = false;
    fixture.releaseReservation();
    await fixture.handling;
    assertAlreadyDispatchedRetained(fixture);
  } finally {
    fixture.releaseReservation();
    await fixture.engine.stop();
  }
});

test("an in-memory circuit raised after dispatch retains the submitted attempt", async () => {
  const fixture = delayedReservationFixture();
  try {
    await fixture.durableReservationReached;
    fixture.internals.circuitBroken = true;
    fixture.releaseReservation();
    await fixture.handling;
    assertAlreadyDispatchedRetained(fixture);
  } finally {
    fixture.releaseReservation();
    await fixture.engine.stop();
  }
});

test("a persistent circuit raised after dispatch retains the submitted attempt", async () => {
  const fixture = delayedReservationFixture();
  try {
    await fixture.durableReservationReached;
    await fixture.internals.ledger.tripCircuit("operator circuit during durable reservation");
    fixture.releaseReservation();
    await fixture.handling;
    assertAlreadyDispatchedRetained(fixture);
  } finally {
    fixture.releaseReservation();
    await fixture.engine.stop();
  }
});

test("an Ed lane circuit does not block a ready kuzuo wallet from dispatching", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const { internals, timing } = readyEngine(engine, "kuzuo");
  internals.armGate.armedState = true;
  internals.lanes.kuzuo.config.signer = signingDouble("63");
  let dispatches = 0;
  internals.builders = [builderDouble(() => { dispatches += 1; })];
  await internals.lanes.ed.ledger.tripCircuit("injected Ed-only nonce uncertainty");
  internals.lanes.ed.circuitBroken = true;
  internals.lanes.ed.circuitReason = "injected Ed-only nonce uncertainty";
  const kuzuo = targetSignal("kuzuo", "club48_auction");
  kuzuo.sourceSequence = "pending-test:auction-1";

  try {
    await internals.handleTarget(kuzuo, timing);
    assert.equal(dispatches, 1, "a healthy kuzuo lane must cross its Builder boundary independently");
    assert.equal(internals.lanes.ed.circuitBroken, true);
    assert.equal(internals.lanes.kuzuo.circuitBroken, false);
    assert.equal(engine.snapshot().circuitBroken, false, "lane-local uncertainty must not become a global stop");
    assert.ok((engine.snapshot().recentEvents as Array<Record<string, unknown>>)
      .some((event) => event.type === "target_planned" && event.strategy === "kuzuo"));
  } finally {
    await engine.stop();
  }
});

interface ReconciliationInternals extends EngineInternals {
  rpc: {
    receipt(hash: string): Promise<RpcReceipt | null>;
    blockNumber(): Promise<number>;
    latestNonce(address: string): Promise<number>;
    pendingNonce(address: string): Promise<number>;
  };
  stopped: boolean;
  latestHead: HeadSnapshot | null;
  activeRaces: Map<string, unknown>;
  checkRace(race: unknown): Promise<void>;
  lanes: Record<TargetStrategy, {
    nonce: {
      synchronize(value: number): unknown;
      reserve(hash: string, block: number, time: string): unknown;
      markSubmitted(hash: string, builder: string): unknown;
      optimisticCommit(hash: string): unknown;
      snapshot(): { state: string; nextNonce: number | null; lease: unknown };
    };
    config: StrategyLaneConfig;
  }>;
}

async function persistedRaceFixture(path: string): Promise<{
  engine: CopyExecutionEngine;
  internals: ReconciliationInternals;
  race: Record<string, unknown>;
  attemptKey: string;
  worstCostWei: bigint;
}> {
  const liveConfig = config("live");
  liveConfig.riskLedgerPath = path;
  const engine = new CopyExecutionEngine(liveConfig);
  const ready = readyEngine(engine, "ed");
  const internals = ready.internals as ReconciliationInternals;
  const targetHash = targetSignal("ed").transaction.hash.toLowerCase() as HexString;
  const candidateHash = `0x${"73".repeat(32)}` as HexString;
  const nonce = 12;
  const validUntilBlock = 114_700_001;
  const laneConfig = internals.lanes.ed.config;
  const worstCostWei = laneConfig.followAmountWei
    + laneConfig.builderTipWei
    + laneConfig.gasLimit * laneConfig.gasPriceWei;
  const attempt = await internals.ledger.reserveAttempt({
    chainId: 56,
    signer: laneConfig.signer!.address,
    nonce,
    strategy: "ed",
    targetHash,
    candidateHashes: [candidateHash],
    maxBlock: validUntilBlock,
    worstCostWei,
  });
  internals.lanes.ed.nonce.reserve(targetHash, validUntilBlock, "1", 2);
  internals.lanes.ed.nonce.markSubmitted(targetHash, "club48:raw");
  internals.lanes.ed.nonce.optimisticCommit(targetHash);
  const race = {
    targetHash,
    strategy: "ed" as const,
    validUntilBlock,
    targetFirstSeenMonoNs: process.hrtime.bigint(),
    candidates: new Map([[candidateHash.toLowerCase(), {
      hash: candidateHash,
      valueWei: 11_000_000_000_000_000n,
      builders: ["club48:raw"],
      tipCandidates: new Map(),
    }]]),
    plannedRoutes: new Set(["club48:raw"]),
    persistedCandidateHashes: new Set([candidateHash.toLowerCase()]),
    riskAttemptKey: attempt.key,
    riskReservationPromise: null,
    nonce,
    nonceSpan: 2,
    frontierCommitted: true,
    checkAttempts: 0,
    checking: false,
    lastSubmittedBlock: validUntilBlock,
  };
  internals.activeRaces.set(`ed:${targetHash}`, race);
  internals.stopped = false;
  internals.latestHead = {
    number: validUntilBlock + 2,
    hash: `0x${"ad".repeat(32)}` as HexString,
    timestamp: Math.floor(Date.now() / 1_000),
    source: "test-finality-head",
    seenMonoNs: process.hrtime.bigint(),
  };
  return { engine, internals, race, attemptKey: attempt.key, worstCostWei };
}

test("missing receipts release only after finality and unchanged latest/pending nonce", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "copy-executor-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = await persistedRaceFixture(join(directory, "risk-ledger.json"));
  fixture.internals.rpc = {
    async receipt() { return null; },
    async blockNumber() { return 114_700_003; },
    async latestNonce() { return 12; },
    async pendingNonce() { return 12; },
  };

  await fixture.internals.checkRace(fixture.race);

  assert.equal(fixture.internals.ledger.attempt(fixture.attemptKey)?.state, "not_included");
  assert.equal(fixture.internals.ledger.spent("ed"), 0n);
  assert.equal(fixture.internals.activeRaces.size, 0);
  const nonce = fixture.internals.lanes.ed.nonce.snapshot();
  assert.equal(nonce.state, "ready");
  assert.equal(nonce.nextNonce, 14, "receipt finality must not rewind the optimistic frontier");
  assert.equal(nonce.lease, null);
  assert.equal(nonce.externalPending, null);
  assert.equal(fixture.engine.snapshot().circuitBroken, false);
  await fixture.engine.stop();
});

test("stop waits for an in-flight reconciliation before the ledger is closed", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "copy-executor-stop-reconcile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = await persistedRaceFixture(join(directory, "risk-ledger.json"));
  let receiptStarted!: () => void;
  const receiptReached = new Promise<void>((resolveReached) => { receiptStarted = resolveReached; });
  let releaseReceipts!: () => void;
  const receiptGate = new Promise<void>((resolveReceipts) => { releaseReceipts = resolveReceipts; });
  fixture.internals.rpc = {
    async receipt() {
      receiptStarted();
      await receiptGate;
      return null;
    },
    async blockNumber() { return 114_700_003; },
    async latestNonce() { return 12; },
    async pendingNonce() { return 12; },
  };

  const checking = fixture.internals.checkRace(fixture.race);
  await receiptReached;
  let stopResolved = false;
  const stopping = fixture.engine.stop().then(() => { stopResolved = true; });
  await Promise.resolve();
  assert.equal(stopResolved, false, "ledger close must wait for the tracked reconciliation");

  releaseReceipts();
  await Promise.all([checking, stopping]);
  assert.equal(fixture.internals.ledger.attempt(fixture.attemptKey)?.state, "not_included");
  assert.equal(stopResolved, true);
});

test("advanced nonce without a receipt is conservatively charged and circuit-latched on disk", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "copy-executor-unknown-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "risk-ledger.json");
  const fixture = await persistedRaceFixture(path);
  fixture.internals.rpc = {
    async receipt() { return null; },
    async blockNumber() { return 114_700_003; },
    async latestNonce() { return 13; },
    async pendingNonce() { return 13; },
  };

  await fixture.internals.checkRace(fixture.race);
  await fixture.engine.stop();

  const durable = new RiskLedger(riskLedgerPaths(path).ed);
  await durable.load();
  assert.equal(durable.attempt(fixture.attemptKey)?.state, "unknown_charged");
  assert.equal(durable.spent("ed"), fixture.worstCostWei);
  assert.equal(durable.trades("ed"), 1);
  assert.equal(durable.circuitState().tripped, true);
  assert.match(durable.circuitState().reason ?? "", /nonce advanced without a candidate receipt/);
});

interface StartupRpcDouble {
  latestNonce(address: string): Promise<number>;
  pendingNonce(address: string): Promise<number>;
  balance(address: string): Promise<bigint>;
  blockNumber(): Promise<number>;
  assertAtomicExecutor(address: string, owner: string): Promise<void>;
  receipt(hash: string): Promise<RpcReceipt | null>;
  transactionValue(hash: string): Promise<bigint | null>;
}

function startupConfig(path: string): CopyExecutorConfig {
  const value = config("live");
  value.riskLedgerPath = path;
  value.httpRpcUrl = "https://rpc.test.invalid/";
  // Startup recovery exercises the same production live-public invariant as a
  // fresh enable: all three structural routes must exist and BlockRazor must
  // carry submit authorization. `config("live")` supplies exactly that set.
  value.builders = BUILDER_CONFIGS.map((entry) => ({ ...entry }));
  value.lanes.kuzuo.enabled = false;
  return value;
}

async function initializeStartupLedgers(path: string, value: CopyExecutorConfig): Promise<RiskLedger> {
  const paths = riskLedgerPaths(path);
  const global = new RiskLedger(paths.global);
  await global.load();
  await global.ensureIdentity({ chainId: 56, lanes: { ed: null, kuzuo: null } }, true);
  await global.close();

  const ledger = new RiskLedger(paths.ed);
  await ledger.load();
  await ledger.ensureIdentity({
    chainId: 56,
    lanes: {
      ed: {
        signer: value.lanes.ed.signer!.address,
        executor: value.lanes.ed.executorAddress!,
      },
      kuzuo: null,
    },
  }, true);
  return ledger;
}

function installStartupRpc(engine: CopyExecutionEngine, rpc: StartupRpcDouble): void {
  (engine as unknown as { rpc: StartupRpcDouble }).rpc = rpc;
}

test("startup settles a persisted reservation when its candidate receipt is found", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "copy-executor-startup-settle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "risk-ledger.json");
  const liveConfig = startupConfig(path);
  const targetHash = `0x${"81".repeat(32)}`;
  const candidateHash = `0x${"82".repeat(32)}`;
  const initial = await initializeStartupLedgers(path, liveConfig);
  const attempt = await initial.reserveAttempt({
    chainId: 56,
    signer: liveConfig.lanes.ed.signer!.address,
    nonce: 12,
    strategy: "ed",
    targetHash,
    candidateHashes: [candidateHash],
    maxBlock: 114_700_001,
    worstCostWei: 1_000n,
  });
  const targetReceipt: RpcReceipt = {
    transactionHash: targetHash as HexString,
    blockNumber: 114_700_001,
    transactionIndex: 10,
    status: 1,
    gasUsed: 100n,
    effectiveGasPrice: 2n,
  };
  const candidateReceipt: RpcReceipt = {
    ...targetReceipt,
    transactionHash: candidateHash as HexString,
    transactionIndex: 11,
  };
  const engine = new CopyExecutionEngine(liveConfig);
  installStartupRpc(engine, {
    async latestNonce() { return 13; },
    async pendingNonce() { return 13; },
    async balance() { return 1_000_000_000_000_000_000n; },
    async blockNumber() { return 114_700_003; },
    async assertAtomicExecutor() {},
    async receipt(hash) {
      if (hash.toLowerCase() === candidateHash.toLowerCase()) return candidateReceipt;
      if (hash.toLowerCase() === targetHash.toLowerCase()) return targetReceipt;
      return null;
    },
    async transactionValue() { return 10n; },
  });

  await engine.start();
  const ledger = (engine as unknown as { ledger: RiskLedger }).ledger;
  assert.equal(ledger.attempt(attempt.key)?.state, "settled");
  assert.equal(ledger.spent("ed"), 210n);
  assert.equal(ledger.trades("ed"), 1);
  assert.equal(engine.snapshot().circuitBroken, false);
  await engine.stop();
});

test("startup nonce advance charges unknown consumption and a restart restores the persistent circuit", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "copy-executor-startup-unknown-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "risk-ledger.json");
  const liveConfig = startupConfig(path);
  const initial = await initializeStartupLedgers(path, liveConfig);
  const attempt = await initial.reserveAttempt({
    chainId: 56,
    signer: liveConfig.lanes.ed.signer!.address,
    nonce: 12,
    strategy: "ed",
    targetHash: `0x${"91".repeat(32)}`,
    candidateHashes: [`0x${"92".repeat(32)}`],
    maxBlock: 114_700_001,
    worstCostWei: 1_000n,
  });
  const rpc: StartupRpcDouble = {
    async latestNonce() { return 13; },
    async pendingNonce() { return 13; },
    async balance() { return 1_000_000_000_000_000_000n; },
    async blockNumber() { return 114_700_003; },
    async assertAtomicExecutor() {},
    async receipt() { return null; },
    async transactionValue() { return null; },
  };

  const first = new CopyExecutionEngine(liveConfig);
  installStartupRpc(first, rpc);
  await first.start();
  const firstLedger = (first as unknown as { ledger: RiskLedger }).ledger;
  assert.equal(firstLedger.attempt(attempt.key)?.state, "unknown_charged");
  assert.equal(firstLedger.spent("ed"), 1_000n);
  assert.equal(firstLedger.circuitState().tripped, true);
  await first.stop();

  const restarted = new CopyExecutionEngine(startupConfig(path));
  installStartupRpc(restarted, rpc);
  await restarted.start();
  assert.equal(restarted.snapshot().circuitBroken, false);
  const restartedEd = (restarted.snapshot().lanes as Array<Record<string, unknown>>)
    .find((lane) => lane.strategy === "ed")!;
  assert.equal(restartedEd.circuitBroken, true);
  assert.match(String(restartedEd.circuitReason), /consumed copy nonce without a candidate receipt/);
  const restartedLedger = (restarted as unknown as { ledger: RiskLedger }).ledger;
  assert.equal(restartedLedger.attempt(attempt.key)?.state, "unknown_charged");
  assert.equal(restartedLedger.spent("ed"), 1_000n, "restart must not double-charge the unknown attempt");
  await restarted.stop();
});

test("startup re-trips a circuit when an unknown charge was durable but the prior circuit write was lost", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "copy-executor-startup-unknown-no-circuit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "risk-ledger.json");
  const liveConfig = startupConfig(path);
  const initial = await initializeStartupLedgers(path, liveConfig);
  const attempt = await initial.reserveAttempt({
    chainId: 56,
    signer: liveConfig.lanes.ed.signer!.address,
    nonce: 12,
    strategy: "ed",
    targetHash: `0x${"93".repeat(32)}`,
    candidateHashes: [`0x${"94".repeat(32)}`],
    maxBlock: 114_700_001,
    worstCostWei: 1_000n,
  });
  await initial.chargeUnknownConsumption(attempt.key);
  assert.equal(initial.circuitState().tripped, false, "fixture models a lost circuit write after the charge");
  await initial.close();

  const engine = new CopyExecutionEngine(liveConfig);
  installStartupRpc(engine, {
    async latestNonce() { return 13; },
    async pendingNonce() { return 13; },
    async balance() { return 1_000_000_000_000_000_000n; },
    async blockNumber() { return 114_700_003; },
    async assertAtomicExecutor() {},
    async receipt() { return null; },
    async transactionValue() { return null; },
  });
  await engine.start();
  assert.equal(engine.snapshot().circuitBroken, false);
  assert.equal(engine.snapshot().unresolvedRiskAttempts, 1);
  const edStatus = (engine.snapshot().lanes as Array<Record<string, unknown>>)
    .find((lane) => lane.strategy === "ed")!;
  assert.equal(edStatus.circuitBroken, true);
  assert.match(String(edStatus.circuitReason), /persisted unknown charge/);
  await engine.stop();
});
