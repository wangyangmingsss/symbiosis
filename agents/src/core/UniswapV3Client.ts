/**
 * UniswapV3Client -- helper for real Uniswap V3 interaction on X Layer.
 *
 * Provides typed methods for reading pool state (slot0), computing prices,
 * reading NFT LP positions, quoting swaps via QuoterV2, and converting
 * between prices and ticks.
 *
 * Contract addresses default to well-known Uniswap V3 deployments on X Layer
 * but can be overridden via environment variables.
 */

import { JsonRpcProvider, Contract, BigNumberish } from "ethers";

// ---------------------------------------------------------------------------
// Contract addresses -- X Layer defaults, overridable via env
// ---------------------------------------------------------------------------

/** Uniswap V3 Factory on X Layer (override with UNISWAP_V3_FACTORY). */
const FACTORY_ADDRESS =
  process.env.UNISWAP_V3_FACTORY ??
  "0x1F98431c8aD98523631AE4a59f267346ea31F984";

/** NonfungiblePositionManager on X Layer (override with UNISWAP_V3_NPM). */
const NPM_ADDRESS =
  process.env.UNISWAP_V3_NPM ??
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

/** QuoterV2 on X Layer (override with UNISWAP_V3_QUOTER). */
const QUOTER_ADDRESS =
  process.env.UNISWAP_V3_QUOTER ??
  "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// ---------------------------------------------------------------------------
// Minimal ABIs -- only the functions we actually call
// ---------------------------------------------------------------------------

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "function liquidity() external view returns (uint128)",
] as const;

const NPM_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function balanceOf(address owner) external view returns (uint256)",
] as const;

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from reading a pool's slot0. */
export interface PoolPrice {
  /** Raw sqrtPriceX96 as a string (to avoid BigInt serialisation issues). */
  sqrtPriceX96: string;
  /** Current tick of the pool. */
  tick: number;
  /** Human-readable price of token0 denominated in token1. */
  price: number;
}

/** Raw position data from NonfungiblePositionManager. */
export interface PositionInfo {
  nonce: bigint;
  operator: string;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

/** Result of a QuoterV2 single-input quote. */
export interface QuoteResult {
  /** Expected output amount as a string (smallest-unit). */
  amountOut: string;
  /** sqrtPriceX96 of the pool after the swap. */
  sqrtPriceX96After: string;
  /** Number of initialised ticks crossed during the swap simulation. */
  initializedTicksCrossed: number;
  /** Estimated gas cost of the swap. */
  gasEstimate: bigint;
}

/** Edge-distance info for a position relative to the current tick. */
export interface TickEdgeInfo {
  /** True when tickLower <= currentTick < tickUpper. */
  inRange: boolean;
  /** Distance (in ticks) from currentTick to the nearest boundary. */
  ticksToNearest: number;
  /** Which boundary is nearest: "lower", "upper", or "none" (equidistant). */
  nearestEdge: "lower" | "upper" | "none";
}

// ---------------------------------------------------------------------------
// UniswapV3Client
// ---------------------------------------------------------------------------

export class UniswapV3Client {
  private readonly provider: JsonRpcProvider;
  private readonly npmAddress: string;
  private readonly quoterAddress: string;
  private readonly factoryAddress: string;

  /**
   * Create a new UniswapV3Client.
   *
   * @param provider  - An ethers v6 JsonRpcProvider connected to X Layer.
   * @param overrides - Optional address overrides for core Uniswap V3 contracts.
   */
  constructor(
    provider: JsonRpcProvider,
    overrides?: {
      factory?: string;
      npm?: string;
      quoter?: string;
    },
  ) {
    this.provider = provider;
    this.factoryAddress = overrides?.factory ?? FACTORY_ADDRESS;
    this.npmAddress = overrides?.npm ?? NPM_ADDRESS;
    this.quoterAddress = overrides?.quoter ?? QUOTER_ADDRESS;
  }

  // -----------------------------------------------------------------------
  // Pool price
  // -----------------------------------------------------------------------

