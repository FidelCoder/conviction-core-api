import type { FastifyInstance } from "fastify";

import { sendSuccess } from "../lib/responses.js";
import {
  getExecutionCapabilities,
  getExecutionReadiness,
  settlePositionExecution,
  startPositionExecution,
} from "../services/execution.js";
import {
  authorizePolymarketMarginExecution,
  getPolymarketMarginExecution,
  preparePolymarketMarginExecution,
  type AuthorizePolymarketExecutionInput,
  type PreparePolymarketExecutionInput,
} from "../services/polymarket-margin-execution.js";
import {
  advancePolymarketMarginExecution,
  getPolymarketExecutionReadiness,
  recordPolymarketLoanReservation,
} from "../services/polymarket-execution-orchestrator.js";

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

  app.get("/execution/polymarket/readiness", async (_request, reply) => {
    return sendSuccess(reply, { readiness: await getPolymarketExecutionReadiness() });
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

  app.post<{ Params: PositionExecutionParams; Body: PreparePolymarketExecutionInput }>(
    "/execution/positions/:positionId/polymarket/prepare",
    { schema: polymarketPreparationSchema },
    async (request, reply) => {
      const prepared = await preparePolymarketMarginExecution(
        request.params.positionId,
        request.body,
      );
      return sendSuccess(reply, { prepared });
    },
  );

  app.post<{ Params: PositionExecutionParams; Body: AuthorizePolymarketExecutionInput }>(
    "/execution/positions/:positionId/polymarket/authorize",
    {
      schema: {
        ...polymarketPreparationSchema,
        body: {
          ...polymarketPreparationSchema.body,
          required: [
            ...polymarketPreparationSchema.body.required,
            "quoteId",
            "borrowAssets",
            "minimumOutcomeShares",
            "priceLimit",
            "signature",
          ],
          properties: {
            ...polymarketPreparationSchema.body.properties,
            quoteId: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
            borrowAssets: decimalSchema,
            minimumOutcomeShares: decimalSchema,
            priceLimit: decimalSchema,
            signature: { type: "string", pattern: "^0x[a-fA-F0-9]+$" },
          },
        },
      },
    },
    async (request, reply) => {
      const execution = await authorizePolymarketMarginExecution(
        request.params.positionId,
        request.body,
      );
      return sendSuccess(reply, { execution }, 201);
    },
  );

  app.get<{ Params: PositionExecutionParams; Querystring: { userId: string } }>(
    "/execution/positions/:positionId/polymarket",
    {
      schema: {
        params: positionParamsSchema,
        querystring: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: { userId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const execution = await getPolymarketMarginExecution(
        request.params.positionId,
        request.query.userId,
      );
      return sendSuccess(reply, { execution });
    },
  );

  app.post<{
    Params: { executionId: string };
    Body: { userId: string; transactionHash: string };
  }>(
    "/execution/polymarket/:executionId/reservation",
    {
      schema: {
        params: executionIdParamsSchema,
        body: {
          type: "object",
          required: ["userId", "transactionHash"],
          additionalProperties: false,
          properties: {
            userId: { type: "string", minLength: 1 },
            transactionHash: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const execution = await recordPolymarketLoanReservation({
        executionId: request.params.executionId,
        userId: request.body.userId,
        transactionHash: request.body.transactionHash,
      });
      return sendSuccess(reply, { execution });
    },
  );

  app.post<{ Params: { executionId: string }; Body: { userId: string } }>(
    "/execution/polymarket/:executionId/advance",
    {
      schema: {
        params: executionIdParamsSchema,
        body: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: { userId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const execution = await advancePolymarketMarginExecution({
        executionId: request.params.executionId,
        userId: request.body.userId,
      });
      return sendSuccess(reply, { execution }, 202);
    },
  );
}

const positionParamsSchema = {
  type: "object",
  required: ["positionId"],
  additionalProperties: false,
  properties: { positionId: { type: "string", minLength: 1 } },
} as const;

const executionIdParamsSchema = {
  type: "object",
  required: ["executionId"],
  additionalProperties: false,
  properties: { executionId: { type: "string", minLength: 1 } },
} as const;

const decimalSchema = { type: "string", pattern: "^\\d+(?:\\.\\d{1,6})?$" } as const;

const polymarketPreparationSchema = {
  params: positionParamsSchema,
  body: {
    type: "object",
    required: ["userId", "idempotencyKey", "nonce", "deadline", "maxSlippageBps"],
    additionalProperties: false,
    properties: {
      userId: { type: "string", minLength: 1 },
      idempotencyKey: { type: "string", minLength: 12, maxLength: 160 },
      nonce: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
      deadline: { type: "integer" },
      maxSlippageBps: { type: "integer", minimum: 0, maximum: 500 },
    },
  },
} as const;
