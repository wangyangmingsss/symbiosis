/**
 * AgenticWalletClient -- OKX Agentic Wallet integration for SYMBIOSIS.
 *
 * Wraps the OKX Agentic Wallet (TEE-secured) lifecycle:
 *   - Email OTP authentication
 *   - Wallet creation & address retrieval
 *   - Balance queries (EVM + Solana)
 *   - Transaction signing via TEE (keys never leave enclave)
 *   - Portfolio aggregation
 *   - Transaction history
 *
 * All signing happens inside the Trusted Execution Environment.
 * Private keys are generated and stored entirely within the TEE —
 * never exposed to anyone, including the AI Agent.
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletAuth {
  email: string;
  sessionToken: string;
  expiresAt: number;
}

export interface WalletAddress {
  chain: "evm" | "solana";
  address: string;
  chainId?: number;
}

export interface WalletBalance {
  chain: string;
  address: string;
  nativeBalance: string;
  nativeSymbol: string;
  tokens: TokenBalance[];
  totalValueUsd: number;
}

export interface TokenBalance {
  symbol: string;
  name: string;
  contractAddress: string;
  balance: string;
  decimals: number;
  priceUsd: number;
  valueUsd: number;
}

export interface TxRequest {
  chainId: number;
  to: string;
  value: string;
  data: string;
  gasLimit?: string;
  gasPrice?: string;
}

export interface TxResult {
  txHash: string;
  status: "pending" | "confirmed" | "failed";
  blockNumber?: number;
  gasUsed?: string;
  timestamp?: number;
}

export interface PortfolioSummary {
  totalValueUsd: number;
  chains: { chain: string; valueUsd: number; percentage: number }[];
  topTokens: { symbol: string; valueUsd: number; percentage: number }[];
  pnl24h: number;
  pnlPercentage24h: number;
}

export interface TxHistoryEntry {
  txHash: string;
  chain: string;
  from: string;
  to: string;
  value: string;
  method: string;
  timestamp: number;
  status: "confirmed" | "failed";
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  baseUrl: "https://www.okx.com",
  walletApiPath: "/api/v5/waas",
  chainId: 195, // X Layer mainnet; 1952 for testnet
  timeout: 30_000,
};

// ---------------------------------------------------------------------------
// AgenticWalletClient
// ---------------------------------------------------------------------------

export class AgenticWalletClient {
  private apiKey: string;
  private secretKey: string;
  private passphrase: string;
  private baseUrl: string;
  private walletApiPath: string;
  private chainId: number;
  private timeout: number;

  private auth: WalletAuth | null = null;
  private addresses: WalletAddress[] = [];
  private _actionsLog: string[] = [];

  constructor(opts: {
    apiKey: string;
    secretKey: string;
    passphrase: string;
    baseUrl?: string;
    chainId?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.secretKey = opts.secretKey;
    this.passphrase = opts.passphrase;
    this.baseUrl = opts.baseUrl ?? DEFAULT_CONFIG.baseUrl;
    this.walletApiPath = DEFAULT_CONFIG.walletApiPath;
    this.chainId = opts.chainId ?? DEFAULT_CONFIG.chainId;
    this.timeout = DEFAULT_CONFIG.timeout;
  }

  // -------------------------------------------------------------------------
  // HMAC Auth (same pattern as OnchainOSClient)
  // -------------------------------------------------------------------------

  private sign(timestamp: string, method: string, path: string, body: string): string {
    const prehash = timestamp + method.toUpperCase() + path + body;
    return crypto.createHmac("sha256", this.secretKey).update(prehash).digest("base64");
  }

  private headers(method: string, path: string, body = ""): Record<string, string> {
    const ts = new Date().toISOString();
    return {
      "OK-ACCESS-KEY": this.apiKey,
      "OK-ACCESS-SIGN": this.sign(ts, method, path, body),
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": this.passphrase,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const bodyStr = body ? JSON.stringify(body) : "";
    const url = this.baseUrl + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const resp = await fetch(url, {
        method,
        headers: this.headers(method, path, bodyStr),
        body: method === "GET" ? undefined : bodyStr,
        signal: controller.signal,
      });
      const data = (await resp.json()) as any;
      if (data.code && data.code !== "0") {
        throw new Error(`Wallet API error ${data.code}: ${data.msg || JSON.stringify(data)}`);
      }
      return data.data ?? data;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Authentication: Email OTP Flow
  // -------------------------------------------------------------------------

  /**
   * Step 1: Request OTP code sent to email.
   * User must provide the OTP to complete login.
   */
  async requestEmailOtp(email: string): Promise<{ success: boolean; message: string }> {
    this.log(`Requesting OTP for ${email}`);
    const resp = await this.request<any>("POST", `${this.walletApiPath}/auth/otp`, {
      email,
      type: "login",
    });
    return { success: true, message: `OTP sent to ${email}` };
  }

  /**
   * Step 2: Verify OTP and obtain session.
   * On first login, wallet is auto-created with EVM + Solana addresses.
   */
  async verifyOtp(email: string, otp: string): Promise<WalletAuth> {
    this.log(`Verifying OTP for ${email}`);
    const resp = await this.request<any>("POST", `${this.walletApiPath}/auth/verify`, {
      email,
      otp,
    });
    this.auth = {
      email,
      sessionToken: resp.sessionToken || resp.token,
      expiresAt: Date.now() + 3600_000, // 1h default
    };
    // Auto-fetch addresses after auth
    await this.fetchAddresses();
    return this.auth;
  }

  // -------------------------------------------------------------------------
  // Wallet Address Management
  // -------------------------------------------------------------------------

  async fetchAddresses(): Promise<WalletAddress[]> {
    this.log("Fetching wallet addresses");
    const resp = await this.request<any>("GET", `${this.walletApiPath}/wallet/addresses`);
    this.addresses = (resp.addresses || []).map((a: any) => ({
      chain: a.chain || "evm",
      address: a.address,
      chainId: a.chainId,
    }));
    return this.addresses;
  }

  getEvmAddress(): string | null {
    const evm = this.addresses.find((a) => a.chain === "evm");
    return evm?.address ?? null;
  }

  getSolanaAddress(): string | null {
    const sol = this.addresses.find((a) => a.chain === "solana");
    return sol?.address ?? null;
  }

  // -------------------------------------------------------------------------
  // Balance & Portfolio
  // -------------------------------------------------------------------------

  async getBalance(chainId?: number): Promise<WalletBalance> {
    const cid = chainId ?? this.chainId;
    const addr = this.getEvmAddress();
    this.log(`Querying balance for ${addr} on chain ${cid}`);
    return this.request<WalletBalance>(
      "GET",
      `${this.walletApiPath}/wallet/balance?chainId=${cid}&address=${addr}`
    );
  }

  async getPortfolio(): Promise<PortfolioSummary> {
    this.log("Fetching portfolio summary");
    return this.request<PortfolioSummary>("GET", `${this.walletApiPath}/wallet/portfolio`);
  }

  // -------------------------------------------------------------------------
  // Transaction Signing (TEE)
  // -------------------------------------------------------------------------

  /**
   * Submit a transaction to be signed inside the TEE.
   * The private key never leaves the enclave.
   */
  async signAndBroadcast(tx: TxRequest): Promise<TxResult> {
    this.log(`Signing TX → ${tx.to} value=${tx.value} on chain ${tx.chainId}`);
    const resp = await this.request<TxResult>("POST", `${this.walletApiPath}/wallet/send`, {
      chainId: tx.chainId || this.chainId,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      gasLimit: tx.gasLimit,
      gasPrice: tx.gasPrice,
    });
    this.log(`TX broadcast: ${resp.txHash}`);
    return resp;
  }

  /**
   * Call a smart contract method via TEE-signed transaction.
   */
  async contractCall(opts: {
    contractAddress: string;
    abi: any[];
    method: string;
    args: any[];
    value?: string;
    chainId?: number;
  }): Promise<TxResult> {
    const iface = new (await import("ethers")).Interface(opts.abi);
    const data = iface.encodeFunctionData(opts.method, opts.args);
    return this.signAndBroadcast({
      chainId: opts.chainId ?? this.chainId,
      to: opts.contractAddress,
      value: opts.value ?? "0",
      data,
    });
  }

  // -------------------------------------------------------------------------
  // Transaction History
  // -------------------------------------------------------------------------

  async getTxHistory(opts?: {
    chainId?: number;
    limit?: number;
    cursor?: string;
  }): Promise<TxHistoryEntry[]> {
    const cid = opts?.chainId ?? this.chainId;
    const limit = opts?.limit ?? 20;
    const addr = this.getEvmAddress();
    let path = `${this.walletApiPath}/wallet/transactions?chainId=${cid}&address=${addr}&limit=${limit}`;
    if (opts?.cursor) path += `&cursor=${opts.cursor}`;
    return this.request<TxHistoryEntry[]>("GET", path);
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  isAuthenticated(): boolean {
    return this.auth !== null && Date.now() < (this.auth.expiresAt ?? 0);
  }

  getActionLog(): string[] {
    return [...this._actionsLog];
  }

  private log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    this._actionsLog.push(`[${ts}] ${msg}`);
  }
}
