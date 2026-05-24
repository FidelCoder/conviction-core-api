import { CopyTradeStatus, Prisma, type TraderProfile } from "@prisma/client";

import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

export type TraderStats = {
  traderProfileId: string;
  userId: string;
  handle: string;
  numberOfSignals: number;
  numberOfCopyIntents: number;
  copiedVolume: string;
  executedCopyIntentCount: number;
  executedCopiedVolume: string | null;
  realizedPnl: string | null;
};

export type LeaderboardEntry = TraderStats & {
  rank: number;
};

export async function getTraderProfileStats(traderProfileId: string): Promise<TraderStats> {
  const traderProfile = await prisma.traderProfile.findUnique({
    where: { id: traderProfileId },
  });

  if (!traderProfile) {
    throw new AppError("Trader profile not found", {
      code: "TRADER_PROFILE_NOT_FOUND",
      statusCode: 404,
    });
  }

  return buildTraderStats(traderProfile);
}

export async function listLeaderboard(limit = 25): Promise<LeaderboardEntry[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const traderProfiles = await prisma.traderProfile.findMany({
    orderBy: { createdAt: "asc" },
  });

  const stats = await Promise.all(traderProfiles.map(buildTraderStats));

  return stats
    .sort(compareTraderStats)
    .slice(0, safeLimit)
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));
}

async function buildTraderStats(traderProfile: TraderProfile): Promise<TraderStats> {
  const copyIntentWhere = {
    sourcePosition: {
      is: {
        userId: traderProfile.userId,
      },
    },
  };
  const executedCopyIntentWhere = {
    ...copyIntentWhere,
    status: CopyTradeStatus.EXECUTED,
  };

  const [numberOfSignals, copyIntentAggregate, executedCopyIntentAggregate] = await Promise.all([
    prisma.tradeSignal.count({
      where: { traderProfileId: traderProfile.id },
    }),
    prisma.copyTrade.aggregate({
      where: copyIntentWhere,
      _count: { _all: true },
      _sum: { requestedQuantity: true },
    }),
    prisma.copyTrade.aggregate({
      where: executedCopyIntentWhere,
      _count: { _all: true },
      _sum: { executedQuantity: true },
    }),
  ]);

  const executedCopyIntentCount = executedCopyIntentAggregate._count._all;

  return {
    traderProfileId: traderProfile.id,
    userId: traderProfile.userId,
    handle: traderProfile.handle,
    numberOfSignals,
    numberOfCopyIntents: copyIntentAggregate._count._all,
    copiedVolume: copyIntentAggregate._sum.requestedQuantity?.toString() ?? "0",
    executedCopyIntentCount,
    executedCopiedVolume:
      executedCopyIntentCount > 0
        ? (executedCopyIntentAggregate._sum.executedQuantity?.toString() ?? "0")
        : null,
    realizedPnl: null,
  };
}

function compareTraderStats(a: TraderStats, b: TraderStats) {
  const copyIntentDelta = b.numberOfCopyIntents - a.numberOfCopyIntents;

  if (copyIntentDelta !== 0) {
    return copyIntentDelta;
  }

  const copiedVolumeDelta = new Prisma.Decimal(b.copiedVolume).comparedTo(a.copiedVolume);

  if (copiedVolumeDelta !== 0) {
    return copiedVolumeDelta;
  }

  const signalDelta = b.numberOfSignals - a.numberOfSignals;

  if (signalDelta !== 0) {
    return signalDelta;
  }

  return a.handle.localeCompare(b.handle);
}
