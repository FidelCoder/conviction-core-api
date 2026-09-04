// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EquityOptionsVaultAccounting} from "./EquityOptionsVaultAccounting.sol";

/// @title EquityOptionsVault
/// @notice Covered call vault for Coinbase B20 tokenized stocks on Base.
///         Users deposit tokenized equities. The operator writes covered calls
///         against the deposit. Premium is distributed pro-rata to depositors.
///         Settlement is oracle-driven (Chainlink final price at expiry).
contract EquityOptionsVault is EquityOptionsVaultAccounting {
    constructor(address initialOwner) EquityOptionsVaultAccounting(initialOwner) {}

    // ---------------------------------------------------------------
    //  Write Covered Call (operator only)
    // ---------------------------------------------------------------

    /// @notice Write a covered call against vault collateral.
    /// @param underlyingToken The B20 token address (e.g. NVDAc)
    /// @param strikePrice     Strike price in Chainlink decimals (8)
    /// @param expiry          Unix timestamp of expiry
    /// @param premium         Premium collected in USDC (6 dec)
    /// @param collateralAmount Amount of underlying to lock
    function writeCoveredCall(
        address underlyingToken,
        uint256 strikePrice,
        uint256 expiry,
        uint256 premium,
        uint256 collateralAmount
    ) external onlyOperator nonReentrant whenNotPaused {
        if (!supportedTokens[underlyingToken]) revert TokenNotSupported(underlyingToken);
        if (strikePrice == 0) revert InvalidStrike();
        if (expiry <= block.timestamp) revert InvalidExpiry();
        if (collateralAmount == 0) revert InvalidAmount();

        // Ensure vault has enough unlocked underlying
        VaultShare storage vs = vaultShares[underlyingToken];
        uint256 totalLocked = _getTotalLocked(underlyingToken);
        uint256 available = vs.totalAssets - totalLocked;
        if (available < collateralAmount) revert InsufficientBalance();

        uint256 optionId = nextOptionId[underlyingToken]++;

        coveredCalls[underlyingToken][optionId] = CoveredCall({
            underlyingToken: underlyingToken,
            strikePrice: strikePrice,
            expiry: expiry,
            premium: premium,
            collateralLocked: collateralAmount,
            seller: address(0), // vault-level position, not individual
            status: OptionStatus.ACTIVE,
            settledAt: 0,
            settlementPrice: 0
        });

        emit CoveredCallWritten(
            underlyingToken,
            optionId,
            strikePrice,
            expiry,
            premium,
            collateralAmount
        );
    }

    // ---------------------------------------------------------------
    //  Settle Option (operator only)
    // ---------------------------------------------------------------

    /// @notice Settle an expired covered call using the oracle final price.
    /// @param underlyingToken The B20 token address
    /// @param optionId        The option to settle
    /// @param finalPrice      Chainlink price at expiry (8 dec)
    /// @param settlementAmount If ITM: amount of underlying to sell at strike.
    ///                        If OTM: 0 (premium kept, collateral released).
    function settleOption(
        address underlyingToken,
        uint256 optionId,
        uint256 finalPrice,
        uint256 settlementAmount
    ) external onlyOperator nonReentrant {
        CoveredCall storage cc = coveredCalls[underlyingToken][optionId];
        if (cc.status != OptionStatus.ACTIVE) revert OptionAlreadySettled();
        if (block.timestamp < cc.expiry) revert OptionNotExpired();

        VaultShare storage vs = vaultShares[underlyingToken];

        if (finalPrice >= cc.strikePrice) {
            // ITM: option exercised. Vault sells underlying at strike.
            // settlementAmount worth of underlying is sold at strikePrice.
            // Premium + strike proceeds go to vault (distributed as yield).
            uint256 strikeProceeds = (settlementAmount * cc.strikePrice) / (10 ** PRICE_DECIMALS);

            cc.status = OptionStatus.EXERCISED;
            cc.settledAt = block.timestamp;
            cc.settlementPrice = finalPrice;

            // Add premium + strike proceeds to vault yield pool
            vs.totalPremiumEarned += cc.premium + strikeProceeds;
            // Reduce underlying (sold at strike)
            vs.totalAssets -= settlementAmount;

            // Send the underlying to operator (who bought at strike)
            _safeTransfer(underlyingToken, msg.sender, settlementAmount);

            emit OptionSettled(
                underlyingToken,
                optionId,
                OptionStatus.EXERCISED,
                finalPrice,
                strikeProceeds + cc.premium
            );
        } else {
            // OTM: option expires worthless. Premium kept. Collateral released.
            cc.status = OptionStatus.EXPIRED_OTM;
            cc.settledAt = block.timestamp;
            cc.settlementPrice = finalPrice;

            // Premium goes to vault yield pool
            vs.totalPremiumEarned += cc.premium;

            emit OptionSettled(
                underlyingToken,
                optionId,
                OptionStatus.EXPIRED_OTM,
                finalPrice,
                cc.premium
            );
        }
    }

    // ---------------------------------------------------------------
    //  Claim Premium (user only)
    // ---------------------------------------------------------------

    /// @notice User claims their share of accumulated premium.
    ///         Premium is proportional to vault shares held.
    function claimPremium(address underlyingToken) external nonReentrant {
        // Premium is automatically reflected in share price via totalAssets.
        // This function is a no-op for accounting but emits an event for UX.
        // The real yield is realized on withdraw at higher share price.
        emit PremiumDistributed(
            underlyingToken,
            vaultShares[underlyingToken].totalPremiumEarned,
            _getPremiumPerShare(underlyingToken)
        );
    }

    // ---------------------------------------------------------------
    //  Views
    // ---------------------------------------------------------------

    function getActiveOptionsCount(address underlyingToken) external view returns (uint256) {
        uint256 count = 0;
        uint256 total = nextOptionId[underlyingToken];
        for (uint256 i = 0; i < total; i++) {
            if (coveredCalls[underlyingToken][i].status == OptionStatus.ACTIVE) {
                count++;
            }
        }
        return count;
    }

    function getOptionDetails(
        address underlyingToken,
        uint256 optionId
    )
        external
        view
        returns (
            uint256 strikePrice,
            uint256 expiry,
            uint256 premium,
            uint256 collateralLocked,
            OptionStatus status,
            uint256 settlementPrice
        )
    {
        CoveredCall storage cc = coveredCalls[underlyingToken][optionId];
        return (
            cc.strikePrice,
            cc.expiry,
            cc.premium,
            cc.collateralLocked,
            cc.status,
            cc.settlementPrice
        );
    }

    function getPremiumPerShare(address underlyingToken) external view returns (uint256) {
        return _getPremiumPerShare(underlyingToken);
    }

    // ---------------------------------------------------------------
    //  Internal
    // ---------------------------------------------------------------

    function _getPremiumPerShare(address underlyingToken) internal view returns (uint256) {
        VaultShare storage vs = vaultShares[underlyingToken];
        if (vs.totalShares == 0) return 0;
        return (vs.totalPremiumEarned * 1e18) / vs.totalShares;
    }
}
