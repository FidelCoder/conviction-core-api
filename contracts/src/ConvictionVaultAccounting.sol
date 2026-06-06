// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "./interfaces/IERC20.sol";
import { ConvictionVaultState } from "./ConvictionVaultState.sol";

abstract contract ConvictionVaultAccounting is ConvictionVaultState {
    constructor(address initialOwner) ConvictionVaultState(initialOwner) { }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();

        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotAuthorized();

        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function setPaused(bool nextPaused) external onlyOwner {
        paused = nextPaused;
        emit PauseStatusUpdated(nextPaused);
    }

    function setLiquidationRecipient(address nextLiquidationRecipient) external onlyOwner {
        if (nextLiquidationRecipient == address(0)) revert InvalidAddress();

        liquidationRecipient = nextLiquidationRecipient;
        emit LiquidationRecipientUpdated(nextLiquidationRecipient);
    }

    function setAdapter(address adapter, bool enabled) external onlyOwner {
        if (adapter == address(0)) revert InvalidAddress();

        authorizedAdapters[adapter] = enabled;
        emit AdapterUpdated(adapter, enabled);
    }

    function setCollateralSupport(address collateralToken, bool enabled) external onlyOwner {
        setCollateralPolicy(
            collateralToken,
            enabled,
            MAX_LEVERAGE_BPS,
            type(uint256).max,
            DEFAULT_MAINTENANCE_MARGIN_BPS,
            type(uint256).max,
            type(uint256).max
        );
    }

    function setCollateralPolicy(
        address collateralToken,
        bool enabled,
        uint256 maxLeverageBps,
        uint256 maxIntentCollateral,
        uint256 maintenanceMarginBps,
        uint256 maxAccountBorrowed,
        uint256 maxAccountExposure
    ) public onlyOwner {
        if (collateralToken == address(0) || collateralToken.code.length == 0) {
            revert InvalidAddress();
        }

        if (enabled) {
            if (maxLeverageBps < BPS || maxLeverageBps > MAX_LEVERAGE_BPS) {
                revert InvalidLeverage();
            }
            if (maxIntentCollateral == 0) revert AmountRequired();
            if (maintenanceMarginBps == 0 || maintenanceMarginBps > BPS) {
                revert InvalidMarginRequirement();
            }
        }

        collateralPolicies[collateralToken] = CollateralPolicy({
            enabled: enabled,
            maxLeverageBps: maxLeverageBps,
            maxIntentCollateral: maxIntentCollateral,
            maintenanceMarginBps: maintenanceMarginBps,
            maxAccountBorrowed: maxAccountBorrowed,
            maxAccountExposure: maxAccountExposure
        });

        emit CollateralSupportUpdated(collateralToken, enabled);
        emit CollateralPolicyUpdated(
            collateralToken,
            enabled,
            maxLeverageBps,
            maxIntentCollateral,
            maintenanceMarginBps,
            maxAccountBorrowed,
            maxAccountExposure
        );
    }

    function setOperator(address operator, bool enabled) external onlyOwner {
        if (operator == address(0)) revert InvalidAddress();

        authorizedOperators[operator] = enabled;
        emit OperatorUpdated(operator, enabled);
    }

    function deposit(address collateralToken, uint256 amount) external nonReentrant whenNotPaused {
        _requireSupportedCollateral(collateralToken);
        if (amount == 0) revert AmountRequired();

        uint256 balanceBefore = IERC20(collateralToken).balanceOf(address(this));
        _safeTransferFrom(collateralToken, msg.sender, address(this), amount);
        uint256 receivedAmount = IERC20(collateralToken).balanceOf(address(this)) - balanceBefore;
        if (receivedAmount != amount) revert TransferFailed();

        availableBalance[msg.sender][collateralToken] += receivedAmount;

        emit Deposited(msg.sender, collateralToken, receivedAmount);
    }

    function withdraw(address collateralToken, uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountRequired();

        uint256 available = availableBalance[msg.sender][collateralToken];
        if (available < amount) revert InsufficientAvailableBalance();

        availableBalance[msg.sender][collateralToken] = available - amount;
        _safeTransfer(collateralToken, msg.sender, amount);

        emit Withdrawn(msg.sender, collateralToken, amount);
    }

    function calculateIntentAmounts(uint256 collateralAmount, uint256 leverageBps)
        public
        pure
        returns (uint256 notionalAmount, uint256 borrowedAmount)
    {
        if (collateralAmount == 0) revert AmountRequired();
        if (leverageBps < BPS || leverageBps > MAX_LEVERAGE_BPS) revert InvalidLeverage();

        notionalAmount = collateralAmount * leverageBps / BPS;
        borrowedAmount = notionalAmount - collateralAmount;
    }

    function getAccountCollateral(address account, address collateralToken)
        external
        view
        returns (uint256 available, uint256 lockedAmount)
    {
        return (availableBalance[account][collateralToken], lockedBalance[account][collateralToken]);
    }

    function getAccountMarginState(address account, address collateralToken)
        external
        view
        returns (
            uint256 available,
            uint256 lockedAmount,
            uint256 borrowedNotional,
            uint256 exposureNotional,
            uint256 healthBps,
            bool belowMaintenance
        )
    {
        AccountRisk memory risk = accountRisk[account][collateralToken];
        uint256 lockedAmount_ = lockedBalance[account][collateralToken];
        uint256 healthBps_ = _calculateHealthBps(lockedAmount_, risk.exposureNotional);
        CollateralPolicy memory policy = collateralPolicies[collateralToken];

        return (
            availableBalance[account][collateralToken],
            lockedAmount_,
            risk.borrowedNotional,
            risk.exposureNotional,
            healthBps_,
            risk.exposureNotional > 0 && policy.enabled && healthBps_ < policy.maintenanceMarginBps
        );
    }

    function getAccountHealthBps(address account, address collateralToken)
        external
        view
        returns (uint256)
    {
        return _calculateHealthBps(
            lockedBalance[account][collateralToken],
            accountRisk[account][collateralToken].exposureNotional
        );
    }

    function _validateNextAccountRisk(
        address account,
        address collateralToken,
        uint256 collateralAmount,
        uint256 borrowedAmount,
        uint256 notionalAmount,
        CollateralPolicy memory policy
    ) internal view {
        AccountRisk memory currentRisk = accountRisk[account][collateralToken];
        uint256 nextBorrowed = currentRisk.borrowedNotional + borrowedAmount;
        uint256 nextExposure = currentRisk.exposureNotional + notionalAmount;
        uint256 nextLocked = lockedBalance[account][collateralToken] + collateralAmount;

        if (nextBorrowed > policy.maxAccountBorrowed) revert AccountBorrowLimitExceeded();
        if (nextExposure > policy.maxAccountExposure) revert AccountExposureLimitExceeded();
        if (_calculateHealthBps(nextLocked, nextExposure) < policy.maintenanceMarginBps) {
            revert AccountHealthTooLow();
        }
    }

    function _addAccountRisk(
        address account,
        address collateralToken,
        uint256 borrowedAmount,
        uint256 notionalAmount
    ) internal {
        AccountRisk storage risk = accountRisk[account][collateralToken];
        risk.borrowedNotional += borrowedAmount;
        risk.exposureNotional += notionalAmount;

        emit AccountRiskUpdated(
            account,
            collateralToken,
            risk.borrowedNotional,
            risk.exposureNotional,
            _calculateHealthBps(lockedBalance[account][collateralToken], risk.exposureNotional)
        );
    }

    function _removeAccountRisk(
        address account,
        address collateralToken,
        uint256 borrowedAmount,
        uint256 notionalAmount
    ) internal {
        AccountRisk storage risk = accountRisk[account][collateralToken];
        risk.borrowedNotional -= borrowedAmount;
        risk.exposureNotional -= notionalAmount;

        emit AccountRiskUpdated(
            account,
            collateralToken,
            risk.borrowedNotional,
            risk.exposureNotional,
            _calculateHealthBps(lockedBalance[account][collateralToken], risk.exposureNotional)
        );
    }

    function _calculateHealthBps(uint256 collateralAmount, uint256 exposureAmount)
        internal
        pure
        returns (uint256)
    {
        if (exposureAmount == 0) return type(uint256).max;

        return collateralAmount * BPS / exposureAmount;
    }

    function _checkAdapter() internal view override {
        if (!authorizedAdapters[msg.sender]) revert NotAuthorized();
    }

    function _checkNotPaused() internal view override {
        if (paused) revert VaultPaused();
    }

    function _checkOwner() internal view override {
        if (msg.sender != owner) revert NotAuthorized();
    }

    function _checkOperator() internal view override {
        if (!authorizedOperators[msg.sender]) revert NotAuthorized();
    }

    function _nonReentrantBefore() internal override {
        if (locked) revert ReentrantCall();
        locked = true;
    }

    function _nonReentrantAfter() internal override {
        locked = false;
    }

    function _requireSupportedCollateral(address collateralToken)
        internal
        view
        returns (CollateralPolicy memory policy)
    {
        policy = collateralPolicies[collateralToken];
        if (!policy.enabled) revert CollateralNotSupported(collateralToken);
    }

    function _releaseMarginIntent(MarginIntent storage intent) internal {
        lockedBalance[intent.account][intent.collateralToken] -= intent.collateralAmount;
        availableBalance[intent.account][intent.collateralToken] += intent.collateralAmount;
        _removeAccountRisk(
            intent.account, intent.collateralToken, intent.borrowedAmount, intent.notionalAmount
        );
    }

    function _seizeMarginIntent(MarginIntent storage intent, address recipient) internal {
        if (recipient == address(0)) revert InvalidAddress();

        lockedBalance[intent.account][intent.collateralToken] -= intent.collateralAmount;
        availableBalance[recipient][intent.collateralToken] += intent.collateralAmount;
        _removeAccountRisk(
            intent.account, intent.collateralToken, intent.borrowedAmount, intent.notionalAmount
        );
    }

    function _safeTransfer(address collateralToken, address to, uint256 amount) private {
        _callOptionalReturn(collateralToken, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _safeTransferFrom(address collateralToken, address from, address to, uint256 amount)
        private
    {
        _callOptionalReturn(
            collateralToken, abi.encodeCall(IERC20.transferFrom, (from, to, amount))
        );
    }

    function _callOptionalReturn(address token, bytes memory data) private {
        if (token.code.length == 0) revert TransferFailed();

        (bool success, bytes memory returndata) = token.call(data);
        if (!success) revert TransferFailed();
        if (returndata.length > 0 && !abi.decode(returndata, (bool))) revert TransferFailed();
    }
}
