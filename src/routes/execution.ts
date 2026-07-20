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
  authorizePolymarketPositionClose,
  getPolymarketCloseAttempts,
  getPolymarketExecutionReadiness,
  getPolymarketPositionControls,
  preparePolymarketPositionClose,
  preparePolymarketPositionControls,
  preparePolymarketPrincipalRepayment,
  recordPolymarketPrincipalRepayment,
  recordPolymarketExecutionWalletCommit,
  recordPolymarketLoanReservation,
  updatePolymarketPositionControls,
  type AuthorizePolymarketCloseInput,
  type PreparePolymarketCloseInput,
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
            "financingFeeAssets",
            "priceLimit",
            "signature",
          ],
          properties: {
            ...polymarketPreparationSchema.body.properties,
            quoteId: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
            borrowAssets: decimalSchema,
            minimumOutcomeShares: decimalSchema,
            financingFeeAssets: decimalSchema,
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

  app.get<{ Params: PositionExecutionParams; Querystring: { userId: string } }>(
    "/execution/positions/:positionId/polymarket/controls",
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
      return sendSuccess(reply, {
        controls: await getPolymarketPositionControls(
          request.params.positionId,
          request.query.userId,
        ),
      });
    },
  );

  app.put<{
    Params: PositionExecutionParams;
    Body: {
      userId: string;
      stopLossPrice: string | null;
      takeProfitPrice: string | null;
      nonce: string;
      deadline: number;
      signature: string;
    };
  }>(
    "/execution/positions/:positionId/polymarket/controls",
    {
      schema: {
        params: positionParamsSchema,
        body: {
          type: "object",
          required: [
            "userId",
            "stopLossPrice",
            "takeProfitPrice",
            "nonce",
            "deadline",
            "signature",
          ],
          additionalProperties: false,
          properties: {
            userId: { type: "string", minLength: 1 },
            stopLossPrice: { ...decimalSchema, nullable: true },
            takeProfitPrice: { ...decimalSchema, nullable: true },
            nonce: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
            deadline: { type: "integer" },
            signature: { type: "string", pattern: "^0x[a-fA-F0-9]+$" },
          },
        },
      },
    },
    async (request, reply) => {
      return sendSuccess(reply, {
        controls: await updatePolymarketPositionControls({
          positionId: request.params.positionId,
          ...request.body,
        }),
      });
    },
  );

  app.post<{
    Params: PositionExecutionParams;
    Body: {
      userId: string;
      stopLossPrice: string | null;
      takeProfitPrice: string | null;
      nonce: string;
      deadline: number;
    };
  }>(
    "/execution/positions/:positionId/polymarket/controls/prepare",
    {
      schema: {
        params: positionParamsSchema,
        body: {
          type: "object",
          required: ["userId", "stopLossPrice", "takeProfitPrice", "nonce", "deadline"],
          additionalProperties: false,
          properties: {
            userId: { type: "string", minLength: 1 },
            stopLossPrice: { ...decimalSchema, nullable: true },
            takeProfitPrice: { ...decimalSchema, nullable: true },
            nonce: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
            deadline: { type: "integer" },
          },
        },
      },
    },
    async (request, reply) => {
      return sendSuccess(reply, {
        prepared: await preparePolymarketPositionControls({
          positionId: request.params.positionId,
          ...request.body,
        }),
      });
    },
  );

  app.post<{ Params: PositionExecutionParams; Body: { userId: string; assets: string } }>(
    "/execution/positions/:positionId/polymarket/repay/prepare",
    {
      schema: {
        params: positionParamsSchema,
        body: {
          type: "object",
          required: ["userId", "assets"],
          additionalProperties: false,
          properties: { userId: { type: "string", minLength: 1 }, assets: decimalSchema },
        },
      },
    },
    async (request, reply) => {
      return sendSuccess(reply, {
        prepared: await preparePolymarketPrincipalRepayment({
          positionId: request.params.positionId,
          ...request.body,
        }),
      });
    },
  );

  app.post<{ Params: PositionExecutionParams; Body: PreparePolymarketCloseInput }>(
    "/execution/positions/:positionId/polymarket/close/prepare",
    { schema: polymarketClosePreparationSchema },
    async (request, reply) => {
      const prepared = await preparePolymarketPositionClose(
        request.params.positionId,
        request.body,
      );
      return sendSuccess(reply, { prepared });
    },
  );

  app.post<{ Params: PositionExecutionParams; Body: AuthorizePolymarketCloseInput }>(
    "/execution/positions/:positionId/polymarket/close/authorize",
    {
      schema: {
        ...polymarketClosePreparationSchema,
        body: {
          ...polymarketClosePreparationSchema.body,
          required: [
            ...polymarketClosePreparationSchema.body.required,
            "minimumProceeds",
            "priceLimit",
            "signature",
          ],
          properties: {
            ...polymarketClosePreparationSchema.body.properties,
            minimumProceeds: decimalSchema,
            priceLimit: decimalSchema,
            signature: { type: "string", pattern: "^0x[a-fA-F0-9]+$" },
          },
        },
      },
    },
    async (request, reply) => {
      const closeAttempt = await authorizePolymarketPositionClose(
        request.params.positionId,
        request.body,
      );
      return sendSuccess(reply, { closeAttempt }, 201);
    },
  );

  app.get<{ Params: PositionExecutionParams; Querystring: { userId: string } }>(
    "/execution/positions/:positionId/polymarket/close-attempts",
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
      const closeAttempts = await getPolymarketCloseAttempts(
        request.params.positionId,
        request.query.userId,
      );
      return sendSuccess(reply, { closeAttempts });
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

  app.post<{
    Params: { executionId: string };
    Body: { userId: string; assets: string; transactionHash: string };
  }>(
    "/execution/polymarket/:executionId/repayments",
    {
      schema: {
        params: executionIdParamsSchema,
        body: {
          type: "object",
          required: ["userId", "assets", "transactionHash"],
          additionalProperties: false,
          properties: {
            userId: { type: "string", minLength: 1 },
            assets: decimalSchema,
            transactionHash: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
          },
        },
      },
    },
    async (request, reply) => {
      return sendSuccess(reply, {
        controls: await recordPolymarketPrincipalRepayment({
          executionId: request.params.executionId,
          ...request.body,
        }),
      });
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

  app.post<{
    Params: { executionId: string };
    Body: { userId: string; transactionHash: string };
  }>(
    "/execution/polymarket/:executionId/wallet-commit",
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
      const execution = await recordPolymarketExecutionWalletCommit({
        executionId: request.params.executionId,
        userId: request.body.userId,
        transactionHash: request.body.transactionHash,
      });
      return sendSuccess(reply, { execution });
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

const polymarketClosePreparationSchema = {
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
