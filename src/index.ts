import { env } from "./config/index.js";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";

async function start() {
  const app = await buildApp();

  const shutdown = async () => {
    await app.close();
    await prisma.$disconnect();
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await app.listen({ host: env.host, port: env.port });
}

void start();
