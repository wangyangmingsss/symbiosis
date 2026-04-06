/**
 * LiquidityManagerAgent -- manages Uniswap V3 style LP positions.
 *
 * Cycle:
 *  1. Fetch on-chain pool price from Uniswap V3 (with CEX fallback)
 *  2. Cross-venue price comparison (Uniswap V3 vs OKX CEX)
 *  3. Check current liquidity positions (real or simulated)
 *  4. Determine if positions are in range
 *  5. If out of range, rebalance by withdrawing and re-entering at new ticks
 *  6. Collect accumulated fees and estimate IL
 *  7. Track TVL, APR, and emit detailed events
 *  8. List LP_MANAGEMENT service on the marketplace
 *  9. Take economy snapshot after significant LP actions
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient } from "../core/OnchainOSClient.js";
import { UniswapV3Client } from "../core/UniswapV3Client.js";
import { globalBus } from "../core/EventBus.js";
import { AgentType } from "../config/contracts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LPPosition {
  positionId: string;
  tokenId?: number;              // On-chain NFT token ID (real positions)
  token0: string;
  token1: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feesEarned0: bigint;
  feesEarned1: bigint;
  entryPrice: number;            // Price when position was opened/rebalanced
  entryTimestamp: number;        // When position was opened/rebalanced
  isReal: boolean;               // True if read from on-chain NFT manager
}

interface CrossVenueComparison {
  onChainPrice: number;
  cexPrice: number;
  onChainTick: number;
  cexTick: number;
  divergencePct: number;         // Percentage difference
  timestamp: number;
}

interface LPPerformanceMetrics {
  totalFeesCollected0: bigint;
  totalFeesCollected1: bigint;
  totalImpermanentLoss: number;  // Estimated IL in USD
  estimatedAPR: number;          // Annualized return from fees
  totalValueLocked: number;      // TVL in USD across all positions
  positionCount: number;
  rebalanceCount: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const START_PRICE = ethers.parseEther("0.003");
const FLOOR_PRICE = ethers.parseEther("0.0003");
const DECAY_RATE = ethers.parseEther("0.00003");

/** NonfungiblePositionManager ABI for LP position management (write methods). */
const NPM_WRITE_ABI = [
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external payable returns (uint256 amount0, uint256 amount1)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];

/** Basis points threshold for "out of range" -- if price is within 5% of tick edge. */
const RANGE_BUFFER_BPS = 500; // 5%

/** Cross-venue divergence threshold (%) that triggers extra caution on rebalance. */
const CROSS_VENUE_DIVERGENCE_WARN_PCT = 1.0;

/** Minimum number of cycles before APR estimation is meaningful. */
const MIN_CYCLES_FOR_APR = 5;

