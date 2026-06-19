import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/errors.js";
import { sendSuccess } from "../lib/responses.js";
import { getMarketById, getMarketHistory, listMarkets, type MarketHistoryRange } from "../services/markets.js";

type MarketParams = {
  id: string;
};

type MarketListQuery = {
  limit?: string;
  q?: string;
  status?: "ACTIVE" | "CLOSED" | "CANCELLED";
};

type MarketHistoryQuery = {
  range?: MarketHistoryRange;
};

export async function registerMarketRoutes(app: FastifyInstance) {
  app.get<{ Querystring: MarketListQuery }>(
    "/markets",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string" },
            q: { type: "string" },
            status: { type: "string", enum: ["ACTIVE", "CLOSED", "CANCELLED"] },
          },
        },
      },
    },
    async (request, reply) => {
      const markets = await listMarkets({
        limit: parseLimit(request.query.limit),
        search: request.query.q,
        status: request.query.status,
      });

      return sendSuccess(reply, { markets });
    },
  );


  app.get<{ Params: MarketParams; Querystring: MarketHistoryQuery }>(
    "/markets/:id/history",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
        querystring: {
          type: "object",
          properties: {
            range: { type: "string", enum: ["1h", "1w", "1m", "1y"] },
          },
        },
      },
    },
    async (request, reply) => {
      const history = await getMarketHistory(request.params.id, request.query.range ?? "1w");

      if (!history) {
        throw new AppError("Market not found", {
          code: "MARKET_NOT_FOUND",
          statusCode: 404,
        });
      }

      return sendSuccess(reply, history);
    },
  );

  app.get<{ Params: MarketParams }>(
    "/markets/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const market = await getMarketById(request.params.id);

      if (!market) {
        throw new AppError("Market not found", {
          code: "MARKET_NOT_FOUND",
          statusCode: 404,
        });
      }

      return sendSuccess(reply, { market });
    },
  );
}

function parseLimit(value: string | undefined) {
  if (!value) return undefined;
  const limit = Number(value);

  if (!Number.isInteger(limit) || limit <= 0) {
    return undefined;
  }

  return Math.min(limit, 500);
}
