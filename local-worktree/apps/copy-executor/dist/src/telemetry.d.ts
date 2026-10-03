export interface TelemetryRecord {
    type: string;
    at: string;
    [key: string]: unknown;
}
export declare function serializeTelemetryRecord(record: TelemetryRecord): string;
/**
 * Hot-path callers only append to memory. JSON serialization and stdout writes
 * run in a later event-loop turn, so journald backpressure cannot delay signing.
 */
export declare class TelemetryBuffer {
    private readonly queued;
    private flushScheduled;
    emit(type: string, fields?: Record<string, unknown>): void;
    private flush;
}
export declare function elapsedMs(startNs: bigint, endNs: bigint): number;
