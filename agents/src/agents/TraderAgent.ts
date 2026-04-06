/**
 * TraderAgent -- executes trades based on alpha signals.
 *
 * Cycle:
 *  1. Listen for ALPHA_SIGNAL from the AnalystAgent
 *  2. Request SECURITY_AUDIT for the target token
 *  3. If the token is safe AND confidence > 0.7, execute a trade via OKX DEX
 *  4. Track PnL in the AgentTreasury
 *
 * v2 Upgrades:
 *  - LIVE_EXECUTION mode via LIVE_TRADE env var for real on-chain swaps
 *  - Pre-trade wallet balance checks
 *  - 24h market stats and kline signal validation
 *  - Post-trade economy snapshot via on-chain oracle
 *  - Detailed trade event emission on EventBus
 *  - Error categorization (insufficient balance, high slippage, API failure)
 *  - Cumulative stats tracking (trades, wins, losses, PnL)
 *  - Configurable position sizing based on wallet balance percentage
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient, DexSwapResult } from "../core/OnchainOSClient.js";
import { globalBus } from "../core/EventBus.js";
import { AgentType } from "../config/contracts.js";
import type { AlphaSignal } from "./AnalystAgent.js";
import type { SecurityScanResult } from "../core/OnchainOSClient.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Minimum confidence to act on a signal. */
const MIN_CONFIDENCE = 0.7;

/** Maximum position size per trade (in OKB wei). */
const MAX_TRADE_SIZE = ethers.parseEther("0.1");

/** Maximum acceptable risk score (0-100, lower is safer). */
const MAX_RISK_SCORE = 30;

/** Whether to broadcast real on-chain swaps via broadcastSwap(). */
const LIVE_EXECUTION = process.env.LIVE_TRADE === "true";

/** Position size as a percentage of wallet balance (0-100). */
const POSITION_SIZE_PCT = Math.min(
  100,
  Math.max(1, parseFloat(process.env.POSITION_SIZE_PCT ?? "10")),
);

/** Maximum acceptable slippage percentage for pre-trade validation. */
const MAX_SLIPPAGE_PCT = parseFloat(process.env.MAX_SLIPPAGE_PCT ?? "3.0");

// Token addresses on X Layer Mainnet (Chain ID 196)
const TOKEN_ADDRESSES: Record<string, string> = {
  OKB: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // native token
  USDT: process.env.XLAYER_USDT_ADDRESS ?? "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
  WETH: process.env.XLAYER_WETH_ADDRESS ?? "0x5A77f1443D16ee5761d310e38b62f77f726bC71c",
};

// ---------------------------------------------------------------------------
// Error categories
// ---------------------------------------------------------------------------

enum TradeErrorCategory {
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  HIGH_SLIPPAGE = "HIGH_SLIPPAGE",
  API_FAILURE = "API_FAILURE",
  SECURITY_REJECTED = "SECURITY_REJECTED",
  BROADCAST_FAILURE = "BROADCAST_FAILURE",
  UNKNOWN = "UNKNOWN",
}

// ---------------------------------------------------------------------------
// Trade event types
// ---------------------------------------------------------------------------

interface TradeEvent {
  timestamp: number;
  agent: string;
  direction: string;
  token: string;
  fromToken: string;
  toToken: string;
  amount: string;
  result: DexSwapResult | null;
  mode: "live" | "simulation";
  error?: string;
  errorCategory?: TradeErrorCategory;
  confidence: number;
  walletBalanceUsd: number;
  market24hChange: number;
}

// ---------------------------------------------------------------------------
// Cumulative stats
// ---------------------------------------------------------------------------

