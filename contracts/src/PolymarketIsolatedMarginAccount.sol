// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "./interfaces/IERC20.sol";
import { IERC1155, IERC1155Receiver } from "./interfaces/IERC1155.sol";

interface IExecutionTargetRegistry {
    function isExecutionTargetAllowed(address target) external view returns (bool);
}

/// @notice Dedicated custody for one trader, one market outcome, and one margin loan.
/// @dev The account deliberately has no generic trader or operator withdrawal function.
contract PolymarketIsolatedMarginAccount is IERC1155Receiver {
    enum Phase {
        SETUP,
        ACTIVE,
        FINALIZED
    }

    address public immutable controller;
    address public immutable trader;
    address public immutable adapter;
    address public immutable asset;
    address public immutable outcomeToken;
    uint256 public immutable outcomeTokenId;

    Phase public phase;
    uint256 public pledgedShares;

    event AssetApprovalUpdated(address indexed venue, uint256 amount);
    event OutcomeApprovalUpdated(address indexed venue, bool approved);
    event VenueCallExecuted(address indexed venue, bytes4 indexed selector);
    event PositionSecured(uint256 shares);
    event PositionFinalized();
    event AssetReturned(uint256 amount);
    event OutcomeReleased(address indexed recipient, uint256 amount);
    event UnrelatedTokenRecovered(address indexed token, address indexed recipient, uint256 amount);

    error AccountAlreadyFinalized();
    error AccountNotFinalized();
    error InvalidAddress();
    error InvalidOutcomeToken();
    error InvalidPhase();
    error NotAuthorized();
    error TargetNotAllowed();
    error TransferFailed();
    error UnsecuredPosition();

    modifier onlyController() {
        _checkController();
        _;
    }

    modifier onlyAdapter() {
        _checkAdapter();
        _;
    }

    constructor(
        address controller_,
        address trader_,
        address adapter_,
        address asset_,
        address outcomeToken_,
        uint256 outcomeTokenId_
    ) {
        if (
            controller_ == address(0) || trader_ == address(0) || adapter_ == address(0)
                || asset_ == address(0) || outcomeToken_ == address(0)
        ) revert InvalidAddress();

        controller = controller_;
        trader = trader_;
        adapter = adapter_;
        asset = asset_;
        outcomeToken = outcomeToken_;
        outcomeTokenId = outcomeTokenId_;
    }

    function approveAssetForVenue(address venue, uint256 amount) external onlyAdapter {
        _requireOpenAndAllowed(venue);
        _callOptionalReturn(asset, abi.encodeCall(IERC20.approve, (venue, amount)));
        emit AssetApprovalUpdated(venue, amount);
    }

    function approveOutcomeForVenue(address venue, bool approved) external onlyAdapter {
        _requireOpenAndAllowed(venue);
        IERC1155(outcomeToken).setApprovalForAll(venue, approved);
        emit OutcomeApprovalUpdated(venue, approved);
    }

    function executeVenueCall(address venue, bytes calldata data)
        external
        onlyAdapter
        returns (bytes memory result)
    {
        _requireOpenAndAllowed(venue);
        if (data.length < 4) revert TargetNotAllowed();

        (bool success, bytes memory returndata) = venue.call(data);
        if (!success) {
            assembly {
                revert(add(returndata, 32), mload(returndata))
            }
        }

        bytes4 selector;
        assembly {
            selector := calldataload(data.offset)
        }
        emit VenueCallExecuted(venue, selector);
        return returndata;
    }

    function securePosition(uint256 shares) external onlyController {
        if (phase != Phase.SETUP) revert InvalidPhase();
        if (shares == 0 || IERC1155(outcomeToken).balanceOf(address(this), outcomeTokenId) < shares)
        {
            revert UnsecuredPosition();
        }

        pledgedShares = shares;
        phase = Phase.ACTIVE;
        emit PositionSecured(shares);
    }

    function finalizePosition() external onlyController {
        if (phase == Phase.FINALIZED) revert AccountAlreadyFinalized();
        phase = Phase.FINALIZED;
        pledgedShares = 0;
        emit PositionFinalized();
    }

    function returnAsset(uint256 amount) external onlyController {
        _callOptionalReturn(asset, abi.encodeCall(IERC20.transfer, (controller, amount)));
        emit AssetReturned(amount);
    }

    function releaseOutcome(address recipient, uint256 amount) external onlyController {
        if (phase != Phase.FINALIZED) revert AccountNotFinalized();
        if (recipient == address(0)) revert InvalidAddress();

        IERC1155(outcomeToken)
            .safeTransferFrom(address(this), recipient, outcomeTokenId, amount, bytes(""));
        emit OutcomeReleased(recipient, amount);
    }

    function recoverUnrelatedERC20(address token, address recipient) external {
        if (msg.sender != trader || phase != Phase.FINALIZED) revert NotAuthorized();
        if (token == asset || token == address(0) || recipient == address(0)) {
            revert InvalidAddress();
        }

        uint256 amount = IERC20(token).balanceOf(address(this));
        _callOptionalReturn(token, abi.encodeCall(IERC20.transfer, (recipient, amount)));
        emit UnrelatedTokenRecovered(token, recipient, amount);
    }

    function onERC1155Received(address, address, uint256 id, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != outcomeToken || id != outcomeTokenId || phase == Phase.FINALIZED) {
            revert InvalidOutcomeToken();
        }
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata ids,
        uint256[] calldata,
        bytes calldata
    ) external view returns (bytes4) {
        if (msg.sender != outcomeToken || phase == Phase.FINALIZED) {
            revert InvalidOutcomeToken();
        }
        for (uint256 index = 0; index < ids.length; ++index) {
            if (ids[index] != outcomeTokenId) revert InvalidOutcomeToken();
        }
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == 0x01ffc9a7;
    }

    function _requireOpenAndAllowed(address venue) private view {
        if (phase == Phase.FINALIZED) revert AccountAlreadyFinalized();
        if (venue == address(0)) revert InvalidAddress();
        if (!IExecutionTargetRegistry(controller).isExecutionTargetAllowed(venue)) {
            revert TargetNotAllowed();
        }
    }

    function _checkController() private view {
        if (msg.sender != controller) revert NotAuthorized();
    }

    function _checkAdapter() private view {
        if (msg.sender != adapter) revert NotAuthorized();
    }

    function _callOptionalReturn(address token, bytes memory data) private {
        if (token.code.length == 0) revert TransferFailed();
        (bool success, bytes memory returndata) = token.call(data);
        if (!success || (returndata.length > 0 && !abi.decode(returndata, (bool)))) {
            revert TransferFailed();
        }
    }
}
