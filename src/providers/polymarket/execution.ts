import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  getContractConfig,
  isV2Order,
  type ApiKeyCreds,
  type SignedOrder,
  type TickSize,
  type Trade,
} from "@polymarket/clob-client-v2";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  hashTypedData,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { z } from "zod";

import { env } from "../../config/env.js";

const relayerTransactionSchema = z
  .object({
    transactionID: z.string().min(1),
    transactionHash: z.string().nullable().optional(),
    proxyAddress: z.string().nullable().optional(),
    state: z.enum([
      "STATE_NEW",
      "STATE_EXECUTED",
      "STATE_MINED",
      "STATE_CONFIRMED",
      "STATE_INVALID",
      "STATE_FAILED",
    ]),
  })
  .passthrough();

const relayerSubmitSchema = z
  .object({
    transactionID: z.string().min(1),
    transactionHash: z.string().nullable().optional(),
    proxyAddress: z.string().nullable().optional(),
    state: z.string().optional(),
  })
  .passthrough();

const relayerNonceSchema = z.object({ nonce: z.union([z.string(), z.number()]).transform(String) });

const postOrderResponseSchema = z
  .object({
    success: z.boolean(),
    errorMsg: z.string().optional().default(""),
    orderID: z.string().min(1),
    status: z.string().min(1),
    takingAmount: z.union([z.string(), z.number()]).transform(String),
    makingAmount: z.union([z.string(), z.number()]).transform(String),
    transactionsHashes: z.array(z.string()).optional().default([]),
    tradeIDs: z.array(z.string()).optional().default([]),
  })
  .passthrough();

export type DepositWalletCall = {
  target: Address;
  value: string;
  data: Hex;
};

export type RelayerTransaction = z.infer<typeof relayerTransactionSchema>;

export function createPolymarketSessionAccount(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(env.polygonRpcUrl),
  });
  return { account, signer };
}

export class PolymarketClobExecutionClient {
  private readonly client: ClobClient;

  constructor(input: { privateKey: Hex; funderAddress: Address; credentials?: ApiKeyCreds }) {
    const { signer } = createPolymarketSessionAccount(input.privateKey);
    this.client = new ClobClient({
      host: env.polymarketClobApiUrl,
      chain: Chain.POLYGON,
      signer,
      creds: input.credentials,
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: input.funderAddress,
      builderConfig: env.polymarketBuilderCode
        ? { builderCode: env.polymarketBuilderCode }
        : undefined,
      retryOnError: false,
      throwOnError: true,
      useServerTime: true,
    });
  }

  createOrDeriveCredentials() {
    return this.client.createOrDeriveApiKey();
  }

  async prepareFokBuy(input: {
    amountAssets: string;
    negativeRisk: boolean;
    priceLimit: string;
    tickSize: TickSize;
    tokenId: string;
  }) {
    return this.client.createMarketOrder(
      {
        tokenID: input.tokenId,
        amount: exactSdkNumber(input.amountAssets, "amountAssets"),
        price: exactSdkNumber(input.priceLimit, "priceLimit"),
        side: Side.BUY,
        orderType: OrderType.FOK,
        ...(env.polymarketBuilderCode ? { builderCode: env.polymarketBuilderCode } : {}),
      },
      { tickSize: input.tickSize, negRisk: input.negativeRisk },
    );
  }

  async prepareFokSell(input: {
    amountShares: string;
    negativeRisk: boolean;
    priceLimit: string;
    tickSize: TickSize;
    tokenId: string;
  }) {
    return this.client.createMarketOrder(
      {
        tokenID: input.tokenId,
        amount: exactSdkNumber(input.amountShares, "amountShares"),
        price: exactSdkNumber(input.priceLimit, "priceLimit"),
        side: Side.SELL,
        orderType: OrderType.FOK,
        ...(env.polymarketBuilderCode ? { builderCode: env.polymarketBuilderCode } : {}),
      },
      { tickSize: input.tickSize, negRisk: input.negativeRisk },
    );
  }

