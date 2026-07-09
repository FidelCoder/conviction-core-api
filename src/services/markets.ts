import type { Market, Prisma } from "@prisma/client";
import { MarketSource, MarketStatus } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import type { MarketProvider, ProviderMarketInput } from "./market-provider.js";

export type MarketListOptions = {
  limit?: number;
  search?: string;
  status?: Market["status"];
};

export type NormalizedMarket = {
  id: string;
  externalMarketId: string;
  source: Market["source"];
  title: string;
  description: string | null;
  category: string | null;
  status: Market["status"];
  resolutionDate: string | null;
  externalUrl: string | null;
  yesTokenId: string | null;
  noTokenId: string | null;
  slug: string | null;
  conditionId: string | null;
  questionId: string | null;
  orderBookEnabled: boolean;
  acceptingOrders: boolean;
  orderPriceMinTickSize: string | null;
  orderMinSize: string | null;
  lastTradePrice: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  liquidity: string | null;
  providerMetadata: MarketProviderMetadata;
  syncedAt: string | null;
  volume1mo: string | null;
  volume1wk: string | null;
  volume1yr: string | null;
  volume24hr: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketProviderMetadata = {
  discoveryRegion?: string | null;
  discoveryTopics?: string[];
  eventSlug?: string | null;
  eventTitle?: string | null;
  groupItemTitle?: string | null;
  iconUrl?: string | null;
  imageUrl?: string | null;
  liquidity?: string | null;
  oneDayPriceChange?: string | null;
  primaryTag?: string | null;
  tagLabels?: string[];
  tagSlugs?: string[];
  totalVolume?: string | null;
  volume1mo?: string | null;
  volume1wk?: string | null;
  volume1yr?: string | null;
  volume24hr?: string | null;
};

export type MarketHistoryRange = "1h" | "1w" | "1m" | "1y";

export type MarketCandle = {
  close: number;
  high: number;
  low: number;
  open: number;
  timestamp: string;
  volume: number | null;
};

export type MarketHistoryResult = {
  candles: MarketCandle[];
  marketId: string;
  range: MarketHistoryRange;
  source: "CONVICTION_PROVIDER_HISTORY" | "CONVICTION_SNAPSHOT";
  status: "ready" | "snapshot_only" | "empty";
};

export type MarketSyncResult = {
  source: Market["source"];
  requested: number;
  retired: number;
  synced: number;
  marketIds: string[];
};

export async function listMarkets(options: MarketListOptions = {}) {
  const markets = await prisma.market.findMany({
    where: buildMarketListWhere(options),
    orderBy: [{ syncedAt: "desc" }, { createdAt: "desc" }],
    take: options.limit,
  });

  return markets.map(normalizeMarket).sort(compareNormalizedMarkets);
}

export async function getMarketById(id: string) {
  const market = await prisma.market.findUnique({
    where: { id },
  });

  return market ? normalizeMarket(market) : null;
}

export async function getMarketHistory(
  id: string,
  range: MarketHistoryRange,
): Promise<MarketHistoryResult | null> {
  const market = await prisma.market.findUnique({ where: { id } });

  if (!market) {
    return null;
  }

  const snapshotCandles = buildSnapshotCandles(market);

  if (market.source !== MarketSource.POLYMARKET || !market.yesTokenId) {
    return {
      candles: snapshotCandles,
      marketId: market.id,
      range,
      source: "CONVICTION_SNAPSHOT",
      status: snapshotCandles.length > 0 ? "snapshot_only" : "empty",
    };
  }

  try {
    const points = await fetchPolymarketPriceHistory(market.yesTokenId, range);
    const candles = pointsToCandles(points);

    if (candles.length > 0) {
      return {
        candles,
        marketId: market.id,
        range,
        source: "CONVICTION_PROVIDER_HISTORY",
        status: "ready",
      };
    }
  } catch {
    // Keep the API responsive; callers can render the latest market snapshot.
  }

  return {
    candles: snapshotCandles,
    marketId: market.id,
    range,
    source: "CONVICTION_SNAPSHOT",
    status: snapshotCandles.length > 0 ? "snapshot_only" : "empty",
  };
}

export async function syncMarketsFromProvider(provider: MarketProvider): Promise<MarketSyncResult> {
  const syncStartedAt = new Date();
  const providerMarkets = await provider.listMarkets();
  const activeProviderMarkets = providerMarkets.filter(isProviderMarketListable);
  const marketIds: string[] = [];

  for (const providerMarket of activeProviderMarkets) {
    const market = await upsertProviderMarket(providerMarket);
    marketIds.push(market.id);
  }

  const retired = await retireInactiveProviderMarkets(
    provider.source,
    activeProviderMarkets.map((market) => market.externalMarketId),
    syncStartedAt,
  );

  return {
    source: provider.source,
    requested: providerMarkets.length,
    retired,
    synced: marketIds.length,
    marketIds,
  };
}

export async function syncMarketFromProvider(
  provider: MarketProvider,
  externalMarketId: string,
): Promise<NormalizedMarket | null> {
  const providerMarket = await provider.getMarketById(externalMarketId);

  if (!providerMarket) {
    return null;
  }

  const market = await upsertProviderMarket(providerMarket);

  return normalizeMarket(market);
}

export function normalizeMarket(market: Market): NormalizedMarket {
  const metadata = parseProviderMetadata(market.providerMetadata);

  return {
    id: market.id,
    externalMarketId: market.externalMarketId,
    source: market.source,
    title: market.title,
    description: market.description,
    category: market.category,
    status: market.status,
    resolutionDate: market.resolutionDate?.toISOString() ?? null,
    externalUrl: market.externalUrl,
    yesTokenId: market.yesTokenId,
    noTokenId: market.noTokenId,
    slug: market.slug,
    conditionId: market.conditionId,
    questionId: market.questionId,
    orderBookEnabled: market.orderBookEnabled,
    acceptingOrders: market.acceptingOrders,
    orderPriceMinTickSize: market.orderPriceMinTickSize?.toString() ?? null,
    orderMinSize: market.orderMinSize?.toString() ?? null,
    lastTradePrice: market.lastTradePrice?.toString() ?? null,
    bestBid: market.bestBid?.toString() ?? null,
    bestAsk: market.bestAsk?.toString() ?? null,
    liquidity: metadata.liquidity ?? null,
    providerMetadata: metadata,
    syncedAt: market.syncedAt?.toISOString() ?? null,
    volume1mo: metadata.volume1mo ?? null,
    volume1wk: metadata.volume1wk ?? null,
    volume1yr: metadata.volume1yr ?? null,
    volume24hr: metadata.volume24hr ?? null,
    createdAt: market.createdAt.toISOString(),
    updatedAt: market.updatedAt.toISOString(),
  };
}

async function upsertProviderMarket(providerMarket: ProviderMarketInput) {
  const syncedAt = new Date();

  const marketData = {
    ...providerMarket,
    orderBookEnabled: providerMarket.orderBookEnabled ?? false,
    acceptingOrders: providerMarket.acceptingOrders ?? false,
    orderPriceMinTickSize: normalizeOptionalDecimalString(providerMarket.orderPriceMinTickSize),
    orderMinSize: normalizeOptionalDecimalString(providerMarket.orderMinSize),
    lastTradePrice: normalizeOptionalDecimalString(providerMarket.lastTradePrice),
    bestBid: normalizeOptionalDecimalString(providerMarket.bestBid),
    bestAsk: normalizeOptionalDecimalString(providerMarket.bestAsk),
    providerMetadata: providerMarket.providerMetadata ?? null,
    syncedAt,
  };

  const existingMarket = await prisma.market.findUnique({
    where: {
      source_externalMarketId: {
        source: providerMarket.source,
        externalMarketId: providerMarket.externalMarketId,
      },
    },
  });

  if (existingMarket) {
    return prisma.market.update({
      where: { id: existingMarket.id },
      data: marketData,
    });
  }

  try {
    return await prisma.market.create({ data: marketData });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const market = await prisma.market.findUnique({
      where: {
        source_externalMarketId: {
          source: providerMarket.source,
          externalMarketId: providerMarket.externalMarketId,
        },
      },
    });

    if (!market) {
      throw error;
    }

    return prisma.market.update({
      where: { id: market.id },
      data: marketData,
    });
  }
}

async function retireInactiveProviderMarkets(
  source: MarketSource,
  activeExternalMarketIds: string[],
  now: Date,
) {
  const retirementFilters: Prisma.MarketWhereInput[] = [{ resolutionDate: { lte: now } }];

  if (activeExternalMarketIds.length > 0) {
    retirementFilters.push({ externalMarketId: { notIn: activeExternalMarketIds } });
  }

  const result = await prisma.market.updateMany({
    where: {
      source,
      status: MarketStatus.ACTIVE,
      OR: retirementFilters,
    },
    data: {
      acceptingOrders: false,
      status: MarketStatus.CLOSED,
    },
  });

  return result.count;
}

function isProviderMarketListable(providerMarket: ProviderMarketInput) {
  if (providerMarket.status !== MarketStatus.ACTIVE) return false;
  if (!providerMarket.yesTokenId) return false;
  if (providerMarket.resolutionDate && providerMarket.resolutionDate.getTime() <= Date.now())
    return false;

  return true;
}

function normalizeOptionalDecimalString(value: string | number | null | undefined) {
  if (value === null || typeof value === "undefined") {
    return null;
  }

  const normalized = String(value).trim();

  return normalized.length > 0 ? normalized : null;
}

function isUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

type HistoryPoint = {
  p?: number;
  t?: number;
};

const polymarketClobUrl = "https://clob.polymarket.com";
const historyTimeoutMs = 6500;

function buildMarketListWhere(options: MarketListOptions): Prisma.MarketWhereInput {
  const filters: Prisma.MarketWhereInput[] = [];

  if (options.search?.trim()) {
    filters.push(buildSearchWhere(options.search));
  }

  if (options.status === MarketStatus.ACTIVE) {
    filters.push(buildActiveMarketWhere(new Date()));
  }

  return {
    status: options.status,
    ...(filters.length > 0 ? { AND: filters } : {}),
  };
}

function buildActiveMarketWhere(now: Date): Prisma.MarketWhereInput {
  return {
    OR: [{ resolutionDate: null }, { resolutionDate: { gt: now } }],
  };
}

function buildSearchWhere(search: string): Prisma.MarketWhereInput {
  const query = search.trim();

  if (!query) {
    return {};
  }

  return {
    OR: [
      { title: { contains: query, mode: "insensitive" as const } },
      { description: { contains: query, mode: "insensitive" as const } },
      { category: { contains: query, mode: "insensitive" as const } },
      { providerMetadata: { contains: query, mode: "insensitive" as const } },
    ],
  };
}

function compareNormalizedMarkets(left: NormalizedMarket, right: NormalizedMarket) {
  const rightScore = getMarketSortScore(right);
  const leftScore = getMarketSortScore(left);

  if (rightScore !== leftScore) {
    return rightScore - leftScore;
  }

  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
}

function getMarketSortScore(market: NormalizedMarket) {
  const volume = Number(
    market.volume24hr ??
      market.volume1wk ??
      market.volume1mo ??
      market.providerMetadata.totalVolume ??
      0,
  );
  const liquidity = Number(market.liquidity ?? 0);
  const liveBonus = market.status === "ACTIVE" ? 1_000_000 : 0;
  const discoveryBonus = getDiscoverySortBonus(market);

  return liveBonus + discoveryBonus + volume + liquidity / 100;
}

function getDiscoverySortBonus(market: NormalizedMarket) {
  const region = market.providerMetadata.discoveryRegion;
  const topics = new Set(market.providerMetadata.discoveryTopics ?? []);
  let bonus = 0;

  if (region === "Africa") bonus += 75_000;
  if (region === "Global") bonus += 25_000;
  if (topics.has("African Football")) bonus += 85_000;
  if (topics.has("World Cup")) bonus += 45_000;
  if (topics.has("Football")) bonus += 30_000;
  if (topics.has("Cricket") || topics.has("Rugby")) bonus += 20_000;

  return bonus;
}

function parseProviderMetadata(value: string | null): MarketProviderMetadata {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;

    return {
      discoveryRegion: normalizeMetadataString(parsed.discoveryRegion),
      discoveryTopics: normalizeMetadataStringArray(parsed.discoveryTopics),
      eventSlug: normalizeMetadataString(parsed.eventSlug),
      eventTitle: normalizeMetadataString(parsed.eventTitle),
      groupItemTitle: normalizeMetadataString(parsed.groupItemTitle),
      iconUrl: normalizeMetadataString(parsed.iconUrl),
      imageUrl: normalizeMetadataString(parsed.imageUrl),
      liquidity: normalizeMetadataString(parsed.liquidity),
      oneDayPriceChange: normalizeMetadataString(parsed.oneDayPriceChange),
      primaryTag: normalizeMetadataString(parsed.primaryTag),
      tagLabels: normalizeMetadataStringArray(parsed.tagLabels),
      tagSlugs: normalizeMetadataStringArray(parsed.tagSlugs),
      totalVolume: normalizeMetadataString(parsed.totalVolume),
      volume1mo: normalizeMetadataString(parsed.volume1mo),
      volume1wk: normalizeMetadataString(parsed.volume1wk),
      volume1yr: normalizeMetadataString(parsed.volume1yr),
      volume24hr: normalizeMetadataString(parsed.volume24hr),
    };
  } catch {
    return {};
  }
}

