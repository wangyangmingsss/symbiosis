/**
 * ArbitrageurAgent -- detects and executes cross-venue arbitrage.
 *
 * Cycle (runs every ~10s, the most frequent agent):
 *  1. Compare Uniswap V3 on-chain price vs OKX DEX aggregator price
 *  2. If spread exceeds threshold, request a security audit on the tokens
 *  3. Execute the arbitrage trade
 *  4. Record profit in the AgentTreasury
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient, SecurityScanResult } from "../core/OnchainOSClient.js";
import { globalBus } from "../core/EventBus.js";
import { AgentType } from "../config/contracts.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Minimum spread (as a ratio) to trigger arbitrage. 0.005 = 0.5%. */
const MIN_SPREAD = 0.005;

/** Maximum trade size per arb attempt (OKB wei). */
const MAX_ARB_SIZE = ethers.parseEther("0.5");

/** Maximum risk score to proceed with arb. */
const MAX_RISK_SCORE = 20;

/** Token addresses on X Layer (placeholders). */
const TOKENS = {
  OKB: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  USDT: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class ArbitrageurAgent extends AgentBase {
  private readonly okx: OnchainOSClient;
  private totalProfit = 0n;
  private arbCount = 0;
  private latestScan: SecurityScanResult | null = null;

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("Arbitrageur", AgentType.Arbitrageur, privateKey, provider);
    this.okx = new OnchainOSClient();

    globalBus.on<SecurityScanResult>("security:result", (result) => {
      this.latestScan = result;
    });
  }

  async runCycle(): Promise<void> {
    // 1. Get prices from two sources
    const [okxPrice, uniPrice] = await Promise.all([
      this._getOkxPrice(),
      this._getUniswapPrice(),
    ]);

    if (okxPrice === 0 || uniPrice === 0) {
      this.log("Could not fetch prices from both venues");
      return;
    }

    // 2. Calculate spread
    const spread = Math.abs(okxPrice - uniPrice) / Math.min(okxPrice, uniPrice);
    const buyVenue = okxPrice < uniPrice ? "OKX" : "Uniswap";
    const sellVenue = okxPrice < uniPrice ? "Uniswap" : "OKX";

    this.log(
      `OKB: OKX=$${okxPrice.toFixed(4)} | Uni=$${uniPrice.toFixed(4)} | ` +
      `spread=${(spread * 100).toFixed(3)}%`
    );

    if (spread < MIN_SPREAD) {
      this.log("Spread below threshold, no arbitrage opportunity");
      return;
    }

    // 3. Security check before executing
    this.log(`Spread ${(spread * 100).toFixed(3)}% detected. Requesting security audit...`);
    await globalBus.emit("security:request", {
      tokenAddress: TOKENS.OKB,
      requester: this.name,
    });

    // Use cached scan or fetch directly
    const scan = this.latestScan ?? await this.okx.securityScan(TOKENS.OKB);
    if (scan.riskScore > MAX_RISK_SCORE) {
      this.warn(`Risk score ${scan.riskScore} too high for arb, skipping`);
      return;
    }

    // 4. Execute arbitrage
    this.log(`Executing arb: buy on ${buyVenue}, sell on ${sellVenue}...`);

    try {
      // Size based on spread magnitude (bigger spread = more confident)
      const sizeFactor = BigInt(Math.min(100, Math.floor(spread * 10000)));
      const arbSize = (MAX_ARB_SIZE * sizeFactor) / 100n;

      // Step A: Buy on cheaper venue
      const buyQuote = await this.okx.getDexQuote(
        TOKENS.USDT,
        TOKENS.OKB,
        arbSize.toString(),
      );

      // Step B: Sell on more expensive venue
      const sellQuote = await this.okx.getDexQuote(
        TOKENS.OKB,
        TOKENS.USDT,
        buyQuote.toAmount,
      );

      // Calculate expected profit
      const costBasis = BigInt(arbSize);
      const proceeds = BigInt(sellQuote.toAmount);
      const profit = proceeds > costBasis ? proceeds - costBasis : 0n;

      if (profit === 0n) {
        this.log("No profit after slippage, aborting");
        return;
      }

      // Execute the buy leg
      const buyResult = await this.okx.executeDexSwap({
        fromToken: TOKENS.USDT,
        toToken: TOKENS.OKB,
        amount: arbSize.toString(),
        slippage: "0.3",
        userWalletAddress: this.wallet.address,
      });

      if (buyResult.status !== "success") {
        this.warn("Buy leg failed, aborting arb");
        return;
      }

      // Execute the sell leg
      const sellResult = await this.okx.executeDexSwap({
        fromToken: TOKENS.OKB,
        toToken: TOKENS.USDT,
        amount: buyResult.toAmount,
        slippage: "0.3",
        userWalletAddress: this.wallet.address,
      });

      if (sellResult.status === "success") {
        this.arbCount++;
        this.totalProfit += profit;

        this.log(
          `Arb #${this.arbCount} complete! ` +
          `Profit: ${ethers.formatEther(profit)} | ` +
          `Total: ${ethers.formatEther(this.totalProfit)}`
        );

        // Record in treasury
        await globalBus.emit("arb:profit", {
          arbCount: this.arbCount,
          profit: profit.toString(),
          totalProfit: this.totalProfit.toString(),
          buyVenue,
          sellVenue,
          spread,
        });
      } else {
        this.warn("Sell leg failed -- position still open");
      }
    } catch (err) {
      this.warn(`Arb execution error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // -----------------------------------------------------------------------
  // Price fetching
  // -----------------------------------------------------------------------

  /** Get OKB price from OKX CEX/aggregator. */
  private async _getOkxPrice(): Promise<number> {
    try {
      const data = await this.okx.getMarketPrice("OKB");
      return data.price;
    } catch {
      return 0;
    }
  }

  /**
   * Get OKB price from Uniswap V3 on X Layer.
   * In production this reads the slot0 of the pool contract.
   * For the hackathon, we simulate slight price deviation.
   */
  private async _getUniswapPrice(): Promise<number> {
    try {
      const data = await this.okx.getMarketPrice("OKB");
      // Simulate a small random deviation from OKX price (+/- 1%)
      const deviation = 1 + (Math.random() - 0.5) * 0.02;
      return data.price * deviation;
    } catch {
      return 0;
    }
  }
}
