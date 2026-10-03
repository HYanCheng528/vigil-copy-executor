import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  Server,
  ServerCredentials,
  type ServerWritableStream,
} from "@grpc/grpc-js";
import {
  SigningKey,
  Transaction,
  computeAddress,
  getBytes,
} from "ethers";
import { WebSocketServer, type WebSocket } from "ws";
import {
  BLOCKRAZOR_GATEWAY_NEW_TXS_METHOD,
  BLOCKRAZOR_PUBLIC_MEMPOOL_TOKYO_ENDPOINT,
  BlockRazorPublicMempoolFeed,
  blockRazorRawTransactionToWire,
  inspectBlockRazorRawTransaction,
  type RelayTxsReply,
  type RelayTxsRequest,
} from "../src/blockrazor-public-feed.js";
import { GMGN_ROUTER_ADDRESS, GMGN_SWAP_SELECTOR } from "../src/core/gmgn-calldata.js";
import { isSourceVerifiedTargetSignal, type TargetSignal } from "../src/core/messages.js";
import { loadConfig, type CopyExecutorConfig, type StrategyLaneConfig } from "../src/config.js";
import { CopyExecutionEngine } from "../src/engine.js";

const KUZUO_KEY = new SigningKey(`0x${"51".repeat(32)}`);
const ED_KEY = new SigningKey(`0x${"52".repeat(32)}`);
const OTHER_KEY = new SigningKey(`0x${"53".repeat(32)}`);
const KUZUO = computeAddress(KUZUO_KEY.publicKey);
const ED = computeAddress(ED_KEY.publicKey);
const BLOCKRAZOR_TIP = "0x1266c6be60392a8ff346e8d5eccd3e69dd9c5f20";
const PLAINTEXT_CONFIRMATION = "I_ACCEPT_BLOCKRAZOR_PLAINTEXT_API_KEY_TRANSPORT";

function signedLegacyRaw(
  key: SigningKey,
  nonce: number,
  to: string,
  data: string,
  gasLimit: bigint,
  value: bigint,
): `0x${string}` {
  const transaction = Transaction.from({
    type: 0,
    chainId: 56,
    nonce,
    gasPrice: 1_000_000_000n,
    gasLimit,
    to,
    value,
    data,
  });
  transaction.signature = key.sign(transaction.unsignedHash);
  return transaction.serialized as `0x${string}`;
}

function reply(raw: `0x${string}`, from = KUZUO): RelayTxsReply {
  return {
    tx: {
      from: getBytes(from),
      timestamp: "0",
      rawTx: getBytes(raw),
    },
  };
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
}

function observeLane(strategy: "ed" | "kuzuo"): StrategyLaneConfig {
  return {
    strategy,
    label: strategy,
    enabled: true,
    signer: null,
    executorAddress: null,
    followAmountWei: 1n,
    builderTipWei: 0n,
    gasPriceWei: 1n,
    gasLimit: 1_000_000n,
    edMinReturnRetentionBps: 10_000,
    allowZeroMinReturnInLive: false,
  };
}

test("official Tokyo endpoint and raw classifier recover audited target/predecessor locally", () => {
  assert.equal(BLOCKRAZOR_PUBLIC_MEMPOOL_TOKYO_ENDPOINT, "63.254.162.18:50051");
  const predecessorRaw = signedLegacyRaw(KUZUO_KEY, 9, BLOCKRAZOR_TIP, "0x", 21_000n, 1n);
  const targetRaw = signedLegacyRaw(KUZUO_KEY, 10, GMGN_ROUTER_ADDRESS, GMGN_SWAP_SELECTOR, 500_000n, 2n);
  const targets = { ed: ED, kuzuo: KUZUO };

  const wire = blockRazorRawTransactionToWire(targetRaw);
  assert.equal(wire.rawTransaction, targetRaw);
  assert.equal(wire.from, KUZUO);
  assert.equal(wire.chainId, 56);
  assert.equal(wire.type, 0);

  const predecessor = inspectBlockRazorRawTransaction(predecessorRaw, targets);
  assert.equal(predecessor.kind, "predecessor");
  if (predecessor.kind === "predecessor") assert.equal(predecessor.transaction.nonce, 9);

  const target = inspectBlockRazorRawTransaction(targetRaw, targets);
  assert.equal(target.kind, "target");
  if (target.kind === "target") {
    assert.equal(target.strategy, "kuzuo");
    assert.equal(target.transaction.nonce, 10);
  }

  const unrelated = signedLegacyRaw(
    KUZUO_KEY,
    11,
    "0x000000000000000000000000000000000000bEEF",
    GMGN_SWAP_SELECTOR,
    100_000n,
    0n,
  );
  assert.deepEqual(inspectBlockRazorRawTransaction(unrelated, targets), {
    kind: "ignore",
    reason: "not_candidate",
  });
});

