import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddress, keccak256, parseEther, parseUnits, toUtf8Bytes, } from "ethers";
import { BuilderClient, DEFAULT_BUILDERS, } from "./builders.js";
import { fastGmgnBuyTemplate, finalTokenFromGmgnCalldata, GMGN_ROUTER_ADDRESS, } from "./core/gmgn-calldata.js";
import { validateTargetSignal, } from "./core/messages.js";
import { HotSigner } from "./hot-signer.js";
import { ExecutorRpcClient, } from "./rpc-client.js";
export const BLOCKRAZOR_ONEOFF_CONFIRMATION = "I_ACCEPT_ONE_BLOCKRAZOR_0.001_BNB_BUY_PLUS_EXPLICIT_TIP";
export const BLOCKRAZOR_ONEOFF_AMOUNT_WEI = parseEther("0.001");
export const BLOCKRAZOR_ONEOFF_EXPECTED_TOKEN = getAddress("0x5e88b8fb2a9c501eceb186476797882dee087777");
const FINALITY_BLOCKS = 2;
const MAX_SAME_ENVELOPE_DISPATCHES = 2;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
function rpcQuantity(value, field) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
        throw new Error(field + " is not an RPC quantity");
    }
    return BigInt(value);
}
function hexQuantity(value) {
    if (value < 0n)
        throw new Error("negative RPC quantity");
    return `0x${value.toString(16)}`;
}
function exactReceipt(left, right) {
    return left.transactionHash === right.transactionHash
        && left.blockHash === right.blockHash
        && left.blockNumber === right.blockNumber
        && left.transactionIndex === right.transactionIndex
        && left.status === right.status
        && left.gasUsed === right.gasUsed.toString()
        && left.effectiveGasPrice === right.effectiveGasPrice.toString();
}
function storedReceipt(value) {
    return {
        transactionHash: value.transactionHash,
        blockHash: value.blockHash,
        blockNumber: value.blockNumber,
        transactionIndex: value.transactionIndex,
        status: value.status,
        gasUsed: value.gasUsed.toString(),
        effectiveGasPrice: value.effectiveGasPrice.toString(),
    };
}
function fsyncDirectory(path) {
    try {
        const descriptor = openSync(dirname(path), constants.O_RDONLY);
        try {
            fsyncSync(descriptor);
        }
        finally {
            closeSync(descriptor);
        }
    }
    catch (error) {
        const code = error.code;
        if (!new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR", "EACCES"]).has(code ?? ""))
            throw error;
    }
}
/** First publication is O_EXCL+fsync, so no network write can precede the journal. */
export function createOneOffStateExclusive(path, state) {
    const target = resolve(path);
    const descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
        writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
    fsyncDirectory(target);
}
export function persistOneOffState(path, state) {
    const target = resolve(path);
    const temporary = `${target}.${process.pid}.tmp`;
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
        writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
    renameSync(temporary, target);
    fsyncDirectory(target);
}
export function readOneOffState(path) {
    const target = resolve(path);
    const stats = lstatSync(target);
    if (!stats.isFile() || stats.isSymbolicLink())
        throw new Error("one-off state must be a regular non-symlink file");
    if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
        throw new Error("one-off state mode must be 0600");
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(target, "utf8"));
    }
    catch {
        throw new Error("one-off state is unreadable or malformed");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("one-off state is invalid");
    const state = parsed;
    if (state.version !== 1 || state.kind !== "blockrazor_oneoff_public_buy"
        || !new Set(["prepared", "submitted", "included", "not_included", "unresolved"]).has(state.stage)
        || !HASH_RE.test(state.targetHash ?? "") || !HASH_RE.test(state.buyHash ?? "")
        || !HASH_RE.test(state.tipHash ?? "") || !HASH_RE.test(state.envelopeBodyHash ?? "")
        || !Number.isSafeInteger(state.nonce) || state.nonce < 0
        || !Number.isSafeInteger(state.envelopeMaxBlock) || state.envelopeMaxBlock <= 0
        || !Number.isSafeInteger(state.dispatchAttempts) || state.dispatchAttempts < 0) {
        throw new Error("one-off state schema is invalid");
    }
    return state;
}
function expectedStateMatches(actual, expected) {
    const immutableKeys = [
        "version", "kind", "strategy", "signer", "targetHash", "targetBlock", "targetBlockHash",
        "amountWei", "tipWei", "gasPriceWei", "gasLimit", "nonce", "tokenOut", "calldataHash",
        "buyHash", "tipHash", "envelopeMaxBlock", "envelopeMaxTimestamp", "envelopeBodyHash",
    ];
    for (const key of immutableKeys) {
        if (actual[key] !== expected[key])
            throw new Error(`one-off state ${String(key)} does not match this run`);
    }
}
async function defaultWaitForBlock(minimumBlock, rpc, deadlineMonoNs) {
    for (;;) {
        if (process.hrtime.bigint() >= deadlineMonoNs)
            throw new Error("one-off total wait timeout elapsed");
        const current = await rpc.blockNumber();
        if (current >= minimumBlock)
            return current;
        await new Promise((resolveWait) => {
            const remainingMs = Math.max(1, Number(deadlineMonoNs - process.hrtime.bigint()) / 1e6);
            setTimeout(resolveWait, Math.min(250, remainingMs));
        });
    }
}
function summary(mode, state, gasEstimate, maximumCost) {
    return {
        mode,
        stage: state.stage,
        strategy: state.strategy,
        signer: state.signer,
        targetHash: state.targetHash,
        targetBlock: state.targetBlock,
        tokenOut: state.tokenOut,
        nonce: state.nonce,
        buyHash: state.buyHash,
        tipHash: state.tipHash,
        envelopeMaxBlock: state.envelopeMaxBlock,
        gasEstimate: gasEstimate.toString(),
        maximumCostWei: maximumCost.toString(),
        dispatchAttempts: state.dispatchAttempts,
        bundleIds: [...state.bundleIds],
        actualCostWei: state.actualCostWei,
        reason: state.reason,
    };
}
async function stableReceipts(rpc, buyHash, tipHash) {
    const [buy, tip] = await Promise.all([rpc.receipt(buyHash), rpc.receipt(tipHash)]);
    const [confirmedBuy, confirmedTip] = await Promise.all([rpc.receipt(buyHash), rpc.receipt(tipHash)]);
    const stable = (buy === null ? confirmedBuy === null : confirmedBuy !== null && exactReceipt(storedReceipt(buy), confirmedBuy))
        && (tip === null ? confirmedTip === null : confirmedTip !== null && exactReceipt(storedReceipt(tip), confirmedTip));
    return { buy: confirmedBuy, tip: confirmedTip, stable };
}
function terminal(stage) {
    return stage === "included" || stage === "not_included" || stage === "unresolved";
}
export async function runBlockRazorOneOff(options) {
    if (options.confirmation !== BLOCKRAZOR_ONEOFF_CONFIRMATION)
        throw new Error("one-off confirmation is invalid");
    if (options.strategy !== "ed" && options.strategy !== "kuzuo")
        throw new Error("one-off strategy is invalid");
    if (!HASH_RE.test(options.targetHash))
        throw new Error("one-off target hash is invalid");
    if (options.amountWei !== BLOCKRAZOR_ONEOFF_AMOUNT_WEI)
        throw new Error("one-off buy amount must be exactly 0.001 BNB");
    if (options.tipWei <= 0n)
        throw new Error("one-off BlockRazor tip must be positive");
    if (options.gasPriceWei <= 0n || options.gasLimit < 21000n)
        throw new Error("one-off gas settings are invalid");
    if (getAddress(options.expectedToken) !== BLOCKRAZOR_ONEOFF_EXPECTED_TOKEN) {
        throw new Error("one-off expected token is not the user-confirmed AI contract");
    }
    if (getAddress(options.expectedSigner) !== options.signer.address) {
        throw new Error("one-off HotSigner does not match the frozen production lane identity");
    }
    const totalTimeoutMs = options.totalTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1_000 || totalTimeoutMs > 120_000) {
        throw new Error("one-off total timeout must be between 1000 and 120000ms");
    }
    if (options.builder.config.name !== "blockrazor"
        || options.builder.config.url !== DEFAULT_BUILDERS.blockrazor.url
        || getAddress(options.builder.config.tipRecipient) !== getAddress(DEFAULT_BUILDERS.blockrazor.tipRecipient)
        || !options.builder.config.authorization) {
        throw new Error("one-off runner accepts only the pinned authenticated BlockRazor Builder");
    }
    if (!options.preflightOnly && !options.stateFile)
        throw new Error("broadcast mode requires an independent state file");
    const now = options.now ?? (() => new Date());
    const deadlineMonoNs = process.hrtime.bigint() + (BigInt(totalTimeoutMs) * 1000000n);
    const waitForBlock = options.waitForBlock
        ?? ((minimumBlock, rpcClient) => (defaultWaitForBlock(minimumBlock, rpcClient, deadlineMonoNs)));
    const signer = options.signer;
    const rpc = options.rpc;
    const builder = options.builder;
    try {
        await rpc.assertBscChain();
        const target = await rpc.minedTargetTransaction(options.targetHash, 1_000);
        if (!target)
            throw new Error("historical target transaction was not returned");
        const targetReceipt = await rpc.receipt(options.targetHash);
        if (!targetReceipt || targetReceipt.status !== 1
            || targetReceipt.blockNumber !== target.blockNumber
            || targetReceipt.blockHash !== target.blockHash) {
            throw new Error("historical target is not a successful canonical transaction");
        }
        validateTargetSignal({
            version: 1,
            source: "confirmed_log_fallback",
            sourceSequence: `blockrazor-oneoff:${options.strategy}:${options.targetHash}`,
            firstSeenUnixNs: (BigInt(now().valueOf()) * 1000000n).toString(),
            firstSeenMonoNs: process.hrtime.bigint().toString(),
            strategy: options.strategy,
            transaction: target.transaction,
            sourceBlockHint: target.blockNumber,
        });
        const tokenOut = finalTokenFromGmgnCalldata(target.transaction.input);
        if (getAddress(tokenOut) !== BLOCKRAZOR_ONEOFF_EXPECTED_TOKEN) {
            throw new Error("historical target does not buy the user-confirmed AI contract");
        }
        const template = fastGmgnBuyTemplate({
            targetTo: target.transaction.to,
            targetInput: target.transaction.input,
            targetValueWei: BigInt(target.transaction.valueWei),
            followAmountInWei: options.amountWei,
        });
        if (template.valueWei !== options.amountWei
            || template.differingWordIndexes.some((index) => index !== 2 && index !== 3 && index !== 4)) {
            throw new Error("one-off calldata rewrite violated the audited mutation set");
        }
        const call = {
            from: signer.address,
            to: GMGN_ROUTER_ADDRESS,
            value: hexQuantity(options.amountWei),
            data: template.calldata,
            gas: hexQuantity(options.gasLimit),
            gasPrice: hexQuantity(options.gasPriceWei),
        };
        const callResult = await rpc.request("eth_call", [call, "pending"]);
        if (typeof callResult !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(callResult)) {
            throw new Error("one-off eth_call returned invalid data");
        }
        const gasEstimate = rpcQuantity(await rpc.request("eth_estimateGas", [call, "pending"]), "one-off gas estimate");
        if (gasEstimate < 21000n || gasEstimate > options.gasLimit) {
            throw new Error("one-off gas estimate exceeds the signed gas limit");
        }
        const maximumCost = options.amountWei + options.tipWei
            + ((options.gasLimit + 21000n) * options.gasPriceWei);
        if (await rpc.balance(signer.address) < maximumCost)
            throw new Error("one-off wallet balance is below maximum cost");
        await builder.prewarm();
        const builderSnapshot = builder.snapshot();
        if (builderSnapshot.readyChannels !== 2)
            throw new Error("both BlockRazor channels must be submit-capable");
        let persisted = !options.preflightOnly && options.stateFile && existsSync(options.stateFile)
            ? readOneOffState(options.stateFile)
            : null;
        const fresh = persisted === null;
        let nonce;
        let envelopeMaxBlock;
        let envelopeMaxTimestamp;
        if (persisted) {
            nonce = persisted.nonce;
            envelopeMaxBlock = persisted.envelopeMaxBlock;
            envelopeMaxTimestamp = persisted.envelopeMaxTimestamp;
        }
        else {
            const [latestNonce, pendingNonce, head] = await Promise.all([
                rpc.latestNonce(signer.address),
                rpc.pendingNonce(signer.address),
                rpc.blockNumber(),
            ]);
            if (latestNonce !== pendingNonce)
                throw new Error("one-off requires latest nonce to equal pending nonce");
            nonce = pendingNonce;
            envelopeMaxBlock = head + 1;
            envelopeMaxTimestamp = Math.floor(now().valueOf() / 1_000) + 60;
        }
        signer.prewarm();
        const buy = signer.signDirectGmgnBuy({
            routerCalldata: template.calldata,
            swapValueWei: options.amountWei,
            nonce,
            gasPriceWei: options.gasPriceWei,
            gasLimit: options.gasLimit,
        });
        const tip = signer.signBuilderTip({
            tipRecipient: DEFAULT_BUILDERS.blockrazor.tipRecipient,
            builderTipWei: options.tipWei,
            nonce: nonce + 1,
            gasPriceWei: options.gasPriceWei,
        });
        const prepared = builder.prepare({
            target: {
                kind: "confirmedNextBlock",
                targetHash: options.targetHash,
                targetBlock: target.blockNumber,
            },
            strategyTxs: [buy.rawTransaction, tip.rawTransaction],
            maxBlockNumber: envelopeMaxBlock,
            maxTimestamp: envelopeMaxTimestamp,
            noMerge: true,
            positionFirst: false,
        });
        const timestamp = now().toISOString();
        const expected = {
            version: 1,
            kind: "blockrazor_oneoff_public_buy",
            stage: "prepared",
            strategy: options.strategy,
            signer: signer.address,
            targetHash: options.targetHash.toLowerCase(),
            targetBlock: target.blockNumber,
            targetBlockHash: target.blockHash,
            amountWei: options.amountWei.toString(),
            tipWei: options.tipWei.toString(),
            gasPriceWei: options.gasPriceWei.toString(),
            gasLimit: options.gasLimit.toString(),
            nonce,
            tokenOut,
            calldataHash: keccak256(template.calldata),
            buyHash: buy.hash,
            tipHash: tip.hash,
            envelopeMaxBlock,
            envelopeMaxTimestamp,
            envelopeBodyHash: keccak256(toUtf8Bytes(prepared.body)),
            dispatchAttempts: 0,
            bundleIds: [],
            lastAckHttpStatus: null,
            buyReceipt: null,
            tipReceipt: null,
            actualCostWei: null,
            reason: null,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        if (options.preflightOnly) {
            return {
                ...summary("preflight-only", expected, gasEstimate, maximumCost),
                stage: "preflight",
            };
        }
        const stateFile = options.stateFile;
        if (persisted) {
            expectedStateMatches(persisted, expected);
            if (terminal(persisted.stage))
                return summary("broadcast", persisted, gasEstimate, maximumCost);
        }
        else {
            try {
                createOneOffStateExclusive(stateFile, expected);
                persisted = expected;
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
                persisted = readOneOffState(stateFile);
                expectedStateMatches(persisted, expected);
            }
        }
        let state = persisted;
        // A preflight can go stale before its first write. Recheck both authoritative
        // nonce views immediately before the first possible Builder dispatch.
        if (fresh && state.dispatchAttempts === 0) {
            const [latestNonce, pendingNonce] = await Promise.all([
                rpc.latestNonce(signer.address),
                rpc.pendingNonce(signer.address),
            ]);
            if (latestNonce !== nonce || pendingNonce !== nonce) {
                state = { ...state, stage: "unresolved", reason: "nonce_changed_before_dispatch", updatedAt: now().toISOString() };
                persistOneOffState(stateFile, state);
                return summary("broadcast", state, gasEstimate, maximumCost);
            }
        }
        // A freshly journaled attempt cannot already have receipts: neither raw
        // transaction has been exposed to a network yet.  Do not spend a BSC block
        // querying four guaranteed-null receipts before the first fixed-head
        // dispatch.  Resume/reconciliation paths still prove both receipts twice.
        const firstFreshDispatch = fresh && state.dispatchAttempts === 0;
        const currentReceipts = firstFreshDispatch
            ? { buy: null, tip: null, stable: true }
            : await stableReceipts(rpc, buy.hash, tip.hash);
        if (!currentReceipts.stable) {
            state = { ...state, stage: "unresolved", reason: "receipt_changed_during_reconciliation", updatedAt: now().toISOString() };
            persistOneOffState(stateFile, state);
            return summary("broadcast", state, gasEstimate, maximumCost);
        }
        // The head used to create envelopeMaxBlock was read after all expensive
        // preflight work.  For the first network write, dispatch immediately after
        // the authoritative nonce recheck and fsynced journal.  If the envelope is
        // already stale, BlockRazor can only reject it; it cannot include it late.
        let currentBlock = firstFreshDispatch
            ? envelopeMaxBlock - 1
            : await rpc.blockNumber();
        if (!currentReceipts.buy && !currentReceipts.tip && currentBlock < envelopeMaxBlock) {
            while (state.dispatchAttempts < MAX_SAME_ENVELOPE_DISPATCHES && currentBlock < envelopeMaxBlock) {
                if (process.hrtime.bigint() >= deadlineMonoNs)
                    throw new Error("one-off total wait timeout elapsed");
                // Persist the possible network write before invoking dispatch. Every
                // retry reuses this exact PreparedBuilderSubmission and fixed maxBlock.
                state = {
                    ...state,
                    stage: "submitted",
                    dispatchAttempts: state.dispatchAttempts + 1,
                    updatedAt: now().toISOString(),
                };
                persistOneOffState(stateFile, state);
                const ack = await builder.dispatch(prepared);
                state = {
                    ...state,
                    bundleIds: ack.accepted && ack.bundleId && !state.bundleIds.includes(ack.bundleId)
                        ? [...state.bundleIds, ack.bundleId]
                        : state.bundleIds,
                    lastAckHttpStatus: ack.httpStatus,
                    updatedAt: now().toISOString(),
                };
                persistOneOffState(stateFile, state);
                if (ack.accepted)
                    break;
                currentBlock = await rpc.blockNumber();
            }
        }
        await waitForBlock(envelopeMaxBlock + FINALITY_BLOCKS, rpc);
        const receipts = await stableReceipts(rpc, buy.hash, tip.hash);
        if (!receipts.stable) {
            state = { ...state, stage: "unresolved", reason: "receipt_not_stable_after_finality", updatedAt: now().toISOString() };
        }
        else if (receipts.buy && receipts.tip) {
            state.buyReceipt = storedReceipt(receipts.buy);
            state.tipReceipt = storedReceipt(receipts.tip);
            if (receipts.buy.status !== 1 || receipts.tip.status !== 1
                || receipts.buy.blockNumber !== receipts.tip.blockNumber
                || receipts.tip.transactionIndex <= receipts.buy.transactionIndex) {
                state = { ...state, stage: "unresolved", reason: "buy_tip_receipt_order_or_status_invalid", updatedAt: now().toISOString() };
            }
            else {
                const actualCost = options.amountWei + options.tipWei
                    + (receipts.buy.gasUsed * receipts.buy.effectiveGasPrice)
                    + (receipts.tip.gasUsed * receipts.tip.effectiveGasPrice);
                state = {
                    ...state,
                    stage: "included",
                    actualCostWei: actualCost.toString(),
                    reason: null,
                    updatedAt: now().toISOString(),
                };
            }
        }
        else if (receipts.buy || receipts.tip) {
            state.buyReceipt = receipts.buy ? storedReceipt(receipts.buy) : null;
            state.tipReceipt = receipts.tip ? storedReceipt(receipts.tip) : null;
            state = { ...state, stage: "unresolved", reason: "only_one_of_buy_and_tip_has_a_receipt", updatedAt: now().toISOString() };
        }
        else {
            const [latestNonce, pendingNonce] = await Promise.all([
                rpc.latestNonce(signer.address),
                rpc.pendingNonce(signer.address),
            ]);
            state = latestNonce === nonce && pendingNonce === nonce
                ? { ...state, stage: "not_included", reason: "fixed_next_block_envelope_expired", updatedAt: now().toISOString() }
                : { ...state, stage: "unresolved", reason: "nonce_advanced_without_both_receipts", updatedAt: now().toISOString() };
        }
        persistOneOffState(stateFile, state);
        return summary("broadcast", state, gasEstimate, maximumCost);
    }
    finally {
        await options.builder.close();
    }
}
function secureFile(path, label, maximumBytes) {
    const target = resolve(path);
    const stats = lstatSync(target);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maximumBytes) {
        throw new Error(label + " must be a bounded regular non-symlink file");
    }
    return readFileSync(target, "utf8").trim();
}
function blockRazorAuthorization(path) {
    let authorization = null;
    for (const entry of secureFile(path, "Builder auth file", 16_384).split(/[;,\n]/)) {
        const item = entry.trim();
        if (!item)
            continue;
        const separator = item.indexOf("=");
        if (separator <= 0)
            throw new Error("Builder auth entries must use provider=value");
        if (item.slice(0, separator).trim().toLowerCase() === "blockrazor") {
            if (authorization !== null)
                throw new Error("Builder auth contains duplicate BlockRazor entries");
            authorization = item.slice(separator + 1).trim();
        }
    }
    if (!authorization)
        throw new Error("BlockRazor authorization is unavailable");
    return authorization;
}
function parseCli(argv) {
    const values = new Map();
    let preflightOnly = false;
    let broadcast = false;
    for (let index = 0; index < argv.length; index += 1) {
        const item = argv[index];
        if (item === "--preflight-only") {
            preflightOnly = true;
            continue;
        }
        if (item === "--broadcast") {
            broadcast = true;
            continue;
        }
        if (!item.startsWith("--") || index + 1 >= argv.length)
            throw new Error("one-off CLI arguments are invalid");
        if (values.has(item))
            throw new Error("one-off CLI argument is duplicated");
        values.set(item, argv[++index]);
    }
    const allowed = new Set([
        "--confirmation", "--strategy", "--target-hash", "--amount-bnb", "--tip-bnb",
        "--expected-token", "--expected-signer", "--gas-price-gwei", "--gas-limit", "--state-file", "--timeout-ms",
    ]);
    for (const key of values.keys())
        if (!allowed.has(key))
            throw new Error("unknown one-off CLI argument");
    if (preflightOnly === broadcast)
        throw new Error("select exactly one of --preflight-only or --broadcast");
    const required = (name) => {
        const value = values.get(name)?.trim();
        if (!value)
            throw new Error(name + " is required");
        return value;
    };
    const strategy = required("--strategy");
    if (strategy !== "ed" && strategy !== "kuzuo")
        throw new Error("--strategy must be ed or kuzuo");
    const targetHash = required("--target-hash");
    if (!HASH_RE.test(targetHash))
        throw new Error("--target-hash is invalid");
    const gasLimit = BigInt(required("--gas-limit"));
    return {
        confirmation: required("--confirmation"),
        strategy,
        targetHash: targetHash.toLowerCase(),
        amountWei: parseEther(required("--amount-bnb")),
        tipWei: parseEther(required("--tip-bnb")),
        expectedToken: required("--expected-token"),
        expectedSigner: required("--expected-signer"),
        gasPriceWei: parseUnits(required("--gas-price-gwei"), "gwei"),
        gasLimit,
        stateFile: values.get("--state-file")?.trim() || null,
        preflightOnly,
        ...(values.has("--timeout-ms") ? { totalTimeoutMs: Number(required("--timeout-ms")) } : {}),
    };
}
function sanitizedError(error) {
    return String(error instanceof Error ? error.message : error)
        .replace(/https?:\/\/\S+/gi, "[redacted-url]")
        .replace(/(?:0x)?[0-9a-fA-F]{64,}/g, "[redacted-hex]")
        .slice(0, 500);
}
async function main() {
    try {
        const input = parseCli(process.argv.slice(2));
        const rpcUrl = process.env.BSC_EXECUTOR_HTTP_RPC_URL?.trim();
        const authFile = process.env.COPYTRADE_BUILDER_AUTH_FILE?.trim();
        const keyFile = process.env[input.strategy === "ed" ? "ED_COPY_PRIVATE_KEY_FILE" : "KUZUO_COPY_PRIVATE_KEY_FILE"]?.trim();
        if (!rpcUrl)
            throw new Error("BSC_EXECUTOR_HTTP_RPC_URL is required");
        if (!authFile)
            throw new Error("COPYTRADE_BUILDER_AUTH_FILE is required");
        if (!keyFile)
            throw new Error("selected lane private-key file is required");
        const privateKey = secureFile(keyFile, "private-key file", 256);
        if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(privateKey))
            throw new Error("private-key file is invalid");
        const signer = new HotSigner(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
        const rpc = new ExecutorRpcClient(rpcUrl);
        const builder = new BuilderClient({
            ...DEFAULT_BUILDERS.blockrazor,
            authorization: blockRazorAuthorization(authFile),
        });
        const result = await runBlockRazorOneOff({ ...input, signer, rpc, builder });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    catch (error) {
        process.stderr.write(`${JSON.stringify({ status: "blockrazor_oneoff_failed", error: sanitizedError(error) })}\n`);
        process.exitCode = 1;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    await main();
//# sourceMappingURL=blockrazor-oneoff.js.map