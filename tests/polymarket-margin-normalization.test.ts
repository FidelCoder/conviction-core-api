import assert from "node:assert/strict";
import test from "node:test";

import { PolymarketMarginExecutionState } from "@prisma/client";

import { normalizePolymarketMarginExecution } from "../src/services/polymarket-margin-execution.js";

test("exposes safe stage instructions without returning execution credentials", () => {
  const now = new Date("2026-07-20T00:00:00.000Z");
  const normalized = normalizePolymarketMarginExecution({
    id: "execution-id",
    positionId: "position-id",
    idempotencyKey: "idempotency-key",
    state: PolymarketMarginExecutionState.WALLET_COMMIT_REQUIRED,
    conditionId: `0x${"1".repeat(64)}`,
    tokenId: "123",
    vaultAddress: `0x${"2".repeat(40)}`,
    adapterAddress: `0x${"3".repeat(40)}`,
    loanId: `0x${"4".repeat(64)}`,
    custodyAddress: `0x${"5".repeat(40)}`,
    depositWalletAddress: `0x${"6".repeat(40)}`,
    clobOrderId: null,
    clobTradeIds: null,
    settlementTxHashes: null,
    actualFillPrice: null,
    actualShares: null,
    actualSpentAssets: null,
    actualFeeAssets: null,
    requestPayload: { borrowAssets: "1", financingFeeAssets: "0.01" },
    responsePayload: {
      stage: "execution_wallet_commit_required",
      walletCall: { chainId: 137, to: `0x${"2".repeat(40)}`, value: "0", data: "0x1234" },
    },
    failureCode: null,
    failureMessage: null,
    reservedAt: now,
    orderSubmittedAt: null,
    fillConfirmedAt: null,
    securedAt: null,
    openedAt: null,
    closingAt: null,
    closedAt: null,
    lastReconciledAt: now,
    createdAt: now,
    updatedAt: now,
    sessionSignerCiphertext: "must-not-leak",
    clobCredentialsCiphertext: "must-not-leak",
  } as Parameters<typeof normalizePolymarketMarginExecution>[0] & {
    sessionSignerCiphertext: string;
    clobCredentialsCiphertext: string;
  });

  assert.deepEqual(normalized.authorizedTerms, {
    borrowAssets: "1",
    financingFeeAssets: "0.01",
  });
  assert.deepEqual(normalized.stageInstruction, {
    stage: "execution_wallet_commit_required",
    walletCall: { chainId: 137, to: `0x${"2".repeat(40)}`, value: "0", data: "0x1234" },
  });
  assert.equal("sessionSignerCiphertext" in normalized, false);
  assert.equal("clobCredentialsCiphertext" in normalized, false);
});