test("BlockRazor can be the primary target source while heads-only WSS avoids the full-pending cost gate", () => {
  const directory = mkdtempSync(join(tmpdir(), "blockrazor-public-config-"));
  const tokenPath = join(directory, "api-key");
  const apiKey = "root-file-api-key";
  writeFileSync(tokenPath, apiKey + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    const config = loadConfig({
      COPY_EXECUTOR_MODE: "shadow",
      BLOCKRAZOR_PUBLIC_MEMPOOL_ENABLED: "true",
      BLOCKRAZOR_PLAINTEXT_GRPC_CONFIRM: PLAINTEXT_CONFIRMATION,
      BLOCKRAZOR_PUBLIC_MEMPOOL_API_KEY_FILE: tokenPath,
      BSC_HEADS_WSS_URL: "wss://heads.example/secret-path",
      COPYTRADE_BUILDERS: "club48",
    });
    assert.deepEqual(config.pendingWssUrls, []);
    assert.deepEqual(config.headWssUrls, ["wss://heads.example/secret-path"]);
    assert.equal(config.fullPendingCostConfirmed, false);
    assert.equal(config.blockRazorPublicMempool.enabled, true);
    assert.equal(config.blockRazorPublicMempool.endpoint, BLOCKRAZOR_PUBLIC_MEMPOOL_TOKYO_ENDPOINT);
    assert.equal(config.blockRazorPublicMempool.apiKey, apiKey);

    assert.throws(() => loadConfig({
      COPY_EXECUTOR_MODE: "shadow",
      BLOCKRAZOR_PUBLIC_MEMPOOL_ENABLED: "true",
      BLOCKRAZOR_PLAINTEXT_GRPC_CONFIRM: PLAINTEXT_CONFIRMATION,
      BLOCKRAZOR_PUBLIC_MEMPOOL_API_KEY_FILE: tokenPath,
      COPYTRADE_BUILDERS: "club48",
    }), /BSC_HEADS_WSS_URL/);
    assert.throws(() => loadConfig({
      COPY_EXECUTOR_MODE: "shadow",
      BLOCKRAZOR_PUBLIC_MEMPOOL_ENABLED: "true",
      BLOCKRAZOR_PLAINTEXT_GRPC_CONFIRM: PLAINTEXT_CONFIRMATION,
      BLOCKRAZOR_PUBLIC_MEMPOOL_API_KEY: apiKey,
      BSC_HEADS_WSS_URL: "wss://heads.example/",
      COPYTRADE_BUILDERS: "club48",
    }), /BLOCKRAZOR_PUBLIC_MEMPOOL_API_KEY_FILE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("engine does not connect the paid target stream until heads-only WSS proves a current block", async () => {
  const headServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(headServer, "listening");
  const headAddress = headServer.address();
  assert.equal(typeof headAddress, "object");
  let headSocket: WebSocket | null = null;
  let resolveHeadRequest!: () => void;
  const headRequest = new Promise<void>((resolve) => {
    resolveHeadRequest = resolve;
  });
  headServer.on("connection", (socket) => {
    headSocket = socket;
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as { id: number; params?: string[] };
      if (request.id === 2 && request.params?.[0] === "newHeads") resolveHeadRequest();
    });
  });

  const grpcServer = new Server();
  let grpcSubscriptions = 0;
  let resolveGrpcSubscription!: () => void;
  const grpcSubscription = new Promise<void>((resolve) => {
    resolveGrpcSubscription = resolve;
  });
  grpcServer.addService({ newTxs: BLOCKRAZOR_GATEWAY_NEW_TXS_METHOD }, {
    newTxs(_call: ServerWritableStream<RelayTxsRequest, RelayTxsReply>) {
      grpcSubscriptions += 1;
      resolveGrpcSubscription();
    },
  });
  const grpcPort = await new Promise<number>((resolve, reject) => {
    grpcServer.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, port) => {
      if (error) reject(error);
      else resolve(port);
    });
  });

  const config: CopyExecutorConfig = {
    mode: "observe",
    liveConfirmed: false,
    fullPendingCostConfirmed: false,
    pendingWssUrls: [],
    headWssUrls: [`ws://127.0.0.1:${headAddress.port}`],
    headReadyTimeoutMs: 2_000,
    blockRazorPublicMempool: {
      enabled: true,
      name: "blockrazor-loopback-gated",
      endpoint: `127.0.0.1:${grpcPort}`,
      apiKey: "test-api-key",
    },
    httpRpcUrl: null,
    host: "127.0.0.1",
    port: 18_770,
    riskLedgerPath: null,
    armFilePath: null,
    builders: [],
    lanes: { ed: observeLane("ed"), kuzuo: observeLane("kuzuo") },
  };
  const engine = new CopyExecutionEngine(config);
  let timeoutEngine: CopyExecutionEngine | null = null;
  let startPromise: Promise<void> | null = null;
  try {
    startPromise = engine.start();
    await headRequest;
    await delay(75);
    assert.equal(grpcSubscriptions, 0, "paid target stream connected before the first head");

    headSocket!.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "head-sub" }));
    headSocket!.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: {
        subscription: "head-sub",
        result: {
          hash: `0x${"cd".repeat(32)}`,
          number: "0x6d62d80",
          timestamp: `0x${Math.floor(Date.now() / 1_000).toString(16)}`,
        },
      },
    }));
    await startPromise;
    await Promise.race([
      grpcSubscription,
      delay(2_000).then(() => { throw new Error("paid target stream did not connect after head readiness"); }),
    ]);
    assert.equal(grpcSubscriptions, 1);

    await engine.stop();
    timeoutEngine = new CopyExecutionEngine({ ...config, headReadyTimeoutMs: 100 });
    await assert.rejects(
      timeoutEngine.start(),
      /BSC head source did not become ready before target feeds/,
    );
    assert.equal(grpcSubscriptions, 1, "paid target stream connected after head bootstrap timeout");
  } finally {
    await engine.stop();
    await timeoutEngine?.stop();
    if (startPromise) await startPromise.catch(() => undefined);
    for (const socket of headServer.clients) socket.terminate();
    await new Promise<void>((resolve) => headServer.close(() => resolve()));
    grpcServer.forceShutdown();
  }
});

