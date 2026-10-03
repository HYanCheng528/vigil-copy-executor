export function serializeTelemetryRecord(record) {
    try {
        return JSON.stringify(record, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    }
    catch {
        // Telemetry is best-effort observability. A future accidental circular
        // field must drop that record rather than terminate the executor.
        return JSON.stringify({
            type: "telemetry_serialization_failed",
            at: new Date().toISOString(),
        });
    }
}
/**
 * Hot-path callers only append to memory. JSON serialization and stdout writes
 * run in a later event-loop turn, so journald backpressure cannot delay signing.
 */
export class TelemetryBuffer {
    queued = [];
    flushScheduled = false;
    emit(type, fields = {}) {
        this.queued.push({ type, at: new Date().toISOString(), ...fields });
        if (this.queued.length > 2_000)
            this.queued.splice(0, this.queued.length - 2_000);
        if (this.flushScheduled)
            return;
        this.flushScheduled = true;
        setImmediate(() => this.flush());
    }
    flush() {
        this.flushScheduled = false;
        const records = this.queued.splice(0, 200);
        if (records.length === 0)
            return;
        const output = records.map(serializeTelemetryRecord).join("\n") + "\n";
        process.stdout.write(output);
        if (this.queued.length > 0 && !this.flushScheduled) {
            this.flushScheduled = true;
            setImmediate(() => this.flush());
        }
    }
}
export function elapsedMs(startNs, endNs) {
    return Math.round((Number(endNs - startNs) / 1e6) * 1_000) / 1_000;
}
//# sourceMappingURL=telemetry.js.map