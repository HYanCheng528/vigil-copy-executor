import assert from "node:assert/strict";
import test from "node:test";
import {
  BuilderClient,
  type BuilderChannelFactory,
  type BuilderChannelRequest,
  type BuilderChannelResponse,
  type BuilderName,
  type SubmitIntent,
  type TargetReference,
} from "../src/builders.js";
import type { HexString } from "../src/core/messages.js";

const PREDECESSOR_A = "0x01" as HexString;
const PREDECESSOR_B = "0x02" as HexString;
const TARGET_RAW = "0x03" as HexString;
const BUY_RAW = "0x04" as HexString;
const TIP_RAW = "0x05" as HexString;
const TARGET_HASH = `0x${"11".repeat(32)}` as HexString;
const PRIVATE_BUNDLE_HASH = `0x${"22".repeat(32)}` as HexString;

function client(name: BuilderName, channelFactory?: BuilderChannelFactory): BuilderClient {
  return new BuilderClient({
    name,
    url: `https://${name}.builder.example/`,
    authorization: "Bearer regression-test",
    tipRecipient: "0x0000000000000000000000000000000000000001",
    requestTimeoutMs: 250,
    prewarmIntervalMs: 100,
  }, channelFactory);
}

function channelFactory(
  handler: (channelIndex: number, request: BuilderChannelRequest) => Promise<BuilderChannelResponse>,
): BuilderChannelFactory {
  return (channelIndex) => ({
    request: (value) => handler(channelIndex, value),
    close() {},
  });
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

function intent(target: TargetReference, overrides: Partial<SubmitIntent> = {}): SubmitIntent {
  return {
    target,
    strategyTxs: [BUY_RAW, TIP_RAW],
    maxBlockNumber: 114_700_001,
    minTimestamp: 1_786_180_000,
    maxTimestamp: 1_786_180_001,
    noMerge: false,
    positionFirst: false,
    ...overrides,
  };
}

function decodedBody(builder: BuilderClient, value: SubmitIntent): Record<string, unknown> {
  const prepared = builder.prepare(value);
  assert.equal(prepared.headers.authorization, "Bearer regression-test");
  return JSON.parse(prepared.body) as Record<string, unknown>;
}

function firstParams(body: Record<string, unknown>): Record<string, unknown> {
  const params = body.params as unknown[];
  assert.equal(params.length, 1);
  return params[0] as Record<string, unknown>;
}

function unboundedIntent(target: TargetReference): SubmitIntent {
  return {
    target,
    strategyTxs: [BUY_RAW, TIP_RAW],
    noMerge: false,
    positionFirst: false,
  };
}

test("raw target bundles preserve predecessor -> target -> buy -> separate tip ordering for all three Builders", () => {
  const target: TargetReference = {
    kind: "rawTx",
    hash: TARGET_HASH,
    raw: TARGET_RAW,
    requiredPredecessorRaws: [PREDECESSOR_A, PREDECESSOR_B],
  };

  for (const name of ["club48", "blockrazor", "jet"] as const) {
    const body = decodedBody(client(name), intent(target));
    assert.equal(body.method, "eth_sendBundle");
    assert.deepEqual(firstParams(body).txs, [PREDECESSOR_A, PREDECESSOR_B, TARGET_RAW, BUY_RAW, TIP_RAW]);
  }
});

test("all three public eth_sendBundle payloads omit block and time limits when absent", () => {
  const target: TargetReference = {
    kind: "rawTx",
    hash: TARGET_HASH,
    raw: TARGET_RAW,
    requiredPredecessorRaws: [],
  };

  for (const name of ["club48", "blockrazor", "jet"] as const) {
    const body = decodedBody(client(name), unboundedIntent(target));
    const params = firstParams(body);
    assert.equal(body.method, "eth_sendBundle");
    assert.equal(Object.hasOwn(params, "maxBlockNumber"), false, `${name} must omit maxBlockNumber`);
    assert.equal(Object.hasOwn(params, "minTimestamp"), false, `${name} must omit minTimestamp`);
    assert.equal(Object.hasOwn(params, "maxTimestamp"), false, `${name} must omit maxTimestamp`);
  }
});

test("confirmed target N+1 bundles never re-include the already-mined target", () => {
  const target: TargetReference = {
    kind: "confirmedNextBlock",
    targetHash: TARGET_HASH,
    targetBlock: 114_700_000,
  };
  for (const name of ["club48", "blockrazor", "jet"] as const) {
    const body = decodedBody(client(name), intent(target));
    assert.equal(body.method, "eth_sendBundle");
    assert.deepEqual(firstParams(body).txs, [BUY_RAW, TIP_RAW]);
    assert.equal(firstParams(body).maxBlockNumber, 114_700_001);
  }
});

test("48Club backrun uses backrunTarget and never duplicates the target into txs", () => {
  const body = decodedBody(client("club48"), intent({ kind: "club48AuctionId", id: TARGET_HASH }, {
    noMerge: true,
  }));
  const params = firstParams(body);

  assert.equal(body.method, "eth_sendBundle");
  assert.equal(params.backrunTarget, TARGET_HASH);
  assert.deepEqual(params.txs, [BUY_RAW, TIP_RAW]);
  assert.equal(params.noMerge, true);
  assert.equal(params.positionFirst, false);
  assert.equal(params.maxBlockNumber, 114_700_001);
  assert.equal(params.maxTimestamp, 1_786_180_001);
});

test("BlockRazor private orderflow hash uses eth_sendMevBundle without pretending raw availability", () => {
  const body = decodedBody(client("blockrazor"), intent({
    kind: "blockrazorPrivateBundleHash",
    hash: PRIVATE_BUNDLE_HASH,
  }, { strategyTxs: [BUY_RAW] }));

  assert.equal(body.method, "eth_sendMevBundle");
  assert.deepEqual(firstParams(body), {
    hash: PRIVATE_BUNDLE_HASH,
    txs: [BUY_RAW],
    maxBlockNumber: 114_700_001,
    revertingTxHashes: [],
  });

  assert.throws(
    () => client("blockrazor").prepare({
      ...unboundedIntent({
        kind: "blockrazorPrivateBundleHash",
        hash: PRIVATE_BUNDLE_HASH,
      }),
      strategyTxs: [BUY_RAW],
    }),
    /private eth_sendMevBundle requires maxBlockNumber/,
  );
});

test("optional public bundle limits are validated only when supplied", () => {
  const target: TargetReference = {
    kind: "rawTx",
    hash: TARGET_HASH,
    raw: TARGET_RAW,
    requiredPredecessorRaws: [],
  };
  assert.doesNotThrow(() => client("blockrazor").prepare(unboundedIntent(target)));
  assert.throws(
    () => client("blockrazor").prepare({ ...unboundedIntent(target), maxBlockNumber: 0 }),
    /maxBlockNumber must be positive when provided/,
  );
  assert.throws(
    () => client("blockrazor").prepare({ ...unboundedIntent(target), minTimestamp: -1 }),
    /minTimestamp must be non-negative when provided/,
  );
  assert.throws(
    () => client("blockrazor").prepare({ ...unboundedIntent(target), maxTimestamp: 0 }),
    /maxTimestamp must be positive when provided/,
  );
});

test("Builder TargetRef capabilities fail closed instead of silently degrading ordering", () => {
  assert.throws(
    () => client("club48").prepare(intent(
      { kind: "blockrazorPrivateBundleHash", hash: PRIVATE_BUNDLE_HASH },
      { strategyTxs: [BUY_RAW] },
    )),
    /48Club cannot consume/,
  );
  assert.throws(
    () => client("blockrazor").prepare(intent({ kind: "club48AuctionId", id: TARGET_HASH })),
    /BlockRazor cannot consume/,
  );
  assert.throws(
    () => client("jet").prepare(intent({ kind: "club48AuctionId", id: TARGET_HASH })),
    /Jet requires the complete signed target transaction/,
  );
  assert.doesNotThrow(() => client("jet").prepare(intent({
    kind: "rawTx",
    hash: TARGET_HASH,
    raw: TARGET_RAW,
    requiredPredecessorRaws: [],
  }, { noMerge: true })));
});

test("public payload requires exactly buy and separate tip transactions", () => {
  const target: TargetReference = {
    kind: "rawTx",
    hash: TARGET_HASH,
    raw: TARGET_RAW,
    requiredPredecessorRaws: [],
  };
  assert.throws(() => client("club48").prepare(intent(target, { strategyTxs: [] })), /buy and separate tip/);
  assert.throws(
    () => client("blockrazor").prepare(intent(target, { strategyTxs: [BUY_RAW] })),
    /buy and separate tip/,
  );
});

test("Builder startup prewarm probes both owned channels and rejects a wrong chain", async () => {
  const channelCalls: number[] = [];
  const readyFactory = channelFactory(async (channelIndex, value) => {
    channelCalls.push(channelIndex);
    const request = JSON.parse(value.body) as Record<string, unknown>;
    assert.equal(request.method, "eth_chainId");
    assert.deepEqual(request.params, []);
    assert.equal(value.headers.authorization, "Bearer regression-test");
    return { status: 200, body: '{"jsonrpc":"2.0","id":"warm","result":"0x38"}' };
  });
  const builder = client("jet", readyFactory);
  const firstWarmup = builder.prewarm();
  assert.strictEqual(builder.prewarm(), firstWarmup, "overlapping startup warmups must share one flight");
  await firstWarmup;
  assert.deepEqual(channelCalls, [0, 1], "heartbeat must stagger one request across each owned channel");
  assert.notEqual(builder.snapshot().lastPrewarmMonoNs, null);

  const wrongNetwork = client("jet", channelFactory(async () => ({
    status: 200,
    body: '{"jsonrpc":"2.0","id":"warm","result":"0x1"}',
  })));
  await wrongNetwork.prewarm();
  assert.equal(wrongNetwork.snapshot().lastPrewarmMonoNs, null);

  const sanitized = client("jet", channelFactory(async (_channelIndex, value) => {
    const request = JSON.parse(value.body) as { method: string };
    return request.method === "eth_chainId"
      ? { status: 200, body: '{"jsonrpc":"2.0","id":"warm","result":"0x38"}' }
      : {
          status: 200,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32_000, message: "TOP_SECRET_SIGNED_RAW_AND_AUTH" },
          }),
        };
  }));
  await sanitized.prewarm();
  const ack = await sanitized.dispatch(sanitized.prepare(intent({
    kind: "rawTx",
    hash: TARGET_HASH,
    raw: TARGET_RAW,
    requiredPredecessorRaws: [],
  })));
  assert.equal(ack.error, "Builder JSON-RPC error (-32000)");
  assert.equal(ack.error.includes("TOP_SECRET"), false);
  const snapshotAck = sanitized.snapshot().lastAck;
  assert.equal(typeof snapshotAck?.startedMonoNs, "string");
  assert.equal(typeof snapshotAck?.responseMonoNs, "string");
  await Promise.all([builder.close(), wrongNetwork.close(), sanitized.close()]);
});

