import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Interface } from "ethers";
import {
  DEPLOY_AUDITED_IMMUTABLE_REFERENCES,
  DEPLOY_AUDITED_RUNTIME_LENGTH,
  DEPLOY_AUDITED_RUNTIME_TEMPLATE_HASH,
  assertAuditedDeploymentRuntime,
  assertPlannedNonces,
  assertDistinctIdentities,
  maskAddress,
  parseDeployMode,
  partitionDeploymentOutcomes,
  publicDeploymentError,
  expectedDeploymentRuntime,
  verifyDeployment,
} from "../scripts/deploy-executors.mjs";
import {
  ATOMIC_EXECUTOR_IMMUTABLE_REFERENCES,
  ATOMIC_EXECUTOR_RUNTIME_LENGTH,
  ATOMIC_EXECUTOR_RUNTIME_TEMPLATE_HASH,
} from "../src/executor-capability.js";

const artifact = JSON.parse(readFileSync(
  new URL("../contracts/artifacts/GmgnAtomicCopyExecutor.json", import.meta.url),
  "utf8",
));
const VIEW = new Interface([
  "function owner() view returns (address)",
  "function router() view returns (address)",
  "function BLOCKRAZOR_PROXY_BID_SELECTOR() view returns (bytes4)",
]);

test("executor deployment is plan-only unless the exact broadcast gate is present", () => {
  assert.equal(parseDeployMode([], {}), "plan");
  assert.equal(parseDeployMode(["--plan"], {}), "plan");
  assert.throws(
    () => parseDeployMode(["--plan", "--broadcast"], {
      COPY_EXECUTOR_DEPLOY_CONFIRM: "I_ACCEPT_TWO_EXECUTOR_DEPLOYMENTS",
    }),
    /mutually exclusive/,
  );
  assert.throws(() => parseDeployMode(["--broadcast"], {}), /exact|requires|broadcast/i);
  assert.equal(parseDeployMode(["--broadcast"], {
    COPY_EXECUTOR_DEPLOY_CONFIRM: "I_ACCEPT_TWO_EXECUTOR_DEPLOYMENTS",
  }), "broadcast");
});

test("Ed and kuzuo deployment identities must be completely separate", () => {
  const ed = { keyPath: "/run/credentials/ed", owner: "0x0000000000000000000000000000000000000001" };
  const kuzuo = { keyPath: "/run/credentials/kuzuo", owner: "0x0000000000000000000000000000000000000002" };
  assert.doesNotThrow(() => assertDistinctIdentities(ed, kuzuo));
  assert.throws(() => assertDistinctIdentities(ed, { ...kuzuo, keyPath: ed.keyPath }), /different key files/);
  assert.throws(() => assertDistinctIdentities(ed, { ...kuzuo, owner: ed.owner }), /different owner wallets/);
});

test("deployment output masks addresses", () => {
  assert.equal(maskAddress("0x000000000000000000000000000000000000dEaD"), "0x000000…00dEaD");
});

test("deployment preflight and runtime capability identities stay identical", () => {
  const owner = "0x0000000000000000000000000000000000009001";
  assert.equal(DEPLOY_AUDITED_RUNTIME_LENGTH, ATOMIC_EXECUTOR_RUNTIME_LENGTH);
  assert.equal(DEPLOY_AUDITED_RUNTIME_TEMPLATE_HASH, ATOMIC_EXECUTOR_RUNTIME_TEMPLATE_HASH);
  assert.deepEqual(DEPLOY_AUDITED_IMMUTABLE_REFERENCES, ATOMIC_EXECUTOR_IMMUTABLE_REFERENCES);
  const runtime = expectedDeploymentRuntime(artifact, owner);
  assert.doesNotThrow(() => assertAuditedDeploymentRuntime(runtime, artifact, owner));
  const immutableByte = DEPLOY_AUDITED_IMMUTABLE_REFERENCES.owner[1].start;
  const offset = 2 + (immutableByte * 2);
  const mutated = runtime.slice(0, offset)
    + (runtime.slice(offset, offset + 2) === "00" ? "01" : "00")
    + runtime.slice(offset + 2);
  assert.throws(() => assertAuditedDeploymentRuntime(mutated, artifact, owner), /exactly match/);
});

