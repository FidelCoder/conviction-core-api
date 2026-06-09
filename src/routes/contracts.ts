import type { FastifyInstance } from "fastify";
import { ContractRole, ContractTransactionStatus } from "@prisma/client";

import { sendSuccess } from "../lib/responses.js";
import {
  getActiveContractConfig,
  listContractDeployments,
  listPositionContractTransactions,
  prepareCollateralApprovalTransaction,
  prepareCollateralDepositTransaction,
  prepareMarginIntentTransaction,
  updateContractTransaction,
  upsertContractDeployment,
} from "../services/contracts.js";

type ContractConfigBody = {
  chainId: number;
  role: ContractRole;
  address: string;
  label?: string | null;
  tokenSymbol?: string | null;
  tokenDecimals?: number | null;
  isActive?: boolean;
};

type PrepareMarginIntentBody = {
  positionId: string;
  maxSlippageBps?: number;
  deadline?: number;
};

type ContractTransactionParams = {
  id: string;
};

type PositionContractTransactionsParams = {
  positionId: string;
};

type UpdateContractTransactionBody = {
  transactionHash?: string | null;
  status?: ContractTransactionStatus;
  responsePayload?: unknown;
};

export async function registerContractRoutes(app: FastifyInstance) {
  app.get("/contracts/config", async (_request, reply) => {
    const deployments = await listContractDeployments();

    return sendSuccess(reply, { deployments });
  });

  app.get<{ Querystring: { chainId?: number } }>(
    "/contracts/config/active",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            chainId: { type: "number" },
          },
        },
      },
    },
    async (request, reply) => {
      const deployments = await getActiveContractConfig(request.query.chainId ?? null);

      return sendSuccess(reply, { deployments });
    },
  );

  app.post<{ Body: ContractConfigBody }>(
    "/contracts/config",
    {
      schema: {
        body: {
          type: "object",
          required: ["chainId", "role", "address"],
          properties: {
            chainId: { type: "number" },
            role: { type: "string", enum: Object.values(ContractRole) },
            address: { type: "string" },
            label: { type: "string" },
            tokenSymbol: { type: "string" },
            tokenDecimals: { type: "number" },
            isActive: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const deployment = await upsertContractDeployment(request.body);

      return sendSuccess(reply, { deployment }, 201);
    },
  );

  app.post<{ Body: Pick<PrepareMarginIntentBody, "positionId"> }>(
    "/contracts/collateral-approvals/prepare",
    {
      schema: {
        body: {
          type: "object",
          required: ["positionId"],
          properties: {
            positionId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const prepared = await prepareCollateralApprovalTransaction(request.body);

      return sendSuccess(reply, prepared, 201);
    },
  );

  app.post<{ Body: Pick<PrepareMarginIntentBody, "positionId"> }>(
    "/contracts/deposits/prepare",
    {
      schema: {
        body: {
          type: "object",
          required: ["positionId"],
          properties: {
            positionId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const prepared = await prepareCollateralDepositTransaction(request.body);

      return sendSuccess(reply, prepared, 201);
    },
  );

  app.post<{ Body: PrepareMarginIntentBody }>(
    "/contracts/margin-intents/prepare",
    {
      schema: {
        body: {
          type: "object",
          required: ["positionId"],
          properties: {
            positionId: { type: "string", minLength: 1 },
            maxSlippageBps: { type: "number" },
            deadline: { type: "number" },
          },
        },
      },
    },
    async (request, reply) => {
      const prepared = await prepareMarginIntentTransaction(request.body);

      return sendSuccess(reply, prepared, 201);
    },
  );

  app.patch<{ Params: ContractTransactionParams; Body: UpdateContractTransactionBody }>(
    "/contracts/transactions/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          properties: {
            transactionHash: { type: "string" },
            status: { type: "string", enum: Object.values(ContractTransactionStatus) },
            responsePayload: {},
          },
        },
      },
    },
    async (request, reply) => {
      const transaction = await updateContractTransaction(request.params.id, {
        transactionHash: request.body.transactionHash,
        status: request.body.status,
        responsePayload: request.body.responsePayload as never,
      });

      return sendSuccess(reply, { transaction });
    },
  );

  app.get<{ Params: PositionContractTransactionsParams }>(
    "/positions/:positionId/contract-transactions",
    {
      schema: {
        params: {
          type: "object",
          required: ["positionId"],
          properties: { positionId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const transactions = await listPositionContractTransactions(request.params.positionId);

      return sendSuccess(reply, { transactions });
    },
  );
}
