/**
 * Options Pricing Engine
 *
 * Black-Scholes model for pricing European call options on tokenized stocks.
 * Used to calculate fair premium for covered calls and estimate yield.
 *
 * All prices are in USD with 8 decimal precision (matching Chainlink feeds).
 */

// ---------------------------------------------------------------
//  Types
// ---------------------------------------------------------------

export type OptionQuote = {
  /** Fair premium in USD (8 dec) */
  premium: number;
  /** Premium as % of underlying price */
  premiumPct: number;
  /** Black-Scholes delta (0-1 for calls) */
  delta: number;
  /** Gamma — rate of change of delta */
  gamma: number;
  /** Theta — time decay per day */
  theta: number;
  /** Implied vol used */
  impliedVol: number;
  /** Strike price */
  strike: number;
  /** Current underlying price */
  underlyingPrice: number;
  /** Time to expiry in years */
  timeToExpiryYears: number;
};

export type StrikeProposal = {
  strike: number;
  strikeDeltaPct: number; // how far OTM/ITM (%)
  label: string; // "OTM 10%", "ATM", "ITM 5%"
  quote: OptionQuote;
};

// ---------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------

const RISK_FREE_RATE = 0.05; // 5% annual
const SQRT_252 = 15.8745; // sqrt(252 trading days)

// ---------------------------------------------------------------
//  Black-Scholes Core
// ---------------------------------------------------------------

/**
 * Standard normal cumulative distribution function (CDF).
 * Uses Abramowitz & Stegun approximation (accuracy ~7 decimal places).
 */
function normCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Standard normal probability density function (PDF).
 */
function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes price for a European call option.
 *
 * @param S - Current underlying price
 * @param K - Strike price
 * @param T - Time to expiry in years
 * @param r - Risk-free rate (annual, e.g. 0.05)
 * @param sigma - Implied volatility (annual, e.g. 0.30)
 * @returns Call option price
 */
function blackScholesCall(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0) return Math.max(S - K, 0); // intrinsic value at expiry
  if (sigma <= 0) return Math.max(S - K * Math.exp(-r * T), 0); // no vol

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
}

/**
 * Black-Scholes Greeks for a European call option.
 */
function blackScholesGreeks(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number
): { delta: number; gamma: number; theta: number } {
  if (T <= 0) return { delta: S > K ? 1 : 0, gamma: 0, theta: 0 };

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  const delta = normCDF(d1);
  const gamma = normPDF(d1) / (S * sigma * Math.sqrt(T));
  const theta =
    (-(S * normPDF(d1) * sigma) / (2 * Math.sqrt(T)) -
      r * K * Math.exp(-r * T) * normCDF(d2)) /
    365; // per day

  return { delta, gamma, theta };
}

// ---------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------

/**
 * Calculate fair premium for a covered call on a tokenized stock.
 *
 * @param underlyingPrice - Current stock price (USD, e.g. 142.30)
 * @param strike - Strike price (USD, e.g. 128.07 for OTM 10%)
 * @param expirySeconds - Time to expiry in seconds
 * @param impliedVol - Implied volatility (e.g. 0.30 for 30%)
 * @param volatilityOverrideBps - Vol override from strategy (0 = use param)
 */
export function calculateCallPremium(
  underlyingPrice: number,
  strike: number,
  expirySeconds: number,
  impliedVol: number,
  volatilityOverrideBps?: number
): OptionQuote {
  const vol = volatilityOverrideBps && volatilityOverrideBps > 0
    ? volatilityOverrideBps / 10_000
    : impliedVol;

  const T = expirySeconds / (365.25 * 24 * 60 * 60); // convert to years
  const premium = blackScholesCall(underlyingPrice, strike, T, RISK_FREE_RATE, vol);
  const premiumPct = underlyingPrice > 0 ? (premium / underlyingPrice) * 100 : 0;
  const { delta, gamma, theta } = blackScholesGreeks(underlyingPrice, strike, T, RISK_FREE_RATE, vol);

  return {
    premium,
    premiumPct,
    delta,
    gamma,
    theta,
    impliedVol: vol,
    strike,
    underlyingPrice,
    timeToExpiryYears: T,
  };
}

