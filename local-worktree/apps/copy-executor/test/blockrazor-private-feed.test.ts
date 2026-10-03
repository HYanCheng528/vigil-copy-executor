import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  BLOCKRAZOR_PRIVATE_REGIONS,
  BlockRazorPrivateFirstSeenDeduper,
  BlockRazorPrivateMempoolFeed,
  SseDataDecoder,
  inspectBlockRazorPrivateBundle,
} from "../src/blockrazor-private-feed.js";
import { ED_TARGET_ADDRESS, isSourceVerifiedTargetSignal, type TargetSignal } from "../src/core/messages.js";
import { GMGN_ROUTER_ADDRESS, GMGN_SWAP_SELECTOR } from "../src/core/gmgn-calldata.js";

const TOKEN = "private-test-token-123";
const ED_TOPIC = `0x${"0".repeat(24)}${ED_TARGET_ADDRESS.slice(2).toLowerCase()}`;

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainID: "56",
    hash: `0x${"aa".repeat(32)}`,
    txs: [{
      hash: `0x${"bb".repeat(32)}`,
      from: ED_TARGET_ADDRESS,
      to: GMGN_ROUTER_ADDRESS,
      value: "0x01",
      nonce: 42,
      calldata: GMGN_SWAP_SELECTOR,
      functionSelector: GMGN_SWAP_SELECTOR,
      logs: [{
        address: GMGN_ROUTER_ADDRESS,
        topics: [
          "0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a",
          ED_TOPIC,
          ED_TOPIC,
          `0x${"0".repeat(64)}`,
        ],
        data: "0x",
      }],
    }],
    nextBlockNumber: 114_700_001,
    maxBlockNumber: 114_700_001,
    proxyBidContract: "0x74Ce839c6aDff544139f27C1257D34944B794605",
    refundAddress: "0x9abae1b279a4be25aeae49a33e807cdd3ccffa0c",
    refundCfg: 10_380_050,
    ...overrides,
  };
}

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server did not bind TCP");
  return { server, url: `http://127.0.0.1:${String(address.port)}/stream` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("official Private region stream and submit domains stay paired", () => {
  assert.deepEqual(BLOCKRAZOR_PRIVATE_REGIONS, {
    tokyo: {
      streamUrl: "https://jp-bscscutum.blockrazor.xyz/stream",
      submitUrl: "https://jp-bscscutum.blockrazor.xyz",
    },
    "new-york": {
      streamUrl: "https://us-bscscutum.blockrazor.xyz/stream",
      submitUrl: "https://us-bscscutum.blockrazor.xyz",
    },
    frankfurt: {
      streamUrl: "https://ger-bscscutum.blockrazor.xyz/stream",
      submitUrl: "https://ger-bscscutum.blockrazor.xyz",
    },
    dublin: {
      streamUrl: "https://ire-bscscutum.blockrazor.xyz/stream",
      submitUrl: "https://ire-bscscutum.blockrazor.xyz",
    },
  });
});

test("private disclosure validates every target field without inventing raw or gas", () => {
  const [match] = inspectBlockRazorPrivateBundle(bundle(), "tokyo");
  assert.ok(match);
  assert.equal(match.strategy, "ed");
  assert.equal(match.transaction.disclosure, "blockrazor_private");
  assert.equal("rawTransaction" in match.transaction, false);
  assert.equal("gasPriceWei" in match.transaction, false);
  assert.equal("gasLimit" in match.transaction, false);
  assert.equal(match.transaction.logCount, 1);
  assert.equal(match.bundle.bundleHash, `0x${"aa".repeat(32)}`);
  assert.equal(match.bundle.refundCfg, "10380050");
  assert.equal(match.bundle.logsVerified, true);
  assert.equal(match.bundle.routerSwapVerified, true);

  const badSelector = bundle();
  (badSelector.txs as Array<Record<string, unknown>>)[0]!.functionSelector = "0x12345678";
  assert.throws(() => inspectBlockRazorPrivateBundle(badSelector, "tokyo"), /functionSelector/);

  const missingLogs = bundle();
  delete (missingLogs.txs as Array<Record<string, unknown>>)[0]!.logs;
  assert.throws(() => inspectBlockRazorPrivateBundle(missingLogs, "tokyo"), /logs/);
  const spoofedReceiver = bundle();
  (spoofedReceiver.txs as Array<Record<string, unknown>>)[0]!.logs = [{
    address: GMGN_ROUTER_ADDRESS,
    topics: [
      "0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a",
      ED_TOPIC,
      `0x${"0".repeat(24)}${"12".repeat(20)}`,
    ],
    data: "0x",
  }];
  assert.throws(() => inspectBlockRazorPrivateBundle(spoofedReceiver, "tokyo"), /Router Swap log/);
  assert.throws(() => inspectBlockRazorPrivateBundle(bundle({ refundCfg: -1 }), "tokyo"), /refundCfg/);
});

test("bounded SSE decoder handles chunk splits, CRLF and multiline data", () => {
  const decoder = new SseDataDecoder();
  assert.deepEqual(decoder.push(": keepalive\r\ndata: {\"a\":"), []);
  assert.deepEqual(decoder.push("1,\r\ndata: \"b\":2}\r\n\r\n"), ['{\"a\":1,\n\"b\":2}']);
});

test("loopback SSE sends token only in Authorization and emits a branded private target", async () => {
  let requestUrl = "";
  let authorization = "";
  const loopback = await listen((request, response) => {
    requestUrl = request.url ?? "";
    authorization = String(request.headers.authorization ?? "");
    response.writeHead(200, { "content-type": "text/event-stream" });
    const payload = JSON.stringify(bundle());
    response.write("data: " + payload.slice(0, 40));
    response.write(payload.slice(40) + "\n\n");
  });
  let signal: TargetSignal | null = null;
  const feed = new BlockRazorPrivateMempoolFeed({
    name: "blockrazor-private-tokyo",
    region: "tokyo",
    streamUrl: loopback.url,
    token: TOKEN,
    connectTimeoutMs: 1_000,
    idleTimeoutMs: 5_000,
    onTarget: (value) => { signal = value; },
  }, { allowInsecureLoopback: true });
  try {
    feed.start();
    await until(() => signal !== null);
    assert.equal(requestUrl, "/stream");
    assert.ok(!requestUrl.includes(TOKEN));
    assert.equal(authorization, "Bearer " + TOKEN);
    assert.equal(signal!.source, "blockrazor_private_mempool");
    assert.equal(isSourceVerifiedTargetSignal(signal!), true);
    assert.equal(signal!.blockRazorPrivateBundle?.region, "tokyo");
    assert.equal(feed.snapshot().targetMatches, 1);
    assert.ok(!JSON.stringify(feed.snapshot()).includes(TOKEN));
  } finally {
    feed.stop();
    await close(loopback.server);
  }
});

test("multi-region feeds share first-wins dedupe and sanitize HTTP failures", async () => {
  const first = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: " + JSON.stringify(bundle()) + "\n\n");
  });
  let attempts = 0;
  const second = await listen((_request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("do not log " + TOKEN);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: " + JSON.stringify(bundle()) + "\n\n");
  });
  const deduper = new BlockRazorPrivateFirstSeenDeduper();
  let emitted = 0;
  const feeds = [
    new BlockRazorPrivateMempoolFeed({
      name: "blockrazor-private-tokyo",
      region: "tokyo",
      streamUrl: first.url,
      token: TOKEN,
      connectTimeoutMs: 1_000,
      idleTimeoutMs: 5_000,
      onTarget: () => { emitted += 1; },
    }, { allowInsecureLoopback: true, deduper }),
    new BlockRazorPrivateMempoolFeed({
      name: "blockrazor-private-dublin",
      region: "dublin",
      streamUrl: second.url,
      token: TOKEN,
      connectTimeoutMs: 1_000,
      idleTimeoutMs: 5_000,
      onTarget: () => { emitted += 1; },
    }, { allowInsecureLoopback: true, deduper }),
  ];
  try {
    for (const feed of feeds) feed.start();
    await until(() => feeds.reduce((sum, feed) => sum + feed.snapshot().notifications, 0) >= 2, 3_000);
    assert.equal(emitted, 1);
    assert.equal(feeds.reduce((sum, feed) => sum + feed.snapshot().duplicateTargets, 0), 1);
    assert.ok(feeds[1]!.snapshot().reconnects >= 1);
    assert.ok(!JSON.stringify(feeds.map((feed) => feed.snapshot())).includes(TOKEN));
  } finally {
    for (const feed of feeds) feed.stop();
    await Promise.all([close(first.server), close(second.server)]);
  }
});

test("production constructor rejects plaintext non-loopback streams", () => {
  assert.throws(() => new BlockRazorPrivateMempoolFeed({
    name: "unsafe",
    region: "tokyo",
    streamUrl: "http://example.test/stream",
    token: TOKEN,
    connectTimeoutMs: 1_000,
    idleTimeoutMs: 5_000,
    onTarget: () => undefined,
  }), /HTTPS/);
});
