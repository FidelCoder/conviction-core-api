import type { FastifyInstance } from "fastify";

import { env } from "../config/index.js";
import { sendError, sendSuccess } from "../lib/responses.js";
import { handleTelegramUpdate, sendMarketDigestToRole } from "../services/telegram.js";

type WebhookParams = { secret: string };
type DigestBody = { token?: string };

export async function registerTelegramRoutes(app: FastifyInstance) {
  app.post<{ Params: WebhookParams; Body: unknown }>("/telegram/webhook/:secret", async (request, reply) => {
    if (!env.telegramWebhookSecret || request.params.secret !== env.telegramWebhookSecret) {
      return sendError(reply, { code: "INVALID_TELEGRAM_WEBHOOK", message: "Invalid Telegram webhook secret." }, 401);
    }

    const result = await handleTelegramUpdate(request.body as never);
    return sendSuccess(reply, result);
  });

  app.post<{ Body: DigestBody }>("/telegram/market-digest", async (request, reply) => {
    if (env.marketSyncToken && request.body?.token !== env.marketSyncToken) {
      return sendError(reply, { code: "UNAUTHORIZED_MARKET_DIGEST", message: "Invalid digest token." }, 401);
    }

    const result = await sendMarketDigestToRole();
    return sendSuccess(reply, result);
  });
}
