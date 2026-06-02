// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ConvictionVault } from "../src/ConvictionVault.sol";

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

contract ConvictionVaultTest {
    ConvictionVault private vault;
    MockERC20 private token;

    function setUp() public {
        vault = new ConvictionVault(address(this));
        token = new MockERC20();
        vault.setCollateralSupport(address(token), true);
    }

    function testDepositAndWithdraw() public {
        token.mint(address(this), 100 ether);
        token.approve(address(vault), 100 ether);

        vault.deposit(address(token), 100 ether);
        require(
            vault.availableBalance(address(this), address(token)) == 100 ether, "deposit failed"
        );

        vault.withdraw(address(token), 40 ether);
        require(
            vault.availableBalance(address(this), address(token)) == 60 ether, "withdraw failed"
        );
        require(token.balanceOf(address(this)) == 40 ether, "token return failed");
    }

    function testCreateAndCancelMarginIntentLocksCollateral() public {
        token.mint(address(this), 100 ether);
        token.approve(address(vault), 100 ether);
        vault.deposit(address(token), 100 ether);

        bytes32 intentId = vault.createMarginIntent(
            address(token),
            keccak256("polymarket-market-id"),
            ConvictionVault.Side.YES,
            25 ether,
            30_000,
            100,
            block.timestamp + 1 days,
            keccak256("core-position-id")
        );

        require(vault.availableBalance(address(this), address(token)) == 75 ether, "not locked");
        require(vault.lockedBalance(address(this), address(token)) == 25 ether, "lock missing");

        vault.cancelMarginIntent(intentId);

        require(vault.availableBalance(address(this), address(token)) == 100 ether, "not unlocked");
        require(vault.lockedBalance(address(this), address(token)) == 0, "lock remains");
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
        token.mint(address(this), 100 ether);
        token.approve(address(vault), 100 ether);
        vault.deposit(address(token), 100 ether);
        vault.setOperator(address(this), true);

        bytes32 intentId = vault.createMarginIntent(
            address(token),
            keccak256("polymarket-market-id"),
            ConvictionVault.Side.NO,
            10 ether,
            20_000,
            50,
            block.timestamp + 1 days,
            keccak256("core-position-id")
        );

        vault.markMarginIntentFailed(intentId, keccak256("ADAPTER_UNAVAILABLE"));

        require(vault.availableBalance(address(this), address(token)) == 100 ether, "not unlocked");
        require(vault.lockedBalance(address(this), address(token)) == 0, "lock remains");
    }
}
