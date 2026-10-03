import type { TargetStrategy } from "./core/messages.js";

const DEFAULT_CAPACITY = 64;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 150;
const DEFAULT_SEEN_CAPACITY = 4_096;
const TARGET_HASH = /^0x[0-9a-fA-F]{64}$/;
const BEARER_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/;

export const DEFAULT_MACHINE_DISPATCH_ENDPOINT = "http://127.0.0.1:8766/internal/machine-dispatch";

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

type QueuedMachineDispatchNotice = Omit<MachineDispatchNotice, "dispatchedAt">;

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return resolved;
}

function loopbackEndpoint(value: string): string {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "http:"
    || parsed.username
    || parsed.password
    || (host !== "localhost" && host !== "127.0.0.1" && host !== "::1")
    || parsed.pathname !== "/internal/machine-dispatch"
    || parsed.search
    || parsed.hash) {
    throw new Error("machine dispatch notifier endpoint must be loopback HTTP /internal/machine-dispatch");
  }
  return parsed.toString();
}

function canonicalHash(value: string): string | null {
  return TARGET_HASH.test(value) ? value.toLowerCase() : null;
}

/**
 * A lossy, detached notification sidecar for the first real Builder dispatch.
 *
 * `afterBuilderDispatchStarted` only performs bounded in-memory work. JSON
 * timestamping, serialization and loopback fetch are deferred to `setImmediate`, so a slow,
 * unauthenticated or unavailable relay can only drop speech telemetry and can
 * never become part of the Builder write path.
 */
export class DetachedMachineDispatchNotifier {
  private readonly endpoint: string;
  private readonly bearerToken: string;
  private readonly capacity: number;
  private readonly concurrency: number;
  private readonly requestTimeoutMs: number;
  private readonly seenCapacity: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;
  private readonly queue: QueuedMachineDispatchNotice[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly seen = new Map<string, true>();
  private pumpScheduled = false;
  private closed = false;
  private accepted = 0;
  private delivered = 0;
  private failed = 0;
  private dropped = 0;
  private duplicates = 0;
  private invalid = 0;

  constructor(options: DetachedMachineDispatchNotifierOptions) {
    this.endpoint = loopbackEndpoint(options.endpoint ?? DEFAULT_MACHINE_DISPATCH_ENDPOINT);
    if (!BEARER_TOKEN.test(options.bearerToken)) {
      throw new Error("machine dispatch notifier bearer token is invalid");
    }
    this.bearerToken = options.bearerToken;
    this.capacity = positiveInteger(options.capacity, DEFAULT_CAPACITY, "capacity");
    this.concurrency = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY, "concurrency");
    if (this.concurrency > this.capacity) throw new Error("concurrency cannot exceed capacity");
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.seenCapacity = positiveInteger(options.seenCapacity, DEFAULT_SEEN_CAPACITY, "seenCapacity");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Call immediately after `builder.dispatch(prepared)` returns its Promise.
   * It is safe to call once per Builder candidate: strategy+targetHash dedupe
   * ensures only the first started dispatch schedules a notification.
   */
  afterBuilderDispatchStarted(strategy: TargetStrategy, targetHash: string): void {
    try {
      if (this.closed) {
        this.dropped += 1;
        return;
      }
      if (strategy !== "ed" && strategy !== "kuzuo") {
        this.invalid += 1;
        return;
      }
      const hash = canonicalHash(targetHash);
      if (!hash) {
        this.invalid += 1;
        return;
      }
      const key = `${strategy}:${hash}`;
      if (this.seen.has(key)) {
        this.duplicates += 1;
        return;
      }
      if (this.queue.length + this.inFlight.size >= this.capacity) {
        this.dropped += 1;
        return;
      }
      this.remember(key);
      this.queue.push({
        version: 1,
        strategy,
        targetHash: hash,
      });
      this.accepted += 1;
      this.schedulePump();
    } catch {
      // This boundary is deliberately fail-open for trading. Even a broken
      // clock or injected test dependency is reduced to lost speech telemetry.
      this.invalid += 1;
    }
  }

  snapshot(): MachineDispatchNotifierSnapshot {
    return {
      queued: this.queue.length,
      inFlight: this.inFlight.size,
      accepted: this.accepted,
      delivered: this.delivered,
      failed: this.failed,
      dropped: this.dropped,
      duplicates: this.duplicates,
      invalid: this.invalid,
      closed: this.closed,
    };
  }

  async stop(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled([...this.inFlight]);
      return;
    }
    this.closed = true;
    this.dropped += this.queue.length;
    this.queue.length = 0;
    await Promise.allSettled([...this.inFlight]);
  }

  private remember(key: string): void {
    this.seen.set(key, true);
    while (this.seen.size > this.seenCapacity) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seen.delete(oldest);
    }
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.closed) return;
    this.pumpScheduled = true;
    // Builder socket writes and their Promise continuations get priority over
    // this lossy sidecar. Starting in the check phase also proves the hot-path
    // call itself performs no clock, serialization or network work.
    setImmediate(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.closed) return;
    while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
      const notice = this.queue.shift()!;
      const work = this.deliver(notice);
      this.inFlight.add(work);
      void work.finally(() => {
        this.inFlight.delete(work);
        this.pump();
      });
    }
  }

  private async deliver(queued: QueuedMachineDispatchNotice): Promise<void> {
    try {
      const notice: MachineDispatchNotice = {
        ...queued,
        dispatchedAt: this.now(),
      };
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(notice),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (response.status === 202) this.delivered += 1;
      else this.failed += 1;
    } catch {
      this.failed += 1;
    }
  }
}
