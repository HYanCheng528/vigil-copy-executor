/**
 * Per-process live latch. It is intentionally never restored from disk: a
 * service restart, crash or DynamicUser identity change always starts closed.
 * Root-owned deployment credentials authorize the control request; the
 * unprivileged executor does not need to mutate any root-owned file.
 */
export class ArmGate {
    required;
    armedState = false;
    static ENABLE_CONFIRMATION = "I_ACCEPT_LIVE_COPY_TRADING_NOW";
    constructor(_legacyPath, required) {
        this.required = required;
    }
    get armed() {
        return this.required ? this.armedState : true;
    }
    /** Kept as a compatibility field; runtime control uses the fixed phrase. */
    get challenge() {
        return null;
    }
    async start() {
        this.armedState = false;
    }
    stop() {
        this.armedState = false;
    }
    async enable(confirmation) {
        if (!this.required)
            throw new Error("live arming is unavailable outside live mode");
        if (confirmation !== ArmGate.ENABLE_CONFIRMATION)
            throw new Error("live enable confirmation is invalid");
        this.armedState = true;
    }
    /** Close synchronously; the resolved Promise keeps the control API uniform. */
    disable() {
        this.armedState = false;
        return Promise.resolve();
    }
}
//# sourceMappingURL=arm-gate.js.map