import { randomBytes } from "node:crypto";

import {
  AuthProvider,
  PolymarketAccountStatus,
  PolymarketChallengePurpose,
  PolymarketPositionState,
  PolymarketWalletType,
  Prisma,
  SocialPlatform,
} from "@prisma/client";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  verifyMessage as verifyEoaMessage,
  type Address,
  type Hex,
} from "viem";
import { arbitrumSepolia, base, baseSepolia, polygon, sepolia } from "viem/chains";
import { z } from "zod";

import { env } from "../config/index.js";
import { encryptJson } from "../lib/credentials.js";
import { AppError } from "../lib/errors.js";
import {
  buildPolymarketAccountMessage,
  buildPolymarketAuthMessage,
} from "../lib/polymarket-link-message.js";
import { prisma } from "../lib/prisma.js";
import { attachVerifiedSocialAccountToUser, createOrFetchSocialAccount } from "./users.js";

const challengeLifetimeMs = 10 * 60 * 1000;
const polygonChainId = 137;
const supportedConvictionChainIds = new Set<number>([
  base.id,
  baseSepolia.id,
  sepolia.id,
  arbitrumSepolia.id,
  polygon.id,
]);

const optionalText = z.union([z.string(), z.number()]).transform(String).nullable().optional();
const polymarketPositionSchema = z
  .object({
    asset: z.union([z.string(), z.number()]).transform(String),
    conditionId: z.string().nullable().optional(),
    size: optionalText,
    avgPrice: optionalText,
    initialValue: optionalText,
    currentValue: optionalText,
    cashPnl: optionalText,
    realizedPnl: optionalText,
    curPrice: optionalText,
    title: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    eventSlug: z.string().nullable().optional(),
    outcome: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
    redeemable: z.boolean().optional(),
    mergeable: z.boolean().optional(),
  })
  .passthrough();
const polymarketPositionListSchema = z.array(polymarketPositionSchema);

export type PolymarketCredentials = {
  apiKey: string;
  secret: string;
  passphrase: string;
};

export type CreateLinkChallengeInput = {
  userId: string;
  convictionAddress: string;
  convictionChainId: number;
  polymarketOwnerAddress: string;
  polymarketFunderAddress: string;
  polymarketWalletType: PolymarketWalletType;
};

export type CompleteLinkInput = {
  userId: string;
  challengeId: string;
  convictionSignature: string;
  polymarketSignature?: string | null;
  credentials?: PolymarketCredentials | null;
};

export type CompleteUnlinkInput = {
  userId: string;
  accountId: string;
  challengeId: string;
  convictionSignature: string;
  polymarketSignature?: string | null;
};

export type CreatePolymarketAuthChallengeInput = {
  ownerAddress: string;
};

export type CompletePolymarketAuthInput = {
  challengeId: string;
  signature: string;
};

export function resolvePolymarketAuthUserId(linkedUserIds: string[], socialUserId: string | null) {
  const uniqueLinkedUserIds = [...new Set(linkedUserIds)];

  if (uniqueLinkedUserIds.length > 1) {
    throw new AppError("This Polymarket owner is linked to multiple Conviction users", {
      code: "POLYMARKET_AUTH_IDENTITY_CONFLICT",
      statusCode: 409,
    });
  }

  const linkedUserId = uniqueLinkedUserIds[0] ?? null;

  if (linkedUserId && socialUserId && linkedUserId !== socialUserId) {
    throw new AppError("Polymarket and Conviction wallet identities do not match", {
      code: "POLYMARKET_AUTH_IDENTITY_CONFLICT",
      statusCode: 409,
    });
  }

  return linkedUserId ?? socialUserId;
}

