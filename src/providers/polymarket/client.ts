import { MarketSource, MarketStatus } from "@prisma/client";
import { z } from "zod";

import type { MarketProvider, ProviderMarketInput } from "../../services/market-provider.js";

const gammaMarketSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  question: z.string().min(1),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  archived: z.boolean().optional(),
  endDate: z.string().nullable().optional(),
  endDateIso: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  conditionId: z.string().nullable().optional(),
  questionID: z.string().nullable().optional(),
  clobTokenIds: z.string().nullable().optional(),
  enableOrderBook: z.boolean().optional(),
  acceptingOrders: z.boolean().optional(),
  orderPriceMinTickSize: z.union([z.string(), z.number()]).nullable().optional(),
  orderMinSize: z.union([z.string(), z.number()]).nullable().optional(),
  lastTradePrice: z.union([z.string(), z.number()]).nullable().optional(),
  bestBid: z.union([z.string(), z.number()]).nullable().optional(),
  bestAsk: z.union([z.string(), z.number()]).nullable().optional(),
  events: z
    .array(
      z.object({
        slug: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const gammaMarketListSchema = z.array(gammaMarketSchema);

type GammaMarket = z.infer<typeof gammaMarketSchema>;

export class PolymarketProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PolymarketProviderError";
  }
}

export type PolymarketProviderOptions = {
  gammaApiUrl: string;
  listLimit: number;
};

export class PolymarketProvider implements MarketProvider {
  readonly source = MarketSource.POLYMARKET;

  private readonly gammaApiUrl: URL;
  private readonly listLimit: number;

  constructor(options: PolymarketProviderOptions) {
    this.gammaApiUrl = new URL(options.gammaApiUrl);
    this.listLimit = options.listLimit;
  }

  async listMarkets(): Promise<ProviderMarketInput[]> {
    const url = this.buildUrl("/markets", {
      active: "true",
      closed: "false",
      limit: String(this.listLimit),
    });
    const payload = await this.fetchJson(url);
    const parsed = gammaMarketListSchema.safeParse(payload);

    if (!parsed.success) {
      throw new PolymarketProviderError(
        "Polymarket market list response did not match expected shape",
        {
          cause: parsed.error,
        },
      );
    }

    return parsed.data.map(mapGammaMarket);
  }

  async getMarketById(externalMarketId: string): Promise<ProviderMarketInput | null> {
    const url = this.buildUrl("/markets/" + encodeURIComponent(externalMarketId));

    try {
      const payload = await this.fetchJson(url);
      const parsed = gammaMarketSchema.safeParse(payload);

      if (!parsed.success) {
        throw new PolymarketProviderError(
          "Polymarket market response did not match expected shape",
          {
            cause: parsed.error,
          },
        );
      }

      return mapGammaMarket(parsed.data);
    } catch (error) {
      if (error instanceof PolymarketProviderError && error.message.includes("404")) {
        return null;
      }

      throw error;
    }
  }

  async syncMarket(externalMarketId: string): Promise<ProviderMarketInput | null> {
    return this.getMarketById(externalMarketId);
  }

  private buildUrl(pathname: string, params: Record<string, string> = {}) {
    const url = new URL(pathname, this.gammaApiUrl);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return url;
  }

  private async fetchJson(url: URL): Promise<unknown> {
    let response: Response;

    try {
      response = await fetch(url);
    } catch (error) {
      throw new PolymarketProviderError("Failed to reach Polymarket Gamma API at " + url.origin, {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new PolymarketProviderError(
        "Polymarket Gamma API request failed with " + response.status + " " + response.statusText,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new PolymarketProviderError("Polymarket Gamma API returned invalid JSON", {
        cause: error,
      });
    }
  }
}

export function mapGammaMarket(market: GammaMarket): ProviderMarketInput {
  const [yesTokenId, noTokenId] = parseTokenIds(market.clobTokenIds);
  const slug = market.slug ?? null;

  return {
    externalMarketId: market.id,
    source: MarketSource.POLYMARKET,
    title: market.question,
    description: market.description ?? null,
    category: market.category ?? market.events?.[0]?.title ?? null,
    status: mapMarketStatus(market),
    resolutionDate: parseDate(market.endDate ?? market.endDateIso),
    externalUrl: slug ? "https://polymarket.com/market/" + slug : null,
    yesTokenId,
    noTokenId,
    slug,
    conditionId: market.conditionId ?? null,
    questionId: market.questionID ?? null,
    orderBookEnabled: market.enableOrderBook ?? false,
    acceptingOrders: market.acceptingOrders ?? false,
    orderPriceMinTickSize: market.orderPriceMinTickSize ?? null,
    orderMinSize: market.orderMinSize ?? null,
    lastTradePrice: market.lastTradePrice ?? null,
    bestBid: market.bestBid ?? null,
    bestAsk: market.bestAsk ?? null,
  };
}

function mapMarketStatus(
  market: Pick<GammaMarket, "active" | "archived" | "closed">,
): MarketStatus {
  if (market.archived) {
    return MarketStatus.CANCELLED;
  }

  if (market.closed) {
    return MarketStatus.CLOSED;
  }

  if (market.active) {
    return MarketStatus.ACTIVE;
  }

  return MarketStatus.CLOSED;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTokenIds(value: string | null | undefined): [string | null, string | null] {
  if (!value) {
    return [null, null];
  }

  try {
    const parsed = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return [null, null];
    }

    const [yesTokenId, noTokenId] = parsed;

    return [
      typeof yesTokenId === "string" ? yesTokenId : null,
      typeof noTokenId === "string" ? noTokenId : null,
    ];
  } catch {
    return [null, null];
  }
}
