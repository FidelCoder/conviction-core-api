import { createHash } from "node:crypto";
import {
  ExecutionMode,
  MarginMarketPolicyStatus,
  MarketSource,
  PositionStatus,
} from "@prisma/client";

import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import {
  getPolymarketRiskSnapshot,
  PolymarketMarketDataError,
  type PolymarketRiskSnapshot,
} from "../providers/polymarket/orderbook.js";
import {
  DEFAULT_MAX_LEVERAGE_BPS,
  HARD_MAX_LEVERAGE_BPS,
  evaluateMarginRisk,
  formatFixed,
  parseFixed,
  type MarginRiskDecision,
  type MarginSide,
} from "./margin-risk.js";

export type MarginMarketPolicyInput = {
  approvedBy?: string | null;
  closeBufferSeconds: number;
  earliestResolutionAt: string;
  expectedNegativeRisk: boolean;
  feeBps: number;
  maintenanceMarginBps: number;
  mandatoryCloseAt: string;
  maxAccountBorrowAssets: string;
  maxCategoryBorrowAssets: string;
  maxLeverageBps?: number;
  maxMarketBorrowAssets: string;
  maxPriceAgeSeconds: number;
  maxSpreadBps: number;
  maxTwapDeviationBps: number;
  maxVaultBorrowAssets: string;
  minimumDepthAssets: string;
  notes?: string | null;
  status: "DRAFT" | "APPROVED" | "PAUSED";
  threeXApproved?: boolean;
};

export type CreateMarginQuoteInput = {
  collateralAssets: string;
  leverageBps: number;
  marketId: string;
  side: MarginSide;
  userId: string;
};

const polygonChainId = 137;
const conditionIdPattern = /^0x[a-fA-F0-9]{64}$/;
const tokenIdPattern = /^\d+$/;
const supportedTickSizes = new Set(["0.1", "0.01", "0.001", "0.0001"]);

export async function getMarginMarketPolicy(marketId: string) {
  const policy = await prisma.marginMarketPolicy.findUnique({ where: { marketId } });
  return policy ? normalizePolicy(policy) : null;
}

export async function upsertMarginMarketPolicy(marketId: string, input: MarginMarketPolicyInput) {
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market) {
    throw new AppError("Market not found", {
      code: "MARKET_NOT_FOUND",
      statusCode: 404,
    });
  }
  if (market.source !== MarketSource.POLYMARKET) {
    throw new AppError("Production margin policies currently require a Polymarket market", {
      code: "UNSUPPORTED_MARGIN_MARKET_SOURCE",
      statusCode: 422,
    });
  }

  const validated = validatePolicyInput(market, input);
  const policy = await prisma.marginMarketPolicy.upsert({
    where: { marketId },
    create: {
      marketId,
      ...validated,
    },
    update: validated,
  });

  return normalizePolicy(policy);
}

