/**
 * Yield Calculator
 *
 * Tracks premium yield for equity options vaults.
 * Computes APY, cumulative earnings, and buy-and-hold comparison.
 */

import {
  estimateApy,
  calculateVsBuyAndHold,
  type OptionQuote,
} from "./options-pricing.js";
import { type TokenizedStock } from "../config/tokenized-stocks.js";

// ---------------------------------------------------------------
//  Types
// ---------------------------------------------------------------

export type YieldEpoch = {
  epochNumber: number;
  stock: TokenizedStock;
  strategyName: string;
  premiumEarned: number; // USD
  underlyingDeposited: number; // amount of tokens
  underlyingValueUsd: number; // USD value at deposit
  strikePrice: number;
  expirySeconds: number;
  settledAt: number; // unix timestamp
  isITM: boolean;
  finalPrice: number | null;
};

export type YieldSummary = {
  stock: TokenizedStock;
  totalPremiumEarned: number; // USD
  totalEpochs: number;
  currentApy: number; // %
  averagePremiumPerEpoch: number; // USD
  averageEpochDuration: number; // seconds
  winRate: number; // % of OTM settlements
  holdReturnPct: number;
  yieldReturnPct: number;
  totalReturnPct: number;
  outperformancePct: number;
  epochs: YieldEpoch[];
};

export type VaultYieldSnapshot = {
  timestamp: number;
  totalPremiumAllVaults: number;
  averageApy: number;
  vaults: YieldSummary[];
};

// ---------------------------------------------------------------
//  In-memory yield store (replace with DB in production)
// ---------------------------------------------------------------

const yieldHistory = new Map<string, YieldEpoch[]>(); // key: `${chainId}:${vaultAddress}:${tokenSymbol}`
const depositSnapshots = new Map<string, { valueUsd: number; amount: number }>(); // initial deposit

export function recordEpoch(vaultKey: string, epoch: YieldEpoch): void {
  const key = `${vaultKey}:${epoch.stock.symbol}`;
  const existing = yieldHistory.get(key) ?? [];
  existing.push(epoch);
  yieldHistory.set(key, existing);
}

export function setInitialDeposit(vaultKey: string, stockSymbol: string, valueUsd: number, amount: number): void {
  const key = `${vaultKey}:${stockSymbol}`;
  depositSnapshots.set(key, { valueUsd, amount });
}

export function getInitialDeposit(vaultKey: string, stockSymbol: string): { valueUsd: number; amount: number } | null {
  return depositSnapshots.get(`${vaultKey}:${stockSymbol}`) ?? null;
}

// ---------------------------------------------------------------
//  Yield Calculation
// ---------------------------------------------------------------

/**
 * Calculate yield summary for a specific stock in a vault.
 */
export function calculateYieldSummary(
  vaultKey: string,
  stock: TokenizedStock,
  currentPrice: number
): YieldSummary {
  const key = `${vaultKey}:${stock.symbol}`;
  const epochs = yieldHistory.get(key) ?? [];
  const deposit = depositSnapshots.get(key);

  const totalPremiumEarned = epochs.reduce((sum, e) => sum + e.premiumEarned, 0);
  const totalEpochs = epochs.length;

  // Average premium per epoch
  const averagePremiumPerEpoch = totalEpochs > 0 ? totalPremiumEarned / totalEpochs : 0;

  // Average epoch duration
  const averageEpochDuration =
    totalEpochs > 1
      ? epochs.reduce((sum, e) => sum + e.expirySeconds, 0) / totalEpochs
      : totalEpochs === 1
        ? epochs[0].expirySeconds
        : 30 * 24 * 60 * 60; // default 30 days

  // Current APY (based on most recent epoch)
  const latestEpoch = epochs[epochs.length - 1];
  const currentApy =
    latestEpoch && latestEpoch.underlyingValueUsd > 0
      ? estimateApy(
          latestEpoch.premiumEarned,
          latestEpoch.underlyingValueUsd,
          latestEpoch.expirySeconds
        )
      : 0;

  // Win rate (OTM settlements = premium kept)
  const settledEpochs = epochs.filter((e) => e.finalPrice !== null);
  const otmCount = settledEpochs.filter((e) => !e.isITM).length;
  const winRate = settledEpochs.length > 0 ? (otmCount / settledEpochs.length) * 100 : 0;

  // Buy and hold comparison
  const initialValue = deposit?.valueUsd ?? (epochs[0]?.underlyingValueUsd ?? 0);
  const currentUnderlyingValue = currentPrice * (deposit?.amount ?? 0);
  const { holdReturnPct, yieldReturnPct, totalReturnPct, outperformancePct } =
    calculateVsBuyAndHold(totalPremiumEarned, initialValue, currentUnderlyingValue);

  return {
    stock,
    totalPremiumEarned,
    totalEpochs,
    currentApy: Math.round(currentApy * 100) / 100,
    averagePremiumPerEpoch: Math.round(averagePremiumPerEpoch * 100) / 100,
    averageEpochDuration,
    winRate: Math.round(winRate * 10) / 10,
    holdReturnPct,
    yieldReturnPct,
    totalReturnPct,
    outperformancePct,
    epochs,
  };
}

/**
 * Calculate aggregate yield across all vaults.
 */
export function calculateAggregateYield(
  vaultKey: string,
  stocks: TokenizedStock[],
  currentPrices: Map<string, number>
): VaultYieldSnapshot {
  const summaries = stocks.map((stock) => {
    const price = currentPrices.get(stock.symbol) ?? 0;
    return calculateYieldSummary(vaultKey, stock, price);
  });

  const totalPremiumAllVaults = summaries.reduce((sum, s) => sum + s.totalPremiumEarned, 0);
  const apyValues = summaries.filter((s) => s.currentApy > 0).map((s) => s.currentApy);
  const averageApy = apyValues.length > 0
    ? apyValues.reduce((sum, a) => sum + a, 0) / apyValues.length
    : 0;

  return {
    timestamp: Math.floor(Date.now() / 1000),
    totalPremiumAllVaults,
    averageApy: Math.round(averageApy * 100) / 100,
    vaults: summaries,
  };
}

/**
 * Get the next epoch yield estimate for a given option quote.
 */
export function estimateNextEpochYield(
  quote: OptionQuote,
  collateralAmount: number,
  underlyingValueUsd: number
): {
  estimatedPremium: number;
  estimatedApy: number;
  winProbability: number;
} {
  const estimatedPremium = quote.premium * collateralAmount;
  const estimatedApy =
    underlyingValueUsd > 0
      ? estimateApy(estimatedPremium, underlyingValueUsd, 14 * 24 * 60 * 60) // assume 14-day epoch
      : 0;

  return {
    estimatedPremium: Math.round(estimatedPremium * 100) / 100,
    estimatedApy: Math.round(estimatedApy * 100) / 100,
    winProbability: 0.85, // default; replaced by strategy engine in production
  };
}
