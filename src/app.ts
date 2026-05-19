import fastify from "fastify";

import { env } from "./config/index.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMarketRoutes } from "./routes/markets.js";

export async function buildApp() {
  const app = fastify({
    logger: {
      level: env.logLevel,
    },
  });

  registerErrorHandler(app);
  await registerHealthRoutes(app);
  await registerMarketRoutes(app);

  return app;
}
