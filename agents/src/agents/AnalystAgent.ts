/**
 * AnalystAgent -- consumes market data and produces alpha signals.
 *
 * Cycle:
 *  1. Request MARKET_DATA from the marketplace (or read from EventBus cache)
 *  2. Fetch kline (candlestick) data via OnchainOSClient for OKB, BTC, ETH
 *  3. Compute technical indicators: RSI, MACD, Bollinger Bands
 *  4. Compute volatility, trend direction, and market regime
 *  5. Compute multi-asset correlation (BTC/ETH vs OKB)
 *  6. Generate an alpha signal with a confidence score
 *  7. Validate liquidity via getDexQuote (market depth check)
 *  8. List ALPHA_SIGNAL service on the marketplace
 *  9. Broadcast signal to in-process EventBus
 * 10. Take economy snapshots periodically (every 10 cycles)
 * 11. Track signal accuracy over time
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient, KlineBar } from "../core/OnchainOSClient.js";
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
  rsi: number;
  macdHistogram: number;
  bollingerPosition: number; // 0..1 where 0=lower band, 1=upper band
  btcCorrelation: number;
  ethCorrelation: number;
  liquidityValid: boolean;
  dataHash: string; // provenance link to source data
}

interface TechnicalIndicators {
  rsi: number;
  macd: { macdLine: number; signalLine: number; histogram: number };
  bollinger: { upper: number; middle: number; lower: number; position: number };
}

interface SignalRecord {
  cycle: number;
  timestamp: number;
  direction: SignalDirection;
  priceAtSignal: number;
  priceNextCycle: number | null;
  correct: boolean | null;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const START_PRICE = ethers.parseEther("0.002");
const FLOOR_PRICE = ethers.parseEther("0.0002");
const DECAY_RATE = ethers.parseEther("0.00002");

/** OKB token contract on X Layer for DEX quote depth check. */
const OKB_CONTRACT = "0x75ab5AB1Eef154C0352Fc31D2428Cef80C7F8B33";
const USDT_CONTRACT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const DEPTH_CHECK_AMOUNT = ethers.parseEther("100").toString(); // 100 OKB

export class AnalystAgent extends AgentBase {
  /** Rolling window of recent price snapshots for analysis. */
  private priceHistory: MarketDataSnapshot[] = [];
  private currentListingId: bigint | null = null;
  private readonly MAX_HISTORY = 60; // keep last 60 snapshots

  /** OnchainOS client for klines, ticker, and DEX quotes. */
  private readonly okx: OnchainOSClient;

  /** Signal accuracy tracking. */
  private signalHistory: SignalRecord[] = [];
  private readonly MAX_SIGNAL_HISTORY = 100;

  /** Cycle counter for periodic economy snapshots. */
  private cycleIndex = 0;

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("Analyst", AgentType.Analyst, privateKey, provider);
    this.okx = new OnchainOSClient();

