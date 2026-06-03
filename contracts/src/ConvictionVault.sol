// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ConvictionVaultAccounting } from "./ConvictionVaultAccounting.sol";

contract ConvictionVault is ConvictionVaultAccounting {
    constructor(address initialOwner) ConvictionVaultAccounting(initialOwner) { }

    function createMarginIntent(
        address collateralToken,
        bytes32 marketId,
        Side side,
        uint256 collateralAmount,
        uint256 leverageBps,
        uint256 maxSlippageBps,
        uint256 deadline,
        bytes32 offchainPositionId
    ) external nonReentrant whenNotPaused returns (bytes32 intentId) {
        CollateralPolicy memory policy = _requireSupportedCollateral(collateralToken);
        if (marketId == bytes32(0) || offchainPositionId == bytes32(0)) revert InvalidReference();
        if (collateralAmount == 0) revert AmountRequired();
        if (leverageBps < BPS || leverageBps > policy.maxLeverageBps) revert InvalidLeverage();
        if (collateralAmount > policy.maxIntentCollateral) revert CollateralLimitExceeded();
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert InvalidSlippage();
        if (deadline <= block.timestamp) revert DeadlineExpired();

        uint256 available = availableBalance[msg.sender][collateralToken];
        if (available < collateralAmount) revert InsufficientAvailableBalance();

        (uint256 notionalAmount, uint256 borrowedAmount) =
            calculateIntentAmounts(collateralAmount, leverageBps);
        _validateNextAccountRisk(
            msg.sender, collateralToken, collateralAmount, borrowedAmount, notionalAmount, policy
        );

        availableBalance[msg.sender][collateralToken] = available - collateralAmount;
        lockedBalance[msg.sender][collateralToken] += collateralAmount;
        _addAccountRisk(msg.sender, collateralToken, borrowedAmount, notionalAmount);

        intentId = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                msg.sender,
                collateralToken,
                marketId,
                offchainPositionId,
                nextIntentNonce++
            )
        );

        marginIntents[intentId] = MarginIntent({
            account: msg.sender,
            collateralToken: collateralToken,
            marketId: marketId,
            offchainPositionId: offchainPositionId,
            side: side,
            collateralAmount: collateralAmount,
            leverageBps: leverageBps,
            maxSlippageBps: maxSlippageBps,
            deadline: deadline,
            createdAt: block.timestamp,
            notionalAmount: notionalAmount,
            borrowedAmount: borrowedAmount,
            maintenanceMarginBps: policy.maintenanceMarginBps,
            status: IntentStatus.PENDING
        });

        emit MarginIntentCreated(
            intentId,
            msg.sender,
            marketId,
            offchainPositionId,
            side,
            collateralToken,
            collateralAmount,
            leverageBps,
            notionalAmount,
            borrowedAmount
        );
    }

    function submitMarginIntent(bytes32 intentId, bytes32 externalRef)
        external
        onlyAdapter
        whenNotPaused
    {
        MarginIntent storage intent = marginIntents[intentId];
        if (intent.status != IntentStatus.PENDING) revert InvalidIntentStatus();
        if (adapterRecords[intentId].status != AdapterStatus.NONE) {
            revert AdapterAlreadySubmitted();
        }

        intent.status = IntentStatus.SUBMITTED;
        adapterRecords[intentId] = AdapterRecord({
            adapter: msg.sender,
            status: AdapterStatus.SUBMITTED,
            externalRef: externalRef,
            failureCode: bytes32(0),
            submittedAt: block.timestamp,
            updatedAt: block.timestamp
        });

        emit MarginIntentSubmitted(intentId, msg.sender, externalRef);
    }

    function confirmMarginIntent(bytes32 intentId, bytes32 executionRef)
        external
        onlyAdapter
        nonReentrant
        whenNotPaused
    {
        AdapterRecord storage record = adapterRecords[intentId];
        MarginIntent storage intent = marginIntents[intentId];
        if (record.adapter != msg.sender) revert NotAuthorized();
        if (record.status != AdapterStatus.SUBMITTED) revert InvalidAdapterStatus();
        if (intent.status != IntentStatus.SUBMITTED) revert InvalidIntentStatus();

        record.status = AdapterStatus.CONFIRMED;
        record.externalRef = executionRef;
        record.updatedAt = block.timestamp;
        intent.status = IntentStatus.EXECUTED;

        emit MarginIntentExecuted(intentId, msg.sender, executionRef);
    }

    function failMarginIntent(bytes32 intentId, bytes32 reasonCode)
        external
        onlyAdapter
        nonReentrant
    {
        AdapterRecord storage record = adapterRecords[intentId];
        MarginIntent storage intent = marginIntents[intentId];
        if (record.adapter != msg.sender) revert NotAuthorized();
        if (record.status != AdapterStatus.SUBMITTED) revert InvalidAdapterStatus();
        if (intent.status != IntentStatus.SUBMITTED) revert InvalidIntentStatus();

        record.status = AdapterStatus.FAILED;
        record.failureCode = reasonCode;
        record.updatedAt = block.timestamp;
        _releaseMarginIntent(intent);
        intent.status = IntentStatus.FAILED;

        emit MarginIntentFailed(intentId, msg.sender, reasonCode);
    }

    function cancelSubmittedMarginIntent(bytes32 intentId, bytes32 reasonCode)
        external
        onlyAdapter
        nonReentrant
    {
        AdapterRecord storage record = adapterRecords[intentId];
        MarginIntent storage intent = marginIntents[intentId];
        if (record.adapter != msg.sender) revert NotAuthorized();
        if (record.status != AdapterStatus.SUBMITTED) revert InvalidAdapterStatus();
        if (intent.status != IntentStatus.SUBMITTED) revert InvalidIntentStatus();

        record.status = AdapterStatus.CANCELLED;
        record.failureCode = reasonCode;
        record.updatedAt = block.timestamp;
        _releaseMarginIntent(intent);
        intent.status = IntentStatus.CANCELLED;

        emit MarginIntentCancelled(intentId, intent.account);
    }

    function cancelMarginIntent(bytes32 intentId) external nonReentrant {
        MarginIntent storage intent = marginIntents[intentId];
        if (intent.status != IntentStatus.PENDING) revert InvalidIntentStatus();
        if (msg.sender != intent.account && !authorizedOperators[msg.sender]) {
            revert NotAuthorized();
        }

        _releaseMarginIntent(intent);
        intent.status = IntentStatus.CANCELLED;

        emit MarginIntentCancelled(intentId, intent.account);
    }

    function closeExecutedMarginIntent(bytes32 intentId, bytes32 closeRef)
        external
        onlyOperator
        nonReentrant
    {
        MarginIntent storage intent = marginIntents[intentId];
        if (intent.status != IntentStatus.EXECUTED) revert InvalidIntentStatus();

        _releaseMarginIntent(intent);
        intent.status = IntentStatus.CLOSED;

        emit MarginIntentClosed(intentId, msg.sender, closeRef);
    }

    function emergencyCancelMarginIntent(bytes32 intentId, bytes32 reasonCode)
        external
        onlyOwner
        nonReentrant
    {
        MarginIntent storage intent = marginIntents[intentId];
        if (intent.status != IntentStatus.PENDING && intent.status != IntentStatus.SUBMITTED) {
            revert InvalidIntentStatus();
        }

        AdapterRecord storage record = adapterRecords[intentId];
        if (record.status == AdapterStatus.SUBMITTED) {
            record.status = AdapterStatus.CANCELLED;
            record.failureCode = reasonCode;
            record.updatedAt = block.timestamp;
        }

        _releaseMarginIntent(intent);
        intent.status = IntentStatus.CANCELLED;

        emit MarginIntentEmergencyCancelled(intentId, intent.account, reasonCode);
    }

    function liquidateMarginIntent(bytes32 intentId, bytes32 liquidationRef)
        external
        onlyOperator
        nonReentrant
    {
        MarginIntent storage intent = marginIntents[intentId];
        if (intent.status != IntentStatus.EXECUTED) revert InvalidIntentStatus();
        if (!isLiquidatable(intentId)) revert HealthyAccount();

        _releaseMarginIntent(intent);
        intent.status = IntentStatus.LIQUIDATED;

        emit MarginIntentLiquidated(intentId, msg.sender, liquidationRef);
    }

    function markMarginIntentFailed(bytes32 intentId, bytes32 reasonCode)
        external
        onlyOperator
        nonReentrant
    {
        MarginIntent storage intent = marginIntents[intentId];
        if (intent.status != IntentStatus.PENDING) revert InvalidIntentStatus();

        _releaseMarginIntent(intent);
        intent.status = IntentStatus.FAILED;

        emit MarginIntentFailed(intentId, msg.sender, reasonCode);
    }

    function isLiquidatable(bytes32 intentId) public view returns (bool) {
        MarginIntent memory intent = marginIntents[intentId];
        if (intent.status != IntentStatus.EXECUTED) return false;

        CollateralPolicy memory policy = collateralPolicies[intent.collateralToken];
        uint256 maintenanceMarginBps =
            policy.enabled ? policy.maintenanceMarginBps : intent.maintenanceMarginBps;

        return _calculateHealthBps(
            lockedBalance[intent.account][intent.collateralToken],
            accountRisk[intent.account][intent.collateralToken].exposureNotional
        ) < maintenanceMarginBps;
    }
}
