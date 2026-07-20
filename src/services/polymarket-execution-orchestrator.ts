import { randomUUID } from "node:crypto";

import {
  getContractConfig,
  type ApiKeyCreds,
  type SignedOrder,
  type TickSize,
} from "@polymarket/clob-client-v2";
import {
  PolymarketCloseReason,
  PolymarketCloseStage,
  PolymarketMarginExecutionState,
  PositionStatus,
  Prisma,
  type Market,
  type PolymarketCloseAttempt,
  type PolymarketMarginExecution,
  type Position,
} from "@prisma/client";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  toBytes,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { z } from "zod";

import { env } from "../config/env.js";
import { decryptJson, encryptJson } from "../lib/credentials.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import {
  buildDepositWalletApprovalCalls,
  calculateClobV2OrderId,
  PolymarketClobExecutionClient,
  PolymarketRelayerClient,
} from "../providers/polymarket/execution.js";
import { getPolymarketRiskSnapshot } from "../providers/polymarket/orderbook.js";
import { createMarginRiskQuote } from "./margin-risk-quotes.js";
import { normalizePolymarketMarginExecution } from "./polymarket-margin-execution.js";
import {
  calculateFokBuyPriceLimit,
  classifyFokPostResult,
  formatSixDecimalAssets,
  parseSixDecimalAssets,
  persistedOrderRecoveryState,
  quoteFokSellFromBids,
  summarizeClobTrades,
} from "./polymarket-execution-state.js";

const polygonChainId = 137;
const activeRepaymentVersion = keccak256(toBytes("CONVICTION_ACTIVE_REPAYMENT_V1"));
const transactionHashPattern = /^0x[a-fA-F0-9]{64}$/;
// Polygon receipt waits can outlive one serverless request. Keep the lease longer than any
// bounded provider stage; expired leases are still recovered from onchain/CLOB state.
const executionLockMs = 5 * 60_000;
const terminalLoanStatus = { ACTIVE: 3, SETTLED: 4, FAILED: 5, CANCELLED: 6 } as const;
const closingLoanStatus = 7;
const zeroBytes32 = `0x${"0".repeat(64)}` as Hex;
const closeReasonCode = {
  VOLUNTARY: 0,
  MANDATORY: 1,
  LIQUIDATION: 2,
  RESOLUTION: 3,
  STOP_LOSS: 4,
  TAKE_PROFIT: 5,
} as const;

const closeAuthorizationTypes = {
  CloseAuthorization: [
    { name: "positionId", type: "bytes32" },
    { name: "loanId", type: "bytes32" },
    { name: "tokenId", type: "uint256" },
    { name: "amountShares", type: "uint256" },
    { name: "minimumProceeds", type: "uint256" },
    { name: "priceLimit", type: "uint256" },
    { name: "maxSlippageBps", type: "uint16" },
    { name: "reason", type: "uint8" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
const riskControlAuthorizationTypes = {
  RiskControlAuthorization: [
    { name: "positionId", type: "bytes32" },
    { name: "loanId", type: "bytes32" },
    { name: "stopLossPrice", type: "uint256" },
    { name: "takeProfitPrice", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const executionRequestSchema = z.object({
  collateralAssets: z.string(),
  borrowAssets: z.string(),
  leverageBps: z.number().int(),
  minimumOutcomeShares: z.string(),
  financingFeeAssets: z.string(),
  priceLimit: z.string(),
  side: z.enum(["YES", "NO"]),
  tokenId: z.string(),
});

const loanReservedEvent = parseAbiItem(
  "event LoanReserved(bytes32 indexed loanId,address indexed trader,address indexed custodyAccount,bytes32 marketId,uint256 traderEquity,uint256 borrowAssets)",
);
const loanPrincipalRepaidEvent = parseAbiItem(
  "event LoanPrincipalRepaid(bytes32 indexed loanId,address indexed trader,uint256 assets,uint256 remainingPrincipal)",
);
const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function ACTIVE_REPAYMENT_VERSION() view returns (bytes32)",
  "function deploymentChainId() view returns (uint256)",
  "function authorizedAdapters(address) view returns (bool)",
  "function owner() view returns (address)",
  "function guardian() view returns (address)",
  "function riskManager() view returns (address)",
  "function paused() view returns (bool)",
  "function protocolReserves() view returns (uint256)",
  "function totalBorrowedAssets() view returns (uint256)",
  "function totalUncoveredBadDebt() view returns (uint256)",
  "function isExecutionTargetAllowed(address) view returns (bool)",
  "function fundLoan(bytes32 loanId)",
  "function commitExecutionWallet(bytes32 loanId,address executionWallet)",
  "function failLoan(bytes32 loanId,bytes32 reasonCode)",
  "function beginLoanClose(bytes32 loanId)",
  "function repayLoanPrincipal(bytes32 loanId,uint256 assets)",
  "function restoreLoanAfterFailedClose(bytes32 loanId)",
  "function settleLoan(bytes32 loanId,bytes32 settlementRef)",
  "function activateLoan(bytes32 loanId,uint256 securedOutcomeShares,bytes32 executionRef)",
  "function loans(bytes32) view returns (address trader,address adapter,address custodyAccount,bytes32 marketId,address outcomeToken,uint256 outcomeTokenId,uint256 minimumOutcomeShares,uint256 securedOutcomeShares,uint256 traderEquity,uint256 borrowAssets,uint256 fundedAssets,uint256 financingFeeAssets,uint256 deadline,uint8 status,address executionWallet,uint256 executionWalletBaselineShares,bytes32 executionRef,bytes32 settlementRef)",
]);
const custodyAbi = parseAbi([
  "function executeVenueCall(address venue,bytes data) returns (bytes result)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address recipient,uint256 amount) returns (bool)",
]);
const erc1155Abi = parseAbi([
  "function balanceOf(address account,uint256 id) view returns (uint256)",
  "function safeTransferFrom(address from,address to,uint256 id,uint256 amount,bytes data)",
]);
const ctfRedemptionAbi = parseAbi([
  "function redeemPositions(address collateralToken,bytes32 parentCollectionId,bytes32 conditionId,uint256[] indexSets)",
]);
const negativeRiskRedemptionAbi = parseAbi([
  "function redeemPositions(bytes32 conditionId,uint256[] amounts)",
]);

type ExecutionWithPosition = PolymarketMarginExecution & {
  position: Position & { market: Market };
};

type SecretEnvelope = { privateKey: Hex };

export type PreparePolymarketCloseInput = {
  userId: string;
  idempotencyKey: string;
  nonce: string;
  deadline: number;
  maxSlippageBps: number;
};

export type AuthorizePolymarketCloseInput = PreparePolymarketCloseInput & {
  minimumProceeds: string;
  priceLimit: string;
  signature: string;
};

export async function recordPolymarketLoanReservation(input: {
  executionId: string;
  userId: string;
  transactionHash: string;
}) {
  if (!transactionHashPattern.test(input.transactionHash)) {
    throw new AppError("Reservation transaction hash is malformed", {
      code: "INVALID_RESERVATION_TRANSACTION_HASH",
      statusCode: 422,
    });
  }
  const execution = await getOwnedExecution(input.executionId, input.userId);
  if (execution.state !== PolymarketMarginExecutionState.AUTHORIZED) {
    if (execution.loanId) return normalizePolymarketMarginExecution(execution);
    throw invalidState(execution.state, "record a reservation");
  }
  if (execution.authorizationDeadline.getTime() <= Date.now()) {
    throw new AppError("Execution authorization expired before reservation", {
      code: "MARGIN_EXECUTION_AUTHORIZATION_EXPIRED",
      statusCode: 409,
    });
  }

  const publicClient = polygonPublicClient();
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: input.transactionHash.toLowerCase() as Hex,
  });
  if (receipt.status !== "success") {
    throw new AppError("Vault reservation transaction failed on Polygon", {
      code: "MARGIN_LOAN_RESERVATION_FAILED",
      statusCode: 409,
    });
  }
  const reservation = parseLoanReserved(receipt.logs, execution.vaultAddress);
  if (!reservation) {
    throw new AppError("Transaction did not emit the expected vault reservation", {
      code: "LOAN_RESERVED_EVENT_NOT_FOUND",
      statusCode: 409,
    });
  }
  const request = executionRequest(execution);
  assertReservationMatches(execution, request, reservation);
  const loan = await readLoan(execution.vaultAddress, reservation.loanId);
  const conditionalTokens = requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  if (
    loan.trader.toLowerCase() !== execution.authorizationSigner.toLowerCase() ||
    loan.adapter.toLowerCase() !== execution.adapterAddress.toLowerCase() ||
    loan.custodyAccount.toLowerCase() !== reservation.custodyAddress.toLowerCase() ||
    loan.marketId.toLowerCase() !== execution.conditionId.toLowerCase() ||
    loan.outcomeToken.toLowerCase() !== conditionalTokens.toLowerCase() ||
    loan.outcomeTokenId.toString() !== execution.tokenId ||
    loan.minimumOutcomeShares !==
      parseSixDecimalAssets(request.minimumOutcomeShares, "minimumOutcomeShares") ||
    loan.traderEquity !== parseSixDecimalAssets(request.collateralAssets, "collateralAssets") ||
    loan.borrowAssets !== parseSixDecimalAssets(request.borrowAssets, "borrowAssets") ||
    loan.financingFeeAssets !==
      parseSixDecimalAssets(request.financingFeeAssets, "financingFeeAssets") ||
    loan.status !== 1
  ) {
    throw new AppError("Onchain loan does not match the authorized execution", {
      code: "MARGIN_LOAN_MISMATCH",
      statusCode: 409,
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.polymarketMarginExecution.updateMany({
      where: { id: execution.id, state: PolymarketMarginExecutionState.AUTHORIZED },
      data: {
        state: PolymarketMarginExecutionState.RESERVED,
        loanId: reservation.loanId,
        custodyAddress: reservation.custodyAddress,
        reservedAt: new Date(),
        responsePayload: {
          reservationTransactionHash: receipt.transactionHash,
          reservationBlockNumber: receipt.blockNumber.toString(),
        },
      },
    });
    if (claimed.count !== 1) throw new Error("Reservation was concurrently updated");
    await tx.position.update({
      where: { id: execution.positionId },
      data: { chainTransactionHash: receipt.transactionHash },
    });
    return tx.polymarketMarginExecution.findUniqueOrThrow({ where: { id: execution.id } });
  });
  return normalizePolymarketMarginExecution(updated);
}

export async function recordPolymarketExecutionWalletCommit(input: {
  executionId: string;
  userId: string;
  transactionHash: string;
}) {
  if (!transactionHashPattern.test(input.transactionHash)) {
    throw new AppError("Wallet commitment transaction hash is malformed", {
      code: "INVALID_WALLET_COMMIT_TRANSACTION_HASH",
      statusCode: 422,
    });
  }
  const execution = await getOwnedExecution(input.executionId, input.userId);
  if (execution.state !== PolymarketMarginExecutionState.WALLET_COMMIT_REQUIRED) {
    if (
      !(
        [
          PolymarketMarginExecutionState.AUTHORIZED,
          PolymarketMarginExecutionState.RESERVED,
          PolymarketMarginExecutionState.WALLET_DEPLOYING,
        ] as PolymarketMarginExecutionState[]
      ).includes(execution.state)
    ) {
      return normalizePolymarketMarginExecution(execution);
    }
    throw invalidState(execution.state, "record an execution-wallet commitment");
  }
  const receipt = await polygonPublicClient().waitForTransactionReceipt({
    hash: input.transactionHash.toLowerCase() as Hex,
  });
  if (receipt.status !== "success") {
    throw new AppError("Execution-wallet commitment failed on Polygon", {
      code: "EXECUTION_WALLET_COMMIT_FAILED",
      statusCode: 409,
    });
  }
  const loan = await readLoan(execution.vaultAddress, requiredLoanId(execution));
  if (
    loan.status !== 1 ||
    loan.executionWallet.toLowerCase() !==
      requiredAddress(execution.depositWalletAddress, "depositWalletAddress").toLowerCase()
  ) {
    throw new AppError("Onchain execution-wallet commitment does not match this loan", {
      code: "EXECUTION_WALLET_COMMIT_MISMATCH",
      statusCode: 409,
    });
  }
  const updated = await prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      state: PolymarketMarginExecutionState.WALLET_COMMITTED,
      responsePayload: {
        stage: "execution_wallet_committed",
        transactionHash: receipt.transactionHash.toLowerCase(),
      },
    },
  });
  return normalizePolymarketMarginExecution(updated);
}

export async function advancePolymarketMarginExecution(input: {
  executionId: string;
  userId: string;
}) {
  const initial = await getOwnedExecution(input.executionId, input.userId);
  return advanceExecutionRecord(initial);
}

export async function preparePolymarketPositionClose(
  positionId: string,
  input: PreparePolymarketCloseInput,
) {
  validateCloseInput(input);
  const execution = await getOwnedExecutionByPosition(positionId, input.userId);
  assertCloseCanStart(execution);
  const quote = await createCloseQuote(execution, input.maxSlippageBps);
  const typedData = buildCloseTypedData(execution, input, {
    minimumProceeds: quote.minimumProceeds,
    priceLimit: quote.priceLimit,
    reason: PolymarketCloseReason.VOLUNTARY,
  });

  return {
    quote,
    typedData: serializeCloseTypedData(typedData),
    warning:
      "Signing authorizes one full-position FOK close at or above the displayed net proceeds floor. A no-fill returns the shares to isolated custody.",
  };
}

