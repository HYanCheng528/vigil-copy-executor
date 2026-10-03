import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { keccak256 } from "ethers";
import {
  ATOMIC_EXECUTOR_IMMUTABLE_REFERENCES,
  ATOMIC_EXECUTOR_RUNTIME_LENGTH,
  ATOMIC_EXECUTOR_RUNTIME_TEMPLATE_HASH,
  assertAuditedAtomicExecutorRuntime,
  expectedAtomicExecutorRuntime,
} from "../src/executor-capability.js";

const OWNER = "0x0000000000000000000000000000000000009001";
const OTHER_OWNER = "0x0000000000000000000000000000000000009002";
const ROUTER = "0x1de460f363af910f51726def188f9004276bf4bc";
const artifact = JSON.parse(readFileSync(
  new URL("../contracts/artifacts/GmgnAtomicCopyExecutor.json", import.meta.url),
  "utf8",
)) as {
  deployedBytecode: string;
  immutableReferences: typeof ATOMIC_EXECUTOR_IMMUTABLE_REFERENCES;
};

function mutateByte(code: string, byteIndex: number): string {
  const offset = 2 + (byteIndex * 2);
  const current = code.slice(offset, offset + 2);
  return code.slice(0, offset) + (current === "00" ? "01" : "00") + code.slice(offset + 2);
}

test("deployed Executor runtime is materialized from every named owner/router reference", () => {
  assert.equal((artifact.deployedBytecode.length - 2) / 2, ATOMIC_EXECUTOR_RUNTIME_LENGTH);
  assert.equal(keccak256(artifact.deployedBytecode), ATOMIC_EXECUTOR_RUNTIME_TEMPLATE_HASH);
  assert.deepEqual(artifact.immutableReferences, ATOMIC_EXECUTOR_IMMUTABLE_REFERENCES);
  const runtime = expectedAtomicExecutorRuntime(OWNER, ROUTER);
  assert.notEqual(runtime, artifact.deployedBytecode, "zero-filled compiler template is not deployed runtime");
  assert.doesNotThrow(() => assertAuditedAtomicExecutorRuntime(runtime, OWNER, ROUTER));
  assert.throws(
    () => assertAuditedAtomicExecutorRuntime(runtime, OTHER_OWNER, ROUTER),
    /exactly match/,
  );
});

test("Executor capability fails if any ordinary or duplicate immutable byte changes", () => {
  const runtime = expectedAtomicExecutorRuntime(OWNER, ROUTER);
  assert.throws(() => assertAuditedAtomicExecutorRuntime(mutateByte(runtime, 10), OWNER, ROUTER), /exactly match/);
  assert.throws(
    () => assertAuditedAtomicExecutorRuntime(
      mutateByte(runtime, ATOMIC_EXECUTOR_IMMUTABLE_REFERENCES.owner[1]!.start),
      OWNER,
      ROUTER,
    ),
    /exactly match/,
  );
  assert.throws(
    () => assertAuditedAtomicExecutorRuntime(
      mutateByte(runtime, ATOMIC_EXECUTOR_IMMUTABLE_REFERENCES.router[1]!.start),
      OWNER,
      ROUTER,
    ),
    /exactly match/,
  );
  assert.throws(() => assertAuditedAtomicExecutorRuntime(artifact.deployedBytecode, OWNER, ROUTER), /exactly match/);
  assert.throws(() => assertAuditedAtomicExecutorRuntime("0x00", OWNER, ROUTER), /length/);
});
