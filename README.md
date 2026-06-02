# Conviction Core API

Core API service for Conviction Markets. This repo owns product and business logic for the Telegram and Farcaster clients.

## Setup

Package manager: npm.

```sh
npm install
cp .env.example .env
npm run db:local:up
npm run db:generate
npm run db:push
npm run dev
```

The API expects MongoDB. The default `.env.example` points to the local Docker MongoDB replica set. Run `npm run db:local:up`, then `npm run db:push` to sync Prisma indexes and collections before starting the server. Use MongoDB Atlas or another publicly reachable replica-set backed MongoDB deployment for production/Vercel.

## Commands

- `npm run dev` starts the Fastify server in watch mode.
- `npm run build` runs the TypeScript compiler in check mode.
- `npm run lint` runs ESLint.
- `npm run format` runs Prettier.
- `npm run format:check` checks formatting.
- `npm run db:local:up` starts the local MongoDB replica-set container.
- `npm run db:local:down` stops the local MongoDB container.
- `npm run db:generate` generates the Prisma client.
- `npm run db:push` syncs the Prisma schema to MongoDB. MongoDB does not use the old PostgreSQL migration files.
- `npm run db:studio` opens Prisma Studio.
- `npm run markets:sync:polymarket -- --limit=50` syncs real active Polymarket markets from Gamma.

## Database Schema

This service uses Prisma with MongoDB. After changing `prisma/schema.prisma`, sync the schema with MongoDB:

```sh
npm run db:push
```

Prisma Migrate is not used for this MongoDB setup. Numeric trading values are stored as validated decimal strings so the API does not lose precision through floating point storage.

## Vercel Deployment

The API uses `api/index.ts` as the Vercel serverless entry and routes every public request to the Fastify app from `src/app.ts`. Local development still uses `src/index.ts` and `app.listen()`. The Vercel install command includes dev dependencies for build-time TypeScript checks, and the build command runs Prisma client generation before TypeScript so cached builds use the current schema.

Production needs a real MongoDB connection string before deployment; `mongodb://127.0.0.1:27017/...` is only for local development and will not be reachable from Vercel.

Required Vercel environment variables:

```sh
DATABASE_URL=mongodb+srv://<username>:<password>@<cluster-url>/conviction_markets?retryWrites=true&w=majority
NODE_ENV=production
LOG_LEVEL=info
POLYMARKET_GAMMA_API_URL=https://gamma-api.polymarket.com
POLYMARKET_MARKETS_SYNC_LIMIT=50
```

Deployment checklist:

```sh
vercel link --yes --project conviction-core-api
vercel env add DATABASE_URL production
vercel env add NODE_ENV production
vercel env add LOG_LEVEL production
vercel env add POLYMARKET_GAMMA_API_URL production
vercel env add POLYMARKET_MARKETS_SYNC_LIMIT production
npm run db:generate
npm run build
npm run lint
vercel --prod
```

Run `npm run db:push` against the same production MongoDB database before beta testing writes. Then verify the public API is reachable without a Vercel login or bypass token:

```sh
curl https://<core-api-vercel-url>/health
curl https://<core-api-vercel-url>/markets
```

If Vercel returns an authentication page, disable deployment protection for the public beta environment before wiring the URL into the Farcaster app. Farcaster clients cannot call a protected core API.

## HTTP

- `GET /health` returns API health status.
- `GET /execution/capabilities` returns the current execution capability contract for clients.
- `POST /execution/positions/:positionId/start` records an execution attempt and blocks it while adapters/contracts are not live.
- `POST /social-accounts` creates or fetches a real user from a Telegram or Farcaster identity.
- `POST /trader-profiles` creates or updates a trader profile for a real user.
- `GET /trader-profiles/:id` returns one trader profile.
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
- `GET /users/:userId/copy-trades` returns copy intents submitted by one follower user.
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

If Polymarket or MongoDB is unavailable, the command exits with `POLYMARKET_SYNC_FAILED` and does not insert placeholder records.

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

## Execution Intents

The API supports intent-first execution records for beta testing. Clients may create margin position intents with `executionMode=MARGIN`, EVM chain metadata, wallet address, collateral, and leverage. These records stay `PENDING_EXECUTION`. Starting execution creates an `ExecutionAttempt` with `BLOCKED` status until real contracts, vault liquidity, liquidation rules, and provider adapters are live.

Current capability discovery:

```sh
curl http://localhost:3000/execution/capabilities
```

Create a margin intent and record the blocked attempt:

