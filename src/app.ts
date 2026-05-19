import fastify from "fastify";

import { env } from "./config/index.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMarketRoutes } from "./routes/markets.js";
import { registerPositionRoutes } from "./routes/positions.js";
import { registerSignalRoutes } from "./routes/signals.js";

export async function buildApp() {
  const app = fastify({
    logger: {
      level: env.logLevel,
    },
  });

  registerErrorHandler(app);
  await registerHealthRoutes(app);
  await registerMarketRoutes(app);
  await registerSignalRoutes(app);
  await registerPositionRoutes(app);

  return app;
}
