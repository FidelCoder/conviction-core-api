import { OmnistonQuoteStatus, Prisma, SocialPlatform } from "@prisma/client";
import type { FastifyInstance } from "fastify";

import { env } from "../config/index.js";
import { sendError, sendSuccess } from "../lib/responses.js";
import {
  getOmnistonQuoteSummary,
  listOmnistonQuoteEvents,
  recordOmnistonQuoteEvent,
} from "../services/omniston-quotes.js";
import {
  getOmnistonQuoteStatus,
  OmnistonNoQuoteError,
  OmnistonQuoteDisabledError,
  OmnistonQuoteInputError,
  OmnistonQuoteService,
  OmnistonQuoteTimeoutError,
} from "../services/omniston-quote-service.js";

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

type RequestOmnistonQuoteBody = {
  fromAsset: string;
  toAsset: string;
  amountUnits: string;
  platformUserId?: string | null;
  username?: string | null;
};

const quoteAssetDecimals: Record<string, number> = {
  TON: 9,
  USDT: 6,
  STON: 9,
};

const platformValues = Object.values(SocialPlatform);
const quoteStatusValues = Object.values(OmnistonQuoteStatus);

export async function registerOmnistonQuoteRoutes(app: FastifyInstance) {
  app.post<{ Body: RequestOmnistonQuoteBody }>(
    "/omniston/quote",
    {
      schema: {
        body: {
          type: "object",
          required: ["fromAsset", "toAsset", "amountUnits"],
          additionalProperties: false,
          properties: {
            fromAsset: { type: "string", minLength: 1, maxLength: 128 },
            toAsset: { type: "string", minLength: 1, maxLength: 128 },
            amountUnits: {
              type: "string",
              minLength: 1,
              maxLength: 80,
              pattern: "^(?:0|[1-9]\\d*)$",
            },
            platformUserId: { type: "string", nullable: true },
            username: { type: "string", nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const input = request.body;
      const quoteService = new OmnistonQuoteService(env.omniston);

      try {
        const result = await quoteService.requestQuote(input);
        const routeCount =
          result.quote.settlementData.$case === "swap"
            ? result.quote.settlementData.value.routes.length
            : null;
        const recommendedMinOutputAmount =
          result.quote.settlementData.$case === "swap"
            ? result.quote.settlementData.value.recommendedMinOutputAmount
            : null;

        const event = await recordOmnistonQuoteEvent({
          platform: SocialPlatform.TELEGRAM,
          platformUserId: input.platformUserId ?? null,
          username: input.username ?? null,
          source: "MINI_APP",
          fromAsset: input.fromAsset,
          toAsset: input.toAsset,
          amountUnits: input.amountUnits,
          status: OmnistonQuoteStatus.QUOTED,
          inputUnits: result.quote.inputUnits,
          outputUnits: result.quote.outputUnits,
          settlement: result.settlement,
          resolverName: result.quote.resolverName,
          quoteId: result.quote.quoteId,
          gasBudget: result.quote.gasBudget ?? null,
          routeCount,
          metadata: { recommendedMinOutputAmount },
        });

        return sendSuccess(reply, {
          quote: {
            fromAsset: input.fromAsset,
            toAsset: input.toAsset,
            inputSymbol: result.inputSymbol,
            outputSymbol: result.outputSymbol,
            inputUnits: result.quote.inputUnits,
            outputUnits: result.quote.outputUnits,
            inputAmount: formatQuoteAmount(result.quote.inputUnits, result.inputSymbol),
            outputAmount: formatQuoteAmount(result.quote.outputUnits, result.outputSymbol),
            settlement: result.settlement,
            resolverName: result.quote.resolverName,
            quoteId: result.quote.quoteId,
            gasBudget: result.quote.gasBudget ?? null,
            routeCount,
            recommendedMinOutputAmount,
          },
          event,
        });
      } catch (error) {
        await recordOmnistonQuoteEvent({
          platform: SocialPlatform.TELEGRAM,
          platformUserId: input.platformUserId ?? null,
          username: input.username ?? null,
          source: "MINI_APP",
          fromAsset: input.fromAsset,
          toAsset: input.toAsset,
          amountUnits: input.amountUnits,
          ...quoteErrorFields(error),
        });

        const errorResponse = quoteErrorResponse(error);
        return sendError(reply, errorResponse.error, errorResponse.statusCode);
      }
    },
  );
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
function quoteErrorFields(error: unknown): {
  status: OmnistonQuoteStatus;
  errorCode: string;
  errorMessage: string;
} {
  if (error instanceof OmnistonQuoteDisabledError) {
    return {
      status: OmnistonQuoteStatus.DISABLED,
      errorCode: "OMNISTON_DISABLED",
      errorMessage: error.message,
    };
  }

  if (error instanceof OmnistonNoQuoteError) {
    return {
      status: OmnistonQuoteStatus.NO_QUOTE,
      errorCode: "OMNISTON_NO_QUOTE",
      errorMessage: error.message,
    };
  }

  if (error instanceof OmnistonQuoteTimeoutError) {
    return {
      status: OmnistonQuoteStatus.TIMEOUT,
      errorCode: "OMNISTON_TIMEOUT",
      errorMessage: error.message,
    };
  }

  if (error instanceof OmnistonQuoteInputError) {
    return {
      status: OmnistonQuoteStatus.FAILED,
      errorCode: "OMNISTON_INPUT_ERROR",
      errorMessage: error.message,
    };
  }

  return {
    status: OmnistonQuoteStatus.FAILED,
    errorCode: error instanceof Error ? error.name : "OMNISTON_UNKNOWN_ERROR",
    errorMessage: error instanceof Error ? error.message : "Unknown quote error.",
  };
}

function quoteErrorResponse(error: unknown) {
  const fields = quoteErrorFields(error);

  if (error instanceof OmnistonQuoteDisabledError) {
    return {
      statusCode: 503,
      error: { code: fields.errorCode, message: "Omniston quotes are disabled on this deployment." },
    };
  }

  if (error instanceof OmnistonQuoteInputError) {
    return { statusCode: 422, error: { code: fields.errorCode, message: fields.errorMessage } };
  }

  if (error instanceof OmnistonNoQuoteError || error instanceof OmnistonQuoteTimeoutError) {
    return {
      statusCode: 504,
      error: {
        code: fields.errorCode,
        message: "No Omniston quote is available for that pair and amount right now.",
      },
    };
  }

  return {
    statusCode: 502,
    error: { code: fields.errorCode, message: "Omniston quote request failed." },
  };
}

function formatQuoteAmount(units: string, symbol: string) {
  const decimals = quoteAssetDecimals[symbol.toUpperCase()];

  if (decimals === undefined) {
    return units + " " + symbol;
  }

  const padded = units.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return whole + (fraction ? "." + fraction : "") + " " + symbol;
}

