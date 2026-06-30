import { OmnistonQuoteStatus, Prisma, SocialPlatform } from "@prisma/client";
import type { FastifyInstance } from "fastify";

import { env } from "../config/index.js";
import { sendSuccess } from "../lib/responses.js";
import {
  getOmnistonQuoteSummary,
  listOmnistonQuoteEvents,
  recordOmnistonQuoteEvent,
} from "../services/omniston-quotes.js";
import { getOmnistonQuoteStatus } from "../services/omniston-quote-service.js";

type CreateOmnistonQuoteEventBody = {
  userId?: string | null;
  platform?: SocialPlatform;
  platformUserId?: string | null;
  username?: string | null;
  source?: string;
  fromAsset: string;
  toAsset: string;
  amountUnits: string;
  status: OmnistonQuoteStatus;
  inputUnits?: string | null;
  outputUnits?: string | null;
  settlement?: string | null;
  resolverName?: string | null;
  quoteId?: string | null;
  gasBudget?: string | null;
  routeCount?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Prisma.InputJsonValue | null;
};

type QuoteEventsQuery = {
  limit?: number;
};

const platformValues = Object.values(SocialPlatform);
const quoteStatusValues = Object.values(OmnistonQuoteStatus);

export async function registerOmnistonQuoteRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateOmnistonQuoteEventBody }>(
    "/omniston/quote-events",
    {
      schema: {
        body: {
          type: "object",
          required: ["fromAsset", "toAsset", "amountUnits", "status"],
          additionalProperties: false,
          properties: {
            userId: { type: "string", minLength: 1, nullable: true },
            platform: { type: "string", enum: platformValues },
            platformUserId: { type: "string", nullable: true },
            username: { type: "string", nullable: true },
            source: { type: "string", minLength: 1, maxLength: 80 },
            fromAsset: { type: "string", minLength: 1, maxLength: 128 },
            toAsset: { type: "string", minLength: 1, maxLength: 128 },
            amountUnits: {
              type: "string",
              minLength: 1,
              maxLength: 80,
              pattern: "^(?:0|[1-9]\\d*)$",
            },
            status: { type: "string", enum: quoteStatusValues },
            inputUnits: { type: "string", nullable: true },
            outputUnits: { type: "string", nullable: true },
            settlement: { type: "string", nullable: true },
            resolverName: { type: "string", nullable: true },
            quoteId: { type: "string", nullable: true },
            gasBudget: { type: "string", nullable: true },
            routeCount: { type: "integer", minimum: 0, nullable: true },
            errorCode: { type: "string", nullable: true },
            errorMessage: { type: "string", nullable: true },
            metadata: { type: "object", additionalProperties: true, nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const event = await recordOmnistonQuoteEvent(request.body);

      return sendSuccess(reply, { event }, 201);
    },
  );

  app.get<{ Querystring: QuoteEventsQuery }>(
    "/omniston/quote-events",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const events = await listOmnistonQuoteEvents(request.query.limit);

      return sendSuccess(reply, { events });
    },
  );

  app.get("/omniston/quote-summary", async (_request, reply) => {
    const summary = await getOmnistonQuoteSummary();

    return sendSuccess(reply, { summary });
  });

  app.get("/omniston/quote-status", async (_request, reply) => {
    return sendSuccess(reply, { omniston: getOmnistonQuoteStatus(env.omniston) });
  });
}
