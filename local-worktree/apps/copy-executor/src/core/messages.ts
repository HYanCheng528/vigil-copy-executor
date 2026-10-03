import { Transaction, getAddress } from "ethers";

export type HexString = `0x${string}`;

export const EXECUTION_SIGNAL_VERSION = 1 as const;
export const BSC_CHAIN_ID = 56 as const;

function configuredTargetAddress(name: string, fallback: string): string {
  return getAddress(process.env[name]?.trim() || fallback);
}

export const ED_TARGET_ADDRESS = configuredTargetAddress(
  "COPYTRADE_ED_TARGET_ADDRESS",
  "0xC2C6aCD377458010713e733e1b21dD6F670D091C",
);
export const KUZUO_TARGET_ADDRESS = configuredTargetAddress(
  "COPYTRADE_KUZUO_TARGET_ADDRESS",
  "0x2cE9D43d1CBA6ae31D7f07BfE0098DFa2D833373",
);
export const KNOWN_BUILDER_TIP_RECIPIENTS = new Set([
  "0x4848489f0b2bedd788c696e2d79b6b69d7484848", // 48Club
  "0x1266c6be60392a8ff346e8d5eccd3e69dd9c5f20", // BlockRazor
  "0xe89c42bc188c993273ab34231e12ae60c73042e4", // Jet
  "0xfffffffffffffffffffffffffffffffffffffffe", // NodeReal
]);

export type TargetStrategy = "ed" | "kuzuo";
export type ExecutionMode = "observe" | "shadow" | "dry-sign" | "live";
export type TargetSignalSource =
  | "bsc_pending_full"
  | "blockrazor_public_mempool"
  | "blockrazor_private_mempool"
  | "club48_auction"
  | "blockrazor_orderflow"
  | "jet_orderflow"
  | "confirmed_log_fallback";

export interface TargetTransactionWire {
  hash: HexString;
  rawTransaction?: HexString;
  chainId: typeof BSC_CHAIN_ID;
  type: 0;
  from: string;
  to: string;
  nonce: number;
  gasPriceWei: string;
  gasLimit: string;
  valueWei: string;
  input: HexString;
}

export type BlockRazorPrivateRegion = "tokyo" | "new-york" | "frankfurt" | "dublin";

/**
 * BlockRazor's Private Mempool deliberately discloses selected transaction
 * fields, not the signed raw transaction or its gas envelope. Keeping this as
 * a separate wire type prevents callers from inventing gas/raw values merely
 * to fit TargetTransactionWire.
 */
export interface BlockRazorPrivateTransactionWire {
  disclosure: "blockrazor_private";
  hash: HexString;
  chainId: typeof BSC_CHAIN_ID;
  from: string;
  to: string;
  nonce: number;
  valueWei: string;
  input: HexString;
  functionSelector: HexString;
  logCount: number;
}

export interface BlockRazorPrivateBundleContext {
  bundleHash: HexString;
  region: BlockRazorPrivateRegion;
  nextBlockNumber: number;
  maxBlockNumber: number;
  proxyBidContract: string;
  refundAddress: string;
  /** Normalized unsigned integer. The stream calls this `int`; proxyBid uses uint256. */
  refundCfg: string;
  targetIndex: number;
  transactionCount: number;
  logsVerified: true;
  routerSwapVerified: true;
}

export type TargetTransactionSignal = TargetTransactionWire | BlockRazorPrivateTransactionWire;

/**
 * In-memory contract between a pre-inclusion source adapter and the execution
 * planner. It is deliberately independent from MonitorEvent: no database or UI
 * serialization is allowed before this message reaches the planner.
 */
