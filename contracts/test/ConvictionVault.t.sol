// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ConvictionVault } from "../src/ConvictionVault.sol";
import { ConvictionVaultState } from "../src/ConvictionVaultState.sol";

contract AdapterCaller {
    ConvictionVault private vault;

    constructor(ConvictionVault vault_) {
        vault = vault_;
    }

    function submit(bytes32 intentId, bytes32 externalRef) external {
        vault.submitMarginIntent(intentId, externalRef);
    }

    function confirm(bytes32 intentId, bytes32 executionRef) external {
        vault.confirmMarginIntent(intentId, executionRef);
    }

    function fail(bytes32 intentId, bytes32 reasonCode) external {
        vault.failMarginIntent(intentId, reasonCode);
    }

    function cancelSubmitted(bytes32 intentId, bytes32 reasonCode) external {
        vault.cancelSubmittedMarginIntent(intentId, reasonCode);
    }
}

contract OwnerCaller {
    ConvictionVault private vault;

    constructor(ConvictionVault vault_) {
        vault = vault_;
    }

    function acceptOwnership() external {
        vault.acceptOwnership();
    }

    function setPaused(bool nextPaused) external {
        vault.setPaused(nextPaused);
    }
}

contract MockERC20 {
    string public name = "Mock USD";
    string public symbol = "mUSD";
    uint8 public decimals = 18;

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract ShortTransferERC20 {
    string public name = "Short Transfer USD";
    string public symbol = "sUSD";
    uint8 public decimals = 18;

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(amount > 0, "amount required");
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - 1;
        return true;
    }
}

