import { ExecutionMode, Prisma } from "@prisma/client";

import { AppError } from "../lib/errors.js";

const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const decimalInputPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/;

export type ExecutionIntentInput = {
  chainId?: number | null;
  walletAddress?: string | null;
  executionMode?: ExecutionMode | null;
  leverageMultiplier?: string | null;
  executionAdapterId?: string | null;
  idempotencyKey?: string | null;
};

export type ExecutionIntentMetadata = {
  chainId: number | null;
  walletAddress: string | null;
  executionMode: ExecutionMode;
  leverageMultiplier: Prisma.Decimal | null;
  executionAdapterId: string | null;
  chainTransactionHash: null;
  idempotencyKey: string | null;
};

export type ExecutionCapability = {
  chainId: number;
  chainName: string;
  ecosystem: "EVM";
  network: "mainnet" | "testnet";
  spotExecutionEnabled: boolean;
  marginExecutionEnabled: boolean;
  contractRequiredForMargin: boolean;
  plannedAdapters: string[];
};

const executionCapabilities: ExecutionCapability[] = [
  {
    chainId: 8453,
    chainName: "Base",
    ecosystem: "EVM",
    network: "mainnet",
    spotExecutionEnabled: false,
    marginExecutionEnabled: false,
    contractRequiredForMargin: true,
    plannedAdapters: [],
  },
  {
    chainId: 84532,
    chainName: "Base Sepolia",
    ecosystem: "EVM",
    network: "testnet",
    spotExecutionEnabled: false,
    marginExecutionEnabled: false,
    contractRequiredForMargin: true,
    plannedAdapters: [],
  },
  {
    chainId: 137,
    chainName: "Polygon",
    ecosystem: "EVM",
    network: "mainnet",
    spotExecutionEnabled: false,
    marginExecutionEnabled: false,
    contractRequiredForMargin: true,
    plannedAdapters: ["polymarket-clob"],
  },
  {
    chainId: 42161,
    chainName: "Arbitrum One",
    ecosystem: "EVM",
    network: "mainnet",
    spotExecutionEnabled: false,
    marginExecutionEnabled: false,
    contractRequiredForMargin: true,
    plannedAdapters: [],
  },
  {
    chainId: 10,
    chainName: "Optimism",
    ecosystem: "EVM",
    network: "mainnet",
    spotExecutionEnabled: false,
    marginExecutionEnabled: false,
    contractRequiredForMargin: true,
    plannedAdapters: [],
  },
];

export function getExecutionCapabilities() {
  return {
    evmOnly: true,
    architecture: "INTENT_FIRST_SPOT_ADAPTERS_BEFORE_MARGIN",
    spotExecutionEnabled: false,
    marginExecutionEnabled: false,
    leverageEnabled: false,
    leverageRequiresContracts: true,
    activeAdapters: [],
    recommendation:
      "Build spot execution adapters first. Add an Ultramarkets-style margin vault/risk layer later; do not synthesize leveraged fills in the API.",
    chains: executionCapabilities,
  };
}

export function buildExecutionIntentMetadata(input: ExecutionIntentInput): ExecutionIntentMetadata {
  const executionMode = input.executionMode ?? ExecutionMode.SPOT;

  if (executionMode === ExecutionMode.MARGIN) {
    throw new AppError("Margin and leveraged execution are not enabled yet", {
      code: "LEVERAGE_EXECUTION_NOT_ENABLED",
      statusCode: 422,
      details: {
        recommendation:
          "Use SPOT intents until margin contracts, risk checks, and execution adapters exist.",
      },
    });
  }

  const leverageMultiplier = parseLeverageMultiplier(input.leverageMultiplier);

  if (leverageMultiplier && !leverageMultiplier.equals(1)) {
    throw new AppError("Leveraged execution is not enabled yet", {
      code: "LEVERAGE_EXECUTION_NOT_ENABLED",
      statusCode: 422,
      details: {
        leverageMultiplier: leverageMultiplier.toString(),
        recommendation:
          "Submit a spot intent now; add margin support after contracts and liquidation rules exist.",
      },
    });
  }

  const chainId = normalizeChainId(input.chainId);
  const walletAddress = normalizeWalletAddress(input.walletAddress);
  const executionAdapterId = normalizeOptionalText(
    input.executionAdapterId,
    "executionAdapterId",
    80,
  );
  const idempotencyKey = normalizeOptionalText(input.idempotencyKey, "idempotencyKey", 128);

  if (chainId && !executionCapabilities.some((capability) => capability.chainId === chainId)) {
    throw new AppError("Unsupported EVM chain", {
      code: "UNSUPPORTED_CHAIN",
      statusCode: 422,
      details: {
        chainId,
        supportedChainIds: executionCapabilities.map((capability) => capability.chainId),
      },
    });
  }

  return {
    chainId,
    walletAddress,
    executionMode,
    leverageMultiplier,
    executionAdapterId,
    chainTransactionHash: null,
    idempotencyKey,
  };
}

function normalizeChainId(chainId: number | null | undefined) {
  if (chainId === null || typeof chainId === "undefined") {
    return null;
  }

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new AppError("chainId must be a positive integer", {
      code: "INVALID_CHAIN_ID",
      statusCode: 422,
    });
  }

  return chainId;
}

function normalizeWalletAddress(walletAddress: string | null | undefined) {
  if (!walletAddress) {
    return null;
  }

  const normalized = walletAddress.trim();

  if (!evmAddressPattern.test(normalized)) {
    throw new AppError("walletAddress must be a valid EVM address", {
      code: "INVALID_WALLET_ADDRESS",
      statusCode: 422,
    });
  }

  return normalized.toLowerCase();
}

function parseLeverageMultiplier(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = value.trim();

  if (!decimalInputPattern.test(normalized)) {
    throw new AppError("leverageMultiplier must be a decimal string with up to 4 decimals", {
      code: "INVALID_LEVERAGE_MULTIPLIER",
      statusCode: 422,
    });
  }

  const decimal = new Prisma.Decimal(normalized);

  if (decimal.lte(0)) {
    throw new AppError("leverageMultiplier must be greater than zero", {
      code: "INVALID_LEVERAGE_MULTIPLIER",
      statusCode: 422,
    });
  }

  return decimal;
}

function normalizeOptionalText(
  value: string | null | undefined,
  fieldName: string,
  maxLength: number,
) {
  if (!value) {
    return null;
  }

  const normalized = value.trim();

  if (!normalized) {
    return null;
  }

  if (normalized.length > maxLength) {
    throw new AppError(fieldName + " is too long", {
      code: "INVALID_EXECUTION_METADATA",
      statusCode: 422,
      details: { field: fieldName, maxLength },
    });
  }

  return normalized;
}
