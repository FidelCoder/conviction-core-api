import type { FastifyInstance } from "fastify";

import { sendSuccess } from "../lib/responses.js";
import {
  createMarginRiskQuote,
  getMarginMarketPolicy,
  upsertMarginMarketPolicy,
  type CreateMarginQuoteInput,
  type MarginMarketPolicyInput,
} from "../services/margin-risk-quotes.js";
import { assertAdminAuthorized } from "./admin.js";

type MarketParams = {
  id: string;
};

const decimalAmountSchema = {
  type: "string",
  pattern: "^\\d+(?:\\.\\d{1,6})?$",
} as const;

const marketParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
  },
} as const;

export async function registerMarginRiskRoutes(app: FastifyInstance) {
  app.get<{ Params: MarketParams }>(
    "/admin/markets/:id/margin-policy",
    {
      schema: { params: marketParamsSchema },
    },
    async (request, reply) => {
      assertAdminAuthorized(request.headers.authorization);
      const policy = await getMarginMarketPolicy(request.params.id);
      return sendSuccess(reply, { policy });
    },
  );

  app.put<{ Params: MarketParams; Body: MarginMarketPolicyInput }>(
    "/admin/markets/:id/margin-policy",
    {
      schema: {
        params: marketParamsSchema,
        body: {
          type: "object",
          required: [
            "status",
            "expectedNegativeRisk",
            "maintenanceMarginBps",
            "feeBps",
            "minimumDepthAssets",
            "maxSpreadBps",
            "maxTwapDeviationBps",
            "maxPriceAgeSeconds",
            "closeBufferSeconds",
            "earliestResolutionAt",
            "mandatoryCloseAt",
            "maxMarketBorrowAssets",
            "maxAccountBorrowAssets",
            "maxCategoryBorrowAssets",
            "maxVaultBorrowAssets",
          ],
          additionalProperties: false,
          properties: {
            approvedBy: { type: "string", minLength: 1, maxLength: 120, nullable: true },
            closeBufferSeconds: { type: "integer", minimum: 300 },
            earliestResolutionAt: { type: "string", format: "date-time" },
            expectedNegativeRisk: { type: "boolean" },
            feeBps: { type: "integer", minimum: 0, maximum: 1000 },
            maintenanceMarginBps: { type: "integer", minimum: 1, maximum: 9999 },
            mandatoryCloseAt: { type: "string", format: "date-time" },
            maxAccountBorrowAssets: decimalAmountSchema,
            maxCategoryBorrowAssets: decimalAmountSchema,
            maxLeverageBps: { type: "integer", minimum: 10001, maximum: 30000 },
            maxMarketBorrowAssets: decimalAmountSchema,
            maxPriceAgeSeconds: { type: "integer", minimum: 5, maximum: 300 },
            maxSpreadBps: { type: "integer", minimum: 1, maximum: 2000 },
            maxTwapDeviationBps: { type: "integer", minimum: 1, maximum: 3000 },
            maxVaultBorrowAssets: decimalAmountSchema,
            minimumDepthAssets: decimalAmountSchema,
            notes: { type: "string", maxLength: 1000, nullable: true },
            status: { type: "string", enum: ["DRAFT", "APPROVED", "PAUSED"] },
            threeXApproved: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      assertAdminAuthorized(request.headers.authorization);
      const policy = await upsertMarginMarketPolicy(request.params.id, request.body);
      return sendSuccess(reply, { policy });
    },
  );

  app.post<{ Params: MarketParams; Body: Omit<CreateMarginQuoteInput, "marketId"> }>(
    "/markets/:id/margin-quote",
    {
      schema: {
        params: marketParamsSchema,
        body: {
          type: "object",
          required: ["userId", "side", "collateralAssets", "leverageBps"],
          additionalProperties: false,
          properties: {
            collateralAssets: decimalAmountSchema,
            leverageBps: { type: "integer", minimum: 10001, maximum: 30000 },
            side: { type: "string", enum: ["YES", "NO"] },
            userId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const decision = await createMarginRiskQuote({
        ...request.body,
        marketId: request.params.id,
      });
      return sendSuccess(reply, decision);
    },
  );
}
