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

export async function createSupportTicket(input: CreateSupportTicketInput) {
  const ticket = await prisma.supportTicket.create({
    data: {
      userId: input.userId ?? null,
      wallet: input.wallet ?? null,
      email: input.email,
      subject: input.subject,
      summary: input.summary,
      transcript: input.transcript ?? null,
    },
  });

  const telegramSent = await sendTelegramSupportAlert(ticket);

  if (telegramSent) {
    return prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { telegramSentAt: new Date() },
    });
  }

  return ticket;
}

export async function listSupportTickets(limit = 50) {
  return prisma.supportTicket.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 100)),
  });
}

async function sendTelegramSupportAlert(ticket: { id: string; email: string; subject: string; summary: string; wallet: string | null; userId: string | null }) {
  return sendSupportTicketAlert(ticket);
}
