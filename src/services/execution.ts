import type { ExecutionAttempt, Market, Position } from "@prisma/client";
import {
  ContractRole,
  ExecutionAttemptStatus,
  ExecutionMode,
  ExecutionTargetType,
  MarketSource,
  PositionSide,
  PositionStatus,
  Prisma,
} from "@prisma/client";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  toBytes,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia, baseSepolia, sepolia } from "viem/chains";

import { supportedIntentChains } from "../config/deployed-contracts.js";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { getActiveContractConfig } from "./contracts.js";
import {
  advancePolymarketMarginExecution,
  getPolymarketExecutionReadiness,
  recordPolymarketLoanReservation,
} from "./polymarket-execution-orchestrator.js";

export const MAX_PENDING_MARGIN_LEVERAGE = 3;

const TESTNET_ADAPTER_ID = "CONVICTION_TESTNET_VAULT_ADAPTER";
const POLYMARKET_ADAPTER_ID = "POLYMARKET_CLOB_ADAPTER";

const transactionHashPattern = /^0x[a-fA-F0-9]{64}$/;

const vaultAdapterAbi = parseAbi([
  "function authorizedAdapters(address adapter) view returns (bool)",
  "function submitMarginIntent(bytes32 intentId, bytes32 externalRef)",
  "function confirmMarginIntent(bytes32 intentId, bytes32 executionRef)",
]);

const marginIntentCreatedEvent = parseAbiItem(
  "event MarginIntentCreated(bytes32 indexed intentId,address indexed account,bytes32 indexed marketId,bytes32 offchainPositionId,uint8 side,address collateralToken,uint256 collateralAmount,uint256 leverageBps,uint256 notionalAmount,uint256 borrowedAmount)",
);

type PositionWithMarket = Position & { market: Market };

type ChainRuntime = {
  chain: typeof baseSepolia | typeof sepolia | typeof arbitrumSepolia;
  rpcUrl: string;
};

type ParsedMarginIntent = {
  account: string;
  collateralAmount: string;
  collateralToken: string;
  intentId: Hex;
  marketId: Hex;
  notionalAmount: string;
  offchainPositionId: Hex;
};

export async function getExecutionCapabilities() {
  const activeContracts = await getActiveContractConfig(null);
  const hasActiveVault = activeContracts.some((deployment) => deployment.role === "MARGIN_VAULT");
  const adapterRuntime = getAdapterRuntime();
  const polymarketReadiness =
    env.convictionExecutionMode === "polymarket" ? await getPolymarketExecutionReadiness() : null;
  const executionReady = polymarketReadiness?.productionVenueFillEnabled ?? adapterRuntime.ready;
  const activeAdapters = executionReady ? [adapterRuntime.adapterId] : [];
  const chains = supportedIntentChains.map((chain) => {
    const isPolymarketPolygon =
      chain.chainId === 137 && env.convictionExecutionMode === "polymarket";
    const walletFlowEnabled = isPolymarketPolygon
      ? Boolean(env.polymarketPusdVaultAddress && env.polymarketPusdAddress)
      : chain.walletFlowEnabled;
    return {
      ...chain,
      vaultAddress: isPolymarketPolygon ? env.polymarketPusdVaultAddress : chain.vaultAddress,
      walletFlowEnabled,
      marginExecutionEnabled: isPolymarketPolygon
        ? polymarketReadiness?.productionVenueFillEnabled === true
        : adapterRuntime.ready &&
          chain.network === "testnet" &&
          walletFlowEnabled &&
          env.convictionExecutionMode === "testnet",
    };
  });
  const liveVaultAddress =
    env.convictionExecutionMode === "polymarket"
      ? env.polymarketPusdVaultAddress
      : env.convictionVaultAddress;
  const liveAdapterAddress =
    env.convictionExecutionMode === "polymarket"
      ? env.polymarketExecutionAdapterAddress
      : env.convictionExecutionAdapterAddress;

  return {
    evmOnly: true,
    architecture: "INTENT_FIRST_MULTICHAIN_MARGIN_LAYER",
    spotExecutionEnabled: false,
    marginExecutionEnabled: executionReady,
    leverageEnabled: executionReady,
    marginIntentsEnabled: true,
    leverageRequiresContracts: true,
    maxPendingMarginLeverage: MAX_PENDING_MARGIN_LEVERAGE,
    activeAdapters,
    contractLayer: {
      status: polymarketReadiness
        ? polymarketReadiness.productionVenueFillEnabled
          ? "POLYGON_PUSD_CANARY_READY"
          : "POLYGON_PUSD_BLOCKED"
        : hasActiveVault
          ? adapterRuntime.ready
            ? "TESTNET_VAULT_ADAPTER_READY"
            : "TESTNET_VAULTS_CONNECTED"
          : liveVaultAddress
            ? "CONFIGURED_NOT_ENABLED"
            : "PLANNED",
      vaultAddress: liveVaultAddress,
      executionAdapterAddress: liveAdapterAddress,
      marginVaultRequired: true,
      contractRepoPath: "contracts/src/ConvictionVault.sol",
      activeContracts,
      notes: [
        "Wallet flow is approval, deposit, then margin intent creation.",
        "A position is only marked executed after an execution adapter confirms the vault intent.",
        adapterRuntime.message,
      ],
    },
    recommendation: polymarketReadiness
      ? polymarketReadiness.productionVenueFillEnabled
        ? "Run a capped open-secure-close-repay canary before enabling production limits."
        : `Production execution is blocked: ${polymarketReadiness.missing.join(" ")}`
      : adapterRuntime.ready
        ? "Testnet adapter settlement is enabled. Do not describe it as a live venue fill."
        : "Record user intents now. Enable an adapter signer before showing positions as executed.",
    chains,
  };
}

