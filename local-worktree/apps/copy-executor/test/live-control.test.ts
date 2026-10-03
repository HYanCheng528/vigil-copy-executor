import assert from "node:assert/strict";
import test from "node:test";
import { ArmGate } from "../src/arm-gate.js";
import type { CopyExecutorConfig, StrategyLaneConfig } from "../src/config.js";
import type { TargetStrategy } from "../src/core/messages.js";
import { CopyExecutionEngine, ExecutorControlError } from "../src/engine.js";
import { HotSigner } from "../src/hot-signer.js";

function lane(strategy: TargetStrategy, enabled: boolean): StrategyLaneConfig {
  return {
    strategy,
    label: strategy,
    enabled,
    signer: enabled ? new HotSigner(`0x${(strategy === "ed" ? "61" : "62").repeat(32)}`) : null,
    executorAddress: null,
    followAmountWei: 10n,
    builderTipWei: 1n,
    gasPriceWei: 1n,
    gasLimit: 500_000n,
    edMinReturnRetentionBps: 10_000,
    allowZeroMinReturnInLive: true,
  };
}

function config(mode: "live" | "shadow"): CopyExecutorConfig {
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
    builders: [
      { name: "club48", url: "https://club48.example/", tipRecipient: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848", requestTimeoutMs: 250, prewarmIntervalMs: 30_000 },
      { name: "blockrazor", url: "https://blockrazor.example/", authorization: "Bearer test-blockrazor", tipRecipient: "0x1266c6be60392a8ff346e8d5eccd3e69dd9c5f20", requestTimeoutMs: 250, prewarmIntervalMs: 15_000 },
      { name: "jet", url: "https://jet.example/", tipRecipient: "0xe89c42bc188c993273ab34231e12ae60c73042e4", requestTimeoutMs: 250, prewarmIntervalMs: 15_000 },
    ],
    lanes: { ed: lane("ed", true), kuzuo: lane("kuzuo", false) },
  };
}

test("disable closes synchronously and supersedes an older concurrent enable", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  let releaseEnable!: () => void;
  const enableWait = new Promise<void>((resolve) => { releaseEnable = resolve; });
  const fakeGate = {
    armed: false,
    enable: async () => {
      await enableWait;
      fakeGate.armed = true;
    },
    disable: async () => { fakeGate.armed = false; },
  };
  const internals = engine as unknown as {
    stopped: boolean;
    broadcastClosed: boolean;
    latestHead: { number: number; hash: string; timestamp: number; source: string; seenMonoNs: bigint };
    armGate: typeof fakeGate;
    rpc: { latestNonce(address: string): Promise<number>; pendingNonce(address: string): Promise<number> };
    routeReadiness: () => { sourceReady: boolean; routeReady: boolean };
    lanes: Record<TargetStrategy, { nonce: { synchronize(value: number): void } }>;
  };
  internals.stopped = false;
  internals.broadcastClosed = true;
  internals.latestHead = {
    number: 100,
    hash: `0x${"11".repeat(32)}`,
    timestamp: 1,
    source: "test",
    seenMonoNs: process.hrtime.bigint(),
  };
  internals.routeReadiness = () => ({ sourceReady: true, routeReady: true });
  internals.lanes.ed.nonce.synchronize(1);
  internals.rpc = {
    async latestNonce() { return 1; },
    async pendingNonce() { return 1; },
  };
  internals.armGate = fakeGate;

  const enabling = engine.enableLive(ArmGate.ENABLE_CONFIRMATION);
  const disabling = engine.disableLive();
  assert.equal(internals.broadcastClosed, true, "disable must close before yielding");
  releaseEnable();
  await disabling;
  await assert.rejects(enabling, (error: unknown) => error instanceof ExecutorControlError && error.code === "stale_request");
  assert.equal(internals.broadcastClosed, true);
  assert.equal(fakeGate.armed, false);
});

test("stop epoch also prevents an in-flight enable from reopening broadcast", async () => {
  const engine = new CopyExecutionEngine(config("live"));
  const internals = engine as unknown as { stopped: boolean; broadcastClosed: boolean; liveControlEpoch: number };
  internals.stopped = false;
  internals.broadcastClosed = false;
  internals.liveControlEpoch = 7;
  const stopping = engine.stop();
  assert.equal(internals.stopped, true);
  assert.equal(internals.broadcastClosed, true);
  assert.equal(internals.liveControlEpoch, 8);
  await stopping;
});

test("shadow and observe-style processes cannot enable live", async () => {
  const engine = new CopyExecutionEngine(config("shadow"));
  await assert.rejects(
    engine.enableLive(ArmGate.ENABLE_CONFIRMATION),
    (error: unknown) => error instanceof ExecutorControlError && error.code === "mode_forbidden",
  );
});
