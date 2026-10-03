import type { CopyExecutorConfig } from "./config.js";
import { type ConfirmedTargetHint } from "./core/messages.js";
import { type RuntimeLaneUpdate } from "./runtime-settings.js";
import type { DetachedMachineDispatchNotifier } from "./machine-dispatch-notifier.js";
export declare class ExecutorControlError extends Error {
    readonly code: "mode_forbidden" | "invalid_confirmation" | "not_ready" | "stopped" | "persistence_failed" | "stale_request" | "invalid_value";
    constructor(code: "mode_forbidden" | "invalid_confirmation" | "not_ready" | "stopped" | "persistence_failed" | "stale_request" | "invalid_value", message: string);
}
export declare class CopyExecutionEngine {
    readonly config: CopyExecutorConfig;
    private readonly dispatchNotifier;
    private readonly telemetry;
    private readonly armGate;
    private readonly globalLedger;
    /** Ed-lane compatibility alias for focused tests; production logic uses lane.ledger. */
    private readonly ledger;
    private readonly rpc;
    private readonly builders;
    private readonly privateBuilders;
    private readonly lanes;
    private readonly runtimeSettings;
    private readonly positionLedger;
    private readonly bootstrapFeeds;
    private readonly targetFeeds;
    private readonly feeds;
    private readonly feedMetrics;
    private readonly activeRaces;
    /** Own raws can echo back after a race settles; keep them through a generous block horizon. */
    private readonly recentOwnHashes;
    private readonly seenTargets;
    private readonly confirmedHintClaims;
    private readonly recentEvents;
    private readonly headReadyWaiters;
    private readonly plannerPromises;
    private readonly reconciliationPromises;
    private latestHead;
    private resyncTimer;
    private stopped;
    private broadcastClosed;
    private stopPromise;
    private circuitBroken;
    private circuitReason;
    private liveControlEpoch;
    constructor(config: CopyExecutorConfig, dispatchNotifier?: DetachedMachineDispatchNotifier | null);
    start(): Promise<void>;
    stop(): Promise<void>;
    snapshot(): Record<string, unknown>;
    controlSnapshot(): Record<string, unknown>;
    positionsSnapshot(): Record<string, unknown>;
    enableLive(confirmation: string): Promise<void>;
    disableLive(): Promise<void>;
    updateRuntimeLane(request: RuntimeLaneUpdate): Promise<void>;
    private initializeLanes;
    /**
     * Tip transfers are target-independent. Keep the three provider variants
     * signed for the lane's next N+1 nonce so a target arrival only signs one
     * common GMGN buy transaction.
     */
    private refreshPublicTipCache;
    private publicTipFor;
    private handleTarget;
    private handleCopyWalletPending;
    private rememberOwnHash;
    private suppressUnsentWork;
    private queueKey;
    private enqueueTarget;
    private scheduleQueueDrain;
    private drainQueue;
    /**
     * Loopback-only ingress used by the monitor's already-filtered Router log.
     * It claims synchronously, then hydrates and plans without awaiting the HTTP
     * request handler, DB, browser fan-out, metadata, or another wallet lane.
     */
    acceptConfirmedTargetHint(hint: ConfirmedTargetHint): boolean;
    private hydrateConfirmedTarget;
    private planTarget;
    /**
     * Queue durable accounting as soon as the first Builder write starts. The
     * promise continuation cannot run until this synchronous planning stack has
     * invoked the remaining eligible Builders, so reserveAttempt's validation,
     * cloning and JSON serialization never block the three-way fanout. Hashes are
     * collected inside that continuation so it sees every candidate prepared by
     * the current fanout. A failure trips only this lane; restart reconciliation
     * also treats an untracked pending nonce as terminal.
     */
    private deferRiskReservation;
    private feedIsActionable;
    private authorityHeadFreshness;
    private builderIsFresh;
    private routeReadiness;
    /** Final synchronous gate immediately before every real Builder call. */
    private canBroadcast;
    private cancelBeforeBroadcast;
    private skipBuilderRoute;
    private handleHead;
    private handleAck;
    private checkRace;
    private reconcileRace;
    private finishIncludedRace;
    private markRaceUnresolved;
    private reconcilePersistedLane;
    private orderingAccepted;
    private resynchronizeNeededLanes;
    private resynchronizeNeededLanesInner;
    private resynchronizeLane;
    private refreshLaneNonceAtHead;
    private reconcileLaneBeforeEnable;
    private worstCost;
    private assertLivePublicBuilderSet;
    private validateLaneIsolation;
    private globalRiskLedgerIdentity;
    private laneRiskLedgerIdentity;
    private reject;
    private breakCircuit;
    private breakCircuitPersistent;
    private breakLaneCircuit;
    private breakLaneCircuitPersistent;
    private trackPromise;
    private waitForTrackedWork;
    private emit;
    private waitForInitialHead;
    private pruneSeenTargets;
}
