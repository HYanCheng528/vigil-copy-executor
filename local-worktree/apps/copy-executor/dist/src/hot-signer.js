import { Interface, SigningKey, Transaction, computeAddress, getAddress, keccak256, } from "ethers";
import { GMGN_ROUTER_ADDRESS } from "./core/gmgn-calldata.js";
const EXECUTOR_INTERFACE = new Interface([
    "function executeCopyBuy(address tokenOut,uint256 swapValueWei,uint256 minimumTokenOut,address tipRecipient,uint256 builderTipWei,bytes routerCalldata) payable returns (uint256 tokenAmountOut)",
    "function executeCopyBuyV2(address tokenOut,uint256 swapValueWei,uint256 minimumTokenOut,address tipRecipient,uint256 builderTipWei,uint256 validUntilBlock,bytes routerCalldata) payable returns (uint256 tokenAmountOut)",
    "function executePrivateCopyBuy(address tokenOut,uint256 swapValueWei,uint256 minimumOwnerTokenOut,address proxyBidContract,address refundAddress,uint256 refundCfg,uint256 proxyBidWei,uint256 validUntilBlock,bytes routerCalldata) payable returns (uint256 ownerTokenAmountOut)",
]);
/**
 * SigningKey signs the already-materialized legacy transaction synchronously.
 * No Promise, RPC, ENS lookup, worker hop, or filesystem access exists here.
 */
