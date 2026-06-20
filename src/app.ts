import fastify from "fastify";

import { env } from "./config/index.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerActivityMediaRoutes } from "./routes/activity-media.js";
import { registerContractRoutes } from "./routes/contracts.js";
import { registerExecutionRoutes } from "./routes/execution.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMarketRoutes } from "./routes/markets.js";
import { registerOperationsRoutes } from "./routes/operations.js";
import { registerPositionRoutes } from "./routes/positions.js";
import { registerPreferenceRoutes } from "./routes/preferences.js";
import { registerSignalRoutes } from "./routes/signals.js";
import { registerSocialRoutes } from "./routes/social.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerSupportRoutes } from "./routes/support.js";
import { registerUserRoutes } from "./routes/users.js";
import { ensureDefaultContractDeployments } from "./services/contracts.js";

export async function buildApp() {
  const app = fastify({
    logger: {
      level: env.logLevel,
    },
  });

  registerErrorHandler(app);
  void syncDefaultContractDeployments(app);
  await registerHealthRoutes(app);
  await registerExecutionRoutes(app);
  await registerContractRoutes(app);
  await registerUserRoutes(app);
  await registerPreferenceRoutes(app);
  await registerMarketRoutes(app);
  await registerOperationsRoutes(app);
  await registerSignalRoutes(app);
  await registerSocialRoutes(app);
  await registerActivityMediaRoutes(app);
  await registerSupportRoutes(app);
  await registerPositionRoutes(app);
  await registerStatsRoutes(app);

  return app;
}

async function syncDefaultContractDeployments(app: ReturnType<typeof fastify>) {
  try {
    await withTimeout(ensureDefaultContractDeployments(), 8_000);
  } catch (error: unknown) {
    app.log.warn({ error }, "Default contract deployments were not synced");
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Operation timed out after " + timeoutMs + "ms"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