```sh
curl -X POST http://localhost:3000/positions \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "existing-user-id",
    "marketId": "existing-market-id",
    "side": "YES",
    "quantity": "10",
    "executionMode": "MARGIN",
    "chainId": 8453,
    "walletAddress": "0x0000000000000000000000000000000000000000",
    "leverageMultiplier": "3",
    "marginCollateral": "25"
  }'

curl -X POST http://localhost:3000/execution/positions/:positionId/start
```

This does not execute a trade, submit an order, create PnL, or mark a position as executed.

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
curl http://localhost:3000/users/:userId/copy-trades
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

## Demo Readiness

This demo flow uses real local records created through the API. Replace every placeholder with a real local operator value. Do not seed fake users, fake traders, fake markets, fake positions, or fake trade history.

Start local MongoDB, sync the schema, and run the API:

```sh
npm install
cp .env.example .env
npm run db:local:up
npm run db:generate
npm run db:push
npm run dev
```

Sync real markets from Polymarket. If the provider is unavailable, stop here and keep the market empty state visible.

```sh
npm run markets:sync:polymarket -- --limit=10
curl http://localhost:3000/markets
```

Create or fetch a real Telegram user record. Use your own Telegram numeric ID and username, or run `/start` in the Telegram bot once it points at this API.

```sh
curl -X POST http://localhost:3000/social-accounts \
  -H 'Content-Type: application/json' \
  -d '{
    "platform": "TELEGRAM",
    "platformUserId": "<your-real-telegram-user-id>",
    "username": "<your-real-telegram-username>",
    "displayName": "<your-real-display-name>",
    "profileUrl": "https://t.me/<your-real-telegram-username>"
  }'
```

Create or update a trader profile for that real user. Use the returned `user.id` from the previous response.

```sh
curl -X POST http://localhost:3000/trader-profiles \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "<real-user-id>",
    "handle": "<real-trader-handle>",
    "bio": "Local demo profile for a real operator."
  }'
```

Create a signal against a synced market. Use a real `market.id` from `GET /markets` and the real `traderProfile.id` from the previous response.

```sh
curl -X POST http://localhost:3000/signals \
  -H 'Content-Type: application/json' \
  -d '{
    "traderProfileId": "<real-trader-profile-id>",
    "marketId": "<real-synced-market-id>",
    "side": "YES",
    "thesis": "My real thesis for this market.",
    "convictionLevel": 75,
    "source": "WEB"
  }'
```

Create a pending position intent from real user input. This is not execution and does not create PnL.

```sh
curl -X POST http://localhost:3000/positions \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "<real-user-id>",
    "marketId": "<real-synced-market-id>",
    "side": "YES",
    "quantity": "10.00000000"
  }'
```

Create a second real user, then submit a copy intent against the source position. The response should remain `PENDING_EXECUTION` until a real execution adapter exists.

```sh
curl -X POST http://localhost:3000/copy-trades \
  -H 'Content-Type: application/json' \
  -d '{
    "followerId": "<real-follower-user-id>",
    "sourcePositionId": "<real-source-position-id>",
    "requestedQuantity": "5.00000000"
  }'
```

Check the demo read endpoints:

```sh
curl http://localhost:3000/health
curl http://localhost:3000/leaderboard
curl http://localhost:3000/trader-profiles/<real-trader-profile-id>/stats
curl http://localhost:3000/positions/<real-source-position-id>/copy-trades
```

Demo script:

1. Run core API on `http://localhost:3000`.
2. Sync real Polymarket markets or show the empty market state if sync is unavailable.
3. Start Telegram with `CORE_API_URL=http://localhost:3000`.
4. Start Farcaster/web with the same `CORE_API_URL=http://localhost:3000`.
5. Create or fetch a real Telegram user through `/start` or `POST /social-accounts`.
6. Create a real trader profile for that user.
7. Create a trade signal against a real synced market.
8. Open the Farcaster signal page and share the Mini App card.
9. Submit a copy intent from another real user.
10. Confirm leaderboard and stats update only from the recorded signal/copy-intent rows.

## Structure

- `prisma` keeps the MongoDB Prisma schema.
- `src/config` keeps environment validation and runtime config.
- `src/routes` keeps HTTP route modules.
- `src/services` is reserved for service modules.
- `src/lib` keeps shared helpers such as Prisma, responses, and errors.
- `src/plugins` keeps Fastify plugins and cross-cutting handlers.
- `tests` is reserved for test coverage.

Do not add fake users, fake traders, fake markets, fake positions, fake PnL, or demo trade history. Records should come from real user input or real integrations when those integrations are added.
