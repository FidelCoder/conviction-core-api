import "dotenv/config";

import { z } from "zod";

const optionalEvmAddress = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
);

const optionalPrivateKey = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .optional(),
);

const optionalBoolean = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }

  return value;
}, z.boolean().default(false));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url(),
  POLYMARKET_GAMMA_API_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_DATA_API_URL: z.string().url().default("https://data-api.polymarket.com"),
  POLYMARKET_MARKETS_SYNC_LIMIT: z.coerce.number().int().positive().max(500).default(250),
  MARKET_SYNC_TOKEN: z.string().min(24).optional(),
  CRON_SECRET: z.string().min(16).optional(),
  ADMIN_DASHBOARD_TOKEN: z.string().min(24).optional(),
  CONVICTION_VAULT_ADDRESS: optionalEvmAddress,
  CONVICTION_EXECUTION_ADAPTER_ADDRESS: optionalEvmAddress,
  CONVICTION_EXECUTION_MODE: z.enum(["disabled", "testnet", "polymarket"]).default("disabled"),
  CONVICTION_EXECUTION_SIGNER_PRIVATE_KEY: optionalPrivateKey,
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  ETHEREUM_SEPOLIA_RPC_URL: z.string().url().default("https://ethereum-sepolia-rpc.publicnode.com"),
  ARBITRUM_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia-rollup.arbitrum.io/rpc"),
  BASE_RPC_URL: z.string().url().default("https://mainnet.base.org"),
  POLYGON_RPC_URL: z.string().url().default("https://polygon-rpc.com"),
  POLYMARKET_CLOB_API_URL: z.string().url().default("https://clob.polymarket.com"),
  POLYMARKET_CLOB_API_KEY: z.string().min(1).optional(),
  POLYMARKET_CLOB_API_SECRET: z.string().min(1).optional(),
  POLYMARKET_CLOB_API_PASSPHRASE: z.string().min(1).optional(),
  POLYMARKET_CLOB_FUNDER_ADDRESS: optionalEvmAddress,
  POLYMARKET_CREDENTIALS_ENCRYPTION_KEY: z.string().min(32).optional(),
  POLYMARKET_PUSD_VAULT_ADDRESS: optionalEvmAddress,
  POLYMARKET_EXECUTION_ADAPTER_ADDRESS: optionalEvmAddress,
  POLYMARKET_EXECUTION_SIGNER_PRIVATE_KEY: optionalPrivateKey,
  POLYMARKET_EXECUTION_KEY_ENCRYPTION_KEY: z.string().min(32).optional(),
  POLYMARKET_PUSD_ADDRESS: optionalEvmAddress,
  POLYMARKET_CTF_ADDRESS: optionalEvmAddress,
  POLYMARKET_EXCHANGE_V2_ADDRESS: optionalEvmAddress,
  POLYMARKET_NEG_RISK_EXCHANGE_V2_ADDRESS: optionalEvmAddress,
  POLYMARKET_NEG_RISK_ADAPTER_ADDRESS: optionalEvmAddress,
  POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS: optionalEvmAddress,
  POLYMARKET_GOVERNANCE_ADDRESS: optionalEvmAddress,
  POLYMARKET_GUARDIAN_ADDRESS: optionalEvmAddress,
  POLYMARKET_RISK_MANAGER_ADDRESS: optionalEvmAddress,
  POLYMARKET_LIFECYCLE_ENABLED: optionalBoolean.default(false),
  POLYMARKET_ACTIVE_REPAY_ENABLED: optionalBoolean.default(false),
  POLYMARKET_CANARY_PASSED: optionalBoolean.default(false),
  POLYMARKET_CANARY_MAX_ASSETS: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/)
    .default("5"),
  POLYMARKET_CANARY_ALLOWED_WALLETS: z.string().trim().optional(),
  POLYMARKET_CANARY_CONDITION_IDS: z.string().trim().optional(),
  POLYMARKET_RELEASE_MAX_LEVERAGE_BPS: z.coerce
    .number()
    .int()
    .min(10_001)
    .max(30_000)
    .default(20_000),
  POLYMARKET_RELEASE_MAX_POSITION_ASSETS: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/)
    .default("25"),
  POLYMARKET_RELEASE_MAX_TVL_ASSETS: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/)
    .default("1000"),
  POLYMARKET_RELEASE_MAX_UTILIZATION_BPS: z.coerce.number().int().min(1).max(9_000).default(5_000),
  POLYMARKET_RELEASE_DAILY_LOSS_LIMIT_ASSETS: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/)
    .default("25"),
  POLYMARKET_DIRECT_LIQUIDATION_MAX_ASSETS: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/)
    .default("250"),
  POLYMARKET_MIN_RESERVE_BPS: z.coerce.number().int().min(0).max(10_000).default(1_000),
  POLYMARKET_BUILDER_TAKER_FEE_BPS: z.coerce.number().int().min(0).max(100).default(0),
  POLYMARKET_RELAYER_API_URL: z.string().url().default("https://relayer-v2.polymarket.com"),
  POLYMARKET_RELAYER_API_KEY: z.string().min(1).optional(),
  POLYMARKET_RELAYER_API_KEY_ADDRESS: optionalEvmAddress,
  POLYMARKET_BUILDER_CODE: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .optional(),
  POLYMARKET_BUILDER_API_KEY: z.string().min(1).optional(),
  POLYMARKET_BUILDER_API_SECRET: z.string().min(1).optional(),
  POLYMARKET_BUILDER_API_PASSPHRASE: z.string().min(1).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(8).optional(),
  TELEGRAM_SUPPORT_CHAT_ID: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  CORE_PUBLIC_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(8).optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_SUPPORT_MODEL: z.string().min(1).default("gpt-5.5"),
  OPENAI_MODEL: z.string().min(1).optional(),
  OMNISTON_ENABLED: optionalBoolean.default(true),
  OMNISTON_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  OMNISTON_ROUTING_MODE: z.enum(["disabled", "quote_only", "swap_intent"]).default("quote_only"),
  OMNISTON_API_URL: z.string().url().optional(),
  OMNISTON_QUOTE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.flatten().fieldErrors;

  throw new Error(`Invalid environment configuration: ${JSON.stringify(details)}`);
}