export class HotSigner {
    address;
    key;
    warmed = false;
    constructor(privateKey) {
        this.key = new SigningKey(privateKey);
        this.address = getAddress(computeAddress(this.key.publicKey));
    }
    /**
     * Pays the secp256k1/ABI/JIT cold-start cost before any target feed starts.
     * The deterministic dummy transaction is never returned or submitted.
     */
    prewarm() {
        if (this.warmed)
            return;
        this.signAtomicCopy({
            executorAddress: "0x000000000000000000000000000000000000dead",
            tokenOut: "0x0000000000000000000000000000000000000001",
            routerCalldata: "0x4d819a2a",
            swapValueWei: 1n,
            minimumTokenOut: 0n,
            tipRecipient: "0x0000000000000000000000000000000000000000",
            builderTipWei: 0n,
            validUntilBlock: 1,
            nonce: 0,
            gasPriceWei: 1000000000n,
            gasLimit: 500000n,
        });
        this.signPrivateAtomicCopy({
            executorAddress: "0x000000000000000000000000000000000000dead",
            tokenOut: "0x0000000000000000000000000000000000000001",
            routerCalldata: "0x4d819a2a",
            swapValueWei: 1n,
            minimumOwnerTokenOut: 0n,
            proxyBidContract: "0x0000000000000000000000000000000000000002",
            refundAddress: "0x0000000000000000000000000000000000000003",
            refundCfg: 0n,
            proxyBidWei: 1n,
            validUntilBlock: 1,
            nonce: 0,
            gasPriceWei: 1000000000n,
            gasLimit: 500000n,
        });
        this.signDirectGmgnBuy({
            routerCalldata: "0x4d819a2a",
            swapValueWei: 1n,
            nonce: 0,
            gasPriceWei: 1000000000n,
            gasLimit: 500000n,
        });
        this.signBuilderTip({
            tipRecipient: "0x0000000000000000000000000000000000000001",
            builderTipWei: 1n,
            nonce: 1,
            gasPriceWei: 1000000000n,
        });
        this.warmed = true;
    }
    /**
     * Public-orderflow fast path: call the audited GMGN Router directly from the
     * dedicated copy wallet. No executor wrapper, token metadata, quote or RPC is
     * needed between first-seen and signing.
     */
    signDirectGmgnBuy(request) {
        if (!Number.isSafeInteger(request.nonce) || request.nonce < 0)
            throw new Error("copy nonce is invalid");
        if (request.swapValueWei <= 0n)
            throw new Error("copy value is invalid");
        if (request.gasPriceWei <= 0n || request.gasLimit < 21000n)
            throw new Error("copy gas settings are invalid");
        if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(request.routerCalldata))
            throw new Error("GMGN calldata is invalid");
        const transaction = Transaction.from({
            type: 0,
            chainId: 56,
            nonce: request.nonce,
            gasPrice: request.gasPriceWei,
            gasLimit: request.gasLimit,
            to: GMGN_ROUTER_ADDRESS,
            value: request.swapValueWei,
            data: request.routerCalldata,
        });
        transaction.signature = this.key.sign(transaction.unsignedHash);
        const rawTransaction = transaction.serialized;
        return {
            rawTransaction,
            hash: keccak256(rawTransaction),
            data: request.routerCalldata,
            valueWei: request.swapValueWei,
            signedMonoNs: process.hrtime.bigint(),
        };
    }
    /** A provider-specific, plain 21k BNB transfer at copy nonce N+1. */
    signBuilderTip(request) {
        if (!Number.isSafeInteger(request.nonce) || request.nonce < 0)
            throw new Error("tip nonce is invalid");
        if (request.builderTipWei <= 0n || request.gasPriceWei <= 0n)
            throw new Error("Builder tip settings are invalid");
        const transaction = Transaction.from({
            type: 0,
            chainId: 56,
            nonce: request.nonce,
            gasPrice: request.gasPriceWei,
            gasLimit: 21000n,
            to: getAddress(request.tipRecipient),
            value: request.builderTipWei,
            data: "0x",
        });
        transaction.signature = this.key.sign(transaction.unsignedHash);
        const rawTransaction = transaction.serialized;
        return {
            rawTransaction,
            hash: keccak256(rawTransaction),
            data: "0x",
            valueWei: request.builderTipWei,
            signedMonoNs: process.hrtime.bigint(),
        };
    }
    signAtomicCopy(request) {
        if (!Number.isSafeInteger(request.nonce) || request.nonce < 0)
            throw new Error("copy nonce is invalid");
        if (request.swapValueWei <= 0n || request.builderTipWei < 0n)
            throw new Error("copy value/tip is invalid");
        if (request.minimumTokenOut < 0n)
            throw new Error("minimumTokenOut cannot be negative");
        assertValidUntilBlock(request.validUntilBlock);
        if (request.gasPriceWei <= 0n || request.gasLimit < 21000n)
            throw new Error("copy gas settings are invalid");
        const data = EXECUTOR_INTERFACE.encodeFunctionData("executeCopyBuyV2", [
            getAddress(request.tokenOut),
            request.swapValueWei,
            request.minimumTokenOut,
            getAddress(request.tipRecipient),
            request.builderTipWei,
            request.validUntilBlock,
            request.routerCalldata,
        ]);
        const valueWei = request.swapValueWei + request.builderTipWei;
        const transaction = Transaction.from({
            type: 0,
            chainId: 56,
            nonce: request.nonce,
            gasPrice: request.gasPriceWei,
            gasLimit: request.gasLimit,
            to: getAddress(request.executorAddress),
            value: valueWei,
            data,
        });
        transaction.signature = this.key.sign(transaction.unsignedHash);
        const rawTransaction = transaction.serialized;
        return {
            rawTransaction,
            hash: keccak256(rawTransaction),
            data,
            valueWei,
            signedMonoNs: process.hrtime.bigint(),
        };
    }
    /** Signs the dedicated BlockRazor proxyBid path synchronously. */
    signPrivateAtomicCopy(request) {
        if (!Number.isSafeInteger(request.nonce) || request.nonce < 0)
            throw new Error("copy nonce is invalid");
        if (request.swapValueWei <= 0n || request.proxyBidWei <= 0n) {
            throw new Error("private copy value/proxy bid is invalid");
        }
        if (request.minimumOwnerTokenOut < 0n)
            throw new Error("minimumOwnerTokenOut cannot be negative");
        if (request.refundCfg < 0n)
            throw new Error("refundCfg cannot be negative");
        assertValidUntilBlock(request.validUntilBlock);
        if (request.gasPriceWei <= 0n || request.gasLimit < 21000n)
            throw new Error("copy gas settings are invalid");
        const data = EXECUTOR_INTERFACE.encodeFunctionData("executePrivateCopyBuy", [
            getAddress(request.tokenOut),
            request.swapValueWei,
            request.minimumOwnerTokenOut,
            getAddress(request.proxyBidContract),
            getAddress(request.refundAddress),
            request.refundCfg,
            request.proxyBidWei,
            request.validUntilBlock,
            request.routerCalldata,
        ]);
        // BlockRazor's proxy bid replaces the ordinary Builder tip; it is never
        // paid a second time through executeCopyBuyV2.
        const valueWei = request.swapValueWei + request.proxyBidWei;
        const transaction = Transaction.from({
            type: 0,
            chainId: 56,
            nonce: request.nonce,
            gasPrice: request.gasPriceWei,
            gasLimit: request.gasLimit,
            to: getAddress(request.executorAddress),
            value: valueWei,
            data,
        });
        transaction.signature = this.key.sign(transaction.unsignedHash);
        const rawTransaction = transaction.serialized;
        return {
            rawTransaction,
            hash: keccak256(rawTransaction),
            data,
            valueWei,
            signedMonoNs: process.hrtime.bigint(),
        };
    }
}
function assertValidUntilBlock(value) {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("validUntilBlock is invalid");
}
export function atomicExecutorSelector() {
    return EXECUTOR_INTERFACE.getFunction("executeCopyBuyV2").selector;
}
export function legacyAtomicExecutorSelector() {
    return EXECUTOR_INTERFACE.getFunction("executeCopyBuy").selector;
}
export function privateAtomicExecutorSelector() {
    return EXECUTOR_INTERFACE.getFunction("executePrivateCopyBuy").selector;
}
//# sourceMappingURL=hot-signer.js.map