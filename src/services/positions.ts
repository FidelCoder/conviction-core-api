import type { CopyTrade, Market, Position } from "@prisma/client";
import {
  CopyTradeStatus,
  ExecutionMode,
  PositionSide,
  PositionStatus,
  Prisma,
} from "@prisma/client";

import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { buildExecutionIntentMetadata, type ExecutionIntentInput } from "./execution.js";

const decimalInputPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/;

type MarketPriceSnapshot = Pick<
  Market,
  "lastTradePrice" | "bestAsk" | "bestBid" | "syncedAt" | "updatedAt"
>;

export type CreatePositionInput = ExecutionIntentInput & {
  userId: string;
  marketId: string;
  side: PositionSide;
  quantity: string;
};

export type CreateCopyTradeInput = ExecutionIntentInput & {
  followerId: string;
  sourcePositionId: string;
  requestedQuantity: string;
  sourceSignalId?: string | null;
};

export type NormalizedPosition = {
  id: string;
  userId: string;
  marketId: string;
  side: Position["side"];
  quantity: string;
  averageEntryPrice: string | null;
  observedMarketPrice: string | null;
  observedMarketPriceSource: string | null;
  observedMarketPriceAt: string | null;
  chainId: number | null;
  walletAddress: string | null;
  executionMode: ExecutionMode;
  leverageMultiplier: string | null;
  marginCollateral: string | null;
  notionalAmount: string | null;
  borrowedAmount: string | null;
  executionAdapterId: string | null;
  chainTransactionHash: string | null;
  idempotencyKey: string | null;
  status: Position["status"];
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NormalizedCopyTrade = {
  id: string;
  followerId: string;
  sourcePositionId: string;
  sourceSignalId: string | null;
  requestedQuantity: string;
  executedQuantity: string | null;
  executionPrice: string | null;
  observedMarketPrice: string | null;
  observedMarketPriceSource: string | null;
  observedMarketPriceAt: string | null;
  chainId: number | null;
  walletAddress: string | null;
  executionMode: ExecutionMode;
  leverageMultiplier: string | null;
  marginCollateral: string | null;
  notionalAmount: string | null;
  borrowedAmount: string | null;
  executionAdapterId: string | null;
  chainTransactionHash: string | null;
  idempotencyKey: string | null;
  resultingPositionId: string | null;
  status: CopyTrade["status"];
  externalOrderId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function createPosition(input: CreatePositionInput) {
  const quantity = parsePositiveDecimal(input.quantity, "quantity");
  const [user, market] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.userId } }),
    prisma.market.findUnique({ where: { id: input.marketId } }),
  ]);

  if (!user) {
    throw new AppError("User not found", {
      code: "USER_NOT_FOUND",
      statusCode: 404,
    });
  }

  if (!market) {
    throw new AppError("Market not found", {
      code: "MARKET_NOT_FOUND",
      statusCode: 404,
    });
  }

  const observedPrice = getObservedMarketPrice(market);
  const executionMetadata = buildExecutionIntentMetadata(input);
  const position = await prisma.position.create({
    data: {
      userId: input.userId,
      marketId: input.marketId,
      side: input.side,
      quantity,
      averageEntryPrice: null,
      observedMarketPrice: observedPrice.price,
      observedMarketPriceSource: observedPrice.source,
      observedMarketPriceAt: observedPrice.observedAt,
      ...executionMetadata,
      status: PositionStatus.PENDING_EXECUTION,
      openedAt: null,
    },
  });

  return normalizePosition(position);
}

export async function getPositionById(id: string) {
  const position = await prisma.position.findUnique({
    where: { id },
  });

  return position ? normalizePosition(position) : null;
}

export async function listUserPositions(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new AppError("User not found", {
      code: "USER_NOT_FOUND",
      statusCode: 404,
    });
  }

  const positions = await prisma.position.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  return positions.map(normalizePosition);
}

export async function listTraderProfilePositions(traderProfileId: string) {
  const traderProfile = await prisma.traderProfile.findUnique({
    where: { id: traderProfileId },
    select: { userId: true },
  });

  if (!traderProfile) {
    throw new AppError("Trader profile not found", {
      code: "TRADER_PROFILE_NOT_FOUND",
      statusCode: 404,
    });
  }

  const positions = await prisma.position.findMany({
    where: { userId: traderProfile.userId },
    orderBy: { createdAt: "desc" },
  });

  return positions.map(normalizePosition);
}