export async function createMarginRiskQuote(input: CreateMarginQuoteInput) {
  const [market, user] = await Promise.all([
    prisma.market.findUnique({
      where: { id: input.marketId },
      include: { marginRiskPolicy: true },
    }),
    prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } }),
  ]);

  if (!market) {
    throw new AppError("Market not found", {
      code: "MARKET_NOT_FOUND",
      statusCode: 404,
    });
  }
  if (!user) {
    throw new AppError("User not found", {
      code: "USER_NOT_FOUND",
      statusCode: 404,
    });
  }
  if (!market.marginRiskPolicy) {
    return {
      approved: false,
      quote: null,
      quoteId: null,
      rejections: [
        {
          code: "MARKET_NOT_APPROVED",
          message: "This market has no manually approved production margin policy.",
        },
      ],
    } satisfies MarginRiskDecision & { quoteId: string | null };
  }

  const nowMs = Date.now();
  const tokenId = input.side === "YES" ? market.yesTokenId : market.noTokenId;
  let snapshot: PolymarketRiskSnapshot;
  let providerOperational = true;

  try {
    snapshot = tokenId
      ? await getPolymarketRiskSnapshot(tokenId, nowMs)
      : unavailableSnapshot(tokenId ?? "", market);
  } catch (error) {
    if (!(error instanceof PolymarketMarketDataError)) throw error;
    providerOperational = false;
    snapshot = unavailableSnapshot(tokenId ?? "", market);
  }

  const exposure = await getCurrentPolygonExposure(input.userId, market.id, market.category);
  const policy = market.marginRiskPolicy;
  const decision = evaluateMarginRisk({
    nowMs,
    market: {
      acceptingOrders: market.acceptingOrders,
      conditionId: market.conditionId,
      negativeRisk: market.negativeRisk,
      noTokenId: market.noTokenId,
      orderBookEnabled: market.orderBookEnabled,
      resolutionAtMs: market.resolutionDate?.getTime() ?? null,
      status: market.status,
      syncedAtMs: market.syncedAt?.getTime() ?? null,
      tickSize: market.orderPriceMinTickSize?.toString() ?? null,
      yesTokenId: market.yesTokenId,
    },
    policy: {
      closeBufferSeconds: policy.closeBufferSeconds,
      earliestResolutionAtMs: policy.earliestResolutionAt.getTime(),
      expectedNegativeRisk: policy.expectedNegativeRisk,
      feeBps: policy.feeBps,
      maintenanceMarginBps: policy.maintenanceMarginBps,
      mandatoryCloseAtMs: policy.mandatoryCloseAt.getTime(),
      maxAccountBorrowAssets: policy.maxAccountBorrowAssets,
      maxCategoryBorrowAssets: policy.maxCategoryBorrowAssets,
      maxLeverageBps: policy.maxLeverageBps,
      maxMarketBorrowAssets: policy.maxMarketBorrowAssets,
      maxPriceAgeSeconds: policy.maximumPriceAgeSeconds,
      maxSpreadBps: policy.maximumSpreadBps,
      maxTwapDeviationBps: policy.maximumTwapDeviationBps,
      maxVaultBorrowAssets: policy.maxVaultBorrowAssets,
      minimumDepthAssets: policy.minimumDepthAssets,
      status: policy.status,
    },
    provider: {
      asks: snapshot.asks,
      bids: snapshot.bids,
      negativeRisk: snapshot.negativeRisk,
      observedAtMs: snapshot.observedAtMs,
      operational: providerOperational,
      tickSize: snapshot.tickSize,
      tokenId: snapshot.tokenId,
      twapPrice: snapshot.twapPrice,
    },
    request: {
      collateralAssets: input.collateralAssets,
      leverageBps: input.leverageBps,
      side: input.side,
    },
    exposure,
  });

  if (!decision.approved) {
    return { ...decision, quoteId: null };
  }

  return {
    ...decision,
    quoteId: createQuoteId({
      marketId: market.id,
      policyUpdatedAt: policy.updatedAt.toISOString(),
      quote: decision.quote,
      userId: input.userId,
    }),
  };
}

