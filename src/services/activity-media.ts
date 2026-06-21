import type { Prisma } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import { getUserPreference } from "./preferences.js";

export type CreateActivityMediaInput = {
  userId?: string | null;
  marketId?: string | null;
  kind: string;
  title: string;
  summary: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  mediaBrief?: unknown;
  source?: string;
};

export async function listActivityMediaFeed(options: { userId?: string | null; limit?: number }) {
  const limit = clampLimit(options.limit);

  if (options.userId) {
    const preference = await getUserPreference(options.userId);
    const topicTerms = [...preference.topics, ...preference.regions, ...preference.sports].map((value) => value.toLowerCase());
    const items = await prisma.activityMediaItem.findMany({
      where: { status: "PUBLISHED" },
      include: { market: true },
      orderBy: { createdAt: "desc" },
      take: Math.max(limit * 3, limit),
    });

    const ranked = items.sort((a, b) => scoreItem(b, topicTerms) - scoreItem(a, topicTerms));
    return ranked.slice(0, limit).map(normalizeActivityMediaItem);
  }

  const items = await prisma.activityMediaItem.findMany({
    where: { status: "PUBLISHED" },
    include: { market: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return items.map(normalizeActivityMediaItem);
}

type ActivityMediaItemWithMarket = Prisma.ActivityMediaItemGetPayload<{ include: { market: true } }>;

export async function createActivityMediaItem(input: CreateActivityMediaInput) {
  const item = await prisma.activityMediaItem.create({
    data: {
      userId: input.userId ?? null,
      marketId: input.marketId ?? null,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      imageUrl: input.imageUrl ?? null,
      videoUrl: input.videoUrl ?? null,
      mediaBrief: input.mediaBrief ? (input.mediaBrief as object) : undefined,
      source: input.source ?? "CONVICTION_AI",
    },
    include: { market: true },
  });

  return normalizeActivityMediaItem(item);
}

export async function generatePreferenceNewsFeed(userId: string, limit = 8) {
  const preference = await getUserPreference(userId);
  const terms = [...preference.topics, ...preference.regions, ...preference.sports].filter(Boolean);
  const markets = await prisma.market.findMany({
    where: {
      status: "ACTIVE",
      OR: terms.length > 0
        ? terms.flatMap((term) => [
            { title: { contains: term, mode: "insensitive" as const } },
            { description: { contains: term, mode: "insensitive" as const } },
            { category: { contains: term, mode: "insensitive" as const } },
            { providerMetadata: { contains: term, mode: "insensitive" as const } },
          ])
        : undefined,
    },
    orderBy: [{ syncedAt: "desc" }, { updatedAt: "desc" }],
    take: Math.max(1, Math.min(limit, 20)),
  });

  const created = [];
  for (const market of markets) {
    const summary = summarizeMarket(market.description, market.title);
    created.push(await createActivityMediaItem({
      userId,
      marketId: market.id,
      kind: "news",
      title: market.title,
      summary,
      imageUrl: "/api/miniapp-image?type=market&id=" + market.id,
      videoUrl: "/api/activity-video?marketId=" + market.id,
      mediaBrief: {
        headline: market.title,
        subline: market.category ?? "Prediction Market",
        cadenceMinutes: preference.newsIntervalMinutes,
        mediaTypes: preference.mediaTypes,
      },
      source: "CONVICTION_NEWS_ENGINE",
    }));
  }

  return created;
}

function normalizeActivityMediaItem(item: ActivityMediaItemWithMarket) {
  return {
    id: item.id,
    userId: item.userId ?? null,
    marketId: item.marketId ?? null,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    imageUrl: item.imageUrl ?? null,
    videoUrl: item.videoUrl ?? null,
    mediaBrief: item.mediaBrief ?? null,
    source: item.source,
    status: item.status,
    market: item.market ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function scoreItem(item: ActivityMediaItemWithMarket, terms: string[]) {
  if (terms.length === 0) return 0;
  const haystack = [item.title, item.summary, item.market?.title, item.market?.category, item.market?.providerMetadata]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function summarizeMarket(description: string | null, title: string) {
  const source = description?.replace(/\s+/g, " ").trim() || title;
  return source.length <= 220 ? source : source.slice(0, 219) + "...";
}

function clampLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(100, Math.round(value!)));
}
