import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Interface, Transaction, ZeroAddress, ZeroHash, parseEther, parseUnits } from "ethers";
import {
  BuilderClient,
  DEFAULT_BUILDERS,
  type BuilderChannelRequest,
  type BuilderChannelResponse,
  type BuilderChannelTransport,
} from "../src/builders.js";
import {
  BLOCKRAZOR_ONEOFF_AMOUNT_WEI,
  BLOCKRAZOR_ONEOFF_CONFIRMATION,
  BLOCKRAZOR_ONEOFF_EXPECTED_TOKEN,
  readOneOffState,
  runBlockRazorOneOff,
  type BlockRazorOneOffOptions,
  type BlockRazorOneOffRpc,
} from "../src/blockrazor-oneoff.js";
import { BSC_WBNB_ADDRESS, GMGN_ROUTER_ADDRESS } from "../src/core/gmgn-calldata.js";
import {
  ED_TARGET_ADDRESS,
  type HexString,
  type TargetTransactionWire,
} from "../src/core/messages.js";
import { HotSigner } from "../src/hot-signer.js";
import type { RpcMinedTargetTransaction, RpcReceipt } from "../src/rpc-client.js";

const SWAP = new Interface([
  "function swap((uint8 swapType,address tokenIn,address tokenOut,address poolAddress,uint24 fee,int24 tickSpacing,address hooks,bytes hookData,address poolManager,bytes32 parameters)[] descs,address feeToken,uint256 amountIn,uint256 minReturn,uint256 userFeeRate) payable",
]);
const TOKEN = BLOCKRAZOR_ONEOFF_EXPECTED_TOKEN;
const POOL = "0x2222222222222222222222222222222222222222";
const TARGET_HASH = `0x${"31".repeat(32)}` as HexString;
const TARGET_BLOCK_HASH = `0x${"32".repeat(32)}` as HexString;
const INCLUDED_BLOCK_HASH = `0x${"33".repeat(32)}` as HexString;
const TARGET_AMOUNT = parseEther("0.25");
const TIP = parseEther("0.0001");
const GAS_PRICE = parseUnits("0.1", "gwei");
const GAS_LIMIT = 1_750_000n;
const COPY_NONCE = 17;

function targetInput(): HexString {
  return SWAP.encodeFunctionData("swap", [[
    [0, BSC_WBNB_ADDRESS, TOKEN, POOL, 2_500, 50, ZeroAddress, "0x", ZeroAddress, ZeroHash],
  ], ZeroAddress, TARGET_AMOUNT, 123n, 999n]) as HexString;
}

function targetTransaction(): TargetTransactionWire {
  return {
    hash: TARGET_HASH,
    chainId: 56,
    type: 0,
    from: ED_TARGET_ADDRESS,
    to: GMGN_ROUTER_ADDRESS,
    nonce: 900,
    gasPriceWei: parseUnits("1", "gwei").toString(),
    gasLimit: "500000",
    valueWei: TARGET_AMOUNT.toString(),
    input: targetInput(),
  };
}

function receipt(hash: HexString, index: number): RpcReceipt {
  return {
    transactionHash: hash,
    blockHash: INCLUDED_BLOCK_HASH,
    blockNumber: 101,
    transactionIndex: index,
    status: 1,
    gasUsed: index === 2 ? 125_000n : 21_000n,
    effectiveGasPrice: GAS_PRICE,
  };
}

class FakeRpc implements BlockRazorOneOffRpc {
  head = 100;
  latest = COPY_NONCE;
  pending = COPY_NONCE;
  readonly requests: Array<{ method: string; params: unknown[] }> = [];
  readonly receipts = new Map<string, RpcReceipt>();
  readonly receiptRequests: string[] = [];
  readonly target: RpcMinedTargetTransaction = {
    transaction: targetTransaction(),
    blockNumber: 90,
    blockHash: TARGET_BLOCK_HASH,
  };

  constructor() {
    this.receipts.set(TARGET_HASH, {
      transactionHash: TARGET_HASH,
      blockHash: TARGET_BLOCK_HASH,
      blockNumber: 90,
      transactionIndex: 1,
      status: 1,
      gasUsed: 100_000n,
      effectiveGasPrice: parseUnits("1", "gwei"),
    });
  }

  async assertBscChain(): Promise<void> {}
  async minedTargetTransaction(hash: string): Promise<RpcMinedTargetTransaction | null> {
    return hash.toLowerCase() === TARGET_HASH ? this.target : null;
  }
  async latestNonce(): Promise<number> { return this.latest; }
  async pendingNonce(): Promise<number> { return this.pending; }
  async balance(): Promise<bigint> { return parseEther("1"); }
  async blockNumber(): Promise<number> { return this.head; }
  async receipt(hash: string): Promise<RpcReceipt | null> {
    this.receiptRequests.push(hash.toLowerCase());
    return this.receipts.get(hash.toLowerCase()) ?? null;
  }
  async request(method: string, params: unknown[]): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "eth_call") return "0x";
    if (method === "eth_estimateGas") return "0x1e848"; // 125,000
    throw new Error("unexpected fake RPC method");
  }
}