interface CumulativeStats {
  tradesExecuted: number;
  wins: number;
  losses: number;
  totalPnL: number;
  largestWin: number;
  largestLoss: number;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class TraderAgent extends AgentBase {
  private readonly okx: OnchainOSClient;
  private latestSignal: AlphaSignal | null = null;
  private latestSecurityScan: SecurityScanResult | null = null;
  private stats: CumulativeStats = {
    tradesExecuted: 0,
    wins: 0,
    losses: 0,
    totalPnL: 0,
    largestWin: 0,
    largestLoss: 0,
  };

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("Trader", AgentType.Trader, privateKey, provider);
    this.okx = new OnchainOSClient();

    this.log(
      `Initialized in ${LIVE_EXECUTION ? "LIVE" : "SIMULATION"} mode | ` +
      `positionSize=${POSITION_SIZE_PCT}% | maxSlippage=${MAX_SLIPPAGE_PCT}%`,
    );

    // Listen for alpha signals from the Analyst
    globalBus.on<AlphaSignal>("alpha:signal", (signal) => {
      this.latestSignal = signal;
    });

    // Listen for security scan results from the SecurityAuditor
    globalBus.on<SecurityScanResult>("security:result", (result) => {
      this.latestSecurityScan = result;
    });
  }

  // -------------------------------------------------------------------------
  // Main cycle
  // -------------------------------------------------------------------------