  async postPreparedFokOrder(order: SignedOrder) {
    return postOrderResponseSchema.parse(await this.client.postOrder(order, OrderType.FOK));
  }

  getOrder(orderId: string) {
    return this.client.getOrder(orderId);
  }

  getTrades(input: { funderAddress: string; tokenId: string }): Promise<Trade[]> {
    return this.client.getTrades({
      maker_address: input.funderAddress,
      asset_id: input.tokenId,
    });
  }

  getFeeRateBps(tokenId: string) {
    return this.client.getFeeRateBps(tokenId);
  }

  async syncCollateralBalance() {
    await this.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  }

  async syncConditionalBalance(tokenId: string) {
    await this.client.updateBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
  }
}

export class PolymarketRelayerClient {
  private readonly builderConfig: BuilderConfig | null;

  constructor(private readonly privateKey: Hex) {
    this.builderConfig =
      env.polymarketBuilderApiKey &&
      env.polymarketBuilderApiSecret &&
      env.polymarketBuilderApiPassphrase
        ? new BuilderConfig({
            localBuilderCreds: {
              key: env.polymarketBuilderApiKey,
              secret: env.polymarketBuilderApiSecret,
              passphrase: env.polymarketBuilderApiPassphrase,
            },
          })
        : null;
  }

  async deployDepositWallet() {
    const { account } = createPolymarketSessionAccount(this.privateKey);
    if (!env.polymarketDepositWalletFactoryAddress) {
      throw new Error("POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS is missing");
    }

    return this.submit({
      type: "WALLET-CREATE",
      from: account.address,
      to: env.polymarketDepositWalletFactoryAddress,
    });
  }

  async executeDepositWalletBatch(
    walletAddress: Address,
    calls: readonly DepositWalletCall[],
    deadline: number,
  ) {
    if (!env.polymarketDepositWalletFactoryAddress) {
      throw new Error("POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS is missing");
    }
    if (!Number.isInteger(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
      throw new Error("Deposit-wallet batch deadline must be in the future");
    }

    const { account, signer } = createPolymarketSessionAccount(this.privateKey);
    const nonce = await this.getWalletNonce(account.address);
    const normalizedCalls = calls.map((call) => ({ ...call }));
    const signature = await signer.signTypedData({
      account,
      domain: {
        name: "DepositWallet",
        version: "1",
        chainId: polygon.id,
        verifyingContract: walletAddress,
      },
      primaryType: "Batch",
      types: {
        Call: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
        Batch: [
          { name: "wallet", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "calls", type: "Call[]" },
        ],
      },
      message: {
        wallet: walletAddress,
        nonce: BigInt(nonce),
        deadline: BigInt(deadline),
        calls: normalizedCalls.map((call) => ({
          target: call.target,
          value: BigInt(call.value),
          data: call.data,
        })),
      },
    });

    return this.submit({
      type: "WALLET",
      from: account.address,
      to: env.polymarketDepositWalletFactoryAddress,
      nonce,
      signature,
      depositWalletParams: {
        depositWallet: walletAddress,
        deadline: String(deadline),
        calls: normalizedCalls,
      },
    });
  }

  async getTransaction(transactionId: string) {
    const payload = await this.request(
      "GET",
      `/transaction?id=${encodeURIComponent(transactionId)}`,
    );
    const selected = Array.isArray(payload) ? payload[0] : payload;
    return relayerTransactionSchema.parse(selected);
  }

  async waitForConfirmation(transactionId: string, timeoutMs = 45_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const transaction = await this.getTransaction(transactionId);
      if (transaction.state === "STATE_CONFIRMED") return transaction;
      if (transaction.state === "STATE_FAILED" || transaction.state === "STATE_INVALID") {
        throw new Error(`Relayer transaction ${transactionId} ended in ${transaction.state}`);
      }
      await sleep(1_000);
    }
    throw new Error(`Relayer transaction ${transactionId} did not confirm before timeout`);
  }

