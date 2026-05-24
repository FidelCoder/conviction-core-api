import type { FastifyInstance } from "fastify";

import { sendSuccess } from "../lib/responses.js";
import { getExecutionCapabilities } from "../services/execution.js";

export async function registerExecutionRoutes(app: FastifyInstance) {
  app.get("/execution/capabilities", async (_request, reply) => {
    return sendSuccess(reply, { execution: getExecutionCapabilities() });
  });
}
