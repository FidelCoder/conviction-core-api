import { randomBytes } from "node:crypto";

import {
  ExecutionMode,
  MarketSource,
  PolymarketMarginExecutionState,
  PositionStatus,
  Prisma,
} from "@prisma/client";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";

import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { createMarginRiskQuote } from "./margin-risk-quotes.js";
import {
  calculateFokBuyPriceLimit,
  formatSixDecimalAssets,
  parseSixDecimalAssets,
} from "./polymarket-execution-state.js";
import { assertPolymarketReleasePolicy } from "./polymarket-release-policy.js";

const polygonChainId = 137;
const bytes32Pattern = /^0x[a-fA-F0-9]{64}$/;
const hashPattern = /^[a-fA-F0-9]{64}$/;
const signaturePattern = /^0x[a-fA-F0-9]+$/;
const supportedTickSizes = new Set(["0.1", "0.01", "0.001", "0.0001"]);

const marginAuthorizationTypes = {
  MarginAuthorization: [
    { name: "positionId", type: "bytes32" },
    { name: "conditionId", type: "bytes32" },
    { name: "tokenId", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "collateralAssets", type: "uint256" },
    { name: "borrowAssets", type: "uint256" },
    { name: "minimumOutcomeShares", type: "uint256" },
    { name: "financingFeeAssets", type: "uint256" },
    { name: "priceLimit", type: "uint256" },
    { name: "maxSlippageBps", type: "uint16" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
  ],
} as const;

const erc20ApproveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const polygonVaultAbi = parseAbi([
  "function reserveLoan((address adapter,bytes32 marketId,uint256 traderEquity,uint256 borrowAssets,address outcomeToken,uint256 outcomeTokenId,uint256 minimumOutcomeShares,uint256 financingFeeAssets,uint256 deadline) request) returns (bytes32 loanId,address custodyAccount)",
]);

export type PreparePolymarketExecutionInput = {
  userId: string;
  idempotencyKey: string;
  nonce: string;
  deadline: number;
  maxSlippageBps: number;
};

export type AuthorizePolymarketExecutionInput = PreparePolymarketExecutionInput & {
  quoteId: string;
  borrowAssets: string;
  minimumOutcomeShares: string;
  financingFeeAssets: string;
  priceLimit: string;
  signature: string;
};

export async function preparePolymarketMarginExecution(
  positionId: string,
  input: PreparePolymarketExecutionInput,
) {
  validatePrepareInput(input);
  const context = await getAuthorizationContext(positionId, input.userId);
  const decision = await createMarginRiskQuote({
    userId: input.userId,
    marketId: context.position.marketId,
    side: context.position.side,
    collateralAssets: context.position.marginCollateral!,
    leverageBps: context.leverageBps,
  });

  if (!decision.approved || !decision.quoteId) {
    throw new AppError("This margin request is not eligible for production execution", {
      code: "MARGIN_RISK_REJECTED",
      statusCode: 422,
      details: { rejections: decision.rejections },
    });
  }
  await assertPolymarketReleasePolicy({
    borrowAssets: decision.quote.borrowAssets,
    conditionId: context.market.conditionId!,
    leverageBps: context.leverageBps,
    notionalAssets: decision.quote.notionalAssets,
    userId: input.userId,
    walletAddress: context.position.walletAddress!,
  });

  const priceLimit = calculateFokBuyPriceLimit(
    decision.quote.openingPrice,
    input.maxSlippageBps,
    context.tickSize,
  );
  const authorization = {
    quoteId: decision.quoteId,
    borrowAssets: decision.quote.borrowAssets,
    minimumOutcomeShares: decision.quote.estimatedOutcomeShares,
    financingFeeAssets: decision.quote.feeAssets,
    priceLimit,
  };
  const typedData = buildAuthorizationTypedData(context, input, authorization);

  return {
    authorization,
    quote: decision.quote,
    typedData: serializeTypedData(typedData),
    walletCalls: buildReservationWalletCalls(context, input, authorization),
    warning:
      "Signing authorizes only the displayed Polygon pUSD reservation and FOK price limit. It does not permit withdrawals or arbitrary orders.",
  };
}

export async function authorizePolymarketMarginExecution(
  positionId: string,
  input: AuthorizePolymarketExecutionInput,
) {
  validatePrepareInput(input);
  validateAuthorizationInput(input);
  const existing = await prisma.polymarketMarginExecution.findUnique({
    where: { positionId },
  });
  if (existing) {
    if (existing.idempotencyKey !== input.idempotencyKey) {
      throw new AppError("This position already has a different execution authorization", {
        code: "POLYMARKET_EXECUTION_ALREADY_AUTHORIZED",
        statusCode: 409,
      });
    }
    return normalizePolymarketMarginExecution(existing);
  }

  const context = await getAuthorizationContext(positionId, input.userId);
  const typedData = buildAuthorizationTypedData(context, input, input);
  const client = createPublicClient({ chain: polygon, transport: http(env.polygonRpcUrl) });
  const validSignature = await client.verifyTypedData({
    address: context.position.walletAddress as Address,
    ...typedData,
    signature: input.signature as Hex,
  });
  if (!validSignature) {
    throw new AppError("Margin execution authorization signature is invalid", {
      code: "INVALID_MARGIN_EXECUTION_SIGNATURE",
      statusCode: 401,
    });
  }

  const freshDecision = await createMarginRiskQuote({
    userId: input.userId,
    marketId: context.position.marketId,
    side: context.position.side,
    collateralAssets: context.position.marginCollateral!,
    leverageBps: context.leverageBps,
  });
  if (!freshDecision.approved) {
    throw new AppError("Market risk changed before authorization completed", {
      code: "MARGIN_RISK_CHANGED",
      statusCode: 409,
      details: { rejections: freshDecision.rejections },
    });
  }
  await assertPolymarketReleasePolicy({
    borrowAssets: freshDecision.quote.borrowAssets,
    conditionId: context.market.conditionId!,
    leverageBps: context.leverageBps,
    notionalAssets: freshDecision.quote.notionalAssets,
    userId: input.userId,
    walletAddress: context.position.walletAddress!,
  });
  assertFreshQuoteInsideAuthorization(context.tickSize, input, freshDecision.quote);
  const reservationCalls = buildReservationWalletCalls(context, input, input);
  const approvalCall = reservationCalls.find((call) => call.id === "approve-pusd");
  const reservationCall = reservationCalls.find((call) => call.id === "reserve-margin-loan");
  if (!approvalCall || !reservationCall) {
    throw new Error("Margin reservation calls could not be constructed");
  }

  try {
    const execution = await prisma.polymarketMarginExecution.create({
      data: {
        positionId,
        idempotencyKey: input.idempotencyKey,
        authorizationNonce: input.nonce.toLowerCase(),
        authorizationDeadline: new Date(input.deadline * 1_000),
        authorizationSigner: context.position.walletAddress!.toLowerCase(),
        authorizationSignature: input.signature,
        quoteId: input.quoteId.toLowerCase(),
        maxSlippageBps: input.maxSlippageBps,
        state: PolymarketMarginExecutionState.AUTHORIZED,
        conditionId: context.market.conditionId!,
        tokenId: context.tokenId,
        vaultAddress: context.vaultAddress.toLowerCase(),
        adapterAddress: context.adapterAddress.toLowerCase(),
        requestPayload: {
          collateralAssets: context.position.marginCollateral!,
          borrowAssets: input.borrowAssets,
          leverageBps: context.leverageBps,
          minimumOutcomeShares: input.minimumOutcomeShares,
          financingFeeAssets: input.financingFeeAssets,
          priceLimit: input.priceLimit,
          side: context.position.side,
          tokenId: context.tokenId,
        },
        responsePayload: {
          stage: "margin_reservation_required",
          approvalCall,
          walletCall: reservationCall,
        },
      },
    });
    return normalizePolymarketMarginExecution(execution);
  } catch (error) {
    if (isPrismaUniqueConflict(error)) {
      throw new AppError("Execution nonce or idempotency key has already been used", {
        code: "MARGIN_EXECUTION_REPLAY",
        statusCode: 409,
      });
    }
    throw error;
  }
}

export async function getPolymarketMarginExecution(positionId: string, userId: string) {
  const execution = await prisma.polymarketMarginExecution.findFirst({
    where: { positionId, position: { userId } },
  });
  if (!execution) {
    throw new AppError("Polymarket margin execution not found", {
      code: "POLYMARKET_EXECUTION_NOT_FOUND",
      statusCode: 404,
    });
  }
  return normalizePolymarketMarginExecution(execution);
}

export function normalizePolymarketMarginExecution(execution: {
  id: string;
  positionId: string;
  idempotencyKey: string;
  state: PolymarketMarginExecutionState;
  conditionId: string;
  tokenId: string;
  vaultAddress: string;
  adapterAddress: string;
  loanId: string | null;
  custodyAddress: string | null;
  depositWalletAddress: string | null;
  clobOrderId: string | null;
  clobTradeIds: unknown;
  settlementTxHashes: unknown;
  actualFillPrice: string | null;
  actualShares: string | null;
  actualSpentAssets: string | null;
  actualFeeAssets: string | null;
  requestPayload: unknown;
  responsePayload: unknown;
  failureCode: string | null;
  failureMessage: string | null;
  reservedAt: Date | null;
  orderSubmittedAt: Date | null;
  fillConfirmedAt: Date | null;
  securedAt: Date | null;
  openedAt: Date | null;
  closingAt: Date | null;
  closedAt: Date | null;
  lastReconciledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: execution.id,
    positionId: execution.positionId,
    idempotencyKey: execution.idempotencyKey,
    state: execution.state,
    conditionId: execution.conditionId,
    tokenId: execution.tokenId,
    vaultAddress: execution.vaultAddress,
    adapterAddress: execution.adapterAddress,
    loanId: execution.loanId,
    custodyAddress: execution.custodyAddress,
    depositWalletAddress: execution.depositWalletAddress,
    clobOrderId: execution.clobOrderId,
    clobTradeIds: execution.clobTradeIds,
    settlementTxHashes: execution.settlementTxHashes,
    actualFillPrice: execution.actualFillPrice,
    actualShares: execution.actualShares,
    actualSpentAssets: execution.actualSpentAssets,
    actualFeeAssets: execution.actualFeeAssets,
    authorizedTerms: normalizeAuthorizedTerms(execution.requestPayload),
    stageInstruction: normalizeStageInstruction(execution.responsePayload),
    fundingTxHash: "fundingTxHash" in execution ? execution.fundingTxHash : null,
    custodyFundingTxHash:
      "custodyFundingTxHash" in execution ? execution.custodyFundingTxHash : null,
    securityTransferTxHash:
      "securityTransferTxHash" in execution ? execution.securityTransferTxHash : null,
    activationTxHash: "activationTxHash" in execution ? execution.activationTxHash : null,
    activeCloseAttemptId:
      "activeCloseAttemptId" in execution ? execution.activeCloseAttemptId : null,
    stopLossPrice: "stopLossPrice" in execution ? execution.stopLossPrice : null,
    takeProfitPrice: "takeProfitPrice" in execution ? execution.takeProfitPrice : null,
    failureCode: execution.failureCode,
    failureMessage: execution.failureMessage,
    reservedAt: execution.reservedAt?.toISOString() ?? null,
    orderSubmittedAt: execution.orderSubmittedAt?.toISOString() ?? null,
    fillConfirmedAt: execution.fillConfirmedAt?.toISOString() ?? null,
    securedAt: execution.securedAt?.toISOString() ?? null,
    openedAt: execution.openedAt?.toISOString() ?? null,
    closingAt: execution.closingAt?.toISOString() ?? null,
    closedAt: execution.closedAt?.toISOString() ?? null,
    lastReconciledAt: execution.lastReconciledAt?.toISOString() ?? null,
    createdAt: execution.createdAt.toISOString(),
    updatedAt: execution.updatedAt.toISOString(),
  };
}

function normalizeAuthorizedTerms(value: unknown) {
  if (!isJsonRecord(value)) return {};

  return Object.fromEntries(
    [
      "collateralAssets",
      "borrowAssets",
      "leverageBps",
      "minimumOutcomeShares",
      "financingFeeAssets",
      "priceLimit",
      "side",
      "tokenId",
    ]
      .map((key) => [key, value[key]] as const)
      .filter((entry): entry is readonly [string, string | number] => {
        return typeof entry[1] === "string" || typeof entry[1] === "number";
      }),
  );
}

function normalizeStageInstruction(value: unknown) {
  if (!isJsonRecord(value) || typeof value.stage !== "string") return null;

  const instruction: {
    stage: string;
    approvalCall?: { chainId: number; to: string; value: string; data: string };
    walletCall?: { chainId: number; to: string; value: string; data: string };
  } = { stage: value.stage };
  const walletCall = normalizePublicWalletCall(value.walletCall);
  const approvalCall = normalizePublicWalletCall(value.approvalCall);
  if (walletCall) instruction.walletCall = walletCall;
  if (approvalCall) instruction.approvalCall = approvalCall;

  return instruction;
}

function normalizePublicWalletCall(value: unknown) {
  if (
    !isJsonRecord(value) ||
    !Number.isInteger(value.chainId) ||
    Number(value.chainId) <= 0 ||
    typeof value.to !== "string" ||
    !isAddress(value.to) ||
    typeof value.value !== "string" ||
    !/^\d+$/.test(value.value) ||
    typeof value.data !== "string" ||
    !/^0x(?:[a-fA-F0-9]{2})*$/.test(value.data)
  ) {
    return null;
  }
  return {
    chainId: Number(value.chainId),
    to: value.to,
    value: value.value,
    data: value.data,
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getAuthorizationContext(positionId: string, userId: string) {
  const position = await prisma.position.findFirst({
    where: { id: positionId, userId },
    include: { market: true },
  });
  if (!position) {
    throw new AppError("Position not found", { code: "POSITION_NOT_FOUND", statusCode: 404 });
  }
  if (
    position.executionMode !== ExecutionMode.MARGIN ||
    position.status !== PositionStatus.PENDING_EXECUTION
  ) {
    throw new AppError("Only pending margin positions can be authorized", {
      code: "POSITION_NOT_PENDING_MARGIN",
      statusCode: 422,
    });
  }
  if (position.chainId !== polygonChainId || !position.walletAddress) {
    throw new AppError("Production Polymarket margin requires a Polygon wallet position", {
      code: "POLYGON_MARGIN_POSITION_REQUIRED",
      statusCode: 422,
    });
  }
  if (!isAddress(position.walletAddress)) {
    throw new AppError("Position wallet is malformed", {
      code: "INVALID_POSITION_WALLET",
      statusCode: 422,
    });
  }
  if (
    position.market.source !== MarketSource.POLYMARKET ||
    !position.market.conditionId ||
    !bytes32Pattern.test(position.market.conditionId)
  ) {
    throw new AppError("Position market is missing valid Polymarket metadata", {
      code: "INVALID_POLYMARKET_MARKET",
      statusCode: 422,
    });
  }
  const tokenId = position.side === "YES" ? position.market.yesTokenId : position.market.noTokenId;
  if (!tokenId || !/^\d+$/.test(tokenId) || BigInt(tokenId) <= 0n) {
    throw new AppError("Position outcome token is missing", {
      code: "INVALID_OUTCOME_TOKEN",
      statusCode: 422,
    });
  }
  const tickSize = position.market.orderPriceMinTickSize;
  if (!tickSize || !supportedTickSizes.has(tickSize)) {
    throw new AppError("Market tick size is not supported", {
      code: "INVALID_TICK_SIZE",
      statusCode: 422,
    });
  }
  if (!position.marginCollateral || !position.leverageMultiplier) {
    throw new AppError("Position is missing margin terms", {
      code: "POSITION_MARGIN_METADATA_MISSING",
      statusCode: 422,
    });
  }
  const vaultAddress = requiredAddress(
    env.polymarketPusdVaultAddress,
    "POLYMARKET_PUSD_VAULT_ADDRESS",
  );
  const adapterAddress = requiredAddress(
    env.polymarketExecutionAdapterAddress,
    "POLYMARKET_EXECUTION_ADAPTER_ADDRESS",
  );
  requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
  requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");

  const leverageBps = new Prisma.Decimal(position.leverageMultiplier).mul(10_000).toNumber();
  if (!Number.isInteger(leverageBps) || leverageBps <= 10_000 || leverageBps > 30_000) {
    throw new AppError("Position leverage is outside the production range", {
      code: "INVALID_POSITION_LEVERAGE",
      statusCode: 422,
    });
  }

  return {
    position,
    market: position.market,
    tokenId,
    tickSize,
    leverageBps,
    vaultAddress,
    adapterAddress,
  };
}

function buildAuthorizationTypedData(
  context: Awaited<ReturnType<typeof getAuthorizationContext>>,
  input: PreparePolymarketExecutionInput,
  authorization: {
    quoteId: string;
    borrowAssets: string;
    minimumOutcomeShares: string;
    financingFeeAssets: string;
    priceLimit: string;
  },
) {
  return {
    domain: {
      name: "Conviction Markets Margin",
      version: "2",
      chainId: polygonChainId,
      verifyingContract: context.vaultAddress,
    },
    primaryType: "MarginAuthorization" as const,
    types: marginAuthorizationTypes,
    message: {
      positionId: objectIdToBytes32(context.position.id),
      conditionId: context.market.conditionId as Hex,
      tokenId: BigInt(context.tokenId),
      side: context.position.side === "YES" ? 0 : 1,
      collateralAssets: parseSixDecimalAssets(
        context.position.marginCollateral!,
        "collateralAssets",
      ),
      borrowAssets: parseSixDecimalAssets(authorization.borrowAssets, "borrowAssets"),
      minimumOutcomeShares: parseSixDecimalAssets(
        authorization.minimumOutcomeShares,
        "minimumOutcomeShares",
      ),
      financingFeeAssets: parseSixDecimalAssets(
        authorization.financingFeeAssets,
        "financingFeeAssets",
      ),
      priceLimit: parseSixDecimalAssets(authorization.priceLimit, "priceLimit"),
      maxSlippageBps: input.maxSlippageBps,
      nonce: input.nonce as Hex,
      deadline: BigInt(input.deadline),
      quoteId: `0x${authorization.quoteId}` as Hex,
    },
  };
}

function serializeTypedData(value: ReturnType<typeof buildAuthorizationTypedData>) {
  return {
    ...value,
    message: Object.fromEntries(
      Object.entries(value.message).map(([key, item]) => [
        key,
        typeof item === "bigint" ? item.toString() : item,
      ]),
    ),
  };
}

function buildReservationWalletCalls(
  context: Awaited<ReturnType<typeof getAuthorizationContext>>,
  input: PreparePolymarketExecutionInput,
  authorization: {
    borrowAssets: string;
    minimumOutcomeShares: string;
    financingFeeAssets: string;
  },
) {
  const collateralUnits = parseSixDecimalAssets(
    context.position.marginCollateral!,
    "collateralAssets",
  );
  const request = {
    adapter: context.adapterAddress,
    marketId: context.market.conditionId as Hex,
    traderEquity: collateralUnits,
    borrowAssets: parseSixDecimalAssets(authorization.borrowAssets, "borrowAssets"),
    outcomeToken: requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS"),
    outcomeTokenId: BigInt(context.tokenId),
    minimumOutcomeShares: parseSixDecimalAssets(
      authorization.minimumOutcomeShares,
      "minimumOutcomeShares",
    ),
    financingFeeAssets: parseSixDecimalAssets(
      authorization.financingFeeAssets,
      "financingFeeAssets",
    ),
    deadline: BigInt(input.deadline),
  };
  const collateral = requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");

  return [
    {
      id: "approve-pusd",
      chainId: polygonChainId,
      to: collateral,
      value: "0",
      data: encodeFunctionData({
        abi: erc20ApproveAbi,
        functionName: "approve",
        args: [context.vaultAddress, collateralUnits],
      }),
    },
    {
      id: "reserve-margin-loan",
      chainId: polygonChainId,
      to: context.vaultAddress,
      value: "0",
      data: encodeFunctionData({
        abi: polygonVaultAbi,
        functionName: "reserveLoan",
        args: [request],
      }),
    },
  ];
}

function assertFreshQuoteInsideAuthorization(
  tickSize: string,
  authorized: AuthorizePolymarketExecutionInput,
  fresh: {
    borrowAssets: string;
    estimatedOutcomeShares: string;
    openingPrice: string;
    feeAssets: string;
  },
) {
  if (
    parseSixDecimalAssets(authorized.borrowAssets, "borrowAssets") !==
    parseSixDecimalAssets(fresh.borrowAssets, "fresh.borrowAssets")
  ) {
    throw changedTerms("Borrow amount changed after the user signed.");
  }
  if (
    parseSixDecimalAssets(fresh.estimatedOutcomeShares, "fresh.estimatedOutcomeShares") <
    parseSixDecimalAssets(authorized.minimumOutcomeShares, "minimumOutcomeShares")
  ) {
    throw changedTerms("Live depth no longer satisfies the signed minimum share amount.");
  }
  if (
    parseSixDecimalAssets(authorized.financingFeeAssets, "financingFeeAssets") !==
    parseSixDecimalAssets(fresh.feeAssets, "fresh.feeAssets")
  ) {
    throw changedTerms("The fixed financing fee changed after the user signed.");
  }
  const freshLimit = calculateFokBuyPriceLimit(
    fresh.openingPrice,
    authorized.maxSlippageBps,
    tickSize,
  );
  if (
    parseSixDecimalAssets(freshLimit, "fresh.priceLimit") >
    parseSixDecimalAssets(authorized.priceLimit, "priceLimit")
  ) {
    throw changedTerms("Live execution would exceed the signed worst price.");
  }
}

function validatePrepareInput(input: PreparePolymarketExecutionInput) {
  if (!input.userId || !input.idempotencyKey || input.idempotencyKey.length > 160) {
    throw invalidInput("userId and a bounded idempotencyKey are required.");
  }
  if (!bytes32Pattern.test(input.nonce)) throw invalidInput("nonce must be a bytes32 value.");
  const now = Math.floor(Date.now() / 1_000);
  if (
    !Number.isInteger(input.deadline) ||
    input.deadline <= now ||
    input.deadline > now + 15 * 60
  ) {
    throw invalidInput("deadline must be within the next 15 minutes.");
  }
  if (
    !Number.isInteger(input.maxSlippageBps) ||
    input.maxSlippageBps < 0 ||
    input.maxSlippageBps > 500
  ) {
    throw invalidInput("maxSlippageBps must be between 0 and 500.");
  }
}

function validateAuthorizationInput(input: AuthorizePolymarketExecutionInput) {
  if (!hashPattern.test(input.quoteId)) throw invalidInput("quoteId must be a 32-byte hex digest.");
  if (!signaturePattern.test(input.signature) || input.signature.length < 132) {
    throw invalidInput("signature must be a valid hex signature.");
  }
  parseSixDecimalAssets(input.borrowAssets, "borrowAssets");
  parseSixDecimalAssets(input.minimumOutcomeShares, "minimumOutcomeShares");
  parseSixDecimalAssets(input.financingFeeAssets, "financingFeeAssets");
  const limit = parseSixDecimalAssets(input.priceLimit, "priceLimit");
  if (limit <= 0n || limit >= 1_000_000n) throw invalidInput("priceLimit must be between 0 and 1.");
}

function requiredAddress(value: string | null, name: string) {
  if (!value || !isAddress(value)) {
    throw new AppError(`${name} is not configured`, {
      code: "POLYMARKET_EXECUTION_NOT_CONFIGURED",
      statusCode: 503,
    });
  }
  return value as Address;
}

function objectIdToBytes32(value: string) {
  if (!/^[a-fA-F0-9]{24}$/.test(value)) throw invalidInput("position id is malformed.");
  return `0x${value.toLowerCase().padStart(64, "0")}` as Hex;
}

function invalidInput(message: string) {
  return new AppError(message, { code: "INVALID_MARGIN_EXECUTION_INPUT", statusCode: 422 });
}

function changedTerms(message: string) {
  return new AppError(message, { code: "MARGIN_EXECUTION_TERMS_CHANGED", statusCode: 409 });
}

function isPrismaUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function createExecutionNonce() {
  return `0x${randomBytes(32).toString("hex")}`;
}

export function decimalUnitsForContract(value: string) {
  return formatSixDecimalAssets(parseSixDecimalAssets(value, "value"));
}
