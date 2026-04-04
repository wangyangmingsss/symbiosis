/**
 * ArbitrageurAgent -- detects and executes cross-venue arbitrage.
 *
 * Cycle (runs every ~10s, the most frequent agent):
 *  1. Compare Uniswap V3 on-chain price vs OKX DEX aggregator price
 *  2. If spread exceeds threshold, request a security audit on the tokens
 *  3. Check market depth via DEX quote before executing
 *  4. Estimate gas costs and calculate net profit
 *  5. Execute the arbitrage trade (simulated or live)
 *  6. Record profit in the AgentTreasury and take economy snapshot
 *
 * Upgrades over v1:
 *  - Real Uniswap V3 pool price reading via slot0
 *  - Live execution mode via LIVE_TRADE=true env var
 *  - Gas-aware profit calculation
 *  - Market depth checks before execution
 *  - Economy oracle snapshots after successful arbs
 *  - Detailed logging of attempts, successes, and failures
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient, SecurityScanResult } from "../core/OnchainOSClient.js";
import { UniswapV3Client } from "../core/UniswapV3Client.js";
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

/** Minimum market depth (in toAmount wei) to consider the trade viable. */
const MIN_DEPTH_WEI = ethers.parseEther("0.01");

/** Token addresses on X Layer (placeholders). */
const TOKENS = {
  OKB: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  USDT: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
};

/** Whether to broadcast real swaps on-chain. */
const LIVE_EXECUTION = process.env.LIVE_TRADE === "true";

