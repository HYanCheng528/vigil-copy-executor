/**
 * Per-process live latch. It is intentionally never restored from disk: a
 * service restart, crash or DynamicUser identity change always starts closed.
 * Root-owned deployment credentials authorize the control request; the
 * unprivileged executor does not need to mutate any root-owned file.
 */
export class ArmGate {
  private armedState = false;

  static readonly ENABLE_CONFIRMATION = "I_ACCEPT_LIVE_COPY_TRADING_NOW";

  constructor(_legacyPath: string | null, private readonly required: boolean) {}

  get armed(): boolean {
    return this.required ? this.armedState : true;
  }

  /** Kept as a compatibility field; runtime control uses the fixed phrase. */
  get challenge(): null {
    return null;
  }

  async start(): Promise<void> {
    this.armedState = false;
  }

  stop(): void {
    this.armedState = false;
  }

  async enable(confirmation: string): Promise<void> {
    if (!this.required) throw new Error("live arming is unavailable outside live mode");
    if (confirmation !== ArmGate.ENABLE_CONFIRMATION) throw new Error("live enable confirmation is invalid");
    this.armedState = true;
  }

  /** Close synchronously; the resolved Promise keeps the control API uniform. */
  disable(): Promise<void> {
    this.armedState = false;
    return Promise.resolve();
  }
}
