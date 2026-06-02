// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "./interfaces/IERC20.sol";

contract ConvictionVault {
    enum Side {
        YES,
        NO
    }

    enum IntentStatus {
        NONE,
        PENDING,
        SUBMITTED,
        EXECUTED,
        FAILED,
        CANCELLED,
        CLOSED,
        LIQUIDATED
    }

    enum AdapterStatus {
        NONE,
        SUBMITTED,
        CONFIRMED,
        FAILED,
        CANCELLED
    }

    struct AccountRisk {
        uint256 borrowedNotional;
        uint256 exposureNotional;
    }

    struct AdapterRecord {
        address adapter;
        AdapterStatus status;
        bytes32 externalRef;
        bytes32 failureCode;
        uint256 submittedAt;
        uint256 updatedAt;
    }

    struct CollateralPolicy {
        bool enabled;
        uint256 maxLeverageBps;
        uint256 maxIntentCollateral;
        uint256 maintenanceMarginBps;
        uint256 maxAccountBorrowed;
        uint256 maxAccountExposure;
    }

    struct MarginIntent {
        address account;
        address collateralToken;
        bytes32 marketId;
        bytes32 offchainPositionId;
        Side side;
        uint256 collateralAmount;
        uint256 leverageBps;
        uint256 maxSlippageBps;
        uint256 deadline;
        uint256 createdAt;
        uint256 notionalAmount;
        uint256 borrowedAmount;
        uint256 maintenanceMarginBps;
        IntentStatus status;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant DEFAULT_MAINTENANCE_MARGIN_BPS = 1_000;
    uint256 public constant MAX_LEVERAGE_BPS = 100_000;
    uint256 public constant MAX_SLIPPAGE_BPS = 2_000;

    address public owner;
    uint256 public nextIntentNonce;
    bool public paused;
    bool private locked;

    mapping(address collateralToken => CollateralPolicy policy) public collateralPolicies;
    mapping(address adapter => bool enabled) public authorizedAdapters;
    mapping(address operator => bool enabled) public authorizedOperators;
    mapping(address account => mapping(address collateralToken => uint256 amount)) public
        availableBalance;
    mapping(address account => mapping(address collateralToken => uint256 amount)) public
        lockedBalance;
    mapping(address account => mapping(address collateralToken => AccountRisk risk)) public
        accountRisk;
    mapping(bytes32 intentId => AdapterRecord record) public adapterRecords;
    mapping(bytes32 intentId => MarginIntent intent) public marginIntents;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PauseStatusUpdated(bool paused);
    event AdapterUpdated(address indexed adapter, bool enabled);
    event CollateralSupportUpdated(address indexed collateralToken, bool enabled);
    event CollateralPolicyUpdated(
        address indexed collateralToken,
        bool enabled,
        uint256 maxLeverageBps,
        uint256 maxIntentCollateral,
        uint256 maintenanceMarginBps,
        uint256 maxAccountBorrowed,
        uint256 maxAccountExposure
    );
    event OperatorUpdated(address indexed operator, bool enabled);
    event Deposited(address indexed account, address indexed collateralToken, uint256 amount);
    event Withdrawn(address indexed account, address indexed collateralToken, uint256 amount);
    event AccountRiskUpdated(
        address indexed account,
        address indexed collateralToken,
        uint256 borrowedNotional,
        uint256 exposureNotional,
        uint256 healthBps
    );
    event MarginIntentCreated(
        bytes32 indexed intentId,
        address indexed account,
        bytes32 indexed marketId,
        bytes32 offchainPositionId,
        Side side,
        address collateralToken,
        uint256 collateralAmount,
        uint256 leverageBps,
        uint256 notionalAmount,
        uint256 borrowedAmount
    );
    event MarginIntentSubmitted(
        bytes32 indexed intentId, address indexed adapter, bytes32 externalRef
    );
    event MarginIntentCancelled(bytes32 indexed intentId, address indexed account);
    event MarginIntentClosed(bytes32 indexed intentId, address indexed operator, bytes32 closeRef);
    event MarginIntentEmergencyCancelled(
        bytes32 indexed intentId, address indexed account, bytes32 reasonCode
    );
    event MarginIntentFailed(bytes32 indexed intentId, address indexed adapter, bytes32 reasonCode);
    event MarginIntentExecuted(
        bytes32 indexed intentId, address indexed adapter, bytes32 executionRef
    );
    event MarginIntentLiquidated(
        bytes32 indexed intentId, address indexed operator, bytes32 liquidationRef
    );

    error AccountBorrowLimitExceeded();
    error AccountExposureLimitExceeded();
    error AccountHealthTooLow();
    error AdapterAlreadySubmitted();
    error AmountRequired();
    error CollateralLimitExceeded();
    error CollateralNotSupported(address collateralToken);
    error DeadlineExpired();
    error HealthyAccount();
    error InsufficientAvailableBalance();
    error InvalidAddress();
    error InvalidAdapterStatus();
    error InvalidIntentStatus();
    error InvalidLeverage();
    error InvalidMarginRequirement();
    error InvalidReference();
    error InvalidSlippage();
    error NotAuthorized();
    error ReentrantCall();
    error TransferFailed();
    error VaultPaused();

    modifier onlyAdapter() {
        _checkAdapter();
        _;
    }

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    modifier onlyOperator() {
        _checkOperator();
        _;
    }

    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    modifier whenNotPaused() {
        _checkNotPaused();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();

        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();

        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setPaused(bool nextPaused) external onlyOwner {
        paused = nextPaused;
        emit PauseStatusUpdated(nextPaused);
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
        if (collateralToken == address(0)) revert InvalidAddress();

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

        _safeTransferFrom(collateralToken, msg.sender, address(this), amount);
        availableBalance[msg.sender][collateralToken] += amount;

        emit Deposited(msg.sender, collateralToken, amount);
    }

    function withdraw(address collateralToken, uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountRequired();

        uint256 available = availableBalance[msg.sender][collateralToken];
        if (available < amount) revert InsufficientAvailableBalance();

        availableBalance[msg.sender][collateralToken] = available - amount;
        _safeTransfer(collateralToken, msg.sender, amount);

        emit Withdrawn(msg.sender, collateralToken, amount);
    }

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

    function _validateNextAccountRisk(
        address account,
        address collateralToken,
        uint256 collateralAmount,
        uint256 borrowedAmount,
        uint256 notionalAmount,
        CollateralPolicy memory policy
    ) private view {
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
    ) private {
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
    ) private {
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
        private
        pure
        returns (uint256)
    {
        if (exposureAmount == 0) return type(uint256).max;

        return collateralAmount * BPS / exposureAmount;
    }

    function _checkAdapter() private view {
        if (!authorizedAdapters[msg.sender]) revert NotAuthorized();
    }

    function _checkNotPaused() private view {
        if (paused) revert VaultPaused();
    }

    function _checkOwner() private view {
        if (msg.sender != owner) revert NotAuthorized();
    }

    function _checkOperator() private view {
        if (!authorizedOperators[msg.sender]) revert NotAuthorized();
    }

    function _nonReentrantBefore() private {
        if (locked) revert ReentrantCall();
        locked = true;
    }

    function _nonReentrantAfter() private {
        locked = false;
    }

    function _requireSupportedCollateral(address collateralToken)
        private
        view
        returns (CollateralPolicy memory policy)
    {
        policy = collateralPolicies[collateralToken];
        if (!policy.enabled) revert CollateralNotSupported(collateralToken);
    }

    function _releaseMarginIntent(MarginIntent storage intent) private {
        lockedBalance[intent.account][intent.collateralToken] -= intent.collateralAmount;
        availableBalance[intent.account][intent.collateralToken] += intent.collateralAmount;
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
        (bool success, bytes memory returndata) = token.call(data);
        if (!success) revert TransferFailed();
        if (returndata.length > 0 && !abi.decode(returndata, (bool))) revert TransferFailed();
    }
}