function validatePolicyInput(
  market: {
    acceptingOrders: boolean;
    conditionId: string | null;
    negativeRisk: boolean | null;
    noTokenId: string | null;
    orderBookEnabled: boolean;
    orderPriceMinTickSize: unknown;
    resolutionDate: Date | null;
    status: string;
    yesTokenId: string | null;
  },
  input: MarginMarketPolicyInput,
) {
  const earliestResolutionAt = parseDate(input.earliestResolutionAt, "earliestResolutionAt");
  const mandatoryCloseAt = parseDate(input.mandatoryCloseAt, "mandatoryCloseAt");
  const maxLeverageBps = input.maxLeverageBps ?? DEFAULT_MAX_LEVERAGE_BPS;
  const threeXApproved = input.threeXApproved ?? false;
  let amounts: bigint[];
  try {
    amounts = [
      input.minimumDepthAssets,
      input.maxMarketBorrowAssets,
      input.maxAccountBorrowAssets,
      input.maxCategoryBorrowAssets,
      input.maxVaultBorrowAssets,
    ].map(parseFixed);
  } catch {
    throw invalidPolicy("Depth and exposure caps must use up to six decimal places.");
  }

  if (
    !Number.isInteger(maxLeverageBps) ||
    maxLeverageBps <= 10_000 ||
    maxLeverageBps > HARD_MAX_LEVERAGE_BPS ||
    (maxLeverageBps > DEFAULT_MAX_LEVERAGE_BPS && !threeXApproved)
  ) {
    throw invalidPolicy(
      "Leverage defaults to 2x. A selected market may use up to 3x only with threeXApproved.",
    );
  }
  if (
    input.maintenanceMarginBps <= 0 ||
    input.maintenanceMarginBps >= 10_000 ||
    input.feeBps < 0 ||
    input.feeBps > 1_000
  ) {
    throw invalidPolicy("Maintenance margin or fee basis points are outside safe bounds.");
  }
  if (
    input.maxSpreadBps <= 0 ||
    input.maxSpreadBps > 2_000 ||
    input.maxTwapDeviationBps <= 0 ||
    input.maxTwapDeviationBps > 3_000 ||
    input.maxPriceAgeSeconds < 5 ||
    input.maxPriceAgeSeconds > 300 ||
    input.closeBufferSeconds < 300
  ) {
    throw invalidPolicy("Freshness, spread, deviation, or close-buffer limits are invalid.");
  }
  if (amounts.some((amount) => amount <= 0n)) {
    throw invalidPolicy("Depth and exposure caps must be positive decimal amounts.");
  }

  const [, marketCap, accountCap, categoryCap, vaultCap] = amounts;
  if (marketCap! > vaultCap! || accountCap! > vaultCap! || categoryCap! > vaultCap!) {
    throw invalidPolicy("Market, account, and category caps cannot exceed the vault cap.");
  }
  if (
    mandatoryCloseAt.getTime() > earliestResolutionAt.getTime() - input.closeBufferSeconds * 1000 ||
    (market.resolutionDate && earliestResolutionAt.getTime() > market.resolutionDate.getTime())
  ) {
    throw invalidPolicy("Mandatory close and earliest-resolution timestamps are inconsistent.");
  }
  if (input.status === "APPROVED") {
    if (!input.approvedBy?.trim()) {
      throw invalidPolicy("An approved production policy must record its approver.");
    }
    if (
      !market.conditionId ||
      !conditionIdPattern.test(market.conditionId) ||
      market.status !== "ACTIVE" ||
      !validToken(market.yesTokenId) ||
      !validToken(market.noTokenId) ||
      market.yesTokenId === market.noTokenId ||
      market.negativeRisk === null ||
      !market.orderBookEnabled ||
      !market.acceptingOrders
    ) {
      throw invalidPolicy("The market is missing required live CLOB metadata.");
    }
    if (market.negativeRisk !== input.expectedNegativeRisk) {
      throw invalidPolicy("Approved neg-risk policy does not match the market.");
    }
    const tickSize =
      market.orderPriceMinTickSize === null ? null : String(market.orderPriceMinTickSize);
    if (!tickSize || !supportedTickSizes.has(tickSize)) {
      throw invalidPolicy("Approved markets require a supported live orderbook tick size.");
    }
    if (mandatoryCloseAt.getTime() <= Date.now() || earliestResolutionAt.getTime() <= Date.now()) {
      throw invalidPolicy("Approved market close and resolution timestamps must be in the future.");
    }
  }

  return {
    approvedBy: input.approvedBy?.trim() || null,
    closeBufferSeconds: input.closeBufferSeconds,
    earliestResolutionAt,
    expectedNegativeRisk: input.expectedNegativeRisk,
    feeBps: input.feeBps,
    maintenanceMarginBps: input.maintenanceMarginBps,
    mandatoryCloseAt,
    maxAccountBorrowAssets: input.maxAccountBorrowAssets,
    maxCategoryBorrowAssets: input.maxCategoryBorrowAssets,
    maxLeverageBps,
    maxMarketBorrowAssets: input.maxMarketBorrowAssets,
    maximumPriceAgeSeconds: input.maxPriceAgeSeconds,
    maximumSpreadBps: input.maxSpreadBps,
    maximumTwapDeviationBps: input.maxTwapDeviationBps,
    maxVaultBorrowAssets: input.maxVaultBorrowAssets,
    minimumDepthAssets: input.minimumDepthAssets,
    notes: input.notes?.trim() || null,
    status: input.status as MarginMarketPolicyStatus,
    threeXApproved,
  };
}

