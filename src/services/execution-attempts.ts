import type { CopyTrade, ExecutionAttempt, Position } from "@prisma/client";
import {
  CopyTradeStatus,
  ExecutionAttemptStatus,
  ExecutionAttemptTarget,
  PositionStatus,
  Prisma,
} from "@prisma/client";

import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { getExecutionReadiness } from "./execution.js";

export type NormalizedExecutionAttempt = {
  id: string;
  targetType: ExecutionAttempt["targetType"];
  positionId: string | null;
  copyTradeId: string | null;
  adapterId: string;
  executionMode: ExecutionAttempt["executionMode"];
  chainId: number | null;
  walletAddress: string | null;
  requestedQuantity: string | null;
  leverageMultiplier: string | null;
  marginCollateral: string | null;
  notionalAmount: string | null;
  borrowedAmount: string | null;
  observedMarketPrice: string | null;
  status: ExecutionAttempt["status"];
  failureCode: string | null;
  failureMessage: string | null;
  externalOrderId: string | null;
  chainTransactionHash: string | null;
  requestPayload: Prisma.JsonValue | null;
  responsePayload: Prisma.JsonValue | null;
  createdAt: string;
  updatedAt: string;
};

export async function startPositionExecution(positionId: string) {
  const position = await prisma.position.findUnique({ where: { id: positionId } });

  if (!position) {
    throw new AppError("Position not found", {
      code: "POSITION_NOT_FOUND",
      statusCode: 404,
    });
  }

  assertPendingPosition(position);

  const readiness = getExecutionReadiness({
    chainId: position.chainId,
    executionAdapterId: position.executionAdapterId,
    executionMode: position.executionMode,
  });
  const attempt = await prisma.executionAttempt.create({
    data: {
      targetType: ExecutionAttemptTarget.POSITION,
      positionId: position.id,
      copyTradeId: null,
      adapterId: readiness.adapterId,
      executionMode: position.executionMode,
      chainId: position.chainId,
      walletAddress: position.walletAddress,
      requestedQuantity: position.quantity,
      leverageMultiplier: position.leverageMultiplier,
      marginCollateral: position.marginCollateral,
      notionalAmount: position.notionalAmount,
      borrowedAmount: position.borrowedAmount,
      observedMarketPrice: position.observedMarketPrice,
      status: readiness.ready ? ExecutionAttemptStatus.CREATED : ExecutionAttemptStatus.BLOCKED,
      failureCode: readiness.ready ? null : readiness.code,
      failureMessage: readiness.ready ? null : readiness.message,
      externalOrderId: null,
      chainTransactionHash: null,
      requestPayload: buildPositionAttemptPayload(position),
      responsePayload: readiness.ready
        ? Prisma.JsonNull
        : buildBlockedPayload(readiness.code, readiness.message),
    },
  });

  return normalizeExecutionAttempt(attempt);
}

export async function startCopyTradeExecution(copyTradeId: string) {
  const copyTrade = await prisma.copyTrade.findUnique({ where: { id: copyTradeId } });

  if (!copyTrade) {
    throw new AppError("Copy intent not found", {
      code: "COPY_TRADE_NOT_FOUND",
      statusCode: 404,
    });
  }

  assertPendingCopyTrade(copyTrade);

  const readiness = getExecutionReadiness({
    chainId: copyTrade.chainId,
    executionAdapterId: copyTrade.executionAdapterId,
    executionMode: copyTrade.executionMode,
  });
  const attempt = await prisma.executionAttempt.create({
    data: {
      targetType: ExecutionAttemptTarget.COPY_TRADE,
      positionId: null,
      copyTradeId: copyTrade.id,
      adapterId: readiness.adapterId,
      executionMode: copyTrade.executionMode,
      chainId: copyTrade.chainId,
      walletAddress: copyTrade.walletAddress,
      requestedQuantity: copyTrade.requestedQuantity,
      leverageMultiplier: copyTrade.leverageMultiplier,
      marginCollateral: copyTrade.marginCollateral,
      notionalAmount: copyTrade.notionalAmount,
      borrowedAmount: copyTrade.borrowedAmount,
      observedMarketPrice: copyTrade.observedMarketPrice,
      status: readiness.ready ? ExecutionAttemptStatus.CREATED : ExecutionAttemptStatus.BLOCKED,
      failureCode: readiness.ready ? null : readiness.code,
      failureMessage: readiness.ready ? null : readiness.message,
      externalOrderId: null,
      chainTransactionHash: null,
      requestPayload: buildCopyTradeAttemptPayload(copyTrade),
      responsePayload: readiness.ready
        ? Prisma.JsonNull
        : buildBlockedPayload(readiness.code, readiness.message),
    },
  });

  return normalizeExecutionAttempt(attempt);
}

export async function getExecutionAttemptById(id: string) {
  const attempt = await prisma.executionAttempt.findUnique({ where: { id } });

  return attempt ? normalizeExecutionAttempt(attempt) : null;
}

