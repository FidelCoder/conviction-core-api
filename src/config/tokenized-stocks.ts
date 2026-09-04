/**
 * Tokenized Stocks Registry
 *
 * Coinbase B20 tokenized stocks on Base mainnet (chainId 8453).
 * Each entry maps a B20 token to its Chainlink oracle feed and metadata.
 *
 * Contract addresses from: https://www.base.org/stocks
 * Chainlink feeds from: https://docs.chain.link/data-feeds/tokenized-equity-feeds/coinbase
 */

export type TokenizedStock = {
  symbol: string;
  name: string;
  underlyingTicker: string;
  tokenAddress: `0x${string}`;
  chainId: number;
  decimals: number;
  chainlinkFeedId: string;
  chainlinkFeedAddress: `0x${string}`;
  sector: "tech" | "finance" | "consumer" | "healthcare" | "energy" | "communication";
  multiplier: number; // B20 multiplier (1.0 = 1:1 backing)
};

export const BASE_MAINNET_CHAIN_ID = 8453;

/**
 * Coinbase Onchain Registry for B20 tokens.
 * Returns multiplier and pause flag for each token.
 * Source: https://docs.base.org/specifications/b20/tokenized-stocks-on-base
 */
export const B20_ONCHAIN_REGISTRY = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD" as const;

/**
 * B20 token standard details.
 * - Multiplier: WAD-scaled (1e18). Token price = underlying price × multiplier.
 * - Corporate actions (dividends, splits) update the multiplier, not balances.
 * - Chainlink feeds report Total Return Values (price × multiplier).
 * - Feeds run 24/5, hold last value on weekends/holidays.
 * - B20 tokens are Base-native precompiles (no per-asset bytecode).
 */
export const B20_STANDARD = {
  wadPrecision: 10n ** 18n,
  decimals: 8, // Chainlink feeds return 8 decimals
  feedUpdateFrequency: "0.5% deviation or 24h heartbeat",
  complianceNotes: "KYC only at mint/redeem (APs). Secondary market is permissionless.",
} as const;

/**
 * B20 Tokenized Stock addresses on Base mainnet.
 * These are the official Coinbase-issued tokens.
 */
/**
 * B20 Tokenized Stock contract addresses on Base mainnet.
 * Source: https://docs.base.org/specifications/b20/tokenized-stocks-on-base
 * B20 tokens are Base-native precompiles (no per-asset bytecode on Basescan).
 */