export async function authorizePolymarketPositionClose(
  positionId: string,
  input: AuthorizePolymarketCloseInput,
) {
  validateCloseInput(input);
  parseSixDecimalAssets(input.minimumProceeds, "minimumProceeds");
  parseSixDecimalAssets(input.priceLimit, "priceLimit");
  if (!/^0x[a-fA-F0-9]+$/.test(input.signature) || input.signature.length < 132) {
    throw new AppError("Close authorization signature is malformed", {
      code: "INVALID_CLOSE_AUTHORIZATION_SIGNATURE",
      statusCode: 422,
    });
  }

  const execution = await getOwnedExecutionByPosition(positionId, input.userId);
  assertCloseCanStart(execution);
  const recentAttempts = await prisma.polymarketCloseAttempt.count({
    where: {
      execution: { position: { userId: input.userId } },
      createdAt: { gte: new Date(Date.now() - 60_000) },
    },
  });
  if (recentAttempts >= 5) {
    throw new AppError("Close authorization rate limit reached", {
      code: "CLOSE_RATE_LIMITED",
      statusCode: 429,
    });
  }

  const fresh = await createCloseQuote(execution, input.maxSlippageBps);
  if (
    parseSixDecimalAssets(input.priceLimit, "priceLimit") !==
      parseSixDecimalAssets(fresh.priceLimit, "fresh.priceLimit") ||
    parseSixDecimalAssets(input.minimumProceeds, "minimumProceeds") !==
      parseSixDecimalAssets(fresh.minimumProceeds, "fresh.minimumProceeds")
  ) {
    throw new AppError("Live close terms changed before authorization completed", {
      code: "CLOSE_TERMS_CHANGED",
      statusCode: 409,
    });
  }

  const typedData = buildCloseTypedData(execution, input, {
    minimumProceeds: input.minimumProceeds,
    priceLimit: input.priceLimit,
    reason: PolymarketCloseReason.VOLUNTARY,
  });
  const signatureValid = await polygonPublicClient().verifyTypedData({
    address: execution.authorizationSigner as Address,
    ...typedData,
    signature: input.signature as Hex,
  });
  if (!signatureValid) {
    throw new AppError("Close authorization signature is invalid", {
      code: "INVALID_CLOSE_AUTHORIZATION_SIGNATURE",
      statusCode: 401,
    });
  }

  try {
    const attempt = await prisma.$transaction(async (tx) => {
      const created = await tx.polymarketCloseAttempt.create({
        data: {
          executionId: execution.id,
          idempotencyKey: input.idempotencyKey,
          authorizationNonce: input.nonce.toLowerCase(),
          authorizationDeadline: new Date(input.deadline * 1_000),
          authorizationSigner: execution.authorizationSigner,
          authorizationSignature: input.signature,
          reason: PolymarketCloseReason.VOLUNTARY,
          stage: PolymarketCloseStage.AUTHORIZED,
          maxSlippageBps: input.maxSlippageBps,
          priceLimit: input.priceLimit,
          minimumProceeds: input.minimumProceeds,
          requestPayload: {
            amountShares: execution.actualShares,
            feeRateBps: fresh.feeRateBps,
            maximumVenueFeeAssets: fresh.maximumVenueFeeAssets,
          },
        },
      });
      const claimed = await tx.polymarketMarginExecution.updateMany({
        where: {
          id: execution.id,
          state: PolymarketMarginExecutionState.OPEN,
          activeCloseAttemptId: null,
        },
        data: {
          state: PolymarketMarginExecutionState.CLOSING,
          activeCloseAttemptId: created.id,
          closingAt: new Date(),
        },
      });
      if (claimed.count !== 1) throw new Error("Position close was concurrently authorized");
      return created;
    });
    return normalizeCloseAttempt(attempt);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("Close nonce or idempotency key has already been used", {
        code: "CLOSE_AUTHORIZATION_REPLAY",
        statusCode: 409,
      });
    }
    throw error;
  }
}

export async function getPolymarketCloseAttempts(positionId: string, userId: string) {
  const execution = await getOwnedExecutionByPosition(positionId, userId);
  const attempts = await prisma.polymarketCloseAttempt.findMany({
    where: { executionId: execution.id },
    orderBy: { createdAt: "desc" },
  });
  return attempts.map(normalizeCloseAttempt);
}

export async function getPolymarketPositionControls(positionId: string, userId: string) {
  const execution = await getOwnedExecutionByPosition(positionId, userId);
  const loan = execution.loanId
    ? await readLoan(execution.vaultAddress, execution.loanId as Hex)
    : null;
  const repayments = await prisma.polymarketDebtRepayment.findMany({
    where: { executionId: execution.id },
    orderBy: { confirmedAt: "desc" },
  });
  return {
    activeRepaymentEnabled: env.polymarketActiveRepayEnabled,
    stopLossPrice: execution.stopLossPrice,
    takeProfitPrice: execution.takeProfitPrice,
    currentBorrowAssets: loan ? formatSixDecimalAssets(loan.borrowAssets) : null,
    warning:
      "Stop-loss and take-profit are best-effort instructions. Thin liquidity, gaps, outages, and resolution can produce a different exit price.",
    repayments: repayments.map((repayment) => ({
      ...repayment,
      confirmedAt: repayment.confirmedAt.toISOString(),
      createdAt: repayment.createdAt.toISOString(),
    })),
  };
}

export async function preparePolymarketPositionControls(input: {
  positionId: string;
  userId: string;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  nonce: string;
  deadline: number;
}) {
  const execution = await getOwnedExecutionByPosition(input.positionId, input.userId);
  assertRiskControlsCanChange(execution, input.nonce, input.deadline);
  const stopLossPrice = optionalProbability(input.stopLossPrice, "stopLossPrice");
  const takeProfitPrice = optionalProbability(input.takeProfitPrice, "takeProfitPrice");
  assertRiskControlOrder(stopLossPrice, takeProfitPrice);
  return {
    stopLossPrice,
    takeProfitPrice,
    typedData: serializeTypedData(
      buildRiskControlTypedData(execution, {
        ...input,
        stopLossPrice,
        takeProfitPrice,
      }),
    ),
    warning:
      "Signing stores best-effort exit instructions for this position only. It does not guarantee the trigger or fill price.",
  };
}

export async function updatePolymarketPositionControls(input: {
  positionId: string;
  userId: string;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  nonce: string;
  deadline: number;
  signature: string;
}) {
  const execution = await getOwnedExecutionByPosition(input.positionId, input.userId);
  assertRiskControlsCanChange(execution, input.nonce, input.deadline);
  const stopLossPrice = optionalProbability(input.stopLossPrice, "stopLossPrice");
  const takeProfitPrice = optionalProbability(input.takeProfitPrice, "takeProfitPrice");
  assertRiskControlOrder(stopLossPrice, takeProfitPrice);
  if (!/^0x[a-fA-F0-9]+$/.test(input.signature) || input.signature.length < 132) {
    throw new AppError("Risk-control signature is malformed", {
      code: "INVALID_RISK_CONTROL_SIGNATURE",
      statusCode: 422,
    });
  }
  const typedData = buildRiskControlTypedData(execution, {
    ...input,
    stopLossPrice,
    takeProfitPrice,
  });
  const signatureValid = await polygonPublicClient().verifyTypedData({
    address: execution.authorizationSigner as Address,
    ...typedData,
    signature: input.signature as Hex,
  });
  if (!signatureValid) {
    throw new AppError("Risk-control signature is invalid", {
      code: "INVALID_RISK_CONTROL_SIGNATURE",
      statusCode: 401,
    });
  }
  try {
    await prisma.$transaction([
      prisma.polymarketRiskControlAuthorization.create({
        data: {
          executionId: execution.id,
          authorizationNonce: input.nonce.toLowerCase(),
          authorizationDeadline: new Date(input.deadline * 1_000),
          authorizationSigner: execution.authorizationSigner,
          authorizationSignature: input.signature,
          stopLossPrice,
          takeProfitPrice,
        },
      }),
      prisma.polymarketMarginExecution.update({
        where: { id: execution.id },
        data: { stopLossPrice, takeProfitPrice },
      }),
    ]);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("Risk-control authorization nonce was already used", {
        code: "RISK_CONTROL_AUTHORIZATION_REPLAY",
        statusCode: 409,
      });
    }
    throw error;
  }
  return getPolymarketPositionControls(input.positionId, input.userId);
}

export async function preparePolymarketPrincipalRepayment(input: {
  positionId: string;
  userId: string;
  assets: string;
}) {
  if (!env.polymarketActiveRepayEnabled) {
    throw new AppError(
      "Active principal repayment requires the compatible Polygon vault deployment",
      {
        code: "ACTIVE_REPAYMENT_NOT_ENABLED",
        statusCode: 503,
      },
    );
  }
  const execution = await getOwnedExecutionByPosition(input.positionId, input.userId);
  if (execution.state !== PolymarketMarginExecutionState.OPEN || !execution.loanId) {
    throw new AppError("Only an open margin position can reduce principal", {
      code: "POSITION_NOT_OPEN",
      statusCode: 422,
    });
  }
  const assets = parseSixDecimalAssets(input.assets, "assets");
  const loan = await readLoan(execution.vaultAddress, execution.loanId as Hex);
  if (assets === 0n || assets > loan.borrowAssets) {
    throw new AppError("Repayment must be positive and no greater than current principal", {
      code: "INVALID_REPAYMENT_AMOUNT",
      statusCode: 422,
    });
  }
  const approvalCall = {
    id: "approve-pusd-repayment",
    chainId: polygonChainId,
    to: requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS"),
    value: "0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [execution.vaultAddress as Address, assets],
    }),
  };
  const repaymentCall = {
    id: "repay-principal",
    chainId: polygonChainId,
    to: execution.vaultAddress,
    value: "0",
    data: encodeFunctionData({
      abi: vaultAbi,
      functionName: "repayLoanPrincipal",
      args: [execution.loanId as Hex, assets],
    }),
  };
  return {
    assets: formatSixDecimalAssets(assets),
    currentBorrowAssets: formatSixDecimalAssets(loan.borrowAssets),
    remainingBorrowAssets: formatSixDecimalAssets(loan.borrowAssets - assets),
    walletCalls: [approvalCall, repaymentCall],
  };
}

export async function recordPolymarketPrincipalRepayment(input: {
  executionId: string;
  userId: string;
  assets: string;
  transactionHash: string;
}) {
  if (!env.polymarketActiveRepayEnabled) throw new Error("Active repayment is disabled");
  const execution = await getOwnedExecution(input.executionId, input.userId);
  if (!execution.loanId) throw new Error("Execution has no active vault loan");
  const expectedAssets = parseSixDecimalAssets(input.assets, "assets");
  if (!transactionHashPattern.test(input.transactionHash))
    throw new Error("Repayment transaction hash is malformed");
  const receipt = await polygonPublicClient().waitForTransactionReceipt({
    hash: input.transactionHash as Hex,
  });
  if (receipt.status !== "success") throw new Error("Principal repayment failed on Polygon");
  const event = parsePrincipalRepayment(receipt.logs, execution.vaultAddress);
  if (
    !event ||
    event.loanId.toLowerCase() !== execution.loanId.toLowerCase() ||
    event.trader.toLowerCase() !== execution.position.walletAddress?.toLowerCase() ||
    event.assets !== expectedAssets
  ) {
    throw new Error("Repayment receipt does not match this position and amount");
  }
  await prisma.polymarketDebtRepayment.upsert({
    where: { transactionHash: receipt.transactionHash.toLowerCase() },
    create: {
      executionId: execution.id,
      userId: input.userId,
      assets: formatSixDecimalAssets(event.assets),
      transactionHash: receipt.transactionHash.toLowerCase(),
      confirmedAt: new Date(),
    },
    update: {},
  });
  await createLifecycleNotification(
    execution,
    "POSITION_PRINCIPAL_REPAID",
    `${formatSixDecimalAssets(event.assets)} pUSD reduced your margin principal.`,
  );
  return getPolymarketPositionControls(execution.positionId, input.userId);
}

export async function monitorPolymarketPositionLifecycles(limit = 25) {
  if (!env.polymarketLifecycleEnabled) {
    return { enabled: false, inspected: 0, triggered: 0, results: [] };
  }
  const records = await prisma.polymarketMarginExecution.findMany({
    where: { state: PolymarketMarginExecutionState.OPEN, activeCloseAttemptId: null },
    include: { position: { include: { market: true } } },
    orderBy: { openedAt: "asc" },
    take: Math.max(1, Math.min(limit, 50)),
  });
  const results: Array<{ executionId: string; action: string; error?: string }> = [];
  for (const execution of records) {
    try {
      const action = await assessOpenExecution(execution);
      results.push({ executionId: execution.id, action });
    } catch (error) {
      const message = providerError(error);
      await createLifecycleNotification(
        execution,
        "RISK_MONITOR_ALERT",
        `Position monitoring needs attention: ${message}`,
      );
      results.push({ executionId: execution.id, action: "ALERT", error: message });
    }
  }
  return {
    enabled: true,
    inspected: records.length,
    triggered: results.filter((result) => !["HEALTHY", "ALERT"].includes(result.action)).length,
    results,
  };
}

export async function getPolymarketLifecycleHealth() {
  const now = Date.now();
  const staleStageBefore = new Date(now - 10 * 60_000);
  const [openRecords, closing, reconciliationRequired, staleClosing, failedAttempts] =
    await Promise.all([
      prisma.polymarketMarginExecution.findMany({
        where: { state: PolymarketMarginExecutionState.OPEN },
        select: {
          id: true,
          position: {
            select: {
              market: {
                select: {
                  syncedAt: true,
                  marginRiskPolicy: { select: { maximumPriceAgeSeconds: true } },
                },
              },
            },
          },
        },
      }),
      prisma.polymarketMarginExecution.count({
        where: { state: PolymarketMarginExecutionState.CLOSING },
      }),
      prisma.polymarketMarginExecution.count({
        where: { state: PolymarketMarginExecutionState.RECONCILIATION_REQUIRED },
      }),
      prisma.polymarketMarginExecution.count({
        where: {
          state: PolymarketMarginExecutionState.CLOSING,
          updatedAt: { lt: staleStageBefore },
        },
      }),
      prisma.polymarketCloseAttempt.count({
        where: {
          OR: [
            { stage: PolymarketCloseStage.FAILED },
            { stage: PolymarketCloseStage.SETTLING, updatedAt: { lt: staleStageBefore } },
            { failureCode: { not: null } },
          ],
        },
      }),
    ]);
  const staleFeeds = openRecords.filter((record) => {
    const market = record.position.market;
    const maxAge = market.marginRiskPolicy?.maximumPriceAgeSeconds ?? 60;
    return !market.syncedAt || now - market.syncedAt.getTime() > maxAge * 1_000;
  }).length;

  let vault: null | {
    paused: boolean;
    protocolReserves: string;
    totalBorrowedAssets: string;
    totalUncoveredBadDebt: string;
    reserveCoverageBps: number | null;
  } = null;
  if (env.polymarketPusdVaultAddress) {
    const address = env.polymarketPusdVaultAddress as Address;
    const [paused, reserves, borrowed, uncovered] = await Promise.all([
      polygonPublicClient().readContract({ abi: vaultAbi, address, functionName: "paused" }),
      polygonPublicClient().readContract({
        abi: vaultAbi,
        address,
        functionName: "protocolReserves",
      }),
      polygonPublicClient().readContract({
        abi: vaultAbi,
        address,
        functionName: "totalBorrowedAssets",
      }),
      polygonPublicClient().readContract({
        abi: vaultAbi,
        address,
        functionName: "totalUncoveredBadDebt",
      }),
    ]);
    vault = {
      paused,
      protocolReserves: formatSixDecimalAssets(reserves),
      totalBorrowedAssets: formatSixDecimalAssets(borrowed),
      totalUncoveredBadDebt: formatSixDecimalAssets(uncovered),
      reserveCoverageBps: borrowed === 0n ? null : Number((reserves * 10_000n) / borrowed),
    };
  }
  const alerts = [
    ...(staleFeeds > 0 ? [`${staleFeeds} open positions have stale market feeds.`] : []),
    ...(staleClosing > 0 ? [`${staleClosing} closes have not advanced for ten minutes.`] : []),
    ...(failedAttempts > 0 ? [`${failedAttempts} close attempts require reconciliation.`] : []),
    ...(reconciliationRequired > 0
      ? [`${reconciliationRequired} open executions require reconciliation.`]
      : []),
    ...(vault?.totalUncoveredBadDebt !== "0" ? ["Vault reports uncovered bad debt."] : []),
  ];
  return {
    status: alerts.length === 0 ? "HEALTHY" : "ATTENTION_REQUIRED",
    open: openRecords.length,
    closing,
    staleFeeds,
    staleClosing,
    failedAttempts,
    reconciliationRequired,
    vault,
    alerts,
  };
}

