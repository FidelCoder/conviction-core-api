import { env } from "../config/index.js";
import { supportedIntentChains } from "../config/deployed-contracts.js";

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

type SupportUnavailableReason = "missing_api_key" | "empty_response" | "provider_error" | "invalid_question";

type SupportAnswerResult =
  | {
      ok: true;
      answer: string;
      source: "ai";
      model: string;
      baseUrl: string;
    }
  | {
      ok: false;
      answer: string;
      source: "unavailable";
      reason: SupportUnavailableReason;
      detail?: string;
      model: string;
      baseUrl: string;
    };

type SupportAiProbeResult = {
  configured: boolean;
  ok: boolean;
  baseUrl: string;
  model: string;
  detail: string;
};

const maxConversationMessages = 8;

export async function createSupportAnswer(input: SupportAnswerInput): Promise<SupportAnswerResult> {
  const question = normalizeSupportQuestion(truncateClean(input.question, 1200));

  if (!question) return unavailable("invalid_question");
  if (!env.openAiApiKey) return unavailable("missing_api_key");

  try {
    const answer = await requestOpenAiAnswer({
      question,
      conversation: normalizeConversation(input.conversation),
      pageContext: input.pageContext ?? "Telegram community/support bot",
      maxLength: input.maxLength ?? 1400,
    });

    if (!answer) return unavailable("empty_response");

    return {
      ok: true,
      answer,
      source: "ai",
      model: env.openAiSupportModel,
      baseUrl: env.openAiBaseUrl,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    console.warn("Support AI provider request failed", detail);
    return unavailable("provider_error", detail);
  }
}

export function getSupportAiRuntimeStatus() {
  return {
    configured: Boolean(env.openAiApiKey),
    baseUrl: env.openAiBaseUrl,
    model: env.openAiSupportModel,
  };
}

export async function checkSupportAiProvider(): Promise<SupportAiProbeResult> {
  const status = getSupportAiRuntimeStatus();

  if (!env.openAiApiKey) {
    return {
      ...status,
      ok: false,
      detail: "missing_OPENAI_API_KEY_on_core_api",
    };
  }

  try {
    const response = await fetch(env.openAiBaseUrl.replace(/\/$/, "") + "/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.openAiApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.openAiSupportModel,
        input: [
          { role: "system", content: "Return exactly AI_READY." },
          { role: "user", content: "ping" },
        ],
      }),
    });

    if (!response.ok) {
      return {
        ...status,
        ok: false,
        detail: "provider_status_" + response.status,
      };
    }

    const text = truncateClean(extractResponseText(await response.json()), 120);

    return {
      ...status,
      ok: Boolean(text),
      detail: text || "empty_response",
    };
  } catch (error) {
    return {
      ...status,
      ok: false,
      detail: error instanceof Error ? error.message : "provider_error",
    };
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
  const response = await fetch(env.openAiBaseUrl.replace(/\/$/, "") + "/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.openAiApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.openAiSupportModel,
      input: [
        { role: "system", content: buildSupportContext() },
        ...conversation,
        { role: "user", content: JSON.stringify({ question, pageContext }) },
      ],
    }),
  });

  if (!response.ok) throw new Error("provider_status_" + response.status);

  const parsed = (await response.json()) as unknown;
  return truncateClean(extractResponseText(parsed), maxLength);
}

function buildSupportContext() {
  return [
    "You are Conviction AI, the Telegram and product support assistant for Conviction Markets.",
    "Answer the user's exact question conversationally. Do not reply with a generic capability menu unless the user asks what you can do.",
    "Conviction Markets is a leveraged marketplace for prediction markets. It uses real event market data and adds Conviction-native margin requests, vault liquidity, portfolio tracking, .viction identity, social Market Pulse, media/share cards, preferences, and support workflows.",
    "Simple product explanation: traders can discover event markets, review rules and odds, and request larger YES/NO exposure using their collateral plus liquidity supplied by vault depositors. Liquidity providers deposit capital into vaults and can earn from margin activity, while accepting risk.",
    "Current execution posture: if the app says intent-only, testnet, or pending adapter, explain that the flow may record or prepare a request but should not be called fully executed onchain unless the app has a confirmed transaction hash/state.",
    "Vault risks: smart-contract risk, liquidation/market movement risk, oracle or adapter risk, liquidity lockup while funds back active margin, and rollout risk. Do not call yield guaranteed.",
    "Wallet model: EVM wallet sessions key profile, email, preferences, portfolio context, support tickets, and .viction identity. Users do not need Farcaster to use wallet profiles.",
    "Activity model: Market Pulse is the social/news layer for prediction markets. Users can post market calls, reply, like, repost, follow traders, and share market cards. Respect public/private trade visibility.",
    "Market model: market pages show event rules, category, region/topic, odds, and price history/candles when available. The product should feel like Conviction, not an outbound wrapper.",
    "Support model: for account-specific issues, ask for email and a short issue summary so a human ticket can be created. Support email is convictionsmarket@gmail.com. Do not mention WhatsApp.",
    "Contract deployments known to the product:\n" + contractSummary(),
    "Tone: clear, direct, practical, and human. Avoid hype. Do not invent odds, winners, fills, PnL, TVL, liquidity, transaction hashes, or execution state.",
  ].join("\n\n");
}

function extractResponseText(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.output_text === "string") return value.output_text;

  const output = value.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];

    for (const item of output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        const text = extractTextContent(content);
        if (text) parts.push(text);
      }
    }

    if (parts.length > 0) return parts.join("\n").trim();
  }

  const choices = value.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isRecord(choice) || !isRecord(choice.message)) continue;
      const content = choice.message.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) continue;
      const text = content.map(extractTextContent).filter(Boolean).join("\n").trim();
      if (text) return text;
    }
  }

  return "";
}

function extractTextContent(value: unknown) {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (isRecord(value.text) && typeof value.text.value === "string") return value.text.value;
  if (typeof value.output_text === "string") return value.output_text;
  if (typeof value.content === "string") return value.content;
  return "";
}

function unavailable(reason: SupportUnavailableReason, detail?: string): SupportAnswerResult {
  const status = getSupportAiRuntimeStatus();
  const reasonText = reason === "missing_api_key"
    ? "OPENAI_API_KEY is missing on the core API deployment."
    : reason === "empty_response"
      ? "The AI provider returned an empty response."
      : reason === "invalid_question"
        ? "No AI question was provided."
        : "The core API could not reach the AI provider" + (detail ? ": " + detail : ".");

  return {
    ok: false,
    answer: "Conviction AI is unavailable right now. " + reasonText + " The bot is not using local canned answers for /ai.",
    source: "unavailable",
    reason,
    detail,
    model: status.model,
    baseUrl: status.baseUrl,
  };
}

function contractSummary() {
  return supportedIntentChains.map((chain) => {
    const vault = chain.vaultAddress ?? "not deployed/configured yet";
    const collateral = chain.collateralTokenAddress
      ? `${chain.collateralTokenSymbol ?? "collateral"} ${chain.collateralTokenAddress}`
      : "not deployed/configured yet";
    const walletFlow = chain.walletFlowEnabled ? "wallet flow enabled" : "wallet flow not enabled";

    return `${chain.chainName} (${chain.network}, chainId ${chain.chainId}): Conviction Vault ${vault}; collateral ${collateral}; ${walletFlow}.`;
  }).join("\n");
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

function normalizeSupportQuestion(value: string) {
  return value
    .replace(/^<+/, "")
    .replace(/>+$/, "")
    .replace(/^question>\s*/i, "")
    .trim();
}

function truncateClean(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength - 1) + "...";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