export async function getExecutionReadiness() {
  const capabilities = await getExecutionCapabilities();
  const adapterRuntime = getAdapterRuntime();
  const testnetChains = capabilities.chains.filter((chain) => chain.network === "testnet");
  const walletFlowChains = testnetChains.filter(
    (chain) => chain.walletFlowEnabled && chain.vaultAddress && chain.collateralTokenAddress,
  );
  const missing: string[] = [];

  if (walletFlowChains.length === 0) {
    missing.push("No testnet chain has both an active vault and collateral token configured.");
  }

  if (env.convictionExecutionMode === "disabled") {
    missing.push("CONVICTION_EXECUTION_MODE is disabled.");
  }

  if (env.convictionExecutionMode === "testnet" && !env.convictionExecutionSignerPrivateKey) {
    missing.push("CONVICTION_EXECUTION_SIGNER_PRIVATE_KEY is missing.");
  }

  const polymarketReadiness =
    env.convictionExecutionMode === "polymarket" ? await getPolymarketExecutionReadiness() : null;
  if (polymarketReadiness && !polymarketReadiness.productionVenueFillEnabled) {
    missing.push(...polymarketReadiness.missing);
  }

  const stages = [
    {
      id: "market_intent",
      label: "Create market margin intent",
      ready: true,
      testEndpoint: "POST /positions",
      note: "Creates a persisted user intent. It is not a market fill.",
    },
    {
      id: "wallet_approval",
      label: "Prepare collateral approval",
      ready: walletFlowChains.length > 0,
      testEndpoint: "POST /contracts/collateral-approvals/prepare",
      note: "Returns wallet call data for ERC20 approval.",
    },
    {
      id: "vault_deposit",
      label: "Prepare vault deposit",
      ready: walletFlowChains.length > 0,
      testEndpoint: "POST /contracts/deposits/prepare",
      note: "Returns wallet call data for vault deposit.",
    },
    {
      id: "vault_margin_intent",
      label: "Prepare vault margin intent",
      ready: walletFlowChains.length > 0,
      testEndpoint: "POST /contracts/margin-intents/prepare",
      note: "Returns wallet call data for createMarginIntent.",
    },
    {
      id: "transaction_tracking",
      label: "Record wallet transaction hashes",
      ready: true,
      testEndpoint: "PATCH /contracts/transactions/:id",
      note: "Tracks submitted/confirmed wallet hashes. It does not by itself execute a market fill.",
    },
    {
      id: "adapter_settlement",
      label: "Settle adapter execution",
      ready:
        env.convictionExecutionMode === "polymarket"
          ? polymarketReadiness?.productionVenueFillEnabled === true
          : adapterRuntime.ready,
      testEndpoint: "POST /execution/positions/:positionId/settle",
      note: adapterRuntime.message,
    },
  ];

  return {
    status: polymarketReadiness?.productionVenueFillEnabled
      ? "PRODUCTION_CANARY_READY"
      : adapterRuntime.ready
        ? "ADAPTER_READY"
        : walletFlowChains.length > 0
          ? "WALLET_FLOW_READY"
          : "BLOCKED",
    canCreateMarginIntent: true,
    canPrepareWalletTransactions: walletFlowChains.length > 0,
    canSettleAdapterExecution:
      polymarketReadiness?.productionVenueFillEnabled ?? adapterRuntime.ready,
    canClaimRealMarketFill:
      polymarketReadiness?.productionVenueFillEnabled === true ||
      (adapterRuntime.ready && env.convictionExecutionMode === "testnet"),
    productionVenueFillEnabled: polymarketReadiness?.productionVenueFillEnabled ?? false,
    adapter: {
      id: adapterRuntime.adapterId,
      code: adapterRuntime.code,
      ready: adapterRuntime.ready,
      message: adapterRuntime.message,
    },
    missing,
    stages,
    supportedChains: capabilities.chains,
    warning: polymarketReadiness?.productionVenueFillEnabled
      ? "Production remains canary-capped. A position becomes EXECUTED only after CLOB trades, Polygon receipts, ERC-1155 custody, and vault activation all reconcile."
      : "A Conviction position should only show EXECUTED after adapter settlement confirms. Wallet approval, deposit, and margin intent transactions are not venue fills.",
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

  if (position.executionMode !== ExecutionMode.MARGIN) {
    return createBlockedAttempt(position, getSpotExecutionBlockReason());
  }

  if (!position.chainTransactionHash) {
    return createPendingAttempt(position, {
      code: "AWAITING_MARGIN_INTENT_TRANSACTION",
      message:
        "Margin request accepted. Submit and confirm the vault margin-intent transaction before execution can settle.",
    });
  }

  return settlePositionExecution(positionId);
}

export async function settlePositionExecution(positionId: string) {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
    include: { market: true },
  });

  if (!position) {
    throw new AppError("Position not found", {
      code: "POSITION_NOT_FOUND",
      statusCode: 404,
    });
  }

  if (position.executionMode !== ExecutionMode.MARGIN) {
    return createBlockedAttempt(position, getSpotExecutionBlockReason());
  }

  if (position.status === PositionStatus.EXECUTED) {
    const existingAttempt = await prisma.executionAttempt.findFirst({
      where: { positionId: position.id, status: ExecutionAttemptStatus.CONFIRMED },
      orderBy: { updatedAt: "desc" },
    });

    if (existingAttempt) return normalizeExecutionAttempt(existingAttempt);

    return createBlockedAttempt(position, {
      code: "POSITION_ALREADY_EXECUTED",
      message: "This position is already marked executed.",
    });
  }

  const adapterRuntime = getAdapterRuntime();

  if (!adapterRuntime.ready) {
    return createBlockedAttempt(position, {
      code: adapterRuntime.code,
      message: adapterRuntime.message,
    });
  }

  if (env.convictionExecutionMode === "polymarket") {
    const execution = await prisma.polymarketMarginExecution.findUnique({
      where: { positionId: position.id },
    });
    if (!execution) {
      return createBlockedAttempt(position, {
        code: "POLYMARKET_EXECUTION_AUTHORIZATION_REQUIRED",
        message:
          "Prepare and sign the Polygon margin execution authorization before settlement starts.",
      });
    }
    if (
      execution.state === "AUTHORIZED" &&
      position.chainTransactionHash &&
      transactionHashPattern.test(position.chainTransactionHash)
    ) {
      await recordPolymarketLoanReservation({
        executionId: execution.id,
        userId: position.userId,
        transactionHash: position.chainTransactionHash,
      });
    }
    return advancePolymarketMarginExecution({
      executionId: execution.id,
      userId: position.userId,
    });
  }

  return executeTestnetVaultAdapter(position, adapterRuntime.adapterId);
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

