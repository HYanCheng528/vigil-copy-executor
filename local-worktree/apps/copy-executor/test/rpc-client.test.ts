import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { GMGN_ROUTER_ADDRESS } from "../src/core/gmgn-calldata.js";
import {
  ATOMIC_EXECUTOR_IMMUTABLE_REFERENCES,
  expectedAtomicExecutorRuntime,
} from "../src/executor-capability.js";
import { ExecutorRpcClient } from "../src/rpc-client.js";

const VIEW = new Interface([
  "function owner() view returns (address)",
  "function router() view returns (address)",
  "function BLOCKRAZOR_PROXY_BID_SELECTOR() view returns (bytes4)",
]);
const OWNER = "0x0000000000000000000000000000000000009001";
const EXECUTOR = "0x0000000000000000000000000000000000001001";
const PINNED_BLOCK = "0x6d0";
const RECEIPT_HASH = `0x${"11".repeat(32)}`;
const RECEIPT_BLOCK_HASH = `0x${"22".repeat(32)}`;

interface CapturedRequest {
  id: number;
  method: string;
  params: unknown[];
}

function mutateByte(code: string, byteIndex: number): string {
  const offset = 2 + (byteIndex * 2);
  const current = code.slice(offset, offset + 2);
  return code.slice(0, offset) + (current === "00" ? "01" : "00") + code.slice(offset + 2);
}

