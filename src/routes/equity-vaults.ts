import type { FastifyInstance } from "fastify";

import { sendSuccess } from "../lib/responses.js";
import {
  TOKENIZED_STOCKS,
  STRATEGY_PRESETS,
  getTokenizedStock,
  getStrategyPreset,
} from "../config/tokenized-stocks.js";
import { getAllStockPrices, getStockPrice } from "../services/oracle-prices.js";
import { calculateCallPremium, proposeStrikes, estimateApy, calculateVsBuyAndHold } from "../services/options-pricing.js";
import { generateOptionParams, generateSettlementParams } from "../services/strategy-engine.js";
import {
  getActiveOptions,
  getSettlementEligible,
  settleOption,
  registerOption,
  type ActiveOption,
} from "../services/settlement.js";
import {
  calculateYieldSummary,
  calculateAggregateYield,
  recordEpoch,
  setInitialDeposit,
  getInitialDeposit,
} from "../services/yield-calculator.js";

// ---------------------------------------------------------------
//  Types
// ---------------------------------------------------------------

type VaultParams = {
  vaultAddress: string;
};

type StockSymbolParams = {
  symbol: string;
};

type QuoteBody = {
  symbol: string;
  strategy: string;
  collateralAmount: number;
};

type SimulateSettlementBody = {
  symbol: string;
  optionId: number;
  mockFinalPrice: number;
};

// ---------------------------------------------------------------
//  In-memory vault store (replace with DB/contract reads in production)
// ---------------------------------------------------------------

type VaultState = {
  address: string;
  deposits: Map<string, { amount: number; shares: number }>; // symbol → position
  options: ActiveOption[];
};

const vaults = new Map<string, VaultState>();

function getOrCreateVault(address: string): VaultState {
  let vault = vaults.get(address);
  if (!vault) {
    vault = {
      address,
      deposits: new Map(),
      options: [],
    };
    vaults.set(address, vault);
  }
  return vault;
}

// ---------------------------------------------------------------
//  Routes
// ---------------------------------------------------------------

