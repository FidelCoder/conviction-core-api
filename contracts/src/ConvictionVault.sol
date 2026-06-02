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
    bool private locked;

    mapping(address collateralToken => bool enabled) public supportedCollateral;
    mapping(address operator => bool enabled) public authorizedOperators;
    mapping(address account => mapping(address collateralToken => uint256 amount)) public
        availableBalance;
    mapping(address account => mapping(address collateralToken => uint256 amount)) public
        lockedBalance;
    mapping(bytes32 intentId => MarginIntent intent) public marginIntents;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event CollateralSupportUpdated(address indexed collateralToken, bool enabled);
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
    event MarginIntentFailed(
        bytes32 indexed intentId, address indexed operator, bytes32 reasonCode
    );
    event MarginIntentExecuted(
        bytes32 indexed intentId, address indexed operator, bytes32 executionRef
    );

    error AmountRequired();
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

    function setCollateralSupport(address collateralToken, bool enabled) external onlyOwner {
        if (collateralToken == address(0)) revert InvalidAddress();

        supportedCollateral[collateralToken] = enabled;
        emit CollateralSupportUpdated(collateralToken, enabled);
    }

    function setOperator(address operator, bool enabled) external onlyOwner {
        if (operator == address(0)) revert InvalidAddress();

        authorizedOperators[operator] = enabled;
        emit OperatorUpdated(operator, enabled);
    }

    function deposit(address collateralToken, uint256 amount) external nonReentrant {
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
    ) external nonReentrant returns (bytes32 intentId) {
        _requireSupportedCollateral(collateralToken);
        if (marketId == bytes32(0) || offchainPositionId == bytes32(0)) revert InvalidReference();
        if (collateralAmount == 0) revert AmountRequired();
        if (leverageBps < BPS || leverageBps > MAX_LEVERAGE_BPS) revert InvalidLeverage();
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
    {
        MarginIntent storage intent = marginIntents[intentId];
        if (intent.status != IntentStatus.PENDING) revert InvalidIntentStatus();

        intent.status = IntentStatus.EXECUTED;

        emit MarginIntentExecuted(intentId, msg.sender, executionRef);
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

    function _requireSupportedCollateral(address collateralToken) private view {
        if (!supportedCollateral[collateralToken]) revert CollateralNotSupported(collateralToken);
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
