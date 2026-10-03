/**
 * Per-process live latch. It is intentionally never restored from disk: a
 * service restart, crash or DynamicUser identity change always starts closed.
 * Root-owned deployment credentials authorize the control request; the
 * unprivileged executor does not need to mutate any root-owned file.
 */
export declare class ArmGate {
    private readonly required;
    private armedState;
    static readonly ENABLE_CONFIRMATION = "I_ACCEPT_LIVE_COPY_TRADING_NOW";
    constructor(_legacyPath: string | null, required: boolean);
    get armed(): boolean;
    /** Kept as a compatibility field; runtime control uses the fixed phrase. */
    get challenge(): null;
    start(): Promise<void>;
    stop(): void;
    enable(confirmation: string): Promise<void>;
    /** Close synchronously; the resolved Promise keeps the control API uniform. */
    disable(): Promise<void>;
}
