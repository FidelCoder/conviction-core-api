import { OmnistonQuoteStatus, Prisma, SocialPlatform } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

export type RecordOmnistonQuoteEventInput = {
  userId?: string | null;
  platform?: SocialPlatform;
  platformUserId?: string | null;
  username?: string | null;
  source?: string;
  fromAsset: string;
  toAsset: string;
  amountUnits: string;
  status: OmnistonQuoteStatus;
  inputUnits?: string | null;
  outputUnits?: string | null;
  settlement?: string | null;
  resolverName?: string | null;
  quoteId?: string | null;
  gasBudget?: string | null;
  routeCount?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Prisma.InputJsonValue | null;
};

export async function recordOmnistonQuoteEvent(input: RecordOmnistonQuoteEventInput) {
  const event = await prisma.omnistonQuoteEvent.create({
    data: {
      userId: input.userId ?? undefined,
      platform: input.platform ?? SocialPlatform.TELEGRAM,
      platformUserId: input.platformUserId ?? undefined,
      username: input.username ?? undefined,
      source: input.source ?? "TELEGRAM_BOT",
      fromAsset: input.fromAsset,
      toAsset: input.toAsset,
      amountUnits: input.amountUnits,
      status: input.status,
      inputUnits: input.inputUnits ?? undefined,
      outputUnits: input.outputUnits ?? undefined,
      settlement: input.settlement ?? undefined,
      resolverName: input.resolverName ?? undefined,
      quoteId: input.quoteId ?? undefined,
      gasBudget: input.gasBudget ?? undefined,
      routeCount: input.routeCount ?? undefined,
      errorCode: input.errorCode ?? undefined,
      errorMessage: input.errorMessage ?? undefined,
      metadata: input.metadata ?? undefined,
    },
  });

  return serializeOmnistonQuoteEvent(event);
}

export async function listOmnistonQuoteEvents(limit = 50) {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const events = await prisma.omnistonQuoteEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: safeLimit,
  });

  return events.map(serializeOmnistonQuoteEvent);
}

export async function getOmnistonQuoteSummary() {
  const [total, uniqueUsers, statusCounts, pairs, recent] = await Promise.all([
    prisma.omnistonQuoteEvent.count(),
    prisma.omnistonQuoteEvent.findMany({
      distinct: ["platform", "platformUserId"],
      where: { platformUserId: { not: null } },
      select: { platform: true, platformUserId: true },
    }),
    prisma.omnistonQuoteEvent.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    prisma.omnistonQuoteEvent.groupBy({
      by: ["fromAsset", "toAsset"],
      _count: { _all: true },
    }),
    prisma.omnistonQuoteEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  return {
    total,
    uniqueTelegramUsers: uniqueUsers.length,
    byStatus: statusCounts.map((entry) => ({
      status: entry.status,
      count: entry._count._all,
    })),
    topPairs: pairs
      .sort((left, right) => right._count._all - left._count._all)
      .slice(0, 10)
      .map((entry) => ({
        fromAsset: entry.fromAsset,
        toAsset: entry.toAsset,
        count: entry._count._all,
      })),
    recent: recent.map(serializeOmnistonQuoteEvent),
  };
}

type OmnistonQuoteEventRecord = Awaited<ReturnType<typeof prisma.omnistonQuoteEvent.findFirst>>;

function serializeOmnistonQuoteEvent(event: NonNullable<OmnistonQuoteEventRecord>) {
  return {
    id: event.id,
    userId: event.userId,
    platform: event.platform,
    platformUserId: event.platformUserId,
    username: event.username,
    source: event.source,
    fromAsset: event.fromAsset,
    toAsset: event.toAsset,
    amountUnits: event.amountUnits,
    status: event.status,
    inputUnits: event.inputUnits,
    outputUnits: event.outputUnits,
    settlement: event.settlement,
    resolverName: event.resolverName,
    quoteId: event.quoteId,
    gasBudget: event.gasBudget,
    routeCount: event.routeCount,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
    metadata: event.metadata,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}
