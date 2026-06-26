import type {
  ContractDeployment,
  ContractTransaction,
  ContractTransactionStatus,
} from "@prisma/client";
import { ContractRole, ExecutionMode, PositionStatus, Prisma } from "@prisma/client";

import { defaultContractDeployments } from "../config/deployed-contracts.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const objectIdPattern = /^[a-fA-F0-9]{24}$/;
const transactionHashPattern = /^0x[a-fA-F0-9]{64}$/;

export type UpsertContractDeploymentInput = {
  chainId: number;
  role: ContractRole;
  address: string;
  label?: string | null;
  tokenSymbol?: string | null;
  tokenDecimals?: number | null;
  isActive?: boolean;
};

export type PrepareCollateralTransactionInput = {
  positionId: string;
};

export type PrepareMarginIntentInput = {
  positionId: string;
  maxSlippageBps?: number;
  deadline?: number;
};

export type RecordContractTransactionInput = {
  transactionHash?: string | null;
  status?: ContractTransactionStatus;
  responsePayload?: Prisma.InputJsonValue | null;
};

export async function listContractDeployments() {
  const deployments = await prisma.contractDeployment.findMany({
    orderBy: [{ chainId: "asc" }, { role: "asc" }, { createdAt: "desc" }],
  });

  return deployments.map(normalizeContractDeployment);
}

export async function upsertContractDeployment(input: UpsertContractDeploymentInput) {
  validateChainId(input.chainId);
  validateEvmAddress(input.address, "address");

  if (input.role === ContractRole.COLLATERAL_TOKEN && typeof input.tokenDecimals !== "number") {
    throw new AppError("Collateral token decimals are required", {
      code: "TOKEN_DECIMALS_REQUIRED",
      statusCode: 422,
    });
  }

  const deployment = await prisma.contractDeployment.upsert({
    where: {
      chainId_role_address: {
        chainId: input.chainId,
        role: input.role,
        address: input.address.toLowerCase(),
      },
    },
    update: {
      label: normalizeNullableString(input.label),
      tokenSymbol: normalizeNullableString(input.tokenSymbol),
      tokenDecimals: input.tokenDecimals ?? null,
      isActive: input.isActive ?? true,
    },
    create: {
      chainId: input.chainId,
      role: input.role,
      address: input.address.toLowerCase(),
      label: normalizeNullableString(input.label),
      tokenSymbol: normalizeNullableString(input.tokenSymbol),
      tokenDecimals: input.tokenDecimals ?? null,
      isActive: input.isActive ?? true,
    },
  });

  return normalizeContractDeployment(deployment);
}

export async function getActiveContractConfig(chainId?: number | null) {
  const where = {
    isActive: true,
    ...(chainId ? { chainId } : {}),
  };
  const deployments = await prisma.contractDeployment.findMany({
    where,
    orderBy: [{ chainId: "asc" }, { role: "asc" }, { updatedAt: "desc" }],
  });

  return deployments.map(normalizeContractDeployment);
}

export async function ensureDefaultContractDeployments() {
  for (const deployment of defaultContractDeployments) {
    await upsertContractDeployment({ ...deployment, isActive: true });
  }
}

export async function prepareCollateralApprovalTransaction(
  input: PrepareCollateralTransactionInput,
) {
  const { collateralAmount, collateralToken, position, vault } = await getMarginContractContext(
    input.positionId,
  );

  const args = [vault.address, collateralAmount] as const;
  const requestPayload = {
    functionName: "approve",
    abi: ["function approve(address spender, uint256 amount) returns (bool)"],
    args,
    namedArgs: {
      spender: vault.address,
      amount: collateralAmount,
      collateralToken: collateralToken.address,
    },
  } satisfies Prisma.InputJsonObject;
  const transaction = await prisma.contractTransaction.create({
    data: {
      userId: position.userId,
      positionId: position.id,
      chainId: position.chainId!,
      contractAddress: collateralToken.address,
      walletAddress: position.walletAddress!.toLowerCase(),
      transactionHash: null,
      type: "COLLATERAL_APPROVAL",
      status: "PREPARED",
      requestPayload,
      responsePayload: null,
    },
  });

  return {
    transaction: normalizeContractTransaction(transaction),
    contractCall: {
      chainId: position.chainId!,
      contractAddress: collateralToken.address,
      walletAddress: position.walletAddress!,
      ...requestPayload,
    },
    executionNote:
      "Approve the vault to spend this collateral amount. This does not deposit funds or execute a market trade.",
  };
}

