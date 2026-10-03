import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { formatEther, formatUnits, parseEther, parseUnits } from "ethers";
import type { StrategyLaneConfig } from "./config.js";
import type { TargetStrategy } from "./core/messages.js";

const BNB_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/;
const GWEI_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/;
const UINT_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;

export interface RuntimeLaneSettings {
  followAmountWei: bigint;
  gasPriceWei: bigint;
  builderTipWei: bigint;
}

export interface RuntimeLaneUpdate {
  strategy: TargetStrategy;
  followAmountBnb: string;
  gasPriceGwei: string;
  builderTipBnb: string;
}

export class RuntimeSettingsError extends Error {
  constructor(readonly code: "invalid_value" | "persistence_unavailable", message: string) {
    super(message);
  }
}

interface RuntimeSettingsDocument {
  version: 1;
  updatedAt: string;
  lanes: Record<TargetStrategy, {
    followAmountWei: string;
    gasPriceWei: string;
    builderTipWei: string;
  }>;
}

export interface RuntimeSettingsDependencies {
  writeDocument?: (path: string, contents: string) => Promise<void>;
  now?: () => Date;
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
    } finally {
      await directory?.close().catch(() => undefined);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(field + " has unexpected fields");
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(field + " must be an object");
  return value as Record<string, unknown>;
}

function positiveUint256Raw(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !UINT_DECIMAL.test(value) || value === "0") {
    throw new Error(field + " must be a positive integer string");
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new Error(field + " must fit uint256");
  return parsed;
}

function parseFixed(value: string, unit: "bnb" | "gwei", field: string): bigint {
  const pattern = unit === "bnb" ? BNB_DECIMAL : GWEI_DECIMAL;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RuntimeSettingsError("invalid_value", `${field} is not a canonical ${unit} decimal string`);
  }
  const parsed = unit === "bnb" ? parseEther(value) : parseUnits(value, "gwei");
  if (parsed <= 0n) throw new RuntimeSettingsError("invalid_value", field + " must be positive");
  if (parsed > UINT256_MAX) throw new RuntimeSettingsError("invalid_value", field + " must fit uint256");
  return parsed;
}

export class RuntimeSettingsStore {
  private current: Record<TargetStrategy, RuntimeLaneSettings>;
  private updatedAt: string | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly writeDocument: (path: string, contents: string) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    private readonly path: string | null,
    private readonly lanes: Record<TargetStrategy, StrategyLaneConfig>,
    dependencies: RuntimeSettingsDependencies = {},
  ) {
    this.current = {
      ed: this.defaults("ed"),
      kuzuo: this.defaults("kuzuo"),
    };
    this.writeDocument = dependencies.writeDocument ?? atomicWrite;
    this.now = dependencies.now ?? (() => new Date());
  }

  get writable(): boolean {
    return Boolean(this.path);
  }

  lane(strategy: TargetStrategy): RuntimeLaneSettings {
    return { ...this.current[strategy] };
  }

  async load(): Promise<void> {
    if (!this.path) return;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.persist(this.current, this.timestamp());
        return;
      }
      throw error;
    }
    const parsed = object(JSON.parse(raw) as unknown, "runtime settings");
    exactKeys(parsed, ["version", "updatedAt", "lanes"], "runtime settings");
    if (parsed.version !== 1 || typeof parsed.updatedAt !== "string" || Number.isNaN(Date.parse(parsed.updatedAt))) {
      throw new Error("runtime settings header is invalid");
    }
    const lanes = object(parsed.lanes, "runtime settings.lanes");
    exactKeys(lanes, ["ed", "kuzuo"], "runtime settings.lanes");
    const next = {
      ed: this.parseLaneDocument(lanes.ed, "ed"),
      kuzuo: this.parseLaneDocument(lanes.kuzuo, "kuzuo"),
    };
    this.current = next;
    this.updatedAt = new Date(parsed.updatedAt).toISOString();
  }

  update(request: RuntimeLaneUpdate): Promise<void> {
    const operation = this.writes.then(async () => {
      if (!this.path) throw new RuntimeSettingsError("persistence_unavailable", "runtime settings persistence is unavailable");
      const nextLane: RuntimeLaneSettings = {
        followAmountWei: parseFixed(request.followAmountBnb, "bnb", "followAmountBnb"),
        gasPriceWei: parseFixed(request.gasPriceGwei, "gwei", "gasPriceGwei"),
        builderTipWei: parseFixed(request.builderTipBnb, "bnb", "builderTipBnb"),
      };
      const next: Record<TargetStrategy, RuntimeLaneSettings> = {
        ed: { ...this.current.ed },
        kuzuo: { ...this.current.kuzuo },
      };
      next[request.strategy] = nextLane;
      const updatedAt = this.timestamp();
      // Publish only after the rename+fsync succeeds. A target arriving while
      // this write is in flight therefore sees the complete previous tuple.
      await this.persist(next, updatedAt);
      this.current = next;
      this.updatedAt = updatedAt;
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  snapshot(): Record<string, unknown> {
    return {
      writable: this.writable,
      updatedAt: this.updatedAt,
      lanes: (["ed", "kuzuo"] as const).map((strategy) => {
        const settings = this.current[strategy];
        return {
          strategy,
          followAmountBnb: formatEther(settings.followAmountWei),
          gasPriceGwei: formatUnits(settings.gasPriceWei, "gwei"),
          builderTipBnb: formatEther(settings.builderTipWei),
        };
      }),
    };
  }

  private defaults(strategy: TargetStrategy): RuntimeLaneSettings {
    const lane = this.lanes[strategy];
    return {
      followAmountWei: lane.followAmountWei,
      gasPriceWei: lane.gasPriceWei,
      builderTipWei: lane.builderTipWei,
    };
  }

  private parseLaneDocument(value: unknown, strategy: TargetStrategy): RuntimeLaneSettings {
    const record = object(value, `runtime settings.lanes.${strategy}`);
    exactKeys(record, ["followAmountWei", "gasPriceWei", "builderTipWei"], `runtime settings.lanes.${strategy}`);
    const parsed = {
      followAmountWei: positiveUint256Raw(record.followAmountWei, `${strategy}.followAmountWei`),
      gasPriceWei: positiveUint256Raw(record.gasPriceWei, `${strategy}.gasPriceWei`),
      builderTipWei: positiveUint256Raw(record.builderTipWei, `${strategy}.builderTipWei`),
    };
    return parsed;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("runtime settings clock is invalid");
    return value.toISOString();
  }

  private async persist(value: Record<TargetStrategy, RuntimeLaneSettings>, updatedAt: string): Promise<void> {
    if (!this.path) throw new RuntimeSettingsError("persistence_unavailable", "runtime settings persistence is unavailable");
    const document: RuntimeSettingsDocument = {
      version: 1,
      updatedAt,
      lanes: {
        ed: {
          followAmountWei: value.ed.followAmountWei.toString(),
          gasPriceWei: value.ed.gasPriceWei.toString(),
          builderTipWei: value.ed.builderTipWei.toString(),
        },
        kuzuo: {
          followAmountWei: value.kuzuo.followAmountWei.toString(),
          gasPriceWei: value.kuzuo.gasPriceWei.toString(),
          builderTipWei: value.kuzuo.builderTipWei.toString(),
        },
      },
    };
    await this.writeDocument(this.path, JSON.stringify(document) + "\n");
    this.updatedAt = updatedAt;
  }
}
