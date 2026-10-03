import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  formatEther,
  getAddress,
  keccak256,
} from "ethers";

export const BSC_CHAIN_ID = 56;
export const GMGN_ROUTER = "0x1de460f363af910f51726def188f9004276bf4bc";
export const TEST_TOKEN = "0x5e88b8fb2a9c501eceb186476797882dee087777";
export const TEST_BUY_WEI = 100_000_000_000_000n;
export const BUY_TEMPLATE_HASH = "0xff1b21dd9ab76065b2c4c36d523b29976a3a8b011c87788015e46b03a65688ec";
export const SELL_TEMPLATE_HASH = "0x3de73d97a9ad1344dcebce0eae23528f484d728895694a882303d8e069c70190";
export const BROADCAST_CONFIRM = "I_ACCEPT_AI_0.0001_BNB_BUY_AND_SELL";

const ROUTER_IMPLEMENTATION = "0x9d82e6fe9ad22b1e793ae557bb55e3ea08482fcb";
const TOKEN_IMPLEMENTATION = "0x024f18294970b5c76c0691b87f138a0317156422";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PINNED_CODE_HASHES = new Map([
  [GMGN_ROUTER, "0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e"],
  [ROUTER_IMPLEMENTATION, "0x69eecab56727992fb49a4607f9b79c17453187da17a123829509e2780c0b7e8f"],
  [TEST_TOKEN, "0x9a16180e23f97dd8df627d48402f11d69169798b0470c1d975bf3d846a38e365"],
  [TOKEN_IMPLEMENTATION, "0xb530a7e0ff0d6ab435a5ec71f2b04092937735e23a0fb3a0746724ce9b875b4a"],
]);

const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const SWAP_SELECTOR = "0x4d819a2a";
const SWAP_INTERFACE = new Interface([
  "function swap((uint8 swapType,address tokenIn,address tokenOut,address poolAddress,uint24 fee,int24 tickSpacing,address hooks,bytes hookData,address poolManager,bytes32 parameters)[] descs,address feeToken,uint256 amountIn,uint256 minReturn,uint256 userFeeRate) payable",
]);
const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];
const TRANSFER_INTERFACE = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const MAX_TEST_TOKEN_WEI = 1_000_000_000n * (10n ** 18n);
const STATE_VERSION = 2;
const TRANSACTION_KINDS = new Set(["buy", "approve", "sell"]);
const STATE_STAGES = new Set([
  "buy_intent", "buy_broadcast", "buy_confirmed",
  "approve_intent", "approve_broadcast", "approve_confirmed",
  "sell_intent", "sell_broadcast", "sold",
]);

function wordStart(index) {
  return 10 + (index * 64);
}

export function readHeadWord(calldata, index) {
  const start = wordStart(index);
  const end = start + 64;
  if (!/^0x[0-9a-fA-F]+$/.test(calldata) || end > calldata.length) {
    throw new Error("GMGN calldata head is truncated");
  }
  return BigInt(`0x${calldata.slice(start, end)}`);
}

export function replaceHeadWord(calldata, index, value) {
  if (value < 0n || value >= (1n << 256n)) throw new Error("replacement does not fit uint256");
  const start = wordStart(index);
  if (start + 64 > calldata.length) throw new Error("GMGN calldata head is truncated");
  return `${calldata.slice(0, start)}${value.toString(16).padStart(64, "0")}${calldata.slice(start + 64)}`;
}

export function patchHistoricalSwap(calldata, amountIn) {
  if (calldata.slice(0, 10).toLowerCase() !== SWAP_SELECTOR) {
    throw new Error("template is not the audited GMGN swap selector");
  }
  let patched = replaceHeadWord(calldata, 2, amountIn);
  patched = replaceHeadWord(patched, 3, 0n);
  // Historical templates often use block.timestamp + 10 seconds. Replaying
  // that value would always revert; audited live calls also use zero here.
  patched = replaceHeadWord(patched, 4, 0n);
  return patched;
}

