import { Interface, getAddress } from "ethers";
import { GMGN_ROUTER_ADDRESS } from "./core/gmgn-calldata.js";
import { BSC_CHAIN_ID as BSC_SIGNAL_CHAIN_ID, type HexString, type TargetTransactionWire } from "./core/messages.js";
import { assertAuditedAtomicExecutorRuntime } from "./executor-capability.js";

const BSC_CHAIN_ID = 56n;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const EXECUTOR_VIEW = new Interface([
  "function owner() view returns (address)",
  "function router() view returns (address)",
  "function BLOCKRAZOR_PROXY_BID_SELECTOR() view returns (bytes4)",
]);
const ERC20_VIEW = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: unknown };
}

function rpcMethodCategory(method: string): string {
  switch (method) {
    case "eth_chainId": return "chain";
    case "eth_getTransactionCount": return "nonce";
    case "eth_getBalance": return "balance";
    case "eth_blockNumber": return "block";
    case "eth_getTransactionReceipt": return "receipt";
    case "eth_getTransactionByHash": return "transaction";
    case "eth_getCode": return "code";
    case "eth_call": return "view";
    default: return "request";
  }
}

function rpcErrorCode(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}

export interface RpcReceipt {
  transactionHash: HexString;
  blockHash: HexString;
  blockNumber: number;
  transactionIndex: number;
  status: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export interface RpcMinedTargetTransaction {
  transaction: TargetTransactionWire;
  blockNumber: number;
  blockHash: HexString;
}

function quantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(field + " is not an RPC quantity");
  }
  return BigInt(value);
}

function safeNumber(value: bigint, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(field + " is outside the safe integer range");
  return parsed;
}

function rpcHash(value: unknown, field: string): HexString {
  if (typeof value !== "string" || !HASH_RE.test(value)) throw new Error(field + " is not a 32-byte hash");
  return value.toLowerCase() as HexString;
}

export class ExecutorRpcClient {
  private id = 1;

  constructor(
    private readonly url: string,
    private readonly timeoutMs = 1_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (new URL(url).protocol !== "https:") throw new Error("executor RPC must use HTTPS");
  }