export async function createPolymarketLinkChallenge(input: CreateLinkChallengeInput) {
  const convictionAddress = normalizeAddress(input.convictionAddress, "Conviction wallet");
  const ownerAddress = normalizeAddress(input.polymarketOwnerAddress, "Polymarket owner");
  const funderAddress = normalizeAddress(input.polymarketFunderAddress, "Polymarket funder");

  validateConvictionChain(input.convictionChainId);
  validateWalletAddressRelationship(input.polymarketWalletType, ownerAddress, funderAddress);
  await ensureConvictionAddressBelongsToUser(input.userId, convictionAddress);
  await validatePolymarketWalletDeployment(input.polymarketWalletType, ownerAddress, funderAddress);

  const conflictingAccount = await prisma.polymarketAccount.findUnique({
    where: { funderAddress },
    select: { userId: true },
  });

  if (conflictingAccount && conflictingAccount.userId !== input.userId) {
    throw new AppError("This Polymarket account is already linked to another Conviction user", {
      code: "POLYMARKET_ACCOUNT_LINK_CONFLICT",
      statusCode: 409,
    });
  }

  return createChallenge({
    purpose: PolymarketChallengePurpose.LINK,
    userId: input.userId,
    accountId: null,
    convictionAddress,
    convictionChainId: input.convictionChainId,
    ownerAddress,
    funderAddress,
    walletType: input.polymarketWalletType,
  });
}

export async function completePolymarketAccountLink(input: CompleteLinkInput) {
  const challenge = await getUsableChallenge(
    input.challengeId,
    input.userId,
    PolymarketChallengePurpose.LINK,
  );

  await verifyChallengeSignatures(challenge, input.convictionSignature, input.polymarketSignature);
  const walletOwnershipVerified = await validatePolymarketWalletDeployment(
    challenge.polymarketWalletType,
    challenge.polymarketOwnerAddress,
    challenge.polymarketFunderAddress,
  );

  const consumed = await prisma.polymarketLinkChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  if (consumed.count !== 1) {
    throw challengeUsedError();
  }

  const credentialsCiphertext = input.credentials
    ? sealPolymarketCredentials(input.credentials)
    : null;

  const account = await prisma.polymarketAccount.upsert({
    where: { funderAddress: challenge.polymarketFunderAddress },
    create: {
      userId: input.userId,
      ownerAddress: challenge.polymarketOwnerAddress,
      funderAddress: challenge.polymarketFunderAddress,
      walletType: challenge.polymarketWalletType,
      chainId: polygonChainId,
      status: PolymarketAccountStatus.LINKED,
      credentialsCiphertext,
      credentialsVerifiedAt: null,
      linkedAt: new Date(),
      walletVerifiedAt: walletOwnershipVerified ? new Date() : null,
    },
    update: {
      ownerAddress: challenge.polymarketOwnerAddress,
      walletType: challenge.polymarketWalletType,
      status: PolymarketAccountStatus.LINKED,
      credentialsCiphertext,
      credentialsVerifiedAt: null,
      linkedAt: new Date(),
      walletVerifiedAt: walletOwnershipVerified ? new Date() : null,
      disconnectedAt: null,
      lastSyncError: null,
    },
  });

  try {
    return await syncPolymarketAccount(input.userId, account.id);
  } catch (error) {
    await prisma.polymarketAccount.update({
      where: { id: account.id },
      data: {
        status: PolymarketAccountStatus.ERROR,
        lastSyncError: getErrorMessage(error),
      },
    });

    return getPolymarketAccount(input.userId, account.id);
  }
}

