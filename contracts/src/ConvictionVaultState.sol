// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

abstract contract ConvictionVaultState {
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
    bool internal locked;

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

    function _checkAdapter() internal view virtual;

    function _checkNotPaused() internal view virtual;

    function _checkOwner() internal view virtual;

    function _checkOperator() internal view virtual;

    function _nonReentrantBefore() internal virtual;

    function _nonReentrantAfter() internal virtual;
}