    // Listen for market data from the DataProvider (local fast-path)
    globalBus.on<MarketDataSnapshot>("market:data", (snap) => {
      this.priceHistory.push(snap);
      if (this.priceHistory.length > this.MAX_HISTORY) {
        this.priceHistory.shift();
      }
    });
  }

  async runCycle(): Promise<void> {
    this.cycleIndex++;

    // 1. Check if we have enough data
    if (this.priceHistory.length < 3) {
      this.log("Not enough data yet, waiting for DataProvider...");
      return;
    }

    // 2. Update signal accuracy from previous cycle
    this._updateSignalAccuracy();

    // 3. Fetch kline data for OKB, BTC, ETH in parallel
    const [okbKlines, btcKlines, ethKlines] = await Promise.all([
      this.okx.getKlines("OKB", "1H", "50"),
      this.okx.getKlines("BTC", "1H", "50"),
      this.okx.getKlines("ETH", "1H", "50"),
    ]);

    // 4. Extract OKB prices from local history (existing logic)
    const okbPrices = this.priceHistory
      .map((s) => s.prices.find((p) => p.token === "OKB")?.price ?? 0)
      .filter((p) => p > 0);

    if (okbPrices.length < 3) {
      this.log("Insufficient OKB price points");
      return;
    }

    // 5. Compute traditional volatility and trend from local price history
    const volatility = this._computeVolatility(okbPrices);
    const trend = this._computeTrend(okbPrices);
    const regime = this._detectRegime(volatility, trend);

    // 6. Compute technical indicators from kline data
    const closePrices = okbKlines.map((k) => k.close);
    const indicators = closePrices.length >= 26
      ? this._computeTechnicalIndicators(closePrices)
      : { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0 }, bollinger: { upper: 0, middle: 0, lower: 0, position: 0.5 } };

    // 7. Compute multi-asset correlation
    const btcCorrelation = this._computeCorrelation(
      okbKlines.map((k) => k.close),
      btcKlines.map((k) => k.close),
    );
    const ethCorrelation = this._computeCorrelation(
      okbKlines.map((k) => k.close),
      ethKlines.map((k) => k.close),
    );

    // 8. Generate signal using combined analysis
    const { direction, confidence } = this._generateSignal(
      trend, volatility, regime, indicators, btcCorrelation, ethCorrelation,
    );

    // 9. Validate liquidity via DEX quote
    let liquidityValid = false;
    try {
      const quote = await this.okx.getDexQuote(OKB_CONTRACT, USDT_CONTRACT, DEPTH_CHECK_AMOUNT);
      const impact = quote.priceImpact;
      liquidityValid = impact < 2.0; // less than 2% impact = sufficient liquidity
      this.log(
        `Depth check: priceImpact=${impact.toFixed(2)}% | ` +
        `route=${quote.route.join("->")} | liquidity=${liquidityValid ? "OK" : "THIN"}`,
      );
    } catch (err) {
      this.warn(`Depth check failed: ${err instanceof Error ? err.message : err}`);
    }

    const currentPrice = okbPrices[okbPrices.length - 1];
    const signal: AlphaSignal = {
      timestamp: Date.now(),
      token: "OKB",
      direction,
      confidence,
      regime,
      volatility,
      rsi: indicators.rsi,
      macdHistogram: indicators.macd.histogram,
      bollingerPosition: indicators.bollinger.position,
      btcCorrelation,
      ethCorrelation,
      liquidityValid,
      dataHash: this.priceHistory[this.priceHistory.length - 1].dataHash,
    };

    // 10. Log detailed technical output
    this.log(
      `Signal: ${direction.toUpperCase()} OKB | ` +
      `confidence=${(confidence * 100).toFixed(1)}% | regime=${regime} | vol=${volatility.toFixed(4)}`,
    );
    this.log(
      `  RSI=${indicators.rsi.toFixed(1)} | ` +
      `MACD=[${indicators.macd.macdLine.toFixed(4)}, ${indicators.macd.signalLine.toFixed(4)}, hist=${indicators.macd.histogram.toFixed(4)}] | ` +
      `BB-pos=${(indicators.bollinger.position * 100).toFixed(1)}%`,
    );
    this.log(
      `  Correlation: BTC=${btcCorrelation.toFixed(3)}, ETH=${ethCorrelation.toFixed(3)} | ` +
      `Liquidity=${liquidityValid ? "OK" : "THIN"}`,
    );
    this._logSignalAccuracy();

    // 11. Record signal for accuracy tracking
    this._recordSignal(direction, currentPrice);

    // 12. Take economy snapshot every 10 cycles
    if (this.cycleIndex % 10 === 0) {
      await this._takeEconomySnapshot();
    }

    // 13. List ALPHA_SIGNAL service if not yet listed
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

    // 14. Broadcast signal locally
    await globalBus.emit("alpha:signal", signal);
  }

  // -----------------------------------------------------------------------
  // Technical indicator calculations
  // -----------------------------------------------------------------------

  private _computeTechnicalIndicators(closes: number[]): TechnicalIndicators {
    return {
      rsi: this._computeRSI(closes, 14),
      macd: this._computeMACD(closes, 12, 26, 9),
      bollinger: this._computeBollingerBands(closes, 20, 2),
    };
  }

  /**
   * RSI (Relative Strength Index) over the given period.
   * Uses exponential moving average of gains/losses.
   */
  private _computeRSI(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50; // neutral default

    const changes: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }

    // Seed with simple average for first `period` changes
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) avgGain += changes[i];
      else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period;
    avgLoss /= period;

    // Smoothed EMA-style for remaining
    for (let i = period; i < changes.length; i++) {
      const change = changes[i];
      avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /**
   * MACD (Moving Average Convergence Divergence).
   * Returns MACD line, signal line, and histogram.
   */
  private _computeMACD(
    closes: number[],
    fastPeriod: number,
    slowPeriod: number,
    signalPeriod: number,
  ): { macdLine: number; signalLine: number; histogram: number } {
    const emaFast = this._computeEMA(closes, fastPeriod);
    const emaSlow = this._computeEMA(closes, slowPeriod);

    // MACD line values for each point where both EMAs exist
    const minLen = Math.min(emaFast.length, emaSlow.length);
    const macdValues: number[] = [];
    for (let i = 0; i < minLen; i++) {
      const fi = emaFast.length - minLen + i;
      const si = emaSlow.length - minLen + i;
      macdValues.push(emaFast[fi] - emaSlow[si]);
    }

    if (macdValues.length === 0) {
      return { macdLine: 0, signalLine: 0, histogram: 0 };
    }

    const signalValues = this._computeEMA(macdValues, signalPeriod);
    const macdLine = macdValues[macdValues.length - 1];
    const signalLine = signalValues.length > 0 ? signalValues[signalValues.length - 1] : 0;

    return {
      macdLine,
      signalLine,
      histogram: macdLine - signalLine,
    };
  }

  /**
   * Exponential Moving Average helper.
   * Returns an array of EMA values (same length as input).
   */
  private _computeEMA(data: number[], period: number): number[] {
    if (data.length === 0) return [];
    if (data.length < period) {
      // Not enough data; return SMA of what we have as single value
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      return [avg];
    }

    const k = 2 / (period + 1);
    const result: number[] = [];

    // Seed with SMA of first `period` values
    let ema = 0;
    for (let i = 0; i < period; i++) ema += data[i];
    ema /= period;
    result.push(ema);

    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  }

  /**
   * Bollinger Bands: middle = SMA, upper/lower = middle +/- (multiplier * stddev).
   * Returns current band values and the position of the last close within the bands (0..1).
   */
  private _computeBollingerBands(
    closes: number[],
    period: number,
    multiplier: number,
  ): { upper: number; middle: number; lower: number; position: number } {
    if (closes.length < period) {
      return { upper: 0, middle: 0, lower: 0, position: 0.5 };
    }

    // Use the last `period` closes
    const window = closes.slice(-period);
    const middle = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, v) => a + (v - middle) ** 2, 0) / period;
    const stddev = Math.sqrt(variance);

    const upper = middle + multiplier * stddev;
    const lower = middle - multiplier * stddev;

    const lastClose = closes[closes.length - 1];
    const bandwidth = upper - lower;
    const position = bandwidth > 0 ? (lastClose - lower) / bandwidth : 0.5;

    return { upper, middle, lower, position: Math.max(0, Math.min(1, position)) };
  }

  // -----------------------------------------------------------------------
  // Multi-asset correlation
  // -----------------------------------------------------------------------

  /**
   * Pearson correlation coefficient between two price series.
   * Aligns by taking the shorter length from the tail end.
   */
  private _computeCorrelation(seriesA: number[], seriesB: number[]): number {
    const len = Math.min(seriesA.length, seriesB.length);
    if (len < 5) return 0;

    const a = seriesA.slice(-len);
    const b = seriesB.slice(-len);

    // Use log returns for correlation
    const rA: number[] = [];
    const rB: number[] = [];
    for (let i = 1; i < len; i++) {
      if (a[i - 1] > 0 && b[i - 1] > 0) {
        rA.push(Math.log(a[i] / a[i - 1]));
        rB.push(Math.log(b[i] / b[i - 1]));
      }
    }

    if (rA.length < 3) return 0;

    const n = rA.length;
    const meanA = rA.reduce((s, v) => s + v, 0) / n;
    const meanB = rB.reduce((s, v) => s + v, 0) / n;

    let cov = 0, varA = 0, varB = 0;
    for (let i = 0; i < n; i++) {
      const dA = rA[i] - meanA;
      const dB = rB[i] - meanB;
      cov += dA * dB;
      varA += dA * dA;
      varB += dB * dB;
    }

    const denom = Math.sqrt(varA * varB);
    return denom > 0 ? cov / denom : 0;
  }

  // -----------------------------------------------------------------------
  // Signal accuracy tracking
  // -----------------------------------------------------------------------

  private _recordSignal(direction: SignalDirection, priceAtSignal: number): void {
    this.signalHistory.push({
      cycle: this.cycleIndex,
      timestamp: Date.now(),
      direction,
      priceAtSignal,
      priceNextCycle: null,
      correct: null,
    });
    if (this.signalHistory.length > this.MAX_SIGNAL_HISTORY) {
      this.signalHistory.shift();
    }
  }

  /**
   * After each cycle, check the previous signal's direction against
   * the actual price movement.
   */
  private _updateSignalAccuracy(): void {
    const okbPrices = this.priceHistory
      .map((s) => s.prices.find((p) => p.token === "OKB")?.price ?? 0)
      .filter((p) => p > 0);
    if (okbPrices.length === 0) return;

    const currentPrice = okbPrices[okbPrices.length - 1];

    // Update the most recent unresolved signal
    for (let i = this.signalHistory.length - 1; i >= 0; i--) {
      const rec = this.signalHistory[i];
      if (rec.priceNextCycle === null) {
        rec.priceNextCycle = currentPrice;
        const moved = currentPrice - rec.priceAtSignal;
        if (rec.direction === "long") {
          rec.correct = moved > 0;
        } else if (rec.direction === "short") {
          rec.correct = moved < 0;
        } else {
          rec.correct = Math.abs(moved / rec.priceAtSignal) < 0.005; // neutral = small move
        }
        break;
      }
    }
  }

  private _logSignalAccuracy(): void {
    const resolved = this.signalHistory.filter((s) => s.correct !== null);
    if (resolved.length === 0) return;

    const correctCount = resolved.filter((s) => s.correct === true).length;
    const accuracy = (correctCount / resolved.length) * 100;
    this.log(
      `  Signal accuracy: ${correctCount}/${resolved.length} correct (${accuracy.toFixed(1)}%) ` +
      `over last ${resolved.length} signals`,
    );
  }

  // -----------------------------------------------------------------------
  // Economy snapshot
  // -----------------------------------------------------------------------

  private async _takeEconomySnapshot(): Promise<void> {
    try {
      this.log("Taking economy snapshot (every 10 cycles)...");
      const [okbTicker, btcTicker, ethTicker] = await Promise.all([
        this.okx.getMarketTicker24h("OKB"),
        this.okx.getMarketTicker24h("BTC"),
        this.okx.getMarketTicker24h("ETH"),
      ]);

      this.log(
        `  Economy: OKB 24h[vol=${okbTicker.volume24h.toFixed(0)}, chg=${okbTicker.change24h.toFixed(2)}%] | ` +
        `BTC 24h[vol=${btcTicker.volume24h.toFixed(0)}, chg=${btcTicker.change24h.toFixed(2)}%] | ` +
        `ETH 24h[vol=${ethTicker.volume24h.toFixed(0)}, chg=${ethTicker.change24h.toFixed(2)}%]`,
      );

      // Optionally record on-chain via the oracle contract
      try {
        const encoded = ethers.toUtf8Bytes(
          JSON.stringify({ okb: okbTicker, btc: btcTicker, eth: ethTicker, cycle: this.cycleIndex }),
        );
        const snapshotHash = ethers.keccak256(encoded);
        this.log(`  Economy snapshot hash: ${snapshotHash}`);
      } catch { /* non-critical */ }
    } catch (err) {
      this.warn(`Economy snapshot failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // -----------------------------------------------------------------------
  // Original analysis helpers (preserved)
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

  /**
   * Generate a directional signal with confidence.
   * Now incorporates RSI, MACD, Bollinger, and correlation data
   * alongside the original trend/volatility/regime analysis.
   */
  private _generateSignal(
    trend: number,
    volatility: number,
    regime: MarketRegime,
    indicators: TechnicalIndicators,
    btcCorrelation: number,
    ethCorrelation: number,
  ): { direction: SignalDirection; confidence: number } {
    // --- Base signal from regime (original logic) ---
    let baseDirection: SignalDirection = "neutral";
    let baseConfidence = 0.3;

    if (regime === "trending_up") {
      baseDirection = "long";
      baseConfidence = Math.min(0.9, 0.5 + Math.abs(trend) * 2);
    } else if (regime === "trending_down") {
      baseDirection = "short";
      baseConfidence = Math.min(0.9, 0.5 + Math.abs(trend) * 2);
    } else if (regime === "mean_reverting" && trend < -0.01) {
      baseDirection = "long";
      baseConfidence = 0.55;
    } else if (regime === "mean_reverting" && trend > 0.01) {
      baseDirection = "short";
      baseConfidence = 0.55;
    }

    // --- RSI adjustment ---
    // Overbought (>70) favors short, oversold (<30) favors long
    let rsiScore = 0;
    if (indicators.rsi > 70) rsiScore = -0.15; // bearish
    else if (indicators.rsi > 60) rsiScore = -0.05;
    else if (indicators.rsi < 30) rsiScore = 0.15; // bullish
    else if (indicators.rsi < 40) rsiScore = 0.05;

    // --- MACD adjustment ---
    // Positive histogram = bullish momentum, negative = bearish
    let macdScore = 0;
    if (indicators.macd.histogram > 0) {
      macdScore = Math.min(0.1, indicators.macd.histogram * 10);
    } else {
      macdScore = Math.max(-0.1, indicators.macd.histogram * 10);
    }

    // --- Bollinger position adjustment ---
    // Near lower band = potential long, near upper = potential short
    let bbScore = 0;
    if (indicators.bollinger.position < 0.15) bbScore = 0.1; // near lower band
    else if (indicators.bollinger.position > 0.85) bbScore = -0.1; // near upper band

    // --- Correlation adjustment ---
    // High correlation with BTC in a trending regime boosts confidence
    const correlationBoost = (Math.abs(btcCorrelation) > 0.7 && regime.startsWith("trending"))
      ? 0.05
      : 0;

    // Combine scores
    const compositeScore = rsiScore + macdScore + bbScore;
    let finalDirection = baseDirection;
    let finalConfidence = baseConfidence + correlationBoost;

    // If technical indicators strongly disagree with base regime signal, moderate confidence
    if (baseDirection === "long" && compositeScore < -0.15) {
      finalConfidence = Math.max(0.2, finalConfidence - 0.15);
    } else if (baseDirection === "short" && compositeScore > 0.15) {
      finalConfidence = Math.max(0.2, finalConfidence - 0.15);
    } else if (baseDirection === "neutral") {
      // Let technicals determine direction when regime is neutral
      if (compositeScore > 0.1) {
        finalDirection = "long";
        finalConfidence = 0.4 + compositeScore;
      } else if (compositeScore < -0.1) {
        finalDirection = "short";
        finalConfidence = 0.4 + Math.abs(compositeScore);
      }
    } else {
      // Technicals agree with regime -- boost confidence
      if ((baseDirection === "long" && compositeScore > 0) ||
          (baseDirection === "short" && compositeScore < 0)) {
        finalConfidence = Math.min(0.95, finalConfidence + Math.abs(compositeScore) * 0.5);
      }
    }

    finalConfidence = Math.max(0.1, Math.min(0.95, finalConfidence));

    return { direction: finalDirection, confidence: finalConfidence };
  }
}