test("post-deployment verification proves full runtime, owner, router and proxyBid selector", async () => {
  const owner = "0x0000000000000000000000000000000000009001";
  const router = "0x1de460f363af910f51726def188f9004276bf4bc";
  const executor = "0x0000000000000000000000000000000000001001";
  const runtime = expectedDeploymentRuntime(artifact, owner, router);
  const requests = [];
  const provider = {
    async send(method, params) {
      requests.push({ method, params });
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_blockNumber") return "0x123";
      if (method === "eth_getCode") return runtime;
      if (method === "eth_call") {
        const data = params[0].data;
        if (data === VIEW.getFunction("owner").selector) return VIEW.encodeFunctionResult("owner", [owner]);
        if (data === VIEW.getFunction("router").selector) return VIEW.encodeFunctionResult("router", [router]);
        if (data === VIEW.getFunction("BLOCKRAZOR_PROXY_BID_SELECTOR").selector) {
          return VIEW.encodeFunctionResult("BLOCKRAZOR_PROXY_BID_SELECTOR", ["0xbd69ffca"]);
        }
      }
      throw new Error("unexpected RPC request");
    },
  };
  await assert.doesNotReject(verifyDeployment(provider, executor, owner, artifact));
  for (const request of requests.filter(({ method }) => method === "eth_getCode" || method === "eth_call")) {
    assert.equal(request.params.at(-1), "0x123");
  }
  const badProvider = {
    ...provider,
    async send(method, params) {
      if (method === "eth_call" && params[0].data === VIEW.getFunction("BLOCKRAZOR_PROXY_BID_SELECTOR").selector) {
        return VIEW.encodeFunctionResult("BLOCKRAZOR_PROXY_BID_SELECTOR", ["0x00000000"]);
      }
      return provider.send(method, params);
    },
  };
  await assert.rejects(verifyDeployment(badProvider, executor, owner, artifact), /proxyBid selector mismatch/);
  const wrongChainProvider = {
    async send(method, params) {
      if (method === "eth_chainId") return "0x1";
      return provider.send(method, params);
    },
  };
  await assert.rejects(verifyDeployment(wrongChainProvider, executor, owner, artifact), /not BSC chainId 56/);
});

test("partial cross-wallet deployment is preserved as an explicit incomplete result", () => {
  const successful = { lane: "Ed", executor: "0x0000000000000000000000000000000000001001" };
  const incomplete = {
    lane: "枯坐",
    predictedExecutor: "0x0000000000000000000000000000000000001002",
    deploymentTransaction: null,
    status: "failed_or_unknown_after_broadcast",
  };
  assert.deepEqual(partitionDeploymentOutcomes([
    { status: "deployed", deployed: successful },
    { status: "incomplete", incomplete },
  ]), { deployed: [successful], incomplete: [incomplete] });
});

test("broadcast aborts both lanes when a predicted CREATE nonce has changed", () => {
  const plans = [
    { lane: { label: "Ed" }, nonce: 4 },
    { lane: { label: "枯坐" }, nonce: 9 },
  ];
  assert.doesNotThrow(() => assertPlannedNonces(plans, [4, 9]));
  assert.throws(() => assertPlannedNonces(plans, [5, 9]), /Ed pending nonce changed/);
  assert.throws(() => assertPlannedNonces(plans, [4]), /recheck is incomplete/);
});

test("entrypoint errors never reflect provider URLs, raw transactions, or credentials", () => {
  assert.equal(
    publicDeploymentError(new Error("upstream failed https://rpc.example/secret-token raw=0xdead")),
    "deployment operation failed",
  );
  assert.match(
    publicDeploymentError(new Error("--plan and --broadcast are mutually exclusive")),
    /mutually exclusive/,
  );
});
