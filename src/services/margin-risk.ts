export const ASSET_SCALE = 1_000_000n;
export const BPS = 10_000n;
export const DEFAULT_MAX_LEVERAGE_BPS = 20_000;
export const HARD_MAX_LEVERAGE_BPS = 30_000;
export const QUOTE_TTL_MS = 30_000;

export type MarginSide = "YES" | "NO";

export type MarginRiskRejectionCode =
  | "ACCOUNT_EXPOSURE_CAP"
  | "CATEGORY_EXPOSURE_CAP"
  | "EVENT_TOO_CLOSE"
  | "INVALID_CONDITION_ID"
  | "INVALID_MARKET_METADATA"
  | "INVALID_POLICY"
  | "INVALID_REQUEST"
  | "INVALID_TOKEN_IDS"
  | "INVALID_TICK_SIZE"
  | "LEVERAGE_LIMIT"
  | "LOW_ENTRY_DEPTH"
  | "LOW_EXIT_DEPTH"
  | "MARKET_EXPOSURE_CAP"
  | "MARKET_NOT_ACTIVE"
  | "MARKET_NOT_APPROVED"
  | "NEGATIVE_RISK_MISMATCH"
  | "ORDERBOOK_DISABLED"
  | "ORDERBOOK_STALE"
  | "PRICE_DEVIATION"
  | "PROVIDER_OUTAGE"
  | "SPREAD_TOO_WIDE"
  | "STALE_MARKET"
  | "VAULT_EXPOSURE_CAP";

export type MarginRiskRejection = {
  code: MarginRiskRejectionCode;
  message: string;
};

export type MarginOrderBookLevel = {
  price: string;
  size: string;
};

export type MarginRiskInput = {
  nowMs: number;
  market: {
    acceptingOrders: boolean;
    conditionId: string | null;
    negativeRisk: boolean | null;
    noTokenId: string | null;
    orderBookEnabled: boolean;
    resolutionAtMs: number | null;
    status: "ACTIVE" | "CLOSED" | "SETTLED" | "CANCELLED";
    syncedAtMs: number | null;
    tickSize: string | null;
    yesTokenId: string | null;
  };
  policy: {
    closeBufferSeconds: number;
    earliestResolutionAtMs: number;
    expectedNegativeRisk: boolean;
    feeBps: number;
    maintenanceMarginBps: number;
    mandatoryCloseAtMs: number;
    maxAccountBorrowAssets: string;
    maxCategoryBorrowAssets: string;
    maxLeverageBps: number;
    maxMarketBorrowAssets: string;
    maxPriceAgeSeconds: number;
    maxSpreadBps: number;
    maxTwapDeviationBps: number;
    maxVaultBorrowAssets: string;
    minimumDepthAssets: string;
    status: "DRAFT" | "APPROVED" | "PAUSED";
  };
  provider: {
    asks: MarginOrderBookLevel[];
    bids: MarginOrderBookLevel[];
    negativeRisk: boolean | null;
    observedAtMs: number;
    operational: boolean;
    tickSize: string | null;
    tokenId: string;
    twapPrice: string | null;
  };
  request: {
    collateralAssets: string;
    leverageBps: number;
    side: MarginSide;
  };
  exposure: {
    accountBorrowAssets: string;
    categoryBorrowAssets: string;
    marketBorrowAssets: string;
    vaultBorrowAssets: string;
  };
};

export type MarginRiskQuote = {
  borrowAssets: string;
  collateralAssets: string;
  conservativeMarkPrice: string;
  entryDepthAssets: string;
  estimatedOutcomeShares: string;
  feeAssets: string;
  leverageBps: number;
  leverageMultiplier: string;
  liquidationPrice: string;
  mandatoryCloseAt: string;
  notionalAssets: string;
  openingPrice: string;
  orderBookObservedAt: string;
  quoteExpiresAt: string;
  side: MarginSide;
  spreadBps: number;
  tokenId: string;
  twapPrice: string;
};

