import { OmnistonQuoteStatus, TelegramChatRole } from "@prisma/client";

import { env } from "../config/index.js";
import { prisma } from "../lib/prisma.js";
import { getExecutionReadiness } from "./execution.js";
import { listMarkets } from "./markets.js";
import { recordOmnistonQuoteEvent } from "./omniston-quotes.js";
import {
  OmnistonNoQuoteError,
  OmnistonQuoteDisabledError,
  OmnistonQuoteInputError,
  type OmnistonQuoteResult,
  OmnistonQuoteService,
  OmnistonQuoteTimeoutError,
} from "./omniston-quote-service.js";
import {
  checkSupportAiProvider,
  createSupportAnswer,
  getSupportAiRuntimeStatus,
} from "./support-ai.js";
import { createSupportReply, resolveSupportTicket } from "./support.js";

type TelegramChat = {
  id: number;
  title?: string;
  type?: string;
};

type TelegramUser = {
  id?: number;
  first_name?: string;
  username?: string;
  is_bot?: boolean;
};

type TelegramMessage = {
  chat?: TelegramChat;
  from?: TelegramUser;
  text?: string;
  new_chat_members?: TelegramUser[];
};

type TelegramChatMemberResponse = {
  ok?: boolean;
  result?: {
    status?: string;
  };
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

const supportEmail = "convictionsmarket@gmail.com";
const miniAppUrl = "https://convictionmarkets.xyz/telegram";

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
  const storedChat = await rememberTelegramChat(chat);

  if (message.new_chat_members?.length) {
    const welcomed = await welcomeNewTelegramMembers(
      chat,
      message.new_chat_members,
      storedChat.role,
    );
    if (welcomed) return { handled: true, command: "welcome" };
  }

  if (!text.startsWith("/")) {
    const stored = await prisma.telegramChat.findUnique({ where: { chatId: String(chat.id) } });

    if (shouldAnswerCommunityMessage(stored?.role ?? TelegramChatRole.GENERAL, text)) {
      await sendTelegramMessage(String(chat.id), await buildTelegramAiAnswer(text, message));
      return { handled: true, command: "ai_reply" };
    }

    return { handled: true, command: "message" };
  }

  const normalizedText = normalizeTelegramCommandText(text);
  const [rawCommand, ...rawArgs] = normalizedText.split(/\s+/);
  const commandToken = rawCommand.split("@")[0].toLowerCase();
  const aiColonQuestion = commandToken.startsWith("/ai:")
    ? commandToken.slice("/ai:".length).trim()
    : "";
  const askColonQuestion = commandToken.startsWith("/ask:")
    ? commandToken.slice("/ask:".length).trim()
    : "";
  const command = commandToken.startsWith("/ai:")
    ? "/ai"
    : commandToken.startsWith("/ask:")
      ? "/ask"
      : commandToken;
  const args =
    aiColonQuestion || askColonQuestion
      ? [aiColonQuestion || askColonQuestion, ...rawArgs]
      : rawArgs;

  if (command === "/start") {
    await sendTelegramMessage(String(chat.id), startMessage(chat.id), miniAppKeyboard());
    return { handled: true, command };
  }

  if (command === "/help") {
    const stored = await prisma.telegramChat.findUnique({ where: { chatId: String(chat.id) } });
    await sendTelegramMessage(
      String(chat.id),
      helpMessage(stored?.role ?? TelegramChatRole.GENERAL),
      miniAppKeyboard(),
    );
    return { handled: true, command };
  }

  if (command === "/ai" || command === "/ask") {
    const question = normalizeAiQuestion(args.join(" "));

    if (!question) {
      await sendTelegramMessage(
        String(chat.id),
        "Ask like this: /ask What is vault liquidity risk?",
      );
      return { handled: true, command };
    }

    await sendTelegramMessage(String(chat.id), await buildTelegramAiAnswer(question, message));
    return { handled: true, command };
  }

  if (command === "/chatid") {
    const stored = await prisma.telegramChat.findUnique({ where: { chatId: String(chat.id) } });
    const role = stored?.role ?? TelegramChatRole.GENERAL;

    if (role !== TelegramChatRole.SUPPORT && !(await isTelegramAdmin(chat.id, message.from))) {
      await sendTelegramMessage(
        String(chat.id),
        "Only group admins can view this community chat id.",
      );
      return { handled: true, command };
    }

    await sendTelegramMessage(String(chat.id), chatIdMessage(chat.id, role));
    return { handled: true, command };
  }

  if (command === "/role") {
    const requested = args[0]?.toLowerCase();
    const role = requested ? roleAliases[requested] : null;

    if (!role) {
      await sendTelegramMessage(
        String(chat.id),
        "Usage: /role support | /role alerts | /role general",
      );
      return { handled: true, command };
    }

    if (!(await isTelegramAdmin(chat.id, message.from))) {
      await sendTelegramMessage(String(chat.id), "Only group admins can change this bot role.");
      return { handled: true, command };
    }

    await setTelegramChatRole(String(chat.id), role, chat);
    await sendTelegramMessage(
      String(chat.id),
      "This chat is now registered as " + roleLabel(role) + ".",
    );
    return { handled: true, command };
  }

  if (command === "/markets") {
    await sendTelegramMessage(String(chat.id), await buildMarketDigest());
    return { handled: true, command };
  }

  if (command === "/quote_status") {
    await sendTelegramMessage(String(chat.id), omnistonQuoteStatusMessage());
    return { handled: true, command };
  }

  if (command === "/quote") {
    await sendTelegramMessage(String(chat.id), await handleOmnistonQuoteCommand(args, message));
    return { handled: true, command };
  }

  if (command === "/app" || command === "/miniapp") {
    await sendTelegramMessage(String(chat.id), miniAppMessage(), miniAppKeyboard());
    return { handled: true, command };
  }

  if (command === "/execution_status") {
    await sendTelegramMessage(String(chat.id), await executionStatusMessage());
    return { handled: true, command };
  }

  if (command === "/aistatus") {
    const status = await checkSupportAiProvider();
    await sendTelegramMessage(String(chat.id), aiStatusMessage(status));
    return { handled: true, command };
  }

  if (command === "/reply") {
    const stored = await prisma.telegramChat.findUnique({ where: { chatId: String(chat.id) } });
    if ((stored?.role ?? TelegramChatRole.GENERAL) !== TelegramChatRole.SUPPORT) {
      await sendTelegramMessage(
        String(chat.id),
        "Support replies can only be sent from the support group.",
      );
      return { handled: true, command };
    }
    const result = await handleSupportReplyCommand(args, message);
    await sendTelegramMessage(String(chat.id), result);
    return { handled: true, command };
  }

  if (command === "/resolve") {
    const stored = await prisma.telegramChat.findUnique({ where: { chatId: String(chat.id) } });
    if ((stored?.role ?? TelegramChatRole.GENERAL) !== TelegramChatRole.SUPPORT) {
      await sendTelegramMessage(
        String(chat.id),
        "Tickets can only be resolved from the support group.",
      );
      return { handled: true, command };
    }
    const result = await handleSupportResolveCommand(args, message);
    await sendTelegramMessage(String(chat.id), result);
    return { handled: true, command };
  }

  if (command === "/status") {
    const stored = await prisma.telegramChat.findUnique({ where: { chatId: String(chat.id) } });
    await sendTelegramMessage(
      String(chat.id),
      [
        "Conviction bot status",
        "Chat id: " + chat.id,
        "Role: " + roleLabel(stored?.role ?? TelegramChatRole.GENERAL),
        "Support alerts: " +
          (env.telegramSupportChatId ? "configured" : "missing TELEGRAM_SUPPORT_CHAT_ID"),
        "Mini app: " + miniAppUrl,
      ].join("\n"),
      miniAppKeyboard(),
    );
    return { handled: true, command };
  }

  await sendTelegramMessage(
    String(chat.id),
    "Unknown command. Send /help for Conviction bot commands.",
  );
  return { handled: true, command };
}

