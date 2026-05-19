import type { Market } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

export type MarketListOptions = {
  status?: Market["status"];
};

export async function listMarkets(options: MarketListOptions = {}) {
  return prisma.market.findMany({
    where: {
      status: options.status,
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}

export async function getMarketById(id: string) {
  return prisma.market.findUnique({
    where: { id },
  });
}