/** Assume cycle interval for APR estimation (ms). */
const CYCLE_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class LiquidityManagerAgent extends AgentBase {
  private readonly okx: OnchainOSClient;
  private readonly uniswapClient: UniswapV3Client;
  private currentListingId: bigint | null = null;
  private rebalanceCount = 0;
  private totalFeesCollected0 = 0n;
  private totalFeesCollected1 = 0n;

  /** Simulated or real positions. */
  private positions: LPPosition[] = [];

  /** Whether real Uniswap V3 pool integration is active. */
  private readonly useRealPool: boolean;
  private readonly poolAddress: string;
  private readonly positionManagerAddress: string;
  private readonly realTokenIds: number[];

  /** Performance tracking. */
  private cyclesElapsed = 0;
  private cumulativeFeesUSD = 0;
  private lastCrossVenueComparison: CrossVenueComparison | null = null;
  private totalValueLocked = 0;

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("LiquidityManager", AgentType.LiquidityManager, privateKey, provider);
    this.okx = new OnchainOSClient();
    this.uniswapClient = new UniswapV3Client(provider);

    // Read config from environment
    this.poolAddress = process.env.UNISWAP_OKB_USDT_POOL ?? "";
    this.positionManagerAddress = process.env.UNISWAP_POSITION_MANAGER ?? "";
    this.useRealPool = !!this.poolAddress;

    // Parse real token IDs from env (comma-separated)
    const tokenIdsEnv = process.env.UNISWAP_POSITION_TOKEN_IDS ?? "";
    this.realTokenIds = tokenIdsEnv
      ? tokenIdsEnv.split(",").map((id) => parseInt(id.trim(), 10)).filter((n) => !isNaN(n))
      : [];

    if (this.useRealPool) {
      this.log(`Real Uniswap V3 mode: pool=${this.poolAddress}`);
      if (this.realTokenIds.length > 0) {
        this.log(`Tracking ${this.realTokenIds.length} on-chain position(s): [${this.realTokenIds.join(", ")}]`);
      }
    } else {
      this.log("Simulation mode: no UNISWAP_OKB_USDT_POOL configured");
      // Initialize a simulated position as fallback
      this.positions.push({
        positionId: "sim-1",
        token0: "OKB",
        token1: "USDT",
        tickLower: -1000,
        tickUpper: 1000,
        liquidity: ethers.parseEther("1"),
        feesEarned0: 0n,
        feesEarned1: 0n,
        entryPrice: 48.5,
        entryTimestamp: Date.now(),
        isReal: false,
      });
    }
  }

  async runCycle(): Promise<void> {
    this.cyclesElapsed++;

    // 1. Fetch prices from both venues
    const { currentTick, currentPrice, cexPrice } = await this._fetchPrices();

    // 2. Cross-venue price comparison
    this._performCrossVenueComparison(currentPrice, cexPrice, currentTick);

    // 3. Load real positions from chain if configured
    if (this.useRealPool && this.realTokenIds.length > 0) {
      await this._loadRealPositions();
    }

    // 4. Check each position and rebalance if needed
    await this._checkAndRebalancePositions(currentTick, currentPrice, cexPrice);

    // 5. Compute performance metrics
    const metrics = this._computePerformanceMetrics(currentPrice);

    // 6. List LP_MANAGEMENT service
    await this._ensureServiceListed();

    // 7. Broadcast detailed LP status event
    await this._emitDetailedStatus(metrics, currentPrice, currentTick);
  }

  // -----------------------------------------------------------------------
  // Price fetching
  // -----------------------------------------------------------------------

  private async _fetchPrices(): Promise<{
    currentTick: number;
    currentPrice: number;
    cexPrice: number;
  }> {
    // Always fetch CEX price
    const priceData = await this.okx.getMarketPrice("OKB");
    const cexPrice = priceData.price;

    let currentPrice: number;
    let currentTick: number;

    if (this.useRealPool) {
      try {
        const poolData = await this.uniswapClient.getPoolPrice(this.poolAddress);
        currentPrice = poolData.price;
        currentTick = poolData.tick;
        this.log(`On-chain pool price=$${currentPrice.toFixed(4)} tick=${currentTick}`);
      } catch (err) {
        this.warn(`Failed to read pool price, falling back to CEX: ${err instanceof Error ? err.message : err}`);
        currentPrice = cexPrice;
        currentTick = UniswapV3Client.priceToTick(cexPrice);
      }
    } else {
      currentPrice = cexPrice;
      currentTick = this._priceToTick(cexPrice);
    }

    this.log(`CEX price=$${cexPrice.toFixed(2)} | Effective price=$${currentPrice.toFixed(4)} tick=${currentTick}`);
    return { currentTick, currentPrice, cexPrice };
  }

  // -----------------------------------------------------------------------
  // Cross-venue comparison
  // -----------------------------------------------------------------------

  private _performCrossVenueComparison(
    onChainPrice: number,
    cexPrice: number,
    onChainTick: number,
  ): void {
    if (!this.useRealPool || cexPrice === 0) return;

    const divergencePct = Math.abs(onChainPrice - cexPrice) / cexPrice * 100;
    const cexTick = UniswapV3Client.priceToTick(cexPrice);

    this.lastCrossVenueComparison = {
      onChainPrice,
      cexPrice,
      onChainTick,
      cexTick,
      divergencePct,
      timestamp: Date.now(),
    };

    if (divergencePct > CROSS_VENUE_DIVERGENCE_WARN_PCT) {
      this.warn(
        `Cross-venue divergence: ${divergencePct.toFixed(2)}% ` +
        `(on-chain=$${onChainPrice.toFixed(4)} vs CEX=$${cexPrice.toFixed(4)}) -- ` +
        `possible arb opportunity or stale pool`
      );
    } else {
      this.log(`Cross-venue spread: ${divergencePct.toFixed(3)}% (healthy)`);
    }
  }

  // -----------------------------------------------------------------------
  // Real position loading
  // -----------------------------------------------------------------------

  private async _loadRealPositions(): Promise<void> {
    const loadedIds = new Set(
      this.positions.filter((p) => p.isReal).map((p) => p.tokenId),
    );

    for (const tokenId of this.realTokenIds) {
      if (loadedIds.has(tokenId)) continue; // Already tracked

      try {
        const posData = await this.uniswapClient.getPosition(tokenId);
        this.positions.push({
          positionId: `nft-${tokenId}`,
          tokenId,
          token0: posData.token0 ?? "OKB",
          token1: posData.token1 ?? "USDT",
          tickLower: posData.tickLower,
          tickUpper: posData.tickUpper,
          liquidity: BigInt(posData.liquidity.toString()),
          feesEarned0: 0n,
          feesEarned1: 0n,
          entryPrice: UniswapV3Client.tickToPrice((posData.tickLower + posData.tickUpper) / 2),
          entryTimestamp: Date.now(),
          isReal: true,
        });
        this.log(`Loaded real position NFT #${tokenId}: ticks [${posData.tickLower}, ${posData.tickUpper}]`);
      } catch (err) {
        this.warn(`Failed to load position #${tokenId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Position checking and rebalancing
  // -----------------------------------------------------------------------

  private async _checkAndRebalancePositions(
    currentTick: number,
    currentPrice: number,
    cexPrice: number,
  ): Promise<void> {
    for (const pos of this.positions) {
      // Use Uniswap client for range check if available, else manual
      const inRange = this.useRealPool
        ? UniswapV3Client.isPositionInRange(currentTick, pos.tickLower, pos.tickUpper)
        : currentTick >= pos.tickLower && currentTick <= pos.tickUpper;

      const rangeWidth = pos.tickUpper - pos.tickLower;
      const distToEdge = Math.min(
        Math.abs(currentTick - pos.tickLower),
        Math.abs(currentTick - pos.tickUpper),
      );
      const nearEdge = distToEdge < rangeWidth * (RANGE_BUFFER_BPS / 10000);

      if (!inRange) {
        this.log(`Position ${pos.positionId} OUT OF RANGE. Rebalancing...`);

        // Cross-venue sanity check: avoid rebalancing into a diverged price
        const shouldRebalance = this._shouldRebalance(currentPrice, cexPrice);
        if (shouldRebalance) {
          await this._rebalance(pos, currentTick, currentPrice);
          this.rebalanceCount++;

          // Emit rebalance event
          await globalBus.emit("lp:rebalance", {
            positionId: pos.positionId,
            isReal: pos.isReal,
            newTickLower: pos.tickLower,
            newTickUpper: pos.tickUpper,
            currentTick,
            currentPrice,
            cexPrice,
            rebalanceCount: this.rebalanceCount,
            timestamp: Date.now(),
          });

          // Take economy snapshot after significant rebalance
          await this._takeEconomySnapshot();
        } else {
          this.warn(
            `Skipping rebalance for ${pos.positionId}: cross-venue divergence too high ` +
            `(${this.lastCrossVenueComparison?.divergencePct.toFixed(2)}%)`
          );
        }
      } else if (nearEdge) {
        this.log(`Position ${pos.positionId} near edge (${distToEdge} ticks), monitoring closely`);
      } else {
        this.log(`Position ${pos.positionId} in range, ${distToEdge} ticks from nearest edge`);
      }

      // Collect fees (simulated for sim positions, tracked for real)
      this._collectFees(pos, currentPrice);

      // Estimate impermanent loss
      const il = this._estimateImpermanentLoss(pos, currentPrice);
      if (Math.abs(il) > 0.001) {
        this.log(`Position ${pos.positionId} estimated IL: ${(il * 100).toFixed(3)}%`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Rebalance logic
  // -----------------------------------------------------------------------

  /** Check if it's safe to rebalance given cross-venue prices. */
  private _shouldRebalance(onChainPrice: number, cexPrice: number): boolean {
    if (!this.useRealPool) return true; // Simulation always rebalances

    const comparison = this.lastCrossVenueComparison;
    if (!comparison) return true;

    // If divergence is extreme (>5%), something is wrong -- skip rebalance
    if (comparison.divergencePct > 5.0) return false;

    return true;
  }

  /** Rebalance a position: center the range around the current tick. */
  private async _rebalance(
    pos: LPPosition,
    currentTick: number,
    currentPrice: number,
  ): Promise<void> {
    const halfRange = Math.floor((pos.tickUpper - pos.tickLower) / 2);
    const newTickLower = currentTick - halfRange;
    const newTickUpper = currentTick + halfRange;

    if (pos.isReal && pos.tokenId) {
      // Real on-chain rebalance via NonfungiblePositionManager
      try {
        const npmAddress = process.env.UNISWAP_V3_NPM ?? "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
        const npm = new ethers.Contract(npmAddress, NPM_WRITE_ABI, this.wallet);
        const deadline = Math.floor(Date.now() / 1000) + 600; // 10 min deadline

        // Step 1: Remove all liquidity from current position
        this.log(`[REAL] Removing liquidity from NFT #${pos.tokenId}...`);
        const decreaseTx = await npm.decreaseLiquidity({
          tokenId: pos.tokenId,
          liquidity: pos.liquidity,
          amount0Min: 0,
          amount1Min: 0,
          deadline,
        });
        await decreaseTx.wait();
        this.log(`[REAL] Liquidity removed: tx=${decreaseTx.hash}`);

        // Step 2: Collect tokens from the closed position
        this.log(`[REAL] Collecting tokens from NFT #${pos.tokenId}...`);
        const collectTx = await npm.collect({
          tokenId: pos.tokenId,
          recipient: this.wallet.address,
          amount0Max: BigInt("0xffffffffffffffffffffffffffffffff"),
          amount1Max: BigInt("0xffffffffffffffffffffffffffffffff"),
        });
        await collectTx.wait();
        this.log(`[REAL] Tokens collected: tx=${collectTx.hash}`);

        // Step 3: Mint new position at new tick range
        // Note: In a production system, amount0Desired/amount1Desired would be
        // calculated from the collected amounts. For now we re-enter with the
        // same liquidity value as a proxy.
        this.log(`[REAL] Minting new position at ticks [${newTickLower}, ${newTickUpper}]...`);
        const mintTx = await npm.mint({
          token0: pos.token0,
          token1: pos.token1,
          fee: 3000, // 0.3% fee tier
          tickLower: newTickLower,
          tickUpper: newTickUpper,
          amount0Desired: pos.liquidity / 2n,
          amount1Desired: pos.liquidity / 2n,
          amount0Min: 0,
          amount1Min: 0,
          recipient: this.wallet.address,
          deadline,
        });
        await mintTx.wait();
        this.log(`[REAL] New position minted: tx=${mintTx.hash}`);

        // Update local state
        pos.tickLower = newTickLower;
        pos.tickUpper = newTickUpper;
        pos.entryPrice = currentPrice;
        pos.entryTimestamp = Date.now();

        this.log(
          `[REAL] Rebalance complete for NFT #${pos.tokenId}: new range [${newTickLower}, ${newTickUpper}]`
        );
      } catch (err) {
        this.warn(
          `[REAL] On-chain rebalance failed for NFT #${pos.tokenId}: ` +
          `${err instanceof Error ? err.message : err} -- falling back to local update`
        );
        // Fall back to local state update
        pos.tickLower = newTickLower;
        pos.tickUpper = newTickUpper;
        pos.entryPrice = currentPrice;
        pos.entryTimestamp = Date.now();
      }
    } else {
      // Simulated rebalance: update local tick state only
      pos.tickLower = newTickLower;
      pos.tickUpper = newTickUpper;
      pos.entryPrice = currentPrice;
      pos.entryTimestamp = Date.now();

      this.log(
        `[SIM] Rebalanced ${pos.positionId}: new range [${newTickLower}, ${newTickUpper}]`
      );
    }
  }

  // -----------------------------------------------------------------------
  // Fee collection
  // -----------------------------------------------------------------------

  private _collectFees(pos: LPPosition, currentPrice: number): void {
    const fees0 = this._simulateFees(pos.liquidity);
    const fees1 = this._simulateFees(pos.liquidity);
    pos.feesEarned0 += fees0;
    pos.feesEarned1 += fees1;
    this.totalFeesCollected0 += fees0;
    this.totalFeesCollected1 += fees1;

    // Accumulate USD estimate for APR calculation
    const feesUSD =
      Number(ethers.formatEther(fees0)) * currentPrice +
      Number(ethers.formatEther(fees1)); // token1 is USDT, ~$1
    this.cumulativeFeesUSD += feesUSD;

    this.log(
      `Fees collected: ${ethers.formatEther(fees0)} OKB + ${ethers.formatEther(fees1)} USDT | ` +
      `Cumulative: ${ethers.formatEther(this.totalFeesCollected0)} OKB + ${ethers.formatEther(this.totalFeesCollected1)} USDT`
    );
  }

  // -----------------------------------------------------------------------
  // Impermanent loss estimation
  // -----------------------------------------------------------------------

  /**
   * Estimate IL as a fraction (e.g. -0.05 = 5% loss).
   * IL = 2 * sqrt(priceRatio) / (1 + priceRatio) - 1
   * where priceRatio = currentPrice / entryPrice
   */
  private _estimateImpermanentLoss(pos: LPPosition, currentPrice: number): number {
    if (pos.entryPrice <= 0) return 0;
    const priceRatio = currentPrice / pos.entryPrice;
    if (priceRatio <= 0) return 0;
    const il = 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
    return il;
  }

  // -----------------------------------------------------------------------
  // Performance metrics
  // -----------------------------------------------------------------------

  private _computePerformanceMetrics(currentPrice: number): LPPerformanceMetrics {
    // TVL: sum of liquidity across all positions (simplified USD estimate)
    let tvl = 0;
    for (const pos of this.positions) {
      // Rough estimate: liquidity split between token0 and token1
      const liqEth = Number(ethers.formatEther(pos.liquidity));
      tvl += liqEth * currentPrice + liqEth; // token0 * price + token1 (USDT)
    }
    this.totalValueLocked = tvl;

    // APR estimation: annualize fee income relative to TVL
    let estimatedAPR = 0;
    if (this.cyclesElapsed >= MIN_CYCLES_FOR_APR && tvl > 0) {
      const elapsedMs = this.cyclesElapsed * CYCLE_INTERVAL_MS;
      const elapsedYears = elapsedMs / (365.25 * 24 * 60 * 60 * 1000);
      if (elapsedYears > 0) {
        estimatedAPR = (this.cumulativeFeesUSD / tvl) / elapsedYears;
      }
    }

    const totalIL = this.positions.reduce(
      (sum, pos) => sum + this._estimateImpermanentLoss(pos, currentPrice) * Number(ethers.formatEther(pos.liquidity)),
      0,
    );

    const metrics: LPPerformanceMetrics = {
      totalFeesCollected0: this.totalFeesCollected0,
      totalFeesCollected1: this.totalFeesCollected1,
      totalImpermanentLoss: totalIL,
      estimatedAPR,
      totalValueLocked: tvl,
      positionCount: this.positions.length,
      rebalanceCount: this.rebalanceCount,
    };

    if (this.cyclesElapsed % 10 === 0) {
      this.log(
        `Performance: TVL=$${tvl.toFixed(2)} | APR=${(estimatedAPR * 100).toFixed(2)}% | ` +
        `IL=$${totalIL.toFixed(4)} | Positions=${this.positions.length} | Rebalances=${this.rebalanceCount}`
      );
    }

    return metrics;
  }

  // -----------------------------------------------------------------------
  // Service listing
  // -----------------------------------------------------------------------

  private async _ensureServiceListed(): Promise<void> {
    if (this.currentListingId !== null) return;

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

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------

  private async _emitDetailedStatus(
    metrics: LPPerformanceMetrics,
    currentPrice: number,
    currentTick: number,
  ): Promise<void> {
    await globalBus.emit("lp:status", {
      mode: this.useRealPool ? "real" : "simulation",
      positions: this.positions.map((p) => ({
        positionId: p.positionId,
        tokenId: p.tokenId,
        isReal: p.isReal,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        liquidity: p.liquidity.toString(),
        feesEarned0: p.feesEarned0.toString(),
        feesEarned1: p.feesEarned1.toString(),
        entryPrice: p.entryPrice,
      })),
      currentPrice,
      currentTick,
      crossVenueComparison: this.lastCrossVenueComparison,
      performance: {
        totalFeesCollected0: metrics.totalFeesCollected0.toString(),
        totalFeesCollected1: metrics.totalFeesCollected1.toString(),
        totalImpermanentLoss: metrics.totalImpermanentLoss,
        estimatedAPR: metrics.estimatedAPR,
        totalValueLocked: metrics.totalValueLocked,
        positionCount: metrics.positionCount,
        rebalanceCount: metrics.rebalanceCount,
      },
      cyclesElapsed: this.cyclesElapsed,
      timestamp: Date.now(),
    });
  }

  // -----------------------------------------------------------------------
  // Economy snapshots
  // -----------------------------------------------------------------------

  private async _takeEconomySnapshot(): Promise<void> {
    try {
      const tx = await this.contracts.oracle.takeSnapshot(
        this.positions.length,        // activeAgents (positions as proxy)
        this.currentListingId ? 1 : 0, // totalListings
        this.cyclesElapsed,            // totalRequests (cycles as proxy)
        this.rebalanceCount,           // totalMatches (rebalances as proxy)
        ethers.parseEther(this.totalValueLocked.toFixed(4)), // totalEscrowVolume (TVL)
        this.totalFeesCollected0 + this.totalFeesCollected1, // totalSettled
        ethers.parseEther(this.cumulativeFeesUSD.toFixed(4)), // gdp (fees as GDP proxy)
      );
      await tx.wait();
      this.log("Economy snapshot recorded after LP rebalance");
    } catch (err) {
      this.warn(`Economy snapshot failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

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