async function getCurrentPolygonExposure(
  userId: string,
  marketId: string,
  category: string | null,
) {
  const positions = await prisma.position.findMany({
    where: {
      borrowedAmount: { not: null },
      chainId: polygonChainId,
      executionMode: ExecutionMode.MARGIN,
      status: { in: [PositionStatus.PENDING_EXECUTION, PositionStatus.EXECUTED] },
    },
    select: {
      borrowedAmount: true,
      id: true,
      marketId: true,
      userId: true,
      market: { select: { category: true } },
    },
  });

  let accountBorrow = 0n;
  let categoryBorrow = 0n;
  let marketBorrow = 0n;
  let vaultBorrow = 0n;
  const categoryKey = category ?? "__UNCATEGORIZED__";
  for (const position of positions) {
    if (!position.borrowedAmount) continue;
    let borrowed: bigint;
    try {
      borrowed = parseFixed(position.borrowedAmount);
    } catch {
      throw new AppError("Stored Polygon margin exposure is malformed", {
        code: "INVALID_PERSISTED_MARGIN_EXPOSURE",
        statusCode: 503,
        details: { positionId: position.id },
      });
    }
    vaultBorrow += borrowed;
    if (position.userId === userId) accountBorrow += borrowed;
    if (position.marketId === marketId) marketBorrow += borrowed;
    if ((position.market.category ?? "__UNCATEGORIZED__") === categoryKey) {
      categoryBorrow += borrowed;
    }
  }

  return {
    accountBorrowAssets: formatFixed(accountBorrow),
    categoryBorrowAssets: formatFixed(categoryBorrow),
    marketBorrowAssets: formatFixed(marketBorrow),
    vaultBorrowAssets: formatFixed(vaultBorrow),
  };
}

function normalizePolicy(policy: {
  approvedBy: string | null;
  closeBufferSeconds: number;
  createdAt: Date;
  earliestResolutionAt: Date;
  expectedNegativeRisk: boolean;
  feeBps: number;
  id: string;
  maintenanceMarginBps: number;
  mandatoryCloseAt: Date;
  marketId: string;
  maxAccountBorrowAssets: string;
  maxCategoryBorrowAssets: string;
  maxLeverageBps: number;
  maxMarketBorrowAssets: string;
  maximumPriceAgeSeconds: number;
  maximumSpreadBps: number;
  maximumTwapDeviationBps: number;
  maxVaultBorrowAssets: string;
  minimumDepthAssets: string;
  notes: string | null;
  status: MarginMarketPolicyStatus;
  threeXApproved: boolean;
  updatedAt: Date;
}) {
  return {
    ...policy,
    earliestResolutionAt: policy.earliestResolutionAt.toISOString(),
    mandatoryCloseAt: policy.mandatoryCloseAt.toISOString(),
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

function unavailableSnapshot(
  tokenId: string,
  market: { negativeRisk: boolean | null; orderPriceMinTickSize: unknown },
): PolymarketRiskSnapshot {
  return {
    asks: [],
    bids: [],
    minimumOrderSize: null,
    negativeRisk: market.negativeRisk,
    observedAtMs: 0,
    tickSize: market.orderPriceMinTickSize === null ? null : String(market.orderPriceMinTickSize),
    tokenId,
    twapPrice: "0.5",
  };
}

function createQuoteId(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseDate(value: string, field: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalidPolicy(`${field} must be a valid ISO timestamp.`);
  }
  return parsed;
}

function validToken(value: string | null) {
  return Boolean(value && tokenIdPattern.test(value) && BigInt(value) > 0n);
}

function invalidPolicy(message: string) {
  return new AppError(message, {
    code: "INVALID_MARGIN_MARKET_POLICY",
    statusCode: 422,
  });
}
