/**
 * SYMBIOSIS Agent Runtime -- Orchestrator
 *
 * Boots all 7 autonomous agents, registers them on-chain,
 * and starts their respective cycle intervals.
 *
 * Usage:
 *   NETWORK=testnet node dist/index.js
 *
 * Required .env variables:
 *   NETWORK           - "mainnet" | "testnet" (default: testnet)
 *   PK_DATA_PROVIDER  - private key for DataProviderAgent
 *   PK_ANALYST        - private key for AnalystAgent
 *   PK_TRADER         - private key for TraderAgent
 *   PK_SECURITY       - private key for SecurityAuditorAgent
 *   PK_LIQUIDITY      - private key for LiquidityManagerAgent
 *   PK_ARBITRAGEUR    - private key for ArbitrageurAgent
 *   PK_GOVERNANCE     - private key for GovernanceAgent
 *   OKX_API_KEY       - OKX Onchain OS API key (optional for mock mode)
 *   OKX_SECRET_KEY    - OKX HMAC secret
 *   OKX_PASSPHRASE    - OKX API passphrase
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

// Load .env from project root (one level up from agents/)
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });
import { JsonRpcProvider } from "ethers";

import { getChainConfig } from "./config/xlayer.js";
import { AgentBase } from "./core/AgentBase.js";

import { DataProviderAgent } from "./agents/DataProviderAgent.js";
import { AnalystAgent } from "./agents/AnalystAgent.js";
import { TraderAgent } from "./agents/TraderAgent.js";
import { SecurityAuditorAgent } from "./agents/SecurityAuditorAgent.js";
import { LiquidityManagerAgent } from "./agents/LiquidityManagerAgent.js";
import { ArbitrageurAgent } from "./agents/ArbitrageurAgent.js";
import { GovernanceAgent } from "./agents/GovernanceAgent.js";

// ---------------------------------------------------------------------------
// Cycle intervals (milliseconds)
// ---------------------------------------------------------------------------

const INTERVALS = {
  dataProvider: 30_000,       // 30s -- fetch fresh market data
  analyst: 45_000,            // 45s -- enough data to analyse
  trader: 60_000,             // 60s -- deliberate execution
  securityAuditor: 20_000,    // 20s -- responsive to scan requests
  liquidityManager: 120_000,  // 2m  -- LP positions change slowly
  arbitrageur: 10_000,        // 10s -- fastest, catches fleeting spreads
  governance: 90_000,          // 90s -- governance proposals & voting
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const chain = getChainConfig();
  console.log(`\n=== SYMBIOSIS Agent Economy ===`);
  console.log(`Network : ${chain.name} (chainId ${chain.chainId})`);
  console.log(`RPC     : ${chain.rpcUrl}`);
  console.log(`Block   : ~${chain.blockTimeMs}ms\n`);

  const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId);

  // Read private keys from env (fall back to deterministic dev keys for local testing)
  const keys = {
    dataProvider: process.env.PK_DATA_PROVIDER ?? generateDevKey("data-provider"),
    analyst: process.env.PK_ANALYST ?? generateDevKey("analyst"),
    trader: process.env.PK_TRADER ?? generateDevKey("trader"),
    security: process.env.PK_SECURITY ?? generateDevKey("security"),
    liquidity: process.env.PK_LIQUIDITY ?? generateDevKey("liquidity"),
    arbitrageur: process.env.PK_ARBITRAGEUR ?? generateDevKey("arbitrageur"),
    governance: process.env.PK_GOVERNANCE ?? generateDevKey("governance"),
  };

  // Instantiate agents
  const agents: AgentBase[] = [
    new DataProviderAgent(keys.dataProvider, provider),
    new AnalystAgent(keys.analyst, provider),
    new TraderAgent(keys.trader, provider),
    new SecurityAuditorAgent(keys.security, provider),
    new LiquidityManagerAgent(keys.liquidity, provider),
    new ArbitrageurAgent(keys.arbitrageur, provider),
    new GovernanceAgent(keys.governance, provider),
  ];

  // Register all agents on-chain
  console.log("Registering agents on-chain...\n");
  for (const agent of agents) {
    try {
      await agent.registerOnChain(
        `ipfs://symbiosis/${agent.name.toLowerCase()}`,
        "0.01",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${agent.name}] Registration skipped: ${msg}`);
    }
  }

  // Start all agents with their respective intervals
  console.log("\nStarting agent cycles...\n");

  const intervalKeys = Object.keys(INTERVALS) as (keyof typeof INTERVALS)[];
  for (let i = 0; i < agents.length; i++) {
    const intervalMs = INTERVALS[intervalKeys[i]];
    agents[i].start(intervalMs);
  }

  // Graceful shutdown
  const shutdown = (): void => {
    console.log("\n\nShutting down agents...");
    for (const agent of agents) {
      agent.stop();
    }
    console.log("All agents stopped. Goodbye.\n");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  console.log("All agents running. Press Ctrl+C to stop.\n");
}

/**
 * Generate a deterministic private key for local development.
 * NOT for production -- use real keys via .env in deployment.
 */
function generateDevKey(seed: string): string {
  return "0x" + crypto.createHash("sha256").update(`symbiosis-dev-${seed}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
