import { prisma } from "../lib/prisma.js";

export type UpsertUserPreferenceInput = {
  userId: string;
  topics?: string[];
  regions?: string[];
  sports?: string[];
  mediaTypes?: string[];
  newsIntervalMinutes?: number;
  notifyInActivity?: boolean;
};

const DEFAULT_TOPICS = ["Sports", "World Cup", "Crypto", "Politics", "Geopolitics", "Finance", "Tech", "Culture", "Weather", "Breaking"];
const DEFAULT_REGIONS = ["Global"];
const DEFAULT_MEDIA_TYPES = ["image", "video"];

export async function getUserPreference(userId: string) {
  const existing = await prisma.userPreference.findUnique({ where: { userId } });
  return existing ?? createDefaultPreference(userId);
}

export async function upsertUserPreference(input: UpsertUserPreferenceInput) {
  await ensureUser(input.userId);

  const data = {
    topics: sanitizeList(input.topics, DEFAULT_TOPICS),
    regions: sanitizeList(input.regions, DEFAULT_REGIONS),
    sports: sanitizeList(input.sports, []),
    mediaTypes: sanitizeList(input.mediaTypes, DEFAULT_MEDIA_TYPES),
    newsIntervalMinutes: normalizeInterval(input.newsIntervalMinutes),
    notifyInActivity: input.notifyInActivity ?? true,
  };

  return prisma.userPreference.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, ...data },
    update: data,
  });
}

async function createDefaultPreference(userId: string) {
  await ensureUser(userId);
  return prisma.userPreference.create({
    data: {
      userId,
      topics: DEFAULT_TOPICS,
      regions: DEFAULT_REGIONS,
      sports: [],
      mediaTypes: DEFAULT_MEDIA_TYPES,
      newsIntervalMinutes: 20,
      notifyInActivity: true,
    },
  });
}

async function ensureUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error("User not found");
  }
}

function sanitizeList(input: string[] | undefined, fallback: string[]) {
  const values = (input ?? fallback)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 24);

  return Array.from(new Set(values));
}

function normalizeInterval(value: number | undefined) {
  if (!Number.isFinite(value)) return 20;
  return Math.max(10, Math.min(180, Math.round(value!)));
}
