# Polymarket execution runbook

## Deployment gate

1. Deploy and verify `PolygonPusdLiquidityVault` and its isolated account implementation on Polygon.
2. Set distinct governance, guardian, risk-manager, and execution-adapter
   addresses. The owner should be a multisig or timelock, never the hot signer.
3. Configure all `POLYMARKET_*` variables from `.env.example` in the core API deployment.
4. Configure `CRON_SECRET` or `MARKET_SYNC_TOKEN` for protected reconciliation calls.
5. Apply the Prisma schema before serving execution traffic.
6. Set `POLYMARKET_LIFECYCLE_ENABLED=true` and keep
   `POLYMARKET_CANARY_PASSED=false`. The canary cannot exceed
   `POLYMARKET_CANARY_MAX_ASSETS`.
7. Add only approved wallets to `POLYMARKET_CANARY_ALLOWED_WALLETS`. Each invited user must have
   a verified linked Polymarket account. Add one through five reviewed condition IDs to
   `POLYMARKET_CANARY_CONDITION_IDS`; each market needs both outcome tokens and an active risk policy.
8. Set the initial leverage, position, TVL, utilization, and daily realized-loss caps. The defaults
   in `.env.example` are deliberately conservative and are enforced before reservation calldata is
   returned.
9. Confirm `GET /execution/polymarket/readiness` returns `READY_FOR_CANARY`, every structured gate
   reports `ready: true`, and the reported cap values match the approved release sheet.
10. Keep normal production fills disabled until a complete canary passes. Only
    then set `POLYMARKET_CANARY_PASSED=true` and require readiness `READY`.

## Active Principal Repayment

`POLYMARKET_ACTIVE_REPAY_ENABLED` must remain `false` until the configured Polygon vault is a
deployment of `PolygonPusdLiquidityVault` containing `repayLoanPrincipal(bytes32,uint256)`.
After deployment, verify the contract source, run the repayment accounting test against the exact
artifact, update `POLYMARKET_PUSD_VAULT_ADDRESS`, and only then set the flag to `true`. The endpoint
reduces principal and exposure atomically; it must never be enabled against an older vault.

Stop-loss and take-profit controls are best-effort lifecycle instructions. Keep the lifecycle
monitor scheduled and alerting before exposing them. They do not guarantee an exit price during
gaps, thin depth, venue outages, or resolution.

## Reconciliation

Each call advances at most one external side-effect stage per execution. Invoke one of:

```bash
npm run executions:reconcile:polymarket -- 10
```

```bash
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  "$CORE_API_URL/ops/executions/polymarket/reconcile?limit=10"
```

Run the job frequently enough that relayer and CLOB states are reconciled before authorization deadlines. A five-minute operation lease prevents concurrent workers from entering a slow Polygon or relayer stage; after expiry, recovery checks source-system state before submitting another action.

Run lifecycle monitoring before reconciliation:

```bash
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  "$CORE_API_URL/ops/executions/polymarket/lifecycle?limit=10"
```

Inspect health without changing state:

```bash
curl --fail \
  --header "Authorization: Bearer $CRON_SECRET" \
  "$CORE_API_URL/ops/executions/polymarket/lifecycle/health"
```

## Canary

Use a fresh market with adequate depth and a small pUSD amount.

1. Prepare and sign the authorization.
2. Confirm the wallet reservation transaction.
3. Advance until the execution reaches `WALLET_COMMIT_REQUIRED`, submit the
   returned `commitExecutionWallet` call from the trader wallet, and report its
   confirmed transaction hash to the wallet-commit endpoint.
4. Verify the vault records the exact deposit wallet before allowing funding.
5. Advance or reconcile until the record reaches `OPEN`.
6. Verify the CLOB credential belongs to the session signer and successfully authorizes its deposit wallet order.
7. Verify order ID, trade IDs, Polygon settlement hashes, fill price, shares, fee equivalent, custody balance, and active loan directly against their source systems.
8. Prepare and sign a voluntary full close. Reconcile through `CLOSED`, then
   verify principal, fixed financing fee, protocol fee, LP yield, reserve loss,
   uncovered bad debt, and trader remainder directly onchain.
9. Repeat for YES, NO, negative-risk, explicit no-fill, relayer delay, RPC timeout, and worker restart cases.

Record one evidence row per run with the Conviction position/execution IDs, linked account ID,
condition/token IDs, CLOB order and trade IDs, every Polygon transaction hash, actual fill/spend/fee,
vault loan and custody addresses, close-attempt ID, repayment/settlement hashes, LP share change, and
the final readiness snapshot. A readiness response is not a successful canary. Do not change
`POLYMARKET_CANARY_PASSED` without this source-system evidence for both YES and NO plus a no-fill
recovery.

## Deployment and rollback order

1. Deploy and verify the exact vault/factory artifacts, configure separated roles, authorize only the
   adapter and official pUSD target, then fund the signer with the minimum required POL.
2. Apply the database schema and deploy Core with execution disabled. Verify health, market sync,
   account linking, protected reconciliation, and secret-free readiness output.
3. Deploy the frontend against that Core release. Existing market, Pulse, profile, and intent-only
   functions must remain usable while the execution gate is blocked.
4. Enable lifecycle and active repayment, configure invite and market allowlists, then switch Core to
   `polymarket`. Do not mark the canary passed.
5. Run the evidence sequence above. Raise no cap during the run.

Rollback starts by blocking new risk, never by deleting records: set
`CONVICTION_EXECUTION_MODE=disabled` and pause the vault if contract-level protection is required.
Keep the deployed Core version capable of reconciliation, close, repayment, and no-fill restoration.
Roll the frontend back independently only after preserving access to Portfolio recovery controls.
Before reopening, reconcile every nonterminal record and require zero uncovered bad debt, healthy
reserve coverage, and a green structured readiness response.

Support must have the position/execution ID, wallet, condition ID, current state, and relevant Polygon
hash before escalating. Never ask a user for a private key, API secret, recovery phrase, or signature
payload.

## Incident actions

- Stop creating new authorizations by setting `CONVICTION_EXECUTION_MODE=disabled` or pausing the vault.
- Do not delete or manually mark records executed.
- Continue reconciliation and risk-reducing close or repayment paths.
- Guardian pause blocks deposits, reservations, funding, and activation. It does
  not block begin-close, no-fill restoration, repayment, or settlement. Only
  governance can unpause.
- For `RECONCILIATION_REQUIRED`, compare the vault loan, CLOB order/trades, Polygon receipts, deposit wallet, and isolated custody before changing state.
- For a stuck close, inspect the append-only close attempt before acting:
  `SHARES_RELEASED` means shares must be in the committed wallet;
  `ORDER_SUBMITTED` requires CLOB trade reconciliation;
  `NO_FILL_RETURNING` requires all pledged shares back in custody;
  `PROCEEDS_RETURNING` requires only the sale proceeds to move to custody;
  `SETTLING` requires both outcome balances at their recorded baselines.
- Never settle while outcome shares remain in custody or above the execution
  wallet baseline. The vault enforces both checks.
- `AUCTION_REQUIRED` is an explicit operator boundary. Do not bypass it with a
  direct market sell. Pause new risk if auction handling is unavailable.
- Treat stale feeds, uncovered bad debt, low reserve coverage, failed relayer
  transactions, and ten-minute close-stage stalls as incidents. Keep repayment
  active and reduce market/account caps before resuming new risk.
- Rotate the execution signer, encryption key, CLOB credentials, or relayer credentials immediately if exposure is suspected. Rotation requires a migration plan for in-flight encrypted records.