export async function prepareCollateralDepositTransaction(
  input: PrepareCollateralTransactionInput,
) {
  const { collateralAmount, collateralToken, position, vault } = await getMarginContractContext(
    input.positionId,
  );

  const args = [collateralToken.address, collateralAmount] as const;
  const requestPayload = {
    functionName: "deposit",
    abi: ["function deposit(address collateralToken, uint256 amount)"],
    args,
    namedArgs: {
      collateralToken: collateralToken.address,
      amount: collateralAmount,
    },
  } satisfies Prisma.InputJsonObject;
  const transaction = await prisma.contractTransaction.create({
    data: {
      userId: position.userId,
      positionId: position.id,
      chainId: position.chainId!,
      contractAddress: vault.address,
      walletAddress: position.walletAddress!.toLowerCase(),
      transactionHash: null,
      type: "DEPOSIT",
      status: "PREPARED",
      requestPayload,
      responsePayload: null,
    },
  });

  return {
    transaction: normalizeContractTransaction(transaction),
    contractCall: {
      chainId: position.chainId!,
      contractAddress: vault.address,
      walletAddress: position.walletAddress!,
      ...requestPayload,
    },
    executionNote:
      "Deposit approved collateral into the vault. This creates vault balance only; it does not execute a market trade.",
  };
}

export async function prepareMarginIntentTransaction(input: PrepareMarginIntentInput) {
  const maxSlippageBps = input.maxSlippageBps ?? 100;
  const deadline = input.deadline ?? Math.floor(Date.now() / 1000) + 60 * 60;

  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 2_000) {
    throw new AppError("maxSlippageBps must be an integer between 0 and 2000", {
      code: "INVALID_MAX_SLIPPAGE_BPS",
      statusCode: 422,
    });
  }

  if (!Number.isInteger(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
    throw new AppError("deadline must be a future unix timestamp", {
      code: "INVALID_DEADLINE",
      statusCode: 422,
    });
  }

  const { collateralAmount, collateralToken, position, vault } = await getMarginContractContext(
    input.positionId,
  );
  const leverageBps = decimalToBps(position.leverageMultiplier!.toString());
  const marketId = objectIdToBytes32(position.marketId, "marketId");
  const offchainPositionId = objectIdToBytes32(position.id, "positionId");
  const side = position.side === "YES" ? 0 : 1;
  const args = [
    collateralToken.address,
    marketId,
    side,
    collateralAmount,
    leverageBps.toString(),
    maxSlippageBps,
    deadline,
    offchainPositionId,
  ] as const;
  const requestPayload = {
    functionName: "createMarginIntent",
    abi: [
      "function createMarginIntent(address collateralToken, bytes32 marketId, uint8 side, uint256 collateralAmount, uint256 leverageBps, uint256 maxSlippageBps, uint256 deadline, bytes32 offchainPositionId) returns (bytes32 intentId)",
    ],
    args,
    namedArgs: {
      collateralToken: collateralToken.address,
      marketId,
      side,
      collateralAmount,
      leverageBps: leverageBps.toString(),
      maxSlippageBps,
      deadline,
      offchainPositionId,
    },
  } satisfies Prisma.InputJsonObject;
  const transaction = await prisma.contractTransaction.create({
    data: {
      userId: position.userId,
      positionId: position.id,
      chainId: position.chainId!,
      contractAddress: vault.address,
      walletAddress: position.walletAddress!.toLowerCase(),
      transactionHash: null,
      type: "MARGIN_INTENT",
      status: "PREPARED",
      requestPayload,
      responsePayload: null,
    },
  });

  return {
    transaction: normalizeContractTransaction(transaction),
    contractCall: {
      chainId: position.chainId!,
      contractAddress: vault.address,
      walletAddress: position.walletAddress!,
      ...requestPayload,
    },
    executionNote:
      "Submitting this transaction only records an on-chain margin intent. It does not confirm market execution or PnL.",
  };
}

