import type { FastifyInstance } from "fastify";

import { sendSuccess } from "../lib/responses.js";
import { getUserPreference, upsertUserPreference } from "../services/preferences.js";

type UserParams = { userId: string };

type PreferenceBody = {
  topics?: string[];
  regions?: string[];
  sports?: string[];
  mediaTypes?: string[];
  newsIntervalMinutes?: number;
  notifyInActivity?: boolean;
};

export async function registerPreferenceRoutes(app: FastifyInstance) {
  app.get<{ Params: UserParams }>("/users/:userId/preferences", async (request, reply) => {
    const preference = await getUserPreference(request.params.userId);
    return sendSuccess(reply, { preference });
  });

  app.put<{ Params: UserParams; Body: PreferenceBody }>("/users/:userId/preferences", async (request, reply) => {
    const preference = await upsertUserPreference({ userId: request.params.userId, ...request.body });
    return sendSuccess(reply, { preference });
  });
}
