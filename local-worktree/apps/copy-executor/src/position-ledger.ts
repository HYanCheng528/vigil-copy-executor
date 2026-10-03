import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getAddress } from "ethers";
import type { TargetStrategy } from "./core/messages.js";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/;

export interface PositionSnapshot {
  strategy: TargetStrategy;
  tokenAddress: string;
  symbol: string | null;
  decimals: number | null;
  balanceRaw: string;
  acquiredAt: string;
  updatedAt: string;
  sourceTxHash: string;
  status: "open" | "closed";
}

interface PositionDocument {
  version: 1;
  positions: PositionSnapshot[];
}

export interface PositionReader {
  tokenBalance(token: string, owner: string): Promise<bigint>;
  tokenMetadata(token: string): Promise<{ symbol: string | null; decimals: number | null }>;
  close?(): void | Promise<void>;
}

export interface PositionLedgerDependencies {
  writeDocument?: (path: string, contents: string) => Promise<void>;
  now?: () => Date;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onError?: (reason: string) => void;
  reconcileConcurrency?: number;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r").catch(() => null);
    try {
      await directory?.sync().catch((error) => {
        if (process.platform !== "win32") throw error;
      });
    } finally { await directory?.close().catch(() => undefined); }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(field + " is invalid");
  return new Date(value).toISOString();
}

function normalizePosition(value: unknown, index: number): PositionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("position is invalid");
  const item = value as Record<string, unknown>;
  const expected = ["acquiredAt", "balanceRaw", "decimals", "sourceTxHash", "status", "strategy", "symbol", "tokenAddress", "updatedAt"].sort();
  const actual = Object.keys(item).sort();
  if (actual.length !== expected.length || actual.some((key, keyIndex) => key !== expected[keyIndex])) {
    throw new Error(`positions[${String(index)}] has unexpected fields`);
  }
  if (item.strategy !== "ed" && item.strategy !== "kuzuo") throw new Error("position strategy is invalid");
  if (typeof item.tokenAddress !== "string") throw new Error("position token is invalid");
  const tokenAddress = getAddress(item.tokenAddress).toLowerCase();
  if (item.symbol !== null && (typeof item.symbol !== "string" || item.symbol.length < 1 || item.symbol.length > 64)) {
    throw new Error("position symbol is invalid");
  }
  if (item.decimals !== null && (!Number.isSafeInteger(item.decimals) || (item.decimals as number) < 0 || (item.decimals as number) > 255)) {
    throw new Error("position decimals are invalid");
  }
  if (typeof item.balanceRaw !== "string" || !UINT_RE.test(item.balanceRaw)) throw new Error("position balance is invalid");
  if (typeof item.sourceTxHash !== "string" || !HASH_RE.test(item.sourceTxHash)) throw new Error("position source hash is invalid");
  if (item.status !== "open" && item.status !== "closed") throw new Error("position status is invalid");
  return {
    strategy: item.strategy,
    tokenAddress,
    symbol: item.symbol,
    decimals: item.decimals as number | null,
    balanceRaw: BigInt(item.balanceRaw).toString(),
    acquiredAt: timestamp(item.acquiredAt, "position acquiredAt"),
    updatedAt: timestamp(item.updatedAt, "position updatedAt"),
    sourceTxHash: item.sourceTxHash.toLowerCase(),
    status: item.status,
  };
}

export class PositionLedger {
  private readonly positions = new Map<string, PositionSnapshot>();
  private readonly writeDocument: (path: string, contents: string) => Promise<void>;
  private readonly now: () => Date;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private readonly onError: (reason: string) => void;
  private readonly reconcileConcurrency: number;
  private writes: Promise<void> = Promise.resolve();
  private work = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private reconciling = false;

  constructor(
    private readonly path: string | null,
    private readonly reader: PositionReader | null,
    private readonly wallets: Record<TargetStrategy, string | null>,
    private readonly reconcileIntervalMs: number,
    dependencies: PositionLedgerDependencies = {},
  ) {
    this.writeDocument = dependencies.writeDocument ?? atomicWrite;
    this.now = dependencies.now ?? (() => new Date());
    this.setIntervalImpl = dependencies.setInterval ?? setInterval;
    this.clearIntervalImpl = dependencies.clearInterval ?? clearInterval;
    this.onError = dependencies.onError ?? (() => undefined);
    this.reconcileConcurrency = dependencies.reconcileConcurrency ?? 4;
    if (!Number.isSafeInteger(this.reconcileConcurrency) || this.reconcileConcurrency < 1) {
      throw new Error("position reconcile concurrency must be positive");
    }
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.load();
    if (this.path && this.reader && this.reconcileIntervalMs > 0) {
      this.timer = this.setIntervalImpl(() => this.track(this.reconcile()), this.reconcileIntervalMs);
      this.timer.unref?.();
      this.track(this.reconcile());
    }
  }

