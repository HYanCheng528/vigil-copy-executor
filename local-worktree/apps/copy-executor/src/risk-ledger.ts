import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { getAddress } from "ethers";
import type { TargetStrategy } from "./core/messages.js";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UTC_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNSIGNED_DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const MAX_CANDIDATE_HASHES = 32;

export interface RiskLedgerPaths {
  global: string;
  ed: string;
  kuzuo: string;
}

/**
 * One operator-facing base path deterministically names three independent
 * durability domains. The base file is the global emergency circuit; each
 * wallet lane gets its own file and therefore its own fsync queue.
 */
export function riskLedgerPaths(basePath: string): RiskLedgerPaths {
  const normalized = basePath.trim();
  if (!normalized) throw new Error("risk ledger base path is required");
  const extension = extname(normalized);
  const stem = extension ? normalized.slice(0, -extension.length) : normalized;
  return {
    global: normalized,
    ed: `${stem}.ed${extension}`,
    kuzuo: `${stem}.kuzuo${extension}`,
  };
}

export type RiskAttemptState = "reserved" | "settled" | "not_included" | "unknown_charged";
export type RiskOrderingMode = "same_block_after" | "next_block_after" | "any_block_after";

export interface RiskAttemptReservation {
  chainId: number;
  signer: string;
  nonce: number;
  strategy: TargetStrategy;
  targetHash: string;
  candidateHashes: readonly string[];
  /** Separate nonce N+1 Builder payments; never infer their inclusion from the buy. */
  tipCandidateHashes?: readonly string[];
  maxBlock: number;
  worstCostWei: bigint;
  orderingMode?: RiskOrderingMode;
  /** One atomic copy transaction increments the daily audit counter. */
  reservedTrades?: 1;
}

export interface RiskAttemptSnapshot {
  key: string;
  chainId: number;
  signer: string;
  nonce: number;
  strategy: TargetStrategy;
  targetHash: string;
  candidateHashes: string[];
  tipCandidateHashes: string[];
  maxBlock: number;
  /** Latest Builder maxBlockNumber that was actually handed to dispatch. */
  lastSubmittedBlock: number;
  worstCostWei: string;
  orderingMode: RiskOrderingMode;
  reservedTrades: 1;
  state: RiskAttemptState;
  actualCostWei: string | null;
  accountedUtcDate: string | null;
  reservedAt: string;
  lastSubmissionAt: string;
  resolvedAt: string | null;
}

export interface RiskCircuitState {
  tripped: boolean;
  reason: string | null;
  trippedAt: string | null;
}

export interface RiskLedgerLaneIdentity {
  signer: string;
  executor: string;
}

export interface RiskLedgerIdentity {
  chainId: number;
  lanes: Record<TargetStrategy, RiskLedgerLaneIdentity | null>;
}

export interface RiskLedgerSnapshot {
  version: 2;
  identity: RiskLedgerIdentity | null;
  utcDate: string;
  spentWei: Record<TargetStrategy, string>;
  includedTrades: Record<TargetStrategy, number>;
  attempts: Record<string, RiskAttemptSnapshot>;
  circuit: RiskCircuitState;
}

interface LegacyLedgerDocument {
  version: 1;
  utcDate: string;
  spentWei: Record<TargetStrategy, string>;
  includedTrades: Record<TargetStrategy, number>;
}

export interface RiskLedgerDependencies {
  now?: () => Date;
  writeDocument?: (path: string, contents: string) => Promise<void>;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(field + " must be an object");
  }
  return value as Record<string, unknown>;
}

function strategy(value: unknown, field: string): TargetStrategy {
  if (value !== "ed" && value !== "kuzuo") throw new Error(field + " is invalid");
  return value;
}

function safeUnsigned(value: unknown, field: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
    throw new Error(field + " must be a " + (positive ? "positive" : "non-negative") + " safe integer");
  }
  return value as number;
}