export function inspectRoute(calldata) {
  const decoded = SWAP_INTERFACE.decodeFunctionData("swap", calldata);
  const descriptors = [...decoded.descs].map((item) => ({
    tokenIn: getAddress(item.tokenIn),
    tokenOut: getAddress(item.tokenOut),
    poolAddress: getAddress(item.poolAddress),
    swapType: Number(item.swapType),
  }));
  if (descriptors.length < 1 || descriptors.length > 8) throw new Error("route length is outside the audited range");
  for (let index = 1; index < descriptors.length; index += 1) {
    if (descriptors[index - 1].tokenOut !== descriptors[index].tokenIn) {
      throw new Error("GMGN route is not token-continuous");
    }
  }
  return {
    descriptors,
    feeToken: getAddress(decoded.feeToken),
    amountIn: BigInt(decoded.amountIn),
    minReturn: BigInt(decoded.minReturn),
    deadline: BigInt(decoded.userFeeRate),
  };
}

export function assertRoundtripTemplates(buyTransaction, sellTransaction, walletAddress) {
  const token = getAddress(TEST_TOKEN);
  const router = getAddress(GMGN_ROUTER);
  const walletHex = getAddress(walletAddress).slice(2).toLowerCase();
  for (const [kind, transaction] of [["buy", buyTransaction], ["sell", sellTransaction]]) {
    if (!transaction || getAddress(transaction.to) !== router) throw new Error(`${kind} template does not call GMGN Router`);
    if (transaction.data.slice(0, 10).toLowerCase() !== SWAP_SELECTOR) throw new Error(`${kind} template selector is invalid`);
    if (transaction.data.toLowerCase().includes(walletHex)) throw new Error(`${kind} template embeds the test wallet`);
    if (transaction.from && transaction.data.toLowerCase().includes(getAddress(transaction.from).slice(2).toLowerCase())) {
      throw new Error(`${kind} template embeds its original sender`);
    }
  }
  const buy = inspectRoute(buyTransaction.data);
  const sell = inspectRoute(sellTransaction.data);
  if (buy.feeToken !== ZeroAddress || sell.feeToken !== ZeroAddress) throw new Error("non-zero feeToken is outside this test");
  if (BigInt(buyTransaction.value) !== buy.amountIn || buy.amountIn <= 0n) throw new Error("buy template is not native BNB input");
  if (![WBNB, ZeroAddress.toLowerCase()].includes(buy.descriptors[0].tokenIn.toLowerCase())) {
    throw new Error("buy template does not begin with native BNB/WBNB");
  }
  if (buy.descriptors.at(-1).tokenOut !== token) throw new Error("buy template does not end at the allowed token");
  if (BigInt(sellTransaction.value) !== 0n) throw new Error("sell template unexpectedly carries native value");
  if (sell.descriptors[0].tokenIn !== token) throw new Error("sell template does not begin with the allowed token");
  if (sell.descriptors.at(-1).tokenOut.toLowerCase() !== WBNB) throw new Error("sell template does not end at WBNB");
  const buyPath = [buy.descriptors[0].tokenIn, ...buy.descriptors.map((item) => item.tokenOut)]
    .map((value) => value.toLowerCase());
  const sellPath = [sell.descriptors[0].tokenIn, ...sell.descriptors.map((item) => item.tokenOut)]
    .map((value) => value.toLowerCase());
  if (buyPath.length !== sellPath.length || buyPath.some((value, index) => value !== sellPath.at(-(index + 1)))) {
    throw new Error("sell route is not the exact reverse asset path of the buy route");
  }
  return { buy, sell };
}

export function sanitizeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(?:0x)?[0-9a-fA-F]{64,}/g, "[redacted-hex]")
    .slice(0, 500);
}

function loadPrivateKey(filePath) {
  const value = fs.readFileSync(filePath, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("private-key file is not one exact 32-byte hex key");
  return value;
}

export function writeState(filePath, state) {
  const target = path.resolve(filePath);
  const temporary = `${target}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, target);
    try {
      const directoryDescriptor = fs.openSync(path.dirname(target), "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error?.code)) throw error;
    }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function assertStatePathWritable(filePath) {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  const probe = path.join(directory, `.roundtrip-write-probe-${process.pid}`);
  const descriptor = fs.openSync(probe, "wx", 0o600);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(probe);
  }
}

function parseDecimal(value, label, { allowZero = false, maximum } = {}) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} is invalid`);
  const parsed = BigInt(value);
  if ((!allowZero && parsed <= 0n) || (maximum !== undefined && parsed > maximum)) throw new Error(`${label} is outside its allowed range`);
  return parsed;
}

