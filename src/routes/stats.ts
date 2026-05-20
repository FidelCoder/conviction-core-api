import type { FastifyInstance } from "fastify";

import { sendSuccess } from "../lib/responses.js";
import { getTraderProfileStats, listLeaderboard } from "../services/stats.js";

type LeaderboardQuery = {
  limit?: number;
};

type TraderStatsParams = {
  id: string;
};

export async function registerStatsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: LeaderboardQuery }>(
    "/leaderboard",
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
      const leaderboard = await listLeaderboard(request.query.limit);

      return sendSuccess(reply, { leaderboard });
    },
  );

  app.get<{ Params: TraderStatsParams }>(
    "/trader-profiles/:id/stats",
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
      const stats = await getTraderProfileStats(request.params.id);

      return sendSuccess(reply, { stats });
    },
  );
}