export type MarginRiskDecision =
  | { approved: true; quote: MarginRiskQuote; rejections: [] }
  | { approved: false; quote: null; rejections: MarginRiskRejection[] };

type ParsedLevel = {
  price: bigint;
  size: bigint;
};

const conditionIdPattern = /^0x[a-fA-F0-9]{64}$/;
const tokenIdPattern = /^\d+$/;
const supportedTickSizes = new Set(["0.1", "0.01", "0.001", "0.0001"]);

export function evaluateMarginRisk(input: MarginRiskInput): MarginRiskDecision {
  const rejections: MarginRiskRejection[] = [];
  const reject = (code: MarginRiskRejectionCode, message: string) => {
    if (!rejections.some((entry) => entry.code === code)) {
      rejections.push({ code, message });
    }
  };

  validateEligibility(input, reject);

  let collateral: bigint;
  let minimumDepth: bigint;
  let accountExposure: bigint;
  let categoryExposure: bigint;
  let marketExposure: bigint;
  let vaultExposure: bigint;
  let accountCap: bigint;
  let categoryCap: bigint;
  let marketCap: bigint;
  let vaultCap: bigint;

  try {
    collateral = parseFixed(input.request.collateralAssets);
    minimumDepth = parseFixed(input.policy.minimumDepthAssets);
    accountExposure = parseFixed(input.exposure.accountBorrowAssets);
    categoryExposure = parseFixed(input.exposure.categoryBorrowAssets);
    marketExposure = parseFixed(input.exposure.marketBorrowAssets);
    vaultExposure = parseFixed(input.exposure.vaultBorrowAssets);
    accountCap = parseFixed(input.policy.maxAccountBorrowAssets);
    categoryCap = parseFixed(input.policy.maxCategoryBorrowAssets);
    marketCap = parseFixed(input.policy.maxMarketBorrowAssets);
    vaultCap = parseFixed(input.policy.maxVaultBorrowAssets);
  } catch {
    reject("INVALID_REQUEST", "Risk inputs must use positive decimal asset amounts.");
    return { approved: false, quote: null, rejections };
  }

  if (collateral <= 0n) {
    reject("INVALID_REQUEST", "Collateral must be greater than zero.");
  }

  const leverageBps = input.request.leverageBps;
  if (
    !Number.isInteger(leverageBps) ||
    leverageBps <= Number(BPS) ||
    leverageBps > HARD_MAX_LEVERAGE_BPS ||
    leverageBps > input.policy.maxLeverageBps
  ) {
    reject(
      "LEVERAGE_LIMIT",
      "Requested leverage exceeds this market's approved limit. Universal 10x is disabled.",
    );
  }

  if (rejections.length > 0) {
    return { approved: false, quote: null, rejections };
  }

  const notional = mulDiv(collateral, BigInt(leverageBps), BPS);
  const borrow = notional - collateral;
  const fee = mulDivUp(notional, BigInt(input.policy.feeBps), BPS);

  if (marketExposure + borrow > marketCap) {
    reject("MARKET_EXPOSURE_CAP", "This quote would exceed the approved market borrow cap.");
  }
  if (accountExposure + borrow > accountCap) {
    reject("ACCOUNT_EXPOSURE_CAP", "This quote would exceed the account borrow cap.");
  }
  if (categoryExposure + borrow > categoryCap) {
    reject("CATEGORY_EXPOSURE_CAP", "This quote would exceed the category borrow cap.");
  }
  if (vaultExposure + borrow > vaultCap) {
    reject("VAULT_EXPOSURE_CAP", "This quote would exceed the vault borrow cap.");
  }

  let asks: ParsedLevel[];
  let bids: ParsedLevel[];
  let twapPrice: bigint;

  try {
    asks = parseLevels(input.provider.asks, "asc");
    bids = parseLevels(input.provider.bids, "desc");
    twapPrice = parsePrice(input.provider.twapPrice ?? "");
  } catch {
    reject("INVALID_MARKET_METADATA", "Orderbook or TWAP values are malformed.");
    return { approved: false, quote: null, rejections };
  }

  const totalAskDepth = sumAssetDepth(asks);
  const totalBidDepth = sumAssetDepth(bids);
  if (totalAskDepth < minimumDepth) {
    reject("LOW_ENTRY_DEPTH", "Available ask depth is below the approved minimum.");
  }
  if (totalBidDepth < minimumDepth) {
    reject("LOW_EXIT_DEPTH", "Available bid depth is below the approved minimum.");
  }

  const entry = consumeAssets(asks, notional);
  if (!entry.complete || entry.shares === 0n) {
    reject("LOW_ENTRY_DEPTH", "The orderbook cannot fill the requested notional.");
  }

  if (rejections.length > 0) {
    return { approved: false, quote: null, rejections };
  }

  const exit = consumeShares(bids, entry.shares);
  if (!exit.complete || exit.assets === 0n) {
    reject("LOW_EXIT_DEPTH", "The orderbook cannot exit the estimated outcome shares.");
    return { approved: false, quote: null, rejections };
  }

  const bestAsk = asks[0]!.price;
  const bestBid = bids[0]!.price;
  const midpoint = (bestAsk + bestBid) / 2n;
  const spreadBps =
    midpoint === 0n ? Number(BPS) : Number(mulDiv(bestAsk - bestBid, BPS, midpoint));
  if (bestAsk <= bestBid || spreadBps > input.policy.maxSpreadBps) {
    reject("SPREAD_TOO_WIDE", "The executable spread exceeds this market's risk limit.");
  }

  const openingPrice = mulDivUp(entry.assets, ASSET_SCALE, entry.shares);
  const exitPrice = mulDiv(exit.assets, ASSET_SCALE, entry.shares);
  const deviationBps = Number(
    mulDiv(abs(openingPrice - twapPrice), BPS, twapPrice === 0n ? 1n : twapPrice),
  );
  if (
    twapPrice <= 0n ||
    twapPrice >= ASSET_SCALE ||
    deviationBps > input.policy.maxTwapDeviationBps
  ) {
    reject("PRICE_DEVIATION", "Executable price deviates too far from the recent TWAP.");
  }

  const maintenanceDenominator = BPS - BigInt(input.policy.maintenanceMarginBps);
  const liquidationPrice = mulDivUp(
    borrow * ASSET_SCALE,
    BPS,
    entry.shares * maintenanceDenominator,
  );
  const conservativeMark = exitPrice < twapPrice ? exitPrice : twapPrice;
  if (liquidationPrice >= conservativeMark) {
    reject(
      "INVALID_REQUEST",
      "The position would begin at or below its conservative liquidation threshold.",
    );
  }

  if (rejections.length > 0) {
    return { approved: false, quote: null, rejections };
  }

  return {
    approved: true,
    rejections: [],
    quote: {
      borrowAssets: formatFixed(borrow),
      collateralAssets: formatFixed(collateral),
      conservativeMarkPrice: formatFixed(conservativeMark),
      entryDepthAssets: formatFixed(totalAskDepth),
      estimatedOutcomeShares: formatFixed(entry.shares),
      feeAssets: formatFixed(fee),
      leverageBps,
      leverageMultiplier: formatBpsMultiplier(leverageBps),
      liquidationPrice: formatFixed(liquidationPrice),
      mandatoryCloseAt: new Date(input.policy.mandatoryCloseAtMs).toISOString(),
      notionalAssets: formatFixed(notional),
      openingPrice: formatFixed(openingPrice),
      orderBookObservedAt: new Date(input.provider.observedAtMs).toISOString(),
      quoteExpiresAt: new Date(
        Math.min(input.nowMs + QUOTE_TTL_MS, input.policy.mandatoryCloseAtMs),
      ).toISOString(),
      side: input.request.side,
      spreadBps,
      tokenId: input.provider.tokenId,
      twapPrice: formatFixed(twapPrice),
    },
  };
}

