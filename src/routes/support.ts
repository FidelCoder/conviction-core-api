import type { FastifyInstance } from "fastify";

import { sendError, sendSuccess } from "../lib/responses.js";
import { createSupportTicket, listSupportTickets } from "../services/support.js";

type SupportBody = {
  userId?: string | null;
  wallet?: string | null;
  email: string;
  subject: string;
  summary: string;
  transcript?: string | null;
};

type SupportQuery = { limit?: number };

export async function registerSupportRoutes(app: FastifyInstance) {
  app.post<{ Body: SupportBody }>("/support/tickets", async (request, reply) => {
    const email = normalizeField(request.body.email);
    const subject = normalizeField(request.body.subject);
    const summary = normalizeField(request.body.summary);

    if (!email || !subject || !summary) {
      return sendError(
        reply,
        { code: "INVALID_SUPPORT_TICKET", message: "Email, subject, and summary are required." },
        422,
      );
    }

    const ticket = await createSupportTicket({
      ...request.body,
      email,
      subject,
      summary,
      transcript: normalizeNullableField(request.body.transcript),
      wallet: normalizeNullableField(request.body.wallet),
      userId: normalizeNullableField(request.body.userId),
    });
    return sendSuccess(reply, { ticket }, 201);
  });

  app.get<{ Querystring: SupportQuery }>("/support/tickets", async (request, reply) => {
    const tickets = await listSupportTickets(request.query.limit);
    return sendSuccess(reply, { tickets });
  });
}

function normalizeField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableField(value: unknown) {
  const normalized = normalizeField(value);
  return normalized || null;
}
