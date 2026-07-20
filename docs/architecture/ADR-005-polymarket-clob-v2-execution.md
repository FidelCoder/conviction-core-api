# ADR-005: Polymarket CLOB V2 execution

## Status

Accepted for a production-capped canary. Position close, repayment, liquidation, and resolution remain gated by the lifecycle controls in issue #40.

## Decision

Conviction executes leveraged Polymarket positions on Polygon through one isolated account per position.

- The trader signs a Conviction margin authorization binding the position, condition, outcome token, side, collateral, borrow amount, minimum shares, worst price, slippage, nonce, deadline, and risk quote.
- The Polygon pUSD vault reserves and funds a dedicated custody account.
- A generated execution signer controls a dedicated Polymarket deposit wallet. Its private key and CLOB credentials are encrypted at rest and are never returned by the API.
- The current official `@polymarket/clob-client-v2` client creates a `POLY_1271` Fill-or-Kill order with the isolated deposit wallet as funder.
- The exact signed order and deterministic V2 order hash are persisted before network submission.
- A position is not `OPEN` until CLOB trades, Polygon transaction receipts, deposit-wallet ERC-1155 shares, isolated custody shares, and an active vault loan all agree.
- Explicit no-fill responses recover all pUSD and fail the loan. Ambiguous responses enter reconciliation; they never create a synthetic fill.

The user may link an existing Polymarket account for identity, positions, and history. Leveraged assets still use the isolated Conviction account because an unrestricted user-controlled wallet could transfer collateral while owing the vault.

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
