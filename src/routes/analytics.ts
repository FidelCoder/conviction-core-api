import { AuthProvider, UsageEventType } from "@prisma/client";
import type { FastifyInstance } from "fastify";

import { sendError, sendSuccess } from "../lib/responses.js";
import { recordUsageEvent } from "../services/analytics.js";

type UsageEventBody = {
  area?: string | null;
  authProvider?: AuthProvider | null;
  clientSessionId: string;
  label?: string | null;
  metadata?: unknown;
  path?: string | null;
  referrer?: string | null;
  socialAccountId?: string | null;
  source?: string | null;
  type: UsageEventType;
  userId?: string | null;
  value?: number | null;
};

const authProviderValues = Object.values(AuthProvider);
const usageEventTypeValues = Object.values(UsageEventType);

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  app.post<{ Body: UsageEventBody }>(
    "/analytics/events",
    {
      schema: {
        body: {
          type: "object",
          required: ["clientSessionId", "type"],
          additionalProperties: false,
          properties: {
            area: { type: "string", maxLength: 80, nullable: true },
            authProvider: { type: "string", enum: authProviderValues, nullable: true },
            clientSessionId: { type: "string", minLength: 8, maxLength: 120 },
            label: { type: "string", maxLength: 160, nullable: true },
            metadata: { type: "object", additionalProperties: true, nullable: true },
            path: { type: "string", maxLength: 256, nullable: true },
            referrer: { type: "string", maxLength: 512, nullable: true },
            socialAccountId: { type: "string", minLength: 1, nullable: true },
            source: { type: "string", maxLength: 80, nullable: true },
            type: { type: "string", enum: usageEventTypeValues },
            userId: { type: "string", minLength: 1, nullable: true },
            value: { type: "number", nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedClientSessionId(request.body.clientSessionId)) {
        return sendError(reply, { code: "INVALID_ANALYTICS_SESSION", message: "Client session id is invalid." }, 422);
      }

      const result = await recordUsageEvent({
        ...request.body,
        userAgent: request.headers["user-agent"] ?? null,
      });

      return sendSuccess(reply, result, 201);
    },
  );
}

function isAllowedClientSessionId(value: string) {
  return /^[a-zA-Z0-9:_-]{8,120}$/.test(value);
}
