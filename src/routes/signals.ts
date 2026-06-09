import { TradeSignalSide, TradeSignalSource } from "@prisma/client";
import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/errors.js";
import { sendSuccess } from "../lib/responses.js";
import {
  createTradeSignal,
  getTradeSignalById,
  listRecentTradeSignals,
  listMarketTradeSignals,
  listTraderProfileTradeSignals,
} from "../services/signals.js";

type SignalParams = {
  id: string;
};

type MarketSignalsParams = {
  marketId: string;
};

type TraderProfileSignalsParams = {
  traderProfileId: string;
};

type SignalFeedQuery = {
  limit?: number;
};

type CreateSignalBody = {
  traderProfileId: string;
  marketId: string;
  side: TradeSignalSide;
  thesis: string;
  convictionLevel?: number | null;
  source: TradeSignalSource;
};

const signalSourceValues = Object.values(TradeSignalSource);
const signalSideValues = Object.values(TradeSignalSide);

export async function registerSignalRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateSignalBody }>(
    "/signals",
    {
      schema: {
        body: {
          type: "object",
          required: ["traderProfileId", "marketId", "side", "thesis", "source"],
          additionalProperties: false,
          properties: {
            traderProfileId: { type: "string", minLength: 1 },
            marketId: { type: "string", minLength: 1 },
            side: { type: "string", enum: signalSideValues },
            thesis: { type: "string", minLength: 1, maxLength: 5000 },
            convictionLevel: { type: "integer", minimum: 1, maximum: 100, nullable: true },
            source: { type: "string", enum: signalSourceValues },
          },
        },
      },
    },
    async (request, reply) => {
      const signal = await createTradeSignal(request.body);

      return sendSuccess(reply, { signal }, 201);
    },
  );

  app.get<{ Querystring: SignalFeedQuery }>(
    "/signals",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const signals = await listRecentTradeSignals(request.query.limit);

      return sendSuccess(reply, { signals });
    },
  );

  app.get<{ Params: SignalParams }>(
    "/signals/:id",
    {
      schema: {
        params: idParamsSchema("id"),
      },
    },
    async (request, reply) => {
      const signal = await getTradeSignalById(request.params.id);

      if (!signal) {
        throw new AppError("Trade signal not found", {
          code: "TRADE_SIGNAL_NOT_FOUND",
          statusCode: 404,
        });
      }

      return sendSuccess(reply, { signal });
    },
  );

  app.get<{ Params: MarketSignalsParams }>(
    "/markets/:marketId/signals",
    {
      schema: {
        params: idParamsSchema("marketId"),
      },
    },
    async (request, reply) => {
      const signals = await listMarketTradeSignals(request.params.marketId);

      return sendSuccess(reply, { signals });
    },
  );

  app.get<{ Params: TraderProfileSignalsParams }>(
    "/trader-profiles/:traderProfileId/signals",
    {
      schema: {
        params: idParamsSchema("traderProfileId"),
      },
    },
    async (request, reply) => {
      const signals = await listTraderProfileTradeSignals(request.params.traderProfileId);

      return sendSuccess(reply, { signals });
    },
  );
}

function idParamsSchema(paramName: string) {
  return {
    type: "object",
    required: [paramName],
    properties: {
      [paramName]: { type: "string", minLength: 1 },
    },
  };
}