function unsignedDecimal(value: unknown, field: string, positive = false): string {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL_RE.test(value)) {
    throw new Error(field + " must be an unsigned decimal string");
  }
  if (positive && value === "0") throw new Error(field + " must be positive");
  return BigInt(value).toString();
}

function normalizedHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH_RE.test(value)) throw new Error(field + " must be a transaction hash");
  return value.toLowerCase();
}

function normalizedSigner(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(field + " must be an address");
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new Error(field + " must be an EVM address");
  }
}

function normalizedIdentity(value: unknown): RiskLedgerIdentity | null {
  if (value === null || value === undefined) return null;
  const record = object(value, "identity");
  const lanes = object(record.lanes, "identity.lanes");
  const normalizeLane = (value: unknown, name: TargetStrategy): RiskLedgerLaneIdentity | null => {
    if (value === null) return null;
    const lane = object(value, `identity.lanes.${name}`);
    return {
      signer: normalizedSigner(lane.signer, `identity.lanes.${name}.signer`),
      executor: normalizedSigner(lane.executor, `identity.lanes.${name}.executor`),
    };
  };
  return {
    chainId: safeUnsigned(record.chainId, "identity.chainId", true),
    lanes: {
      ed: normalizeLane(lanes.ed, "ed"),
      kuzuo: normalizeLane(lanes.kuzuo, "kuzuo"),
    },
  };
}

function normalizedUtcDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !UTC_DATE_RE.test(value)) throw new Error(field + " is invalid");
  const parsed = new Date(value + "T00:00:00.000Z");
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(field + " is invalid");
  }
  return value;
}

function normalizedTimestamp(value: unknown, field: string, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(field + " is invalid");
  return new Date(value).toISOString();
}

function normalizedCandidateHashes(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CANDIDATE_HASHES) {
    throw new Error(field + " must contain 1-" + String(MAX_CANDIDATE_HASHES) + " hashes");
  }
  return [...new Set(value.map((candidate, index) => normalizedHash(candidate, `${field}[${String(index)}]`)))].sort();
}

function normalizedOptionalCandidateHashes(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATE_HASHES) {
    throw new Error(field + " must contain 0-" + String(MAX_CANDIDATE_HASHES) + " hashes");
  }
  return [...new Set(value.map((candidate, index) => normalizedHash(candidate, `${field}[${String(index)}]`)))].sort();
}

function currentDate(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("risk ledger clock returned an invalid date");
  return value.toISOString().slice(0, 10);
}

function currentTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("risk ledger clock returned an invalid date");
  return value.toISOString();
}

export function riskAttemptKey(identity: Pick<RiskAttemptReservation, "chainId" | "signer" | "nonce">): string {
  const chainId = safeUnsigned(identity.chainId, "attempt.chainId", true);
  const signer = normalizedSigner(identity.signer, "attempt.signer");
  const nonce = safeUnsigned(identity.nonce, "attempt.nonce");
  return `${String(chainId)}:${signer}:${String(nonce)}`;
}

function emptyLedger(utcDate: string): RiskLedgerSnapshot {
  return {
    version: 2,
    identity: null,
    utcDate,
    spentWei: { ed: "0", kuzuo: "0" },
    includedTrades: { ed: 0, kuzuo: 0 },
    attempts: {},
    circuit: { tripped: false, reason: null, trippedAt: null },
  };
}

function normalizedCounters(value: unknown, field: string): Record<TargetStrategy, string> {
  const record = object(value, field);
  return {
    ed: unsignedDecimal(record.ed, field + ".ed"),
    kuzuo: unsignedDecimal(record.kuzuo, field + ".kuzuo"),
  };
}

function normalizedTradeCounters(value: unknown, field: string): Record<TargetStrategy, number> {
  const record = object(value, field);
  return {
    ed: safeUnsigned(record.ed, field + ".ed"),
    kuzuo: safeUnsigned(record.kuzuo, field + ".kuzuo"),
  };
}