export async function listPositionExecutionAttempts(positionId: string) {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
    select: { id: true },
  });

  if (!position) {
    throw new AppError("Position not found", {
      code: "POSITION_NOT_FOUND",
      statusCode: 404,
    });
  }

  const attempts = await prisma.executionAttempt.findMany({
    where: { positionId },
    orderBy: { createdAt: "desc" },
  });

  return attempts.map(normalizeExecutionAttempt);
}

export async function listCopyTradeExecutionAttempts(copyTradeId: string) {
  const copyTrade = await prisma.copyTrade.findUnique({
    where: { id: copyTradeId },
    select: { id: true },
  });

  if (!copyTrade) {
    throw new AppError("Copy intent not found", {
      code: "COPY_TRADE_NOT_FOUND",
      statusCode: 404,
    });
  }

  const attempts = await prisma.executionAttempt.findMany({
    where: { copyTradeId },
    orderBy: { createdAt: "desc" },
  });

  return attempts.map(normalizeExecutionAttempt);
}

export function normalizeExecutionAttempt(attempt: ExecutionAttempt): NormalizedExecutionAttempt {
  return {
    id: attempt.id,
    targetType: attempt.targetType,
    positionId: attempt.positionId,
    copyTradeId: attempt.copyTradeId,
    adapterId: attempt.adapterId,
    executionMode: attempt.executionMode,
    chainId: attempt.chainId,
    walletAddress: attempt.walletAddress,
    requestedQuantity: attempt.requestedQuantity?.toString() ?? null,
    leverageMultiplier: attempt.leverageMultiplier?.toString() ?? null,
    marginCollateral: attempt.marginCollateral?.toString() ?? null,
    notionalAmount: attempt.notionalAmount?.toString() ?? null,
    borrowedAmount: attempt.borrowedAmount?.toString() ?? null,
    observedMarketPrice: attempt.observedMarketPrice?.toString() ?? null,
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

function assertPendingPosition(position: Position) {
  if (position.status !== PositionStatus.PENDING_EXECUTION) {
    throw new AppError("Position is not pending execution", {
      code: "POSITION_NOT_PENDING_EXECUTION",
      statusCode: 422,
      details: {
        positionId: position.id,
        status: position.status,
      },
    });
  }
}

function assertPendingCopyTrade(copyTrade: CopyTrade) {
  if (copyTrade.status !== CopyTradeStatus.PENDING_EXECUTION) {
    throw new AppError("Copy intent is not pending execution", {
      code: "COPY_TRADE_NOT_PENDING_EXECUTION",
      statusCode: 422,
      details: {
        copyTradeId: copyTrade.id,
        status: copyTrade.status,
      },
    });
  }
}

function buildPositionAttemptPayload(position: Position): Prisma.JsonObject {
  return {
    targetType: ExecutionAttemptTarget.POSITION,
    positionId: position.id,
    userId: position.userId,
    marketId: position.marketId,
    side: position.side,
    quantity: position.quantity.toString(),
    executionMode: position.executionMode,
    leverageMultiplier: position.leverageMultiplier?.toString() ?? null,
    marginCollateral: position.marginCollateral?.toString() ?? null,
    notionalAmount: position.notionalAmount?.toString() ?? null,
    borrowedAmount: position.borrowedAmount?.toString() ?? null,
    chainId: position.chainId,
    walletAddress: position.walletAddress,
    observedMarketPrice: position.observedMarketPrice?.toString() ?? null,
    observedMarketPriceSource: position.observedMarketPriceSource,
    observedMarketPriceAt: position.observedMarketPriceAt?.toISOString() ?? null,
  };
}

function buildCopyTradeAttemptPayload(copyTrade: CopyTrade): Prisma.JsonObject {
  return {
    targetType: ExecutionAttemptTarget.COPY_TRADE,
    copyTradeId: copyTrade.id,
    followerId: copyTrade.followerId,
    sourcePositionId: copyTrade.sourcePositionId,
    sourceSignalId: copyTrade.sourceSignalId,
    requestedQuantity: copyTrade.requestedQuantity.toString(),
    executionMode: copyTrade.executionMode,
    leverageMultiplier: copyTrade.leverageMultiplier?.toString() ?? null,
    marginCollateral: copyTrade.marginCollateral?.toString() ?? null,
    notionalAmount: copyTrade.notionalAmount?.toString() ?? null,
    borrowedAmount: copyTrade.borrowedAmount?.toString() ?? null,
    chainId: copyTrade.chainId,
    walletAddress: copyTrade.walletAddress,
    observedMarketPrice: copyTrade.observedMarketPrice?.toString() ?? null,
    observedMarketPriceSource: copyTrade.observedMarketPriceSource,
    observedMarketPriceAt: copyTrade.observedMarketPriceAt?.toISOString() ?? null,
  };
}

function buildBlockedPayload(code: string, message: string): Prisma.JsonObject {
  return {
    blocked: true,
    code,
    message,
  };
}
