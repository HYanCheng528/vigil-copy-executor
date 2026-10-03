import type { Server } from "node:http";
import { type CopyExecutorConfig } from "./config.js";
import { CopyExecutionEngine } from "./engine.js";
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
export declare function startExecutorRuntime(dependencies?: ExecutorRuntimeDependencies): Promise<ExecutorRuntime>;
export declare function isExecutorEntryPoint(moduleUrl: string, argvEntry: string | undefined): boolean;
