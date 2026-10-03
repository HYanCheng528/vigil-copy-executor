import { type Server } from "node:http";
import { type CopyExecutionEngine } from "./engine.js";
export declare function startStatusServer(engine: CopyExecutionEngine, host: string, port: number, controlBearerToken?: string | null): Promise<Server>;
