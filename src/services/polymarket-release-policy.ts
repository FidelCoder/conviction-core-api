import { PolymarketAccountStatus, PolymarketCloseStage } from "@prisma/client";
import { getContractConfig } from "@polymarket/clob-client-v2";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { formatSixDecimalAssets, parseSixDecimalAssets } from "./polymarket-execution-state.js";

const bps = 10_000n;
const walletPattern = /^0x[a-fA-F0-9]{40}$/;
const conditionPattern = /^0x[a-fA-F0-9]{64}$/;
const vaultRiskAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalBorrowedAssets() view returns (uint256)",
  "function totalReservedAssets() view returns (uint256)",
  "function totalUncoveredBadDebt() view returns (uint256)",
  "function paused() view returns (bool)",
  "function asset() view returns (address)",
  "function deploymentChainId() view returns (uint256)",
  "function authorizedAdapters(address account) view returns (bool)",
  "function isExecutionTargetAllowed(address target) view returns (bool)",
]);

export type PolymarketReleaseCaps = {
  dailyLossLimitAssets: string;
  maxLeverageBps: number;
  maxPositionAssets: string;
  maxTvlAssets: string;
  maxUtilizationBps: number;
};

export type PolymarketReleasePolicyStatus = {
  mode: "INVITE_ONLY_CANARY" | "PRODUCTION";
  canaryPassed: boolean;
  inviteOnly: boolean;
  allowedWalletsCount: number;
  allowedMarketsCount: number;
  caps: PolymarketReleaseCaps;
  dailyRealizedLossAssets: string | null;
  currentTvlAssets: string | null;
  currentUtilizationBps: number | null;
  missing: string[];
};

export type PolymarketVaultReleaseSnapshot = {
  paused: boolean;
  totalAssets: bigint;
  totalBorrowedAssets: bigint;
  totalReservedAssets: bigint;
  uncoveredBadDebt: bigint;
};

type ReleasePolicyInput = {
  borrowAssets: string;
  conditionId: string;
  leverageBps: number;
  notionalAssets: string;
  userId: string;
  walletAddress: string;
};

type ReleaseCapEvaluation = {
  accountLinked: boolean;
  allowedMarket: boolean;
  allowedWallet: boolean;
  borrowAssets: bigint;
  dailyLossAssets: bigint;
  dailyLossLimitAssets: bigint;
  leverageBps: number;
  maxLeverageBps: number;
  maxPositionAssets: bigint;
  maxTvlAssets: bigint;
  maxUtilizationBps: number;
  notionalAssets: bigint;
  paused: boolean;
  totalAssets: bigint;
  totalBorrowedAssets: bigint;
  totalReservedAssets: bigint;
  uncoveredBadDebt: bigint;
};

export function evaluatePolymarketReleaseCaps(input: ReleaseCapEvaluation) {
  const rejections: string[] = [];
  if (!input.allowedWallet) rejections.push("Wallet is not invited to the execution canary.");
  if (!input.accountLinked)
    rejections.push("Canary wallet has no verified linked Polymarket account.");
  if (!input.allowedMarket) rejections.push("Market is outside the canary market allowlist.");
  if (input.leverageBps > input.maxLeverageBps)
    rejections.push("Requested leverage exceeds the release leverage cap.");
  if (input.notionalAssets > input.maxPositionAssets)
    rejections.push("Position notional exceeds the release position cap.");
  if (input.totalAssets > input.maxTvlAssets)
    rejections.push("Vault TVL exceeds the configured release cap.");
  if (input.paused) rejections.push("Polygon vault is paused for new risk.");
  if (input.uncoveredBadDebt > 0n) rejections.push("Vault reports uncovered bad debt.");
  if (input.dailyLossAssets >= input.dailyLossLimitAssets)
    rejections.push("Daily realized-loss limit has been reached.");

  if (input.totalAssets === 0n) {
    rejections.push("Vault has no LP assets available for margin.");
  } else {
    const projectedBorrowed =
      input.totalBorrowedAssets + input.totalReservedAssets + input.borrowAssets;
    const projectedUtilizationBps = Number((projectedBorrowed * bps) / input.totalAssets);
    if (projectedUtilizationBps > input.maxUtilizationBps) {
      rejections.push("Projected vault utilization exceeds the release cap.");
    }
  }
  return rejections;
}

