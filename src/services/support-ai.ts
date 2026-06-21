import { env } from "../config/index.js";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type SupportAnswerInput = {
  question: string;
  conversation?: ChatMessage[];
  pageContext?: string;
  maxLength?: number;
};

const maxConversationMessages = 8;

export async function createSupportAnswer(input: SupportAnswerInput) {
  const question = truncateClean(input.question, 1200);
  const fallback = createFallbackAnswer(question);

  if (!question) return fallback;
  if (!env.openAiApiKey) return fallback;

  try {
    const answer = await requestOpenAiAnswer({
      question,
      conversation: normalizeConversation(input.conversation),
      pageContext: input.pageContext ?? "Telegram community/support bot",
      maxLength: input.maxLength ?? 1400,
    });

    return answer || fallback;
  } catch {
    return fallback;
  }
}

async function requestOpenAiAnswer({
  question,
  conversation,
  pageContext,
  maxLength,
}: {
  question: string;
  conversation: ChatMessage[];
  pageContext: string;
  maxLength: number;
}) {
  const supportContext = [
    "Conviction Markets is a leveraged marketplace for prediction markets.",
    "Users browse real event markets, inspect rules and odds, create social signals, request margin, and manage portfolio/vault activity from Conviction routes.",
    "The product adds a margin desk, vault-supplied liquidity, .viction identity, social Market Pulse, share cards, preferences, and support workflows around prediction market data.",
    "Current execution posture: if the app says intent-only or testnet, explain that requests may be recorded/prepared but should not be described as fully executed unless transaction state confirms it.",
    "Vault model: liquidity providers supply capital to vaults. Traders can use collateral plus vault liquidity for larger prediction market exposure. LP risks include smart-contract risk, market/liquidation risk, oracle/adapter risk, liquidity lockup during active use, and rollout risk.",
    "Wallet model: EVM wallet sessions key profile, email, preferences, portfolio context, and support context. Users do not need Farcaster to use wallet profiles.",
    "Profile model: users claim .viction handles, avatar, bio, and email against the connected wallet. Guests should connect wallet before editing profile.",
    "Activity model: Market Pulse is the social/news layer. Users can post market calls, reply, like, repost, follow traders, and share market cards. Public/private trade visibility must be respected.",
    "Market model: market pages show rules, category, region/topic, odds, and price history/candles when available. The product should feel like Conviction, not an outbound wrapper.",
    "Telegram model: answer clearly inside Telegram. For account-specific issues, ask for email and issue summary so a human support ticket can be created. Do not mention WhatsApp.",
    "Tone: concise, practical, and direct. Avoid hype and do not invent odds, winners, fills, PnL, liquidity, or execution state.",
  ].join(" ");

  const response = await fetch(env.openAiBaseUrl.replace(/\/$/, "") + "/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.openAiApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.openAiSupportModel,
      input: [
        { role: "system", content: supportContext },
        ...conversation,
        { role: "user", content: JSON.stringify({ question, pageContext }) },
      ],
    }),
  });

  if (!response.ok) throw new Error("Support AI request failed.");

  const parsed = (await response.json()) as unknown;
  return truncateClean(extractResponseText(parsed), maxLength);
}

function extractResponseText(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.output_text === "string") return value.output_text;

  const output = value.output;
  if (!Array.isArray(output)) return "";

  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string") return content.text;
    }
  }

  return "";
}

function createFallbackAnswer(question: string) {
  const normalized = question.toLowerCase();

  if (normalized.includes("risk") || normalized.includes("locked") || normalized.includes("lock")) {
    return "Yes, vault liquidity has risk. Funds can be locked while backing active margin, and LPs carry smart-contract, market/liquidation, adapter/oracle, and rollout risk. The upside is earning from margin activity when the system is live and working correctly.";
  }

  if (normalized.includes("vault") || normalized.includes("liquidity") || normalized.includes("yield")) {
    return "Vaults are the capital layer. Liquidity providers deposit capital, traders borrow from that pool for larger prediction-market exposure, and LPs can earn from that activity. It should be treated as risk capital, not guaranteed yield.";
  }

  if (normalized.includes("margin") || normalized.includes("leverage")) {
    return "Margin means a trader uses their collateral plus vault liquidity to get larger exposure to a prediction market. The flow is: review rules, choose YES/NO, set collateral and leverage, then submit through the wallet flow when available.";
  }

  if (normalized.includes("prediction") || normalized.includes("market")) {
    return "Conviction Markets is a leveraged marketplace for prediction markets. Users discover event markets, review rules and odds, discuss them in Market Pulse, and can request margin powered by vault liquidity.";
  }

  if (normalized.includes("wallet") || normalized.includes("connect")) {
    return "Connect an EVM wallet from the top-right wallet button. Conviction keys profile, email, preferences, portfolio, and support context to that wallet address so the account persists across refreshes.";
  }

  if (normalized.includes("profile") || normalized.includes("viction")) {
    return "Your Conviction identity is tied to your connected wallet. Claim a .viction handle, add email, avatar, and bio, then your public signals and social activity show under that profile.";
  }

  return "I can help with market discovery, rules, margin requests, vault deposits, wallet connection, .viction profiles, portfolio, Activity, or support. For account-specific help, share an email and short issue summary so the team can follow up.";
}

function normalizeConversation(value: ChatMessage[] | undefined): ChatMessage[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" as const : "user" as const,
      content: truncateClean(message.content, 1000),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-maxConversationMessages);
}

function truncateClean(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength - 1) + "...";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
