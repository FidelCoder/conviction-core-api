import { SocialPlatform } from "@prisma/client";
import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/errors.js";
import { sendSuccess } from "../lib/responses.js";
import { prisma } from "../lib/prisma.js";
import {
  createOrFetchSocialAccount,
  getTraderProfileById,
  upsertTraderProfile,
} from "../services/users.js";

type SocialAccountBody = {
  platform: SocialPlatform;
  platformUserId: string;
  username?: string | null;
  displayName?: string | null;
  profileUrl?: string | null;
  metadata?: unknown;
};

type TraderProfileBody = {
  userId: string;
  handle: string;
  bio?: string | null;
  avatarUrl?: string | null;
};

type TraderProfileParams = {
  id: string;
};

const platformValues = Object.values(SocialPlatform);

export async function registerUserRoutes(app: FastifyInstance) {
  app.post<{ Body: SocialAccountBody }>(
    "/social-accounts",
    {
      schema: {
        body: {
          type: "object",
          required: ["platform", "platformUserId"],
          additionalProperties: false,
          properties: {
            platform: { type: "string", enum: platformValues },
            platformUserId: { type: "string", minLength: 1, maxLength: 128 },
            username: { type: "string", maxLength: 128, nullable: true },
            displayName: { type: "string", maxLength: 160, nullable: true },
            profileUrl: { type: "string", maxLength: 512, nullable: true },
            metadata: { type: "object", additionalProperties: true, nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const session = await createOrFetchSocialAccount(request.body);

      return sendSuccess(reply, session, 201);
    },
  );

  app.post<{ Body: TraderProfileBody }>(
    "/trader-profiles",
    {
      schema: {
        body: {
          type: "object",
          required: ["userId", "handle"],
          additionalProperties: false,
          properties: {
            userId: { type: "string", minLength: 1 },
            handle: { type: "string", minLength: 2, maxLength: 48 },
            bio: { type: "string", maxLength: 280, nullable: true },
            avatarUrl: { type: "string", maxLength: 1024, nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const traderProfile = await upsertTraderProfile(request.body);

      return sendSuccess(reply, { traderProfile }, 201);
    },
  );

  app.patch<{ Params: TraderProfileParams; Body: { email: string } }>(
    "/users/:id/email",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["email"],
          additionalProperties: false,
          properties: {
            email: { type: "string", minLength: 3, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await prisma.user.update({
        where: { id: request.params.id },
        data: { email: request.body.email },
      });

      return sendSuccess(reply, { email: user.email });
    },
  );

  app.get<{ Params: TraderProfileParams }>(
    "/trader-profiles/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const traderProfile = await getTraderProfileById(request.params.id);

      if (!traderProfile) {
        throw new AppError("Trader profile not found", {
          code: "TRADER_PROFILE_NOT_FOUND",
          statusCode: 404,
        });
      }

      return sendSuccess(reply, { traderProfile });
    },
  );
}
