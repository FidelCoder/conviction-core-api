import type { SocialAccount, TraderProfile, User } from "@prisma/client";
import { Prisma, SocialPlatform } from "@prisma/client";

import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

export type CreateOrFetchSocialAccountInput = {
  platform: SocialPlatform;
  platformUserId: string;
  username?: string | null;
  displayName?: string | null;
  profileUrl?: string | null;
};

export type UpsertTraderProfileInput = {
  userId: string;
  handle: string;
  bio?: string | null;
  avatarUrl?: string | null;
};

export type UserSession = {
  user: NormalizedUser;
  socialAccount: NormalizedSocialAccount;
  traderProfile: NormalizedTraderProfile | null;
};

export type NormalizedUser = {
  id: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NormalizedSocialAccount = {
  id: string;
  userId: string;
  platform: SocialAccount["platform"];
  platformUserId: string;
  username: string | null;
  profileUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NormalizedTraderProfile = {
  id: string;
  userId: string;
  handle: string;
  bio: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

const handlePattern = /^[a-z0-9_][a-z0-9_.-]{1,39}\.viction$/;
const victionSuffix = ".viction";

export async function createOrFetchSocialAccount(input: CreateOrFetchSocialAccountInput) {
  const platformUserId = input.platformUserId.trim();

  if (!platformUserId) {
    throw new AppError("Platform user ID is required", {
      code: "INVALID_PLATFORM_USER_ID",
      statusCode: 422,
    });
  }

  const existingSocialAccount = await prisma.socialAccount.findUnique({
    where: {
      platform_platformUserId: {
        platform: input.platform,
        platformUserId,
      },
    },
    include: {
      user: {
        include: {
          traderProfile: true,
        },
      },
    },
  });

  if (existingSocialAccount) {
    const [socialAccount, user] = await prisma.$transaction([
      prisma.socialAccount.update({
        where: { id: existingSocialAccount.id },
        data: {
          username: normalizeNullableStringUpdate(input.username),
          profileUrl: normalizeNullableStringUpdate(input.profileUrl),
        },
      }),
      prisma.user.update({
        where: { id: existingSocialAccount.userId },
        data: {
          displayName: normalizeNullableStringUpdate(input.displayName),
        },
        include: {
          traderProfile: true,
        },
      }),
    ]);

    return normalizeUserSession(user, socialAccount, user.traderProfile);
  }

  const user = await prisma.user.create({
    data: {
      displayName: normalizeNullableString(input.displayName),
      socialAccounts: {
        create: {
          platform: input.platform,
          platformUserId,
          username: normalizeNullableString(input.username),
          profileUrl: normalizeNullableString(input.profileUrl),
        },
      },
    },
    include: {
      socialAccounts: {
        where: {
          platform: input.platform,
          platformUserId,
        },
      },
      traderProfile: true,
    },
  });
  const socialAccount = user.socialAccounts[0];

  if (!socialAccount) {
    throw new AppError("Social account was not created", {
      code: "SOCIAL_ACCOUNT_CREATE_FAILED",
      statusCode: 500,
    });
  }

  return normalizeUserSession(user, socialAccount, user.traderProfile);
}

export async function upsertTraderProfile(input: UpsertTraderProfileInput) {
  const handle = normalizeVictionHandle(input.handle);

  if (!handlePattern.test(handle)) {
    throw new AppError(
      "Handle must end in .viction and use letters, numbers, underscores, dots, or dashes",
      {
        code: "INVALID_TRADER_HANDLE",
        statusCode: 422,
      },
    );
  }

  const user = await prisma.user.findUnique({ where: { id: input.userId } });

  if (!user) {
    throw new AppError("User not found", {
      code: "USER_NOT_FOUND",
      statusCode: 404,
    });
  }

  try {
    const existingProfile = await prisma.traderProfile.findUnique({
      where: { userId: input.userId },
    });

    if (existingProfile) {
      const traderProfile = await prisma.traderProfile.update({
        where: { id: existingProfile.id },
        data: {
          handle,
          bio: normalizeNullableString(input.bio),
          avatarUrl: normalizeNullableStringUpdate(input.avatarUrl),
        },
      });

      return normalizeTraderProfile(traderProfile);
    }

    const traderProfile = await prisma.traderProfile.create({
      data: {
        userId: input.userId,
        handle,
        bio: normalizeNullableString(input.bio),
        avatarUrl: normalizeNullableString(input.avatarUrl),
      },
    });

    return normalizeTraderProfile(traderProfile);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("Trader handle is already in use", {
        code: "TRADER_HANDLE_CONFLICT",
        statusCode: 409,
      });
    }

    throw error;
  }
}

export async function getTraderProfileById(id: string) {
  const traderProfile = await prisma.traderProfile.findUnique({ where: { id } });

  return traderProfile ? normalizeTraderProfile(traderProfile) : null;
}

function normalizeUserSession(
  user: User,
  socialAccount: SocialAccount,
  traderProfile: TraderProfile | null,
): UserSession {
  return {
    user: normalizeUser(user),
    socialAccount: normalizeSocialAccount(socialAccount),
    traderProfile: traderProfile ? normalizeTraderProfile(traderProfile) : null,
  };
}

function normalizeUser(user: User): NormalizedUser {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function normalizeSocialAccount(socialAccount: SocialAccount): NormalizedSocialAccount {
  return {
    id: socialAccount.id,
    userId: socialAccount.userId,
    platform: socialAccount.platform,
    platformUserId: socialAccount.platformUserId,
    username: socialAccount.username,
    profileUrl: socialAccount.profileUrl,
    createdAt: socialAccount.createdAt.toISOString(),
    updatedAt: socialAccount.updatedAt.toISOString(),
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

function normalizeNullableString(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNullableStringUpdate(value: string | null | undefined) {
  return typeof value === "undefined" ? undefined : normalizeNullableString(value);
}

function normalizeVictionHandle(value: string) {
  const trimmed = value.trim().toLowerCase();
  const base = trimmed.endsWith(victionSuffix) ? trimmed.slice(0, -victionSuffix.length) : trimmed;

  return base + victionSuffix;
}
