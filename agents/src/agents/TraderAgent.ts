/**
 * TraderAgent -- executes trades based on alpha signals.
 *
 * Cycle:
 *  1. Listen for ALPHA_SIGNAL from the AnalystAgent
 *  2. Request SECURITY_AUDIT for the target token
 *  3. If the token is safe AND confidence > 0.7, execute a trade via OKX DEX
 *  4. Track PnL in the AgentTreasury
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient } from "../core/OnchainOSClient.js";
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

// Placeholder token addresses on X Layer
const TOKEN_ADDRESSES: Record<string, string> = {
  OKB: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // native
  USDT: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",  // placeholder
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class TraderAgent extends AgentBase {
  private readonly okx: OnchainOSClient;
  private latestSignal: AlphaSignal | null = null;
  private latestSecurityScan: SecurityScanResult | null = null;
  private totalPnL = 0;
  private tradeCount = 0;

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("Trader", AgentType.Trader, privateKey, provider);
    this.okx = new OnchainOSClient();

    // Listen for alpha signals from the Analyst
    globalBus.on<AlphaSignal>("alpha:signal", (signal) => {
      this.latestSignal = signal;
    });

    // Listen for security scan results from the SecurityAuditor
    globalBus.on<SecurityScanResult>("security:result", (result) => {
      this.latestSecurityScan = result;
    });
  }

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
      this.log(`Confidence ${(signal.confidence * 100).toFixed(1)}% below threshold ${MIN_CONFIDENCE * 100}%, skipping`);
      return;
    }

    // 2. Request security audit for the token
    this.log(`Requesting security audit for ${signal.token}...`);
    const tokenAddr = TOKEN_ADDRESSES[signal.token] ?? TOKEN_ADDRESSES.OKB;

    // Emit request so SecurityAuditorAgent picks it up
    await globalBus.emit("security:request", { tokenAddress: tokenAddr, requester: this.name });

    // Also do our own quick scan as backup
    const scan = this.latestSecurityScan ?? await this.okx.securityScan(tokenAddr);

    if (scan.riskScore > MAX_RISK_SCORE) {
      this.warn(`Token ${signal.token} risk score ${scan.riskScore} exceeds max ${MAX_RISK_SCORE}, aborting`);
      return;
    }
    if (scan.isHoneypot) {
      this.warn(`Token ${signal.token} flagged as honeypot, aborting`);
      return;
    }

    // 3. Execute trade
    this.log(`Executing ${signal.direction.toUpperCase()} trade on ${signal.token}...`);

    const fromToken = signal.direction === "long" ? TOKEN_ADDRESSES.USDT : tokenAddr;
    const toToken = signal.direction === "long" ? tokenAddr : TOKEN_ADDRESSES.USDT;

    try {
      // Size the position based on confidence
      const sizeFactor = BigInt(Math.floor(signal.confidence * 100));
      const tradeSize = (MAX_TRADE_SIZE * sizeFactor) / 100n;

      const quote = await this.okx.getDexQuote(fromToken, toToken, tradeSize.toString());
      this.log(`Quote: ${quote.fromAmount} -> ${quote.toAmount} via ${quote.route.join(",")}`);

      const result = await this.okx.executeDexSwap({
        fromToken,
        toToken,
        amount: tradeSize.toString(),
        slippage: "0.5",
        userWalletAddress: this.wallet.address,
      });

      if (result.status === "success") {
        this.tradeCount++;
        // Simplified PnL: log the trade for now
        this.log(`Trade #${this.tradeCount} executed: tx=${result.txHash}`);

        // Record in treasury
        try {
          const tx = await this.contracts.treasury.deposit({ value: 0 });
          await tx.wait();
        } catch {
          // Treasury tracking is best-effort
        }
      } else {
        this.warn("Trade execution failed");
      }
    } catch (err) {
      this.warn(`Trade error: ${err instanceof Error ? err.message : err}`);
    }

    // 4. Log PnL summary
    this.log(`Cumulative: ${this.tradeCount} trades | PnL tracking via treasury`);
  }
}