test("BlockRazor validates sendBundle capability on both channels and only real auth failure revokes it", async () => {
  const probes: number[] = [];
  let dispatchStatus = 200;
  const builder = client("blockrazor", channelFactory(async (channelIndex, value) => {
    const request = JSON.parse(value.body) as { method: string; params: Array<Record<string, unknown>> };
    if (request.method === "eth_sendBundle" && Array.isArray(request.params?.[0]?.txs)
      && (request.params[0]!.txs as unknown[]).length === 0) {
      probes.push(channelIndex);
      assert.deepEqual(request.params, [{ txs: [] }]);
      return {
        status: 200,
        body: '{"jsonrpc":"2.0","id":"warm","error":{"code":-38000,"message":"bundle missing txs"}}',
      };
    }
    return dispatchStatus === 200
      ? { status: 200, body: `{"jsonrpc":"2.0","id":1,"result":"0x${"ef".repeat(32)}"}` }
      : { status: dispatchStatus, body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"auth"}}' };
  }));
  try {
    await builder.prewarm();
    assert.deepEqual(probes, [0, 1]);
    assert.equal(builder.snapshot().readyChannels, 2);
    const prepared = () => builder.prepare(intent({
      kind: "rawTx",
      hash: TARGET_HASH,
      raw: TARGET_RAW,
      requiredPredecessorRaws: [],
    }));
    assert.equal((await builder.dispatch(prepared())).accepted, true);
    dispatchStatus = 402;
    assert.equal((await builder.dispatch(prepared())).httpStatus, 402);
    const channels = (builder as unknown as { channels: Array<{ submitCapable: boolean }> }).channels;
    assert.equal(channels.some((channel) => !channel.submitCapable), true);
  } finally {
    await builder.close();
  }
});

