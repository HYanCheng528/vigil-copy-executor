function assertNonce(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("nonce must be a non-negative safe integer");
}
function cloneLease(lease) {
    return lease ? { ...lease, submittedBuilders: [...lease.submittedBuilders] } : null;
}
/**
 * A lane is one funded signing wallet. All builders for one target share the
 * same lease; a different target can never reuse or leapfrog that nonce span.
 * Expiry intentionally requires a fresh pending-nonce sync instead of guessing
 * whether a private builder retained the candidate.
 */
export class NonceLane {
    laneId;
    currentState = "unsynchronized";
    nextNonce = null;
    lease = null;
    generation = 0;
    externalPending = null;
    constructor(laneId) {
        this.laneId = laneId;
        if (!laneId.trim())
            throw new Error("nonce lane id is required");
    }
    snapshot() {
        return {
            laneId: this.laneId,
            state: this.currentState,
            nextNonce: this.nextNonce,
            lease: cloneLease(this.lease),
            generation: this.generation,
            externalPending: this.externalPending ? { ...this.externalPending } : null,
        };
    }
    /** Captures the exact in-memory lane generation before an asynchronous RPC read. */
    refreshGuard() {
        return this.generation;
    }
    /** Apply an asynchronous refresh only while the lane is still the same ready generation. */
    synchronizeIfUnchanged(latestNonce, pendingNonce, guard) {
        assertNonce(latestNonce);
        assertNonce(pendingNonce);
        if (!Number.isSafeInteger(guard) || guard < 0)
            throw new Error("nonce refresh guard is invalid");
        if ((this.currentState !== "ready" && this.currentState !== "external_pending" && this.currentState !== "needs_sync")
            || this.generation !== guard) {
            return { applied: false, snapshot: this.snapshot() };
        }
        if (latestNonce !== pendingNonce) {
            if (this.currentState === "ready")
                this.currentState = "external_pending";
            this.generation += 1;
            return { applied: false, snapshot: this.snapshot() };
        }
        this.nextNonce = pendingNonce;
        this.lease = null;
        this.externalPending = null;
        this.currentState = "ready";
        this.generation += 1;
        return { applied: true, snapshot: this.snapshot() };
    }
    /**
     * Routine head/pending observations may move an optimistically allocated
     * signing frontier forward, never backward. A later authoritative enable or
     * explicit recovery can still use synchronizeIfUnchanged for exact reset.
     */
    advanceIfUnchanged(latestNonce, pendingNonce, guard) {
        assertNonce(latestNonce);
        assertNonce(pendingNonce);
        if (!Number.isSafeInteger(guard) || guard < 0)
            throw new Error("nonce refresh guard is invalid");
        if ((this.currentState !== "ready" && this.currentState !== "external_pending" && this.currentState !== "needs_sync")
            || this.generation !== guard) {
            return { applied: false, snapshot: this.snapshot() };
        }
        if (pendingNonce < latestNonce)
            throw new Error("pending nonce cannot be below latest nonce");
        this.nextNonce = Math.max(this.nextNonce ?? 0, latestNonce, pendingNonce);
        if (this.currentState === "external_pending" && latestNonce !== pendingNonce) {
            this.externalPending = { nonce: pendingNonce - 1, hash: this.externalPending?.hash ?? null };
            this.generation += 1;
            return { applied: false, snapshot: this.snapshot() };
        }
        this.lease = null;
        this.externalPending = null;
        this.currentState = "ready";
        this.generation += 1;
        return { applied: true, snapshot: this.snapshot() };
    }
    /** A verified external pending transaction blocks reuse until latest catches pending. */
    observeExternalPending(transactionNonce, hash = null) {
        assertNonce(transactionNonce);
        if (hash !== null && !/^0x[0-9a-fA-F]{64}$/.test(hash))
            throw new Error("external pending hash is invalid");
        const normalized = hash?.toLowerCase() ?? null;
        if (!this.externalPending || transactionNonce >= this.externalPending.nonce) {
            this.externalPending = { nonce: transactionNonce, hash: normalized };
        }
        if (this.currentState === "ready") {
            this.currentState = "external_pending";
        }
        this.generation += 1;
        return this.snapshot();
    }
    synchronize(pendingNonce) {
        assertNonce(pendingNonce);
        if (this.currentState === "reserved" || this.currentState === "submitted") {
            throw new Error("cannot synchronize a nonce lane with an active candidate");
        }
        this.nextNonce = pendingNonce;
        this.lease = null;
        this.externalPending = null;
        this.currentState = "ready";
        this.generation += 1;
        return this.snapshot();
    }
    reserve(targetHash, validUntilBlock, nowMonoNs, span = 1) {
        if (this.currentState === "reserved" || this.currentState === "submitted") {
            if (this.lease?.targetHash.toLowerCase() === targetHash.toLowerCase()) {
                if (validUntilBlock > this.lease.validUntilBlock) {
                    this.lease.validUntilBlock = validUntilBlock;
                    this.generation += 1;
                }
                return cloneLease(this.lease);
            }
            throw new Error("nonce lane is already reserved for another target");
        }
        if (this.currentState !== "ready" || this.nextNonce === null)
            throw new Error("nonce lane is not synchronized and ready");
        if (!/^0x[0-9a-fA-F]{64}$/.test(targetHash))
            throw new Error("target hash is invalid");
        if (!Number.isSafeInteger(validUntilBlock) || validUntilBlock < 0)
            throw new Error("validUntilBlock is invalid");
        if (!/^(?:0|[1-9][0-9]*)$/.test(nowMonoNs))
            throw new Error("nowMonoNs must be an unsigned decimal string");
        if (span !== 1 && span !== 2)
            throw new Error("nonce span must be one or two transactions");
        this.lease = {
            laneId: this.laneId,
            targetHash: targetHash.toLowerCase(),
            startNonce: this.nextNonce,
            span,
            reservedAtMonoNs: nowMonoNs,
            validUntilBlock,
            submittedBuilders: [],
        };
        this.currentState = "reserved";
        this.generation += 1;
        return cloneLease(this.lease);
    }
    markSubmitted(targetHash, builder) {
        const lease = this.requireLease(targetHash);
        if (!builder.trim())
            throw new Error("builder is required");
        if (!lease.submittedBuilders.includes(builder))
            lease.submittedBuilders.push(builder);
        this.currentState = "submitted";
        this.generation += 1;
        return this.snapshot();
    }
    /** Release a candidate that was prepared locally but never sent anywhere. */
    releaseUnsubmitted(targetHash) {
        const lease = this.requireLease(targetHash);
        if (this.currentState !== "reserved" || lease.submittedBuilders.length !== 0) {
            throw new Error("cannot release a nonce lease after submission");
        }
        this.lease = null;
        this.currentState = this.externalPending ? "external_pending" : "ready";
        this.generation += 1;
        return this.snapshot();
    }
    markIncluded(targetHash) {
        return this.optimisticCommit(targetHash);
    }
    /**
     * A real dispatch has synchronously started for this exact signed span. Move
     * only the local signing frontier so later targets can be pipelined; chain
     * inclusion and risk finality remain the caller's independent background
     * responsibility.
     */
    optimisticCommit(targetHash) {
        const lease = this.requireLease(targetHash);
        this.nextNonce = lease.startNonce + lease.span;
        this.lease = null;
        this.currentState = this.externalPending ? "external_pending" : "ready";
        this.generation += 1;
        return this.snapshot();
    }
    markExpired(targetHash) {
        this.requireLease(targetHash);
        this.lease = null;
        this.currentState = "needs_sync";
        this.generation += 1;
        return this.snapshot();
    }
    markNonceConflict() {
        this.lease = null;
        this.currentState = "needs_sync";
        this.generation += 1;
        return this.snapshot();
    }
    requireLease(targetHash) {
        if (!this.lease || (this.currentState !== "reserved" && this.currentState !== "submitted")) {
            throw new Error("nonce lane has no active lease");
        }
        if (this.lease.targetHash.toLowerCase() !== targetHash.toLowerCase()) {
            throw new Error("nonce lease belongs to a different target");
        }
        return this.lease;
    }
}
//# sourceMappingURL=nonce-lane.js.map