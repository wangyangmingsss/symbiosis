/**
 * DataProviderAgent -- fetches market data and publishes it on-chain.
 *
 * Cycle:
 *  1. Fetch market data for tracked tokens via OnchainOSClient
 *  2. Fetch 24h ticker stats (volume, high/low, change%) for primary token
 *  3. Monitor gas prices on X Layer
 *  4. Hash the data and record on-chain (proof of data freshness)
 *  5. List MARKET_DATA service on the marketplace with Dutch auction pricing
 *  6. Broadcast enriched snapshot to in-process EventBus for local consumers
 *  7. Every 5 cycles: take economy snapshot via contracts.oracle
 *  8. Periodically discover new tokens on X Layer and add them to tracking
 *  9. Check agent's own wallet balance for operational awareness
 * 10. Track data freshness, quality metrics, and total API calls
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient, MarketPrice } from "../core/OnchainOSClient.js";
import { globalBus } from "../core/EventBus.js";
import { AgentType } from "../config/contracts.js";

/** Tokens we track by default. */
const DEFAULT_TRACKED_TOKENS = ["OKB", "ETH", "BTC", "USDT"];

/** How often (in cycles) to run token discovery on X Layer. */
const TOKEN_DISCOVERY_INTERVAL = 10;

/** How often (in cycles) to take an economy snapshot via oracle. */
const ECONOMY_SNAPSHOT_INTERVAL = 5;

/** How often (in cycles) to check agent wallet balance. */
const WALLET_CHECK_INTERVAL = 3;

/** How much to charge for a market data snapshot (in wei). */
const START_PRICE = ethers.parseEther("0.001");
const FLOOR_PRICE = ethers.parseEther("0.0001");
const DECAY_RATE = ethers.parseEther("0.00001"); // per block

export interface MarketDataSnapshot {
  timestamp: number;
  prices: MarketPrice[];
  dataHash: string;
  ticker24h?: { volume: number; high: number; low: number; change: number };
  gasPrice?: string;
  xlayerTokenCount?: number;
  apiCallsThisCycle?: number;
}

/** Internal metrics for data quality tracking. */
interface DataQualityMetrics {
  totalCycles: number;
  successfulFetches: number;
  failedFetches: number;
  averageLatencyMs: number;
  lastSuccessTimestamp: number;
  stalePriceCount: number;
  totalApiCalls: number;
}

export class DataProviderAgent extends AgentBase {
  private readonly okx: OnchainOSClient;
  private currentListingId: bigint | null = null;

  /** Dynamic token list -- starts with defaults, grows via discovery. */
  private trackedTokens: string[] = [...DEFAULT_TRACKED_TOKENS];

  /** Running cycle counter for interval-based tasks. */
  private internalCycleCount = 0;

  /** Cached X Layer token count from last discovery run. */
  private xlayerTokenCount = 0;

  /** Data quality and freshness metrics. */
  private metrics: DataQualityMetrics = {
    totalCycles: 0,
    successfulFetches: 0,
    failedFetches: 0,
    averageLatencyMs: 0,
    lastSuccessTimestamp: 0,
    stalePriceCount: 0,
    totalApiCalls: 0,
  };

  /** Whether we are targeting testnet (chain 195) or mainnet (chain 196). */
  private readonly isTestnet: boolean;

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("DataProvider", AgentType.DataProvider, privateKey, provider);
    this.okx = new OnchainOSClient();