test("BlockRazor keeps a submit-validated channel ready when eth_chainId returns non-JSON 402", async () => {
  const heartbeatChannels: number[] = [];
  const builder = client("blockrazor", channelFactory(async (channelIndex, value) => {
    const request = JSON.parse(value.body) as { method: string; params: Array<Record<string, unknown>> };
    if (request.method === "eth_sendBundle") {
      assert.deepEqual(request.params, [{ txs: [] }]);
      return {
        status: 200,
        body: '{"jsonrpc":"2.0","id":"warm","error":{"code":-38000,"message":"bundle missing txs"}}',
      };
    }
    assert.equal(request.method, "eth_chainId");
    heartbeatChannels.push(channelIndex);
    return { status: 402, body: "Payment Required" };
  }));
  try {
    await builder.prewarm();
    assert.equal(builder.snapshot().readyChannels, 2);

    const internals = builder as unknown as {
      channels: [object, object];
      prewarmConnection(channel: object): Promise<void>;
    };
    await internals.prewarmConnection(internals.channels[0]);
    await internals.prewarmConnection(internals.channels[1]);

    assert.deepEqual(heartbeatChannels, [0, 1]);
    assert.equal(builder.snapshot().readyChannels, 2,
      "an unsupported chainId heartbeat must not erase proven sendBundle capability");
  } finally {
    await builder.close();
  }
});