/**
 * Propose strikes for a given underlying price and strategy.
 *
 * @param underlyingPrice - Current stock price
 * @param strikeDeltaBps - Strategy strike delta in bps (9000 = OTM 10%)
 * @param expirySeconds - Time to expiry
 * @param impliedVol - Default implied vol
 * @param volOverrideBps - Strategy vol override (0 = use default)
 */
export function proposeStrikes(
  underlyingPrice: number,
  strikeDeltaBps: number,
  expirySeconds: number,
  impliedVol: number,
  volOverrideBps?: number
): StrikeProposal {
  // Calculate strike from delta bps
  // strikeDeltaBps = 9000 → OTM 10% → strike = price * 0.90
  // strikeDeltaBps = 10000 → ATM → strike = price
  // strikeDeltaBps = 11000 → ITM 10% → strike = price * 1.10
  const strikeMultiplier = strikeDeltaBps / 10_000;
  const strike = Math.round(underlyingPrice * strikeMultiplier * 100) / 100; // 2 dec precision

  const strikeDeltaPct = Math.abs(strikeMultiplier - 1) * 100;
  let label: string;
  if (strikeMultiplier < 1) {
    label = `OTM ${strikeDeltaPct.toFixed(1)}%`;
  } else if (strikeMultiplier > 1) {
    label = `ITM ${strikeDeltaPct.toFixed(1)}%`;
  } else {
    label = "ATM";
  }

  const quote = calculateCallPremium(
    underlyingPrice,
    strike,
    expirySeconds,
    impliedVol,
    volOverrideBps
  );

  return { strike, strikeDeltaPct, label, quote };
}

/**
 * Estimate annualized APY from premium yield.
 *
 * @param premiumPerEpoch - Premium earned per epoch (USD)
 * @param underlyingValue - Total underlying value in vault (USD)
 * @param epochDurationSeconds - Duration of one epoch in seconds
 * @returns Annualized APY as a percentage
 */
export function estimateApy(
  premiumPerEpoch: number,
  underlyingValue: number,
  epochDurationSeconds: number
): number {
  if (underlyingValue <= 0 || epochDurationSeconds <= 0) return 0;

  const epochsPerYear = (365.25 * 24 * 60 * 60) / epochDurationSeconds;
  const yieldPerEpoch = premiumPerEpoch / underlyingValue;
  const apy = yieldPerEpoch * epochsPerYear * 100;

  return Math.round(apy * 100) / 100; // 2 decimal places
}

/**
 * Calculate comparison to buy-and-hold.
 *
 * @param premiumEarned - Total premium earned (USD)
 * @param underlyingInitialValue - Initial deposit value (USD)
 * @param underlyingCurrentValue - Current value of underlying (USD)
 * @returns Object with hold return, yield return, and total return
 */
export function calculateVsBuyAndHold(
  premiumEarned: number,
  underlyingInitialValue: number,
  underlyingCurrentValue: number
): {
  holdReturnPct: number;
  yieldReturnPct: number;
  totalReturnPct: number;
  outperformancePct: number;
} {
  const holdReturnPct =
    underlyingInitialValue > 0
      ? ((underlyingCurrentValue - underlyingInitialValue) / underlyingInitialValue) * 100
      : 0;

  const yieldReturnPct =
    underlyingInitialValue > 0 ? (premiumEarned / underlyingInitialValue) * 100 : 0;

  const totalReturnPct = holdReturnPct + yieldReturnPct;
  const outperformancePct = yieldReturnPct; // yield is the outperformance over pure hold

  return {
    holdReturnPct: Math.round(holdReturnPct * 100) / 100,
    yieldReturnPct: Math.round(yieldReturnPct * 100) / 100,
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    outperformancePct: Math.round(outperformancePct * 100) / 100,
  };
}
