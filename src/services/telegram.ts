import { TelegramChatRole } from "@prisma/client";

import { env } from "../config/index.js";
import { prisma } from "../lib/prisma.js";
import { listMarkets } from "./markets.js";
import { createSupportAnswer } from "./support-ai.js";

type TelegramChat = {
  id: number;
  title?: string;
  type?: string;
};

type TelegramUser = {
  first_name?: string;
  username?: string;
};

type TelegramMessage = {
  chat?: TelegramChat;
  from?: TelegramUser;
  text?: string;
};

type TelegramUpdate = {
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

type SupportTicketAlert = {
  id: string;
  email: string;
  subject: string;
  summary: string;
  wallet: string | null;
  userId: string | null;
};

const roleAliases: Record<string, TelegramChatRole> = {
  support: TelegramChatRole.SUPPORT,
  alerts: TelegramChatRole.MARKET_ALERTS,
  market_alerts: TelegramChatRole.MARKET_ALERTS,
  markets: TelegramChatRole.MARKET_ALERTS,
  general: TelegramChatRole.GENERAL,
};

export async function handleTelegramUpdate(update: TelegramUpdate) {
  const message = update.message ?? update.channel_post;
  if (!message?.chat) return { handled: false };

  const chat = message.chat;
  const text = message.text?.trim() ?? "";
  await rememberTelegramChat(chat);

  if (!text.startsWith("/")) {
    const stored = await prisma.telegramChat.findUnique({ where: { chatId: String(chat.id) } });

    if (shouldAnswerCommunityMessage(stored?.role ?? TelegramChatRole.GENERAL, text)) {
      await sendTelegramMessage(String(chat.id), await buildTelegramAiAnswer(text, message));
      return { handled: true, command: "ai_reply" };
    }

    return { handled: true, command: "message" };
  }

  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();

  if (command === "/start") {
    await sendTelegramMessage(String(chat.id), startMessage(chat.id));
    return { handled: true, command };
  }

  if (command === "/help") {
    await sendTelegramMessage(String(chat.id), helpMessage());
    return { handled: true, command };
  }

  if (command === "/ask") {
    const question = args.join(" ").trim();

    if (!question) {
      await sendTelegramMessage(String(chat.id), "Ask like this: /ask What is vault liquidity risk?");
      return { handled: true, command };
    }

    await sendTelegramMessage(String(chat.id), await buildTelegramAiAnswer(question, message));
    return { handled: true, command };
  }

  if (command === "/chatid") {
    await sendTelegramMessage(String(chat.id), "Chat id: " + chat.id + "\nUse this as TELEGRAM_SUPPORT_CHAT_ID if this group should receive support alerts.");
    return { handled: true, command };
  }

  if (command === "/role") {
    const requested = args[0]?.toLowerCase();
    const role = requested ? roleAliases[requested] : null;

    if (!role) {
      await sendTelegramMessage(String(chat.id), "Usage: /role support | /role alerts | /role general");
      return { handled: true, command };
    }

    await setTelegramChatRole(String(chat.id), role, chat);
    await sendTelegramMessage(String(chat.id), "This chat is now registered as " + roleLabel(role) + ".");
    return { handled: true, command };
  }

  if (command === "/markets") {
    await sendTelegramMessage(String(chat.id), await buildMarketDigest());
    return { handled: true, command };
  }

  if (command === "/status") {
    const stored = await prisma.telegramChat.findUnique({ where: { chatId: String(chat.id) } });
    await sendTelegramMessage(String(chat.id), [
      "Conviction bot status",
      "Chat id: " + chat.id,
      "Role: " + roleLabel(stored?.role ?? TelegramChatRole.GENERAL),
      "Support alerts: " + (env.telegramSupportChatId ? "configured" : "missing TELEGRAM_SUPPORT_CHAT_ID"),
    ].join("\n"));
    return { handled: true, command };
  }

  await sendTelegramMessage(String(chat.id), "Unknown command. Send /help for Conviction bot commands.");
  return { handled: true, command };
}

export async function sendSupportTicketAlert(ticket: SupportTicketAlert) {
  const chats = await supportAlertChats();
  if (chats.length === 0) return false;

  const text = [
    "New Conviction support ticket",
    "Ticket: " + ticket.id,
    "Email: " + ticket.email,
    ticket.wallet ? "Wallet: " + ticket.wallet : null,
    ticket.userId ? "User: " + ticket.userId : null,
    "Subject: " + ticket.subject,
    "Summary: " + ticket.summary,
  ].filter(Boolean).join("\n");

  const results = await Promise.all(chats.map((chatId) => sendTelegramMessage(chatId, text)));
  return results.some(Boolean);
}

export async function sendMarketDigestToRole(role = TelegramChatRole.MARKET_ALERTS) {
  const chats = await prisma.telegramChat.findMany({ where: { role, isActive: true } });
  if (chats.length === 0) return { sent: 0 };

  const digest = await buildMarketDigest();
  const results = await Promise.all(chats.map((chat) => sendTelegramMessage(chat.chatId, digest)));
  return { sent: results.filter(Boolean).length };
}

async function supportAlertChats() {
  const ids = new Set<string>();
  if (env.telegramSupportChatId) ids.add(env.telegramSupportChatId);

  const roleChats = await prisma.telegramChat.findMany({
    where: { role: TelegramChatRole.SUPPORT, isActive: true },
    select: { chatId: true },
  });

  for (const chat of roleChats) ids.add(chat.chatId);
  return [...ids];
}

async function rememberTelegramChat(chat: TelegramChat) {
  return prisma.telegramChat.upsert({
    where: { chatId: String(chat.id) },
    update: {
      title: chat.title ?? null,
      type: chat.type ?? null,
      isActive: true,
      lastSeenAt: new Date(),
    },
    create: {
      chatId: String(chat.id),
      title: chat.title ?? null,
      type: chat.type ?? null,
      role: env.telegramSupportChatId === String(chat.id) ? TelegramChatRole.SUPPORT : TelegramChatRole.GENERAL,
      isActive: true,
      lastSeenAt: new Date(),
    },
  });
}

async function setTelegramChatRole(chatId: string, role: TelegramChatRole, chat: TelegramChat) {
  return prisma.telegramChat.upsert({
    where: { chatId },
    update: {
      role,
      title: chat.title ?? null,
      type: chat.type ?? null,
      isActive: true,
      lastSeenAt: new Date(),
    },
    create: {
      chatId,
      role,
      title: chat.title ?? null,
      type: chat.type ?? null,
      isActive: true,
      lastSeenAt: new Date(),
    },
  });
}

async function buildTelegramAiAnswer(question: string, message: TelegramMessage) {
  const author = message.from?.username ? "@" + message.from.username : message.from?.first_name ?? "Telegram user";

  return createSupportAnswer({
    question,
    pageContext: "Telegram group question from " + author,
    maxLength: 1500,
  });
}

function shouldAnswerCommunityMessage(role: TelegramChatRole, text: string) {
  if (role === TelegramChatRole.SUPPORT) return false;

  const normalized = text.toLowerCase();
  if (normalized.includes("@convictionmarkets_bot")) return true;
  if (normalized.startsWith("conviction") || normalized.startsWith("bot")) return true;
  if (normalized.includes("conviction markets") && normalized.includes("?")) return true;
  if (normalized.includes("prediction market") && normalized.includes("?")) return true;
  if (normalized.includes("vault") && normalized.includes("?")) return true;
  if (normalized.includes("margin") && normalized.includes("?")) return true;
  if (normalized.includes("leverage") && normalized.includes("?")) return true;
  if (normalized.includes("risk") && normalized.includes("?")) return true;

  return false;
}

async function buildMarketDigest() {
  const markets = await listMarkets({ limit: 5, status: "ACTIVE" });

  if (markets.length === 0) {
    return "No active Conviction markets are available right now.";
  }

  return [
    "Conviction market pulse",
    ...markets.map((market, index) => {
      const yes = formatPercent(market.lastTradePrice ?? market.bestAsk ?? market.bestBid);
      const tag = market.providerMetadata.primaryTag ?? market.category ?? "Market";
      return [
        String(index + 1) + ". " + market.title,
        "YES " + yes + " | " + tag,
      ].join("\n");
    }),
    "Open: https://convictionmarkets.xyz/markets",
  ].join("\n\n");
}

async function sendTelegramMessage(chatId: string, text: string) {
  if (!env.telegramBotToken) return false;

  try {
    const response = await fetch("https://api.telegram.org/bot" + env.telegramBotToken + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        disable_web_page_preview: true,
        text: truncateTelegramText(text),
      }),
    });

    return response.ok;
  } catch {
    return false;
  }
}

function startMessage(chatId: number) {
  return [
    "Conviction Markets bot is active.",
    "Chat id: " + chatId,
    "Use /role support if this group should receive support tickets.",
    "Use /role alerts if this group should receive market digests.",
    "Use /markets for a live market pulse.",
  ].join("\n");
}

function helpMessage() {
  return [
    "Conviction bot commands",
    "/chatid - show this Telegram chat id",
    "/role support - route support tickets here",
    "/role alerts - route market alerts here",
    "/role general - keep this as a general group",
    "/markets - show a live market digest",
    "/ask <question> - ask Conviction AI in Telegram",
    "/status - show bot setup status",
  ].join("\n");
}

function roleLabel(role: TelegramChatRole) {
  if (role === TelegramChatRole.SUPPORT) return "support";
  if (role === TelegramChatRole.MARKET_ALERTS) return "market alerts";
  return "general";
}

function formatPercent(value: string | null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return percent.toFixed(percent >= 10 ? 1 : 2) + "%";
}

function truncateTelegramText(value: string) {
  return value.length <= 3900 ? value : value.slice(0, 3897) + "...";
}
