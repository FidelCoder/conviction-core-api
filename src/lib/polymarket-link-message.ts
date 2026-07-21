import { PolymarketChallengePurpose, PolymarketWalletType } from "@prisma/client";

export function buildPolymarketAccountMessage(input: {
  purpose: PolymarketChallengePurpose;
  userId: string;
  convictionAddress: string;
  convictionChainId: number;
  polymarketOwnerAddress: string;
  polymarketFunderAddress: string;
  polymarketWalletType: PolymarketWalletType;
  nonce: string;
  expiresAt: Date;
}) {
  const action =
    input.purpose === PolymarketChallengePurpose.LINK
      ? "Link Polymarket account"
      : "Disconnect Polymarket account";

  return [
    "Conviction Markets",
    action,
    "Domain: convictionmarkets.xyz",
    "Conviction user: " + input.userId,
    "Conviction wallet: " + input.convictionAddress,
    "Conviction chain: " + input.convictionChainId,
    "Polymarket owner: " + input.polymarketOwnerAddress,
    "Polymarket funder: " + input.polymarketFunderAddress,
    "Polymarket wallet type: " + input.polymarketWalletType,
    "Nonce: " + input.nonce,
    "Expires: " + input.expiresAt.toISOString(),
    "",
    "Signing proves account control. It does not authorize a trade or token transfer.",
  ].join("\n");
}

export function buildPolymarketAuthMessage(input: {
  ownerAddress: string;
  funderAddress: string;
  walletType: PolymarketWalletType;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}) {
  return [
    "Conviction Markets",
    "Sign in with Polymarket",
    "Domain: convictionmarkets.xyz",
    "URI: https://convictionmarkets.xyz",
    "Polygon chain: 137",
    "Polymarket owner: " + input.ownerAddress,
    "Polymarket funder: " + input.funderAddress,
    "Polymarket wallet type: " + input.walletType,
    "Nonce: " + input.nonce,
    "Issued at: " + input.issuedAt.toISOString(),
    "Expires: " + input.expiresAt.toISOString(),
    "",
    "Signing opens a Conviction session for this wallet.",
    "It does not authorize a trade, token transfer, allowance, or API credential.",
  ].join("\n");
}
