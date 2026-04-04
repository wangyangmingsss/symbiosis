/**
 * Comprehensive test suite for SYMBIOSIS agents.
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run with: npm test
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// 1. EventBus tests
// ---------------------------------------------------------------------------

describe("EventBus", () => {
  // Inline import to avoid module resolution issues with .js extensions
  let EventBus: typeof import("../src/core/EventBus.js").EventBus;
  let bus: InstanceType<typeof EventBus>;

  beforeEach(async () => {
    const mod = await import("../src/core/EventBus.js");
    EventBus = mod.EventBus;
    bus = new EventBus();
  });

  it("should subscribe and emit", async () => {
    const received: string[] = [];
    bus.on<string>("test", (data) => {
      received.push(data);
    });

    await bus.emit("test", "hello");
    assert.equal(received.length, 1);
    assert.equal(received[0], "hello");
  });

  it("should deliver to multiple subscribers", async () => {
    let countA = 0;
    let countB = 0;

    bus.on("multi", () => { countA++; });
    bus.on("multi", () => { countB++; });

    await bus.emit("multi", null);
    assert.equal(countA, 1);
    assert.equal(countB, 1);
    assert.equal(bus.listenerCount("multi"), 2);
  });

  it("should unsubscribe correctly", async () => {
    let count = 0;
    const unsub = bus.on("unsub-test", () => { count++; });

    await bus.emit("unsub-test", null);
    assert.equal(count, 1);

    unsub();
    await bus.emit("unsub-test", null);
    assert.equal(count, 1, "handler should not fire after unsubscribe");
    assert.equal(bus.listenerCount("unsub-test"), 0);
  });

  it("should isolate errors in handlers", async () => {
    const received: number[] = [];

    bus.on("err-test", () => {
      throw new Error("boom");
    });
    bus.on<number>("err-test", (data) => {
      received.push(data);
    });

    // Should not throw even though the first handler throws
    await bus.emit("err-test", 42);
    assert.equal(received.length, 1, "second handler should still receive data");
    assert.equal(received[0], 42);
  });

  it("should clear a specific event", () => {
    bus.on("a", () => {});
    bus.on("b", () => {});

    assert.equal(bus.listenerCount("a"), 1);
    assert.equal(bus.listenerCount("b"), 1);

    bus.clear("a");
    assert.equal(bus.listenerCount("a"), 0);
    assert.equal(bus.listenerCount("b"), 1, "other events should remain");
  });

  it("should clear all events when called without args", () => {
    bus.on("x", () => {});
    bus.on("y", () => {});

    bus.clear();
    assert.equal(bus.listenerCount("x"), 0);
    assert.equal(bus.listenerCount("y"), 0);
  });

  it("should handle emit with no subscribers gracefully", async () => {
    // Should not throw
    await bus.emit("no-listeners", { foo: "bar" });
  });
});

// ---------------------------------------------------------------------------
// 2. OnchainOSClient tests
// ---------------------------------------------------------------------------

describe("OnchainOSClient", () => {
  let OnchainOSClient: typeof import("../src/core/OnchainOSClient.js").OnchainOSClient;

  beforeEach(async () => {
    const mod = await import("../src/core/OnchainOSClient.js");
    OnchainOSClient = mod.OnchainOSClient;
  });

  it("should return a valid MarketPrice for OKB (live or mock)", async () => {
    // Without an API key the client may still reach the public OKX endpoint.
    // We verify the returned structure regardless of source.
    const origKey = process.env.OKX_API_KEY;
    delete process.env.OKX_API_KEY;

    try {
      const client = new OnchainOSClient();
      const price = await client.getMarketPrice("OKB");

      assert.equal(price.token, "OKB");
      assert.ok(["okx", "mock"].includes(price.source), `source should be "okx" or "mock", got "${price.source}"`);
      assert.equal(typeof price.price, "number");
      assert.ok(price.price > 0, "price should be positive");
      assert.equal(typeof price.timestamp, "number");
    } finally {
      if (origKey !== undefined) process.env.OKX_API_KEY = origKey;
    }
  });

  it("should return mock price via _mockPrice fallback", async () => {
    // Directly test the mock fallback by accessing the private method
    const client = new OnchainOSClient();
    const mockPrice = (client as any)._mockPrice("OKB");

    assert.equal(mockPrice.token, "OKB");
    assert.equal(mockPrice.source, "mock");
    assert.equal(mockPrice.price, 48.5);
    assert.equal(typeof mockPrice.timestamp, "number");

    // Test unknown token defaults to 1.0
    const unknownMock = (client as any)._mockPrice("UNKNOWN_TOKEN");
    assert.equal(unknownMock.price, 1.0);
  });

  it("should return valid MarketPrice for known tokens (live or mock)", async () => {
    const origKey = process.env.OKX_API_KEY;
    delete process.env.OKX_API_KEY;

    try {
      const client = new OnchainOSClient();

      const eth = await client.getMarketPrice("ETH");
      assert.equal(eth.token, "ETH");
      assert.equal(typeof eth.price, "number");
      assert.ok(eth.price > 0, "ETH price should be positive");

      const btc = await client.getMarketPrice("BTC");
      assert.equal(btc.token, "BTC");
      assert.ok(btc.price > 0, "BTC price should be positive");
    } finally {
      if (origKey !== undefined) process.env.OKX_API_KEY = origKey;
    }
  });

  it("_mockPrice should return correct fallback prices", async () => {
    const client = new OnchainOSClient();
    const mock = (client as any)._mockPrice;

    assert.equal(mock.call(client, "ETH").price, 3200);
    assert.equal(mock.call(client, "BTC").price, 62000);
    assert.equal(mock.call(client, "USDT").price, 1.0);
    assert.equal(mock.call(client, "USDC").price, 1.0);
    assert.equal(mock.call(client, "RANDOM").price, 1.0, "unknown tokens default to 1.0");
  });

  it("getDexQuote should return proper DexQuote structure on fallback", async () => {
    const origKey = process.env.OKX_API_KEY;
    delete process.env.OKX_API_KEY;

    try {
      const client = new OnchainOSClient();
      const quote = await client.getDexQuote(
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
        "1000000000000000000", // 1 token in wei
      );

      // Verify DexQuote shape
      assert.equal(typeof quote.fromToken, "string");
      assert.equal(typeof quote.toToken, "string");
      assert.equal(typeof quote.fromAmount, "string");
      assert.equal(typeof quote.toAmount, "string");
      assert.equal(typeof quote.priceImpact, "number");
      assert.ok(Array.isArray(quote.route), "route should be an array");
      assert.equal(typeof quote.estimatedGas, "string");

      // Verify fallback values
      assert.equal(quote.fromToken, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
      assert.deepEqual(quote.route, ["mock-dex"]);
      assert.equal(quote.estimatedGas, "200000");
      assert.equal(quote.priceImpact, 0.01);
    } finally {
      if (origKey !== undefined) process.env.OKX_API_KEY = origKey;
    }
  });

  it("should generate correct HMAC auth headers", async () => {
    const origKey = process.env.OKX_API_KEY;
    const origSecret = process.env.OKX_SECRET_KEY;
    const origPass = process.env.OKX_PASSPHRASE;
    const origProject = process.env.OKX_PROJECT_ID;

    process.env.OKX_API_KEY = "test-api-key";
    process.env.OKX_SECRET_KEY = "test-secret-key";
    process.env.OKX_PASSPHRASE = "test-passphrase";
    process.env.OKX_PROJECT_ID = "test-project-id";

    try {
      const client = new OnchainOSClient();

      // Access private _authHeaders via type bypass
      const authHeaders = (client as any)._authHeaders("GET", "/api/v5/market/ticker?instId=OKB-USDT", "");

      assert.equal(authHeaders["OK-ACCESS-KEY"], "test-api-key");
      assert.equal(authHeaders["OK-ACCESS-PASSPHRASE"], "test-passphrase");
      assert.equal(authHeaders["OK-ACCESS-PROJECT"], "test-project-id");
      assert.ok(authHeaders["OK-ACCESS-TIMESTAMP"], "should have a timestamp");
      assert.ok(authHeaders["OK-ACCESS-SIGN"], "should have a signature");

      // Verify the HMAC signature independently
      const timestamp = authHeaders["OK-ACCESS-TIMESTAMP"];
      const prehash = timestamp + "GET" + "/api/v5/market/ticker?instId=OKB-USDT" + "";
      const expectedSig = crypto
        .createHmac("sha256", "test-secret-key")
        .update(prehash)
        .digest("base64");

      assert.equal(authHeaders["OK-ACCESS-SIGN"], expectedSig, "HMAC signature should match");
    } finally {
      // Restore original env
      if (origKey !== undefined) process.env.OKX_API_KEY = origKey; else delete process.env.OKX_API_KEY;
      if (origSecret !== undefined) process.env.OKX_SECRET_KEY = origSecret; else delete process.env.OKX_SECRET_KEY;
      if (origPass !== undefined) process.env.OKX_PASSPHRASE = origPass; else delete process.env.OKX_PASSPHRASE;
      if (origProject !== undefined) process.env.OKX_PROJECT_ID = origProject; else delete process.env.OKX_PROJECT_ID;
    }
  });

  it("should track API call count", async () => {
    const origKey = process.env.OKX_API_KEY;
    delete process.env.OKX_API_KEY;

    try {
      const client = new OnchainOSClient();
      assert.equal(client.apiCallCount, 0);

      // Each getMarketPrice call triggers one _get call
      await client.getMarketPrice("OKB");
      assert.equal(client.apiCallCount, 1);

      await client.getMarketPrice("ETH");
      assert.equal(client.apiCallCount, 2);
    } finally {
      if (origKey !== undefined) process.env.OKX_API_KEY = origKey;
    }
  });

  it("should track skills used", async () => {
    const origKey = process.env.OKX_API_KEY;
    delete process.env.OKX_API_KEY;

    try {
      const client = new OnchainOSClient();
      assert.deepEqual(client.skillsUsed, []);

      await client.getMarketPrice("OKB");
      assert.ok(client.skillsUsed.includes("market-ticker"));

      await client.getDexQuote("0xaaa", "0xbbb", "1000");
      assert.ok(client.skillsUsed.includes("dex-quote"));
    } finally {
      if (origKey !== undefined) process.env.OKX_API_KEY = origKey;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Agent config tests
// ---------------------------------------------------------------------------

describe("Agent config", () => {
  it("ADDRESSES should be valid Ethereum addresses", async () => {
    const { ADDRESSES } = await import("../src/config/contracts.js");
    const ethAddrRegex = /^0x[0-9a-fA-F]{40}$/;

    for (const [name, addr] of Object.entries(ADDRESSES)) {
      assert.match(
        addr,
        ethAddrRegex,
        `${name} address "${addr}" is not a valid Ethereum address`,
      );
    }
  });

  it("ADDRESSES should have all 6 required contracts", async () => {
    const { ADDRESSES } = await import("../src/config/contracts.js");
    const expectedKeys = [
      "AgentRegistry",
      "ServiceMarketplace",
      "ReputationEngine",
      "EscrowSettlement",
      "AgentTreasury",
      "EconomyOracle",
    ];

    for (const key of expectedKeys) {
      assert.ok(
        key in ADDRESSES,
        `ADDRESSES should contain ${key}`,
      );
    }
  });

  it("SERVICE_TYPES should be defined", async () => {
    const { SERVICE_TYPES } = await import("../src/config/contracts.js");

    const expectedTypes = [
      "MARKET_DATA",
      "ALPHA_SIGNAL",
      "TRADE_EXECUTION",
      "SECURITY_AUDIT",
      "LP_MANAGEMENT",
      "ARBITRAGE_SIGNAL",
    ];

    for (const t of expectedTypes) {
      assert.ok(
        t in SERVICE_TYPES,
        `SERVICE_TYPES should contain ${t}`,
      );
      assert.equal(
        (SERVICE_TYPES as any)[t],
        t,
        `SERVICE_TYPES.${t} should equal "${t}"`,
      );
    }
  });

  it("AgentType enum should have all 6 types", async () => {
    const { AgentType } = await import("../src/config/contracts.js");

    assert.equal(AgentType.DataProvider, 0);
    assert.equal(AgentType.Trader, 1);
    assert.equal(AgentType.Analyst, 2);
    assert.equal(AgentType.LiquidityManager, 3);
    assert.equal(AgentType.SecurityAuditor, 4);
    assert.equal(AgentType.Arbitrageur, 5);

    // Verify reverse mapping works (TypeScript numeric enums)
    assert.equal(AgentType[0], "DataProvider");
    assert.equal(AgentType[5], "Arbitrageur");
  });
});

// ---------------------------------------------------------------------------
// 4. Integration flow tests
// ---------------------------------------------------------------------------

describe("Integration flow", () => {
  let EventBus: typeof import("../src/core/EventBus.js").EventBus;

  beforeEach(async () => {
    const mod = await import("../src/core/EventBus.js");
    EventBus = mod.EventBus;
  });

  it("DataProvider emits market:data -> Analyst receives", async () => {
    const bus = new EventBus();

    // Simulate Analyst subscribing to market data
    const received: Array<{ timestamp: number; prices: any[]; dataHash: string }> = [];
    bus.on("market:data", (snapshot: any) => {
      received.push(snapshot);
    });

    // Simulate DataProvider emitting a market data snapshot
    const snapshot = {
      timestamp: Date.now(),
      prices: [
        { token: "OKB", price: 48.5, timestamp: Date.now(), source: "mock" },
        { token: "ETH", price: 3200, timestamp: Date.now(), source: "mock" },
      ],
      dataHash: "0xabc123",
    };

    await bus.emit("market:data", snapshot);

    assert.equal(received.length, 1);
    assert.equal(received[0].prices.length, 2);
    assert.equal(received[0].prices[0].token, "OKB");
    assert.equal(received[0].dataHash, "0xabc123");
  });

  it("Analyst emits alpha:signal -> Trader receives", async () => {
    const bus = new EventBus();

    let traderSignal: any = null;
    bus.on("alpha:signal", (signal: any) => {
      traderSignal = signal;
    });

    const signal = {
      timestamp: Date.now(),
      token: "OKB",
      direction: "long" as const,
      confidence: 0.85,
      regime: "trending_up" as const,
      volatility: 0.015,
      dataHash: "0xdef456",
    };

    await bus.emit("alpha:signal", signal);

    assert.ok(traderSignal, "Trader should have received the signal");
    assert.equal(traderSignal.direction, "long");
    assert.equal(traderSignal.confidence, 0.85);
    assert.equal(traderSignal.token, "OKB");
  });

  it("Trader emits security:request -> SecurityAuditor receives", async () => {
    const bus = new EventBus();

    const securityRequests: Array<{ tokenAddress: string; requester: string }> = [];
    bus.on("security:request", (req: any) => {
      securityRequests.push(req);
    });

    // Simulate Trader requesting a security audit
    await bus.emit("security:request", {
      tokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      requester: "Trader",
    });

    assert.equal(securityRequests.length, 1);
    assert.equal(securityRequests[0].requester, "Trader");
    assert.equal(
      securityRequests[0].tokenAddress,
      "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    );
  });

  it("SecurityAuditor emits security:result -> Trader receives", async () => {
    const bus = new EventBus();

    let scanResult: any = null;
    bus.on("security:result", (result: any) => {
      scanResult = result;
    });

    // Simulate SecurityAuditor emitting scan results
    const result = {
      tokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      riskScore: 10,
      isHoneypot: false,
      hasProxyContract: false,
      ownerCanMint: false,
      holders: 1000,
      warnings: [],
    };

    await bus.emit("security:result", result);

    assert.ok(scanResult, "Trader should have received the scan result");
    assert.equal(scanResult.riskScore, 10);
    assert.equal(scanResult.isHoneypot, false);
    assert.equal(scanResult.holders, 1000);
  });

  it("full pipeline: DataProvider -> Analyst -> Trader -> SecurityAuditor round trip", async () => {
    const bus = new EventBus();
    const events: string[] = [];

    // Wire up event chain
    bus.on("market:data", () => {
      events.push("market:data received");
      // Analyst would process and emit alpha signal
      bus.emit("alpha:signal", {
        token: "OKB",
        direction: "long",
        confidence: 0.85,
      });
    });

    bus.on("alpha:signal", (signal: any) => {
      events.push("alpha:signal received");
      if (signal.confidence >= 0.7) {
        // Trader requests security audit
        bus.emit("security:request", {
          tokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
          requester: "Trader",
        });
      }
    });

    bus.on("security:request", (req: any) => {
      events.push("security:request received");
      // SecurityAuditor processes and returns result
      bus.emit("security:result", {
        tokenAddress: req.tokenAddress,
        riskScore: 5,
        isHoneypot: false,
      });
    });

    bus.on("security:result", () => {
      events.push("security:result received");
    });

    // Kick off the pipeline
    await bus.emit("market:data", {
      timestamp: Date.now(),
      prices: [{ token: "OKB", price: 48.5 }],
      dataHash: "0xtest",
    });

    // Allow microtasks to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(events.includes("market:data received"), "market:data should be received");
    assert.ok(events.includes("alpha:signal received"), "alpha:signal should be received");
    assert.ok(events.includes("security:request received"), "security:request should be received");
    assert.ok(events.includes("security:result received"), "security:result should be received");
  });
});
