import type {
  Market,
  SignalBookmark,
  SignalReaction,
  SignalReply,
  SocialAccount,
  TraderProfile,
  User,
} from "@prisma/client";
import { Prisma, SignalReactionType, SignalReplyStatus } from "@prisma/client";

import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { normalizeMarket, type NormalizedMarket } from "./markets.js";
import { normalizeTradeSignal, type NormalizedTradeSignal } from "./signals.js";
import { type NormalizedTraderProfile } from "./users.js";

export type SocialFeedOptions = {
  limit?: number;
  marketId?: string;
  traderProfileId?: string;
  viewerUserId?: string;
};

export type CreateSignalReplyInput = {
  signalId: string;
  authorUserId: string;
  body: string;
};

export type SignalReactionInput = {
  signalId: string;
  userId: string;
};

export type SignalBookmarkInput = {
  signalId: string;
  userId: string;
};

export type NormalizedSocialActor = {
  userId: string;
  displayName: string | null;
  handle: string | null;
  platform: SocialAccount["platform"] | null;
  platformUserId: string | null;
  username: string | null;
  profileUrl: string | null;
};

export type NormalizedSignalReply = {
  id: string;
  signalId: string;
  authorUserId: string;
  body: string;
  status: SignalReply["status"];
  author: NormalizedSocialActor;
  createdAt: string;
  updatedAt: string;
};

export type SocialFeedCounts = {
  replies: number;
  reactions: number;
  bookmarks: number;
  copyIntents: number;
};

export type SocialViewerState = {
  reacted: boolean;
  bookmarked: boolean;
};

export type NormalizedSocialFeedItem = {
  signal: NormalizedTradeSignal;
  market: NormalizedMarket | null;
  trader: NormalizedTraderProfile | null;
  author: NormalizedSocialActor;
  counts: SocialFeedCounts;
  viewer: SocialViewerState | null;
  recentReplies: NormalizedSignalReply[];
};

const feedInclude = {
  market: true,
  traderProfile: {
    include: {
      user: {
        include: {
          socialAccounts: true,
        },
      },
    },
  },
  socialReplies: {
    where: { status: SignalReplyStatus.PUBLISHED },
    orderBy: { createdAt: "desc" },
    take: 2,
    include: {
      author: {
        include: {
          socialAccounts: true,
          traderProfile: true,
        },
      },
    },
  },
  _count: {
    select: {
      socialReplies: { where: { status: SignalReplyStatus.PUBLISHED } },
      socialReactions: true,
      socialBookmarks: true,
      copyTrades: true,
    },
  },
} satisfies Prisma.TradeSignalInclude;

type FeedSignal = Prisma.TradeSignalGetPayload<{ include: typeof feedInclude }>;

type ReplyWithAuthor = SignalReply & {
  author: User & {
    socialAccounts: SocialAccount[];
    traderProfile: TraderProfile | null;
  };
};