function normalizedAttempt(key: string, value: unknown): RiskAttemptSnapshot {
  const record = object(value, `attempts.${key}`);
  const state = record.state;
  if (state !== "reserved" && state !== "settled" && state !== "not_included" && state !== "unknown_charged") {
    throw new Error(`attempts.${key}.state is invalid`);
  }
  const snapshot: RiskAttemptSnapshot = {
    key: typeof record.key === "string" ? record.key : "",
    chainId: safeUnsigned(record.chainId, `attempts.${key}.chainId`, true),
    signer: normalizedSigner(record.signer, `attempts.${key}.signer`),
    nonce: safeUnsigned(record.nonce, `attempts.${key}.nonce`),
    strategy: strategy(record.strategy, `attempts.${key}.strategy`),
    targetHash: normalizedHash(record.targetHash, `attempts.${key}.targetHash`),
    candidateHashes: normalizedCandidateHashes(record.candidateHashes, `attempts.${key}.candidateHashes`),
    tipCandidateHashes: record.tipCandidateHashes === undefined
      ? []
      : normalizedOptionalCandidateHashes(record.tipCandidateHashes, `attempts.${key}.tipCandidateHashes`),
    maxBlock: safeUnsigned(record.maxBlock, `attempts.${key}.maxBlock`, true),
    lastSubmittedBlock: record.lastSubmittedBlock === undefined
      ? safeUnsigned(record.maxBlock, `attempts.${key}.maxBlock`, true)
      : safeUnsigned(record.lastSubmittedBlock, `attempts.${key}.lastSubmittedBlock`, true),
    worstCostWei: unsignedDecimal(record.worstCostWei, `attempts.${key}.worstCostWei`, true),
    // Backward-compatible default for every v2 attempt written before the N+1
    // confirmed-log fallback existed.
    orderingMode: record.orderingMode === undefined || record.orderingMode === "same_block_after"
      ? "same_block_after"
      : record.orderingMode === "next_block_after"
        ? "next_block_after"
        : record.orderingMode === "any_block_after"
          ? "any_block_after"
        : (() => { throw new Error(`attempts.${key}.orderingMode is invalid`); })(),
    reservedTrades: record.reservedTrades === 1 ? 1 : (() => { throw new Error(`attempts.${key}.reservedTrades must be 1`); })(),
    state,
    actualCostWei: record.actualCostWei === null
      ? null
      : unsignedDecimal(record.actualCostWei, `attempts.${key}.actualCostWei`),
    accountedUtcDate: record.accountedUtcDate === null
      ? null
      : normalizedUtcDate(record.accountedUtcDate, `attempts.${key}.accountedUtcDate`),
    reservedAt: normalizedTimestamp(record.reservedAt, `attempts.${key}.reservedAt`, false)!,
    lastSubmissionAt: normalizedTimestamp(
      record.lastSubmissionAt === undefined ? record.reservedAt : record.lastSubmissionAt,
      `attempts.${key}.lastSubmissionAt`,
      false,
    )!,
    resolvedAt: normalizedTimestamp(record.resolvedAt, `attempts.${key}.resolvedAt`, true),
  };
  if (snapshot.lastSubmittedBlock < snapshot.maxBlock) {
    throw new Error(`attempts.${key}.lastSubmittedBlock cannot precede maxBlock`);
  }
  const derivedKey = riskAttemptKey(snapshot);
  if (snapshot.key !== key || derivedKey !== key) throw new Error(`attempts.${key} identity does not match its key`);
  if (state === "reserved" && (snapshot.actualCostWei !== null || snapshot.accountedUtcDate !== null || snapshot.resolvedAt !== null)) {
    throw new Error(`attempts.${key} reserved state has terminal accounting fields`);
  }
  if (state === "not_included" && (snapshot.actualCostWei !== null || snapshot.accountedUtcDate !== null || snapshot.resolvedAt === null)) {
    throw new Error(`attempts.${key} not-included state is malformed`);
  }
  if (state === "unknown_charged" && (snapshot.actualCostWei !== null || snapshot.accountedUtcDate === null || snapshot.resolvedAt === null)) {
    throw new Error(`attempts.${key} unknown state is malformed`);
  }
  if (state === "settled" && (snapshot.actualCostWei === null || snapshot.accountedUtcDate === null || snapshot.resolvedAt === null)) {
    throw new Error(`attempts.${key} settled state is malformed`);
  }
  return snapshot;
}