test("BlockRazor rejects wrong capability status, code, or missing-txs classification", async () => {
  const responses = [
    { status: 402, body: '{"error":{"code":-38000,"message":"bundle missing txs"}}' },
    { status: 200, body: '{"error":{"code":-32000,"message":"bundle missing txs"}}' },
    { status: 200, body: '{"error":{"code":-38000,"message":"some other error"}}' },
  ];
  for (const response of responses) {
    const builder = client("blockrazor", channelFactory(async () => response));
    await builder.prewarm();
    assert.equal(builder.snapshot().readyChannels, 0);
    await builder.close();
  }
});

test("freshness uses only the healthy watermark and includes the exact TTL boundary", async () => {
  const builder = client("jet", channelFactory(async () => ({
    status: 200,
    body: '{"jsonrpc":"2.0","id":"warm","result":"0x38"}',
  })));
  try {
    await builder.prewarm();
    const channels = (builder as unknown as {
      channels: [{ ready: boolean; lastHealthyMonoNs: bigint }, { ready: boolean; lastHealthyMonoNs: bigint }];
    }).channels;
    channels[1].ready = false;
    const ttlNs = BigInt(builder.config.prewarmIntervalMs * 3) * 1_000_000n;
    assert.equal(builder.isFresh(channels[0].lastHealthyMonoNs + ttlNs), true);
    assert.equal(builder.isFresh(channels[0].lastHealthyMonoNs + ttlNs + 1n), false);
  } finally {
    await builder.close();
  }
});

test("JSON-RPC rejection does not renew health while auth failure immediately disables its channel", async () => {
  let sendCount = 0;
  const builder = client("jet", channelFactory(async (_channelIndex, value) => {
    const request = JSON.parse(value.body) as { method: string };
    if (request.method === "eth_chainId") {
      return { status: 200, body: '{"jsonrpc":"2.0","id":"warm","result":"0x38"}' };
    }
    sendCount += 1;
    return sendCount === 1
      ? { status: 200, body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"rejected"}}' }
      : { status: 402, body: '{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"auth"}}' };
  }));
  try {
    await builder.prewarm();
    const channels = (builder as unknown as {
      channels: [
        { ready: boolean; lastHealthyMonoNs: bigint },
        { ready: boolean; lastHealthyMonoNs: bigint },
      ];
    }).channels;
    const healthyBefore = channels.map((channel) => channel.lastHealthyMonoNs);
    const prepared = () => builder.prepare(intent({
      kind: "rawTx",
      hash: TARGET_HASH,
      raw: TARGET_RAW,
      requiredPredecessorRaws: [],
    }));

    const rejected = await builder.dispatch(prepared());
    assert.equal(rejected.accepted, false);
    assert.equal(channels[0].ready, true, "a valid JSON-RPC rejection must not discard a live socket");
    assert.equal(channels[0].lastHealthyMonoNs, healthyBefore[0]);

    const unauthorized = await builder.dispatch(prepared());
    assert.equal(unauthorized.httpStatus, 402);
    assert.equal(channels[1].ready, false, "authentication failure must immediately remove the channel");
    assert.deepEqual(channels.map((channel) => channel.lastHealthyMonoNs), healthyBefore);
    const ttlNs = BigInt(builder.config.prewarmIntervalMs * 3) * 1_000_000n;
    assert.equal(builder.isFresh(healthyBefore[0]! + ttlNs + 1n), false,
      "error traffic must not keep an old healthy session fresh forever");
  } finally {
    await builder.close();
  }
});

