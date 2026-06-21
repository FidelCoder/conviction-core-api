import type { FastifyInstance } from "fastify";

import { sendError, sendSuccess } from "../lib/responses.js";
import { createSupportReply, createSupportTicket, getSupportTicket, listSupportTickets } from "../services/support.js";

type SupportBody = {
  userId?: string | null;
  wallet?: string | null;
  email: string;
  subject: string;
  summary: string;
  transcript?: string | null;
};

type SupportReplyBody = {
  userId?: string | null;
  subject?: string | null;
  body: string;
};

type SupportParams = { ticketId: string };
type SupportQuery = { limit?: number; userId?: string; email?: string };

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
    const tickets = await listSupportTickets({
      limit: request.query.limit,
      userId: normalizeNullableField(request.query.userId),
      email: normalizeNullableField(request.query.email),
    });
    return sendSuccess(reply, { tickets });
  });

  app.get<{ Params: SupportParams }>("/support/tickets/:ticketId", async (request, reply) => {
    const ticket = await getSupportTicket(request.params.ticketId);

    if (!ticket) {
      return sendError(reply, { code: "SUPPORT_TICKET_NOT_FOUND", message: "Support ticket was not found." }, 404);
    }

    return sendSuccess(reply, { ticket });
  });

  app.post<{ Params: SupportParams; Body: SupportReplyBody }>("/support/tickets/:ticketId/replies", async (request, reply) => {
    const body = normalizeField(request.body.body);

    if (!body) {
      return sendError(reply, { code: "INVALID_SUPPORT_REPLY", message: "Reply body is required." }, 422);
    }

    try {
      const result = await createSupportReply({
        ticketId: request.params.ticketId,
        authorType: "USER",
        authorUserId: normalizeNullableField(request.body.userId),
        subject: normalizeNullableField(request.body.subject),
        body,
        source: "APP",
      });

      return sendSuccess(reply, result, 201);
    } catch {
      return sendError(reply, { code: "SUPPORT_TICKET_NOT_FOUND", message: "Support ticket was not found." }, 404);
    }
  });
}

function normalizeField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableField(value: unknown) {
  const normalized = normalizeField(value);
  return normalized || null;
}
