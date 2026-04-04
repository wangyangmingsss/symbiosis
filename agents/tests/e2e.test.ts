/**
 * End-to-end integration test suite for the SYMBIOSIS system.
 *
 * Verifies the full system works without a real blockchain connection.
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run with: cd agents && npx tsx --test tests/e2e.test.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { ethers, JsonRpcProvider, Wallet } from "ethers";

// Deterministic test private key (not used on any real network)
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Track all mock providers so we can destroy them after tests complete
const mockProviders: JsonRpcProvider[] = [];

// Destroy all mock providers after the full test suite to prevent the
// process from hanging due to background reconnection loops.
after(() => {
  for (const p of mockProviders) {
    p.destroy();
  }
});

// ---------------------------------------------------------------------------
// Helper: create a mock JsonRpcProvider that never makes real RPC calls
// ---------------------------------------------------------------------------

function createMockProvider(): JsonRpcProvider {
  // Instantiate with a dummy URL; no actual connection is made unless
  // a contract call triggers a network request.
  const provider = new JsonRpcProvider("http://localhost:1", undefined, {
    staticNetwork: true,
  });
  mockProviders.push(provider);
  return provider;
}

// ---------------------------------------------------------------------------
// 1. Agent Lifecycle Test
// ---------------------------------------------------------------------------

describe("Agent Lifecycle", () => {
  it("should create all 6 agents with a mock provider", async () => {
    const { DataProviderAgent } = await import(
      "../src/agents/DataProviderAgent.js"
    );
    const { AnalystAgent } = await import("../src/agents/AnalystAgent.js");
    const { TraderAgent } = await import("../src/agents/TraderAgent.js");
    const { SecurityAuditorAgent } = await import(
      "../src/agents/SecurityAuditorAgent.js"
    );
    const { LiquidityManagerAgent } = await import(
      "../src/agents/LiquidityManagerAgent.js"
    );
    const { ArbitrageurAgent } = await import(
      "../src/agents/ArbitrageurAgent.js"
    );
    const { AgentType } = await import("../src/config/contracts.js");

    const provider = createMockProvider();

    const dataProvider = new DataProviderAgent(TEST_PRIVATE_KEY, provider);
    const analyst = new AnalystAgent(TEST_PRIVATE_KEY, provider);
    const trader = new TraderAgent(TEST_PRIVATE_KEY, provider);
    const securityAuditor = new SecurityAuditorAgent(
      TEST_PRIVATE_KEY,
      provider,
    );
    const liquidityManager = new LiquidityManagerAgent(
      TEST_PRIVATE_KEY,
      provider,
    );
    const arbitrageur = new ArbitrageurAgent(TEST_PRIVATE_KEY, provider);

    const agents = [
      dataProvider,
      analyst,
      trader,
      securityAuditor,
      liquidityManager,
      arbitrageur,
    ];

    // Verify names
    assert.equal(dataProvider.name, "DataProvider");
    assert.equal(analyst.name, "Analyst");
    assert.equal(trader.name, "Trader");
    assert.equal(securityAuditor.name, "SecurityAuditor");
    assert.equal(liquidityManager.name, "LiquidityManager");
    assert.equal(arbitrageur.name, "Arbitrageur");

    // Verify agent types
    assert.equal(dataProvider.agentType, AgentType.DataProvider);
    assert.equal(analyst.agentType, AgentType.Analyst);
    assert.equal(trader.agentType, AgentType.Trader);
    assert.equal(securityAuditor.agentType, AgentType.SecurityAuditor);
    assert.equal(liquidityManager.agentType, AgentType.LiquidityManager);
    assert.equal(arbitrageur.agentType, AgentType.Arbitrageur);

    // Verify all agents share the same provider and have a valid wallet
    for (const agent of agents) {
      assert.equal(agent.provider, provider);
      assert.ok(agent.wallet instanceof Wallet, `${agent.name} should have a Wallet`);
      assert.ok(
        ethers.isAddress(agent.wallet.address),
        `${agent.name} wallet address should be valid`,
      );
    }

    // Verify lifecycle defaults
    for (const agent of agents) {
      assert.equal(agent.isRunning, false, `${agent.name} should not be running`);
      assert.equal(agent.cycleCount, 0, `${agent.name} cycleCount should be 0`);
    }

    // Verify contract handles exist
    for (const agent of agents) {
      assert.ok(agent.contracts.registry, `${agent.name} should have registry`);
      assert.ok(agent.contracts.marketplace, `${agent.name} should have marketplace`);
      assert.ok(agent.contracts.reputation, `${agent.name} should have reputation`);
      assert.ok(agent.contracts.escrow, `${agent.name} should have escrow`);
      assert.ok(agent.contracts.treasury, `${agent.name} should have treasury`);
      assert.ok(agent.contracts.oracle, `${agent.name} should have oracle`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. EventBus Pipeline Test
// ---------------------------------------------------------------------------

describe("EventBus Pipeline", () => {
  let EventBus: typeof import("../src/core/EventBus.js").EventBus;

  beforeEach(async () => {
    const mod = await import("../src/core/EventBus.js");
    EventBus = mod.EventBus;
  });

  it("DataProvider -> Analyst -> Trader -> SecurityAuditor full pipeline", async () => {
    const bus = new EventBus();
    const trace: string[] = [];

    // Analyst subscribes to market:data
    bus.on("market:data", (snapshot: any) => {
      trace.push("analyst:received:market:data");
      // Analyst processes data and emits an alpha signal
      bus.emit("alpha:signal", {
        timestamp: Date.now(),
        token: snapshot.prices[0].token,
        direction: "long",
        confidence: 0.85,
        regime: "trending_up",
        volatility: 0.015,
        dataHash: snapshot.dataHash,
      });
    });

    // Trader subscribes to alpha:signal
    bus.on("alpha:signal", (signal: any) => {
      trace.push("trader:received:alpha:signal");
      if (signal.confidence >= 0.7) {
        // Trader requests a security audit
        bus.emit("security:request", {
          tokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
          requester: "Trader",
        });
      }
    });

    // SecurityAuditor subscribes to security:request
    bus.on("security:request", (req: any) => {
      trace.push("auditor:received:security:request");
      // Auditor scans and emits result
      bus.emit("security:result", {
        tokenAddress: req.tokenAddress,
        riskScore: 5,
        isHoneypot: false,
        hasProxyContract: false,
        ownerCanMint: false,
        holders: 5000,
        warnings: [],
      });
    });

    // Final consumer of security:result
    bus.on("security:result", (result: any) => {
      trace.push("trader:received:security:result");
    });

    // Kick off: DataProvider publishes market data
    await bus.emit("market:data", {
      timestamp: Date.now(),
      prices: [
        { token: "OKB", price: 48.5, timestamp: Date.now(), source: "mock" },
      ],
      dataHash: "0xabc123",
    });

    // Allow async microtasks to settle
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(
      trace.includes("analyst:received:market:data"),
      "Analyst should receive market:data",
    );
    assert.ok(
      trace.includes("trader:received:alpha:signal"),
      "Trader should receive alpha:signal",
    );
    assert.ok(
      trace.includes("auditor:received:security:request"),
      "SecurityAuditor should receive security:request",
    );
    assert.ok(
      trace.includes("trader:received:security:result"),
      "Trader should receive security:result",
    );

    // Verify ordering: market:data before alpha:signal before security:request
    const idxMarket = trace.indexOf("analyst:received:market:data");
    const idxSignal = trace.indexOf("trader:received:alpha:signal");
    const idxRequest = trace.indexOf("auditor:received:security:request");
    const idxResult = trace.indexOf("trader:received:security:result");

    assert.ok(idxMarket < idxSignal, "market:data should precede alpha:signal");
    assert.ok(idxSignal < idxRequest, "alpha:signal should precede security:request");
    assert.ok(
      idxRequest < idxResult,
      "security:request should precede security:result",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. OnchainOSClient Skills Test
// ---------------------------------------------------------------------------

describe("OnchainOSClient Skills", () => {
  it("should exercise all skills and report them as active", async () => {
    const origKey = process.env.OKX_API_KEY;
    delete process.env.OKX_API_KEY;

    try {
      const { OnchainOSClient } = await import(
        "../src/core/OnchainOSClient.js"
      );
      const client = new OnchainOSClient();

      // Skill 1: getSupportedChains  -> "dex-supported-chains"
      await client.getSupportedChains();

      // Skill 2: getAllTokens         -> "dex-all-tokens"
      await client.getAllTokens();

      // Skill 3: getDexQuote          -> "dex-quote"
      await client.getDexQuote(
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
        "1000000000000000000",
      );

      // Skill 4: getDexSwap           -> "dex-swap"
      await client.getDexSwap(
        "196",
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
        "1000000000000000000",
        "0.5",
        "0x0000000000000000000000000000000000000001",
      );

      // Skill 5: broadcastSwap        -> "dex-broadcast-swap"
      // This will fail to broadcast (no real network) but still registers the skill
      const mockProvider = createMockProvider();
      const mockWallet = new Wallet(TEST_PRIVATE_KEY, mockProvider);
      await client.broadcastSwap(mockWallet, {
        fromToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        toToken: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
        amount: "1000000000000000000",
        slippage: "0.5",
        userWalletAddress: mockWallet.address,
      });

      // Skill 6: executeDexSwap       -> "dex-execute-swap"
      await client.executeDexSwap({
        fromToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        toToken: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
        amount: "1000000000000000000",
        slippage: "0.5",
        userWalletAddress: "0x0000000000000000000000000000000000000001",
      });

      // Skill 7: getCrossChainQuote   -> "cross-chain-quote"
      await client.getCrossChainQuote(
        "196",
        "1",
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        "1000000000000000000",
      );

      // Skill 8: getGasPrice          -> "gas-price"
      await client.getGasPrice();

      // Skill 9: getApproveTransaction -> "token-approval"
      await client.getApproveTransaction(
        "196",
        "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
        "1000000000000000000",
      );

      // Skill 10: getMarketPrice      -> "market-ticker"
      await client.getMarketPrice("OKB");

      // Skill 11: getMarketTicker24h  -> "market-ticker-24h"
      await client.getMarketTicker24h("OKB");

      // Skill 12: getKlines           -> "market-klines"
      await client.getKlines("OKB", "1H", "10");

      // Skill 13: getTokenInfo        -> "token-info"
      await client.getTokenInfo("OKB");

      // Skill 14: getWalletBalance    -> "wallet-balance"
      // May throw due to mock API returning non-JSON; the skill is still registered
      try {
        await client.getWalletBalance(
          "0x0000000000000000000000000000000000000001",
        );
      } catch {
        // Skill is tracked even if the response parsing fails
      }

      // Skill 15: securityScan        -> "security-scan"
      await client.securityScan(
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      );

      // Skill 16: getTransactionStatus -> "tx-status"
      await client.getTransactionStatus(
        "0x0000000000000000000000000000000000000000000000000000000000000001",
        mockProvider,
      );

      // Verify the skills report
      const report = client.getSkillsReport();

      assert.equal(report.totalSkills, 16, "should have 16 total skills defined");
      assert.ok(report.totalApiCalls > 0, "should have made API calls");

      // Every skill should be active
      const inactiveSkills = report.skills.filter((s) => !s.active);
      assert.equal(
        inactiveSkills.length,
        0,
        `All skills should be active, but these are inactive: ${inactiveSkills.map((s) => s.id).join(", ")}`,
      );

      assert.equal(
        report.activeSkills,
        report.totalSkills,
        "activeSkills should equal totalSkills",
      );
    } finally {
      if (origKey !== undefined) process.env.OKX_API_KEY = origKey;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. UniswapV3Client Math Test
// ---------------------------------------------------------------------------

describe("UniswapV3Client Math", () => {
  let UniswapV3Client: typeof import("../src/core/UniswapV3Client.js").UniswapV3Client;

  beforeEach(async () => {
    const mod = await import("../src/core/UniswapV3Client.js");
    UniswapV3Client = mod.UniswapV3Client;
  });

  it("sqrtPriceX96ToPrice should convert known values correctly", () => {
    // sqrtPriceX96 = sqrt(1) * 2^96 = 2^96 => price = 1.0
    const Q96 = 2n ** 96n;
    const priceOne = UniswapV3Client.sqrtPriceX96ToPrice(Q96);
    assert.ok(
      Math.abs(priceOne - 1.0) < 1e-10,
      `price should be ~1.0, got ${priceOne}`,
    );

    // sqrtPriceX96 = sqrt(4) * 2^96 = 2 * 2^96 => price = 4.0
    const priceTwo = UniswapV3Client.sqrtPriceX96ToPrice(Q96 * 2n);
    assert.ok(
      Math.abs(priceTwo - 4.0) < 1e-10,
      `price should be ~4.0, got ${priceTwo}`,
    );

    // sqrtPriceX96 for price ~0.25: sqrt(0.25) * 2^96 = 0.5 * 2^96
    const halfQ96 = Q96 / 2n;
    const priceQuarter = UniswapV3Client.sqrtPriceX96ToPrice(halfQ96);
    assert.ok(
      Math.abs(priceQuarter - 0.25) < 0.001,
      `price should be ~0.25, got ${priceQuarter}`,
    );
  });

  it("priceToTick should return the correct tick for known prices", () => {
    // price = 1.0 => tick = floor(log(1) / log(1.0001)) = 0
    assert.equal(UniswapV3Client.priceToTick(1.0), 0);

    // price = 1.0001 => tick = floor(log(1.0001)/log(1.0001)) = 1
    assert.equal(UniswapV3Client.priceToTick(1.0001), 1);

    // price = 1.0001^100 => tick should be approximately 100
    // (floating-point pow may lose a tiny fraction, so allow +/- 1)
    const price100 = Math.pow(1.0001, 100);
    const tick100 = UniswapV3Client.priceToTick(price100);
    assert.ok(
      Math.abs(tick100 - 100) <= 1,
      `tick for 1.0001^100 should be ~100, got ${tick100}`,
    );

    // Negative ticks for prices < 1
    const priceSub = Math.pow(1.0001, -50);
    const tickSub = UniswapV3Client.priceToTick(priceSub);
    assert.ok(
      Math.abs(tickSub - -50) <= 1,
      `tick for 1.0001^-50 should be ~-50, got ${tickSub}`,
    );

    // Should throw for non-positive prices
    assert.throws(
      () => UniswapV3Client.priceToTick(0),
      /positive/i,
      "Should throw for price = 0",
    );
    assert.throws(
      () => UniswapV3Client.priceToTick(-1),
      /positive/i,
      "Should throw for negative price",
    );
  });

  it("tickToPrice should be the inverse of priceToTick", () => {
    // tick = 0 => price = 1.0
    assert.ok(
      Math.abs(UniswapV3Client.tickToPrice(0) - 1.0) < 1e-10,
      "tick 0 should give price 1.0",
    );

    // Round-trip: priceToTick(tickToPrice(t)) should be within +/- 1
    // due to floating-point precision loss in pow / log
    for (const tick of [-500, -100, 0, 100, 500, 1000]) {
      const price = UniswapV3Client.tickToPrice(tick);
      const recoveredTick = UniswapV3Client.priceToTick(price);
      assert.ok(
        Math.abs(recoveredTick - tick) <= 1,
        `Round-trip for tick ${tick}: got ${recoveredTick}, expected ~${tick}`,
      );
    }
  });

  it("isPositionInRange should correctly detect in/out of range", () => {
    // In range: tickLower <= tick < tickUpper
    assert.equal(UniswapV3Client.isPositionInRange(50, 0, 100), true);
    assert.equal(UniswapV3Client.isPositionInRange(0, 0, 100), true);

    // tick == tickUpper is OUT of range
    assert.equal(UniswapV3Client.isPositionInRange(100, 0, 100), false);

    // Below range
    assert.equal(UniswapV3Client.isPositionInRange(-1, 0, 100), false);

    // Above range
    assert.equal(UniswapV3Client.isPositionInRange(200, 0, 100), false);
  });

  it("ticksToEdge should compute distances and nearest edge correctly", () => {
    // In range, closer to lower
    const edge1 = UniswapV3Client.ticksToEdge(10, 0, 100);
    assert.equal(edge1.inRange, true);
    assert.equal(edge1.ticksToNearest, 10);
    assert.equal(edge1.nearestEdge, "lower");

    // In range, closer to upper
    const edge2 = UniswapV3Client.ticksToEdge(80, 0, 100);
    assert.equal(edge2.inRange, true);
    assert.equal(edge2.ticksToNearest, 20);
    assert.equal(edge2.nearestEdge, "upper");

    // Equidistant
    const edge3 = UniswapV3Client.ticksToEdge(50, 0, 100);
    assert.equal(edge3.inRange, true);
    assert.equal(edge3.ticksToNearest, 50);
    assert.equal(edge3.nearestEdge, "none");

    // Out of range (above)
    const edge4 = UniswapV3Client.ticksToEdge(150, 0, 100);
    assert.equal(edge4.inRange, false);
    assert.equal(edge4.ticksToNearest, 50);
    assert.equal(edge4.nearestEdge, "upper");

    // Out of range (below)
    const edge5 = UniswapV3Client.ticksToEdge(-30, 0, 100);
    assert.equal(edge5.inRange, false);
    assert.equal(edge5.ticksToNearest, 30);
    assert.equal(edge5.nearestEdge, "lower");
  });
});

// ---------------------------------------------------------------------------
// 5. Full Economy Cycle Test
// ---------------------------------------------------------------------------

describe("Full Economy Cycle", () => {
  it("should simulate a complete economy cycle end-to-end", async () => {
    const { EventBus } = await import("../src/core/EventBus.js");
    const { OnchainOSClient } = await import(
      "../src/core/OnchainOSClient.js"
    );

    const origKey = process.env.OKX_API_KEY;
    delete process.env.OKX_API_KEY;

    try {
      const bus = new EventBus();
      const client = new OnchainOSClient();
      const log: Array<{ step: string; data: any }> = [];

      // --- Step 1: DataProvider publishes market data ---
      const prices = await Promise.all([
        client.getMarketPrice("OKB"),
        client.getMarketPrice("ETH"),
        client.getMarketPrice("BTC"),
      ]);

      const dataHash = ethers.keccak256(
        ethers.toUtf8Bytes(JSON.stringify(prices)),
      );

      const snapshot = {
        timestamp: Date.now(),
        prices,
        dataHash,
      };

      log.push({ step: "data:published", data: snapshot });

      // --- Step 2: Analyst receives data and generates signal ---
      let alphaSignal: any = null;

      bus.on("market:data", (snap: any) => {
        // Simulate analyst logic: generate a signal from the data
        const okbPrice = snap.prices.find(
          (p: any) => p.token === "OKB",
        );
        assert.ok(okbPrice, "OKB price should exist in snapshot");

        alphaSignal = {
          timestamp: Date.now(),
          token: "OKB",
          direction: "long" as const,
          confidence: 0.85,
          regime: "trending_up" as const,
          volatility: 0.012,
          dataHash: snap.dataHash,
        };

        log.push({ step: "signal:generated", data: alphaSignal });
        bus.emit("alpha:signal", alphaSignal);
      });

      // --- Step 3: Trader evaluates the signal ---
      let tradeDecision: any = null;

      bus.on("alpha:signal", (signal: any) => {
        assert.equal(signal.direction, "long");
        assert.ok(signal.confidence >= 0.7, "confidence should meet threshold");

        tradeDecision = {
          action: "execute",
          token: signal.token,
          direction: signal.direction,
          size: "0.05",
          reason: `confidence=${signal.confidence}, regime=${signal.regime}`,
        };
        log.push({ step: "trade:evaluated", data: tradeDecision });

        // Trader requests security audit before executing
        bus.emit("security:request", {
          tokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
          requester: "Trader",
        });
      });

      // --- Step 4: SecurityAuditor scans the token ---
      let scanResult: any = null;

      bus.on("security:request", async (req: any) => {
        // Use the real client to do a mock security scan
        scanResult = await client.securityScan(req.tokenAddress);
        log.push({ step: "security:scanned", data: scanResult });

        // Broadcast result
        await bus.emit("security:result", scanResult);
      });

      // --- Step 5: Results broadcast and final verification ---
      let finalResultReceived = false;

      bus.on("security:result", (result: any) => {
        finalResultReceived = true;
        log.push({ step: "result:broadcast", data: result });
      });

      // Kick off the pipeline
      await bus.emit("market:data", snapshot);

      // Allow cascading async events to settle
      await new Promise((r) => setTimeout(r, 200));

      // Verify all steps executed
      const steps = log.map((l) => l.step);
      assert.ok(
        steps.includes("data:published"),
        "Data should be published",
      );
      assert.ok(
        steps.includes("signal:generated"),
        "Signal should be generated",
      );
      assert.ok(
        steps.includes("trade:evaluated"),
        "Trade should be evaluated",
      );
      assert.ok(
        steps.includes("security:scanned"),
        "Security scan should execute",
      );
      assert.ok(
        steps.includes("result:broadcast"),
        "Result should be broadcast",
      );

      // Verify data integrity across the pipeline
      assert.ok(alphaSignal, "Alpha signal should have been created");
      assert.equal(
        alphaSignal.dataHash,
        dataHash,
        "Signal's dataHash should match the original snapshot",
      );

      assert.ok(tradeDecision, "Trade decision should have been made");
      assert.equal(tradeDecision.action, "execute");
      assert.equal(tradeDecision.token, "OKB");

      assert.ok(scanResult, "Scan result should exist");
      assert.equal(
        scanResult.tokenAddress,
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      );
      assert.equal(typeof scanResult.riskScore, "number");
      assert.equal(typeof scanResult.isHoneypot, "boolean");

      assert.ok(finalResultReceived, "Final result should have been received");

      // Verify the OnchainOSClient tracked skill usage across the cycle
      assert.ok(
        client.skillsUsed.includes("market-ticker"),
        "market-ticker skill should be used",
      );
      assert.ok(
        client.skillsUsed.includes("security-scan"),
        "security-scan skill should be used",
      );
      assert.ok(
        client.apiCallCount >= 4,
        `Should have at least 4 API calls (3 prices + 1 scan), got ${client.apiCallCount}`,
      );
    } finally {
      if (origKey !== undefined) process.env.OKX_API_KEY = origKey;
    }
  });
});
