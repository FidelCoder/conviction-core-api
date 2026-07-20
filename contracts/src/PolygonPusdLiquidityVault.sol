// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "./interfaces/IERC20.sol";
import { IERC1155 } from "./interfaces/IERC1155.sol";
import {
    IExecutionTargetRegistry,
    PolymarketIsolatedMarginAccount
} from "./PolymarketIsolatedMarginAccount.sol";

interface IERC20Metadata is IERC20 {
    function decimals() external view returns (uint8);
}

/// @notice Polygon pUSD LP vault and one-position-per-account margin custody coordinator.
/// @dev This contract is intentionally separate from the legacy Sepolia intent vault.
contract PolygonPusdLiquidityVault is IExecutionTargetRegistry {
    enum LoanStatus {
        NONE,
        RESERVED,
        EXECUTING,
        ACTIVE,
        SETTLED,
        FAILED,
        CANCELLED
    }

    enum RedemptionStatus {
        NONE,
        PENDING,
        COMPLETED,
        CANCELLED
    }

    struct LoanRequest {
        address adapter;
        bytes32 marketId;
        uint256 traderEquity;
        uint256 borrowAssets;
        address outcomeToken;
        uint256 outcomeTokenId;
        uint256 minimumOutcomeShares;
        uint256 deadline;
    }

    struct Loan {
        address trader;
        address adapter;
        address custodyAccount;
        bytes32 marketId;
        address outcomeToken;
        uint256 outcomeTokenId;
        uint256 minimumOutcomeShares;
        uint256 securedOutcomeShares;
        uint256 traderEquity;
        uint256 borrowAssets;
        uint256 fundedAssets;
        uint256 deadline;
        LoanStatus status;
        bytes32 executionRef;
        bytes32 settlementRef;
    }

    struct RedemptionRequest {
        address owner;
        address receiver;
        uint256 shares;
        RedemptionStatus status;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant SHARE_DECIMALS_OFFSET = 6;
    uint256 private constant VIRTUAL_SHARES = 10 ** SHARE_DECIMALS_OFFSET;

    IERC20Metadata public immutable assetToken;
    uint256 public immutable deploymentChainId;
    uint8 public immutable decimals;
    string public name;
    string public symbol;

    address public owner;
    address public pendingOwner;
    bool public paused;
    bool private locked;

    uint256 public idleReserveBps = 2_000;
    uint256 public reserveFactorBps = 2_000;
    uint256 public maximumInterestBps = 5_000;
    uint256 public defaultMarketExposureCap;
    uint256 public accountExposureCap;

    uint256 public totalSupply;
    uint256 public totalReservedAssets;
    uint256 public totalBorrowedAssets;
    uint256 public totalTraderEquityHeld;
    uint256 public protocolReserves;
    uint256 public accruedProtocolFees;
    uint256 public totalInterestCollected;
    uint256 public totalBadDebt;
    uint256 public totalQueuedShares;
    uint256 public nextLoanNonce = 1;
    uint256 public nextRedemptionId = 1;
    uint256 public nextRedemptionToProcess = 1;

    mapping(address account => uint256 shares) public balanceOf;
    mapping(address account => mapping(address spender => uint256 shares)) public allowance;
    mapping(address adapter => bool enabled) public authorizedAdapters;
    mapping(address target => bool enabled) public allowedExecutionTargets;
    mapping(bytes32 marketId => uint256 cap) public marketExposureCap;
    mapping(bytes32 marketId => uint256 assets) public marketExposure;
    mapping(address trader => uint256 assets) public accountExposure;
    mapping(bytes32 loanId => Loan loan) public loans;
    mapping(uint256 requestId => RedemptionRequest request) public redemptionRequests;

    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PauseStatusUpdated(bool paused);
    event AdapterUpdated(address indexed adapter, bool enabled);
    event ExecutionTargetUpdated(address indexed target, bool enabled);
    event RiskParametersUpdated(
        uint256 idleReserveBps,
        uint256 reserveFactorBps,
        uint256 maximumInterestBps,
        uint256 defaultMarketExposureCap,
        uint256 accountExposureCap
    );
    event MarketExposureCapUpdated(bytes32 indexed marketId, uint256 cap);
    event ProtocolReserveSeeded(address indexed sender, uint256 assets);
    event ProtocolFeeAccrued(uint256 interestAssets, uint256 protocolFeeAssets);
    event ProtocolFeesAllocatedToReserve(uint256 assets);
    event LoanReserved(
        bytes32 indexed loanId,
        address indexed trader,
        address indexed custodyAccount,
        bytes32 marketId,
        uint256 traderEquity,
        uint256 borrowAssets
    );
    event LoanFunded(bytes32 indexed loanId, uint256 fundedAssets);
    event LoanActivated(
        bytes32 indexed loanId,
        uint256 traderEquity,
        uint256 principal,
        uint256 securedOutcomeShares,
        bytes32 executionRef
    );
    event LoanFailed(bytes32 indexed loanId, bytes32 reasonCode);
    event LoanCancelled(bytes32 indexed loanId);
    event LoanSettled(
        bytes32 indexed loanId,
        uint256 principalRecovered,
        uint256 interestRecovered,
        uint256 reserveCover,
        uint256 badDebt,
        uint256 traderSurplus,
        bytes32 settlementRef
    );
    event RedemptionRequested(
        uint256 indexed requestId, address indexed owner, address indexed receiver, uint256 shares
    );
    event RedemptionCompleted(
        uint256 indexed requestId, address indexed receiver, uint256 shares, uint256 assets
    );
    event RedemptionCancelled(uint256 indexed requestId, address indexed owner);

    error AccountExposureLimitExceeded();
    error AmountRequired();
    error ChainMismatch();
    error DeadlineExpired();
    error InsufficientAllowance();
    error InsufficientAssetsRecovered();
    error InsufficientLiquidity();
    error InsufficientShares();
    error InvalidAddress();
    error InvalidLoanStatus();
    error InvalidMarket();
    error InvalidParameters();
    error InvalidRedemptionStatus();
    error MarketExposureLimitExceeded();
    error NotAuthorized();
    error OutcomeSharesRemain();
    error ReentrantCall();
    error TransferFailed();
    error UnsecuredPosition();
    error VaultPaused();

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    modifier onDeploymentChain() {
        _checkDeploymentChain();
        _;
    }

    constructor(address asset_, address initialOwner, uint256 chainId_) {
        if (
            asset_ == address(0) || asset_.code.length == 0 || initialOwner == address(0)
                || chainId_ == 0
        ) revert InvalidAddress();

        assetToken = IERC20Metadata(asset_);
        owner = initialOwner;
        deploymentChainId = chainId_;
        name = "Conviction Polygon pUSD Vault";
        symbol = "cvpUSD";

        uint8 assetDecimals = 18;
        try IERC20Metadata(asset_).decimals() returns (uint8 value) {
            assetDecimals = value;
        } catch { }
        if (uint256(assetDecimals) + SHARE_DECIMALS_OFFSET > type(uint8).max) {
            revert InvalidParameters();
        }
        decimals = assetDecimals + 6;

        emit OwnershipTransferred(address(0), initialOwner);
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidAddress();
        pendingOwner = nextOwner;
        emit OwnershipTransferStarted(owner, nextOwner);
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

    function setAdapter(address adapter, bool enabled) external onlyOwner {
        if (adapter == address(0)) revert InvalidAddress();
        authorizedAdapters[adapter] = enabled;
        emit AdapterUpdated(adapter, enabled);
    }

    function setExecutionTarget(address target, bool enabled) external onlyOwner {
        if (target == address(0) || (enabled && target.code.length == 0)) {
            revert InvalidAddress();
        }
        allowedExecutionTargets[target] = enabled;
        emit ExecutionTargetUpdated(target, enabled);
    }

    function isExecutionTargetAllowed(address target) external view override returns (bool) {
        return allowedExecutionTargets[target];
    }

    function setRiskParameters(
        uint256 idleReserveBps_,
        uint256 reserveFactorBps_,
        uint256 maximumInterestBps_,
        uint256 defaultMarketExposureCap_,
        uint256 accountExposureCap_
    ) external onlyOwner {
        if (
            idleReserveBps_ > 5_000 || reserveFactorBps_ > BPS || maximumInterestBps_ > BPS
                || defaultMarketExposureCap_ == 0 || accountExposureCap_ == 0
        ) revert InvalidParameters();

        idleReserveBps = idleReserveBps_;
        reserveFactorBps = reserveFactorBps_;
        maximumInterestBps = maximumInterestBps_;
        defaultMarketExposureCap = defaultMarketExposureCap_;
        accountExposureCap = accountExposureCap_;
        emit RiskParametersUpdated(
            idleReserveBps_,
            reserveFactorBps_,
            maximumInterestBps_,
            defaultMarketExposureCap_,
            accountExposureCap_
        );
    }

    function setMarketExposureCap(bytes32 marketId, uint256 cap) external onlyOwner {
        if (marketId == bytes32(0) || cap == 0) revert InvalidParameters();
        marketExposureCap[marketId] = cap;
        emit MarketExposureCapUpdated(marketId, cap);
    }

    function totalAssets() public view returns (uint256) {
        uint256 grossAssets = assetToken.balanceOf(address(this)) + totalBorrowedAssets;
        uint256 excludedAssets = totalTraderEquityHeld + protocolReserves + accruedProtocolFees;
        return grossAssets > excludedAssets ? grossAssets - excludedAssets : 0;
    }

    function availableLiquidity() public view returns (uint256) {
        uint256 managedAssets = totalAssets();
        uint256 requiredIdle = _mulDiv(managedAssets, idleReserveBps, BPS);
        uint256 liquidAssets = _lpCash();
        uint256 unavailableAssets = requiredIdle + totalReservedAssets;
        return liquidAssets > unavailableAssets ? liquidAssets - unavailableAssets : 0;
    }

    function withdrawableAssets() public view returns (uint256) {
        uint256 liquidAssets = _lpCash();
        return liquidAssets > totalReservedAssets ? liquidAssets - totalReservedAssets : 0;
    }

    function withdrawalObligationAssets() external view returns (uint256) {
        return previewRedeem(totalQueuedShares);
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return _convertToShares(assets, false);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return _convertToAssets(shares, false);
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return _convertToShares(assets, false);
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        return _convertToAssets(shares, true);
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        return _convertToShares(assets, true);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return _convertToAssets(shares, false);
    }

    function maxDeposit(address) external view returns (uint256) {
        return paused || block.chainid != deploymentChainId ? 0 : type(uint256).max;
    }

    function maxMint(address) external view returns (uint256) {
        return paused || block.chainid != deploymentChainId ? 0 : type(uint256).max;
    }

    function maxWithdraw(address account) external view returns (uint256) {
        uint256 assets = convertToAssets(balanceOf[account]);
        uint256 liquid = withdrawableAssets();
        return assets < liquid ? assets : liquid;
    }

    function maxRedeem(address account) external view returns (uint256) {
        uint256 liquidShares = convertToShares(withdrawableAssets());
        uint256 ownedShares = balanceOf[account];
        return ownedShares < liquidShares ? ownedShares : liquidShares;
    }

    function approve(address spender, uint256 shares) external returns (bool) {
        allowance[msg.sender][spender] = shares;
        emit Approval(msg.sender, spender, shares);
        return true;
    }

    function transfer(address recipient, uint256 shares) external returns (bool) {
        _transfer(msg.sender, recipient, shares);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 shares)
        external
        returns (bool)
    {
        _spendAllowance(sender, msg.sender, shares);
        _transfer(sender, recipient, shares);
        return true;
    }

    function deposit(uint256 assets, address receiver)
        external
        nonReentrant
        onDeploymentChain
        returns (uint256 shares)
    {
        if (paused) revert VaultPaused();
        if (assets == 0 || receiver == address(0)) revert AmountRequired();
        shares = previewDeposit(assets);
        if (shares == 0) revert InsufficientShares();

        _pullExact(msg.sender, assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function mint(uint256 shares, address receiver)
        external
        nonReentrant
        onDeploymentChain
        returns (uint256 assets)
    {
        if (paused) revert VaultPaused();
        if (shares == 0 || receiver == address(0)) revert AmountRequired();
        assets = previewMint(shares);
        _pullExact(msg.sender, assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address shareOwner)
        external
        nonReentrant
        onDeploymentChain
        returns (uint256 shares)
    {
        if (assets == 0 || receiver == address(0) || shareOwner == address(0)) {
            revert AmountRequired();
        }
        if (assets > withdrawableAssets()) revert InsufficientLiquidity();

        shares = previewWithdraw(assets);
        if (msg.sender != shareOwner) _spendAllowance(shareOwner, msg.sender, shares);
        _burn(shareOwner, shares);
        _pushExact(receiver, assets);
        emit Withdraw(msg.sender, receiver, shareOwner, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address shareOwner)
        external
        nonReentrant
        onDeploymentChain
        returns (uint256 assets)
    {
        if (shares == 0 || receiver == address(0) || shareOwner == address(0)) {
            revert AmountRequired();
        }
        if (msg.sender != shareOwner) _spendAllowance(shareOwner, msg.sender, shares);
        assets = previewRedeem(shares);
        if (assets == 0 || assets > withdrawableAssets()) revert InsufficientLiquidity();

        _burn(shareOwner, shares);
        _pushExact(receiver, assets);
        emit Withdraw(msg.sender, receiver, shareOwner, assets, shares);
    }

    function requestRedeem(uint256 shares, address receiver)
        external
        nonReentrant
        onDeploymentChain
        returns (uint256 requestId)
    {
        if (shares == 0 || receiver == address(0)) revert AmountRequired();
        _transfer(msg.sender, address(this), shares);

        requestId = nextRedemptionId++;
        redemptionRequests[requestId] = RedemptionRequest({
            owner: msg.sender, receiver: receiver, shares: shares, status: RedemptionStatus.PENDING
        });
        totalQueuedShares += shares;
        emit RedemptionRequested(requestId, msg.sender, receiver, shares);
    }

    function cancelRedemption(uint256 requestId) external nonReentrant {
        RedemptionRequest storage request = redemptionRequests[requestId];
        if (request.status != RedemptionStatus.PENDING) revert InvalidRedemptionStatus();
        if (request.owner != msg.sender) revert NotAuthorized();

        request.status = RedemptionStatus.CANCELLED;
        totalQueuedShares -= request.shares;
        _transfer(address(this), request.owner, request.shares);
        emit RedemptionCancelled(requestId, request.owner);
    }

    function processRedemptionQueue(uint256 maximumRequests)
        external
        nonReentrant
        onDeploymentChain
        returns (uint256 processed)
    {
        if (maximumRequests == 0) revert AmountRequired();

        uint256 cursor = nextRedemptionToProcess;
        uint256 end = nextRedemptionId;
        while (cursor < end && processed < maximumRequests) {
            RedemptionRequest storage request = redemptionRequests[cursor];
            if (request.status == RedemptionStatus.PENDING) {
                uint256 assets = previewRedeem(request.shares);
                if (assets == 0 || assets > withdrawableAssets()) break;

                request.status = RedemptionStatus.COMPLETED;
                totalQueuedShares -= request.shares;
                _burn(address(this), request.shares);
                _pushExact(request.receiver, assets);
                emit RedemptionCompleted(cursor, request.receiver, request.shares, assets);
                ++processed;
            }
            ++cursor;
        }
        nextRedemptionToProcess = cursor;
    }

    function seedProtocolReserve(uint256 assets) external nonReentrant onDeploymentChain {
        if (assets == 0) revert AmountRequired();
        _pullExact(msg.sender, assets);
        protocolReserves += assets;
        emit ProtocolReserveSeeded(msg.sender, assets);
    }

    function allocateProtocolFeesToReserve(uint256 assets) external onlyOwner {
        if (assets == 0 || assets > accruedProtocolFees) revert AmountRequired();
        accruedProtocolFees -= assets;
        protocolReserves += assets;
        emit ProtocolFeesAllocatedToReserve(assets);
    }

    function reserveLoan(LoanRequest calldata request)
        external
        nonReentrant
        onDeploymentChain
        returns (bytes32 loanId, address custodyAccount)
    {
        if (paused) revert VaultPaused();
        if (
            !authorizedAdapters[request.adapter] || request.outcomeToken == address(0)
                || request.outcomeToken.code.length == 0
        ) revert NotAuthorized();
        if (
            request.marketId == bytes32(0) || request.traderEquity == 0 || request.borrowAssets == 0
                || request.minimumOutcomeShares == 0
        ) revert InvalidMarket();
        if (request.deadline <= block.timestamp) revert DeadlineExpired();
        if (request.borrowAssets > availableLiquidity()) revert InsufficientLiquidity();

        uint256 marketCap = marketExposureCap[request.marketId];
        if (marketCap == 0) marketCap = defaultMarketExposureCap;
        if (marketCap == 0 || marketExposure[request.marketId] + request.borrowAssets > marketCap) {
            revert MarketExposureLimitExceeded();
        }
        if (
            accountExposureCap == 0
                || accountExposure[msg.sender] + request.borrowAssets > accountExposureCap
        ) revert AccountExposureLimitExceeded();

        _pullExact(msg.sender, request.traderEquity);

        loanId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                msg.sender,
                request.marketId,
                request.outcomeToken,
                request.outcomeTokenId,
                nextLoanNonce++
            )
        );
        PolymarketIsolatedMarginAccount custody = new PolymarketIsolatedMarginAccount{
            salt: loanId
        }(
            address(this),
            msg.sender,
            request.adapter,
            address(assetToken),
            request.outcomeToken,
            request.outcomeTokenId
        );
        custodyAccount = address(custody);

        loans[loanId] = Loan({
            trader: msg.sender,
            adapter: request.adapter,
            custodyAccount: custodyAccount,
            marketId: request.marketId,
            outcomeToken: request.outcomeToken,
            outcomeTokenId: request.outcomeTokenId,
            minimumOutcomeShares: request.minimumOutcomeShares,
            securedOutcomeShares: 0,
            traderEquity: request.traderEquity,
            borrowAssets: request.borrowAssets,
            fundedAssets: 0,
            deadline: request.deadline,
            status: LoanStatus.RESERVED,
            executionRef: bytes32(0),
            settlementRef: bytes32(0)
        });

        totalTraderEquityHeld += request.traderEquity;
        totalReservedAssets += request.borrowAssets;
        marketExposure[request.marketId] += request.borrowAssets;
        accountExposure[msg.sender] += request.borrowAssets;

        emit LoanReserved(
            loanId,
            msg.sender,
            custodyAccount,
            request.marketId,
            request.traderEquity,
            request.borrowAssets
        );
    }

    function fundLoan(bytes32 loanId) external nonReentrant onDeploymentChain {
        Loan storage loan = _loanForAdapter(loanId);
        if (paused) revert VaultPaused();
        if (loan.status != LoanStatus.RESERVED) revert InvalidLoanStatus();
        if (loan.deadline <= block.timestamp) revert DeadlineExpired();

        uint256 funding = loan.traderEquity + loan.borrowAssets;
        loan.status = LoanStatus.EXECUTING;
        loan.fundedAssets = funding;
        totalReservedAssets -= loan.borrowAssets;
        totalBorrowedAssets += loan.borrowAssets;
        totalTraderEquityHeld -= loan.traderEquity;
        _pushExact(loan.custodyAccount, funding);
        emit LoanFunded(loanId, funding);
    }

    function activateLoan(bytes32 loanId, uint256 securedOutcomeShares, bytes32 executionRef)
        external
        nonReentrant
        onDeploymentChain
    {
        Loan storage loan = _loanForAdapter(loanId);
        if (loan.status != LoanStatus.EXECUTING) revert InvalidLoanStatus();
        if (loan.deadline <= block.timestamp) revert DeadlineExpired();
        if (
            securedOutcomeShares < loan.minimumOutcomeShares
                || IERC1155(loan.outcomeToken).balanceOf(loan.custodyAccount, loan.outcomeTokenId)
                    < securedOutcomeShares
        ) revert UnsecuredPosition();

        uint256 custodyCash = assetToken.balanceOf(loan.custodyAccount);
        if (custodyCash > loan.fundedAssets) revert InvalidParameters();
        uint256 spentAssets = loan.fundedAssets - custodyCash;
        uint256 equityUsed = spentAssets < loan.traderEquity ? spentAssets : loan.traderEquity;
        uint256 principal = spentAssets - equityUsed;
        if (principal == 0) revert UnsecuredPosition();

        uint256 unusedBorrow = loan.borrowAssets - principal;
        uint256 unusedEquity = loan.traderEquity - equityUsed;
        if (custodyCash > 0) {
            PolymarketIsolatedMarginAccount(loan.custodyAccount).returnAsset(custodyCash);
        }
        if (unusedBorrow > 0) {
            totalBorrowedAssets -= unusedBorrow;
            marketExposure[loan.marketId] -= unusedBorrow;
            accountExposure[loan.trader] -= unusedBorrow;
        }
        if (unusedEquity > 0) _pushExact(loan.trader, unusedEquity);

        PolymarketIsolatedMarginAccount(loan.custodyAccount).securePosition(securedOutcomeShares);
        loan.traderEquity = equityUsed;
        loan.borrowAssets = principal;
        loan.fundedAssets = spentAssets;
        loan.securedOutcomeShares = securedOutcomeShares;
        loan.executionRef = executionRef;
        loan.status = LoanStatus.ACTIVE;
        emit LoanActivated(loanId, equityUsed, principal, securedOutcomeShares, executionRef);
    }

    function failLoan(bytes32 loanId, bytes32 reasonCode) external nonReentrant onDeploymentChain {
        Loan storage loan = _loanForAdapter(loanId);
        if (loan.status == LoanStatus.RESERVED) {
            _releaseReservation(loan);
            loan.status = LoanStatus.FAILED;
        } else if (loan.status == LoanStatus.EXECUTING) {
            if (
                IERC1155(loan.outcomeToken).balanceOf(loan.custodyAccount, loan.outcomeTokenId) != 0
            ) revert OutcomeSharesRemain();

            uint256 recovered = assetToken.balanceOf(loan.custodyAccount);
            if (recovered < loan.fundedAssets) revert InsufficientAssetsRecovered();
            PolymarketIsolatedMarginAccount account =
                PolymarketIsolatedMarginAccount(loan.custodyAccount);
            account.returnAsset(recovered);
            account.finalizePosition();

            totalBorrowedAssets -= loan.borrowAssets;
            _removeExposure(loan.marketId, loan.trader, loan.borrowAssets);
            uint256 traderRefund = recovered - loan.borrowAssets;
            if (traderRefund > 0) _pushExact(loan.trader, traderRefund);
            loan.status = LoanStatus.FAILED;
        } else {
            revert InvalidLoanStatus();
        }
        emit LoanFailed(loanId, reasonCode);
    }

    function cancelLoan(bytes32 loanId) external nonReentrant onDeploymentChain {
        Loan storage loan = loans[loanId];
        if (loan.status != LoanStatus.RESERVED) revert InvalidLoanStatus();
        if (msg.sender != loan.trader && msg.sender != loan.adapter) revert NotAuthorized();
        _releaseReservation(loan);
        loan.status = LoanStatus.CANCELLED;
        emit LoanCancelled(loanId);
    }

    function cancelExpiredLoan(bytes32 loanId) external nonReentrant onDeploymentChain {
        Loan storage loan = loans[loanId];
        if (loan.status != LoanStatus.RESERVED) revert InvalidLoanStatus();
        if (loan.deadline >= block.timestamp) revert DeadlineExpired();
        _releaseReservation(loan);
        loan.status = LoanStatus.CANCELLED;
        emit LoanCancelled(loanId);
    }

    function settleLoan(bytes32 loanId, uint256 interestDue, bytes32 settlementRef)
        external
        nonReentrant
        onDeploymentChain
    {
        Loan storage loan = _loanForAdapter(loanId);
        if (loan.status != LoanStatus.ACTIVE) revert InvalidLoanStatus();
        if (interestDue > _mulDiv(loan.borrowAssets, maximumInterestBps, BPS)) {
            revert InvalidParameters();
        }
        if (IERC1155(loan.outcomeToken).balanceOf(loan.custodyAccount, loan.outcomeTokenId) != 0) {
            revert OutcomeSharesRemain();
        }

        PolymarketIsolatedMarginAccount account =
            PolymarketIsolatedMarginAccount(loan.custodyAccount);
        uint256 recovered = assetToken.balanceOf(loan.custodyAccount);
        if (recovered > 0) account.returnAsset(recovered);
        account.finalizePosition();

        uint256 principalRecovered = recovered < loan.borrowAssets ? recovered : loan.borrowAssets;
        uint256 remaining = recovered - principalRecovered;
        uint256 interestRecovered = remaining < interestDue ? remaining : interestDue;
        uint256 traderSurplus = remaining - interestRecovered;
        uint256 badDebt = loan.borrowAssets - principalRecovered;
        uint256 reserveCover = protocolReserves < badDebt ? protocolReserves : badDebt;

        totalBorrowedAssets -= loan.borrowAssets;
        _removeExposure(loan.marketId, loan.trader, loan.borrowAssets);
        protocolReserves -= reserveCover;
        totalBadDebt += badDebt;
        uint256 protocolFee = _mulDiv(interestRecovered, reserveFactorBps, BPS);
        accruedProtocolFees += protocolFee;
        totalInterestCollected += interestRecovered;
        emit ProtocolFeeAccrued(interestRecovered, protocolFee);
        if (traderSurplus > 0) _pushExact(loan.trader, traderSurplus);

        loan.status = LoanStatus.SETTLED;
        loan.settlementRef = settlementRef;
        emit LoanSettled(
            loanId,
            principalRecovered,
            interestRecovered,
            reserveCover,
            badDebt,
            traderSurplus,
            settlementRef
        );
    }

    function _loanForAdapter(bytes32 loanId) private view returns (Loan storage loan) {
        loan = loans[loanId];
        if (loan.adapter != msg.sender || !authorizedAdapters[msg.sender]) {
            revert NotAuthorized();
        }
    }

    function _checkOwner() private view {
        if (msg.sender != owner) revert NotAuthorized();
    }

    function _checkDeploymentChain() private view {
        if (block.chainid != deploymentChainId) revert ChainMismatch();
    }

    function _nonReentrantBefore() private {
        if (locked) revert ReentrantCall();
        locked = true;
    }

    function _nonReentrantAfter() private {
        locked = false;
    }

    function _releaseReservation(Loan storage loan) private {
        totalReservedAssets -= loan.borrowAssets;
        totalTraderEquityHeld -= loan.traderEquity;
        _removeExposure(loan.marketId, loan.trader, loan.borrowAssets);
        _pushExact(loan.trader, loan.traderEquity);
        PolymarketIsolatedMarginAccount(loan.custodyAccount).finalizePosition();
    }

    function _removeExposure(bytes32 marketId, address trader, uint256 assets) private {
        marketExposure[marketId] -= assets;
        accountExposure[trader] -= assets;
    }

    function _lpCash() private view returns (uint256) {
        uint256 cash = assetToken.balanceOf(address(this));
        uint256 excluded = totalTraderEquityHeld + protocolReserves + accruedProtocolFees;
        return cash > excluded ? cash - excluded : 0;
    }

    function _convertToShares(uint256 assets, bool roundUp) private view returns (uint256) {
        uint256 numerator = totalSupply + VIRTUAL_SHARES;
        uint256 denominator = totalAssets() + 1;
        return roundUp
            ? _mulDivUp(assets, numerator, denominator)
            : _mulDiv(assets, numerator, denominator);
    }

    function _convertToAssets(uint256 shares, bool roundUp) private view returns (uint256) {
        uint256 numerator = totalAssets() + 1;
        uint256 denominator = totalSupply + VIRTUAL_SHARES;
        return roundUp
            ? _mulDivUp(shares, numerator, denominator)
            : _mulDiv(shares, numerator, denominator);
    }

    function _mint(address receiver, uint256 shares) private {
        totalSupply += shares;
        balanceOf[receiver] += shares;
        emit Transfer(address(0), receiver, shares);
    }

    function _burn(address account, uint256 shares) private {
        if (balanceOf[account] < shares) revert InsufficientShares();
        balanceOf[account] -= shares;
        totalSupply -= shares;
        emit Transfer(account, address(0), shares);
    }

    function _transfer(address sender, address receiver, uint256 shares) private {
        if (receiver == address(0)) revert InvalidAddress();
        if (balanceOf[sender] < shares) revert InsufficientShares();
        balanceOf[sender] -= shares;
        balanceOf[receiver] += shares;
        emit Transfer(sender, receiver, shares);
    }

    function _spendAllowance(address shareOwner, address spender, uint256 shares) private {
        uint256 currentAllowance = allowance[shareOwner][spender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < shares) revert InsufficientAllowance();
            allowance[shareOwner][spender] = currentAllowance - shares;
            emit Approval(shareOwner, spender, allowance[shareOwner][spender]);
        }
    }

    function _pullExact(address from, uint256 assets) private {
        uint256 beforeBalance = assetToken.balanceOf(address(this));
        _callOptionalReturn(
            address(assetToken), abi.encodeCall(IERC20.transferFrom, (from, address(this), assets))
        );
        if (assetToken.balanceOf(address(this)) - beforeBalance != assets) {
            revert TransferFailed();
        }
    }

    function _pushExact(address recipient, uint256 assets) private {
        uint256 beforeBalance = assetToken.balanceOf(address(this));
        _callOptionalReturn(
            address(assetToken), abi.encodeCall(IERC20.transfer, (recipient, assets))
        );
        if (beforeBalance - assetToken.balanceOf(address(this)) != assets) {
            revert TransferFailed();
        }
    }

    function _callOptionalReturn(address token, bytes memory data) private {
        (bool success, bytes memory returndata) = token.call(data);
        if (!success || (returndata.length > 0 && !abi.decode(returndata, (bool)))) {
            revert TransferFailed();
        }
    }

    function _mulDivUp(uint256 x, uint256 y, uint256 denominator)
        private
        pure
        returns (uint256 result)
    {
        result = _mulDiv(x, y, denominator);
        if (mulmod(x, y, denominator) > 0) ++result;
    }

    function _mulDiv(uint256 x, uint256 y, uint256 denominator)
        private
        pure
        returns (uint256 result)
    {
        if (denominator == 0) revert InvalidParameters();
        uint256 prod0;
        uint256 prod1;
        assembly {
            let mm := mulmod(x, y, not(0))
            prod0 := mul(x, y)
            prod1 := sub(sub(mm, prod0), lt(mm, prod0))
        }
        if (prod1 == 0) return prod0 / denominator;
        if (denominator <= prod1) revert InvalidParameters();

        uint256 remainder;
        assembly {
            remainder := mulmod(x, y, denominator)
            prod1 := sub(prod1, gt(remainder, prod0))
            prod0 := sub(prod0, remainder)
        }
        uint256 twos = denominator & (~denominator + 1);
        assembly {
            denominator := div(denominator, twos)
            prod0 := div(prod0, twos)
            twos := add(div(sub(0, twos), twos), 1)
        }
        prod0 |= prod1 * twos;

        // Seed for the modular inverse. This is intentionally bitwise XOR.
        // slither-disable-next-line incorrect-exp
        uint256 inverse = (3 * denominator) ^ 2;
        inverse *= 2 - denominator * inverse;
        inverse *= 2 - denominator * inverse;
        inverse *= 2 - denominator * inverse;
        inverse *= 2 - denominator * inverse;
        inverse *= 2 - denominator * inverse;
        inverse *= 2 - denominator * inverse;
        return prod0 * inverse;
    }
}
