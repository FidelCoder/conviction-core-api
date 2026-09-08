// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {EquityOptionsVaultState} from "./EquityOptionsVaultState.sol";

abstract contract EquityOptionsVaultAccounting is EquityOptionsVaultState {
    constructor(address initialOwner) EquityOptionsVaultState(initialOwner) {}

    // ---------------------------------------------------------------
    //  Admin — Ownership (two-step)
    // ---------------------------------------------------------------

    /// @notice Start ownership transfer. Only callable by current owner.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Accept ownership. Only callable by pending owner.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OwnershipNotPending();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------
    //  Admin — Operator
    // ---------------------------------------------------------------

    function setOperator(address nextOperator) external onlyOwner {
        if (nextOperator == address(0)) revert InvalidAddress();
        address prev = operator;
        operator = nextOperator;
        emit OperatorUpdated(prev, nextOperator);
    }

    // ---------------------------------------------------------------
    //  Admin — Pause / Token / Strategy / Oracle
    // ---------------------------------------------------------------

    function setPaused(bool nextPaused) external onlyOwner {
        paused = nextPaused;
        emit PauseStatusUpdated(nextPaused);
    }

    function setTokenSupport(address underlyingToken, bool supported) external onlyOwner {
        if (underlyingToken == address(0)) revert InvalidAddress();
        supportedTokens[underlyingToken] = supported;
        emit TokenSupportUpdated(underlyingToken, supported);
    }

    function setOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert InvalidAddress();
        address prev = oracle;
        oracle = newOracle;
        emit OracleUpdated(prev, newOracle);
    }

    function setStrategy(
        address underlyingToken,
        Strategy strategy,
        uint256 strikeDeltaBps,
        uint256 expirySeconds,
        uint256 volOverrideBps
    ) external onlyOwner {
        if (!supportedTokens[underlyingToken]) revert TokenNotSupported(underlyingToken);
        if (strikeDeltaBps == 0 || strikeDeltaBps > MAX_STRIKE_DELTA_BPS) revert InvalidStrike();
        if (expirySeconds < MIN_EXPIRY || expirySeconds > MAX_EXPIRY) revert InvalidExpiry();
        if (volOverrideBps > MAX_VOL_BPS) revert InvalidStrike(); // reuse error for vol cap

        tokenStrategy[underlyingToken] = strategy;
        tokenStrategyParams[underlyingToken] = StrategyParams({
            strikeDeltaBps: strikeDeltaBps,
            expirySeconds: expirySeconds,
            volOverrideBps: volOverrideBps
        });

        emit StrategyUpdated(underlyingToken, strategy, strikeDeltaBps, expirySeconds);
    }

    // ---------------------------------------------------------------
    //  Deposit / Withdraw
    // ---------------------------------------------------------------

    function deposit(address underlyingToken, uint256 amount) external nonReentrant whenNotPaused {
        if (!supportedTokens[underlyingToken]) revert TokenNotSupported(underlyingToken);
        if (amount == 0) revert InvalidAmount();

        // Transfer underlying from user to vault
        uint256 balBefore = IERC20(underlyingToken).balanceOf(address(this));
        _safeTransferFrom(underlyingToken, msg.sender, address(this), amount);
        uint256 received = IERC20(underlyingToken).balanceOf(address(this)) - balBefore;
        if (received == 0) revert TransferFailed();

        // Mint vault shares
        VaultShare storage vs = vaultShares[underlyingToken];
        uint256 sharesMinted;
        if (vs.totalShares == 0) {
            // First deposit: mint MIN_DEAD_SHARES to dead address to prevent
            // share inflation attack, then 1:1 for the depositor.
            uint256 deadShares = MIN_DEAD_SHARES;
            vs.totalShares = deadShares + received;
            vs.totalAssets = received;
            userShares[underlyingToken][address(0xdead)] = deadShares;
            sharesMinted = received;
        } else {
            sharesMinted = (received * vs.totalShares) / vs.totalAssets;
            vs.totalAssets += received;
            vs.totalShares += sharesMinted;
        }

        if (sharesMinted == 0) revert ZeroSharesMinted();

        userShares[underlyingToken][msg.sender] += sharesMinted;

        emit Deposited(msg.sender, underlyingToken, received, sharesMinted);
    }

    function withdraw(address underlyingToken, uint256 sharesToBurn) external nonReentrant {
        if (sharesToBurn == 0) revert InvalidAmount();

        uint256 userBalance = userShares[underlyingToken][msg.sender];
        if (userBalance < sharesToBurn) revert InsufficientShares();

        VaultShare storage vs = vaultShares[underlyingToken];
        uint256 amountReturned = (sharesToBurn * vs.totalAssets) / vs.totalShares;
        if (amountReturned == 0) revert InvalidAmount();

        // Check there's enough unlocked underlying (not locked by active options)
        uint256 totalLocked = _getTotalLocked(underlyingToken);
        uint256 available = vs.totalAssets - totalLocked;
        if (available < amountReturned) revert InsufficientBalance();

        vs.totalAssets -= amountReturned;
        vs.totalShares -= sharesToBurn;
        userShares[underlyingToken][msg.sender] -= sharesToBurn;

        _safeTransfer(underlyingToken, msg.sender, amountReturned);

        emit Withdrawn(msg.sender, underlyingToken, sharesToBurn, amountReturned);
    }

    // ---------------------------------------------------------------
    //  Views
    // ---------------------------------------------------------------

    function getSharePrice(address underlyingToken) external view returns (uint256) {
        VaultShare storage vs = vaultShares[underlyingToken];
        if (vs.totalShares == 0) return 1e18; // default 1:1
        return (vs.totalAssets * 1e18) / vs.totalShares;
    }

    function getUserBalance(address underlyingToken, address user) external view returns (uint256 shares, uint256 underlyingAmount) {
        shares = userShares[underlyingToken][user];
        VaultShare storage vs = vaultShares[underlyingToken];
        if (vs.totalShares > 0) {
            underlyingAmount = (shares * vs.totalAssets) / vs.totalShares;
        }
    }

    function getVaultStats(address underlyingToken)
        external
        view
        returns (
            uint256 totalAssets,
            uint256 totalShares,
            uint256 totalPremiumEarned,
            uint256 sharePrice,
            uint256 lockedAmount
        )
    {
        VaultShare storage vs = vaultShares[underlyingToken];
        totalAssets = vs.totalAssets;
        totalShares = vs.totalShares;
        totalPremiumEarned = vs.totalPremiumEarned;
        sharePrice = vs.totalShares > 0 ? (vs.totalAssets * 1e18) / vs.totalShares : 1e18;
        lockedAmount = _getTotalLocked(underlyingToken);
    }

    function getUtilizationBps(address underlyingToken) external view returns (uint256) {
        VaultShare storage vs = vaultShares[underlyingToken];
        if (vs.totalAssets == 0) return 0;
        uint256 locked = _getTotalLocked(underlyingToken);
        return (locked * BPS) / vs.totalAssets;
    }

    // ---------------------------------------------------------------
    //  Internal helpers
    // ---------------------------------------------------------------

    /// @notice Sum collateralLocked across all ACTIVE options. O(activeCount) not O(totalCreated).
    function _getTotalLocked(address underlyingToken) internal view returns (uint256 total) {
        uint256 count = nextOptionId[underlyingToken];
        for (uint256 i = 0; i < count; i++) {
            CoveredCall storage cc = coveredCalls[underlyingToken][i];
            if (cc.status == OptionStatus.ACTIVE) {
                total += cc.collateralLocked;
            }
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount)
        );
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