interface RecordingBuilder {
  builder: BuilderClient;
  dispatches: BuilderChannelRequest[];
  warmups: BuilderChannelRequest[];
}

function recordingBuilder(
  dispatchStatuses: number[] = [200],
  beforeFirstDispatch?: () => void,
): RecordingBuilder {
  const dispatches: BuilderChannelRequest[] = [];
  const warmups: BuilderChannelRequest[] = [];
  let dispatchIndex = 0;
  class Transport implements BuilderChannelTransport {
    async request(value: BuilderChannelRequest): Promise<BuilderChannelResponse> {
      const envelope = JSON.parse(value.body) as { method: string; params?: Array<{ txs?: unknown[] }> };
      const txs = envelope.params?.[0]?.txs;
      if (envelope.method === "eth_sendBundle" && Array.isArray(txs) && txs.length === 0) {
        warmups.push(value);
        return {
          status: 200,
          body: JSON.stringify({ jsonrpc: "2.0", id: "warm", error: { code: -38_000, message: "missing txs required" } }),
        };
      }
      if (dispatchIndex === 0) beforeFirstDispatch?.();
      dispatches.push(value);
      const status = dispatchStatuses[Math.min(dispatchIndex++, dispatchStatuses.length - 1)]!;
      return status === 200
        ? { status, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"44".repeat(32)}` }) }
        : { status, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32_000 } }) };
    }
    close(): void {}
  }
  return {
    builder: new BuilderClient({
      ...DEFAULT_BUILDERS.blockrazor,
      authorization: "Bearer test-only",
      requestTimeoutMs: 100,
    }, () => new Transport()),
    dispatches,
    warmups,
  };
}

function options(
  rpc: FakeRpc,
  builder: BuilderClient,
  stateFile: string | null,
  preflightOnly: boolean,
): BlockRazorOneOffOptions {
  const signer = new HotSigner(`0x${"51".repeat(32)}`);
  return {
    confirmation: BLOCKRAZOR_ONEOFF_CONFIRMATION,
    strategy: "ed",
    targetHash: TARGET_HASH,
    amountWei: BLOCKRAZOR_ONEOFF_AMOUNT_WEI,
    tipWei: TIP,
    expectedToken: BLOCKRAZOR_ONEOFF_EXPECTED_TOKEN,
    expectedSigner: signer.address,
    gasPriceWei: GAS_PRICE,
    gasLimit: GAS_LIMIT,
    preflightOnly,
    stateFile,
    signer,
    rpc,
    builder,
    now: () => new Date("2026-08-09T12:00:00.000Z"),
    waitForBlock: async (minimum) => {
      rpc.head = minimum;
      return minimum;
    },
  };
}

test("preflight-only validates both BlockRazor channels and never writes state or dispatches", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "blockrazor-oneoff-preflight-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "state.json");
  const rpc = new FakeRpc();
  const recording = recordingBuilder();

  const result = await runBlockRazorOneOff(options(rpc, recording.builder, stateFile, true));

  assert.equal(result.stage, "preflight");
  assert.equal(result.envelopeMaxBlock, 101);
  assert.equal(result.maximumCostWei,
    (BLOCKRAZOR_ONEOFF_AMOUNT_WEI + TIP + ((GAS_LIMIT + 21_000n) * GAS_PRICE)).toString());
  assert.equal(existsSync(stateFile), false);
  assert.equal(recording.warmups.length, 2);
  assert.equal(recording.dispatches.length, 0);
  assert.deepEqual(rpc.requests.map(({ method }) => method), ["eth_call", "eth_estimateGas"]);
});

test("broadcast writes the journal first and submits exactly buy N plus BlockRazor tip N+1", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "blockrazor-oneoff-success-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "state.json");
  const rpc = new FakeRpc();
  let inspectedFirstDispatch = false;
  const recording = recordingBuilder([200], () => {
    inspectedFirstDispatch = true;
    // Only the historical target's canonical receipt is read before the first
    // exposure. Querying guaranteed-null buy/tip receipts here can consume the
    // entire next-block envelope on a three-second chain.
    assert.deepEqual(rpc.receiptRequests, [TARGET_HASH]);
    assert.equal(existsSync(stateFile), true);
    if (process.platform !== "win32") assert.equal(lstatSync(stateFile).mode & 0o777, 0o600);
    const journal = readOneOffState(stateFile);
    assert.equal(journal.stage, "submitted");
    assert.equal(journal.dispatchAttempts, 1);
  });
  const input = options(rpc, recording.builder, stateFile, false);
  input.waitForBlock = async (minimum) => {
    const body = JSON.parse(recording.dispatches[0]!.body) as { params: Array<{ txs: HexString[] }> };
    const [buyRaw, tipRaw] = body.params[0]!.txs;
    const buy = Transaction.from(buyRaw!);
    const tip = Transaction.from(tipRaw!);
    rpc.receipts.set(buy.hash!.toLowerCase(), receipt(buy.hash!.toLowerCase() as HexString, 2));
    rpc.receipts.set(tip.hash!.toLowerCase(), receipt(tip.hash!.toLowerCase() as HexString, 3));
    rpc.head = minimum;
    return minimum;
  };

  const result = await runBlockRazorOneOff(input);

  assert.equal(result.stage, "included");
  assert.equal(inspectedFirstDispatch, true);
  assert.equal(recording.dispatches.length, 1);
  const request = recording.dispatches[0]!;
  assert.equal(request.headers.authorization, "Bearer test-only");
  const body = JSON.parse(request.body) as {
    method: string;
    params: Array<{ txs: HexString[]; maxBlockNumber: number; noMerge: boolean; positionFirst: boolean }>;
  };
  assert.equal(body.method, "eth_sendBundle");
  assert.equal(body.params[0]!.maxBlockNumber, 101);
  assert.equal(body.params[0]!.noMerge, true);
  assert.equal(body.params[0]!.positionFirst, false);
  assert.equal(body.params[0]!.txs.length, 2);
  const buy = Transaction.from(body.params[0]!.txs[0]!);
  const tip = Transaction.from(body.params[0]!.txs[1]!);
  assert.equal(buy.nonce, COPY_NONCE);
  assert.equal(buy.to, getAddressForAssertion(GMGN_ROUTER_ADDRESS));
  assert.equal(buy.value, BLOCKRAZOR_ONEOFF_AMOUNT_WEI);
  assert.equal(tip.nonce, COPY_NONCE + 1);
  assert.equal(tip.to, getAddressForAssertion(DEFAULT_BUILDERS.blockrazor.tipRecipient));
  assert.equal(tip.value, TIP);
  assert.equal(readOneOffState(stateFile).stage, "included");
});

test("ambiguous fixed envelope retries the identical body only before the same maxBlock", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "blockrazor-oneoff-retry-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "state.json");
  const rpc = new FakeRpc();
  const recording = recordingBuilder([500, 500]);

  const result = await runBlockRazorOneOff(options(rpc, recording.builder, stateFile, false));

  assert.equal(result.stage, "not_included");
  assert.equal(result.dispatchAttempts, 2);
  assert.equal(recording.dispatches.length, 2);
  assert.equal(recording.dispatches[0]!.body, recording.dispatches[1]!.body);
  const bodies = recording.dispatches.map(({ body }) => JSON.parse(body) as { params: Array<{ maxBlockNumber: number }> });
  assert.deepEqual(bodies.map((body) => body.params[0]!.maxBlockNumber), [101, 101]);
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as { envelopeMaxBlock: number; stage: string };
  assert.equal(state.envelopeMaxBlock, 101);
  assert.equal(state.stage, "not_included");
});

test("an ambiguous response never retries once the fixed envelope block is already the head", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "blockrazor-oneoff-cutoff-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "state.json");
  const rpc = new FakeRpc();
  const recording = recordingBuilder([500, 500], () => { rpc.head = 101; });

  const result = await runBlockRazorOneOff(options(rpc, recording.builder, stateFile, false));

  assert.equal(result.stage, "not_included");
  assert.equal(result.dispatchAttempts, 1);
  assert.equal(recording.dispatches.length, 1);
  const body = JSON.parse(recording.dispatches[0]!.body) as { params: Array<{ maxBlockNumber: number }> };
  assert.equal(body.params[0]!.maxBlockNumber, 101);
});

test("nonce disagreement fails before state creation or non-empty dispatch", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "blockrazor-oneoff-nonce-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "state.json");
  const rpc = new FakeRpc();
  rpc.pending = COPY_NONCE + 1;
  const recording = recordingBuilder();

  await assert.rejects(
    runBlockRazorOneOff(options(rpc, recording.builder, stateFile, false)),
    /latest nonce to equal pending nonce/,
  );
  assert.equal(existsSync(stateFile), false);
  assert.equal(recording.dispatches.length, 0);
});

test("confirmed token and frozen signer mismatches fail before state or dispatch", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "blockrazor-oneoff-identity-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "state.json");

  {
    const rpc = new FakeRpc();
    const recording = recordingBuilder();
    const input = options(rpc, recording.builder, stateFile, false);
    input.expectedToken = "0x1111111111111111111111111111111111111111";
    await assert.rejects(runBlockRazorOneOff(input), /expected token is not the user-confirmed AI contract/);
    assert.equal(existsSync(stateFile), false);
    assert.equal(recording.dispatches.length, 0);
  }

  {
    const rpc = new FakeRpc();
    const recording = recordingBuilder();
    const input = options(rpc, recording.builder, stateFile, false);
    input.expectedSigner = "0x2222222222222222222222222222222222222222";
    await assert.rejects(runBlockRazorOneOff(input), /does not match the frozen production lane identity/);
    assert.equal(existsSync(stateFile), false);
    assert.equal(recording.dispatches.length, 0);
  }
});

function getAddressForAssertion(value: string): string {
  return Transaction.from({ to: value }).to!;
}
