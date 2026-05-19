import type { Market, MarketSource } from "@prisma/client";

export type ProviderMarketInput = {
  externalMarketId: string;
  source: MarketSource;
  title: string;
  description?: string | null;
  category?: string | null;
  status: Market["status"];
  resolutionDate?: Date | null;
  externalUrl?: string | null;
  yesTokenId?: string | null;
  noTokenId?: string | null;
};

export type MarketProvider = {
  readonly source: MarketSource;
  listMarkets(): Promise<ProviderMarketInput[]>;
  getMarketById(externalMarketId: string): Promise<ProviderMarketInput | null>;
  syncMarket(externalMarketId: string): Promise<Market | null>;
};