function assertIntent(intent, kind) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw new Error(`${kind} intent is missing`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(intent.hash ?? "")) throw new Error(`${kind} intent hash is invalid`);
  parseDecimal(intent.nonce, `${kind} nonce`, { allowZero: true, maximum: BigInt(Number.MAX_SAFE_INTEGER) });
  if (getAddress(intent.to) !== getAddress(kind === "approve" ? TEST_TOKEN : GMGN_ROUTER)) throw new Error(`${kind} intent target is invalid`);
  parseDecimal(intent.value, `${kind} value`, { allowZero: true });
  parseDecimal(intent.gasPrice, `${kind} gas price`, { maximum: 5_000_000_000n });
  parseDecimal(intent.gasLimit, `${kind} gas limit`, { maximum: kind === "approve" ? 200_000n : 2_000_000n });
  if (!/^0x[0-9a-fA-F]{64}$/.test(intent.dataHash ?? "")) throw new Error(`${kind} intent data hash is invalid`);
  if (!new Set(["intent", "broadcast", "confirmed"]).has(intent.status)) throw new Error(`${kind} intent status is invalid`);
  if (kind === "buy" && BigInt(intent.value) !== TEST_BUY_WEI) throw new Error("buy intent exceeds the exact 0.0001 BNB hard cap");
  if (kind !== "buy" && BigInt(intent.value) !== 0n) throw new Error(`${kind} intent unexpectedly carries native value`);
}

export function validateRoundtripState(state, walletAddress) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("roundtrip state is invalid");
  if (state.version !== STATE_VERSION || !STATE_STAGES.has(state.stage)) throw new Error("roundtrip state version/stage is invalid");
  if (getAddress(state.wallet) !== getAddress(walletAddress) || getAddress(state.token) !== getAddress(TEST_TOKEN)) {
    throw new Error("roundtrip state does not match this wallet/token");
  }
  if (state.buyWei !== TEST_BUY_WEI.toString() || state.startingTokenBalance !== "0") {
    throw new Error("roundtrip state violates the isolated-wallet hard cap");
  }
  if (!state.transactions || typeof state.transactions !== "object" || Array.isArray(state.transactions)) {
    throw new Error("roundtrip state transactions are invalid");
  }
  for (const [kind, intent] of Object.entries(state.transactions)) {
    if (!TRANSACTION_KINDS.has(kind)) throw new Error("roundtrip state contains an unknown transaction kind");
    assertIntent(intent, kind);
  }
  assertIntent(state.transactions.buy, "buy");
  if (state.stage.startsWith("approve_") && !state.transactions.approve) throw new Error("approve state is missing its intent");
  if (state.stage.startsWith("sell_") && !state.transactions.sell) throw new Error("sell state is missing its intent");
  if (state.acquiredToken !== undefined) parseDecimal(state.acquiredToken, "recorded acquisition", { maximum: MAX_TEST_TOKEN_WEI });
  if (state.stage === "sold" && !state.transactions.sell) throw new Error("sold state is missing its sell intent");
  return state;
}

function readState(filePath, walletAddress) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("roundtrip state file is unreadable or malformed");
  }
  return validateRoundtripState(parsed, walletAddress);
}

function requestForSigning(request, nonce) {
  return {
    chainId: BSC_CHAIN_ID,
    type: 0,
    nonce,
    to: getAddress(request.to),
    value: BigInt(request.value ?? 0n),
    data: request.data,
    gasPrice: BigInt(request.gasPrice),
    gasLimit: BigInt(request.gasLimit),
  };
}

