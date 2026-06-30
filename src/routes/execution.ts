import type { FastifyInstance } from "fastify";

import { sendSuccess } from "../lib/responses.js";
import {
  getExecutionCapabilities,
  getExecutionReadiness,
  settlePositionExecution,
  startPositionExecution,
} from "../services/execution.js";

type PositionExecutionParams = {
  positionId: string;
};

export async function registerExecutionRoutes(app: FastifyInstance) {
  app.get("/execution/capabilities", async (_request, reply) => {
    return sendSuccess(reply, { execution: await getExecutionCapabilities() });
  });

  app.get("/execution/readiness", async (_request, reply) => {
    return sendSuccess(reply, { readiness: await getExecutionReadiness() });
  });

  app.post<{ Params: PositionExecutionParams }>(
    "/execution/positions/:positionId/start",
    {
      schema: {
        params: {
          type: "object",
          required: ["positionId"],
          properties: {
            positionId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const executionAttempt = await startPositionExecution(request.params.positionId);

      return sendSuccess(reply, { executionAttempt }, 202);
    },
  );

  app.post<{ Params: PositionExecutionParams }>(
    "/execution/positions/:positionId/settle",
    {
      schema: {
        params: {
          type: "object",
          required: ["positionId"],
          properties: {
            positionId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const executionAttempt = await settlePositionExecution(request.params.positionId);

      return sendSuccess(reply, { executionAttempt }, 202);
    },
  );
}
