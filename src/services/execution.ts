import { ExecutionMode, Prisma } from "@prisma/client";

import { env } from "../config/index.js";
import { AppError } from "../lib/errors.js";

const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const decimalInputPattern = /^(?:0|[1-9]d*)(?:.d{1,4})?$/;
const defaultAdapterId = "unassigned";

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

export type ExecutionAdapterDescriptor = {
  id: string;
  name: string;
  chainIds: number[];
  executionModes: ExecutionMode[];
};

export type ExecutionReadinessInput = {
  chainId: number | null;
  executionAdapterId: string | null;
  executionMode: ExecutionMode;
};

export type ExecutionReadiness =
  | {
      ready: true;
      adapterId: string;
    }
  | {
      ready: false;
      adapterId: string;
      code: string;
      message: string;
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

const implementedExecutionAdapters: ExecutionAdapterDescriptor[] = [];

export function getExecutionCapabilities() {
  const activeAdapters = getActiveExecutionAdapters();
  const spotExecutionEnabled =
    env.executionSpotEnabled &&
    activeAdapters.some((adapter) => adapter.executionModes.includes(ExecutionMode.SPOT));
  const marginExecutionEnabled =
    env.executionMarginEnabled &&
    activeAdapters.some((adapter) => adapter.executionModes.includes(ExecutionMode.MARGIN));

  return {
    evmOnly: true,
    architecture: "INTENT_FIRST_SPOT_ADAPTERS_BEFORE_MARGIN",
    spotExecutionEnabled,
    marginExecutionEnabled,
    marginIntentsEnabled: true,
    leverageEnabled: marginExecutionEnabled,
    leverageRequiresContracts: true,
    maxPendingMarginLeverage: env.executionMarginMaxLeverage,
    activeAdapters: activeAdapters.map((adapter) => adapter.id),
    implementedAdapters: implementedExecutionAdapters.map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      chainIds: adapter.chainIds,
      executionModes: adapter.executionModes,
    })),
    recommendation:
      "Record real spot and margin intents now. Execute only after real adapters, contracts, vault liquidity, and liquidation rules are configured.",
    chains: executionCapabilities.map((capability) => ({
      ...capability,
      spotExecutionEnabled:
        spotExecutionEnabled &&
        activeAdapters.some(
          (adapter) =>
            adapter.chainIds.includes(capability.chainId) &&
            adapter.executionModes.includes(ExecutionMode.SPOT),
        ),
      marginExecutionEnabled:
        marginExecutionEnabled &&
        activeAdapters.some(
          (adapter) =>
            adapter.chainIds.includes(capability.chainId) &&
            adapter.executionModes.includes(ExecutionMode.MARGIN),
        ),
    })),
  };
}

export function getExecutionReadiness(input: ExecutionReadinessInput): ExecutionReadiness {
  const adapterId = input.executionAdapterId ?? defaultAdapterId;
  const supportedChain = input.chainId
    ? executionCapabilities.find((capability) => capability.chainId === input.chainId)
    : null;

  if (input.chainId && !supportedChain) {
    return {
      ready: false,
      adapterId,
      code: "UNSUPPORTED_CHAIN",
      message: "Execution cannot start on an unsupported EVM chain.",
    };
  }

  const activeAdapters = getActiveExecutionAdapters().filter((adapter) => {
    const supportsMode = adapter.executionModes.includes(input.executionMode);
    const supportsChain = input.chainId ? adapter.chainIds.includes(input.chainId) : true;

    return supportsMode && supportsChain;
  });

  if (input.executionMode === ExecutionMode.MARGIN && !env.executionMarginEnabled) {
    return {
      ready: false,
      adapterId,
      code: "MARGIN_EXECUTION_NOT_ENABLED",
      message:
        "Margin execution is not enabled. Contracts, vault liquidity, risk checks, and adapters must be live first.",
    };
  }

  if (input.executionMode === ExecutionMode.SPOT && !env.executionSpotEnabled) {
    return {
      ready: false,
      adapterId,
      code: "SPOT_EXECUTION_NOT_ENABLED",
      message: "Spot execution is not enabled. Configure a real adapter before starting execution.",
    };
  }

  if (input.executionAdapterId) {
    const requestedAdapter = activeAdapters.find(
      (adapter) => adapter.id === input.executionAdapterId,
    );

    if (!requestedAdapter) {
      return {
        ready: false,
        adapterId: input.executionAdapterId,
        code: "EXECUTION_ADAPTER_NOT_AVAILABLE",
        message: "The requested execution adapter is not active for this chain and mode.",
      };
    }

    return { ready: true, adapterId: requestedAdapter.id };
  }

  const adapter = activeAdapters[0];

  if (!adapter) {
    return {
      ready: false,
      adapterId,
      code: "NO_ACTIVE_EXECUTION_ADAPTER",
      message: "No active execution adapter is configured for this chain and mode.",
    };
  }

  return { ready: true, adapterId: adapter.id };
}

export function buildExecutionIntentMetadata(input: ExecutionIntentInput): ExecutionIntentMetadata {
  const executionMode = input.executionMode ?? ExecutionMode.SPOT;
  const leverageMultiplier = parseLeverageMultiplier(input.leverageMultiplier);
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

  if (executionMode === ExecutionMode.SPOT) {
    validateSpotIntent(leverageMultiplier);
  }

  if (executionMode === ExecutionMode.MARGIN) {
    validateMarginIntent({ chainId, walletAddress, leverageMultiplier });
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

function getActiveExecutionAdapters() {
  const activeAdapterIds = new Set(env.executionActiveAdapters);

  return implementedExecutionAdapters.filter((adapter) => activeAdapterIds.has(adapter.id));
}

function validateSpotIntent(leverageMultiplier: Prisma.Decimal | null) {
  if (leverageMultiplier && !leverageMultiplier.equals(1)) {
    throw new AppError("Spot intents cannot request leverage", {
      code: "SPOT_LEVERAGE_NOT_SUPPORTED",
      statusCode: 422,
      details: {
        leverageMultiplier: leverageMultiplier.toString(),
        recommendation: "Use executionMode=MARGIN for leverage intent records.",
      },
    });
  }
}

function validateMarginIntent(input: {
  chainId: number | null;
  walletAddress: string | null;
  leverageMultiplier: Prisma.Decimal | null;
}) {
  if (!input.chainId) {
    throw new AppError("Margin intents require chainId", {
      code: "MARGIN_CHAIN_REQUIRED",
      statusCode: 422,
    });
  }

  if (!input.walletAddress) {
    throw new AppError("Margin intents require walletAddress", {
      code: "MARGIN_WALLET_REQUIRED",
      statusCode: 422,
    });
  }

  if (!input.leverageMultiplier || input.leverageMultiplier.lte(1)) {
    throw new AppError("Margin intents require leverageMultiplier greater than 1", {
      code: "MARGIN_LEVERAGE_REQUIRED",
      statusCode: 422,
    });
  }

  if (input.leverageMultiplier.gt(env.executionMarginMaxLeverage)) {
    throw new AppError("Margin leverage exceeds configured maximum", {
      code: "MARGIN_LEVERAGE_LIMIT_EXCEEDED",
      statusCode: 422,
      details: {
        maxPendingMarginLeverage: env.executionMarginMaxLeverage,
        leverageMultiplier: input.leverageMultiplier.toString(),
      },
    });
  }
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
