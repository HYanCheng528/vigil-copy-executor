import { Transaction, getAddress, keccak256 } from "ethers";
import WebSocket from "ws";
import { BSC_CHAIN_ID, brandSourceVerifiedTargetSignal, ED_TARGET_ADDRESS, EXECUTION_SIGNAL_VERSION, KNOWN_BUILDER_TIP_RECIPIENTS, KUZUO_TARGET_ADDRESS, } from "./core/messages.js";
import { GMGN_ROUTER_ADDRESS, GMGN_SWAP_SELECTOR } from "./core/gmgn-calldata.js";
const DEFAULT_TARGET_ADDRESSES = {
    ed: ED_TARGET_ADDRESS,
    kuzuo: KUZUO_TARGET_ADDRESS,
};
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const HASH_ONLY_ERROR = "pending feed returned hashes; full objects are required for the hot path";
const CAPABILITY_TIMEOUT_ERROR = "pending feed did not prove full-object capability";
export const DEFAULT_AUTHORITY_HEAD_MAX_TIMESTAMP_LAG_MS = 15_000;
const STALE_HEAD_ERROR = "head feed timestamp is stale";
const METRICS_PUBLISH_INTERVAL_MS = 250;
const PREDECESSOR_TTL_NS = 10000000000n;
// This is only the feed's in-memory out-of-order correlation retention. It is
// not a target signature, bundle, block, or rolling-submission validity window.
const ORPHAN_TARGET_TTL_NS = PREDECESSOR_TTL_NS;
const PREDECESSOR_CAPACITY = 64;
const ORPHAN_TARGET_CAPACITY = 64;
const WALL_CLOCK_OFFSET_NS = (BigInt(Date.now()) * 1000000n) - process.hrtime.bigint();
function normalizedTargetMap(addresses) {
    return new Map([
        [getAddress(addresses.ed).toLowerCase(), "ed"],
        [getAddress(addresses.kuzuo).toLowerCase(), "kuzuo"],
    ]);
}
function isFresh(nowMonoNs, seenMonoNs, ttlNs) {
    return nowMonoNs >= seenMonoNs && nowMonoNs - seenMonoNs <= ttlNs;
}
function jsonRpcErrorCode(value) {
    return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}
function subscriptionError(id, codeValue) {
    const category = id === 1 ? "pending" : "heads";
    const code = jsonRpcErrorCode(codeValue);
    return `pending feed ${category} subscription failed${code ? ` (${code})` : ""}`;
}
function rpcQuantity(value, field) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
        throw new Error(field + " is not an RPC quantity");
    }
    return BigInt(value);
}
function safeNonce(value) {
    const nonce = Number(value);
    if (!Number.isSafeInteger(nonce) || nonce < 0)
        throw new Error("target nonce is unsafe");
    return nonce;
}
function isLegacyType(value) {
    return value === undefined || value === null || value === "0x0" || value === "0x00" || value === 0;
}
function legacyRecoveryV(networkV, chainId) {
    if (networkV === 0n || networkV === 1n)
        return Number(networkV) + 27;
    if (networkV === 27n || networkV === 28n)
        return Number(networkV);
    const parity = networkV - ((chainId * 2n) + 35n);
    if (parity !== 0n && parity !== 1n) {
        throw new Error("pending legacy signature v does not match chainId");
    }
    return Number(parity) + 27;
}
function wallNsFor(monotonicNs) {
    return WALL_CLOCK_OFFSET_NS + monotonicNs;
}
/**
 * Rebuild the exact signed legacy RLP bytes from QuickNode's full-pending
 * object. This avoids an eth_getTransactionByHash round trip on the hot path.
 */
