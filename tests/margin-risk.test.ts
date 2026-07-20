import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMarginRisk,
  formatFixed,
  parseFixed,
  type MarginRiskInput,
  type MarginRiskRejectionCode,
} from "../src/services/margin-risk.js";

const nowMs = 1_800_000_000_000;

function baseInput(): MarginRiskInput {
  return {
    nowMs,
    market: {
      acceptingOrders: true,
      conditionId: "0x" + "1".repeat(64),
      negativeRisk: false,
      noTokenId: "456",
      orderBookEnabled: true,
      resolutionAtMs: nowMs + 7 * 24 * 60 * 60 * 1000,
      status: "ACTIVE",
      syncedAtMs: nowMs - 5_000,
      tickSize: "0.01",
      yesTokenId: "123",
    },
    policy: {
      closeBufferSeconds: 24 * 60 * 60,
      earliestResolutionAtMs: nowMs + 6 * 24 * 60 * 60 * 1000,
      expectedNegativeRisk: false,
      feeBps: 100,
      maintenanceMarginBps: 3_000,
      mandatoryCloseAtMs: nowMs + 5 * 24 * 60 * 60 * 1000,
      maxAccountBorrowAssets: "500",
      maxCategoryBorrowAssets: "2000",
      maxLeverageBps: 20_000,
      maxMarketBorrowAssets: "1000",
      maxPriceAgeSeconds: 30,
      maxSpreadBps: 500,
      maxTwapDeviationBps: 1_000,
      maxVaultBorrowAssets: "5000",
      minimumDepthAssets: "100",
      status: "APPROVED",
    },
    provider: {
      asks: [{ price: "0.50", size: "1000" }],
      bids: [{ price: "0.49", size: "1000" }],
      negativeRisk: false,
      observedAtMs: nowMs - 2_000,
      operational: true,
      tickSize: "0.01",
      tokenId: "123",
      twapPrice: "0.495",
    },
    request: {
      collateralAssets: "100",
      leverageBps: 20_000,
      side: "YES",
    },
    exposure: {
      accountBorrowAssets: "0",
      categoryBorrowAssets: "0",
      marketBorrowAssets: "0",
      vaultBorrowAssets: "0",
    },
  };
}

test("returns a complete deterministic 2x margin quote from executable depth", () => {
  const decision = evaluateMarginRisk(baseInput());

  assert.equal(decision.approved, true);
  if (!decision.approved) return;
  assert.deepEqual(decision.rejections, []);
  assert.equal(decision.quote.collateralAssets, "100");
  assert.equal(decision.quote.borrowAssets, "100");
  assert.equal(decision.quote.notionalAssets, "200");
  assert.equal(decision.quote.estimatedOutcomeShares, "400");
  assert.equal(decision.quote.openingPrice, "0.5");
  assert.equal(decision.quote.conservativeMarkPrice, "0.49");
  assert.equal(decision.quote.liquidationPrice, "0.357143");
  assert.equal(decision.quote.feeAssets, "2");
  assert.equal(decision.quote.leverageMultiplier, "2x");
  assert.equal(
    decision.quote.mandatoryCloseAt,
    new Date(baseInput().policy.mandatoryCloseAtMs).toISOString(),
  );
});

test("rejects leverage above the market limit and the hard 3x ceiling", () => {
  const marketLimit = baseInput();
  marketLimit.request.leverageBps = 25_000;
  assertRejected(marketLimit, "LEVERAGE_LIMIT");

  const universalTenX = baseInput();
  universalTenX.policy.maxLeverageBps = 30_000;
  universalTenX.request.leverageBps = 100_000;
  assertRejected(universalTenX, "LEVERAGE_LIMIT");
});

test("allows an explicitly configured 3x market when initial health remains sufficient", () => {
  const input = baseInput();
  input.policy.maxLeverageBps = 30_000;
  input.request.leverageBps = 30_000;
  const decision = evaluateMarginRisk(input);

  assert.equal(decision.approved, true);
  if (decision.approved) {
    assert.equal(decision.quote.borrowAssets, "200");
    assert.equal(decision.quote.leverageMultiplier, "3x");
  }
});