export async function createPolymarketAuthChallenge(input: CreatePolymarketAuthChallengeInput) {
  const ownerAddress = normalizeAddress(input.ownerAddress, "Polymarket owner");
  const activeAccounts = await prisma.polymarketAccount.findMany({
    where: {
      ownerAddress,
      status: { not: PolymarketAccountStatus.DISCONNECTED },
    },
    orderBy: { updatedAt: "desc" },
  });

  const linkedAccount = activeAccounts[0] ?? null;
  const existingSocialAccount = await prisma.socialAccount.findUnique({
    where: {
      platform_platformUserId: {
        platform: SocialPlatform.WEB,
        platformUserId: ownerAddress,
      },
    },
  });

  const resolvedUserId = resolvePolymarketAuthUserId(
    activeAccounts.map((account) => account.userId),
    existingSocialAccount?.userId ?? null,
  );

  if (!linkedAccount) {
    const disconnectedAccount = await prisma.polymarketAccount.findFirst({
      where: { ownerAddress, status: PolymarketAccountStatus.DISCONNECTED },
      orderBy: { updatedAt: "desc" },
    });

    if (disconnectedAccount) {
      throw new AppError(
        "This Polymarket connection was disconnected. Sign in another way and re-link it first",
        {
          code: "POLYMARKET_AUTH_DISCONNECTED",
          statusCode: 403,
        },
      );
    }
  }

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + challengeLifetimeMs);
  const nonce = randomBytes(32).toString("hex");
  const funderAddress = linkedAccount?.funderAddress ?? ownerAddress;
  const walletType = linkedAccount?.walletType ?? PolymarketWalletType.EOA;
  const message = buildPolymarketAuthMessage({
    ownerAddress,
    funderAddress,
    walletType,
    nonce,
    issuedAt,
    expiresAt,
  });

  await prisma.polymarketLinkChallenge.deleteMany({
    where: {
      purpose: PolymarketChallengePurpose.AUTH,
      polymarketOwnerAddress: ownerAddress,
      expiresAt: { lte: issuedAt },
    },
  });

  const challenge = await prisma.polymarketLinkChallenge.create({
    data: {
      userId: resolvedUserId,
      accountId: linkedAccount?.id ?? null,
      purpose: PolymarketChallengePurpose.AUTH,
      convictionAddress: ownerAddress,
      convictionChainId: polygonChainId,
      polymarketOwnerAddress: ownerAddress,
      polymarketFunderAddress: funderAddress,
      polymarketWalletType: walletType,
      nonce,
      message,
      expiresAt,
    },
  });

  return {
    id: challenge.id,
    message: challenge.message,
    ownerAddress,
    funderAddress,
    walletType,
    expiresAt: challenge.expiresAt.toISOString(),
  };
}

export async function completePolymarketAuth(input: CompletePolymarketAuthInput) {
  const challenge = await prisma.polymarketLinkChallenge.findFirst({
    where: {
      id: input.challengeId,
      purpose: PolymarketChallengePurpose.AUTH,
    },
  });

  if (!challenge) {
    throw new AppError("Polymarket authentication challenge not found", {
      code: "POLYMARKET_AUTH_CHALLENGE_NOT_FOUND",
      statusCode: 404,
    });
  }

  assertPolymarketChallengeState(challenge);
  const signatureValid = await verifyOwnershipSignature({
    address: challenge.polymarketOwnerAddress,
    chainId: polygonChainId,
    message: challenge.message,
    signature: input.signature,
  });

  if (!signatureValid) {
    throw new AppError("Polymarket owner signature is invalid", {
      code: "INVALID_POLYMARKET_AUTH_SIGNATURE",
      statusCode: 401,
    });
  }

  const account = challenge.accountId
    ? await prisma.polymarketAccount.findFirst({
        where: {
          id: challenge.accountId,
          ownerAddress: challenge.polymarketOwnerAddress,
          funderAddress: challenge.polymarketFunderAddress,
          status: { not: PolymarketAccountStatus.DISCONNECTED },
        },
        include: { positions: { orderBy: { updatedAt: "desc" } } },
      })
    : null;

  if (challenge.accountId && !account) {
    throw new AppError("The linked Polymarket account changed during authentication", {
      code: "POLYMARKET_AUTH_ACCOUNT_CHANGED",
      statusCode: 409,
    });
  }

  let authenticatedAccount = account;

  if (!authenticatedAccount) {
    const candidateAccount = await prisma.polymarketAccount.findUnique({
      where: { funderAddress: challenge.polymarketFunderAddress },
      include: { positions: { orderBy: { updatedAt: "desc" } } },
    });

    if (candidateAccount?.status === PolymarketAccountStatus.DISCONNECTED) {
      throw new AppError("This Polymarket connection must be re-linked before sign-in", {
        code: "POLYMARKET_AUTH_DISCONNECTED",
        statusCode: 403,
      });
    }

    if (
      candidateAccount &&
      (candidateAccount.ownerAddress !== challenge.polymarketOwnerAddress ||
        (challenge.userId && candidateAccount.userId !== challenge.userId))
    ) {
      throw new AppError("This Polymarket account belongs to another Conviction user", {
        code: "POLYMARKET_AUTH_IDENTITY_CONFLICT",
        statusCode: 409,
      });
    }

    authenticatedAccount = candidateAccount;
  }

  if (
    authenticatedAccount &&
    challenge.userId &&
    authenticatedAccount.userId !== challenge.userId
  ) {
    throw new AppError("Polymarket and Conviction wallet identities do not match", {
      code: "POLYMARKET_AUTH_IDENTITY_CONFLICT",
      statusCode: 409,
    });
  }

  const consumed = await prisma.polymarketLinkChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  if (consumed.count !== 1) throw challengeUsedError();

  const sessionInput = {
    platform: SocialPlatform.WEB,
    platformUserId: challenge.polymarketOwnerAddress,
    username: shortWalletLabel(challenge.polymarketOwnerAddress),
    displayName: "Polymarket " + shortWalletLabel(challenge.polymarketOwnerAddress),
    profileUrl: null,
    authProvider: AuthProvider.POLYMARKET_WALLET,
    source: "POLYMARKET_SIGN_IN",
    metadata: {
      funderAddress: challenge.polymarketFunderAddress,
      walletType: challenge.polymarketWalletType,
    },
  };
  const session = authenticatedAccount
    ? await attachVerifiedSocialAccountToUser(authenticatedAccount.userId, sessionInput)
    : challenge.userId
      ? await attachVerifiedSocialAccountToUser(challenge.userId, sessionInput)
      : await createOrFetchSocialAccount(sessionInput);

  if (!authenticatedAccount) {
    authenticatedAccount = await prisma.polymarketAccount.create({
      data: {
        userId: session.user.id,
        ownerAddress: challenge.polymarketOwnerAddress,
        funderAddress: challenge.polymarketFunderAddress,
        walletType: PolymarketWalletType.EOA,
        chainId: polygonChainId,
        status: PolymarketAccountStatus.LINKED,
        linkedAt: new Date(),
        walletVerifiedAt: new Date(),
      },
      include: { positions: true },
    });
  }

  return {
    session,
    account: normalizePolymarketAccount(authenticatedAccount),
  };
}

