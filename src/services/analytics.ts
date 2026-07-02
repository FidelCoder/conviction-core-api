import { AuthProvider, Prisma, UsageEventType } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

type RecordUsageEventInput = {
  area?: string | null;
  authProvider?: AuthProvider | null;
  clientSessionId: string;
  label?: string | null;
  metadata?: unknown;
  path?: string | null;
  referrer?: string | null;
  socialAccountId?: string | null;
  source?: string | null;
  type: UsageEventType;
  userAgent?: string | null;
  userId?: string | null;
  value?: number | null;
};


export async function recordUsageEvent(input: RecordUsageEventInput) {
  const now = new Date();
  const area = normalizeArea(input.area, input.path);
  const authProvider = input.authProvider ?? AuthProvider.UNKNOWN;
  const existingSession = await prisma.usageSession.findUnique({
    where: { clientSessionId: input.clientSessionId },
    select: { id: true },
  });
  const isNewSession = !existingSession;
  const session = await prisma.usageSession.upsert({
    where: { clientSessionId: input.clientSessionId },
    create: {
      authProvider,
      clientSessionId: input.clientSessionId,
      currentPath: normalizeNullableString(input.path),
      entryPath: normalizeNullableString(input.path),
      eventCount: 1,
      lastSeenAt: now,
      referrer: normalizeNullableString(input.referrer),
      socialAccountId: normalizeNullableString(input.socialAccountId),
      source: normalizeNullableString(input.source) ?? "WEB_APP",
      startedAt: now,
      userAgent: normalizeNullableString(input.userAgent),
      userId: normalizeNullableString(input.userId),
    },
    update: {
      authProvider,
      currentPath: normalizeNullableString(input.path),
      durationSeconds: { increment: getDurationIncrement(input.type) },
      eventCount: { increment: 1 },
      lastSeenAt: now,
      socialAccountId: normalizeNullableString(input.socialAccountId),
      userId: normalizeNullableString(input.userId),
    },
  });

  const event = await prisma.usageEvent.create({
    data: {
      area,
      clientSessionId: input.clientSessionId,
      label: normalizeNullableString(input.label),
      metadata: toJsonValue(input.metadata),
      path: normalizeNullableString(input.path),
      sessionId: session.id,
      socialAccountId: normalizeNullableString(input.socialAccountId),
      type: input.type,
      userId: normalizeNullableString(input.userId),
      value: typeof input.value === "number" && Number.isFinite(input.value) ? input.value : null,
    },
  });

  if (input.userId || input.socialAccountId) {
    await touchUserUsage({
      authProvider,
      incrementSession: isNewSession,
      socialAccountId: input.socialAccountId,
      userId: input.userId,
      source: input.source,
    });
  }

  return {
    eventId: event.id,
    sessionId: session.id,
  };
}

export async function getAdminUsageAnalytics() {
  const [
    users,
    socialAccounts,
    traderProfiles,
    sessions,
    events,
    signals,
    positions,
    supportTickets,
  ] = await Promise.all([
    prisma.user.findMany({
      include: {
        socialAccounts: true,
        traderProfile: true,
        _count: {
          select: {
            positions: true,
            pulsePosts: true,
          },
        },
      },
    }),
    prisma.socialAccount.findMany(),
    prisma.traderProfile.findMany(),
    prisma.usageSession.findMany({ orderBy: { lastSeenAt: "desc" }, take: 500 }),
    prisma.usageEvent.findMany({ orderBy: { createdAt: "desc" }, take: 1000 }),
    prisma.tradeSignal.count(),
    prisma.position.count(),
    prisma.supportTicket.count(),
  ]);

  const realUsers = users.filter((user) => isRealUser(user));
  const fallbackProfiles = traderProfiles.filter((profile) => !isClaimedProfileHandle(profile.handle));
  const noProfileUsers = users.filter((user) => !user.traderProfile);
  const emailUsers = users.filter((user) => hasEmail(user.email));
  const active24h = countActiveUsers(users, 24);
  const active7d = countActiveUsers(users, 24 * 7);

  return {
    generatedAt: new Date().toISOString(),
    users: {
      rawAccounts: users.length,
      realUsers: realUsers.length,
      walletLinked: users.filter((user) => user.socialAccounts.some((account) => account.platform === "WEB")).length,
      evmWallets: users.filter((user) => user.socialAccounts.some((account) => account.platform === "WEB" && /^0x[a-f0-9]{40}$/i.test(account.platformUserId))).length,
      tonWallets: users.filter((user) => user.socialAccounts.some((account) => account.platform === "WEB" && account.platformUserId.startsWith("ton:"))).length,
      claimedViction: users.filter((user) => isClaimedProfileHandle(user.traderProfile?.handle)).length,
      fallbackProfiles: fallbackProfiles.length,
      noProfile: noProfileUsers.length,
      emailConfigured: emailUsers.length,
      active24h,
      active7d,
      internalMarked: users.filter((user) => user.isInternal).length,
    },
    acquisition: countBy(socialAccounts, (account) => account.authProvider),
    engagement: {
      sessions: sessions.length,
      trackedEvents: events.length,
      avgSessionSeconds: average(sessions.map((session) => session.durationSeconds)),
      medianSessionSeconds: median(sessions.map((session) => session.durationSeconds)),
      avgEventsPerSession: average(sessions.map((session) => session.eventCount)),
      signals,
      positions,
      supportTickets,
    },
    productUsage: {
      topAreas: topEntries(countBy(events, (event) => event.area), 12),
      topActions: topEntries(countBy(events, (event) => event.type), 12),
      topPaths: topEntries(countBy(events, (event) => event.path ?? "unknown"), 12),
    },
    recentSessions: sessions.slice(0, 20).map((session) => ({
      id: session.id,
      authProvider: session.authProvider,
      currentPath: session.currentPath,
      durationSeconds: session.durationSeconds,
      eventCount: session.eventCount,
      lastSeenAt: session.lastSeenAt.toISOString(),
      source: session.source,
      userId: session.userId,
    })),
  };
}