async function assessOpenExecution(execution: ExecutionWithPosition) {
  const policy = await prisma.marginMarketPolicy.findUnique({
    where: { marketId: execution.position.marketId },
  });
  if (!policy) throw new Error("Open position is missing its margin risk policy");

  if (["SETTLED", "CLOSED"].includes(execution.position.market.status)) {
    await createSystemCloseAttempt(execution, PolymarketCloseReason.RESOLUTION, null, false);
    return "RESOLUTION";
  }
  const quote = await createCloseQuote(execution, 500);
  if (Date.now() >= policy.mandatoryCloseAt.getTime()) {
    await createSystemCloseAttempt(execution, PolymarketCloseReason.MANDATORY, quote, false);
    return "MANDATORY";
  }

  const executableExitPrice = Number(quote.depthFloorPrice);
  if (
    execution.stopLossPrice &&
    Number.isFinite(executableExitPrice) &&
    executableExitPrice <= Number(execution.stopLossPrice)
  ) {
    await createSystemCloseAttempt(execution, PolymarketCloseReason.STOP_LOSS, quote, false);
    return "STOP_LOSS";
  }
  if (
    execution.takeProfitPrice &&
    Number.isFinite(executableExitPrice) &&
    executableExitPrice >= Number(execution.takeProfitPrice)
  ) {
    await createSystemCloseAttempt(execution, PolymarketCloseReason.TAKE_PROFIT, quote, false);
    return "TAKE_PROFIT";
  }

  const loan = await readLoan(execution.vaultAddress, requiredLoanId(execution));
  const conservativeValue = parseSixDecimalAssets(quote.minimumProceeds, "minimumProceeds");
  const healthy =
    conservativeValue * BigInt(10_000 - policy.maintenanceMarginBps) >= loan.borrowAssets * 10_000n;
  if (healthy) return "HEALTHY";

  const directCap = parseSixDecimalAssets(
    env.polymarketDirectLiquidationMaxAssets,
    "POLYMARKET_DIRECT_LIQUIDATION_MAX_ASSETS",
  );
  const openedNotional = parseSixDecimalAssets(
    requiredText(execution.actualSpentAssets, "actualSpentAssets"),
    "actualSpentAssets",
  );
  const auctionRequired = openedNotional > directCap;
  await createSystemCloseAttempt(
    execution,
    PolymarketCloseReason.LIQUIDATION,
    quote,
    auctionRequired,
  );
  return auctionRequired ? "AUCTION_REQUIRED" : "LIQUIDATION";
}

async function createSystemCloseAttempt(
  execution: ExecutionWithPosition,
  reason: PolymarketCloseReason,
  quote: Awaited<ReturnType<typeof createCloseQuote>> | null,
  auctionRequired: boolean,
) {
  const nonce = keccak256(
    toBytes(`conviction:${reason}:${execution.id}:${Math.floor(Date.now() / 60_000)}`),
  );
  const deadline = new Date(Date.now() + 60 * 60_000);
  const stage = auctionRequired
    ? PolymarketCloseStage.AUCTION_REQUIRED
    : PolymarketCloseStage.AUTHORIZED;
  const attempt = await prisma.$transaction(async (tx) => {
    const created = await tx.polymarketCloseAttempt.create({
      data: {
        executionId: execution.id,
        idempotencyKey: `system:${reason.toLowerCase()}:${execution.id}:${nonce}`,
        authorizationNonce: nonce,
        authorizationDeadline: deadline,
        authorizationSigner: "SYSTEM_RISK_ENGINE",
        authorizationSignature: "SYSTEM_POLICY_AUTHORIZATION",
        reason,
        stage,
        maxSlippageBps: 500,
        priceLimit: quote?.priceLimit ?? execution.position.market.orderPriceMinTickSize ?? "0.01",
        minimumProceeds: quote?.minimumProceeds ?? "0",
        requestPayload: quote
          ? {
              amountShares: quote.amountShares,
              feeRateBps: quote.feeRateBps,
              trigger: reason,
            }
          : { amountShares: execution.actualShares, trigger: reason },
      },
    });
    const claimed = await tx.polymarketMarginExecution.updateMany({
      where: {
        id: execution.id,
        state: PolymarketMarginExecutionState.OPEN,
        activeCloseAttemptId: null,
      },
      data: {
        activeCloseAttemptId: created.id,
        ...(auctionRequired
          ? {}
          : { state: PolymarketMarginExecutionState.CLOSING, closingAt: new Date() }),
      },
    });
    if (claimed.count !== 1) throw new Error("System close was concurrently claimed");
    return created;
  });

  await createLifecycleNotification(
    execution,
    auctionRequired ? "LIQUIDATION_AUCTION_REQUIRED" : `POSITION_${reason}`,
    auctionRequired
      ? "Your position crossed maintenance and is above the direct-liquidation cap. It was routed for auction handling."
      : `A ${reason.toLowerCase()} close was started under the signed margin risk policy.`,
  );
  return attempt;
}

function createLifecycleNotification(
  execution: ExecutionWithPosition,
  type: string,
  message: string,
) {
  return prisma.userNotification.create({
    data: {
      userId: execution.position.userId,
      type,
      entityType: "POSITION",
      entityId: execution.positionId,
      message,
    },
  });
}

export async function reconcilePendingPolymarketExecutions(limit = 10) {
  const boundedLimit = Math.max(1, Math.min(limit, 25));
  const records = await prisma.polymarketMarginExecution.findMany({
    where: {
      state: {
        in: [
          PolymarketMarginExecutionState.RESERVED,
          PolymarketMarginExecutionState.WALLET_DEPLOYING,
          PolymarketMarginExecutionState.WALLET_COMMITTED,
          PolymarketMarginExecutionState.FUNDED,
          PolymarketMarginExecutionState.ORDER_PREPARED,
          PolymarketMarginExecutionState.ORDER_SUBMITTED,
          PolymarketMarginExecutionState.FILL_CONFIRMED,
          PolymarketMarginExecutionState.SECURED,
          PolymarketMarginExecutionState.CLOSING,
          PolymarketMarginExecutionState.RECONCILIATION_REQUIRED,
        ],
      },
      OR: [{ operationLockedUntil: null }, { operationLockedUntil: { lt: new Date() } }],
    },
    include: { position: { include: { market: true } } },
    orderBy: { updatedAt: "asc" },
    take: boundedLimit,
  });
  const results: Array<{ executionId: string; state: string; error?: string }> = [];

  for (const record of records) {
    try {
      const result = await advanceExecutionRecord(record);
      results.push({ executionId: record.id, state: result.state });
    } catch (error) {
      results.push({
        executionId: record.id,
        state: record.state,
        error: providerError(error),
      });
    }
  }

  return {
    requested: boundedLimit,
    processed: results.length,
    succeeded: results.filter((result) => !result.error).length,
    failed: results.filter((result) => result.error).length,
    results,
  };
}