async function executeTestnetVaultAdapter(position: PositionWithMarket, adapterId: string) {
  const chainRuntime = getChainRuntime(position.chainId);

  if (!chainRuntime) {
    return createBlockedAttempt(position, {
      code: "UNSUPPORTED_ADAPTER_CHAIN",
      message: "The selected chain is not enabled for adapter settlement.",
    });
  }

  if (
    !position.chainTransactionHash ||
    !transactionHashPattern.test(position.chainTransactionHash)
  ) {
    return createPendingAttempt(position, {
      code: "AWAITING_MARGIN_INTENT_TRANSACTION",
      message: "The position does not have a confirmed vault margin-intent transaction hash yet.",
    });
  }

  const vault = await findActiveDeployment(position.chainId!, ContractRole.MARGIN_VAULT);
  const publicClient = createPublicClient({
    chain: chainRuntime.chain,
    transport: http(chainRuntime.rpcUrl),
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: position.chainTransactionHash as Hex,
  });

  if (receipt.status !== "success") {
    await prisma.position.update({
      where: { id: position.id },
      data: { status: PositionStatus.FAILED },
    });

    return createBlockedAttempt(position, {
      code: "MARGIN_INTENT_TRANSACTION_FAILED",
      message: "The vault margin-intent transaction failed onchain.",
    });
  }

  const parsedIntent = parseMarginIntentCreatedLog(receipt.logs, vault.address);

  if (!parsedIntent) {
    return createBlockedAttempt(position, {
      code: "MARGIN_INTENT_EVENT_NOT_FOUND",
      message: "The confirmed transaction did not emit the vault MarginIntentCreated event.",
    });
  }

  validateParsedIntent(position, parsedIntent);

  const fill = getReferenceFill(position.market, position.side);
  const attempt = await prisma.executionAttempt.create({
    data: {
      targetType: ExecutionTargetType.POSITION,
      positionId: position.id,
      adapterId,
      executionMode: position.executionMode,
      chainId: position.chainId,
      walletAddress: position.walletAddress?.toLowerCase() ?? null,
      requestedQuantity: position.quantity,
      leverageMultiplier: position.leverageMultiplier,
      marginCollateral: position.marginCollateral,
      notionalAmount: position.notionalAmount,
      borrowedAmount: position.borrowedAmount,
      observedMarketPrice: fill.price,
      status: ExecutionAttemptStatus.PENDING,
      failureCode: null,
      failureMessage: null,
      externalOrderId: null,
      chainTransactionHash: null,
      requestPayload: {
        intentId: parsedIntent.intentId,
        marketId: position.marketId,
        marketSource: position.market.source,
        marketSourceId: position.market.externalMarketId,
        priceSource: fill.source,
      },
      responsePayload: {
        stage: "adapter_pending",
      },
    },
  });

  const signerPrivateKey = env.convictionExecutionSignerPrivateKey;

  if (!signerPrivateKey) {
    return normalizeExecutionAttempt(
      await markAttemptBlocked(attempt.id, {
        code: "EXECUTION_SIGNER_MISSING",
        message: "CONVICTION_EXECUTION_SIGNER_PRIVATE_KEY is required for adapter settlement.",
      }),
    );
  }

  const account = privateKeyToAccount(signerPrivateKey as Hex);
  const isAuthorized = await publicClient.readContract({
    abi: vaultAdapterAbi,
    address: vault.address as Address,
    args: [account.address],
    functionName: "authorizedAdapters",
  });

  if (!isAuthorized) {
    return normalizeExecutionAttempt(
      await markAttemptBlocked(attempt.id, {
        code: "EXECUTION_SIGNER_NOT_AUTHORIZED",
        message:
          "The execution signer is not authorized as a vault adapter. The vault owner must call setAdapter(signer, true).",
      }),
    );
  }

  const walletClient = createWalletClient({
    account,
    chain: chainRuntime.chain,
    transport: http(chainRuntime.rpcUrl),
  });
  const externalRef = buildReferenceBytes("conviction:testnet:submit:" + position.id);
  const executionRef = buildReferenceBytes(
    "conviction:testnet:fill:" + position.id + ":" + fill.price,
  );
  let submitHash: Hex;

  try {
    submitHash = await walletClient.writeContract({
      abi: vaultAdapterAbi,
      address: vault.address as Address,
      args: [parsedIntent.intentId, externalRef],
      functionName: "submitMarginIntent",
    });
  } catch (error) {
    return normalizeExecutionAttempt(
      await markAttemptFailed(attempt.id, {
        code: "ADAPTER_SUBMIT_REJECTED",
        message: getAdapterErrorMessage(error, "The adapter submit transaction was rejected."),
        responsePayload: { error: getAdapterErrorMessage(error, "adapter_submit_rejected") },
      }),
    );
  }

  const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: submitHash });

  if (submitReceipt.status !== "success") {
    return normalizeExecutionAttempt(
      await markAttemptFailed(attempt.id, {
        code: "ADAPTER_SUBMIT_FAILED",
        message: "The adapter submit transaction failed onchain.",
        responsePayload: { submitHash, submitReceipt: summarizeReceipt(submitReceipt) },
      }),
    );
  }

  await prisma.executionAttempt.update({
    where: { id: attempt.id },
    data: {
      chainTransactionHash: submitHash,
      externalOrderId: externalRef,
      responsePayload: {
        fill,
        intentId: parsedIntent.intentId,
        stage: "adapter_submitted",
        submitHash,
      },
      status: ExecutionAttemptStatus.SUBMITTED,
    },
  });

  let confirmHash: Hex;

  try {
    confirmHash = await walletClient.writeContract({
      abi: vaultAdapterAbi,
      address: vault.address as Address,
      args: [parsedIntent.intentId, executionRef],
      functionName: "confirmMarginIntent",
    });
  } catch (error) {
    return normalizeExecutionAttempt(
      await markAttemptFailed(attempt.id, {
        code: "ADAPTER_CONFIRM_REJECTED",
        message: getAdapterErrorMessage(error, "The adapter confirm transaction was rejected."),
        responsePayload: {
          error: getAdapterErrorMessage(error, "adapter_confirm_rejected"),
          submitHash,
        },
      }),
    );
  }

  const confirmReceipt = await publicClient.waitForTransactionReceipt({ hash: confirmHash });

  if (confirmReceipt.status !== "success") {
    return normalizeExecutionAttempt(
      await markAttemptFailed(attempt.id, {
        code: "ADAPTER_CONFIRM_FAILED",
        message: "The adapter confirm transaction failed onchain.",
        responsePayload: {
          confirmHash,
          confirmReceipt: summarizeReceipt(confirmReceipt),
          submitHash,
        },
      }),
    );
  }

  const [confirmedAttempt] = await prisma.$transaction([
    prisma.executionAttempt.update({
      where: { id: attempt.id },
      data: {
        chainTransactionHash: confirmHash,
        externalOrderId: executionRef,
        failureCode: null,
        failureMessage: null,
        responsePayload: {
          fill,
          intentId: parsedIntent.intentId,
          stage: "adapter_confirmed",
          submitHash,
          confirmHash,
        },
        status: ExecutionAttemptStatus.CONFIRMED,
      },
    }),
    prisma.position.update({
      where: { id: position.id },
      data: {
        averageEntryPrice: fill.price,
        executionAdapterId: adapterId,
        status: PositionStatus.EXECUTED,
        openedAt: new Date(),
      },
    }),
  ]);

  return normalizeExecutionAttempt(confirmedAttempt);
}