test("prices the NO outcome from its own token orderbook", () => {
  const input = baseInput();
  input.request.side = "NO";
  input.provider.tokenId = input.market.noTokenId!;
  const decision = evaluateMarginRisk(input);

  assert.equal(decision.approved, true);
  if (decision.approved) assert.equal(decision.quote.tokenId, "456");
});

test("rejects missing condition and outcome-token metadata", () => {
  const input = baseInput();
  input.market.conditionId = null;
  input.market.noTokenId = input.market.yesTokenId;

  assertRejected(input, "INVALID_CONDITION_ID");
  assertRejected(input, "INVALID_TOKEN_IDS");
});

test("rejects stale stored markets and stale orderbooks", () => {
  const input = baseInput();
  input.market.syncedAtMs = nowMs - 31_000;
  input.provider.observedAtMs = nowMs - 31_000;

  assertRejected(input, "STALE_MARKET");
  assertRejected(input, "ORDERBOOK_STALE");
});

test("rejects thin entry and exit depth", () => {
  const input = baseInput();
  input.provider.asks = [{ price: "0.50", size: "100" }];
  input.provider.bids = [{ price: "0.49", size: "100" }];

  assertRejected(input, "LOW_ENTRY_DEPTH");
  assertRejected(input, "LOW_EXIT_DEPTH");
});

test("rejects quotes after the mandatory close time", () => {
  const input = baseInput();
  input.nowMs = input.policy.mandatoryCloseAtMs;

  assertRejected(input, "EVENT_TOO_CLOSE");
});

test("rejects paused policies and provider outages", () => {
  const paused = baseInput();
  paused.policy.status = "PAUSED";
  assertRejected(paused, "MARKET_NOT_APPROVED");

  const outage = baseInput();
  outage.provider.operational = false;
  assertRejected(outage, "PROVIDER_OUTAGE");
});

test("rejects neg-risk and tick-size mismatches", () => {
  const input = baseInput();
  input.provider.negativeRisk = true;
  input.provider.tickSize = "0.001";

  assertRejected(input, "NEGATIVE_RISK_MISMATCH");
  assertRejected(input, "INVALID_TICK_SIZE");
});

test("rejects excessive spread and TWAP deviation", () => {
  const input = baseInput();
  input.provider.asks = [{ price: "0.60", size: "1000" }];
  input.provider.bids = [{ price: "0.40", size: "1000" }];
  input.provider.twapPrice = "0.45";

  assertRejected(input, "SPREAD_TOO_WIDE");
  assertRejected(input, "PRICE_DEVIATION");
});

test("rejects market, account, category, and vault exposure breaches", () => {
  const input = baseInput();
  input.exposure.marketBorrowAssets = "901";
  input.exposure.accountBorrowAssets = "401";
  input.exposure.categoryBorrowAssets = "1901";
  input.exposure.vaultBorrowAssets = "4901";

  assertRejected(input, "MARKET_EXPOSURE_CAP");
  assertRejected(input, "ACCOUNT_EXPOSURE_CAP");
  assertRejected(input, "CATEGORY_EXPOSURE_CAP");
  assertRejected(input, "VAULT_EXPOSURE_CAP");
});

test("fixed-point helpers reject excess precision and round-trip pUSD units", () => {
  assert.equal(parseFixed("123.456789"), 123_456_789n);
  assert.equal(formatFixed(123_456_789n), "123.456789");
  assert.throws(() => parseFixed("1.0000001"));
  assert.throws(() => parseFixed("-1"));
});

function assertRejected(input: MarginRiskInput, code: MarginRiskRejectionCode) {
  const decision = evaluateMarginRisk(input);
  assert.equal(decision.approved, false);
  assert.ok(
    decision.rejections.some((rejection) => rejection.code === code),
    `expected ${code}, received ${decision.rejections.map((entry) => entry.code).join(", ")}`,
  );
}
