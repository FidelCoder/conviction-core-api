import { prisma } from "../lib/prisma.js";
import { reconcilePendingPolymarketExecutions } from "../services/polymarket-execution-orchestrator.js";

const requestedLimit = Number(process.argv[2] ?? "10");
const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 10;

try {
  const result = await reconcilePendingPolymarketExecutions(limit);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