  private async getWalletNonce(address: Address) {
    const payload = await this.request(
      "GET",
      `/nonce?address=${encodeURIComponent(address)}&type=WALLET`,
    );
    return relayerNonceSchema.parse(payload).nonce;
  }

  private async submit(body: unknown) {
    return relayerSubmitSchema.parse(await this.request("POST", "/submit", body));
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown) {
    const requestPath = path.split("?")[0]!;
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    const builderHeaders = this.builderConfig
      ? await this.builderConfig.generateBuilderHeaders(method, requestPath, bodyText)
      : undefined;
    const response = await fetch(new URL(path, `${env.polymarketRelayerApiUrl}/`), {
      method,
      headers: {
        Accept: "application/json",
        ...(bodyText ? { "Content-Type": "application/json" } : {}),
        ...(env.polymarketRelayerApiKey ? { RELAYER_API_KEY: env.polymarketRelayerApiKey } : {}),
        ...(env.polymarketRelayerApiKeyAddress
          ? { RELAYER_API_KEY_ADDRESS: env.polymarketRelayerApiKeyAddress }
          : {}),
        ...(builderHeaders ?? {}),
      },
      body: bodyText,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Polymarket relayer returned invalid JSON (${response.status})`);
    }
    if (!response.ok) {
      const message = extractProviderError(payload);
      throw new Error(`Polymarket relayer request failed (${response.status}): ${message}`);
    }
    return payload;
  }
}

export function buildDepositWalletApprovalCalls(input: {
  collateral: Address;
  conditionalTokens: Address;
  exchange: Address;
}): DepositWalletCall[] {
  return [
    {
      target: input.collateral,
      value: "0",
      data: encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "approve",
            stateMutability: "nonpayable",
            inputs: [
              { name: "spender", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ type: "bool" }],
          },
        ],
        functionName: "approve",
        args: [input.exchange, maxUint256],
      }),
    },
    {
      target: input.conditionalTokens,
      value: "0",
      data: encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "setApprovalForAll",
            stateMutability: "nonpayable",
            inputs: [
              { name: "operator", type: "address" },
              { name: "approved", type: "bool" },
            ],
            outputs: [],
          },
        ],
        functionName: "setApprovalForAll",
        args: [input.exchange, true],
      }),
    },
  ];
}

export function calculateClobV2OrderId(order: SignedOrder, negativeRisk: boolean) {
  if (!isV2Order(order)) throw new Error("Production execution requires a V2 signed order");
  const contracts = getContractConfig(Chain.POLYGON);
  return hashTypedData({
    domain: {
      name: "Polymarket CTF Exchange",
      version: "2",
      chainId: Chain.POLYGON,
      verifyingContract: (negativeRisk
        ? contracts.negRiskExchangeV2
        : contracts.exchangeV2) as Address,
    },
    primaryType: "Order",
    types: {
      Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "side", type: "uint8" },
        { name: "signatureType", type: "uint8" },
        { name: "timestamp", type: "uint256" },
        { name: "metadata", type: "bytes32" },
        { name: "builder", type: "bytes32" },
      ],
    },
    message: {
      salt: BigInt(order.salt),
      maker: order.maker as Address,
      signer: order.signer as Address,
      tokenId: BigInt(order.tokenId),
      makerAmount: BigInt(order.makerAmount),
      takerAmount: BigInt(order.takerAmount),
      side: order.side === Side.BUY ? 0 : 1,
      signatureType: order.signatureType,
      timestamp: BigInt(order.timestamp),
      metadata: order.metadata as Hex,
      builder: order.builder as Hex,
    },
  });
}

function exactSdkNumber(value: string, field: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(`${field} must have at most six decimal places`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000_000) {
    throw new Error(`${field} is outside the supported SDK range`);
  }
  return number;
}

function extractProviderError(payload: unknown) {
  if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    for (const key of ["error", "message", "errorMsg", "detail"]) {
      if (typeof object[key] === "string") return object[key].slice(0, 300);
    }
  }
  return "provider rejected the request";
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
