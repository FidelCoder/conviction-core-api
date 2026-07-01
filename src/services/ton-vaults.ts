import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

export type CreateTonVaultIntentInput = {
  userId?: string | null;
  telegramUserId?: string | null;
  tonAddress: string;
  asset: string;
  amount: string;
  note?: string | null;
};

const supportedAssets = new Set(["TON", "USDT", "STON"]);
const positiveDecimalPattern = /^(?=.*[1-9])(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;
const tonAddressPattern = /^(?:EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46,}$/;

export async function createTonVaultIntent(input: CreateTonVaultIntentInput) {
  const tonAddress = input.tonAddress.trim();
  const asset = input.asset.trim().toUpperCase();
  const amount = input.amount.trim();

  if (!tonAddressPattern.test(tonAddress)) {
    throw new AppError("A valid TON wallet address is required.", {
      code: "INVALID_TON_ADDRESS",
      statusCode: 422,
    });
  }

  if (!supportedAssets.has(asset)) {
    throw new AppError("Asset must be TON, USDT, or STON.", {
      code: "INVALID_TON_VAULT_ASSET",
      statusCode: 422,
    });
  }

  if (!positiveDecimalPattern.test(amount)) {
    throw new AppError("Amount must be greater than zero with up to 9 decimals.", {
      code: "INVALID_TON_VAULT_AMOUNT",
      statusCode: 422,
    });
  }

  if (input.userId) {
    const user = await prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) {
      throw new AppError("User not found.", {
        code: "USER_NOT_FOUND",
        statusCode: 404,
      });
    }
  }

  const intent = await prisma.tonVaultIntent.create({
    data: {
      userId: input.userId ?? null,
      telegramUserId: normalizeNullable(input.telegramUserId),
      tonAddress,
      asset,
      amount,
      note: normalizeNullable(input.note),
      status: "REQUESTED",
    },
  });

  return normalizeTonVaultIntent(intent);
}

export async function listTonVaultIntents(input: { userId?: string | null; tonAddress?: string | null; limit?: number } = {}) {
  const intents = await prisma.tonVaultIntent.findMany({
    where: {
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.tonAddress ? { tonAddress: input.tonAddress } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(input.limit ?? 25, 100)),
  });

  return intents.map(normalizeTonVaultIntent);
}

export async function getTonVaultSummary() {
  const [total, recent, byAsset] = await Promise.all([
    prisma.tonVaultIntent.count(),
    prisma.tonVaultIntent.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.tonVaultIntent.groupBy({
      by: ["asset"],
      _count: { _all: true },
      where: { status: { in: ["REQUESTED", "ACKNOWLEDGED"] } },
    }),
  ]);

  return {
    total,
    byAsset: byAsset.map((item) => ({ asset: item.asset, count: item._count._all })),
    recent: recent.map(normalizeTonVaultIntent),
    custody: {
      status: "contract_pending",
      message:
        "TON vault intents are recorded in Conviction today. Actual TON custody requires the TON vault contract address before funds can be transferred on-chain.",
    },
  };
}

type TonVaultIntentRecord = Awaited<ReturnType<typeof prisma.tonVaultIntent.findFirst>>;

function normalizeTonVaultIntent(intent: NonNullable<TonVaultIntentRecord>) {
  return {
    id: intent.id,
    userId: intent.userId,
    telegramUserId: intent.telegramUserId,
    tonAddress: intent.tonAddress,
    asset: intent.asset,
    amount: intent.amount,
    status: intent.status,
    note: intent.note,
    createdAt: intent.createdAt.toISOString(),
    updatedAt: intent.updatedAt.toISOString(),
  };
}

function normalizeNullable(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}
