# Conviction Contracts

Foundry contracts for the Conviction Markets margin layer live inside the core API repo because the API owns execution state, validation, and adapter boundaries.

## Current Scope

This is a contract foundation, not a live execution system.

- `ConvictionVault` accepts supported ERC20 collateral deposits.
- Owner-managed collateral policies define whether a token is enabled, its max leverage, max single-intent collateral, maintenance margin, account borrow limit, and account exposure limit.
- Users can create margin intents against an off-chain synced market id.
- Collateral is locked while an intent is pending or executed. The vault tracks borrowed notional, exposure notional, and health in basis points for each account/collateral pair.
- Users or authorized operators can cancel pending intents.
- The owner can pause new deposits, new intents, and execution marking during incident response while still allowing withdrawals and cancellations.
- The owner can emergency-cancel pending intents and unlock collateral.
- Authorized operators can mark an intent failed and unlock collateral.
- Authorized operators can mark an intent executed only after a real adapter confirms execution.
- `IConvictionExecutionAdapter` defines the adapter boundary; venue-specific execution must stay outside the vault.
- Adapter status flows through `SUBMITTED`, `CONFIRMED`, `FAILED`, and `CANCELLED`; direct operator execution marking is not available.
- Executed intents can be closed by an operator or liquidated only when the account/collateral health is below the active maintenance margin.
- Risk accounting is based on submitted intent collateral and leverage. It is not PnL and does not prove a market order filled.

The core API must continue to report `marginExecutionEnabled=false` until real contracts are deployed, funded, monitored, and wired to execution adapters.

## Contract Layout

The vault is split into three focused source files:

- `contracts/src/ConvictionVaultState.sol` owns enums, structs, storage, events, errors, and shared modifiers.
- `contracts/src/ConvictionVaultAccounting.sol` owns collateral policy, deposits, withdrawals, account risk, transfer helpers, and guard checks.
- `contracts/src/ConvictionVault.sol` keeps the deployable vault name and owns margin-intent lifecycle transitions.

This keeps `ConvictionVault.sol` small while preserving the deployment import path used by scripts and tests.

## Commands

```sh
npm run contracts:build
npm run contracts:test
npm run contracts:fmt
```

Deploying requires Foundry and real operator-controlled environment values:

```sh
CONVICTION_VAULT_OWNER=0x...
forge script contracts/script/DeployConvictionVault.s.sol \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast
```

Do not reuse development private keys in production.

## Next Contract Work

- Implement real adapter contracts for prediction-market venues.
- Add oracle/mark-price based health updates before enabling live leverage.
- Add oracle/price-source validation for collateral and market exposure.
- Add role handoff to multisig-controlled ownership before public funds.
- Add audit-focused tests and invariant tests before mainnet deployment.
