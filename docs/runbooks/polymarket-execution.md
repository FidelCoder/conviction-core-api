# Polymarket execution runbook

## Deployment gate

1. Deploy and verify `PolygonPusdLiquidityVault` and its isolated account implementation on Polygon.
2. Authorize a dedicated execution adapter signer. Do not reuse the owner or deployer key.
3. Configure all `POLYMARKET_*` variables from `.env.example` in the core API deployment.
4. Configure `CRON_SECRET` or `MARKET_SYNC_TOKEN` for protected reconciliation calls.
5. Apply the Prisma schema before serving execution traffic.
6. Confirm `GET /execution/polymarket/readiness` returns `READY_FOR_CANARY` with no missing items.
7. Keep user-facing production execution disabled until issue #40 close, repayment, liquidation, and monitoring gates are complete.

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

## Canary

Use a fresh market with adequate depth and a small pUSD amount.

1. Prepare and sign the authorization.
2. Confirm the wallet reservation transaction.
3. Advance or reconcile until the record reaches `OPEN`.
4. Verify the CLOB credential belongs to the session signer and successfully authorizes its deposit wallet order.
5. Verify order ID, trade IDs, Polygon settlement hashes, fill price, shares, fee equivalent, custody balance, and active loan directly against their source systems.
6. Close and repay through the issue #40 lifecycle before increasing any cap.
7. Repeat for YES, NO, negative-risk, explicit no-fill, relayer delay, RPC timeout, and worker restart cases.

## Incident actions

- Stop creating new authorizations by setting `CONVICTION_EXECUTION_MODE=disabled` or pausing the vault.
- Do not delete or manually mark records executed.
- Continue reconciliation and risk-reducing close or repayment paths.
- For `RECONCILIATION_REQUIRED`, compare the vault loan, CLOB order/trades, Polygon receipts, deposit wallet, and isolated custody before changing state.
- Rotate the execution signer, encryption key, CLOB credentials, or relayer credentials immediately if exposure is suspected. Rotation requires a migration plan for in-flight encrypted records.