function normalizedCircuit(value: unknown): RiskCircuitState {
  const record = object(value, "circuit");
  if (typeof record.tripped !== "boolean") throw new Error("circuit.tripped must be boolean");
  const reason = record.reason === null ? null : typeof record.reason === "string" ? record.reason : undefined;
  if (reason === undefined || (reason !== null && (reason.trim() === "" || reason.length > 500))) {
    throw new Error("circuit.reason is invalid");
  }
  const trippedAt = normalizedTimestamp(record.trippedAt, "circuit.trippedAt", true);
  if (record.tripped && (reason === null || trippedAt === null)) throw new Error("tripped circuit must retain reason and timestamp");
  if (!record.tripped && (reason !== null || trippedAt !== null)) throw new Error("clear circuit must not retain terminal fields");
  return { tripped: record.tripped, reason, trippedAt };
}

function normalizedV2(value: unknown): RiskLedgerSnapshot {
  const record = object(value, "risk ledger");
  if (record.version !== 2) throw new Error("risk ledger version is unsupported");
  const utcDate = normalizedUtcDate(record.utcDate, "risk ledger utcDate");
  const attemptsValue = object(record.attempts, "attempts");
  const attempts: Record<string, RiskAttemptSnapshot> = {};
  for (const [key, attempt] of Object.entries(attemptsValue)) attempts[key] = normalizedAttempt(key, attempt);
  const document: RiskLedgerSnapshot = {
    version: 2,
    // Old v2 files predate identity binding. They remain readable for status
    // and reconciliation, but live startup must explicitly reject them.
    identity: normalizedIdentity(record.identity),
    utcDate,
    spentWei: normalizedCounters(record.spentWei, "spentWei"),
    includedTrades: normalizedTradeCounters(record.includedTrades, "includedTrades"),
    attempts,
    circuit: normalizedCircuit(record.circuit),
  };

  // Terminal attempts accounted on the active UTC day form a lower bound for
  // the durable counters. Reject a truncated or manually weakened document.
  const minimumSpent = { ed: 0n, kuzuo: 0n };
  const minimumTrades = { ed: 0, kuzuo: 0 };
  for (const attempt of Object.values(attempts)) {
    if (attempt.accountedUtcDate !== utcDate) continue;
    if (attempt.state === "unknown_charged") {
      minimumSpent[attempt.strategy] += BigInt(attempt.worstCostWei);
      minimumTrades[attempt.strategy] += attempt.reservedTrades;
    } else if (attempt.state === "settled") {
      minimumSpent[attempt.strategy] += BigInt(attempt.actualCostWei!);
      minimumTrades[attempt.strategy] += attempt.reservedTrades;
    }
  }
  for (const lane of ["ed", "kuzuo"] as const) {
    if (BigInt(document.spentWei[lane]) < minimumSpent[lane]
      || document.includedTrades[lane] < minimumTrades[lane]) {
      throw new Error("risk ledger counters are lower than durable attempt accounting");
    }
  }
  return document;
}

