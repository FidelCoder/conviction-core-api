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

## Structure

- `prisma` keeps the database schema and migrations.
- `src/config` keeps environment validation and runtime config.
- `src/routes` keeps HTTP route modules.
- `src/services` is reserved for service modules.
- `src/lib` keeps shared helpers such as Prisma, responses, and errors.
- `src/plugins` keeps Fastify plugins and cross-cutting handlers.
- `tests` is reserved for test coverage.

Do not add fake users, fake traders, fake markets, fake positions, fake PnL, or demo trade history. Records should come from real user input or real integrations when those integrations are added.