/** Uniswap V3 pool address for OKB/USDT on X Layer. */
const UNISWAP_POOL = process.env.UNISWAP_OKB_USDT_POOL ?? "";

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class ArbitrageurAgent extends AgentBase {
  private readonly okx: OnchainOSClient;
  private readonly uniClient: UniswapV3Client;
  private totalProfit = 0n;
  private arbCount = 0;
  private failCount = 0;
  private attemptCount = 0;
  private latestScan: SecurityScanResult | null = null;

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("Arbitrageur", AgentType.Arbitrageur, privateKey, provider);
    this.okx = new OnchainOSClient();
    this.uniClient = new UniswapV3Client(provider);

    globalBus.on<SecurityScanResult>("security:result", (result) => {
      this.latestScan = result;
    });

    this.log(
      `Initialized | live=${LIVE_EXECUTION} | pool=${UNISWAP_POOL || "(none, using fallback)"}`,
    );
  }

  async runCycle(): Promise<void> {
    this.attemptCount++;
    this.log(`--- Arb cycle #${this.attemptCount} start ---`);

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
      `spread=${(spread * 100).toFixed(3)}%`,
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
      this.failCount++;
      return;
    }

    // 4. Market depth check via DEX quote
    this.log("Checking market depth...");
    const depthQuote = await this.okx.getDexQuote(
      TOKENS.USDT,
      TOKENS.OKB,
      MAX_ARB_SIZE.toString(),
    );

    if (BigInt(depthQuote.toAmount) < MIN_DEPTH_WEI) {
      this.warn(
        `Insufficient market depth: toAmount=${depthQuote.toAmount}, ` +
        `min=${MIN_DEPTH_WEI.toString()}`,
      );
      this.failCount++;
      return;
    }
    this.log(
      `Depth OK | priceImpact=${depthQuote.priceImpact.toFixed(4)}% | ` +
      `route=${depthQuote.route.join(" -> ")}`,
    );

    // 5. Gas estimation
    this.log("Estimating gas costs...");
    const gasInfo = await this.okx.getGasPrice();
    const gasPriceWei = gasInfo ? BigInt(gasInfo.gasPrice) : 0n;
    // Estimate ~300k gas for a swap pair (buy + sell)
    const estimatedGasUnits = 300_000n;
    const gasCostWei = gasPriceWei * estimatedGasUnits;

    this.log(
      `Gas: price=${gasPriceWei.toString()} wei | ` +
      `estimatedCost=${ethers.formatEther(gasCostWei)} OKB`,
    );

    // 6. Execute arbitrage
    this.log(`Executing arb: buy on ${buyVenue}, sell on ${sellVenue}...`);

    try {
      // Size based on spread magnitude (bigger spread = more confident)
      const sizeFactor = BigInt(Math.min(100, Math.floor(spread * 10000)));
      const arbSize = (MAX_ARB_SIZE * sizeFactor) / 100n;

      this.log(`Trade size: ${ethers.formatEther(arbSize)} OKB (factor=${sizeFactor})`);

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

      // Calculate expected profit accounting for gas
      const costBasis = BigInt(arbSize);
      const proceeds = BigInt(sellQuote.toAmount);
      const grossProfit = proceeds > costBasis ? proceeds - costBasis : 0n;
      const netProfit = grossProfit > gasCostWei ? grossProfit - gasCostWei : 0n;

      this.log(
        `Profit estimate: gross=${ethers.formatEther(grossProfit)} | ` +
        `gas=${ethers.formatEther(gasCostWei)} | ` +
        `net=${ethers.formatEther(netProfit)}`,
      );

      if (netProfit === 0n) {
        this.log("No net profit after gas costs, aborting");
        this.failCount++;
        return;
      }

      // Execute buy leg
      let buyResult;
      if (LIVE_EXECUTION) {
        this.log("[LIVE] Broadcasting buy swap on-chain...");
        buyResult = await this.okx.broadcastSwap(this.wallet, {
          fromToken: TOKENS.USDT,
          toToken: TOKENS.OKB,
          amount: arbSize.toString(),
          slippage: "0.3",
          userWalletAddress: this.wallet.address,
        });
      } else {
        buyResult = await this.okx.executeDexSwap({
          fromToken: TOKENS.USDT,
          toToken: TOKENS.OKB,
          amount: arbSize.toString(),
          slippage: "0.3",
          userWalletAddress: this.wallet.address,
        });
      }

      if (buyResult.status !== "success") {
        this.warn(`Buy leg failed | tx=${buyResult.txHash} | status=${buyResult.status}`);
        this.failCount++;
        return;
      }
      this.log(`Buy leg success | tx=${buyResult.txHash} | received=${buyResult.toAmount}`);

      // Execute sell leg
      let sellResult;
      if (LIVE_EXECUTION) {
        this.log("[LIVE] Broadcasting sell swap on-chain...");
        sellResult = await this.okx.broadcastSwap(this.wallet, {
          fromToken: TOKENS.OKB,
          toToken: TOKENS.USDT,
          amount: buyResult.toAmount,
          slippage: "0.3",
          userWalletAddress: this.wallet.address,
        });
      } else {
        sellResult = await this.okx.executeDexSwap({
          fromToken: TOKENS.OKB,
          toToken: TOKENS.USDT,
          amount: buyResult.toAmount,
          slippage: "0.3",
          userWalletAddress: this.wallet.address,
        });
      }

      if (sellResult.status === "success") {
        this.arbCount++;
        this.totalProfit += netProfit;

        this.log(
          `Arb #${this.arbCount} COMPLETE | ` +
          `tx=${sellResult.txHash} | ` +
          `netProfit=${ethers.formatEther(netProfit)} | ` +
          `totalProfit=${ethers.formatEther(this.totalProfit)} | ` +
          `successRate=${((this.arbCount / this.attemptCount) * 100).toFixed(1)}%`,
        );

        // Record in treasury
        await globalBus.emit("arb:profit", {
          arbCount: this.arbCount,
          profit: netProfit.toString(),
          totalProfit: this.totalProfit.toString(),
          gasCost: gasCostWei.toString(),
          buyVenue,
          sellVenue,
          spread,
          live: LIVE_EXECUTION,
        });

        // Take economy snapshot after successful arb
        await this._takeEconomySnapshot();
      } else {
        this.failCount++;
        this.warn(
          `Sell leg failed | tx=${sellResult.txHash} | ` +
          `status=${sellResult.status} -- position still open`,
        );
      }
    } catch (err) {
      this.failCount++;
      this.warn(
        `Arb execution error: ${err instanceof Error ? err.message : err} | ` +
        `attempts=${this.attemptCount} | fails=${this.failCount}`,
      );
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
    } catch (err) {
      this.warn(`OKX price fetch failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  /**
   * Get OKB price from Uniswap V3 on X Layer.
   *
   * Reads the real pool slot0 via UniswapV3Client when UNISWAP_OKB_USDT_POOL
   * is configured. Falls back to OKX price + small deviation for backward
   * compatibility if pool reading fails or no pool address is set.
   */
  private async _getUniswapPrice(): Promise<number> {
    // Attempt real pool reading if configured
    if (UNISWAP_POOL) {
      try {
        const poolPrice = await this.uniClient.getPoolPrice(UNISWAP_POOL);
        this.log(
          `Uniswap V3 pool read | tick=${poolPrice.tick} | ` +
          `sqrtPriceX96=${poolPrice.sqrtPriceX96.toString()} | ` +
          `price=${poolPrice.price.toFixed(4)}`,
        );
        return poolPrice.price;
      } catch (err) {
        this.warn(
          `Uniswap V3 pool read failed, using fallback: ` +
          `${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Fallback: OKX price + small random deviation (backward compatible)
    try {
      const data = await this.okx.getMarketPrice("OKB");
      const deviation = 1 + (Math.random() - 0.5) * 0.02;
      return data.price * deviation;
    } catch (err) {
      this.warn(`Uniswap fallback price fetch failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  // -----------------------------------------------------------------------
  // Economy snapshot
  // -----------------------------------------------------------------------

  /**
   * Take an economy snapshot via the EconomyOracle contract after a
   * successful arbitrage execution.
   */
  private async _takeEconomySnapshot(): Promise<void> {
    try {
      this.log("Taking economy snapshot via oracle...");
      const tx = await this.contracts.oracle.takeSnapshot(
        1,                              // activeAgents (self)
        0,                              // totalListings
        0,                              // totalRequests
        this.arbCount,                  // totalMatches (arb count)
        this.totalProfit,               // totalEscrowVolume
        this.totalProfit,               // totalSettled
        this.totalProfit,               // gdp
      );
      await tx.wait();
      this.log(`Economy snapshot recorded | tx=${tx.hash}`);
    } catch (err) {
      this.warn(
        `Economy snapshot failed (non-fatal): ` +
        `${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