  /**
   * Read a pool's slot0 and derive the human-readable price.
   *
   * The returned price is token1-per-token0 (i.e. "how many token1 for
   * one token0") without decimal adjustment -- callers should account for
   * differing decimals between token0 and token1 if needed.
   *
   * @param poolAddress - Address of the Uniswap V3 pool contract.
   * @returns PoolPrice containing sqrtPriceX96, tick, and computed price.
   * @throws If the on-chain call reverts or the address is invalid.
   */
  async getPoolPrice(poolAddress: string): Promise<PoolPrice> {
    try {
      const pool = new Contract(poolAddress, POOL_ABI, this.provider);
      const slot0 = await pool.slot0();

      const sqrtPriceX96: bigint = BigInt(slot0.sqrtPriceX96);
      const tick: number = Number(slot0.tick);

      const price = UniswapV3Client.sqrtPriceX96ToPrice(sqrtPriceX96);

      return {
        sqrtPriceX96: sqrtPriceX96.toString(),
        tick,
        price,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`getPoolPrice failed for ${poolAddress}: ${msg}`);
    }
  }

  // -----------------------------------------------------------------------
  // Position reading
  // -----------------------------------------------------------------------

  /**
   * Read a Uniswap V3 NFT position from the NonfungiblePositionManager.
   *
   * @param tokenId - The NFT token ID of the LP position.
   * @returns Parsed PositionInfo struct with all on-chain fields.
   * @throws If the tokenId does not exist or the RPC call fails.
   */
  async getPosition(tokenId: BigNumberish): Promise<PositionInfo> {
    try {
      const npm = new Contract(this.npmAddress, NPM_ABI, this.provider);
      const pos = await npm.positions(tokenId);

      return {
        nonce: BigInt(pos.nonce),
        operator: pos.operator,
        token0: pos.token0,
        token1: pos.token1,
        fee: Number(pos.fee),
        tickLower: Number(pos.tickLower),
        tickUpper: Number(pos.tickUpper),
        liquidity: BigInt(pos.liquidity),
        feeGrowthInside0LastX128: BigInt(pos.feeGrowthInside0LastX128),
        feeGrowthInside1LastX128: BigInt(pos.feeGrowthInside1LastX128),
        tokensOwed0: BigInt(pos.tokensOwed0),
        tokensOwed1: BigInt(pos.tokensOwed1),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`getPosition failed for tokenId ${tokenId}: ${msg}`);
    }
  }

  // -----------------------------------------------------------------------
  // Quoting
  // -----------------------------------------------------------------------

