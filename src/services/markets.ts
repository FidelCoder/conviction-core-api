import type { Market } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import type { MarketProvider, ProviderMarketInput } from "./market-provider.js";

export type MarketListOptions = {
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
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketSyncResult = {
  source: Market["source"];
  requested: number;
  synced: number;
  marketIds: string[];
};

export async function listMarkets(options: MarketListOptions = {}) {
  const markets = await prisma.market.findMany({
    where: {
      status: options.status,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return markets.map(normalizeMarket);
}

export async function getMarketById(id: string) {
  const market = await prisma.market.findUnique({
    where: { id },
  });

  return market ? normalizeMarket(market) : null;
}

export async function syncMarketsFromProvider(provider: MarketProvider): Promise<MarketSyncResult> {
  const providerMarkets = await provider.listMarkets();
  const marketIds: string[] = [];

  for (const providerMarket of providerMarkets) {
    const market = await upsertProviderMarket(providerMarket);
    marketIds.push(market.id);
  }

  return {
    source: provider.source,
    requested: providerMarkets.length,
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
    syncedAt: market.syncedAt?.toISOString() ?? null,
    createdAt: market.createdAt.toISOString(),
    updatedAt: market.updatedAt.toISOString(),
  };
}

async function upsertProviderMarket(providerMarket: ProviderMarketInput) {
  const syncedAt = new Date();

  return prisma.market.upsert({
    where: {
      source_externalMarketId: {
        source: providerMarket.source,
        externalMarketId: providerMarket.externalMarketId,
      },
    },
    create: {
      ...providerMarket,
      orderBookEnabled: providerMarket.orderBookEnabled ?? false,
      acceptingOrders: providerMarket.acceptingOrders ?? false,
      syncedAt,
    },
    update: {
      ...providerMarket,
      orderBookEnabled: providerMarket.orderBookEnabled ?? false,
      acceptingOrders: providerMarket.acceptingOrders ?? false,
      syncedAt,
    },
  });
}
