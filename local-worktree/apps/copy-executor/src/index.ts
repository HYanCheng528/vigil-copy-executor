import type { Server } from "node:http";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, type CopyExecutorConfig } from "./config.js";
import { CopyExecutionEngine } from "./engine.js";
import { DetachedMachineDispatchNotifier } from "./machine-dispatch-notifier.js";
import { startStatusServer } from "./status-server.js";

export interface ExecutorRuntimeDependencies {
  loadConfig?: () => CopyExecutorConfig;
  createEngine?: (config: CopyExecutorConfig) => CopyExecutionEngine;
  startStatusServer?: typeof startStatusServer;
}

export interface ExecutorRuntime {
  engine: CopyExecutionEngine;
  server: Server;
  stop(): Promise<void>;
}

function closeStatusServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

export async function startExecutorRuntime(
  dependencies: ExecutorRuntimeDependencies = {},
): Promise<ExecutorRuntime> {
  const config = (dependencies.loadConfig ?? loadConfig)();
  const engine = (dependencies.createEngine ?? ((value) => new CopyExecutionEngine(
    value,
    value.mode === "live" && value.controlBearerToken
      ? new DetachedMachineDispatchNotifier({ bearerToken: value.controlBearerToken })
      : null,
  )))(config);
  const startServer = dependencies.startStatusServer ?? startStatusServer;
  let server: Server | null = null;
  let startupComplete = false;

  try {
    await engine.start();
    server = await startServer(engine, config.host, config.port, config.controlBearerToken ?? null);
    startupComplete = true;
  } finally {
    // A bind/listen failure happens after the engine has opened its feeds. It
    // must therefore use the same shutdown path instead of leaking a live
    // executor with no status endpoint or signal handlers.
    if (!startupComplete) await engine.stop();
  }

  if (!server) throw new Error("status server did not return a listening server");
  const runningServer = server;
  let stopPromise: Promise<void> | null = null;
  return {
    engine,
    server: runningServer,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      // Calling engine.stop() synchronously closes its broadcast latch before
      // status-server shutdown or any await can yield to a planner.
      const engineStop = engine.stop();
      const serverStop = closeStatusServer(runningServer);
      stopPromise = (async () => {
        const results = await Promise.allSettled([engineStop, serverStop]);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length > 0) throw new AggregateError(failures, "executor shutdown failed");
      })();
      return stopPromise;
    },
  };
}

function waitForShutdownSignal(): Promise<"SIGTERM" | "SIGINT"> {
  return new Promise((resolveSignal) => {
    const finish = (signal: "SIGTERM" | "SIGINT"): void => {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      resolveSignal(signal);
    };
    const onSigterm = (): void => finish("SIGTERM");
    const onSigint = (): void => finish("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
  });
}

async function main(): Promise<void> {
  let runtime: ExecutorRuntime | null = null;
  let signal: "SIGTERM" | "SIGINT" | null = null;
  try {
    runtime = await startExecutorRuntime();
    signal = await waitForShutdownSignal();
  } finally {
    await runtime?.stop();
  }
  process.stdout.write(JSON.stringify({
    type: "executor_stopped",
    at: new Date().toISOString(),
    signal,
  }) + "\n");
}

export function isExecutorEntryPoint(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argvEntry));
  } catch {
    return moduleUrl === pathToFileURL(resolve(argvEntry)).href;
  }
}

const entryPath = process.argv[1];
if (isExecutorEntryPoint(import.meta.url, entryPath)) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({
      type: "executor_start_failed",
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }) + "\n");
    process.exitCode = 1;
  });
}
