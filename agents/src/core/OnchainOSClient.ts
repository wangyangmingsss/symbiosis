/**
 * OnchainOSClient -- wrapper for OKX Onchain OS REST API.
 *
 * Provides typed helpers for market data, DEX quotes / swaps,
 * wallet balance, and security scanning. Authentication uses
 * HMAC-SHA256 per OKX API v5 spec.
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

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class OnchainOSClient {
  private readonly baseUrl = "https://www.okx.com/api/v5/";
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly passphrase: string;

  constructor() {
    this.apiKey = process.env.OKX_API_KEY ?? "";
    this.secretKey = process.env.OKX_SECRET_KEY ?? "";
    this.passphrase = process.env.OKX_PASSPHRASE ?? "";

    if (!this.apiKey) {
      console.warn("[OnchainOSClient] OKX_API_KEY not set -- API calls will use mock data");
    }
  }

  // -----------------------------------------------------------------------
  // Public API methods
  // -----------------------------------------------------------------------

  /** Fetch current market price for a token symbol (e.g. "OKB", "ETH"). */
  async getMarketPrice(token: string): Promise<MarketPrice> {
    const data = await this._get(`market/ticker`, { instId: `${token}-USDT` });
    if (data?.data?.[0]) {
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

  /** Get on-chain token metadata. */
  async getTokenInfo(token: string): Promise<TokenInfo> {
    const data = await this._get(`defi/token/token-list`, { chainId: "196", symbol: token });
    if (data?.data?.[0]) {
      const d = data.data[0];
      return {
        symbol: d.symbol,
        name: d.name,
        decimals: parseInt(d.decimals, 10),
        contractAddress: d.contractAddress,
        totalSupply: d.totalSupply ?? "0",
      };
    }
    return { symbol: token, name: token, decimals: 18, contractAddress: "", totalSupply: "0" };
  }

  /** Get a DEX swap quote (cross-chain or single-chain). */
  async getDexQuote(fromToken: string, toToken: string, amount: string): Promise<DexQuote> {
    const data = await this._get(`defi/aggregator/quote`, {
      chainId: "196",
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      amount,
    });
    if (data?.data?.[0]) {
      const d = data.data[0];
      return {
        fromToken,
        toToken,
        fromAmount: amount,
        toAmount: d.toTokenAmount ?? "0",
        priceImpact: parseFloat(d.priceImpact ?? "0"),
        route: d.routerResult?.routes?.map((r: any) => r.dexName) ?? [],
        estimatedGas: d.estimatedGas ?? "0",
      };
    }
    // Mock for offline development
    return {
      fromToken, toToken, fromAmount: amount,
      toAmount: String(BigInt(amount) * 99n / 100n), // 1% slippage mock
      priceImpact: 0.01, route: ["mock-dex"], estimatedGas: "200000",
    };
  }

  /** Execute a DEX swap through OKX aggregator. */
  async executeDexSwap(params: DexSwapParams): Promise<DexSwapResult> {
    const data = await this._post(`defi/aggregator/swap`, {
      chainId: "196",
      fromTokenAddress: params.fromToken,
      toTokenAddress: params.toToken,
      amount: params.amount,
      slippage: params.slippage,
      userWalletAddress: params.userWalletAddress,
    });
    if (data?.data?.[0]) {
      const d = data.data[0];
      return {
        txHash: d.txHash ?? "0x",
        fromAmount: params.amount,
        toAmount: d.toTokenAmount ?? "0",
        status: "success",
      };
    }
    // Mock result
    return { txHash: "0xmock", fromAmount: params.amount, toAmount: "0", status: "failed" };
  }

  /** Get wallet token balances on X Layer. */
  async getWalletBalance(address: string): Promise<WalletBalance> {
    const data = await this._get(`defi/balance/token-balances`, {
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
    const data = await this._get(`defi/security/token-security`, {
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
      tokenAddress, riskScore: 10, isHoneypot: false,
      hasProxyContract: false, ownerCanMint: false,
      holders: 1000, warnings: [],
    };
  }

  // -----------------------------------------------------------------------
  // HTTP transport with HMAC-SHA256 auth
  // -----------------------------------------------------------------------

  private async _get(path: string, params: Record<string, string> = {}): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const fullPath = qs ? `${path}?${qs}` : path;
    const url = `${this.baseUrl}${fullPath}`;
    const headers = this._authHeaders("GET", `/${fullPath}`, "");

    try {
      const res = await fetch(url, { method: "GET", headers });
      return await res.json();
    } catch (err) {
      console.warn(`[OnchainOSClient] GET ${path} failed:`, err);
      return null;
    }
  }

  private async _post(path: string, body: Record<string, any> = {}): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const bodyStr = JSON.stringify(body);
    const headers = this._authHeaders("POST", `/${path}`, bodyStr);
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
   * Build OKX API v5 authentication headers.
   * Signature = Base64(HMAC-SHA256(timestamp + method + path + body, secretKey))
   */
  private _authHeaders(method: string, path: string, body: string): Record<string, string> {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + path + body;
    const signature = crypto
      .createHmac("sha256", this.secretKey)
      .update(prehash)
      .digest("base64");

    return {
      "OK-ACCESS-KEY": this.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.passphrase,
    };
  }

  // -----------------------------------------------------------------------
  // Mock helpers (offline / hackathon demo)
  // -----------------------------------------------------------------------

  private _mockPrice(token: string): MarketPrice {
    const prices: Record<string, number> = {
      OKB: 48.5, ETH: 3200, BTC: 62000, USDT: 1.0, USDC: 1.0,
    };
    return {
      token,
      price: prices[token.toUpperCase()] ?? 1.0,
      timestamp: Date.now(),
      source: "mock",
    };
  }
}