test("raw classifier fails closed for another chain, typed targets, and malformed raw bytes", () => {
  const otherChain = Transaction.from({
    type: 0,
    chainId: 1,
    nonce: 1,
    gasPrice: 1n,
    gasLimit: 100_000n,
    to: GMGN_ROUTER_ADDRESS,
    data: GMGN_SWAP_SELECTOR,
  });
  otherChain.signature = KUZUO_KEY.sign(otherChain.unsignedHash);
  assert.deepEqual(inspectBlockRazorRawTransaction(otherChain.serialized as `0x${string}`, {
    ed: ED,
    kuzuo: KUZUO,
  }), { kind: "ignore", reason: "unsupported_envelope" });

  const typed = Transaction.from({
    type: 2,
    chainId: 56,
    nonce: 1,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    gasLimit: 100_000n,
    to: GMGN_ROUTER_ADDRESS,
    data: GMGN_SWAP_SELECTOR,
  });
  typed.signature = KUZUO_KEY.sign(typed.unsignedHash);
  assert.deepEqual(inspectBlockRazorRawTransaction(typed.serialized as `0x${string}`, {
    ed: ED,
    kuzuo: KUZUO,
  }), { kind: "ignore", reason: "unsupported_envelope" });

  assert.throws(() => blockRazorRawTransactionToWire("0x01"), /signed|legacy|transaction/i);
  assert.throws(() => inspectBlockRazorRawTransaction("0xzz" as `0x${string}`), /raw_tx/);
});

