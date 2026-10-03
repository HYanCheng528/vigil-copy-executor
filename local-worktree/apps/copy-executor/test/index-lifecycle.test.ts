import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { CopyExecutorConfig } from "../src/config.js";
import type { CopyExecutionEngine } from "../src/engine.js";
import { isExecutorEntryPoint, startExecutorRuntime } from "../src/index.js";

function runtimeConfig(): CopyExecutorConfig {
  return { host: "127.0.0.1", port: 8770 } as CopyExecutorConfig;
}

test("entrypoint detection resolves the atomic current-release symlink", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "copy-executor-entry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const releaseEntry = join(directory, "release-index.js");
  const currentEntry = join(directory, "current-index.js");
  writeFileSync(releaseEntry, "export {};\n", "utf8");
  try {
    symlinkSync(releaseEntry, currentEntry, "file");
  } catch (error) {
    if (process.platform === "win32") {
      t.skip("Windows symlink creation needs Developer Mode or elevated privileges");
      return;
    }
    throw error;
  }
  assert.equal(isExecutorEntryPoint(pathToFileURL(releaseEntry).href, currentEntry), true);
  assert.equal(isExecutorEntryPoint(pathToFileURL(releaseEntry).href, join(directory, "other.js")), false);
});

test("status-server startup failure always stops the already-started engine", async () => {
  const events: string[] = [];
  const engine = {
    async start() { events.push("engine:start"); },
    async stop() { events.push("engine:stop"); },
    snapshot() { return {}; },
  } as unknown as CopyExecutionEngine;

  await assert.rejects(startExecutorRuntime({
    loadConfig: runtimeConfig,
    createEngine: () => engine,
    startStatusServer: async () => {
      events.push("status:start");
      throw new Error("injected listen failure");
    },
  }), /injected listen failure/);

  assert.deepEqual(events, ["engine:start", "status:start", "engine:stop"]);
});

test("runtime stop closes the engine latch first, waits for both paths, and is idempotent", async () => {
  const events: string[] = [];
  let releaseEngineStop!: () => void;
  const engineStopGate = new Promise<void>((resolveStop) => { releaseEngineStop = resolveStop; });
  let releaseServerStop!: () => void;
  const serverStopGate = new Promise<void>((resolveStop) => { releaseServerStop = resolveStop; });
  const engine = {
    async start() { events.push("engine:start"); },
    stop() {
      events.push("engine:stop");
      return engineStopGate;
    },
    snapshot() { return {}; },
  } as unknown as CopyExecutionEngine;
  const server = {
    listening: true,
    close(callback: (error?: Error) => void) {
      events.push("status:close");
      void serverStopGate.then(() => callback());
      return this;
    },
  } as unknown as Server;

  const runtime = await startExecutorRuntime({
    loadConfig: runtimeConfig,
    createEngine: () => engine,
    startStatusServer: async () => server,
  });
  const firstStop = runtime.stop();
  const secondStop = runtime.stop();

  assert.equal(firstStop, secondStop);
  assert.deepEqual(events, ["engine:start", "engine:stop", "status:close"]);
  let resolved = false;
  void firstStop.then(() => { resolved = true; });
  releaseEngineStop();
  await Promise.resolve();
  assert.equal(resolved, false, "shutdown must also wait for status-server close");
  releaseServerStop();
  await firstStop;
  assert.equal(resolved, true);
  assert.equal(events.filter((event) => event === "engine:stop").length, 1);
  assert.equal(events.filter((event) => event === "status:close").length, 1);
});