  get enabled(): boolean {
    return !this.stopped && Boolean(this.path && this.reader);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.work]);
    await this.writes.catch(() => undefined);
    await this.reader?.close?.();
  }

  snapshot(): { positions: PositionSnapshot[] } {
    return {
      positions: [...this.positions.values()]
        .filter((position) => position.status === "open" && position.balanceRaw !== "0")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((position) => ({ ...position })),
    };
  }

  recordIncluded(request: {
    strategy: TargetStrategy;
    tokenAddress: string;
    sourceTxHash: string;
    acquiredAt?: string;
  }): void {
    if (this.stopped || !this.path || !this.reader) return;
    this.track(this.record(request));
  }

  private track(promise: Promise<unknown>): void {
    this.work.add(promise);
    void promise.catch((error) => this.onError((error instanceof Error ? error.message : String(error)).slice(0, 240)))
      .finally(() => this.work.delete(promise));
  }

  private async record(request: {
    strategy: TargetStrategy;
    tokenAddress: string;
    sourceTxHash: string;
    acquiredAt?: string;
  }): Promise<void> {
    const wallet = this.wallets[request.strategy];
    if (!wallet) return;
    const tokenAddress = getAddress(request.tokenAddress).toLowerCase();
    if (!HASH_RE.test(request.sourceTxHash)) throw new Error("position source hash is invalid");
    const [balance, metadata] = await Promise.all([
      this.reader!.tokenBalance(tokenAddress, wallet),
      this.reader!.tokenMetadata(tokenAddress).catch(() => ({ symbol: null, decimals: null })),
    ]);
    const updatedAt = this.currentTimestamp();
    const key = `${request.strategy}:${tokenAddress}`;
    await this.mutate(() => {
      const existing = this.positions.get(key);
      this.positions.set(key, {
        strategy: request.strategy,
        tokenAddress,
        symbol: metadata.symbol ?? existing?.symbol ?? null,
        decimals: metadata.decimals ?? existing?.decimals ?? null,
        balanceRaw: balance.toString(),
        acquiredAt: existing?.acquiredAt ?? (request.acquiredAt ? timestamp(request.acquiredAt, "acquiredAt") : updatedAt),
        updatedAt,
        sourceTxHash: request.sourceTxHash.toLowerCase(),
        status: balance > 0n ? "open" : "closed",
      });
    });
  }

  private async reconcile(): Promise<void> {
    if (this.stopped || !this.reader || this.reconciling) return;
    this.reconciling = true;
    try {
      const open = this.snapshot().positions.filter((position) => Boolean(this.wallets[position.strategy]));
      if (open.length === 0) return;
      const balances: Array<{ key: string; balance: bigint }> = [];
      for (let offset = 0; offset < open.length; offset += this.reconcileConcurrency) {
        if (this.stopped) return;
        const batch = open.slice(offset, offset + this.reconcileConcurrency);
        const settled = await Promise.allSettled(batch.map(async (position) => ({
          key: `${position.strategy}:${position.tokenAddress}`,
          balance: await this.reader!.tokenBalance(position.tokenAddress, this.wallets[position.strategy]!),
        })));
        for (const result of settled) {
          if (result.status === "fulfilled") {
            balances.push(result.value);
          } else {
            // A malformed/non-standard token or one provider failure must not
            // prevent other positions in this pass from detecting a manual sell.
            this.onError((result.reason instanceof Error ? result.reason.message : String(result.reason)).slice(0, 240));
          }
        }
      }
      const changed = balances.some(({ key, balance }) => this.positions.get(key)?.balanceRaw !== balance.toString());
      if (!changed) return;
      const updatedAt = this.currentTimestamp();
      await this.mutate(() => {
        for (const { key, balance } of balances) {
          const existing = this.positions.get(key);
          if (!existing || existing.balanceRaw === balance.toString()) continue;
          this.positions.set(key, {
            ...existing,
            balanceRaw: balance.toString(),
            status: balance > 0n ? "open" : "closed",
            updatedAt,
          });
        }
      });
    } finally {
      this.reconciling = false;
    }
  }

  private async load(): Promise<void> {
    if (!this.path) return;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.persist();
        return;
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("position ledger is invalid");
    const document = parsed as Record<string, unknown>;
    if (document.version !== 1 || !Array.isArray(document.positions)) throw new Error("position ledger header is invalid");
    this.positions.clear();
    document.positions.map(normalizePosition).forEach((position) => {
      this.positions.set(`${position.strategy}:${position.tokenAddress}`, position);
    });
  }

  private mutate(callback: () => void): Promise<void> {
    const operation = this.writes.then(async () => {
      const before = new Map([...this.positions.entries()].map(([key, value]) => [key, { ...value }]));
      callback();
      try {
        await this.persist();
      } catch (error) {
        this.positions.clear();
        before.forEach((value, key) => this.positions.set(key, value));
        throw error;
      }
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  private async persist(): Promise<void> {
    if (!this.path) return;
    const document: PositionDocument = {
      version: 1,
      positions: [...this.positions.values()].sort((left, right) => left.strategy.localeCompare(right.strategy)
        || left.tokenAddress.localeCompare(right.tokenAddress)),
    };
    await this.writeDocument(this.path, JSON.stringify(document) + "\n");
  }

  private currentTimestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("position ledger clock is invalid");
    return value.toISOString();
  }
}