async function advanceExecutionRecord(initial: ExecutionWithPosition) {
  if (
    initial.state === PolymarketMarginExecutionState.OPEN ||
    initial.state === PolymarketMarginExecutionState.CLOSED ||
    initial.state === PolymarketMarginExecutionState.CANCELLED ||
    initial.state === PolymarketMarginExecutionState.FAILED
  ) {
    return normalizePolymarketMarginExecution(initial);
  }
  const operationId = randomUUID();
  const acquired = await prisma.polymarketMarginExecution.updateMany({
    where: {
      id: initial.id,
      OR: [{ operationLockedUntil: null }, { operationLockedUntil: { lt: new Date() } }],
    },
    data: {
      operationId,
      operationLockedUntil: new Date(Date.now() + executionLockMs),
    },
  });
  if (acquired.count !== 1) {
    throw new AppError("Execution is already being reconciled", {
      code: "POLYMARKET_EXECUTION_BUSY",
      statusCode: 409,
    });
  }

  try {
    const execution = await getExecutionWithPosition(initial.id);
    await assertExecutionRuntimeReady(execution);
    const updated = await advanceOneStage(execution);
    return normalizePolymarketMarginExecution(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Execution failed";
    if (initial.state === PolymarketMarginExecutionState.CLOSING) {
      if (initial.activeCloseAttemptId) {
        await prisma.polymarketCloseAttempt.updateMany({
          where: { id: initial.activeCloseAttemptId },
          data: {
            failureCode: "CLOSE_STAGE_REQUIRES_RECONCILIATION",
            failureMessage: message,
          },
        });
      }
      const updated = await prisma.polymarketMarginExecution.update({
        where: { id: initial.id },
        data: {
          failureCode: "CLOSE_STAGE_REQUIRES_RECONCILIATION",
          failureMessage: message,
          lastReconciledAt: new Date(),
        },
      });
      return normalizePolymarketMarginExecution(updated);
    }
    const updated = await prisma.polymarketMarginExecution.update({
      where: { id: initial.id },
      data: {
        state: PolymarketMarginExecutionState.RECONCILIATION_REQUIRED,
        failureCode: "EXECUTION_STAGE_REQUIRES_RECONCILIATION",
        failureMessage: message,
        lastReconciledAt: new Date(),
      },
    });
    return normalizePolymarketMarginExecution(updated);
  } finally {
    await prisma.polymarketMarginExecution.updateMany({
      where: { id: initial.id, operationId },
      data: { operationId: null, operationLockedUntil: null },
    });
  }
}

export async function getPolymarketExecutionReadiness() {
  const missing: string[] = [];
  const warnings: string[] = [];
  const official = getContractConfig(polygonChainId);
  const expectedAddresses = {
    POLYMARKET_PUSD_ADDRESS: official.collateral,
    POLYMARKET_CTF_ADDRESS: official.conditionalTokens,
    POLYMARKET_EXCHANGE_V2_ADDRESS: official.exchangeV2,
    POLYMARKET_NEG_RISK_EXCHANGE_V2_ADDRESS: official.negRiskExchangeV2,
    POLYMARKET_NEG_RISK_ADAPTER_ADDRESS: official.negRiskAdapter,
  };
  const configuredAddresses = {
    POLYMARKET_PUSD_ADDRESS: env.polymarketPusdAddress,
    POLYMARKET_CTF_ADDRESS: env.polymarketCtfAddress,
    POLYMARKET_EXCHANGE_V2_ADDRESS: env.polymarketExchangeV2Address,
    POLYMARKET_NEG_RISK_EXCHANGE_V2_ADDRESS: env.polymarketNegRiskExchangeV2Address,
    POLYMARKET_NEG_RISK_ADAPTER_ADDRESS: env.polymarketNegRiskAdapterAddress,
  };

  for (const [name, expected] of Object.entries(expectedAddresses)) {
    const configured = configuredAddresses[name as keyof typeof configuredAddresses];
    if (!configured) missing.push(`${name} is missing.`);
    else if (configured.toLowerCase() !== expected.toLowerCase()) {
      missing.push(`${name} does not match the current official CLOB V2 address.`);
    }
  }
  for (const [name, value] of [
    ["POLYMARKET_PUSD_VAULT_ADDRESS", env.polymarketPusdVaultAddress],
    ["POLYMARKET_EXECUTION_ADAPTER_ADDRESS", env.polymarketExecutionAdapterAddress],
    ["POLYMARKET_EXECUTION_SIGNER_PRIVATE_KEY", env.polymarketExecutionSignerPrivateKey],
    ["POLYMARKET_EXECUTION_KEY_ENCRYPTION_KEY", env.polymarketExecutionKeyEncryptionKey],
    ["POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS", env.polymarketDepositWalletFactoryAddress],
    ["POLYMARKET_BUILDER_CODE", env.polymarketBuilderCode],
    ["POLYMARKET_GOVERNANCE_ADDRESS", env.polymarketGovernanceAddress],
    ["POLYMARKET_GUARDIAN_ADDRESS", env.polymarketGuardianAddress],
    ["POLYMARKET_RISK_MANAGER_ADDRESS", env.polymarketRiskManagerAddress],
  ] as const) {
    if (!value) missing.push(`${name} is missing.`);
  }
  const hasRelayerKey = Boolean(
    (env.polymarketRelayerApiKey && env.polymarketRelayerApiKeyAddress) ||
      (env.polymarketBuilderApiKey &&
        env.polymarketBuilderApiSecret &&
        env.polymarketBuilderApiPassphrase),
  );
  if (!hasRelayerKey)
    missing.push("Relayer API credentials or builder HMAC credentials are missing.");
  if (env.convictionExecutionMode !== "polymarket") {
    missing.push("CONVICTION_EXECUTION_MODE is not polymarket.");
  }
  if (!env.polymarketLifecycleEnabled) {
    missing.push("POLYMARKET_LIFECYCLE_ENABLED is false.");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if ((major ?? 0) < 20 || ((major ?? 0) === 20 && (minor ?? 0) < 10)) {
    missing.push("Node 20.10 or newer is required by the official CLOB V2 client.");
  }

  if (missing.length === 0) {
    try {
      const publicClient = polygonPublicClient();
      const vault = env.polymarketPusdVaultAddress as Address;
      const adapterAccount = privateKeyToAccount(env.polymarketExecutionSignerPrivateKey as Hex);
      if (
        adapterAccount.address.toLowerCase() !==
        env.polymarketExecutionAdapterAddress!.toLowerCase()
      ) {
        missing.push("Execution signer does not match POLYMARKET_EXECUTION_ADAPTER_ADDRESS.");
      }
      const [
        vaultCode,
        asset,
        chainId,
        adapterAllowed,
        pusdAllowed,
        owner,
        guardian,
        riskManager,
        paused,
        reserves,
        borrowed,
        uncoveredBadDebt,
      ] = await Promise.all([
        publicClient.getCode({ address: vault }),
        publicClient.readContract({ abi: vaultAbi, address: vault, functionName: "asset" }),
        publicClient.readContract({
          abi: vaultAbi,
          address: vault,
          functionName: "deploymentChainId",
        }),
        publicClient.readContract({
          abi: vaultAbi,
          address: vault,
          functionName: "authorizedAdapters",
          args: [adapterAccount.address],
        }),
        publicClient.readContract({
          abi: vaultAbi,
          address: vault,
          functionName: "isExecutionTargetAllowed",
          args: [env.polymarketPusdAddress as Address],
        }),
        publicClient.readContract({ abi: vaultAbi, address: vault, functionName: "owner" }),
        publicClient.readContract({ abi: vaultAbi, address: vault, functionName: "guardian" }),
        publicClient.readContract({ abi: vaultAbi, address: vault, functionName: "riskManager" }),
        publicClient.readContract({ abi: vaultAbi, address: vault, functionName: "paused" }),
        publicClient.readContract({
          abi: vaultAbi,
          address: vault,
          functionName: "protocolReserves",
        }),
        publicClient.readContract({
          abi: vaultAbi,
          address: vault,
          functionName: "totalBorrowedAssets",
        }),
        publicClient.readContract({
          abi: vaultAbi,
          address: vault,
          functionName: "totalUncoveredBadDebt",
        }),
      ]);
      if (!vaultCode || vaultCode === "0x")
        missing.push("Configured Polygon vault has no bytecode.");
      if (asset.toLowerCase() !== env.polymarketPusdAddress!.toLowerCase()) {
        missing.push("Polygon vault asset is not the configured pUSD contract.");
      }
      if (chainId !== 137n) missing.push("Polygon vault deploymentChainId is not 137.");
      if (!adapterAllowed)
        missing.push("Execution adapter is not authorized by the Polygon vault.");
      if (!pusdAllowed)
        missing.push("Polygon vault has not allowlisted pUSD as an execution target.");
      if (owner.toLowerCase() !== env.polymarketGovernanceAddress!.toLowerCase()) {
        missing.push("Vault owner does not match POLYMARKET_GOVERNANCE_ADDRESS.");
      }
      if (guardian.toLowerCase() !== env.polymarketGuardianAddress!.toLowerCase()) {
        missing.push("Vault guardian does not match POLYMARKET_GUARDIAN_ADDRESS.");
      }
      if (riskManager.toLowerCase() !== env.polymarketRiskManagerAddress!.toLowerCase()) {
        missing.push("Vault risk manager does not match POLYMARKET_RISK_MANAGER_ADDRESS.");
      }
      const roleAddresses = new Set([
        owner.toLowerCase(),
        guardian.toLowerCase(),
        riskManager.toLowerCase(),
        adapterAccount.address.toLowerCase(),
      ]);
      if (roleAddresses.size !== 4) missing.push("Vault governance roles are not separated.");
      if (paused) missing.push("Polygon vault is paused for new risk.");
      if (borrowed > 0n && (reserves * 10_000n) / borrowed < BigInt(env.polymarketMinReserveBps)) {
        missing.push("Protocol reserve coverage is below POLYMARKET_MIN_RESERVE_BPS.");
      }
      if (uncoveredBadDebt > 0n) missing.push("Vault reports uncovered bad debt.");
      if (env.polymarketActiveRepayEnabled) {
        const repaymentVersion = await publicClient.readContract({
          abi: vaultAbi,
          address: vault,
          functionName: "ACTIVE_REPAYMENT_VERSION",
        });
        if (repaymentVersion !== activeRepaymentVersion) {
          missing.push("Polygon vault does not match the active repayment implementation.");
        }
      }

      const [clobOk, clobVersion] = await Promise.all([
        fetch(new URL("/ok", env.polymarketClobApiUrl), {
          signal: AbortSignal.timeout(5_000),
        }),
        fetch(new URL("/version", env.polymarketClobApiUrl), {
          signal: AbortSignal.timeout(5_000),
        }),
      ]);
      if (!clobOk.ok) missing.push("Polymarket CLOB health endpoint is unavailable.");
      const versionPayload = (await clobVersion.json()) as { version?: number };
      if (!clobVersion.ok || versionPayload.version !== 2) {
        missing.push("Polymarket CLOB is not reporting V2.");
      }
    } catch (error) {
      missing.push(`Polygon/CLOB readiness probe failed: ${providerError(error)}`);
    }
  }
  if (missing.length === 0 && !env.polymarketCanaryPassed) {
    warnings.push(
      "A small real-money open-secure-close-repay canary is still required before caps are raised.",
    );
  }

  const infrastructureReady = missing.length === 0;
  const productionReady = infrastructureReady && env.polymarketCanaryPassed;

  return {
    status: productionReady ? "READY" : infrastructureReady ? "READY_FOR_CANARY" : "BLOCKED",
    venueFillEnabled: infrastructureReady,
    canaryVenueFillEnabled: infrastructureReady && !env.polymarketCanaryPassed,
    productionVenueFillEnabled: productionReady,
    chainId: polygonChainId,
    custody: "ONE_POSITION_ONE_ISOLATED_ACCOUNT",
    orderType: "FOK",
    signatureType: "POLY_1271",
    missing,
    warnings,
  };
}

async function advanceOneStage(execution: ExecutionWithPosition) {
  switch (execution.state) {
    case PolymarketMarginExecutionState.RESERVED:
      return startDepositWalletDeployment(execution);
    case PolymarketMarginExecutionState.WALLET_DEPLOYING:
      return reconcileDepositWalletAndFunding(execution);
    case PolymarketMarginExecutionState.WALLET_COMMIT_REQUIRED:
      return execution;
    case PolymarketMarginExecutionState.WALLET_COMMITTED:
      return fundCommittedExecutionWallet(execution);
    case PolymarketMarginExecutionState.FUNDED:
      return prepareDurableFokOrder(execution);
    case PolymarketMarginExecutionState.ORDER_PREPARED:
      return postDurableFokOrder(execution);
    case PolymarketMarginExecutionState.ORDER_SUBMITTED:
      return reconcileClobFill(execution);
    case PolymarketMarginExecutionState.FILL_CONFIRMED:
      return secureFilledShares(execution);
    case PolymarketMarginExecutionState.SECURED:
      return markExecutionOpen(execution);
    case PolymarketMarginExecutionState.CLOSING:
      return advanceCloseStage(execution);
    case PolymarketMarginExecutionState.RECONCILIATION_REQUIRED:
      return recoverReconciliationState(execution);
    case PolymarketMarginExecutionState.AUTHORIZED:
      throw new Error("Record the confirmed vault reservation before execution can advance");
    default:
      return execution;
  }
}

async function advanceCloseStage(execution: ExecutionWithPosition) {
  const attempt = await getActiveCloseAttempt(execution);
  switch (attempt.stage) {
    case PolymarketCloseStage.AUTHORIZED:
    case PolymarketCloseStage.SHARES_RELEASING:
      return beginGuardedClose(execution, attempt);
    case PolymarketCloseStage.SHARES_RELEASED:
      return attempt.reason === PolymarketCloseReason.RESOLUTION
        ? submitResolutionRedemption(execution, attempt)
        : prepareCloseOrder(execution, attempt);
    case PolymarketCloseStage.ORDER_PREPARED:
      return postCloseOrder(execution, attempt);
    case PolymarketCloseStage.ORDER_SUBMITTED:
      return reconcileCloseFill(execution, attempt);
    case PolymarketCloseStage.FILL_CONFIRMED:
    case PolymarketCloseStage.PROCEEDS_RETURNING:
      return returnCloseProceeds(execution, attempt);
    case PolymarketCloseStage.SETTLING:
      return settleGuardedClose(execution, attempt);
    case PolymarketCloseStage.NO_FILL_RETURNING:
      return returnNoFillShares(execution, attempt);
    case PolymarketCloseStage.NO_FILL_RESTORING:
      return restoreNoFillLoan(execution, attempt);
    case PolymarketCloseStage.RESOLUTION_REDEEMING:
      return reconcileResolutionRedemption(execution, attempt);
    case PolymarketCloseStage.RESTORED:
    case PolymarketCloseStage.CLOSED:
      return getExecutionWithPosition(execution.id);
    case PolymarketCloseStage.AUCTION_REQUIRED:
      throw new Error("Large liquidation requires the auction operator");
    case PolymarketCloseStage.FAILED:
      throw new Error(attempt.failureMessage ?? "Close attempt failed");
  }
}

async function beginGuardedClose(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
) {
  if (
    attempt.stage === PolymarketCloseStage.AUTHORIZED &&
    attempt.authorizationDeadline.getTime() <= Date.now()
  ) {
    return expireUnusedCloseAuthorization(execution, attempt);
  }
  const loan = await readLoan(execution.vaultAddress, requiredLoanId(execution));
  if (loan.status === terminalLoanStatus.SETTLED) {
    return finalizeClosedExecution(execution, attempt, null);
  }
  if (![terminalLoanStatus.ACTIVE, closingLoanStatus].includes(Number(loan.status))) {
    throw new Error(`Vault loan cannot begin close from status ${loan.status}`);
  }
  const depositWallet = requiredAddress(execution.depositWalletAddress, "depositWalletAddress");
  if (
    loan.executionWallet !== "0x0000000000000000000000000000000000000000" &&
    loan.executionWallet.toLowerCase() !== depositWallet.toLowerCase()
  ) {
    throw new Error("Vault loan execution wallet does not match the linked deposit wallet");
  }
  const collateral = requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
  const baselineAssets = await readErc20Balance(collateral, depositWallet);

  let beginHash = attempt.vaultBeginTxHash;
  if (loan.status === terminalLoanStatus.ACTIVE) {
    await prisma.polymarketCloseAttempt.update({
      where: { id: attempt.id },
      data: { stage: PolymarketCloseStage.SHARES_RELEASING },
    });
    beginHash = await writeAdapterContract(execution, {
      abi: vaultAbi,
      address: execution.vaultAddress as Address,
      functionName: "beginLoanClose",
      args: [requiredLoanId(execution)],
    });
  }
  const closingLoan = await readLoan(execution.vaultAddress, requiredLoanId(execution));
  if (closingLoan.status !== closingLoanStatus) {
    throw new Error("Vault loan did not enter CLOSING after custody release");
  }
  await prisma.polymarketCloseAttempt.update({
    where: { id: attempt.id },
    data: {
      stage: PolymarketCloseStage.SHARES_RELEASED,
      vaultBeginTxHash: beginHash,
      walletBaselineAssets: formatSixDecimalAssets(baselineAssets),
      walletBaselineShares: formatSixDecimalAssets(closingLoan.executionWalletBaselineShares),
      failureCode: null,
      failureMessage: null,
      responsePayload: { stage: "guarded_shares_released" },
    },
  });
  return getExecutionWithPosition(execution.id);
}

async function expireUnusedCloseAuthorization(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
) {
  const now = new Date();
  await prisma.$transaction([
    prisma.polymarketCloseAttempt.update({
      where: { id: attempt.id },
      data: {
        stage: PolymarketCloseStage.FAILED,
        failureCode: "CLOSE_AUTHORIZATION_EXPIRED",
        failureMessage: "Close authorization expired before custody release.",
        completedAt: now,
      },
    }),
    prisma.polymarketMarginExecution.update({
      where: { id: execution.id },
      data: {
        state: PolymarketMarginExecutionState.OPEN,
        activeCloseAttemptId: null,
        closingAt: null,
        lastReconciledAt: now,
      },
    }),
  ]);
  return getExecutionWithPosition(execution.id);
}

async function prepareCloseOrder(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
) {
  const shares = parseSixDecimalAssets(
    requiredText(execution.actualShares, "actualShares"),
    "shares",
  );
  await assertReleasedShares(execution, attempt, shares);
  const fresh = await createCloseQuote(execution, attempt.maxSlippageBps);
  if (
    parseSixDecimalAssets(fresh.depthFloorPrice, "fresh.depthFloorPrice") <
      parseSixDecimalAssets(attempt.priceLimit, "priceLimit") ||
    parseSixDecimalAssets(fresh.minimumProceeds, "fresh.minimumProceeds") <
      parseSixDecimalAssets(attempt.minimumProceeds, "minimumProceeds")
  ) {
    return markCloseNoFill(execution, attempt, "CLOSE_DEPTH_MOVED");
  }
  const signedOrder = await clobClientForExecution(execution).prepareFokSell({
    amountShares: formatSixDecimalAssets(shares),
    negativeRisk: execution.position.market.negativeRisk === true,
    priceLimit: attempt.priceLimit,
    tickSize: execution.position.market.orderPriceMinTickSize as TickSize,
    tokenId: execution.tokenId,
  });
  const orderId = calculateClobV2OrderId(
    signedOrder,
    execution.position.market.negativeRisk === true,
  );
  await prisma.polymarketCloseAttempt.update({
    where: { id: attempt.id },
    data: {
      stage: PolymarketCloseStage.ORDER_PREPARED,
      signedOrderPayload: JSON.parse(JSON.stringify(signedOrder)) as Prisma.InputJsonValue,
      clobOrderId: orderId,
      responsePayload: { stage: "close_fok_prepared", fresh },
    },
  });
  return getExecutionWithPosition(execution.id);
}

async function postCloseOrder(execution: ExecutionWithPosition, attempt: PolymarketCloseAttempt) {
  if (!attempt.signedOrderPayload || !attempt.clobOrderId) {
    throw new Error("Persisted close order is incomplete");
  }
  let response: Awaited<ReturnType<PolymarketClobExecutionClient["postPreparedFokOrder"]>>;
  try {
    response = await clobClientForExecution(execution).postPreparedFokOrder(
      attempt.signedOrderPayload as unknown as SignedOrder,
    );
  } catch (error) {
    const disposition = classifyFokPostResult({ error: providerError(error) });
    if (disposition === "NO_FILL") return markCloseNoFill(execution, attempt, "CLOSE_NO_FILL");
    if (disposition === "DUPLICATE") {
      await markCloseOrderSubmitted(attempt, "duplicate_acknowledged", [], []);
      return getExecutionWithPosition(execution.id);
    }
    throw error;
  }
  if (response.orderID.toLowerCase() !== attempt.clobOrderId.toLowerCase()) {
    throw new Error("CLOB close order id does not match the persisted V2 hash");
  }
  const disposition = classifyFokPostResult({
    success: response.success,
    status: response.status,
    error: response.errorMsg,
  });
  if (disposition === "NO_FILL") return markCloseNoFill(execution, attempt, "CLOSE_NO_FILL");
  if (disposition !== "SUBMITTED") {
    throw new Error(response.errorMsg || `Close FOK returned ${response.status}`);
  }
  await markCloseOrderSubmitted(
    attempt,
    response.status,
    response.tradeIDs,
    response.transactionsHashes,
  );
  return getExecutionWithPosition(execution.id);
}

async function reconcileCloseFill(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
) {
  if (!attempt.clobOrderId) throw new Error("Submitted close is missing its CLOB order id");
  const trades = await clobClientForExecution(execution).getTrades({
    funderAddress: requiredAddress(execution.depositWalletAddress, "depositWalletAddress"),
    tokenId: execution.tokenId,
  });
  const matching = trades.filter(
    (trade) =>
      trade.taker_order_id === attempt.clobOrderId ||
      trade.maker_orders.some((order) => order.order_id === attempt.clobOrderId),
  );
  if (matching.length === 0) return getExecutionWithPosition(execution.id);
  const evidence = summarizeClobTrades(
    matching.map((trade) => ({
      id: trade.id,
      price: trade.price,
      size: trade.size,
      feeRateBps: trade.fee_rate_bps,
      transactionHash: trade.transaction_hash,
    })),
  );
  const pledged = parseSixDecimalAssets(
    requiredText(execution.actualShares, "actualShares"),
    "shares",
  );
  if (
    parseSixDecimalAssets(evidence.actualShares, "close.actualShares") !== pledged ||
    parseSixDecimalAssets(evidence.actualFillPrice, "close.actualFillPrice") <
      parseSixDecimalAssets(attempt.priceLimit, "priceLimit")
  ) {
    throw new Error("Confirmed close fill violated signed size or price limits");
  }
  for (const hash of evidence.transactionHashes) {
    if (!transactionHashPattern.test(hash)) throw new Error("Close trade omitted a valid hash");
    const receipt = await polygonPublicClient().waitForTransactionReceipt({ hash: hash as Hex });
    if (receipt.status !== "success") throw new Error(`Close settlement ${hash} failed`);
  }

  const depositWallet = requiredAddress(execution.depositWalletAddress, "depositWalletAddress");
  const collateral = requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
  const conditionalTokens = requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  const [walletAssets, walletShares] = await Promise.all([
    readErc20Balance(collateral, depositWallet),
    readErc1155Balance(conditionalTokens, depositWallet, BigInt(execution.tokenId)),
  ]);
  const baselineAssets = parseSixDecimalAssets(
    requiredText(attempt.walletBaselineAssets, "walletBaselineAssets"),
    "walletBaselineAssets",
  );
  const baselineShares = parseSixDecimalAssets(
    requiredText(attempt.walletBaselineShares, "walletBaselineShares"),
    "walletBaselineShares",
  );
  if (walletShares !== baselineShares || walletAssets < baselineAssets) {
    throw new Error("Close wallet balances do not reconcile after the confirmed fill");
  }
  const proceeds = walletAssets - baselineAssets;
  if (proceeds < parseSixDecimalAssets(attempt.minimumProceeds, "minimumProceeds")) {
    throw new Error("Confirmed close proceeds are below the signed minimum");
  }

  await prisma.polymarketCloseAttempt.update({
    where: { id: attempt.id },
    data: {
      stage: PolymarketCloseStage.FILL_CONFIRMED,
      clobTradeIds: evidence.tradeIds,
      settlementTxHashes: evidence.transactionHashes,
      actualFillPrice: evidence.actualFillPrice,
      actualShares: evidence.actualShares,
      actualProceeds: formatSixDecimalAssets(proceeds),
      actualFeeAssets: evidence.actualFeeAssets,
      failureCode: null,
      failureMessage: null,
      responsePayload: { stage: "close_fill_confirmed" },
    },
  });
  return getExecutionWithPosition(execution.id);
}

async function returnCloseProceeds(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
) {
  const proceeds = parseSixDecimalAssets(
    requiredText(attempt.actualProceeds, "actualProceeds"),
    "actualProceeds",
  );
  if (proceeds === 0n) {
    await prisma.polymarketCloseAttempt.update({
      where: { id: attempt.id },
      data: { stage: PolymarketCloseStage.SETTLING },
    });
    return getExecutionWithPosition(execution.id);
  }
  const relayer = new PolymarketRelayerClient(executionPrivateKey(execution));
  if (!attempt.relayerTransactionId || attempt.relayerOperation !== "CLOSE_PROCEEDS") {
    const response = await relayer.executeDepositWalletBatch(
      requiredAddress(execution.depositWalletAddress, "depositWalletAddress"),
      [
        {
          target: requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS"),
          value: "0",
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [requiredAddress(execution.custodyAddress, "custodyAddress"), proceeds],
          }),
        },
      ],
      Math.floor(Date.now() / 1_000) + 5 * 60,
    );
    await prisma.polymarketCloseAttempt.update({
      where: { id: attempt.id },
      data: {
        stage: PolymarketCloseStage.PROCEEDS_RETURNING,
        relayerTransactionId: response.transactionID,
        relayerOperation: "CLOSE_PROCEEDS",
        responsePayload: { stage: "close_proceeds_return_pending" },
      },
    });
    return getExecutionWithPosition(execution.id);
  }
  const transfer = await relayer.getTransaction(attempt.relayerTransactionId);
  if (["STATE_FAILED", "STATE_INVALID"].includes(transfer.state)) {
    throw new Error(`Close proceeds return ${transfer.state}`);
  }
  if (transfer.state !== "STATE_CONFIRMED") return getExecutionWithPosition(execution.id);
  await prisma.polymarketCloseAttempt.update({
    where: { id: attempt.id },
    data: {
      stage: PolymarketCloseStage.SETTLING,
      returnTxHash: transfer.transactionHash?.toLowerCase() ?? null,
      relayerTransactionId: null,
      relayerOperation: null,
      responsePayload: { stage: "close_proceeds_returned" },
    },
  });
  return getExecutionWithPosition(execution.id);
}

