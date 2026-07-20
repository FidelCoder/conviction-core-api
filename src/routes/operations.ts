import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

import { env } from "../config/index.js";
import { AppError } from "../lib/errors.js";
import { sendSuccess } from "../lib/responses.js";
import { PolymarketProvider } from "../providers/polymarket/index.js";
import { syncMarketsFromProvider } from "../services/markets.js";
import { reconcilePendingPolymarketExecutions } from "../services/polymarket-execution-orchestrator.js";

type MarketSyncQuery = {
  limit?: string;
};

type ExecutionReconcileQuery = {
  limit?: string;
};

const maxServerlessSyncLimit = 180;

export async function registerOperationsRoutes(app: FastifyInstance) {
  const syncOptions = {
    schema: {
      querystring: {
        type: "object",
        properties: {
          limit: { type: "string" },
        },
      },
    },
  };

  app.post<{ Querystring: MarketSyncQuery }>(
    "/ops/markets/sync",
    syncOptions,
    async (request, reply) => {
      return handleMarketSync(request.headers.authorization, request.query, reply);
    },
  );

  app.get<{ Querystring: MarketSyncQuery }>(
    "/ops/markets/sync",
    syncOptions,
    async (request, reply) => {
      return handleMarketSync(request.headers.authorization, request.query, reply);
    },
  );

  const reconciliationOptions = {
    schema: {
      querystring: {
        type: "object",
        properties: { limit: { type: "string" } },
      },
    },
  };

  app.post<{ Querystring: ExecutionReconcileQuery }>(
    "/ops/executions/polymarket/reconcile",
    reconciliationOptions,
    async (request, reply) => {
      return handleExecutionReconciliation(request.headers.authorization, request.query, reply);
    },
  );

  app.get<{ Querystring: ExecutionReconcileQuery }>(
    "/ops/executions/polymarket/reconcile",
    reconciliationOptions,
    async (request, reply) => {
      return handleExecutionReconciliation(request.headers.authorization, request.query, reply);
    },
  );
}

async function handleExecutionReconciliation(
  authorization: string | undefined,
  query: ExecutionReconcileQuery,
  reply: Parameters<typeof sendSuccess>[0],
) {
  assertAuthorized(authorization);
  const limit = parseLimit(query.limit) ?? 10;
  return sendSuccess(reply, {
    reconciliation: await reconcilePendingPolymarketExecutions(limit),
  });
}

async function handleMarketSync(
  authorization: string | undefined,
  query: MarketSyncQuery,
  reply: Parameters<typeof sendSuccess>[0],
) {
  assertAuthorized(authorization);

  const limit =
    parseLimit(query.limit) ?? Math.min(env.polymarketMarketsSyncLimit, maxServerlessSyncLimit);
  const provider = new PolymarketProvider({
    gammaApiUrl: env.polymarketGammaApiUrl,
    listLimit: limit,
  });
  const result = await syncMarketsFromProvider(provider);

  return sendSuccess(reply, {
    requested: result.requested,
    retired: result.retired,
    source: result.source,
    synced: result.synced,
  });
}

function assertAuthorized(authorization: string | undefined) {
  const allowedTokens = [env.marketSyncToken, env.cronSecret].filter(Boolean) as string[];

  if (allowedTokens.length === 0) {
    throw new AppError("Market sync token is not configured", {
      code: "MARKET_SYNC_TOKEN_MISSING",
      statusCode: 503,
    });
  }

  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";

  if (!allowedTokens.some((allowedToken) => isSameToken(token, allowedToken))) {
    throw new AppError("Operations request is not authorized", {
      code: "MARKET_SYNC_UNAUTHORIZED",
      statusCode: 401,
    });
  }
}

function isSameToken(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseLimit(value: string | undefined) {
  if (!value) return undefined;
  const limit = Number(value);

  if (!Number.isInteger(limit) || limit <= 0) {
    return undefined;
  }

  return Math.min(limit, maxServerlessSyncLimit);
}
