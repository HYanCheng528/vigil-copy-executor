import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ContractFactory,
  Interface,
  JsonRpcProvider,
  Wallet,
  getBytes,
  getAddress,
  getCreateAddress,
  hexlify,
  keccak256,
  parseUnits,
  zeroPadValue,
} from "ethers";

const BSC_CHAIN_ID = 56n;
const GMGN_ROUTER = "0x1de460f363af910f51726def188f9004276bf4bc";
const BROADCAST_CONFIRMATION = "I_ACCEPT_TWO_EXECUTOR_DEPLOYMENTS";
const BLOCKRAZOR_PROXY_BID_SELECTOR = "0xbd69ffca";
const PRIVATE_KEY_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;
export const DEPLOY_AUDITED_RUNTIME_LENGTH = 5_800;
export const DEPLOY_AUDITED_RUNTIME_TEMPLATE_HASH =
  "0x4a22738033fc73b28a6bab2082111a610f0fd56d6dab1efc426f5fbd843075b1";
export const DEPLOY_AUDITED_IMMUTABLE_REFERENCES = Object.freeze({
  owner: Object.freeze([
    { start: 285, length: 32 }, { start: 512, length: 32 },
    { start: 899, length: 32 }, { start: 1298, length: 32 },
    { start: 1417, length: 32 }, { start: 1525, length: 32 },
    { start: 1658, length: 32 }, { start: 1805, length: 32 },
    { start: 1931, length: 32 }, { start: 2878, length: 32 },
    { start: 3296, length: 32 }, { start: 3357, length: 32 },
    { start: 3949, length: 32 }, { start: 4150, length: 32 },
  ]),
  router: Object.freeze([
    { start: 465, length: 32 }, { start: 2567, length: 32 },
    { start: 4009, length: 32 }, { start: 4210, length: 32 },
  ]),
});
const VIEW = new Interface([
  "function owner() view returns (address)",
  "function router() view returns (address)",
  "function BLOCKRAZOR_PROXY_BID_SELECTOR() view returns (bytes4)",
]);

