export const polymarketExecutionStates = [
  "AUTHORIZED",
  "RESERVED",
  "WALLET_DEPLOYING",
  "FUNDED",
  "ORDER_PREPARED",
  "ORDER_SUBMITTED",
  "FILL_CONFIRMED",
  "SECURED",
  "OPEN",
  "CLOSING",
  "CLOSED",
  "CANCELLED",
  "FAILED",
  "RECONCILIATION_REQUIRED",
] as const;

export type PolymarketExecutionState = (typeof polymarketExecutionStates)[number];

const allowedTransitions: Record<PolymarketExecutionState, readonly PolymarketExecutionState[]> = {
  AUTHORIZED: ["RESERVED", "CANCELLED", "FAILED"],
  RESERVED: ["WALLET_DEPLOYING", "CANCELLED", "FAILED"],
  WALLET_DEPLOYING: ["FUNDED", "FAILED", "RECONCILIATION_REQUIRED"],
  FUNDED: ["ORDER_PREPARED", "FAILED", "RECONCILIATION_REQUIRED"],
  ORDER_PREPARED: ["ORDER_SUBMITTED", "FAILED", "RECONCILIATION_REQUIRED"],
  ORDER_SUBMITTED: ["FILL_CONFIRMED", "FAILED", "RECONCILIATION_REQUIRED"],
  FILL_CONFIRMED: ["SECURED", "RECONCILIATION_REQUIRED"],
  SECURED: ["OPEN", "RECONCILIATION_REQUIRED"],
  OPEN: ["CLOSING", "RECONCILIATION_REQUIRED"],
  CLOSING: ["CLOSED", "RECONCILIATION_REQUIRED"],
  RECONCILIATION_REQUIRED: [
    "RESERVED",
    "WALLET_DEPLOYING",
    "FUNDED",
    "ORDER_PREPARED",
    "ORDER_SUBMITTED",
    "FILL_CONFIRMED",
    "SECURED",
    "OPEN",
    "CLOSING",
    "CLOSED",
    "CANCELLED",
    "FAILED",
  ],
  CLOSED: [],
  CANCELLED: [],
  FAILED: [],
};

const terminalStates = new Set<PolymarketExecutionState>(["CLOSED", "CANCELLED", "FAILED"]);

export function canTransitionPolymarketExecution(
  current: PolymarketExecutionState,
  next: PolymarketExecutionState,
) {
  return current === next || allowedTransitions[current].includes(next);
}

export function assertPolymarketExecutionTransition(
  current: PolymarketExecutionState,
  next: PolymarketExecutionState,
) {
  if (!canTransitionPolymarketExecution(current, next)) {
    throw new Error(`Invalid Polymarket execution transition: ${current} -> ${next}`);
  }
}

export function isTerminalPolymarketExecutionState(state: PolymarketExecutionState) {
  return terminalStates.has(state);
}

export type FokPostDisposition = "SUBMITTED" | "NO_FILL" | "DUPLICATE" | "RECONCILE";

export function classifyFokPostResult(input: {
  success?: boolean;
  status?: string | null;
  error?: string | null;
}): FokPostDisposition {
  const status = input.status?.trim().toLowerCase() ?? "";
  const error = input.error?.trim().toLowerCase() ?? "";

  if (status === "unmatched" || error.includes("fok_order_not_filled_error")) {
    return "NO_FILL";
  }
  if (
    error.includes("already exists") ||
    error.includes("duplicate order") ||
    error.includes("order already")
  ) {
    return "DUPLICATE";
  }
  if (input.success === true && (status === "matched" || status === "delayed")) {
    return "SUBMITTED";
  }
  return "RECONCILE";
}

export function persistedOrderRecoveryState(input: {
  hasOrderId: boolean;
  hasSignedOrder: boolean;
  orderSubmittedAt: Date | null;
  hasConfirmedShares: boolean;
}): PolymarketExecutionState | null {
  if (input.hasConfirmedShares) return "FILL_CONFIRMED";
  if (input.hasSignedOrder && input.hasOrderId && !input.orderSubmittedAt) {
    return "ORDER_PREPARED";
  }
  if (input.hasOrderId && input.orderSubmittedAt) return "ORDER_SUBMITTED";
  if (input.hasSignedOrder) return "ORDER_PREPARED";
  return null;
}

