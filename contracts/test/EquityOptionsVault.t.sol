// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EquityOptionsVault } from "../src/EquityOptionsVault.sol";
import { EquityOptionsVaultState } from "../src/EquityOptionsVaultState.sol";

interface Vm {
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 newTimestamp) external;
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
        require(totalShares == 3 ether, "totalShares wrong");
    }

    function testDeposit_secondDeposit_proRata() public {
        _enableToken();
        _depositAlice(3 ether);

        nvda.mint(bob, 5 ether);
        vm.startPrank(bob);
        nvda.approve(address(vault), 5 ether);
        vault.deposit(address(nvda), 5 ether);
        vm.stopPrank();

        (uint256 bobShares,) = vault.getUserBalance(address(nvda), bob);
        require(bobShares == 5 ether, "bob shares wrong");

        (uint256 totalAssets, uint256 totalShares,,, ) = vault.getVaultStats(address(nvda));
        require(totalAssets == 8 ether, "totalAssets wrong");
        require(totalShares == 8 ether, "totalShares wrong");
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
        require(nvda.balanceOf(alice) == 3 ether, "should get back 3 underlying");
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

        vm.prank(operatorAddr);
        vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, PREMIUM, 5 ether);

        bool reverted;
        vm.prank(operatorAddr);
        try vault.writeCoveredCall(address(nvda), STRIKE_PRICE, block.timestamp + 14 days, 10e6, 1 ether) {
        } catch {
            reverted = true;
        }
        require(reverted, "should revert when insufficient available");
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
    //  Settle Option tests
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

    // ---------------------------------------------------------------
    //  Share price tests
    // ---------------------------------------------------------------

    function testSharePrice_afterPremium() public {
        _enableToken();
        _depositAlice(5 ether);

        uint256 priceBefore = vault.getSharePrice(address(nvda));
        require(priceBefore == 1e18, "initial share price should be 1e18");

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

        // Write two options
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