function getAdapterRuntime() {
  if (env.convictionExecutionMode === "disabled") {
    return {
      adapterId: "NO_ACTIVE_EXECUTION_ADAPTER",
      code: "EXECUTION_MODE_DISABLED",
      message:
        "Execution adapter mode is disabled. Set CONVICTION_EXECUTION_MODE=testnet only after an adapter signer is configured and authorized.",
      ready: false,
    };
  }

  if (env.convictionExecutionMode === "polymarket") {
    const hasCredentials = Boolean(
      env.polymarketPusdVaultAddress &&
        env.polymarketExecutionAdapterAddress &&
        env.polymarketExecutionSignerPrivateKey &&
        env.polymarketExecutionKeyEncryptionKey &&
        env.polymarketPusdAddress &&
        env.polymarketCtfAddress &&
        env.polymarketExchangeV2Address &&
        env.polymarketNegRiskExchangeV2Address &&
        env.polymarketDepositWalletFactoryAddress &&
        env.polymarketBuilderCode &&
        ((env.polymarketRelayerApiKey && env.polymarketRelayerApiKeyAddress) ||
          (env.polymarketBuilderApiKey &&
            env.polymarketBuilderApiSecret &&
            env.polymarketBuilderApiPassphrase)),
    );

    return {
      adapterId: POLYMARKET_ADAPTER_ID,
      code: hasCredentials ? "POLYMARKET_ADAPTER_CONFIGURED" : "POLYMARKET_CREDENTIALS_MISSING",
      message: hasCredentials
        ? "Polymarket CLOB V2 and isolated Polygon custody are configured. Every execution still runs live readiness and reconciliation checks."
        : "Production Polygon vault, signer, relayer, builder, custody encryption, and current venue addresses are required.",
      ready: hasCredentials,
    };
  }

  if (!env.convictionExecutionSignerPrivateKey) {
    return {
      adapterId: TESTNET_ADAPTER_ID,
      code: "EXECUTION_SIGNER_MISSING",
      message:
        "Testnet adapter mode is selected, but CONVICTION_EXECUTION_SIGNER_PRIVATE_KEY is missing.",
      ready: false,
    };
  }

  return {
    adapterId: TESTNET_ADAPTER_ID,
    code: "TESTNET_ADAPTER_READY",
    message:
      "Testnet vault adapter is configured. It can submit and confirm vault intents with an authorized adapter signer; this is not a live Polymarket venue fill.",
    ready: true,
  };
}