export interface TargetSignal {
  version: typeof EXECUTION_SIGNAL_VERSION;
  source: TargetSignalSource;
  sourceSequence: string;
  firstSeenUnixNs: string;
  firstSeenMonoNs: string;
  strategy: TargetStrategy;
  transaction: TargetTransactionSignal;
  /**
   * Same-sender contiguous nonce transactions required before the swap. The
   * audited kuzuo flow uses one nonce-1 plain Builder-tip transfer.
   */
  requiredPredecessors?: TargetTransactionWire[];
  sourceBlockHint?: number;
  blockRazorPrivateBundle?: BlockRazorPrivateBundleContext;
}

/** Small loopback envelope emitted directly by the strict Router-log monitor. */
export interface ConfirmedTargetHint {
  version: 1;
  strategy: TargetStrategy;
  txHash: HexString;
  payer: string;
  blockNumber: number;
  blockHash: HexString;
  logIndex: number;
  observedUnixNs: string;
}

export interface ValidatedTargetSignal extends TargetSignal {
  rawTransactionVerified: boolean;
  predecessorsVerified: boolean;
}

const SOURCE_VERIFIED_SIGNAL = Symbol("vigil.source-verified-target-signal");

/**
 * Runtime brand for adapters that already performed their source-specific
 * validation: signed-raw recovery for raw feeds, or strict disclosed-field
 * validation for BlockRazor Private. Plain JSON cannot forge this symbol, so
 * external signals still take the full validateTargetSignal path in the engine.
 */
export type SourceVerifiedTargetSignal = ValidatedTargetSignal & {
  readonly [SOURCE_VERIFIED_SIGNAL]: true;
};

