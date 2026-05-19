import type { Market, MarketSource, Prisma } from "@prisma/client";

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
  slug?: string | null;
  conditionId?: string | null;
  questionId?: string | null;
  orderBookEnabled?: boolean;
  acceptingOrders?: boolean;
  orderPriceMinTickSize?: Prisma.Decimal | string | number | null;
  orderMinSize?: Prisma.Decimal | string | number | null;
  lastTradePrice?: Prisma.Decimal | string | number | null;
  bestBid?: Prisma.Decimal | string | number | null;
  bestAsk?: Prisma.Decimal | string | number | null;
};

export type MarketProvider = {
  readonly source: MarketSource;
  listMarkets(): Promise<ProviderMarketInput[]>;
  getMarketById(externalMarketId: string): Promise<ProviderMarketInput | null>;
  syncMarket(externalMarketId: string): Promise<ProviderMarketInput | null>;
};
