import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MACHINE_DISPATCH_ENDPOINT,
  DetachedMachineDispatchNotifier,
} from "../src/machine-dispatch-notifier.js";

const TOKEN = "n".repeat(48);
const HASH = `0x${"12".repeat(32)}`;

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("machine dispatch notification is detached from the caller and deduplicated", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const notifier = new DetachedMachineDispatchNotifier({
    endpoint: "http://127.0.0.1:8787/internal/machine-dispatch",
    bearerToken: TOKEN,
    now: () => "2026-08-09T10:00:00.000Z",
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });

  notifier.afterBuilderDispatchStarted("ed", HASH.toUpperCase().replace("0X", "0x"));
  notifier.afterBuilderDispatchStarted("ed", HASH);
  assert.equal(requests.length, 0, "the hot-path call must not start fetch synchronously");

  await tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "http://127.0.0.1:8787/internal/machine-dispatch");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    version: 1,
    strategy: "ed",
    targetHash: HASH,
    dispatchedAt: "2026-08-09T10:00:00.000Z",
  });
  assert.deepEqual(notifier.snapshot(), {
    queued: 0,
    inFlight: 0,
    accepted: 1,
    delivered: 1,
    failed: 0,
    dropped: 0,
    duplicates: 1,
    invalid: 0,
    closed: false,
  });
  await notifier.stop();
});

test("queue overflow, auth failure and transport failure only drop notification work", async () => {
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const notifier = new DetachedMachineDispatchNotifier({
    endpoint: "http://localhost:8787/internal/machine-dispatch",
    bearerToken: TOKEN,
    capacity: 2,
    concurrency: 1,
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) {
        await first;
        return new Response(null, { status: 401 });
      }
      throw new Error("relay offline");
    }) as typeof fetch,
  });

  assert.doesNotThrow(() => notifier.afterBuilderDispatchStarted("ed", HASH));
  await tick();
  assert.equal(notifier.snapshot().inFlight, 1);
  assert.doesNotThrow(() => notifier.afterBuilderDispatchStarted("kuzuo", HASH));
  assert.doesNotThrow(() => notifier.afterBuilderDispatchStarted("ed", `0x${"34".repeat(32)}`));
  assert.equal(notifier.snapshot().dropped, 1, "capacity includes queued and in-flight work");

  releaseFirst();
  await tick();
  await tick();
  assert.equal(notifier.snapshot().failed, 2);
  assert.equal(notifier.snapshot().delivered, 0);

  // Overflow does not poison dedupe: another Builder for that target may retry
  // after capacity becomes available.
  notifier.afterBuilderDispatchStarted("ed", `0x${"34".repeat(32)}`);
  await tick();
  assert.equal(calls, 3);
  assert.equal(notifier.snapshot().failed, 3);
  await notifier.stop();
});

test("invalid calls and stopped notifier never throw or perform network work", async () => {
  let calls = 0;
  const notifier = new DetachedMachineDispatchNotifier({
    endpoint: "http://[::1]:8787/internal/machine-dispatch",
    bearerToken: TOKEN,
    fetchImpl: (async () => {
      calls += 1;
      return new Response(null, { status: 202 });
    }) as typeof fetch,
    now: () => { throw new Error("clock unavailable"); },
  });

  assert.doesNotThrow(() => notifier.afterBuilderDispatchStarted("ed", "0xbad"));
  assert.doesNotThrow(() => notifier.afterBuilderDispatchStarted("ed", HASH));
  await tick();
  await notifier.stop();
  assert.doesNotThrow(() => notifier.afterBuilderDispatchStarted("ed", `0x${"56".repeat(32)}`));
  await tick();
  assert.equal(calls, 0);
  assert.equal(notifier.snapshot().invalid, 1);
  assert.equal(notifier.snapshot().failed, 1);
  assert.equal(notifier.snapshot().dropped, 1);
});

test("production default points at the relay's injected loopback port 8766", async () => {
  const requests: string[] = [];
  const notifier = new DetachedMachineDispatchNotifier({
    bearerToken: TOKEN,
    fetchImpl: (async (url) => {
      requests.push(String(url));
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });
  notifier.afterBuilderDispatchStarted("ed", HASH);
  await tick();
  assert.equal(DEFAULT_MACHINE_DISPATCH_ENDPOINT, "http://127.0.0.1:8766/internal/machine-dispatch");
  assert.deepEqual(requests, [DEFAULT_MACHINE_DISPATCH_ENDPOINT]);
  await notifier.stop();
});

test("notifier rejects non-loopback endpoints and weak bearer credentials", () => {
  assert.throws(() => new DetachedMachineDispatchNotifier({
    endpoint: "https://example.com/internal/machine-dispatch",
    bearerToken: TOKEN,
  }), /loopback/);
  assert.throws(() => new DetachedMachineDispatchNotifier({
    endpoint: "http://127.0.0.1:8787/internal/machine-dispatch",
    bearerToken: "short",
  }), /bearer token/);
});
