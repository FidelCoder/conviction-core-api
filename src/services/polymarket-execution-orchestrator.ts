import { randomUUID } from "node:crypto";

import {
  getContractConfig,
  type ApiKeyCreds,
  type SignedOrder,
  type TickSize,
} from "@polymarket/clob-client-v2";
import {
  PolymarketMarginExecutionState,
  PositionStatus,
  Prisma,
  type Market,
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
import { createMarginRiskQuote } from "./margin-risk-quotes.js";
import { normalizePolymarketMarginExecution } from "./polymarket-margin-execution.js";
import {
  calculateFokBuyPriceLimit,
  classifyFokPostResult,
  formatSixDecimalAssets,
  parseSixDecimalAssets,
  persistedOrderRecoveryState,
  summarizeClobTrades,
} from "./polymarket-execution-state.js";

const polygonChainId = 137;
const transactionHashPattern = /^0x[a-fA-F0-9]{64}$/;
// Polygon receipt waits can outlive one serverless request. Keep the lease longer than any
// bounded provider stage; expired leases are still recovered from onchain/CLOB state.
const executionLockMs = 5 * 60_000;
const terminalLoanStatus = { ACTIVE: 3, SETTLED: 4, FAILED: 5, CANCELLED: 6 } as const;

const executionRequestSchema = z.object({
  collateralAssets: z.string(),
  borrowAssets: z.string(),
  leverageBps: z.number().int(),
  minimumOutcomeShares: z.string(),
  priceLimit: z.string(),
  side: z.enum(["YES", "NO"]),
  tokenId: z.string(),
});

const loanReservedEvent = parseAbiItem(
  "event LoanReserved(bytes32 indexed loanId,address indexed trader,address indexed custodyAccount,bytes32 marketId,uint256 traderEquity,uint256 borrowAssets)",
);
const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function deploymentChainId() view returns (uint256)",
  "function authorizedAdapters(address) view returns (bool)",
  "function isExecutionTargetAllowed(address) view returns (bool)",
  "function fundLoan(bytes32 loanId)",
  "function failLoan(bytes32 loanId,bytes32 reasonCode)",
  "function activateLoan(bytes32 loanId,uint256 securedOutcomeShares,bytes32 executionRef)",
  "function loans(bytes32) view returns (address trader,address adapter,address custodyAccount,bytes32 marketId,address outcomeToken,uint256 outcomeTokenId,uint256 minimumOutcomeShares,uint256 securedOutcomeShares,uint256 traderEquity,uint256 borrowAssets,uint256 fundedAssets,uint256 deadline,uint8 status,bytes32 executionRef,bytes32 settlementRef)",
]);
const custodyAbi = parseAbi([
  "function executeVenueCall(address venue,bytes data) returns (bytes result)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address recipient,uint256 amount) returns (bool)",
]);
const erc1155Abi = parseAbi([
  "function balanceOf(address account,uint256 id) view returns (uint256)",
  "function safeTransferFrom(address from,address to,uint256 id,uint256 amount,bytes data)",
]);

type ExecutionWithPosition = PolymarketMarginExecution & {
  position: Position & { market: Market };
};