async function touchUserUsage(input: {
  authProvider: AuthProvider;
  incrementSession: boolean;
  socialAccountId?: string | null;
  source?: string | null;
  userId?: string | null;
}) {
  const now = new Date();

  if (input.userId) {
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { firstSeenAt: true } }).catch(() => null);
    await prisma.user.update({
      where: { id: input.userId },
      data: {
        firstSeenAt: user?.firstSeenAt ?? now,
        lastSeenAt: now,
        ...(input.incrementSession ? { sessionCount: { increment: 1 } } : {}),
        ...(input.source ? { acquisitionSource: input.source } : {}),
      },
    }).catch(() => null);
  }

  if (input.socialAccountId) {
    const account = await prisma.socialAccount.findUnique({ where: { id: input.socialAccountId }, select: { firstSeenAt: true } }).catch(() => null);
    await prisma.socialAccount.update({
      where: { id: input.socialAccountId },
      data: {
        authProvider: input.authProvider,
        firstSeenAt: account?.firstSeenAt ?? now,
        lastSeenAt: now,
        ...(input.incrementSession ? { sessionCount: { increment: 1 } } : {}),
        ...(input.source ? { source: input.source } : {}),
      },
    }).catch(() => null);
  }
}

function isRealUser(user: { isInternal?: boolean; traderProfile?: { handle: string } | null }) {
  return !user.isInternal && isClaimedProfileHandle(user.traderProfile?.handle);
}

function isClaimedProfileHandle(handle: string | null | undefined) {
  const normalized = handle?.trim().toLowerCase() ?? "";
  if (!normalized.endsWith(".viction")) return false;
  if (generatedHandlePatterns.some((pattern) => pattern.test(normalized))) return false;
  return normalized.slice(0, -".viction".length).length >= 2;
}

const generatedHandlePatterns = [
  /^wallet[a-f0-9]{6,}\.viction$/i,
  /^trader[a-f0-9]{4,}\.viction$/i,
  /^user[a-f0-9]{4,}\.viction$/i,
  /^guest\.viction$/i,
  /^trader\.viction$/i,
  /^yourname\.viction$/i,
];

function normalizeArea(area: string | null | undefined, path: string | null | undefined) {
  const normalized = normalizeNullableString(area);
  if (normalized) return normalized.slice(0, 80);
  const cleanPath = normalizeNullableString(path) ?? "/";
  const segment = cleanPath.split("?")[0]?.split("/").filter(Boolean)[0];
  return segment || "home";
}

function normalizeNullableString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (typeof value === "undefined" || value === null) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

function getDurationIncrement(type: UsageEventType) {
  return type === UsageEventType.HEARTBEAT ? 15 : 0;
}

function hasEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase() ?? "";
  return normalized.includes("@") && normalized.includes(".");
}

function countActiveUsers(users: Array<{ lastSeenAt: Date | null }>, hours: number) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return users.filter((user) => user.lastSeenAt && user.lastSeenAt.getTime() >= cutoff).length;
}

function countBy<T>(items: T[], getKey: (item: T) => string | null | undefined) {
  const counts: Record<string, number> = {};
  items.forEach((item) => {
    const key = getKey(item) ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  });
  return counts;
}

function topEntries(counts: Record<string, number>, limit: number) {
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
}

function average(values: number[]) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return 0;
  return Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function median(values: number[]) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!finite.length) return 0;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[mid] : Math.round((finite[mid - 1] + finite[mid]) / 2);
}
