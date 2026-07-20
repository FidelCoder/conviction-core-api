// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { PolygonPusdLiquidityVault } from "../src/PolygonPusdLiquidityVault.sol";

interface PolygonDeployVm {
    function envAddress(string calldata name) external view returns (address);

    function startBroadcast() external;

    function stopBroadcast() external;
}

contract DeployPolygonPusdLiquidityVault {
    uint256 private constant POLYGON_CHAIN_ID = 137;
    PolygonDeployVm private constant VM =
        PolygonDeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error PolygonMainnetRequired();

    function run() external returns (PolygonPusdLiquidityVault vault) {
        if (block.chainid != POLYGON_CHAIN_ID) revert PolygonMainnetRequired();

        address owner = VM.envAddress("CONVICTION_POLYGON_VAULT_OWNER");
        address pusd = VM.envAddress("POLYGON_PUSD_ADDRESS");

        VM.startBroadcast();
        vault = new PolygonPusdLiquidityVault(pusd, owner, POLYGON_CHAIN_ID);
        VM.stopBroadcast();
    }
}