contract ReentrantTransferERC20 {
    string public name = "Reentrant USD";
    string public symbol = "rUSD";
    uint8 public decimals = 18;

    ConvictionVault private vault;
    bool public attackEnabled;
    bool public attackBlocked;

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    constructor(ConvictionVault vault_) {
        vault = vault_;
    }

    function setAttackEnabled(bool enabled) external {
        attackEnabled = enabled;
        attackBlocked = false;
    }

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (attackEnabled) {
            attackEnabled = false;
            try vault.deposit(address(this), 1) { }
            catch {
                attackBlocked = true;
            }
        }

        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract ConvictionVaultTest {
    ConvictionVault private vault;
    MockERC20 private token;

    function setUp() public {
        vault = new ConvictionVault(address(this));
        token = new MockERC20();
        vault.setCollateralSupport(address(token), true);
    }

    function testOwnershipTransferRequiresPendingOwnerAcceptance() public {
        OwnerCaller nextOwner = new OwnerCaller(vault);

        vault.transferOwnership(address(nextOwner));

        require(vault.owner() == address(this), "owner changed early");
        require(vault.pendingOwner() == address(nextOwner), "pending owner missing");

        bool earlyOwnerReverted;
        try nextOwner.setPaused(true) { }
        catch {
            earlyOwnerReverted = true;
        }
        require(earlyOwnerReverted, "pending owner acted early");

        nextOwner.acceptOwnership();

        require(vault.owner() == address(nextOwner), "owner not accepted");
        require(vault.pendingOwner() == address(0), "pending owner not cleared");

        bool previousOwnerReverted;
        try vault.setPaused(true) { }
        catch {
            previousOwnerReverted = true;
        }
        require(previousOwnerReverted, "previous owner retained control");

        nextOwner.setPaused(true);
        require(vault.paused(), "new owner cannot manage vault");
    }

    function testRejectNonContractCollateralPolicy() public {
        bool reverted;
        try vault.setCollateralSupport(address(uint160(0xBEEF)), true) { }
        catch {
            reverted = true;
        }

        require(reverted, "non-contract collateral accepted");
    }

    function testOwnerCanUpdateLiquidationRecipient() public {
        address recipient = address(uint160(0xCAFE));

        vault.setLiquidationRecipient(recipient);

        require(vault.liquidationRecipient() == recipient, "recipient not updated");
    }

    function testDepositRequiresExactReceivedAmount() public {
        ShortTransferERC20 shortToken = new ShortTransferERC20();
        vault.setCollateralSupport(address(shortToken), true);
        shortToken.mint(address(this), 10 ether);
        shortToken.approve(address(vault), 10 ether);

        bool reverted;
        try vault.deposit(address(shortToken), 10 ether) { }
        catch {
            reverted = true;
        }

        require(reverted, "short transfer deposit accepted");
        require(
            vault.availableBalance(address(this), address(shortToken)) == 0,
            "short transfer credited"
        );
    }

    function testDepositBlocksReentrantTokenCallback() public {
        ReentrantTransferERC20 reentrantToken = new ReentrantTransferERC20(vault);
        vault.setCollateralSupport(address(reentrantToken), true);
        reentrantToken.mint(address(this), 10 ether);
        reentrantToken.approve(address(vault), 10 ether);
        reentrantToken.setAttackEnabled(true);

        vault.deposit(address(reentrantToken), 10 ether);

        require(reentrantToken.attackBlocked(), "reentrant call was not blocked");
        require(
            vault.availableBalance(address(this), address(reentrantToken)) == 10 ether,
            "valid deposit not credited"
        );
    }

    function testDepositAndWithdraw() public {
        _fundAndDeposit(100 ether);

        vault.withdraw(address(token), 40 ether);
        require(
            vault.availableBalance(address(this), address(token)) == 60 ether, "withdraw failed"
        );
        require(token.balanceOf(address(this)) == 40 ether, "token return failed");
    }

    function testCreateAndCancelMarginIntentLocksCollateral() public {
        _fundAndDeposit(100 ether);

        bytes32 intentId = _createIntent(25 ether, 30_000, block.timestamp + 1 days);

        require(vault.availableBalance(address(this), address(token)) == 75 ether, "not locked");
        require(vault.lockedBalance(address(this), address(token)) == 25 ether, "lock missing");

        vault.cancelMarginIntent(intentId);

        require(vault.availableBalance(address(this), address(token)) == 100 ether, "not unlocked");
        require(vault.lockedBalance(address(this), address(token)) == 0, "lock remains");
    }

    function testCreateIntentRecordsMarginRisk() public {
        _fundAndDeposit(100 ether);

        _createIntent(10 ether, 30_000, block.timestamp + 1 days);

        (
            uint256 available,
            uint256 lockedAmount,
            uint256 borrowedNotional,
            uint256 exposureNotional,
            uint256 healthBps,
            bool belowMaintenance
        ) = vault.getAccountMarginState(address(this), address(token));

        require(available == 90 ether, "available mismatch");
        require(lockedAmount == 10 ether, "locked mismatch");
        require(borrowedNotional == 20 ether, "borrowed mismatch");
        require(exposureNotional == 30 ether, "exposure mismatch");
        require(healthBps == 3_333, "health mismatch");
        require(!belowMaintenance, "unexpected maintenance breach");
    }

    function testCancelReleasesMarginRisk() public {
        _fundAndDeposit(100 ether);
        bytes32 intentId = _createIntent(10 ether, 30_000, block.timestamp + 1 days);

        vault.cancelMarginIntent(intentId);

        (,, uint256 borrowedNotional, uint256 exposureNotional,, bool belowMaintenance) =
            vault.getAccountMarginState(address(this), address(token));

        require(borrowedNotional == 0, "borrowed remains");
        require(exposureNotional == 0, "exposure remains");
        require(!belowMaintenance, "maintenance breach remains");
    }

    function testExecutedIntentKeepsMarginRiskLocked() public {
        _fundAndDeposit(100 ether);
        AdapterCaller adapter = _authorizedAdapter();
        bytes32 intentId = _createIntent(10 ether, 30_000, block.timestamp + 1 days);

        adapter.submit(intentId, keccak256("external-ref"));
        adapter.confirm(intentId, keccak256("execution-ref"));

        (, uint256 lockedAmount, uint256 borrowedNotional, uint256 exposureNotional,,) =
            vault.getAccountMarginState(address(this), address(token));

        require(lockedAmount == 10 ether, "executed collateral unlocked");
        require(borrowedNotional == 20 ether, "executed borrowed removed");
        require(exposureNotional == 30 ether, "executed exposure removed");
    }

    function testRejectUnsupportedCollateral() public {
        MockERC20 unsupported = new MockERC20();
        unsupported.mint(address(this), 1 ether);
        unsupported.approve(address(vault), 1 ether);

        bool reverted;
        try vault.deposit(address(unsupported), 1 ether) { }
        catch {
            reverted = true;
        }

        require(reverted, "unsupported collateral accepted");
    }

    function testOperatorCanFailPendingIntentAndUnlockCollateral() public {
        _fundAndDeposit(100 ether);
        vault.setOperator(address(this), true);

        bytes32 intentId = _createIntent(10 ether, 20_000, block.timestamp + 1 days);

        vault.markMarginIntentFailed(intentId, keccak256("ADAPTER_UNAVAILABLE"));

        require(vault.availableBalance(address(this), address(token)) == 100 ether, "not unlocked");
        require(vault.lockedBalance(address(this), address(token)) == 0, "lock remains");
        (, uint256 exposureNotional) = vault.accountRisk(address(this), address(token));
        require(exposureNotional == 0, "risk remains");
    }

    function testPauseBlocksDepositsAndNewIntentsButAllowsWithdrawAndCancel() public {
        _fundAndDeposit(100 ether);
        bytes32 intentId = _createIntent(20 ether, 20_000, block.timestamp + 1 days);
        vault.setPaused(true);

        token.mint(address(this), 10 ether);
        token.approve(address(vault), 10 ether);

        bool depositReverted;
        try vault.deposit(address(token), 10 ether) { }
        catch {
            depositReverted = true;
        }
        require(depositReverted, "paused deposit accepted");

        bool intentReverted;
        try vault.createMarginIntent(
            address(token),
            keccak256("another-market-id"),
            ConvictionVaultState.Side.NO,
            10 ether,
            20_000,
            100,
            block.timestamp + 1 days,
            keccak256("another-position-id")
        ) { }
        catch {
            intentReverted = true;
        }
        require(intentReverted, "paused intent accepted");

        vault.withdraw(address(token), 30 ether);
        vault.cancelMarginIntent(intentId);

        require(vault.availableBalance(address(this), address(token)) == 70 ether, "exit blocked");
        require(vault.lockedBalance(address(this), address(token)) == 0, "locked after cancel");
    }

    function testOwnerCanEmergencyCancelPendingIntent() public {
        _fundAndDeposit(100 ether);
        bytes32 intentId = _createIntent(15 ether, 20_000, block.timestamp + 1 days);

        vault.emergencyCancelMarginIntent(intentId, keccak256("INCIDENT_RESPONSE"));

        require(vault.availableBalance(address(this), address(token)) == 100 ether, "not unlocked");
        require(vault.lockedBalance(address(this), address(token)) == 0, "lock remains");
    }

    function testCollateralPolicyRejectsExcessLeverage() public {
        vault.setCollateralPolicy(
            address(token), true, 20_000, 100 ether, 1_000, 100 ether, 200 ether
        );
        _fundAndDeposit(100 ether);

        bool reverted;
        try vault.createMarginIntent(
            address(token),
            keccak256("polymarket-market-id"),
            ConvictionVaultState.Side.YES,
            10 ether,
            30_000,
            100,
            block.timestamp + 1 days,
            keccak256("core-position-id")
        ) { }
        catch {
            reverted = true;
        }

        require(reverted, "excess leverage accepted");
    }

    function testCollateralPolicyRejectsOversizedIntent() public {
        vault.setCollateralPolicy(
            address(token), true, 30_000, 10 ether, 1_000, 100 ether, 200 ether
        );
        _fundAndDeposit(100 ether);

        bool reverted;
        try vault.createMarginIntent(
            address(token),
            keccak256("polymarket-market-id"),
            ConvictionVaultState.Side.YES,
            11 ether,
            20_000,
            100,
            block.timestamp + 1 days,
            keccak256("core-position-id")
        ) { }
        catch {
            reverted = true;
        }

        require(reverted, "oversized collateral accepted");
    }

    function testCollateralPolicyRejectsLowAccountHealth() public {
        vault.setCollateralPolicy(
            address(token), true, 100_000, 100 ether, 4_000, 100 ether, 200 ether
        );
        _fundAndDeposit(100 ether);

        bool reverted;
        try vault.createMarginIntent(
            address(token),
            keccak256("polymarket-market-id"),
            ConvictionVaultState.Side.YES,
            10 ether,
            30_000,
            100,
            block.timestamp + 1 days,
            keccak256("core-position-id")
        ) { }
        catch {
            reverted = true;
        }

        require(reverted, "low-health intent accepted");
    }

    function testCollateralPolicyRejectsBorrowLimit() public {
        vault.setCollateralPolicy(
            address(token), true, 100_000, 100 ether, 1_000, 15 ether, 200 ether
        );
        _fundAndDeposit(100 ether);

        bool reverted;
        try vault.createMarginIntent(
            address(token),
            keccak256("polymarket-market-id"),
            ConvictionVaultState.Side.YES,
            10 ether,
            30_000,
            100,
            block.timestamp + 1 days,
            keccak256("core-position-id")
        ) { }
        catch {
            reverted = true;
        }

        require(reverted, "borrow-limit intent accepted");
    }

    function testCollateralPolicyRejectsExposureLimit() public {
        vault.setCollateralPolicy(
            address(token), true, 100_000, 100 ether, 1_000, 100 ether, 25 ether
        );
        _fundAndDeposit(100 ether);

        bool reverted;
        try vault.createMarginIntent(
            address(token),
            keccak256("polymarket-market-id"),
            ConvictionVaultState.Side.YES,
            10 ether,
            30_000,
            100,
            block.timestamp + 1 days,
            keccak256("core-position-id")
        ) { }
        catch {
            reverted = true;
        }

        require(reverted, "exposure-limit intent accepted");
    }

    function testCalculateIntentAmounts() public view {
        (uint256 notionalAmount, uint256 borrowedAmount) =
            vault.calculateIntentAmounts(10 ether, 30_000);

        require(notionalAmount == 30 ether, "notional mismatch");
        require(borrowedAmount == 20 ether, "borrowed mismatch");
    }

    function testUnauthorizedAdapterCannotSubmit() public {
        _fundAndDeposit(100 ether);
        bytes32 intentId = _createIntent(10 ether, 20_000, block.timestamp + 1 days);

        bool reverted;
        try vault.submitMarginIntent(intentId, keccak256("external-ref")) { }
        catch {
            reverted = true;
        }

        require(reverted, "unauthorized adapter submitted");
    }

    function testAdapterSubmitAndConfirmFlow() public {
        _fundAndDeposit(100 ether);
        AdapterCaller adapter = _authorizedAdapter();
        bytes32 intentId = _createIntent(10 ether, 20_000, block.timestamp + 1 days);

        adapter.submit(intentId, keccak256("external-ref"));
        adapter.confirm(intentId, keccak256("execution-ref"));

        (, ConvictionVaultState.AdapterStatus adapterStatus,,,,) = vault.adapterRecords(intentId);
        (,,,,,,,,,,,,, ConvictionVaultState.IntentStatus intentStatus) =
            vault.marginIntents(intentId);

        require(adapterStatus == ConvictionVaultState.AdapterStatus.CONFIRMED, "not confirmed");
        require(intentStatus == ConvictionVaultState.IntentStatus.EXECUTED, "not executed");
    }

    function testAdapterCannotConfirmTwice() public {
        _fundAndDeposit(100 ether);
        AdapterCaller adapter = _authorizedAdapter();
        bytes32 intentId = _createIntent(10 ether, 20_000, block.timestamp + 1 days);

        adapter.submit(intentId, keccak256("external-ref"));
        adapter.confirm(intentId, keccak256("execution-ref"));

        bool reverted;
        try adapter.confirm(intentId, keccak256("second-ref")) { }
        catch {
            reverted = true;
        }

        require(reverted, "double confirm accepted");
    }

    function testDifferentAdapterCannotConfirmSubmittedIntent() public {
        _fundAndDeposit(100 ether);
        AdapterCaller firstAdapter = _authorizedAdapter();
        AdapterCaller secondAdapter = _authorizedAdapter();
        bytes32 intentId = _createIntent(10 ether, 20_000, block.timestamp + 1 days);

        firstAdapter.submit(intentId, keccak256("external-ref"));

        bool reverted;
        try secondAdapter.confirm(intentId, keccak256("execution-ref")) { }
        catch {
            reverted = true;
        }

        require(reverted, "different adapter confirmed");
    }

    function testAdapterFailureUnlocksCollateralAndRisk() public {
        _fundAndDeposit(100 ether);
        AdapterCaller adapter = _authorizedAdapter();
        bytes32 intentId = _createIntent(10 ether, 20_000, block.timestamp + 1 days);

        adapter.submit(intentId, keccak256("external-ref"));
        adapter.fail(intentId, keccak256("ADAPTER_FAILED"));

        (, ConvictionVaultState.AdapterStatus adapterStatus,,,,) = vault.adapterRecords(intentId);
        (,, uint256 borrowedNotional, uint256 exposureNotional,,) =
            vault.getAccountMarginState(address(this), address(token));
        (,,,,,,,,,,,,, ConvictionVaultState.IntentStatus intentStatus) =
            vault.marginIntents(intentId);

        require(adapterStatus == ConvictionVaultState.AdapterStatus.FAILED, "adapter not failed");
        require(intentStatus == ConvictionVaultState.IntentStatus.FAILED, "intent not failed");
        require(vault.availableBalance(address(this), address(token)) == 100 ether, "not unlocked");
        require(borrowedNotional == 0, "borrowed remains");
        require(exposureNotional == 0, "exposure remains");
    }

    function testCloseExecutedIntentReleasesAccounting() public {
        _fundAndDeposit(100 ether);
        vault.setOperator(address(this), true);
        AdapterCaller adapter = _authorizedAdapter();
        bytes32 intentId = _createIntent(10 ether, 20_000, block.timestamp + 1 days);

        adapter.submit(intentId, keccak256("external-ref"));
        adapter.confirm(intentId, keccak256("execution-ref"));
        vault.closeExecutedMarginIntent(intentId, keccak256("close-ref"));

        (,,,,,,,,,,,,, ConvictionVaultState.IntentStatus intentStatus) =
            vault.marginIntents(intentId);
        (,, uint256 borrowedNotional, uint256 exposureNotional,,) =
            vault.getAccountMarginState(address(this), address(token));

        require(intentStatus == ConvictionVaultState.IntentStatus.CLOSED, "not closed");
        require(
            vault.availableBalance(address(this), address(token)) == 100 ether,
            "collateral not released"
        );
        require(borrowedNotional == 0, "borrowed remains");
        require(exposureNotional == 0, "exposure remains");
    }

    function testHealthyExecutedIntentCannotLiquidate() public {
        _fundAndDeposit(100 ether);
        vault.setOperator(address(this), true);
        AdapterCaller adapter = _authorizedAdapter();
        bytes32 intentId = _createIntent(10 ether, 20_000, block.timestamp + 1 days);

        adapter.submit(intentId, keccak256("external-ref"));
        adapter.confirm(intentId, keccak256("execution-ref"));

        bool reverted;
        try vault.liquidateMarginIntent(intentId, keccak256("liquidation-ref")) { }
        catch {
            reverted = true;
        }

        require(reverted, "healthy intent liquidated");
    }

    function testLiquidationSeizesCollateralWhenBelowMaintenance() public {
        address recipient = address(uint160(0xCAFE));
        vault.setLiquidationRecipient(recipient);
        vault.setCollateralPolicy(
            address(token), true, 100_000, 100 ether, 1_000, 100 ether, 200 ether
        );
        _fundAndDeposit(100 ether);
        vault.setOperator(address(this), true);
        AdapterCaller adapter = _authorizedAdapter();
        bytes32 intentId = _createIntent(10 ether, 30_000, block.timestamp + 1 days);

        adapter.submit(intentId, keccak256("external-ref"));
        adapter.confirm(intentId, keccak256("execution-ref"));
        vault.setCollateralPolicy(
            address(token), true, 100_000, 100 ether, 4_000, 100 ether, 200 ether
        );

        require(vault.isLiquidatable(intentId), "not liquidatable");
        vault.liquidateMarginIntent(intentId, keccak256("liquidation-ref"));

        (,,,,,,,,,,,,, ConvictionVaultState.IntentStatus intentStatus) =
            vault.marginIntents(intentId);
        (, uint256 lockedAmount, uint256 borrowedNotional, uint256 exposureNotional,,) =
            vault.getAccountMarginState(address(this), address(token));

        require(intentStatus == ConvictionVaultState.IntentStatus.LIQUIDATED, "not liquidated");
        require(
            vault.availableBalance(address(this), address(token)) == 90 ether, "trader refunded"
        );
        require(vault.lockedBalance(address(this), address(token)) == 0, "locked remains");
        require(lockedAmount == 0, "account state locked remains");
        require(vault.availableBalance(recipient, address(token)) == 10 ether, "not seized");
        require(borrowedNotional == 0, "borrowed remains");
        require(exposureNotional == 0, "exposure remains");
    }

    function testRejectExpiredDeadline() public {
        _fundAndDeposit(100 ether);

        bool reverted;
        try vault.createMarginIntent(
            address(token),
            keccak256("polymarket-market-id"),
            ConvictionVaultState.Side.YES,
            10 ether,
            20_000,
            100,
            block.timestamp,
            keccak256("core-position-id")
        ) { }
        catch {
            reverted = true;
        }

        require(reverted, "expired deadline accepted");
    }

    function testOwnerCannotConfirmWithoutAdapterRole() public {
        _fundAndDeposit(100 ether);
        bytes32 intentId = _createIntent(10 ether, 20_000, block.timestamp + 1 days);

        bool reverted;
        try vault.confirmMarginIntent(intentId, keccak256("execution-ref")) { }
        catch {
            reverted = true;
        }

        require(reverted, "owner confirmed without adapter role");
    }

    function testCannotTransitionIntentTwice() public {
        _fundAndDeposit(100 ether);
        bytes32 intentId = _createIntent(10 ether, 20_000, block.timestamp + 1 days);

        vault.cancelMarginIntent(intentId);

        bool reverted;
        try vault.cancelMarginIntent(intentId) { }
        catch {
            reverted = true;
        }

        require(reverted, "double transition accepted");
    }

    function testCannotWithdrawLockedCollateral() public {
        _fundAndDeposit(100 ether);
        _createIntent(90 ether, 20_000, block.timestamp + 1 days);

        bool reverted;
        try vault.withdraw(address(token), 100 ether) { }
        catch {
            reverted = true;
        }

        require(reverted, "locked collateral withdrawn");
    }

    function testPausedVaultBlocksAdapterConfirmation() public {
        _fundAndDeposit(100 ether);
        AdapterCaller adapter = _authorizedAdapter();
        bytes32 intentId = _createIntent(10 ether, 20_000, block.timestamp + 1 days);
        adapter.submit(intentId, keccak256("external-ref"));
        vault.setPaused(true);

        bool reverted;
        try adapter.confirm(intentId, keccak256("execution-ref")) { }
        catch {
            reverted = true;
        }

        require(reverted, "paused execution accepted");
    }

    function _authorizedAdapter() private returns (AdapterCaller adapter) {
        adapter = new AdapterCaller(vault);
        vault.setAdapter(address(adapter), true);
    }

    function _fundAndDeposit(uint256 amount) private {
        token.mint(address(this), amount);
        token.approve(address(vault), amount);
        vault.deposit(address(token), amount);
        require(vault.availableBalance(address(this), address(token)) >= amount, "deposit failed");
    }

    function _createIntent(uint256 collateralAmount, uint256 leverageBps, uint256 deadline)
        private
        returns (bytes32)
    {
        return vault.createMarginIntent(
            address(token),
            keccak256("polymarket-market-id"),
            ConvictionVaultState.Side.YES,
            collateralAmount,
            leverageBps,
            100,
            deadline,
            keccak256(abi.encodePacked("core-position-id", collateralAmount, leverageBps))
        );
    }
}