function normalizedV1(value: unknown, today: string): RiskLedgerSnapshot {
  const record = object(value, "legacy risk ledger");
  if (record.version !== 1) throw new Error("risk ledger version is unsupported");
  const legacy: LegacyLedgerDocument = {
    version: 1,
    utcDate: normalizedUtcDate(record.utcDate, "legacy risk ledger utcDate"),
    spentWei: normalizedCounters(record.spentWei, "legacy spentWei"),
    includedTrades: normalizedTradeCounters(record.includedTrades, "legacy includedTrades"),
  };
  const migrated = emptyLedger(today);
  if (legacy.utcDate === today) {
    migrated.spentWei = legacy.spentWei;
    migrated.includedTrades = legacy.includedTrades;
  }
  return migrated;
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows and some filesystems do not expose directory fsync. File fsync,
    // atomic rename and all other directory errors remain authoritative.
    if (code !== "EISDIR" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM" && code !== "EBADF") {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function durableWriteDocument(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${String(process.pid)}.${randomBytes(8).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await syncDirectoryBestEffort(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function assertSameAttempt(existing: RiskAttemptSnapshot, next: RiskAttemptSnapshot): void {
  if (existing.chainId !== next.chainId
    || existing.signer !== next.signer
    || existing.nonce !== next.nonce
    || existing.strategy !== next.strategy
    || existing.targetHash !== next.targetHash
    || existing.worstCostWei !== next.worstCostWei
    || existing.reservedTrades !== next.reservedTrades) {
    throw new Error("attempt key is already bound to different immutable trade data");
  }
}

export class RiskLedger {
  private document: RiskLedgerSnapshot;
  private readonly now: () => Date;
  private readonly writeDocument: (path: string, contents: string) => Promise<void>;
  private writeTail: Promise<void> = Promise.resolve();
  private latestPersist: Promise<void> = Promise.resolve();
  private loaded = false;
  private existedAtLoad = false;

  constructor(private readonly path: string | null, dependencies: RiskLedgerDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.writeDocument = dependencies.writeDocument ?? durableWriteDocument;
    this.document = emptyLedger(currentDate(this.now));
  }

  async load(options: { requireExisting?: boolean } = {}): Promise<void> {
    if (!this.path) {
      if (options.requireExisting) throw new Error("risk ledger path is unavailable");
      this.loaded = true;
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.existedAtLoad = true;
      const version = object(parsed, "risk ledger").version;
      const today = currentDate(this.now);
      if (version === 1) {
        const migrated = normalizedV1(parsed, today);
        // Live/requireExisting is verification-only. In particular it must not
        // rewrite a legacy or otherwise unbound ledger before identity checking
        // rejects it: startup fail-closed is not authorization to mutate disk.
        if (options.requireExisting) {
          throw new Error("live mode requires a version 2 identity-bound risk ledger; initialize lane ledgers offline first");
        }
        this.document = migrated;
        await this.persist();
        return;
      }
      const document = normalizedV2(parsed);
      if (options.requireExisting && document.identity === null) {
        throw new Error("live mode requires an identity-bound risk ledger; initialize lane ledgers offline first");
      }
      this.document = document;
      if (this.rotateIfNeeded()) await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.existedAtLoad = false;
      if (options.requireExisting) {
        throw new Error("live mode requires a pre-initialized risk ledger; run dry-sign initialization first");
      }
    } finally {
      this.loaded = true;
    }
  }

  /**
   * Bind the durable ledger to the exact BSC signer/Executor topology.
   * Only dry-sign may initialize a brand-new path. Live must match an existing
   * identity, so deleting or redirecting the file cannot erase attempt history
   * or bypass circuit reconciliation.
   */
  ensureIdentity(identity: RiskLedgerIdentity, initializeMissing: boolean): Promise<void> {
    if (!this.loaded) throw new Error("risk ledger must be loaded before identity verification");
    const expected = normalizedIdentity(identity)!;
    const current = this.document.identity;
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new Error("risk ledger identity does not match the configured chain, signers, and executors");
      }
      return Promise.resolve();
    }
    if (!initializeMissing) {
      throw new Error("risk ledger is not initialized for the configured chain, signers, and executors");
    }
    if (this.existedAtLoad) {
      throw new Error("an existing unbound risk ledger cannot be initialized in place");
    }
    const pristine = this.document.spentWei.ed === "0"
      && this.document.spentWei.kuzuo === "0"
      && this.document.includedTrades.ed === 0
      && this.document.includedTrades.kuzuo === 0
      && Object.keys(this.document.attempts).length === 0
      && !this.document.circuit.tripped;
    if (!pristine || !this.path) throw new Error("risk ledger identity initialization requires a new empty durable path");
    this.document.identity = expected;
    return this.persist().then(() => {
      this.existedAtLoad = true;
    });
  }

  /** Confirmed daily spend plus worst-case cost of every unresolved attempt. */
  spent(strategy: TargetStrategy): bigint {
    this.rotateReadIfNeeded();
    let total = BigInt(this.document.spentWei[strategy]);
    for (const attempt of Object.values(this.document.attempts)) {
      if (attempt.strategy === strategy && attempt.state === "reserved") total += BigInt(attempt.worstCostWei);
    }
    return total;
  }

  /** Confirmed daily trades plus the slot reserved by every unresolved attempt. */
  trades(strategy: TargetStrategy): number {
    this.rotateReadIfNeeded();
    let total = this.document.includedTrades[strategy];
    for (const attempt of Object.values(this.document.attempts)) {
      if (attempt.strategy === strategy && attempt.state === "reserved") total += attempt.reservedTrades;
    }
    return total;
  }

  attempt(key: string): RiskAttemptSnapshot | null {
    const value = this.document.attempts[key];
    return value ? structuredClone(value) : null;
  }

  circuitState(): RiskCircuitState {
    return { ...this.document.circuit };
  }

  /**
   * Persistently reserves worst-case spend and one trade before submission.
   * Repeating the same identity is idempotent; candidate hashes may only grow.
   */
  reserveAttempt(reservation: RiskAttemptReservation): Promise<RiskAttemptSnapshot> {
    this.rotateIfNeeded();
    const timestamp = currentTimestamp(this.now);
    const key = riskAttemptKey(reservation);
    const next: RiskAttemptSnapshot = {
      key,
      chainId: safeUnsigned(reservation.chainId, "attempt.chainId", true),
      signer: normalizedSigner(reservation.signer, "attempt.signer"),
      nonce: safeUnsigned(reservation.nonce, "attempt.nonce"),
      strategy: strategy(reservation.strategy, "attempt.strategy"),
      targetHash: normalizedHash(reservation.targetHash, "attempt.targetHash"),
      candidateHashes: normalizedCandidateHashes(reservation.candidateHashes, "attempt.candidateHashes"),
      tipCandidateHashes: normalizedOptionalCandidateHashes(reservation.tipCandidateHashes ?? [], "attempt.tipCandidateHashes"),
      maxBlock: safeUnsigned(reservation.maxBlock, "attempt.maxBlock", true),
      lastSubmittedBlock: safeUnsigned(reservation.maxBlock, "attempt.maxBlock", true),
      worstCostWei: (() => {
        if (reservation.worstCostWei <= 0n) throw new Error("attempt.worstCostWei must be positive");
        return reservation.worstCostWei.toString();
      })(),
      orderingMode: reservation.orderingMode ?? "same_block_after",
      reservedTrades: reservation.reservedTrades ?? 1,
      state: "reserved",
      actualCostWei: null,
      accountedUtcDate: null,
      reservedAt: timestamp,
      lastSubmissionAt: timestamp,
      resolvedAt: null,
    };
    if (next.reservedTrades !== 1) throw new Error("attempt.reservedTrades must be 1");

    const existing = this.document.attempts[key];
    if (existing) {
      // A nonce may be rebound only after its prior envelope was durably proven
      // not included. This is how a causally newer watched-wallet transaction
      // can take over N/N+1 without retaining stale trade identity.
      if (existing.state === "not_included") {
        this.document.attempts[key] = next;
        return this.persistReturning(structuredClone(next));
      }
      assertSameAttempt(existing, next);
      if (existing.state === "settled" || existing.state === "unknown_charged") {
        throw new Error("attempt nonce is already terminally consumed");
      }
      if (next.lastSubmittedBlock < existing.lastSubmittedBlock) {
        throw new Error("attempt submission block cannot regress");
      }
      existing.maxBlock = next.lastSubmittedBlock;
      existing.lastSubmittedBlock = next.lastSubmittedBlock;
      existing.lastSubmissionAt = timestamp;
      if (existing.orderingMode !== next.orderingMode) existing.orderingMode = "any_block_after";
      existing.candidateHashes = [...new Set([...existing.candidateHashes, ...next.candidateHashes])].sort();
      if (existing.candidateHashes.length > MAX_CANDIDATE_HASHES) throw new Error("attempt has too many candidate hashes");
      existing.tipCandidateHashes = [...new Set([
        ...existing.tipCandidateHashes,
        ...next.tipCandidateHashes,
      ])].sort();
      if (existing.tipCandidateHashes.length > MAX_CANDIDATE_HASHES) {
        throw new Error("attempt has too many tip candidate hashes");
      }
      return this.persistReturning(structuredClone(existing));
    }
    this.document.attempts[key] = next;
    return this.persistReturning(structuredClone(next));
  }

  /** Settle a known inclusion. Unknown conservative charge is adjusted, never added twice. */
  settleAttemptActual(key: string, actualCostWei: bigint): Promise<RiskAttemptSnapshot> {
    if (actualCostWei < 0n) throw new Error("actual included cost cannot be negative");
    this.rotateIfNeeded();
    const attempt = this.requireAttempt(key);
    const actual = actualCostWei.toString();
    if (attempt.state === "settled") {
      if (attempt.actualCostWei !== actual) throw new Error("attempt is already settled with a different actual cost");
      return this.persistReturning(structuredClone(attempt));
    }
    if (attempt.state === "not_included") throw new Error("confirmed not-included attempt cannot be settled");

    const today = this.document.utcDate;
    if (attempt.state === "reserved") {
      this.addConfirmed(attempt.strategy, actualCostWei, attempt.reservedTrades);
      attempt.accountedUtcDate = today;
    } else if (attempt.accountedUtcDate === today) {
      const previous = BigInt(attempt.worstCostWei);
      const confirmed = BigInt(this.document.spentWei[attempt.strategy]);
      if (actualCostWei >= previous) {
        this.document.spentWei[attempt.strategy] = (confirmed + actualCostWei - previous).toString();
      } else {
        const reduction = previous - actualCostWei;
        if (confirmed < reduction) throw new Error("risk ledger conservative charge cannot be adjusted safely");
        this.document.spentWei[attempt.strategy] = (confirmed - reduction).toString();
      }
      // The unknown charge already consumed its one trade slot.
    }
    attempt.state = "settled";
    attempt.actualCostWei = actual;
    attempt.resolvedAt = currentTimestamp(this.now);
    return this.persistReturning(structuredClone(attempt));
  }

  /** Release only after authoritative proof that no candidate was included. */
  releaseConfirmedNotIncluded(key: string): Promise<RiskAttemptSnapshot> {
    this.rotateIfNeeded();
    const attempt = this.requireAttempt(key);
    if (attempt.state === "not_included") return this.persistReturning(structuredClone(attempt));
    if (attempt.state !== "reserved") throw new Error("accounted attempt cannot be released as not included");
    attempt.state = "not_included";
    attempt.resolvedAt = currentTimestamp(this.now);
    return this.persistReturning(structuredClone(attempt));
  }

  /**
   * If nonce consumption cannot be reconciled, charge worst cost and one trade.
   * A later receipt may call settleAttemptActual to adjust this same attempt.
   */
  chargeUnknownConsumption(key: string): Promise<RiskAttemptSnapshot> {
    this.rotateIfNeeded();
    const attempt = this.requireAttempt(key);
    if (attempt.state === "unknown_charged" || attempt.state === "settled") {
      return this.persistReturning(structuredClone(attempt));
    }
    if (attempt.state === "not_included") throw new Error("confirmed not-included attempt cannot consume nonce");
    this.addConfirmed(attempt.strategy, BigInt(attempt.worstCostWei), attempt.reservedTrades);
    attempt.state = "unknown_charged";
    attempt.accountedUtcDate = this.document.utcDate;
    attempt.resolvedAt = currentTimestamp(this.now);
    return this.persistReturning(structuredClone(attempt));
  }

  /** Legacy inclusion API retained until Engine adopts attempt settlement. */
  recordIncluded(strategy: TargetStrategy, costWei: bigint): Promise<void> {
    if (costWei < 0n) throw new Error("included cost cannot be negative");
    this.rotateIfNeeded();
    this.addConfirmed(strategy, costWei, 1);
    return this.persist();
  }

  /** First trip wins and survives UTC rotation/restart until clearCircuit is called. */
  tripCircuit(reason: string): Promise<RiskCircuitState> {
    const normalized = reason.trim();
    if (!normalized || normalized.length > 500) throw new Error("circuit trip reason must contain 1-500 characters");
    this.rotateIfNeeded();
    if (!this.document.circuit.tripped) {
      this.document.circuit = {
        tripped: true,
        reason: normalized,
        trippedAt: currentTimestamp(this.now),
      };
    }
    return this.persistReturning(this.circuitState());
  }

  /** Deliberately explicit operator/application action; no startup or date path calls it. */
  clearCircuit(): Promise<RiskCircuitState> {
    this.rotateIfNeeded();
    const unresolved = Object.values(this.document.attempts)
      .some((attempt) => attempt.state === "reserved" || attempt.state === "unknown_charged");
    if (unresolved) {
      throw new Error("cannot clear circuit while an unresolved attempt still requires reconciliation");
    }
    this.document.circuit = { tripped: false, reason: null, trippedAt: null };
    return this.persistReturning(this.circuitState());
  }

  snapshot(): RiskLedgerSnapshot {
    this.rotateReadIfNeeded();
    return structuredClone(this.document);
  }

  /** Explicit retry/barrier for callers that need durable-before-submit semantics. */
  persist(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const snapshot = JSON.stringify(this.document) + "\n";
    const operation = this.writeTail.then(() => this.writeDocument(this.path!, snapshot));
    // A failed write is returned to the initiating caller, but does not poison
    // later retries. Attaching a handler also avoids an unhandled rejection if
    // a legacy caller has not yet been converted to await the returned promise.
    this.writeTail = operation.catch(() => undefined);
    this.latestPersist = operation;
    void operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.latestPersist;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private persistReturning<T>(value: T): Promise<T> {
    return this.persist().then(() => value);
  }

  private requireAttempt(key: string): RiskAttemptSnapshot {
    const attempt = this.document.attempts[key];
    if (!attempt) throw new Error("risk attempt does not exist");
    return attempt;
  }

  private addConfirmed(strategy: TargetStrategy, costWei: bigint, trades: number): void {
    this.document.spentWei[strategy] = (BigInt(this.document.spentWei[strategy]) + costWei).toString();
    this.document.includedTrades[strategy] += trades;
    if (!Number.isSafeInteger(this.document.includedTrades[strategy])) throw new Error("daily trade counter overflow");
  }

  private rotateIfNeeded(): boolean {
    const today = currentDate(this.now);
    if (this.document.utcDate === today) return false;
    this.document.utcDate = today;
    this.document.spentWei = { ed: "0", kuzuo: "0" };
    this.document.includedTrades = { ed: 0, kuzuo: 0 };
    // Resolved attempts have already been folded into the prior day's counters
    // (or proved absent), so retaining them would make every hot-path rewrite
    // grow without bound. Reserved/unknown attempts and the circuit latch must
    // survive indefinitely until authoritative reconciliation.
    for (const [key, attempt] of Object.entries(this.document.attempts)) {
      if (attempt.state === "settled" || attempt.state === "not_included") {
        delete this.document.attempts[key];
      }
    }
    return true;
  }

  private rotateReadIfNeeded(): void {
    if (this.rotateIfNeeded()) void this.persist();
  }
}