async function settleGuardedClose(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
) {
  const loan = await readLoan(execution.vaultAddress, requiredLoanId(execution));
  if (loan.status === terminalLoanStatus.SETTLED) {
    return finalizeClosedExecution(execution, attempt, attempt.vaultSettlementTxHash);
  }
  if (loan.status !== closingLoanStatus) throw new Error("Vault loan is not ready to settle");
  const depositWallet = requiredAddress(execution.depositWalletAddress, "depositWalletAddress");
  const collateral = requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
  const conditionalTokens = requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  const [walletAssets, walletShares, custodyShares] = await Promise.all([
    readErc20Balance(collateral, depositWallet),
    readErc1155Balance(conditionalTokens, depositWallet, BigInt(execution.tokenId)),
    readErc1155Balance(
      conditionalTokens,
      requiredAddress(execution.custodyAddress, "custodyAddress"),
      BigInt(execution.tokenId),
    ),
  ]);
  if (
    walletAssets !==
      parseSixDecimalAssets(
        requiredText(attempt.walletBaselineAssets, "walletBaselineAssets"),
        "walletBaselineAssets",
      ) ||
    walletShares !==
      parseSixDecimalAssets(
        requiredText(attempt.walletBaselineShares, "walletBaselineShares"),
        "walletBaselineShares",
      ) ||
    custodyShares !== 0n
  ) {
    throw new Error("Close balances do not reconcile before vault settlement");
  }
  const settlementRef = keccak256(toBytes(`conviction:close:${attempt.clobOrderId ?? attempt.id}`));
  const settlementHash = await writeAdapterContract(execution, {
    abi: vaultAbi,
    address: execution.vaultAddress as Address,
    functionName: "settleLoan",
    args: [requiredLoanId(execution), settlementRef],
  });
  return finalizeClosedExecution(execution, attempt, settlementHash);
}

async function markCloseNoFill(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
  code: string,
) {
  await prisma.polymarketCloseAttempt.update({
    where: { id: attempt.id },
    data: {
      stage: PolymarketCloseStage.NO_FILL_RETURNING,
      failureCode: code,
      failureMessage: "The full close could not fill inside the signed limits.",
      responsePayload: { stage: "close_no_fill_return_required" },
    },
  });
  return getExecutionWithPosition(execution.id);
}

async function returnNoFillShares(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
) {
  const shares = parseSixDecimalAssets(
    requiredText(execution.actualShares, "actualShares"),
    "shares",
  );
  const depositWallet = requiredAddress(execution.depositWalletAddress, "depositWalletAddress");
  const custody = requiredAddress(execution.custodyAddress, "custodyAddress");
  const conditionalTokens = requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  const baseline = parseSixDecimalAssets(
    requiredText(attempt.walletBaselineShares, "walletBaselineShares"),
    "walletBaselineShares",
  );
  const [walletShares, custodyShares] = await Promise.all([
    readErc1155Balance(conditionalTokens, depositWallet, BigInt(execution.tokenId)),
    readErc1155Balance(conditionalTokens, custody, BigInt(execution.tokenId)),
  ]);
  if (walletShares === baseline && custodyShares === shares) {
    await prisma.polymarketCloseAttempt.update({
      where: { id: attempt.id },
      data: { stage: PolymarketCloseStage.NO_FILL_RESTORING },
    });
    return getExecutionWithPosition(execution.id);
  }
  if (walletShares !== baseline + shares || custodyShares !== 0n) {
    throw new Error("No-fill share balances cannot be reconciled");
  }

  const relayer = new PolymarketRelayerClient(executionPrivateKey(execution));
  if (!attempt.relayerTransactionId || attempt.relayerOperation !== "CLOSE_RETURN_SHARES") {
    const response = await relayer.executeDepositWalletBatch(
      depositWallet,
      [
        {
          target: conditionalTokens,
          value: "0",
          data: encodeFunctionData({
            abi: erc1155Abi,
            functionName: "safeTransferFrom",
            args: [depositWallet, custody, BigInt(execution.tokenId), shares, "0x"],
          }),
        },
      ],
      Math.floor(Date.now() / 1_000) + 5 * 60,
    );
    await prisma.polymarketCloseAttempt.update({
      where: { id: attempt.id },
      data: {
        relayerTransactionId: response.transactionID,
        relayerOperation: "CLOSE_RETURN_SHARES",
      },
    });
    return getExecutionWithPosition(execution.id);
  }
  const transfer = await relayer.getTransaction(attempt.relayerTransactionId);
  if (["STATE_FAILED", "STATE_INVALID"].includes(transfer.state)) {
    throw new Error(`No-fill share return ${transfer.state}`);
  }
  if (transfer.state !== "STATE_CONFIRMED") return getExecutionWithPosition(execution.id);
  await prisma.polymarketCloseAttempt.update({
    where: { id: attempt.id },
    data: {
      stage: PolymarketCloseStage.NO_FILL_RESTORING,
      returnTxHash: transfer.transactionHash?.toLowerCase() ?? null,
      relayerTransactionId: null,
      relayerOperation: null,
    },
  });
  return getExecutionWithPosition(execution.id);
}

async function restoreNoFillLoan(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
) {
  const loan = await readLoan(execution.vaultAddress, requiredLoanId(execution));
  if (loan.status === closingLoanStatus) {
    await writeAdapterContract(execution, {
      abi: vaultAbi,
      address: execution.vaultAddress as Address,
      functionName: "restoreLoanAfterFailedClose",
      args: [requiredLoanId(execution)],
    });
  } else if (loan.status !== terminalLoanStatus.ACTIVE) {
    throw new Error(`No-fill loan cannot restore from status ${loan.status}`);
  }
  await prisma.$transaction([
    prisma.polymarketCloseAttempt.update({
      where: { id: attempt.id },
      data: {
        stage: PolymarketCloseStage.RESTORED,
        completedAt: new Date(),
        responsePayload: { stage: "close_no_fill_restored" },
      },
    }),
    prisma.polymarketMarginExecution.update({
      where: { id: execution.id },
      data: {
        state: PolymarketMarginExecutionState.OPEN,
        activeCloseAttemptId: null,
        closingAt: null,
        lastReconciledAt: new Date(),
      },
    }),
  ]);
  return getExecutionWithPosition(execution.id);
}

async function submitResolutionRedemption(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
) {
  const shares = parseSixDecimalAssets(
    requiredText(execution.actualShares, "actualShares"),
    "shares",
  );
  await assertReleasedShares(execution, attempt, shares);
  const depositWallet = requiredAddress(execution.depositWalletAddress, "depositWalletAddress");
  const negativeRisk = execution.position.market.negativeRisk === true;
  const target = negativeRisk
    ? requiredAddress(env.polymarketNegRiskAdapterAddress, "POLYMARKET_NEG_RISK_ADAPTER_ADDRESS")
    : requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  const data = negativeRisk
    ? encodeFunctionData({
        abi: negativeRiskRedemptionAbi,
        functionName: "redeemPositions",
        args: [
          execution.conditionId as Hex,
          execution.position.side === "YES" ? [shares, 0n] : [0n, shares],
        ],
      })
    : encodeFunctionData({
        abi: ctfRedemptionAbi,
        functionName: "redeemPositions",
        args: [
          requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS"),
          zeroBytes32,
          execution.conditionId as Hex,
          [1n, 2n],
        ],
      });
  const response = await new PolymarketRelayerClient(
    executionPrivateKey(execution),
  ).executeDepositWalletBatch(
    depositWallet,
    [{ target, value: "0", data }],
    Math.floor(Date.now() / 1_000) + 5 * 60,
  );
  await prisma.polymarketCloseAttempt.update({
    where: { id: attempt.id },
    data: {
      stage: PolymarketCloseStage.RESOLUTION_REDEEMING,
      relayerTransactionId: response.transactionID,
      relayerOperation: "RESOLUTION_REDEEM",
      responsePayload: { stage: "resolution_redemption_pending", negativeRisk },
    },
  });
  return getExecutionWithPosition(execution.id);
}

async function reconcileResolutionRedemption(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
) {
  if (!attempt.relayerTransactionId) throw new Error("Resolution redemption id is missing");
  const relayer = new PolymarketRelayerClient(executionPrivateKey(execution));
  const redemption = await relayer.getTransaction(attempt.relayerTransactionId);
  if (["STATE_FAILED", "STATE_INVALID"].includes(redemption.state)) {
    throw new Error(`Resolution redemption ${redemption.state}`);
  }
  if (redemption.state !== "STATE_CONFIRMED") return getExecutionWithPosition(execution.id);
  const depositWallet = requiredAddress(execution.depositWalletAddress, "depositWalletAddress");
  const [walletAssets, walletShares] = await Promise.all([
    readErc20Balance(
      requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS"),
      depositWallet,
    ),
    readErc1155Balance(
      requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS"),
      depositWallet,
      BigInt(execution.tokenId),
    ),
  ]);
  const baselineAssets = parseSixDecimalAssets(
    requiredText(attempt.walletBaselineAssets, "walletBaselineAssets"),
    "walletBaselineAssets",
  );
  const baselineShares = parseSixDecimalAssets(
    requiredText(attempt.walletBaselineShares, "walletBaselineShares"),
    "walletBaselineShares",
  );
  if (walletAssets < baselineAssets || walletShares !== baselineShares) {
    throw new Error("Resolution wallet balances do not reconcile");
  }
  await prisma.polymarketCloseAttempt.update({
    where: { id: attempt.id },
    data: {
      stage: PolymarketCloseStage.FILL_CONFIRMED,
      actualShares: execution.actualShares,
      actualProceeds: formatSixDecimalAssets(walletAssets - baselineAssets),
      settlementTxHashes: redemption.transactionHash
        ? [redemption.transactionHash.toLowerCase()]
        : [],
      relayerTransactionId: null,
      relayerOperation: null,
      responsePayload: { stage: "resolution_redeemed" },
    },
  });
  return getExecutionWithPosition(execution.id);
}

