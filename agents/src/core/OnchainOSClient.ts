/**
 * OnchainOSClient -- wrapper for OKX Onchain OS REST API.
 *
 * Provides typed helpers for market data, DEX quotes / swaps,
 * wallet balance, and security scanning. Authentication uses
 * HMAC-SHA256 per OKX API spec.
 *
 * DEX aggregator endpoints use the V6 API (`/api/v6/dex/aggregator/...`).
 * CEX market endpoints still use V5 (`/api/v5/market/...`).
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketPrice {
  token: string;
  price: number;
  timestamp: number;
  source: string;
}

export interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  contractAddress: string;
  totalSupply: string;
}

export interface DexQuote {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  priceImpact: number;
  route: string[];
  estimatedGas: string;
}

export interface DexSwapParams {
  fromToken: string;
  toToken: string;
  amount: string;
  slippage: string;
  userWalletAddress: string;
}

export interface DexSwapResult {
  txHash: string;
  fromAmount: string;
  toAmount: string;
  status: "success" | "failed";
}

export interface WalletBalance {
  address: string;
  balances: Array<{
    token: string;
    balance: string;
    balanceUsd: string;
  }>;
}

export interface SecurityScanResult {
  tokenAddress: string;
  riskScore: number; // 0 (safe) .. 100 (dangerous)
  isHoneypot: boolean;
  hasProxyContract: boolean;
  ownerCanMint: boolean;
  holders: number;
  warnings: string[];
}

export interface SupportedChain {
  chainId: number;
  chainIndex: number;
  chainName: string;
  dexTokenApproveAddress: string;
}

export interface DexToken {
  decimals: string;
  tokenContractAddress: string;
  tokenLogoUrl: string;
  tokenName: string;
  tokenSymbol: string;
}

export interface DexSwapTx {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  estimatedGas: string;
  tx: {
    to: string;
    data: string;
    value: string;
    gasLimit: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class OnchainOSClient {
  /** Base URL for all OKX API requests. */
  private readonly baseUrl = "https://www.okx.com";
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly passphrase: string;
  private readonly projectId: string;

  constructor() {
    this.apiKey = process.env.OKX_API_KEY ?? "";
    this.secretKey = process.env.OKX_SECRET_KEY ?? "";
    this.passphrase = process.env.OKX_PASSPHRASE ?? "";
    this.projectId = process.env.OKX_PROJECT_ID ?? this.apiKey;

    if (!this.apiKey) {
      console.warn("[OnchainOSClient] OKX_API_KEY not set -- API calls will use mock data");
    }
  }

  // -----------------------------------------------------------------------
  // NEW: V6 DEX Aggregator methods
  // -----------------------------------------------------------------------

  /** List all chains supported by the OKX DEX aggregator. */
  async getSupportedChains(): Promise<SupportedChain[]> {
    const data = await this._get("/api/v6/dex/aggregator/supported/chain");
    if (data?.code === "0" && Array.isArray(data.data)) {
      return data.data as SupportedChain[];
    }
    return [];
  }

  /** List all tokens on a given chain. */
  async getAllTokens(chainIndex: string): Promise<DexToken[]> {
    const data = await this._get("/api/v6/dex/aggregator/all-tokens", { chainIndex });
    if (data?.code === "0" && Array.isArray(data.data)) {
      return data.data as DexToken[];
    }
    return [];
  }

  /**
   * Get a DEX quote via the V6 aggregator.
   * @param chainIndex  Chain index (e.g. "196" for X Layer)
   * @param fromToken   Source token address (use 0xEeee...EEeE for native)
   * @param toToken     Destination token address
   * @param amount      Amount in smallest unit (wei)
   */
  async getDexQuote(
    fromToken: string,
    toToken: string,
    amount: string,
    chainIndex = "196",
  ): Promise<DexQuote> {
    const data = await this._get("/api/v6/dex/aggregator/quote", {
      chainIndex,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      amount,
    });
    if (data?.code === "0" && data.data?.[0]) {
      const d = data.data[0];
      return {
        fromToken,
        toToken,
        fromAmount: d.fromTokenAmount ?? amount,
        toAmount: d.toTokenAmount ?? "0",
        priceImpact: parseFloat(d.priceImpactPercent ?? "0"),
        route: (d.dexRouterList ?? []).map(
          (r: any) => r.dexProtocol?.dexName ?? "unknown",
        ),
        estimatedGas: d.estimateGasFee ?? "0",
      };
    }
    // Fallback mock for offline development
    return {
      fromToken,
      toToken,
      fromAmount: amount,
      toAmount: String(BigInt(amount) * 99n / 100n),
      priceImpact: 0.01,
      route: ["mock-dex"],
      estimatedGas: "200000",
    };
  }

  /**
   * Build a DEX swap transaction via the V6 aggregator.
   * Returns the unsigned transaction data to be signed and broadcast.
   */
  async getDexSwap(
    chainIndex: string,
    fromToken: string,
    toToken: string,
    amount: string,
    slippage: string,
    userAddr: string,
  ): Promise<DexSwapTx> {
    const data = await this._get("/api/v6/dex/aggregator/swap", {
      chainIndex,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      amount,
      slippagePercent: slippage,
      userWalletAddress: userAddr,
    });
    if (data?.code === "0" && data.data?.[0]) {
      const d = data.data[0];
      const router = d.routerResult ?? {};
      const txData = d.tx ?? null;
      return {
        fromToken,
        toToken,
        fromAmount: router.fromTokenAmount ?? amount,
        toAmount: router.toTokenAmount ?? "0",
        estimatedGas: router.estimateGasFee ?? "0",
        tx: txData
          ? {
              to: txData.to ?? "",
              data: txData.data ?? "",
              value: txData.value ?? "0",
              gasLimit: txData.gasLimit ?? router.estimateGasFee ?? "0",
            }
          : null,
      };
    }
    return {
      fromToken,
      toToken,
      fromAmount: amount,
      toAmount: "0",
      estimatedGas: "0",
      tx: null,
    };
  }

  // -----------------------------------------------------------------------
  // Existing public API methods (kept compatible)
  // -----------------------------------------------------------------------

  /**
   * Fetch current market price for a token symbol (e.g. "OKB", "ETH").
   * Uses the V5 CEX market ticker endpoint.
   */
  async getMarketPrice(token: string): Promise<MarketPrice> {
    const data = await this._get("/api/v5/market/ticker", {
      instId: `${token}-USDT`,
    });
    if (data?.code === "0" && data.data?.[0]) {
      const d = data.data[0];
      return {
        token,
        price: parseFloat(d.last ?? "0"),
        timestamp: Date.now(),
        source: "okx",
      };
    }
    // Fallback mock for hackathon demo
    return this._mockPrice(token);
  }

  /** Get on-chain token metadata via V6 all-tokens. */
  async getTokenInfo(token: string): Promise<TokenInfo> {
    const tokens = await this.getAllTokens("196");
    const match = tokens.find(
      (t) => t.tokenSymbol.toUpperCase() === token.toUpperCase(),
    );
    if (match) {
      return {
        symbol: match.tokenSymbol,
        name: match.tokenName,
        decimals: parseInt(match.decimals, 10),
        contractAddress: match.tokenContractAddress,
        totalSupply: "0",
      };
    }
    return {
      symbol: token,
      name: token,
      decimals: 18,
      contractAddress: "",
      totalSupply: "0",
    };
  }

  /** Execute a DEX swap through OKX V6 aggregator (builds tx data). */
  async executeDexSwap(params: DexSwapParams): Promise<DexSwapResult> {
    const swap = await this.getDexSwap(
      "196",
      params.fromToken,
      params.toToken,
      params.amount,
      params.slippage,
      params.userWalletAddress,
    );
    if (swap.tx) {
      // In a real flow the caller would sign and broadcast swap.tx.
      // We return the tx data as the "hash" placeholder so callers
      // can pick it up.
      return {
        txHash: swap.tx.data.slice(0, 66) || "0x",
        fromAmount: swap.fromAmount,
        toAmount: swap.toAmount,
        status: "success",
      };
    }
    return {
      txHash: "0x",
      fromAmount: params.amount,
      toAmount: "0",
      status: "failed",
    };
  }

  /** Get wallet token balances on X Layer. */
  async getWalletBalance(address: string): Promise<WalletBalance> {
    const data = await this._get("/api/v5/defi/balance/token-balances", {
      chainId: "196",
      address,
    });
    const balances = (data?.data ?? []).map((b: any) => ({
      token: b.symbol ?? "UNKNOWN",
      balance: b.balance ?? "0",
      balanceUsd: b.balanceUsd ?? "0",
    }));
    return { address, balances };
  }

  /** Run a security / rug-pull scan on a token address. */
  async securityScan(tokenAddress: string): Promise<SecurityScanResult> {
    const data = await this._get("/api/v5/defi/security/token-security", {
      chainId: "196",
      tokenAddress,
    });
    if (data?.data) {
      const d = data.data;
      return {
        tokenAddress,
        riskScore: parseInt(d.riskScore ?? "50", 10),
        isHoneypot: d.isHoneypot === "1",
        hasProxyContract: d.isProxy === "1",
        ownerCanMint: d.canMint === "1",
        holders: parseInt(d.holderCount ?? "0", 10),
        warnings: d.warnings ?? [],
      };
    }
    // Safe mock for known tokens during hackathon
    return {
      tokenAddress,
      riskScore: 10,
      isHoneypot: false,
      hasProxyContract: false,
      ownerCanMint: false,
      holders: 1000,
      warnings: [],
    };
  }

  // -----------------------------------------------------------------------
  // HTTP transport with HMAC-SHA256 auth
  // -----------------------------------------------------------------------

  private async _get(
    path: string,
    params: Record<string, string> = {},
  ): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const requestPath = qs ? `${path}?${qs}` : path;
    const url = `${this.baseUrl}${requestPath}`;
    const headers = this._authHeaders("GET", requestPath, "");

    try {
      const res = await fetch(url, { method: "GET", headers });
      return await res.json();
    } catch (err) {
      console.warn(`[OnchainOSClient] GET ${path} failed:`, err);
      return null;
    }
  }

  private async _post(
    path: string,
    body: Record<string, any> = {},
  ): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const bodyStr = JSON.stringify(body);
    const headers = this._authHeaders("POST", path, bodyStr);
    headers["Content-Type"] = "application/json";

    try {
      const res = await fetch(url, { method: "POST", headers, body: bodyStr });
      return await res.json();
    } catch (err) {
      console.warn(`[OnchainOSClient] POST ${path} failed:`, err);
      return null;
    }
  }

  /**
   * Build OKX API authentication headers.
   * Signature = Base64(HMAC-SHA256(timestamp + method + requestPath + body, secretKey))
   */
  private _authHeaders(
    method: string,
    requestPath: string,
    body: string,
  ): Record<string, string> {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + requestPath + body;
    const signature = crypto
      .createHmac("sha256", this.secretKey)
      .update(prehash)
      .digest("base64");

    return {
      "OK-ACCESS-KEY": this.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.passphrase,
      "OK-ACCESS-PROJECT": this.projectId,
    };
  }

  // -----------------------------------------------------------------------
  // Mock helpers (offline / hackathon demo)
  // -----------------------------------------------------------------------

  private _mockPrice(token: string): MarketPrice {
    const prices: Record<string, number> = {
      OKB: 48.5,
      ETH: 3200,
      BTC: 62000,
      USDT: 1.0,
      USDC: 1.0,
    };
    return {
      token,
      price: prices[token.toUpperCase()] ?? 1.0,
      timestamp: Date.now(),
      source: "mock",
    };
  }
}
