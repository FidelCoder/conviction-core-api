import { env } from "../config/index.js";
import { prisma } from "../lib/prisma.js";
import { PolymarketProvider } from "../providers/polymarket/index.js";
import { syncMarketsFromProvider } from "../services/markets.js";

async function main() {
  const limit = getLimitArg() ?? env.polymarketMarketsSyncLimit;
  const provider = new PolymarketProvider({
    gammaApiUrl: env.polymarketGammaApiUrl,
    listLimit: limit,
  });
  const result = await syncMarketsFromProvider(provider);

  console.log(
    JSON.stringify(
      {
        ok: true,
        source: result.source,
        requested: result.requested,
        retired: result.retired,
        synced: result.synced,
        marketIds: result.marketIds,
      },
      null,
      2,
    ),
  );
}

function getLimitArg() {
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));

  if (!limitArg) {
    return null;
  }

  const limit = Number(limitArg.slice("--limit=".length));

  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("--limit must be an integer between 1 and 500");
  }

  return limit;
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown Polymarket sync error";

    console.error(
      JSON.stringify(
        {
          ok: false,
          error: {
            code: "POLYMARKET_SYNC_FAILED",
            message,
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