async function startDepositWalletDeployment(execution: ExecutionWithPosition) {
  const encryptionKey = requiredEncryptionKey();
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const prepared = await prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      state: PolymarketMarginExecutionState.WALLET_DEPLOYING,
      sessionSignerAddress: account.address.toLowerCase(),
      sessionSignerCiphertext: encryptJson({ privateKey }, encryptionKey),
      failureCode: null,
      failureMessage: null,
    },
    include: { position: { include: { market: true } } },
  });
  return submitDepositWalletDeployment(prepared);
}

async function submitDepositWalletDeployment(execution: ExecutionWithPosition) {
  const privateKey = executionPrivateKey(execution);
  const relayer = new PolymarketRelayerClient(privateKey);
  const response = await relayer.deployDepositWallet();
  return prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      relayerTransactionId: response.transactionID,
      relayerOperation: "DEPLOY",
      responsePayload: {
        stage: "deposit_wallet_deploying",
        relayerState: response.state ?? "STATE_NEW",
      },
    },
  });
}

async function reconcileDepositWalletAndFunding(execution: ExecutionWithPosition) {
  if (!execution.relayerTransactionId) return submitDepositWalletDeployment(execution);
  const privateKey = executionPrivateKey(execution);
  const relayer = new PolymarketRelayerClient(privateKey);

  const deployed = await relayer.getTransaction(execution.relayerTransactionId);
  if (deployed.state !== "STATE_CONFIRMED") {
    if (["STATE_FAILED", "STATE_INVALID"].includes(deployed.state)) {
      throw new Error(`Deposit-wallet deployment ${deployed.state}`);
    }
    return execution;
  }
  if (!deployed.proxyAddress || !isAddress(deployed.proxyAddress)) {
    throw new Error("Confirmed deposit-wallet deployment omitted the wallet address");
  }
  const depositWallet = getAddress(deployed.proxyAddress);
  const publicClient = polygonPublicClient();
  const code = await publicClient.getCode({ address: depositWallet });
  if (!code || code === "0x") throw new Error("Confirmed deposit wallet has no Polygon bytecode");

  let credentialsCiphertext = execution.clobCredentialsCiphertext;
  if (!credentialsCiphertext) {
    const clob = new PolymarketClobExecutionClient({ privateKey, funderAddress: depositWallet });
    const credentials = await clob.createOrDeriveCredentials();
    credentialsCiphertext = encryptJson(credentials, requiredEncryptionKey());
  }
  return prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      state: PolymarketMarginExecutionState.WALLET_COMMIT_REQUIRED,
      depositWalletAddress: depositWallet.toLowerCase(),
      clobCredentialsCiphertext: credentialsCiphertext,
      relayerTransactionId: null,
      relayerOperation: null,
      responsePayload: {
        stage: "execution_wallet_commit_required",
        walletCall: {
          chainId: polygonChainId,
          to: execution.vaultAddress,
          value: "0",
          data: encodeFunctionData({
            abi: vaultAbi,
            functionName: "commitExecutionWallet",
            args: [requiredLoanId(execution), depositWallet],
          }),
        },
      },
    },
  });
}

async function fundCommittedExecutionWallet(execution: ExecutionWithPosition) {
  const request = executionRequest(execution);
  const depositWallet = requiredAddress(execution.depositWalletAddress, "depositWalletAddress");
  const relayer = new PolymarketRelayerClient(executionPrivateKey(execution));
  if (execution.relayerOperation === "APPROVE" && execution.relayerTransactionId) {
    const approval = await relayer.getTransaction(execution.relayerTransactionId);
    if (["STATE_FAILED", "STATE_INVALID"].includes(approval.state)) {
      throw new Error(`Deposit-wallet approval ${approval.state}`);
    }
    if (approval.state !== "STATE_CONFIRMED") return execution;
    await clobClientForExecution(execution).syncCollateralBalance();
    return prisma.polymarketMarginExecution.update({
      where: { id: execution.id },
      data: {
        state: PolymarketMarginExecutionState.FUNDED,
        relayerTransactionId: null,
        relayerOperation: null,
        lastReconciledAt: new Date(),
        responsePayload: { stage: "deposit_wallet_funded_and_approved" },
      },
    });
  }

  const loan = await readLoan(execution.vaultAddress, requiredLoanId(execution));
  if (loan.executionWallet.toLowerCase() !== depositWallet.toLowerCase()) {
    throw new Error("Trader-committed execution wallet does not match the deployed wallet");
  }
  let fundingTxHash = execution.fundingTxHash;
  if (loan.status === 1) {
    fundingTxHash = await writeAdapterContract(execution, {
      abi: vaultAbi,
      address: execution.vaultAddress as Address,
      functionName: "fundLoan",
      args: [requiredLoanId(execution)],
    });
  } else if (loan.status !== 2) {
    throw new Error(`Vault loan cannot be funded from status ${loan.status}`);
  }

  const custody = requiredAddress(execution.custodyAddress, "custodyAddress");
  const collateral = requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
  const [custodyBalance, depositBalance] = await Promise.all([
    readErc20Balance(collateral, custody),
    readErc20Balance(collateral, depositWallet),
  ]);
  let custodyFundingTxHash = execution.custodyFundingTxHash;
  if (custodyBalance > 0n) {
    const transferData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [depositWallet, custodyBalance],
    });
    custodyFundingTxHash = await writeAdapterContract(execution, {
      abi: custodyAbi,
      address: custody,
      functionName: "executeVenueCall",
      args: [collateral, transferData],
    });
  } else if (depositBalance === 0n) {
    throw new Error("Funded loan has no pUSD in custody or its committed wallet");
  }

  const exchange = execution.position.market.negativeRisk
    ? requiredAddress(
        env.polymarketNegRiskExchangeV2Address,
        "POLYMARKET_NEG_RISK_EXCHANGE_V2_ADDRESS",
      )
    : requiredAddress(env.polymarketExchangeV2Address, "POLYMARKET_EXCHANGE_V2_ADDRESS");
  const approval = await relayer.executeDepositWalletBatch(
    depositWallet,
    buildDepositWalletApprovalCalls({
      collateral,
      conditionalTokens: requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS"),
      exchange,
    }),
    Math.floor(Date.now() / 1_000) + 5 * 60,
  );
  return prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      fundingTxHash,
      custodyFundingTxHash,
      relayerTransactionId: approval.transactionID,
      relayerOperation: "APPROVE",
      responsePayload: {
        stage: "deposit_wallet_approval_pending",
        authorizedBorrowAssets: request.borrowAssets,
      },
    },
  });
}

async function prepareDurableFokOrder(execution: ExecutionWithPosition) {
  const request = executionRequest(execution);
  const fresh = await createMarginRiskQuote({
    userId: execution.position.userId,
    marketId: execution.position.marketId,
    side: request.side,
    collateralAssets: request.collateralAssets,
    leverageBps: request.leverageBps,
  });
  if (!fresh.approved)
    throw new Error(
      `Risk rerun rejected execution: ${fresh.rejections.map((item) => item.code).join(",")}`,
    );
  const tickSize = execution.position.market.orderPriceMinTickSize as TickSize;
  const freshLimit = calculateFokBuyPriceLimit(
    fresh.quote.openingPrice,
    execution.maxSlippageBps,
    tickSize,
  );
  if (
    parseSixDecimalAssets(freshLimit, "freshLimit") >
    parseSixDecimalAssets(request.priceLimit, "priceLimit")
  ) {
    throw new Error("Fresh FOK price exceeds the signed worst-price limit");
  }
  if (
    parseSixDecimalAssets(fresh.quote.estimatedOutcomeShares, "freshShares") <
    parseSixDecimalAssets(request.minimumOutcomeShares, "minimumShares")
  ) {
    throw new Error("Fresh orderbook depth is below the signed minimum outcome shares");
  }

  const depositWallet = requiredAddress(execution.depositWalletAddress, "depositWalletAddress");
  const collateral = requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
  const balance = await readErc20Balance(collateral, depositWallet);
  const maximumAuthorized =
    parseSixDecimalAssets(request.collateralAssets, "collateralAssets") +
    parseSixDecimalAssets(request.borrowAssets, "borrowAssets");
  if (balance === 0n || balance > maximumAuthorized) {
    throw new Error("Deposit-wallet pUSD balance does not match the authorized funded amount");
  }

  const clob = clobClientForExecution(execution);
  const signedOrder = await clob.prepareFokBuy({
    amountAssets: formatSixDecimalAssets(balance),
    negativeRisk: execution.position.market.negativeRisk === true,
    priceLimit: request.priceLimit,
    tickSize,
    tokenId: execution.tokenId,
  });
  const expectedOrderId = calculateClobV2OrderId(
    signedOrder,
    execution.position.market.negativeRisk === true,
  );
  return prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      state: PolymarketMarginExecutionState.ORDER_PREPARED,
      signedOrderPayload: JSON.parse(JSON.stringify(signedOrder)) as Prisma.InputJsonValue,
      clobOrderId: expectedOrderId,
      failureCode: null,
      failureMessage: null,
      responsePayload: {
        stage: "fok_order_prepared",
        freshQuoteId: fresh.quoteId,
        amountAssets: formatSixDecimalAssets(balance),
      },
    },
  });
}

async function postDurableFokOrder(execution: ExecutionWithPosition) {
  if (!execution.signedOrderPayload) throw new Error("Persisted signed FOK order is missing");
  let response: Awaited<ReturnType<PolymarketClobExecutionClient["postPreparedFokOrder"]>>;
  try {
    response = await clobClientForExecution(execution).postPreparedFokOrder(
      execution.signedOrderPayload as unknown as SignedOrder,
    );
  } catch (error) {
    const message = providerError(error);
    const disposition = classifyFokPostResult({ error: message });
    if (disposition === "NO_FILL") {
      return beginNoFillRecovery(execution, "FOK_ORDER_NOT_FILLED");
    }
    if (disposition === "DUPLICATE") {
      return markOrderSubmitted(execution, {
        orderStatus: "duplicate_acknowledged",
        tradeIds: [],
        transactionHashes: [],
      });
    }
    throw error;
  }
  if (
    !execution.clobOrderId ||
    response.orderID.toLowerCase() !== execution.clobOrderId.toLowerCase()
  ) {
    throw new Error("CLOB response order id does not match the persisted V2 order hash");
  }
  const disposition = classifyFokPostResult({
    success: response.success,
    status: response.status,
    error: response.errorMsg,
  });
  if (disposition === "NO_FILL") {
    return beginNoFillRecovery(execution, "FOK_ORDER_UNMATCHED");
  }
  if (disposition !== "SUBMITTED") {
    throw new Error(response.errorMsg || `FOK order returned ${response.status}`);
  }
  return markOrderSubmitted(execution, {
    orderStatus: response.status,
    tradeIds: response.tradeIDs,
    transactionHashes: response.transactionsHashes,
    makingAmount: response.makingAmount,
    takingAmount: response.takingAmount,
  });
}

async function markOrderSubmitted(
  execution: ExecutionWithPosition,
  evidence: {
    orderStatus: string;
    tradeIds: string[];
    transactionHashes: string[];
    makingAmount?: string;
    takingAmount?: string;
  },
) {
  return prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      state: PolymarketMarginExecutionState.ORDER_SUBMITTED,
      clobOrderId: execution.clobOrderId,
      clobTradeIds: evidence.tradeIds,
      settlementTxHashes: evidence.transactionHashes.map((hash) => hash.toLowerCase()),
      orderSubmittedAt: new Date(),
      failureCode: null,
      failureMessage: null,
      responsePayload: {
        stage: "fok_order_submitted",
        orderStatus: evidence.orderStatus,
        makingAmount: evidence.makingAmount ?? null,
        takingAmount: evidence.takingAmount ?? null,
      },
    },
  });
}

async function reconcileClobFill(execution: ExecutionWithPosition) {
  if (!execution.clobOrderId) throw new Error("Submitted execution is missing its CLOB order id");
  const request = executionRequest(execution);
  const clob = clobClientForExecution(execution);
  const trades = await clob.getTrades({
    funderAddress: requiredAddress(execution.depositWalletAddress, "depositWalletAddress"),
    tokenId: execution.tokenId,
  });
  const matching = trades.filter(
    (trade) =>
      trade.taker_order_id === execution.clobOrderId ||
      trade.maker_orders.some((order) => order.order_id === execution.clobOrderId),
  );
  if (matching.length === 0) return execution;
  const evidence = summarizeClobTrades(
    matching.map((trade) => ({
      id: trade.id,
      price: trade.price,
      size: trade.size,
      feeRateBps: trade.fee_rate_bps,
      transactionHash: trade.transaction_hash,
    })),
  );
  if (
    parseSixDecimalAssets(evidence.actualFillPrice, "actualFillPrice") >
      parseSixDecimalAssets(request.priceLimit, "priceLimit") ||
    parseSixDecimalAssets(evidence.actualShares, "actualShares") <
      parseSixDecimalAssets(request.minimumOutcomeShares, "minimumOutcomeShares")
  ) {
    throw new Error("Confirmed CLOB fill violated signed price or minimum-share limits");
  }
  const publicClient = polygonPublicClient();
  for (const hash of evidence.transactionHashes) {
    if (!transactionHashPattern.test(hash))
      throw new Error("CLOB trade omitted a valid settlement hash");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as Hex });
    if (receipt.status !== "success") throw new Error(`CLOB settlement ${hash} failed on Polygon`);
  }
  const walletShares = await readErc1155Balance(
    requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS"),
    requiredAddress(execution.depositWalletAddress, "depositWalletAddress"),
    BigInt(execution.tokenId),
  );
  if (walletShares < parseSixDecimalAssets(evidence.actualShares, "actualShares")) {
    throw new Error("Deposit wallet does not hold the confirmed outcome shares");
  }
  return prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      state: PolymarketMarginExecutionState.FILL_CONFIRMED,
      clobTradeIds: evidence.tradeIds,
      settlementTxHashes: evidence.transactionHashes,
      actualFillPrice: evidence.actualFillPrice,
      actualShares: evidence.actualShares,
      actualSpentAssets: evidence.actualSpentAssets,
      actualFeeAssets: evidence.actualFeeAssets,
      fillConfirmedAt: new Date(),
      lastReconciledAt: new Date(),
      responsePayload: { stage: "polygon_fill_confirmed" },
    },
  });
}

