// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Executes one native-asset GMGN copy buy and its Builder payment atomically.
/// @dev Transaction envelope selection (legacy versus EIP-1559) belongs to the signer.
///      This contract guarantees that the swap, output sweep, and tip are one EVM
///      transaction: a failure in any step reverts every preceding step.
contract GmgnAtomicCopyExecutor {
    bytes4 public constant GMGN_SWAP_SELECTOR = 0x4d819a2a;
    bytes4 public constant BLOCKRAZOR_PROXY_BID_SELECTOR = 0xbd69ffca;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    address public immutable owner;
    address public immutable router;

    uint256 private _reentrancyStatus = _NOT_ENTERED;

    error NotOwner();
    error Reentrancy();
    error ZeroAddress();
    error RouterCalldataTooShort(uint256 actualLength);
    error UnsupportedRouterSelector(bytes4 actualSelector);
    error IncorrectNativeValue(uint256 actual, uint256 required);
    error InvalidBlockWindow(uint256 currentBlock, uint256 validUntilBlock);
    error OutputBalanceDecreased(uint256 beforeBalance, uint256 afterBalance);
    error NoTokenOutput();
    error InsufficientTokenOutput(uint256 actual, uint256 minimum);
    error OutputSweepIncomplete(uint256 expectedBalance, uint256 actualBalance);
    error InvalidTipRecipient(address recipient);
    error InvalidPrivateAddress(address candidate);
    error DuplicatePrivateAddress(address candidate);
    error InvalidProxyBidContract(address candidate);
    error ZeroProxyBid();
    error OwnerBalanceDecreased(uint256 beforeBalance, uint256 afterBalance);
    error NoOwnerTokenOutput();
    error InsufficientOwnerTokenOutput(uint256 actual, uint256 minimum);
    error RouterCallFailed(bytes result);
    error TokenCallFailed(address token, bytes4 selector, bytes result);
    error NativeTransferFailed(address recipient, uint256 amount, bytes result);
    error ProxyBidCallFailed(address proxyBidContract, bytes result);

    event AtomicCopyExecuted(
        address indexed tokenOut,
        uint256 tokenAmountOut,
        uint256 swapValueWei,
        address indexed tipRecipient,
        uint256 builderTipWei,
        bytes32 routerCallHash
    );
    event AtomicCopyExecutedV2(
        address indexed tokenOut,
        uint256 tokenAmountOut,
        uint256 swapValueWei,
        address indexed tipRecipient,
        uint256 builderTipWei,
        uint256 validUntilBlock,
        bytes32 routerCallHash
    );
    event PrivateAtomicCopyExecuted(
        address indexed tokenOut,
        uint256 ownerTokenAmountOut,
        address indexed proxyBidContract
    );
    event TokenRecovered(address indexed token, uint256 amount);
    event NativeRecovered(uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyStatus != _NOT_ENTERED) revert Reentrancy();
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    constructor(address owner_, address router_) {
        if (owner_ == address(0) || router_ == address(0)) revert ZeroAddress();
        owner = owner_;
        router = router_;
    }

    /// @notice Accepts native-asset refunds and forced/recovery funding.
    receive() external payable {}

    /// @notice Atomically calls the immutable GMGN router, sweeps new output, then pays a Builder.
    /// @param tokenOut Token that the router calldata must deliver to this executor.
    /// @param swapValueWei Native asset forwarded to the GMGN router.
    /// @param minimumTokenOut Independent output floor checked against this contract's balance delta.
    /// @param tipRecipient Builder payment recipient. Use address(0) to pay block.coinbase.
    /// @param builderTipWei Native Builder payment sent only after the swap and output sweep succeed.
    /// @param routerCalldata Complete GMGN router calldata beginning with 0x4d819a2a.
    function executeCopyBuy(
        address tokenOut,
        uint256 swapValueWei,
        uint256 minimumTokenOut,
        address tipRecipient,
        uint256 builderTipWei,
        bytes calldata routerCalldata
    ) external payable onlyOwner nonReentrant returns (uint256 tokenAmountOut) {
        if (tokenOut == address(0)) revert ZeroAddress();
        _validateRouterCalldata(routerCalldata);

        uint256 requiredNative = swapValueWei + builderTipWei;
        if (msg.value != requiredNative) {
            revert IncorrectNativeValue(msg.value, requiredNative);
        }

        tokenAmountOut = _swapAndSweep(
            tokenOut,
            swapValueWei,
            minimumTokenOut,
            routerCalldata
        );
        address resolvedTipRecipient = _payBuilderTip(
            tipRecipient,
            builderTipWei
        );

        emit AtomicCopyExecuted(
            tokenOut,
            tokenAmountOut,
            swapValueWei,
            resolvedTipRecipient,
            builderTipWei,
            keccak256(routerCalldata)
        );
    }

    /// @notice Expiring version used by the production public-orderflow signer.
    /// @dev The legacy executeCopyBuy selector remains for compatibility only.
    function executeCopyBuyV2(
        address tokenOut,
        uint256 swapValueWei,
        uint256 minimumTokenOut,
        address tipRecipient,
        uint256 builderTipWei,
        uint256 validUntilBlock,
        bytes calldata routerCalldata
    ) external payable onlyOwner nonReentrant returns (uint256 tokenAmountOut) {
        _validateBlockWindow(validUntilBlock);
        if (tokenOut == address(0)) revert ZeroAddress();
        _validateRouterCalldata(routerCalldata);

        uint256 requiredNative = swapValueWei + builderTipWei;
        if (msg.value != requiredNative) {
            revert IncorrectNativeValue(msg.value, requiredNative);
        }

        tokenAmountOut = _swapAndSweepOwnerFloor(
            tokenOut,
            swapValueWei,
            minimumTokenOut,
            routerCalldata
        );
        address resolvedTipRecipient = _payBuilderTip(
            tipRecipient,
            builderTipWei
        );

        emit AtomicCopyExecutedV2(
            tokenOut,
            tokenAmountOut,
            swapValueWei,
            resolvedTipRecipient,
            builderTipWei,
            validUntilBlock,
            keccak256(routerCalldata)
        );
    }

    /// @notice Atomically swaps, verifies the owner's actual token delta, then
    ///         performs BlockRazor's fixed proxyBid(address,uint256) call.
    /// @dev No caller-supplied proxy calldata is accepted. Any proxy failure
    ///      reverts the preceding router call and token sweep as one transaction.
    function executePrivateCopyBuy(
        address tokenOut,
        uint256 swapValueWei,
        uint256 minimumOwnerTokenOut,
        address proxyBidContract,
        address refundAddress,
        uint256 refundCfg,
        uint256 proxyBidWei,
        uint256 validUntilBlock,
        bytes calldata routerCalldata
    ) external payable onlyOwner nonReentrant returns (uint256 ownerTokenAmountOut) {
        _validateBlockWindow(validUntilBlock);
        if (tokenOut == address(0)) revert ZeroAddress();
        _validateRouterCalldata(routerCalldata);
        _validatePrivateAddresses(tokenOut, proxyBidContract, refundAddress);
        if (proxyBidWei == 0) revert ZeroProxyBid();

        uint256 requiredNative = swapValueWei + proxyBidWei;
        if (msg.value != requiredNative) {
            revert IncorrectNativeValue(msg.value, requiredNative);
        }

        ownerTokenAmountOut = _swapAndSweepOwnerFloor(
            tokenOut,
            swapValueWei,
            minimumOwnerTokenOut,
            routerCalldata
        );

        bytes memory proxyBidCalldata = abi.encodeWithSelector(
            BLOCKRAZOR_PROXY_BID_SELECTOR,
            refundAddress,
            refundCfg
        );
        (bool proxyBidOk, bytes memory proxyBidResult) = proxyBidContract.call{
            value: proxyBidWei
        }(proxyBidCalldata);
        if (!proxyBidOk) {
            revert ProxyBidCallFailed(proxyBidContract, proxyBidResult);
        }

        _emitPrivateExecution(tokenOut, ownerTokenAmountOut, proxyBidContract);

    }

    function _validateBlockWindow(uint256 validUntilBlock) private view {
        if (
            validUntilBlock == 0 ||
            block.number > validUntilBlock ||
            validUntilBlock > block.number + 1
        ) {
            revert InvalidBlockWindow(block.number, validUntilBlock);
        }
    }

    function _validatePrivateAddresses(
        address tokenOut,
        address proxyBidContract,
        address refundAddress
    ) private view {
        if (proxyBidContract == address(0)) {
            revert InvalidPrivateAddress(proxyBidContract);
        }
        if (refundAddress == address(0)) {
            revert InvalidPrivateAddress(refundAddress);
        }
        if (proxyBidContract == refundAddress) {
            revert DuplicatePrivateAddress(proxyBidContract);
        }
        if (
            proxyBidContract == address(this) ||
            proxyBidContract == owner ||
            proxyBidContract == router ||
            proxyBidContract == tokenOut
        ) {
            revert InvalidPrivateAddress(proxyBidContract);
        }
        if (
            refundAddress == address(this) ||
            refundAddress == owner ||
            refundAddress == router ||
            refundAddress == tokenOut
        ) {
            revert InvalidPrivateAddress(refundAddress);
        }
        if (proxyBidContract.code.length == 0) {
            revert InvalidProxyBidContract(proxyBidContract);
        }
    }

    function _validateRouterCalldata(bytes calldata routerCalldata) private pure {
        if (routerCalldata.length < 4) {
            revert RouterCalldataTooShort(routerCalldata.length);
        }

        bytes4 actualSelector;
        assembly ("memory-safe") {
            actualSelector := calldataload(routerCalldata.offset)
        }
        if (actualSelector != GMGN_SWAP_SELECTOR) {
            revert UnsupportedRouterSelector(actualSelector);
        }
    }

    function _swapAndSweep(
        address tokenOut,
        uint256 swapValueWei,
        uint256 minimumTokenOut,
        bytes calldata routerCalldata
    ) private returns (uint256 tokenAmountOut) {
        uint256 balanceBefore = _safeBalanceOf(tokenOut, address(this));
        (bool routerOk, bytes memory routerResult) = router.call{ value: swapValueWei }(
            routerCalldata
        );
        if (!routerOk) revert RouterCallFailed(routerResult);

        uint256 balanceAfter = _safeBalanceOf(tokenOut, address(this));
        if (balanceAfter < balanceBefore) {
            revert OutputBalanceDecreased(balanceBefore, balanceAfter);
        }
        tokenAmountOut = balanceAfter - balanceBefore;
        if (tokenAmountOut == 0) revert NoTokenOutput();
        if (tokenAmountOut < minimumTokenOut) {
            revert InsufficientTokenOutput(tokenAmountOut, minimumTokenOut);
        }

        _safeTransfer(tokenOut, owner, tokenAmountOut);
        uint256 balanceAfterSweep = _safeBalanceOf(tokenOut, address(this));
        if (balanceAfterSweep != balanceBefore) {
            revert OutputSweepIncomplete(balanceBefore, balanceAfterSweep);
        }
    }

    /// @dev Measures the final owner delta, not merely the Executor's router
    ///      receipt. This keeps the production floor meaningful for tokens
    ///      that tax the subsequent Executor -> owner transfer.
    function _swapAndSweepOwnerFloor(
        address tokenOut,
        uint256 swapValueWei,
        uint256 minimumOwnerTokenOut,
        bytes calldata routerCalldata
    ) private returns (uint256 ownerTokenAmountOut) {
        uint256 ownerBalanceBefore = _safeBalanceOf(tokenOut, owner);
        _swapAndSweep(tokenOut, swapValueWei, 0, routerCalldata);
        uint256 ownerBalanceAfter = _safeBalanceOf(tokenOut, owner);
        if (ownerBalanceAfter < ownerBalanceBefore) {
            revert OwnerBalanceDecreased(ownerBalanceBefore, ownerBalanceAfter);
        }
        ownerTokenAmountOut = ownerBalanceAfter - ownerBalanceBefore;
        if (ownerTokenAmountOut == 0) revert NoOwnerTokenOutput();
        if (ownerTokenAmountOut < minimumOwnerTokenOut) {
            revert InsufficientOwnerTokenOutput(
                ownerTokenAmountOut,
                minimumOwnerTokenOut
            );
        }
    }

    function _emitPrivateExecution(
        address tokenOut,
        uint256 ownerTokenAmountOut,
        address proxyBidContract
    ) private {
        emit PrivateAtomicCopyExecuted(
            tokenOut,
            ownerTokenAmountOut,
            proxyBidContract
        );
    }

    function _payBuilderTip(
        address tipRecipient,
        uint256 builderTipWei
    ) private returns (address resolvedTipRecipient) {
        resolvedTipRecipient = tipRecipient;
        if (builderTipWei != 0) {
            if (resolvedTipRecipient == address(0)) {
                resolvedTipRecipient = block.coinbase;
            }
            if (
                resolvedTipRecipient == address(0) ||
                resolvedTipRecipient == address(this)
            ) {
                revert InvalidTipRecipient(resolvedTipRecipient);
            }

            (bool tipOk, bytes memory tipResult) = resolvedTipRecipient.call{
                value: builderTipWei
            }("");
            if (!tipOk) {
                revert NativeTransferFailed(
                    resolvedTipRecipient,
                    builderTipWei,
                    tipResult
                );
            }
        }
    }

    /// @notice Recovers tokens that predated an execution or were sent accidentally.
    function recoverToken(
        address token,
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        _safeTransfer(token, owner, amount);
        emit TokenRecovered(token, amount);
    }

    /// @notice Recovers native refunds, forced funds, or accidental deposits.
    function recoverNative(
        uint256 amount
    ) external onlyOwner nonReentrant {
        (bool ok, bytes memory result) = owner.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed(owner, amount, result);
        emit NativeRecovered(amount);
    }

    function _safeBalanceOf(
        address token,
        address account
    ) private view returns (uint256 balance) {
        bytes4 selector = 0x70a08231;
        bytes memory data = abi.encodeWithSelector(selector, account);
        (bool ok, bytes memory result) = token.staticcall(data);
        if (!ok || result.length < 32) {
            revert TokenCallFailed(token, selector, result);
        }
        balance = abi.decode(result, (uint256));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        bytes4 selector = 0xa9059cbb;
        bytes memory data = abi.encodeWithSelector(selector, to, amount);
        (bool ok, bytes memory result) = token.call(data);
        if (!ok || !_isOptionalBooleanSuccess(result)) {
            revert TokenCallFailed(token, selector, result);
        }
    }

    function _isOptionalBooleanSuccess(
        bytes memory result
    ) private pure returns (bool) {
        if (result.length == 0) return true;
        if (result.length < 32) return false;

        uint256 returnedValue;
        assembly ("memory-safe") {
            returnedValue := mload(add(result, 32))
        }
        return returnedValue == 1;
    }
}