export async function updateContractTransaction(id: string, input: RecordContractTransactionInput) {
  const existing = await prisma.contractTransaction.findUnique({ where: { id } });

  if (!existing) {
    throw new AppError("Contract transaction not found", {
      code: "CONTRACT_TRANSACTION_NOT_FOUND",
      statusCode: 404,
    });
  }

  const transactionHash = normalizeNullableString(input.transactionHash);

  if (transactionHash && !transactionHashPattern.test(transactionHash)) {
    throw new AppError("transactionHash must be a valid EVM transaction hash", {
      code: "INVALID_TRANSACTION_HASH",
      statusCode: 422,
    });
  }

  const status = input.status ?? existing.status;
  const data: Prisma.ContractTransactionUpdateInput = {
    transactionHash: transactionHash?.toLowerCase() ?? existing.transactionHash,
    status,
  };

  if (input.responsePayload !== undefined && input.responsePayload !== null) {
    data.responsePayload = input.responsePayload as Prisma.InputJsonValue;
  }

  const updated = await prisma.contractTransaction.update({
    where: { id },
    data,
  });

  if (updated.positionId && updated.transactionHash) {
    const positionUpdate = getPositionUpdateFromContractTransaction(updated);

    if (positionUpdate) {
      await prisma.position.update({
        where: { id: updated.positionId },
        data: positionUpdate,
      });
    }
  }

  return normalizeContractTransaction(updated);
}

export async function listPositionContractTransactions(positionId: string) {
  const transactions = await prisma.contractTransaction.findMany({
    where: { positionId },
    orderBy: { createdAt: "desc" },
  });

  return transactions.map(normalizeContractTransaction);
}

export function normalizeContractDeployment(deployment: ContractDeployment) {
  return {
    id: deployment.id,
    chainId: deployment.chainId,
    role: deployment.role,
    address: deployment.address,
    label: deployment.label,
    tokenSymbol: deployment.tokenSymbol,
    tokenDecimals: deployment.tokenDecimals,
    isActive: deployment.isActive,
    createdAt: deployment.createdAt.toISOString(),
    updatedAt: deployment.updatedAt.toISOString(),
  };
}

export function normalizeContractTransaction(transaction: ContractTransaction) {
  return {
    id: transaction.id,
    userId: transaction.userId,
    positionId: transaction.positionId,
    chainId: transaction.chainId,
    contractAddress: transaction.contractAddress,
    walletAddress: transaction.walletAddress,
    transactionHash: transaction.transactionHash,
    type: transaction.type,
    status: transaction.status,
    requestPayload: transaction.requestPayload,
    responsePayload: transaction.responsePayload,
    createdAt: transaction.createdAt.toISOString(),
    updatedAt: transaction.updatedAt.toISOString(),
  };
}