export const TOKENIZED_STOCKS: TokenizedStock[] = [
  {
    symbol: "NVDAc",
    name: "NVIDIA Tokenized Stock",
    underlyingTicker: "NVDA",
    tokenAddress: "0xb20000000000000000000078ee7ce2fE4908108C",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase NVDA",
    chainlinkFeedAddress: "0x04689a41629776563E6822F76f2e57D148d28513",
    sector: "tech",
    multiplier: 1.0,
  },
  {
    symbol: "AAPLc",
    name: "Apple Tokenized Stock",
    underlyingTicker: "AAPL",
    tokenAddress: "0xb200000000000000000000C2e324d24d7eEcd1fb",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase AAPL",
    chainlinkFeedAddress: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
    sector: "tech",
    multiplier: 1.0,
  },
  {
    symbol: "GOOGLc",
    name: "Alphabet Tokenized Stock",
    underlyingTicker: "GOOGL",
    tokenAddress: "0xb2000000000000000000002D0BA3164cc74f58B7",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase GOOGL",
    chainlinkFeedAddress: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
    sector: "tech",
    multiplier: 1.0,
  },
  {
    symbol: "METAc",
    name: "Meta Tokenized Stock",
    underlyingTicker: "META",
    tokenAddress: "0xb2000000000000000000008bC8786B856E61707C",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase META",
    chainlinkFeedAddress: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
    sector: "tech",
    multiplier: 1.0,
  },
  {
    symbol: "AMZNc",
    name: "Amazon Tokenized Stock",
    underlyingTicker: "AMZN",
    tokenAddress: "0xb200000000000000000000d9192b6B456483C2E8",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase AMZN",
    chainlinkFeedAddress: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
    sector: "tech",
    multiplier: 1.0,
  },
  {
    symbol: "TSLAc",
    name: "Tesla Tokenized Stock",
    underlyingTicker: "TSLA",
    tokenAddress: "0xb2000000000000000000001e800a7f5189430cD0",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase TSLA",
    chainlinkFeedAddress: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
    sector: "tech",
    multiplier: 1.0,
  },
  {
    symbol: "MSFTc",
    name: "Microsoft Tokenized Stock",
    underlyingTicker: "MSFT",
    tokenAddress: "0xB200000000000000000000Ab99cFa739E253872B",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase MSFT",
    chainlinkFeedAddress: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
    sector: "tech",
    multiplier: 1.0,
  },
  {
    symbol: "COINc",
    name: "Coinbase Tokenized Stock",
    underlyingTicker: "COIN",
    tokenAddress: "0xb200000000000000000000c85a31389D71F3ecfb",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase COIN",
    chainlinkFeedAddress: "0x408e44f504A7371a345F03a73dDC96A4b48e8aa7",
    sector: "finance",
    multiplier: 1.0,
  },
  {
    symbol: "INTCc",
    name: "Intel Tokenized Stock",
    underlyingTicker: "INTC",
    tokenAddress: "0xB2000000000000000000004AFF16039bA04bdFBc",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase INTC",
    chainlinkFeedAddress: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB",
    sector: "tech",
    multiplier: 1.0,
  },
  {
    symbol: "MSTRc",
    name: "MicroStrategy Tokenized Stock",
    underlyingTicker: "MSTR",
    tokenAddress: "0xB2000000000000000000004884b426556b92883d",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase MSTR",
    chainlinkFeedAddress: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
    sector: "finance",
    multiplier: 1.0,
  },
  {
    symbol: "CRCLc",
    name: "Circle Tokenized Stock",
    underlyingTicker: "CRCL",
    tokenAddress: "0xB20000000000000000000019f6E7C675b73C2e4D",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase CRCL",
    chainlinkFeedAddress: "0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33",
    sector: "finance",
    multiplier: 1.0,
  },
  {
    symbol: "SNDKc",
    name: "SanDisk Tokenized Stock",
    underlyingTicker: "SNDK",
    tokenAddress: "0xb200000000000000000000397293Cb8cda9a10c5",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase SNDK",
    chainlinkFeedAddress: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA",
    sector: "tech",
    multiplier: 1.0,
  },
  {
    symbol: "SPCXc",
    name: "SPAC Index Tokenized Stock",
    underlyingTicker: "SPCX",
    tokenAddress: "0xb2000000000000000000007b9fcbd005511aCBd5",
    chainId: BASE_MAINNET_CHAIN_ID,
    decimals: 8,
    chainlinkFeedId: "Coinbase SPCX",
    chainlinkFeedAddress: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
    sector: "finance",
    multiplier: 1.0,
  },
];

/**
 * Get a tokenized stock by symbol.
 */
export function getTokenizedStock(symbol: string): TokenizedStock | undefined {
  return TOKENIZED_STOCKS.find((s) => s.symbol === symbol);
}

/**
 * Get all supported token addresses as an array.
 */
export function getSupportedTokenAddresses(): `0x${string}`[] {
  return TOKENIZED_STOCKS.map((s) => s.tokenAddress);
}

/**
 * Default strategy parameters for covered calls.
 */
export type StrategyPreset = {
  name: string;
  label: string;
  description: string;
  strikeDeltaBps: number; // 9000 = OTM 10%, 10000 = ATM, 11000 = ITM 10%
  expirySeconds: number;
  defaultVolBps: number; // implied vol in bps (30000 = 30%)
  targetApyLow: number; // %
  targetApyHigh: number; // %
};

export const STRATEGY_PRESETS: Record<string, StrategyPreset> = {
  CONSERVATIVE: {
    name: "CONSERVATIVE",
    label: "Conservative",
    description: "OTM 10%, 30-day expiry. Lower premium, higher win rate (~85%).",
    strikeDeltaBps: 9000,
    expirySeconds: 30 * 24 * 60 * 60,
    defaultVolBps: 25000,
    targetApyLow: 8,
    targetApyHigh: 12,
  },
  MODERATE: {
    name: "MODERATE",
    label: "Moderate",
    description: "ATM strike, 14-day expiry. Balanced premium and risk.",
    strikeDeltaBps: 10000,
    expirySeconds: 14 * 24 * 60 * 60,
    defaultVolBps: 30000,
    targetApyLow: 12,
    targetApyHigh: 18,
  },
  AGGRESSIVE: {
    name: "AGGRESSIVE",
    label: "Aggressive",
    description: "ITM 5%, 7-day expiry. High premium, higher assignment risk.",
    strikeDeltaBps: 10500,
    expirySeconds: 7 * 24 * 60 * 60,
    defaultVolBps: 35000,
    targetApyLow: 18,
    targetApyHigh: 25,
  },
};

export function getStrategyPreset(name: string): StrategyPreset | undefined {
  return STRATEGY_PRESETS[name.toUpperCase()];
}