function rpcFetch(options: {
  code?: string;
  chainId?: string;
  requests?: CapturedRequest[];
} = {}): typeof fetch {
  const code = options.code ?? expectedAtomicExecutorRuntime(OWNER, GMGN_ROUTER_ADDRESS);
  return (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as CapturedRequest;
    options.requests?.push(request);
    let result: string;
    if (request.method === "eth_chainId") {
      result = options.chainId ?? "0x38";
    } else if (request.method === "eth_blockNumber") {
      result = PINNED_BLOCK;
    } else if (request.method === "eth_getCode") {
      result = code;
    } else if (request.method === "eth_call") {
      const data = (request.params[0] as { data: string }).data.toLowerCase();
      if (data === VIEW.getFunction("owner")!.selector) {
        result = VIEW.encodeFunctionResult("owner", [OWNER]);
      } else if (data === VIEW.getFunction("router")!.selector) {
        result = VIEW.encodeFunctionResult("router", [GMGN_ROUTER_ADDRESS]);
      } else if (data === VIEW.getFunction("BLOCKRAZOR_PROXY_BID_SELECTOR")!.selector) {
        result = VIEW.encodeFunctionResult("BLOCKRAZOR_PROXY_BID_SELECTOR", ["0xbd69ffca"]);
      } else {
        throw new Error("unexpected test eth_call selector");
      }
    } else {
      throw new Error("unexpected test RPC method");
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function receiptFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  return (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as CapturedRequest;
    assert.equal(request.method, "eth_getTransactionReceipt");
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        transactionHash: RECEIPT_HASH,
        blockHash: RECEIPT_BLOCK_HASH,
        blockNumber: "0x123",
        transactionIndex: "0x2",
        status: "0x1",
        gasUsed: "0x5208",
        effectiveGasPrice: "0x3b9aca00",
        ...overrides,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "expected an Error rejection");
  return caught.message;
}

function assertNotVisibleOnErrorSurfaces(message: string, secrets: string[]): void {
  const visibleSurfaces = {
    error: message,
    telemetry: JSON.stringify({ type: "rpc_failed", reason: message }),
    status: JSON.stringify({ lanes: { ed: { lastError: message } } }),
    journal: JSON.stringify({ type: "executor_start_failed", error: message }),
  };
  for (const [surface, text] of Object.entries(visibleSurfaces)) {
    for (const secret of secrets) {
      assert.equal(text.includes(secret), false, `${surface} reflected provider-controlled data`);
    }
  }
}

test("Executor preflight proves BSC and exact owner/router runtime at one pinned block", async () => {
  const requests: CapturedRequest[] = [];
  const client = new ExecutorRpcClient("https://rpc.example/", 1_000, rpcFetch({ requests }));
  await assert.doesNotReject(client.assertAtomicExecutor(EXECUTOR, OWNER));
  assert.deepEqual(requests.slice(0, 2).map(({ method }) => method), ["eth_chainId", "eth_blockNumber"]);
  const pinned = requests.filter(({ method }) => method === "eth_getCode" || method === "eth_call");
  assert.equal(pinned.length, 4);
  for (const request of pinned) assert.equal(request.params.at(-1), PINNED_BLOCK);
});

test("Executor preflight rejects the wrong chain before reading code", async () => {
  const requests: CapturedRequest[] = [];
  const client = new ExecutorRpcClient("https://rpc.example/", 1_000, rpcFetch({ chainId: "0x1", requests }));
  await assert.rejects(client.assertAtomicExecutor(EXECUTOR, OWNER), /not BSC chainId 56/);
  assert.deepEqual(requests.map(({ method }) => method), ["eth_chainId"]);
});

test("one inconsistent duplicate immutable fails even when all mocked views are correct", async () => {
  const runtime = expectedAtomicExecutorRuntime(OWNER, GMGN_ROUTER_ADDRESS);
  const mutated = mutateByte(runtime, ATOMIC_EXECUTOR_IMMUTABLE_REFERENCES.owner[1]!.start);
  const client = new ExecutorRpcClient("https://rpc.example/", 1_000, rpcFetch({ code: mutated }));
  await assert.rejects(client.assertAtomicExecutor(EXECUTOR, OWNER), /exactly match/);
});

test("receipt parsing binds transactionHash and requires a canonical blockHash", async () => {
  const valid = new ExecutorRpcClient("https://rpc.example/", 1_000, receiptFetch());
  const receipt = await valid.receipt(RECEIPT_HASH.toUpperCase().replace("0X", "0x"));
  assert.equal(receipt?.transactionHash, RECEIPT_HASH);
  assert.equal(receipt?.blockHash, RECEIPT_BLOCK_HASH);

  const wrongHash = new ExecutorRpcClient("https://rpc.example/", 1_000, receiptFetch({
    transactionHash: `0x${"33".repeat(32)}`,
  }));
  await assert.rejects(wrongHash.receipt(RECEIPT_HASH), /does not match the request/);

  const missingBlockHash = new ExecutorRpcClient("https://rpc.example/", 1_000, receiptFetch({ blockHash: null }));
  await assert.rejects(missingBlockHash.receipt(RECEIPT_HASH), /blockHash is not a 32-byte hash/);
});

test("confirmed-log hydration binds a mined BSC legacy envelope without a receipt read", async () => {
  const methods: string[] = [];
  const fetchImpl = (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as CapturedRequest;
    methods.push(request.method);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        hash: RECEIPT_HASH,
        blockHash: RECEIPT_BLOCK_HASH,
        blockNumber: "0x123",
        chainId: "0x38",
        type: "0x0",
        from: OWNER,
        to: GMGN_ROUTER_ADDRESS,
        nonce: "0x7",
        gas: "0x100000",
        gasPrice: "0x3b9aca00",
        value: "0x1",
        input: "0x4d819a2a",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new ExecutorRpcClient("https://rpc.example/", 1_000, fetchImpl);
  const hydrated = await client.minedTargetTransaction(RECEIPT_HASH);
  assert.equal(hydrated?.blockNumber, 0x123);
  assert.equal(hydrated?.blockHash, RECEIPT_BLOCK_HASH);
  assert.equal(hydrated?.transaction.from, OWNER);
  assert.equal(hydrated?.transaction.rawTransaction, undefined);
  assert.deepEqual(methods, ["eth_getTransactionByHash"]);
});

test("RPC failures expose only local method categories and controlled numeric codes", async () => {
  const token = "provider-token-must-not-leak";
  const raw = `0x${"de".repeat(96)}`;
  const url = `https://rpc.example/private/${token}`;
  const providerText = `upstream echoed ${url} ${token} ${raw}`;
  const secrets = [url, token, raw, providerText];

  const jsonRpcClient = new ExecutorRpcClient(url, 1_000, (async () => new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32_000, message: providerText, data: { raw, url } },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch);
  const jsonRpcMessage = await rejectionMessage(jsonRpcClient.receipt(RECEIPT_HASH));
  assert.equal(jsonRpcMessage, "RPC receipt JSON-RPC error (-32000)");
  assertNotVisibleOnErrorSurfaces(jsonRpcMessage, secrets);

  const httpClient = new ExecutorRpcClient(url, 1_000, (async () => new Response(providerText, {
    status: 503,
    headers: { "content-type": "text/plain" },
  })) as typeof fetch);
  const httpMessage = await rejectionMessage(httpClient.assertBscChain());
  assert.equal(httpMessage, "RPC chain HTTP 503");
  assertNotVisibleOnErrorSurfaces(httpMessage, secrets);

  const transportClient = new ExecutorRpcClient(url, 1_000, (async () => {
    throw new Error(providerText);
  }) as typeof fetch);
  const transportMessage = await rejectionMessage(transportClient.assertBscChain());
  assert.equal(transportMessage, "RPC chain transport failed");
  assertNotVisibleOnErrorSurfaces(transportMessage, secrets);
});
