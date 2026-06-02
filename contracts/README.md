# Conviction Contracts

Foundry contracts for the Conviction Markets margin layer live inside the core API repo because the API owns execution state, validation, and adapter boundaries.

## Current Scope

This is a contract foundation, not a live execution system.

- `ConvictionVault` accepts supported ERC20 collateral deposits.
- Users can create margin intents against an off-chain synced market id.
- Collateral is locked while an intent is pending.
- Users or authorized operators can cancel pending intents.
- Authorized operators can mark an intent failed and unlock collateral.
- Authorized operators can mark an intent executed only after a real adapter confirms execution.

The core API must continue to report `marginExecutionEnabled=false` until real contracts are deployed, funded, monitored, and wired to execution adapters.

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

- Add collateral allowlist policy for production tokens.
- Add adapter contracts for real prediction-market venues.
- Add liquidation-health accounting before enabling leverage.
- Add oracle/price-source validation for collateral and market exposure.
- Add pausing and incident-response controls before public funds.
- Add audit-focused tests and invariant tests before mainnet deployment.