function assertRequestMatchesIntent(request, intent, kind) {
  assertIntent(intent, kind);
  if (getAddress(request.to) !== getAddress(intent.to)
    || BigInt(request.value ?? 0n) !== BigInt(intent.value)
    || BigInt(request.gasPrice) !== BigInt(intent.gasPrice)
    || BigInt(request.gasLimit) !== BigInt(intent.gasLimit)
    || keccak256(request.data) !== intent.dataHash) {
    throw new Error(`${kind} recovery request does not match the persisted intent`);
  }
}

export async function persistTransactionIntent({ wallet, stateFile, state, kind, request, nonce }) {
  if (!TRANSACTION_KINDS.has(kind)) throw new Error("unknown roundtrip transaction kind");
  const signedTransaction = await wallet.signTransaction(requestForSigning(request, nonce));
  const hash = keccak256(signedTransaction);
  const intent = {
    hash,
    nonce: BigInt(nonce).toString(),
    to: getAddress(request.to),
    value: BigInt(request.value ?? 0n).toString(),
    dataHash: keccak256(request.data),
    gasPrice: BigInt(request.gasPrice).toString(),
    gasLimit: BigInt(request.gasLimit).toString(),
    status: "intent",
  };
  assertIntent(intent, kind);
  const nextState = {
    ...state,
    stage: `${kind}_intent`,
    transactions: { ...state.transactions, [kind]: intent },
  };
  validateRoundtripState(nextState, wallet.address);
  writeState(stateFile, nextState);
  return { state: nextState, signedTransaction, hash };
}

export async function settlePersistedIntent({ provider, wallet, stateFile, state, kind, request, broadcast }) {
  const intent = state.transactions[kind];
  assertRequestMatchesIntent(request, intent, kind);
  const signedTransaction = await wallet.signTransaction(requestForSigning(request, Number(intent.nonce)));
  if (keccak256(signedTransaction) !== intent.hash) throw new Error(`${kind} deterministic recovery hash mismatch`);
  let receipt = await provider.getTransactionReceipt(intent.hash);
  if (!receipt && !broadcast) return { state, receipt: null };
  if (!receipt) {
    const latestNonce = await provider.getTransactionCount(wallet.address, "latest");
    if (latestNonce > Number(intent.nonce)) throw new Error(`${kind} nonce was consumed without the persisted transaction receipt`);
    try {
      const response = await provider.broadcastTransaction(signedTransaction);
      if (response.hash.toLowerCase() !== intent.hash.toLowerCase()) throw new Error(`${kind} RPC returned a different transaction hash`);
    } catch (error) {
      receipt = await provider.getTransactionReceipt(intent.hash);
      if (!receipt) throw error;
    }
    const broadcastState = {
      ...state,
      stage: `${kind}_broadcast`,
      transactions: {
        ...state.transactions,
        [kind]: { ...intent, status: "broadcast" },
      },
    };
    writeState(stateFile, broadcastState);
    state = broadcastState;
    receipt ??= await provider.waitForTransaction(intent.hash, 1, 120_000);
  }
  if (!receipt || receipt.status !== 1) throw new Error(`${kind} transaction failed or is not confirmed`);
  const transaction = await provider.getTransaction(intent.hash);
  if (!transaction
    || getAddress(transaction.from) !== getAddress(wallet.address)
    || Number(transaction.nonce) !== Number(intent.nonce)
    || getAddress(transaction.to) !== getAddress(intent.to)
    || BigInt(transaction.value) !== BigInt(intent.value)
    || keccak256(transaction.data) !== intent.dataHash) {
    throw new Error(`${kind} confirmed transaction does not match the persisted intent`);
  }
  return { state, receipt };
}

export function acquiredFromBuyReceipt(receipt, walletAddress) {
  const wallet = getAddress(walletAddress);
  let net = 0n;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(TEST_TOKEN)) continue;
    let parsed;
    try { parsed = TRANSFER_INTERFACE.parseLog(log); } catch { continue; }
    if (!parsed || parsed.name !== "Transfer") continue;
    const amount = BigInt(parsed.args.value);
    if (getAddress(parsed.args.to) === wallet) net += amount;
    if (getAddress(parsed.args.from) === wallet) net -= amount;
  }
  if (net <= 0n || net > MAX_TEST_TOKEN_WEI) throw new Error("buy receipt does not prove a bounded positive AI acquisition");
  return net;
}

