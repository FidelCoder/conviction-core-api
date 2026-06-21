import { prisma } from "../lib/prisma.js";
import { sendSupportTicketAlert } from "./telegram.js";

export type CreateSupportTicketInput = {
  userId?: string | null;
  wallet?: string | null;
  email: string;
  subject: string;
  summary: string;
  transcript?: string | null;
};

export type CreateSupportReplyInput = {
  ticketId: string;
  authorType: "USER" | "SUPPORT" | "AI";
  authorUserId?: string | null;
  authorName?: string | null;
  subject?: string | null;
  body: string;
  source?: string | null;
  resolve?: boolean;
};

const autoCloseDays = 3;

export async function createSupportTicket(input: CreateSupportTicketInput) {
  const now = new Date();
  const ticket = await prisma.supportTicket.create({
    data: {
      userId: input.userId ?? null,
      wallet: input.wallet ?? null,
      email: input.email,
      subject: input.subject,
      summary: input.summary,
      transcript: input.transcript ?? null,
      status: "OPEN",
      autoCloseAt: addDays(now, autoCloseDays),
    },
    include: supportTicketInclude,
  });

  const telegramSent = await sendTelegramSupportAlert(ticket);

  const finalTicket = telegramSent
    ? await prisma.supportTicket.update({
        where: { id: ticket.id },
        data: { telegramSentAt: new Date() },
        include: supportTicketInclude,
      })
    : ticket;

  return normalizeSupportTicket(finalTicket);
}

export async function listSupportTickets(input: { limit?: number; userId?: string | null; email?: string | null } = {}) {
  await closeExpiredTickets();

  const tickets = await prisma.supportTicket.findMany({
    where: {
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.email ? { email: input.email } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(input.limit ?? 50, 100)),
    include: supportTicketInclude,
  });

  return tickets.map(normalizeSupportTicket);
}

export async function getSupportTicket(ticketId: string) {
  await closeExpiredTickets();

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: supportTicketInclude,
  });

  return ticket ? normalizeSupportTicket(ticket) : null;
}

export async function createSupportReply(input: CreateSupportReplyInput) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: input.ticketId } });

  if (!ticket) {
    throw new Error("Support ticket not found.");
  }

  const now = new Date();
  const reply = await prisma.supportTicketReply.create({
    data: {
      ticketId: input.ticketId,
      authorType: input.authorType,
      authorUserId: input.authorUserId ?? null,
      authorName: input.authorName ?? null,
      subject: input.subject ?? null,
      body: input.body,
      source: input.source ?? "APP",
    },
  });

  const nextStatus = input.resolve ? "RESOLVED" : input.authorType === "SUPPORT" ? "AWAITING_USER" : "OPEN";
  const updated = await prisma.supportTicket.update({
    where: { id: input.ticketId },
    data: {
      status: nextStatus,
      resolvedAt: input.resolve ? now : ticket.resolvedAt,
      closedAt: null,
      autoCloseAt: addDays(now, autoCloseDays),
    },
    include: supportTicketInclude,
  });

  if (input.authorType === "SUPPORT" && updated.userId) {
    await prisma.userNotification.create({
      data: {
        userId: updated.userId,
        type: input.resolve ? "SUPPORT_RESOLVED" : "SUPPORT_REPLY",
        entityType: "SUPPORT_TICKET",
        entityId: updated.id,
        message: input.resolve
          ? "Support resolved ticket " + shortTicketId(updated.id) + ": " + (input.subject || updated.subject)
          : "Support replied to ticket " + shortTicketId(updated.id) + ": " + (input.subject || updated.subject),
      },
    });
  }

  return { ticket: normalizeSupportTicket(updated), reply: normalizeSupportReply(reply) };
}

export async function resolveSupportTicket(ticketId: string, input: { subject?: string | null; body?: string | null; authorName?: string | null } = {}) {
  return createSupportReply({
    ticketId,
    authorType: "SUPPORT",
    authorName: input.authorName ?? "Conviction Support",
    subject: input.subject ?? "Ticket resolved",
    body: input.body ?? "This support ticket has been marked resolved. Reply from the Support page if you still need help.",
    source: "TELEGRAM",
    resolve: true,
  });
}

async function closeExpiredTickets() {
  const now = new Date();

  await prisma.supportTicket.updateMany({
    where: {
      status: { in: ["OPEN", "AWAITING_USER", "RESOLVED"] },
      autoCloseAt: { lte: now },
    },
    data: {
      status: "CLOSED",
      closedAt: now,
    },
  });
}

async function sendTelegramSupportAlert(ticket: { id: string; email: string; subject: string; summary: string; wallet: string | null; userId: string | null }) {
  return sendSupportTicketAlert(ticket);
}

const supportTicketInclude = {
  replies: { orderBy: { createdAt: "asc" as const } },
};

type SupportTicketWithReplies = Awaited<ReturnType<typeof prisma.supportTicket.findFirst<{ include: typeof supportTicketInclude }>>>;
type SupportTicketReplyRecord = NonNullable<SupportTicketWithReplies>["replies"][number];

function normalizeSupportTicket(ticket: NonNullable<SupportTicketWithReplies>) {
  return {
    id: ticket.id,
    userId: ticket.userId,
    wallet: ticket.wallet,
    email: ticket.email,
    subject: ticket.subject,
    summary: ticket.summary,
    transcript: ticket.transcript,
    status: ticket.status,
    telegramSentAt: ticket.telegramSentAt?.toISOString() ?? null,
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    closedAt: ticket.closedAt?.toISOString() ?? null,
    autoCloseAt: ticket.autoCloseAt?.toISOString() ?? null,
    replies: ticket.replies.map(normalizeSupportReply),
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

function normalizeSupportReply(reply: SupportTicketReplyRecord) {
  return {
    id: reply.id,
    ticketId: reply.ticketId,
    authorType: reply.authorType,
    authorUserId: reply.authorUserId,
    authorName: reply.authorName,
    subject: reply.subject,
    body: reply.body,
    source: reply.source,
    createdAt: reply.createdAt.toISOString(),
    updatedAt: reply.updatedAt.toISOString(),
  };
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function shortTicketId(id: string) {
  return id.slice(-6);
}
