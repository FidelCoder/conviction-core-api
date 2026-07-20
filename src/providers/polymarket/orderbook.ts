import { z } from "zod";

import type { MarginOrderBookLevel } from "../../services/margin-risk.js";

const orderBookLevelSchema = z.object({
  price: z.union([z.string(), z.number()]).transform(String),
  size: z.union([z.string(), z.number()]).transform(String),
});

const orderBookSchema = z.object({
  asks: z.array(orderBookLevelSchema),
  bids: z.array(orderBookLevelSchema),
  asset_id: z.union([z.string(), z.number()]).transform(String).optional(),
  min_order_size: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
  neg_risk: z.boolean().nullable().optional(),
  tick_size: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
  timestamp: z.union([z.string(), z.number()]).nullable().optional(),
});

const historySchema = z.object({
  history: z
    .array(
      z.object({
        p: z.number(),
        t: z.number(),
      }),
    )
    .default([]),
});

export type PolymarketRiskSnapshot = {
  asks: MarginOrderBookLevel[];
  bids: MarginOrderBookLevel[];
  minimumOrderSize: string | null;
  negativeRisk: boolean | null;
  observedAtMs: number;
  tickSize: string | null;
  tokenId: string;
  twapPrice: string;
};

export class PolymarketMarketDataError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PolymarketMarketDataError";
  }
}

const clobBaseUrl = "https://clob.polymarket.com";
const requestTimeoutMs = 5_000;
const twapWindowSeconds = 15 * 60;

export async function getPolymarketRiskSnapshot(
  tokenId: string,
  nowMs = Date.now(),
): Promise<PolymarketRiskSnapshot> {
  const [orderBook, history] = await Promise.all([
    fetchOrderBook(tokenId),
    fetchRecentHistory(tokenId, nowMs),
  ]);
  const twapPrice = calculateTimeWeightedPrice(history, nowMs);

  if (twapPrice === null) {
    throw new PolymarketMarketDataError("Polymarket returned no recent price history");
  }

  return {
    asks: orderBook.asks,
    bids: orderBook.bids,
    minimumOrderSize: orderBook.min_order_size ?? null,
    negativeRisk: orderBook.neg_risk ?? null,
    observedAtMs: parseProviderTimestamp(orderBook.timestamp, nowMs),
    tickSize: orderBook.tick_size ?? null,
    tokenId,
    twapPrice,
  };
}

async function fetchOrderBook(tokenId: string) {
  const url = new URL("/book", clobBaseUrl);
  url.searchParams.set("token_id", tokenId);
  const payload = await fetchJson(url);
  const parsed = orderBookSchema.safeParse(payload);

  if (!parsed.success) {
    throw new PolymarketMarketDataError("Polymarket orderbook response was malformed", {
      cause: parsed.error,
    });
  }
  if (parsed.data.asset_id && parsed.data.asset_id !== tokenId) {
    throw new PolymarketMarketDataError("Polymarket orderbook returned a different token id");
  }

  return parsed.data;
}

async function fetchRecentHistory(tokenId: string, nowMs: number) {
  const endTs = Math.floor(nowMs / 1000);
  const url = new URL("/prices-history", clobBaseUrl);
  url.searchParams.set("market", tokenId);
  url.searchParams.set("startTs", String(endTs - twapWindowSeconds));
  url.searchParams.set("endTs", String(endTs));
  url.searchParams.set("interval", "1m");
  url.searchParams.set("fidelity", "1");

  const payload = await fetchJson(url);
  const parsed = historySchema.safeParse(payload);
  if (!parsed.success) {
    throw new PolymarketMarketDataError("Polymarket price history response was malformed", {
      cause: parsed.error,
    });
  }
  return parsed.data.history;
}

async function fetchJson(url: URL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PolymarketMarketDataError(
        `Polymarket CLOB request failed with ${response.status} ${response.statusText}`,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof PolymarketMarketDataError) throw error;
    throw new PolymarketMarketDataError("Failed to reach the Polymarket CLOB API", {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function calculateTimeWeightedPrice(
  history: Array<{ p: number; t: number }>,
  nowMs: number,
): string | null {
  const nowSeconds = Math.floor(nowMs / 1000);
  const startSeconds = nowSeconds - twapWindowSeconds;
  const points = history
    .filter(
      (point) =>
        Number.isFinite(point.p) &&
        point.p > 0 &&
        point.p < 1 &&
        Number.isFinite(point.t) &&
        point.t >= startSeconds &&
        point.t <= nowSeconds,
    )
    .sort((left, right) => left.t - right.t);

  if (points.length === 0) return null;
  if (points.length === 1) return normalizePrice(points[0]!.p);

  let weightedPrice = 0;
  let totalSeconds = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const nextTimestamp = points[index + 1]?.t ?? nowSeconds;
    const duration = Math.max(1, nextTimestamp - Math.max(point.t, startSeconds));
    weightedPrice += point.p * duration;
    totalSeconds += duration;
  }

  return normalizePrice(weightedPrice / totalSeconds);
}

function normalizePrice(price: number) {
  return price.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function parseProviderTimestamp(value: string | number | null | undefined, fallbackMs: number) {
  if (value === null || typeof value === "undefined") return fallbackMs;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}
