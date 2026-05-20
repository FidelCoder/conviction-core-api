# Conviction Core API

Core API service for Conviction Markets. This repo owns product and business logic for the Telegram and Farcaster clients.

## Setup

Package manager: npm.

```sh
npm install
cp .env.example .env
npm run db:generate
npm run dev
```

The API expects PostgreSQL. Set `DATABASE_URL` in `.env` before running migrations or starting the server.

## Commands

- `npm run dev` starts the Fastify server in watch mode.
- `npm run build` runs the TypeScript compiler in check mode.
- `npm run lint` runs ESLint.
- `npm run format` runs Prettier.
- `npm run format:check` checks formatting.
- `npm run db:generate` generates the Prisma client.
- `npm run db:migrate` creates and applies local Prisma migrations.
- `npm run db:deploy` applies committed migrations in deployed environments.
- `npm run db:studio` opens Prisma Studio.
- `npm run markets:sync:polymarket -- --limit=50` syncs real active Polymarket markets from Gamma.

## Database Migrations

Create a migration after changing `prisma/schema.prisma`:

```sh
npm run db:migrate -- --name describe_change
```

Apply committed migrations in an environment:

```sh
npm run db:deploy
```

## HTTP

- `GET /health` returns API health status.
- `GET /markets` returns persisted market records. Until a real provider integration is added, this returns an empty list when no markets have been synced.
- `GET /markets/:id` returns one persisted market record by internal market id.
- `POST /signals` creates a trade signal against an existing trader profile and synced market.
- `GET /signals/:id` returns one trade signal.
- `GET /markets/:marketId/signals` returns signals for one market.
- `GET /trader-profiles/:traderProfileId/signals` returns signals from one trader profile.
- `POST /positions` creates a pending execution position intent for an existing user and market.
- `GET /positions/:id` returns one position intent.
- `GET /users/:userId/positions` returns positions for one user.
- `GET /trader-profiles/:traderProfileId/positions` returns positions for the user behind one trader profile.
- `POST /copy-trades` creates a pending execution copy intent against an existing source position.
- `GET /positions/:positionId/copy-trades` returns copy intents for one source position.
- `GET /leaderboard` returns trader stats calculated from real database records.
- `GET /trader-profiles/:id/stats` returns stats for one trader profile.

## Market Data

Market data must come from real provider integrations. The Polymarket provider reads public market records from the Gamma API and persists them through the shared market sync service. The sync path does not create fallback markets, placeholders, demo markets, or hardcoded trading data.

Configure the provider in `.env`:

```sh
POLYMARKET_GAMMA_API_URL=https://gamma-api.polymarket.com
POLYMARKET_MARKETS_SYNC_LIMIT=50
```

Sync real active Polymarket markets for local development or admin use:

```sh
npm run markets:sync:polymarket -- --limit=50
```

If Polymarket or PostgreSQL is unavailable, the command exits with `POLYMARKET_SYNC_FAILED` and does not insert placeholder records.

## Trade Signals

Trade signals are expressions of thesis or intent. Creating a signal does not create a position, calculate PnL, or imply execution. The referenced trader profile and market must already exist in the database.

Create a signal:

```sh
curl -X POST http://localhost:3000/signals \
  -H 'Content-Type: application/json' \
  -d '{
    "traderProfileId": "existing-trader-profile-id",
    "marketId": "existing-market-id",
    "side": "YES",
    "thesis": "Market thesis based on the trader's real view.",
    "convictionLevel": 75,
    "source": "WEB"
  }'
```

Read signals:

```sh
curl http://localhost:3000/signals/:id
curl http://localhost:3000/markets/:marketId/signals
curl http://localhost:3000/trader-profiles/:traderProfileId/signals
```

## Positions and Copy Intents

Positions and copy records are intent records until a real execution adapter is added. New records are created with `PENDING_EXECUTION`. They must not be marked `EXECUTED` unless a real adapter confirms execution. Failed or cancelled attempts can use `FAILED` or `CANCELLED` once execution handling exists.

Execution fields such as `averageEntryPrice`, `executedQuantity`, `executionPrice`, `resultingPositionId`, and `openedAt` stay `null` when there is no confirmed execution. The API does not calculate PnL.

When a synced market has real price fields, the API stores an `observedMarketPrice` snapshot from the market record at intent creation time. If no real market price is available, `observedMarketPrice`, `observedMarketPriceSource`, and `observedMarketPriceAt` are returned as `null`.

Create a position intent:

```sh
curl -X POST http://localhost:3000/positions \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "existing-user-id",
    "marketId": "existing-market-id",
    "side": "YES",
    "quantity": "10.00000000"
  }'
```

Create a copy intent:

```sh
curl -X POST http://localhost:3000/copy-trades \
  -H 'Content-Type: application/json' \
  -d '{
    "followerId": "existing-user-id",
    "sourcePositionId": "existing-source-position-id",
    "requestedQuantity": "5.00000000"
  }'
```

Read positions and copy intents:

```sh
curl http://localhost:3000/positions/:id
curl http://localhost:3000/users/:userId/positions
curl http://localhost:3000/trader-profiles/:traderProfileId/positions
curl http://localhost:3000/positions/:positionId/copy-trades
```

## Real Stats and Leaderboard

Stats are calculated from persisted records only:

- `numberOfSignals` counts real `TradeSignal` rows for a trader profile.
- `numberOfCopyIntents` counts real `CopyTrade` rows submitted against positions owned by the trader profile's user.
- `copiedVolume` sums `requestedQuantity` from those submitted copy intents.
- `executedCopiedVolume` sums `executedQuantity` only for copy intents with `EXECUTED` status; it returns `null` when there are no executed copy intents.
- `realizedPnl` returns `null` until real execution and close data exists in the database.

The leaderboard does not invent win rate, PnL, trader performance, or copied volume. Entries are sorted by real copy intent count, copied volume, then signal count.

Read stats:

```sh
curl http://localhost:3000/leaderboard
curl http://localhost:3000/trader-profiles/:id/stats
```

## Structure

- `prisma` keeps the database schema and migrations.
- `src/config` keeps environment validation and runtime config.
- `src/routes` keeps HTTP route modules.
- `src/services` is reserved for service modules.
- `src/lib` keeps shared helpers such as Prisma, responses, and errors.
- `src/plugins` keeps Fastify plugins and cross-cutting handlers.
- `tests` is reserved for test coverage.

Do not add fake users, fake traders, fake markets, fake positions, fake PnL, or demo trade history. Records should come from real user input or real integrations when those integrations are added.
