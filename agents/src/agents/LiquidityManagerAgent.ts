/**
 * LiquidityManagerAgent -- manages Uniswap V3 style LP positions.
 *
 * Cycle:
 *  1. Check current liquidity positions
 *  2. Determine if positions are in range
 *  3. If out of range, rebalance by withdrawing and re-entering at new ticks
 *  4. Collect accumulated fees
 *  5. List LP_MANAGEMENT service on the marketplace
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient } from "../core/OnchainOSClient.js";
import { globalBus } from "../core/EventBus.js";
import { AgentType } from "../config/contracts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LPPosition {
  positionId: string;
  token0: string;
  token1: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feesEarned0: bigint;
  feesEarned1: bigint;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const START_PRICE = ethers.parseEther("0.003");
const FLOOR_PRICE = ethers.parseEther("0.0003");
const DECAY_RATE = ethers.parseEther("0.00003");

/** Basis points threshold for "out of range" -- if price is within 5% of tick edge. */
const RANGE_BUFFER_BPS = 500; // 5%

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class LiquidityManagerAgent extends AgentBase {
  private readonly okx: OnchainOSClient;
  private currentListingId: bigint | null = null;
  private rebalanceCount = 0;
  private totalFeesCollected = 0n;

  /** Simulated positions (in production, read from Uniswap V3 NFT manager). */
  private positions: LPPosition[] = [];

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("LiquidityManager", AgentType.LiquidityManager, privateKey, provider);
    this.okx = new OnchainOSClient();

    // Initialize a simulated position
    this.positions.push({
      positionId: "sim-1",
      token0: "OKB",
      token1: "USDT",
      tickLower: -1000,
      tickUpper: 1000,
      liquidity: ethers.parseEther("1"),
      feesEarned0: 0n,
      feesEarned1: 0n,
    });
  }

  async runCycle(): Promise<void> {
    // 1. Fetch current price to determine tick
    const priceData = await this.okx.getMarketPrice("OKB");
    const currentPrice = priceData.price;
    const currentTick = this._priceToTick(currentPrice);

    this.log(`Current OKB price=$${currentPrice.toFixed(2)} tick=${currentTick}`);

    // 2. Check each position
    for (const pos of this.positions) {
      const inRange = currentTick >= pos.tickLower && currentTick <= pos.tickUpper;
      const rangeWidth = pos.tickUpper - pos.tickLower;
      const distToEdge = Math.min(
        Math.abs(currentTick - pos.tickLower),
        Math.abs(currentTick - pos.tickUpper),
      );
      const nearEdge = distToEdge < rangeWidth * (RANGE_BUFFER_BPS / 10000);

      if (!inRange) {
        // 3. Out of range -- rebalance
        this.log(`Position ${pos.positionId} OUT OF RANGE. Rebalancing...`);
        await this._rebalance(pos, currentTick);
        this.rebalanceCount++;
      } else if (nearEdge) {
        this.log(`Position ${pos.positionId} near edge (${distToEdge} ticks), considering preemptive rebalance`);
      } else {
        this.log(`Position ${pos.positionId} in range, ${distToEdge} ticks from nearest edge`);
      }

      // 4. Collect fees (simulated)
      const fees0 = this._simulateFees(pos.liquidity);
      const fees1 = this._simulateFees(pos.liquidity);
      pos.feesEarned0 += fees0;
      pos.feesEarned1 += fees1;
      this.totalFeesCollected += fees0 + fees1;

      this.log(
        `Fees collected: ${ethers.formatEther(fees0)} OKB + ${ethers.formatEther(fees1)} USDT | ` +
        `Total: ${ethers.formatEther(this.totalFeesCollected)} cumulative`
      );
    }

    // 5. List LP_MANAGEMENT service
    if (this.currentListingId === null) {
      try {
        const serviceType = this.serviceTypeHash("LP_MANAGEMENT");
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
              this.log(`Listed LP_MANAGEMENT service, listingId=${this.currentListingId}`);
            }
          } catch { /* skip */ }
        }
      } catch (err) {
        this.warn(`Failed to list service: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Broadcast LP status
    await globalBus.emit("lp:status", {
      positions: this.positions.length,
      rebalanceCount: this.rebalanceCount,
      totalFeesCollected: this.totalFeesCollected.toString(),
    });
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Rebalance a position: center the range around the current tick. */
  private async _rebalance(pos: LPPosition, currentTick: number): Promise<void> {
    const halfRange = Math.floor((pos.tickUpper - pos.tickLower) / 2);
    pos.tickLower = currentTick - halfRange;
    pos.tickUpper = currentTick + halfRange;

    this.log(
      `Rebalanced ${pos.positionId}: new range [${pos.tickLower}, ${pos.tickUpper}]`
    );

    // In production: call Uniswap V3 NonfungiblePositionManager to
    // decreaseLiquidity -> collect -> mint new position
  }

  /** Approximate tick from price (Uniswap V3 uses tick = log1.0001(price)). */
  private _priceToTick(price: number): number {
    return Math.floor(Math.log(price) / Math.log(1.0001));
  }

  /** Simulate fee accrual proportional to liquidity. */
  private _simulateFees(liquidity: bigint): bigint {
    // Tiny fee per cycle for demo purposes
    return liquidity / 10000n;
  }
}
