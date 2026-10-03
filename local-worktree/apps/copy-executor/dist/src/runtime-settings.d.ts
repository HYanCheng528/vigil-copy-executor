import type { StrategyLaneConfig } from "./config.js";
import type { TargetStrategy } from "./core/messages.js";
export interface RuntimeLaneSettings {
    followAmountWei: bigint;
    gasPriceWei: bigint;
    builderTipWei: bigint;
}
export interface RuntimeLaneUpdate {
    strategy: TargetStrategy;
    followAmountBnb: string;
    gasPriceGwei: string;
    builderTipBnb: string;
}
export declare class RuntimeSettingsError extends Error {
    readonly code: "invalid_value" | "persistence_unavailable";
    constructor(code: "invalid_value" | "persistence_unavailable", message: string);
}
export interface RuntimeSettingsDependencies {
    writeDocument?: (path: string, contents: string) => Promise<void>;
    now?: () => Date;
}
export declare class RuntimeSettingsStore {
    private readonly path;
    private readonly lanes;
    private current;
    private updatedAt;
    private writes;
    private readonly writeDocument;
    private readonly now;
    constructor(path: string | null, lanes: Record<TargetStrategy, StrategyLaneConfig>, dependencies?: RuntimeSettingsDependencies);
    get writable(): boolean;
    lane(strategy: TargetStrategy): RuntimeLaneSettings;
    load(): Promise<void>;
    update(request: RuntimeLaneUpdate): Promise<void>;
    snapshot(): Record<string, unknown>;
    private defaults;
    private parseLaneDocument;
    private timestamp;
    private persist;
}