async function createPendingAttempt(position: Position, detail: { code: string; message: string }) {
  const executionAttempt = await prisma.executionAttempt.create({
    data: buildAttemptData(position, {
      adapterId: "AWAITING_WALLET_TRANSACTION",
      responsePayload: {
        executed: false,
        reason: detail.code,
      },
      status: ExecutionAttemptStatus.PENDING,
      failureCode: detail.code,
      failureMessage: detail.message,
    }),
  });

  return normalizeExecutionAttempt(executionAttempt);
}

async function createBlockedAttempt(position: Position, detail: { code: string; message: string }) {
  const adapterRuntime = getAdapterRuntime();
  const executionAttempt = await prisma.executionAttempt.create({
    data: buildAttemptData(position, {
      adapterId: adapterRuntime.adapterId,
      responsePayload: {
        executed: false,
        reason: detail.code,
      },
      status: ExecutionAttemptStatus.BLOCKED,
      failureCode: detail.code,
      failureMessage: detail.message,
    }),
  });

  return normalizeExecutionAttempt(executionAttempt);
}

function buildAttemptData(
  position: Position,
  detail: {
    adapterId: string;
    failureCode: string | null;
    failureMessage: string | null;
    responsePayload: Prisma.InputJsonValue;
    status: ExecutionAttemptStatus;
  },
): Prisma.ExecutionAttemptUncheckedCreateInput {
  return {
    targetType: ExecutionTargetType.POSITION,
    positionId: position.id,
    adapterId: detail.adapterId,
    executionMode: position.executionMode,
    chainId: position.chainId,
    walletAddress: position.walletAddress?.toLowerCase() ?? null,
    requestedQuantity: position.quantity,
    leverageMultiplier: position.leverageMultiplier,
    marginCollateral: position.marginCollateral,
    notionalAmount: position.notionalAmount,
    borrowedAmount: position.borrowedAmount,
    observedMarketPrice: position.observedMarketPrice,
    status: detail.status,
    failureCode: detail.failureCode,
    failureMessage: detail.failureMessage,
    externalOrderId: null,
    chainTransactionHash: null,
    requestPayload: {
      idempotencyKey: position.idempotencyKey,
      positionId: position.id,
    },
    responsePayload: detail.responsePayload,
  };
}

