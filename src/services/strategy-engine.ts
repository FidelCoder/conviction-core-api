/**
 * Strategy Engine
 *
 * Orchestrates covered call writing for tokenized stocks.
 * Selects strike based on strategy preset, calculates premium,
 * and produces option parameters for the vault contract.
 */

import {
  STRATEGY_PRESETS,
  type StrategyPreset,
  type TokenizedStock,
} from "../config/tokenized-stocks.js";
import {
  calculateCallPremium,
  proposeStrikes,
  estimateApy,
  type OptionQuote,
  type StrikeProposal,
} from "./options-pricing.js";
import { getStockPrice, type OraclePrice } from "./oracle-prices.js";

// ---------------------------------------------------------------
//  Types
// ---------------------------------------------------------------

export type OptionParams = {
  stock: TokenizedStock;
  strategy: StrategyPreset;
  currentPrice: number;
  strike: number;
  strikeLabel: string;
  expirySeconds: number;
  expiryTimestamp: number;
  premium: number; // USD
  premiumPct: number; // % of underlying
  delta: number;
  theta: number;
  impliedVol: number;
  estimatedApy: number; // annualized %
  collateralAmount: string; // amount of underlying to lock (string for contract)
  collateralValueUsd: number;
};

export type SettlementParams = {
  optionId: number;
  stock: TokenizedStock;
  finalPrice: number;
  strike: number;
  isITM: boolean;
  settlementAmount: string; // underlying to sell if ITM
  payoutUsd: number; // premium + strike proceeds if ITM
};

// ---------------------------------------------------------------
//  Core Functions
// ---------------------------------------------------------------

/**
 * Generate option parameters for writing a covered call.
 *
 * @param stock - The tokenized stock to write against
 * @param strategyName - Strategy preset name (CONSERVATIVE, MODERATE, AGGRESSIVE)
 * @param collateralAmount - Amount of underlying to lock (as a number, in token units)
 */
export async function generateOptionParams(
  stock: TokenizedStock,
  strategyName: string,
  collateralAmount: number,
  options?: { rpcUrl?: string }
): Promise<OptionParams> {
  const strategy = STRATEGY_PRESETS[strategyName.toUpperCase()];
  if (!strategy) {
    throw new Error(`Unknown strategy: ${strategyName}`);
  }

  // Get current price from oracle
  const oraclePrice = await getStockPrice(stock, options);
  if (oraclePrice.stale || oraclePrice.price <= 0) {
    throw new Error(`Price unavailable for ${stock.symbol}`);
  }

  const currentPrice = oraclePrice.price;
  const impliedVol = strategy.defaultVolBps / 10_000;

  // Propose strike based on strategy
  const proposal = proposeStrikes(
    currentPrice,
    strategy.strikeDeltaBps,
    strategy.expirySeconds,
    impliedVol,
    strategy.defaultVolBps
  );

  // Calculate premium per unit
  const premiumPerUnit = proposal.quote.premium;

  // Total premium = premium per unit * collateral amount
  const totalPremium = premiumPerUnit * collateralAmount;

  // Estimate APY
  const collateralValueUsd = currentPrice * collateralAmount;
  const estimatedApy = estimateApy(totalPremium, collateralValueUsd, strategy.expirySeconds);

  // Expiry timestamp
  const expiryTimestamp = Math.floor(Date.now() / 1000) + strategy.expirySeconds;

  return {
    stock,
    strategy,
    currentPrice,
    strike: proposal.strike,
    strikeLabel: proposal.label,
    expirySeconds: strategy.expirySeconds,
    expiryTimestamp,
    premium: totalPremium,
    premiumPct: proposal.quote.premiumPct,
    delta: proposal.quote.delta,
    theta: proposal.quote.theta,
    impliedVol,
    estimatedApy,
    collateralAmount: collateralAmount.toString(),
    collateralValueUsd,
  };
}

/**
 * Generate settlement parameters when an option expires.
 *
 * @param optionId - The option ID in the vault
 * @param stock - The tokenized stock
 * @param strike - Strike price of the option
 * @param premium - Premium collected (USD)
 * @param collateralLocked - Amount of underlying locked
 * @param finalPrice - Chainlink price at expiry
 */
export function generateSettlementParams(
  optionId: number,
  stock: TokenizedStock,
  strike: number,
  premium: number,
  collateralLocked: number,
  finalPrice: number
): SettlementParams {
  const isITM = finalPrice >= strike;

  if (isITM) {
    // ITM: vault sells underlying at strike price
    // Settlement amount = all locked collateral
    const settlementAmount = collateralLocked;
    const strikeProceeds = (collateralLocked * strike) / Math.pow(10, stock.decimals - stock.decimals);
    // Simplified: strikeProceeds = collateralLocked * strike / 1e8 (Chainlink decimals)
    const strikeProceedsUsd = collateralLocked * (strike / 1e8);
    const payoutUsd = premium + strikeProceedsUsd;

    return {
      optionId,
      stock,
      finalPrice,
      strike,
      isITM: true,
      settlementAmount: collateralLocked.toString(),
      payoutUsd,
    };
  } else {
    // OTM: option expires worthless, premium kept
    return {
      optionId,
      stock,
      finalPrice,
      strike,
      isITM: false,
      settlementAmount: "0",
      payoutUsd: premium,
    };
  }
}

/**
 * Batch generate option quotes for all supported stocks with a given strategy.
 */
export async function generateBatchQuotes(
  stocks: TokenizedStock[],
  strategyName: string,
  collateralAmounts: Map<string, number>,
  options?: { rpcUrl?: string }
): Promise<OptionParams[]> {
  const results: OptionParams[] = [];

  for (const stock of stocks) {
    const amount = collateralAmounts.get(stock.symbol) ?? 1;
    try {
      const params = await generateOptionParams(stock, strategyName, amount, options);
      results.push(params);
    } catch {
      // Skip stocks with unavailable prices
      continue;
    }
  }

  return results;
}

/**
 * Calculate win rate for a given strategy based on historical vol.
 * Uses the probability that the option expires OTM.
 *
 * @param currentPrice - Current underlying price
 * @param strikeDeltaBps - Strategy strike delta
 * @param expirySeconds - Time to expiry
 * @param historicalVol - Historical annualized vol
 * @returns Probability of expiring OTM (0-1)
 */
export function estimateWinRate(
  currentPrice: number,
  strikeDeltaBps: number,
  expirySeconds: number,
  historicalVol: number
): number {
  const strikeMultiplier = strikeDeltaBps / 10_000;
  const strike = currentPrice * strikeMultiplier;
  const T = expirySeconds / (365.25 * 24 * 60 * 60);
  const sigma = historicalVol;

  if (T <= 0 || sigma <= 0) return 0.5;

  // P(OTM) = P(S_T < K) = N(-d2) for a call
  const d2 = (Math.log(currentPrice / strike) + (0.05 - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));

  // Standard normal CDF approximation
  const x = -d2;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1.0 / (1.0 + p * Math.abs(x));
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  const probOTM = 0.5 * (1.0 + (x >= 0 ? 1 : -1) * y);

  return Math.round(probOTM * 1000) / 1000; // 3 decimal places
}
