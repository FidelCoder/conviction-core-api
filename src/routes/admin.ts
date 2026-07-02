import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

import { env } from "../config/index.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { sendSuccess } from "../lib/responses.js";
import { getAdminUsageAnalytics } from "../services/analytics.js";

const generatedHandlePatterns = [
  /^wallet[a-f0-9]{6,}\.viction$/i,
  /^trader[a-f0-9]{4,}\.viction$/i,
  /^user[a-f0-9]{4,}\.viction$/i,
  /^guest\.viction$/i,
  /^trader\.viction$/i,
  /^yourname\.viction$/i,
];

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get("/admin/analytics", async (request, reply) => {
    assertAdminAuthorized(request.headers.authorization);

    const analytics = await getAdminUsageAnalytics();

    return sendSuccess(reply, analytics);
  });

  app.get("/admin/fallback-profiles", async (request, reply) => {
    assertAdminAuthorized(request.headers.authorization);

    const profiles = await prisma.traderProfile.findMany({
      include: {
        user: {
          include: {
            socialAccounts: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    const fallbackProfiles = profiles
      .filter((profile) => !isClaimedProfileHandle(profile.handle))
      .map((profile) => {
        const wallets = profile.user.socialAccounts
          .filter((account) => account.platform === "WEB")
          .map((account) => ({
            type: account.platformUserId.startsWith("ton:") ? "TON" : "EVM",
            address: account.platformUserId,
          }));

        return {
          userId: profile.userId,
          traderProfileId: profile.id,
          handle: profile.handle,
          displayName: profile.user.displayName,
          reason: getFallbackReason(profile.handle),
          wallets,
          createdAt: profile.createdAt.toISOString(),
          updatedAt: profile.updatedAt.toISOString(),
        };
      });

    return sendSuccess(reply, {
      count: fallbackProfiles.length,
      fallbackProfiles,
    });
  });
}

function assertAdminAuthorized(authorization: string | undefined) {
  if (!env.adminDashboardToken) {
    throw new AppError("Admin dashboard token is not configured", {
      code: "ADMIN_TOKEN_MISSING",
      statusCode: 503,
    });
  }

  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";

  if (!isSameToken(token, env.adminDashboardToken)) {
    throw new AppError("Admin dashboard is not authorized", {
      code: "ADMIN_UNAUTHORIZED",
      statusCode: 401,
    });
  }
}

function isClaimedProfileHandle(handle: string | null | undefined) {
  const normalized = handle?.trim().toLowerCase() ?? "";

  if (!normalized.endsWith(".viction")) return false;
  if (generatedHandlePatterns.some((pattern) => pattern.test(normalized))) return false;

  return normalized.slice(0, -".viction".length).length >= 2;
}

function getFallbackReason(handle: string | null | undefined) {
  const normalized = handle?.trim().toLowerCase() ?? "";

  if (!normalized.endsWith(".viction")) return "invalid_handle";
  if (generatedHandlePatterns.some((pattern) => pattern.test(normalized))) return "generated_handle";

  return "incomplete_claim";
}

function isSameToken(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