async function markAttemptBlocked(attemptId: string, detail: { code: string; message: string }) {
  return prisma.executionAttempt.update({
    where: { id: attemptId },
    data: {
      failureCode: detail.code,
      failureMessage: detail.message,
      responsePayload: {
        executed: false,
        reason: detail.code,
      },
      status: ExecutionAttemptStatus.BLOCKED,
    },
  });
}

async function markAttemptFailed(
  attemptId: string,
  detail: { code: string; message: string; responsePayload: Prisma.InputJsonValue },
) {
  return prisma.executionAttempt.update({
    where: { id: attemptId },
    data: {
      failureCode: detail.code,
      failureMessage: detail.message,
      responsePayload: detail.responsePayload,
      status: ExecutionAttemptStatus.FAILED,
    },
  });
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

function getChainRuntime(chainId: number | null): ChainRuntime | null {
  if (chainId === 84532) {
    return { chain: baseSepolia, rpcUrl: env.baseSepoliaRpcUrl };
  }

  if (chainId === 11155111) {
    return { chain: sepolia, rpcUrl: env.ethereumSepoliaRpcUrl };
  }

  if (chainId === 421614) {
    return { chain: arbitrumSepolia, rpcUrl: env.arbitrumSepoliaRpcUrl };
  }

  return null;
}

function parseMarginIntentCreatedLog(logs: Log[], vaultAddress: string): ParsedMarginIntent | null {
  const normalizedVault = vaultAddress.toLowerCase();

  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedVault) continue;

    try {
      const decoded = decodeEventLog({
        abi: [marginIntentCreatedEvent],
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName !== "MarginIntentCreated") continue;

      return {
        account: decoded.args.account,
        collateralAmount: decoded.args.collateralAmount.toString(),
        collateralToken: decoded.args.collateralToken,
        intentId: decoded.args.intentId,
        marketId: decoded.args.marketId,
        notionalAmount: decoded.args.notionalAmount.toString(),
        offchainPositionId: decoded.args.offchainPositionId,
      };
    } catch {
      continue;
    }
  }

  return null;
}