export async function listPolymarketAccounts(userId: string) {
  await ensureUserExists(userId);
  const accounts = await prisma.polymarketAccount.findMany({
    where: { userId },
    include: { positions: { orderBy: { updatedAt: "desc" } } },
    orderBy: { updatedAt: "desc" },
  });

  return accounts.map(normalizePolymarketAccount);
}

export async function getPolymarketAccount(userId: string, accountId: string) {
  const account = await prisma.polymarketAccount.findFirst({
    where: { id: accountId, userId },
    include: { positions: { orderBy: { updatedAt: "desc" } } },
  });

  if (!account) {
    throw new AppError("Linked Polymarket account not found", {
      code: "POLYMARKET_ACCOUNT_NOT_FOUND",
      statusCode: 404,
    });
  }

  return normalizePolymarketAccount(account);
}

export async function createPolymarketUnlinkChallenge(input: {
  userId: string;
  accountId: string;
  convictionAddress: string;
  convictionChainId: number;
}) {
  const account = await prisma.polymarketAccount.findFirst({
    where: { id: input.accountId, userId: input.userId },
  });

  if (!account) {
    throw new AppError("Linked Polymarket account not found", {
      code: "POLYMARKET_ACCOUNT_NOT_FOUND",
      statusCode: 404,
    });
  }

  if (account.status === PolymarketAccountStatus.DISCONNECTED) {
    throw new AppError("Polymarket account is already disconnected", {
      code: "POLYMARKET_ACCOUNT_ALREADY_DISCONNECTED",
      statusCode: 409,
    });
  }

  const convictionAddress = normalizeAddress(input.convictionAddress, "Conviction wallet");
  validateConvictionChain(input.convictionChainId);
  await ensureConvictionAddressBelongsToUser(input.userId, convictionAddress);

  return createChallenge({
    purpose: PolymarketChallengePurpose.UNLINK,
    userId: input.userId,
    accountId: account.id,
    convictionAddress,
    convictionChainId: input.convictionChainId,
    ownerAddress: account.ownerAddress,
    funderAddress: account.funderAddress,
    walletType: account.walletType,
  });
}

