import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/errors.js";
import { sendSuccess } from "../lib/responses.js";
import {
  getExecutionAttemptById,
  listCopyTradeExecutionAttempts,
  listPositionExecutionAttempts,
  startCopyTradeExecution,
  startPositionExecution,
} from "../services/execution-attempts.js";
import { getExecutionCapabilities } from "../services/execution.js";

type ExecutionAttemptParams = {
  id: string;
};

type PositionExecutionParams = {
  positionId: string;
};

type CopyTradeExecutionParams = {
  copyTradeId: string;
};

export async function registerExecutionRoutes(app: FastifyInstance) {
  app.get("/execution/capabilities", async (_request, reply) => {
    return sendSuccess(reply, { execution: getExecutionCapabilities() });
  });

  app.post<{ Params: PositionExecutionParams }>(
    "/execution/positions/:positionId/start",
    {
      schema: {
        params: idParamsSchema("positionId"),
      },
    },
    async (request, reply) => {
      const executionAttempt = await startPositionExecution(request.params.positionId);

      return sendSuccess(reply, { executionAttempt }, 202);
    },
  );

  app.get<{ Params: PositionExecutionParams }>(
    "/positions/:positionId/execution-attempts",
    {
      schema: {
        params: idParamsSchema("positionId"),
      },
    },
    async (request, reply) => {
      const executionAttempts = await listPositionExecutionAttempts(request.params.positionId);

      return sendSuccess(reply, { executionAttempts });
    },
  );

  app.post<{ Params: CopyTradeExecutionParams }>(
    "/execution/copy-trades/:copyTradeId/start",
    {
      schema: {
        params: idParamsSchema("copyTradeId"),
      },
    },
    async (request, reply) => {
      const executionAttempt = await startCopyTradeExecution(request.params.copyTradeId);

      return sendSuccess(reply, { executionAttempt }, 202);
    },
  );

  app.get<{ Params: CopyTradeExecutionParams }>(
    "/copy-trades/:copyTradeId/execution-attempts",
    {
      schema: {
        params: idParamsSchema("copyTradeId"),
      },
    },
    async (request, reply) => {
      const executionAttempts = await listCopyTradeExecutionAttempts(request.params.copyTradeId);

      return sendSuccess(reply, { executionAttempts });
    },
  );

  app.get<{ Params: ExecutionAttemptParams }>(
    "/execution/attempts/:id",
    {
      schema: {
        params: idParamsSchema("id"),
      },
    },
    async (request, reply) => {
      const executionAttempt = await getExecutionAttemptById(request.params.id);

      if (!executionAttempt) {
        throw new AppError("Execution attempt not found", {
          code: "EXECUTION_ATTEMPT_NOT_FOUND",
          statusCode: 404,
        });
      }

      return sendSuccess(reply, { executionAttempt });
    },
  );
}

function idParamsSchema(key: string) {
  return {
    type: "object",
    required: [key],
    additionalProperties: false,
    properties: {
      [key]: { type: "string", minLength: 1 },
    },
  };
}
