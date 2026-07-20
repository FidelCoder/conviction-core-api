import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPolymarketExecutionTransition,
  calculateFokBuyPriceLimit,
  calculateFokSellPriceLimit,
  canTransitionPolymarketExecution,
  classifyFokPostResult,
  formatSixDecimalAssets,
  isTerminalPolymarketExecutionState,
  parseSixDecimalAssets,
  persistedOrderRecoveryState,
  quoteFokSellFromBids,
  summarizeClobTrades,
} from "../src/services/polymarket-execution-state.js";

test("permits only explicit execution lifecycle transitions", () => {
  assert.equal(canTransitionPolymarketExecution("AUTHORIZED", "RESERVED"), true);
  assert.equal(
    canTransitionPolymarketExecution("WALLET_DEPLOYING", "WALLET_COMMIT_REQUIRED"),
    true,
  );
  assert.equal(
    canTransitionPolymarketExecution("WALLET_COMMIT_REQUIRED", "WALLET_COMMITTED"),
    true,
  );
  assert.equal(canTransitionPolymarketExecution("WALLET_COMMITTED", "FUNDED"), true);
  assert.equal(canTransitionPolymarketExecution("WALLET_COMMIT_REQUIRED", "FUNDED"), false);
  assert.equal(canTransitionPolymarketExecution("ORDER_PREPARED", "ORDER_SUBMITTED"), true);
  assert.equal(canTransitionPolymarketExecution("ORDER_PREPARED", "OPEN"), false);
  assert.equal(canTransitionPolymarketExecution("CLOSED", "OPEN"), false);
  assert.throws(
    () => assertPolymarketExecutionTransition("FILL_CONFIRMED", "OPEN"),
    /Invalid Polymarket execution transition/,
  );
});

test("recognizes only closed, cancelled, and failed records as terminal", () => {
  assert.equal(isTerminalPolymarketExecutionState("CLOSED"), true);
  assert.equal(isTerminalPolymarketExecutionState("RECONCILIATION_REQUIRED"), false);
  assert.equal(isTerminalPolymarketExecutionState("OPEN"), false);
});

test("parses and formats six-decimal pUSD and conditional-token amounts exactly", () => {
  assert.equal(parseSixDecimalAssets("89.990001", "amount"), 89_990_001n);
  assert.equal(formatSixDecimalAssets(89_990_001n), "89.990001");
  assert.equal(formatSixDecimalAssets(10_000_000n), "10");
  assert.throws(() => parseSixDecimalAssets("1.0000001", "amount"), /six decimal/);
});

test("rounds the FOK worst price upward to the market tick", () => {
  assert.equal(calculateFokBuyPriceLimit("0.501", 100, "0.01"), "0.51");
  assert.equal(calculateFokBuyPriceLimit("0.995", 2_000, "0.01"), "0.99");
});

test("rounds the FOK closing floor downward to the market tick", () => {
  assert.equal(calculateFokSellPriceLimit("0.501", 100, "0.01"), "0.49");
  assert.equal(calculateFokSellPriceLimit("0.004", 2_000, "0.01"), "0.01");
});

test("quotes a full-depth FOK close with conservative venue fees", () => {
  assert.deepEqual(
    quoteFokSellFromBids({
      amountShares: "100",
      bids: [
        { price: "0.6", size: "40" },
        { price: "0.55", size: "60" },
      ],
      builderFeeBps: 100,
      feeRateBps: 700,
      maxSlippageBps: 100,
      tickSize: "0.01",
    }),
    {
      depthFloorPrice: "0.55",
      estimatedGrossProceeds: "57",
      maximumVenueFeeAssets: "2.29",
      minimumProceeds: "51.71",
      priceLimit: "0.54",
    },
  );
});

test("rejects a close when live bids cannot fill every pledged share", () => {
  assert.throws(
    () =>
      quoteFokSellFromBids({
        amountShares: "100",
        bids: [{ price: "0.5", size: "99" }],
        builderFeeBps: 0,
        feeRateBps: 0,
        maxSlippageBps: 100,
        tickSize: "0.01",
      }),
    /cannot close the full position/,
  );
});

test("aggregates unique CLOB trades into exact fill evidence", () => {
  const summary = summarizeClobTrades([
    {
      id: "trade-1",
      price: "0.4",
      size: "100",
      feeRateBps: "100",
      transactionHash: "0xABC",
    },
    {
      id: "trade-2",
      price: "0.5",
      size: "100",
      feeRateBps: "100",
      transactionHash: "0xDEF",
    },
    {
      id: "trade-1",
      price: "0.4",
      size: "100",
      feeRateBps: "100",
      transactionHash: "0xABC",
    },
  ]);

  assert.deepEqual(summary, {
    actualFillPrice: "0.45",
    actualShares: "200",
    actualSpentAssets: "90",
    actualFeeAssets: "0.49",
    tradeIds: ["trade-1", "trade-2"],
    transactionHashes: ["0xabc", "0xdef"],
  });
});

test("classifies only explicit CLOB outcomes as submitted, duplicate, or no-fill", () => {
  assert.equal(classifyFokPostResult({ success: true, status: "matched" }), "SUBMITTED");
  assert.equal(classifyFokPostResult({ success: true, status: "delayed" }), "SUBMITTED");
  assert.equal(classifyFokPostResult({ success: false, status: "unmatched" }), "NO_FILL");
  assert.equal(classifyFokPostResult({ error: "FOK_ORDER_NOT_FILLED_ERROR" }), "NO_FILL");
  assert.equal(classifyFokPostResult({ error: "order already exists" }), "DUPLICATE");
  assert.equal(classifyFokPostResult({ error: "request timed out" }), "RECONCILE");
  assert.equal(classifyFokPostResult({ success: false, status: "matched" }), "RECONCILE");
});

test("reposts a persisted order only when submission evidence is absent", () => {
  assert.equal(
    persistedOrderRecoveryState({
      hasOrderId: true,
      hasSignedOrder: true,
      orderSubmittedAt: null,
      hasConfirmedShares: false,
    }),
    "ORDER_PREPARED",
  );
  assert.equal(
    persistedOrderRecoveryState({
      hasOrderId: true,
      hasSignedOrder: true,
      orderSubmittedAt: new Date(),
      hasConfirmedShares: false,
    }),
    "ORDER_SUBMITTED",
  );
  assert.equal(
    persistedOrderRecoveryState({
      hasOrderId: true,
      hasSignedOrder: true,
      orderSubmittedAt: null,
      hasConfirmedShares: true,
    }),
    "FILL_CONFIRMED",
  );
});
