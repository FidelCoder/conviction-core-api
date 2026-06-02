// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IConvictionExecutionAdapter {
    enum Side {
        YES,
        NO
    }

    struct MarginExecutionRequest {
        bytes32 intentId;
        address account;
        address collateralToken;
        bytes32 marketId;
        bytes32 offchainPositionId;
        Side side;
        uint256 collateralAmount;
        uint256 leverageBps;
        uint256 maxSlippageBps;
        uint256 deadline;
    }

    function submitMarginIntent(MarginExecutionRequest calldata request)
        external
        returns (bytes32 externalRef);

    function cancelMarginIntent(bytes32 intentId, bytes32 reasonCode) external;

    function closeMarginIntent(bytes32 intentId, bytes32 closeRef) external;
}
