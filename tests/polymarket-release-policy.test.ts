import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePolymarketReleaseCaps,
  selectEffectivePolymarketPositionCap,
} from "../src/services/polymarket-release-policy.js";

const unit = 1_000_000n;

function healthyInput() {
  return {
    accountLinked: true,
    allowedMarket: true,
    allowedWallet: true,
    borrowAssets: 10n * unit,
    dailyLossAssets: 0n,
    dailyLossLimitAssets: 25n * unit,
    leverageBps: 20_000,
    maxLeverageBps: 20_000,
    maxPositionAssets: 25n * unit,
    maxTvlAssets: 1_000n * unit,
    maxUtilizationBps: 5_000,
    notionalAssets: 20n * unit,
    paused: false,
    totalAssets: 1_000n * unit,
    totalBorrowedAssets: 100n * unit,
    totalReservedAssets: 50n * unit,
    uncoveredBadDebt: 0n,
  };
}

test("accepts an invited linked account inside every release cap", () => {
  assert.deepEqual(evaluatePolymarketReleaseCaps(healthyInput()), []);
});

test("fails closed across identity, market, leverage, loss, vault, and utilization gates", () => {
  const rejections = evaluatePolymarketReleaseCaps({
    ...healthyInput(),
    accountLinked: false,
    allowedMarket: false,
    allowedWallet: false,
    dailyLossAssets: 25n * unit,
    leverageBps: 20_001,
    notionalAssets: 26n * unit,
    paused: true,
    totalAssets: 1_001n * unit,
    totalBorrowedAssets: 900n * unit,
    uncoveredBadDebt: 1n,
  });

  assert.equal(rejections.length, 10);
  assert.ok(rejections.includes("Wallet is not invited to the execution canary."));
  assert.ok(rejections.includes("Canary wallet has no verified linked Polymarket account."));
  assert.ok(rejections.includes("Market is outside the canary market allowlist."));
  assert.ok(rejections.includes("Requested leverage exceeds the release leverage cap."));
  assert.ok(rejections.includes("Position notional exceeds the release position cap."));
  assert.ok(rejections.includes("Vault TVL exceeds the configured release cap."));
  assert.ok(rejections.includes("Polygon vault is paused for new risk."));
  assert.ok(rejections.includes("Vault reports uncovered bad debt."));
  assert.ok(rejections.includes("Daily realized-loss limit has been reached."));
  assert.ok(rejections.includes("Projected vault utilization exceeds the release cap."));
});

test("allows the exact utilization boundary and rejects one unit above it", () => {
  const atBoundary = healthyInput();
  atBoundary.totalBorrowedAssets = 490n * unit;
  atBoundary.totalReservedAssets = 0n;
  assert.deepEqual(evaluatePolymarketReleaseCaps(atBoundary), []);

  const aboveBoundary = { ...atBoundary, borrowAssets: 10n * unit + 100_000n };
  assert.deepEqual(evaluatePolymarketReleaseCaps(aboveBoundary), [
    "Projected vault utilization exceeds the release cap.",
  ]);
});

test("blocks new borrowing when no LP assets exist", () => {
  assert.deepEqual(evaluatePolymarketReleaseCaps({ ...healthyInput(), totalAssets: 0n }), [
    "Vault has no LP assets available for margin.",
  ]);
});

test("reports the smaller canary cap until the canary is explicitly passed", () => {
  assert.equal(selectEffectivePolymarketPositionCap(true, 5n * unit, 25n * unit), 5n * unit);
  assert.equal(selectEffectivePolymarketPositionCap(false, 5n * unit, 25n * unit), 25n * unit);
  assert.equal(selectEffectivePolymarketPositionCap(true, 50n * unit, 25n * unit), 25n * unit);
});
