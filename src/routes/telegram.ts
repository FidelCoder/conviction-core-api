import type { FastifyInstance } from "fastify";

import { env } from "../config/index.js";
import { sendError, sendSuccess } from "../lib/responses.js";
import { handleTelegramUpdate, sendMarketDigestToRole } from "../services/telegram.js";

type WebhookParams = { secret: string };
type DigestBody = { token?: string };
type DigestQuery = { token?: string };

export async function registerTelegramRoutes(app: FastifyInstance) {
  app.post<{ Params: WebhookParams; Body: unknown }>("/telegram/webhook/:secret", async (request, reply) => {
    if (!env.telegramWebhookSecret || request.params.secret !== env.telegramWebhookSecret) {
      return sendError(reply, { code: "INVALID_TELEGRAM_WEBHOOK", message: "Invalid Telegram webhook secret." }, 401);
    }

    const result = await handleTelegramUpdate(request.body as never);
    return sendSuccess(reply, result);
  });

  app.post<{ Body: DigestBody }>("/telegram/market-digest", async (request, reply) => {
    if (!isAuthorizedDigest(request.headers.authorization, request.body?.token)) {
      return sendError(reply, { code: "UNAUTHORIZED_MARKET_DIGEST", message: "Invalid digest token." }, 401);
    }

    const result = await sendMarketDigestToRole();
    return sendSuccess(reply, result);
  });

  app.get<{ Querystring: DigestQuery }>("/telegram/market-digest", async (request, reply) => {
    if (!isAuthorizedDigest(request.headers.authorization, request.query.token)) {
      return sendError(reply, { code: "UNAUTHORIZED_MARKET_DIGEST", message: "Invalid digest token." }, 401);
    }

    const result = await sendMarketDigestToRole();
    return sendSuccess(reply, result);
  });
}

function isAuthorizedDigest(authorization: string | undefined, token: string | undefined) {
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";

  if (env.cronSecret && bearer === env.cronSecret) return true;
  if (env.marketSyncToken && (token === env.marketSyncToken || bearer === env.marketSyncToken)) return true;

  return env.environment !== "production" && !env.cronSecret && !env.marketSyncToken;
}