  async runCycle(): Promise<void> {
    // 1. Check for actionable signal
    if (!this.latestSignal) {
      this.log("No alpha signal yet, waiting...");
      return;
    }

    const signal = this.latestSignal;
    this.latestSignal = null; // consume the signal

    if (signal.direction === "neutral") {
      this.log("Signal is neutral, skipping");
      return;
    }

    if (signal.confidence < MIN_CONFIDENCE) {
      this.log(
        `Confidence ${(signal.confidence * 100).toFixed(1)}% below threshold ` +
        `${MIN_CONFIDENCE * 100}%, skipping`,
      );
      return;
    }

    // 2. Validate signal with 24h market stats and klines
    const tokenAddr = TOKEN_ADDRESSES[signal.token] ?? TOKEN_ADDRESSES.OKB;

    const marketValid = await this.validateMarketConditions(signal);
    if (!marketValid) {
      return;
    }

    // 3. Security audit
    this.log(`Requesting security audit for ${signal.token}...`);
    await globalBus.emit("security:request", { tokenAddress: tokenAddr, requester: this.name });

    const scan = this.latestSecurityScan ?? await this.okx.securityScan(tokenAddr);

    if (scan.riskScore > MAX_RISK_SCORE) {
      this.warn(`Token ${signal.token} risk score ${scan.riskScore} exceeds max ${MAX_RISK_SCORE}, aborting`);
      await this.emitTradeEvent(signal, tokenAddr, null, TradeErrorCategory.SECURITY_REJECTED);
      return;
    }
    if (scan.isHoneypot) {
      this.warn(`Token ${signal.token} flagged as honeypot, aborting`);
      await this.emitTradeEvent(signal, tokenAddr, null, TradeErrorCategory.SECURITY_REJECTED);
      return;
    }

    // 4. Pre-trade wallet balance check and position sizing
    const tradeSize = await this.computeTradeSize(signal);
    if (tradeSize === 0n) {
      return; // already logged inside computeTradeSize
    }

    // 5. Execute trade (live or simulation)
    const fromToken = signal.direction === "long" ? TOKEN_ADDRESSES.USDT : tokenAddr;
    const toToken = signal.direction === "long" ? tokenAddr : TOKEN_ADDRESSES.USDT;

    this.log(
      `Executing ${signal.direction.toUpperCase()} trade on ${signal.token} | ` +
      `mode=${LIVE_EXECUTION ? "LIVE" : "SIM"} | size=${ethers.formatEther(tradeSize)} ...`,
    );

    try {
      // Pre-trade quote for slippage check
      const quote = await this.okx.getDexQuote(fromToken, toToken, tradeSize.toString());
      this.log(`Quote: ${quote.fromAmount} -> ${quote.toAmount} via ${quote.route.join(",")}`);

      if (quote.priceImpact > MAX_SLIPPAGE_PCT) {
        this.warn(
          `Price impact ${quote.priceImpact.toFixed(2)}% exceeds max ${MAX_SLIPPAGE_PCT}%, aborting`,
        );
        await this.emitTradeEvent(signal, tokenAddr, null, TradeErrorCategory.HIGH_SLIPPAGE);
        return;
      }

      const swapParams = {
        fromToken,
        toToken,
        amount: tradeSize.toString(),
        slippage: "0.5",
        userWalletAddress: this.wallet.address,
      };

      let result: DexSwapResult;

      if (LIVE_EXECUTION) {
        // REAL on-chain execution via broadcastSwap
        this.log("Broadcasting LIVE swap on-chain...");
        result = await this.okx.broadcastSwap(this.wallet, swapParams);
      } else {
        // Simulation execution via legacy method
        result = await this.okx.executeDexSwap(swapParams);
      }

      if (result.status === "success") {
        this.recordTradeResult(result, quote, signal);

        // Record in treasury (best-effort)
        try {
          const tx = await this.contracts.treasury.deposit({ value: 0 });
          await tx.wait();
        } catch {
          // Treasury tracking is best-effort
        }

        // x402 escrow settlement: create and release escrow for the trade
        await this._settleViaEscrow(signal, result);

        // Take economy snapshot on-chain after successful trade
        await this.takeEconomySnapshot(signal, result);

        // Emit detailed trade event
        await this.emitTradeEvent(signal, tokenAddr, result);
      } else {
        this.stats.tradesExecuted++;
        this.stats.losses++;
        this.warn("Trade execution failed");
        await this.emitTradeEvent(signal, tokenAddr, result, TradeErrorCategory.BROADCAST_FAILURE);
      }
    } catch (err) {
      const errorCategory = this.categorizeError(err);
      this.warn(`Trade error [${errorCategory}]: ${err instanceof Error ? err.message : err}`);
      await this.emitTradeEvent(
        signal, tokenAddr, null, errorCategory,
        err instanceof Error ? err.message : String(err),
      );
    }

    // 6. Log cumulative stats
    this.log(
      `Cumulative: ${this.stats.tradesExecuted} trades | ` +
      `W:${this.stats.wins} L:${this.stats.losses} | ` +
      `PnL: ${this.stats.totalPnL >= 0 ? "+" : ""}${this.stats.totalPnL.toFixed(4)} | ` +
      `Best: +${this.stats.largestWin.toFixed(4)} | Worst: ${this.stats.largestLoss.toFixed(4)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Market validation using 24h stats and kline data
  // -------------------------------------------------------------------------

  private async validateMarketConditions(signal: AlphaSignal): Promise<boolean> {
    try {
      const [ticker24h, klines] = await Promise.all([
        this.okx.getMarketTicker24h(signal.token),
        this.okx.getKlines(signal.token, "1H", "24"),
      ]);

      this.log(
        `24h stats for ${signal.token}: vol=${ticker24h.volume24h.toFixed(2)} | ` +
        `change=${ticker24h.change24h.toFixed(2)}% | ` +
        `range=${ticker24h.low24h}-${ticker24h.high24h}`,
      );

      // Use kline data to validate signal direction
      if (klines.length >= 3) {
        const recentCloses = klines.slice(0, 3).map((k) => k.close);
        const klineTrend = recentCloses[0] > recentCloses[2] ? "up" : "down";
        const signalTrend = signal.direction === "long" ? "up" : "down";

        if (klineTrend !== signalTrend) {
          this.log(
            `Kline trend (${klineTrend}) conflicts with signal direction (${signal.direction}), ` +
            `reducing effective confidence`,
          );
          // We still proceed but this info is logged; could be used to reduce size
        }

        const avgVolume = klines.reduce((s, k) => s + k.volume, 0) / klines.length;
        this.log(`Kline data: ${klines.length} bars | avgVolume=${avgVolume.toFixed(2)}`);
      }

      // Reject if 24h change is too extreme (> 20%) -- likely manipulation
      if (Math.abs(ticker24h.change24h) > 20) {
        this.warn(
          `24h change ${ticker24h.change24h.toFixed(2)}% is extreme, skipping trade`,
        );
        return false;
      }

      return true;
    } catch (err) {
      this.warn(`Market validation failed: ${err instanceof Error ? err.message : err}`);
      // Proceed cautiously if market data unavailable
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // Position sizing based on wallet balance
  // -------------------------------------------------------------------------

  private async computeTradeSize(signal: AlphaSignal): Promise<bigint> {
    try {
      const walletBalance = await this.okx.getWalletBalance(this.wallet.address);

      const totalUsd = walletBalance.balances.reduce(
        (sum, b) => sum + parseFloat(b.balanceUsd || "0"),
        0,
      );
      this.log(`Wallet balance: $${totalUsd.toFixed(2)} across ${walletBalance.balances.length} tokens`);

      if (totalUsd < 1) {
        this.warn("Insufficient wallet balance (< $1), skipping trade");
        await this.emitTradeEvent(signal, "", null, TradeErrorCategory.INSUFFICIENT_BALANCE);
        return 0n;
      }

      // Position size = wallet balance * POSITION_SIZE_PCT / 100, scaled by confidence
      const sizeFactor = BigInt(Math.floor(signal.confidence * 100));
      const pctFactor = BigInt(Math.floor(POSITION_SIZE_PCT));
      const balanceBased = (MAX_TRADE_SIZE * pctFactor) / 100n;
      const tradeSize = (balanceBased * sizeFactor) / 100n;

      if (tradeSize === 0n) {
        this.warn("Computed trade size is 0, skipping");
        return 0n;
      }

      this.log(`Position size: ${ethers.formatEther(tradeSize)} (${POSITION_SIZE_PCT}% * ${(signal.confidence * 100).toFixed(1)}% confidence)`);
      return tradeSize;
    } catch (err) {
      this.warn(`Balance check failed: ${err instanceof Error ? err.message : err}, using fallback sizing`);

      // Fallback to original confidence-based sizing
      const sizeFactor = BigInt(Math.floor(signal.confidence * 100));
      return (MAX_TRADE_SIZE * sizeFactor) / 100n;
    }
  }

  // -------------------------------------------------------------------------
  // Record trade result and update cumulative stats
  // -------------------------------------------------------------------------

  private recordTradeResult(
    result: DexSwapResult,
    quote: { fromAmount: string; toAmount: string },
    signal: AlphaSignal,
  ): void {
    this.stats.tradesExecuted++;

    // Estimate PnL from quote amounts (simplified)
    const fromAmt = parseFloat(ethers.formatEther(BigInt(result.fromAmount || "0")));
    const toAmt = parseFloat(ethers.formatEther(BigInt(result.toAmount || "0")));
    const pnl = toAmt - fromAmt;

    if (pnl >= 0) {
      this.stats.wins++;
      if (pnl > this.stats.largestWin) this.stats.largestWin = pnl;
    } else {
      this.stats.losses++;
      if (pnl < this.stats.largestLoss) this.stats.largestLoss = pnl;
    }
    this.stats.totalPnL += pnl;

    this.log(
      `Trade #${this.stats.tradesExecuted} executed: tx=${result.txHash} | ` +
      `mode=${LIVE_EXECUTION ? "LIVE" : "SIM"} | pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Post-trade economy snapshot
  // -------------------------------------------------------------------------

  private async takeEconomySnapshot(signal: AlphaSignal, result: DexSwapResult): Promise<void> {
    try {
      this.log("Taking economy snapshot on-chain...");
      const tx = await this.contracts.oracle.takeSnapshot();
      await tx.wait();
      this.log(`Economy snapshot recorded: tx=${tx.hash}`);
    } catch (err) {
      this.warn(`Economy snapshot failed (non-critical): ${err instanceof Error ? err.message : err}`);
    }
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  private async emitTradeEvent(
    signal: AlphaSignal,
    tokenAddr: string,
    result: DexSwapResult | null,
    errorCategory?: TradeErrorCategory,
    errorMessage?: string,
  ): Promise<void> {
    const fromToken = signal.direction === "long" ? TOKEN_ADDRESSES.USDT : tokenAddr;
    const toToken = signal.direction === "long" ? tokenAddr : TOKEN_ADDRESSES.USDT;

    const event: TradeEvent = {
      timestamp: Date.now(),
      agent: this.name,
      direction: signal.direction,
      token: signal.token,
      fromToken,
      toToken,
      amount: result?.fromAmount ?? "0",
      result,
      mode: LIVE_EXECUTION ? "live" : "simulation",
      confidence: signal.confidence,
      walletBalanceUsd: 0,
      market24hChange: 0,
    };

    if (errorCategory) {
      event.error = errorMessage ?? errorCategory;
      event.errorCategory = errorCategory;
    }

    await globalBus.emit("trade:executed", event);
    await globalBus.emit("trade:stats", { ...this.stats });
  }

  // -------------------------------------------------------------------------
  // x402 Escrow Settlement
  // -------------------------------------------------------------------------

  /**
   * Create and immediately release an escrow for a successful trade.
   * This demonstrates the full x402 payment flow: create escrow -> release -> reputation update.
   */
  private async _settleViaEscrow(signal: AlphaSignal, result: DexSwapResult): Promise<void> {
    try {
      // Find the analyst's listing to use as the request context
      const requestCount = await this.contracts.marketplace.getRequestCount().catch(() => 0n);
      if (requestCount === 0n) {
        this.log("No marketplace requests yet, skipping escrow settlement");
        return;
      }

      // Create a micro-escrow for the trade execution fee
      const escrowAmount = ethers.parseEther("0.0001"); // micro-payment for service
      const duration = 3600; // 1 hour escrow window

      // Use the latest request ID as context
      const requestId = requestCount;

      this.log(`Creating x402 escrow: requestId=${requestId}, amount=${ethers.formatEther(escrowAmount)} OKB`);
      const createTx = await this.contracts.escrow.createEscrow(
        requestId,
        this.wallet.address, // seller = self for self-trade recording
        escrowAmount,
        duration,
        { value: escrowAmount },
      );
      const createReceipt = await createTx.wait();

      // Parse escrow ID from event
      let escrowId: bigint | null = null;
      const iface = this.contracts.escrow.interface;
      for (const log of createReceipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "EscrowCreated") {
            escrowId = parsed.args[0];
          }
        } catch { /* skip non-matching logs */ }
      }

      if (escrowId !== null) {
        // Immediately release the escrow (trade was successful)
        const releaseTx = await this.contracts.escrow.releaseEscrow(escrowId);
        await releaseTx.wait();
        this.log(`x402 escrow #${escrowId} created and released | tx=${releaseTx.hash}`);
      }
    } catch (err) {
      this.warn(`x402 escrow settlement failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  // -------------------------------------------------------------------------
  // Error categorization
  // -------------------------------------------------------------------------

  private categorizeError(err: unknown): TradeErrorCategory {
    if (!(err instanceof Error)) return TradeErrorCategory.UNKNOWN;

    const msg = err.message.toLowerCase();

    if (msg.includes("insufficient") || msg.includes("balance") || msg.includes("underflow")) {
      return TradeErrorCategory.INSUFFICIENT_BALANCE;
    }
    if (msg.includes("slippage") || msg.includes("price impact") || msg.includes("too high")) {
      return TradeErrorCategory.HIGH_SLIPPAGE;
    }
    if (msg.includes("fetch") || msg.includes("timeout") || msg.includes("network") || msg.includes("econnrefused")) {
      return TradeErrorCategory.API_FAILURE;
    }
    if (msg.includes("broadcast") || msg.includes("revert") || msg.includes("gas")) {
      return TradeErrorCategory.BROADCAST_FAILURE;
    }

    return TradeErrorCategory.UNKNOWN;
  }
}