export async function sendSupportTicketAlert(ticket: SupportTicketAlert) {
  const chats = await supportAlertChats();
  if (chats.length === 0) return false;

  const text = [
    "New Conviction support ticket",
    "Ticket: " + ticket.id,
    "Reply: /reply " + ticket.id + " Subject | Solution body",
    "Resolve: /resolve " + ticket.id + " Subject | Closing note",
    "Support mail: " + supportEmail,
    "Email: " + ticket.email,
    ticket.wallet ? "Wallet: " + ticket.wallet : null,
    ticket.userId ? "User: " + ticket.userId : null,
    "Subject: " + ticket.subject,
    "Summary: " + ticket.summary,
  ]
    .filter(Boolean)
    .join("\n");

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

async function welcomeNewTelegramMembers(
  chat: TelegramChat,
  members: TelegramUser[],
  role: TelegramChatRole,
) {
  if (role === TelegramChatRole.SUPPORT) return false;

  const realMembers = members.filter((member) => !member.is_bot);
  if (realMembers.length === 0) return false;

  const names = realMembers.map(telegramMentionName).join(", ");
  const text = [
    "Welcome " + names + " to Conviction Markets.",
    "Test the product and share your feedback: https://convictionmarkets.xyz",
  ].join("\n");

  return sendTelegramMessage(String(chat.id), text);
}

function telegramMentionName(user: TelegramUser) {
  if (user.username) return "@" + user.username;
  const name = user.first_name?.trim() || "there";
  return name;
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
      role:
        env.telegramSupportChatId === String(chat.id)
          ? TelegramChatRole.SUPPORT
          : TelegramChatRole.GENERAL,
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

async function handleSupportReplyCommand(args: string[], message: TelegramMessage) {
  const ticketId = args[0];
  const rest = args.slice(1).join(" ").trim();

  if (!ticketId || !rest) {
    return [
      "Reply format:",
      "/reply <ticketId> Subject | Solution body",
      "Example:",
      "/reply 6a37... Legality | Prediction market rules depend on jurisdiction. Please review local laws before trading.",
    ].join("\n");
  }

  const parsed = parseSupportMail(rest);

  try {
    await createSupportReply({
      ticketId,
      authorType: "SUPPORT",
      authorName: telegramAuthorName(message),
      subject: parsed.subject,
      body: parsed.body,
      source: "TELEGRAM",
    });

    return (
      "Reply saved for ticket " +
      ticketId +
      ". The user can see it in Conviction Support and app notifications."
    );
  } catch {
    return "Ticket not found. Check the ticket id and try again.";
  }
}

async function handleSupportResolveCommand(args: string[], message: TelegramMessage) {
  const ticketId = args[0];
  const rest = args.slice(1).join(" ").trim();

  if (!ticketId) {
    return "Resolve format: /resolve <ticketId> Optional subject | Optional closing note";
  }

  const parsed = parseSupportMail(
    rest ||
      "Ticket resolved | This ticket has been marked resolved. Reply from the Support page if you still need help.",
  );

  try {
    await resolveSupportTicket(ticketId, {
      authorName: telegramAuthorName(message),
      subject: parsed.subject,
      body: parsed.body,
    });

    return (
      "Ticket " +
      ticketId +
      " marked resolved. It will auto-close after 3 days unless the user replies."
    );
  } catch {
    return "Ticket not found. Check the ticket id and try again.";
  }
}

async function handleOmnistonQuoteCommand(args: string[], message: TelegramMessage) {
  const [fromAsset, toAsset, amountUnits] = args;

  if (!fromAsset || !toAsset || !amountUnits) {
    return [
      "Usage: /quote <from> <to> <amountUnits>",
      "Examples:",
      "/quote TON USDT 1000000000",
      "/quote USDT STON 1000000",
      "Amounts are base units, not display decimals.",
    ].join("\n");
  }

  if (!integerUnitsPattern.test(amountUnits) || BigInt(amountUnits) <= 0n) {
    return "Amount must be positive integer base units, for example 1000000.";
  }

  const quoteService = new OmnistonQuoteService(env.omniston);

  try {
    const result = await quoteService.requestQuote({ fromAsset, toAsset, amountUnits });
    await recordTelegramQuoteEvent(message, {
      fromAsset,
      toAsset,
      amountUnits,
      status: OmnistonQuoteStatus.QUOTED,
      inputUnits: result.quote.inputUnits,
      outputUnits: result.quote.outputUnits,
      settlement: result.settlement,
      resolverName: result.quote.resolverName,
      quoteId: result.quote.quoteId,
      gasBudget: result.quote.gasBudget ?? null,
      routeCount:
        result.quote.settlementData.$case === "swap"
          ? result.quote.settlementData.value.routes.length
          : null,
    });

    return formatOmnistonQuote(result);
  } catch (error) {
    await recordTelegramQuoteEvent(message, {
      fromAsset,
      toAsset,
      amountUnits,
      ...omnistonQuoteErrorFields(error),
    });

    return omnistonQuoteErrorMessage(error);
  }
}

type TelegramQuoteEventInput = {
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
};

async function recordTelegramQuoteEvent(message: TelegramMessage, input: TelegramQuoteEventInput) {
  try {
    await recordOmnistonQuoteEvent({
      platformUserId: message.from?.id ? String(message.from.id) : null,
      username: message.from?.username ?? null,
      source: "CORE_TELEGRAM_WEBHOOK",
      ...input,
    });
  } catch (error) {
    console.error("[telegram] could not record Omniston quote event", error);
  }
}

function omnistonQuoteStatusMessage() {
  return [
    "Omniston quote status",
    "Enabled: " + (env.omniston.enabled ? "yes" : "no"),
    "Network: " + env.omniston.network,
    "Routing mode: " + env.omniston.routingMode,
    "API: " + env.omniston.apiUrl,
    "Timeout: " + env.omniston.quoteTimeoutMs + "ms",
    "Quote command: " +
      (env.omniston.enabled && env.omniston.routingMode === "quote_only" ? "ready" : "disabled"),
  ].join("\n");
}

function formatOmnistonQuote(result: OmnistonQuoteResult) {
  const { quote } = result;
  const lines = [
    "Omniston quote",
    result.inputSymbol + " -> " + result.outputSymbol,
    "Input: " + formatQuoteAmount(quote.inputUnits, result.inputSymbol),
    "Estimated output: " + formatQuoteAmount(quote.outputUnits, result.outputSymbol),
    "Settlement: " + result.settlement,
    "Resolver: " + quote.resolverName,
    "Quote ID: " + quote.quoteId,
  ];

  if (quote.gasBudget) {
    lines.push("Gas budget: " + quote.gasBudget);
  }

  if (quote.settlementData.$case === "swap") {
    lines.push("Routes: " + quote.settlementData.value.routes.length);
    lines.push(
      "Recommended min output: " +
        formatQuoteAmount(
          quote.settlementData.value.recommendedMinOutputAmount,
          result.outputSymbol,
        ),
    );
  }

  lines.push(
    "",
    "Quote only. No wallet transaction was built or submitted.",
    "https://convictionmarkets.xyz",
  );

  return lines.join("\n");
}

const integerUnitsPattern = /^(?:0|[1-9]\d*)$/;

const quoteAssetDecimals: Record<string, number> = {
  STON: 9,
  TON: 9,
  USDT: 6,
};

function formatQuoteAmount(units: string, symbol: string) {
  const decimals = quoteAssetDecimals[symbol.toUpperCase()];

  if (decimals === undefined) {
    return units + " units";
  }

  const value = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const displayFraction = fractionText ? "." + fractionText.slice(0, 6) : "";

  return whole.toString() + displayFraction + " " + symbol + " (" + units + " units)";
}

function omnistonQuoteErrorFields(error: unknown): {
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

function omnistonQuoteErrorMessage(error: unknown) {
  if (error instanceof OmnistonQuoteDisabledError) {
    return "Omniston quotes are disabled on this deployment. Set OMNISTON_ENABLED=true and OMNISTON_ROUTING_MODE=quote_only to test quotes.";
  }

  if (error instanceof OmnistonQuoteInputError) {
    return error.message;
  }

  if (error instanceof OmnistonNoQuoteError || error instanceof OmnistonQuoteTimeoutError) {
    return error.message;
  }

  console.error(error);
  return "I could not fetch an Omniston quote right now. Please try again later.";
}

async function buildTelegramAiAnswer(question: string, message: TelegramMessage) {
  const author = message.from?.username
    ? "@" + message.from.username
    : (message.from?.first_name ?? "Telegram user");
  const result = await createSupportAnswer({
    question,
    pageContext: "Telegram group question from " + author,
    maxLength: 1500,
  });

  return result.answer;
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
      return [String(index + 1) + ". " + market.title, "YES " + yes + " | " + tag].join("\n");
    }),
    "Open: https://convictionmarkets.xyz/markets",
  ].join("\n\n");
}