function validateEligibility(
  input: MarginRiskInput,
  reject: (code: MarginRiskRejectionCode, message: string) => void,
) {
  if (input.policy.status !== "APPROVED") {
    reject(
      "MARKET_NOT_APPROVED",
      input.policy.status === "PAUSED"
        ? "Margin is paused for this market."
        : "This market has not been manually approved for production margin.",
    );
  }
  if (input.market.status !== "ACTIVE") {
    reject("MARKET_NOT_ACTIVE", "The market is not active.");
  }
  if (!input.market.acceptingOrders || !input.market.orderBookEnabled) {
    reject("ORDERBOOK_DISABLED", "The market is not accepting CLOB orders.");
  }
  if (!input.provider.operational) {
    reject("PROVIDER_OUTAGE", "Live orderbook or price history is unavailable.");
  }
  if (!input.market.conditionId || !conditionIdPattern.test(input.market.conditionId)) {
    reject("INVALID_CONDITION_ID", "The market condition id is missing or malformed.");
  }
  if (!validTokenId(input.market.yesTokenId) || !validTokenId(input.market.noTokenId)) {
    reject("INVALID_TOKEN_IDS", "Both YES and NO token ids must be valid decimal identifiers.");
  } else if (input.market.yesTokenId === input.market.noTokenId) {
    reject("INVALID_TOKEN_IDS", "YES and NO token ids must be different.");
  }

  const expectedToken =
    input.request.side === "YES" ? input.market.yesTokenId : input.market.noTokenId;
  if (expectedToken !== input.provider.tokenId) {
    reject("INVALID_TOKEN_IDS", "The orderbook token does not match the requested outcome.");
  }

  if (
    !input.market.tickSize ||
    !input.provider.tickSize ||
    !supportedTickSizes.has(input.market.tickSize) ||
    input.market.tickSize !== input.provider.tickSize
  ) {
    reject("INVALID_TICK_SIZE", "Market and orderbook tick sizes do not match.");
  }
  if (
    input.market.negativeRisk === null ||
    input.provider.negativeRisk === null ||
    input.market.negativeRisk !== input.policy.expectedNegativeRisk ||
    input.provider.negativeRisk !== input.policy.expectedNegativeRisk
  ) {
    reject("NEGATIVE_RISK_MISMATCH", "Neg-risk metadata does not match the approved policy.");
  }

  if (!validPolicy(input)) {
    reject("INVALID_POLICY", "The approved margin policy is internally inconsistent.");
  }

  const maximumAgeMs = input.policy.maxPriceAgeSeconds * 1000;
  if (
    input.market.syncedAtMs === null ||
    input.nowMs - input.market.syncedAtMs > maximumAgeMs ||
    input.market.syncedAtMs - input.nowMs > 5_000
  ) {
    reject("STALE_MARKET", "Stored market metadata is stale.");
  }
  if (
    input.nowMs - input.provider.observedAtMs > maximumAgeMs ||
    input.provider.observedAtMs - input.nowMs > 5_000
  ) {
    reject("ORDERBOOK_STALE", "The live orderbook snapshot is stale.");
  }
  if (
    input.nowMs >= input.policy.mandatoryCloseAtMs ||
    input.nowMs >= input.policy.earliestResolutionAtMs
  ) {
    reject("EVENT_TOO_CLOSE", "The mandatory close window has started.");
  }
}

