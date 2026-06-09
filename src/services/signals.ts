import type { TradeSignal } from "@prisma/client";
import { TradeSignalSide, TradeSignalSource } from "@prisma/client";

import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

export type CreateTradeSignalInput = {
  traderProfileId: string;
  marketId: string;
  side: TradeSignalSide;
  thesis: string;
  convictionLevel?: number | null;
  source: TradeSignalSource;
};

export type NormalizedTradeSignal = {
  id: string;
  traderProfileId: string;
  marketId: string;
  side: TradeSignal["side"];
  thesis: string;
  convictionLevel: number | null;
  source: TradeSignal["source"];
  status: TradeSignal["status"];
  createdAt: string;
  updatedAt: string;
};

export async function createTradeSignal(input: CreateTradeSignalInput) {
  const [traderProfile, market] = await Promise.all([
    prisma.traderProfile.findUnique({ where: { id: input.traderProfileId } }),
    prisma.market.findUnique({ where: { id: input.marketId } }),
  ]);

  if (!traderProfile) {
    throw new AppError("Trader profile not found", {
      code: "TRADER_PROFILE_NOT_FOUND",
      statusCode: 404,
    });
  }

  if (!market) {
    throw new AppError("Market not found", {
      code: "MARKET_NOT_FOUND",
      statusCode: 404,
    });
  }

  const signal = await prisma.tradeSignal.create({
    data: {
      traderProfileId: input.traderProfileId,
      marketId: input.marketId,
      side: input.side,
      thesis: input.thesis,
      convictionLevel: input.convictionLevel ?? null,
      source: input.source,
    },
  });

  return normalizeTradeSignal(signal);
}

export async function getTradeSignalById(id: string) {
  const signal = await prisma.tradeSignal.findUnique({
    where: { id },
  });

  return signal ? normalizeTradeSignal(signal) : null;
}

export async function listRecentTradeSignals(limit = 50) {
  const signals = await prisma.tradeSignal.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
  });

  return signals.map(normalizeTradeSignal);
}

export async function listMarketTradeSignals(marketId: string) {
  const market = await prisma.market.findUnique({ where: { id: marketId } });

  if (!market) {
    throw new AppError("Market not found", {
      code: "MARKET_NOT_FOUND",
      statusCode: 404,
    });
  }

  const signals = await prisma.tradeSignal.findMany({
    where: { marketId },
    orderBy: { createdAt: "desc" },
  });

  return signals.map(normalizeTradeSignal);
}

export async function listTraderProfileTradeSignals(traderProfileId: string) {
  const traderProfile = await prisma.traderProfile.findUnique({ where: { id: traderProfileId } });

  if (!traderProfile) {
    throw new AppError("Trader profile not found", {
      code: "TRADER_PROFILE_NOT_FOUND",
      statusCode: 404,
    });
  }

  const signals = await prisma.tradeSignal.findMany({
    where: { traderProfileId },
    orderBy: { createdAt: "desc" },
  });

  return signals.map(normalizeTradeSignal);
}

export function normalizeTradeSignal(signal: TradeSignal): NormalizedTradeSignal {
  return {
    id: signal.id,
    traderProfileId: signal.traderProfileId,
    marketId: signal.marketId,
    side: signal.side,
    thesis: signal.thesis,
    convictionLevel: signal.convictionLevel,
    source: signal.source,
    status: signal.status,
    createdAt: signal.createdAt.toISOString(),
    updatedAt: signal.updatedAt.toISOString(),
  };
}