async function sendTelegramMessage(chatId: string, text: string, replyMarkup?: TelegramReplyMarkup) {
  if (!env.telegramBotToken) return false;

  try {
    const response = await fetch(
      "https://api.telegram.org/bot" + env.telegramBotToken + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          disable_web_page_preview: true,
          text: truncateTelegramText(text),
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      },
    );

    return response.ok;
  } catch {
    return false;
  }
}


type TelegramReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; url?: string; web_app?: { url: string } }>>;
};

function miniAppKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "Open Conviction Mini App", web_app: { url: miniAppUrl } }],
      [{ text: "Open in browser", url: miniAppUrl }],
    ],
  };
}

function miniAppMessage() {
  return [
    "Conviction Mini App",
    "Explore markets, follow Pulse, request margin, and prepare TON vault liquidity from Telegram.",
    "Open: " + miniAppUrl,
  ].join("\n");
}

function normalizeTelegramCommandText(value: string) {
  return value
    .replace(/^\/ai\s*<question>\s*/i, "/ai ")
    .replace(/^\/ai:\s*/i, "/ai ")
    .replace(/^\/ask:\s*/i, "/ask ");
}

function normalizeAiQuestion(value: string) {
  return value
    .trim()
    .replace(/^<+/, "")
    .replace(/>+$/, "")
    .replace(/^question>\s*/i, "")
    .trim();
}

