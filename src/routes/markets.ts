import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/errors.js";
import { sendSuccess } from "../lib/responses.js";
import { getMarketById, listMarkets } from "../services/markets.js";

type MarketParams = {
  id: string;
};

export async function registerMarketRoutes(app: FastifyInstance) {
  app.get("/markets", async (_request, reply) => {
    const markets = await listMarkets();

    return sendSuccess(reply, { markets });
  });

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
