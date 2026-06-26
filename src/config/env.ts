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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url(),
  POLYMARKET_GAMMA_API_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_MARKETS_SYNC_LIMIT: z.coerce.number().int().positive().max(500).default(250),
  MARKET_SYNC_TOKEN: z.string().min(24).optional(),
  CRON_SECRET: z.string().min(16).optional(),
  CONVICTION_VAULT_ADDRESS: optionalEvmAddress,
  CONVICTION_EXECUTION_ADAPTER_ADDRESS: optionalEvmAddress,
  CONVICTION_EXECUTION_MODE: z.enum(["disabled", "testnet", "polymarket"]).default("disabled"),
  CONVICTION_EXECUTION_SIGNER_PRIVATE_KEY: optionalPrivateKey,
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  ETHEREUM_SEPOLIA_RPC_URL: z
    .string()
    .url()
    .default("https://ethereum-sepolia-rpc.publicnode.com"),
  ARBITRUM_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia-rollup.arbitrum.io/rpc"),
  POLYMARKET_CLOB_API_URL: z.string().url().default("https://clob.polymarket.com"),
  POLYMARKET_CLOB_API_KEY: z.string().min(1).optional(),
  POLYMARKET_CLOB_API_SECRET: z.string().min(1).optional(),
  POLYMARKET_CLOB_API_PASSPHRASE: z.string().min(1).optional(),
  POLYMARKET_CLOB_FUNDER_ADDRESS: optionalEvmAddress,
  TELEGRAM_BOT_TOKEN: z.string().min(8).optional(),
  TELEGRAM_SUPPORT_CHAT_ID: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  CORE_PUBLIC_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(8).optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_SUPPORT_MODEL: z.string().min(1).default("gpt-5.5"),
  OPENAI_MODEL: z.string().min(1).optional(),
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
  polymarketMarketsSyncLimit: parsedEnv.data.POLYMARKET_MARKETS_SYNC_LIMIT,
  marketSyncToken: parsedEnv.data.MARKET_SYNC_TOKEN ?? null,
  cronSecret: parsedEnv.data.CRON_SECRET ?? null,
  convictionVaultAddress: parsedEnv.data.CONVICTION_VAULT_ADDRESS ?? null,
  convictionExecutionAdapterAddress: parsedEnv.data.CONVICTION_EXECUTION_ADAPTER_ADDRESS ?? null,
  convictionExecutionMode: parsedEnv.data.CONVICTION_EXECUTION_MODE,
  convictionExecutionSignerPrivateKey:
    parsedEnv.data.CONVICTION_EXECUTION_SIGNER_PRIVATE_KEY ?? null,
  baseSepoliaRpcUrl: parsedEnv.data.BASE_SEPOLIA_RPC_URL,
  ethereumSepoliaRpcUrl: parsedEnv.data.ETHEREUM_SEPOLIA_RPC_URL,
  arbitrumSepoliaRpcUrl: parsedEnv.data.ARBITRUM_SEPOLIA_RPC_URL,
  polymarketClobApiUrl: parsedEnv.data.POLYMARKET_CLOB_API_URL,
  polymarketClobApiKey: parsedEnv.data.POLYMARKET_CLOB_API_KEY ?? null,
  polymarketClobApiSecret: parsedEnv.data.POLYMARKET_CLOB_API_SECRET ?? null,
  polymarketClobApiPassphrase: parsedEnv.data.POLYMARKET_CLOB_API_PASSPHRASE ?? null,
  polymarketClobFunderAddress: parsedEnv.data.POLYMARKET_CLOB_FUNDER_ADDRESS ?? null,
  telegramBotToken: parsedEnv.data.TELEGRAM_BOT_TOKEN ?? null,
  telegramSupportChatId: parsedEnv.data.TELEGRAM_SUPPORT_CHAT_ID ?? null,
  telegramWebhookSecret: parsedEnv.data.TELEGRAM_WEBHOOK_SECRET ?? null,
  corePublicUrl: parsedEnv.data.CORE_PUBLIC_URL ?? null,
  openAiApiKey: parsedEnv.data.OPENAI_API_KEY ?? null,
  openAiBaseUrl: parsedEnv.data.OPENAI_BASE_URL,
  openAiSupportModel: parsedEnv.data.OPENAI_SUPPORT_MODEL ?? parsedEnv.data.OPENAI_MODEL ?? "gpt-5.5",
};