test("relay from is only a hint while signed raw sender remains authoritative", async () => {
  const targetRaw = signedLegacyRaw(ED_KEY, 31, GMGN_ROUTER_ADDRESS, GMGN_SWAP_SELECTOR, 500_000n, 5n);
  const noHintTargetRaw = signedLegacyRaw(ED_KEY, 32, GMGN_ROUTER_ADDRESS, GMGN_SWAP_SELECTOR, 500_000n, 5n);
  const spoofedRaw = signedLegacyRaw(OTHER_KEY, 33, GMGN_ROUTER_ADDRESS, GMGN_SWAP_SELECTOR, 500_000n, 5n);
  const unrelatedRaw = signedLegacyRaw(
    OTHER_KEY,
    34,
    "0x000000000000000000000000000000000000bEEF",
    "0x1234",
    100_000n,
    0n,
  );
  const server = new Server();
  let stream: ServerWritableStream<RelayTxsRequest, RelayTxsReply> | null = null;
  let resolveSubscription!: () => void;
  const subscription = new Promise<void>((resolve) => {
    resolveSubscription = resolve;
  });
  server.addService({ newTxs: BLOCKRAZOR_GATEWAY_NEW_TXS_METHOD }, {
    newTxs(call: ServerWritableStream<RelayTxsRequest, RelayTxsReply>) {
      stream = call;
      resolveSubscription();
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) reject(error);
      else resolve(boundPort);
    });
  });

  const signals: TargetSignal[] = [];
  const feed = new BlockRazorPublicMempoolFeed({
    name: "loopback-sender-hint",
    endpoint: `127.0.0.1:${port}`,
    apiKey: "test-api-key",
    onTarget: (signal) => signals.push(signal),
  }, {
    targetAddresses: { ed: ED, kuzuo: KUZUO },
  });

  try {
    feed.start();
    await subscription;

    // A valid unrelated raw envelope is rejected by recipient/calldata before
    // sender recovery; the unmonitored relay hint does not decide anything.
    stream!.write(reply(unrelatedRaw, computeAddress(OTHER_KEY.publicKey)));
    await waitUntil(() => feed.snapshot().decodedMessages === 1, "unrelated raw inspection");
    assert.equal(feed.snapshot().targetMatches, 0);
    assert.equal(feed.snapshot().invalidTransactions, 0);

    // A wrong negative hint must not hide a genuine signed Ed target.
    stream!.write(reply(targetRaw, computeAddress(OTHER_KEY.publicKey)));
    await waitUntil(() => signals.length === 1, "target with wrong relay hint");
    assert.equal(signals[0]?.strategy, "ed");
    assert.equal(signals[0]?.transaction.rawTransaction, targetRaw);
    assert.equal(feed.snapshot().senderHintMismatches, 1);

    // Conversely, an Ed hint cannot brand raw bytes signed by a stranger.
    stream!.write(reply(spoofedRaw, ED));
    await waitUntil(() => feed.snapshot().decodedMessages === 3, "spoofed positive hint inspection");
    assert.equal(signals.length, 1);
    assert.equal(feed.snapshot().targetMatches, 1);

    // Missing metadata still relies exclusively on signed raw recovery.
    stream!.write({
      tx: { from: new Uint8Array(), timestamp: "0", rawTx: getBytes(noHintTargetRaw) },
    });
    await waitUntil(() => signals.length === 2, "target without relay hint");
    assert.equal(signals[1]?.strategy, "ed");
    assert.equal(signals[1]?.transaction.rawTransaction, noHintTargetRaw);
    assert.equal(feed.snapshot().senderFallbackRecoveries, 1);
  } finally {
    feed.stop();
    server.forceShutdown();
  }
});

