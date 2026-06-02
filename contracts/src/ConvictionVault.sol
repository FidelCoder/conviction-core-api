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
        CANCELLED,
        EXECUTED,
        FAILED
    }

    struct CollateralPolicy {
        bool enabled;
        uint256 maxLeverageBps;
        uint256 maxIntentCollateral;
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
        IntentStatus status;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_LEVERAGE_BPS = 100_000;
    uint256 public constant MAX_SLIPPAGE_BPS = 2_000;

    address public owner;
    uint256 public nextIntentNonce;
    bool public paused;
    bool private locked;

    mapping(address collateralToken => CollateralPolicy policy) public collateralPolicies;
    mapping(address operator => bool enabled) public authorizedOperators;
    mapping(address account => mapping(address collateralToken => uint256 amount)) public
        availableBalance;
    mapping(address account => mapping(address collateralToken => uint256 amount)) public
        lockedBalance;
    mapping(bytes32 intentId => MarginIntent intent) public marginIntents;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PauseStatusUpdated(bool paused);
    event CollateralSupportUpdated(address indexed collateralToken, bool enabled);
    event CollateralPolicyUpdated(
        address indexed collateralToken,
        bool enabled,
        uint256 maxLeverageBps,
        uint256 maxIntentCollateral
    );
    event OperatorUpdated(address indexed operator, bool enabled);
    event Deposited(address indexed account, address indexed collateralToken, uint256 amount);
    event Withdrawn(address indexed account, address indexed collateralToken, uint256 amount);
    event MarginIntentCreated(
        bytes32 indexed intentId,
        address indexed account,
        bytes32 indexed marketId,
        bytes32 offchainPositionId,
        Side side,
        address collateralToken,
        uint256 collateralAmount,
        uint256 leverageBps
    );
    event MarginIntentCancelled(bytes32 indexed intentId, address indexed account);
    event MarginIntentEmergencyCancelled(
        bytes32 indexed intentId, address indexed account, bytes32 reasonCode
    );
    event MarginIntentFailed(
        bytes32 indexed intentId, address indexed operator, bytes32 reasonCode
    );
    event MarginIntentExecuted(
        bytes32 indexed intentId, address indexed operator, bytes32 executionRef
    );

    error AmountRequired();
    error CollateralLimitExceeded();
    error CollateralNotSupported(address collateralToken);
    error DeadlineExpired();
    error InsufficientAvailableBalance();
    error InvalidAddress();
    error InvalidIntentStatus();
    error InvalidLeverage();
    error InvalidReference();
    error InvalidSlippage();
    error NotAuthorized();
    error ReentrantCall();
    error TransferFailed();
    error VaultPaused();

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

    function setCollateralSupport(address collateralToken, bool enabled) external onlyOwner {
        setCollateralPolicy(collateralToken, enabled, MAX_LEVERAGE_BPS, type(uint256).max);
    }

    function setCollateralPolicy(
        address collateralToken,
        bool enabled,
        uint256 maxLeverageBps,
        uint256 maxIntentCollateral
    ) public onlyOwner {
        if (collateralToken == address(0)) revert InvalidAddress();

        if (enabled) {
            if (maxLeverageBps < BPS || maxLeverageBps > MAX_LEVERAGE_BPS) {
                revert InvalidLeverage();
            }
            if (maxIntentCollateral == 0) revert AmountRequired();
        }

        collateralPolicies[collateralToken] = CollateralPolicy({
            enabled: enabled,
            maxLeverageBps: maxLeverageBps,
            maxIntentCollateral: maxIntentCollateral
        });

        emit CollateralSupportUpdated(collateralToken, enabled);
        emit CollateralPolicyUpdated(collateralToken, enabled, maxLeverageBps, maxIntentCollateral);
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

        availableBalance[msg.sender][collateralToken] = available - collateralAmount;
        lockedBalance[msg.sender][collateralToken] += collateralAmount;

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
            leverageBps
        );
    }

    function cancelMarginIntent(bytes32 intentId) external nonReentrant {
        MarginIntent storage intent = marginIntents[intentId];
        if (intent.status != IntentStatus.PENDING) revert InvalidIntentStatus();
        if (msg.sender != intent.account && !authorizedOperators[msg.sender]) {
            revert NotAuthorized();
        }

        _unlockCollateral(intent);
        intent.status = IntentStatus.CANCELLED;

        emit MarginIntentCancelled(intentId, intent.account);
    }

    function emergencyCancelMarginIntent(bytes32 intentId, bytes32 reasonCode)
        external
        onlyOwner
        nonReentrant
    {
        MarginIntent storage intent = marginIntents[intentId];
        if (intent.status != IntentStatus.PENDING) revert InvalidIntentStatus();

        _unlockCollateral(intent);
        intent.status = IntentStatus.CANCELLED;

        emit MarginIntentEmergencyCancelled(intentId, intent.account, reasonCode);
    }

    function markMarginIntentFailed(bytes32 intentId, bytes32 reasonCode)
        external
        onlyOperator
        nonReentrant
    {
        MarginIntent storage intent = marginIntents[intentId];
        if (intent.status != IntentStatus.PENDING) revert InvalidIntentStatus();

        _unlockCollateral(intent);
        intent.status = IntentStatus.FAILED;

        emit MarginIntentFailed(intentId, msg.sender, reasonCode);
    }

    function markMarginIntentExecuted(bytes32 intentId, bytes32 executionRef)
        external
        onlyOperator
        nonReentrant
        whenNotPaused
    {
        MarginIntent storage intent = marginIntents[intentId];
        if (intent.status != IntentStatus.PENDING) revert InvalidIntentStatus();

        intent.status = IntentStatus.EXECUTED;

        emit MarginIntentExecuted(intentId, msg.sender, executionRef);
    }

    function getAccountCollateral(address account, address collateralToken)
        external
        view
        returns (uint256 available, uint256 lockedAmount)
    {
        return (availableBalance[account][collateralToken], lockedBalance[account][collateralToken]);
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

    function _unlockCollateral(MarginIntent storage intent) private {
        lockedBalance[intent.account][intent.collateralToken] -= intent.collateralAmount;
        availableBalance[intent.account][intent.collateralToken] += intent.collateralAmount;
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
