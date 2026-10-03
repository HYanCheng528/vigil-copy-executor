import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { id } from "ethers";

import {
  CONTRACT_NAME,
  EVM_VERSION,
  SOURCE_NAME,
  buildArtifact,
  compileContract,
  namedImmutableReferences,
} from "../scripts/compile-contract.mjs";

const EXECUTE_SIGNATURE =
  "executeCopyBuy(address,uint256,uint256,address,uint256,bytes)";
const EXECUTE_V2_SIGNATURE =
  "executeCopyBuyV2(address,uint256,uint256,address,uint256,uint256,bytes)";
const EXECUTE_PRIVATE_SIGNATURE =
  "executePrivateCopyBuy(address,uint256,uint256,address,address,uint256,uint256,uint256,bytes)";

test("GMGN executor compiles deterministically for a conservative BSC EVM target", () => {
  const { compiled, sourceAst, diagnostics, input } = compileContract();
  const errors = diagnostics.filter(({ severity }) => severity === "error");

  assert.equal(errors.length, 0);
  assert.equal(input.settings.evmVersion, EVM_VERSION);
  assert.deepEqual(input.settings.optimizer, { enabled: true, runs: 200 });
  assert.equal(CONTRACT_NAME, "GmgnAtomicCopyExecutor");
  assert.equal(SOURCE_NAME, "contracts/GmgnAtomicCopyExecutor.sol");

  const creationBytecode = compiled.evm.bytecode.object;
  const runtimeBytecode = compiled.evm.deployedBytecode.object;
  assert.match(creationBytecode, /^[0-9a-f]+$/i);
  assert.match(runtimeBytecode, /^[0-9a-f]+$/i);
  assert.ok(creationBytecode.length > runtimeBytecode.length);
  assert.ok(runtimeBytecode.length / 2 < 24_576, "runtime exceeds EIP-170");
  assert.match(
    input.sources[SOURCE_NAME].content,
    /GMGN_SWAP_SELECTOR\s*=\s*0x4d819a2a/,
    "source compiled into the bytecode must pin the GMGN selector",
  );
  assert.match(input.sources[SOURCE_NAME].content, /BLOCKRAZOR_PROXY_BID_SELECTOR\s*=\s*0xbd69ffca/);
  assert.match(
    input.sources[SOURCE_NAME].content,
    /validUntilBlock\s*==\s*0[\s\S]*block\.number\s*>\s*validUntilBlock[\s\S]*validUntilBlock\s*>\s*block\.number\s*\+\s*1/,
    "signed V2/private transactions must be unusable outside the one-block window",
  );
  assert.match(
    input.sources[SOURCE_NAME].content,
    /function _swapAndSweepOwnerFloor[\s\S]*_safeBalanceOf\(tokenOut, owner\)[\s\S]*_swapAndSweep\(tokenOut, swapValueWei, 0,[\s\S]*ownerTokenAmountOut = ownerBalanceAfter - ownerBalanceBefore/,
    "production floor must measure the owner's post-tax balance delta",
  );

  const immutableReferences = Object.values(
    compiled.evm.deployedBytecode.immutableReferences,
  ).flat();
  assert.ok(immutableReferences.length >= 2, "owner/router must be immutable");
  const namedReferences = namedImmutableReferences(compiled, sourceAst);
  assert.deepEqual(Object.keys(namedReferences).sort(), ["owner", "router"]);
  assert.deepEqual(namedReferences.owner.map(({ start }) => start), [
    285, 512, 899, 1298, 1417, 1525, 1658, 1805, 1931, 2878, 3296, 3357, 3949, 4150,
  ]);
  assert.deepEqual(namedReferences.router.map(({ start }) => start), [465, 2567, 4009, 4210]);
  const runtimeBytes = Buffer.from(runtimeBytecode, "hex");
  for (const references of Object.values(namedReferences)) {
    for (const { start, length } of references) {
      assert.equal(length, 32);
      assert.ok(runtimeBytes.subarray(start, start + length).every((value) => value === 0));
    }
  }
  assert.deepEqual(compiled.evm.bytecode.linkReferences, {});
});

test("checked-in atomic Executor artifact exactly matches the pinned compiler output", () => {
  const checkedIn = JSON.parse(readFileSync(
    new URL("../contracts/artifacts/GmgnAtomicCopyExecutor.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(checkedIn, buildArtifact());
});

test("artifact exposes the atomic owner-only execution and recovery ABI", () => {
  const artifact = buildArtifact();
  const functions = new Map(
    artifact.abi
      .filter(({ type }) => type === "function")
      .map((entry) => [entry.name, entry]),
  );
  const errors = new Set(
    artifact.abi
      .filter(({ type }) => type === "error")
      .map(({ name }) => name),
  );
  const events = new Set(
    artifact.abi
      .filter(({ type }) => type === "event")
      .map(({ name }) => name),
  );

  assert.deepEqual(
    [...functions.keys()].sort(),
    [
      "BLOCKRAZOR_PROXY_BID_SELECTOR",
      "GMGN_SWAP_SELECTOR",
      "executeCopyBuy",
      "executeCopyBuyV2",
      "executePrivateCopyBuy",
      "owner",
      "recoverNative",
      "recoverToken",
      "router",
    ],
  );
  assert.equal(functions.get("executeCopyBuy").stateMutability, "payable");
  assert.deepEqual(
    functions.get("executeCopyBuy").inputs.map(({ type }) => type),
    ["address", "uint256", "uint256", "address", "uint256", "bytes"],
  );
  assert.equal(functions.get("executeCopyBuyV2").stateMutability, "payable");
  assert.deepEqual(
    functions.get("executeCopyBuyV2").inputs.map(({ type }) => type),
    ["address", "uint256", "uint256", "address", "uint256", "uint256", "bytes"],
  );
  assert.equal(functions.get("executePrivateCopyBuy").stateMutability, "payable");
  assert.deepEqual(
    functions.get("executePrivateCopyBuy").inputs.map(({ type }) => type),
    ["address", "uint256", "uint256", "address", "address", "uint256", "uint256", "uint256", "bytes"],
  );
  assert.deepEqual(
    functions.get("executeCopyBuy").outputs.map(({ type }) => type),
    ["uint256"],
  );

  assert.equal(
    artifact.methodIdentifiers[EXECUTE_SIGNATURE],
    id(EXECUTE_SIGNATURE).slice(2, 10),
  );
  assert.equal(artifact.methodIdentifiers[EXECUTE_V2_SIGNATURE], id(EXECUTE_V2_SIGNATURE).slice(2, 10));
  assert.equal(artifact.methodIdentifiers[EXECUTE_PRIVATE_SIGNATURE], id(EXECUTE_PRIVATE_SIGNATURE).slice(2, 10));
  assert.equal(artifact.methodIdentifiers["BLOCKRAZOR_PROXY_BID_SELECTOR()"], id("BLOCKRAZOR_PROXY_BID_SELECTOR()").slice(2, 10));
  assert.ok(events.has("AtomicCopyExecuted"));
  assert.ok(events.has("AtomicCopyExecutedV2"));
  assert.ok(events.has("PrivateAtomicCopyExecuted"));
  assert.ok(errors.has("NotOwner"));
  assert.ok(errors.has("Reentrancy"));
  assert.ok(errors.has("IncorrectNativeValue"));
  assert.ok(errors.has("UnsupportedRouterSelector"));
  assert.ok(errors.has("NoTokenOutput"));
  assert.ok(errors.has("InsufficientTokenOutput"));
  assert.ok(errors.has("OutputSweepIncomplete"));
  assert.ok(errors.has("RouterCallFailed"));
  assert.ok(errors.has("NativeTransferFailed"));
  assert.ok(errors.has("InvalidBlockWindow"));
  assert.ok(errors.has("ZeroProxyBid"));
  assert.ok(errors.has("InvalidProxyBidContract"));
  assert.ok(errors.has("ProxyBidCallFailed"));
  assert.ok(errors.has("InsufficientOwnerTokenOutput"));

  assert.match(artifact.bytecode, /^0x[0-9a-f]+$/i);
  assert.match(artifact.deployedBytecode, /^0x[0-9a-f]+$/i);
  assert.equal(artifact.evmVersion, "paris");
  assert.deepEqual(Object.keys(artifact.immutableReferences).sort(), ["owner", "router"]);
});