    // Detect testnet vs mainnet from RPC URL or default to testnet
    const rpcUrl = (provider as any)._getConnection?.()?.url ?? "";
    this.isTestnet = rpcUrl.includes("testnet") || rpcUrl.includes("195");
  }

  async runCycle(): Promise<void> {
    const cycleStart = Date.now();
    const apiCallsBefore = this.okx.apiCallCount;
    this.internalCycleCount++;
    this.metrics.totalCycles++;

    // -----------------------------------------------------------------
    // 1. Fetch market prices for all tracked tokens
    // -----------------------------------------------------------------
    this.log(`Fetching market data for ${this.trackedTokens.length} tokens...`);
    const prices = await this._fetchAllPrices();

    // -----------------------------------------------------------------
    // 2. Fetch 24h ticker stats for the primary token (OKB)
    // -----------------------------------------------------------------
    const ticker24h = await this._fetch24hTicker("OKB");

    // -----------------------------------------------------------------
    // 3. Fetch kline data for OKB (used for trend context in snapshot)
    // -----------------------------------------------------------------
    await this._fetchKlines("OKB");

    // -----------------------------------------------------------------
    // 4. Monitor gas price on X Layer
    // -----------------------------------------------------------------
    const gasPrice = await this._fetchGasPrice();

    // -----------------------------------------------------------------
    // 5. Periodically check agent's own wallet balance
    // -----------------------------------------------------------------
    if (this.internalCycleCount % WALLET_CHECK_INTERVAL === 0) {
      await this._checkWalletBalance();
    }

    // -----------------------------------------------------------------
    // 6. Periodically discover new tokens on X Layer
    // -----------------------------------------------------------------
    if (this.internalCycleCount % TOKEN_DISCOVERY_INTERVAL === 0) {
      await this._discoverXLayerTokens();
    }

    // -----------------------------------------------------------------
    // 7. Every 5 cycles, take an economy snapshot via contracts.oracle
    // -----------------------------------------------------------------
    if (this.internalCycleCount % ECONOMY_SNAPSHOT_INTERVAL === 0) {
      await this._takeEconomySnapshot();
    }

    // -----------------------------------------------------------------
    // 8. Build enriched snapshot, hash, and record on-chain
    // -----------------------------------------------------------------
    const apiCallsThisCycle = this.okx.apiCallCount - apiCallsBefore;
    this.metrics.totalApiCalls = this.okx.apiCallCount;

    const snapshot: MarketDataSnapshot = {
      timestamp: Date.now(),
      prices,
      dataHash: "",
      ticker24h,
      gasPrice,
      xlayerTokenCount: this.xlayerTokenCount,
      apiCallsThisCycle,
    };

    const encoded = ethers.toUtf8Bytes(JSON.stringify(snapshot));
    snapshot.dataHash = ethers.keccak256(encoded);

    this.log(`Data hash: ${snapshot.dataHash}`);

    // -----------------------------------------------------------------
    // 9. List MARKET_DATA service (Dutch auction) if not already listed
    // -----------------------------------------------------------------
    if (this.currentListingId === null) {
      await this._listMarketDataService();
    }

    // -----------------------------------------------------------------
    // 10. Broadcast to local agents via EventBus
    // -----------------------------------------------------------------
    await globalBus.emit("market:data", snapshot);

    // -----------------------------------------------------------------
    // 11. Update quality metrics and log summary
    // -----------------------------------------------------------------
    const cycleLatency = Date.now() - cycleStart;
    this._updateQualityMetrics(prices, cycleLatency);

    const okbPrice = prices.find((p) => p.token === "OKB")?.price ?? "?";
    this.log(
      `Published ${prices.length} prices. ` +
      `OKB=$${okbPrice} | ` +
      `24h vol=${ticker24h?.volume ?? "N/A"} | ` +
      `gas=${gasPrice ?? "N/A"} | ` +
      `API calls this cycle=${apiCallsThisCycle}, total=${this.okx.apiCallCount} | ` +
      `network=${this.isTestnet ? "testnet" : "mainnet"}`
    );
  }

  // =====================================================================
  // Private helpers -- each wraps an Onchain OS API call with error handling
  // =====================================================================

  /** Fetch prices for all tracked tokens via getMarketPrice(). */
  private async _fetchAllPrices(): Promise<MarketPrice[]> {
    const results: MarketPrice[] = [];
    for (const token of this.trackedTokens) {
      try {
        const price = await this.okx.getMarketPrice(token);
        results.push(price);
      } catch (err) {
        this.warn(`Failed to fetch price for ${token}: ${err instanceof Error ? err.message : err}`);
        this.metrics.failedFetches++;
      }
    }
    return results;
  }

  /** Fetch 24h ticker stats via getMarketTicker24h(). */
  private async _fetch24hTicker(
    token: string,
  ): Promise<{ volume: number; high: number; low: number; change: number } | undefined> {
    try {
      const ticker = await this.okx.getMarketTicker24h(token);
      return {
        volume: ticker.volume24h,
        high: ticker.high24h,
        low: ticker.low24h,
        change: ticker.change24h,
      };
    } catch (err) {
      this.warn(`Failed to fetch 24h ticker for ${token}: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }

  /** Fetch kline/candlestick data via getKlines(). */
  private async _fetchKlines(token: string): Promise<void> {
    try {
      const klines = await this.okx.getKlines(token, "1H", "10");
      if (klines.length > 0) {
        const latest = klines[0];
        this.log(
          `Kline ${token}: O=${latest.open} H=${latest.high} L=${latest.low} C=${latest.close} V=${latest.volume}`
        );
      }
    } catch (err) {
      this.warn(`Failed to fetch klines for ${token}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Fetch gas price via getGasPrice(). */
  private async _fetchGasPrice(): Promise<string | undefined> {
    try {
      const gas = await this.okx.getGasPrice();
      if (gas) {
        this.log(`Gas price: base=${gas.baseFee} gwei, priority=${gas.maxPriorityFee}`);
        return gas.gasPrice;
      }
    } catch (err) {
      this.warn(`Failed to fetch gas price: ${err instanceof Error ? err.message : err}`);
    }
    return undefined;
  }

  /** Check agent's own wallet balance via getWalletBalance(). */
  private async _checkWalletBalance(): Promise<void> {
    try {
      const balance = await this.okx.getWalletBalance(this.wallet.address);
      const totalUsd = balance.balances.reduce(
        (sum, b) => sum + parseFloat(b.balanceUsd || "0"),
        0,
      );
      this.log(
        `Wallet balance: ${balance.balances.length} tokens, ~$${totalUsd.toFixed(2)} USD total`
      );
    } catch (err) {
      this.warn(`Failed to check wallet balance: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Discover tokens available on X Layer via getAllTokens().
   * If new tokens are found that are not yet tracked, add them.
   */
  private async _discoverXLayerTokens(): Promise<void> {
    try {
      const tokens = await this.okx.getAllTokens();
      this.xlayerTokenCount = tokens.length;
      this.log(`X Layer token discovery: ${tokens.length} tokens available`);

      // Add high-profile tokens we aren't already tracking
      const knownSymbols = new Set(this.trackedTokens.map((t) => t.toUpperCase()));
      const interestingTokens = tokens
        .filter((t) => !knownSymbols.has(t.tokenSymbol.toUpperCase()))
        .slice(0, 5); // cap to avoid unbounded growth

      for (const t of interestingTokens) {
        this.trackedTokens.push(t.tokenSymbol.toUpperCase());
        this.log(`Added new tracked token from X Layer: ${t.tokenSymbol}`);
      }
    } catch (err) {
      this.warn(`Token discovery failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Take an economy snapshot via contracts.oracle.takeSnapshot().
   * Reads current on-chain stats and records them.
   */
  private async _takeEconomySnapshot(): Promise<void> {
    try {
      // Read current counts from marketplace
      const [listingCount, requestCount] = await Promise.all([
        this.contracts.marketplace.getListingCount().catch(() => 0n),
        this.contracts.marketplace.getRequestCount().catch(() => 0n),
      ]);

      // Read agent count
      const agentCount = await this.contracts.registry.getAgentCount().catch(() => 0n);

      this.log(
        `Economy snapshot: agents=${agentCount}, listings=${listingCount}, requests=${requestCount}`
      );

      const tx = await this.contracts.oracle.takeSnapshot(
        agentCount,   // activeAgents
        listingCount,  // totalListings
        requestCount,  // totalRequests
        0,             // totalMatches (not tracked locally)
        0,             // totalEscrowVolume
        0,             // totalSettled
        0,             // gdp
      );
      await tx.wait();
      this.log(`Economy snapshot recorded on-chain. tx=${tx.hash}`);
    } catch (err) {
      this.warn(`Economy snapshot failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** List MARKET_DATA service on the marketplace with Dutch auction pricing. */
  private async _listMarketDataService(): Promise<void> {
    try {
      const serviceType = this.serviceTypeHash("MARKET_DATA");
      const tx = await this.contracts.marketplace.listService(
        serviceType,
        START_PRICE,
        FLOOR_PRICE,
        DECAY_RATE,
        0, // unlimited fulfillments
      );
      const receipt = await tx.wait();

      // Parse listing ID from event
      const iface = this.contracts.marketplace.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "ServiceListed") {
            this.currentListingId = parsed.args[0];
            this.log(`Listed MARKET_DATA service, listingId=${this.currentListingId}`);
          }
        } catch {
          // skip non-matching logs
        }
      }
    } catch (err) {
      this.warn(`Failed to list service: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Update data freshness and quality metrics after each cycle. */
  private _updateQualityMetrics(prices: MarketPrice[], cycleLatencyMs: number): void {
    const now = Date.now();
    const staleThresholdMs = 60_000; // 1 minute

    // Count stale prices (source timestamp older than threshold)
    let staleCount = 0;
    for (const p of prices) {
      if (now - p.timestamp > staleThresholdMs) {
        staleCount++;
      }
    }
    this.metrics.stalePriceCount = staleCount;

    if (prices.length > 0) {
      this.metrics.successfulFetches += prices.length;
      this.metrics.lastSuccessTimestamp = now;
    }

    // Rolling average latency
    const prev = this.metrics.averageLatencyMs;
    const n = this.metrics.totalCycles;
    this.metrics.averageLatencyMs = prev + (cycleLatencyMs - prev) / n;

    if (staleCount > 0) {
      this.warn(`Data quality: ${staleCount}/${prices.length} prices are stale (>${staleThresholdMs}ms old)`);
    }

    this.log(
      `Quality metrics: cycles=${this.metrics.totalCycles}, ` +
      `success=${this.metrics.successfulFetches}, failed=${this.metrics.failedFetches}, ` +
      `avgLatency=${this.metrics.averageLatencyMs.toFixed(0)}ms, ` +
      `totalAPICalls=${this.metrics.totalApiCalls}`
    );
  }
}