export function selectEffectivePolymarketPositionCap(
  canary: boolean,
  canaryCap: bigint,
  releaseCap: bigint,
) {
  return canary && canaryCap < releaseCap ? canaryCap : releaseCap;
}

export async function assertPolymarketReleasePolicy(input: ReleasePolicyInput) {
  const config = releasePolicyConfig();
  const canary = !env.polymarketCanaryPassed;
  const wallet = input.walletAddress.toLowerCase();
  const conditionId = input.conditionId.toLowerCase();
  const configurationRejections = releaseConfigurationRejections();
  if (configurationRejections.length > 0) {
    throw releasePolicyError(configurationRejections);
  }
  const [vault, dailyLossAssets, linkedAccount, clobReady] = await Promise.all([
    readVaultRiskSnapshot(),
    getDailyRealizedLossAssets(),
    canary
      ? prisma.polymarketAccount.findFirst({
          where: {
            userId: input.userId,
            status: { in: [PolymarketAccountStatus.LINKED, PolymarketAccountStatus.READY] },
            walletVerifiedAt: { not: null },
          },
          select: { id: true },
        })
      : Promise.resolve({ id: "production-isolated-custody" }),
    checkClobV2(),
  ]);
  const canaryPositionCap = parseSixDecimalAssets(
    env.polymarketCanaryMaxAssets,
    "POLYMARKET_CANARY_MAX_ASSETS",
  );
  const releasePositionCap = parseSixDecimalAssets(
    env.polymarketReleaseMaxPositionAssets,
    "POLYMARKET_RELEASE_MAX_POSITION_ASSETS",
  );
  const maxPositionAssets = selectEffectivePolymarketPositionCap(
    canary,
    canaryPositionCap,
    releasePositionCap,
  );
  const rejections = evaluatePolymarketReleaseCaps({
    accountLinked: Boolean(linkedAccount),
    allowedMarket: !canary || config.conditionIds.includes(conditionId),
    allowedWallet: !canary || config.wallets.includes(wallet),
    borrowAssets: parseSixDecimalAssets(input.borrowAssets, "borrowAssets"),
    dailyLossAssets,
    dailyLossLimitAssets: parseSixDecimalAssets(
      env.polymarketReleaseDailyLossLimitAssets,
      "POLYMARKET_RELEASE_DAILY_LOSS_LIMIT_ASSETS",
    ),
    leverageBps: input.leverageBps,
    maxLeverageBps: env.polymarketReleaseMaxLeverageBps,
    maxPositionAssets,
    maxTvlAssets: parseSixDecimalAssets(
      env.polymarketReleaseMaxTvlAssets,
      "POLYMARKET_RELEASE_MAX_TVL_ASSETS",
    ),
    maxUtilizationBps: env.polymarketReleaseMaxUtilizationBps,
    notionalAssets: parseSixDecimalAssets(input.notionalAssets, "notionalAssets"),
    paused: vault.paused,
    totalAssets: vault.totalAssets,
    totalBorrowedAssets: vault.totalBorrowedAssets,
    totalReservedAssets: vault.totalReservedAssets,
    uncoveredBadDebt: vault.uncoveredBadDebt,
  });
  if (!vault.vaultCode || vault.vaultCode === "0x")
    rejections.push("Configured Polygon vault has no bytecode.");
  if (!vault.pusdCode || vault.pusdCode === "0x")
    rejections.push("Configured pUSD contract has no bytecode.");
  if (!vault.factoryCode || vault.factoryCode === "0x")
    rejections.push("Configured deposit-wallet factory has no bytecode.");
  if (vault.deploymentChainId !== 137n)
    rejections.push("Polygon vault deployment chain is not 137.");
  if (vault.asset.toLowerCase() !== env.polymarketPusdAddress!.toLowerCase())
    rejections.push("Polygon vault asset is not the configured pUSD contract.");
  if (!vault.adapterAllowed) rejections.push("Execution adapter is not authorized by the vault.");
  if (!vault.pusdAllowed) rejections.push("pUSD is not allowlisted as an execution target.");
  if (!clobReady) rejections.push("Polymarket CLOB V2 health checks are not passing.");
  if (config.invalidWallets.length > 0)
    rejections.push("Canary wallet allowlist contains malformed addresses.");
  if (config.invalidConditionIds.length > 0)
    rejections.push("Canary market allowlist contains malformed condition IDs.");
  if (canary && config.wallets.length === 0) rejections.push("Canary wallet allowlist is empty.");
  if (canary && (config.conditionIds.length < 1 || config.conditionIds.length > 5))
    rejections.push("Canary market allowlist must contain between one and five markets.");

  if (rejections.length > 0) {
    throw releasePolicyError(rejections);
  }
}