export function bufferedGas(estimate, maximum) {
  const value = ((estimate * 13n) / 10n) + 10_000n;
  if (value > maximum) throw new Error("estimated gas exceeds the audited test ceiling");
  return value;
}

export async function simulateAndEstimateGas(provider, request, maximum) {
  // Some RPCs inject an enormous default gas when eth_call omits it, then
  // reject a perfectly funded wallet during their value + gas*gasPrice check.
  // The ceiling is simulation-only; eth_estimateGas still sees the original
  // uncapped request and the signed transaction receives its buffered result.
  await provider.call({ ...request, gasLimit: maximum });
  return bufferedGas(await provider.estimateGas(request), maximum);
}

async function safeTokenMetadata(token) {
  const [name, symbol, decimals] = await Promise.all([token.name(), token.symbol(), token.decimals()]);
  if (name !== "Artificial Inu" || symbol !== "AI" || Number(decimals) !== 18) {
    throw new Error("token metadata does not match the allowed AI contract");
  }
  return { name, symbol, decimals: Number(decimals) };
}

export async function assertPinnedContracts(provider) {
  const implementationWord = await provider.getStorage(GMGN_ROUTER, EIP1967_IMPLEMENTATION_SLOT);
  const observedRouterImplementation = getAddress(`0x${implementationWord.slice(-40)}`);
  if (observedRouterImplementation !== getAddress(ROUTER_IMPLEMENTATION)) {
    throw new Error("GMGN Router implementation changed after route audit");
  }
  for (const [address, expectedHash] of PINNED_CODE_HASHES) {
    const code = await provider.getCode(address);
    if (code === "0x" || keccak256(code) !== expectedHash) {
      throw new Error(`audited contract code changed at ${address}`);
    }
  }
}

