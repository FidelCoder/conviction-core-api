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
        uint256 totalShares;     // total vault shares outstanding
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

    // ---------------------------------------------------------------
    //  Storage
    // ---------------------------------------------------------------

    address public owner;
    address public operator; // can write options and settle
    bool public paused;

    // Vault share accounting per underlying token
    mapping(address underlyingToken => VaultShare share) public vaultShares;

    // User share balance per underlying token
    mapping(address underlyingToken => mapping(address user => uint256 shares)) public userShares;

    // Active covered calls per underlying token
    mapping(address underlyingToken => mapping(uint256 optionId => CoveredCall call)) public coveredCalls;
    mapping(address underlyingToken => uint256) public nextOptionId;

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

    event OperatorUpdated(address indexed operator, bool enabled);
    event PauseStatusUpdated(bool paused);
    event TokenSupportUpdated(address indexed token, bool supported);

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
        owner = initialOwner;
        operator = initialOwner;
    }
}
