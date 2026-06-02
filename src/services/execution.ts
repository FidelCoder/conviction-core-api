import type { ExecutionAttempt } from "@prisma/client";
import { ExecutionAttemptStatus, ExecutionMode, ExecutionTargetType } from "@prisma/client";

import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

export const MAX_PENDING_MARGIN_LEVERAGE = 10;

const supportedIntentChains = [
  {
    chainId: 8453,
    chainName: "Base",
    ecosystem: "EVM" as const,
    network: "mainnet" as const,
    spotExecutionEnabled: false,
    marginExecutionEnabled: false,
    contractRequiredForMargin: true,
    plannedAdapters: ["Polymarket CLOB adapter", "Margin vault adapter"],
  },
  {
    chainId: 84532,
    chainName: "Base Sepolia",
    ecosystem: "EVM" as const,
    network: "testnet" as const,
    spotExecutionEnabled: false,
    marginExecutionEnabled: false,
    contractRequiredForMargin: true,
    plannedAdapters: ["Testnet margin vault adapter", "Execution adapter smoke tests"],
  },
];

export function getExecutionCapabilities() {
  return {
    evmOnly: true,
    architecture: "INTENT_FIRST_MULTICHAIN_MARGIN_LAYER",
    spotExecutionEnabled: false,
    marginExecutionEnabled: false,
    leverageEnabled: false,
    marginIntentsEnabled: true,
    leverageRequiresContracts: true,
    maxPendingMarginLeverage: MAX_PENDING_MARGIN_LEVERAGE,
    activeAdapters: [] as string[],
    contractLayer: {
      status: env.convictionVaultAddress ? "CONFIGURED_NOT_ENABLED" : "PLANNED",
      vaultAddress: env.convictionVaultAddress,
      executionAdapterAddress: env.convictionExecutionAdapterAddress,
      marginVaultRequired: true,
      contractRepoPath: "contracts/src/ConvictionVault.sol",
      notes: [
        "Contracts are scaffolded in this API repo.",
        "Configured contract addresses do not enable execution by themselves.",
        "Margin execution remains disabled until deployment, liquidity, monitoring, and adapters are live.",
      ],
    },
    recommendation:
      "Record real user intents now. Execute only after contracts, vault liquidity, liquidation rules, and provider adapters are live.",
    chains: supportedIntentChains,
  };
}

export function isSupportedExecutionIntentChain(chainId: number) {
  return supportedIntentChains.some((chain) => chain.chainId === chainId);
}

export async function startPositionExecution(positionId: string) {
  const position = await prisma.position.findUnique({ where: { id: positionId } });

  if (!position) {
    throw new AppError("Position not found", {
      code: "POSITION_NOT_FOUND",
      statusCode: 404,
    });
  }

  const failure = getExecutionBlockReason(position.executionMode);
  const executionAttempt = await prisma.executionAttempt.create({
    data: {
      targetType: ExecutionTargetType.POSITION,
      positionId: position.id,
      adapterId: "NO_ACTIVE_EXECUTION_ADAPTER",
      executionMode: position.executionMode,
      chainId: position.chainId,
      walletAddress: position.walletAddress,
      requestedQuantity: position.quantity,
      leverageMultiplier: position.leverageMultiplier,
      marginCollateral: position.marginCollateral,
      notionalAmount: position.notionalAmount,
      borrowedAmount: position.borrowedAmount,
      observedMarketPrice: position.observedMarketPrice,
      status: ExecutionAttemptStatus.BLOCKED,
      failureCode: failure.code,
      failureMessage: failure.message,
      externalOrderId: null,
      chainTransactionHash: null,
      requestPayload: {
        positionId: position.id,
        idempotencyKey: position.idempotencyKey,
      },
      responsePayload: {
        executed: false,
        reason: failure.code,
      },
    },
  });

  return normalizeExecutionAttempt(executionAttempt);
}

export function normalizeExecutionAttempt(attempt: ExecutionAttempt) {
  return {
    id: attempt.id,
    targetType: attempt.targetType,
    positionId: attempt.positionId,
    copyTradeId: attempt.copyTradeId,
    adapterId: attempt.adapterId,
    executionMode: attempt.executionMode,
    chainId: attempt.chainId,
    walletAddress: attempt.walletAddress,
    requestedQuantity: attempt.requestedQuantity,
    leverageMultiplier: attempt.leverageMultiplier,
    marginCollateral: attempt.marginCollateral,
    notionalAmount: attempt.notionalAmount,
    borrowedAmount: attempt.borrowedAmount,
    observedMarketPrice: attempt.observedMarketPrice,
    status: attempt.status,
    failureCode: attempt.failureCode,
    failureMessage: attempt.failureMessage,
    externalOrderId: attempt.externalOrderId,
    chainTransactionHash: attempt.chainTransactionHash,
    requestPayload: attempt.requestPayload,
    responsePayload: attempt.responsePayload,
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString(),
  };
}

function getExecutionBlockReason(executionMode: ExecutionMode) {
  if (executionMode === ExecutionMode.MARGIN) {
    return {
      code: "MARGIN_EXECUTION_NOT_ENABLED",
      message:
        "Margin execution is blocked until contracts, vault liquidity, liquidation rules, and execution adapters are live.",
    };
  }

  return {
    code: "SPOT_EXECUTION_NOT_ENABLED",
    message: "Spot execution is blocked until a real execution adapter is live.",
  };
}
