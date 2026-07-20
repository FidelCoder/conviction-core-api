# ADR-004: Polygon pUSD Vault And Isolated Margin Custody

- Status: Accepted for implementation; mainnet activation remains blocked
- Date: 2026-07-20
- Owners: Conviction Core

## Decision

Conviction's Polymarket execution layer will use one Polygon pUSD LP vault and one
dedicated custody account for every margin position.

The existing Sepolia ConvictionVault remains a test-only intent and collateral
contract. It is not the production LP vault and must not be presented as one.

## Why

Polymarket orders settle on Polygon. The funding wallet spends pUSD and receives
ERC-1155 YES or NO outcome shares. LP debt is secured only if those shares remain
inside an account the trader cannot empty while the debt is open.

An omnibus wallet was rejected. It would mix users, positions, debt, and losses
inside one operator-controlled account. That increases accounting, insolvency,
security, and regulatory risk.

## Custody Boundary

PolymarketIsolatedMarginAccount is created for exactly one trader, market
outcome, token id, adapter, and loan.

- It accepts only the configured ERC-1155 outcome token and token id.
- It has no generic trader or operator withdrawal function.
- Only its immutable adapter can call execution targets.
- The vault owner must explicitly allow each execution target.
- The account can approve only an allowed venue.
- The vault activates debt only after the configured outcome balance is present.
- Outcome shares cannot be released while the position is active.
- Settlement is blocked until the pledged outcome balance has been sold, redeemed,
  or otherwise reduced to zero.
- Unrelated ERC-20 tokens can be recovered only by the trader and only after the
  account is finalized.

This is contract-held isolated custody. A guarded Safe can replace the account
only after equivalent restrictions and Polymarket signature compatibility are
proved in tests.

## Vault Accounting

PolygonPusdLiquidityVault implements the ERC-4626 deposit, mint, withdraw,
redeem, preview, conversion, and limit surface for pUSD.

The vault accounts for these buckets separately:

- LP managed assets
- idle LP cash
- reserved but unfunded borrowing
- active principal
- trader equity waiting for execution
- accrued protocol fees
- protocol reserves
- queued LP shares
- gross bad debt

Trader equity, accrued protocol fees, and protocol reserves are excluded from LP totalAssets.
Outstanding principal remains an LP receivable until settlement. Direct pUSD
donations accrue to LPs.

Virtual shares and one virtual asset reduce first-depositor donation attacks and
make rounding deterministic.

## Loan State Machine

1. RESERVED: trader equity is held and LP principal is reserved.
2. EXECUTING: equity and principal move to a new isolated account.
3. ACTIVE: required outcome shares are proven in that account. Unused pUSD is
   returned, so only the actual borrowed amount remains outstanding.
4. SETTLED: outcome shares are gone, recovered pUSD repays principal and
   interest, and remaining value returns to the trader.
5. FAILED or CANCELLED: reservations and equity are released. A funded no-fill
   can fail only if all funded pUSD is recovered and no outcome shares remain.

No loan becomes ACTIVE from an API record alone.

## Risk And Withdrawals

- The idle reserve limits how much LP cash may be reserved for new loans.
- Account and market caps apply to reserved plus active principal.
- LP withdrawals cannot consume reserved liquidity.
- LPs can escrow shares in a FIFO redemption queue when cash is deployed.
- Queue value is calculated when processed, so losses and yield are shared fairly.
- At settlement, protocol reserves cover principal shortfall before residual loss
  reduces LP share value.
- Interest is split between LP yield and accrued protocol fees. Governance must
  explicitly allocate protocol fees into the bad-debt reserve.

## Operational Requirements

Mainnet activation requires all of the following:

- Polygon chain id 137
- the current official pUSD collateral address verified independently
- owner set to a controlled multisig
- only audited Polymarket exchange and adapter targets allowlisted
- conservative non-zero account and market caps
- funded protocol reserve
- execution reconciliation, liquidation, monitoring, and emergency procedures
- external contract audit

Deployment alone does not enable production margin.

## Consequences

The design creates more contracts and transactions than an omnibus wallet, but a
failure is contained to one position and accounting remains attributable. LP
funds cannot silently become an unsecured balance in a trader-controlled wallet.