export const env = {
  environment: parsedEnv.data.NODE_ENV,
  host: parsedEnv.data.HOST,
  port: parsedEnv.data.PORT,
  logLevel: parsedEnv.data.LOG_LEVEL,
  databaseUrl: parsedEnv.data.DATABASE_URL,
  polymarketGammaApiUrl: parsedEnv.data.POLYMARKET_GAMMA_API_URL,
  polymarketDataApiUrl: parsedEnv.data.POLYMARKET_DATA_API_URL,
  polymarketMarketsSyncLimit: parsedEnv.data.POLYMARKET_MARKETS_SYNC_LIMIT,
  marketSyncToken: parsedEnv.data.MARKET_SYNC_TOKEN ?? null,
  cronSecret: parsedEnv.data.CRON_SECRET ?? null,
  adminDashboardToken: parsedEnv.data.ADMIN_DASHBOARD_TOKEN ?? null,
  convictionVaultAddress: parsedEnv.data.CONVICTION_VAULT_ADDRESS ?? null,
  convictionExecutionAdapterAddress: parsedEnv.data.CONVICTION_EXECUTION_ADAPTER_ADDRESS ?? null,
  convictionExecutionMode: parsedEnv.data.CONVICTION_EXECUTION_MODE,
  convictionExecutionSignerPrivateKey:
    parsedEnv.data.CONVICTION_EXECUTION_SIGNER_PRIVATE_KEY ?? null,
  baseSepoliaRpcUrl: parsedEnv.data.BASE_SEPOLIA_RPC_URL,
  ethereumSepoliaRpcUrl: parsedEnv.data.ETHEREUM_SEPOLIA_RPC_URL,
  arbitrumSepoliaRpcUrl: parsedEnv.data.ARBITRUM_SEPOLIA_RPC_URL,
  baseRpcUrl: parsedEnv.data.BASE_RPC_URL,
  polygonRpcUrl: parsedEnv.data.POLYGON_RPC_URL,
  polymarketClobApiUrl: parsedEnv.data.POLYMARKET_CLOB_API_URL,
  polymarketClobApiKey: parsedEnv.data.POLYMARKET_CLOB_API_KEY ?? null,
  polymarketClobApiSecret: parsedEnv.data.POLYMARKET_CLOB_API_SECRET ?? null,
  polymarketClobApiPassphrase: parsedEnv.data.POLYMARKET_CLOB_API_PASSPHRASE ?? null,
  polymarketClobFunderAddress: parsedEnv.data.POLYMARKET_CLOB_FUNDER_ADDRESS ?? null,
  polymarketCredentialsEncryptionKey: parsedEnv.data.POLYMARKET_CREDENTIALS_ENCRYPTION_KEY ?? null,
  polymarketPusdVaultAddress: parsedEnv.data.POLYMARKET_PUSD_VAULT_ADDRESS ?? null,
  polymarketExecutionAdapterAddress: parsedEnv.data.POLYMARKET_EXECUTION_ADAPTER_ADDRESS ?? null,
  polymarketExecutionSignerPrivateKey:
    parsedEnv.data.POLYMARKET_EXECUTION_SIGNER_PRIVATE_KEY ?? null,
  polymarketExecutionKeyEncryptionKey:
    parsedEnv.data.POLYMARKET_EXECUTION_KEY_ENCRYPTION_KEY ?? null,
  polymarketPusdAddress: parsedEnv.data.POLYMARKET_PUSD_ADDRESS ?? null,
  polymarketCtfAddress: parsedEnv.data.POLYMARKET_CTF_ADDRESS ?? null,
  polymarketExchangeV2Address: parsedEnv.data.POLYMARKET_EXCHANGE_V2_ADDRESS ?? null,
  polymarketNegRiskExchangeV2Address:
    parsedEnv.data.POLYMARKET_NEG_RISK_EXCHANGE_V2_ADDRESS ?? null,
  polymarketNegRiskAdapterAddress: parsedEnv.data.POLYMARKET_NEG_RISK_ADAPTER_ADDRESS ?? null,
  polymarketDepositWalletFactoryAddress:
    parsedEnv.data.POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS ?? null,
  polymarketGovernanceAddress: parsedEnv.data.POLYMARKET_GOVERNANCE_ADDRESS ?? null,
  polymarketGuardianAddress: parsedEnv.data.POLYMARKET_GUARDIAN_ADDRESS ?? null,
  polymarketRiskManagerAddress: parsedEnv.data.POLYMARKET_RISK_MANAGER_ADDRESS ?? null,
  polymarketLifecycleEnabled: parsedEnv.data.POLYMARKET_LIFECYCLE_ENABLED,
  polymarketActiveRepayEnabled: parsedEnv.data.POLYMARKET_ACTIVE_REPAY_ENABLED,
  polymarketCanaryPassed: parsedEnv.data.POLYMARKET_CANARY_PASSED,
  polymarketCanaryMaxAssets: parsedEnv.data.POLYMARKET_CANARY_MAX_ASSETS,
  polymarketCanaryAllowedWallets: parsedEnv.data.POLYMARKET_CANARY_ALLOWED_WALLETS ?? null,
  polymarketCanaryConditionIds: parsedEnv.data.POLYMARKET_CANARY_CONDITION_IDS ?? null,
  polymarketReleaseMaxLeverageBps: parsedEnv.data.POLYMARKET_RELEASE_MAX_LEVERAGE_BPS,
  polymarketReleaseMaxPositionAssets: parsedEnv.data.POLYMARKET_RELEASE_MAX_POSITION_ASSETS,
  polymarketReleaseMaxTvlAssets: parsedEnv.data.POLYMARKET_RELEASE_MAX_TVL_ASSETS,
  polymarketReleaseMaxUtilizationBps: parsedEnv.data.POLYMARKET_RELEASE_MAX_UTILIZATION_BPS,
  polymarketReleaseDailyLossLimitAssets: parsedEnv.data.POLYMARKET_RELEASE_DAILY_LOSS_LIMIT_ASSETS,
  polymarketDirectLiquidationMaxAssets: parsedEnv.data.POLYMARKET_DIRECT_LIQUIDATION_MAX_ASSETS,
  polymarketMinReserveBps: parsedEnv.data.POLYMARKET_MIN_RESERVE_BPS,
  polymarketBuilderTakerFeeBps: parsedEnv.data.POLYMARKET_BUILDER_TAKER_FEE_BPS,
  polymarketRelayerApiUrl: parsedEnv.data.POLYMARKET_RELAYER_API_URL,
  polymarketRelayerApiKey: parsedEnv.data.POLYMARKET_RELAYER_API_KEY ?? null,
  polymarketRelayerApiKeyAddress: parsedEnv.data.POLYMARKET_RELAYER_API_KEY_ADDRESS ?? null,
  polymarketBuilderCode: parsedEnv.data.POLYMARKET_BUILDER_CODE ?? null,
  polymarketBuilderApiKey: parsedEnv.data.POLYMARKET_BUILDER_API_KEY ?? null,
  polymarketBuilderApiSecret: parsedEnv.data.POLYMARKET_BUILDER_API_SECRET ?? null,
  polymarketBuilderApiPassphrase: parsedEnv.data.POLYMARKET_BUILDER_API_PASSPHRASE ?? null,
  telegramBotToken: parsedEnv.data.TELEGRAM_BOT_TOKEN ?? null,
  telegramSupportChatId: parsedEnv.data.TELEGRAM_SUPPORT_CHAT_ID ?? null,
  telegramWebhookSecret: parsedEnv.data.TELEGRAM_WEBHOOK_SECRET ?? null,
  corePublicUrl: parsedEnv.data.CORE_PUBLIC_URL ?? null,
  openAiApiKey: parsedEnv.data.OPENAI_API_KEY ?? null,
  openAiBaseUrl: parsedEnv.data.OPENAI_BASE_URL,
  openAiSupportModel:
    parsedEnv.data.OPENAI_SUPPORT_MODEL ?? parsedEnv.data.OPENAI_MODEL ?? "gpt-5.5",
  omniston: {
    enabled: parsedEnv.data.OMNISTON_ENABLED,
    network: parsedEnv.data.OMNISTON_NETWORK,
    routingMode: parsedEnv.data.OMNISTON_ROUTING_MODE,
    apiUrl:
      parsedEnv.data.OMNISTON_API_URL ??
      (parsedEnv.data.OMNISTON_NETWORK === "testnet"
        ? "wss://omni-ws-sandbox.ston.fi"
        : "wss://omni-ws.ston.fi"),
    quoteTimeoutMs: parsedEnv.data.OMNISTON_QUOTE_TIMEOUT_MS,
  },
};