export async function completePolymarketAccountUnlink(input: CompleteUnlinkInput) {
  const challenge = await getUsableChallenge(
    input.challengeId,
    input.userId,
    PolymarketChallengePurpose.UNLINK,
    input.accountId,
  );

  await verifyChallengeSignatures(challenge, input.convictionSignature, input.polymarketSignature);

  const consumed = await prisma.polymarketLinkChallenge.updateMany({
    where: { id: challenge.id, accountId: input.accountId, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  if (consumed.count !== 1) {
    throw challengeUsedError();
  }

  const account = await prisma.polymarketAccount.update({
    where: { id: input.accountId },
    data: {
      status: PolymarketAccountStatus.DISCONNECTED,
      credentialsCiphertext: null,
      credentialsVerifiedAt: null,
      disconnectedAt: new Date(),
    },
    include: { positions: { orderBy: { updatedAt: "desc" } } },
  });

  return normalizePolymarketAccount(account);
}

export async function syncPolymarketAccount(userId: string, accountId: string) {
  const account = await prisma.polymarketAccount.findFirst({
    where: {
      id: accountId,
      userId,
      status: { not: PolymarketAccountStatus.DISCONNECTED },
    },
  });

  if (!account) {
    throw new AppError("Active linked Polymarket account not found", {
      code: "POLYMARKET_ACCOUNT_NOT_FOUND",
      statusCode: 404,
    });
  }

  try {
    const [openPositions, closedPositions] = await Promise.all([
      fetchPolymarketPositions("/positions", account.funderAddress),
      fetchPolymarketPositions("/closed-positions", account.funderAddress),
    ]);
    const syncedAt = new Date();
    const openAssetIds = openPositions.map((position) => position.asset);

    await prisma.polymarketPositionSnapshot.deleteMany({
      where: {
        accountId,
        state: PolymarketPositionState.OPEN,
        ...(openAssetIds.length > 0 ? { assetId: { notIn: openAssetIds } } : {}),
      },
    });

    for (const position of openPositions) {
      await upsertPositionSnapshot(accountId, PolymarketPositionState.OPEN, position, syncedAt);
    }

    for (const position of closedPositions) {
      await upsertPositionSnapshot(accountId, PolymarketPositionState.CLOSED, position, syncedAt);
    }

    const refreshed = await prisma.polymarketAccount.update({
      where: { id: accountId },
      data: {
        status: account.credentialsVerifiedAt
          ? PolymarketAccountStatus.READY
          : PolymarketAccountStatus.LINKED,
        lastSyncedAt: syncedAt,
        lastSyncError: null,
      },
      include: { positions: { orderBy: { updatedAt: "desc" } } },
    });

    return normalizePolymarketAccount(refreshed);
  } catch (error) {
    await prisma.polymarketAccount.update({
      where: { id: accountId },
      data: {
        status: PolymarketAccountStatus.ERROR,
        lastSyncError: getErrorMessage(error),
      },
    });

    throw new AppError("Polymarket account synchronization failed", {
      code: "POLYMARKET_ACCOUNT_SYNC_FAILED",
      statusCode: 502,
    });
  }
}

function sealPolymarketCredentials(credentials: PolymarketCredentials) {
  const normalized = {
    apiKey: credentials.apiKey.trim(),
    secret: credentials.secret.trim(),
    passphrase: credentials.passphrase.trim(),
  };

  if (!normalized.apiKey || !normalized.secret || !normalized.passphrase) {
    throw new AppError("Complete Polymarket CLOB credentials are required", {
      code: "INVALID_POLYMARKET_CREDENTIALS",
      statusCode: 422,
    });
  }

  if (!env.polymarketCredentialsEncryptionKey) {
    throw new AppError("Polymarket credential encryption is not configured", {
      code: "POLYMARKET_CREDENTIAL_ENCRYPTION_UNAVAILABLE",
      statusCode: 503,
    });
  }

  return encryptJson(normalized, env.polymarketCredentialsEncryptionKey);
}

async function createChallenge(input: {
  purpose: PolymarketChallengePurpose;
  userId: string;
  accountId: string | null;
  convictionAddress: string;
  convictionChainId: number;
  ownerAddress: string;
  funderAddress: string;
  walletType: PolymarketWalletType;
}) {
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + challengeLifetimeMs);
  const message = buildPolymarketAccountMessage({
    purpose: input.purpose,
    userId: input.userId,
    convictionAddress: input.convictionAddress,
    convictionChainId: input.convictionChainId,
    polymarketOwnerAddress: input.ownerAddress,
    polymarketFunderAddress: input.funderAddress,
    polymarketWalletType: input.walletType,
    nonce,
    expiresAt,
  });

  await prisma.polymarketLinkChallenge.deleteMany({
    where: {
      userId: input.userId,
      purpose: input.purpose,
      accountId: input.accountId,
      consumedAt: null,
    },
  });

  const challenge = await prisma.polymarketLinkChallenge.create({
    data: {
      userId: input.userId,
      accountId: input.accountId,
      purpose: input.purpose,
      convictionAddress: input.convictionAddress,
      convictionChainId: input.convictionChainId,
      polymarketOwnerAddress: input.ownerAddress,
      polymarketFunderAddress: input.funderAddress,
      polymarketWalletType: input.walletType,
      nonce,
      message,
      expiresAt,
    },
  });

  return {
    id: challenge.id,
    purpose: challenge.purpose,
    message: challenge.message,
    expiresAt: challenge.expiresAt.toISOString(),
  };
}

async function getUsableChallenge(
  challengeId: string,
  userId: string,
  purpose: PolymarketChallengePurpose,
  accountId?: string,
) {
  const challenge = await prisma.polymarketLinkChallenge.findFirst({
    where: {
      id: challengeId,
      userId,
      purpose,
      ...(accountId ? { accountId } : {}),
    },
  });

  if (!challenge) {
    throw new AppError("Polymarket account challenge not found", {
      code: "POLYMARKET_CHALLENGE_NOT_FOUND",
      statusCode: 404,
    });
  }

  assertPolymarketChallengeState(challenge);

  return challenge;
}

export function assertPolymarketChallengeState(
  challenge: { consumedAt: Date | null; expiresAt: Date },
  now = new Date(),
) {
  if (challenge.consumedAt) throw challengeUsedError();

  if (challenge.expiresAt.getTime() <= now.getTime()) {
    throw new AppError("Polymarket account challenge expired", {
      code: "POLYMARKET_CHALLENGE_EXPIRED",
      statusCode: 410,
    });
  }
}

async function verifyChallengeSignatures(
  challenge: Awaited<ReturnType<typeof getUsableChallenge>>,
  convictionSignature: string,
  polymarketSignature?: string | null,
) {
  const convictionValid = await verifyOwnershipSignature({
    address: challenge.convictionAddress,
    chainId: challenge.convictionChainId,
    message: challenge.message,
    signature: convictionSignature,
  });

  if (!convictionValid) {
    throw new AppError("Conviction wallet signature is invalid", {
      code: "INVALID_CONVICTION_SIGNATURE",
      statusCode: 401,
    });
  }

  const sameOwner =
    challenge.convictionAddress.toLowerCase() === challenge.polymarketOwnerAddress.toLowerCase();
  const ownerSignature = polymarketSignature?.trim() || (sameOwner ? convictionSignature : "");

  if (!ownerSignature) {
    throw new AppError("Polymarket owner signature is required", {
      code: "POLYMARKET_SIGNATURE_REQUIRED",
      statusCode: 422,
    });
  }

  const ownerValid = await verifyOwnershipSignature({
    address: challenge.polymarketOwnerAddress,
    chainId: polygonChainId,
    message: challenge.message,
    signature: ownerSignature,
  });

  if (!ownerValid) {
    throw new AppError("Polymarket owner signature is invalid", {
      code: "INVALID_POLYMARKET_SIGNATURE",
      statusCode: 401,
    });
  }
}

async function verifyOwnershipSignature(input: {
  address: string;
  chainId: number;
  message: string;
  signature: string;
}) {
  const signature = normalizeSignature(input.signature);
  const address = getAddress(input.address) as Address;

  try {
    if (await verifyEoaMessage({ address, message: input.message, signature })) {
      return true;
    }
  } catch {
    // Contract-wallet signatures require chain-aware verification below.
  }

  const runtime = getVerificationRuntime(input.chainId);
  const client = createPublicClient({
    chain: runtime.chain,
    transport: http(runtime.rpcUrl),
  });

  try {
    return await client.verifyMessage({
      address,
      message: input.message,
      signature,
    });
  } catch {
    return false;
  }
}

function getVerificationRuntime(chainId: number) {
  switch (chainId) {
    case base.id:
      return { chain: base, rpcUrl: env.baseRpcUrl };
    case baseSepolia.id:
      return { chain: baseSepolia, rpcUrl: env.baseSepoliaRpcUrl };
    case sepolia.id:
      return { chain: sepolia, rpcUrl: env.ethereumSepoliaRpcUrl };
    case arbitrumSepolia.id:
      return { chain: arbitrumSepolia, rpcUrl: env.arbitrumSepoliaRpcUrl };
    case polygon.id:
      return { chain: polygon, rpcUrl: env.polygonRpcUrl };
    default:
      throw new AppError("Unsupported signature verification chain", {
        code: "UNSUPPORTED_SIGNATURE_CHAIN",
        statusCode: 422,
      });
  }
}

async function ensureConvictionAddressBelongsToUser(userId: string, address: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { socialAccounts: true },
  });

  if (!user) {
    throw new AppError("User not found", {
      code: "USER_NOT_FOUND",
      statusCode: 404,
    });
  }

  const ownsAddress = user.socialAccounts.some(
    (account) =>
      account.platform === "WEB" &&
      account.platformUserId.trim().toLowerCase() === address.toLowerCase(),
  );

  if (!ownsAddress) {
    throw new AppError("Conviction wallet does not belong to this user", {
      code: "CONVICTION_ACCOUNT_MISMATCH",
      statusCode: 403,
    });
  }
}