export function pendingObjectToWire(value) {
    if (!value || typeof value !== "object")
        throw new Error("pending notification is not an object");
    const tx = value;
    if (!isLegacyType(tx.type))
        throw new Error("only legacy pending targets are supported");
    if (typeof tx.hash !== "string" || !HASH_RE.test(tx.hash))
        throw new Error("pending hash is invalid");
    if (typeof tx.from !== "string" || typeof tx.to !== "string")
        throw new Error("pending sender/recipient is missing");
    if (typeof tx.r !== "string" || typeof tx.s !== "string" || tx.v === undefined) {
        throw new Error("pending signature is missing");
    }
    const input = tx.input ?? tx.data;
    if (typeof input !== "string" || !HEX_BYTES_RE.test(input))
        throw new Error("pending calldata is invalid");
    const chainId = rpcQuantity(tx.chainId, "chainId");
    if (chainId !== BigInt(BSC_CHAIN_ID))
        throw new Error("pending transaction is not on BSC");
    const nonce = safeNonce(rpcQuantity(tx.nonce, "nonce"));
    const gasLimit = rpcQuantity(tx.gas, "gas");
    const gasPrice = rpcQuantity(tx.gasPrice, "gasPrice");
    const valueWei = rpcQuantity(tx.value, "value");
    const networkV = rpcQuantity(tx.v, "v");
    const recovered = Transaction.from({
        type: 0,
        chainId,
        nonce,
        gasLimit,
        gasPrice,
        to: getAddress(tx.to),
        value: valueWei,
        data: input,
        signature: {
            r: tx.r,
            s: tx.s,
            // ethers expects the recovery-form v (27/28) here; serializing the
            // chain-aware legacy transaction derives the original EIP-155 networkV.
            v: legacyRecoveryV(networkV, chainId),
        },
    });
    const rawTransaction = recovered.serialized;
    const calculatedHash = keccak256(rawTransaction);
    if (calculatedHash.toLowerCase() !== tx.hash.toLowerCase()) {
        throw new Error("pending fields do not reconstruct the advertised hash");
    }
    if (!recovered.from || getAddress(recovered.from) !== getAddress(tx.from)) {
        throw new Error("pending signature does not recover the advertised sender");
    }
    return {
        hash: calculatedHash,
        rawTransaction,
        chainId: BSC_CHAIN_ID,
        type: 0,
        from: getAddress(tx.from),
        to: getAddress(tx.to),
        nonce,
        gasPriceWei: gasPrice.toString(),
        gasLimit: gasLimit.toString(),
        valueWei: valueWei.toString(),
        input: input,
    };
}
function fastTargetMatch(value, targets) {
    if (!value || typeof value !== "object")
        return null;
    const tx = value;
    if (typeof tx.from !== "string" || typeof tx.to !== "string")
        return null;
    if (tx.to.toLowerCase() !== GMGN_ROUTER_ADDRESS.toLowerCase())
        return null;
    const input = tx.input ?? tx.data;
    if (typeof input !== "string" || input.slice(0, 10).toLowerCase() !== GMGN_SWAP_SELECTOR)
        return null;
    return targets.get(tx.from.toLowerCase()) ?? null;
}
function targetSenderStrategy(value, targets) {
    if (!value || typeof value !== "object")
        return null;
    const tx = value;
    return typeof tx.from === "string" ? targets.get(tx.from.toLowerCase()) ?? null : null;
}
function isAuditedPredecessor(value) {
    if (!value || typeof value !== "object")
        return false;
    const tx = value;
    const input = tx.input ?? tx.data;
    if (typeof tx.to !== "string" || !KNOWN_BUILDER_TIP_RECIPIENTS.has(tx.to.toLowerCase()))
        return false;
    if (input !== "0x")
        return false;
    try {
        return rpcQuantity(tx.gas, "gas") === 21000n && rpcQuantity(tx.value, "value") > 0n;
    }
    catch {
        return false;
    }
}
function parseHead(value, source, seenMonoNs) {
    if (!value || typeof value !== "object")
        return null;
    const head = value;
    if (typeof head.hash !== "string" || !HASH_RE.test(head.hash))
        return null;
    try {
        const number = safeNonce(rpcQuantity(head.number, "head.number"));
        const timestamp = safeNonce(rpcQuantity(head.timestamp, "head.timestamp"));
        return { number, hash: head.hash, timestamp, source, seenMonoNs };
    }
    catch {
        return null;
    }
}
/**
 * One persistent socket carries full pending objects and new heads. The first
 * address/router/selector test happens before RLP reconstruction or ABI decode.
 */
