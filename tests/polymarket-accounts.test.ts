import assert from "node:assert/strict";
import test from "node:test";

import { PolymarketChallengePurpose, PolymarketWalletType } from "@prisma/client";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { decryptJson, encryptJson } from "../src/lib/credentials.js";
import { buildPolymarketAccountMessage } from "../src/lib/polymarket-link-message.js";
import { assertPolymarketChallengeState } from "../src/services/polymarket-accounts.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

test("credential envelopes round-trip without exposing plaintext", () => {
  const credentials = {
    apiKey: "api-key",
    secret: "api-secret",
    passphrase: "passphrase",
  };
  const encrypted = encryptJson(credentials, encryptionKey);

  assert.equal(encrypted.includes(credentials.secret), false);
  assert.deepEqual(decryptJson(encrypted, encryptionKey), credentials);
});

test("credential envelopes reject a different encryption key", () => {
  const encrypted = encryptJson({ secret: "sensitive" }, encryptionKey);
  const wrongKey = Buffer.alloc(32, 8).toString("base64");

  assert.throws(() => decryptJson(encrypted, wrongKey));
});

test("link message binds both accounts, chain, nonce, and expiry", () => {
  const expiresAt = new Date("2026-07-20T12:00:00.000Z");
  const message = buildPolymarketAccountMessage({
    purpose: PolymarketChallengePurpose.LINK,
    userId: "conviction-user-id",
    convictionAddress: "0x1111111111111111111111111111111111111111",
    convictionChainId: 8453,
    polymarketOwnerAddress: "0x2222222222222222222222222222222222222222",
    polymarketFunderAddress: "0x3333333333333333333333333333333333333333",
    polymarketWalletType: PolymarketWalletType.GNOSIS_SAFE,
    nonce: "unique-nonce",
    expiresAt,
  });

  assert.match(message, /Link Polymarket account/);
  assert.match(message, /conviction-user-id/);
  assert.match(message, /8453/);
  assert.match(message, /unique-nonce/);
  assert.match(message, /2026-07-20T12:00:00.000Z/);
  assert.match(message, /does not authorize a trade or token transfer/);
});

test("a link signature cannot be replayed across a different domain or user", async () => {
  const account = privateKeyToAccount(
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  );
  const message = buildPolymarketAccountMessage({
    purpose: PolymarketChallengePurpose.LINK,
    userId: "conviction-user-id",
    convictionAddress: account.address,
    convictionChainId: 8453,
    polymarketOwnerAddress: account.address,
    polymarketFunderAddress: account.address,
    polymarketWalletType: PolymarketWalletType.EOA,
    nonce: "unique-nonce",
    expiresAt: new Date("2026-07-20T12:00:00.000Z"),
  });
  const signature = await account.signMessage({ message });

  assert.equal(await verifyMessage({ address: account.address, message, signature }), true);
  assert.equal(
    await verifyMessage({
      address: account.address,
      message: message.replace("convictionmarkets.xyz", "attacker.example"),
      signature,
    }),
    false,
  );
  assert.equal(
    await verifyMessage({
      address: account.address,
      message: message.replace("conviction-user-id", "different-user-id"),
      signature,
    }),
    false,
  );
});

test("unused challenges remain valid before expiry", () => {
  assert.doesNotThrow(() =>
    assertPolymarketChallengeState(
      {
        consumedAt: null,
        expiresAt: new Date("2026-07-20T12:10:00.000Z"),
      },
      new Date("2026-07-20T12:00:00.000Z"),
    ),
  );
});

test("consumed challenges are rejected as replay attempts", () => {
  assert.throws(
    () =>
      assertPolymarketChallengeState({
        consumedAt: new Date("2026-07-20T12:00:00.000Z"),
        expiresAt: new Date("2026-07-20T12:10:00.000Z"),
      }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "POLYMARKET_CHALLENGE_USED",
  );
});

test("expired challenges are rejected", () => {
  assert.throws(
    () =>
      assertPolymarketChallengeState(
        { consumedAt: null, expiresAt: new Date("2026-07-20T12:00:00.000Z") },
        new Date("2026-07-20T12:00:00.000Z"),
      ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "POLYMARKET_CHALLENGE_EXPIRED",
  );
});