function validateParsedIntent(position: PositionWithMarket, intent: ParsedMarginIntent) {
  if (
    position.walletAddress &&
    intent.account.toLowerCase() !== position.walletAddress.toLowerCase()
  ) {
    throw new AppError("Margin intent wallet does not match the position wallet", {
      code: "MARGIN_INTENT_WALLET_MISMATCH",
      statusCode: 409,
    });
  }

  if (intent.offchainPositionId.toLowerCase() !== objectIdToBytes32(position.id)) {
    throw new AppError("Margin intent does not reference this position", {
      code: "MARGIN_INTENT_POSITION_MISMATCH",
      statusCode: 409,
    });
  }

  if (intent.marketId.toLowerCase() !== objectIdToBytes32(position.marketId)) {
    throw new AppError("Margin intent does not reference this market", {
      code: "MARGIN_INTENT_MARKET_MISMATCH",
      statusCode: 409,
    });
  }
}

function getReferenceFill(market: Market, side: PositionSide) {
  const yesPrice = parseMarketPrice(market.bestAsk ?? market.lastTradePrice ?? market.bestBid);
  const fallback = parseMarketPrice(market.lastTradePrice ?? market.bestBid ?? market.bestAsk);
  const referenceYesPrice = yesPrice ?? fallback ?? new Prisma.Decimal("0.5");
  const boundedYesPrice = clampProbability(referenceYesPrice);
  const fillPrice =
    side === PositionSide.YES ? boundedYesPrice : new Prisma.Decimal(1).minus(boundedYesPrice);

  return {
    price: fillPrice.toDecimalPlaces(4).toString(),
    source:
      market.source === MarketSource.POLYMARKET
        ? "POLYMARKET_SYNCED_REFERENCE_PRICE"
        : "SYNCED_REFERENCE_PRICE",
  };
}

function parseMarketPrice(value: string | null) {
  if (!value) return null;

  try {
    const decimal = new Prisma.Decimal(value);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

function clampProbability(value: Prisma.Decimal) {
  if (value.lt(0)) return new Prisma.Decimal(0);
  if (value.gt(1)) return new Prisma.Decimal(1);

  return value;
}

function buildReferenceBytes(value: string) {
  return keccak256(toBytes(value));
}

function summarizeReceipt(receipt: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>) {
  return {
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status,
    transactionHash: receipt.transactionHash,
  };
}

function getAdapterErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 500);
  }

  return fallback;
}

function objectIdToBytes32(value: string) {
  return "0x" + value.toLowerCase().padStart(64, "0");
}

function getSpotExecutionBlockReason() {
  return {
    code: "SPOT_EXECUTION_NOT_ENABLED",
    message: "Spot execution is blocked until a real execution adapter is live.",
  };
}