export async function runRoundtrip(options = {}) {
  const rpcUrl = options.rpcUrl ?? process.env.BSC_EXECUTOR_HTTP_RPC_URL;
  const keyFile = options.keyFile ?? process.env.ROUNDTRIP_PRIVATE_KEY_FILE;
  const stateFile = options.stateFile ?? process.env.ROUNDTRIP_STATE_FILE ?? path.resolve("roundtrip-ai-state.json");
  const action = options.action ?? process.env.ROUNDTRIP_ACTION ?? "BUY_SELL";
  const broadcast = (options.confirm ?? process.env.ROUNDTRIP_BROADCAST_CONFIRM) === BROADCAST_CONFIRM;
  if (!rpcUrl || new URL(rpcUrl).protocol !== "https:") throw new Error("an HTTPS BSC executor RPC is required");
  if (!keyFile) throw new Error("ROUNDTRIP_PRIVATE_KEY_FILE is required");
  if (!["BUY_SELL", "SELL_ONLY"].includes(action)) throw new Error("ROUNDTRIP_ACTION must be BUY_SELL or SELL_ONLY");

  const provider = new JsonRpcProvider(rpcUrl, BSC_CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
  const wallet = new Wallet(loadPrivateKey(keyFile), provider);
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(BSC_CHAIN_ID)) throw new Error("RPC is not BSC chainId 56");
    await assertPinnedContracts(provider);
    const [buyTemplate, sellTemplate] = await Promise.all([
      provider.getTransaction(BUY_TEMPLATE_HASH),
      provider.getTransaction(SELL_TEMPLATE_HASH),
    ]);
    if (!buyTemplate || !sellTemplate) throw new Error("template lookup failed");
    if (buyTemplate.hash?.toLowerCase() !== BUY_TEMPLATE_HASH || sellTemplate.hash?.toLowerCase() !== SELL_TEMPLATE_HASH) {
      throw new Error("RPC returned a transaction that does not match the pinned template hash");
    }
    const routes = assertRoundtripTemplates(buyTemplate, sellTemplate, wallet.address);
    const token = new Contract(TEST_TOKEN, ERC20_ABI, wallet);
    const metadata = await safeTokenMetadata(token);
    const feeData = await provider.getFeeData();
    const templateGasPrice = [buyTemplate.gasPrice ?? 0n, sellTemplate.gasPrice ?? 0n].reduce((a, b) => a > b ? a : b, 0n);
    const gasPrice = (feeData.gasPrice ?? 0n) > templateGasPrice ? feeData.gasPrice : templateGasPrice;
    if (!gasPrice || gasPrice <= 0n || gasPrice > 5_000_000_000n) throw new Error("gas price is outside the audited test range");
    const startingTokenBalance = BigInt(await token.balanceOf(wallet.address));
    const startingBnbBalance = await provider.getBalance(wallet.address);

    const summary = {
      mode: broadcast ? "broadcast" : "dry-run",
      action,
      chainId: BSC_CHAIN_ID,
      wallet: wallet.address,
      token: getAddress(TEST_TOKEN),
      tokenName: metadata.name,
      tokenSymbol: metadata.symbol,
      buyWei: TEST_BUY_WEI.toString(),
      buyRouteLength: routes.buy.descriptors.length,
      sellRouteLength: routes.sell.descriptors.length,
      startingBnb: formatEther(startingBnbBalance),
      startingTokenBalance: startingTokenBalance.toString(),
      gasPriceWei: gasPrice.toString(),
      transactions: {},
    };

    let state;
    let buyReceipt;
    const buyData = patchHistoricalSwap(buyTemplate.data, TEST_BUY_WEI);
    if (readHeadWord(buyData, 2) !== TEST_BUY_WEI) throw new Error("buy calldata violates the exact 0.0001 BNB hard cap");

    if (action === "BUY_SELL") {
      if (fs.existsSync(stateFile)) throw new Error("roundtrip state already exists; use SELL_ONLY for recovery or a new state path");
      if (startingTokenBalance !== 0n) throw new Error("test wallet already holds AI; refusing to mix balances");
      const coarseReserve = TEST_BUY_WEI + (4_000_000n * gasPrice);
      if (startingBnbBalance < coarseReserve) {
        throw new Error(`wallet needs at least ${formatEther(coarseReserve)} BNB before simulation`);
      }
      const simulatedBuy = { from: wallet.address, to: GMGN_ROUTER, value: TEST_BUY_WEI, data: buyData, gasPrice };
      const buyGasLimit = await simulateAndEstimateGas(provider, simulatedBuy, 2_000_000n);
      const conservativeGasReserve = (buyGasLimit + 200_000n + 2_000_000n) * gasPrice;
      if (startingBnbBalance < TEST_BUY_WEI + conservativeGasReserve) {
        throw new Error(`wallet needs at least ${formatEther(TEST_BUY_WEI + conservativeGasReserve)} BNB for buy, approve and sell gas`);
      }
      summary.buyGasLimit = buyGasLimit.toString();
      if (!broadcast) return summary;

      assertStatePathWritable(stateFile);
      state = {
        version: STATE_VERSION,
        wallet: wallet.address,
        token: getAddress(TEST_TOKEN),
        buyWei: TEST_BUY_WEI.toString(),
        startingTokenBalance: "0",
        stage: "buy_intent",
        transactions: {},
      };
      const nonce = await provider.getTransactionCount(wallet.address, "pending");
      const request = { ...simulatedBuy, gasLimit: buyGasLimit };
      await assertPinnedContracts(provider);
      ({ state } = await persistTransactionIntent({ wallet, stateFile, state, kind: "buy", request, nonce }));
      ({ state, receipt: buyReceipt } = await settlePersistedIntent({
        provider, wallet, stateFile, state, kind: "buy", request, broadcast: true,
      }));
    } else {
      if (!fs.existsSync(stateFile)) throw new Error("SELL_ONLY requires the prior roundtrip state file");
      state = readState(stateFile, wallet.address);
      if (state.stage === "sold") throw new Error("roundtrip state is already sold");
      const buyIntent = state.transactions.buy;
      const request = {
        from: wallet.address,
        to: GMGN_ROUTER,
        value: TEST_BUY_WEI,
        data: buyData,
        gasPrice: BigInt(buyIntent.gasPrice),
        gasLimit: BigInt(buyIntent.gasLimit),
      };
      await assertPinnedContracts(provider);
      ({ state, receipt: buyReceipt } = await settlePersistedIntent({
        provider, wallet, stateFile, state, kind: "buy", request, broadcast,
      }));
      if (!buyReceipt) {
        summary.recoveryPending = "buy";
        return summary;
      }
    }

    const acquired = acquiredFromBuyReceipt(buyReceipt, wallet.address);
    if (state.acquiredToken !== undefined && BigInt(state.acquiredToken) !== acquired) {
      throw new Error("recorded acquisition does not match the confirmed buy receipt");
    }
    state = {
      ...state,
      stage: "buy_confirmed",
      acquiredToken: acquired.toString(),
      transactions: {
        ...state.transactions,
        buy: { ...state.transactions.buy, status: "confirmed" },
      },
    };
    if (broadcast) writeState(stateFile, state);
    summary.acquiredToken = acquired.toString();
    summary.transactions.buy = state.transactions.buy.hash;
    summary.transactions.buyBlock = buyReceipt.blockNumber;

    const sellData = patchHistoricalSwap(sellTemplate.data, acquired);
    if (readHeadWord(sellData, 2) !== acquired) throw new Error("sell calldata is not the exact receipt-proven acquisition");

    // A crash after the sell reached the network must be recovered before
    // checking the pre-sell balance or allowance (both may already be zero).
    if (state.transactions.sell) {
      const intent = state.transactions.sell;
      const recoverySellRequest = {
        from: wallet.address,
        to: GMGN_ROUTER,
        value: 0n,
        data: sellData,
        gasPrice: BigInt(intent.gasPrice),
        gasLimit: BigInt(intent.gasLimit),
      };
      await assertPinnedContracts(provider);
      const settled = await settlePersistedIntent({
        provider, wallet, stateFile, state, kind: "sell", request: recoverySellRequest, broadcast,
      });
      state = settled.state;
      if (!settled.receipt) {
        summary.recoveryPending = "sell";
        return summary;
      }
      const recoveredEndingTokenBalance = BigInt(await token.balanceOf(wallet.address));
      if (recoveredEndingTokenBalance !== 0n) throw new Error("confirmed recovered sell left AI in the isolated test wallet");
      const recoveredEndingBnbBalance = await provider.getBalance(wallet.address);
      summary.transactions.sell = state.transactions.sell.hash;
      summary.transactions.sellBlock = settled.receipt.blockNumber;
      summary.endingTokenBalance = "0";
      summary.endingBnb = formatEther(recoveredEndingBnbBalance);
      summary.bnbDeltaWei = (recoveredEndingBnbBalance - startingBnbBalance).toString();
      state = {
        ...state,
        stage: "sold",
        transactions: {
          ...state.transactions,
          sell: { ...state.transactions.sell, status: "confirmed" },
        },
      };
      if (broadcast) writeState(stateFile, state);
      return summary;
    }

    const afterBuyBalance = BigInt(await token.balanceOf(wallet.address));
    if (afterBuyBalance !== acquired) {
      throw new Error("wallet AI balance is not exactly the acquisition proven by the buy receipt");
    }

    let allowance = BigInt(await token.allowance(wallet.address, GMGN_ROUTER));
    if (state.transactions.approve) {
      const intent = state.transactions.approve;
      const approveData = token.interface.encodeFunctionData("approve", [GMGN_ROUTER, acquired]);
      const recoveryApproveRequest = {
        from: wallet.address,
        to: TEST_TOKEN,
        value: 0n,
        data: approveData,
        gasPrice: BigInt(intent.gasPrice),
        gasLimit: BigInt(intent.gasLimit),
      };
      await assertPinnedContracts(provider);
      const settled = await settlePersistedIntent({
        provider, wallet, stateFile, state, kind: "approve", request: recoveryApproveRequest, broadcast,
      });
      state = settled.state;
      if (!settled.receipt) {
        summary.recoveryPending = "approve";
        return summary;
      }
      allowance = BigInt(await token.allowance(wallet.address, GMGN_ROUTER));
      if (allowance !== acquired) throw new Error("recovered approval is not the exact recorded acquisition allowance");
      state = {
        ...state,
        stage: "approve_confirmed",
        transactions: {
          ...state.transactions,
          approve: { ...state.transactions.approve, status: "confirmed" },
        },
      };
      if (broadcast) writeState(stateFile, state);
      summary.transactions.approve = state.transactions.approve.hash;
    }
    if (allowance !== acquired) {
      const approveData = token.interface.encodeFunctionData("approve", [GMGN_ROUTER, acquired]);
      const simulatedApprove = { from: wallet.address, to: TEST_TOKEN, value: 0n, data: approveData, gasPrice };
      const approveGasLimit = await simulateAndEstimateGas(provider, simulatedApprove, 200_000n);
      summary.approveGasLimit = approveGasLimit.toString();
      if (!broadcast) {
        summary.approvalRequired = true;
        return summary;
      }
      const approveRequest = { ...simulatedApprove, gasLimit: approveGasLimit };
      const nonce = await provider.getTransactionCount(wallet.address, "pending");
      await assertPinnedContracts(provider);
      ({ state } = await persistTransactionIntent({ wallet, stateFile, state, kind: "approve", request: approveRequest, nonce }));
      await assertPinnedContracts(provider);
      let approveReceipt;
      ({ state, receipt: approveReceipt } = await settlePersistedIntent({
        provider, wallet, stateFile, state, kind: "approve", request: approveRequest, broadcast,
      }));
      if (!approveReceipt) {
        summary.recoveryPending = "approve";
        return summary;
      }
      allowance = BigInt(await token.allowance(wallet.address, GMGN_ROUTER));
      if (allowance !== acquired) throw new Error("approval did not establish the exact recorded acquisition allowance");
      state = {
        ...state,
        stage: "approve_confirmed",
        transactions: {
          ...state.transactions,
          approve: { ...state.transactions.approve, status: "confirmed" },
        },
      };
      if (broadcast) writeState(stateFile, state);
      summary.transactions.approve = state.transactions.approve.hash;
    }

    const simulatedSell = { from: wallet.address, to: GMGN_ROUTER, value: 0n, data: sellData, gasPrice };
    await assertPinnedContracts(provider);
    const sellGasLimit = await simulateAndEstimateGas(provider, simulatedSell, 2_000_000n);
    summary.sellGasLimit = sellGasLimit.toString();
    if (!broadcast) return summary;
    const sellRequest = { ...simulatedSell, gasLimit: sellGasLimit };
    const sellNonce = await provider.getTransactionCount(wallet.address, "pending");
    await assertPinnedContracts(provider);
    ({ state } = await persistTransactionIntent({ wallet, stateFile, state, kind: "sell", request: sellRequest, nonce: sellNonce }));
    await assertPinnedContracts(provider);
    const { state: sellState, receipt: sellReceipt } = await settlePersistedIntent({
      provider, wallet, stateFile, state, kind: "sell", request: sellRequest, broadcast,
    });
    state = sellState;
    if (!sellReceipt) {
      summary.recoveryPending = "sell";
      return summary;
    }
    const endingTokenBalance = BigInt(await token.balanceOf(wallet.address));
    if (endingTokenBalance !== 0n) throw new Error("sell completed but AI remains in the isolated test wallet");
    const endingBnbBalance = await provider.getBalance(wallet.address);
    summary.transactions.sell = state.transactions.sell.hash;
    summary.transactions.sellBlock = sellReceipt.blockNumber;
    summary.endingTokenBalance = endingTokenBalance.toString();
    summary.endingBnb = formatEther(endingBnbBalance);
    summary.bnbDeltaWei = (endingBnbBalance - startingBnbBalance).toString();
    state = {
      ...state,
      stage: "sold",
      transactions: {
        ...state.transactions,
        sell: { ...state.transactions.sell, status: "confirmed" },
      },
    };
    if (broadcast) writeState(stateFile, state);
    return summary;
  } finally {
    await provider.destroy();
  }
}

async function main() {
  try {
    const summary = await runRoundtrip();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "roundtrip_failed", error: sanitizeError(error) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
