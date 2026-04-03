/**
 * AnalystAgent -- consumes market data and produces alpha signals.
 *
 * Cycle:
 *  1. Request MARKET_DATA from the marketplace (or read from EventBus cache)
 *  2. Compute volatility, trend direction, and market regime
 *  3. Generate an alpha signal with a confidence score
 *  4. List ALPHA_SIGNAL service on the marketplace
 *  5. Broadcast signal to in-process EventBus
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { globalBus } from "../core/EventBus.js";
import { AgentType } from "../config/contracts.js";
import type { MarketDataSnapshot } from "./DataProviderAgent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarketRegime = "trending_up" | "trending_down" | "mean_reverting" | "volatile";
export type SignalDirection = "long" | "short" | "neutral";

export interface AlphaSignal {
  timestamp: number;
  token: string;
  direction: SignalDirection;
  confidence: number; // 0..1
  regime: MarketRegime;
  volatility: number;
  dataHash: string; // provenance link to source data
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const START_PRICE = ethers.parseEther("0.002");
const FLOOR_PRICE = ethers.parseEther("0.0002");
const DECAY_RATE = ethers.parseEther("0.00002");

export class AnalystAgent extends AgentBase {
  /** Rolling window of recent price snapshots for analysis. */
  private priceHistory: MarketDataSnapshot[] = [];
  private currentListingId: bigint | null = null;
  private readonly MAX_HISTORY = 60; // keep last 60 snapshots

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("Analyst", AgentType.Analyst, privateKey, provider);

    // Listen for market data from the DataProvider (local fast-path)
    globalBus.on<MarketDataSnapshot>("market:data", (snap) => {
      this.priceHistory.push(snap);
      if (this.priceHistory.length > this.MAX_HISTORY) {
        this.priceHistory.shift();
      }
    });
  }

  async runCycle(): Promise<void> {
    // 1. Check if we have enough data
    if (this.priceHistory.length < 3) {
      this.log("Not enough data yet, waiting for DataProvider...");
      return;
    }

    // 2. Analyse -- compute volatility, trend, regime for OKB
    const okbPrices = this.priceHistory
      .map((s) => s.prices.find((p) => p.token === "OKB")?.price ?? 0)
      .filter((p) => p > 0);

    if (okbPrices.length < 3) {
      this.log("Insufficient OKB price points");
      return;
    }

    const volatility = this._computeVolatility(okbPrices);
    const trend = this._computeTrend(okbPrices);
    const regime = this._detectRegime(volatility, trend);
    const { direction, confidence } = this._generateSignal(trend, volatility, regime);

    const signal: AlphaSignal = {
      timestamp: Date.now(),
      token: "OKB",
      direction,
      confidence,
      regime,
      volatility,
      dataHash: this.priceHistory[this.priceHistory.length - 1].dataHash,
    };

    this.log(
      `Signal: ${direction.toUpperCase()} OKB | ` +
      `confidence=${(confidence * 100).toFixed(1)}% | ` +
      `regime=${regime} | vol=${volatility.toFixed(4)}`
    );

    // 3. List ALPHA_SIGNAL service if not yet listed
    if (this.currentListingId === null) {
      try {
        const serviceType = this.serviceTypeHash("ALPHA_SIGNAL");
        const tx = await this.contracts.marketplace.listService(
          serviceType, START_PRICE, FLOOR_PRICE, DECAY_RATE, 0,
        );
        const receipt = await tx.wait();
        const iface = this.contracts.marketplace.interface;
        for (const log of receipt.logs) {
          try {
            const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === "ServiceListed") {
              this.currentListingId = parsed.args[0];
              this.log(`Listed ALPHA_SIGNAL service, listingId=${this.currentListingId}`);
            }
          } catch { /* skip */ }
        }
      } catch (err) {
        this.warn(`Failed to list ALPHA_SIGNAL: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 4. Broadcast signal locally
    await globalBus.emit("alpha:signal", signal);
  }

  // -----------------------------------------------------------------------
  // Analysis helpers
  // -----------------------------------------------------------------------

  /** Simple standard deviation of log returns. */
  private _computeVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  /** Linear regression slope over the price series. */
  private _computeTrend(prices: number[]): number {
    const n = prices.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += prices[i];
      sumXY += i * prices[i];
      sumX2 += i * i;
    }
    return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  }

  /** Classify market regime. */
  private _detectRegime(volatility: number, trend: number): MarketRegime {
    const highVol = volatility > 0.02;
    const strongTrend = Math.abs(trend) > 0.1;

    if (highVol && !strongTrend) return "volatile";
    if (strongTrend && trend > 0) return "trending_up";
    if (strongTrend && trend < 0) return "trending_down";
    return "mean_reverting";
  }

  /** Generate a directional signal with confidence. */
  private _generateSignal(
    trend: number,
    volatility: number,
    regime: MarketRegime,
  ): { direction: SignalDirection; confidence: number } {
    // Trend-following in trending regimes, mean-reversion otherwise
    if (regime === "trending_up") {
      return { direction: "long", confidence: Math.min(0.9, 0.5 + Math.abs(trend) * 2) };
    }
    if (regime === "trending_down") {
      return { direction: "short", confidence: Math.min(0.9, 0.5 + Math.abs(trend) * 2) };
    }
    if (regime === "mean_reverting" && trend < -0.01) {
      return { direction: "long", confidence: 0.55 }; // weak counter-trend
    }
    if (regime === "mean_reverting" && trend > 0.01) {
      return { direction: "short", confidence: 0.55 };
    }
    return { direction: "neutral", confidence: 0.3 };
  }
}