async function ensureUserExists(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });

  if (!user) {
    throw new AppError("User not found", {
      code: "USER_NOT_FOUND",
      statusCode: 404,
    });
  }
}

function validateConvictionChain(chainId: number) {
  if (!supportedConvictionChainIds.has(chainId)) {
    throw new AppError("Conviction wallet chain is not supported for signature verification", {
      code: "UNSUPPORTED_SIGNATURE_CHAIN",
      statusCode: 422,
    });
  }
}

function validateWalletAddressRelationship(
  walletType: PolymarketWalletType,
  ownerAddress: string,
  funderAddress: string,
) {
  if (walletType === PolymarketWalletType.EOA && ownerAddress !== funderAddress) {
    throw new AppError("EOA Polymarket accounts must use the same owner and funder address", {
      code: "INVALID_POLYMARKET_FUNDER",
      statusCode: 422,
    });
  }
}

async function validatePolymarketWalletDeployment(
  walletType: PolymarketWalletType,
  ownerAddress: string,
  funderAddress: string,
) {
  const client = createPublicClient({
    chain: polygon,
    transport: http(env.polygonRpcUrl),
  });
  const code = await client.getCode({ address: getAddress(funderAddress) });
  const isContract = Boolean(code && code !== "0x");

  if (walletType === PolymarketWalletType.EOA) {
    if (isContract) {
      throw new AppError("EOA Polymarket funder cannot be a contract", {
        code: "POLYMARKET_WALLET_TYPE_MISMATCH",
        statusCode: 422,
      });
    }

    return true;
  }

  if (!isContract) {
    throw new AppError("Polymarket smart-wallet funder is not deployed on Polygon", {
      code: "POLYMARKET_FUNDER_NOT_DEPLOYED",
      statusCode: 422,
    });
  }

  if (walletType === PolymarketWalletType.GNOSIS_SAFE) {
    try {
      const owners = await client.readContract({
        address: getAddress(funderAddress),
        abi: [
          {
            type: "function",
            name: "getOwners",
            stateMutability: "view",
            inputs: [],
            outputs: [{ type: "address[]" }],
          },
        ],
        functionName: "getOwners",
      });
      const ownerFound = owners.some((owner) => owner.toLowerCase() === ownerAddress.toLowerCase());

      if (!ownerFound) {
        throw new AppError("Polymarket owner is not an owner of this Safe", {
          code: "POLYMARKET_OWNER_MISMATCH",
          statusCode: 403,
        });
      }
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError("Polymarket Safe ownership could not be verified", {
        code: "POLYMARKET_SAFE_VERIFICATION_FAILED",
        statusCode: 422,
      });
    }

    return true;
  }

  return false;
}

