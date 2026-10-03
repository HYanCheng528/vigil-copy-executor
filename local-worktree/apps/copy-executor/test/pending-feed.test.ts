import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { SigningKey, Transaction, computeAddress } from "ethers";
import WebSocket, { WebSocketServer } from "ws";
import {
  FullPendingFeed,
  pendingObjectToWire,
  type PendingFeedMetrics,
} from "../src/pending-feed.js";
import { GMGN_ROUTER_ADDRESS, GMGN_SWAP_SELECTOR } from "../src/core/gmgn-calldata.js";
import type { TargetSignal } from "../src/core/messages.js";

const PRIVATE_KEY = `0x${"17".repeat(32)}`;
const KUZUO_KEY = new SigningKey(`0x${"51".repeat(32)}`);
const ED_KEY = new SigningKey(`0x${"52".repeat(32)}`);
const OTHER_KEY = new SigningKey(`0x${"53".repeat(32)}`);
const KUZUO = computeAddress(KUZUO_KEY.publicKey);
const ED = computeAddress(ED_KEY.publicKey);
const BLOCKRAZOR_TIP = "0x1266c6be60392a8ff346e8d5eccd3e69dd9c5f20";

async function waitUntil(predicate: () => boolean, failure: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(failure);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function validHead() {
  return {
    hash: `0x${"ab".repeat(32)}`,
    number: "0x6d62d80",
    timestamp: "0x68972b80",
  };
}

function signedLegacyPendingObject(): { rpc: Record<string, unknown>; raw: string; from: string } {
  const key = new SigningKey(PRIVATE_KEY);
  const transaction = Transaction.from({
    type: 0,
    chainId: 56,
    nonce: 73,
    gasPrice: 3_000_000_000n,
    gasLimit: 175_000n,
    to: "0x000000000000000000000000000000000000bEEF",
    value: 123_456_789n,
    data: "0x1234abcd",
  });
  transaction.signature = key.sign(transaction.unsignedHash);
  const recovered = Transaction.from(transaction.serialized);
  assert.ok(recovered.hash);
  assert.ok(recovered.signature?.networkV);
  return {
    raw: transaction.serialized,
    from: computeAddress(key.publicKey),
    rpc: {
      hash: recovered.hash,
      chainId: "0x38",
      type: "0x0",
      from: recovered.from,
      to: recovered.to,
      nonce: "0x49",
      gas: "0x2ab98",
      gasPrice: "0xb2d05e00",
      value: "0x75bcd15",
      input: "0x1234abcd",
      v: `0x${recovered.signature.networkV.toString(16)}`,
      r: recovered.signature.r,
      s: recovered.signature.s,
    },
  };
}

function signedPendingObject(
  key: SigningKey,
  nonce: number,
  to: string,
  data: string,
  gasLimit: bigint,
  value: bigint,
): { rpc: Record<string, unknown>; raw: `0x${string}`; from: string } {
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
  const recovered = Transaction.from(transaction.serialized);
  assert.ok(recovered.hash);
  assert.ok(recovered.signature?.networkV);
  return {
    raw: transaction.serialized as `0x${string}`,
    from: computeAddress(key.publicKey),
    rpc: {
      hash: recovered.hash,
      chainId: "0x38",
      type: "0x0",
      from: recovered.from,
      to: recovered.to,
      nonce: `0x${nonce.toString(16)}`,
      gas: `0x${gasLimit.toString(16)}`,
      gasPrice: "0x3b9aca00",
      value: `0x${value.toString(16)}`,
      input: data,
      v: `0x${recovered.signature.networkV.toString(16)}`,
      r: recovered.signature.r,
      s: recovered.signature.s,
    },
  };
}

test("QuickNode full-pending object reconstructs the exact signed raw transaction", () => {
  const fixture = signedLegacyPendingObject();
  const wire = pendingObjectToWire(fixture.rpc);

  assert.equal(wire.rawTransaction, fixture.raw);
  assert.equal(wire.hash, Transaction.from(fixture.raw).hash);
  assert.equal(wire.from, fixture.from);
  assert.equal(wire.to, "0x000000000000000000000000000000000000bEEF");
  assert.equal(wire.chainId, 56);
  assert.equal(wire.type, 0);
  assert.equal(wire.nonce, 73);
  assert.equal(wire.gasPriceWei, "3000000000");
  assert.equal(wire.gasLimit, "175000");
  assert.equal(wire.valueWei, "123456789");
  assert.equal(wire.input, "0x1234abcd");
});

test("full-pending reconstruction accepts the RPC data alias but fails closed on spoofed fields", () => {
  const fixture = signedLegacyPendingObject();
  const usingData: Record<string, unknown> = { ...fixture.rpc, data: fixture.rpc.input };
  delete usingData.input;
  assert.equal(pendingObjectToWire(usingData).rawTransaction, fixture.raw);

  assert.throws(
    () => pendingObjectToWire({ ...fixture.rpc, hash: `0x${"00".repeat(32)}` }),
    /do not reconstruct the advertised hash/,
  );
  assert.throws(
    () => pendingObjectToWire({ ...fixture.rpc, from: "0x0000000000000000000000000000000000000001" }),
    /does not recover the advertised sender/,
  );
  assert.throws(
    () => pendingObjectToWire({ ...fixture.rpc, chainId: "0x1" }),
    /not on BSC/,
  );
  assert.throws(
    () => pendingObjectToWire({ ...fixture.rpc, v: "0x25" }),
    /signature v does not match chainId/,
  );
  assert.throws(
    () => pendingObjectToWire({ ...fixture.rpc, type: "0x2" }),
    /only legacy pending targets/,
  );
  assert.throws(
    () => pendingObjectToWire({ ...fixture.rpc, s: undefined }),
    /signature is missing/,
  );
});

test("full-pending correlates kuzuo target/predecessor in either order with bounded orphan recovery", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");

  let peer: WebSocket | null = null;
  server.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as { id?: number };
      if (request.id === 2) socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "heads-sub" }));
      if (request.id === 1) socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "pending-sub" }));
    });
  });

  let nowMonoNs = 1_000n;
  const signals: TargetSignal[] = [];
  const feed = new FullPendingFeed({
    name: "loopback-orphan-correlation",
    url: `ws://127.0.0.1:${address.port}`,
    onTarget: (signal) => signals.push(signal),
    onHead: () => undefined,
  }, {
    targetAddresses: { ed: ED, kuzuo: KUZUO },
    orphanTargetTtlNs: 100n,
    orphanTargetCapacity: 2,
    monotonicNow: () => nowMonoNs,
  });

  const notify = async (rpc: Record<string, unknown>): Promise<void> => {
    const previous = feed.snapshot().notifications;
    assert.ok(peer);
    peer.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: { subscription: "pending-sub", result: rpc },
    }));
    await waitUntil(() => feed.snapshot().notifications === previous + 1, "pending object notification");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  const predecessor = (key: SigningKey, nonce: number) => signedPendingObject(
    key,
    nonce,
    BLOCKRAZOR_TIP,
    "0x",
    21_000n,
    1n,
  );
  const target = (nonce: number, value = 2n) => signedPendingObject(
    KUZUO_KEY,
    nonce,
    GMGN_ROUTER_ADDRESS,
    GMGN_SWAP_SELECTOR,
    500_000n,
    value,
  );

  try {
    feed.start();
    await waitUntil(() => feed.snapshot().pendingSubscriptionReady, "pending subscription ACK");

    // Normal predecessor-first arrival emits immediately with the exact tip.
    const predecessor10 = predecessor(KUZUO_KEY, 10);
    const target11 = target(11);
    await notify(predecessor10.rpc);
    assert.equal(signals.length, 0);
    await notify(target11.rpc);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.transaction.rawTransaction, target11.raw);
    assert.equal(signals[0]?.requiredPredecessors?.[0]?.rawTransaction, predecessor10.raw);

    // Target-first arrival is held, then recovered immediately by N-1.
    nowMonoNs += 10n;
    const target21 = target(21);
    const predecessor20 = predecessor(KUZUO_KEY, 20);
    await notify(target21.rpc);
    assert.equal(signals.length, 1);
    await notify(predecessor20.rpc);
    assert.equal(signals.length, 2);
    assert.equal(signals[1]?.transaction.rawTransaction, target21.raw);
    assert.equal(signals[1]?.requiredPredecessors?.[0]?.rawTransaction, predecessor20.raw);

    // Replayed target or predecessor cannot emit a second signal.
    await notify(predecessor20.rpc);
    await notify(target21.rpc);
    assert.equal(signals.length, 2);

    // Same nonce with a different signed hash is a legitimate replacement,
    // not a duplicate; the feed must hand it to the Engine as well.
    const replacement21 = target(21, 3n);
    await notify(replacement21.rpc);
    assert.equal(signals.length, 3);
    assert.equal(signals[2]?.transaction.nonce, 21);
    assert.notEqual(signals[2]?.transaction.hash, signals[1]?.transaction.hash);

    // Same sender with the wrong predecessor nonce cannot satisfy the orphan.
    const target31 = target(31);
    await notify(target31.rpc);
    await notify(predecessor(KUZUO_KEY, 29).rpc);
    assert.equal(signals.length, 3);

    // Correct nonce signed by another sender is neither stored nor attached.
    const target41 = target(41);
    await notify(target41.rpc);
    await notify(predecessor(OTHER_KEY, 40).rpc);
    assert.equal(signals.length, 3);

    // The absolute deadline is not extended; an expired target stays dropped.
    const target51 = target(51);
    await notify(target51.rpc);
    nowMonoNs += 101n;
    await notify(predecessor(KUZUO_KEY, 50).rpc);
    assert.equal(signals.length, 3);

    // Capacity is absolute: with capacity two, the oldest of three orphans is evicted.
    const target61 = target(61);
    const target71 = target(71);
    const target81 = target(81);
    await notify(target61.rpc);
    await notify(target71.rpc);
    await notify(target81.rpc);
    await notify(predecessor(KUZUO_KEY, 60).rpc);
    assert.equal(signals.length, 3);
    await notify(predecessor(KUZUO_KEY, 70).rpc);
    await notify(predecessor(KUZUO_KEY, 80).rpc);
    assert.equal(signals.length, 5);
    assert.deepEqual(signals.slice(3).map((signal) => signal.transaction.nonce), [71, 81]);

    // A target held by one socket generation cannot be completed after reconnect.
    await notify(target(91).rpc);
    const beforeReconnect = signals.length;
    const oldPeer = peer;
    oldPeer!.close(1000, "test generation reset");
    await waitUntil(
      () => peer !== oldPeer && feed.snapshot().pendingSubscriptionReady,
      "fresh pending generation",
    );
    await notify(predecessor(KUZUO_KEY, 90).rpc);
    assert.equal(signals.length, beforeReconnect);

    // stop/start is also a hard correlation boundary.
    await notify(target(101).rpc);
    const beforeRestart = signals.length;
    const preStopPeer = peer;
    feed.stop();
    feed.start();
    await waitUntil(
      () => peer !== preStopPeer && feed.snapshot().pendingSubscriptionReady,
      "pending generation after restart",
    );
    await notify(predecessor(KUZUO_KEY, 100).rpc);
    assert.equal(signals.length, beforeRestart);
  } finally {
    feed.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("full-pending socket subscribes heads and pending in parallel on open", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const requests: Array<{ id: number; channel: string | undefined }> = [];
  let resolvePending!: () => void;
  const pendingRequested = new Promise<void>((resolve) => {
    resolvePending = resolve;
  });
  server.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as { id: number; method: string; params?: string[] };
      requests.push({ id: request.id, channel: request.params?.[0] });
      if (request.method === "eth_subscribe" && request.id === 2) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "heads-sub" }));
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_subscription",
          params: {
            subscription: "heads-sub",
            result: validHead(),
          },
        }));
      } else if (request.method === "eth_subscribe" && request.id === 1) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "pending-sub" }));
        resolvePending();
      }
    });
  });

  const feed = new FullPendingFeed({
    name: "loopback-full-pending",
    url: `ws://127.0.0.1:${address.port}`,
    onTarget: () => assert.fail("loopback did not send a pending target"),
    onHead: () => undefined,
  });
  let timeout: NodeJS.Timeout | null = null;
  try {
    feed.start();
    await Promise.race([
      pendingRequested,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("pending subscription was not requested")), 2_000);
      }),
    ]);
    assert.deepEqual(requests, [
      { id: 2, channel: "newHeads" },
      { id: 1, channel: "newPendingTransactions" },
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    feed.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("full-pending actionability follows ACK, object capability, and disconnect state", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");

  const requests: Array<{ id: number; channel: string | undefined }> = [];
  const published: PendingFeedMetrics[] = [];
  let peer: WebSocket | null = null;
  server.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as { id: number; params?: string[] };
      requests.push({ id: request.id, channel: request.params?.[0] });
    });
  });

  const fixture = signedLegacyPendingObject();
  const feed = new FullPendingFeed({
    name: "loopback-actionability",
    url: `ws://127.0.0.1:${address.port}`,
    onTarget: () => assert.fail("non-target fixture must not emit a target"),
    onHead: () => undefined,
    onState: (_name, metrics) => published.push(metrics),
  });
  try {
    feed.start();
    await waitUntil(
      () => peer !== null && published.some((metrics) => metrics.connected),
      "socket did not open",
    );
    await waitUntil(() => requests.length === 2, "parallel subscriptions were not requested");
    assert.deepEqual(requests, [
      { id: 2, channel: "newHeads" },
      { id: 1, channel: "newPendingTransactions" },
    ]);
    assert.deepEqual(
      {
        heads: feed.snapshot().headsSubscriptionReady,
        pending: feed.snapshot().pendingSubscriptionReady,
        capability: feed.snapshot().pendingObjectCapability,
        actionable: feed.snapshot().actionable,
      },
      { heads: false, pending: false, capability: "unknown", actionable: false },
      "an open socket without subscription ACKs is not actionable",
    );

    peer!.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "heads-sub" }));
    await waitUntil(
      () => published.some((metrics) => metrics.headsSubscriptionReady && !metrics.actionable),
      "heads ACK was not published",
    );
    peer!.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: { subscription: "heads-sub", result: validHead() },
    }));
    assert.equal(feed.snapshot().pendingSubscriptionReady, false);
    assert.equal(feed.snapshot().actionable, false);

    peer!.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "pending-sub" }));
    await waitUntil(
      () => published.some((metrics) => (
        metrics.pendingSubscriptionReady
        && metrics.pendingObjectCapability === "unknown"
        && !metrics.actionable
      )),
      "pending ACK did not publish capability=unknown",
    );
    assert.equal(feed.snapshot().notifications, 0);
    assert.equal(feed.snapshot().objectNotifications, 0);

    peer!.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: { subscription: "pending-sub", result: `0x${"cd".repeat(32)}` },
    }));
    await waitUntil(
      () => published.some((metrics) => (
        metrics.hashOnlyNotifications === 1
        && metrics.pendingObjectCapability === "hash_only"
        && !metrics.actionable
      )),
      "hash-only notification did not downgrade the feed",
    );

    peer!.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: { subscription: "pending-sub", result: fixture.rpc },
    }));
    await waitUntil(
      () => published.some((metrics) => (
        metrics.objectNotifications === 1
        && metrics.pendingObjectCapability === "full"
        && metrics.actionable
      )),
      "full object did not restore the feed",
    );
    assert.equal(feed.snapshot().lastError, null);

    peer!.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: { subscription: "pending-sub", result: fixture.rpc },
    }));
    await waitUntil(() => feed.snapshot().objectNotifications === 2, "second full object was not observed");
    assert.equal(feed.snapshot().actionable, true, "full objects must keep the feed actionable");
    await waitUntil(
      () => published.some((metrics) => metrics.objectNotifications === 2 && metrics.notifications === 3),
      "coalesced metrics did not expose subsequent full objects",
    );

    const beforeClose = published.length;
    peer!.close(1000, "test disconnect");
    await waitUntil(
      () => published.slice(beforeClose).some((metrics) => (
        !metrics.connected
        && !metrics.headsSubscriptionReady
        && !metrics.pendingSubscriptionReady
        && !metrics.actionable
      )),
      "disconnect did not publish reset subscription readiness",
    );
    await waitUntil(() => requests.length === 4, "feed did not reconnect and request both streams again");
    assert.deepEqual(requests.slice(2), [
      { id: 2, channel: "newHeads" },
      { id: 1, channel: "newPendingTransactions" },
    ]);
    assert.deepEqual(
      {
        connected: feed.snapshot().connected,
        heads: feed.snapshot().headsSubscriptionReady,
        pending: feed.snapshot().pendingSubscriptionReady,
        capability: feed.snapshot().pendingObjectCapability,
        actionable: feed.snapshot().actionable,
      },
      { connected: true, heads: false, pending: false, capability: "unknown", actionable: false },
      "a reconnected transport must wait for fresh subscription ACKs",
    );
  } finally {
    feed.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an ACK-only pending subscription times out capability proof and reconnects", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const requests: number[] = [];
  const published: PendingFeedMetrics[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as { id: number };
      requests.push(request.id);
      if (request.id === 2) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "heads-sub" }));
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_subscription",
          params: { subscription: "heads-sub", result: validHead() },
        }));
      } else if (request.id === 1) {
        // Deliberately ACK the full-object request without sending either a
        // hash or object notification: this must never be advertised healthy.
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "pending-sub" }));
      }
    });
  });

  const feed = new FullPendingFeed({
    name: "loopback-silent-capability",
    url: `ws://127.0.0.1:${address.port}`,
    fullObjectCapabilityTimeoutMs: 50,
    onTarget: () => assert.fail("silent loopback must not emit a target"),
    onHead: () => undefined,
    onState: (_name, metrics) => published.push(metrics),
  });
  try {
    feed.start();
    await waitUntil(
      () => published.some((metrics) => (
        metrics.pendingSubscriptionReady
        && metrics.pendingObjectCapability === "unknown"
        && !metrics.actionable
        && metrics.lastError === "pending feed did not prove full-object capability"
      )),
      "silent subscription did not fail the capability deadline",
    );
    assert.equal(feed.snapshot().notifications, 0);
    assert.equal(feed.snapshot().objectNotifications, 0);
    await waitUntil(
      () => requests.filter((id) => id === 2).length >= 2,
      "capability timeout did not reconnect and request fresh heads",
    );
    assert.ok(feed.snapshot().reconnects >= 1);
  } finally {
    feed.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("heads-only feed publishes head readiness but can never become target-actionable", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");

  const requests: Array<{ id: number; channel: string | undefined }> = [];
  const published: PendingFeedMetrics[] = [];
  let peer: WebSocket | null = null;
  server.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as { id: number; params?: string[] };
      requests.push({ id: request.id, channel: request.params?.[0] });
      if (request.id !== 2) return;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "heads-only-sub" }));
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: { subscription: "heads-only-sub", result: validHead() },
      }));
    });
  });

  let resolveHead!: () => void;
  const headSeen = new Promise<void>((resolve) => { resolveHead = resolve; });
  const feed = new FullPendingFeed({
    name: "loopback-heads-only",
    url: `ws://127.0.0.1:${address.port}`,
    subscribePending: false,
    onTarget: () => assert.fail("heads-only feed must never emit a target"),
    onHead: resolveHead,
    onState: (_name, metrics) => published.push(metrics),
  });
  try {
    feed.start();
    await Promise.race([
      headSeen,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("heads-only feed did not receive a head")),
        2_000,
      )),
    ]);
    await waitUntil(
      () => published.some((metrics) => metrics.headsSubscriptionReady),
      "heads-only ACK was not published",
    );
    assert.deepEqual(requests, [{ id: 2, channel: "newHeads" }]);
    assert.equal(feed.snapshot().pendingSubscriptionReady, false);
    assert.equal(feed.snapshot().actionable, false);

    // Even an unsolicited pending ACK cannot make a head-only socket look like
    // a usable target source.
    assert.ok(peer);
    peer.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "unsolicited-pending-sub" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(feed.snapshot().pendingSubscriptionReady, false);
    assert.equal(feed.snapshot().actionable, false);
  } finally {
    feed.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("heads-only feed rejects a stale timestamp before publishing authority", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const wallClockMs = 1_800_000_000_000;
  const published: PendingFeedMetrics[] = [];
  let emittedHeads = 0;

  server.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as { id?: number };
      if (request.id !== 2) return;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "stale-heads-sub" }));
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: {
          subscription: "stale-heads-sub",
          result: {
            ...validHead(),
            timestamp: `0x${Math.floor((wallClockMs - 30_000) / 1_000).toString(16)}`,
          },
        },
      }));
    });
  });

  const feed = new FullPendingFeed({
    name: "loopback-stale-heads",
    url: `ws://127.0.0.1:${address.port}`,
    subscribePending: false,
    maxHeadTimestampLagMs: 5_000,
    onTarget: () => assert.fail("heads-only feed must never emit a target"),
    onHead: () => { emittedHeads += 1; },
    onState: (_name, metrics) => published.push(metrics),
  }, {
    wallClockNow: () => wallClockMs,
  });
  try {
    feed.start();
    await waitUntil(
      () => emittedHeads > 0 || published.some(({ lastError }) => lastError === "head feed timestamp is stale"),
      "stale head was neither rejected nor emitted",
    );
    assert.equal(emittedHeads, 0);
    assert.ok(published.some(({ lastError }) => lastError === "head feed timestamp is stale"));
    assert.equal(feed.snapshot().headsSubscriptionReady, false);
  } finally {
    feed.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("pending-only feed never subscribes heads even under a full-object burst", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");

  const requests: Array<{ id: number; channel: string | undefined }> = [];
  let peer: WebSocket | null = null;
  server.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as { id: number; params?: string[] };
      requests.push({ id: request.id, channel: request.params?.[0] });
      if (request.id === 1) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "pending-only-sub" }));
      }
    });
  });

  const feed = new FullPendingFeed({
    name: "loopback-pending-only",
    url: `ws://127.0.0.1:${address.port}`,
    subscribeHeads: false,
    onTarget: () => undefined,
    onHead: () => assert.fail("pending-only socket must never emit a head"),
  });
  try {
    feed.start();
    await waitUntil(() => feed.snapshot().pendingSubscriptionReady, "pending-only ACK was not published");
    assert.ok(peer);
    const pending = signedLegacyPendingObject().rpc;
    for (let index = 0; index < 100; index += 1) {
      peer.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: { subscription: "pending-only-sub", result: pending },
      }));
    }
    await waitUntil(() => feed.snapshot().notifications === 100, "pending burst was not consumed");
    assert.deepEqual(requests, [{ id: 1, channel: "newPendingTransactions" }]);
    assert.equal(feed.snapshot().headsSubscriptionReady, false);
    assert.equal(feed.snapshot().pendingObjectCapability, "full");
  } finally {
    feed.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("pending subscription failures never reflect provider messages, URLs, tokens, or raw bytes", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const token = "pending-provider-token-must-not-leak";
  const raw = `0x${"ba".repeat(96)}`;
  const providerUrl = `ws://127.0.0.1:${address.port}/private?apiKey=${token}`;
  const providerMessage = `subscription rejected ${providerUrl} ${token} ${raw}`;
  const published: PendingFeedMetrics[] = [];

  server.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as { id?: number };
      if (request.id !== 2) return;
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32_000, message: providerMessage, data: { url: providerUrl, token, raw } },
      }));
    });
  });

  const feed = new FullPendingFeed({
    name: "loopback-sanitized-subscription-error",
    url: providerUrl,
    onTarget: () => assert.fail("subscription failure must not emit a target"),
    onHead: () => undefined,
    onState: (_name, metrics) => published.push(metrics),
  });
  try {
    feed.start();
    await waitUntil(
      () => published.some(({ lastError }) => lastError === "pending feed heads subscription failed (-32000)"),
      "sanitized subscription failure was not published",
    );
    const visible = JSON.stringify({
      telemetry: published,
      status: { feeds: published },
      journal: published.map(({ lastError }) => ({ type: "pending_feed_state", reason: lastError })),
    });
    for (const secret of [providerUrl, token, raw, providerMessage]) {
      assert.equal(visible.includes(secret), false, "provider-controlled subscription data leaked");
    }
  } finally {
    feed.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("pending transport failures never reflect the configured provider URL", async () => {
  const token = "transport-provider-token-must-not-leak";
  const raw = `0x${"ce".repeat(96)}`;
  const providerBody = `upgrade rejected with ${token} ${raw}`;
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end(providerBody);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const providerUrl = `ws://127.0.0.1:${address.port}/private?apiKey=${token}&raw=${raw}`;
  const published: PendingFeedMetrics[] = [];
  const feed = new FullPendingFeed({
    name: "loopback-sanitized-transport-error",
    url: providerUrl,
    onTarget: () => assert.fail("transport failure must not emit a target"),
    onHead: () => undefined,
    onState: (_name, metrics) => published.push(metrics),
  });
  try {
    feed.start();
    await waitUntil(
      () => published.some(({ lastError }) => lastError === "pending feed transport failed"),
      "sanitized transport failure was not published",
    );
    const visible = JSON.stringify({
      telemetry: published,
      status: { feeds: published },
      journal: published.map(({ lastError }) => ({ type: "pending_feed_state", reason: lastError })),
    });
    for (const secret of [providerUrl, token, raw, providerBody]) {
      assert.equal(visible.includes(secret), false, "provider-controlled transport data leaked");
    }
  } finally {
    feed.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
