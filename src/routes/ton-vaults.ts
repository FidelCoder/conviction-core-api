import type { FastifyInstance } from "fastify";

import { isAppError } from "../lib/errors.js";
import { sendError, sendSuccess } from "../lib/responses.js";
import { createTonVaultIntent, getTonVaultSummary, listTonVaultIntents } from "../services/ton-vaults.js";

type CreateTonVaultIntentBody = {
  userId?: string | null;
  telegramUserId?: string | null;
  tonAddress: string;
  asset: string;
  amount: string;
  note?: string | null;
};

type TonVaultIntentQuery = {
  userId?: string;
  tonAddress?: string;
  limit?: number;
};

export async function registerTonVaultRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateTonVaultIntentBody }>(
    "/ton/vault-intents",
    {
      schema: {
        body: {
          type: "object",
          required: ["tonAddress", "asset", "amount"],
          additionalProperties: false,
          properties: {
            userId: { type: "string", minLength: 1, nullable: true },
            telegramUserId: { type: "string", minLength: 1, nullable: true },
            tonAddress: { type: "string", minLength: 32, maxLength: 128 },
            asset: { type: "string", minLength: 2, maxLength: 16 },
            amount: { type: "string", minLength: 1, maxLength: 64 },
            note: { type: "string", maxLength: 280, nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const intent = await createTonVaultIntent(request.body);
        return sendSuccess(reply, { intent }, 201);
      } catch (error) {
        if (isAppError(error)) {
          return sendError(reply, { code: error.code, message: error.message, details: error.details }, error.statusCode);
        }
        throw error;
      }
    },
  );

  app.get<{ Querystring: TonVaultIntentQuery }>(
    "/ton/vault-intents",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            userId: { type: "string", minLength: 1 },
            tonAddress: { type: "string", minLength: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const intents = await listTonVaultIntents(request.query);
      return sendSuccess(reply, { intents });
    },
  );

  app.get("/ton/vault-summary", async (_request, reply) => {
    const summary = await getTonVaultSummary();
    return sendSuccess(reply, { summary });
  });
}