export async function registerEquityVaultRoutes(app: FastifyInstance) {
  // -----------------------------------------------------------
  //  GET /equity-vaults/stocks — List all tokenized stocks
  // -----------------------------------------------------------
  app.get("/equity-vaults/stocks", async (_request, reply) => {
    return sendSuccess(reply, {
      stocks: TOKENIZED_STOCKS.map((s) => ({
        symbol: s.symbol,
        name: s.name,
        underlyingTicker: s.underlyingTicker,
        sector: s.sector,
        tokenAddress: s.tokenAddress,
        chainId: s.chainId,
      })),
    });
  });

  // -----------------------------------------------------------
  //  GET /equity-vaults/prices — Current prices for all stocks
  // -----------------------------------------------------------
  app.get("/equity-vaults/prices", async (_request, reply) => {
    const prices = await getAllStockPrices();
    return sendSuccess(reply, {
      prices: prices.map((p) => ({
        symbol: p.symbol,
        price: p.price,
        stale: p.stale,
        updatedAt: p.updatedAt,
      })),
    });
  });

  // -----------------------------------------------------------
  //  GET /equity-vaults/strategies — Available strategy presets
  // -----------------------------------------------------------
  app.get("/equity-vaults/strategies", async (_request, reply) => {
    return sendSuccess(reply, {
      strategies: Object.values(STRATEGY_PRESETS).map((s) => ({
        name: s.name,
        label: s.label,
        description: s.description,
        targetApyLow: s.targetApyLow,
        targetApyHigh: s.targetApyHigh,
        strikeDeltaBps: s.strikeDeltaBps,
        expiryDays: Math.round(s.expirySeconds / (24 * 60 * 60)),
      })),
    });
  });

  // -----------------------------------------------------------
  //  POST /equity-vaults/quote — Get option quote for a stock+strategy
  // -----------------------------------------------------------
  app.post<{ Body: QuoteBody }>(
    "/equity-vaults/quote",
    {
      schema: {
        body: {
          type: "object",
          required: ["symbol", "strategy", "collateralAmount"],
          additionalProperties: false,
          properties: {
            symbol: { type: "string", minLength: 1 },
            strategy: { type: "string", minLength: 1 },
            collateralAmount: { type: "number", minimum: 0.0001 },
          },
        },
      },
    },
    async (request, reply) => {
      const { symbol, strategy, collateralAmount } = request.body;

      const stock = getTokenizedStock(symbol);
      if (!stock) {
        return sendSuccess(reply, { error: `Unknown stock: ${symbol}` }, 400);
      }

      const strategyPreset = getStrategyPreset(strategy);
      if (!strategyPreset) {
        return sendSuccess(reply, { error: `Unknown strategy: ${strategy}` }, 400);
      }

      try {
        const params = await generateOptionParams(stock, strategy, collateralAmount);
        return sendSuccess(reply, { quote: params });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Quote failed";
        return sendSuccess(reply, { error: message }, 400);
      }
    },
  );

  // -----------------------------------------------------------
  //  POST /equity-vaults/:vaultAddress/deposit — Deposit into vault
  // -----------------------------------------------------------
  app.post<{ Params: VaultParams; Body: { symbol: string; amount: number } }>(
    "/equity-vaults/:vaultAddress/deposit",
    {
      schema: {
        params: {
          type: "object",
          required: ["vaultAddress"],
          properties: {
            vaultAddress: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["symbol", "amount"],
          additionalProperties: false,
          properties: {
            symbol: { type: "string", minLength: 1 },
            amount: { type: "number", minimum: 0.0001 },
          },
        },
      },
    },
    async (request, reply) => {
      const { vaultAddress } = request.params;
      const { symbol, amount } = request.body;

      const stock = getTokenizedStock(symbol);
      if (!stock) {
        return sendSuccess(reply, { error: `Unknown stock: ${symbol}` }, 400);
      }

      const vault = getOrCreateVault(vaultAddress);
      const existing = vault.deposits.get(symbol) ?? { amount: 0, shares: 0 };

      // 1:1 share ratio for simplicity (production uses ERC-4626 math)
      const sharesMinted = amount;
      vault.deposits.set(symbol, {
        amount: existing.amount + amount,
        shares: existing.shares + sharesMinted,
      });

      // Track initial deposit for buy-and-hold comparison
      const oracle = await getStockPrice(stock);
      if (!getInitialDeposit(vaultAddress, symbol)) {
        setInitialDeposit(vaultAddress, symbol, oracle.price * amount, amount);
      }

      return sendSuccess(reply, {
        deposit: {
          symbol,
          amount,
          sharesMinted,
          vaultAddress,
          totalDeposited: existing.amount + amount,
          totalShares: existing.shares + sharesMinted,
        },
      }, 201);
    },
  );

  // -----------------------------------------------------------
  //  GET /equity-vaults/:vaultAddress — Vault overview
  // -----------------------------------------------------------
  app.get<{ Params: VaultParams }>(
    "/equity-vaults/:vaultAddress",
    {
      schema: {
        params: {
          type: "object",
          required: ["vaultAddress"],
          properties: {
            vaultAddress: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { vaultAddress } = request.params;
      const vault = getOrCreateVault(vaultAddress);

      const prices = await getAllStockPrices();
      const priceMap = new Map(prices.map((p) => [p.symbol, p.price]));

      // Build deposit info with current values
      const deposits = Array.from(vault.deposits.entries()).map(([symbol, dep]) => {
        const stock = getTokenizedStock(symbol);
        const currentPrice = priceMap.get(symbol) ?? 0;
        const currentValue = currentPrice * dep.amount;
        return {
          symbol,
          name: stock?.name ?? symbol,
          deposited: dep.amount,
          shares: dep.shares,
          currentPrice,
          currentValue,
        };
      });

      // Active options
      const activeOptions = getActiveOptions(vaultAddress);

      // Yield summaries per stock
      const yieldSummaries = deposits.map((dep) => {
        const stock = getTokenizedStock(dep.symbol);
        if (!stock) return null;
        return calculateYieldSummary(vaultAddress, stock, dep.currentPrice);
      }).filter(Boolean);

      // Total stats
      const totalDepositedUsd = deposits.reduce((sum, d) => sum + d.currentValue, 0);
      const totalPremiumEarned = yieldSummaries.reduce(
        (sum, s) => sum + (s?.totalPremiumEarned ?? 0), 0
      );

      return sendSuccess(reply, {
        vaultAddress,
        totalDepositedUsd,
        totalPremiumEarned,
        deposits,
        activeOptions: activeOptions.map((o) => ({
          optionId: o.optionId,
          symbol: o.stock.symbol,
          strikePrice: o.strikePrice,
          expiry: o.expiry,
          premium: o.premium,
          collateralLocked: o.collateralLocked,
          status: o.status,
        })),
        yieldSummaries: yieldSummaries.map((s) => ({
          symbol: s!.stock.symbol,
          totalPremiumEarned: s!.totalPremiumEarned,
          totalEpochs: s!.totalEpochs,
          currentApy: s!.currentApy,
          winRate: s!.winRate,
          holdReturnPct: s!.holdReturnPct,
          yieldReturnPct: s!.yieldReturnPct,
          outperformancePct: s!.outperformancePct,
        })),
      });
    },
  );

  // -----------------------------------------------------------
  //  GET /equity-vaults/:vaultAddress/options — Active options
  // -----------------------------------------------------------
  app.get<{ Params: VaultParams }>(
    "/equity-vaults/:vaultAddress/options",
    {
      schema: {
        params: {
          type: "object",
          required: ["vaultAddress"],
          properties: {
            vaultAddress: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { vaultAddress } = request.params;
      const active = getActiveOptions(vaultAddress);

      // Enrich with time remaining and safety status
      const now = Math.floor(Date.now() / 1000);
      const enriched = active.map((o) => {
        const timeRemaining = Math.max(0, o.expiry - now);
        const totalDuration = o.expiry - (o.expiry - 14 * 24 * 60 * 60); // approximate
        const timeElapsed = totalDuration - timeRemaining;
        const progressPct = totalDuration > 0 ? Math.round((timeElapsed / totalDuration) * 100) : 0;

        return {
          optionId: o.optionId,
          symbol: o.stock.symbol,
          strikePrice: o.strikePrice,
          expiry: o.expiry,
          premium: o.premium,
          collateralLocked: o.collateralLocked,
          status: o.status,
          timeRemaining,
          progressPct,
        };
      });

      return sendSuccess(reply, { options: enriched });
    },
  );

  // -----------------------------------------------------------
  //  POST /equity-vaults/:vaultAddress/write-option — Write a covered call
  // -----------------------------------------------------------
  app.post<{ Params: VaultParams; Body: { symbol: string; strategy: string; collateralAmount: number } }>(
    "/equity-vaults/:vaultAddress/write-option",
    {
      schema: {
        params: {
          type: "object",
          required: ["vaultAddress"],
          properties: {
            vaultAddress: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["symbol", "strategy", "collateralAmount"],
          additionalProperties: false,
          properties: {
            symbol: { type: "string", minLength: 1 },
            strategy: { type: "string", minLength: 1 },
            collateralAmount: { type: "number", minimum: 0.0001 },
          },
        },
      },
    },
    async (request, reply) => {
      const { vaultAddress } = request.params;
      const { symbol, strategy, collateralAmount } = request.body;

      const stock = getTokenizedStock(symbol);
      if (!stock) {
        return sendSuccess(reply, { error: `Unknown stock: ${symbol}` }, 400);
      }

      // Check vault has enough deposited
      const vault = getOrCreateVault(vaultAddress);
      const deposit = vault.deposits.get(symbol);
      if (!deposit || deposit.amount < collateralAmount) {
        return sendSuccess(reply, { error: "Insufficient deposited balance" }, 400);
      }

      try {
        const params = await generateOptionParams(stock, strategy, collateralAmount);

        // Register the option
        const optionId = vault.options.length;
        const option: ActiveOption = {
          optionId,
          stock,
          strikePrice: params.strike,
          expiry: params.expiryTimestamp,
          premium: params.premium,
          collateralLocked: collateralAmount,
          status: "ACTIVE",
        };

        vault.options.push(option);
        registerOption(vaultAddress, option);

        return sendSuccess(reply, {
          option: {
            optionId,
            symbol,
            strategy,
            strike: params.strike,
            strikeLabel: params.strikeLabel,
            expiry: params.expiryTimestamp,
            premium: params.premium,
            premiumPct: params.premiumPct,
            delta: params.delta,
            collateralAmount,
            estimatedApy: params.estimatedApy,
          },
        }, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to write option";
        return sendSuccess(reply, { error: message }, 400);
      }
    },
  );

  // -----------------------------------------------------------
  //  POST /equity-vaults/:vaultAddress/settle — Settle expired options
  // -----------------------------------------------------------
  app.post<{ Params: VaultParams }>(
    "/equity-vaults/:vaultAddress/settle",
    {
      schema: {
        params: {
          type: "object",
          required: ["vaultAddress"],
          properties: {
            vaultAddress: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { vaultAddress } = request.params;
      const eligible = getSettlementEligible(vaultAddress);

      if (eligible.length === 0) {
        return sendSuccess(reply, { message: "No options eligible for settlement", settled: [] });
      }

      const results = [];
      for (const option of eligible) {
        try {
          const result = await settleOption(vaultAddress, option.optionId);
          results.push(result);

          // Record yield epoch
          recordEpoch(vaultAddress, {
            epochNumber: result.optionId,
            stock: option.stock,
            strategyName: "MODERATE", // default for demo
            premiumEarned: result.payoutUsd,
            underlyingDeposited: option.collateralLocked,
            underlyingValueUsd: option.collateralLocked * (result.finalPrice / 1e8),
            strikePrice: option.strikePrice,
            expirySeconds: 14 * 24 * 60 * 60,
            settledAt: result.settledAt,
            isITM: result.isITM,
            finalPrice: result.finalPrice,
          });
        } catch {
          continue;
        }
      }

      return sendSuccess(reply, { settled: results });
    },
  );

  // -----------------------------------------------------------
  //  POST /equity-vaults/:vaultAddress/simulate — Simulate settlement
  // -----------------------------------------------------------
  app.post<{ Params: VaultParams; Body: SimulateSettlementBody }>(
    "/equity-vaults/:vaultAddress/simulate",
    {
      schema: {
        params: {
          type: "object",
          required: ["vaultAddress"],
          properties: {
            vaultAddress: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["symbol", "optionId", "mockFinalPrice"],
          additionalProperties: false,
          properties: {
            symbol: { type: "string", minLength: 1 },
            optionId: { type: "integer", minimum: 0 },
            mockFinalPrice: { type: "number", minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { vaultAddress } = request.params;
      const { symbol, optionId, mockFinalPrice } = request.body;

      const vault = getOrCreateVault(vaultAddress);
      const option = vault.options.find(
        (o) => o.optionId === optionId && o.stock.symbol === symbol
      );

      if (!option) {
        return sendSuccess(reply, { error: "Option not found" }, 404);
      }

      const { generateSettlementParams: genParams } = await import("../services/strategy-engine.js");
      const simulation = genParams(
        optionId,
        option.stock,
        option.strikePrice,
        option.premium,
        option.collateralLocked,
        mockFinalPrice
      );

      return sendSuccess(reply, { simulation });
    },
  );

  // -----------------------------------------------------------
  //  GET /equity-vaults/:vaultAddress/yield — Yield summary
  // -----------------------------------------------------------
  app.get<{ Params: VaultParams }>(
    "/equity-vaults/:vaultAddress/yield",
    {
      schema: {
        params: {
          type: "object",
          required: ["vaultAddress"],
          properties: {
            vaultAddress: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { vaultAddress } = request.params;
      const vault = getOrCreateVault(vaultAddress);
      const prices = await getAllStockPrices();
      const priceMap = new Map(prices.map((p) => [p.symbol, p.price]));

      const stocks = Array.from(vault.deposits.keys())
        .map((s) => getTokenizedStock(s))
        .filter(Boolean) as typeof TOKENIZED_STOCKS;

      const snapshot = calculateAggregateYield(vaultAddress, stocks, priceMap);

      return sendSuccess(reply, { yield: snapshot });
    },
  );
}