export class FullPendingFeed {
    options;
    socket = null;
    reconnectTimer = null;
    metricsPublishTimer = null;
    capabilityTimer = null;
    stopped = true;
    generation = 0;
    sequence = 0;
    reconnectDelayMs = 250;
    pendingRequested = false;
    targetPredecessors = new Map();
    orphanTargets = new Map();
    emittedTargetHashes = new Set();
    subscriptions = new Map();
    copyWalletAddresses;
    targetMap;
    orphanTargetTtlNs;
    orphanTargetCapacity;
    monotonicNow;
    wallClockNow;
    metricsState = {
        connected: false,
        headsSubscriptionReady: false,
        pendingSubscriptionReady: false,
        pendingObjectCapability: "unknown",
        actionable: false,
        reconnects: 0,
        notifications: 0,
        objectNotifications: 0,
        hashOnlyNotifications: 0,
        targetMatches: 0,
        invalidTargets: 0,
        lastError: null,
        lastMessageAt: null,
    };
    constructor(options, dependencies = {}) {
        this.options = options;
        if (!options.name.trim())
            throw new Error("pending feed name is required");
        if (!/^wss?:\/\//i.test(options.url))
            throw new Error("pending feed URL must use ws/wss");
        if (options.fullObjectCapabilityTimeoutMs !== undefined
            && (!Number.isSafeInteger(options.fullObjectCapabilityTimeoutMs)
                || options.fullObjectCapabilityTimeoutMs < 50
                || options.fullObjectCapabilityTimeoutMs > 60_000)) {
            throw new Error("full-object capability timeout must be an integer between 50 and 60000ms");
        }
        if (options.maxHeadTimestampLagMs !== undefined
            && (!Number.isSafeInteger(options.maxHeadTimestampLagMs)
                || options.maxHeadTimestampLagMs < 1_000
                || options.maxHeadTimestampLagMs > 60_000)) {
            throw new Error("maximum head timestamp lag must be an integer between 1000 and 60000ms");
        }
        this.copyWalletAddresses = new Set((options.copyWalletAddresses ?? []).map((address) => getAddress(address).toLowerCase()));
        this.targetMap = normalizedTargetMap(dependencies.targetAddresses ?? DEFAULT_TARGET_ADDRESSES);
        this.orphanTargetTtlNs = dependencies.orphanTargetTtlNs ?? ORPHAN_TARGET_TTL_NS;
        if (this.orphanTargetTtlNs <= 0n || this.orphanTargetTtlNs > PREDECESSOR_TTL_NS) {
            throw new Error("orphan target TTL must be positive and no longer than the predecessor TTL");
        }
        this.orphanTargetCapacity = dependencies.orphanTargetCapacity ?? ORPHAN_TARGET_CAPACITY;
        if (!Number.isSafeInteger(this.orphanTargetCapacity) || this.orphanTargetCapacity < 1
            || this.orphanTargetCapacity > 1_024) {
            throw new Error("orphan target capacity must be an integer between 1 and 1024");
        }
        this.monotonicNow = dependencies.monotonicNow ?? (() => process.hrtime.bigint());
        this.wallClockNow = dependencies.wallClockNow ?? (() => Date.now());
    }
    start() {
        if (!this.stopped)
            return;
        this.stopped = false;
        this.connect();
    }
    stop() {
        this.stopped = true;
        this.generation += 1;
        this.resetTargetCorrelationState();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.clearCapabilityTimer();
        this.clearMetricsPublishTimer();
        this.socket?.close(1000, "shutdown");
        this.socket = null;
        this.metricsState.connected = false;
        this.resetSubscriptionReadiness();
        this.publishState();
    }
    snapshot() {
        return { ...this.metricsState };
    }
    connect() {
        const generation = ++this.generation;
        this.resetTargetCorrelationState();
        this.subscriptions.clear();
        this.pendingRequested = false;
        this.resetSubscriptionReadiness();
        this.clearMetricsPublishTimer();
        const socket = new WebSocket(this.options.url, {
            perMessageDeflate: false,
            handshakeTimeout: 5_000,
        });
        this.socket = socket;
        socket.on("open", () => {
            if (this.stopped || generation !== this.generation)
                return;
            this.reconnectDelayMs = 250;
            this.metricsState.connected = true;
            this.metricsState.lastError = null;
            // The two streams are independent first-seen sources. Subscribe in the
            // same open callback and let the planner queue pending targets until the
            // first head, instead of sacrificing roughly one block at every reconnect.
            if (this.options.subscribeHeads !== false) {
                socket.send(JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "eth_subscribe",
                    params: ["newHeads"],
                }));
            }
            this.requestPendingSubscription();
            this.publishState();
        });
        socket.on("message", (data) => {
            if (this.stopped || generation !== this.generation || this.socket !== socket)
                return;
            this.handleMessage(data);
        });
        socket.on("error", () => {
            if (generation !== this.generation || this.socket !== socket)
                return;
            // ws errors can contain the provider URL (and therefore an embedded API
            // token). Only publish a local, stable transport category.
            this.metricsState.lastError = "pending feed transport failed";
            this.publishState();
        });
        socket.on("close", () => {
            if (generation !== this.generation)
                return;
            this.resetTargetCorrelationState();
            this.metricsState.connected = false;
            this.resetSubscriptionReadiness();
            this.clearMetricsPublishTimer();
            this.publishState();
            if (this.stopped)
                return;
            this.metricsState.reconnects += 1;
            const delay = this.reconnectDelayMs + Math.floor(Math.random() * 100);
            this.reconnectDelayMs = Math.min(5_000, this.reconnectDelayMs * 2);
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
            this.reconnectTimer.unref();
        });
    }
    handleMessage(data) {
        const socketSeenMonoNs = this.monotonicNow();
        let message;
        try {
            message = JSON.parse(data.toString());
        }
        catch {
            return;
        }
        const parsedMonoNs = this.monotonicNow();
        this.metricsState.lastMessageAt = new Date().toISOString();
        if (message.id === 1 || message.id === 2) {
            if (message.error) {
                // Provider error messages are untrusted response data and can echo
                // credentials, URLs, or transaction bytes. Keep only a numeric code.
                this.metricsState.lastError = subscriptionError(message.id, message.error.code);
                this.resetSubscriptionReadiness();
                this.publishState();
                this.socket?.close(1011, "subscription failed");
                return;
            }
            if (typeof message.result === "string") {
                if (message.id === 1) {
                    if (this.options.subscribePending === false || !this.pendingRequested)
                        return;
                    this.subscriptions.set(message.result, "pending");
                    this.metricsState.pendingSubscriptionReady = true;
                    this.metricsState.pendingObjectCapability = "unknown";
                    this.armCapabilityTimer(this.generation);
                }
                else {
                    if (this.options.subscribeHeads === false)
                        return;
                    this.subscriptions.set(message.result, "heads");
                    this.metricsState.headsSubscriptionReady = true;
                }
                this.refreshActionable();
                // Subscription ACKs are readiness transitions, so expose them without
                // waiting for the provider's first notification.
                this.publishState();
            }
            return;
        }
        const subscription = message.params?.subscription;
        if (typeof subscription !== "string")
            return;
        const kind = this.subscriptions.get(subscription);
        if (!kind)
            return;
        const result = message.params?.result;
        if (kind === "heads") {
            const head = parseHead(result, this.options.name, socketSeenMonoNs);
            if (head) {
                const maximumLagMs = this.options.maxHeadTimestampLagMs;
                const timestampLagMs = this.wallClockNow() - (head.timestamp * 1_000);
                if (maximumLagMs !== undefined && Math.abs(timestampLagMs) > maximumLagMs) {
                    this.metricsState.lastError = STALE_HEAD_ERROR;
                    this.resetSubscriptionReadiness();
                    this.publishState();
                    this.socket?.close(1011, "stale head timestamp");
                    return;
                }
                this.options.onHead(head);
            }
            return;
        }
        this.metricsState.notifications += 1;
        this.scheduleMetricsPublish();
        if (typeof result === "string") {
            this.metricsState.hashOnlyNotifications += 1;
            if (this.metricsState.pendingObjectCapability !== "hash_only") {
                this.clearCapabilityTimer();
                this.metricsState.pendingObjectCapability = "hash_only";
                this.metricsState.lastError = HASH_ONLY_ERROR;
                this.refreshActionable();
                this.publishState();
            }
            return;
        }
        if (!result || typeof result !== "object" || Array.isArray(result)
            || typeof result.hash !== "string"
            || !HASH_RE.test(result.hash))
            return;
        this.metricsState.objectNotifications += 1;
        if (this.metricsState.pendingObjectCapability !== "full") {
            this.clearCapabilityTimer();
            this.metricsState.pendingObjectCapability = "full";
            if (this.metricsState.lastError === HASH_ONLY_ERROR
                || this.metricsState.lastError === CAPABILITY_TIMEOUT_ERROR)
                this.metricsState.lastError = null;
            this.refreshActionable();
            this.publishState();
        }
        const advertisedFrom = result.from;
        if (typeof advertisedFrom === "string"
            && this.copyWalletAddresses.has(advertisedFrom.toLowerCase())) {
            try {
                const transaction = pendingObjectToWire(result);
                if (!this.copyWalletAddresses.has(transaction.from.toLowerCase())) {
                    throw new Error("copy-wallet pending sender recovery mismatch");
                }
                this.options.onCopyWalletPending?.(transaction);
            }
            catch {
                this.metricsState.invalidTargets += 1;
            }
            return;
        }
        const senderStrategy = targetSenderStrategy(result, this.targetMap);
        if (!senderStrategy)
            return;
        const strategy = fastTargetMatch(result, this.targetMap);
        if (!strategy) {
            if (!isAuditedPredecessor(result))
                return;
            try {
                const predecessor = pendingObjectToWire(result);
                this.targetPredecessors.set(predecessor.from.toLowerCase() + ":" + String(predecessor.nonce), {
                    wire: predecessor,
                    seenMonoNs: socketSeenMonoNs,
                });
                this.pruneTargetCorrelationState(socketSeenMonoNs);
                this.recoverOrphanTarget(predecessor, socketSeenMonoNs);
            }
            catch {
                this.metricsState.invalidTargets += 1;
            }
            return;
        }
        const matchedMonoNs = this.monotonicNow();
        this.metricsState.targetMatches += 1;
        try {
            const transaction = pendingObjectToWire(result);
            const timing = { socketSeenMonoNs, parsedMonoNs, matchedMonoNs };
            this.pruneTargetCorrelationState(socketSeenMonoNs);
            if (this.wasTargetEmitted(transaction))
                return;
            const predecessorKey = transaction.from.toLowerCase() + ":" + String(transaction.nonce - 1);
            const predecessor = this.targetPredecessors.get(predecessorKey);
            const predecessorFresh = predecessor && isFresh(socketSeenMonoNs, predecessor.seenMonoNs, PREDECESSOR_TTL_NS) ? predecessor.wire : null;
            if (strategy === "kuzuo" && !predecessorFresh) {
                this.rememberOrphanTarget(transaction, timing);
                return;
            }
            this.emitTarget(strategy, transaction, timing, predecessorFresh);
        }
        catch (error) {
            this.metricsState.invalidTargets += 1;
            this.metricsState.lastError = error instanceof Error ? error.message : String(error);
            this.publishState();
        }
    }
    publishState() {
        this.options.onState?.(this.options.name, this.snapshot());
    }
    resetSubscriptionReadiness() {
        this.clearCapabilityTimer();
        this.metricsState.headsSubscriptionReady = false;
        this.metricsState.pendingSubscriptionReady = false;
        this.metricsState.pendingObjectCapability = "unknown";
        this.metricsState.actionable = false;
    }
    refreshActionable() {
        this.metricsState.actionable = this.metricsState.connected
            && this.options.subscribePending !== false
            && this.metricsState.pendingSubscriptionReady
            && this.metricsState.pendingObjectCapability === "full";
    }
    armCapabilityTimer(generation) {
        this.clearCapabilityTimer();
        const timeoutMs = this.options.fullObjectCapabilityTimeoutMs ?? 5_000;
        this.capabilityTimer = setTimeout(() => {
            this.capabilityTimer = null;
            if (this.stopped || generation !== this.generation)
                return;
            if (!this.metricsState.pendingSubscriptionReady
                || this.metricsState.pendingObjectCapability !== "unknown")
                return;
            this.metricsState.lastError = CAPABILITY_TIMEOUT_ERROR;
            this.refreshActionable();
            this.publishState();
            this.socket?.close(1011, "full-object capability timeout");
        }, timeoutMs);
        this.capabilityTimer.unref();
    }
    clearCapabilityTimer() {
        if (this.capabilityTimer)
            clearTimeout(this.capabilityTimer);
        this.capabilityTimer = null;
    }
    scheduleMetricsPublish() {
        if (this.metricsPublishTimer || this.stopped)
            return;
        this.metricsPublishTimer = setTimeout(() => {
            this.metricsPublishTimer = null;
            if (!this.stopped)
                this.publishState();
        }, METRICS_PUBLISH_INTERVAL_MS);
        this.metricsPublishTimer.unref();
    }
    clearMetricsPublishTimer() {
        if (this.metricsPublishTimer)
            clearTimeout(this.metricsPublishTimer);
        this.metricsPublishTimer = null;
    }
    requestPendingSubscription() {
        if (this.options.subscribePending === false || this.pendingRequested)
            return;
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
            return;
        this.pendingRequested = true;
        this.socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_subscribe",
            params: ["newPendingTransactions", true],
        }));
    }
    rememberOrphanTarget(transaction, timing) {
        const key = transaction.from.toLowerCase() + ":" + String(transaction.nonce - 1);
        const existing = this.orphanTargets.get(key);
        this.orphanTargets.set(key, {
            generation: this.generation,
            strategy: "kuzuo",
            transaction,
            timing,
            // Replayed/replaced targets at the same sender nonce must not extend an
            // orphan forever. A replacement may update the raw target but inherits
            // the first observation's absolute expiry.
            expiresMonoNs: existing?.generation === this.generation
                ? existing.expiresMonoNs
                : timing.socketSeenMonoNs + this.orphanTargetTtlNs,
        });
        this.trimOldest(this.orphanTargets, this.orphanTargetCapacity);
    }
    recoverOrphanTarget(predecessor, nowMonoNs) {
        const key = predecessor.from.toLowerCase() + ":" + String(predecessor.nonce);
        const orphan = this.orphanTargets.get(key);
        if (!orphan)
            return;
        if (orphan.generation !== this.generation || nowMonoNs > orphan.expiresMonoNs
            || predecessor.nonce + 1 !== orphan.transaction.nonce
            || predecessor.from.toLowerCase() !== orphan.transaction.from.toLowerCase()) {
            this.orphanTargets.delete(key);
            return;
        }
        this.orphanTargets.delete(key);
        this.emitTarget(orphan.strategy, orphan.transaction, orphan.timing, predecessor);
    }
    emitTarget(strategy, transaction, timing, predecessor) {
        if (this.wasTargetEmitted(transaction))
            return;
        // Claim before invoking user code so a synchronous/re-entrant duplicate
        // cannot emit the same sender+nonce twice.
        this.emittedTargetHashes.add(transaction.hash.toLowerCase());
        this.sequence += 1;
        this.options.onTarget(brandSourceVerifiedTargetSignal({
            version: EXECUTION_SIGNAL_VERSION,
            source: "bsc_pending_full",
            sourceSequence: this.options.name + ":" + String(this.sequence),
            firstSeenUnixNs: wallNsFor(timing.socketSeenMonoNs).toString(),
            firstSeenMonoNs: timing.socketSeenMonoNs.toString(),
            strategy,
            transaction,
            rawTransactionVerified: true,
            predecessorsVerified: true,
            ...(predecessor ? { requiredPredecessors: [predecessor] } : {}),
        }), timing);
    }
    wasTargetEmitted(transaction) {
        return this.emittedTargetHashes.has(transaction.hash.toLowerCase());
    }
    pruneTargetCorrelationState(nowMonoNs) {
        for (const [key, entry] of this.targetPredecessors) {
            if (!isFresh(nowMonoNs, entry.seenMonoNs, PREDECESSOR_TTL_NS)) {
                this.targetPredecessors.delete(key);
            }
        }
        for (const [key, entry] of this.orphanTargets) {
            if (entry.generation !== this.generation || nowMonoNs > entry.expiresMonoNs) {
                this.orphanTargets.delete(key);
            }
        }
        this.trimOldest(this.targetPredecessors, PREDECESSOR_CAPACITY);
        this.trimOldest(this.orphanTargets, this.orphanTargetCapacity);
    }
    trimOldest(map, capacity) {
        while (map.size > capacity) {
            const oldest = map.keys().next();
            if (oldest.done)
                return;
            map.delete(oldest.value);
        }
    }
    resetTargetCorrelationState() {
        this.targetPredecessors.clear();
        this.orphanTargets.clear();
        this.emittedTargetHashes.clear();
    }
}
//# sourceMappingURL=pending-feed.js.map