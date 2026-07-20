// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { PolygonPusdLiquidityVault } from "../src/PolygonPusdLiquidityVault.sol";
import { PolymarketIsolatedMarginAccount } from "../src/PolymarketIsolatedMarginAccount.sol";
import { IERC1155Receiver } from "../src/interfaces/IERC1155.sol";

contract MockPusd {
    string public name = "Mock pUSD";
    string public symbol = "pUSD";
    uint8 public decimals = 6;

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount)
        external
        returns (bool)
    {
        require(balanceOf[sender] >= amount, "balance");
        require(allowance[sender][msg.sender] >= amount, "allowance");
        allowance[sender][msg.sender] -= amount;
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract MockOutcome1155 {
    mapping(address account => mapping(uint256 id => uint256 amount)) public balanceOf;
    mapping(address owner => mapping(address operator => bool approved)) public isApprovedForAll;

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function mint(address recipient, uint256 id, uint256 amount) external {
        balanceOf[recipient][id] += amount;
        if (recipient.code.length > 0) {
            bytes4 accepted = IERC1155Receiver(recipient)
                .onERC1155Received(msg.sender, address(0), id, amount, bytes(""));
            require(accepted == IERC1155Receiver.onERC1155Received.selector, "rejected");
        }
    }

    function safeTransferFrom(
        address sender,
        address recipient,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) external {
        require(msg.sender == sender || isApprovedForAll[sender][msg.sender], "unauthorized");
        require(balanceOf[sender][id] >= amount, "balance");
        balanceOf[sender][id] -= amount;
        balanceOf[recipient][id] += amount;
        if (recipient.code.length > 0) {
            bytes4 accepted =
                IERC1155Receiver(recipient).onERC1155Received(msg.sender, sender, id, amount, data);
            require(accepted == IERC1155Receiver.onERC1155Received.selector, "rejected");
        }
    }
}

contract MockPolymarketVenue is IERC1155Receiver {
    MockPusd public immutable pusd;
    MockOutcome1155 public immutable outcome;

    constructor(MockPusd pusd_, MockOutcome1155 outcome_) {
        pusd = pusd_;
        outcome = outcome_;
    }

    function buy(uint256 tokenId, uint256 assets, uint256 shares) external {
        require(pusd.transferFrom(msg.sender, address(this), assets), "transfer");
        outcome.mint(msg.sender, tokenId, shares);
    }

    function sell(uint256 tokenId, uint256 shares, uint256 proceeds) external {
        outcome.safeTransferFrom(msg.sender, address(this), tokenId, shares, bytes(""));
        require(pusd.transfer(msg.sender, proceeds), "transfer");
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }
}

contract MockExecutionWallet is IERC1155Receiver {
    MockPusd public immutable pusd;
    MockOutcome1155 public immutable outcome;

    constructor(MockPusd pusd_, MockOutcome1155 outcome_) {
        pusd = pusd_;
        outcome = outcome_;
    }

    function sellAndReturn(
        MockPolymarketVenue venue,
        uint256 tokenId,
        uint256 shares,
        uint256 proceeds,
        address custody
    ) external {
        outcome.setApprovalForAll(address(venue), true);
        venue.sell(tokenId, shares, proceeds);
        require(pusd.transfer(custody, proceeds), "return proceeds");
    }

    function returnShares(address custody, uint256 tokenId, uint256 shares) external {
        outcome.safeTransferFrom(address(this), custody, tokenId, shares, bytes(""));
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }
}

contract MarginAdapter {
    function commitWallet(PolygonPusdLiquidityVault vault, bytes32 loanId, address executionWallet)
        external
    {
        vault.commitExecutionWallet(loanId, executionWallet);
    }

    function fund(PolygonPusdLiquidityVault vault, bytes32 loanId) external {
        vault.fundLoan(loanId);
    }

    function approveAsset(PolymarketIsolatedMarginAccount account, address venue, uint256 amount)
        external
    {
        account.approveAssetForVenue(venue, amount);
    }

    function approveOutcome(PolymarketIsolatedMarginAccount account, address venue, bool approved)
        external
    {
        account.approveOutcomeForVenue(venue, approved);
    }

    function execute(PolymarketIsolatedMarginAccount account, address venue, bytes calldata data)
        external
    {
        account.executeVenueCall(venue, data);
    }

    function activate(
        PolygonPusdLiquidityVault vault,
        bytes32 loanId,
        uint256 shares,
        bytes32 executionRef
    ) external {
        vault.activateLoan(loanId, shares, executionRef);
    }

    function fail(PolygonPusdLiquidityVault vault, bytes32 loanId, bytes32 reasonCode) external {
        vault.failLoan(loanId, reasonCode);
    }

    function beginClose(PolygonPusdLiquidityVault vault, bytes32 loanId) external {
        vault.beginLoanClose(loanId);
    }

    function restoreClose(PolygonPusdLiquidityVault vault, bytes32 loanId) external {
        vault.restoreLoanAfterFailedClose(loanId);
    }

    function settle(PolygonPusdLiquidityVault vault, bytes32 loanId, bytes32 settlementRef)
        external
    {
        vault.settleLoan(loanId, settlementRef);
    }
}

contract ExternalCaller {
    function releaseOutcome(
        PolymarketIsolatedMarginAccount account,
        address recipient,
        uint256 amount
    ) external {
        account.releaseOutcome(recipient, amount);
    }

    function executeVenue(
        PolymarketIsolatedMarginAccount account,
        address venue,
        bytes calldata data
    ) external {
        account.executeVenueCall(venue, data);
    }
}

contract VaultRoleCaller {
    function pause(PolygonPusdLiquidityVault vault) external {
        vault.pause();
    }

    function unpause(PolygonPusdLiquidityVault vault) external {
        vault.setPaused(false);
    }

    function setRisk(PolygonPusdLiquidityVault vault, uint256 marketCap, uint256 accountCap)
        external
    {
        vault.setRiskParameters(2_000, 2_000, 5_000, marketCap, accountCap);
    }
}

contract PolygonPusdLiquidityVaultTest {
    uint256 private constant UNIT = 1e6;
    uint256 private constant TOKEN_ID = 42;
    bytes32 private constant MARKET_ID = keccak256("market");

    MockPusd private pusd;
    MockOutcome1155 private outcome;
    MockPolymarketVenue private venue;
    PolygonPusdLiquidityVault private vault;
    MarginAdapter private adapter;
    MockExecutionWallet private executionWallet;

    function setUp() public {
        pusd = new MockPusd();
        outcome = new MockOutcome1155();
        venue = new MockPolymarketVenue(pusd, outcome);
        adapter = new MarginAdapter();
        executionWallet = new MockExecutionWallet(pusd, outcome);
        vault = new PolygonPusdLiquidityVault(address(pusd), address(this), block.chainid);
        vault.setAdapter(address(adapter), true);
        vault.setExecutionTarget(address(venue), true);
        vault.setRiskParameters(2_000, 2_000, 5_000, 500 * UNIT, 300 * UNIT);

        pusd.mint(address(this), 10_000 * UNIT);
        pusd.approve(address(vault), type(uint256).max);
        pusd.mint(address(venue), 10_000 * UNIT);
    }

    function testDepositDonationAndRedeemPreserveShareAccounting() public {
        uint256 shares = vault.deposit(1_000 * UNIT, address(this));
        require(shares > 0, "shares");
        require(vault.totalAssets() == 1_000 * UNIT, "initial assets");

        require(pusd.transfer(address(vault), 100 * UNIT), "donation");
        require(vault.totalAssets() == 1_100 * UNIT, "donation not recognized");
        require(vault.previewRedeem(shares) >= 1_099 * UNIT, "donation not accrued");

        uint256 assets = vault.redeem(shares, address(this), address(this));
        require(assets >= 1_099 * UNIT, "redeem value");
        require(vault.totalSupply() == 0, "supply remains");
    }

    function testFuzzDepositRedeemRoundTrip(uint96 rawAssets) public {
        uint256 assets = uint256(rawAssets) % (5_000 * UNIT) + 1;
        uint256 shares = vault.deposit(assets, address(this));
        uint256 redeemed = vault.redeem(shares, address(this), address(this));

        require(redeemed <= assets, "rounding created assets");
        require(assets - redeemed <= 1, "rounding loss too large");
        require(vault.totalSupply() == 0, "shares remain");
    }

    function testFuzzReservationCancellationPreservesAccountingInvariant(
        uint64 rawEquity,
        uint64 rawBorrow
    ) public {
        uint256 equity = uint256(rawEquity) % (200 * UNIT) + 1;
        uint256 borrowed = uint256(rawBorrow) % (200 * UNIT) + 1;
        vault.deposit(1_000 * UNIT, address(this));
        uint256 managedAssetsBefore = vault.totalAssets();

        (bytes32 loanId,) = _reserve(equity, borrowed, 1);
        require(vault.totalAssets() == managedAssetsBefore, "reservation inflated assets");
        require(
            vault.totalReservedAssets() == vault.marketExposure(MARKET_ID),
            "reserved exposure mismatch"
        );
        require(vault.totalTraderEquityHeld() == equity, "trader equity accounting mismatch");

        vault.cancelLoan(loanId);
        require(vault.totalAssets() == managedAssetsBefore, "cancellation changed assets");
        require(vault.totalReservedAssets() == 0, "reservation remains");
        require(vault.totalTraderEquityHeld() == 0, "equity remains");
        require(vault.marketExposure(MARKET_ID) == 0, "market exposure remains");
        require(vault.accountExposure(address(this)) == 0, "account exposure remains");
    }

    function testReservationSeparatesTraderEquityFromLpAssets() public {
        vault.deposit(1_000 * UNIT, address(this));
        (bytes32 loanId,) = _reserve(100 * UNIT, 100 * UNIT, 100 * UNIT);

        require(vault.totalAssets() == 1_000 * UNIT, "equity counted as lp assets");
        require(vault.totalTraderEquityHeld() == 100 * UNIT, "equity not held");
        require(vault.totalReservedAssets() == 100 * UNIT, "borrow not reserved");

        vault.cancelLoan(loanId);
        require(vault.totalTraderEquityHeld() == 0, "equity remains");
        require(vault.totalReservedAssets() == 0, "reservation remains");
        require(vault.marketExposure(MARKET_ID) == 0, "market exposure remains");
    }

    function testLoanCannotActivateBeforeOutcomeSharesAreSecured() public {
        vault.deposit(1_000 * UNIT, address(this));
        (bytes32 loanId,) = _reserve(100 * UNIT, 100 * UNIT, 100 * UNIT);
        vault.commitExecutionWallet(loanId, address(executionWallet));
        adapter.fund(vault, loanId);

        bool reverted;
        try adapter.activate(vault, loanId, 100 * UNIT, keccak256("fill")) { }
        catch {
            reverted = true;
        }
        require(reverted, "unsecured loan activated");
        _assertLoanStatus(loanId, PolygonPusdLiquidityVault.LoanStatus.EXECUTING);
    }

    function testTraderMustCommitExecutionWalletBeforeAdapterFunding() public {
        vault.deposit(1_000 * UNIT, address(this));
        (bytes32 loanId,) = _reserve(100 * UNIT, 100 * UNIT, 100 * UNIT);

        bool fundingReverted;
        try adapter.fund(vault, loanId) { }
        catch {
            fundingReverted = true;
        }
        require(fundingReverted, "uncommitted loan funded");

        bool adapterCommitReverted;
        try adapter.commitWallet(vault, loanId, address(executionWallet)) { }
        catch {
            adapterCommitReverted = true;
        }
        require(adapterCommitReverted, "adapter committed execution wallet");

        vault.commitExecutionWallet(loanId, address(executionWallet));
        adapter.fund(vault, loanId);
        _assertLoanStatus(loanId, PolygonPusdLiquidityVault.LoanStatus.EXECUTING);
    }

    function testExecutionFailureReturnsFundsAndReleasesLiquidity() public {
        vault.deposit(1_000 * UNIT, address(this));
        uint256 traderBalanceBefore = pusd.balanceOf(address(this));
        (bytes32 loanId,) = _reserve(100 * UNIT, 100 * UNIT, 100 * UNIT);
        vault.commitExecutionWallet(loanId, address(executionWallet));
        adapter.fund(vault, loanId);
        adapter.fail(vault, loanId, keccak256("NO_FILL"));

        _assertLoanStatus(loanId, PolygonPusdLiquidityVault.LoanStatus.FAILED);
        require(vault.totalBorrowedAssets() == 0, "borrow remains");
        require(vault.marketExposure(MARKET_ID) == 0, "exposure remains");
        require(pusd.balanceOf(address(this)) == traderBalanceBefore, "equity not refunded");
        require(vault.totalAssets() == 1_000 * UNIT, "lp loss on no fill");
    }

    function testActiveLoanSecuresSharesAndSettlesWithYield() public {
        vault.deposit(1_000 * UNIT, address(this));
        (bytes32 loanId, PolymarketIsolatedMarginAccount account) =
            _fundAndBuyWithFee(100 * UNIT, 100 * UNIT, 180 * UNIT, 180 * UNIT, 10 * UNIT);

        adapter.activate(vault, loanId, 180 * UNIT, keccak256("fill"));
        _assertLoanStatus(loanId, PolygonPusdLiquidityVault.LoanStatus.ACTIVE);
        require(account.pledgedShares() == 180 * UNIT, "shares not pledged");
        require(vault.totalBorrowedAssets() == 80 * UNIT, "unused borrow not returned");
        require(vault.totalAssets() == 1_000 * UNIT, "funding changed lp assets");

        _closeAndSettle(loanId, account, 180 * UNIT, 220 * UNIT, keccak256("close"));

        _assertLoanStatus(loanId, PolygonPusdLiquidityVault.LoanStatus.SETTLED);
        require(vault.totalBorrowedAssets() == 0, "debt remains");
        require(vault.accruedProtocolFees() == 2 * UNIT, "protocol fee");
        require(vault.protocolReserves() == 0, "fee silently moved to reserve");
        require(vault.totalFinancingFeesCollected() == 10 * UNIT, "fee metric");
        require(vault.totalAssets() == 1_008 * UNIT, "lp yield");
        require(vault.marketExposure(MARKET_ID) == 0, "exposure remains");
    }

    function testProtocolFeesRequireExplicitReserveAllocation() public {
        vault.deposit(1_000 * UNIT, address(this));
        (bytes32 loanId, PolymarketIsolatedMarginAccount account) =
            _fundAndBuyWithFee(100 * UNIT, 100 * UNIT, 200 * UNIT, 200 * UNIT, 10 * UNIT);
        adapter.activate(vault, loanId, 200 * UNIT, keccak256("fill"));
        _closeAndSettle(loanId, account, 200 * UNIT, 210 * UNIT, keccak256("close"));

        vault.allocateProtocolFeesToReserve(2 * UNIT);
        require(vault.accruedProtocolFees() == 0, "fee remains");
        require(vault.protocolReserves() == 2 * UNIT, "reserve allocation missing");
        require(vault.totalAssets() == 1_008 * UNIT, "allocation changed lp assets");
    }

    function testReserveAbsorbsBadDebtBeforeLpShares() public {
        vault.deposit(1_000 * UNIT, address(this));
        vault.seedProtocolReserve(50 * UNIT);
        (bytes32 loanId, PolymarketIsolatedMarginAccount account) =
            _fundAndBuy(100 * UNIT, 100 * UNIT, 200 * UNIT, 200 * UNIT);
        adapter.activate(vault, loanId, 200 * UNIT, keccak256("fill"));
        _closeAndSettle(loanId, account, 200 * UNIT, 40 * UNIT, keccak256("loss"));

        require(vault.totalBadDebt() == 60 * UNIT, "gross bad debt");
        require(vault.totalReserveLosses() == 50 * UNIT, "reserve loss");
        require(vault.totalUncoveredBadDebt() == 10 * UNIT, "uncovered debt");
        require(vault.protocolReserves() == 0, "reserve not consumed");
        require(vault.totalAssets() == 990 * UNIT, "waterfall mismatch");
    }

    function testWithdrawalQueueWaitsForLoanLiquidity() public {
        uint256 shares = vault.deposit(1_000 * UNIT, address(this));
        (bytes32 loanId, PolymarketIsolatedMarginAccount account) =
            _fundAndBuy(100 * UNIT, 100 * UNIT, 200 * UNIT, 200 * UNIT);
        adapter.activate(vault, loanId, 200 * UNIT, keccak256("fill"));

        uint256 requestId = vault.requestRedeem(shares, address(this));
        uint256 processed = vault.processRedemptionQueue(1);
        require(processed == 0, "illiquid redemption processed");

        _closeAndSettle(loanId, account, 200 * UNIT, 200 * UNIT, keccak256("close"));
        processed = vault.processRedemptionQueue(1);
        require(processed == 1, "redemption not processed");

        (,,, PolygonPusdLiquidityVault.RedemptionStatus status) =
            vault.redemptionRequests(requestId);
        require(status == PolygonPusdLiquidityVault.RedemptionStatus.COMPLETED, "queue status");
    }

    function testCustodyRejectsUnauthorizedOrUnallowlistedMovement() public {
        vault.deposit(1_000 * UNIT, address(this));
        (bytes32 loanId, PolymarketIsolatedMarginAccount account) =
            _fundAndBuy(100 * UNIT, 100 * UNIT, 200 * UNIT, 200 * UNIT);
        adapter.activate(vault, loanId, 200 * UNIT, keccak256("fill"));
        ExternalCaller outsider = new ExternalCaller();

        bool releaseReverted;
        try outsider.releaseOutcome(account, address(this), 1) { }
        catch {
            releaseReverted = true;
        }
        require(releaseReverted, "outsider released pledged shares");

        bool targetReverted;
        try adapter.execute(
            account, address(pusd), abi.encodeCall(MockPusd.transfer, (address(this), 1))
        ) { }
        catch {
            targetReverted = true;
        }
        require(targetReverted, "unallowlisted target executed");

        bool activeVenueReverted;
        try adapter.execute(
            account, address(venue), abi.encodeCall(MockPolymarketVenue.sell, (TOKEN_ID, 1, 1))
        ) { }
        catch {
            activeVenueReverted = true;
        }
        require(activeVenueReverted, "active custody allowed arbitrary venue call");
        require(outcome.balanceOf(address(account), TOKEN_ID) == 200 * UNIT, "shares moved");
    }

    function testCloseNoFillReturnsSharesAndRestoresActiveLoan() public {
        vault.deposit(1_000 * UNIT, address(this));
        (bytes32 loanId, PolymarketIsolatedMarginAccount account) =
            _fundAndBuy(100 * UNIT, 100 * UNIT, 200 * UNIT, 200 * UNIT);
        adapter.activate(vault, loanId, 200 * UNIT, keccak256("fill"));

        adapter.beginClose(vault, loanId);
        _assertLoanStatus(loanId, PolygonPusdLiquidityVault.LoanStatus.CLOSING);
        require(
            outcome.balanceOf(address(executionWallet), TOKEN_ID) == 200 * UNIT,
            "close shares not released"
        );

        executionWallet.returnShares(address(account), TOKEN_ID, 200 * UNIT);
        adapter.restoreClose(vault, loanId);
        _assertLoanStatus(loanId, PolygonPusdLiquidityVault.LoanStatus.ACTIVE);
        require(outcome.balanceOf(address(account), TOKEN_ID) == 200 * UNIT, "shares not restored");
    }

    function testDeauthorizedAdapterCanCloseExistingRiskButCannotOpenNewRisk() public {
        vault.deposit(1_000 * UNIT, address(this));
        (bytes32 loanId, PolymarketIsolatedMarginAccount account) =
            _fundAndBuy(100 * UNIT, 100 * UNIT, 200 * UNIT, 200 * UNIT);
        adapter.activate(vault, loanId, 200 * UNIT, keccak256("fill"));
        vault.setAdapter(address(adapter), false);

        _closeAndSettle(loanId, account, 200 * UNIT, 200 * UNIT, keccak256("close"));
        _assertLoanStatus(loanId, PolygonPusdLiquidityVault.LoanStatus.SETTLED);

        bool reserveReverted;
        try this.reserveForTest(50 * UNIT, 50 * UNIT, 50 * UNIT) { }
        catch {
            reserveReverted = true;
        }
        require(reserveReverted, "deauthorized adapter opened new risk");
    }

    function testPausePreservesRiskReducingCloseAndSettlement() public {
        vault.deposit(1_000 * UNIT, address(this));
        (bytes32 loanId, PolymarketIsolatedMarginAccount account) =
            _fundAndBuy(100 * UNIT, 100 * UNIT, 200 * UNIT, 200 * UNIT);
        adapter.activate(vault, loanId, 200 * UNIT, keccak256("fill"));
        vault.setPaused(true);

        _closeAndSettle(loanId, account, 200 * UNIT, 200 * UNIT, keccak256("paused-close"));
        _assertLoanStatus(loanId, PolygonPusdLiquidityVault.LoanStatus.SETTLED);
    }

    function testGuardianAndRiskManagerHaveSeparatedLeastPrivilegeRoles() public {
        VaultRoleCaller guardian = new VaultRoleCaller();
        VaultRoleCaller riskManager = new VaultRoleCaller();
        vault.setGuardian(address(guardian));
        vault.setRiskManager(address(riskManager));

        guardian.pause(vault);
        require(vault.paused(), "guardian did not pause");

        bool guardianUnpauseReverted;
        try guardian.unpause(vault) { }
        catch {
            guardianUnpauseReverted = true;
        }
        require(guardianUnpauseReverted, "guardian unpaused vault");

        vault.setPaused(false);
        riskManager.setRisk(vault, 600 * UNIT, 400 * UNIT);
        require(vault.defaultMarketExposureCap() == 600 * UNIT, "risk manager market cap");
        require(vault.accountExposureCap() == 400 * UNIT, "risk manager account cap");

        bool guardianRiskReverted;
        try guardian.setRisk(vault, 700 * UNIT, 500 * UNIT) { }
        catch {
            guardianRiskReverted = true;
        }
        require(guardianRiskReverted, "guardian changed risk parameters");
    }

    function testExposureAndIdleReserveCapsAreEnforced() public {
        vault.deposit(1_000 * UNIT, address(this));

        bool marketCapReverted;
        try this.reserveForTest(100 * UNIT, 501 * UNIT, 100 * UNIT) { }
        catch {
            marketCapReverted = true;
        }
        require(marketCapReverted, "market cap bypassed");

        vault.setRiskParameters(5_000, 2_000, 5_000, 900 * UNIT, 900 * UNIT);
        bool idleReverted;
        try this.reserveForTest(100 * UNIT, 501 * UNIT, 100 * UNIT) { }
        catch {
            idleReverted = true;
        }
        require(idleReverted, "idle reserve bypassed");
    }

    function testEachLoanUsesDedicatedCustody() public {
        vault.deposit(1_000 * UNIT, address(this));
        (, address first) = _reserve(50 * UNIT, 50 * UNIT, 50 * UNIT);
        (, address second) =
            _reserveForMarket(keccak256("other-market"), 50 * UNIT, 50 * UNIT, 50 * UNIT);
        require(first != second, "custody reused");
    }

    function reserveForTest(uint256 equity, uint256 borrowed, uint256 minimumShares)
        external
        returns (bytes32 loanId, address custody)
    {
        require(msg.sender == address(this), "self only");
        return _reserve(equity, borrowed, minimumShares);
    }

    function _fundAndBuy(uint256 equity, uint256 borrowed, uint256 spent, uint256 outcomeShares)
        private
        returns (bytes32 loanId, PolymarketIsolatedMarginAccount account)
    {
        return _fundAndBuyWithFee(equity, borrowed, spent, outcomeShares, 0);
    }

    function _fundAndBuyWithFee(
        uint256 equity,
        uint256 borrowed,
        uint256 spent,
        uint256 outcomeShares,
        uint256 financingFee
    ) private returns (bytes32 loanId, PolymarketIsolatedMarginAccount account) {
        address custody;
        (loanId, custody) = _reserveWithFee(equity, borrowed, outcomeShares, financingFee);
        account = PolymarketIsolatedMarginAccount(custody);
        vault.commitExecutionWallet(loanId, address(executionWallet));
        adapter.fund(vault, loanId);
        adapter.approveAsset(account, address(venue), equity + borrowed);
        adapter.execute(
            account,
            address(venue),
            abi.encodeCall(MockPolymarketVenue.buy, (TOKEN_ID, spent, outcomeShares))
        );
    }

    function _reserve(uint256 equity, uint256 borrowed, uint256 minimumShares)
        private
        returns (bytes32 loanId, address custody)
    {
        return _reserveWithFee(equity, borrowed, minimumShares, 0);
    }

    function _reserveWithFee(
        uint256 equity,
        uint256 borrowed,
        uint256 minimumShares,
        uint256 financingFee
    ) private returns (bytes32 loanId, address custody) {
        return _reserveForMarketWithFee(MARKET_ID, equity, borrowed, minimumShares, financingFee);
    }

    function _reserveForMarket(
        bytes32 marketId,
        uint256 equity,
        uint256 borrowed,
        uint256 minimumShares
    ) private returns (bytes32 loanId, address custody) {
        return _reserveForMarketWithFee(marketId, equity, borrowed, minimumShares, 0);
    }

    function _reserveForMarketWithFee(
        bytes32 marketId,
        uint256 equity,
        uint256 borrowed,
        uint256 minimumShares,
        uint256 financingFee
    ) private returns (bytes32 loanId, address custody) {
        PolygonPusdLiquidityVault.LoanRequest memory request =
            PolygonPusdLiquidityVault.LoanRequest({
                adapter: address(adapter),
                marketId: marketId,
                traderEquity: equity,
                borrowAssets: borrowed,
                outcomeToken: address(outcome),
                outcomeTokenId: TOKEN_ID,
                minimumOutcomeShares: minimumShares,
                financingFeeAssets: financingFee,
                deadline: block.timestamp + 1 days
            });
        return vault.reserveLoan(request);
    }

    function _assertLoanStatus(bytes32 loanId, PolygonPusdLiquidityVault.LoanStatus expected)
        private
        view
    {
        require(vault.loanStatus(loanId) == expected, "loan status");
    }

    function _closeAndSettle(
        bytes32 loanId,
        PolymarketIsolatedMarginAccount account,
        uint256 shares,
        uint256 proceeds,
        bytes32 settlementRef
    ) private {
        adapter.beginClose(vault, loanId);
        executionWallet.sellAndReturn(venue, TOKEN_ID, shares, proceeds, address(account));
        adapter.settle(vault, loanId, settlementRef);
    }
}
