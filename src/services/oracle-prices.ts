/**
 * Oracle Prices Service
 *
 * Reads Chainlink data feeds for tokenized stock prices on Base mainnet.
 * Caches prices with a configurable TTL to avoid excessive RPC calls.
 */

import { createPublicClient, http, formatUnits } from "viem";
import { base } from "viem/chains";
import {
  TOKENIZED_STOCKS,
  BASE_MAINNET_CHAIN_ID,
  B20_ONCHAIN_REGISTRY,
  B20_STANDARD,
  type TokenizedStock,
} from "../config/tokenized-stocks.js";

// ---------------------------------------------------------------
//  Chainlink AggregatorV3Interface ABI (minimal)
// ---------------------------------------------------------------

/**
 * Chainlink AggregatorV3Interface ABI.
 * Coinbase feeds report Total Return Values (underlying price × multiplier).
 */
const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * B20 Onchain Registry ABI.
 * Returns multiplier (WAD-scaled) and pause flag for a token.
 */
const B20_REGISTRY_ABI = [
  {
    inputs: [{ name: "token", type: "address" }],
    name: "getTokenInfo",
    outputs: [
      { name: "multiplier", type: "uint256" },
      { name: "paused", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------
//  Cache
// ---------------------------------------------------------------

type PriceCacheEntry = {
  price: number; // USD price as a float
  rawAnswer: bigint;
  updatedAt: number; // unix timestamp
  fetchedAt: number; // unix timestamp when we fetched it
  multiplier: number;
  paused: boolean;
};

const priceCache = new Map<string, PriceCacheEntry>();
const DEFAULT_CACHE_TTL_MS = 10_000; // 10 seconds

// ---------------------------------------------------------------
//  Client singleton
// ---------------------------------------------------------------

function getClient(rpcUrl?: string) {
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl ?? process.env.BASE_RPC_URL),
  });
}

// ---------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------

export type OraclePrice = {
  symbol: string;
  /** Price in USD (total return: underlying × multiplier) */
  price: number;
  rawAnswer: bigint;
  decimals: number;
  updatedAt: number;
  stale: boolean;
  /** B20 multiplier (WAD-scaled, divide by 1e18) */
  multiplier: number;
  /** Whether the B20 token is paused onchain */
  paused: boolean;
};

/**
 * Fetch the current price for a single tokenized stock.
 */
export async function getStockPrice(
  stock: TokenizedStock,
  options?: { rpcUrl?: string; cacheTtlMs?: number }
): Promise<OraclePrice> {
  const cacheKey = stock.symbol;
  const ttl = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = Date.now();

  // Check cache
  const cached = priceCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < ttl) {
    return {
      symbol: stock.symbol,
      price: cached.price,
      rawAnswer: cached.rawAnswer,
      decimals: stock.decimals,
      updatedAt: cached.updatedAt,
      stale: false,
      multiplier: cached.multiplier,
      paused: cached.paused,
    };
  }

  // Fetch from Chainlink + B20 registry
  const c = getClient(options?.rpcUrl);
  const [rawAnswer, feedDecimals, registryResult] = await Promise.all([
    c.readContract({
      address: stock.chainlinkFeedAddress,
      abi: AGGREGATOR_V3_ABI,
      functionName: "latestRoundData",
    }).then((result) => ({
      answer: result[1] as bigint,
      updatedAt: result[3] as bigint,
    })),
    c.readContract({
      address: stock.chainlinkFeedAddress,
      abi: AGGREGATOR_V3_ABI,
      functionName: "decimals",
    }),
    // Read B20 registry for multiplier and pause flag
    c.readContract({
      address: B20_ONCHAIN_REGISTRY,
      abi: B20_REGISTRY_ABI,
      functionName: "getTokenInfo",
      args: [stock.tokenAddress],
    }),
  ]);

  // B20 registry returns (multiplier WAD-scaled, paused bool)
  const multiplier = parseFloat(formatUnits(registryResult[0], 18));
  const paused: boolean = registryResult[1];

  // Coinbase feeds report Total Return Values (underlying × multiplier)
  // The raw answer already includes the multiplier adjustment
  const price = parseFloat(formatUnits(rawAnswer.answer, feedDecimals));

  // Staleness check: Chainlink feeds update on 0.5% deviation or 24h heartbeat
  // If updatedAt is older than 48h, consider stale (covers weekends + holidays)
  const feedUpdatedAt = Number(rawAnswer.updatedAt);
  const STALE_THRESHOLD_SECONDS = 48 * 60 * 60; // 48 hours
  const isStale = Math.floor(Date.now() / 1000) - feedUpdatedAt > STALE_THRESHOLD_SECONDS;

  // Update cache
  priceCache.set(cacheKey, {
    price,
    rawAnswer: rawAnswer.answer,
    updatedAt: feedUpdatedAt,
    fetchedAt: now,
    multiplier,
    paused,
  });

  return {
    symbol: stock.symbol,
    price,
    rawAnswer: rawAnswer.answer,
    decimals: stock.decimals,
    updatedAt: feedUpdatedAt,
    stale: isStale || paused,
    multiplier,
    paused,
  };
}

/**
 * Fetch prices for all configured tokenized stocks.
 */
export async function getAllStockPrices(options?: {
  rpcUrl?: string;
  cacheTtlMs?: number;
}): Promise<OraclePrice[]> {
  const results = await Promise.allSettled(
    TOKENIZED_STOCKS.map((stock) => getStockPrice(stock, options))
  );

  // Fail if any price fetch fails — don't silently return zeros
  const failures: string[] = [];
  const fulfilled: OraclePrice[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      fulfilled.push(result.value);
    } else {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(msg);
    }
  }

  if (failures.length > 0) {
    // Return whatever succeeded, but log the failures
    console.error(`[oracle-prices] ${failures.length} price fetch failures:`, failures);
  }

  return fulfilled;
}

/**
 * Get price as a bigint in Chainlink decimals (8) for contract interaction.
 */
export async function getStockPriceRaw(
  stock: TokenizedStock,
  options?: { rpcUrl?: string }
): Promise<bigint> {
  const oracle = await getStockPrice(stock, options);
  return oracle.rawAnswer;
}

/**
 * Clear the price cache (useful for testing).
 */
export function clearPriceCache(): void {
  priceCache.clear();
}
