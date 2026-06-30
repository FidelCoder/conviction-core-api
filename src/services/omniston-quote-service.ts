import {
  Omniston,
  type AssetId,
  type Quote,
  type QuoteRequest,
  type SettlementParams,
} from "@ston-fi/omniston-sdk";

export type OmnistonQuoteConfig = {
  enabled: boolean;
  network: "mainnet" | "testnet";
  routingMode: "disabled" | "quote_only" | "swap_intent";
  apiUrl: string;
  quoteTimeoutMs: number;
};

export type OmnistonQuoteInput = {
  fromAsset: string;
  toAsset: string;
  amountUnits: string;
};

export type OmnistonQuoteResult = {
  quote: Quote;
  inputSymbol: string;
  outputSymbol: string;
  settlement: "swap" | "order";
};

export function getOmnistonQuoteStatus(config: OmnistonQuoteConfig) {
  const quoteReady = config.enabled && config.routingMode === "quote_only";
  return {
    enabled: config.enabled,
    network: config.network,
    routingMode: config.routingMode,
    apiUrl: config.apiUrl,
    quoteTimeoutMs: config.quoteTimeoutMs,
    quoteReady,
    swapSubmissionEnabled: false,
    status: quoteReady ? "QUOTE_ONLY_READY" : "DISABLED",
    notes: [
      quoteReady
        ? "Quote-only routing is ready. The bot can request Omniston quotes."
        : "Set OMNISTON_ENABLED=true and OMNISTON_ROUTING_MODE=quote_only, then redeploy core.",
      "This path never builds, signs, or submits wallet transactions.",
    ],
  };
}

export class OmnistonQuoteService {
  constructor(private readonly config: OmnistonQuoteConfig) {}

  isQuoteEnabled() {
    return this.config.enabled && this.config.routingMode === "quote_only";
  }

  async requestQuote(input: OmnistonQuoteInput): Promise<OmnistonQuoteResult> {
    if (!this.isQuoteEnabled()) {
      throw new OmnistonQuoteDisabledError();
    }

    const inputAsset = parseTonAsset(input.fromAsset);
    const outputAsset = parseTonAsset(input.toAsset);

    if (inputAsset.symbol === outputAsset.symbol && inputAsset.raw === outputAsset.raw) {
      throw new OmnistonQuoteInputError("Input and output assets must be different.");
    }

    if (!integerUnitsPattern.test(input.amountUnits) || BigInt(input.amountUnits) <= 0n) {
      throw new OmnistonQuoteInputError(
        "Amount must be positive integer units. Example: 1000000 for 1 USDT with 6 decimals.",
      );
    }

    const omniston = new Omniston({ apiUrl: this.config.apiUrl });

    try {
      const quote = await firstQuote(
        omniston,
        {
          inputAsset: inputAsset.assetId,
          outputAsset: outputAsset.assetId,
          amount: {
            $case: "inputUnits",
            value: input.amountUnits,
          },
          settlementParams: quoteOnlySettlementParams,
        },
        this.config.quoteTimeoutMs,
      );

      return {
        quote,
        inputSymbol: inputAsset.symbol,
        outputSymbol: outputAsset.symbol,
        settlement: quote.settlementData.$case,
      };
    } finally {
      omniston.transport.close();
    }
  }
}

export class OmnistonQuoteDisabledError extends Error {
  constructor() {
    super("Omniston quote routing is disabled.");
  }
}

export class OmnistonQuoteInputError extends Error {}

export class OmnistonNoQuoteError extends Error {
  constructor() {
    super("No Omniston quote is currently available for that pair and amount.");
  }
}

export class OmnistonQuoteTimeoutError extends Error {
  constructor() {
    super("Omniston quote request timed out before a quote was returned.");
  }
}

const integerUnitsPattern = /^(?:0|[1-9]\d*)$/;

const tonAssets: Record<string, { symbol: string; raw: string; assetId: AssetId }> = {
  TON: {
    symbol: "TON",
    raw: "native",
    assetId: {
      chain: {
        $case: "ton",
        value: {
          kind: {
            $case: "native",
            value: {},
          },
        },
      },
    },
  },
  USDT: {
    symbol: "USDT",
    raw: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
    assetId: tonJetton("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"),
  },
  STON: {
    symbol: "STON",
    raw: "EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO",
    assetId: tonJetton("EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO"),
  },
};

const quoteOnlySettlementParams: SettlementParams[] = [
  {
    params: {
      $case: "swap",
      value: {
        maxPriceSlippagePips: 10_000,
        flexibleIntegratorFee: true,
      },
    },
  },
  {
    params: {
      $case: "order",
      value: {},
    },
  },
];

function parseTonAsset(value: string) {
  const normalized = value.trim();
  const symbol = normalized.toUpperCase();

  if (tonAssets[symbol]) {
    return tonAssets[symbol];
  }

  if (!normalized) {
    throw new OmnistonQuoteInputError("Asset cannot be empty.");
  }

  return {
    symbol: shortAsset(normalized),
    raw: normalized,
    assetId: tonJetton(normalized),
  };
}

function tonJetton(address: string): AssetId {
  return {
    chain: {
      $case: "ton",
      value: {
        kind: {
          $case: "jetton",
          value: address,
        },
      },
    },
  };
}

function firstQuote(omniston: Omniston, request: QuoteRequest, timeoutMs: number) {
  return new Promise<Quote>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;

      clearTimeout(timeout);
      subscription.unsubscribe();
      callback();
    };

    const subscription = omniston.requestForQuote(request).subscribe({
      next(event) {
        if (!event || settled) {
          return;
        }

        if (event.$case === "quoteUpdated") {
          settle(() => resolve(event.value));
          return;
        }

        if (event.$case === "noQuote") {
          settle(() => reject(new OmnistonNoQuoteError()));
        }
      },
      error(error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      },
    });

    const timeout = setTimeout(() => {
      settle(() => reject(new OmnistonQuoteTimeoutError()));
    }, timeoutMs);
  });
}

function shortAsset(value: string) {
  if (value.length <= 12) {
    return value;
  }

  return value.slice(0, 6) + "..." + value.slice(-4);
}