async function getMarginContractContext(positionId: string) {
  const position = await prisma.position.findUnique({ where: { id: positionId } });

  if (!position) {
    throw new AppError("Position not found", {
      code: "POSITION_NOT_FOUND",
      statusCode: 404,
    });
  }

  if (position.executionMode !== ExecutionMode.MARGIN) {
    throw new AppError("Only margin position intents can be prepared for vault submission", {
      code: "NOT_MARGIN_POSITION",
      statusCode: 422,
    });
  }

  if (position.status !== PositionStatus.PENDING_EXECUTION) {
    throw new AppError("Only pending position intents can be prepared for contract submission", {
      code: "POSITION_NOT_PENDING",
      statusCode: 422,
      details: { status: position.status },
    });
  }

  if (!position.chainId || !position.walletAddress) {
    throw new AppError("Position is missing chain or wallet metadata", {
      code: "POSITION_CONTRACT_METADATA_MISSING",
      statusCode: 422,
    });
  }

  if (!position.marginCollateral || !position.leverageMultiplier) {
    throw new AppError("Position is missing margin collateral or leverage metadata", {
      code: "POSITION_MARGIN_METADATA_MISSING",
      statusCode: 422,
    });
  }

  const [vault, collateralToken] = await Promise.all([
    findActiveDeployment(position.chainId, ContractRole.MARGIN_VAULT),
    findActiveDeployment(position.chainId, ContractRole.COLLATERAL_TOKEN),
  ]);
  const tokenDecimals = collateralToken.tokenDecimals;

  if (typeof tokenDecimals !== "number") {
    throw new AppError("Active collateral token config is missing decimals", {
      code: "TOKEN_DECIMALS_REQUIRED",
      statusCode: 422,
    });
  }

  return {
    collateralAmount: decimalToTokenUnits(position.marginCollateral.toString(), tokenDecimals),
    collateralToken,
    position,
    vault,
  };
}

async function findActiveDeployment(chainId: number, role: ContractRole) {
  const deployment = await prisma.contractDeployment.findFirst({
    where: { chainId, role, isActive: true },
    orderBy: { updatedAt: "desc" },
  });

  if (!deployment) {
    throw new AppError("Required contract deployment is not configured", {
      code: "CONTRACT_DEPLOYMENT_NOT_CONFIGURED",
      statusCode: 422,
      details: { chainId, role },
    });
  }

  return deployment;
}

function decimalToBps(value: string) {
  const decimal = new Prisma.Decimal(value);

  return decimal.mul(10_000).toDecimalPlaces(0).toNumber();
}

function decimalToTokenUnits(value: string, decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new AppError("Token decimals must be an integer between 0 and 36", {
      code: "INVALID_TOKEN_DECIMALS",
      statusCode: 422,
    });
  }

  const [whole, fraction = ""] = value.split(".");

  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > decimals) {
    throw new AppError("Decimal amount cannot be represented with the configured token decimals", {
      code: "INVALID_TOKEN_AMOUNT_DECIMALS",
      statusCode: 422,
      details: { value, decimals },
    });
  }

  return BigInt(whole + fraction.padEnd(decimals, "0")).toString();
}

function objectIdToBytes32(value: string, field: string) {
  if (!objectIdPattern.test(value)) {
    throw new AppError("Expected a Mongo ObjectId hex string", {
      code: "INVALID_OBJECT_ID_BYTES32_SOURCE",
      statusCode: 422,
      details: { field },
    });
  }

  return "0x" + value.toLowerCase().padStart(64, "0");
}

function normalizeNullableString(value: string | null | undefined) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateChainId(chainId: number) {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new AppError("chainId must be a positive integer", {
      code: "INVALID_CHAIN_ID",
      statusCode: 422,
    });
  }
}

function validateEvmAddress(value: string, field: string) {
  if (!evmAddressPattern.test(value)) {
    throw new AppError("Expected a valid EVM address", {
      code: "INVALID_EVM_ADDRESS",
      statusCode: 422,
      details: { field },
    });
  }
}


function getPositionUpdateFromContractTransaction(transaction: ContractTransaction) {
  if (transaction.type !== "MARGIN_INTENT") return null;

  const data: Prisma.PositionUpdateInput = {
    chainTransactionHash: transaction.transactionHash,
  };

  if (transaction.status === "FAILED" || transaction.status === "CANCELLED") {
    data.status = PositionStatus.FAILED;
  } else {
    data.status = PositionStatus.PENDING_EXECUTION;
  }

  return data;
}
