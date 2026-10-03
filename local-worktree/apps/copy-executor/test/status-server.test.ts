import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { CopyExecutionEngine } from "../src/engine.js";
import { startStatusServer } from "../src/status-server.js";

const HASH = `0x${"11".repeat(32)}`;
const BLOCK_HASH = `0x${"22".repeat(32)}`;
const ED = "0xc2c6acd377458010713e733e1b21dd6f670d091c";

test("status serializes nested Builder timing bigint values without terminating the server", async () => {
  const engine = {
    snapshot: () => ({
      ok: true,
      activeRaces: [{ targetHash: HASH, validUntilBlock: 114879361 }],
      builders: [{
        name: "club48",
        lastAck: { startedMonoNs: 1n, responseMonoNs: 2n },
      }],
    }),
  } as unknown as CopyExecutionEngine;
  const server = await startStatusServer(engine, "127.0.0.1", 0);
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(address.port)}`;
  try {
    const status = await fetch(base + "/status");
    assert.equal(status.status, 200);
    const body = await status.json() as {
      activeRaces: Array<{ validUntilBlock: number }>;
      builders: Array<{ lastAck: { startedMonoNs: string; responseMonoNs: string } }>;
    };
    assert.equal(body.activeRaces[0]?.validUntilBlock, 114879361);
    assert.deepEqual(body.builders[0]?.lastAck, { startedMonoNs: "1", responseMonoNs: "2" });

    // A second request proves the first serialization did not crash/close the
    // status server, matching the production polling pattern.
    const health = await fetch(base + "/health");
    assert.equal(health.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("an unserializable snapshot returns a controlled error and leaves the server alive", async () => {
  const circular: Record<string, unknown> = { ok: true };
  circular.self = circular;
  let calls = 0;
  const engine = {
    snapshot: () => (++calls === 1 ? circular : { ok: true }),
  } as unknown as CopyExecutionEngine;
  const server = await startStatusServer(engine, "127.0.0.1", 0);
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(address.port)}`;
  try {
    const failedStatus = await fetch(base + "/status");
    assert.equal(failedStatus.status, 500);
    assert.deepEqual(await failedStatus.json(), { error: "serialization_failed" });

    const health = await fetch(base + "/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok: boolean }).ok, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a throwing snapshot returns a controlled error and leaves the server alive", async () => {
  let calls = 0;
  const engine = {
    snapshot: () => {
      if (++calls === 1) throw new Error("fixture snapshot failure");
      return { ok: true };
    },
  } as unknown as CopyExecutionEngine;
  const server = await startStatusServer(engine, "127.0.0.1", 0);
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(address.port)}`;
  try {
    const failedStatus = await fetch(base + "/status");
    assert.equal(failedStatus.status, 500);
    assert.deepEqual(await failedStatus.json(), { error: "snapshot_failed" });

    const health = await fetch(base + "/health");
    assert.equal(health.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("loopback confirmed-target endpoint claims once and returns before hydration", async () => {
  const hints: unknown[] = [];
  let claimed = false;
  const engine = {
    snapshot: () => ({ ok: true }),
    acceptConfirmedTargetHint(hint: unknown) {
      hints.push(hint);
      if (claimed) return false;
      claimed = true;
      return true;
    },
  } as unknown as CopyExecutionEngine;
  const server = await startStatusServer(engine, "127.0.0.1", 0);
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(address.port)}/internal/confirmed-target`;
  const body = {
    version: 1,
    strategy: "ed",
    txHash: HASH,
    payer: ED,
    blockNumber: 123,
    blockHash: BLOCK_HASH,
    logIndex: 9,
    observedUnixNs: (BigInt(Date.now()) * 1_000_000n).toString(),
  };

  try {
    const first = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const duplicate = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 202);
    assert.equal(duplicate.status, 409);
    assert.equal(hints.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("confirmed-target endpoint rejects non-JSON and oversized input", async () => {
  const engine = {
    snapshot: () => ({ ok: true }),
    acceptConfirmedTargetHint: () => true,
  } as unknown as CopyExecutionEngine;
  const server = await startStatusServer(engine, "127.0.0.1", 0);
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(address.port)}/internal/confirmed-target`;
  try {
    const wrongType = await fetch(url, { method: "POST", body: "{}" });
    const oversized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(3_000) }),
    }).catch(() => null);
    assert.equal(wrongType.status, 415);
    // Destroying the oversized request can surface as either a controlled 400
    // or a client-side socket close; neither reaches the engine.
    if (oversized) assert.equal(oversized.status, 413);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("control and position snapshots require Bearer and control bodies are exact", async () => {
  const calls: unknown[] = [];
  const token = "status-test-control-token-0123456789";
  const engine = {
    snapshot: () => ({ ok: true }),
    controlSnapshot: () => ({ enabled: false, mode: "live", armed: false, writable: true, updatedAt: null, lanes: [] }),
    positionsSnapshot: () => ({ positions: [] }),
    acceptConfirmedTargetHint: () => true,
    enableLive: async (confirmation: string) => { calls.push(["enable", confirmation]); },
    disableLive: async () => { calls.push(["disable"]); },
    updateRuntimeLane: async (request: unknown) => { calls.push(["update", request]); },
  } as unknown as CopyExecutionEngine;
  const server = await startStatusServer(engine, "127.0.0.1", 0, token);
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(address.port)}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    assert.equal((await fetch(base + "/control")).status, 401);
    const control = await fetch(base + "/control", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(control.status, 200);
    assert.equal((await control.json() as { enabled: boolean }).enabled, false);
    assert.equal((await fetch(base + "/positions", { headers: { authorization: `Bearer ${token}` } })).status, 200);

    const invalid = await fetch(base + "/internal/control", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "disable", extra: true }),
    });
    assert.equal(invalid.status, 400);
    const update = await fetch(base + "/internal/control", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "update_lane",
        strategy: "ed",
        followAmountBnb: "0.01",
        gasPriceGwei: "1.5",
        builderTipBnb: "0.001",
      }),
    });
    assert.equal(update.status, 200);
    assert.deepEqual(calls, [["update", {
      strategy: "ed",
      followAmountBnb: "0.01",
      gasPriceGwei: "1.5",
      builderTipBnb: "0.001",
    }]]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