test("gRPC adapter sends exact apiKey/false request and attaches the contiguous kuzuo tip", async () => {
  const apiKey = "test-api-key-never-log";
  const predecessorRaw = signedLegacyRaw(KUZUO_KEY, 20, BLOCKRAZOR_TIP, "0x", 21_000n, 3n);
  const targetRaw = signedLegacyRaw(KUZUO_KEY, 21, GMGN_ROUTER_ADDRESS, GMGN_SWAP_SELECTOR, 500_000n, 4n);
  const server = new Server();
  let observedApiKey: string | Buffer | undefined;
  let observedNodeValidation: boolean | undefined;
  server.addService({ newTxs: BLOCKRAZOR_GATEWAY_NEW_TXS_METHOD }, {
    newTxs(call: ServerWritableStream<RelayTxsRequest, RelayTxsReply>) {
      observedApiKey = call.metadata.get("apikey")[0];
      observedNodeValidation = call.request.nodeValidation;
      call.write(reply(predecessorRaw));
      call.write(reply(targetRaw));
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) reject(error);
      else resolve(boundPort);
    });
  });

  let timeout: NodeJS.Timeout | null = null;
  let feed: BlockRazorPublicMempoolFeed | null = null;
  try {
    const targetPromise = new Promise<TargetSignal>(
      (resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("timed out waiting for loopback target")), 3_000);
        feed = new BlockRazorPublicMempoolFeed({
          name: "loopback-blockrazor",
          endpoint: `127.0.0.1:${port}`,
          apiKey,
          onTarget: (signal) => resolve(signal),
        }, {
          targetAddresses: { ed: ED, kuzuo: KUZUO },
        });
        feed.start();
      },
    );
    const signal = await targetPromise;
    assert.equal(observedApiKey, apiKey);
    assert.equal(observedNodeValidation, false);
    assert.equal(signal.source, "blockrazor_public_mempool");
    assert.equal(isSourceVerifiedTargetSignal(signal), true);
    assert.equal(signal.strategy, "kuzuo");
    assert.equal(signal.transaction.rawTransaction, targetRaw);
    assert.equal(signal.requiredPredecessors?.[0]?.rawTransaction, predecessorRaw);
    assert.equal(signal.requiredPredecessors?.[0]?.nonce, 20);

    const snapshot = feed!.snapshot();
    assert.equal(snapshot.targetMatches, 1);
    assert.equal(snapshot.predecessorMatches, 1);
    assert.equal(snapshot.senderHintMismatches, 0);
    assert.equal(snapshot.senderFallbackRecoveries, 0);
    const serializedMetrics = JSON.stringify(snapshot);
    assert.equal(serializedMetrics.includes(apiKey), false);
    assert.equal(serializedMetrics.includes(targetRaw.slice(2, 42)), false);
  } finally {
    if (timeout) clearTimeout(timeout);
    feed?.stop();
    server.forceShutdown();
  }
});