  async request(method: string, params: unknown[], timeoutMs = this.timeoutMs): Promise<unknown> {
    const category = rpcMethodCategory(method);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params }),
          signal: controller.signal,
        });
      } catch {
        throw new Error(`RPC ${category} ${controller.signal.aborted ? "timed out" : "transport failed"}`);
      }
      if (!response.ok) throw new Error(`RPC ${category} HTTP ${String(response.status)}`);
      let body: JsonRpcResponse;
      try {
        const parsed = await response.json() as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("invalid envelope");
        }
        body = parsed as JsonRpcResponse;
      } catch {
        throw new Error(`RPC ${category} returned invalid JSON`);
      }
      if (body.error) {
        const code = rpcErrorCode(body.error.code);
        throw new Error(`RPC ${category} JSON-RPC error${code ? ` (${code})` : ""}`);
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async nonce(address: string, blockTag: "latest" | "pending"): Promise<number> {
    return safeNumber(
      quantity(
        await this.request("eth_getTransactionCount", [getAddress(address), blockTag]),
        `${blockTag} nonce`,
      ),
      `${blockTag} nonce`,
    );
  }

  async latestNonce(address: string): Promise<number> {
    return this.nonce(address, "latest");
  }

  async pendingNonce(address: string): Promise<number> {
    return this.nonce(address, "pending");
  }

  async balance(address: string): Promise<bigint> {
    return quantity(await this.request("eth_getBalance", [getAddress(address), "latest"]), "balance");
  }

  async tokenBalance(token: string, owner: string): Promise<bigint> {
    const result = await this.request("eth_call", [{
      to: getAddress(token),
      data: ERC20_VIEW.encodeFunctionData("balanceOf", [getAddress(owner)]),
    }, "latest"]);
    if (typeof result !== "string") throw new Error("token balance view returned invalid data");
    const decoded = ERC20_VIEW.decodeFunctionResult("balanceOf", result)[0];
    if (typeof decoded !== "bigint" || decoded < 0n) throw new Error("token balance view is invalid");
    return decoded;
  }

  async tokenMetadata(token: string): Promise<{ symbol: string | null; decimals: number | null }> {
    const address = getAddress(token);
    const [symbolResult, decimalsResult] = await Promise.allSettled([
      this.request("eth_call", [{ to: address, data: ERC20_VIEW.encodeFunctionData("symbol") }, "latest"]),
      this.request("eth_call", [{ to: address, data: ERC20_VIEW.encodeFunctionData("decimals") }, "latest"]),
    ]);
    let symbol: string | null = null;
    let decimals: number | null = null;
    if (symbolResult.status === "fulfilled" && typeof symbolResult.value === "string") {
      try {
        const value = ERC20_VIEW.decodeFunctionResult("symbol", symbolResult.value)[0];
        if (typeof value === "string" && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)) {
          symbol = value;
        }
      } catch { /* optional metadata */ }
    }
    if (decimalsResult.status === "fulfilled" && typeof decimalsResult.value === "string") {
      try {
        const value = ERC20_VIEW.decodeFunctionResult("decimals", decimalsResult.value)[0];
        if (typeof value === "bigint" && value >= 0n && value <= 255n) decimals = Number(value);
      } catch { /* optional metadata */ }
    }
    return { symbol, decimals };
  }

  async blockNumber(): Promise<number> {
    return safeNumber(quantity(await this.request("eth_blockNumber", []), "blockNumber"), "blockNumber");
  }

  async assertBscChain(): Promise<void> {
    const chainId = quantity(await this.request("eth_chainId", []), "chainId");
    if (chainId !== BSC_CHAIN_ID) throw new Error("executor RPC is not BSC chainId 56");
  }

  async receipt(hash: string): Promise<RpcReceipt | null> {
    const requestedHash = hash.toLowerCase();
    if (!HASH_RE.test(requestedHash)) throw new Error("receipt request hash is not a 32-byte hash");
    const raw = await this.request("eth_getTransactionReceipt", [requestedHash]);
    if (raw === null) return null;
    if (!raw || typeof raw !== "object") throw new Error("receipt is malformed");
    const receipt = raw as Record<string, unknown>;
    const transactionHash = rpcHash(receipt.transactionHash, "receipt.transactionHash");
    if (transactionHash !== requestedHash) throw new Error("receipt transactionHash does not match the request");
    return {
      transactionHash,
      blockHash: rpcHash(receipt.blockHash, "receipt.blockHash"),
      blockNumber: safeNumber(quantity(receipt.blockNumber, "receipt.blockNumber"), "receipt.blockNumber"),
      transactionIndex: safeNumber(quantity(receipt.transactionIndex, "receipt.transactionIndex"), "receipt.transactionIndex"),
      status: safeNumber(quantity(receipt.status, "receipt.status"), "receipt.status"),
      gasUsed: quantity(receipt.gasUsed, "receipt.gasUsed"),
      effectiveGasPrice: quantity(receipt.effectiveGasPrice, "receipt.effectiveGasPrice"),
    };
  }

  async transactionValue(hash: string): Promise<bigint | null> {
    const raw = await this.request("eth_getTransactionByHash", [hash]);
    if (raw === null) return null;
    if (!raw || typeof raw !== "object") throw new Error("transaction is malformed");
    const transaction = raw as Record<string, unknown>;
    if (typeof transaction.hash !== "string" || transaction.hash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error("transaction hash does not match the request");
    }
    return quantity(transaction.value, "transaction.value");
  }

  /**
   * Hydrates one already-mined legacy transaction after a strict Router log.
   * It intentionally performs no receipt/metadata/quote reads.
   */
  async minedTargetTransaction(hash: string, timeoutMs = 180): Promise<RpcMinedTargetTransaction | null> {
    const requestedHash = hash.toLowerCase();
    if (!HASH_RE.test(requestedHash)) throw new Error("transaction request hash is not a 32-byte hash");
    const raw = await this.request("eth_getTransactionByHash", [requestedHash], timeoutMs);
    if (raw === null) return null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("transaction is malformed");
    const value = raw as Record<string, unknown>;
    const transactionHash = rpcHash(value.hash, "transaction.hash");
    if (transactionHash !== requestedHash) throw new Error("transaction hash does not match the request");
    const from = typeof value.from === "string" ? getAddress(value.from) : null;
    const to = typeof value.to === "string" ? getAddress(value.to) : null;
    const input = typeof value.input === "string" ? value.input : value.data;
    if (!from || !to || typeof input !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input)) {
      throw new Error("transaction sender, recipient, or calldata is malformed");
    }
    const chainId = safeNumber(quantity(value.chainId, "transaction.chainId"), "transaction.chainId");
    const type = safeNumber(quantity(value.type, "transaction.type"), "transaction.type");
    if (chainId !== BSC_SIGNAL_CHAIN_ID || type !== 0) {
      throw new Error("transaction is not an audited BSC legacy transaction");
    }
    return {
      transaction: {
        hash: transactionHash,
        chainId: BSC_SIGNAL_CHAIN_ID,
        type: 0,
        from,
        to,
        nonce: safeNumber(quantity(value.nonce, "transaction.nonce"), "transaction.nonce"),
        gasPriceWei: quantity(value.gasPrice, "transaction.gasPrice").toString(),
        gasLimit: quantity(value.gas, "transaction.gas").toString(),
        valueWei: quantity(value.value, "transaction.value").toString(),
        input: input.toLowerCase() as HexString,
      },
      blockNumber: safeNumber(quantity(value.blockNumber, "transaction.blockNumber"), "transaction.blockNumber"),
      blockHash: rpcHash(value.blockHash, "transaction.blockHash"),
    };
  }

  async assertAtomicExecutor(address: string, expectedOwner: string): Promise<void> {
    const executor = getAddress(address);
    await this.assertBscChain();
    const blockTagRaw = await this.request("eth_blockNumber", []);
    quantity(blockTagRaw, "executor preflight blockNumber");
    if (typeof blockTagRaw !== "string") throw new Error("executor preflight blockNumber is malformed");
    const blockTag = blockTagRaw.toLowerCase();
    const [code, ownerRaw, routerRaw, proxyBidSelectorRaw] = await Promise.all([
      this.request("eth_getCode", [executor, blockTag]),
      this.request("eth_call", [{ to: executor, data: EXECUTOR_VIEW.encodeFunctionData("owner") }, blockTag]),
      this.request("eth_call", [{ to: executor, data: EXECUTOR_VIEW.encodeFunctionData("router") }, blockTag]),
      this.request("eth_call", [{ to: executor, data: EXECUTOR_VIEW.encodeFunctionData("BLOCKRAZOR_PROXY_BID_SELECTOR") }, blockTag]),
    ]);
    if (typeof code !== "string" || code === "0x") throw new Error("configured atomic executor has no bytecode");
    assertAuditedAtomicExecutorRuntime(code, expectedOwner, GMGN_ROUTER_ADDRESS);
    if (typeof ownerRaw !== "string" || typeof routerRaw !== "string" || typeof proxyBidSelectorRaw !== "string") {
      throw new Error("atomic executor view call failed");
    }
    const owner = EXECUTOR_VIEW.decodeFunctionResult("owner", ownerRaw)[0] as string;
    const router = EXECUTOR_VIEW.decodeFunctionResult("router", routerRaw)[0] as string;
    const proxyBidSelector = EXECUTOR_VIEW.decodeFunctionResult(
      "BLOCKRAZOR_PROXY_BID_SELECTOR",
      proxyBidSelectorRaw,
    )[0] as string;
    if (getAddress(owner) !== getAddress(expectedOwner)) throw new Error("atomic executor owner does not match signer");
    if (getAddress(router) !== getAddress(GMGN_ROUTER_ADDRESS)) throw new Error("atomic executor router is not the audited GMGN router");
    if (proxyBidSelector.toLowerCase() !== "0xbd69ffca") {
      throw new Error("atomic executor proxyBid selector capability is invalid");
    }
  }
}