function normalizeAddress(value: string, label: string) {
  const trimmed = value.trim();

  if (!isAddress(trimmed)) {
    throw new AppError(label + " must be a valid EVM address", {
      code: "INVALID_EVM_ADDRESS",
      statusCode: 422,
    });
  }

  return getAddress(trimmed).toLowerCase();
}

function shortWalletLabel(address: string) {
  return address.slice(0, 6) + "..." + address.slice(-4);
}

function normalizeSignature(value: string) {
  const trimmed = value.trim();

  if (!/^0x[a-f0-9]+$/i.test(trimmed) || trimmed.length < 130) {
    throw new AppError("Wallet signature is invalid", {
      code: "INVALID_WALLET_SIGNATURE",
      statusCode: 422,
    });
  }

  return trimmed as Hex;
}

function challengeUsedError() {
  return new AppError("Polymarket account challenge has already been used", {
    code: "POLYMARKET_CHALLENGE_USED",
    statusCode: 409,
  });
}

async function fetchPolymarketPositions(pathname: string, funderAddress: string) {
  const url = new URL(pathname, env.polymarketDataApiUrl);
  url.searchParams.set("user", funderAddress);
  url.searchParams.set("limit", "500");

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error("Polymarket Data API returned HTTP " + response.status);
  }

  const payload = await response.json();
  const parsed = polymarketPositionListSchema.safeParse(payload);

  if (!parsed.success) {
    throw new Error("Polymarket position response did not match the expected shape");
  }

  return parsed.data;
}