function startMessage(chatId: number) {
  return [
    "Conviction Markets bot is active.",
    "Chat id: " + chatId,
    "Use /help after assigning this group a role.",
    "Support mail: " + supportEmail,
  ].join("\n");
}

function helpMessage(role: TelegramChatRole) {
  if (role === TelegramChatRole.SUPPORT) {
    return [
      "Conviction support commands",
      "/status - show support bot status",
      "/chatid - show this support group id",
      "/reply <ticketId> Subject | Solution body - send a reply into the user support thread",
      "/resolve <ticketId> Subject | Closing note - mark a ticket resolved",
      "/markets - show a live market digest",
      "/quote <from> <to> <amountUnits> - get a quote-only TON route",
      "/app - open the Telegram Mini App",
      "/quote_status - show Omniston quote mode",
      "/execution_status - show margin/fill readiness",
      "/aistatus - test the core AI provider connection",
      "Support mail: " + supportEmail,
    ].join("\n");
  }

  if (role === TelegramChatRole.MARKET_ALERTS) {
    return [
      "Conviction community commands",
      "/ai <question> - ask Conviction AI",
      "/ai: <question> - ask Conviction AI",
      "/markets - show a live market digest",
      "/quote <from> <to> <amountUnits> - get a quote-only TON route",
      "/app - open the Telegram Mini App",
      "/quote_status - show Omniston quote mode",
      "/execution_status - show margin/fill readiness",
      "/aistatus - test the core AI provider connection",
      "/role general - stop scheduled market digests",
      "/status - show community bot status",
    ].join("\n");
  }

  return [
    "Conviction community commands",
    "/ai <question> - ask Conviction AI",
    "/ai: <question> - ask Conviction AI",
    "/markets - show a live market digest",
    "/quote <from> <to> <amountUnits> - get a quote-only TON route",
    "/app - open the Telegram Mini App",
    "/quote_status - show Omniston quote mode",
    "/execution_status - show margin/fill readiness",
    "/aistatus - test the core AI provider connection",
    "/role alerts - receive scheduled market digests",
    "/status - show community bot status",
  ].join("\n");
}

