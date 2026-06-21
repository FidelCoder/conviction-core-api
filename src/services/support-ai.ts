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

const maxConversationMessages = 8;

export async function createSupportAnswer(input: SupportAnswerInput) {
  const question = normalizeSupportQuestion(truncateClean(input.question, 1200));
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
  } catch (error) {
    console.warn(
      "Support AI provider request failed",
      error instanceof Error ? error.message : "unknown error",
    );
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

  if (!response.ok) throw new Error("Support AI request failed with status " + response.status + ".");

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

function createFallbackAnswer(question: string) {
  const normalized = question.toLowerCase();

  if (mentionsContracts(normalized)) {
    return contractSummary(normalized);
  }

  if (asksAboutProduct(normalized)) {
    return "Conviction Markets is a leveraged prediction-market product. Traders discover event markets, review rules and odds, then use collateral plus vault liquidity to take larger YES/NO exposure. Liquidity providers supply capital to vaults and can earn from margin activity, while carrying contract, market, liquidation, and lockup risk. The social layer lets users discuss markets, share signals, follow traders, and route support through the app or Telegram.";
  }

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

  return "Conviction Markets helps traders find prediction markets, understand the rules, discuss them with other traders, and request leveraged exposure backed by vault liquidity. Ask me about a market, vault risk, margin flow, contracts, wallet setup, portfolio, or support.";
}

function contractSummary(filter = "") {
  const normalized = filter.toLowerCase();
  const matchingChains = supportedIntentChains.filter((chain) => {
    if (!normalized) return true;
    if (normalized.includes("base") && chain.chainName.toLowerCase().includes("base")) return true;
    if (normalized.includes("ethereum") && chain.chainName.toLowerCase().includes("ethereum")) return true;
    if (normalized.includes("eth") && chain.chainName.toLowerCase().includes("ethereum")) return true;
    if (normalized.includes("arbitrum") && chain.chainName.toLowerCase().includes("arbitrum")) return true;
    if (normalized.includes(String(chain.chainId))) return true;
    return false;
  });

  const chains = matchingChains.length > 0 ? matchingChains : supportedIntentChains;

  return chains.map((chain) => {
    const vault = chain.vaultAddress ?? "not deployed/configured yet";
    const collateral = chain.collateralTokenAddress
      ? `${chain.collateralTokenSymbol ?? "collateral"} ${chain.collateralTokenAddress}`
      : "not deployed/configured yet";
    const walletFlow = chain.walletFlowEnabled ? "wallet flow enabled" : "wallet flow not enabled";

    return `${chain.chainName} (${chain.network}, chainId ${chain.chainId}): Conviction Vault ${vault}; collateral ${collateral}; ${walletFlow}.`;
  }).join("\n");
}

function mentionsContracts(normalized: string) {
  return [
    "contract",
    "contracts",
    "address",
    "addresses",
    "deployed",
    "deployment",
    "base",
    "sepolia",
    "arbitrum",
    "ethereum",
  ].some((term) => normalized.includes(term));
}

function asksAboutProduct(normalized: string) {
  return [
    "about the product",
    "tell me about this product",
    "tell me about the product",
    "what is conviction",
    "what's conviction",
    "how does conviction",
    "how exactly does it work",
  ].some((term) => normalized.includes(term));
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
