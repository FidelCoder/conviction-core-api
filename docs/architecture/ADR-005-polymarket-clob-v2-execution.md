# ADR-005: Polymarket CLOB V2 execution

## Status

Accepted for a production-capped canary. Production remains disabled until the
complete open-close-repay canary passes and the configured governance roles,
reserve coverage, and monitoring gates are healthy.

## Decision

Conviction executes leveraged Polymarket positions on Polygon through one isolated account per position.

- The trader signs a Conviction margin authorization binding the position, condition, outcome token, side, collateral, borrow amount, fixed financing fee, minimum shares, worst price, slippage, nonce, deadline, and risk quote.
- The Polygon pUSD vault reserves and funds a dedicated custody account.
- A generated execution signer controls a dedicated Polymarket deposit wallet. Its private key and CLOB credentials are encrypted at rest and are never returned by the API.
- The API returns an encoded `commitExecutionWallet` call after that wallet is
  deployed. The trader submits this Polygon transaction before funding, binding
  the loan to that exact contract wallet without trusting the hot adapter to
  select it.
- The current official `@polymarket/clob-client-v2` client creates a `POLY_1271` Fill-or-Kill order with the isolated deposit wallet as funder.
- The exact signed order and deterministic V2 order hash are persisted before network submission.
- A position is not `OPEN` until CLOB trades, Polygon transaction receipts, deposit-wallet ERC-1155 shares, isolated custody shares, and an active vault loan all agree.
- Explicit no-fill responses recover all pUSD and fail the loan. Ambiguous responses enter reconciliation; they never create a synthetic fill.
- Voluntary closes require a second typed signature that binds the full share
  amount, minimum net proceeds, price floor, slippage, nonce, and deadline.
- Close attempts are append-only records. Their signed order, deterministic hash,
  trades, Polygon receipts, wallet baselines, relayer operations, and vault
  settlement cannot be overwritten by a later retry.
- Maintenance and mandatory-close policies may start system closes. Positions
  above the direct-liquidation cap stop at `AUCTION_REQUIRED`; they are never
  forced through a thin CLOB book.
- Resolved positions redeem in the deposit wallet, return pUSD to isolated
  custody, and use the same principal-first vault settlement waterfall.

The user may link an existing Polymarket account for identity, positions, and history. Leveraged assets still use the isolated Conviction account because an unrestricted user-controlled wallet could transfer collateral while owing the vault. The linked account is never accepted as the leveraged execution wallet unless it satisfies the same contract and withdrawal restrictions.

## Idempotency

The authorization nonce, idempotency key, position, loan ID, and CLOB order ID are unique. A restart with a persisted signed order but no submission timestamp reposts the exact same order hash. A duplicate response is treated as submission evidence, then reconciled against actual CLOB trades and Polygon balances.

## Failure boundary

Only explicit `unmatched` or `FOK_ORDER_NOT_FILLED_ERROR` responses trigger no-fill recovery. Timeouts, malformed provider responses, RPC failures, missing transactions, and custody mismatches remain `RECONCILIATION_REQUIRED`.

The published TypeScript V2 client has had deposit-wallet credential-binding reports. The integration therefore remains canary-gated until a live credential-create, YES order, NO order, close, and restart sequence succeeds against the current CLOB deployment. A successful readiness probe alone is not evidence that order authentication works.

## Source contracts

- Polymarket trading overview: https://docs.polymarket.com/trading/overview
- Orders and FOK behavior: https://docs.polymarket.com/trading/orders/create
- Deposit wallets: https://docs.polymarket.com/trading/deposit-wallets
- Builder attribution: https://docs.polymarket.com/trading/clients/builder
- Gasless relayer: https://docs.polymarket.com/trading/gasless