type SecretEnvelope = { privateKey: Hex };

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
  if (
    loan.adapter.toLowerCase() !== execution.adapterAddress.toLowerCase() ||
    loan.custodyAccount.toLowerCase() !== reservation.custodyAddress.toLowerCase() ||
    loan.outcomeTokenId.toString() !== execution.tokenId ||
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

export async function advancePolymarketMarginExecution(input: {
  executionId: string;
  userId: string;
}) {
  const initial = await getOwnedExecution(input.executionId, input.userId);
  return advanceExecutionRecord(initial);
}

export async function reconcilePendingPolymarketExecutions(limit = 10) {
  const boundedLimit = Math.max(1, Math.min(limit, 25));
  const records = await prisma.polymarketMarginExecution.findMany({
    where: {
      state: {
        in: [
          PolymarketMarginExecutionState.RESERVED,
          PolymarketMarginExecutionState.WALLET_DEPLOYING,
          PolymarketMarginExecutionState.FUNDED,
          PolymarketMarginExecutionState.ORDER_PREPARED,
          PolymarketMarginExecutionState.ORDER_SUBMITTED,
          PolymarketMarginExecutionState.FILL_CONFIRMED,
          PolymarketMarginExecutionState.SECURED,
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
  };
  const configuredAddresses = {
    POLYMARKET_PUSD_ADDRESS: env.polymarketPusdAddress,
    POLYMARKET_CTF_ADDRESS: env.polymarketCtfAddress,
    POLYMARKET_EXCHANGE_V2_ADDRESS: env.polymarketExchangeV2Address,
    POLYMARKET_NEG_RISK_EXCHANGE_V2_ADDRESS: env.polymarketNegRiskExchangeV2Address,
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
      const [vaultCode, asset, chainId, adapterAllowed, pusdAllowed] = await Promise.all([
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
  if (missing.length === 0) {
    warnings.push(
      "A small real-money open-secure-close-repay canary is still required before caps are raised.",
    );
  }

  return {
    status: missing.length === 0 ? "READY_FOR_CANARY" : "BLOCKED",
    productionVenueFillEnabled: missing.length === 0,
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
    case PolymarketMarginExecutionState.RECONCILIATION_REQUIRED:
      return recoverReconciliationState(execution);
    case PolymarketMarginExecutionState.AUTHORIZED:
      throw new Error("Record the confirmed vault reservation before execution can advance");
    default:
      return execution;
  }
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
  const request = executionRequest(execution);
  const privateKey = executionPrivateKey(execution);
  const relayer = new PolymarketRelayerClient(privateKey);

  if (execution.relayerOperation === "APPROVE") {
    const approval = await relayer.getTransaction(execution.relayerTransactionId);
    if (approval.state !== "STATE_CONFIRMED") {
      if (["STATE_FAILED", "STATE_INVALID"].includes(approval.state)) {
        throw new Error(`Deposit-wallet approval ${approval.state}`);
      }
      return execution;
    }
    const clob = clobClientForExecution(execution);
    await clob.syncCollateralBalance();
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
  await prisma.polymarketMarginExecution.update({
    where: { id: execution.id },
    data: {
      depositWalletAddress: depositWallet.toLowerCase(),
      clobCredentialsCiphertext: credentialsCiphertext,
    },
  });

  const loan = await readLoan(execution.vaultAddress, requiredLoanId(execution));
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
    throw new Error("Funded loan has no pUSD in custody or its deposit wallet");
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
      depositWalletAddress: depositWallet.toLowerCase(),
      clobCredentialsCiphertext: credentialsCiphertext,
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
  if (custodyShares < shares)
    throw new Error("Isolated custody does not hold the confirmed shares");
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
  if (execution.loanId) {
    const loan = await readLoan(execution.vaultAddress, execution.loanId as Hex);
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
  if (!readiness.productionVenueFillEnabled) {
    throw new Error(`Production execution is blocked: ${readiness.missing.join(" ")}`);
  }
  if (execution.position.chainId !== polygonChainId) throw new Error("Execution is not on Polygon");
  requiredEncryptionKey();
  requiredAddress(env.polymarketPusdAddress, "POLYMARKET_PUSD_ADDRESS");
  requiredAddress(env.polymarketCtfAddress, "POLYMARKET_CTF_ADDRESS");
  requiredAddress(env.polymarketExecutionAdapterAddress, "POLYMARKET_EXECUTION_ADAPTER_ADDRESS");
  const signer = privateKeyToAccount(requiredPrivateKey());
  if (signer.address.toLowerCase() !== execution.adapterAddress.toLowerCase()) {
    throw new Error("Execution signer does not match the loan adapter");
  }
  if (execution.authorizationDeadline.getTime() <= Date.now() && !execution.clobOrderId) {
    throw new Error("Execution authorization expired before order submission");
  }
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
    deadline: result[11],
    status: result[12],
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