function rpcQuantity(value, field) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${field} is not an RPC quantity`);
  }
  return BigInt(value);
}

function assertAuditedArtifactTemplate(artifact) {
  if (!artifact || typeof artifact !== "object"
    || typeof artifact.deployedBytecode !== "string"
    || !/^0x(?:[0-9a-fA-F]{2})+$/.test(artifact.deployedBytecode)) {
    throw new Error("atomic executor artifact is malformed");
  }
  const template = getBytes(artifact.deployedBytecode);
  if (template.length !== DEPLOY_AUDITED_RUNTIME_LENGTH
    || keccak256(template) !== DEPLOY_AUDITED_RUNTIME_TEMPLATE_HASH) {
    throw new Error("atomic executor artifact runtime is not the audited release");
  }
  if (JSON.stringify(artifact.immutableReferences) !== JSON.stringify(DEPLOY_AUDITED_IMMUTABLE_REFERENCES)) {
    throw new Error("atomic executor artifact immutable layout is not the audited release");
  }
  for (const references of Object.values(DEPLOY_AUDITED_IMMUTABLE_REFERENCES)) {
    for (const { start, length } of references) {
      for (let index = start; index < start + length; index += 1) {
        if (template[index] !== 0) throw new Error("atomic executor artifact immutable template is not zero-filled");
      }
    }
  }
}

export function expectedDeploymentRuntime(artifact, owner, router = GMGN_ROUTER) {
  assertAuditedArtifactTemplate(artifact);
  const runtime = getBytes(artifact.deployedBytecode);
  const words = {
    owner: getBytes(zeroPadValue(getAddress(owner), 32)),
    router: getBytes(zeroPadValue(getAddress(router), 32)),
  };
  for (const name of ["owner", "router"]) {
    for (const { start } of DEPLOY_AUDITED_IMMUTABLE_REFERENCES[name]) runtime.set(words[name], start);
  }
  return hexlify(runtime);
}

export function assertAuditedDeploymentRuntime(code, artifact, owner, router = GMGN_ROUTER) {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error("Executor runtime bytecode is malformed");
  const actual = getBytes(code);
  const expected = getBytes(expectedDeploymentRuntime(artifact, owner, router));
  if (actual.length !== expected.length) {
    throw new Error("Executor runtime bytecode length does not match the audited V2 runtime");
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error("Executor runtime bytecode does not exactly match the audited owner/router runtime");
    }
  }
}

export function maskAddress(address) {
  const value = getAddress(address);
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function assertDistinctIdentities(ed, kuzuo) {
  if (ed.keyPath === kuzuo.keyPath) throw new Error("Ed and kuzuo must use different key files");
  if (getAddress(ed.owner) === getAddress(kuzuo.owner)) {
    throw new Error("Ed and kuzuo must use different owner wallets");
  }
}

export function parseDeployMode(argv, env) {
  if (argv.includes("--plan") && argv.includes("--broadcast")) {
    throw new Error("--plan and --broadcast are mutually exclusive");
  }
  const broadcast = argv.includes("--broadcast");
  if (argv.some((value) => value !== "--plan" && value !== "--broadcast")) {
    throw new Error("supported flags are --plan and --broadcast");
  }
  if (broadcast && env.COPY_EXECUTOR_DEPLOY_CONFIRM?.trim() !== BROADCAST_CONFIRMATION) {
    throw new Error(`broadcast requires COPY_EXECUTOR_DEPLOY_CONFIRM=${BROADCAST_CONFIRMATION}`);
  }
  return broadcast ? "broadcast" : "plan";
}

async function readRootOnlyKey(path, label) {
  if (!path) throw new Error(`${label} key file path is required`);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${label} key path is not a regular file`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} key file must be root-only (0600)`);
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!PRIVATE_KEY_PATTERN.test(value)) throw new Error(`${label} key file is not one 32-byte hex key`);
  return value.startsWith("0x") ? value : `0x${value}`;
}

async function loadArtifact() {
  const url = new URL("../contracts/artifacts/GmgnAtomicCopyExecutor.json", import.meta.url);
  const artifact = JSON.parse(await readFile(url, "utf8"));
  if (!Array.isArray(artifact.abi)
    || typeof artifact.bytecode !== "string" || !/^0x[0-9a-fA-F]+$/.test(artifact.bytecode)
    || typeof artifact.deployedBytecode !== "string") {
    throw new Error("atomic executor artifact is malformed");
  }
  // Refuse to spend deployment gas on a stale or locally replaced artifact.
  assertAuditedArtifactTemplate(artifact);
  return artifact;
}

export async function verifyDeployment(provider, address, owner, artifact, pinnedBlockNumber = null) {
  const chainId = rpcQuantity(await provider.send("eth_chainId", []), "deployment RPC chainId");
  if (chainId !== BSC_CHAIN_ID) throw new Error("deployment RPC is not BSC chainId 56");
  const blockTag = pinnedBlockNumber === null
    ? String(await provider.send("eth_blockNumber", [])).toLowerCase()
    : `0x${BigInt(pinnedBlockNumber).toString(16)}`;
  rpcQuantity(blockTag, "deployment verification blockNumber");
  const [code, ownerResult, routerResult, selectorResult] = await Promise.all([
    provider.send("eth_getCode", [getAddress(address), blockTag]),
    provider.send("eth_call", [{ to: getAddress(address), data: VIEW.encodeFunctionData("owner") }, blockTag]),
    provider.send("eth_call", [{ to: getAddress(address), data: VIEW.encodeFunctionData("router") }, blockTag]),
    provider.send("eth_call", [{
      to: getAddress(address),
      data: VIEW.encodeFunctionData("BLOCKRAZOR_PROXY_BID_SELECTOR"),
    }, blockTag]),
  ]);
  if (code === "0x") throw new Error("deployed Executor has no bytecode");
  assertAuditedDeploymentRuntime(code, artifact, owner, GMGN_ROUTER);
  const actualOwner = VIEW.decodeFunctionResult("owner", ownerResult)[0];
  const actualRouter = VIEW.decodeFunctionResult("router", routerResult)[0];
  const actualSelector = VIEW.decodeFunctionResult("BLOCKRAZOR_PROXY_BID_SELECTOR", selectorResult)[0];
  if (getAddress(actualOwner) !== getAddress(owner)) throw new Error("deployed Executor owner mismatch");
  if (getAddress(actualRouter) !== getAddress(GMGN_ROUTER)) throw new Error("deployed Executor router mismatch");
  if (String(actualSelector).toLowerCase() !== BLOCKRAZOR_PROXY_BID_SELECTOR) {
    throw new Error("deployed Executor proxyBid selector mismatch");
  }
}

export function partitionDeploymentOutcomes(outcomes) {
  return {
    deployed: outcomes.filter((outcome) => outcome.status === "deployed").map((outcome) => outcome.deployed),
    incomplete: outcomes.filter((outcome) => outcome.status !== "deployed").map((outcome) => outcome.incomplete),
  };
}

export function assertPlannedNonces(plans, currentNonces) {
  if (plans.length !== currentNonces.length) throw new Error("deployment nonce recheck is incomplete");
  for (let index = 0; index < plans.length; index += 1) {
    if (plans[index].nonce !== currentNonces[index]) {
      throw new Error(`${plans[index].lane.label} pending nonce changed after planning; nothing was broadcast`);
    }
  }
}

export function publicDeploymentError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const controlled = [
    /^--plan and --broadcast are mutually exclusive$/,
    /^supported flags are /,
    /^broadcast requires /,
    /^BSC_EXECUTOR_HTTP_RPC_URL must be HTTPS$/,
    / key file /,
    / must use different /,
    / deployment gas /,
    / wallet balance /,
    / pending nonce changed after planning/,
    /^atomic executor artifact is malformed$/,
    /^Executor deployment incomplete/,
  ];
  return controlled.some((pattern) => pattern.test(message)) ? message : "deployment operation failed";
}

export async function runDeployment(argv = process.argv.slice(2), env = process.env) {
  const mode = parseDeployMode(argv, env);
  const rpcUrl = env.BSC_EXECUTOR_HTTP_RPC_URL?.trim();
  if (!rpcUrl || new URL(rpcUrl).protocol !== "https:") throw new Error("BSC_EXECUTOR_HTTP_RPC_URL must be HTTPS");
  const [edKey, kuzuoKey, artifact] = await Promise.all([
    readRootOnlyKey(env.ED_COPY_PRIVATE_KEY_FILE?.trim(), "Ed"),
    readRootOnlyKey(env.KUZUO_COPY_PRIVATE_KEY_FILE?.trim(), "kuzuo"),
    loadArtifact(),
  ]);
  const provider = new JsonRpcProvider(rpcUrl, Number(BSC_CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });
  const chainId = rpcQuantity(await provider.send("eth_chainId", []), "deployment RPC chainId");
  if (chainId !== BSC_CHAIN_ID) throw new Error("deployment RPC is not BSC chainId 56");
  const lanes = [
    { label: "Ed", keyPath: env.ED_COPY_PRIVATE_KEY_FILE.trim(), wallet: new Wallet(edKey, provider) },
    { label: "枯坐", keyPath: env.KUZUO_COPY_PRIVATE_KEY_FILE.trim(), wallet: new Wallet(kuzuoKey, provider) },
  ];
  assertDistinctIdentities(
    { keyPath: lanes[0].keyPath, owner: lanes[0].wallet.address },
    { keyPath: lanes[1].keyPath, owner: lanes[1].wallet.address },
  );
  const maxGas = BigInt(env.COPY_EXECUTOR_DEPLOY_MAX_GAS?.trim() || "1500000");
  const maxGasPrice = parseUnits(env.COPY_EXECUTOR_DEPLOY_MAX_GAS_PRICE_GWEI?.trim() || "3", "gwei");

  const plans = await Promise.all(lanes.map(async (lane) => {
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, lane.wallet);
    const deployment = await factory.getDeployTransaction(lane.wallet.address, GMGN_ROUTER);
    const [nonce, gasEstimate, feeData, balance] = await Promise.all([
      provider.getTransactionCount(lane.wallet.address, "pending"),
      provider.estimateGas({ ...deployment, from: lane.wallet.address }),
      provider.getFeeData(),
      provider.getBalance(lane.wallet.address),
    ]);
    const gasPrice = feeData.gasPrice ?? 0n;
    if (gasEstimate > maxGas) throw new Error(`${lane.label} deployment gas estimate exceeds hard cap`);
    if (gasPrice <= 0n || gasPrice > maxGasPrice) throw new Error(`${lane.label} deployment gas price exceeds hard cap`);
    const deploymentGasLimit = (gasEstimate * 110n + 99n) / 100n;
    if (deploymentGasLimit > maxGas) throw new Error(`${lane.label} buffered deployment gas exceeds hard cap`);
    const required = deploymentGasLimit * gasPrice;
    if (balance < required) throw new Error(`${lane.label} wallet balance is below deployment estimate`);
    return {
      lane,
      factory,
      nonce,
      gasEstimate,
      deploymentGasLimit,
      gasPrice,
      predicted: getCreateAddress({ from: lane.wallet.address, nonce }),
    };
  }));

  const publicPlan = plans.map((plan) => ({
    lane: plan.lane.label,
    owner: maskAddress(plan.lane.wallet.address),
    predictedExecutor: maskAddress(plan.predicted),
    nonce: plan.nonce,
    gasEstimate: plan.gasEstimate.toString(),
    deploymentGasLimit: plan.deploymentGasLimit.toString(),
    gasPriceWei: plan.gasPrice.toString(),
  }));
  process.stdout.write(JSON.stringify({ mode, chainId: 56, router: maskAddress(GMGN_ROUTER), plans: publicPlan }) + "\n");
  if (mode === "plan") return publicPlan;

  // Preserve every predicted CREATE address if another process touched either
  // dedicated wallet while estimates were running. This check occurs before
  // either lane calls eth_sendRawTransaction.
  const currentNonces = await Promise.all(plans.map((plan) => (
    provider.getTransactionCount(plan.lane.wallet.address, "pending")
  )));
  assertPlannedNonces(plans, currentNonces);

  // Cross-wallet deployment cannot be atomic. Each task therefore catches its
  // own failure and the process waits for both outcomes; Promise.all rejection
  // must never hide a successful sibling deployment.
  const outcomes = await Promise.all(plans.map(async (plan) => {
    let deploymentTransaction = null;
    try {
      const contract = await plan.factory.deploy(plan.lane.wallet.address, GMGN_ROUTER, {
        gasLimit: plan.deploymentGasLimit,
        gasPrice: plan.gasPrice,
        nonce: plan.nonce,
      });
      deploymentTransaction = contract.deploymentTransaction().hash;
      const receipt = await contract.deploymentTransaction().wait(1);
      if (!receipt || receipt.status !== 1) throw new Error("Executor deployment receipt failed");
      const address = await contract.getAddress();
      if (getAddress(address) !== getAddress(plan.predicted)) throw new Error("predicted Executor address mismatch");
      await verifyDeployment(provider, address, plan.lane.wallet.address, artifact, receipt.blockNumber);
      return {
        status: "deployed",
        deployed: {
          lane: plan.lane.label,
          owner: maskAddress(plan.lane.wallet.address),
          // Executor contracts are public configuration, not credentials.
          executor: getAddress(address),
          deploymentTransaction: receipt.hash,
        },
      };
    } catch {
      return {
        status: "incomplete",
        incomplete: {
          lane: plan.lane.label,
          predictedExecutor: getAddress(plan.predicted),
          deploymentTransaction,
          status: "failed_or_unknown_after_broadcast",
        },
      };
    }
  }));
  const result = partitionDeploymentOutcomes(outcomes);
  if (result.incomplete.length > 0) {
    process.stdout.write(JSON.stringify({ mode: "broadcast_incomplete", ...result }) + "\n");
    throw new Error("Executor deployment incomplete; do not rerun blindly because one lane may already be deployed");
  }
  process.stdout.write(JSON.stringify({ mode: "broadcast_complete", deployed: result.deployed }) + "\n");
  return result.deployed;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  runDeployment().catch((error) => {
    process.stderr.write(JSON.stringify({ error: publicDeploymentError(error) }) + "\n");
    process.exitCode = 1;
  });
}
