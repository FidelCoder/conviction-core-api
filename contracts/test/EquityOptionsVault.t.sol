// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EquityOptionsVault } from "../src/EquityOptionsVault.sol";
import { EquityOptionsVaultState } from "../src/EquityOptionsVaultState.sol";

interface Vm {
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 newTimestamp) external;
    function expectRevert(bytes calldata data) external;
}

/// @dev Minimal mock ERC20 for testing
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "no allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }
}

contract EquityOptionsVaultTest {
    EquityOptionsVault private vault;
    MockERC20 private nvda;

    address private ownerAddr = address(0x1);
    address private operatorAddr = address(0x2);
    address private alice = address(0xA);
    address private bob = address(0xB);
    address private dead = address(0xdead);

    uint256 private constant STRIKE_PRICE = 12807_00000000;
    uint256 private constant PREMIUM = 50e6;

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function setUp() public {
        vault = new EquityOptionsVault(ownerAddr);
        vm.prank(ownerAddr);
        vault.setOperator(operatorAddr);
        nvda = new MockERC20("NVDAc", "NVDAc", 8);
    }

    // ---------------------------------------------------------------
    //  Helpers
    // ---------------------------------------------------------------

    function _enableToken() internal {
        vm.prank(ownerAddr);
        vault.setTokenSupport(address(nvda), true);
    }

    function _depositAlice(uint256 amount) internal {
        nvda.mint(alice, amount);
        vm.startPrank(alice);
        nvda.approve(address(vault), amount);
        vault.deposit(address(nvda), amount);
        vm.stopPrank();
    }

    function _depositBob(uint256 amount) internal {
        nvda.mint(bob, amount);
        vm.startPrank(bob);
        nvda.approve(address(vault), amount);
        vault.deposit(address(nvda), amount);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------
    //  Deposit tests
    // ---------------------------------------------------------------

    function testDeposit_mintsShares() public {
        _enableToken();
        _depositAlice(3 ether);

        (uint256 shares,) = vault.getUserBalance(address(nvda), alice);
        require(shares == 3 ether, "shares should equal deposit");

        (uint256 totalAssets, uint256 totalShares,,, ) = vault.getVaultStats(address(nvda));
        require(totalAssets == 3 ether, "totalAssets wrong");
        // totalShares = MIN_DEAD_SHARES (1000) + 3 ether
        require(totalShares == 3 ether + 1000, "totalShares wrong");
    }

    function testDeposit_secondDeposit_proRata() public {
        _enableToken();
        _depositAlice(3 ether);

        nvda.mint(bob, 5 ether);
        vm.startPrank(bob);
        nvda.approve(address(vault), 5 ether);
        vault.deposit(address(nvda), 5 ether);
        vm.stopPrank();

        // Bob gets slightly more than 5 ether shares due to dead shares dilution
        (uint256 bobShares,) = vault.getUserBalance(address(nvda), bob);
        require(bobShares > 5 ether, "bob should get > 5 ether shares due to dead shares");

        (uint256 totalAssets, uint256 totalShares,,, ) = vault.getVaultStats(address(nvda));
        require(totalAssets == 8 ether, "totalAssets wrong");
        // totalShares = deadShares(1000) + alice(3e18) + bob(>5e18)
        require(totalShares > 8 ether + 1000, "totalShares should exceed 8 ether + dead shares");
    }

    function testDeposit_revertsForUnsupported() public {
        MockERC20 badToken = new MockERC20("BAD", "BAD", 18);
        badToken.mint(alice, 1 ether);

        bool reverted;
        vm.startPrank(alice);
        badToken.approve(address(vault), 1 ether);
        try vault.deposit(address(badToken), 1 ether) { } catch {
            reverted = true;
        }
        vm.stopPrank();
        require(reverted, "should revert for unsupported token");
    }

    function testDeposit_revertsForZero() public {
        _enableToken();

        bool reverted;
        vm.startPrank(alice);
        try vault.deposit(address(nvda), 0) { } catch {
            reverted = true;
        }
        vm.stopPrank();
        require(reverted, "should revert for zero amount");
    }

    function testDeposit_deadSharesMintedOnFirst() public {
        _enableToken();
        _depositAlice(1000 ether);

        // Dead address should have MIN_DEAD_SHARES
        uint256 deadShares = vault.userShares(address(nvda), dead);
        require(deadShares == 1000, "dead shares should be 1000");
    }

    // ---------------------------------------------------------------
    //  Withdraw tests
    // ---------------------------------------------------------------

    function testWithdraw_returnsUnderlying() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.startPrank(alice);
        vault.withdraw(address(nvda), 3 ether);
        vm.stopPrank();

        (uint256 shares,) = vault.getUserBalance(address(nvda), alice);
        require(shares == 2 ether, "shares should be 2 after withdrawing 3 of 5");

        // Due to dead shares, alice gets back slightly less than 3 ether
        uint256 aliceBalance = nvda.balanceOf(alice);
        require(aliceBalance > 2.99 ether, "should get back approximately 3 underlying");
    }

    function testWithdraw_partial() public {
        _enableToken();
        _depositAlice(3 ether);

        vm.startPrank(alice);
        vault.withdraw(address(nvda), 1 ether);
        vm.stopPrank();

        (uint256 shares,) = vault.getUserBalance(address(nvda), alice);
        require(shares == 2 ether, "should have 2 shares");
    }

    function testWithdraw_revertsIfLocked() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 3 ether);

        bool reverted;
        vm.startPrank(alice);
        try vault.withdraw(address(nvda), 4 ether) { } catch {
            reverted = true;
        }
        vm.stopPrank();
        require(reverted, "should revert when locked by active option");
    }

    function testWithdraw_revertsIfExceedsShares() public {
        _enableToken();
        _depositAlice(3 ether);

        bool reverted;
        vm.startPrank(alice);
        try vault.withdraw(address(nvda), 10 ether) { } catch {
            reverted = true;
        }
        vm.stopPrank();
        require(reverted, "should revert when exceeds shares");
    }

    // ---------------------------------------------------------------
    //  Write Covered Call tests
    // ---------------------------------------------------------------

    function testWriteCoveredCall_createsOption() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 2 ether);

        (uint256 strike, uint256 expiry, uint256 premium, uint256 locked, EquityOptionsVaultState.OptionStatus status,) =
            vault.getOptionDetails(address(nvda), 0);

        require(strike == STRIKE_PRICE, "strike wrong");
        require(premium == PREMIUM, "premium wrong");
        require(locked == 2 ether, "locked wrong");
        require(uint256(status) == uint256(EquityOptionsVaultState.OptionStatus.ACTIVE), "status wrong");
    }

    function testWriteCoveredCall_revertsIfInsufficient() public {
        _enableToken();
        _depositAlice(5 ether);

        // Lock 3.5 ether (70% = max utilization)
        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 3.5 ether);

        // Try to lock 1 more ether — total would be 4.5/5 = 90% > 70% max
        bool reverted;
        vm.prank(operatorAddr);
        try vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, 10e6, 1 ether) {
        } catch {
            reverted = true;
        }
        require(reverted, "should revert when exceeds max utilization");
    }

    function testWriteCoveredCall_revertsIfNotOperator() public {
        _enableToken();
        _depositAlice(5 ether);

        bool reverted;
        vm.startPrank(alice);
        try vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 1 ether) {
        } catch {
            reverted = true;
        }
        vm.stopPrank();
        require(reverted, "should revert if not operator");
    }

    // ---------------------------------------------------------------
    //  Security: Expiry bounds
    // ---------------------------------------------------------------

    function testWriteCoveredCall_revertsIfExpiryTooShort() public {
        _enableToken();
        _depositAlice(5 ether);

        // Expiry 30 minutes from now (< MIN_EXPIRY of 1 hour)
        bool reverted;
        vm.prank(operatorAddr);
        try vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 30 minutes, PREMIUM, 1 ether) {
        } catch {
            reverted = true;
        }
        require(reverted, "should revert for expiry too short");
    }

    function testWriteCoveredCall_revertsIfExpiryTooLong() public {
        _enableToken();
        _depositAlice(5 ether);

        // Expiry 91 days from now (> MAX_EXPIRY of 90 days)
        bool reverted;
        vm.prank(operatorAddr);
        try vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 91 days, PREMIUM, 1 ether) {
        } catch {
            reverted = true;
        }
        require(reverted, "should revert for expiry too long");
    }

    function testWriteCoveredCall_revertsIfExpiryInPast() public {
        _enableToken();
        _depositAlice(5 ether);

        bool reverted;
        vm.prank(operatorAddr);
        try vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp - 1, PREMIUM, 1 ether) {
        } catch {
            reverted = true;
        }
        require(reverted, "should revert for past expiry");
    }

    // ---------------------------------------------------------------
    //  Security: Max utilization
    // ---------------------------------------------------------------

    function testWriteCoveredCall_revertsIfExceedsMaxUtilization() public {
        _enableToken();
        _depositAlice(10 ether);

        // Try to lock 8 ether out of 10 (80% > 70% max)
        bool reverted;
        vm.prank(operatorAddr);
        try vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 8 ether) {
        } catch {
            reverted = true;
        }
        require(reverted, "should revert when utilization exceeds 70%");
    }

    function testWriteCoveredCall_allowsAtMaxUtilization() public {
        _enableToken();
        _depositAlice(10 ether);

        // Lock 7 ether out of 10 (70% = max)
        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 7 ether);

        (,,,, EquityOptionsVaultState.OptionStatus status,) = vault.getOptionDetails(address(nvda), 0);
        require(uint256(status) == uint256(EquityOptionsVaultState.OptionStatus.ACTIVE), "should succeed at 70%");
    }

    function testWriteCoveredCall_respectsCumulativeUtilization() public {
        _enableToken();
        _depositAlice(10 ether);

        // First: lock 5 ether (50%)
        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 5 ether);

        // Second: try to lock 3 more (total 80% > 70%)
        bool reverted;
        vm.prank(operatorAddr);
        try vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 3 ether) {
        } catch {
            reverted = true;
        }
        require(reverted, "should revert when cumulative utilization exceeds max");
    }

    function testGetUtilizationBps() public {
        _enableToken();
        _depositAlice(10 ether);

        uint256 util = vault.getUtilizationBps(address(nvda));
        require(util == 0, "should be 0 with no options");

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 5 ether);

        util = vault.getUtilizationBps(address(nvda));
        require(util == 5000, "should be 50% (5000 bps)");
    }

    // ---------------------------------------------------------------
    //  Security: Settlement validation
    // ---------------------------------------------------------------

    function testSettle_OTM() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 3 ether);

        vm.warp(block.timestamp + 14 days + 1);

        vm.prank(operatorAddr);
        vault.settleOption(address(nvda), 0, 120_00_00000000, 0);

        (,,, , EquityOptionsVaultState.OptionStatus status,) = vault.getOptionDetails(address(nvda), 0);
        require(uint256(status) == uint256(EquityOptionsVaultState.OptionStatus.EXPIRED_OTM), "status should be EXPIRED_OTM");

        (,, uint256 totalPremium,,) = vault.getVaultStats(address(nvda));
        require(totalPremium == PREMIUM, "premium should be recorded");
    }

    function testSettle_ITM() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 3 ether);

        vm.warp(block.timestamp + 14 days + 1);

        vm.prank(operatorAddr);
        vault.settleOption(address(nvda), 0, 150_00_00000000, 3 ether);

        (,,, , EquityOptionsVaultState.OptionStatus status,) = vault.getOptionDetails(address(nvda), 0);
        require(uint256(status) == uint256(EquityOptionsVaultState.OptionStatus.EXERCISED), "status should be EXERCISED");

        (,, uint256 totalPremium,,) = vault.getVaultStats(address(nvda));
        uint256 expectedStrikeProceeds = (3 ether * STRIKE_PRICE) / 1e8;
        require(totalPremium == PREMIUM + expectedStrikeProceeds, "premium + strike proceeds wrong");

        (uint256 totalAssets,,, ,) = vault.getVaultStats(address(nvda));
        // 5 ether deposited - 3 ether sold at strike = 2 ether remaining
        require(totalAssets == 2 ether, "underlying should be reduced");
    }

    function testSettle_revertsBeforeExpiry() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 3 ether);

        bool reverted;
        vm.prank(operatorAddr);
        try vault.settleOption(address(nvda), 0, 150_00_00000000, 0) { } catch {
            reverted = true;
        }
        require(reverted, "should revert before expiry");
    }

    function testSettle_revertsIfAlreadySettled() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 3 ether);

        vm.warp(block.timestamp + 14 days + 1);

        vm.prank(operatorAddr);
        vault.settleOption(address(nvda), 0, 120_00_00000000, 0);

        bool reverted;
        vm.prank(operatorAddr);
        try vault.settleOption(address(nvda), 0, 120_00_00000000, 0) { } catch {
            reverted = true;
        }
        require(reverted, "should revert if already settled");
    }

    function testSettle_revertsIfSettlementExceedsCollateral() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 3 ether);

        vm.warp(block.timestamp + 14 days + 1);

        // Try to settle 4 ether when only 3 ether is locked
        bool reverted;
        vm.prank(operatorAddr);
        try vault.settleOption(address(nvda), 0, 150_00_00000000, 4 ether) { } catch {
            reverted = true;
        }
        require(reverted, "should revert when settlement exceeds locked collateral");
    }

    function testSettle_revertsIfFinalPriceZero() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 3 ether);

        vm.warp(block.timestamp + 14 days + 1);

        bool reverted;
        vm.prank(operatorAddr);
        try vault.settleOption(address(nvda), 0, 0, 0) { } catch {
            reverted = true;
        }
        require(reverted, "should revert for zero final price");
    }

    function testSettle_decrementsActiveCount() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 2 ether);

        require(vault.getActiveOptionsCount(address(nvda)) == 1, "should be 1 active");

        vm.warp(block.timestamp + 14 days + 1);
        vm.prank(operatorAddr);
        vault.settleOption(address(nvda), 0, 120_00_00000000, 0);

        require(vault.getActiveOptionsCount(address(nvda)) == 0, "should be 0 active after settle");
    }

    // ---------------------------------------------------------------
    //  Share price tests
    // ---------------------------------------------------------------

    function testSharePrice_afterPremium() public {
        _enableToken();
        _depositAlice(5 ether);

        uint256 priceBefore = vault.getSharePrice(address(nvda));
        // Share price is slightly less than 1e18 due to dead shares
        require(priceBefore > 0, "initial share price should be > 0");

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, 100e6, 3 ether);

        vm.warp(block.timestamp + 14 days + 1);
        vm.prank(operatorAddr);
        vault.settleOption(address(nvda), 0, 120_00_00000000, 0);

        uint256 priceAfter = vault.getSharePrice(address(nvda));
        require(priceAfter >= priceBefore, "share price should not decrease");
    }

    // ---------------------------------------------------------------
    //  Strategy tests
    // ---------------------------------------------------------------

    function testSetStrategy() public {
        _enableToken();

        vm.prank(ownerAddr);
        vault.setStrategy(address(nvda), EquityOptionsVaultState.Strategy.MODERATE, 10000, 14 days, 0);

        EquityOptionsVaultState.Strategy stored = vault.tokenStrategy(address(nvda));
        require(uint256(stored) == uint256(EquityOptionsVaultState.Strategy.MODERATE), "strategy wrong");
    }

    function testSetStrategy_revertsIfUnsupported() public {
        MockERC20 badToken = new MockERC20("BAD", "BAD", 18);

        bool reverted;
        vm.prank(ownerAddr);
        try vault.setStrategy(address(badToken), EquityOptionsVaultState.Strategy.CONSERVATIVE, 9000, 30 days, 0) {
        } catch {
            reverted = true;
        }
        require(reverted, "should revert for unsupported token");
    }

    function testSetStrategy_revertsIfStrikeDeltaTooHigh() public {
        _enableToken();

        bool reverted;
        vm.prank(ownerAddr);
        try vault.setStrategy(address(nvda), EquityOptionsVaultState.Strategy.AGGRESSIVE, 16000, 14 days, 0) {
        } catch {
            reverted = true;
        }
        require(reverted, "should revert for strike delta > 150%");
    }

    function testSetStrategy_revertsIfVolTooHigh() public {
        _enableToken();

        bool reverted;
        vm.prank(ownerAddr);
        try vault.setStrategy(address(nvda), EquityOptionsVaultState.Strategy.AGGRESSIVE, 10000, 14 days, 11000) {
        } catch {
            reverted = true;
        }
        require(reverted, "should revert for vol > 100%");
    }

    // ---------------------------------------------------------------
    //  Pause tests
    // ---------------------------------------------------------------

    function testPaused_blocksDeposit() public {
        _enableToken();

        vm.prank(ownerAddr);
        vault.setPaused(true);

        nvda.mint(alice, 1 ether);
        bool reverted;
        vm.startPrank(alice);
        nvda.approve(address(vault), 1 ether);
        try vault.deposit(address(nvda), 1 ether) { } catch {
            reverted = true;
        }
        vm.stopPrank();
        require(reverted, "should revert when paused");
    }

    function testPaused_allowsWithdraw() public {
        _enableToken();
        _depositAlice(3 ether);

        vm.prank(ownerAddr);
        vault.setPaused(true);

        // Withdrawals should still work when paused (safety design)
        vm.startPrank(alice);
        vault.withdraw(address(nvda), 1 ether);
        vm.stopPrank();

        (uint256 shares,) = vault.getUserBalance(address(nvda), alice);
        require(shares == 2 ether, "should have 2 shares after partial withdraw");
    }

    function testPaused_blocksWriteCoveredCall() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.prank(ownerAddr);
        vault.setPaused(true);

        bool reverted;
        vm.prank(operatorAddr);
        try vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 1 ether) {
        } catch {
            reverted = true;
        }
        require(reverted, "should revert when paused");
    }

    // ---------------------------------------------------------------
    //  Security: Ownership transfer
    // ---------------------------------------------------------------

    function testOwnershipTransfer_twoStep() public {
        address newOwner = address(0xC);

        vm.prank(ownerAddr);
        vault.transferOwnership(newOwner);

        require(vault.pendingOwner() == newOwner, "pending owner should be set");
        require(vault.owner() == ownerAddr, "owner should not change yet");

        vm.prank(newOwner);
        vault.acceptOwnership();

        require(vault.owner() == newOwner, "owner should be new owner");
        require(vault.pendingOwner() == address(0), "pending owner should be cleared");
    }

    function testOwnershipTransfer_revertsIfNotPending() public {
        address newOwner = address(0xC);

        vm.prank(ownerAddr);
        vault.transferOwnership(newOwner);

        // Random address tries to accept
        bool reverted;
        vm.prank(alice);
        try vault.acceptOwnership() { } catch {
            reverted = true;
        }
        require(reverted, "should revert if not pending owner");
    }

    function testOwnershipTransfer_revertsIfZeroAddress() public {
        bool reverted;
        vm.prank(ownerAddr);
        try vault.transferOwnership(address(0)) { } catch {
            reverted = true;
        }
        require(reverted, "should revert for zero address");
    }

    function testSetOperator_revertsIfZeroAddress() public {
        bool reverted;
        vm.prank(ownerAddr);
        try vault.setOperator(address(0)) { } catch {
            reverted = true;
        }
        require(reverted, "should revert for zero address operator");
    }

    // ---------------------------------------------------------------
    //  Security: Zero address checks
    // ---------------------------------------------------------------

    function testSetTokenSupport_revertsIfZeroAddress() public {
        bool reverted;
        vm.prank(ownerAddr);
        try vault.setTokenSupport(address(0), true) { } catch {
            reverted = true;
        }
        require(reverted, "should revert for zero address token");
    }

    function testSetOracle_revertsIfZeroAddress() public {
        bool reverted;
        vm.prank(ownerAddr);
        try vault.setOracle(address(0)) { } catch {
            reverted = true;
        }
        require(reverted, "should revert for zero address oracle");
    }

    function testSetOracle_setsCorrectly() public {
        address oracleAddr = address(0x42);

        vm.prank(ownerAddr);
        vault.setOracle(oracleAddr);

        require(vault.oracle() == oracleAddr, "oracle should be set");
    }

    // ---------------------------------------------------------------
    //  Settlement integration tests
    // ---------------------------------------------------------------

    function testSettle_OTM_releasesCollateral() public {
        _enableToken();
        _depositAlice(5 ether);

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 3 ether);

        vm.warp(block.timestamp + 14 days + 1);

        vm.prank(operatorAddr);
        vault.settleOption(address(nvda), 0, 120_00_00000000, 0);

        // After OTM settlement, underlying available for withdraw
        (, uint256 underlyingAmount) = vault.getUserBalance(address(nvda), alice);
        require(underlyingAmount >= 2 ether, "should have underlying available");

        // totalAssets unchanged (OTM = collateral stays)
        (uint256 totalAssets,,, ,) = vault.getVaultStats(address(nvda));
        require(totalAssets == 5 ether, "totalAssets unchanged after OTM");
    }

    function testMultipleOptions_sequentialSettlement() public {
        _enableToken();
        _depositAlice(5 ether);

        // Write two options (each 1 ether = 20% each, total 40% < 70% max)
        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 7 days, 30e6, 1 ether);

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE + 10_00_00000000, block.timestamp + 14 days, 20e6, 1 ether);

        uint256 activeCount = vault.getActiveOptionsCount(address(nvda));
        require(activeCount == 2, "should have 2 active options");

        // Settle first
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(operatorAddr);
        vault.settleOption(address(nvda), 0, 130_00_00000000, 0);

        activeCount = vault.getActiveOptionsCount(address(nvda));
        require(activeCount == 1, "should have 1 active after first settle");

        // Settle second
        vm.warp(block.timestamp + 8 days + 1);
        vm.prank(operatorAddr);
        vault.settleOption(address(nvda), 1, 125_00_00000000, 0);

        activeCount = vault.getActiveOptionsCount(address(nvda));
        require(activeCount == 0, "should have 0 active after both settle");

        (,, uint256 totalPremium,,) = vault.getVaultStats(address(nvda));
        require(totalPremium == 50e6, "total premium should be sum of both");
    }
}
