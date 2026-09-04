// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {EquityOptionsVaultState} from "./EquityOptionsVaultState.sol";

abstract contract EquityOptionsVaultAccounting is EquityOptionsVaultState {
    constructor(address initialOwner) EquityOptionsVaultState(initialOwner) {}

    // ---------------------------------------------------------------
    //  Admin
    // ---------------------------------------------------------------

    function setOperator(address nextOperator) external onlyOwner {
        operator = nextOperator;
        emit OperatorUpdated(nextOperator, true);
    }

    function setPaused(bool nextPaused) external onlyOwner {
        paused = nextPaused;
        emit PauseStatusUpdated(nextPaused);
    }

    function setTokenSupport(address underlyingToken, bool supported) external onlyOwner {
        supportedTokens[underlyingToken] = supported;
        emit TokenSupportUpdated(underlyingToken, supported);
    }

    function setStrategy(
        address underlyingToken,
        Strategy strategy,
        uint256 strikeDeltaBps,
        uint256 expirySeconds,
        uint256 volOverrideBps
    ) external onlyOwner {
        if (!supportedTokens[underlyingToken]) revert TokenNotSupported(underlyingToken);
        if (strikeDeltaBps == 0 || strikeDeltaBps > 2 * BPS) revert InvalidStrike();
        if (expirySeconds == 0) revert InvalidExpiry();

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
            // First deposit: 1:1 share ratio
            sharesMinted = received;
        } else {
            sharesMinted = (received * vs.totalShares) / vs.totalAssets;
        }

        vs.totalAssets += received;
        vs.totalShares += sharesMinted;
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

    // ---------------------------------------------------------------
    //  Internal helpers
    // ---------------------------------------------------------------

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