async function secureFilledShares(execution: ExecutionWithPosition) {
  const relayer = new PolymarketRelayerClient(executionPrivateKey(execution));
  if (execution.relayerOperation === "SECURE" && execution.relayerTransactionId) {
    const transfer = await relayer.getTransaction(execution.relayerTransactionId);
    if (transfer.state !== "STATE_CONFIRMED") {
      if (["STATE_FAILED", "STATE_INVALID"].includes(transfer.state)) {
        throw new Error(`Security transfer ${transfer.state}`);
      }
      return execution;
    }
    return activateSecuredLoan(execution, transfer.transactionHash ?? null);
  }

  const depositWallet = requiredAddress(execution.depositWalletAddress, "depositWalletAddress");
  const custody = requiredAddress(execution.custodyAddress, "custodyAddress");
  const collateral = requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
  const conditionalTokens = requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  const shares = parseSixDecimalAssets(
    requiredText(execution.actualShares, "actualShares"),
    "actualShares",
  );
  const [cash, walletShares, custodyShares] = await Promise.all([
    readErc20Balance(collateral, depositWallet),
    readErc1155Balance(conditionalTokens, depositWallet, BigInt(execution.tokenId)),
    readErc1155Balance(conditionalTokens, custody, BigInt(execution.tokenId)),
  ]);
  if (walletShares === 0n && custodyShares >= shares) {
    return activateSecuredLoan(execution, execution.securityTransferTxHash);
  }
  if (walletShares < shares) {
    throw new Error("Neither the deposit wallet nor isolated custody holds the confirmed shares");
  }
  const calls = [
    {
      target: conditionalTokens,
      value: "0",
      data: encodeFunctionData({
        abi: erc1155Abi,
        functionName: "safeTransferFrom",
        args: [depositWallet, custody, BigInt(execution.tokenId), shares, "0x"],
      }),
    },
    ...(cash > 0n
      ? [
          {
            target: collateral,
            value: "0",
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [custody, cash],
            }),
          },
        ]
      : []),
  ];
  const response = await relayer.executeDepositWalletBatch(
    depositWallet,
    calls,
    Math.floor(Date.now() / 1_000) + 5 * 60,
  );
  return prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      relayerTransactionId: response.transactionID,
      relayerOperation: "SECURE",
      responsePayload: { stage: "security_transfer_pending" },
    },
  });
}

async function activateSecuredLoan(execution: ExecutionWithPosition, securityHash: string | null) {
  const custody = requiredAddress(execution.custodyAddress, "custodyAddress");
  const token = requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  const shares = parseSixDecimalAssets(
    requiredText(execution.actualShares, "actualShares"),
    "actualShares",
  );
  const custodyShares = await readErc1155Balance(token, custody, BigInt(execution.tokenId));
  if (custodyShares !== shares)
    throw new Error("Isolated custody does not hold exactly the confirmed shares");
  const executionRef = keccak256(toBytes(`conviction:polymarket:v2:${execution.clobOrderId}`));
  const activationTxHash = await writeAdapterContract(execution, {
    abi: vaultAbi,
    address: execution.vaultAddress as Address,
    functionName: "activateLoan",
    args: [requiredLoanId(execution), shares, executionRef],
  });
  return prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      state: PolymarketMarginExecutionState.SECURED,
      relayerTransactionId: null,
      relayerOperation: null,
      securityTransferTxHash: securityHash?.toLowerCase() ?? null,
      activationTxHash,
      securedAt: new Date(),
      responsePayload: { stage: "isolated_custody_secured", executionRef },
    },
  });
}

async function markExecutionOpen(execution: ExecutionWithPosition) {
  const loan = await readLoan(execution.vaultAddress, requiredLoanId(execution));
  if (loan.status !== terminalLoanStatus.ACTIVE)
    throw new Error("Vault loan is not ACTIVE after security");
  const [updated] = await prisma.$transaction([
    prisma.polymarketMarginExecution.update({
      where: { id: execution.id },
      data: {
        state: PolymarketMarginExecutionState.OPEN,
        openedAt: new Date(),
        lastReconciledAt: new Date(),
        failureCode: null,
        failureMessage: null,
        responsePayload: { stage: "open" },
      },
    }),
    prisma.position.update({
      where: { id: execution.positionId },
      data: {
        status: PositionStatus.EXECUTED,
        quantity: requiredText(execution.actualShares, "actualShares"),
        averageEntryPrice: execution.actualFillPrice,
        executionAdapterId: "POLYMARKET_CLOB_V2_ISOLATED",
        openedAt: new Date(),
      },
    }),
  ]);
  return updated;
}

async function recoverReconciliationState(execution: ExecutionWithPosition) {
  if (execution.relayerOperation === "RECOVER" && execution.relayerTransactionId) {
    const relayer = new PolymarketRelayerClient(executionPrivateKey(execution));
    const recovery = await relayer.getTransaction(execution.relayerTransactionId);
    if (recovery.state !== "STATE_CONFIRMED") {
      if (["STATE_FAILED", "STATE_INVALID"].includes(recovery.state)) {
        throw new Error(`No-fill recovery ${recovery.state}`);
      }
      return execution;
    }
    return finalizeNoFillRecovery(execution, recovery.transactionHash ?? null);
  }
  const loan = execution.loanId
    ? await readLoan(execution.vaultAddress, execution.loanId as Hex)
    : null;
  if (loan) {
    if (loan.status === terminalLoanStatus.ACTIVE && execution.actualShares) {
      return prisma.polymarketMarginExecution.update({
        where: { id: execution.id },
        data: {
          state: PolymarketMarginExecutionState.SECURED,
          failureCode: null,
          failureMessage: null,
          lastReconciledAt: new Date(),
        },
      });
    }
  }
  const persistedOrderState = persistedOrderRecoveryState({
    hasOrderId: Boolean(execution.clobOrderId),
    hasSignedOrder: Boolean(execution.signedOrderPayload),
    orderSubmittedAt: execution.orderSubmittedAt,
    hasConfirmedShares: Boolean(execution.actualShares),
  });
  if (persistedOrderState) {
    return prisma.polymarketMarginExecution.update({
      where: { id: execution.id },
      data: {
        state: persistedOrderState,
        failureCode: null,
        failureMessage: null,
        lastReconciledAt: new Date(),
      },
    });
  }
  if (execution.depositWalletAddress) {
    if (loan?.status === 1) {
      const committed =
        loan.executionWallet.toLowerCase() === execution.depositWalletAddress.toLowerCase();
      return prisma.polymarketMarginExecution.update({
        where: { id: execution.id },
        data: {
          state: committed
            ? PolymarketMarginExecutionState.WALLET_COMMITTED
            : PolymarketMarginExecutionState.WALLET_COMMIT_REQUIRED,
          failureCode: null,
          failureMessage: null,
          lastReconciledAt: new Date(),
        },
      });
    }
    if (loan?.status === 2) {
      return prisma.polymarketMarginExecution.update({
        where: { id: execution.id },
        data: {
          state: PolymarketMarginExecutionState.WALLET_COMMITTED,
          failureCode: null,
          failureMessage: null,
          lastReconciledAt: new Date(),
        },
      });
    }
    const collateral = requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
    const balance = await readErc20Balance(collateral, execution.depositWalletAddress as Address);
    return prisma.polymarketMarginExecution.update({
      where: { id: execution.id },
      data: {
        state:
          balance > 0n
            ? PolymarketMarginExecutionState.FUNDED
            : PolymarketMarginExecutionState.WALLET_DEPLOYING,
        failureCode: null,
        failureMessage: null,
        lastReconciledAt: new Date(),
      },
    });
  }
  return prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      state: execution.loanId
        ? PolymarketMarginExecutionState.RESERVED
        : PolymarketMarginExecutionState.AUTHORIZED,
      failureCode: null,
      failureMessage: null,
      lastReconciledAt: new Date(),
    },
  });
}

async function beginNoFillRecovery(execution: ExecutionWithPosition, reason: string) {
  const wallet = requiredAddress(execution.depositWalletAddress, "depositWalletAddress");
  const custody = requiredAddress(execution.custodyAddress, "custodyAddress");
  const collateral = requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
  const conditionalTokens = requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  const [cash, shares] = await Promise.all([
    readErc20Balance(collateral, wallet),
    readErc1155Balance(conditionalTokens, wallet, BigInt(execution.tokenId)),
  ]);
  if (shares !== 0n) {
    throw new Error(
      "Cannot classify FOK as no-fill while outcome shares remain in the deposit wallet",
    );
  }
  if (cash === 0n) return finalizeNoFillRecovery(execution, null);
  const relayer = new PolymarketRelayerClient(executionPrivateKey(execution));
  const response = await relayer.executeDepositWalletBatch(
    wallet,
    [
      {
        target: collateral,
        value: "0",
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [custody, cash],
        }),
      },
    ],
    Math.floor(Date.now() / 1_000) + 5 * 60,
  );
  return prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      state: PolymarketMarginExecutionState.RECONCILIATION_REQUIRED,
      relayerTransactionId: response.transactionID,
      relayerOperation: "RECOVER",
      failureCode: reason,
      failureMessage: "FOK did not fill. Recovering all pUSD before failing the vault loan.",
      responsePayload: { stage: "no_fill_recovery_pending" },
    },
  });
}

async function finalizeNoFillRecovery(
  execution: ExecutionWithPosition,
  recoveryTransactionHash: string | null,
) {
  const loan = await readLoan(execution.vaultAddress, requiredLoanId(execution));
  if (loan.status === terminalLoanStatus.FAILED) {
    return markNoFillFailed(execution, recoveryTransactionHash, execution.activationTxHash);
  }
  if (loan.status !== 2) {
    throw new Error(`No-fill recovery cannot fail a vault loan in status ${loan.status}`);
  }
  const custody = requiredAddress(execution.custodyAddress, "custodyAddress");
  const collateral = requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
  const conditionalTokens = requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  const [cash, shares] = await Promise.all([
    readErc20Balance(collateral, custody),
    readErc1155Balance(conditionalTokens, custody, BigInt(execution.tokenId)),
  ]);
  const request = executionRequest(execution);
  const expected =
    parseSixDecimalAssets(request.collateralAssets, "collateralAssets") +
    parseSixDecimalAssets(request.borrowAssets, "borrowAssets");
  if (shares !== 0n || cash < expected) {
    throw new Error("No-fill recovery has not restored all funded pUSD to isolated custody");
  }
  const reasonCode = keccak256(toBytes(execution.failureCode ?? "FOK_NO_FILL"));
  const failHash = await writeAdapterContract(execution, {
    abi: vaultAbi,
    address: execution.vaultAddress as Address,
    functionName: "failLoan",
    args: [requiredLoanId(execution), reasonCode],
  });
  return markNoFillFailed(execution, recoveryTransactionHash, failHash);
}

async function markNoFillFailed(
  execution: ExecutionWithPosition,
  recoveryTransactionHash: string | null,
  failHash: string | null,
) {
  const [updated] = await prisma.$transaction([
    prisma.polymarketMarginExecution.update({
      where: { id: execution.id },
      data: {
        state: PolymarketMarginExecutionState.FAILED,
        relayerTransactionId: null,
        relayerOperation: null,
        securityTransferTxHash: recoveryTransactionHash?.toLowerCase() ?? null,
        activationTxHash: failHash?.toLowerCase() ?? null,
        failureCode: execution.failureCode ?? "FOK_NO_FILL",
        failureMessage:
          "FOK did not fill; all funded pUSD was recovered and the vault loan failed safely.",
        closedAt: new Date(),
        lastReconciledAt: new Date(),
        responsePayload: { stage: "no_fill_recovered", failHash: failHash ?? null },
      },
    }),
    prisma.position.update({
      where: { id: execution.positionId },
      data: { status: PositionStatus.FAILED, closedAt: new Date() },
    }),
  ]);
  return updated;
}

async function assertExecutionRuntimeReady(execution: ExecutionWithPosition) {
  const readiness = await getPolymarketExecutionReadiness();
  if (!readiness.venueFillEnabled) {
    throw new Error(`Polymarket execution is blocked: ${readiness.missing.join(" ")}`);
  }
  if (execution.position.chainId !== polygonChainId) throw new Error("Execution is not on Polygon");
  requiredEncryptionKey();
  requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
  requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  requiredAddress(env.polymarketExecutionAdapterAddress, "POLYMARKET_EXECUTION_ADAPTER_ADDRESS");
  if (!env.polymarketLifecycleEnabled) throw new Error("Polymarket lifecycle is disabled");
  if (!env.polymarketCanaryPassed) {
    const request = executionRequest(execution);
    const requestedAssets =
      parseSixDecimalAssets(request.collateralAssets, "collateralAssets") +
      parseSixDecimalAssets(request.borrowAssets, "borrowAssets");
    if (
      requestedAssets >
      parseSixDecimalAssets(env.polymarketCanaryMaxAssets, "POLYMARKET_CANARY_MAX_ASSETS")
    ) {
      throw new Error("Execution exceeds the pre-production canary cap");
    }
  }
  const signer = privateKeyToAccount(requiredPrivateKey());
  if (signer.address.toLowerCase() !== execution.adapterAddress.toLowerCase()) {
    throw new Error("Execution signer does not match the loan adapter");
  }
  // The deadline gates the trader's reservation transaction. Once equity and LP
  // principal are reserved onchain, recovery must continue instead of trapping funds.
}

async function createCloseQuote(execution: ExecutionWithPosition, maxSlippageBps: number) {
  const shares = requiredText(execution.actualShares, "actualShares");
  const policy = await prisma.marginMarketPolicy.findUnique({
    where: { marketId: execution.position.marketId },
  });
  if (!policy) throw new Error("Position market has no close risk policy");
  const [snapshot, feeRateBps] = await Promise.all([
    getPolymarketRiskSnapshot(execution.tokenId),
    clobClientForExecution(execution).getFeeRateBps(execution.tokenId),
  ]);
  const tickSize = snapshot.tickSize;
  if (
    snapshot.tokenId !== execution.tokenId ||
    !tickSize ||
    tickSize !== execution.position.market.orderPriceMinTickSize
  ) {
    throw new Error("Close orderbook metadata does not match the position market");
  }
  if (Date.now() - snapshot.observedAtMs > policy.maximumPriceAgeSeconds * 1_000) {
    throw new Error("Close orderbook snapshot is stale");
  }
  return {
    ...quoteFokSellFromBids({
      amountShares: shares,
      bids: snapshot.bids,
      builderFeeBps: env.polymarketBuilderTakerFeeBps,
      feeRateBps,
      maxSlippageBps,
      tickSize,
    }),
    amountShares: shares,
    feeRateBps,
    observedAt: new Date(snapshot.observedAtMs).toISOString(),
  };
}

function buildCloseTypedData(
  execution: ExecutionWithPosition,
  input: PreparePolymarketCloseInput,
  terms: {
    minimumProceeds: string;
    priceLimit: string;
    reason: PolymarketCloseReason;
  },
) {
  return {
    domain: {
      name: "Conviction Markets Close",
      version: "1",
      chainId: polygonChainId,
      verifyingContract: execution.vaultAddress as Address,
    },
    primaryType: "CloseAuthorization" as const,
    types: closeAuthorizationTypes,
    message: {
      positionId: objectIdBytes32(execution.positionId),
      loanId: requiredLoanId(execution),
      tokenId: BigInt(execution.tokenId),
      amountShares: parseSixDecimalAssets(requiredText(execution.actualShares, "shares"), "shares"),
      minimumProceeds: parseSixDecimalAssets(terms.minimumProceeds, "minimumProceeds"),
      priceLimit: parseSixDecimalAssets(terms.priceLimit, "priceLimit"),
      maxSlippageBps: input.maxSlippageBps,
      reason: closeReasonCode[terms.reason],
      nonce: input.nonce as Hex,
      deadline: BigInt(input.deadline),
    },
  };
}

