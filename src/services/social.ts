import type {
  Market,
  Position,
  PositionReply,
  SignalBookmark,
  SignalReaction,
  SignalReply,
  SocialAccount,
  TraderProfile,
  User,
  UserFollow,
  UserNotification,
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

export type FollowUserInput = {
  followerId: string;
  followingId: string;
};

export type PositionReplyInput = {
  positionId: string;
  authorUserId: string;
  body: string;
};

export type SocialTimelineOptions = {
  userId?: string;
  limit?: number;
  scope?: "all" | "following";
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

export type SignalSocialParticipants = {
  reactions: NormalizedSocialActor[];
  bookmarks: NormalizedSocialActor[];
  commenters: NormalizedSocialActor[];
};

export type NormalizedUserFollow = {
  id: string;
  followerId: string;
  followingId: string;
  follower: NormalizedSocialActor;
  following: NormalizedSocialActor;
  createdAt: string;
  updatedAt: string;
};

export type NormalizedUserNotification = {
  id: string;
  userId: string;
  actorUserId: string | null;
  actor: NormalizedSocialActor | null;
  type: string;
  entityType: string | null;
  entityId: string | null;
  message: string;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NormalizedPositionReply = {
  id: string;
  positionId: string;
  authorUserId: string;
  body: string;
  status: string;
  author: NormalizedSocialActor;
  createdAt: string;
  updatedAt: string;
};

export type NormalizedPublicPosition = {
  id: string;
  userId: string;
  marketId: string;
  side: Position["side"];
  quantity: string;
  executionMode: Position["executionMode"];
  leverageMultiplier: string | null;
  marginCollateral: string | null;
  notionalAmount: string | null;
  status: Position["status"];
  visibility: string;
  createdAt: string;
  updatedAt: string;
  trader: NormalizedSocialActor;
  market: NormalizedMarket | null;
  replies: NormalizedPositionReply[];
};

export type NormalizedSocialTimelineEvent = {
  id: string;
  type: "SIGNAL" | "REPOST" | "PUBLIC_TRADE" | "FOLLOW";
  createdAt: string;
  actor: NormalizedSocialActor;
  signal?: NormalizedSocialFeedItem;
  position?: NormalizedPublicPosition;
  follow?: NormalizedUserFollow;
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

const followInclude = {
  follower: {
    include: {
      socialAccounts: true,
      traderProfile: true,
    },
  },
  following: {
    include: {
      socialAccounts: true,
      traderProfile: true,
    },
  },
} satisfies Prisma.UserFollowInclude;

const notificationInclude = {
  actor: {
    include: {
      socialAccounts: true,
      traderProfile: true,
    },
  },
} satisfies Prisma.UserNotificationInclude;

const publicPositionInclude = {
  user: {
    include: {
      socialAccounts: true,
      traderProfile: true,
    },
  },
  market: true,
  socialReplies: {
    where: { status: "PUBLISHED" },
    orderBy: { createdAt: "desc" },
    take: 4,
    include: {
      author: {
        include: {
          socialAccounts: true,
          traderProfile: true,
        },
      },
    },
  },
} satisfies Prisma.PositionInclude;

type ReplyWithAuthor = SignalReply & {
  author: User & {
    socialAccounts: SocialAccount[];
    traderProfile: TraderProfile | null;
  };
};

type ReactionWithUser = SignalReaction & {
  user: User & {
    socialAccounts: SocialAccount[];
    traderProfile: TraderProfile | null;
  };
};

type BookmarkWithUser = SignalBookmark & {
  user: User & {
    socialAccounts: SocialAccount[];
    traderProfile: TraderProfile | null;
  };
};

type FollowWithUsers = UserFollow & {
  follower: User & { socialAccounts: SocialAccount[]; traderProfile: TraderProfile | null };
  following: User & { socialAccounts: SocialAccount[]; traderProfile: TraderProfile | null };
};

type NotificationWithActor = UserNotification & {
  actor: (User & { socialAccounts: SocialAccount[]; traderProfile: TraderProfile | null }) | null;
};

type PositionReplyWithAuthor = PositionReply & {
  author: User & { socialAccounts: SocialAccount[]; traderProfile: TraderProfile | null };
};

type PublicPositionWithRelations = Position & {
  user: User & { socialAccounts: SocialAccount[]; traderProfile: TraderProfile | null };
  market: Market | null;
  socialReplies: PositionReplyWithAuthor[];
};

type BookmarkTimelineItem = SignalBookmark & {
  user: User & { socialAccounts: SocialAccount[]; traderProfile: TraderProfile | null };
  signal: FeedSignal;
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

export async function listSignalSocialParticipants(
  signalId: string,
  limit = 20,
): Promise<SignalSocialParticipants> {
  await ensureSignalExists(signalId);

  const [reactions, bookmarks, replies] = await Promise.all([
    prisma.signalReaction.findMany({
      where: { signalId, type: SignalReactionType.LIKE },
      orderBy: { createdAt: "desc" },
      take: clampLimit(limit),
      include: {
        user: {
          include: {
            socialAccounts: true,
            traderProfile: true,
          },
        },
      },
    }),
    prisma.signalBookmark.findMany({
      where: { signalId },
      orderBy: { createdAt: "desc" },
      take: clampLimit(limit),
      include: {
        user: {
          include: {
            socialAccounts: true,
            traderProfile: true,
          },
        },
      },
    }),
    prisma.signalReply.findMany({
      where: { signalId, status: SignalReplyStatus.PUBLISHED },
      orderBy: { createdAt: "desc" },
      take: clampLimit(limit),
      include: {
        author: {
          include: {
            socialAccounts: true,
            traderProfile: true,
          },
        },
      },
    }),
  ]);

  return {
    reactions: dedupeActors(reactions.map((reaction) => normalizeSocialActor((reaction as ReactionWithUser).user))),
    bookmarks: dedupeActors(bookmarks.map((bookmark) => normalizeSocialActor((bookmark as BookmarkWithUser).user))),
    commenters: dedupeActors(replies.map((reply) => normalizeSocialActor((reply as ReplyWithAuthor).author))),
  };
}


export async function listSocialTimeline(options: SocialTimelineOptions = {}) {
  const limit = clampLimit(options.limit ?? 50);
  const followingIds = options.scope === "following" && options.userId
    ? await listFollowingUserIds(options.userId)
    : null;

  if (options.scope === "following" && followingIds && followingIds.length === 0) {
    return [];
  }

  const actorFilter = followingIds ? { in: followingIds } : undefined;
  const [signals, reposts, positions, follows] = await Promise.all([
    prisma.tradeSignal.findMany({
      where: {
        status: "PUBLISHED",
        traderProfile: actorFilter ? { userId: actorFilter } : undefined,
      },
      include: feedInclude,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.signalBookmark.findMany({
      where: actorFilter ? { userId: actorFilter } : undefined,
      include: {
        user: { include: { socialAccounts: true, traderProfile: true } },
        signal: { include: feedInclude },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.position.findMany({
      where: {
        visibility: "PUBLIC",
        userId: actorFilter,
      },
      include: publicPositionInclude,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.userFollow.findMany({
      where: actorFilter ? { followerId: actorFilter } : undefined,
      include: followInclude,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  ]);

  const viewerState = options.userId
    ? await getViewerState(options.userId, [
        ...signals.map((signal) => signal.id),
        ...reposts.map((repost) => repost.signal.id),
      ])
    : null;

  const events: NormalizedSocialTimelineEvent[] = [
    ...signals.map((signal) => ({
      id: "signal-" + signal.id,
      type: "SIGNAL" as const,
      createdAt: signal.createdAt.toISOString(),
      actor: normalizeSocialActor(signal.traderProfile.user),
      signal: normalizeSocialFeedItem(signal, viewerState),
    })),
    ...reposts.map((repost) => ({
      id: "repost-" + repost.id,
      type: "REPOST" as const,
      createdAt: repost.createdAt.toISOString(),
      actor: normalizeSocialActor((repost as BookmarkTimelineItem).user),
      signal: normalizeSocialFeedItem((repost as BookmarkTimelineItem).signal, viewerState),
    })),
    ...positions.map((position) => ({
      id: "position-" + position.id,
      type: "PUBLIC_TRADE" as const,
      createdAt: position.createdAt.toISOString(),
      actor: normalizeSocialActor((position as PublicPositionWithRelations).user),
      position: normalizePublicPosition(position as PublicPositionWithRelations),
    })),
    ...follows.map((follow) => ({
      id: "follow-" + follow.id,
      type: "FOLLOW" as const,
      createdAt: follow.createdAt.toISOString(),
      actor: normalizeSocialActor((follow as FollowWithUsers).follower),
      follow: normalizeUserFollow(follow as FollowWithUsers),
    })),
  ];

  return events
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}

export async function followUser(input: FollowUserInput) {
  if (input.followerId === input.followingId) {
    throw new AppError("You cannot follow yourself", {
      code: "CANNOT_FOLLOW_SELF",
      statusCode: 422,
    });
  }

  await Promise.all([ensureUserExists(input.followerId), ensureUserExists(input.followingId)]);

  const follow = await prisma.userFollow.upsert({
    where: {
      followerId_followingId: {
        followerId: input.followerId,
        followingId: input.followingId,
      },
    },
    create: {
      followerId: input.followerId,
      followingId: input.followingId,
    },
    update: {},
    include: followInclude,
  });

  await createNotification({
    userId: input.followingId,
    actorUserId: input.followerId,
    type: "FOLLOW",
    entityType: "USER",
    entityId: input.followerId,
    message: getActorDisplayName((follow as FollowWithUsers).follower) + " followed you.",
  });

  return normalizeUserFollow(follow as FollowWithUsers);
}

export async function unfollowUser(input: FollowUserInput) {
  await prisma.userFollow
    .delete({
      where: {
        followerId_followingId: {
          followerId: input.followerId,
          followingId: input.followingId,
        },
      },
    })
    .catch(ignoreNotFound);

  return { ok: true };
}

export async function listUserFollowers(userId: string, limit = 50) {
  await ensureUserExists(userId);

  const follows = await prisma.userFollow.findMany({
    where: { followingId: userId },
    include: followInclude,
    orderBy: { createdAt: "desc" },
    take: clampLimit(limit),
  });

  return follows.map((follow) => normalizeUserFollow(follow as FollowWithUsers));
}

export async function listUserFollowing(userId: string, limit = 50) {
  await ensureUserExists(userId);

  const follows = await prisma.userFollow.findMany({
    where: { followerId: userId },
    include: followInclude,
    orderBy: { createdAt: "desc" },
    take: clampLimit(limit),
  });

  return follows.map((follow) => normalizeUserFollow(follow as FollowWithUsers));
}

export async function listUserNotifications(userId: string, limit = 50) {
  await ensureUserExists(userId);

  const notifications = await prisma.userNotification.findMany({
    where: { userId },
    include: notificationInclude,
    orderBy: { createdAt: "desc" },
    take: clampLimit(limit),
  });

  return notifications.map((notification) => normalizeNotification(notification as NotificationWithActor));
}

export async function createPositionReply(input: PositionReplyInput) {
  const body = input.body.trim();

  if (body.length < 1 || body.length > 1000) {
    throw new AppError("Comment must be 1 to 1000 characters", {
      code: "INVALID_POSITION_REPLY",
      statusCode: 422,
    });
  }

  const [position, author] = await Promise.all([
    prisma.position.findUnique({ where: { id: input.positionId } }),
    prisma.user.findUnique({ where: { id: input.authorUserId } }),
  ]);

  if (!position || position.visibility !== "PUBLIC") {
    throw new AppError("Public trade not found", {
      code: "PUBLIC_POSITION_NOT_FOUND",
      statusCode: 404,
    });
  }

  if (!author) {
    throw new AppError("User not found", {
      code: "USER_NOT_FOUND",
      statusCode: 404,
    });
  }

  const reply = await prisma.positionReply.create({
    data: {
      positionId: input.positionId,
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

  if (position.userId !== input.authorUserId) {
    await createNotification({
      userId: position.userId,
      actorUserId: input.authorUserId,
      type: "POSITION_REPLY",
      entityType: "POSITION",
      entityId: input.positionId,
      message: getActorDisplayName(author as User & { socialAccounts: SocialAccount[]; traderProfile?: TraderProfile | null }) + " commented on your public trade.",
    });
  }

  return normalizePositionReply(reply as PositionReplyWithAuthor);
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
      signal: {
        include: {
          traderProfile: true,
        },
      },
    },
  });

  if (reply.signal.traderProfile.userId !== input.authorUserId) {
    await createNotification({
      userId: reply.signal.traderProfile.userId,
      actorUserId: input.authorUserId,
      type: "SIGNAL_REPLY",
      entityType: "SIGNAL",
      entityId: input.signalId,
      message: getActorDisplayName(reply.author) + " replied to your signal.",
    });
  }

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
    include: {
      user: {
        include: {
          socialAccounts: true,
          traderProfile: true,
        },
      },
      signal: {
        include: {
          traderProfile: true,
        },
      },
    },
  });

  if (reaction.signal.traderProfile.userId !== input.userId) {
    await createNotification({
      userId: reaction.signal.traderProfile.userId,
      actorUserId: input.userId,
      type: "SIGNAL_LIKE",
      entityType: "SIGNAL",
      entityId: input.signalId,
      message: getActorDisplayName((reaction as ReactionWithUser).user) + " liked your signal.",
    });
  }

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
    include: {
      user: {
        include: {
          socialAccounts: true,
          traderProfile: true,
        },
      },
      signal: {
        include: {
          traderProfile: true,
        },
      },
    },
  });

  if (bookmark.signal.traderProfile.userId !== input.userId) {
    await createNotification({
      userId: bookmark.signal.traderProfile.userId,
      actorUserId: input.userId,
      type: "SIGNAL_REPOST",
      entityType: "SIGNAL",
      entityId: input.signalId,
      message: getActorDisplayName((bookmark as BookmarkWithUser).user) + " reposted your signal.",
    });
  }

  await notifyFollowers({
    actorUserId: input.userId,
    type: "FOLLOWING_REPOST",
    entityType: "SIGNAL",
    entityId: input.signalId,
    message: getActorDisplayName((bookmark as BookmarkWithUser).user) + " reposted a market signal.",
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

export async function notifyFollowersOfPublicPosition(positionId: string) {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
    include: {
      user: {
        include: {
          socialAccounts: true,
          traderProfile: true,
        },
      },
      market: true,
    },
  });

  if (!position || position.visibility !== "PUBLIC") return;

  await notifyFollowers({
    actorUserId: position.userId,
    type: "FOLLOWING_PUBLIC_TRADE",
    entityType: "POSITION",
    entityId: position.id,
    message: getActorDisplayName(position.user) + " placed a public trade on " + (position.market?.title ?? "a market") + ".",
  });
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


function normalizeUserFollow(follow: FollowWithUsers): NormalizedUserFollow {
  return {
    id: follow.id,
    followerId: follow.followerId,
    followingId: follow.followingId,
    follower: normalizeSocialActor(follow.follower),
    following: normalizeSocialActor(follow.following),
    createdAt: follow.createdAt.toISOString(),
    updatedAt: follow.updatedAt.toISOString(),
  };
}

function normalizeNotification(notification: NotificationWithActor): NormalizedUserNotification {
  return {
    id: notification.id,
    userId: notification.userId,
    actorUserId: notification.actorUserId,
    actor: notification.actor ? normalizeSocialActor(notification.actor) : null,
    type: notification.type,
    entityType: notification.entityType,
    entityId: notification.entityId,
    message: notification.message,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
    updatedAt: notification.updatedAt.toISOString(),
  };
}

function normalizePublicPosition(position: PublicPositionWithRelations): NormalizedPublicPosition {
  return {
    id: position.id,
    userId: position.userId,
    marketId: position.marketId,
    side: position.side,
    quantity: position.quantity,
    executionMode: position.executionMode,
    leverageMultiplier: position.leverageMultiplier,
    marginCollateral: position.marginCollateral,
    notionalAmount: position.notionalAmount,
    status: position.status,
    visibility: position.visibility ?? "PRIVATE",
    createdAt: position.createdAt.toISOString(),
    updatedAt: position.updatedAt.toISOString(),
    trader: normalizeSocialActor(position.user),
    market: position.market ? normalizeMarket(position.market) : null,
    replies: position.socialReplies.map((reply) => normalizePositionReply(reply)).reverse(),
  };
}

function normalizePositionReply(reply: PositionReplyWithAuthor): NormalizedPositionReply {
  return {
    id: reply.id,
    positionId: reply.positionId,
    authorUserId: reply.authorUserId,
    body: reply.body,
    status: reply.status,
    author: normalizeSocialActor(reply.author),
    createdAt: reply.createdAt.toISOString(),
    updatedAt: reply.updatedAt.toISOString(),
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
    avatarUrl: traderProfile.avatarUrl ?? null,
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

function dedupeActors(actors: NormalizedSocialActor[]) {
  const seen = new Set<string>();

  return actors.filter((actor) => {
    if (seen.has(actor.userId)) return false;

    seen.add(actor.userId);
    return true;
  });
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


async function listFollowingUserIds(userId: string) {
  await ensureUserExists(userId);

  const follows = await prisma.userFollow.findMany({
    where: { followerId: userId },
    select: { followingId: true },
  });

  return follows.map((follow) => follow.followingId);
}

async function createNotification(input: {
  userId: string;
  actorUserId?: string | null;
  type: string;
  entityType?: string | null;
  entityId?: string | null;
  message: string;
}) {
  if (input.actorUserId && input.actorUserId === input.userId) return null;

  return prisma.userNotification.create({
    data: {
      userId: input.userId,
      actorUserId: input.actorUserId ?? null,
      type: input.type,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      message: input.message,
    },
  });
}

async function notifyFollowers(input: {
  actorUserId: string;
  type: string;
  entityType: string;
  entityId: string;
  message: string;
}) {
  const followers = await prisma.userFollow.findMany({
    where: { followingId: input.actorUserId },
    select: { followerId: true },
  });

  if (followers.length === 0) return;

  await prisma.userNotification.createMany({
    data: followers
      .filter((follow) => follow.followerId !== input.actorUserId)
      .map((follow) => ({
        userId: follow.followerId,
        actorUserId: input.actorUserId,
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        message: input.message,
      })),
  });
}

function getActorDisplayName(user: User & { socialAccounts?: SocialAccount[]; traderProfile?: TraderProfile | null }) {
  return user.traderProfile?.handle ?? user.socialAccounts?.[0]?.username ?? user.displayName ?? "A trader";
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
