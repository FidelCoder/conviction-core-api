# Conviction Core API

Core API workspace for Conviction Markets.

## Setup

Package manager: npm.

```sh
npm install
cp .env.example .env
npm run dev
```

## Commands

- `npm run dev` starts the TypeScript entrypoint with `tsx`.
- `npm run build` runs the TypeScript compiler in check mode.
- `npm run lint` runs ESLint.
- `npm run format` runs Prettier.
- `npm run format:check` checks formatting.

## Structure

- `src/config` keeps environment and runtime config.
- `src/routes` is reserved for API route modules.
- `src/services` is reserved for service modules.
- `src/lib` is reserved for shared helpers.
- `tests` is reserved for test coverage.
