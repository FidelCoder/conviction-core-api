// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EquityOptionsVault } from "../src/EquityOptionsVault.sol";

interface Vm {
    function envAddress(string calldata name) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract DeployEquityOptionsVault {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (EquityOptionsVault vault) {
        address owner = VM.envAddress("EQUITY_VAULT_OWNER");

        VM.startBroadcast();
        vault = new EquityOptionsVault(owner);
        VM.stopBroadcast();
    }
}