test("dispatch never selects a stale channel merely because its ready flag remains set", async () => {
  const sends: number[] = [];
  const builder = client("jet", channelFactory(async (channelIndex, value) => {
    const request = JSON.parse(value.body) as { method: string };
    if (request.method === "eth_chainId") {
      return { status: 200, body: '{"jsonrpc":"2.0","id":"warm","result":"0x38"}' };
    }
    sends.push(channelIndex);
    return { status: 200, body: `{"jsonrpc":"2.0","id":1,"result":"0x${"ef".repeat(32)}"}` };
  }));
  try {
    await builder.prewarm();
    const now = process.hrtime.bigint();
    const ttlNs = BigInt(builder.config.prewarmIntervalMs * 3) * 1_000_000n;
    const channels = (builder as unknown as {
      channels: [
        { ready: boolean; lastHealthyMonoNs: bigint; lastIoMonoNs: bigint },
        { ready: boolean; lastHealthyMonoNs: bigint; lastIoMonoNs: bigint },
      ];
    }).channels;
    channels[0].ready = true;
    channels[0].lastHealthyMonoNs = now - ttlNs - 1n;
    channels[0].lastIoMonoNs = 0n;
    channels[1].ready = true;
    channels[1].lastHealthyMonoNs = now;
    channels[1].lastIoMonoNs = now;

    const ack = await builder.dispatch(builder.prepare(intent({
      kind: "rawTx",
      hash: TARGET_HASH,
      raw: TARGET_RAW,
      requiredPredecessorRaws: [],
    })));
    assert.equal(ack.accepted, true);
    assert.deepEqual(sends, [1]);
  } finally {
    await builder.close();
  }
});

test("dispatch prefers a fresh channel but still writes immediately when every owned channel is cold", async () => {
  const sends: number[] = [];
  const builder = client("jet", channelFactory(async (channelIndex) => {
    sends.push(channelIndex);
    return { status: 200, body: `{"jsonrpc":"2.0","id":1,"result":"0x${"ef".repeat(32)}"}` };
  }));
  try {
    assert.equal(builder.isFresh(), false);
    const ack = await builder.dispatch(builder.prepare(intent({
      kind: "rawTx",
      hash: TARGET_HASH,
      raw: TARGET_RAW,
      requiredPredecessorRaws: [],
    })));
    assert.equal(ack.accepted, true);
    assert.deepEqual(sends, [0]);
  } finally {
    await builder.close();
  }
});

test("close cancels both adaptive heartbeat deadlines without a later reconnect", async () => {
  let requests = 0;
  const closed: number[] = [];
  const builder = client("jet", (channelIndex) => ({
    async request() {
      requests += 1;
      return { status: 200, body: '{"jsonrpc":"2.0","id":"warm","result":"0x38"}' };
    },
    close() { closed.push(channelIndex); },
  }));
  await builder.prewarm();
  assert.equal(requests, 2);
  await builder.close();
  await new Promise((resolve) => setTimeout(resolve, 80));
  await builder.prewarm();
  assert.equal(requests, 2, "stop must prevent timer probes and explicit reconnects");
  assert.deepEqual(closed.sort(), [0, 1]);
});