async function upsertPositionSnapshot(
  accountId: string,
  state: PolymarketPositionState,
  position: z.infer<typeof polymarketPositionSchema>,
  syncedAt: Date,
) {
  const data = {
    conditionId: normalizeNullableText(position.conditionId),
    outcome: normalizeNullableText(position.outcome),
    size: normalizeNullableText(position.size),
    averagePrice: normalizeNullableText(position.avgPrice),
    initialValue: normalizeNullableText(position.initialValue),
    currentValue: normalizeNullableText(position.currentValue),
    cashPnl: normalizeNullableText(position.cashPnl),
    realizedPnl: normalizeNullableText(position.realizedPnl),
    currentPrice: normalizeNullableText(position.curPrice),
    title: normalizeNullableText(position.title),
    slug: normalizeNullableText(position.slug),
    iconUrl: normalizeNullableText(position.icon),
    eventSlug: normalizeNullableText(position.eventSlug),
    endDate: parseNullableDate(position.endDate),
    redeemable: position.redeemable ?? false,
    mergeable: position.mergeable ?? false,
    raw: toJsonValue(position),
    lastSyncedAt: syncedAt,
  };

  await prisma.polymarketPositionSnapshot.upsert({
    where: {
      accountId_assetId_state: {
        accountId,
        assetId: position.asset,
        state,
      },
    },
    create: {
      accountId,
      assetId: position.asset,
      state,
      ...data,
    },
    update: data,
  });
}

function normalizePolymarketAccount(
  account: Prisma.PolymarketAccountGetPayload<{
    include: { positions: true };
  }>,
) {
  return {
    id: account.id,
    userId: account.userId,
    ownerAddress: account.ownerAddress,
    funderAddress: account.funderAddress,
    walletType: account.walletType,
    chainId: account.chainId,
    status: account.status,
    credentialsConfigured: Boolean(account.credentialsCiphertext),
    credentialsVerifiedAt: account.credentialsVerifiedAt?.toISOString() ?? null,
    profileName: account.profileName,
    profileUrl: account.profileUrl,
    linkedAt: account.linkedAt.toISOString(),
    walletVerifiedAt: account.walletVerifiedAt?.toISOString() ?? null,
    disconnectedAt: account.disconnectedAt?.toISOString() ?? null,
    lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
    lastSyncError: account.lastSyncError,
    positions: account.positions.map((position) => ({
      id: position.id,
      assetId: position.assetId,
      conditionId: position.conditionId,
      state: position.state,
      outcome: position.outcome,
      size: position.size,
      averagePrice: position.averagePrice,
      initialValue: position.initialValue,
      currentValue: position.currentValue,
      cashPnl: position.cashPnl,
      realizedPnl: position.realizedPnl,
      currentPrice: position.currentPrice,
      title: position.title,
      slug: position.slug,
      iconUrl: position.iconUrl,
      eventSlug: position.eventSlug,
      endDate: position.endDate?.toISOString() ?? null,
      redeemable: position.redeemable,
      mergeable: position.mergeable,
      lastSyncedAt: position.lastSyncedAt.toISOString(),
    })),
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

function normalizeNullableText(value: string | number | null | undefined) {
  if (value === null || typeof value === "undefined") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function parseNullableDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown Polymarket sync error";
}
