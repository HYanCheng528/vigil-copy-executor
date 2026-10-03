import { type BuilderEndpointConfig } from "./builders.js";
import type { BlockRazorPrivateRegion, ExecutionMode, TargetStrategy } from "./core/messages.js";
import { HotSigner } from "./hot-signer.js";
export interface StrategyLaneConfig {
    strategy: TargetStrategy;
    label: string;
    enabled: boolean;
    signer: HotSigner | null;
    executorAddress: string | null;
    followAmountWei: bigint;
    builderTipWei: bigint;
    gasPriceWei: bigint;
    gasLimit: bigint;
    edMinReturnRetentionBps: number;
    allowZeroMinReturnInLive: boolean;
}
export interface CopyExecutorConfig {
    mode: ExecutionMode;
    liveConfirmed: boolean;
    fullPendingCostConfirmed: boolean;
    pendingWssUrls: string[];
    headWssUrls: string[];
    headReadyTimeoutMs: number;
    blockRazorPublicMempool: {
        enabled: boolean;
        plaintextTransportConfirmed: boolean;
        name: string;
        endpoint: string;
        apiKey: string | null;
    };
    blockRazorPrivateMempool: {
        enabled: boolean;
        token: string | null;
        regions: BlockRazorPrivateRegion[];
        connectTimeoutMs: number;
        idleTimeoutMs: number;
        submitTimeoutMs: number;
        prewarmIntervalMs: number;
    };
    httpRpcUrl: string | null;
    /** Preferred, read-only position RPCs. The executor RPC is only a fallback. */
    positionHttpRpcUrls?: string[];
    positionRpcTimeoutMs?: number;
    host: string;
    port: number;
    riskLedgerPath: string | null;
    armFilePath: string | null;
    controlBearerToken?: string | null;
    runtimeSettingsPath?: string | null;
    positionLedgerPath?: string | null;
    positionReconcileIntervalMs?: number;
    positionReconcileConcurrency?: number;
    builders: BuilderEndpointConfig[];
    lanes: Record<TargetStrategy, StrategyLaneConfig>;
}
type Env = Record<string, string | undefined>;
export declare function loadConfig(env?: Env): CopyExecutorConfig;
export {};
