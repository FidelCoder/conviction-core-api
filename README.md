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

## Market Data

Market data must come from real provider integrations. This service includes the provider interface and database fields needed to sync external markets, but it does not include fake markets, demo markets, or hardcoded trading data. Provider implementations can be added later behind the `MarketProvider` interface.

## Structure

- `prisma` keeps the database schema and migrations.
- `src/config` keeps environment validation and runtime config.
- `src/routes` keeps HTTP route modules.
- `src/services` is reserved for service modules.
- `src/lib` keeps shared helpers such as Prisma, responses, and errors.
- `src/plugins` keeps Fastify plugins and cross-cutting handlers.
- `tests` is reserved for test coverage.

Do not add fake users, fake traders, fake markets, fake positions, fake PnL, or demo trade history. Records should come from real user input or real integrations when those integrations are added.