test("BlockRazor correlates kuzuo target/predecessor in either order with bounded orphan recovery", async () => {
  const server = new Server();
  let stream: ServerWritableStream<RelayTxsRequest, RelayTxsReply> | null = null;
  let subscriptions = 0;
  let resolveSubscription!: () => void;
  const subscription = new Promise<void>((resolve) => {
    resolveSubscription = resolve;
  });
  server.addService({ newTxs: BLOCKRAZOR_GATEWAY_NEW_TXS_METHOD }, {
    newTxs(call: ServerWritableStream<RelayTxsRequest, RelayTxsReply>) {
      subscriptions += 1;
      stream = call;
      resolveSubscription();
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) reject(error);
      else resolve(boundPort);
    });
  });

  let nowMonoNs = 1_000n;
  const signals: TargetSignal[] = [];
  const feed = new BlockRazorPublicMempoolFeed({
    name: "loopback-blockrazor-orphans",
    endpoint: `127.0.0.1:${port}`,
    apiKey: "test-api-key",
    onTarget: (signal) => signals.push(signal),
  }, {
    targetAddresses: { ed: ED, kuzuo: KUZUO },
    orphanTargetTtlNs: 100n,
    orphanTargetCapacity: 2,
    monotonicNow: () => nowMonoNs,
  });

  const send = async (raw: `0x${string}`, from = KUZUO): Promise<void> => {
    const previous = feed.snapshot().notifications;
    assert.ok(stream);
    stream.write(reply(raw, from));
    await waitUntil(() => feed.snapshot().notifications === previous + 1, "BlockRazor notification");
    await delay(0);
  };
  const predecessor = (key: SigningKey, nonce: number) => signedLegacyRaw(
    key,
    nonce,
    BLOCKRAZOR_TIP,
    "0x",
    21_000n,
    1n,
  );
  const target = (nonce: number, value = 2n) => signedLegacyRaw(
    KUZUO_KEY,
    nonce,
    GMGN_ROUTER_ADDRESS,
    GMGN_SWAP_SELECTOR,
    500_000n,
    value,
  );

  try {
    feed.start();
    await subscription;

    const predecessor10 = predecessor(KUZUO_KEY, 10);
    const target11 = target(11);
    await send(predecessor10);
    assert.equal(signals.length, 0);
    await send(target11);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.transaction.rawTransaction, target11);
    assert.equal(signals[0]?.requiredPredecessors?.[0]?.rawTransaction, predecessor10);

    nowMonoNs += 10n;
    const target21 = target(21);
    const predecessor20 = predecessor(KUZUO_KEY, 20);
    await send(target21);
    assert.equal(signals.length, 1);
    await send(predecessor20);
    assert.equal(signals.length, 2);
    assert.equal(signals[1]?.transaction.rawTransaction, target21);
    assert.equal(signals[1]?.requiredPredecessors?.[0]?.rawTransaction, predecessor20);

    await send(predecessor20);
    await send(target21);
    assert.equal(signals.length, 2, "replayed pair emitted more than once");

    const replacement21 = target(21, 3n);
    await send(replacement21);
    assert.equal(signals.length, 3, "same-nonce replacement was incorrectly deduped");
    assert.equal(signals[2]?.transaction.nonce, 21);
    assert.notEqual(signals[2]?.transaction.hash, signals[1]?.transaction.hash);

    await send(target(31));
    await send(predecessor(KUZUO_KEY, 29));
    assert.equal(signals.length, 3, "wrong predecessor nonce satisfied an orphan");

    await send(target(41));
    await send(predecessor(OTHER_KEY, 40), computeAddress(OTHER_KEY.publicKey));
    assert.equal(signals.length, 3, "different sender satisfied an orphan");

    await send(target(51));
    nowMonoNs += 101n;
    await send(predecessor(KUZUO_KEY, 50));
    assert.equal(signals.length, 3, "expired orphan was recovered");

    await send(target(61));
    await send(target(71));
    await send(target(81));
    await send(predecessor(KUZUO_KEY, 60));
    assert.equal(signals.length, 3, "capacity-evicted orphan was recovered");
    await send(predecessor(KUZUO_KEY, 70));
    await send(predecessor(KUZUO_KEY, 80));
    assert.equal(signals.length, 5);
    assert.deepEqual(signals.slice(3).map((signal) => signal.transaction.nonce), [71, 81]);
    assert.equal(feed.snapshot().targetMatches, 5);

    // A held target is scoped to the exact gRPC stream generation.
    await send(target(91));
    const beforeReconnect = signals.length;
    stream!.end();
    await waitUntil(
      () => subscriptions >= 2 && feed.snapshot().connectionState === "streaming",
      "BlockRazor reconnect generation",
      5_000,
    );
    await send(predecessor(KUZUO_KEY, 90));
    assert.equal(signals.length, beforeReconnect);

    // stop/start is also a hard boundary and must not revive the orphan.
    await send(target(101));
    const beforeRestart = signals.length;
    feed.stop();
    feed.start();
    await waitUntil(
      () => subscriptions >= 3 && feed.snapshot().connectionState === "streaming",
      "BlockRazor generation after restart",
      5_000,
    );
    await send(predecessor(KUZUO_KEY, 100));
    assert.equal(signals.length, beforeRestart);
  } finally {
    feed.stop();
    server.forceShutdown();
  }
});
