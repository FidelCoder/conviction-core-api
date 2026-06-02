// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ConvictionVault } from "../src/ConvictionVault.sol";

interface Vm {
    function envAddress(string calldata name) external view returns (address);

    function startBroadcast() external;

    function stopBroadcast() external;
}

contract DeployConvictionVault {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (ConvictionVault vault) {
        address owner = VM.envAddress("CONVICTION_VAULT_OWNER");

        VM.startBroadcast();
        vault = new ConvictionVault(owner);
        VM.stopBroadcast();
    }
}