export async function getPolymarketReleasePolicyStatus(
  input: {
    vaultSnapshot?: PolymarketVaultReleaseSnapshot | null;
  } = {},
): Promise<PolymarketReleasePolicyStatus> {
  const config = releasePolicyConfig();
  const canary = !env.polymarketCanaryPassed;
  const missing: string[] = [];
  if (config.invalidWallets.length > 0)
    missing.push("POLYMARKET_CANARY_ALLOWED_WALLETS contains malformed addresses.");
  if (config.invalidConditionIds.length > 0)
    missing.push("POLYMARKET_CANARY_CONDITION_IDS contains malformed condition IDs.");
  if (canary && config.wallets.length === 0)
    missing.push("POLYMARKET_CANARY_ALLOWED_WALLETS is empty.");
  if (canary && (config.conditionIds.length < 1 || config.conditionIds.length > 5))
    missing.push("POLYMARKET_CANARY_CONDITION_IDS must contain between one and five IDs.");

  if (canary && config.conditionIds.length > 0 && config.conditionIds.length <= 5) {
    const markets = await prisma.market.findMany({
      where: { conditionId: { in: config.conditionIds } },
      select: {
        conditionId: true,
        yesTokenId: true,
        noTokenId: true,
        marginRiskPolicy: { select: { id: true } },
      },
    });
    const eligible = markets.filter(
      (market) =>
        market.conditionId && market.yesTokenId && market.noTokenId && market.marginRiskPolicy,
    );
    if (eligible.length !== config.conditionIds.length) {
      missing.push("Every canary condition ID must map to both outcome tokens and a risk policy.");
    }
  }

  let dailyLossAssets: bigint | null = null;
  let vault: PolymarketVaultReleaseSnapshot | null = null;
  try {
    [dailyLossAssets, vault] = await Promise.all([
      getDailyRealizedLossAssets(),
      input.vaultSnapshot === undefined
        ? readVaultRiskSnapshot()
        : Promise.resolve(input.vaultSnapshot),
    ]);
  } catch (error) {
    missing.push(
      `Release risk accounting probe failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  const maxTvl = parseSixDecimalAssets(
    env.polymarketReleaseMaxTvlAssets,
    "POLYMARKET_RELEASE_MAX_TVL_ASSETS",
  );
  const dailyLossLimit = parseSixDecimalAssets(
    env.polymarketReleaseDailyLossLimitAssets,
    "POLYMARKET_RELEASE_DAILY_LOSS_LIMIT_ASSETS",
  );
  if (vault?.paused) missing.push("Polygon vault is paused for new risk.");
  if (vault && vault.totalAssets > maxTvl)
    missing.push("Polygon vault TVL exceeds POLYMARKET_RELEASE_MAX_TVL_ASSETS.");
  if (vault?.uncoveredBadDebt && vault.uncoveredBadDebt > 0n)
    missing.push("Polygon vault reports uncovered bad debt.");
  if (dailyLossAssets !== null && dailyLossAssets >= dailyLossLimit)
    missing.push("POLYMARKET_RELEASE_DAILY_LOSS_LIMIT_ASSETS has been reached.");
  const effectivePositionCap = selectEffectivePolymarketPositionCap(
    canary,
    parseSixDecimalAssets(env.polymarketCanaryMaxAssets, "POLYMARKET_CANARY_MAX_ASSETS"),
    parseSixDecimalAssets(
      env.polymarketReleaseMaxPositionAssets,
      "POLYMARKET_RELEASE_MAX_POSITION_ASSETS",
    ),
  );
  const currentUtilizationBps =
    vault && vault.totalAssets > 0n
      ? Number(((vault.totalBorrowedAssets + vault.totalReservedAssets) * bps) / vault.totalAssets)
      : null;
  if (
    currentUtilizationBps !== null &&
    currentUtilizationBps > env.polymarketReleaseMaxUtilizationBps
  ) {
    missing.push("Polygon vault utilization exceeds POLYMARKET_RELEASE_MAX_UTILIZATION_BPS.");
  }

  return {
    mode: canary ? "INVITE_ONLY_CANARY" : "PRODUCTION",
    canaryPassed: env.polymarketCanaryPassed,
    inviteOnly: canary,
    allowedWalletsCount: config.wallets.length,
    allowedMarketsCount: config.conditionIds.length,
    caps: {
      dailyLossLimitAssets: env.polymarketReleaseDailyLossLimitAssets,
      maxLeverageBps: env.polymarketReleaseMaxLeverageBps,
      maxPositionAssets: formatSixDecimalAssets(effectivePositionCap),
      maxTvlAssets: env.polymarketReleaseMaxTvlAssets,
      maxUtilizationBps: env.polymarketReleaseMaxUtilizationBps,
    },
    dailyRealizedLossAssets:
      dailyLossAssets === null ? null : formatSixDecimalAssets(dailyLossAssets),
    currentTvlAssets: vault ? formatSixDecimalAssets(vault.totalAssets) : null,
    currentUtilizationBps,
    missing,
  };
}

function releasePolicyConfig() {
  const wallets = parseList(env.polymarketCanaryAllowedWallets, walletPattern);
  const conditionIds = parseList(env.polymarketCanaryConditionIds, conditionPattern);
  return {
    wallets: wallets.valid,
    invalidWallets: wallets.invalid,
    conditionIds: conditionIds.valid,
    invalidConditionIds: conditionIds.invalid,
  };
}

function parseList(value: string | null, pattern: RegExp) {
  const entries = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  return {
    valid: entries.filter((entry) => pattern.test(entry)),
    invalid: entries.filter((entry) => !pattern.test(entry)),
  };
}

async function readVaultRiskSnapshot() {
  if (!env.polymarketPusdVaultAddress) throw new Error("POLYMARKET_PUSD_VAULT_ADDRESS is missing");
  const client = createPublicClient({ chain: polygon, transport: http(env.polygonRpcUrl) });
  const address = env.polymarketPusdVaultAddress as Address;
  const adapter = env.polymarketExecutionAdapterAddress as Address;
  const pusd = env.polymarketPusdAddress as Address;
  const factory = env.polymarketDepositWalletFactoryAddress as Address;
  const [
    totalAssets,
    totalBorrowedAssets,
    totalReservedAssets,
    uncoveredBadDebt,
    paused,
    asset,
    deploymentChainId,
    adapterAllowed,
    pusdAllowed,
    vaultCode,
    pusdCode,
    factoryCode,
  ] = await Promise.all([
    client.readContract({ address, abi: vaultRiskAbi, functionName: "totalAssets" }),
    client.readContract({ address, abi: vaultRiskAbi, functionName: "totalBorrowedAssets" }),
    client.readContract({ address, abi: vaultRiskAbi, functionName: "totalReservedAssets" }),
    client.readContract({ address, abi: vaultRiskAbi, functionName: "totalUncoveredBadDebt" }),
    client.readContract({ address, abi: vaultRiskAbi, functionName: "paused" }),
    client.readContract({ address, abi: vaultRiskAbi, functionName: "asset" }),
    client.readContract({ address, abi: vaultRiskAbi, functionName: "deploymentChainId" }),
    client.readContract({
      address,
      abi: vaultRiskAbi,
      functionName: "authorizedAdapters",
      args: [adapter],
    }),
    client.readContract({
      address,
      abi: vaultRiskAbi,
      functionName: "isExecutionTargetAllowed",
      args: [pusd],
    }),
    client.getCode({ address }),
    client.getCode({ address: pusd }),
    client.getCode({ address: factory }),
  ]);
  return {
    totalAssets,
    totalBorrowedAssets,
    totalReservedAssets,
    uncoveredBadDebt,
    paused,
    asset,
    deploymentChainId,
    adapterAllowed,
    pusdAllowed,
    vaultCode,
    pusdCode,
    factoryCode,
  };
}

function releaseConfigurationRejections() {
  const rejections: string[] = [];
  const official = getContractConfig(137);
  for (const [name, configured, expected] of [
    ["POLYMARKET_PUSD_ADDRESS", env.polymarketPusdAddress, official.collateral],
    ["POLYMARKET_CTF_ADDRESS", env.polymarketCtfAddress, official.conditionalTokens],
    ["POLYMARKET_EXCHANGE_V2_ADDRESS", env.polymarketExchangeV2Address, official.exchangeV2],
    [
      "POLYMARKET_NEG_RISK_EXCHANGE_V2_ADDRESS",
      env.polymarketNegRiskExchangeV2Address,
      official.negRiskExchangeV2,
    ],
    [
      "POLYMARKET_NEG_RISK_ADAPTER_ADDRESS",
      env.polymarketNegRiskAdapterAddress,
      official.negRiskAdapter,
    ],
  ] as const) {
    if (!configured) rejections.push(`${name} is missing.`);
    else if (configured.toLowerCase() !== expected.toLowerCase())
      rejections.push(`${name} does not match the current official CLOB V2 address.`);
  }
  for (const [name, value] of [
    ["POLYMARKET_PUSD_VAULT_ADDRESS", env.polymarketPusdVaultAddress],
    ["POLYMARKET_PUSD_ADDRESS", env.polymarketPusdAddress],
    ["POLYMARKET_EXECUTION_ADAPTER_ADDRESS", env.polymarketExecutionAdapterAddress],
    ["POLYMARKET_EXECUTION_SIGNER_PRIVATE_KEY", env.polymarketExecutionSignerPrivateKey],
    ["POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS", env.polymarketDepositWalletFactoryAddress],
    ["POLYMARKET_CREDENTIALS_ENCRYPTION_KEY", env.polymarketCredentialsEncryptionKey],
    ["POLYMARKET_EXECUTION_KEY_ENCRYPTION_KEY", env.polymarketExecutionKeyEncryptionKey],
  ] as const) {
    if (!value) rejections.push(`${name} is missing.`);
  }
  if (env.convictionExecutionMode !== "polymarket")
    rejections.push("CONVICTION_EXECUTION_MODE is not polymarket.");
  if (!env.polymarketLifecycleEnabled) rejections.push("POLYMARKET_LIFECYCLE_ENABLED is false.");
  if (!env.polymarketActiveRepayEnabled)
    rejections.push("POLYMARKET_ACTIVE_REPAY_ENABLED is false.");
  const hasRelayerCredentials = Boolean(
    (env.polymarketRelayerApiKey && env.polymarketRelayerApiKeyAddress) ||
      (env.polymarketBuilderApiKey &&
        env.polymarketBuilderApiSecret &&
        env.polymarketBuilderApiPassphrase),
  );
  if (!hasRelayerCredentials)
    rejections.push("Relayer API credentials or builder HMAC credentials are missing.");
  if (env.polymarketExecutionSignerPrivateKey && env.polymarketExecutionAdapterAddress) {
    const signer = privateKeyToAccount(env.polymarketExecutionSignerPrivateKey as Hex);
    if (signer.address.toLowerCase() !== env.polymarketExecutionAdapterAddress.toLowerCase())
      rejections.push("Execution signer does not match the configured adapter.");
  }
  return rejections;
}

async function checkClobV2() {
  try {
    const [health, version] = await Promise.all([
      fetch(new URL("/ok", env.polymarketClobApiUrl), { signal: AbortSignal.timeout(5_000) }),
      fetch(new URL("/version", env.polymarketClobApiUrl), {
        signal: AbortSignal.timeout(5_000),
      }),
    ]);
    const payload = (await version.json()) as { version?: number };
    return health.ok && version.ok && payload.version === 2;
  } catch {
    return false;
  }
}

function releasePolicyError(rejections: string[]) {
  return new AppError("Polymarket release policy blocked this margin request", {
    code: "POLYMARKET_RELEASE_POLICY_BLOCKED",
    statusCode: 403,
    details: { rejections },
  });
}

async function getDailyRealizedLossAssets() {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const closes = await prisma.polymarketCloseAttempt.findMany({
    where: {
      completedAt: { gte: dayStart },
      stage: PolymarketCloseStage.CLOSED,
      actualProceeds: { not: null },
    },
    select: {
      actualProceeds: true,
      execution: { select: { actualSpentAssets: true } },
    },
  });
  return closes.reduce((loss, close) => {
    if (!close.actualProceeds || !close.execution.actualSpentAssets) return loss;
    const spent = parseSixDecimalAssets(close.execution.actualSpentAssets, "actualSpentAssets");
    const proceeds = parseSixDecimalAssets(close.actualProceeds, "actualProceeds");
    return spent > proceeds ? loss + spent - proceeds : loss;
  }, 0n);
}