function serializeCloseTypedData(value: ReturnType<typeof buildCloseTypedData>) {
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

function buildRiskControlTypedData(
  execution: ExecutionWithPosition,
  input: {
    stopLossPrice: string | null;
    takeProfitPrice: string | null;
    nonce: string;
    deadline: number;
  },
) {
  return {
    domain: {
      name: "Conviction Markets Risk Controls",
      version: "1",
      chainId: polygonChainId,
      verifyingContract: execution.vaultAddress as Address,
    },
    primaryType: "RiskControlAuthorization" as const,
    types: riskControlAuthorizationTypes,
    message: {
      positionId: objectIdBytes32(execution.positionId),
      loanId: requiredLoanId(execution),
      stopLossPrice: input.stopLossPrice
        ? parseSixDecimalAssets(input.stopLossPrice, "stopLossPrice")
        : 0n,
      takeProfitPrice: input.takeProfitPrice
        ? parseSixDecimalAssets(input.takeProfitPrice, "takeProfitPrice")
        : 0n,
      nonce: input.nonce as Hex,
      deadline: BigInt(input.deadline),
    },
  };
}

function serializeTypedData(value: ReturnType<typeof buildRiskControlTypedData>) {
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

function assertRiskControlsCanChange(
  execution: ExecutionWithPosition,
  nonce: string,
  deadline: number,
) {
  if (execution.state !== PolymarketMarginExecutionState.OPEN || !execution.loanId) {
    throw new AppError("Risk controls can only be changed on an open position", {
      code: "POSITION_NOT_OPEN",
      statusCode: 422,
    });
  }
  const now = Math.floor(Date.now() / 1_000);
  if (
    !/^0x[a-fA-F0-9]{64}$/.test(nonce) ||
    !Number.isInteger(deadline) ||
    deadline <= now ||
    deadline > now + 15 * 60
  ) {
    throw new AppError("Risk-control nonce or deadline is outside policy", {
      code: "INVALID_EXIT_CONTROLS",
      statusCode: 422,
    });
  }
}

function assertRiskControlOrder(stopLossPrice: string | null, takeProfitPrice: string | null) {
  if (stopLossPrice && takeProfitPrice && Number(stopLossPrice) >= Number(takeProfitPrice)) {
    throw new AppError("Stop-loss must be below take-profit", {
      code: "INVALID_EXIT_CONTROLS",
      statusCode: 422,
    });
  }
}

function validateCloseInput(input: PreparePolymarketCloseInput) {
  if (!input.userId || input.idempotencyKey.length < 12 || input.idempotencyKey.length > 160) {
    throw new AppError("A user and bounded close idempotency key are required", {
      code: "INVALID_CLOSE_INPUT",
      statusCode: 422,
    });
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(input.nonce)) {
    throw new AppError("Close nonce must be bytes32", {
      code: "INVALID_CLOSE_INPUT",
      statusCode: 422,
    });
  }
  const now = Math.floor(Date.now() / 1_000);
  if (
    !Number.isInteger(input.deadline) ||
    input.deadline <= now ||
    input.deadline > now + 15 * 60 ||
    !Number.isInteger(input.maxSlippageBps) ||
    input.maxSlippageBps < 0 ||
    input.maxSlippageBps > 500
  ) {
    throw new AppError("Close deadline or slippage is outside policy", {
      code: "INVALID_CLOSE_INPUT",
      statusCode: 422,
    });
  }
}

function assertCloseCanStart(execution: ExecutionWithPosition) {
  if (!env.polymarketLifecycleEnabled) {
    throw new AppError("Polymarket close lifecycle is disabled", {
      code: "POLYMARKET_LIFECYCLE_DISABLED",
      statusCode: 503,
    });
  }
  if (
    execution.state !== PolymarketMarginExecutionState.OPEN ||
    execution.activeCloseAttemptId ||
    execution.position.status !== PositionStatus.EXECUTED ||
    !execution.actualShares ||
    !execution.loanId
  ) {
    throw new AppError("Only an open secured margin position can be closed", {
      code: "POSITION_NOT_OPEN_FOR_CLOSE",
      statusCode: 409,
    });
  }
}

async function getActiveCloseAttempt(execution: PolymarketMarginExecution) {
  if (!execution.activeCloseAttemptId) throw new Error("Closing execution has no active attempt");
  const attempt = await prisma.polymarketCloseAttempt.findUnique({
    where: { id: execution.activeCloseAttemptId },
  });
  if (!attempt || attempt.executionId !== execution.id) {
    throw new Error("Active close attempt does not belong to the execution");
  }
  return attempt;
}

async function assertReleasedShares(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
  shares: bigint,
) {
  const token = requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  const [walletShares, custodyShares] = await Promise.all([
    readErc1155Balance(
      token,
      requiredAddress(execution.depositWalletAddress, "depositWalletAddress"),
      BigInt(execution.tokenId),
    ),
    readErc1155Balance(
      token,
      requiredAddress(execution.custodyAddress, "custodyAddress"),
      BigInt(execution.tokenId),
    ),
  ]);
  const baseline = parseSixDecimalAssets(
    requiredText(attempt.walletBaselineShares, "walletBaselineShares"),
    "walletBaselineShares",
  );
  if (walletShares !== baseline + shares || custodyShares !== 0n) {
    throw new Error("Guarded close shares do not reconcile between custody and execution wallet");
  }
}

async function markCloseOrderSubmitted(
  attempt: PolymarketCloseAttempt,
  status: string,
  tradeIds: string[],
  transactionHashes: string[],
) {
  await prisma.polymarketCloseAttempt.update({
    where: { id: attempt.id },
    data: {
      stage: PolymarketCloseStage.ORDER_SUBMITTED,
      clobTradeIds: tradeIds,
      settlementTxHashes: transactionHashes.map((hash) => hash.toLowerCase()),
      responsePayload: { stage: "close_fok_submitted", status },
    },
  });
}

async function finalizeClosedExecution(
  execution: ExecutionWithPosition,
  attempt: PolymarketCloseAttempt,
  settlementHash: string | null,
) {
  const now = new Date();
  await prisma.$transaction([
    prisma.polymarketCloseAttempt.update({
      where: { id: attempt.id },
      data: {
        stage: PolymarketCloseStage.CLOSED,
        vaultSettlementTxHash: settlementHash?.toLowerCase() ?? attempt.vaultSettlementTxHash,
        completedAt: now,
        failureCode: null,
        failureMessage: null,
        responsePayload: { stage: "vault_repaid_and_closed" },
      },
    }),
    prisma.polymarketMarginExecution.update({
      where: { id: execution.id },
      data: {
        state: PolymarketMarginExecutionState.CLOSED,
        activeCloseAttemptId: null,
        closedAt: now,
        lastReconciledAt: now,
        failureCode: null,
        failureMessage: null,
      },
    }),
    prisma.position.update({
      where: { id: execution.positionId },
      data: { status: PositionStatus.CLOSED, closedAt: now },
    }),
    prisma.userNotification.create({
      data: {
        userId: execution.position.userId,
        type: "POSITION_CLOSED",
        entityType: "POSITION",
        entityId: execution.positionId,
        message: "Your Polymarket margin position closed and the vault repayment was recorded.",
      },
    }),
  ]);
  return getExecutionWithPosition(execution.id);
}

function normalizeCloseAttempt(attempt: PolymarketCloseAttempt) {
  return {
    ...attempt,
    authorizationDeadline: attempt.authorizationDeadline.toISOString(),
    completedAt: attempt.completedAt?.toISOString() ?? null,
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString(),
  };
}

function objectIdBytes32(value: string) {
  if (!/^[a-fA-F0-9]{24}$/.test(value)) throw new Error("Position id is malformed");
  return `0x${value.toLowerCase().padStart(64, "0")}` as Hex;
}

async function getOwnedExecution(id: string, userId: string): Promise<ExecutionWithPosition> {
  const execution = await prisma.polymarketMarginExecution.findFirst({
    where: { id, position: { userId } },
    include: { position: { include: { market: true } } },
  });
  if (!execution) {
    throw new AppError("Polymarket margin execution not found", {
      code: "POLYMARKET_EXECUTION_NOT_FOUND",
      statusCode: 404,
    });
  }
  return execution;
}

async function getOwnedExecutionByPosition(positionId: string, userId: string) {
  const execution = await prisma.polymarketMarginExecution.findFirst({
    where: { positionId, position: { userId } },
    include: { position: { include: { market: true } } },
  });
  if (!execution) {
    throw new AppError("Polymarket margin execution not found", {
      code: "POLYMARKET_EXECUTION_NOT_FOUND",
      statusCode: 404,
    });
  }
  return execution;
}

function getExecutionWithPosition(id: string) {
  return prisma.polymarketMarginExecution.findUniqueOrThrow({
    where: { id },
    include: { position: { include: { market: true } } },
  });
}

function executionRequest(execution: PolymarketMarginExecution) {
  return executionRequestSchema.parse(execution.requestPayload);
}

function clobClientForExecution(execution: PolymarketMarginExecution) {
  const credentials = decryptJson<ApiKeyCreds>(
    requiredText(execution.clobCredentialsCiphertext, "clobCredentialsCiphertext"),
    requiredEncryptionKey(),
  );
  return new PolymarketClobExecutionClient({
    privateKey: executionPrivateKey(execution),
    funderAddress: requiredAddress(execution.depositWalletAddress, "depositWalletAddress"),
    credentials,
  });
}

function executionPrivateKey(execution: PolymarketMarginExecution) {
  const envelope = decryptJson<SecretEnvelope>(
    requiredText(execution.sessionSignerCiphertext, "sessionSignerCiphertext"),
    requiredEncryptionKey(),
  );
  if (!/^0x[a-fA-F0-9]{64}$/.test(envelope.privateKey))
    throw new Error("Stored execution key is invalid");
  return envelope.privateKey;
}

function requiredEncryptionKey() {
  return requiredText(
    env.polymarketExecutionKeyEncryptionKey,
    "POLYMARKET_EXECUTION_KEY_ENCRYPTION_KEY",
  );
}

function requiredPrivateKey() {
  return requiredText(
    env.polymarketExecutionSignerPrivateKey,
    "POLYMARKET_EXECUTION_SIGNER_PRIVATE_KEY",
  ) as Hex;
}

async function writeAdapterContract(
  execution: PolymarketMarginExecution,
  request: {
    abi: readonly unknown[];
    address: Address;
    functionName: string;
    args: readonly unknown[];
  },
) {
  const account = privateKeyToAccount(requiredPrivateKey());
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(env.polygonRpcUrl),
  });
  const hash = await wallet.writeContract(request as Parameters<typeof wallet.writeContract>[0]);
  const receipt = await polygonPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${request.functionName} failed on Polygon`);
  return hash.toLowerCase();
}

function polygonPublicClient() {
  return createPublicClient({ chain: polygon, transport: http(env.polygonRpcUrl) });
}

async function readLoan(vaultAddress: string, loanId: Hex) {
  const result = await polygonPublicClient().readContract({
    abi: vaultAbi,
    address: vaultAddress as Address,
    functionName: "loans",
    args: [loanId],
  });
  return {
    trader: result[0],
    adapter: result[1],
    custodyAccount: result[2],
    marketId: result[3],
    outcomeToken: result[4],
    outcomeTokenId: result[5],
    minimumOutcomeShares: result[6],
    securedOutcomeShares: result[7],
    traderEquity: result[8],
    borrowAssets: result[9],
    fundedAssets: result[10],
    financingFeeAssets: result[11],
    deadline: result[12],
    status: result[13],
    executionWallet: result[14],
    executionWalletBaselineShares: result[15],
  };
}

async function readErc20Balance(token: Address, account: Address) {
  return polygonPublicClient().readContract({
    abi: erc20Abi,
    address: token,
    functionName: "balanceOf",
    args: [account],
  });
}

async function readErc1155Balance(token: Address, account: Address, tokenId: bigint) {
  return polygonPublicClient().readContract({
    abi: erc1155Abi,
    address: token,
    functionName: "balanceOf",
    args: [account, tokenId],
  });
}

function parseLoanReserved(logs: Log[], vaultAddress: string) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== vaultAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [loanReservedEvent],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "LoanReserved") continue;
      return {
        loanId: decoded.args.loanId,
        trader: decoded.args.trader,
        custodyAddress: decoded.args.custodyAccount,
        marketId: decoded.args.marketId,
        traderEquity: decoded.args.traderEquity,
        borrowAssets: decoded.args.borrowAssets,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function parsePrincipalRepayment(logs: Log[], vaultAddress: string) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== vaultAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [loanPrincipalRepaidEvent],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "LoanPrincipalRepaid") continue;
      return decoded.args;
    } catch {
      continue;
    }
  }
  return null;
}

function optionalProbability(value: string | null, field: string) {
  if (value === null || value.trim() === "") return null;
  const units = parseSixDecimalAssets(value, field);
  if (units === 0n || units >= 1_000_000n) {
    throw new AppError(`${field} must be above 0 and below 1`, {
      code: "INVALID_EXIT_CONTROLS",
      statusCode: 422,
    });
  }
  return formatSixDecimalAssets(units);
}

function assertReservationMatches(
  execution: ExecutionWithPosition,
  request: z.infer<typeof executionRequestSchema>,
  reservation: NonNullable<ReturnType<typeof parseLoanReserved>>,
) {
  if (
    reservation.trader.toLowerCase() !== execution.authorizationSigner.toLowerCase() ||
    reservation.marketId.toLowerCase() !== execution.conditionId.toLowerCase() ||
    reservation.traderEquity !==
      parseSixDecimalAssets(request.collateralAssets, "collateralAssets") ||
    reservation.borrowAssets !== parseSixDecimalAssets(request.borrowAssets, "borrowAssets")
  ) {
    throw new AppError("Vault reservation does not match signed execution terms", {
      code: "MARGIN_RESERVATION_TERMS_MISMATCH",
      statusCode: 409,
    });
  }
}

function requiredAddress(value: string | null, name: string) {
  if (!value || !isAddress(value)) throw new Error(`${name} is missing or malformed`);
  return getAddress(value);
}

function requiredText(value: string | null, name: string) {
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

function requiredLoanId(execution: PolymarketMarginExecution) {
  const value = requiredText(execution.loanId, "loanId");
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error("loanId is malformed");
  return value as Hex;
}

function invalidState(state: PolymarketMarginExecutionState, action: string) {
  return new AppError(`Cannot ${action} while execution is ${state}`, {
    code: "INVALID_POLYMARKET_EXECUTION_STATE",
    statusCode: 409,
  });
}

function providerError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown provider error";
}