  /**
   * Get an exact-input single-hop quote from QuoterV2.
   *
   * This performs a **static call** -- no gas is spent and no state changes.
   *
   * @param tokenIn  - Address of the input token.
   * @param tokenOut - Address of the output token.
   * @param fee      - Pool fee tier (e.g. 500, 3000, 10000).
   * @param amountIn - Amount of tokenIn in its smallest unit (as a string).
   * @returns QuoteResult with expected output amount and swap metadata.
   * @throws If no pool exists for the pair/fee or the RPC call fails.
   */
  async quoteExactInput(
    tokenIn: string,
    tokenOut: string,
    fee: number,
    amountIn: string,
  ): Promise<QuoteResult> {
    try {
      const quoter = new Contract(
        this.quoterAddress,
        QUOTER_ABI,
        this.provider,
      );

      const params = {
        tokenIn,
        tokenOut,
        amountIn: BigInt(amountIn),
        fee,
        sqrtPriceLimitX96: 0n,
      };

      // QuoterV2.quoteExactInputSingle is not a pure view -- it reverts
      // internally -- so we must use staticCall to simulate it.
      const result =
        await quoter.quoteExactInputSingle.staticCall(params);

      return {
        amountOut: result.amountOut.toString(),
        sqrtPriceX96After: result.sqrtPriceX96After.toString(),
        initializedTicksCrossed: Number(result.initializedTicksCrossed),
        gasEstimate: BigInt(result.gasEstimate),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `quoteExactInput failed (${tokenIn} -> ${tokenOut}, fee=${fee}): ${msg}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Static helpers -- range checks
  // -----------------------------------------------------------------------

  /**
   * Check whether a given tick falls inside a position's range.
   *
   * A position is in range when `tickLower <= tick < tickUpper`.
   *
   * @param tick      - Current pool tick.
   * @param tickLower - Position's lower tick boundary.
   * @param tickUpper - Position's upper tick boundary.
   * @returns `true` if the position is currently in range.
   */
  static isPositionInRange(
    tick: number,
    tickLower: number,
    tickUpper: number,
  ): boolean {
    return tick >= tickLower && tick < tickUpper;
  }

  /**
   * Compute how far the current tick is from the position's boundaries.
   *
   * Useful for alerting when a position is about to go out of range.
   *
   * @param tick      - Current pool tick.
   * @param tickLower - Position's lower tick boundary.
   * @param tickUpper - Position's upper tick boundary.
   * @returns TickEdgeInfo with in-range status and distance to edges.
   */
  static ticksToEdge(
    tick: number,
    tickLower: number,
    tickUpper: number,
  ): TickEdgeInfo {
    const inRange = UniswapV3Client.isPositionInRange(
      tick,
      tickLower,
      tickUpper,
    );

    const distToLower = Math.abs(tick - tickLower);
    const distToUpper = Math.abs(tick - tickUpper);

    let nearestEdge: TickEdgeInfo["nearestEdge"];
    let ticksToNearest: number;

    if (distToLower === distToUpper) {
      nearestEdge = "none";
      ticksToNearest = distToLower;
    } else if (distToLower < distToUpper) {
      nearestEdge = "lower";
      ticksToNearest = distToLower;
    } else {
      nearestEdge = "upper";
      ticksToNearest = distToUpper;
    }

    return { inRange, ticksToNearest, nearestEdge };
  }

  // -----------------------------------------------------------------------
  // Static helpers -- price / tick math
  // -----------------------------------------------------------------------

  /**
   * Convert a human-readable price to the nearest Uniswap V3 tick.
   *
   * Formula: `tick = floor( log(price) / log(1.0001) )`
   *
   * @param price - Price of token0 denominated in token1 (must be > 0).
   * @returns The corresponding tick (integer).
   * @throws If price is zero or negative.
   */
  static priceToTick(price: number): number {
    if (price <= 0) {
      throw new Error("Price must be a positive number.");
    }
    return Math.floor(Math.log(price) / Math.log(1.0001));
  }

  /**
   * Convert a Uniswap V3 tick back to a human-readable price.
   *
   * Formula: `price = 1.0001 ^ tick`
   *
   * @param tick - The Uniswap V3 tick value.
   * @returns The price of token0 denominated in token1.
   */
  static tickToPrice(tick: number): number {
    return Math.pow(1.0001, tick);
  }

  /**
   * Convert a raw sqrtPriceX96 value to a human-readable price.
   *
   * Formula: `price = (sqrtPriceX96 / 2^96)^2`
   *
   * Uses scaled bigint arithmetic to preserve precision before the final
   * conversion to a JS number.
   *
   * @param sqrtPriceX96 - The raw sqrtPriceX96 from slot0.
   * @returns The price as a floating-point number (may lose precision for
   *          extreme values).
   */
  static sqrtPriceX96ToPrice(sqrtPriceX96: bigint): number {
    const Q96 = 2n ** 96n;
    // price = (sqrtPriceX96)^2 / (2^96)^2
    const numerator = sqrtPriceX96 * sqrtPriceX96;
    const denominator = Q96 * Q96; // 2^192

    // Scale up by 10^18 before dividing to retain decimal precision.
    const SCALE = 10n ** 18n;
    const scaled = (numerator * SCALE) / denominator;
    return Number(scaled) / 1e18;
  }
}
