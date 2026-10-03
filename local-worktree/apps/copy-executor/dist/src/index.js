import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { CopyExecutionEngine } from "./engine.js";
import { DetachedMachineDispatchNotifier } from "./machine-dispatch-notifier.js";
import { startStatusServer } from "./status-server.js";
function closeStatusServer(server) {
    if (!server.listening)
        return Promise.resolve();
    return new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
            if (error)
                rejectClose(error);
            else
                resolveClose();
        });
    });
}
export async function startExecutorRuntime(dependencies = {}) {
    const config = (dependencies.loadConfig ?? loadConfig)();
    const engine = (dependencies.createEngine ?? ((value) => new CopyExecutionEngine(value, value.mode === "live" && value.controlBearerToken
        ? new DetachedMachineDispatchNotifier({ bearerToken: value.controlBearerToken })
        : null)))(config);
    const startServer = dependencies.startStatusServer ?? startStatusServer;
    let server = null;
    let startupComplete = false;
    try {
        await engine.start();
        server = await startServer(engine, config.host, config.port, config.controlBearerToken ?? null);
        startupComplete = true;
    }
    finally {
        // A bind/listen failure happens after the engine has opened its feeds. It
        // must therefore use the same shutdown path instead of leaking a live
        // executor with no status endpoint or signal handlers.
        if (!startupComplete)
            await engine.stop();
    }
    if (!server)
        throw new Error("status server did not return a listening server");
    const runningServer = server;
    let stopPromise = null;
    return {
        engine,
        server: runningServer,
        stop() {
            if (stopPromise)
                return stopPromise;
            // Calling engine.stop() synchronously closes its broadcast latch before
            // status-server shutdown or any await can yield to a planner.
            const engineStop = engine.stop();
            const serverStop = closeStatusServer(runningServer);
            stopPromise = (async () => {
                const results = await Promise.allSettled([engineStop, serverStop]);
                const failures = results
                    .filter((result) => result.status === "rejected")
                    .map((result) => result.reason);
                if (failures.length > 0)
                    throw new AggregateError(failures, "executor shutdown failed");
            })();
            return stopPromise;
        },
    };
}
function waitForShutdownSignal() {
    return new Promise((resolveSignal) => {
        const finish = (signal) => {
            process.off("SIGTERM", onSigterm);
            process.off("SIGINT", onSigint);
            resolveSignal(signal);
        };
        const onSigterm = () => finish("SIGTERM");
        const onSigint = () => finish("SIGINT");
        process.once("SIGTERM", onSigterm);
        process.once("SIGINT", onSigint);
    });
}
async function main() {
    let runtime = null;
    let signal = null;
    try {
        runtime = await startExecutorRuntime();
        signal = await waitForShutdownSignal();
    }
    finally {
        await runtime?.stop();
    }
    process.stdout.write(JSON.stringify({
        type: "executor_stopped",
        at: new Date().toISOString(),
        signal,
    }) + "\n");
}
export function isExecutorEntryPoint(moduleUrl, argvEntry) {
    if (!argvEntry)
        return false;
    try {
        return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argvEntry));
    }
    catch {
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
//# sourceMappingURL=index.js.map