function validPolicy(input: MarginRiskInput) {
  const policy = input.policy;
  const marketResolution = input.market.resolutionAtMs;

  return (
    Number.isInteger(policy.maxLeverageBps) &&
    policy.maxLeverageBps > Number(BPS) &&
    policy.maxLeverageBps <= HARD_MAX_LEVERAGE_BPS &&
    policy.maintenanceMarginBps > 0 &&
    policy.maintenanceMarginBps < Number(BPS) &&
    policy.feeBps >= 0 &&
    policy.feeBps <= 1_000 &&
    policy.maxSpreadBps > 0 &&
    policy.maxSpreadBps <= 2_000 &&
    policy.maxTwapDeviationBps > 0 &&
    policy.maxTwapDeviationBps <= 3_000 &&
    policy.maxPriceAgeSeconds >= 5 &&
    policy.maxPriceAgeSeconds <= 300 &&
    policy.closeBufferSeconds >= 300 &&
    policy.earliestResolutionAtMs > input.nowMs &&
    policy.mandatoryCloseAtMs <= policy.earliestResolutionAtMs - policy.closeBufferSeconds * 1000 &&
    (marketResolution === null || policy.earliestResolutionAtMs <= marketResolution)
  );
}

function validTokenId(value: string | null) {
  return Boolean(value && tokenIdPattern.test(value) && BigInt(value) > 0n);
}