export function brandSourceVerifiedTargetSignal(signal: ValidatedTargetSignal): SourceVerifiedTargetSignal {
  Object.defineProperty(signal, SOURCE_VERIFIED_SIGNAL, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return signal as SourceVerifiedTargetSignal;
}

export function isSourceVerifiedTargetSignal(signal: TargetSignal): signal is SourceVerifiedTargetSignal {
  return (signal as Partial<SourceVerifiedTargetSignal>)[SOURCE_VERIFIED_SIGNAL] === true;
}

export interface ExecutionIntent {
  version: typeof EXECUTION_SIGNAL_VERSION;
  mode: ExecutionMode;
  targetHash: HexString;
  targetStrategy: TargetStrategy;
  source: TargetSignalSource;
  laneId: string;
  nonceStart: number;
  nonceSpan: 1 | 2;
  targetTokenAddress: string;
  calldata: HexString;
  valueWei: string;
  amountInWei: string;
  minReturn: string;
  validFromBlock: number;
  validUntilBlock: number;
  createdMonoNs: string;
}

export interface BuilderSubmissionCandidate {
  intent: ExecutionIntent;
  builder: "club48" | "blockrazor" | "jet" | "nodereal";
  targetDependency: { kind: "hash"; hash: HexString } | { kind: "raw"; rawTransaction: HexString };
  executorRawTransaction: HexString;
}

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SOURCES = new Set<TargetSignalSource>([
  "bsc_pending_full",
  "blockrazor_public_mempool",
  "blockrazor_private_mempool",
  "club48_auction",
  "blockrazor_orderflow",
  "jet_orderflow",
  "confirmed_log_fallback",
]);

function expectedTargetAddress(strategy: TargetStrategy): string {
  return strategy === "ed" ? ED_TARGET_ADDRESS : KUZUO_TARGET_ADDRESS;
}

function assertDecimal(value: string, field: string): void {
  if (!DECIMAL_PATTERN.test(value)) throw new Error(`${field} must be an unsigned decimal string`);
}

export function isBlockRazorPrivateTransaction(
  transaction: TargetTransactionSignal,
): transaction is BlockRazorPrivateTransactionWire {
  return "disclosure" in transaction && transaction.disclosure === "blockrazor_private";
}

/**
 * Rejects malformed or spoofed target envelopes before calldata planning. If a
 * source supplies the signed raw transaction, every duplicated field is checked
 * against the recovered transaction. Object-only feeds remain explicitly marked
 * unverified so live policy can require a trusted source.
 */
export function validateTargetSignal(signal: TargetSignal): ValidatedTargetSignal {
  if (signal.version !== EXECUTION_SIGNAL_VERSION) throw new Error("unsupported execution signal version");
  if (!SOURCES.has(signal.source)) throw new Error("unsupported target signal source");
  if (!DECIMAL_PATTERN.test(signal.firstSeenUnixNs) || !DECIMAL_PATTERN.test(signal.firstSeenMonoNs)) {
    throw new Error("first-seen timestamps must be unsigned nanosecond strings");
  }
  if (!signal.sourceSequence) throw new Error("sourceSequence is required");

  const transaction = signal.transaction;
  if (transaction.chainId !== BSC_CHAIN_ID) throw new Error("target transaction is not on BSC");
  if (!HASH_PATTERN.test(transaction.hash)) throw new Error("target transaction hash is invalid");
  if (!HEX_PATTERN.test(transaction.input) || transaction.input.length < 10) throw new Error("target calldata is invalid");
  if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0) throw new Error("target nonce is invalid");
  assertDecimal(transaction.valueWei, "valueWei");

  const from = getAddress(transaction.from);
  const expectedFrom = getAddress(expectedTargetAddress(signal.strategy));
  if (from !== expectedFrom) throw new Error(`signal strategy ${signal.strategy} does not match target sender`);
  const to = getAddress(transaction.to);

  if (isBlockRazorPrivateTransaction(transaction)) {
    if (signal.source !== "blockrazor_private_mempool") {
      throw new Error("private transaction disclosure has an incompatible source");
    }
    if (transaction.functionSelector.toLowerCase() !== transaction.input.slice(0, 10).toLowerCase()) {
      throw new Error("private transaction functionSelector does not match calldata");
    }
    if (!Number.isSafeInteger(transaction.logCount) || transaction.logCount < 0) {
      throw new Error("private transaction logCount is invalid");
    }
    const context = signal.blockRazorPrivateBundle;
    if (!context || !HASH_PATTERN.test(context.bundleHash)) {
      throw new Error("private target requires a valid BlockRazor bundle hash");
    }
    if (!Number.isSafeInteger(context.nextBlockNumber) || context.nextBlockNumber <= 0
      || !Number.isSafeInteger(context.maxBlockNumber) || context.maxBlockNumber < context.nextBlockNumber) {
      throw new Error("private target block window is invalid");
    }
    if (!(["tokyo", "new-york", "frankfurt", "dublin"] as string[]).includes(context.region)) {
      throw new Error("private target region is invalid");
    }
    const proxyBidContract = getAddress(context.proxyBidContract);
    const refundAddress = getAddress(context.refundAddress);
    if (proxyBidContract === "0x0000000000000000000000000000000000000000"
      || refundAddress === "0x0000000000000000000000000000000000000000") {
      throw new Error("private target proxy/refund address must not be zero");
    }
    assertDecimal(context.refundCfg, "privateBundle.refundCfg");
    if (!Number.isSafeInteger(context.targetIndex) || context.targetIndex < 0
      || !Number.isSafeInteger(context.transactionCount) || context.transactionCount < 1
      || context.targetIndex >= context.transactionCount || context.logsVerified !== true
      || context.routerSwapVerified !== true) {
      throw new Error("private target bundle position/log validation is invalid");
    }
    if (signal.requiredPredecessors?.length) {
      throw new Error("private bundle dependency must not be represented as raw predecessors");
    }
    return { ...signal, rawTransactionVerified: false, predecessorsVerified: true };
  }

  if (transaction.type !== 0) throw new Error("only the audited legacy target transaction shape is allowed");
  assertDecimal(transaction.gasPriceWei, "gasPriceWei");
  assertDecimal(transaction.gasLimit, "gasLimit");
  if (signal.blockRazorPrivateBundle !== undefined) {
    throw new Error("raw target signal must not carry private bundle metadata");
  }

  let rawTransactionVerified = false;
  if (transaction.rawTransaction !== undefined) {
    if (!HEX_PATTERN.test(transaction.rawTransaction)) throw new Error("raw target transaction is invalid");
    const recovered = Transaction.from(transaction.rawTransaction);
    if (!recovered.isSigned() || !recovered.hash || !recovered.from || !recovered.to) {
      throw new Error("raw target transaction is not fully signed");
    }
    const mismatched = recovered.hash.toLowerCase() !== transaction.hash.toLowerCase()
      || getAddress(recovered.from) !== from
      || getAddress(recovered.to) !== to
      || recovered.chainId !== BigInt(transaction.chainId)
      || recovered.type !== transaction.type
      || recovered.nonce !== transaction.nonce
      || recovered.gasPrice !== BigInt(transaction.gasPriceWei)
      || recovered.gasLimit !== BigInt(transaction.gasLimit)
      || recovered.value !== BigInt(transaction.valueWei)
      || recovered.data.toLowerCase() !== transaction.input.toLowerCase();
    if (mismatched) throw new Error("raw target transaction does not match its signal envelope");
    rawTransactionVerified = true;
  }

  const predecessors = signal.requiredPredecessors ?? [];
  if (predecessors.length > 1) throw new Error("at most one audited target predecessor is allowed");
  let predecessorsVerified = predecessors.length === 0;
  if (predecessors.length === 1) {
    const predecessor = predecessors[0]!;
    if (predecessor.chainId !== BSC_CHAIN_ID || predecessor.type !== 0) {
      throw new Error("target predecessor is not an audited BSC legacy transaction");
    }
    if (!HASH_PATTERN.test(predecessor.hash) || !Number.isSafeInteger(predecessor.nonce) || predecessor.nonce < 0) {
      throw new Error("target predecessor envelope is invalid");
    }
    assertDecimal(predecessor.gasPriceWei, "predecessor.gasPriceWei");
    assertDecimal(predecessor.gasLimit, "predecessor.gasLimit");
    assertDecimal(predecessor.valueWei, "predecessor.valueWei");
    if (predecessor.from.toLowerCase() !== transaction.from.toLowerCase()) {
      throw new Error("target predecessor sender does not match");
    }
    if (predecessor.nonce + 1 !== transaction.nonce) {
      throw new Error("target predecessor nonce is not contiguous");
    }
    if (predecessor.input !== "0x" || predecessor.gasLimit !== "21000") {
      throw new Error("target predecessor is not an audited plain Builder tip");
    }
    if (!KNOWN_BUILDER_TIP_RECIPIENTS.has(predecessor.to.toLowerCase()) || BigInt(predecessor.valueWei) <= 0n) {
      throw new Error("target predecessor does not pay a known Builder");
    }
    if (!predecessor.rawTransaction || !HEX_PATTERN.test(predecessor.rawTransaction)) {
      throw new Error("target predecessor raw transaction is required");
    }
    const recovered = Transaction.from(predecessor.rawTransaction);
    const mismatch = !recovered.isSigned() || !recovered.hash || !recovered.from || !recovered.to
      || recovered.hash.toLowerCase() !== predecessor.hash.toLowerCase()
      || getAddress(recovered.from) !== getAddress(predecessor.from)
      || getAddress(recovered.to) !== getAddress(predecessor.to)
      || recovered.chainId !== BigInt(predecessor.chainId)
      || recovered.type !== predecessor.type
      || recovered.nonce !== predecessor.nonce
      || recovered.gasPrice !== BigInt(predecessor.gasPriceWei)
      || recovered.gasLimit !== BigInt(predecessor.gasLimit)
      || recovered.value !== BigInt(predecessor.valueWei)
      || recovered.data !== predecessor.input;
    if (mismatch) throw new Error("raw target predecessor does not match its envelope");
    predecessorsVerified = true;
  }

  return { ...signal, rawTransactionVerified, predecessorsVerified };
}
