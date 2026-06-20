import { env } from "../config/index.js";
import { prisma } from "../lib/prisma.js";

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
  if (!env.telegramBotToken || !env.telegramSupportChatId) return false;

  const text = [
    "New Conviction support ticket",
    "Ticket: " + ticket.id,
    "Email: " + ticket.email,
    ticket.wallet ? "Wallet: " + ticket.wallet : null,
    ticket.userId ? "User: " + ticket.userId : null,
    "Subject: " + ticket.subject,
    "Summary: " + ticket.summary,
  ].filter(Boolean).join("\n");

  try {
    const response = await fetch("https://api.telegram.org/bot" + env.telegramBotToken + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.telegramSupportChatId, text }),
    });

    return response.ok;
  } catch {
    return false;
  }
}