function parseLevels(levels: MarginOrderBookLevel[], order: "asc" | "desc") {
  const parsed = levels
    .map((level) => ({ price: parsePrice(level.price), size: parseFixed(level.size) }))
    .filter((level) => level.price > 0n && level.price < ASSET_SCALE && level.size > 0n)
    .sort((left, right) => {
      if (left.price === right.price) return 0;
      const comparison = left.price < right.price ? -1 : 1;
      return order === "asc" ? comparison : -comparison;
    });

  if (parsed.length === 0) throw new Error("empty orderbook");
  return parsed;
}

function consumeAssets(levels: ParsedLevel[], targetAssets: bigint) {
  let remaining = targetAssets;
  let shares = 0n;
  let assets = 0n;

  for (const level of levels) {
    if (remaining <= 0n) break;
    const levelAssets = mulDiv(level.size, level.price, ASSET_SCALE);
    if (levelAssets <= remaining) {
      shares += level.size;
      assets += levelAssets;
      remaining -= levelAssets;
      continue;
    }

    const levelShares = min(level.size, mulDivUp(remaining, ASSET_SCALE, level.price));
    const consumed = mulDivUp(levelShares, level.price, ASSET_SCALE);
    shares += levelShares;
    assets += consumed;
    remaining = consumed >= remaining ? 0n : remaining - consumed;
  }

  return { assets, complete: remaining === 0n, shares };
}

function consumeShares(levels: ParsedLevel[], targetShares: bigint) {
  let remaining = targetShares;
  let assets = 0n;

  for (const level of levels) {
    if (remaining <= 0n) break;
    const shares = min(level.size, remaining);
    assets += mulDiv(shares, level.price, ASSET_SCALE);
    remaining -= shares;
  }

  return { assets, complete: remaining === 0n };
}

function sumAssetDepth(levels: ParsedLevel[]) {
  return levels.reduce((total, level) => total + mulDiv(level.size, level.price, ASSET_SCALE), 0n);
}

export function parseFixed(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) throw new Error("invalid decimal");
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole!) * ASSET_SCALE + BigInt(fraction.padEnd(6, "0"));
}

export function formatFixed(value: bigint) {
  const whole = value / ASSET_SCALE;
  const fraction = (value % ASSET_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function parsePrice(value: string) {
  const parsed = parseFixed(value);
  if (parsed <= 0n || parsed >= ASSET_SCALE) throw new Error("invalid price");
  return parsed;
}

function formatBpsMultiplier(leverageBps: number) {
  const whole = Math.floor(leverageBps / Number(BPS));
  const fraction = String(leverageBps % Number(BPS))
    .padStart(4, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}x` : `${whole}x`;
}

function mulDiv(x: bigint, y: bigint, denominator: bigint) {
  if (denominator <= 0n) throw new Error("invalid denominator");
  return (x * y) / denominator;
}

function mulDivUp(x: bigint, y: bigint, denominator: bigint) {
  const product = x * y;
  return product === 0n ? 0n : (product - 1n) / denominator + 1n;
}

function min(left: bigint, right: bigint) {
  return left < right ? left : right;
}

function abs(value: bigint) {
  return value < 0n ? -value : value;
}
