import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/errors.js";
import { sendSuccess } from "../lib/responses.js";
import {
  addSignalBookmark,
  addSignalReaction,
  createSignalReply,
  getSocialFeedItem,
  listSignalReplies,
  listSocialFeed,
  removeSignalBookmark,
  removeSignalReaction,
} from "../services/social.js";

type SocialFeedQuery = {
  limit?: number;
  marketId?: string;
  traderProfileId?: string;
  viewerUserId?: string;
};

type SignalParams = {
  signalId: string;
};

type SignalUserParams = SignalParams & {
  userId: string;
};

type ReplyQuery = {
  limit?: number;
};

type CreateReplyBody = {
  authorUserId: string;
  body: string;
};

type UserActionBody = {
  userId: string;
};

export async function registerSocialRoutes(app: FastifyInstance) {
  app.get<{ Querystring: SocialFeedQuery }>(
    "/social/feed",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            marketId: { type: "string", minLength: 1 },
            traderProfileId: { type: "string", minLength: 1 },
            viewerUserId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const feed = await listSocialFeed(request.query);

      return sendSuccess(reply, { feed });
    },
  );

  app.get<{ Params: SignalParams; Querystring: SocialFeedQuery }>(
    "/signals/:signalId/social",
    {
      schema: {
        params: signalParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            viewerUserId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const item = await getSocialFeedItem(request.params.signalId, request.query.viewerUserId);

      if (!item) {
        throw new AppError("Trade signal not found", {
          code: "TRADE_SIGNAL_NOT_FOUND",
          statusCode: 404,
        });
      }

      return sendSuccess(reply, { item });
    },
  );

  app.get<{ Params: SignalParams; Querystring: ReplyQuery }>(
    "/signals/:signalId/replies",
    {
      schema: {
        params: signalParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const replies = await listSignalReplies(request.params.signalId, request.query.limit);

      return sendSuccess(reply, { replies });
    },
  );

  app.post<{ Params: SignalParams; Body: CreateReplyBody }>(
    "/signals/:signalId/replies",
    {
      schema: {
        params: signalParamsSchema,
        body: {
          type: "object",
          required: ["authorUserId", "body"],
          additionalProperties: false,
          properties: {
            authorUserId: { type: "string", minLength: 1 },
            body: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const replyRecord = await createSignalReply({
        signalId: request.params.signalId,
        authorUserId: request.body.authorUserId,
        body: request.body.body,
      });

      return sendSuccess(reply, { reply: replyRecord }, 201);
    },
  );

  app.post<{ Params: SignalParams; Body: UserActionBody }>(
    "/signals/:signalId/reactions",
    {
      schema: {
        params: signalParamsSchema,
        body: userActionBodySchema,
      },
    },
    async (request, reply) => {
      const result = await addSignalReaction({
        signalId: request.params.signalId,
        userId: request.body.userId,
      });

      return sendSuccess(reply, result, 201);
    },
  );

  app.delete<{ Params: SignalUserParams }>(
    "/signals/:signalId/reactions/:userId",
    {
      schema: {
        params: signalUserParamsSchema,
      },
    },
    async (request, reply) => {
      const result = await removeSignalReaction({
        signalId: request.params.signalId,
        userId: request.params.userId,
      });

      return sendSuccess(reply, result);
    },
  );

  app.post<{ Params: SignalParams; Body: UserActionBody }>(
    "/signals/:signalId/bookmarks",
    {
      schema: {
        params: signalParamsSchema,
        body: userActionBodySchema,
      },
    },
    async (request, reply) => {
      const result = await addSignalBookmark({
        signalId: request.params.signalId,
        userId: request.body.userId,
      });

      return sendSuccess(reply, result, 201);
    },
  );

  app.delete<{ Params: SignalUserParams }>(
    "/signals/:signalId/bookmarks/:userId",
    {
      schema: {
        params: signalUserParamsSchema,
      },
    },
    async (request, reply) => {
      const result = await removeSignalBookmark({
        signalId: request.params.signalId,
        userId: request.params.userId,
      });

      return sendSuccess(reply, result);
    },
  );
}

const signalParamsSchema = {
  type: "object",
  required: ["signalId"],
  properties: {
    signalId: { type: "string", minLength: 1 },
  },
};

const signalUserParamsSchema = {
  type: "object",
  required: ["signalId", "userId"],
  properties: {
    signalId: { type: "string", minLength: 1 },
    userId: { type: "string", minLength: 1 },
  },
};

const userActionBodySchema = {
  type: "object",
  required: ["userId"],
  additionalProperties: false,
  properties: {
    userId: { type: "string", minLength: 1 },
  },
};
