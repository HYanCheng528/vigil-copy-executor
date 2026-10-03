import type { TargetStrategy } from "./core/messages.js";
export declare const DEFAULT_MACHINE_DISPATCH_ENDPOINT = "http://127.0.0.1:8766/internal/machine-dispatch";
export interface MachineDispatchNotice {
    version: 1;
    strategy: TargetStrategy;
    targetHash: string;
    dispatchedAt: string;
}
export interface MachineDispatchNotifierSnapshot {
    queued: number;
    inFlight: number;
    accepted: number;
    delivered: number;
    failed: number;
    dropped: number;
    duplicates: number;
    invalid: number;
    closed: boolean;
}
export interface DetachedMachineDispatchNotifierOptions {
    endpoint?: string;
    bearerToken: string;
    capacity?: number;
    concurrency?: number;
    requestTimeoutMs?: number;
    seenCapacity?: number;
    fetchImpl?: typeof fetch;
    now?: () => string;
}
/**
 * A lossy, detached notification sidecar for the first real Builder dispatch.
 *
 * `afterBuilderDispatchStarted` only performs bounded in-memory work. JSON
 * timestamping, serialization and loopback fetch are deferred to `setImmediate`, so a slow,
 * unauthenticated or unavailable relay can only drop speech telemetry and can
 * never become part of the Builder write path.
 */
export declare class DetachedMachineDispatchNotifier {
    private readonly endpoint;
    private readonly bearerToken;
    private readonly capacity;
    private readonly concurrency;
    private readonly requestTimeoutMs;
    private readonly seenCapacity;
    private readonly fetchImpl;
    private readonly now;
    private readonly queue;
    private readonly inFlight;
    private readonly seen;
    private pumpScheduled;
    private closed;
    private accepted;
    private delivered;
    private failed;
    private dropped;
    private duplicates;
    private invalid;
    constructor(options: DetachedMachineDispatchNotifierOptions);
    /**
     * Call immediately after `builder.dispatch(prepared)` returns its Promise.
     * It is safe to call once per Builder candidate: strategy+targetHash dedupe
     * ensures only the first started dispatch schedules a notification.
     */
    afterBuilderDispatchStarted(strategy: TargetStrategy, targetHash: string): void;
    snapshot(): MachineDispatchNotifierSnapshot;
    stop(): Promise<void>;
    private remember;
    private schedulePump;
    private pump;
    private deliver;
}
