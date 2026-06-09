import fastify from "fastify";

import { env } from "./config/index.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerContractRoutes } from "./routes/contracts.js";
import { registerExecutionRoutes } from "./routes/execution.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMarketRoutes } from "./routes/markets.js";
import { registerPositionRoutes } from "./routes/positions.js";
import { registerSignalRoutes } from "./routes/signals.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerUserRoutes } from "./routes/users.js";
import { ensureDefaultContractDeployments } from "./services/contracts.js";

export async function buildApp() {
  const app = fastify({
    logger: {
      level: env.logLevel,
    },
  });

  registerErrorHandler(app);
  await ensureDefaultContractDeployments().catch((error: unknown) => {
    app.log.warn({ error }, "Default contract deployments were not synced");
  });
  await registerHealthRoutes(app);
  await registerExecutionRoutes(app);
  await registerContractRoutes(app);
  await registerUserRoutes(app);
  await registerMarketRoutes(app);
  await registerSignalRoutes(app);
  await registerPositionRoutes(app);
  await registerStatsRoutes(app);

  return app;
}
