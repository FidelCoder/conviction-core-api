import { ExecutionMode, PositionSide } from "@prisma/client";
import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/errors.js";
import { sendSuccess } from "../lib/responses.js";
import {
  createCopyTrade,
  createPosition,
  getPositionById,
  listPositionCopyTrades,
  listTraderProfilePositions,
  listUserCopyTrades,
  listUserPositions,
} from "../services/positions.js";

type PositionParams = {
  id: string;
};

type UserPositionsParams = {
  userId: string;
};

type TraderProfilePositionsParams = {
  traderProfileId: string;
};

type PositionCopyTradesParams = {
  positionId: string;
};

type CreatePositionBody = {
  userId: string;
  marketId: string;
  side: PositionSide;
  quantity: string;
  executionMode?: ExecutionMode;
  chainId?: number | null;
  walletAddress?: string | null;
  leverageMultiplier?: string | null;
  marginCollateral?: string | null;
  idempotencyKey?: string | null;
  visibility?: "PUBLIC" | "PRIVATE" | null;
};

type CreateCopyTradeBody = {
  followerId: string;
  sourcePositionId: string;
  requestedQuantity: string;
  sourceSignalId?: string | null;
};

const positionSideValues = Object.values(PositionSide);
const executionModeValues = Object.values(ExecutionMode);
const decimalStringSchema = {
  type: "string",
  minLength: 1,
  maxLength: 40,
  pattern: String.raw`^(?:0|[1-9]\d*)(?:\.\d{1,8})?$`,
};

export async function registerPositionRoutes(app: FastifyInstance) {
  app.post<{ Body: CreatePositionBody }>(
    "/positions",
    {
      schema: {
        body: {
          type: "object",
          required: ["userId", "marketId", "side", "quantity"],
          additionalProperties: false,
          properties: {
            userId: { type: "string", minLength: 1 },
            marketId: { type: "string", minLength: 1 },
            side: { type: "string", enum: positionSideValues },
            quantity: decimalStringSchema,
            executionMode: { type: "string", enum: executionModeValues, nullable: true },
            chainId: { type: "integer", minimum: 1, nullable: true },
            walletAddress: { type: "string", minLength: 1, maxLength: 64, nullable: true },
            leverageMultiplier: { ...decimalStringSchema, nullable: true },
            marginCollateral: { ...decimalStringSchema, nullable: true },
            idempotencyKey: { type: "string", minLength: 1, maxLength: 128, nullable: true },
            visibility: { type: "string", enum: ["PUBLIC", "PRIVATE"], nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const position = await createPosition(request.body);

      return sendSuccess(reply, { position }, 201);
    },
  );

  app.get<{ Params: PositionParams }>(
    "/positions/:id",
    {
      schema: {
        params: idParamsSchema("id"),
      },
    },
    async (request, reply) => {
      const position = await getPositionById(request.params.id);

      if (!position) {
        throw new AppError("Position not found", {
          code: "POSITION_NOT_FOUND",
          statusCode: 404,
        });
      }

      return sendSuccess(reply, { position });
    },
  );

  app.get<{ Params: UserPositionsParams }>(
    "/users/:userId/positions",
    {
      schema: {
        params: idParamsSchema("userId"),
      },
    },
    async (request, reply) => {
      const positions = await listUserPositions(request.params.userId);

      return sendSuccess(reply, { positions });
    },
  );

  app.get<{ Params: TraderProfilePositionsParams }>(
    "/trader-profiles/:traderProfileId/positions",
    {
      schema: {
        params: idParamsSchema("traderProfileId"),
      },
    },
    async (request, reply) => {
      const positions = await listTraderProfilePositions(request.params.traderProfileId);

      return sendSuccess(reply, { positions });
    },
  );

  app.post<{ Body: CreateCopyTradeBody }>(
    "/copy-trades",
    {
      schema: {
        body: {
          type: "object",
          required: ["followerId", "sourcePositionId", "requestedQuantity"],
          additionalProperties: false,
          properties: {
            followerId: { type: "string", minLength: 1 },
            sourcePositionId: { type: "string", minLength: 1 },
            sourceSignalId: { type: "string", minLength: 1, nullable: true },
            requestedQuantity: decimalStringSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const copyTrade = await createCopyTrade(request.body);

      return sendSuccess(reply, { copyTrade }, 201);
    },
  );

  app.get<{ Params: UserPositionsParams }>(
    "/users/:userId/copy-trades",
    {
      schema: {
        params: idParamsSchema("userId"),
      },
    },
    async (request, reply) => {
      const copyTrades = await listUserCopyTrades(request.params.userId);

      return sendSuccess(reply, { copyTrades });
    },
  );

  app.get<{ Params: PositionCopyTradesParams }>(
    "/positions/:positionId/copy-trades",
    {
      schema: {
        params: idParamsSchema("positionId"),
      },
    },
    async (request, reply) => {
      const copyTrades = await listPositionCopyTrades(request.params.positionId);

      return sendSuccess(reply, { copyTrades });
    },
  );
}

function idParamsSchema(paramName: string) {
  return {
    type: "object",
    required: [paramName],
    properties: {
      [paramName]: { type: "string", minLength: 1 },
    },
  };
}
