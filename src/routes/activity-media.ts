import type { FastifyInstance } from "fastify";

import { sendSuccess } from "../lib/responses.js";
import { createActivityMediaItem, generatePreferenceNewsFeed, listActivityMediaFeed } from "../services/activity-media.js";

type FeedQuery = { userId?: string; limit?: number };
type GenerateBody = { userId: string; limit?: number };

type CreateBody = {
  userId?: string | null;
  marketId?: string | null;
  kind: string;
  title: string;
  summary: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  mediaBrief?: unknown;
  source?: string;
};

export async function registerActivityMediaRoutes(app: FastifyInstance) {
  app.get<{ Querystring: FeedQuery }>("/activity-media", async (request, reply) => {
    const items = await listActivityMediaFeed(request.query);
    return sendSuccess(reply, { items });
  });

  app.post<{ Body: CreateBody }>("/activity-media", async (request, reply) => {
    const item = await createActivityMediaItem(request.body);
    return sendSuccess(reply, { item }, 201);
  });

  app.post<{ Body: GenerateBody }>("/activity-media/generate", async (request, reply) => {
    const items = await generatePreferenceNewsFeed(request.body.userId, request.body.limit);
    return sendSuccess(reply, { items }, 201);
  });
}
