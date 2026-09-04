/**
 * Settlement Service
 *
 * Handles covered call option settlement at expiry.
 * Fetches final Chainlink price, determines ITM/OTM,
 * and produces settlement transactions for the vault contract.
 *
 * In production this runs as a keeper/cron job.
 * For demo: triggered via API endpoint.
 */

import { type TokenizedStock, TOKENIZED_STOCKS, BASE_MAINNET_CHAIN_ID } from "../config/tokenized-stocks.js";
import { getStockPrice, type OraclePrice } from "./oracle-prices.js";
import { generateSettlementParams, type SettlementParams } from "./strategy-engine.js";

// ---------------------------------------------------------------
//  Types
// ---------------------------------------------------------------

export type ActiveOption = {
  optionId: number;
  stock: TokenizedStock;
  strikePrice: number;
  expiry: number; // unix timestamp
  premium: number; // USD
  collateralLocked: number; // amount of underlying
  status: "ACTIVE" | "SETTLED_ITM" | "SETTLED_OTM";
};

export type SettlementResult = {
  optionId: number;
  stock: TokenizedStock;
  finalPrice: number;
  isITM: boolean;
  payoutUsd: number;
  settlementParams: SettlementParams;
  settledAt: number;
};

// ---------------------------------------------------------------
//  In-memory option store (replace with DB in production)
// ---------------------------------------------------------------

const activeOptions = new Map<string, ActiveOption[]>(); // key: `${chainId}:${vaultAddress}`

export function registerOption(
  vaultKey: string,
  option: ActiveOption
): void {
  const existing = activeOptions.get(vaultKey) ?? [];
  existing.push(option);
  activeOptions.set(vaultKey, existing);
}

export function getActiveOptions(vaultKey: string): ActiveOption[] {
  return (activeOptions.get(vaultKey) ?? []).filter((o) => o.status === "ACTIVE");
}

export function getAllOptions(vaultKey: string): ActiveOption[] {
  return activeOptions.get(vaultKey) ?? [];
}

// ---------------------------------------------------------------
//  Settlement Logic
// ---------------------------------------------------------------

/**
 * Check which options are eligible for settlement (past expiry).
 */
export function getSettlementEligible(vaultKey: string): ActiveOption[] {
  const now = Math.floor(Date.now() / 1000);
  return getActiveOptions(vaultKey).filter((o) => now >= o.expiry);
}

/**
 * Settle a single expired option.
 *
 * 1. Fetch final Chainlink price
 * 2. Determine ITM/OTM
 * 3. Generate settlement parameters
 * 4. Mark as settled
 */
export async function settleOption(
  vaultKey: string,
  optionId: number,
  options?: { rpcUrl?: string }
): Promise<SettlementResult> {
  const options_list = activeOptions.get(vaultKey) ?? [];
  const option = options_list.find((o) => o.optionId === optionId && o.status === "ACTIVE");

  if (!option) {
    throw new Error(`Option ${optionId} not found or already settled`);
  }

  if (Math.floor(Date.now() / 1000) < option.expiry) {
    throw new Error(`Option ${optionId} has not expired yet`);
  }

  // Fetch final price from oracle
  const oraclePrice = await getStockPrice(option.stock, options);
  if (oraclePrice.stale || oraclePrice.price <= 0) {
    throw new Error(`Final price unavailable for ${option.stock.symbol}`);
  }

  const finalPrice = oraclePrice.price;

  // Generate settlement params
  const settlementParams = generateSettlementParams(
    optionId,
    option.stock,
    option.strikePrice,
    option.premium,
    option.collateralLocked,
    finalPrice
  );

  // Mark as settled
  option.status = settlementParams.isITM ? "SETTLED_ITM" : "SETTLED_OTM";

  const result: SettlementResult = {
    optionId,
    stock: option.stock,
    finalPrice,
    isITM: settlementParams.isITM,
    payoutUsd: settlementParams.payoutUsd,
    settlementParams,
    settledAt: Math.floor(Date.now() / 1000),
  };

  return result;
}

/**
 * Batch settle all eligible options for a vault.
 */
export async function settleAllEligible(
  vaultKey: string,
  options?: { rpcUrl?: string }
): Promise<SettlementResult[]> {
  const eligible = getSettlementEligible(vaultKey);
  const results: SettlementResult[] = [];

  for (const option of eligible) {
    try {
      const result = await settleOption(vaultKey, option.optionId, options);
      results.push(result);
    } catch {
      // Log error and continue with other options
      continue;
    }
  }

  return results;
}

/**
 * Simulate settlement for demo purposes.
 * Given a hypothetical final price, show what would happen.
 */
export function simulateSettlement(
  option: ActiveOption,
  finalPrice: number
): SettlementParams {
  return generateSettlementParams(
    option.optionId,
    option.stock,
    option.strikePrice,
    option.premium,
    option.collateralLocked,
    finalPrice
  );
}
