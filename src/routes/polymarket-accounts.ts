import { PolymarketWalletType } from "@prisma/client";
import type { FastifyInstance } from "fastify";

import { sendSuccess } from "../lib/responses.js";
import {
  completePolymarketAccountLink,
  completePolymarketAccountUnlink,
  completePolymarketAuth,
  createPolymarketLinkChallenge,
  createPolymarketAuthChallenge,
  createPolymarketUnlinkChallenge,
  listPolymarketAccounts,
  syncPolymarketAccount,
  type PolymarketCredentials,
} from "../services/polymarket-accounts.js";

type UserParams = { userId: string };
type AccountParams = { userId: string; accountId: string };

type ChallengeBody = {
  convictionAddress: string;
  convictionChainId: number;
  polymarketOwnerAddress: string;
  polymarketFunderAddress: string;
  polymarketWalletType: PolymarketWalletType;
};

type CompleteLinkBody = {
  challengeId: string;
  convictionSignature: string;
  polymarketSignature?: string | null;
  credentials?: PolymarketCredentials | null;
};

type UnlinkChallengeBody = {
  convictionAddress: string;
  convictionChainId: number;
};

type CompleteUnlinkBody = {
  challengeId: string;
  convictionSignature: string;
  polymarketSignature?: string | null;
};

type AuthChallengeBody = {
  ownerAddress: string;
};

type AuthSessionBody = {
  challengeId: string;
  signature: string;
};

const walletTypeValues = Object.values(PolymarketWalletType);
const addressSchema = { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" };
const signatureSchema = { type: "string", pattern: "^0x[a-fA-F0-9]+$", minLength: 130 };

export async function registerPolymarketAccountRoutes(app: FastifyInstance) {
  app.post<{ Body: AuthChallengeBody }>(
    "/auth/polymarket/challenges",
    {
      schema: {
        body: {
          type: "object",
          required: ["ownerAddress"],
          additionalProperties: false,
          properties: {
            ownerAddress: addressSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const challenge = await createPolymarketAuthChallenge(request.body);

      return sendSuccess(reply, { challenge }, 201);
    },
  );

  app.post<{ Body: AuthSessionBody }>(
    "/auth/polymarket/sessions",
    {
      schema: {
        body: {
          type: "object",
          required: ["challengeId", "signature"],
          additionalProperties: false,
          properties: {
            challengeId: { type: "string", minLength: 1 },
            signature: signatureSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const authentication = await completePolymarketAuth(request.body);

      return sendSuccess(reply, authentication, 201);
    },
  );

  app.get<{ Params: UserParams }>("/users/:userId/polymarket/accounts", async (request, reply) => {
    const accounts = await listPolymarketAccounts(request.params.userId);

    return sendSuccess(reply, { accounts });
  });

  app.post<{ Params: UserParams; Body: ChallengeBody }>(
    "/users/:userId/polymarket/link-challenges",
    {
      schema: {
        body: {
          type: "object",
          required: [
            "convictionAddress",
            "convictionChainId",
            "polymarketOwnerAddress",
            "polymarketFunderAddress",
            "polymarketWalletType",
          ],
          additionalProperties: false,
          properties: {
            convictionAddress: addressSchema,
            convictionChainId: { type: "integer", minimum: 1 },
            polymarketOwnerAddress: addressSchema,
            polymarketFunderAddress: addressSchema,
            polymarketWalletType: { type: "string", enum: walletTypeValues },
          },
        },
      },
    },
    async (request, reply) => {
      const challenge = await createPolymarketLinkChallenge({
        userId: request.params.userId,
        ...request.body,
      });

      return sendSuccess(reply, { challenge }, 201);
    },
  );

  app.post<{ Params: UserParams; Body: CompleteLinkBody }>(
    "/users/:userId/polymarket/accounts",
    {
      schema: {
        body: {
          type: "object",
          required: ["challengeId", "convictionSignature"],
          additionalProperties: false,
          properties: {
            challengeId: { type: "string", minLength: 1 },
            convictionSignature: signatureSchema,
            polymarketSignature: { ...signatureSchema, nullable: true },
            credentials: {
              type: "object",
              nullable: true,
              additionalProperties: false,
              required: ["apiKey", "secret", "passphrase"],
              properties: {
                apiKey: { type: "string", minLength: 1, maxLength: 512 },
                secret: { type: "string", minLength: 1, maxLength: 512 },
                passphrase: { type: "string", minLength: 1, maxLength: 512 },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await completePolymarketAccountLink({
        userId: request.params.userId,
        ...request.body,
      });

      return sendSuccess(reply, { account }, 201);
    },
  );

  app.post<{ Params: AccountParams }>(
    "/users/:userId/polymarket/accounts/:accountId/sync",
    async (request, reply) => {
      const account = await syncPolymarketAccount(request.params.userId, request.params.accountId);

      return sendSuccess(reply, { account });
    },
  );

  app.post<{ Params: AccountParams; Body: UnlinkChallengeBody }>(
    "/users/:userId/polymarket/accounts/:accountId/unlink-challenges",
    {
      schema: {
        body: {
          type: "object",
          required: ["convictionAddress", "convictionChainId"],
          additionalProperties: false,
          properties: {
            convictionAddress: addressSchema,
            convictionChainId: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const challenge = await createPolymarketUnlinkChallenge({
        userId: request.params.userId,
        accountId: request.params.accountId,
        ...request.body,
      });

      return sendSuccess(reply, { challenge }, 201);
    },
  );

  app.delete<{ Params: AccountParams; Body: CompleteUnlinkBody }>(
    "/users/:userId/polymarket/accounts/:accountId",
    {
      schema: {
        body: {
          type: "object",
          required: ["challengeId", "convictionSignature"],
          additionalProperties: false,
          properties: {
            challengeId: { type: "string", minLength: 1 },
            convictionSignature: signatureSchema,
            polymarketSignature: { ...signatureSchema, nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await completePolymarketAccountUnlink({
        userId: request.params.userId,
        accountId: request.params.accountId,
        ...request.body,
      });

      return sendSuccess(reply, { account });
    },
  );
}
