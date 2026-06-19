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
  liquidity: z.union([z.string(), z.number()]).nullable().optional(),
  liquidityClob: z.union([z.string(), z.number()]).nullable().optional(),
  volume: z.union([z.string(), z.number()]).nullable().optional(),
  volume24hr: z.union([z.string(), z.number()]).nullable().optional(),
  volume1wk: z.union([z.string(), z.number()]).nullable().optional(),
  volume1mo: z.union([z.string(), z.number()]).nullable().optional(),
  volume1yr: z.union([z.string(), z.number()]).nullable().optional(),
  oneDayPriceChange: z.union([z.string(), z.number()]).nullable().optional(),
  events: z
    .array(
      z.object({
        slug: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const gammaEventSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  volume: z.union([z.string(), z.number()]).nullable().optional(),
  volume24hr: z.union([z.string(), z.number()]).nullable().optional(),
  volume1wk: z.union([z.string(), z.number()]).nullable().optional(),
  volume1mo: z.union([z.string(), z.number()]).nullable().optional(),
  volume1yr: z.union([z.string(), z.number()]).nullable().optional(),
  liquidity: z.union([z.string(), z.number()]).nullable().optional(),
  markets: z.array(gammaMarketSchema).optional(),
});

const gammaMarketListSchema = z.array(gammaMarketSchema);
const gammaEventListSchema = z.array(gammaEventSchema);

type GammaMarket = z.infer<typeof gammaMarketSchema>;
type GammaEvent = z.infer<typeof gammaEventSchema>;

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
    const eventMarkets = await this.listMarketsFromEvents();

    if (eventMarkets.length > 0) {
      return eventMarkets;
    }

    return this.listMarketsDirectly();
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

  private async listMarketsFromEvents() {
    const markets = new Map<string, ProviderMarketInput>();
    const pageSize = Math.min(100, this.listLimit);

    for (let offset = 0; markets.size < this.listLimit; offset += pageSize) {
      const url = this.buildUrl("/events", {
        active: "true",
        closed: "false",
        archived: "false",
        limit: String(pageSize),
        offset: String(offset),
        order: "volume_24hr",
        ascending: "false",
      });
      const payload = await this.fetchJson(url);
      const parsed = gammaEventListSchema.safeParse(payload);

      if (!parsed.success) {
        throw new PolymarketProviderError(
          "Polymarket event list response did not match expected shape",
          { cause: parsed.error },
        );
      }

      if (parsed.data.length === 0) {
        break;
      }

      for (const event of parsed.data) {
        for (const market of event.markets ?? []) {
          const mapped = mapGammaMarket(market, event);

          if (!isTradableMarket(mapped)) {
            continue;
          }

          markets.set(mapped.externalMarketId, mapped);

          if (markets.size >= this.listLimit) {
            break;
          }
        }

        if (markets.size >= this.listLimit) {
          break;
        }
      }

      if (parsed.data.length < pageSize) {
        break;
      }
    }

    return Array.from(markets.values());
  }

  private async listMarketsDirectly() {
    const url = this.buildUrl("/markets", {
      active: "true",
      closed: "false",
      limit: String(this.listLimit),
      order: "volume_24hr",
      ascending: "false",
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

    return parsed.data.map((market) => mapGammaMarket(market)).filter(isTradableMarket);
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

export function mapGammaMarket(market: GammaMarket, event?: GammaEvent): ProviderMarketInput {
  const [yesTokenId, noTokenId] = parseTokenIds(market.clobTokenIds);
  const slug = market.slug ?? event?.slug ?? null;
  const volume24hr = firstDefined(market.volume24hr, event?.volume24hr);
  const volume1wk = firstDefined(market.volume1wk, event?.volume1wk);
  const volume1mo = firstDefined(market.volume1mo, event?.volume1mo);
  const volume1yr = firstDefined(market.volume1yr, event?.volume1yr);
  const totalVolume = firstDefined(market.volume, event?.volume);
  const liquidity = firstDefined(market.liquidityClob, market.liquidity, event?.liquidity);
  const metadata = buildMarketMetadata({
    liquidity,
    oneDayPriceChange: market.oneDayPriceChange,
    totalVolume,
    volume1mo,
    volume1wk,
    volume1yr,
    volume24hr,
  });

  return {
    externalMarketId: market.id,
    source: MarketSource.POLYMARKET,
    title: market.question,
    description: market.description ?? null,
    category: getMarketCategory(market, event),
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
    providerMetadata: metadata,
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

function firstDefined<TValue>(...values: Array<TValue | null | undefined>) {
  return values.find((value) => value !== null && typeof value !== "undefined") ?? null;
}

function getMarketCategory(market: GammaMarket, event?: GammaEvent) {
  return market.category ?? event?.title ?? market.events?.[0]?.title ?? null;
}

function isTradableMarket(market: ProviderMarketInput) {
  return market.status === MarketStatus.ACTIVE && Boolean(market.yesTokenId);
}

function buildMarketMetadata(input: {
  liquidity: string | number | null;
  oneDayPriceChange: string | number | null | undefined;
  totalVolume: string | number | null;
  volume1mo: string | number | null;
  volume1wk: string | number | null;
  volume1yr: string | number | null;
  volume24hr: string | number | null;
}) {
  const metadata = {
    liquidity: normalizeNumericString(input.liquidity),
    oneDayPriceChange: normalizeNumericString(input.oneDayPriceChange),
    totalVolume: normalizeNumericString(input.totalVolume),
    volume1mo: normalizeNumericString(input.volume1mo),
    volume1wk: normalizeNumericString(input.volume1wk),
    volume1yr: normalizeNumericString(input.volume1yr),
    volume24hr: normalizeNumericString(input.volume24hr),
  };

  return JSON.stringify(metadata);
}

function normalizeNumericString(value: string | number | null | undefined) {
  if (value === null || typeof value === "undefined") return null;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? String(parsed) : null;
}