test("close waits for an active heartbeat, drops its queued sibling, and never interrupts the write", async () => {
  const calls: number[] = [];
  const closed: number[] = [];
  let blockHeartbeat = false;
  let heartbeatStarted!: () => void;
  const started = new Promise<void>((resolve) => { heartbeatStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const builder = client("jet", (channelIndex) => ({
    async request() {
      calls.push(channelIndex);
      if (blockHeartbeat && channelIndex === 0) {
        heartbeatStarted();
        await gate;
      }
      return { status: 200, body: '{"jsonrpc":"2.0","id":"warm","result":"0x38"}' };
    },
    close() { closed.push(channelIndex); },
  }));
  try {
    await builder.prewarm();
    blockHeartbeat = true;
    await within(started, "active heartbeat");
    // Let channel 1's full-period deadline collide and queue behind channel 0.
    await new Promise((resolve) => setTimeout(resolve, 65));
    assert.deepEqual(calls, [0, 1, 0]);

    let closeSettled = false;
    const closing = builder.close().then(() => { closeSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(closeSettled, false, "shutdown must wait for already-issued network I/O");
    release();
    await within(closing, "Builder drain");
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.deepEqual(calls, [0, 1, 0], "queued sibling and later timers must never restart after close");
    assert.deepEqual(closed.sort(), [0, 1]);

    const ack = await builder.dispatch(builder.prepare(intent({
      kind: "rawTx",
      hash: TARGET_HASH,
      raw: TARGET_RAW,
      requiredPredecessorRaws: [],
    })));
    assert.equal(ack.accepted, false);
    assert.deepEqual(calls, [0, 1, 0], "dispatch after close must perform no I/O");
  } finally {
    release();
    await builder.close();
  }
});

test("dispatch prefers the one chain-validated channel when its peer warmup failed", async () => {
  const sends: number[] = [];
  const builder = client("jet", channelFactory(async (channelIndex, value) => {
    const request = JSON.parse(value.body) as { method: string };
    if (request.method === "eth_chainId") {
      return {
        status: 200,
        body: channelIndex === 1
          ? '{"jsonrpc":"2.0","id":"warm","result":"0x38"}'
          : '{"jsonrpc":"2.0","id":"warm","result":"0x1"}',
      };
    }
    sends.push(channelIndex);
    return { status: 200, body: `{"jsonrpc":"2.0","id":1,"result":"0x${"ef".repeat(32)}"}` };
  }));
  try {
    await builder.prewarm();
    assert.equal(builder.isFresh(), true);
    const ack = await builder.dispatch(builder.prepare(intent({
      kind: "rawTx",
      hash: TARGET_HASH,
      raw: TARGET_RAW,
      requiredPredecessorRaws: [],
    })));
    assert.equal(ack.accepted, true);
    assert.deepEqual(sends, [1]);
  } finally {
    await builder.close();
  }
});

test("a target colliding with staggered heartbeat uses the other warm channel", async () => {
  const createdChannels: number[] = [];
  const calls: Array<{ channel: number; method: string }> = [];
  let blockHeartbeat = false;
  let heartbeatStarted!: () => void;
  const heartbeatAtChannelZero = new Promise<void>((resolve) => { heartbeatStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const factory: BuilderChannelFactory = (channelIndex) => {
    createdChannels.push(channelIndex);
    return {
      async request(value) {
        const request = JSON.parse(value.body) as { method: string; params: unknown[] };
        calls.push({ channel: channelIndex, method: request.method });
        if (request.method === "eth_chainId") {
          assert.deepEqual(request.params, []);
          assert.equal(value.body.includes("send"), false, "heartbeat must never invoke a send method");
          if (blockHeartbeat && channelIndex === 0) {
            heartbeatStarted();
            await gate;
          }
          return { status: 200, body: '{"jsonrpc":"2.0","id":"warm","result":"0x38"}' };
        }
        return { status: 200, body: `{"jsonrpc":"2.0","id":1,"result":"0x${"ef".repeat(32)}"}` };
      },
      close() {},
    };
  };
  const builder = client("jet", factory);
  try {
    await builder.prewarm();
    assert.deepEqual(createdChannels, [0, 1], "the client must own exactly two transports");
    assert.deepEqual(calls, [
      { channel: 0, method: "eth_chainId" },
      { channel: 1, method: "eth_chainId" },
    ]);

    blockHeartbeat = true;
    await within(heartbeatAtChannelZero, "staggered heartbeat");

    const ack = await builder.dispatch(builder.prepare(intent({
      kind: "rawTx",
      hash: TARGET_HASH,
      raw: TARGET_RAW,
      requiredPredecessorRaws: [],
    })));
    assert.equal(ack.accepted, true, "dispatch must finish before the blocked heartbeat is released");
    const sendCall = calls.findLast((call) => call.method === "eth_sendBundle");
    assert.deepEqual(sendCall, { channel: 1, method: "eth_sendBundle" },
      "a target colliding with channel 0 heartbeat must use already-warm channel 1");
    assert.deepEqual(createdChannels, [0, 1], "collision must never create an overflow cold channel");

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.notEqual(builder.snapshot().lastPrewarmMonoNs, null);
  } finally {
    release();
    await builder.close();
  }
});