export async function listSocialFeed(options: SocialFeedOptions = {}) {
  const limit = clampLimit(options.limit);
  const signals = await prisma.tradeSignal.findMany({
    where: {
      marketId: options.marketId,
      traderProfileId: options.traderProfileId,
      status: "PUBLISHED",
    },
    include: feedInclude,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const viewerState = options.viewerUserId
    ? await getViewerState(
        options.viewerUserId,
        signals.map((signal) => signal.id),
      )
    : null;

  return signals.map((signal) => normalizeSocialFeedItem(signal, viewerState));
}

export async function getSocialFeedItem(signalId: string, viewerUserId?: string) {
  const signal = await prisma.tradeSignal.findUnique({
    where: { id: signalId },
    include: feedInclude,
  });

  if (!signal || signal.status !== "PUBLISHED") {
    return null;
  }

  const viewerState = viewerUserId ? await getViewerState(viewerUserId, [signal.id]) : null;

  return normalizeSocialFeedItem(signal, viewerState);
}

export async function listSignalReplies(signalId: string, limit = 30) {
  await ensureSignalExists(signalId);

  const replies = await prisma.signalReply.findMany({
    where: { signalId, status: SignalReplyStatus.PUBLISHED },
    orderBy: { createdAt: "asc" },
    take: clampLimit(limit),
    include: {
      author: {
        include: {
          socialAccounts: true,
          traderProfile: true,
        },
      },
    },
  });

  return replies.map(normalizeSignalReply);
}

export async function createSignalReply(input: CreateSignalReplyInput) {
  const body = input.body.trim();

  if (body.length < 1 || body.length > 1000) {
    throw new AppError("Reply must be 1 to 1000 characters", {
      code: "INVALID_SIGNAL_REPLY",
      statusCode: 422,
    });
  }

  await Promise.all([ensureSignalExists(input.signalId), ensureUserExists(input.authorUserId)]);

  const reply = await prisma.signalReply.create({
    data: {
      signalId: input.signalId,
      authorUserId: input.authorUserId,
      body,
    },
    include: {
      author: {
        include: {
          socialAccounts: true,
          traderProfile: true,
        },
      },
    },
  });

  return normalizeSignalReply(reply);
}

export async function addSignalReaction(input: SignalReactionInput) {
  await Promise.all([ensureSignalExists(input.signalId), ensureUserExists(input.userId)]);

  const reaction = await prisma.signalReaction.upsert({
    where: {
      signalId_userId_type: {
        signalId: input.signalId,
        userId: input.userId,
        type: SignalReactionType.LIKE,
      },
    },
    create: {
      signalId: input.signalId,
      userId: input.userId,
      type: SignalReactionType.LIKE,
    },
    update: {},
  });
  const counts = await getSignalSocialCounts(input.signalId);

  return {
    reaction: normalizeSignalReaction(reaction),
    counts,
  };
}

export async function removeSignalReaction(input: SignalReactionInput) {
  await prisma.signalReaction
    .delete({
      where: {
        signalId_userId_type: {
          signalId: input.signalId,
          userId: input.userId,
          type: SignalReactionType.LIKE,
        },
      },
    })
    .catch(ignoreNotFound);
  const counts = await getSignalSocialCounts(input.signalId);

  return { counts };
}

export async function addSignalBookmark(input: SignalBookmarkInput) {
  await Promise.all([ensureSignalExists(input.signalId), ensureUserExists(input.userId)]);

  const bookmark = await prisma.signalBookmark.upsert({
    where: {
      signalId_userId: {
        signalId: input.signalId,
        userId: input.userId,
      },
    },
    create: {
      signalId: input.signalId,
      userId: input.userId,
    },
    update: {},
  });
  const counts = await getSignalSocialCounts(input.signalId);

  return {
    bookmark: normalizeSignalBookmark(bookmark),
    counts,
  };
}

export async function removeSignalBookmark(input: SignalBookmarkInput) {
  await prisma.signalBookmark
    .delete({
      where: {
        signalId_userId: {
          signalId: input.signalId,
          userId: input.userId,
        },
      },
    })
    .catch(ignoreNotFound);
  const counts = await getSignalSocialCounts(input.signalId);

  return { counts };
}

async function getSignalSocialCounts(signalId: string): Promise<SocialFeedCounts> {
  const [replies, reactions, bookmarks, copyIntents] = await Promise.all([
    prisma.signalReply.count({ where: { signalId, status: SignalReplyStatus.PUBLISHED } }),
    prisma.signalReaction.count({ where: { signalId } }),
    prisma.signalBookmark.count({ where: { signalId } }),
    prisma.copyTrade.count({ where: { sourceSignalId: signalId } }),
  ]);

  return { replies, reactions, bookmarks, copyIntents };
}

async function getViewerState(userId: string, signalIds: string[]) {
  if (signalIds.length === 0) {
    return new Map<string, SocialViewerState>();
  }

  const [reactions, bookmarks] = await Promise.all([
    prisma.signalReaction.findMany({
      where: { userId, signalId: { in: signalIds }, type: SignalReactionType.LIKE },
      select: { signalId: true },
    }),
    prisma.signalBookmark.findMany({
      where: { userId, signalId: { in: signalIds } },
      select: { signalId: true },
    }),
  ]);
  const reactionIds = new Set(reactions.map((reaction) => reaction.signalId));
  const bookmarkIds = new Set(bookmarks.map((bookmark) => bookmark.signalId));

  return new Map(
    signalIds.map((signalId) => [
      signalId,
      {
        reacted: reactionIds.has(signalId),
        bookmarked: bookmarkIds.has(signalId),
      },
    ]),
  );
}

function normalizeSocialFeedItem(
  signal: FeedSignal,
  viewerState: Map<string, SocialViewerState> | null,
): NormalizedSocialFeedItem {
  return {
    signal: normalizeTradeSignal(signal),
    market: signal.market ? normalizeMarket(signal.market as Market) : null,
    trader: signal.traderProfile ? normalizeTraderProfile(signal.traderProfile) : null,
    author: normalizeSocialActor(signal.traderProfile.user),
    counts: {
      replies: signal._count.socialReplies,
      reactions: signal._count.socialReactions,
      bookmarks: signal._count.socialBookmarks,
      copyIntents: signal._count.copyTrades,
    },
    viewer: viewerState?.get(signal.id) ?? null,
    recentReplies: signal.socialReplies.map(normalizeSignalReply).reverse(),
  };
}

function normalizeSignalReply(reply: ReplyWithAuthor): NormalizedSignalReply {
  return {
    id: reply.id,
    signalId: reply.signalId,
    authorUserId: reply.authorUserId,
    body: reply.body,
    status: reply.status,
    author: normalizeSocialActor(reply.author),
    createdAt: reply.createdAt.toISOString(),
    updatedAt: reply.updatedAt.toISOString(),
  };
}

function normalizeTraderProfile(traderProfile: TraderProfile): NormalizedTraderProfile {
  return {
    id: traderProfile.id,
    userId: traderProfile.userId,
    handle: traderProfile.handle,
    bio: traderProfile.bio,
    createdAt: traderProfile.createdAt.toISOString(),
    updatedAt: traderProfile.updatedAt.toISOString(),
  };
}

function normalizeSocialActor(
  user: User & { socialAccounts: SocialAccount[]; traderProfile?: TraderProfile | null },
): NormalizedSocialActor {
  const account = user.socialAccounts.find((item) => item.platform === "FARCASTER") ?? user.socialAccounts[0] ?? null;

  return {
    userId: user.id,
    displayName: user.displayName,
    handle: user.traderProfile?.handle ?? null,
    platform: account?.platform ?? null,
    platformUserId: account?.platformUserId ?? null,
    username: account?.username ?? null,
    profileUrl: account?.profileUrl ?? null,
  };
}

function normalizeSignalReaction(reaction: SignalReaction) {
  return {
    id: reaction.id,
    signalId: reaction.signalId,
    userId: reaction.userId,
    type: reaction.type,
    createdAt: reaction.createdAt.toISOString(),
    updatedAt: reaction.updatedAt.toISOString(),
  };
}

function normalizeSignalBookmark(bookmark: SignalBookmark) {
  return {
    id: bookmark.id,
    signalId: bookmark.signalId,
    userId: bookmark.userId,
    createdAt: bookmark.createdAt.toISOString(),
    updatedAt: bookmark.updatedAt.toISOString(),
  };
}

async function ensureSignalExists(signalId: string) {
  const signal = await prisma.tradeSignal.findUnique({ where: { id: signalId } });

  if (!signal || signal.status !== "PUBLISHED") {
    throw new AppError("Trade signal not found", {
      code: "TRADE_SIGNAL_NOT_FOUND",
      statusCode: 404,
    });
  }
}

async function ensureUserExists(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new AppError("User not found", {
      code: "USER_NOT_FOUND",
      statusCode: 404,
    });
  }
}

function clampLimit(limit = 50) {
  return Math.min(Math.max(limit, 1), 100);
}

function ignoreNotFound(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
    return null;
  }

  throw error;
}
