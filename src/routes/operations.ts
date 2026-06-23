import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

import { env } from "../config/index.js";
import { AppError } from "../lib/errors.js";
import { sendSuccess } from "../lib/responses.js";
import { PolymarketProvider } from "../providers/polymarket/index.js";
import { syncMarketsFromProvider } from "../services/markets.js";

type MarketSyncQuery = {
  limit?: string;
};

const maxServerlessSyncLimit = 180;

export async function registerOperationsRoutes(app: FastifyInstance) {
  app.post<{ Querystring: MarketSyncQuery }>(
    "/ops/markets/sync",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      assertAuthorized(request.headers.authorization);

      const limit = parseLimit(request.query.limit) ?? Math.min(env.polymarketMarketsSyncLimit, maxServerlessSyncLimit);
      const provider = new PolymarketProvider({
        gammaApiUrl: env.polymarketGammaApiUrl,
        listLimit: limit,
      });
      const result = await syncMarketsFromProvider(provider);

      return sendSuccess(reply, {
        requested: result.requested,
        source: result.source,
        synced: result.synced,
      });
    },
  );
}

function assertAuthorized(authorization: string | undefined) {
  if (!env.marketSyncToken) {
    throw new AppError("Market sync token is not configured", {
      code: "MARKET_SYNC_TOKEN_MISSING",
      statusCode: 503,
    });
  }

  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";

  if (!isSameToken(token, env.marketSyncToken)) {
    throw new AppError("Market sync is not authorized", {
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
