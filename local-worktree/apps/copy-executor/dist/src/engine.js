import { formatEther, getAddress } from "ethers";
import { ArmGate } from "./arm-gate.js";
import { BlockRazorPublicMempoolFeed, } from "./blockrazor-public-feed.js";
import { BLOCKRAZOR_PRIVATE_REGIONS, BlockRazorPrivateFirstSeenDeduper, BlockRazorPrivateMempoolFeed, } from "./blockrazor-private-feed.js";
import { BuilderClient, DEFAULT_BUILDERS, } from "./builders.js";
import { fastGmgnBuyTemplate, finalTokenFromGmgnCalldata, rewriteGmgnSwapCalldata } from "./core/gmgn-calldata.js";
import { brandSourceVerifiedTargetSignal, ED_TARGET_ADDRESS, isSourceVerifiedTargetSignal, isBlockRazorPrivateTransaction, KUZUO_TARGET_ADDRESS, validateTargetSignal, } from "./core/messages.js";
import { NonceLane } from "./core/nonce-lane.js";
import { DEFAULT_AUTHORITY_HEAD_MAX_TIMESTAMP_LAG_MS, FullPendingFeed, } from "./pending-feed.js";
import { ExecutorRpcClient } from "./rpc-client.js";
import { RiskLedger, riskAttemptKey, riskLedgerPaths, } from "./risk-ledger.js";
import { elapsedMs, TelemetryBuffer } from "./telemetry.js";
import { PositionLedger } from "./position-ledger.js";
import { PositionRpcReader } from "./position-rpc.js";
import { RuntimeSettingsError, RuntimeSettingsStore, } from "./runtime-settings.js";
const SHADOW_EXECUTOR = "0x000000000000000000000000000000000000dEaD";
const BSC_CHAIN_ID = 56;
const RECEIPT_FINALITY_BLOCKS = 2;
// Public Builder requests intentionally omit an application-level block
// deadline. Keep only a conservative internal horizon for nonce/risk cleanup,
// matching the documented current-block + 100 default shared by the routes.
const PUBLIC_BUILDER_DEFAULT_BLOCK_WINDOW = 100;
const MAX_RECENT_OWN_HASHES = 8_192;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
export class ExecutorControlError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function nowMsSince(monotonicNs) {
    return Number(process.hrtime.bigint() - monotonicNs) / 1e6;
}
function errorText(error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
function wait(milliseconds) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref();
    });
}
function sameCanonicalReceipt(left, right) {
    return left.transactionHash === right.transactionHash
        && left.blockHash === right.blockHash
        && left.blockNumber === right.blockNumber
        && left.transactionIndex === right.transactionIndex
        && left.status === right.status
        && left.gasUsed === right.gasUsed
        && left.effectiveGasPrice === right.effectiveGasPrice;
}
function canonicalTargetIdentity(signal) {
    const transaction = signal.transaction;
    return {
        strategy: signal.strategy,
        hash: transaction.hash.toLowerCase(),
        chainId: transaction.chainId,
        from: transaction.from.toLowerCase(),
        to: transaction.to.toLowerCase(),
        nonce: transaction.nonce,
        valueWei: BigInt(transaction.valueWei).toString(),
        input: transaction.input.toLowerCase(),
    };
}
function sameTargetIdentity(left, right) {
    return left.strategy === right.strategy
        && left.hash === right.hash
        && left.chainId === right.chainId
        && left.from === right.from
        && left.to === right.to
        && left.nonce === right.nonce
        && left.valueWei === right.valueWei
        && left.input === right.input;
}
function targetRaceKey(strategy, targetHash) {
    return strategy + ":" + targetHash.toLowerCase();
}
function targetReference(signal) {
    if (signal.source === "confirmed_log_fallback") {
        return signal.sourceBlockHint === undefined
            ? null
            : {
                kind: "confirmedNextBlock",
                targetHash: signal.transaction.hash,
                targetBlock: signal.sourceBlockHint,
            };
    }
    if (isBlockRazorPrivateTransaction(signal.transaction)) {
        const context = signal.blockRazorPrivateBundle;
        return context ? { kind: "blockrazorPrivateBundleHash", hash: context.bundleHash } : null;
    }
    const raw = signal.transaction.rawTransaction;
    if (!raw)
        return null;
    return {
        kind: "rawTx",
        hash: signal.transaction.hash,
        raw,
        requiredPredecessorRaws: (signal.requiredPredecessors ?? [])
            .map((transaction) => transaction.rawTransaction)
            .filter((value) => Boolean(value)),
    };
}
export class CopyExecutionEngine {
    config;
    dispatchNotifier;
    telemetry = new TelemetryBuffer();
    armGate;
    globalLedger;
    /** Ed-lane compatibility alias for focused tests; production logic uses lane.ledger. */
    ledger;
    rpc;
    builders;
    privateBuilders = new Map();
    lanes;
    runtimeSettings;
    positionLedger;
    bootstrapFeeds;
    targetFeeds;
    feeds;
    feedMetrics = new Map();
    activeRaces = new Map();
    /** Own raws can echo back after a race settles; keep them through a generous block horizon. */
    recentOwnHashes = new Map();
    seenTargets = new Map();
    confirmedHintClaims = new Set();
    recentEvents = [];
    headReadyWaiters = new Set();
    plannerPromises = new Set();
    reconciliationPromises = new Set();
    latestHead = null;
    resyncTimer = null;
    stopped = true;
    broadcastClosed = true;
    stopPromise = null;
    circuitBroken = false;
    circuitReason = null;
    liveControlEpoch = 0;
    constructor(config, dispatchNotifier = null) {
        this.config = config;
        this.dispatchNotifier = dispatchNotifier;
        this.armGate = new ArmGate(config.armFilePath, config.mode === "live");
        const ledgerPaths = config.riskLedgerPath ? riskLedgerPaths(config.riskLedgerPath) : null;
        this.globalLedger = new RiskLedger(ledgerPaths?.global ?? null);
        const edLedger = new RiskLedger(ledgerPaths?.ed ?? null);
        const kuzuoLedger = new RiskLedger(ledgerPaths?.kuzuo ?? null);
        this.ledger = edLedger;
        this.rpc = config.httpRpcUrl ? new ExecutorRpcClient(config.httpRpcUrl) : null;
        this.builders = config.builders.map((builder) => new BuilderClient(builder));
        this.lanes = {
            ed: {
                config: config.lanes.ed,
                nonce: new NonceLane("ed-copy-wallet"),
                ledger: edLedger,
                circuitBroken: false,
                circuitReason: null,
                lastError: null,
                publicTipCache: new Map(),
                queuedTargets: new Map(),
                drainingQueue: false,
                nonceRefreshPromise: null,
                lastNonceRefreshHead: null,
            },
            kuzuo: {
                config: config.lanes.kuzuo,
                nonce: new NonceLane("kuzuo-copy-wallet"),
                ledger: kuzuoLedger,
                circuitBroken: false,
                circuitReason: null,
                lastError: null,
                publicTipCache: new Map(),
                queuedTargets: new Map(),
                drainingQueue: false,
                nonceRefreshPromise: null,
                lastNonceRefreshHead: null,
            },
        };
        this.runtimeSettings = new RuntimeSettingsStore(config.runtimeSettingsPath ?? null, config.lanes);
        const positionRpcUrls = config.positionHttpRpcUrls ?? [];
        const positionReader = config.positionLedgerPath && (positionRpcUrls.length > 0 || config.httpRpcUrl)
            ? new PositionRpcReader(positionRpcUrls, config.httpRpcUrl, config.positionRpcTimeoutMs ?? 1_500, config.positionReconcileConcurrency ?? 4)
            : null;
        this.positionLedger = new PositionLedger(config.positionLedgerPath ?? null, positionReader, {
            ed: config.lanes.ed.signer?.address ?? null,
            kuzuo: config.lanes.kuzuo.signer?.address ?? null,
        }, config.positionReconcileIntervalMs ?? 15_000, {
            onError: (reason) => this.emit("position_tracker_error", { reason }),
            reconcileConcurrency: config.positionReconcileConcurrency ?? 4,
        });
        const onState = (name, metrics) => {
            this.feedMetrics.set(name, metrics);
        };
        const configuredPendingUrls = config.pendingWssUrls ?? [];
        const fullPendingFeeds = configuredPendingUrls.map((url, index) => new FullPendingFeed({
            name: "pending-" + String(index + 1),
            url,
            subscribeHeads: false,
            copyWalletAddresses: ([config.lanes.ed, config.lanes.kuzuo]
                .map((lane) => lane.signer?.address)
                .filter((address) => Boolean(address))),
            onTarget: (signal, timing) => { void this.handleTarget(signal, timing); },
            onCopyWalletPending: (transaction) => this.handleCopyWalletPending(transaction),
            onHead: () => undefined,
            onState,
        }));
        // A full-pending firehose and newHeads must never share one TCP FIFO. If no
        // paid/dedicated head URL is configured, reuse the public pending URL on a
        // second heads-only socket; this preserves the free source while isolating
        // the authority waterline from pending-object backlog.
        const configuredHeadUrls = config.headWssUrls ?? [];
        const authorityHeadUrls = configuredHeadUrls.length > 0
            ? configuredHeadUrls
            : configuredPendingUrls;
        const headFeeds = authorityHeadUrls
            .map((url, index) => new FullPendingFeed({
            name: "heads-" + String(index + 1),
            url,
            subscribePending: false,
            maxHeadTimestampLagMs: DEFAULT_AUTHORITY_HEAD_MAX_TIMESTAMP_LAG_MS,
            onTarget: () => undefined,
            onHead: (head) => this.handleHead(head),
            onState,
        }));
        const blockRazorConfig = config.blockRazorPublicMempool;
        const blockRazorFeeds = [];
        if (blockRazorConfig?.enabled) {
            if (!blockRazorConfig.apiKey)
                throw new Error("BlockRazor Public Mempool apiKey is unavailable");
            blockRazorFeeds.push(new BlockRazorPublicMempoolFeed({
                name: blockRazorConfig.name,
                endpoint: blockRazorConfig.endpoint,
                apiKey: blockRazorConfig.apiKey,
                onTarget: (signal, timing) => { void this.handleTarget(signal, timing); },
                onState,
            }));
        }
        const privateConfig = config.blockRazorPrivateMempool;
        const blockRazorPrivateFeeds = [];
        if (privateConfig?.enabled) {
            if (!privateConfig.token)
                throw new Error("BlockRazor Private Mempool token is unavailable");
            const deduper = new BlockRazorPrivateFirstSeenDeduper();
            for (const region of privateConfig.regions) {
                this.privateBuilders.set(region, new BuilderClient({
                    name: "blockrazor",
                    url: BLOCKRAZOR_PRIVATE_REGIONS[region].submitUrl,
                    authorization: "Bearer " + privateConfig.token,
                    // Private proxyBid replaces the normal BlockRazor tip recipient.
                    tipRecipient: "0x0000000000000000000000000000000000000000",
                    requestTimeoutMs: privateConfig.submitTimeoutMs,
                    prewarmIntervalMs: privateConfig.prewarmIntervalMs
                        ?? DEFAULT_BUILDERS.blockrazor.prewarmIntervalMs,
                }));
                blockRazorPrivateFeeds.push(new BlockRazorPrivateMempoolFeed({
                    name: "blockrazor-private-" + region,
                    region,
                    streamUrl: BLOCKRAZOR_PRIVATE_REGIONS[region].streamUrl,
                    token: privateConfig.token,
                    connectTimeoutMs: privateConfig.connectTimeoutMs,
                    idleTimeoutMs: privateConfig.idleTimeoutMs,
                    onTarget: (signal, timing) => { void this.handleTarget(signal, timing); },
                    onState,
                }, { deduper }));
            }
        }
        this.bootstrapFeeds = [...headFeeds, ...fullPendingFeeds];
        this.targetFeeds = [...blockRazorFeeds, ...blockRazorPrivateFeeds];
        this.feeds = [...this.bootstrapFeeds, ...this.targetFeeds];
    }
    async start() {
        if (!this.stopped)
            return;
        this.stopped = false;
        this.broadcastClosed = true;
        try {
            this.assertLivePublicBuilderSet();
            await this.runtimeSettings.load();
            await this.positionLedger.start();
            const liveLike = this.config.mode === "dry-sign" || this.config.mode === "live";
            const enabledStrategies = ["ed", "kuzuo"]
                .filter((strategy) => this.lanes[strategy].config.enabled);
            await Promise.all([
                this.globalLedger.load({ requireExisting: this.config.mode === "live" }),
                ...enabledStrategies.map((strategy) => this.lanes[strategy].ledger.load({
                    requireExisting: this.config.mode === "live",
                })),
            ]);
            if (liveLike) {
                this.validateLaneIsolation();
                await Promise.all([
                    this.globalLedger.ensureIdentity(this.globalRiskLedgerIdentity(), this.config.mode === "dry-sign"),
                    ...enabledStrategies.map((strategy) => this.lanes[strategy].ledger.ensureIdentity(this.laneRiskLedgerIdentity(strategy), this.config.mode === "dry-sign")),
                ]);
            }
            const globalCircuit = this.globalLedger.circuitState();
            this.circuitBroken = globalCircuit.tripped;
            this.circuitReason = globalCircuit.reason;
            for (const strategy of enabledStrategies) {
                const lane = this.lanes[strategy];
                const circuit = lane.ledger.circuitState();
                lane.circuitBroken = circuit.tripped;
                lane.circuitReason = circuit.reason;
            }
            if (this.config.mode === "live") {
                // Prove all independent durability domains writable and pay their first
                // create/fsync costs in parallel before a target enters the hot path.
                await Promise.all([
                    this.globalLedger.persist(),
                    ...enabledStrategies.map((strategy) => this.lanes[strategy].ledger.persist()),
                ]);
            }
            await this.armGate.start();
            await this.initializeLanes();
            // Force ethers' first-use curve/setup work before any target source can
            // call the planner. This is local-only and signs a fixed non-broadcastable
            // digest; it never consumes a wallet nonce or makes an RPC request.
            for (const strategy of ["ed", "kuzuo"]) {
                const lane = this.lanes[strategy];
                if (lane.config.enabled) {
                    lane.config.signer?.prewarm();
                    this.refreshPublicTipCache(strategy);
                }
            }
            if (this.config.mode === "live") {
                await Promise.allSettled(this.builders.map((builder) => builder.prewarm()));
            }
            this.resyncTimer = setInterval(() => { void this.resynchronizeNeededLanes(); }, 1_000);
            this.resyncTimer.unref();
            for (const feed of this.bootstrapFeeds)
                feed.start();
            if (this.feeds.length > 0) {
                await this.waitForInitialHead(this.config.headReadyTimeoutMs ?? 5_000);
            }
            if (this.config.mode === "live") {
                // Do not touch a paid/private regional endpoint until a current BSC head
                // has been established. This also pays its TLS cold start before SSE can
                // deliver the first actionable private bundle.
                await Promise.allSettled([...this.privateBuilders.values()].map((builder) => builder.prewarm()));
                // A healthy live process still starts disarmed. Only the authenticated
                // loopback control request may open the synchronous broadcast latch.
            }
            // BlockRazor carries target raws but no head. It is deliberately connected
            // only after bootstrap proved a fresh head, so its very first paid-stream
            // target can never be discarded as head_unknown.
            for (const feed of this.targetFeeds)
                feed.start();
            this.emit("executor_started", {
                mode: this.config.mode,
                feedCount: this.feeds.length,
                builders: this.builders.map((builder) => builder.config.name),
                lanes: ["ed", "kuzuo"].map((strategy) => ({
                    strategy,
                    enabled: this.lanes[strategy].config.enabled,
                    signer: this.lanes[strategy].config.signer?.address ?? null,
                    executor: this.lanes[strategy].config.executorAddress,
                })),
            });
        }
        catch (error) {
            await this.stop();
            throw error;
        }
    }
    async stop() {
        if (this.stopPromise)
            return this.stopPromise;
        // Close the broadcast latch synchronously, before any await or cleanup.
        this.broadcastClosed = true;
        this.liveControlEpoch += 1;
        this.suppressUnsentWork("executor_stopped");
        this.stopped = true;
        for (const feed of this.feeds)
            feed.stop();
        if (this.resyncTimer)
            clearInterval(this.resyncTimer);
        this.resyncTimer = null;
        const builderClosePromises = [...this.builders, ...this.privateBuilders.values()]
            .filter((builder) => builder instanceof BuilderClient)
            .map((builder) => builder.close());
        this.armGate.stop();
        this.stopPromise = (async () => {
            await Promise.all([
                this.waitForTrackedWork(),
                this.positionLedger.stop(),
                this.dispatchNotifier?.stop() ?? Promise.resolve(),
                ...builderClosePromises,
            ]);
            await Promise.all([
                this.globalLedger.close(),
                this.lanes.ed.ledger.close(),
                this.lanes.kuzuo.ledger.close(),
            ]);
        })();
        return this.stopPromise;
    }
    snapshot() {
        const now = process.hrtime.bigint();
        const headFreshness = this.authorityHeadFreshness(now);
        const headAgeMs = headFreshness.deliveryAgeMs;
        const routeReadiness = this.routeReadiness(now);
        const readinessReasons = [];
        if (this.stopped)
            readinessReasons.push("stopped");
        if (this.circuitBroken)
            readinessReasons.push("global_circuit_broken");
        if (headAgeMs === null)
            readinessReasons.push("head_unknown");
        else if (!headFreshness.current)
            readinessReasons.push("head_stale");
        if (!routeReadiness.sourceReady)
            readinessReasons.push("target_source_not_actionable");
        else if (!routeReadiness.routeReady)
            readinessReasons.push("compatible_route_not_ready");
        if (this.config.mode === "live" && (this.broadcastClosed || !this.armGate.armed)) {
            readinessReasons.push("not_armed");
        }
        const laneStatuses = ["ed", "kuzuo"].map((strategy) => {
            const lane = this.lanes[strategy];
            const nonce = lane.nonce.snapshot();
            const laneReasons = [];
            if (!lane.config.enabled)
                laneReasons.push("disabled");
            if (lane.config.enabled && lane.circuitBroken)
                laneReasons.push("lane_circuit_broken");
            if (lane.config.enabled && (nonce.state === "unsynchronized" || nonce.state === "needs_sync"
                || nonce.state === "external_pending")) {
                laneReasons.push("lane_not_synchronized");
            }
            if (lane.config.enabled && (nonce.state === "reserved" || nonce.state === "submitted")) {
                laneReasons.push("lane_busy");
            }
            const attempts = Object.values(lane.ledger.snapshot().attempts);
            return {
                strategy,
                enabled: lane.config.enabled,
                ready: lane.config.enabled && readinessReasons.length === 0 && laneReasons.length === 0,
                readinessReasons: [...readinessReasons, ...laneReasons],
                circuitBroken: lane.circuitBroken,
                circuitReason: lane.circuitReason,
                unresolvedRiskAttempts: attempts
                    .filter((attempt) => attempt.state === "reserved" || attempt.state === "unknown_charged").length,
                signer: lane.config.signer?.address ?? null,
                executor: lane.config.executorAddress,
                nonce,
                spentTodayWei: lane.ledger.spent(strategy).toString(),
                includedToday: lane.ledger.trades(strategy),
                queuedTargets: lane.queuedTargets.size,
                lastError: lane.lastError,
            };
        });
        const enabledLanes = laneStatuses.filter((lane) => lane.enabled);
        const readyLanes = enabledLanes.filter((lane) => lane.ready);
        if (enabledLanes.length === 0)
            readinessReasons.push("no_enabled_lane");
        else if (readyLanes.length === 0 && readinessReasons.length === 0)
            readinessReasons.push("no_ready_lane");
        const degradedReasons = laneStatuses
            .filter((lane) => lane.enabled && !lane.ready)
            .flatMap((lane) => lane.readinessReasons
            .filter((reason) => !readinessReasons.includes(reason))
            .map((reason) => `${reason}:${lane.strategy}`));
        return {
            ok: readinessReasons.length === 0 && readyLanes.length > 0,
            degraded: degradedReasons.length > 0,
            degradedReasons,
            readinessReasons,
            mode: this.config.mode,
            armed: this.armGate.armed,
            armChallenge: this.armGate.challenge,
            circuitBroken: this.circuitBroken,
            circuitReason: this.circuitReason,
            globalCircuit: this.globalLedger.circuitState(),
            unresolvedRiskAttempts: laneStatuses
                .reduce((total, lane) => total + lane.unresolvedRiskAttempts, 0),
            latestHead: this.latestHead ? {
                number: this.latestHead.number,
                hash: this.latestHead.hash,
                source: this.latestHead.source,
                ageMs: headAgeMs,
                timestampLagMs: headFreshness.timestampLagMs,
            } : null,
            feeds: [...this.feedMetrics.entries()].map(([name, metrics]) => ({ name, ...metrics })),
            builders: this.builders.map((builder) => builder.snapshot()),
            privateBuilders: [...this.privateBuilders.entries()].map(([region, builder]) => ({
                region,
                ...builder.snapshot(),
            })),
            lanes: laneStatuses,
            liveControl: this.controlSnapshot(),
            activeRaces: [...this.activeRaces.values()].map((race) => ({
                targetHash: race.targetHash,
                strategy: race.strategy,
                validUntilBlock: race.validUntilBlock,
                candidateHashes: [...race.candidates.keys()],
                nonce: race.nonce,
                nonceSpan: race.nonceSpan,
                frontierCommitted: race.frontierCommitted === true,
            })),
            recentEvents: [...this.recentEvents],
        };
    }
    controlSnapshot() {
        const runtime = this.runtimeSettings.snapshot();
        return {
            enabled: this.config.mode === "live" && !this.stopped && !this.broadcastClosed && this.armGate.armed,
            mode: this.config.mode,
            armed: this.config.mode === "live" && this.armGate.armed,
            writable: runtime.writable,
            updatedAt: runtime.updatedAt,
            lanes: runtime.lanes,
        };
    }
    positionsSnapshot() {
        return this.positionLedger.snapshot();
    }
    async enableLive(confirmation) {
        const epoch = ++this.liveControlEpoch;
        if (this.config.mode !== "live")
            throw new ExecutorControlError("mode_forbidden", "live control is unavailable in this mode");
        if (confirmation !== ArmGate.ENABLE_CONFIRMATION) {
            throw new ExecutorControlError("invalid_confirmation", "live enable confirmation is invalid");
        }
        if (this.stopped)
            throw new ExecutorControlError("stopped", "executor is stopped");
        if (this.circuitBroken || this.globalLedger.circuitState().tripped) {
            throw new ExecutorControlError("not_ready", "executor circuit is open");
        }
        this.assertLivePublicBuilderSet();
        if (!this.latestHead) {
            throw new ExecutorControlError("not_ready", "executor has not observed a BSC head yet");
        }
        for (const strategy of ["ed", "kuzuo"]) {
            const lane = this.lanes[strategy];
            if (!lane.config.enabled)
                continue;
            const nonce = lane.nonce.snapshot();
            if (lane.circuitBroken || lane.ledger.circuitState().tripped
                || nonce.state === "reserved" || nonce.state === "submitted") {
                throw new ExecutorControlError("not_ready", strategy + " lane is not ready");
            }
        }
        await Promise.all(["ed", "kuzuo"]
            .filter((strategy) => this.lanes[strategy].config.enabled)
            .map((strategy) => this.reconcileLaneBeforeEnable(strategy)));
        await this.armGate.enable(confirmation);
        // Disable always wins over an older enable whose fsync completed later.
        if (this.stopped || epoch !== this.liveControlEpoch) {
            await this.armGate.disable().catch(() => undefined);
            throw new ExecutorControlError("stale_request", "live enable was superseded");
        }
        this.broadcastClosed = false;
        this.emit("live_enabled", {});
        for (const strategy of ["ed", "kuzuo"])
            this.scheduleQueueDrain(strategy);
    }
    disableLive() {
        this.liveControlEpoch += 1;
        this.broadcastClosed = true;
        this.suppressUnsentWork("live_disabled");
        this.emit("live_disabled", {});
        return this.armGate.disable();
    }
    async updateRuntimeLane(request) {
        try {
            await this.runtimeSettings.update(request);
        }
        catch (error) {
            if (error instanceof RuntimeSettingsError) {
                throw new ExecutorControlError(error.code === "persistence_unavailable" ? "persistence_failed" : error.code, error.message);
            }
            throw new ExecutorControlError("persistence_failed", "runtime lane settings could not be persisted");
        }
        this.refreshPublicTipCache(request.strategy);
        this.emit("runtime_lane_updated", { strategy: request.strategy });
    }
    async initializeLanes() {
        const liveLike = this.config.mode === "dry-sign" || this.config.mode === "live";
        if (liveLike && !this.rpc)
            throw new Error("executor RPC is unavailable");
        const enabled = ["ed", "kuzuo"].filter((strategy) => this.lanes[strategy].config.enabled);
        if (liveLike)
            this.validateLaneIsolation();
        for (const strategy of enabled) {
            const lane = this.lanes[strategy];
            if (!liveLike) {
                lane.nonce.synchronize(0);
                continue;
            }
            const signer = lane.config.signer;
            const executor = lane.config.executorAddress;
            if (!signer || !this.rpc)
                throw new Error(strategy + " signing lane is incomplete");
            if (this.config.blockRazorPrivateMempool.enabled && !executor) {
                throw new Error(strategy + " private signing lane is missing its atomic executor");
            }
            const worstCost = this.worstCost(lane.config, this.runtimeSettings.lane(strategy));
            const preflight = [
                this.rpc.latestNonce(signer.address),
                this.rpc.pendingNonce(signer.address),
                this.rpc.balance(signer.address),
                this.rpc.blockNumber(),
            ];
            const executorCheck = executor && this.config.blockRazorPrivateMempool.enabled
                ? this.rpc.assertAtomicExecutor(executor, signer.address)
                : Promise.resolve();
            const [latestNonce, pendingNonce, balance, currentBlock] = await Promise.all([
                ...preflight,
                executorCheck,
            ]);
            if (balance < worstCost) {
                throw new Error(strategy + " copy wallet balance is below one configured trade");
            }
            await this.reconcilePersistedLane(strategy, latestNonce, pendingNonce, currentBlock);
            const unresolved = Object.values(lane.ledger.snapshot().attempts)
                .some((attempt) => attempt.state === "reserved" || attempt.state === "unknown_charged");
            if (!unresolved && pendingNonce > latestNonce) {
                lane.nonce.synchronize(latestNonce);
                lane.nonce.observeExternalPending(pendingNonce - 1);
                lane.lastError = "waiting_external_nonce";
            }
            else {
                lane.nonce.synchronize(pendingNonce);
            }
        }
    }
    /**
     * Tip transfers are target-independent. Keep the three provider variants
     * signed for the lane's next N+1 nonce so a target arrival only signs one
     * common GMGN buy transaction.
     */
    refreshPublicTipCache(strategy) {
        const lane = this.lanes[strategy];
        const settings = this.runtimeSettings.lane(strategy);
        const signer = lane.config.signer;
        const nonce = lane.nonce.snapshot().nextNonce;
        lane.publicTipCache.clear();
        if (!signer || nonce === null || settings.builderTipWei <= 0n)
            return;
        for (const builder of this.builders) {
            const signed = signer.signBuilderTip({
                tipRecipient: builder.config.tipRecipient,
                builderTipWei: settings.builderTipWei,
                nonce: nonce + 1,
                gasPriceWei: settings.gasPriceWei,
            });
            lane.publicTipCache.set(builder.config.name, {
                nonce: nonce + 1,
                recipient: builder.config.tipRecipient.toLowerCase(),
                tipWei: settings.builderTipWei,
                gasPriceWei: settings.gasPriceWei,
                signed,
            });
        }
    }
    publicTipFor(strategy, builder, buyNonce, settings) {
        const lane = this.lanes[strategy];
        const cached = lane.publicTipCache.get(builder.config.name);
        if (cached
            && cached.nonce === buyNonce + 1
            && cached.recipient === builder.config.tipRecipient.toLowerCase()
            && cached.tipWei === settings.builderTipWei
            && cached.gasPriceWei === settings.gasPriceWei) {
            return cached.signed;
        }
        const signer = lane.config.signer;
        if (!signer)
            throw new Error("signer unavailable for Builder tip");
        return signer.signBuilderTip({
            tipRecipient: builder.config.tipRecipient,
            builderTipWei: settings.builderTipWei,
            nonce: buyNonce + 1,
            gasPriceWei: settings.gasPriceWei,
        });
    }
    handleTarget(signal, timing) {
        return this.trackPromise(this.plannerPromises, this.planTarget(signal, timing));
    }
    handleCopyWalletPending(transaction) {
        const hash = transaction.hash.toLowerCase();
        if (this.recentOwnHashes.has(hash)
            || [...this.activeRaces.values()].some((race) => race.submittedTransactionHashes.has(hash))) {
            this.emit("own_submission_echo", { hash, nonce: transaction.nonce });
            return;
        }
        const strategy = ["ed", "kuzuo"].find((candidate) => this.lanes[candidate].config.signer?.address.toLowerCase() === transaction.from.toLowerCase());
        if (!strategy)
            return;
        const lane = this.lanes[strategy];
        lane.nonce.observeExternalPending(transaction.nonce, transaction.hash);
        lane.lastError = "waiting_external_nonce";
        this.emit("copy_wallet_external_pending", {
            strategy,
            hash,
            nonce: transaction.nonce,
            laneState: lane.nonce.snapshot().state,
        });
    }
    rememberOwnHash(hash, expiresAfterBlock) {
        const normalized = hash.toLowerCase();
        this.recentOwnHashes.delete(normalized);
        this.recentOwnHashes.set(normalized, expiresAfterBlock);
        while (this.recentOwnHashes.size > MAX_RECENT_OWN_HASHES) {
            const oldest = this.recentOwnHashes.keys().next().value;
            if (!oldest)
                break;
            this.recentOwnHashes.delete(oldest);
            this.emit("own_submission_cache_evicted", { hash: oldest });
        }
    }
    suppressUnsentWork(reason) {
        for (const strategy of ["ed", "kuzuo"]) {
            const lane = this.lanes[strategy];
            const cleared = lane.queuedTargets.size;
            lane.queuedTargets.clear();
            if (cleared > 0)
                this.emit("target_queue_cleared", { strategy, reason, cleared });
        }
        for (const race of this.activeRaces.values()) {
            race.superseded = true;
            delete race.deferredConfirmedUpgrade;
        }
    }
    queueKey(signal) {
        return signal.transaction.from.toLowerCase() + ":" + String(signal.transaction.nonce);
    }
    enqueueTarget(lane, signal, timing, reason) {
        const key = this.queueKey(signal);
        // Different watched-wallet nonces are independent copy opportunities and
        // remain ordered in the queue. Only a replacement at the exact same
        // sender+nonce slot supersedes the prior hash.
        const existing = lane.queuedTargets.get(key);
        lane.queuedTargets.set(key, {
            signal,
            timing,
            senderNonce: signal.transaction.nonce,
            queuedAtMonoNs: existing?.queuedAtMonoNs ?? process.hrtime.bigint(),
        });
        this.emit(existing ? "target_queue_replaced" : "target_queued", {
            strategy: signal.strategy,
            targetHash: signal.transaction.hash.toLowerCase(),
            replacedHash: existing?.signal.transaction.hash.toLowerCase() ?? null,
            senderNonce: signal.transaction.nonce,
            reason,
            queueDepth: lane.queuedTargets.size,
        });
    }
    scheduleQueueDrain(strategy) {
        const lane = this.lanes[strategy];
        if (lane.drainingQueue || this.stopped)
            return;
        lane.drainingQueue = true;
        const operation = new Promise((resolve) => {
            const immediate = setImmediate(() => {
                void this.drainQueue(strategy).finally(() => {
                    lane.drainingQueue = false;
                    resolve();
                });
            });
            immediate.unref();
        });
        void this.trackPromise(this.plannerPromises, operation);
    }
    async drainQueue(strategy) {
        const lane = this.lanes[strategy];
        while (!this.stopped && this.latestHead && lane.queuedTargets.size > 0) {
            if (this.config.mode === "live" && (this.broadcastClosed || !this.armGate.armed))
                return;
            if (lane.circuitBroken || lane.ledger.circuitState().tripped || this.circuitBroken)
                return;
            if (lane.nonce.snapshot().state !== "ready")
                return;
            const next = [...lane.queuedTargets.entries()]
                .sort((left, right) => left[1].senderNonce - right[1].senderNonce
                || Number(left[1].queuedAtMonoNs - right[1].queuedAtMonoNs))[0];
            if (!next)
                return;
            lane.queuedTargets.delete(next[0]);
            await this.planTarget(next[1].signal, next[1].timing);
            if (lane.nonce.snapshot().state !== "ready")
                return;
        }
    }
    /**
     * Loopback-only ingress used by the monitor's already-filtered Router log.
     * It claims synchronously, then hydrates and plans without awaiting the HTTP
     * request handler, DB, browser fan-out, metadata, or another wallet lane.
     */
    acceptConfirmedTargetHint(hint) {
        if (this.stopped)
            throw new Error("executor is stopped");
        if (hint.version !== 1 || (hint.strategy !== "ed" && hint.strategy !== "kuzuo")) {
            throw new Error("confirmed target hint version or strategy is invalid");
        }
        if (!HASH_RE.test(hint.txHash) || !HASH_RE.test(hint.blockHash)
            || !Number.isSafeInteger(hint.blockNumber) || hint.blockNumber <= 0
            || !Number.isSafeInteger(hint.logIndex) || hint.logIndex < 0
            || !DECIMAL_RE.test(hint.observedUnixNs)) {
            throw new Error("confirmed target hint fields are invalid");
        }
        const expectedPayer = hint.strategy === "ed" ? ED_TARGET_ADDRESS : KUZUO_TARGET_ADDRESS;
        if (getAddress(hint.payer) !== getAddress(expectedPayer)) {
            throw new Error("confirmed target hint payer does not match its lane");
        }
        const nowUnixNs = BigInt(Date.now()) * 1000000n;
        const observedUnixNs = BigInt(hint.observedUnixNs);
        const ageNs = nowUnixNs - observedUnixNs;
        if (ageNs < 0n)
            throw new Error("confirmed target hint timestamp is in the future");
        const claimKey = targetRaceKey(hint.strategy, hint.txHash);
        if (this.confirmedHintClaims.has(claimKey))
            return false;
        this.confirmedHintClaims.add(claimKey);
        if (this.confirmedHintClaims.size > 5_000) {
            const oldest = this.confirmedHintClaims.values().next().value;
            if (oldest)
                this.confirmedHintClaims.delete(oldest);
        }
        const receivedMonoNs = process.hrtime.bigint();
        // The strict log itself is the authoritative N head observation. No
        // QuickNode newHeads subscription or periodic block-number request exists.
        this.handleHead({
            number: hint.blockNumber,
            hash: hint.blockHash,
            timestamp: Math.floor(Date.now() / 1_000),
            source: "confirmed-loopback",
            seenMonoNs: receivedMonoNs,
        });
        void this.trackPromise(this.plannerPromises, this.hydrateConfirmedTarget(hint, receivedMonoNs));
        return true;
    }
    async hydrateConfirmedTarget(hint, receivedMonoNs) {
        try {
            if (!this.rpc)
                throw new Error("executor RPC is unavailable for confirmed hydration");
            let hydrated = null;
            let lastHydrationError = null;
            for (const delayMs of [0, 12]) {
                if (delayMs > 0)
                    await wait(delayMs);
                try {
                    hydrated = await this.rpc.minedTargetTransaction(hint.txHash, 160);
                    if (hydrated)
                        break;
                }
                catch (error) {
                    lastHydrationError = error;
                }
            }
            if (!hydrated && lastHydrationError)
                throw lastHydrationError;
            if (!hydrated)
                throw new Error("confirmed transaction was not returned by RPC");
            if (hydrated.blockNumber !== hint.blockNumber
                || hydrated.blockHash.toLowerCase() !== hint.blockHash.toLowerCase()) {
                throw new Error("confirmed transaction block identity does not match the Router log");
            }
            if (hydrated.transaction.from.toLowerCase() !== hint.payer.toLowerCase()) {
                throw new Error("confirmed transaction sender does not match the Router payer");
            }
            const parsedMonoNs = process.hrtime.bigint();
            const validated = validateTargetSignal({
                version: 1,
                source: "confirmed_log_fallback",
                sourceSequence: `confirmed-loopback:${String(hint.blockNumber)}:${String(hint.logIndex)}:${hint.txHash.toLowerCase()}`,
                firstSeenUnixNs: hint.observedUnixNs,
                firstSeenMonoNs: receivedMonoNs.toString(),
                strategy: hint.strategy,
                transaction: hydrated.transaction,
                sourceBlockHint: hint.blockNumber,
            });
            const signal = brandSourceVerifiedTargetSignal(validated);
            await this.planTarget(signal, {
                socketSeenMonoNs: receivedMonoNs,
                parsedMonoNs,
                matchedMonoNs: parsedMonoNs,
            });
        }
        catch (error) {
            this.confirmedHintClaims.delete(targetRaceKey(hint.strategy, hint.txHash));
            this.emit("confirmed_target_rejected", {
                strategy: hint.strategy,
                targetHash: hint.txHash.toLowerCase(),
                sourceBlock: hint.blockNumber,
                reason: errorText(error),
            });
        }
    }
    async planTarget(signal, timing) {
        const targetHash = signal.transaction.hash.toLowerCase();
        const key = targetRaceKey(signal.strategy, targetHash);
        const existing = this.seenTargets.get(key);
        const existingRace = this.activeRaces.get(key);
        if (this.config.mode !== "observe" && existing !== undefined && !existingRace) {
            this.emit("target_duplicate", {
                strategy: signal.strategy,
                targetHash,
                source: signal.source,
                duplicateAfterMs: elapsedMs(existing, timing.socketSeenMonoNs),
            });
            return;
        }
        try {
            const sourceVerified = isSourceVerifiedTargetSignal(signal);
            const validated = sourceVerified ? signal : validateTargetSignal(signal);
            const validatedMonoNs = process.hrtime.bigint();
            const identity = canonicalTargetIdentity(validated);
            if (existingRace && !sameTargetIdentity(existingRace.targetIdentity, identity)) {
                await this.breakCircuitPersistent("same target hash was observed with a conflicting strategy or transaction identity");
                return this.reject(validated, "target_identity_conflict");
            }
            const lane = this.lanes[validated.strategy];
            const confirmedFallback = validated.source === "confirmed_log_fallback";
            for (const active of this.activeRaces.values()) {
                if (active.strategy !== validated.strategy
                    || active.targetHash.toLowerCase() === targetHash
                    || active.targetIdentity.from !== identity.from
                    || active.targetIdentity.nonce !== identity.nonce)
                    continue;
                active.superseded = true;
                this.emit("active_target_replaced", {
                    strategy: validated.strategy,
                    targetHash: active.targetHash,
                    replacementHash: targetHash,
                    senderNonce: identity.nonce,
                });
            }
            if (existingRace?.superseded) {
                return this.reject(validated, "target_superseded");
            }
            // Source quality is monotonic. Once the mined/confirmed dependency is
            // known, a late raw-pending echo cannot downgrade the rolling envelope.
            if (existingRace?.latestSignal.source === "confirmed_log_fallback" && !confirmedFallback) {
                this.emit("target_duplicate", {
                    strategy: validated.strategy,
                    targetHash,
                    source: validated.source,
                    reason: "confirmed_source_already_active",
                });
                return;
            }
            // A private candidate consumes one nonce, while a public Builder envelope
            // consumes buy+tip. Never mutate a span-1 lease into span-2. Stop rolling
            // the private form and retain the confirmed upgrade until its last real
            // submission has passed finality and the authoritative nonce stayed put.
            if (existingRace && existingRace.nonceSpan === 1 && confirmedFallback) {
                existingRace.superseded = true;
                existingRace.deferredConfirmedUpgrade = {
                    signal: validated,
                    timing,
                    senderNonce: validated.transaction.nonce,
                    queuedAtMonoNs: process.hrtime.bigint(),
                };
                this.emit("confirmed_upgrade_deferred", {
                    strategy: validated.strategy,
                    targetHash,
                    reason: "private_span_finality_pending",
                });
                return;
            }
            // A public signal is a one-shot race: the first observation gets one
            // immediate fanout for its earliest executable block. Later source echoes
            // and heads must not turn the same target into a rolling submission.
            if (existingRace && existingRace.nonceSpan === 2) {
                this.emit("target_duplicate", {
                    strategy: validated.strategy,
                    targetHash,
                    source: validated.source,
                    reason: "public_race_already_submitted",
                    duplicateAfterMs: existing === undefined ? null : elapsedMs(existing, timing.socketSeenMonoNs),
                });
                return;
            }
            const executionSettings = existingRace?.executionSettings ?? this.runtimeSettings.lane(validated.strategy);
            if (!lane.config.enabled)
                return this.reject(validated, "strategy_disabled");
            if (this.config.mode === "live" && (this.stopped || this.broadcastClosed)) {
                return this.reject(validated, "broadcast_closed");
            }
            if (this.circuitBroken)
                return this.reject(validated, "global_circuit_breaker");
            if (lane.circuitBroken || lane.ledger.circuitState().tripped) {
                return this.reject(validated, "lane_circuit_breaker");
            }
            if (this.config.mode === "live" && !this.armGate.armed)
                return this.reject(validated, "not_armed");
            if (!this.latestHead) {
                this.enqueueTarget(lane, validated, timing, "head_unknown");
                return;
            }
            if (!this.authorityHeadFreshness(process.hrtime.bigint()).current) {
                return this.reject(validated, "head_stale");
            }
            const nonceState = lane.nonce.snapshot();
            if (nonceState.state === "unsynchronized" || nonceState.state === "needs_sync"
                || nonceState.state === "external_pending") {
                this.enqueueTarget(lane, validated, timing, "lane_waiting_nonce_sync");
                return;
            }
            if ((nonceState.state === "reserved" || nonceState.state === "submitted")
                && nonceState.lease?.targetHash !== targetHash) {
                this.enqueueTarget(lane, validated, timing, "lane_busy");
                return;
            }
            const headAgeMs = Math.max(0, Number(process.hrtime.bigint() - this.latestHead.seenMonoNs) / 1e6);
            const privateDisclosure = isBlockRazorPrivateTransaction(validated.transaction);
            const privateContext = privateDisclosure ? validated.blockRazorPrivateBundle ?? null : null;
            if (privateDisclosure && this.config.mode !== "observe" && !sourceVerified) {
                return this.reject(validated, "blockrazor_private_source_not_process_verified");
            }
            if (confirmedFallback && !sourceVerified) {
                return this.reject(validated, "confirmed_log_source_not_process_verified");
            }
            if (privateDisclosure && !privateContext) {
                return this.reject(validated, "blockrazor_private_context_missing");
            }
            if (!privateDisclosure && !validated.rawTransactionVerified && !confirmedFallback) {
                return this.reject(validated, "target_raw_unverified");
            }
            if (!validated.predecessorsVerified)
                return this.reject(validated, "target_predecessor_unverified");
            const privateRewritten = privateContext ? rewriteGmgnSwapCalldata({
                executionMode: this.config.mode,
                strategy: validated.strategy,
                targetSender: validated.transaction.from,
                targetTo: validated.transaction.to,
                targetInput: validated.transaction.input,
                targetValueWei: BigInt(validated.transaction.valueWei),
                followAmountInWei: executionSettings.followAmountWei,
                edMinReturnRetentionBps: lane.config.edMinReturnRetentionBps,
                allowZeroMinReturnInLive: lane.config.allowZeroMinReturnInLive,
            }) : null;
            const publicRewritten = privateContext ? null : fastGmgnBuyTemplate({
                targetTo: validated.transaction.to,
                targetInput: validated.transaction.input,
                targetValueWei: BigInt(validated.transaction.valueWei),
                followAmountInWei: executionSettings.followAmountWei,
            });
            const routerCalldata = privateRewritten?.calldata ?? publicRewritten.calldata;
            const swapValueWei = privateRewritten?.valueWei ?? publicRewritten.valueWei;
            const minimumTokenOut = privateRewritten?.minReturn ?? 0n;
            const originalAmountIn = privateRewritten?.originalAmountIn ?? publicRewritten.originalAmountIn;
            const targetTokenAddress = privateRewritten?.targetTokenAddress ?? null;
            const calldataValidatedMonoNs = process.hrtime.bigint();
            if (this.config.mode === "observe") {
                this.emit("target_observed", {
                    strategy: validated.strategy,
                    targetHash,
                    tokenOut: targetTokenAddress,
                    targetAmountWei: originalAmountIn.toString(),
                    source: validated.source,
                    privateRegion: validated.blockRazorPrivateBundle?.region ?? null,
                    privateBundleHash: validated.blockRazorPrivateBundle?.bundleHash ?? null,
                    privateTargetIndex: validated.blockRazorPrivateBundle?.targetIndex ?? null,
                    privateTransactionCount: validated.blockRazorPrivateBundle?.transactionCount ?? null,
                    socketToParsedMs: elapsedMs(timing.socketSeenMonoNs, timing.parsedMonoNs),
                    socketToMatchedMs: elapsedMs(timing.socketSeenMonoNs, timing.matchedMonoNs),
                    socketToValidatedMs: elapsedMs(timing.socketSeenMonoNs, calldataValidatedMonoNs),
                });
                return;
            }
            const signer = lane.config.signer;
            if (!signer)
                return this.reject(validated, "signer_unavailable");
            if (privateContext && executionSettings.builderTipWei <= 0n) {
                return this.reject(validated, "blockrazor_private_proxy_bid_zero");
            }
            if (privateContext) {
                const proxy = privateContext.proxyBidContract.toLowerCase();
                const refund = privateContext.refundAddress.toLowerCase();
                const forbidden = new Set([
                    signer.address.toLowerCase(),
                    (lane.config.executorAddress ?? SHADOW_EXECUTOR).toLowerCase(),
                    validated.transaction.to.toLowerCase(),
                    privateRewritten.targetTokenAddress.toLowerCase(),
                ]);
                if (proxy === refund || forbidden.has(proxy) || forbidden.has(refund)) {
                    return this.reject(validated, "blockrazor_private_unsafe_proxy_or_refund_address");
                }
            }
            const worstCost = this.worstCost(lane.config, executionSettings);
            const dependency = targetReference(validated);
            if (!dependency)
                return this.reject(validated, privateDisclosure ? "private_bundle_hash_missing" : "target_raw_missing");
            const publicDependencyUsable = dependency.kind === "confirmedNextBlock" || (dependency.kind === "rawTx"
                && (validated.strategy !== "kuzuo" || dependency.requiredPredecessorRaws.length === 1));
            const routesByBuilder = new Map();
            const privateEnvelopeBlock = this.latestHead.number + 1;
            if (existingRace && privateContext && existingRace.validUntilBlock !== privateEnvelopeBlock) {
                existingRace.plannedRoutes.clear();
            }
            const eligibleBuilders = (privateContext
                ? [this.privateBuilders.get(privateContext.region)].filter((value) => Boolean(value))
                : this.builders).sort((left, right) => Number(this.builderIsFresh(right, process.hrtime.bigint()))
                - Number(this.builderIsFresh(left, process.hrtime.bigint())));
            for (const builder of eligibleBuilders) {
                const routes = [];
                if (privateContext) {
                    routes.push({
                        routeId: "blockrazor-private:" + privateContext.region + "@" + String(privateEnvelopeBlock),
                        variant: "private:" + privateContext.region,
                        target: dependency,
                        noMerge: true,
                    });
                }
                else if (builder.config.name === "club48" && validated.source === "club48_auction") {
                    routes.push({
                        routeId: "club48:backrun",
                        variant: "backrun",
                        target: { kind: "club48AuctionId", id: validated.transaction.hash },
                        noMerge: true,
                    });
                }
                if (!privateContext && publicDependencyUsable) {
                    const nextBlock = dependency.kind === "confirmedNextBlock";
                    routes.push({
                        routeId: builder.config.name + (nextBlock ? ":next-block" : ":raw"),
                        variant: nextBlock ? "next-block" : "raw",
                        target: dependency,
                        noMerge: builder.config.name !== "jet",
                    });
                }
                const unseenRoutes = routes.filter((route) => !existingRace?.plannedRoutes.has(route.routeId));
                if (unseenRoutes.length > 0)
                    routesByBuilder.set(builder, unseenRoutes);
            }
            if (routesByBuilder.size === 0) {
                if (existingRace) {
                    this.emit("target_duplicate", {
                        strategy: validated.strategy,
                        targetHash,
                        source: validated.source,
                        reason: "no_new_builder_capability",
                        duplicateAfterMs: existing === undefined ? null : elapsedMs(existing, timing.socketSeenMonoNs),
                    });
                }
                else {
                    this.reject(validated, "no_supported_target_dependency");
                }
                return;
            }
            const headValidUntilBlock = privateContext
                ? privateEnvelopeBlock
                : this.latestHead.number + PUBLIC_BUILDER_DEFAULT_BLOCK_WINDOW;
            if (privateContext && (headValidUntilBlock < privateContext.nextBlockNumber
                || headValidUntilBlock > privateContext.maxBlockNumber)) {
                return this.reject(validated, "blockrazor_private_head_outside_bundle_window");
            }
            const validUntilBlock = headValidUntilBlock;
            // Once a first dispatch optimistically advances the signing frontier,
            // rolling this older Builder envelope must keep its original signed
            // nonce and must never reserve the lane's newer frontier again.
            const lease = existingRace?.frontierCommitted
                ? {
                    startNonce: existingRace.nonce,
                    span: existingRace.nonceSpan,
                    validUntilBlock,
                }
                : lane.nonce.reserve(targetHash, validUntilBlock, process.hrtime.bigint().toString(), privateContext ? 1 : 2);
            const race = existingRace ?? {
                targetHash: validated.transaction.hash,
                strategy: validated.strategy,
                targetIdentity: identity,
                validUntilBlock,
                targetFirstSeenMonoNs: timing.socketSeenMonoNs,
                candidates: new Map(),
                plannedRoutes: new Set(),
                persistedCandidateHashes: new Set(),
                riskAttemptKey: null,
                riskReservationPromise: null,
                nonce: lease.startNonce,
                nonceSpan: lease.span,
                orderingMode: confirmedFallback ? "any_block_after" : "same_block_after",
                executionSettings,
                routerCalldata,
                checkAttempts: 0,
                checking: false,
                latestSignal: validated,
                latestTiming: timing,
                lastSubmittedBlock: validUntilBlock,
                lastSubmissionAt: new Date().toISOString(),
                submittedTransactionHashes: new Set(),
                superseded: false,
            };
            if (existingRace) {
                existingRace.validUntilBlock = validUntilBlock;
                existingRace.latestSignal = validated;
                existingRace.latestTiming = timing;
                if (confirmedFallback)
                    existingRace.orderingMode = "any_block_after";
            }
            let dispatchCount = 0;
            let liveDispatchStarted = false;
            let riskReservationScheduled = false;
            const publicBuySignStartedMonoNs = process.hrtime.bigint();
            const publicBuy = privateContext ? null : signer.signDirectGmgnBuy({
                routerCalldata,
                swapValueWei,
                nonce: lease.startNonce,
                gasPriceWei: executionSettings.gasPriceWei,
                gasLimit: lane.config.gasLimit,
            });
            const publicBuySignMs = publicBuy
                ? elapsedMs(publicBuySignStartedMonoNs, publicBuy.signedMonoNs)
                : null;
            if (this.config.mode === "live") {
                race.riskAttemptKey = race.riskAttemptKey ?? riskAttemptKey({
                    chainId: BSC_CHAIN_ID,
                    signer: signer.address,
                    nonce: lease.startNonce,
                });
                // Publish only in memory before any Builder write. Durable accounting is
                // deferred until after the first network write has started.
                this.activeRaces.set(key, race);
            }
            for (const [builder, targets] of routesByBuilder) {
                const signedStartedMonoNs = process.hrtime.bigint();
                const executorAddress = lane.config.executorAddress ?? SHADOW_EXECUTOR;
                const signed = privateContext
                    ? signer.signPrivateAtomicCopy({
                        executorAddress,
                        tokenOut: privateRewritten.targetTokenAddress,
                        routerCalldata,
                        swapValueWei,
                        minimumOwnerTokenOut: minimumTokenOut,
                        proxyBidContract: privateContext.proxyBidContract,
                        refundAddress: privateContext.refundAddress,
                        refundCfg: BigInt(privateContext.refundCfg),
                        // This is the lane's current Builder payment value. The
                        // private path does not also pay the ordinary Builder tip.
                        proxyBidWei: executionSettings.builderTipWei,
                        validUntilBlock,
                        nonce: lease.startNonce,
                        gasPriceWei: executionSettings.gasPriceWei,
                        gasLimit: lane.config.gasLimit,
                    })
                    : publicBuy;
                const tip = privateContext ? null : this.publicTipFor(validated.strategy, builder, lease.startNonce, race.executionSettings);
                const strategyTxs = tip
                    ? [signed.rawTransaction, tip.rawTransaction]
                    : [signed.rawTransaction];
                const candidate = race.candidates.get(signed.hash.toLowerCase()) ?? {
                    hash: signed.hash,
                    valueWei: signed.valueWei,
                    builders: [],
                    tipCandidates: new Map(),
                };
                if (tip) {
                    candidate.tipCandidates.set(tip.hash.toLowerCase(), {
                        hash: tip.hash,
                        valueWei: tip.valueWei,
                    });
                }
                race.candidates.set(signed.hash.toLowerCase(), candidate);
                for (const target of targets) {
                    if (race.plannedRoutes.has(target.routeId))
                        continue;
                    race.plannedRoutes.add(target.routeId);
                    let prepared;
                    try {
                        const commonIntent = {
                            target: target.target,
                            strategyTxs,
                            noMerge: target.noMerge,
                            positionFirst: false,
                        };
                        prepared = builder.prepare(privateContext ? {
                            ...commonIntent,
                            // The private disclosure carries an upstream block window and
                            // still needs the exact current private envelope constraint.
                            maxBlockNumber: validUntilBlock,
                            minTimestamp: 0,
                            maxTimestamp: Math.floor(Date.now() / 1_000) + 60,
                        } : commonIntent);
                    }
                    catch (error) {
                        race.plannedRoutes.delete(target.routeId);
                        this.emit("builder_candidate_skipped", {
                            strategy: validated.strategy,
                            targetHash,
                            builder: builder.config.name,
                            variant: target.variant,
                            reason: errorText(error),
                        });
                        continue;
                    }
                    const routeLabel = builder.config.name + ":" + target.variant;
                    const candidateKey = signed.hash.toLowerCase();
                    const submitStartedMonoNs = process.hrtime.bigint();
                    let dispatchPromise = null;
                    if (this.config.mode === "live") {
                        const blockedReason = this.canBroadcast({
                            race,
                            lane,
                            builder,
                            signal: validated,
                            targetHash,
                            routeId: target.routeId,
                            routeLabel,
                            candidateHash: candidateKey,
                        });
                        if (blockedReason) {
                            const context = {
                                race,
                                lane,
                                builder,
                                signal: validated,
                                targetHash,
                                routeId: target.routeId,
                                routeLabel,
                                candidateHash: candidateKey,
                            };
                            await this.cancelBeforeBroadcast(context, blockedReason);
                            return;
                        }
                        // No await is permitted between the final gate, marking the route
                        // submitted, and invoking dispatch. Stop/disarm/circuit callbacks
                        // therefore cannot interleave inside this synchronous section.
                        const coldDispatch = !this.builderIsFresh(builder, process.hrtime.bigint());
                        if (!race.frontierCommitted)
                            lane.nonce.markSubmitted(targetHash, builder.config.name);
                        dispatchPromise = builder.dispatch(prepared);
                        liveDispatchStarted = true;
                        if (!riskReservationScheduled) {
                            riskReservationScheduled = true;
                            this.deferRiskReservation(race, lane, signer.address, worstCost, validUntilBlock);
                        }
                        this.dispatchNotifier?.afterBuilderDispatchStarted(validated.strategy, targetHash);
                        race.lastSubmittedBlock = validUntilBlock;
                        race.lastSubmissionAt = new Date().toISOString();
                        race.submittedTransactionHashes.add(signed.hash.toLowerCase());
                        this.rememberOwnHash(signed.hash, validUntilBlock + 64);
                        if (tip) {
                            race.submittedTransactionHashes.add(tip.hash.toLowerCase());
                            this.rememberOwnHash(tip.hash, validUntilBlock + 64);
                        }
                        if (coldDispatch)
                            this.emit("builder_cold_dispatch", {
                                strategy: validated.strategy,
                                targetHash,
                                builder: builder.config.name,
                                validUntilBlock,
                            });
                    }
                    if (!candidate.builders.includes(routeLabel))
                        candidate.builders.push(routeLabel);
                    dispatchCount += 1;
                    this.emit("builder_candidate_ready", {
                        strategy: validated.strategy,
                        targetHash,
                        copyHash: signed.hash,
                        tipHash: tip?.hash ?? null,
                        builder: builder.config.name,
                        variant: target.variant,
                        signMs: privateContext
                            ? elapsedMs(signedStartedMonoNs, signed.signedMonoNs)
                            : publicBuySignMs,
                        tipPreparedAhead: Boolean(tip && tip.signedMonoNs < timing.socketSeenMonoNs),
                        riskPersistMs: null,
                        riskPersistenceDeferred: this.config.mode === "live",
                        firstSeenToSubmitStartMs: elapsedMs(timing.socketSeenMonoNs, submitStartedMonoNs),
                        mode: this.config.mode,
                        coldDispatch: !this.builderIsFresh(builder, process.hrtime.bigint()),
                    });
                    if (dispatchPromise) {
                        void dispatchPromise.then((ack) => this.handleAck(validated.strategy, targetHash, target.variant, ack));
                    }
                }
            }
            if (liveDispatchStarted) {
                if (!race.frontierCommitted) {
                    const committed = lane.nonce.optimisticCommit(targetHash);
                    race.frontierCommitted = true;
                    this.refreshPublicTipCache(validated.strategy);
                    this.emit("signing_frontier_committed", {
                        strategy: validated.strategy,
                        targetHash,
                        startNonce: race.nonce,
                        nonceSpan: race.nonceSpan,
                        nextNonce: committed.nextNonce,
                    });
                    this.scheduleQueueDrain(validated.strategy);
                }
            }
            const finishedMonoNs = process.hrtime.bigint();
            this.emit("target_planned", {
                strategy: validated.strategy,
                targetHash,
                tokenOut: targetTokenAddress,
                source: validated.source,
                head: this.latestHead.number,
                validUntilBlock,
                predecessorCount: validated.requiredPredecessors?.length ?? 0,
                socketToParsedMs: elapsedMs(timing.socketSeenMonoNs, timing.parsedMonoNs),
                socketToMatchedMs: elapsedMs(timing.socketSeenMonoNs, timing.matchedMonoNs),
                socketToEnvelopeValidatedMs: elapsedMs(timing.socketSeenMonoNs, validatedMonoNs),
                socketToCalldataValidatedMs: elapsedMs(timing.socketSeenMonoNs, calldataValidatedMonoNs),
                socketToAllCandidatesReadyMs: elapsedMs(timing.socketSeenMonoNs, finishedMonoNs),
                dispatchCount,
                headAgeMs,
            });
            if (dispatchCount > 0 && existing === undefined) {
                this.seenTargets.set(key, timing.socketSeenMonoNs);
                this.pruneSeenTargets(timing.socketSeenMonoNs);
            }
            if (this.config.mode === "live" && dispatchCount > 0) {
                this.activeRaces.set(key, race);
            }
            else if (this.config.mode === "shadow" && dispatchCount > 0) {
                lane.nonce.markIncluded(targetHash);
                this.refreshPublicTipCache(validated.strategy);
            }
            else if (dispatchCount > 0) {
                lane.nonce.releaseUnsubmitted(targetHash);
            }
            else {
                if (this.config.mode === "live" && this.activeRaces.get(key) === race) {
                    this.activeRaces.delete(key);
                }
                lane.nonce.releaseUnsubmitted(targetHash);
            }
        }
        catch (error) {
            const lane = this.lanes[signal.strategy];
            lane.lastError = errorText(error);
            this.emit("target_rejected", {
                strategy: signal.strategy,
                targetHash,
                reason: lane.lastError,
                elapsedMs: nowMsSince(timing.socketSeenMonoNs),
            });
        }
    }
    /**
     * Queue durable accounting as soon as the first Builder write starts. The
     * promise continuation cannot run until this synchronous planning stack has
     * invoked the remaining eligible Builders, so reserveAttempt's validation,
     * cloning and JSON serialization never block the three-way fanout. Hashes are
     * collected inside that continuation so it sees every candidate prepared by
     * the current fanout. A failure trips only this lane; restart reconciliation
     * also treats an untracked pending nonce as terminal.
     */
    deferRiskReservation(race, lane, signerAddress, worstCostWei, submittedBlock) {
        if (this.config.mode !== "live")
            return;
        const previous = race.riskReservationPromise ?? Promise.resolve();
        const operation = previous.then(async () => {
            const candidateHashes = [...race.candidates.keys()];
            const tipCandidateHashes = [...new Set([...race.candidates.values()].flatMap((candidate) => [...candidate.tipCandidates.keys()]))];
            try {
                await lane.ledger.reserveAttempt({
                    chainId: BSC_CHAIN_ID,
                    signer: signerAddress,
                    nonce: race.nonce,
                    strategy: race.strategy,
                    targetHash: race.targetHash,
                    candidateHashes,
                    tipCandidateHashes,
                    maxBlock: submittedBlock,
                    worstCostWei,
                    orderingMode: race.orderingMode,
                });
                for (const hash of candidateHashes)
                    race.persistedCandidateHashes.add(hash);
                this.emit("risk_attempt_reserved_after_dispatch", {
                    strategy: race.strategy,
                    targetHash: race.targetHash,
                    lastSubmittedBlock: submittedBlock,
                });
            }
            catch (error) {
                await this.breakLaneCircuitPersistent(race.strategy, "post-dispatch risk reservation failed: " + errorText(error));
            }
        });
        race.riskReservationPromise = this.trackPromise(this.reconciliationPromises, operation);
    }
    feedIsActionable(name, metrics) {
        if (name.startsWith("heads-"))
            return false;
        if ("actionable" in metrics)
            return metrics.actionable === true;
        return metrics.connected && metrics.connectionState === "streaming";
    }
    authorityHeadFreshness(nowMonoNs) {
        if (!this.latestHead)
            return { current: false, deliveryAgeMs: null, timestampLagMs: null };
        const deliveryAgeMs = Math.round(Number(nowMonoNs - this.latestHead.seenMonoNs) / 1e6);
        const timestampLagMs = Date.now() - (this.latestHead.timestamp * 1_000);
        const maximumLagMs = DEFAULT_AUTHORITY_HEAD_MAX_TIMESTAMP_LAG_MS;
        return {
            current: deliveryAgeMs >= 0
                && deliveryAgeMs <= maximumLagMs
                && Math.abs(timestampLagMs) <= maximumLagMs,
            deliveryAgeMs,
            timestampLagMs,
        };
    }
    builderIsFresh(builder, now) {
        if (this.config.mode !== "live")
            return true;
        const candidate = builder;
        if (typeof candidate.isFresh === "function")
            return candidate.isFresh(now);
        // Tests and embedders may provide a structural Builder stand-in. Keep the
        // legacy snapshot fallback, but bind freshness to that Builder's own idle
        // target rather than a process-wide heartbeat interval.
        const value = candidate.snapshot().lastPrewarmMonoNs;
        if (value === null)
            return false;
        const age = now - BigInt(value);
        const intervalMs = candidate.config.prewarmIntervalMs
            ?? DEFAULT_BUILDERS[candidate.config.name].prewarmIntervalMs;
        return age >= 0n && age <= BigInt(intervalMs * 3) * 1000000n;
    }
    routeReadiness(now) {
        const actionable = [...this.feedMetrics.entries()]
            .filter(([name, metrics]) => this.feedIsActionable(name, metrics));
        const publicSourceReady = actionable.some(([name]) => !name.startsWith("blockrazor-private-"));
        const publicBuilderReady = this.builders.length > 0;
        const privateSourceRegions = actionable
            .map(([name]) => name.startsWith("blockrazor-private-")
            ? name.slice("blockrazor-private-".length)
            : null)
            .filter((region) => Boolean(region));
        const privateRouteReady = privateSourceRegions.some((region) => {
            const builder = this.privateBuilders.get(region);
            return Boolean(builder);
        });
        return {
            sourceReady: publicSourceReady || privateSourceRegions.length > 0,
            routeReady: (publicSourceReady && publicBuilderReady) || privateRouteReady,
        };
    }
    /** Final synchronous gate immediately before every real Builder call. */
    canBroadcast(context) {
        if (this.stopped || this.broadcastClosed)
            return "broadcast_closed";
        if (!this.armGate.armed)
            return "not_armed";
        if (this.circuitBroken)
            return "memory_circuit_broken";
        if (this.globalLedger.circuitState().tripped)
            return "persistent_circuit_broken";
        if (context.lane.circuitBroken)
            return "memory_lane_circuit_broken";
        if (context.lane.ledger.circuitState().tripped)
            return "persistent_lane_circuit_broken";
        if (this.lanes[context.race.strategy] !== context.lane
            || context.signal.strategy !== context.race.strategy
            || !sameTargetIdentity(context.race.targetIdentity, canonicalTargetIdentity(context.signal))) {
            return "lane_race_identity_mismatch";
        }
        if (context.signal.source === "blockrazor_private_mempool") {
            const region = context.signal.blockRazorPrivateBundle?.region;
            if (!region || this.privateBuilders.get(region) !== context.builder)
                return "private_builder_region_mismatch";
        }
        const head = this.latestHead;
        if (!head)
            return "head_unknown";
        if (!this.authorityHeadFreshness(process.hrtime.bigint()).current)
            return "head_stale";
        if (this.activeRaces.get(targetRaceKey(context.race.strategy, context.targetHash)) !== context.race)
            return "race_not_active";
        if (!context.race.plannedRoutes.has(context.routeId))
            return "route_not_planned";
        if (!context.race.candidates.has(context.candidateHash))
            return "candidate_not_planned";
        const laneSnapshot = context.lane.nonce.snapshot();
        if (context.race.frontierCommitted) {
            if (laneSnapshot.nextNonce === null
                || laneSnapshot.nextNonce < context.race.nonce + context.race.nonceSpan) {
                return "signing_frontier_regressed";
            }
        }
        else {
            const lease = laneSnapshot.lease;
            if ((laneSnapshot.state !== "reserved" && laneSnapshot.state !== "submitted")
                || !lease
                || lease.targetHash !== context.targetHash
                || lease.startNonce !== context.race.nonce
                || lease.validUntilBlock !== context.race.validUntilBlock) {
                return "nonce_lease_changed";
            }
        }
        const signer = context.lane.config.signer;
        if (!signer
            || context.race.riskAttemptKey !== riskAttemptKey({
                chainId: BSC_CHAIN_ID,
                signer: signer.address,
                nonce: context.race.nonce,
            })) {
            return "risk_attempt_identity_mismatch";
        }
        return null;
    }
    async cancelBeforeBroadcast(context, reason) {
        this.skipBuilderRoute(context, reason);
        const laneSnapshot = context.lane.nonce.snapshot();
        const lease = laneSnapshot.lease;
        const signer = context.lane.config.signer;
        const expectedAttemptKey = signer
            ? riskAttemptKey({ chainId: BSC_CHAIN_ID, signer: signer.address, nonce: context.race.nonce })
            : null;
        const provesNeverSubmitted = laneSnapshot.state === "reserved"
            && lease?.targetHash === context.targetHash
            && lease.startNonce === context.race.nonce
            && lease.submittedBuilders.length === 0;
        const attemptKey = context.race.riskAttemptKey;
        const attempt = attemptKey ? context.lane.ledger.attempt(attemptKey) : null;
        if (provesNeverSubmitted && !context.race.riskReservationPromise && !attempt) {
            const key = targetRaceKey(context.race.strategy, context.targetHash);
            if (this.activeRaces.get(key) === context.race)
                this.activeRaces.delete(key);
            context.lane.nonce.releaseUnsubmitted(context.targetHash);
            this.emit("in_memory_attempt_released_before_broadcast", {
                strategy: context.race.strategy,
                targetHash: context.targetHash,
                reason,
            });
            return;
        }
        const identityConsistent = Boolean(signer
            && expectedAttemptKey
            && attemptKey === expectedAttemptKey
            && this.activeRaces.get(targetRaceKey(context.race.strategy, context.targetHash)) === context.race
            && this.lanes[context.race.strategy] === context.lane
            && context.signal.strategy === context.race.strategy
            && sameTargetIdentity(context.race.targetIdentity, canonicalTargetIdentity(context.signal))
            && context.race.targetHash.toLowerCase() === context.targetHash
            && attempt?.state === "reserved"
            && attempt.chainId === BSC_CHAIN_ID
            && attempt.signer === signer.address.toLowerCase()
            && attempt.strategy === context.race.strategy
            && attempt.targetHash === context.targetHash
            && attempt.nonce === context.race.nonce
            && attempt.maxBlock === context.race.validUntilBlock
            && attempt.candidateHashes.includes(context.candidateHash)
            && context.race.persistedCandidateHashes.has(context.candidateHash)
            && context.race.candidates.has(context.candidateHash));
        if (!provesNeverSubmitted || !identityConsistent || !attemptKey) {
            this.emit("risk_attempt_retained", {
                strategy: context.race.strategy,
                targetHash: context.targetHash,
                reason: "submission_cannot_be_excluded",
            });
            return;
        }
        try {
            // No Builder call can have occurred: markSubmitted is synchronous and is
            // always executed before dispatch. Only this proof permits durable release.
            await context.lane.ledger.releaseConfirmedNotIncluded(attemptKey);
            const key = targetRaceKey(context.race.strategy, context.targetHash);
            if (this.activeRaces.get(key) === context.race) {
                this.activeRaces.delete(key);
            }
            context.lane.nonce.releaseUnsubmitted(context.targetHash);
            this.emit("risk_attempt_released_before_broadcast", {
                strategy: context.race.strategy,
                targetHash: context.targetHash,
                reason,
            });
        }
        catch (error) {
            await this.breakLaneCircuitPersistent(context.race.strategy, "failed to release a provably unsubmitted risk attempt");
            this.emit("risk_attempt_retained", {
                strategy: context.race.strategy,
                targetHash: context.targetHash,
                reason: "release_persistence_failed:" + errorText(error),
            });
        }
    }
    skipBuilderRoute(context, reason) {
        context.race.plannedRoutes.delete(context.routeId);
        this.emit("builder_candidate_blocked", {
            strategy: context.race.strategy,
            targetHash: context.targetHash,
            builderRoute: context.routeLabel,
            reason,
        });
    }
    handleHead(head) {
        const previousNumber = this.latestHead?.number ?? null;
        if (!this.latestHead || head.number > this.latestHead.number) {
            this.latestHead = head;
        }
        else if (head.number === this.latestHead.number && (head.source === "confirmed-loopback"
            || head.seenMonoNs < this.latestHead.seenMonoNs)) {
            this.latestHead = head;
        }
        if (this.latestHead) {
            for (const resolve of this.headReadyWaiters)
                resolve();
            this.headReadyWaiters.clear();
        }
        const advanced = previousNumber === null || head.number > previousNumber;
        if (advanced) {
            for (const [hash, expiresAfterBlock] of this.recentOwnHashes) {
                if (expiresAfterBlock < head.number)
                    this.recentOwnHashes.delete(hash);
            }
            for (const strategy of ["ed", "kuzuo"]) {
                const immediate = setImmediate(() => this.refreshLaneNonceAtHead(strategy, head.number));
                immediate.unref();
                this.scheduleQueueDrain(strategy);
            }
        }
        for (const race of this.activeRaces.values()) {
            if (advanced && race.lastReceiptCheckHead !== head.number) {
                race.lastReceiptCheckHead = head.number;
                const timer = setTimeout(() => void this.checkRace(race), 25);
                timer.unref();
            }
            if (advanced && !this.stopped && !this.broadcastClosed && !race.superseded && !race.inclusionObserved
                && race.latestSignal && isBlockRazorPrivateTransaction(race.latestSignal.transaction)
                && head.number + 1 > race.validUntilBlock) {
                void this.handleTarget(race.latestSignal, race.latestTiming);
            }
        }
    }
    handleAck(strategy, targetHash, variant, ack) {
        this.emit("builder_ack", {
            strategy,
            targetHash,
            builder: ack.builder,
            variant,
            accepted: ack.accepted,
            bundleId: ack.bundleId,
            httpStatus: ack.httpStatus,
            latencyMs: Math.round(ack.latencyMs * 1_000) / 1_000,
            error: ack.error,
        });
    }
    checkRace(race) {
        if (race.checking)
            return Promise.resolve();
        race.checking = true;
        const operation = this.reconcileRace(race).finally(() => {
            race.checking = false;
        });
        return this.trackPromise(this.reconciliationPromises, operation);
    }
    async reconcileRace(race) {
        if (this.stopped || !this.rpc || !this.activeRaces.has(targetRaceKey(race.strategy, race.targetHash)))
            return;
        if (race.riskReservationPromise)
            await race.riskReservationPromise;
        if (this.config.mode === "live" && (!race.riskAttemptKey || !this.lanes[race.strategy].ledger.attempt(race.riskAttemptKey))) {
            await this.markRaceUnresolved(race, "post-dispatch risk attempt is not durable");
            return;
        }
        race.checkAttempts += 1;
        let receiptRoundFailed = false;
        try {
            const entries = [...race.candidates.values()];
            const tipEntries = [...new Map(entries.flatMap((candidate) => [...candidate.tipCandidates.values()])
                    .map((tip) => [tip.hash.toLowerCase(), tip])).values()];
            const receiptResult = await Promise.all([
                this.rpc.receipt(race.targetHash),
                Promise.all(entries.map(async (candidate) => ({
                    candidate,
                    receipt: await this.rpc.receipt(candidate.hash),
                }))),
                Promise.all(tipEntries.map(async (tip) => ({
                    tip,
                    receipt: await this.rpc.receipt(tip.hash),
                }))),
            ]);
            const targetReceipt = receiptResult[0];
            const candidateReceipts = receiptResult[1];
            const includedTips = receiptResult[2].filter((entry) => entry.receipt !== null);
            if (includedTips.length > 1) {
                await this.markRaceUnresolved(race, "multiple tip candidates consumed the same nonce", "global");
                return;
            }
            const includedTip = includedTips[0] ?? null;
            const included = candidateReceipts.find((entry) => entry.receipt !== null);
            if (!included?.receipt && includedTip?.receipt) {
                const tipFinalityBlock = includedTip.receipt.blockNumber + RECEIPT_FINALITY_BLOCKS;
                if (this.latestHead && this.latestHead.number >= tipFinalityBlock) {
                    await this.markRaceUnresolved(race, "tip receipt finalized without its nonce predecessor buy receipt", "global");
                }
                return;
            }
            if (included?.receipt) {
                const observedFinalityBlock = Math.max(included.receipt.blockNumber, includedTip?.receipt?.blockNumber ?? included.receipt.blockNumber) + RECEIPT_FINALITY_BLOCKS;
                if (!targetReceipt) {
                    if (this.latestHead && this.latestHead.number >= observedFinalityBlock) {
                        await this.markRaceUnresolved(race, "copy receipt finalized without the target receipt required for ordering", "global");
                    }
                    return;
                }
                const provisional = race.provisionalInclusion;
                if (!provisional) {
                    race.inclusionObserved = true;
                    race.provisionalInclusion = {
                        candidateHash: included.candidate.hash,
                        receipt: { ...included.receipt },
                        targetReceipt: { ...targetReceipt },
                        tipCandidateHash: includedTip?.tip.hash ?? null,
                        tipReceipt: includedTip?.receipt ? { ...includedTip.receipt } : null,
                    };
                    this.emit("copy_inclusion_provisional", {
                        strategy: race.strategy,
                        targetHash: race.targetHash,
                        copyHash: included.candidate.hash,
                        blockNumber: included.receipt.blockNumber,
                        blockHash: included.receipt.blockHash,
                        tipHash: includedTip?.tip.hash ?? null,
                        tipBlockNumber: includedTip?.receipt?.blockNumber ?? null,
                        finalityBlock: observedFinalityBlock,
                    });
                    return;
                }
                if (provisional.candidateHash !== included.candidate.hash
                    || !sameCanonicalReceipt(provisional.receipt, included.receipt)
                    || !sameCanonicalReceipt(provisional.targetReceipt, targetReceipt)) {
                    await this.markRaceUnresolved(race, "provisional copy/target receipt changed before finality", "global");
                    return;
                }
                if (provisional.tipReceipt) {
                    if (!includedTip?.receipt
                        || provisional.tipCandidateHash !== includedTip.tip.hash
                        || !sameCanonicalReceipt(provisional.tipReceipt, includedTip.receipt)) {
                        await this.markRaceUnresolved(race, "provisional tip receipt changed before finality", "global");
                        return;
                    }
                }
                else if (includedTip?.receipt) {
                    // A provider may expose the independent N+1 tip after the N buy.
                    // Start a fresh canonical observation for the tip and require another
                    // head-driven read after its own +2 finality window.
                    provisional.tipCandidateHash = includedTip.tip.hash;
                    provisional.tipReceipt = { ...includedTip.receipt };
                    this.emit("copy_tip_inclusion_provisional", {
                        strategy: race.strategy,
                        targetHash: race.targetHash,
                        copyHash: included.candidate.hash,
                        tipHash: includedTip.tip.hash,
                        tipBlockNumber: includedTip.receipt.blockNumber,
                        finalityBlock: Math.max(included.receipt.blockNumber, includedTip.receipt.blockNumber)
                            + RECEIPT_FINALITY_BLOCKS,
                    });
                    return;
                }
                const receiptFinalityBlock = Math.max(provisional.receipt.blockNumber, provisional.tipReceipt?.blockNumber ?? provisional.receipt.blockNumber) + RECEIPT_FINALITY_BLOCKS;
                if (!this.latestHead || this.latestHead.number < receiptFinalityBlock) {
                    return;
                }
                const rpcBlock = await this.rpc.blockNumber();
                if (rpcBlock < receiptFinalityBlock) {
                    return;
                }
                if (race.nonceSpan === 2 && !provisional.tipReceipt) {
                    if (race.riskAttemptKey) {
                        await this.lanes[race.strategy].ledger.chargeUnknownConsumption(race.riskAttemptKey);
                    }
                    await this.markRaceUnresolved(race, "public atomic bundle finalized with buy N but without its independent tip N+1");
                    return;
                }
                await this.finishIncludedRace(race, included.candidate, included.receipt, targetReceipt, includedTip?.tip ?? null, includedTip?.receipt ?? null);
                return;
            }
            if (race.provisionalInclusion) {
                const receiptFinalityBlock = Math.max(race.provisionalInclusion.receipt.blockNumber, race.provisionalInclusion.tipReceipt?.blockNumber ?? race.provisionalInclusion.receipt.blockNumber) + RECEIPT_FINALITY_BLOCKS;
                if (this.latestHead && this.latestHead.number >= receiptFinalityBlock) {
                    await this.markRaceUnresolved(race, "provisional copy receipt disappeared before finality", "global");
                    return;
                }
            }
        }
        catch (error) {
            receiptRoundFailed = true;
            this.emit("receipt_check_retry", {
                strategy: race.strategy,
                targetHash: race.targetHash,
                attempt: race.checkAttempts,
                reason: errorText(error),
            });
        }
        if (receiptRoundFailed)
            return;
        const finalityBlock = (race.lastSubmittedBlock ?? race.validUntilBlock) + RECEIPT_FINALITY_BLOCKS;
        if (!this.latestHead || this.latestHead.number < finalityBlock) {
            return;
        }
        const lane = this.lanes[race.strategy];
        const signer = lane.config.signer;
        if (!signer) {
            await this.markRaceUnresolved(race, "signer unavailable during receipt reconciliation");
            return;
        }
        try {
            const [rpcBlock, latestNonce, pendingNonce] = await Promise.all([
                this.rpc.blockNumber(),
                this.rpc.latestNonce(signer.address),
                this.rpc.pendingNonce(signer.address),
            ]);
            if (rpcBlock < finalityBlock) {
                return;
            }
            if (latestNonce === race.nonce && pendingNonce === race.nonce) {
                const deferredConfirmedUpgrade = race.deferredConfirmedUpgrade;
                if (race.riskAttemptKey)
                    await lane.ledger.releaseConfirmedNotIncluded(race.riskAttemptKey);
                this.activeRaces.delete(targetRaceKey(race.strategy, race.targetHash));
                this.seenTargets.delete(targetRaceKey(race.strategy, race.targetHash));
                lane.lastError = null;
                this.emit("copy_expired", {
                    strategy: race.strategy,
                    targetHash: race.targetHash,
                    validUntilBlock: race.validUntilBlock,
                    finalityBlock,
                    reason: "confirmed_not_included_nonce_unchanged",
                });
                if (deferredConfirmedUpgrade && !this.stopped && !this.broadcastClosed) {
                    this.enqueueTarget(lane, deferredConfirmedUpgrade.signal, deferredConfirmedUpgrade.timing, "private_span_released_for_confirmed_upgrade");
                }
                this.scheduleQueueDrain(race.strategy);
                return;
            }
            if (latestNonce > race.nonce || pendingNonce > race.nonce) {
                if (race.riskAttemptKey)
                    await lane.ledger.chargeUnknownConsumption(race.riskAttemptKey);
                await this.markRaceUnresolved(race, `copy nonce advanced without a candidate receipt (latest=${String(latestNonce)}, pending=${String(pendingNonce)})`);
                return;
            }
            await this.markRaceUnresolved(race, `copy nonce regressed below the reserved nonce (latest=${String(latestNonce)}, pending=${String(pendingNonce)})`);
        }
        catch (error) {
            // Keep the reservation and this lane blocked. A transient receipt/nonce
            // outage must never be converted into a reusable nonce.
            lane.lastError = "reconciliation_retry:" + errorText(error);
        }
    }
    async finishIncludedRace(race, candidate, receipt, targetReceipt, tipCandidate, tipReceipt) {
        const lane = this.lanes[race.strategy];
        const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
        const separateTipCost = tipReceipt
            ? (tipReceipt.gasUsed * tipReceipt.effectiveGasPrice)
                + (tipReceipt.status === 1 ? tipCandidate?.valueWei ?? 0n : 0n)
            : 0n;
        const actualCost = gasCost + separateTipCost + (receipt.status === 1 ? candidate.valueWei : 0n);
        const orderedAfterTarget = Boolean(targetReceipt
            && receipt.status === 1
            && targetReceipt.status === 1
            && targetReceipt.blockNumber === receipt.blockNumber
            && receipt.transactionIndex > targetReceipt.transactionIndex);
        const nextBlockAfterTarget = Boolean(targetReceipt
            && receipt.status === 1
            && targetReceipt.status === 1
            && receipt.blockNumber === targetReceipt.blockNumber + 1);
        const ordered = this.orderingAccepted(receipt, targetReceipt, race.orderingMode);
        if (!ordered) {
            await this.breakLaneCircuitPersistent(race.strategy, "included copy did not prove it followed the target");
        }
        if (tipReceipt && !tipCandidate) {
            await this.markRaceUnresolved(race, "included tip receipt has no locally signed candidate", "global");
            return;
        }
        if (tipReceipt && (tipReceipt.blockNumber < receipt.blockNumber
            || (tipReceipt.blockNumber === receipt.blockNumber
                && tipReceipt.transactionIndex <= receipt.transactionIndex))) {
            await this.markRaceUnresolved(race, "included tip did not prove it followed the buy", "global");
            return;
        }
        try {
            if (race.riskAttemptKey) {
                await lane.ledger.settleAttemptActual(race.riskAttemptKey, actualCost);
            }
            else {
                await lane.ledger.recordIncluded(race.strategy, actualCost);
            }
        }
        catch (error) {
            await this.breakLaneCircuitPersistent(race.strategy, "included copy could not be durably accounted: " + errorText(error));
            return;
        }
        this.refreshPublicTipCache(race.strategy);
        lane.lastError = null;
        this.activeRaces.delete(targetRaceKey(race.strategy, race.targetHash));
        this.emit("copy_included", {
            strategy: race.strategy,
            targetHash: race.targetHash,
            copyHash: candidate.hash,
            tipHash: tipCandidate?.hash ?? null,
            tipIncluded: Boolean(tipReceipt),
            builders: candidate.builders,
            blockNumber: receipt.blockNumber,
            transactionIndex: receipt.transactionIndex,
            targetTransactionIndex: targetReceipt?.transactionIndex ?? null,
            status: receipt.status,
            sameBlockAfterTarget: orderedAfterTarget,
            nextBlockAfterTarget,
            orderedAfterTarget,
            orderingAccepted: ordered,
            orderingMode: race.orderingMode,
            transactionGap: targetReceipt ? receipt.transactionIndex - targetReceipt.transactionIndex : null,
            actualCostWei: actualCost.toString(),
            actualCostBnb: formatEther(actualCost),
            firstSeenToReceiptCheckMs: nowMsSince(race.targetFirstSeenMonoNs),
        });
        this.scheduleQueueDrain(race.strategy);
        if (receipt.status === 1 && ordered && this.positionLedger.enabled) {
            // Position reads, optional metadata and fsync are deliberately detached
            // from dispatch, risk settlement and nonce release.
            try {
                this.positionLedger.recordIncluded({
                    strategy: race.strategy,
                    tokenAddress: finalTokenFromGmgnCalldata(race.routerCalldata),
                    sourceTxHash: candidate.hash,
                });
            }
            catch (error) {
                this.emit("position_tracker_error", { reason: errorText(error) });
            }
        }
    }
    async markRaceUnresolved(race, reason, scope = "lane") {
        this.activeRaces.delete(targetRaceKey(race.strategy, race.targetHash));
        const lane = this.lanes[race.strategy];
        // An optimistic race owns only its immutable historical allocation. A
        // newer target may already be using the live NonceLane frontier, so old
        // receipt/reorg uncertainty must never clear or rewind that newer lease.
        lane.lastError = reason;
        if (scope === "global")
            await this.breakCircuitPersistent(reason);
        else
            await this.breakLaneCircuitPersistent(race.strategy, reason);
        this.emit("copy_reconciliation_required", {
            strategy: race.strategy,
            targetHash: race.targetHash,
            validUntilBlock: race.validUntilBlock,
            reason,
        });
    }
    async reconcilePersistedLane(strategy, latestNonce, pendingNonce, currentBlock) {
        const lane = this.lanes[strategy];
        const signer = lane.config.signer;
        if (!this.rpc || !signer)
            return;
        const attempts = Object.values(lane.ledger.snapshot().attempts)
            .filter((attempt) => attempt.chainId === BSC_CHAIN_ID
            && attempt.signer === signer.address.toLowerCase()
            && attempt.strategy === strategy
            && (attempt.state === "reserved" || attempt.state === "unknown_charged"))
            .sort((left, right) => left.nonce - right.nonce);
        for (const attempt of attempts) {
            try {
                const [receipts, tipReceipts] = await Promise.all([
                    Promise.all(attempt.candidateHashes.map(async (hash) => ({
                        hash,
                        receipt: await this.rpc.receipt(hash),
                    }))),
                    Promise.all(attempt.tipCandidateHashes.map(async (hash) => ({
                        hash,
                        receipt: await this.rpc.receipt(hash),
                    }))),
                ]);
                const included = receipts.find((entry) => entry.receipt !== null);
                const includedTips = tipReceipts.filter((entry) => entry.receipt !== null);
                if (includedTips.length > 1) {
                    await this.breakCircuitPersistent("startup found multiple tip receipts for one nonce span");
                    continue;
                }
                const includedTip = includedTips[0] ?? null;
                if (included?.receipt) {
                    const receiptFinalityBlock = Math.max(included.receipt.blockNumber, includedTip?.receipt?.blockNumber ?? included.receipt.blockNumber) + RECEIPT_FINALITY_BLOCKS;
                    if (currentBlock < receiptFinalityBlock) {
                        await this.breakLaneCircuitPersistent(strategy, "startup found a provisional copy/tip receipt before finality");
                        continue;
                    }
                    const [targetReceipt, confirmedReceipt, confirmedTargetReceipt, transactionValue, confirmedTipReceipt, tipTransactionValue] = await Promise.all([
                        this.rpc.receipt(attempt.targetHash),
                        this.rpc.receipt(included.hash),
                        this.rpc.receipt(attempt.targetHash),
                        this.rpc.transactionValue(included.hash),
                        includedTip ? this.rpc.receipt(includedTip.hash) : Promise.resolve(null),
                        includedTip ? this.rpc.transactionValue(includedTip.hash) : Promise.resolve(null),
                    ]);
                    if (!targetReceipt
                        || !confirmedReceipt
                        || !confirmedTargetReceipt
                        || !sameCanonicalReceipt(included.receipt, confirmedReceipt)
                        || !sameCanonicalReceipt(targetReceipt, confirmedTargetReceipt)) {
                        await this.breakCircuitPersistent("startup could not prove stable canonical copy/target receipts at finality");
                        continue;
                    }
                    const gasCost = confirmedReceipt.gasUsed * confirmedReceipt.effectiveGasPrice;
                    const buyCost = transactionValue === null
                        ? BigInt(attempt.worstCostWei)
                        : gasCost + (confirmedReceipt.status === 1 ? transactionValue : 0n);
                    if (includedTip && (!confirmedTipReceipt
                        || !includedTip.receipt
                        || !sameCanonicalReceipt(includedTip.receipt, confirmedTipReceipt))) {
                        await this.breakCircuitPersistent("startup could not prove a stable canonical tip receipt at finality");
                        continue;
                    }
                    if (confirmedTipReceipt && (confirmedTipReceipt.blockNumber < confirmedReceipt.blockNumber
                        || (confirmedTipReceipt.blockNumber === confirmedReceipt.blockNumber
                            && confirmedTipReceipt.transactionIndex <= confirmedReceipt.transactionIndex))) {
                        await this.breakCircuitPersistent("startup tip receipt did not prove it followed the buy");
                        continue;
                    }
                    const expectsAtomicTip = attempt.tipCandidateHashes.length > 0;
                    if (expectsAtomicTip && !confirmedTipReceipt) {
                        await lane.ledger.chargeUnknownConsumption(attempt.key);
                        await this.breakLaneCircuitPersistent(strategy, "startup public atomic bundle has buy N without stable tip N+1");
                        continue;
                    }
                    const expectedSpan = expectsAtomicTip ? 2 : 1;
                    if (pendingNonce < latestNonce || latestNonce < attempt.nonce + expectedSpan) {
                        await this.breakLaneCircuitPersistent(strategy, "startup receipt inclusion disagreed with authoritative nonce");
                        continue;
                    }
                    const tipCost = confirmedTipReceipt
                        ? (confirmedTipReceipt.gasUsed * confirmedTipReceipt.effectiveGasPrice)
                            + (confirmedTipReceipt.status === 1 ? tipTransactionValue ?? 0n : 0n)
                        : 0n;
                    const tipValueUnknown = Boolean(confirmedTipReceipt
                        && confirmedTipReceipt.status === 1
                        && tipTransactionValue === null);
                    const actualCost = transactionValue === null || tipValueUnknown
                        ? BigInt(attempt.worstCostWei)
                        : buyCost + tipCost;
                    await lane.ledger.settleAttemptActual(attempt.key, actualCost);
                    if (!this.orderingAccepted(confirmedReceipt, confirmedTargetReceipt, attempt.orderingMode)) {
                        await this.breakLaneCircuitPersistent(strategy, "recovered copy did not prove its configured target ordering");
                    }
                    continue;
                }
                if (includedTip?.receipt) {
                    await this.breakCircuitPersistent("startup found a tip receipt without its nonce predecessor buy receipt");
                    continue;
                }
                if (attempt.state === "unknown_charged") {
                    await this.breakLaneCircuitPersistent(strategy, "startup found a consumed copy nonce without a candidate receipt (persisted unknown charge)");
                    continue;
                }
                if (latestNonce > attempt.nonce || pendingNonce > attempt.nonce) {
                    await lane.ledger.chargeUnknownConsumption(attempt.key);
                    await this.breakLaneCircuitPersistent(strategy, "startup found a consumed copy nonce without a candidate receipt");
                    continue;
                }
                if (latestNonce < attempt.nonce || pendingNonce < attempt.nonce) {
                    await this.breakLaneCircuitPersistent(strategy, "startup nonce regressed below a persisted copy attempt");
                    continue;
                }
                if (currentBlock >= attempt.lastSubmittedBlock + RECEIPT_FINALITY_BLOCKS) {
                    await lane.ledger.releaseConfirmedNotIncluded(attempt.key);
                    continue;
                }
                await this.breakLaneCircuitPersistent(strategy, "startup found a copy attempt that has not reached its finality window");
            }
            catch (error) {
                lane.lastError = "startup_reconciliation_failed:" + errorText(error);
                await this.breakLaneCircuitPersistent(strategy, "startup could not reconcile a persisted copy attempt");
            }
        }
        if (attempts.length === 0 && pendingNonce > latestNonce)
            lane.lastError = "waiting_external_nonce";
    }
    orderingAccepted(receipt, targetReceipt, mode = "same_block_after") {
        if (!targetReceipt
            || receipt.status !== 1
            || targetReceipt.status !== 1) {
            return false;
        }
        if (mode === "next_block_after") {
            return receipt.blockNumber === targetReceipt.blockNumber + 1;
        }
        if (mode === "any_block_after") {
            return receipt.blockNumber > targetReceipt.blockNumber
                || (receipt.blockNumber === targetReceipt.blockNumber
                    && receipt.transactionIndex > targetReceipt.transactionIndex);
        }
        if (targetReceipt.blockNumber !== receipt.blockNumber
            || receipt.transactionIndex <= targetReceipt.transactionIndex)
            return false;
        return true;
    }
    resynchronizeNeededLanes() {
        return this.trackPromise(this.reconciliationPromises, this.resynchronizeNeededLanesInner());
    }
    async resynchronizeNeededLanesInner() {
        if (!this.rpc)
            return;
        for (const strategy of ["ed", "kuzuo"]) {
            const state = this.lanes[strategy].nonce.snapshot().state;
            if (state === "needs_sync" || state === "external_pending") {
                await this.resynchronizeLane(strategy);
            }
        }
    }
    async resynchronizeLane(strategy) {
        const lane = this.lanes[strategy];
        if (!this.rpc || !lane.config.signer)
            return;
        const state = lane.nonce.snapshot().state;
        if (state !== "needs_sync" && state !== "external_pending")
            return;
        const signer = lane.config.signer.address.toLowerCase();
        const hasOutstandingAttempt = Object.values(lane.ledger.snapshot().attempts)
            .some((attempt) => attempt.chainId === BSC_CHAIN_ID
            && attempt.signer === signer
            && (attempt.state === "reserved" || attempt.state === "unknown_charged"));
        if (hasOutstandingAttempt) {
            lane.lastError = "persisted risk attempt still requires reconciliation";
            return;
        }
        try {
            const guard = lane.nonce.refreshGuard();
            const [latestNonce, pendingNonce] = await Promise.all([
                this.rpc.latestNonce(lane.config.signer.address),
                this.rpc.pendingNonce(lane.config.signer.address),
            ]);
            const result = lane.nonce.synchronizeIfUnchanged(latestNonce, pendingNonce, guard);
            if (result.applied) {
                this.refreshPublicTipCache(strategy);
                lane.lastError = null;
                this.scheduleQueueDrain(strategy);
            }
            else if (latestNonce !== pendingNonce) {
                lane.lastError = "waiting_external_nonce";
            }
        }
        catch (error) {
            lane.lastError = errorText(error);
        }
    }
    refreshLaneNonceAtHead(strategy, headNumber) {
        const lane = this.lanes[strategy];
        if (!lane.config.enabled || !lane.config.signer || !this.rpc || this.stopped)
            return;
        const state = lane.nonce.snapshot().state;
        if (state === "reserved" || state === "submitted" || state === "unsynchronized")
            return;
        if (lane.nonceRefreshPromise || lane.lastNonceRefreshHead === headNumber)
            return;
        lane.lastNonceRefreshHead = headNumber;
        const guard = lane.nonce.refreshGuard();
        const operation = Promise.resolve().then(() => Promise.all([
            this.rpc.latestNonce(lane.config.signer.address),
            this.rpc.pendingNonce(lane.config.signer.address),
        ])).then(([latestNonce, pendingNonce]) => {
            const result = lane.nonce.advanceIfUnchanged(latestNonce, pendingNonce, guard);
            if (result.applied) {
                this.refreshPublicTipCache(strategy);
                lane.lastError = null;
                this.emit("nonce_refreshed_at_head", {
                    strategy,
                    headNumber,
                    nonce: result.snapshot.nextNonce,
                    authorityLatestNonce: latestNonce,
                    authorityPendingNonce: pendingNonce,
                });
                this.scheduleQueueDrain(strategy);
            }
            else if (latestNonce !== pendingNonce) {
                lane.lastError = "waiting_external_nonce";
                this.emit("external_nonce_waiting", { strategy, headNumber, latestNonce, pendingNonce });
            }
        }).catch((error) => {
            lane.lastError = "nonce_refresh_failed:" + errorText(error);
        }).finally(() => {
            lane.nonceRefreshPromise = null;
        });
        lane.nonceRefreshPromise = this.trackPromise(this.reconciliationPromises, operation);
    }
    async reconcileLaneBeforeEnable(strategy) {
        const lane = this.lanes[strategy];
        if (!this.rpc || !lane.config.signer) {
            throw new ExecutorControlError("not_ready", strategy + " authoritative nonce RPC is unavailable");
        }
        const guard = lane.nonce.refreshGuard();
        let latestNonce;
        let pendingNonce;
        try {
            [latestNonce, pendingNonce] = await Promise.all([
                this.rpc.latestNonce(lane.config.signer.address),
                this.rpc.pendingNonce(lane.config.signer.address),
            ]);
        }
        catch {
            throw new ExecutorControlError("not_ready", strategy + " nonce reconciliation failed");
        }
        const result = lane.nonce.synchronizeIfUnchanged(latestNonce, pendingNonce, guard);
        if (!result.applied) {
            lane.lastError = latestNonce === pendingNonce ? "nonce_generation_changed" : "waiting_external_nonce";
            throw new ExecutorControlError("not_ready", strategy + " nonce is not authoritative yet");
        }
        this.refreshPublicTipCache(strategy);
        lane.lastError = null;
    }
    worstCost(config, settings) {
        return settings.followAmountWei
            + settings.builderTipWei
            + ((config.gasLimit + 21000n) * settings.gasPriceWei);
    }
    assertLivePublicBuilderSet() {
        if (this.config.mode !== "live")
            return;
        const publicExecutionConfigured = (this.config.pendingWssUrls?.length ?? 0) > 0
            || Boolean(this.config.blockRazorPublicMempool?.enabled)
            || !this.config.blockRazorPrivateMempool.enabled
            || this.builders.length > 0;
        if (!publicExecutionConfigured)
            return;
        const names = new Set(this.builders.map(({ config }) => config.name));
        const blockRazor = this.builders.find(({ config }) => config.name === "blockrazor");
        if (this.builders.length !== 3
            || !names.has("club48")
            || !names.has("blockrazor")
            || !names.has("jet")) {
            throw new ExecutorControlError("not_ready", "live public execution requires exactly club48, blockrazor,jet Builder routes");
        }
        if (!blockRazor?.config.authorization) {
            throw new ExecutorControlError("not_ready", "live public BlockRazor authorization is unavailable");
        }
    }
    validateLaneIsolation() {
        const enabled = ["ed", "kuzuo"].filter((strategy) => this.lanes[strategy].config.enabled);
        if (enabled.length !== 2)
            return;
        const first = this.lanes.ed.config;
        const second = this.lanes.kuzuo.config;
        if (first.signer?.address === second.signer?.address) {
            throw new Error("Ed and kuzuo must use separate copy wallets");
        }
        if (first.executorAddress && second.executorAddress && first.executorAddress === second.executorAddress) {
            throw new Error("Ed and kuzuo must use separate atomic executors");
        }
    }
    globalRiskLedgerIdentity() {
        return {
            chainId: BSC_CHAIN_ID,
            lanes: { ed: null, kuzuo: null },
        };
    }
    laneRiskLedgerIdentity(strategy) {
        const lane = this.lanes[strategy].config;
        if (!lane.enabled || !lane.signer) {
            throw new Error(strategy + " signing lane is incomplete for risk ledger identity");
        }
        return {
            chainId: BSC_CHAIN_ID,
            lanes: {
                ed: strategy === "ed"
                    ? { signer: lane.signer.address, executor: lane.executorAddress ?? lane.signer.address }
                    : null,
                kuzuo: strategy === "kuzuo"
                    ? { signer: lane.signer.address, executor: lane.executorAddress ?? lane.signer.address }
                    : null,
            },
        };
    }
    reject(signal, reason) {
        this.emit("target_rejected", {
            strategy: signal.strategy,
            targetHash: signal.transaction.hash,
            reason,
        });
    }
    breakCircuit(reason) {
        this.circuitBroken = true;
        this.circuitReason = reason;
        this.emit("circuit_broken", { reason });
        const persistence = this.globalLedger.tripCircuit(reason).catch((error) => {
            this.circuitReason = reason + "; circuit persistence failed: " + errorText(error);
        });
        void this.trackPromise(this.reconciliationPromises, persistence);
    }
    async breakCircuitPersistent(reason) {
        this.circuitBroken = true;
        this.circuitReason = reason;
        this.emit("circuit_broken", { reason });
        try {
            await this.globalLedger.tripCircuit(reason);
        }
        catch (error) {
            this.circuitReason = reason + "; circuit persistence failed: " + errorText(error);
        }
    }
    breakLaneCircuit(strategy, reason) {
        const lane = this.lanes[strategy];
        lane.circuitBroken = true;
        lane.circuitReason = reason;
        lane.lastError = reason;
        this.emit("lane_circuit_broken", { strategy, reason });
        const persistence = lane.ledger.tripCircuit(reason).catch((error) => {
            lane.circuitReason = reason + "; circuit persistence failed: " + errorText(error);
            lane.lastError = lane.circuitReason;
        });
        void this.trackPromise(this.reconciliationPromises, persistence);
    }
    async breakLaneCircuitPersistent(strategy, reason) {
        const lane = this.lanes[strategy];
        lane.circuitBroken = true;
        lane.circuitReason = reason;
        lane.lastError = reason;
        this.emit("lane_circuit_broken", { strategy, reason });
        try {
            await lane.ledger.tripCircuit(reason);
        }
        catch (error) {
            lane.circuitReason = reason + "; circuit persistence failed: " + errorText(error);
            lane.lastError = lane.circuitReason;
        }
    }
    trackPromise(set, promise) {
        set.add(promise);
        void promise.then(() => set.delete(promise), () => set.delete(promise));
        return promise;
    }
    async waitForTrackedWork() {
        while (this.plannerPromises.size > 0 || this.reconciliationPromises.size > 0) {
            await Promise.allSettled([
                ...this.plannerPromises,
                ...this.reconciliationPromises,
            ]);
        }
    }
    emit(type, fields) {
        this.telemetry.emit(type, fields);
        const event = { type, at: new Date().toISOString(), ...fields };
        this.recentEvents.unshift(event);
        if (this.recentEvents.length > 100)
            this.recentEvents.length = 100;
    }
    waitForInitialHead(timeoutMs) {
        if (this.latestHead)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            let settled = false;
            const onHead = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                this.headReadyWaiters.delete(onHead);
                resolve();
            };
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                this.headReadyWaiters.delete(onHead);
                reject(new Error("BSC head source did not become ready before target feeds"));
            }, timeoutMs);
            this.headReadyWaiters.add(onHead);
        });
    }
    pruneSeenTargets(nowMonoNs) {
        if (this.seenTargets.size <= 5_000)
            return;
        for (const [hash, seen] of this.seenTargets) {
            if (nowMonoNs - seen > 86400000000000n)
                this.seenTargets.delete(hash);
        }
    }
}
//# sourceMappingURL=engine.js.map