const assetScale = 1_000_000n;
const bps = 10_000n;

export function parseSixDecimalAssets(value: string, field: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(`${field} must be a non-negative decimal with at most six decimal places`);
  }

  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * assetScale + BigInt(fraction.padEnd(6, "0"));
}

export function formatSixDecimalAssets(value: bigint) {
  if (value < 0n) throw new Error("Asset amount cannot be negative");
  const whole = value / assetScale;
  const fraction = (value % assetScale).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function calculateFokBuyPriceLimit(
  openingPrice: string,
  maxSlippageBps: number,
  tickSize: string,
) {
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 2_000) {
    throw new Error("maxSlippageBps must be an integer between 0 and 2000");
  }

  const opening = parseSixDecimalAssets(openingPrice, "openingPrice");
  const tick = parseSixDecimalAssets(tickSize, "tickSize");
  if (opening <= 0n || opening >= assetScale || tick <= 0n) {
    throw new Error("Opening price and tick size are outside the binary-market range");
  }

  const raw = divideUp(opening * (bps + BigInt(maxSlippageBps)), bps);
  const tickAligned = divideUp(raw, tick) * tick;
  const bounded = tickAligned >= assetScale ? assetScale - tick : tickAligned;
  if (bounded <= 0n || bounded >= assetScale) {
    throw new Error("Slippage limit leaves no valid execution price");
  }

  return formatSixDecimalAssets(bounded);
}

export function calculateFokSellPriceLimit(
  closingPrice: string,
  maxSlippageBps: number,
  tickSize: string,
) {
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 2_000) {
    throw new Error("maxSlippageBps must be an integer between 0 and 2000");
  }

  const closing = parseSixDecimalAssets(closingPrice, "closingPrice");
  const tick = parseSixDecimalAssets(tickSize, "tickSize");
  if (closing <= 0n || closing >= assetScale || tick <= 0n) {
    throw new Error("Closing price and tick size are outside the binary-market range");
  }

  const raw = (closing * (bps - BigInt(maxSlippageBps))) / bps;
  const tickAligned = (raw / tick) * tick;
  const bounded = tickAligned < tick ? tick : tickAligned;
  if (bounded <= 0n || bounded >= assetScale) {
    throw new Error("Slippage limit leaves no valid closing price");
  }

  return formatSixDecimalAssets(bounded);
}

export type ClobTradeEvidence = {
  id: string;
  price: string;
  size: string;
  feeRateBps: string;
  transactionHash?: string | null;
};

export function summarizeClobTrades(trades: readonly ClobTradeEvidence[]) {
  if (trades.length === 0) throw new Error("At least one confirmed trade is required");

  let shares = 0n;
  let spent = 0n;
  let fees = 0n;
  const tradeIds = new Set<string>();
  const transactionHashes = new Set<string>();

  for (const trade of trades) {
    if (!trade.id || tradeIds.has(trade.id)) continue;
    const size = parseSixDecimalAssets(trade.size, "trade.size");
    const price = parseSixDecimalAssets(trade.price, "trade.price");
    if (size <= 0n || price <= 0n || price >= assetScale) {
      throw new Error("Trade evidence contains an invalid size or price");
    }

    const feeRate = BigInt(trade.feeRateBps || "0");
    if (feeRate < 0n || feeRate > bps) throw new Error("Trade fee rate is invalid");
    const tradeAssets = divideUp(size * price, assetScale);
    shares += size;
    spent += tradeAssets;
    fees += divideUp(size * price * (assetScale - price) * feeRate, assetScale * assetScale * bps);
    tradeIds.add(trade.id);
    if (trade.transactionHash) transactionHashes.add(trade.transactionHash.toLowerCase());
  }

  if (shares === 0n) throw new Error("Confirmed trade evidence contains no filled shares");

  return {
    actualFillPrice: formatSixDecimalAssets(divideUp(spent * assetScale, shares)),
    actualShares: formatSixDecimalAssets(shares),
    actualSpentAssets: formatSixDecimalAssets(spent),
    actualFeeAssets: formatSixDecimalAssets(fees),
    tradeIds: [...tradeIds],
    transactionHashes: [...transactionHashes],
  };
}

function divideUp(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) throw new Error("Denominator must be positive");
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}