function normalizeMetadataString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeMetadataStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

async function fetchPolymarketPriceHistory(tokenId: string, range: MarketHistoryRange) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), historyTimeoutMs);
  const settings = getHistoryRangeSettings(range);
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - settings.seconds;
  const url = new URL("/prices-history", polymarketClobUrl);

  url.searchParams.set("market", tokenId);
  url.searchParams.set("startTs", String(startTs));
  url.searchParams.set("endTs", String(endTs));
  url.searchParams.set("interval", settings.interval);
  url.searchParams.set("fidelity", settings.fidelity);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      return [];
    }

    const body = (await response.json()) as { history?: HistoryPoint[] };

    return Array.isArray(body.history) ? body.history : [];
  } finally {
    clearTimeout(timeout);
  }
}

function getHistoryRangeSettings(range: MarketHistoryRange) {
  if (range === "1h") return { fidelity: "1", interval: "1m", seconds: 60 * 60 };
  if (range === "1m") return { fidelity: "720", interval: "1d", seconds: 60 * 60 * 24 * 30 };
  if (range === "1y") return { fidelity: "10080", interval: "1w", seconds: 60 * 60 * 24 * 365 };

  return { fidelity: "60", interval: "1h", seconds: 60 * 60 * 24 * 7 };
}

function pointsToCandles(points: HistoryPoint[]): MarketCandle[] {
  return points
    .filter(
      (point): point is { p: number; t: number } =>
        Number.isFinite(point.p) && Number.isFinite(point.t),
    )
    .map((point, index, filteredPoints) => {
      const previous = filteredPoints[index - 1]?.p ?? point.p;
      const open = clampProbability(previous * 100);
      const close = clampProbability(point.p * 100);

      return {
        close,
        high: Math.max(open, close),
        low: Math.min(open, close),
        open,
        timestamp: new Date(point.t * 1000).toISOString(),
        volume: null,
      };
    });
}

function buildSnapshotCandles(market: Market): MarketCandle[] {
  const bestBid = parseProbability(market.bestBid?.toString());
  const bestAsk = parseProbability(market.bestAsk?.toString());
  const lastTrade = parseProbability(market.lastTradePrice?.toString());
  const midpoint = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const close = lastTrade ?? midpoint ?? bestAsk ?? bestBid;

  if (close === null) return [];

  const open = midpoint ?? close;
  const high = Math.max(open, close, bestAsk ?? close);
  const low = Math.min(open, close, bestBid ?? close);

  return [
    {
      close: clampProbability(close),
      high: clampProbability(high),
      low: clampProbability(low),
      open: clampProbability(open),
      timestamp: (market.syncedAt ?? market.updatedAt).toISOString(),
      volume: null,
    },
  ];
}

function parseProbability(value: string | null | undefined) {
  if (!value) return null;
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) return null;

  return numericValue <= 1 ? numericValue * 100 : numericValue;
}

function clampProbability(value: number) {
  return Math.max(0.1, Math.min(99.9, value));
}
