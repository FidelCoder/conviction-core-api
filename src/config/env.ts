import "dotenv/config";

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url(),
  POLYMARKET_GAMMA_API_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_MARKETS_SYNC_LIMIT: z.coerce.number().int().positive().max(500).default(50),
  EXECUTION_SPOT_ENABLED: z.coerce.boolean().default(false),
  EXECUTION_MARGIN_ENABLED: z.coerce.boolean().default(false),
  EXECUTION_ACTIVE_ADAPTERS: z.string().default(""),
  EXECUTION_MARGIN_MAX_LEVERAGE: z.coerce.number().positive().max(100).default(10),
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
  executionSpotEnabled: parsedEnv.data.EXECUTION_SPOT_ENABLED,
  executionMarginEnabled: parsedEnv.data.EXECUTION_MARGIN_ENABLED,
  executionActiveAdapters: parsedEnv.data.EXECUTION_ACTIVE_ADAPTERS.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  executionMarginMaxLeverage: parsedEnv.data.EXECUTION_MARGIN_MAX_LEVERAGE,
};
