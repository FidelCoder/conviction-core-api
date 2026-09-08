// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

abstract contract EquityOptionsVaultState {
    // ---------------------------------------------------------------
    //  Enums
    // ---------------------------------------------------------------

    enum OptionStatus {
        NONE,
        ACTIVE,
        EXERCISED,
        EXPIRED_OTM,
        SETTLED
    }

    enum Strategy {
        CONSERVATIVE,
        MODERATE,
        AGGRESSIVE
    }

    // ---------------------------------------------------------------
    //  Structs
    // ---------------------------------------------------------------

    struct CoveredCall {
        address underlyingToken;
        uint256 strikePrice;      // in underlying token decimals (8 dec from Chainlink)
        uint256 expiry;           // block.timestamp
        uint256 premium;          // in USDC (6 dec)
        uint256 collateralLocked; // amount of underlying locked
        address seller;           // depositor who owns this position
        OptionStatus status;
        uint256 settledAt;
        uint256 settlementPrice;  // final Chainlink price at expiry
    }

    struct StrategyParams {
        uint256 strikeDeltaBps;  // e.g. 9000 = OTM 10%, 10000 = ATM, 11000 = ITM 10%
        uint256 expirySeconds;   // e.g. 7 days, 14 days, 30 days
        uint256 volOverrideBps;  // implied vol override in bps (3000 = 30%), 0 = use default
    }

    struct VaultShare {
        uint256 totalShares;     // total vault shares outstanding (excluding dead shares)
        uint256 totalAssets;     // total underlying deposited (in underlying decimals)
        uint256 totalPremiumEarned; // cumulative premium in USDC
    }

    // ---------------------------------------------------------------
    //  Constants
    // ---------------------------------------------------------------

    uint256 public constant BPS = 10_000;
    uint256 public constant USDC_DECIMALS = 6;
    uint256 public constant PRICE_DECIMALS = 8;
    uint256 public constant DEFAULT_VOL_BPS = 30_000; // 30% implied vol
    uint256 public constant RISK_FREE_RATE_BPS = 500; // 5% annual

    /// @notice Minimum shares minted on first deposit to prevent share inflation attack.
    ///         These "dead shares" are minted to address(dead) and never redeemable.
    uint256 public constant MIN_DEAD_SHARES = 1000;

    /// @notice Maximum option expiry: 90 days
    uint256 public constant MAX_EXPIRY = 90 days;

    /// @notice Minimum option expiry: 1 hour
    uint256 public constant MIN_EXPIRY = 1 hours;

    /// @notice Maximum vault utilization: 70% (7000 bps)
    uint256 public constant MAX_UTILIZATION_BPS = 7000;

    /// @notice Maximum strike delta: 150% ITM (15000 bps)
    uint256 public constant MAX_STRIKE_DELTA_BPS = 15000;

    /// @notice Maximum implied vol override: 100% (10000 bps)
    uint256 public constant MAX_VOL_BPS = 10000;

    // ---------------------------------------------------------------
    //  Storage
    // ---------------------------------------------------------------

    address public owner;
    address public pendingOwner;    // two-step ownership transfer
    address public operator;        // can write options and settle
    bool public paused;

    /// @notice Chainlink-compatible oracle address for price feeds (set by owner).
    address public oracle;

    // Vault share accounting per underlying token
    mapping(address underlyingToken => VaultShare share) public vaultShares;

    // User share balance per underlying token
    mapping(address underlyingToken => mapping(address user => uint256 shares)) public userShares;

    // Active covered calls per underlying token
    mapping(address underlyingToken => mapping(uint256 optionId => CoveredCall call)) public coveredCalls;
    mapping(address underlyingToken => uint256) public nextOptionId;

    /// @notice Count of currently ACTIVE options per token (for O(1) utilization checks).
    mapping(address underlyingToken => uint256) public activeOptionCount;

    // Strategy config per underlying token
    mapping(address underlyingToken => Strategy strategy) public tokenStrategy;
    mapping(address underlyingToken => StrategyParams strategyParams) public tokenStrategyParams;

    // Supported underlying tokens
    mapping(address underlyingToken => bool supported) public supportedTokens;

    // User's active option IDs per token
    mapping(address underlyingToken => mapping(address user => uint256[] optionIds)) public userOptions;

    // ---------------------------------------------------------------
    //  Events
    // ---------------------------------------------------------------

    event Deposited(
        address indexed user,
        address indexed underlyingToken,
        uint256 amount,
        uint256 sharesMinted
    );

    event Withdrawn(
        address indexed user,
        address indexed underlyingToken,
        uint256 sharesBurned,
        uint256 amountReturned
    );

    event CoveredCallWritten(
        address indexed underlyingToken,
        uint256 indexed optionId,
        uint256 strikePrice,
        uint256 expiry,
        uint256 premium,
        uint256 collateralLocked
    );

    event OptionSettled(
        address indexed underlyingToken,
        uint256 indexed optionId,
        OptionStatus status,
        uint256 settlementPrice,
        uint256 payout
    );

    event PremiumDistributed(
        address indexed underlyingToken,
        uint256 totalPremium,
        uint256 premiumPerShare
    );

    event StrategyUpdated(
        address indexed underlyingToken,
        Strategy strategy,
        uint256 strikeDeltaBps,
        uint256 expirySeconds
    );

    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event PauseStatusUpdated(bool paused);
    event TokenSupportUpdated(address indexed token, bool supported);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);

    // ---------------------------------------------------------------
    //  Errors
    // ---------------------------------------------------------------

    error NotAuthorized();
    error TokenNotSupported(address token);
    error InsufficientBalance();
    error InsufficientShares();
    error NoActiveOption();
    error OptionNotExpired();
    error OptionAlreadySettled();
    error VaultPaused();
    error InvalidAmount();
    error InvalidStrike();
    error InvalidExpiry();
    error ReentrantCall();
    error TransferFailed();
    error InvalidAddress();
    error ExpiryTooShort();
    error ExpiryTooLong();
    error UtilizationExceeded();
    error SettlementAmountExceeded();
    error InvalidSettlementPrice();
    error OwnershipNotPending();
    error ZeroSharesMinted();

    // ---------------------------------------------------------------
    //  Modifiers
    // ---------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotAuthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert VaultPaused();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert ReentrantCall();
        locked = true;
        _;
        locked = false;
    }

    bool private locked;

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
        owner = initialOwner;
        operator = initialOwner;
    }
}
