import type { FastifyInstance } from "fastify";

import { sendSuccess } from "../lib/responses.js";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async (_request, reply) => {
    return sendSuccess(reply, {
      service: "conviction-core-api",
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });
}
