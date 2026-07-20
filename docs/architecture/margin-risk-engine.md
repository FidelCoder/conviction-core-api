# Margin Risk Engine

The production margin path is fail-closed. A market is not eligible because it
appears in discovery; an admin must create an explicit approved policy.

## Policy Gate

Every approved market records:

- expected Polymarket neg-risk mode
- maximum leverage, defaulting to 2x
- an explicit flag for selected limits above 2x, never above 3x
- maintenance margin and fee basis points
- minimum entry and exit depth
- maximum spread and TWAP deviation
- maximum market-data age
- earliest possible resolution
- mandatory close time and close buffer
- market, account, category, and vault borrow caps
- approver and optional decision notes

Draft and paused policies cannot return approved quotes.

## Quote Inputs

The quote endpoint combines:

- current Market metadata from Gamma sync
- the selected YES or NO token's live CLOB orderbook
- a 15-minute time-weighted price
- open and pending Polygon margin exposure from Conviction
- the manually approved policy

The engine validates the condition id, distinct YES/NO token ids, tick size,
neg-risk mode, active and accepting orderbook, freshness, resolution window,
depth, spread, TWAP deviation, leverage, and every exposure cap.

## Quote Output

An approved result includes:

- trader collateral
- borrowed pUSD
- total notional
- estimated outcome shares from executable ask depth
- conservative mark from executable bid depth and TWAP
- liquidation price
- fee
- mandatory close time
- quote expiry
- deterministic quote id

Quotes expire after 30 seconds or at mandatory close, whichever comes first.
A quote is not a reservation, order, or fill. The execution adapter must rerun
the checks and reserve liquidity atomically before signing an order.

## API

Admin policy:

    GET /admin/markets/:id/margin-policy
    PUT /admin/markets/:id/margin-policy
    Authorization: Bearer <ADMIN_DASHBOARD_TOKEN>

Live quote:

    POST /markets/:id/margin-quote

Example quote request:

    {
      "userId": "<conviction-user-id>",
      "side": "YES",
      "collateralAssets": "100",
      "leverageBps": 20000
    }

## Release Rules

- Keep all policies in DRAFT until production addresses are independently
  verified.
- Approve only a small set of liquid markets first.
- Use 2x at launch. A 3x policy needs explicit per-market approval.
- Pause a policy on provider outage, abnormal spread, stale data, thin depth, or
  approaching mandatory close.
- Do not restore 10x as a global UI or API option.