async function executionStatusMessage() {
  const readiness = await getExecutionReadiness();
  const readyStages = readiness.stages.filter((stage) => stage.ready).length;
  const totalStages = readiness.stages.length;
  const missing = readiness.missing.slice(0, 4);

  return [
    "Conviction execution status",
    "Status: " + readiness.status,
    "Wallet flow: " + (readiness.canPrepareWalletTransactions ? "ready" : "blocked"),
    "Adapter settlement: " + (readiness.canSettleAdapterExecution ? "ready" : "blocked"),
    "Production venue fills: " + (readiness.productionVenueFillEnabled ? "ready" : "disabled"),
    "Ready stages: " + readyStages + "/" + totalStages,
    "Adapter: " + readiness.adapter.code,
    readiness.adapter.message,
    missing.length ? "Missing: " + missing.join(" | ") : null,
    "HTTP: https://conviction-core-api.vercel.app/execution/readiness",
  ]
    .filter(Boolean)
    .join("\n");
}

function aiStatusMessage(status: Awaited<ReturnType<typeof checkSupportAiProvider>>) {
  const runtime = getSupportAiRuntimeStatus();

  return [
    "Conviction AI status",
    "Core OPENAI_API_KEY: " + (runtime.configured ? "configured" : "missing"),
    "Base URL: " + runtime.baseUrl,
    "Model: " + runtime.model,
    "Provider test: " + (status.ok ? "ok" : "failed"),
    "Detail: " + status.detail,
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

function chatIdMessage(chatId: number, role: TelegramChatRole) {
  if (role === TelegramChatRole.SUPPORT) {
    return "Chat id: " + chatId + "\nThis support group is registered for ticket alerts.";
  }

  return (
    "Chat id: " +
    chatId +
    "\nAdmins can use /role alerts for market updates or /role general for community AI only."
  );
}

async function isTelegramAdmin(chatId: number, user: TelegramUser | undefined) {
  if (!env.telegramBotToken || !user?.id) return false;
  const userId = user.id;
  if (!userId) return false;

  try {
    const response = await fetch(
      "https://api.telegram.org/bot" + env.telegramBotToken + "/getChatMember",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, user_id: userId }),
      },
    );
    const body = (await response.json()) as TelegramChatMemberResponse;
    const status = body.result?.status;
    return body.ok === true && (status === "creator" || status === "administrator");
  } catch {
    return false;
  }
}

function parseSupportMail(value: string) {
  const [subjectPart, ...bodyParts] = value.split("|");
  const subject = subjectPart.trim() || "Support reply";
  const body = bodyParts.join("|").trim() || subject;

  return { subject, body };
}

function telegramAuthorName(message: TelegramMessage) {
  return message.from?.username
    ? "@" + message.from.username
    : (message.from?.first_name ?? "Conviction Support");
}