export async function createCopyTrade(input: CreateCopyTradeInput) {
  const requestedQuantity = parsePositiveDecimal(input.requestedQuantity, "requestedQuantity");
  const [follower, sourcePosition] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.followerId } }),
    prisma.position.findUnique({
      where: { id: input.sourcePositionId },
      include: { market: true },
    }),
  ]);

  if (!follower) {
    throw new AppError("Follower not found", {
      code: "FOLLOWER_NOT_FOUND",
      statusCode: 404,
    });
  }

  if (!sourcePosition) {
    throw new AppError("Source position not found", {
      code: "SOURCE_POSITION_NOT_FOUND",
      statusCode: 404,
    });
  }

  const sourceSignalId = input.sourceSignalId ?? null;

  if (sourceSignalId) {
    const sourceSignal = await prisma.tradeSignal.findUnique({
      where: { id: sourceSignalId },
      select: { marketId: true },
    });

    if (!sourceSignal) {
      throw new AppError("Trade signal not found", {
        code: "TRADE_SIGNAL_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (sourceSignal.marketId !== sourcePosition.marketId) {
      throw new AppError("Trade signal market does not match source position market", {
        code: "COPY_TRADE_SIGNAL_MARKET_MISMATCH",
        statusCode: 422,
      });
    }
  }

  const observedPrice = getObservedMarketPrice(sourcePosition.market);
  const executionMetadata = buildExecutionIntentMetadata(input);
  const copyTrade = await prisma.copyTrade.create({
    data: {
      followerId: input.followerId,
      sourcePositionId: input.sourcePositionId,
      sourceSignalId,
      requestedQuantity,
      executedQuantity: null,
      executionPrice: null,
      observedMarketPrice: observedPrice.price,
      observedMarketPriceSource: observedPrice.source,
      observedMarketPriceAt: observedPrice.observedAt,
      ...executionMetadata,
      resultingPositionId: null,
      status: CopyTradeStatus.PENDING_EXECUTION,
    },
  });

  return normalizeCopyTrade(copyTrade);
}

export async function listPositionCopyTrades(positionId: string) {
  const position = await prisma.position.findUnique({ where: { id: positionId } });

  if (!position) {
    throw new AppError("Position not found", {
      code: "POSITION_NOT_FOUND",
      statusCode: 404,
    });
  }

  const copyTrades = await prisma.copyTrade.findMany({
    where: { sourcePositionId: positionId },
    orderBy: { createdAt: "desc" },
  });

  return copyTrades.map(normalizeCopyTrade);
}

export function normalizePosition(position: Position): NormalizedPosition {
  return {
    id: position.id,
    userId: position.userId,
    marketId: position.marketId,
    side: position.side,
    quantity: position.quantity.toString(),
    averageEntryPrice: position.averageEntryPrice?.toString() ?? null,
    observedMarketPrice: position.observedMarketPrice?.toString() ?? null,
    observedMarketPriceSource: position.observedMarketPriceSource,
    observedMarketPriceAt: position.observedMarketPriceAt?.toISOString() ?? null,
    chainId: position.chainId,
    walletAddress: position.walletAddress,
    executionMode: position.executionMode,
    leverageMultiplier: position.leverageMultiplier?.toString() ?? null,
    marginCollateral: position.marginCollateral?.toString() ?? null,
    notionalAmount: position.notionalAmount?.toString() ?? null,
    borrowedAmount: position.borrowedAmount?.toString() ?? null,
    executionAdapterId: position.executionAdapterId,
    chainTransactionHash: position.chainTransactionHash,
    idempotencyKey: position.idempotencyKey,
    status: position.status,
    openedAt: position.openedAt?.toISOString() ?? null,
    closedAt: position.closedAt?.toISOString() ?? null,
    createdAt: position.createdAt.toISOString(),
    updatedAt: position.updatedAt.toISOString(),
  };
}

export function normalizeCopyTrade(copyTrade: CopyTrade): NormalizedCopyTrade {
  return {
    id: copyTrade.id,
    followerId: copyTrade.followerId,
    sourcePositionId: copyTrade.sourcePositionId,
    sourceSignalId: copyTrade.sourceSignalId,
    requestedQuantity: copyTrade.requestedQuantity.toString(),
    executedQuantity: copyTrade.executedQuantity?.toString() ?? null,
    executionPrice: copyTrade.executionPrice?.toString() ?? null,
    observedMarketPrice: copyTrade.observedMarketPrice?.toString() ?? null,
    observedMarketPriceSource: copyTrade.observedMarketPriceSource,
    observedMarketPriceAt: copyTrade.observedMarketPriceAt?.toISOString() ?? null,
    chainId: copyTrade.chainId,
    walletAddress: copyTrade.walletAddress,
    executionMode: copyTrade.executionMode,
    leverageMultiplier: copyTrade.leverageMultiplier?.toString() ?? null,
    marginCollateral: copyTrade.marginCollateral?.toString() ?? null,
    notionalAmount: copyTrade.notionalAmount?.toString() ?? null,
    borrowedAmount: copyTrade.borrowedAmount?.toString() ?? null,
    executionAdapterId: copyTrade.executionAdapterId,
    chainTransactionHash: copyTrade.chainTransactionHash,
    idempotencyKey: copyTrade.idempotencyKey,
    resultingPositionId: copyTrade.resultingPositionId,
    status: copyTrade.status,
    externalOrderId: copyTrade.externalOrderId,
    errorMessage: copyTrade.errorMessage,
    createdAt: copyTrade.createdAt.toISOString(),
    updatedAt: copyTrade.updatedAt.toISOString(),
  };
}

function getObservedMarketPrice(market: MarketPriceSnapshot) {
  const observedAt = market.syncedAt ?? market.updatedAt;

  if (market.lastTradePrice !== null) {
    return {
      price: market.lastTradePrice,
      source: "MARKET_LAST_TRADE_PRICE",
      observedAt,
    };
  }

  if (market.bestAsk !== null) {
    return {
      price: market.bestAsk,
      source: "MARKET_BEST_ASK",
      observedAt,
    };
  }

  if (market.bestBid !== null) {
    return {
      price: market.bestBid,
      source: "MARKET_BEST_BID",
      observedAt,
    };
  }

  return {
    price: null,
    source: null,
    observedAt: null,
  };
}

function parsePositiveDecimal(value: string, fieldName: string) {
  if (!decimalInputPattern.test(value)) {
    throw new AppError("Decimal amount must be a positive string with up to 8 decimal places", {
      code: "INVALID_DECIMAL_AMOUNT",
      statusCode: 422,
      details: { field: fieldName },
    });
  }

  const decimal = new Prisma.Decimal(value);

  if (decimal.lte(0)) {
    throw new AppError("Decimal amount must be greater than zero", {
      code: "INVALID_DECIMAL_AMOUNT",
      statusCode: 422,
      details: { field: fieldName },
    });
  }

  return decimal;
}
