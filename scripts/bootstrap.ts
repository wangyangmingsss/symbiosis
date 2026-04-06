/**
 * bootstrap.ts — One-click SYMBIOSIS protocol bootstrap
 *
 * Demonstrates the full lifecycle of the agent-services economy on X Layer:
 *   1.  Check wallet balances (deployer + 6 agents)
 *   2.  Fund agent wallets from deployer (0.02 OKB each)
 *   3.  Register all 6 agents on AgentRegistry (0.01 OKB stake)
 *   4.  List services on the marketplace
 *   5.  Create cross-agent service requests
 *   6.  Accept requests & match services
 *   7.  Create escrows and release them (x402 payment flow)
 *   8.  Treasury deposits from every agent
 *   9.  Economy oracle snapshots
 *  10.  (Optional) Live DEX swap when LIVE_TRADE=true
 *  11.  Final summary: tx count, skills used, balances
 *
 * Run:
 *   npx tsx scripts/bootstrap.ts
 *
 * Environment variables:
 *   PRIVATE_KEY          — deployer / owner wallet
 *   PK_DATA_PROVIDER     — agent 0 (falls back to hardcoded testnet key)
 *   PK_ANALYST           — agent 2
 *   PK_TRADER            — agent 1
 *   PK_SECURITY          — agent 4
 *   PK_LIQUIDITY         — agent 3
 *   PK_ARBITRAGEUR       — agent 5
 *   RPC_URL              — JSON-RPC endpoint (default: X Layer testnet)
 *   ADDR_REGISTRY, ADDR_MARKETPLACE, ADDR_ESCROW, ADDR_TREASURY,
 *   ADDR_ORACLE, ADDR_REPUTATION — contract overrides
 *   LIVE_TRADE           — set "true" to attempt a real DEX swap
 */

import "dotenv/config";
import { ethers } from "ethers";

// ============================================================================
// ABIs
// ============================================================================

const AGENT_REGISTRY_ABI = [
  "function registerAgent(uint8 agentType, string metadataURI) external payable",
  "function isRegistered(address agent) external view returns (bool)",
  "function getAgentCount() external view returns (uint256)",
];

const SERVICE_MARKETPLACE_ABI = [
  "function listService(bytes32 serviceType, uint256 startPrice, uint256 floorPrice, uint256 decayRate, uint256 maxFulfillments) external returns (uint256)",
  "function requestService(bytes32 serviceType, uint256 maxBudget, uint256 deadline) external returns (uint256)",
  "function acceptRequest(uint256 requestId, uint256 listingId) external",
  "function completeService(uint256 requestId, bytes32 proofHash) external",
  "function getListingCount() external view returns (uint256)",
  "function getRequestCount() external view returns (uint256)",
];

const ESCROW_SETTLEMENT_ABI = [
  "function createEscrow(uint256 requestId, address seller, uint256 amount, uint256 duration) external payable returns (uint256)",
  "function releaseEscrow(uint256 escrowId) external",
  "function batchSettle(uint256[] escrowIds) external",
];

const AGENT_TREASURY_ABI = [
  "function deposit() external payable",
  "function getBalance(address agent) external view returns (uint256)",
  "function getPnL(address agent) external view returns (int256)",
];

const ECONOMY_ORACLE_ABI = [
  "function takeSnapshot(uint256 activeAgents, uint256 totalListings, uint256 totalRequests, uint256 totalMatches, uint256 totalEscrowVolume, uint256 totalSettled, uint256 gdp) external",
  "function getLatestSnapshot() external view returns (tuple(uint256 timestamp, uint256 activeAgents, uint256 totalListings, uint256 totalRequests, uint256 totalMatches, uint256 totalEscrowVolume, uint256 totalSettled, uint256 gdp))",
];

const REPUTATION_ENGINE_ABI = [
  "function getReputation(address agent) external view returns (uint256)",
  "function getTopAgents(uint256 count) external view returns (address[], uint256[])",
];

// Minimal Uniswap V2 Router ABI for optional live swap
const UNISWAP_ROUTER_ABI = [
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) external payable returns (uint256[] amounts)",
  "function WETH() external view returns (address)",
];

// ============================================================================
// Constants & Config
// ============================================================================

const RPC_URL = process.env.RPC_URL ?? "https://testrpc.xlayer.tech";

/** Deployed contract addresses — overridable via env */
const ADDRESSES = {
  AgentRegistry:      process.env.ADDR_REGISTRY    ?? "0x33dB9d89F2f4E13470469bB4ccf7f708d8333987",
  ServiceMarketplace: process.env.ADDR_MARKETPLACE ?? "0x58Eb47a4b6F2b777730828Cb8AD77032993a9dbf",
  ReputationEngine:   process.env.ADDR_REPUTATION  ?? "0x6cAa9D8b182f1919d3F6b10AadcaCc542363463F",
  EscrowSettlement:   process.env.ADDR_ESCROW      ?? "0x160dDA2B8dc2f0136AFA6BFbC54D3127163E428A",
  AgentTreasury:      process.env.ADDR_TREASURY    ?? "0x1CE0CAe16F38B32a0dc1aB1fe4E34eFC4942A5F7",
  EconomyOracle:      process.env.ADDR_ORACLE      ?? "0x72d0B059941B0603bff3593Fa2c8Ca26825AE834",
  GovernanceRegistry: process.env.ADDR_GOVERNANCE  ?? "0x016C98657AEE961f5764359030aa15a2fb174351",
};

/** Keccak-256 hashes of canonical service type strings */
const SERVICE_TYPES = {
  MARKET_DATA:      ethers.keccak256(ethers.toUtf8Bytes("MARKET_DATA")),
  ALPHA_SIGNAL:     ethers.keccak256(ethers.toUtf8Bytes("ALPHA_SIGNAL")),
  TRADE_EXECUTION:  ethers.keccak256(ethers.toUtf8Bytes("TRADE_EXECUTION")),
  SECURITY_AUDIT:   ethers.keccak256(ethers.toUtf8Bytes("SECURITY_AUDIT")),
  LP_MANAGEMENT:    ethers.keccak256(ethers.toUtf8Bytes("LP_MANAGEMENT")),
  ARBITRAGE_SIGNAL: ethers.keccak256(ethers.toUtf8Bytes("ARBITRAGE_SIGNAL")),
};

/** Agent type enum (mirrors IAgentRegistry.AgentType in Solidity) */
enum AgentType {
  DataProvider     = 0,
  Trader           = 1,
  Analyst          = 2,
  LiquidityManager = 3,
  SecurityAuditor  = 4,
  Arbitrageur      = 5,
}

// ---------------------------------------------------------------------------
// Agent wallet definitions
// Private keys are read from env vars with hardcoded testnet fallbacks.
// ---------------------------------------------------------------------------

interface AgentDef {
  name: string;
  type: AgentType;
  pkEnv: string;         // env var name
  fallbackPk: string;    // testnet fallback key
  metadata: string;      // on-chain metadata URI
  serviceTypes: string[];// service type hashes this agent will list
  serviceNames: string[];// human-readable names (parallel to serviceTypes)
}

const AGENT_DEFS: AgentDef[] = [
  {
    name: "DataProvider",
    type: AgentType.DataProvider,
    pkEnv: "PK_DATA_PROVIDER",
    fallbackPk: "0x9745c732f841010c6801088dcc2f7e69c953f2c064560974ba98024d0d678a75",
    metadata: "ipfs://QmSymbiosis/agent-data-provider",
    serviceTypes: [SERVICE_TYPES.MARKET_DATA],
    serviceNames: ["MARKET_DATA"],
  },
  {
    name: "Trader",
    type: AgentType.Trader,
    pkEnv: "PK_TRADER",
    fallbackPk: "0xd2168d58a16da270a1660b09e925d9233d48d7dd1cd86440d216bce2624f4447",
    metadata: "ipfs://QmSymbiosis/agent-trader",
    serviceTypes: [SERVICE_TYPES.TRADE_EXECUTION],
    serviceNames: ["TRADE_EXECUTION"],
  },
  {
    name: "Analyst",
    type: AgentType.Analyst,
    pkEnv: "PK_ANALYST",
    fallbackPk: "0x0ac4fa6ae65c6f157351126c2763ff898aa376d22e6999f88d3424239ab7b9b5",
    metadata: "ipfs://QmSymbiosis/agent-analyst",
    serviceTypes: [SERVICE_TYPES.ALPHA_SIGNAL],
    serviceNames: ["ALPHA_SIGNAL"],
  },
  {
    name: "LiquidityManager",
    type: AgentType.LiquidityManager,
    pkEnv: "PK_LIQUIDITY",
    fallbackPk: "0xf9033bdbbf1a611f887a710c3e424d2d613539b51e40f765109db908beb79bd7",
    metadata: "ipfs://QmSymbiosis/agent-lp-manager",
    serviceTypes: [SERVICE_TYPES.LP_MANAGEMENT],
    serviceNames: ["LP_MANAGEMENT"],
  },
  {
    name: "SecurityAuditor",
    type: AgentType.SecurityAuditor,
    pkEnv: "PK_SECURITY",
    fallbackPk: "0xe8429961c5831f4be3c2eb73dbbfc085982a46825b74e6d88f612a39ab6263f5",
    metadata: "ipfs://QmSymbiosis/agent-security-auditor",
    serviceTypes: [SERVICE_TYPES.SECURITY_AUDIT],
    serviceNames: ["SECURITY_AUDIT"],
  },
  {
    name: "Arbitrageur",
    type: AgentType.Arbitrageur,
    pkEnv: "PK_ARBITRAGEUR",
    fallbackPk: "0x9678d6165ed4e06608e2b6119e89dc6b9f7a017fd28b2ee6a494d9e32ce3af2e",
    metadata: "ipfs://QmSymbiosis/agent-arbitrageur",
    serviceTypes: [SERVICE_TYPES.ARBITRAGE_SIGNAL],
    serviceNames: ["ARBITRAGE_SIGNAL"],
  },
];

// ============================================================================
// Tracking & helpers
// ============================================================================

/** Running transaction counter */
let txCount = 0;
/** Collected transaction hashes */
const txHashes: string[] = [];
/** Onchain OS API skills exercised during this run */
const skillsUsed = new Set<string>();

/**
 * Execute a contract write, log the result, and continue on failure.
 * Returns the receipt on success, null on failure.
 */
async function sendTx(
  description: string,
  fn: () => Promise<ethers.ContractTransactionResponse>,
): Promise<ethers.ContractTransactionReceipt | null> {
  txCount++;
  const label = `TX #${txCount}`;
  try {
    console.log(`\n--- ${label}: ${description} ---`);
    const tx = await fn();
    console.log(`  Hash:   ${tx.hash}`);
    txHashes.push(tx.hash);
    const receipt = await tx.wait();
    console.log(`  Status: ${receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);
    console.log(`  Gas:    ${receipt?.gasUsed?.toString()}`);
    return receipt;
  } catch (err: any) {
    const reason = err?.reason ?? err?.shortMessage ?? err?.message ?? String(err);
    console.error(`  FAILED: ${reason}`);
    return null;
  }
}

/** Shorthand: create a Wallet from a private key + provider */
function mkWallet(pk: string, provider: ethers.JsonRpcProvider): ethers.Wallet {
  return new ethers.Wallet(pk, provider);
}

/** Format OKB with 4 decimal places */
function fmtOKB(wei: bigint): string {
  return `${ethers.formatEther(wei)} OKB`;
}

/** Record an Onchain OS skill as "used" */
function skill(name: string): void {
  skillsUsed.add(name);
}

// ============================================================================
// PHASE 1 — Check wallet balances
// ============================================================================

async function phase1_checkBalances(
  provider: ethers.JsonRpcProvider,
  deployer: ethers.Wallet,
  agentWallets: ethers.Wallet[],
): Promise<Map<string, bigint>> {
  console.log("\n==========================================================");
  console.log("  PHASE 1: Check Wallet Balances");
  console.log("==========================================================");
  skill("wallet.getBalance");

  const balances = new Map<string, bigint>();

  // Deployer balance
  const deployerBal = await provider.getBalance(deployer.address);
  balances.set("deployer", deployerBal);
  console.log(`  Deployer (${deployer.address}): ${fmtOKB(deployerBal)}`);

  // Agent balances
  for (let i = 0; i < agentWallets.length; i++) {
    const bal = await provider.getBalance(agentWallets[i].address);
    balances.set(AGENT_DEFS[i].name, bal);
    console.log(`  Agent ${i} ${AGENT_DEFS[i].name.padEnd(18)} (${agentWallets[i].address}): ${fmtOKB(bal)}`);
  }

  return balances;
}

// ============================================================================
// PHASE 2 — Fund agent wallets (0.02 OKB each)
// ============================================================================

async function phase2_fundAgents(
  deployer: ethers.Wallet,
  agentWallets: ethers.Wallet[],
  provider: ethers.JsonRpcProvider,
): Promise<void> {
  console.log("\n==========================================================");
  console.log("  PHASE 2: Fund Agent Wallets (0.02 OKB each)");
  console.log("==========================================================");
  skill("wallet.sendTransaction");

  const fundAmount = ethers.parseEther("0.02");
  const deployerBal = await provider.getBalance(deployer.address);
  const totalNeeded = fundAmount * BigInt(agentWallets.length);

  if (deployerBal < totalNeeded) {
    console.log(`  WARNING: Deployer balance (${fmtOKB(deployerBal)}) may be insufficient`);
    console.log(`           to fund all agents (need ${fmtOKB(totalNeeded)}). Will try anyway.`);
  }

  for (let i = 0; i < agentWallets.length; i++) {
    const agentBal = await provider.getBalance(agentWallets[i].address);
    // Skip if agent already has >= 0.015 OKB
    if (agentBal >= ethers.parseEther("0.015")) {
      console.log(`  Agent ${i} (${AGENT_DEFS[i].name}) already has ${fmtOKB(agentBal)}, skipping.`);
      continue;
    }

    await sendTx(
      `Fund Agent ${i} (${AGENT_DEFS[i].name}) with 0.02 OKB`,
      async () => {
        const tx = await deployer.sendTransaction({
          to: agentWallets[i].address,
          value: fundAmount,
        });
        return tx as unknown as ethers.ContractTransactionResponse;
      },
    );
  }
}

// ============================================================================
// PHASE 3 — Register agents on AgentRegistry (0.01 OKB stake)
// ============================================================================

async function phase3_registerAgents(
  registry: ethers.Contract,
  agentWallets: ethers.Wallet[],
): Promise<void> {
  console.log("\n==========================================================");
  console.log("  PHASE 3: Register Agents on AgentRegistry (0.01 OKB stake)");
  console.log("==========================================================");
  skill("AgentRegistry.registerAgent");
  skill("AgentRegistry.isRegistered");

  const stakeAmount = ethers.parseEther("0.01");

  for (let i = 0; i < AGENT_DEFS.length; i++) {
    const def = AGENT_DEFS[i];
    const w = agentWallets[i];

    // Check if already registered
    try {
      const already = await (registry.connect(w) as ethers.Contract).isRegistered(w.address);
      if (already) {
        console.log(`  Agent ${i} (${def.name}) already registered — skipping.`);
        continue;
      }
    } catch {
      // isRegistered may revert for unknown agents; proceed to register
    }

    await sendTx(
      `Register Agent ${i} (${def.name}) type=${def.type}`,
      () =>
        (registry.connect(w) as ethers.Contract).registerAgent(
          def.type,
          def.metadata,
          { value: stakeAmount },
        ),
    );
  }
}

// ============================================================================
// PHASE 4 — List services on the marketplace
// ============================================================================

async function phase4_listServices(
  marketplace: ethers.Contract,
  agentWallets: ethers.Wallet[],
): Promise<void> {
  console.log("\n==========================================================");
  console.log("  PHASE 4: List Services on Marketplace");
  console.log("==========================================================");
  skill("ServiceMarketplace.listService");

  // Each agent lists their specialty service(s)
  // Parameters: startPrice, floorPrice, decayRate (per block), maxFulfillments
  const listingPlans: {
    agentIdx: number;
    serviceHash: string;
    serviceName: string;
    startPrice: bigint;
    floorPrice: bigint;
    decayRate: bigint;
    maxFulfillments: number;
  }[] = [
    // DataProvider lists MARKET_DATA (twice — different tiers)
    { agentIdx: 0, serviceHash: SERVICE_TYPES.MARKET_DATA,      serviceName: "MARKET_DATA",      startPrice: ethers.parseUnits("500", 12), floorPrice: ethers.parseUnits("200", 12), decayRate: 1_000_000_000n, maxFulfillments: 10 },
    { agentIdx: 0, serviceHash: SERVICE_TYPES.MARKET_DATA,      serviceName: "MARKET_DATA",      startPrice: ethers.parseUnits("300", 12), floorPrice: ethers.parseUnits("100", 12), decayRate: 500_000_000n,   maxFulfillments: 20 },
    // Trader lists TRADE_EXECUTION and ALPHA_SIGNAL
    { agentIdx: 1, serviceHash: SERVICE_TYPES.TRADE_EXECUTION,  serviceName: "TRADE_EXECUTION",  startPrice: ethers.parseUnits("800", 12), floorPrice: ethers.parseUnits("300", 12), decayRate: 2_000_000_000n, maxFulfillments: 5 },
    { agentIdx: 1, serviceHash: SERVICE_TYPES.ALPHA_SIGNAL,     serviceName: "ALPHA_SIGNAL",     startPrice: ethers.parseUnits("600", 12), floorPrice: ethers.parseUnits("200", 12), decayRate: 1_500_000_000n, maxFulfillments: 8 },
    // Analyst lists ALPHA_SIGNAL and MARKET_DATA
    { agentIdx: 2, serviceHash: SERVICE_TYPES.ALPHA_SIGNAL,     serviceName: "ALPHA_SIGNAL",     startPrice: ethers.parseUnits("400", 12), floorPrice: ethers.parseUnits("150", 12), decayRate: 1_000_000_000n, maxFulfillments: 10 },
    { agentIdx: 2, serviceHash: SERVICE_TYPES.MARKET_DATA,      serviceName: "MARKET_DATA",      startPrice: ethers.parseUnits("350", 12), floorPrice: ethers.parseUnits("120", 12), decayRate: 800_000_000n,   maxFulfillments: 15 },
    // LiquidityManager lists LP_MANAGEMENT
    { agentIdx: 3, serviceHash: SERVICE_TYPES.LP_MANAGEMENT,    serviceName: "LP_MANAGEMENT",    startPrice: ethers.parseUnits("700", 12), floorPrice: ethers.parseUnits("250", 12), decayRate: 1_800_000_000n, maxFulfillments: 5 },
    { agentIdx: 3, serviceHash: SERVICE_TYPES.LP_MANAGEMENT,    serviceName: "LP_MANAGEMENT",    startPrice: ethers.parseUnits("500", 12), floorPrice: ethers.parseUnits("200", 12), decayRate: 1_200_000_000n, maxFulfillments: 8 },
    // SecurityAuditor lists SECURITY_AUDIT
    { agentIdx: 4, serviceHash: SERVICE_TYPES.SECURITY_AUDIT,   serviceName: "SECURITY_AUDIT",   startPrice: ethers.parseUnits("900", 12), floorPrice: ethers.parseUnits("400", 12), decayRate: 2_500_000_000n, maxFulfillments: 3 },
    { agentIdx: 4, serviceHash: SERVICE_TYPES.SECURITY_AUDIT,   serviceName: "SECURITY_AUDIT",   startPrice: ethers.parseUnits("600", 12), floorPrice: ethers.parseUnits("250", 12), decayRate: 1_500_000_000n, maxFulfillments: 6 },
    // Arbitrageur lists ARBITRAGE_SIGNAL
    { agentIdx: 5, serviceHash: SERVICE_TYPES.ARBITRAGE_SIGNAL, serviceName: "ARBITRAGE_SIGNAL", startPrice: ethers.parseUnits("500", 12), floorPrice: ethers.parseUnits("180", 12), decayRate: 1_300_000_000n, maxFulfillments: 10 },
    { agentIdx: 5, serviceHash: SERVICE_TYPES.ARBITRAGE_SIGNAL, serviceName: "ARBITRAGE_SIGNAL", startPrice: ethers.parseUnits("350", 12), floorPrice: ethers.parseUnits("120", 12), decayRate: 900_000_000n,   maxFulfillments: 15 },
  ];

  for (const plan of listingPlans) {
    const w = agentWallets[plan.agentIdx];
    await sendTx(
      `Agent ${plan.agentIdx} (${AGENT_DEFS[plan.agentIdx].name}) lists ${plan.serviceName}`,
      () =>
        (marketplace.connect(w) as ethers.Contract).listService(
          plan.serviceHash,
          plan.startPrice,
          plan.floorPrice,
          plan.decayRate,
          plan.maxFulfillments,
        ),
    );
  }
}

// ============================================================================
// PHASE 5 — Create service requests between agents
// ============================================================================

async function phase5_createRequests(
  marketplace: ethers.Contract,
  agentWallets: ethers.Wallet[],
  deadline: number,
): Promise<number> {
  console.log("\n==========================================================");
  console.log("  PHASE 5: Create Cross-Agent Service Requests");
  console.log("==========================================================");
  skill("ServiceMarketplace.requestService");
  skill("ServiceMarketplace.getRequestCount");

  // Capture starting request ID so we can reference our requests later
  let startingRequestId = 0;
  try {
    startingRequestId = Number(await marketplace.getRequestCount());
  } catch { /* first run */ }
  console.log(`  Existing requests on-chain: ${startingRequestId}`);

  // Each request: [requesterAgentIdx, serviceTypeHash, serviceTypeName, maxBudget]
  const requestPlans: { agentIdx: number; hash: string; name: string; budget: bigint }[] = [
    { agentIdx: 1, hash: SERVICE_TYPES.MARKET_DATA,      name: "MARKET_DATA",      budget: ethers.parseUnits("500", 12) },  // Trader wants data
    { agentIdx: 2, hash: SERVICE_TYPES.MARKET_DATA,      name: "MARKET_DATA",      budget: ethers.parseUnits("400", 12) },  // Analyst wants data
    { agentIdx: 1, hash: SERVICE_TYPES.ALPHA_SIGNAL,     name: "ALPHA_SIGNAL",     budget: ethers.parseUnits("500", 12) },  // Trader wants signals
    { agentIdx: 3, hash: SERVICE_TYPES.SECURITY_AUDIT,   name: "SECURITY_AUDIT",   budget: ethers.parseUnits("900", 12) },  // LP Manager wants audit
    { agentIdx: 0, hash: SERVICE_TYPES.TRADE_EXECUTION,  name: "TRADE_EXECUTION",  budget: ethers.parseUnits("800", 12) },  // DataProvider wants execution
    { agentIdx: 5, hash: SERVICE_TYPES.LP_MANAGEMENT,    name: "LP_MANAGEMENT",    budget: ethers.parseUnits("700", 12) },  // Arb wants LP
    { agentIdx: 4, hash: SERVICE_TYPES.ARBITRAGE_SIGNAL, name: "ARBITRAGE_SIGNAL", budget: ethers.parseUnits("500", 12) },  // Auditor wants arb signals
    { agentIdx: 0, hash: SERVICE_TYPES.ALPHA_SIGNAL,     name: "ALPHA_SIGNAL",     budget: ethers.parseUnits("600", 12) },  // DataProvider wants alpha
  ];

  for (const plan of requestPlans) {
    const w = agentWallets[plan.agentIdx];
    await sendTx(
      `Agent ${plan.agentIdx} (${AGENT_DEFS[plan.agentIdx].name}) requests ${plan.name}`,
      () =>
        (marketplace.connect(w) as ethers.Contract).requestService(
          plan.hash,
          plan.budget,
          deadline,
        ),
    );
  }

  return startingRequestId;
}

// ============================================================================
// PHASE 6 — Accept requests & match services
// ============================================================================

async function phase6_acceptAndMatch(
  marketplace: ethers.Contract,
  agentWallets: ethers.Wallet[],
  startingRequestId: number,
): Promise<void> {
  console.log("\n==========================================================");
  console.log("  PHASE 6: Accept Requests & Match Services");
  console.log("==========================================================");
  skill("ServiceMarketplace.acceptRequest");
  skill("ServiceMarketplace.getListingCount");

  // Determine listing offset so we reference our own listings
  let startingListingId = 0;
  try {
    const totalListings = Number(await marketplace.getListingCount());
    startingListingId = Math.max(0, totalListings - 12); // we listed 12 services
  } catch { /* first run */ }
  console.log(`  Our listings start at ID: ${startingListingId}`);

  // Match table: [requestOffset, listingOffset, providerAgentIdx]
  // Maps each request to the best-fit listing from a different agent
  const matchTable: [number, number, number][] = [
    [0, 0, 0],   // Req 0 (MARKET_DATA)      <- Listing 0  (DataProvider)
    [1, 1, 0],   // Req 1 (MARKET_DATA)      <- Listing 1  (DataProvider)
    [2, 4, 2],   // Req 2 (ALPHA_SIGNAL)     <- Listing 4  (Analyst)
    [3, 8, 4],   // Req 3 (SECURITY_AUDIT)   <- Listing 8  (SecurityAuditor)
    [4, 2, 1],   // Req 4 (TRADE_EXECUTION)  <- Listing 2  (Trader)
    [5, 6, 3],   // Req 5 (LP_MANAGEMENT)    <- Listing 6  (LiquidityManager)
    [6, 10, 5],  // Req 6 (ARBITRAGE_SIGNAL) <- Listing 10 (Arbitrageur)
    [7, 3, 1],   // Req 7 (ALPHA_SIGNAL)     <- Listing 3  (Trader)
  ];

  for (const [reqOff, listOff, providerIdx] of matchTable) {
    const reqId = startingRequestId + reqOff;
    const listId = startingListingId + listOff;
    const w = agentWallets[providerIdx];
    await sendTx(
      `Agent ${providerIdx} (${AGENT_DEFS[providerIdx].name}) accepts Request #${reqId} with Listing #${listId}`,
      () =>
        (marketplace.connect(w) as ethers.Contract).acceptRequest(reqId, listId),
    );
  }

  // Complete services with proof hashes
  console.log("\n  --- Completing services with proof hashes ---");
  skill("ServiceMarketplace.completeService");

  for (const [reqOff, , providerIdx] of matchTable) {
    const reqId = startingRequestId + reqOff;
    const w = agentWallets[providerIdx];
    const proofHash = ethers.keccak256(
      ethers.toUtf8Bytes(`proof-req-${reqId}-agent-${providerIdx}-${Date.now()}`),
    );
    await sendTx(
      `Agent ${providerIdx} completes Request #${reqId} (proof: ${proofHash.slice(0, 18)}...)`,
      () =>
        (marketplace.connect(w) as ethers.Contract).completeService(reqId, proofHash),
    );
  }
}

// ============================================================================
// PHASE 7 — Create escrows and release (x402 payment flow)
// ============================================================================

async function phase7_escrows(
  escrow: ethers.Contract,
  deployer: ethers.Wallet,
  agentWallets: ethers.Wallet[],
  startingRequestId: number,
): Promise<void> {
  console.log("\n==========================================================");
  console.log("  PHASE 7: Create & Release Escrows (x402 payment flow)");
  console.log("==========================================================");
  skill("EscrowSettlement.createEscrow");
  skill("EscrowSettlement.releaseEscrow");

  // Escrow definitions: [requestOffset, buyerAgentIdx, sellerAgentIdx, amount]
  const escrowDefs: [number, number, number, bigint][] = [
    [0, 1, 0, ethers.parseUnits("200", 12)],  // Trader pays DataProvider
    [1, 2, 0, ethers.parseUnits("150", 12)],  // Analyst pays DataProvider
    [2, 1, 2, ethers.parseUnits("200", 12)],  // Trader pays Analyst
    [3, 3, 4, ethers.parseUnits("400", 12)],  // LiqManager pays Auditor
    [4, 0, 1, ethers.parseUnits("300", 12)],  // DataProvider pays Trader
    [5, 5, 3, ethers.parseUnits("300", 12)],  // Arb pays LiqManager
  ];

  const createdEscrowIds: number[] = [];
  const escrowCreatedIface = new ethers.Interface([
    "event EscrowCreated(uint256 indexed escrowId, uint256 indexed requestId, address buyer, address seller, uint256 amount)",
  ]);

  for (const [reqOff, buyerIdx, sellerIdx, amount] of escrowDefs) {
    const reqId = startingRequestId + reqOff;
    const buyerWallet = agentWallets[buyerIdx];
    const sellerAddr = agentWallets[sellerIdx].address;

    const receipt = await sendTx(
      `Escrow: ${AGENT_DEFS[buyerIdx].name} -> ${AGENT_DEFS[sellerIdx].name} for Req #${reqId} (${fmtOKB(amount)})`,
      () =>
        (escrow.connect(buyerWallet) as ethers.Contract).createEscrow(
          reqId,
          sellerAddr,
          amount,
          3600, // 1 hour duration
          { value: amount },
        ),
    );

    if (receipt) {
      // Try to extract escrow ID from event logs
      let escrowId: number | null = null;
      for (const log of receipt.logs) {
        try {
          const parsed = escrowCreatedIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "EscrowCreated") {
            escrowId = Number(parsed.args[0]);
            break;
          }
        } catch { /* not our event */ }
      }
      if (escrowId !== null) {
        createdEscrowIds.push(escrowId);
        console.log(`  -> Escrow ID: ${escrowId}`);
      } else {
        // Fallback: assume sequential
        createdEscrowIds.push(createdEscrowIds.length);
        console.log(`  -> Escrow ID (estimated): ${createdEscrowIds.length - 1}`);
      }
    }
  }

  // Release all escrows (deployer/owner releases)
  console.log("\n  --- Releasing Escrows (demonstrating x402 settlement) ---");
  for (const eid of createdEscrowIds) {
    await sendTx(
      `Release Escrow #${eid}`,
      () => (escrow.connect(deployer) as ethers.Contract).releaseEscrow(eid),
    );
  }

  // Batch settle if we have enough
  if (createdEscrowIds.length >= 2) {
    console.log("\n  --- Batch Settle demonstration ---");
    skill("EscrowSettlement.batchSettle");
    // Use first two escrow IDs for batch demo (may revert if already settled, that is fine)
    await sendTx(
      `Batch settle escrows [${createdEscrowIds.slice(0, 2).join(", ")}]`,
      () =>
        (escrow.connect(deployer) as ethers.Contract).batchSettle(
          createdEscrowIds.slice(0, 2),
        ),
    );
  }
}

// ============================================================================
// PHASE 8 — Treasury deposits
// ============================================================================

async function phase8_treasury(
  treasury: ethers.Contract,
  agentWallets: ethers.Wallet[],
): Promise<void> {
  console.log("\n==========================================================");
  console.log("  PHASE 8: Treasury Deposits");
  console.log("==========================================================");
  skill("AgentTreasury.deposit");
  skill("AgentTreasury.getBalance");

  const depositAmounts = [
    ethers.parseUnits("100", 12), // DataProvider
    ethers.parseUnits("150", 12), // Trader
    ethers.parseUnits("120", 12), // Analyst
    ethers.parseUnits("130", 12), // LiquidityManager
    ethers.parseUnits("110", 12), // SecurityAuditor
    ethers.parseUnits("140", 12), // Arbitrageur
  ];

  for (let i = 0; i < AGENT_DEFS.length; i++) {
    const w = agentWallets[i];
    await sendTx(
      `Agent ${i} (${AGENT_DEFS[i].name}) deposits ${fmtOKB(depositAmounts[i])} into Treasury`,
      () =>
        (treasury.connect(w) as ethers.Contract).deposit({ value: depositAmounts[i] }),
    );
  }

  // Read back balances
  console.log("\n  --- Treasury balances after deposits ---");
  for (let i = 0; i < agentWallets.length; i++) {
    try {
      const bal = await treasury.getBalance(agentWallets[i].address);
      console.log(`  ${AGENT_DEFS[i].name.padEnd(18)}: ${fmtOKB(bal)}`);
    } catch {
      console.log(`  ${AGENT_DEFS[i].name.padEnd(18)}: (unable to read)`);
    }
  }
}

// ============================================================================
// PHASE 9 — Economy oracle snapshots
// ============================================================================

async function phase9_oracleSnapshots(
  oracle: ethers.Contract,
  deployer: ethers.Wallet,
): Promise<void> {
  console.log("\n==========================================================");
  console.log("  PHASE 9: Economy Oracle Snapshots");
  console.log("==========================================================");
  skill("EconomyOracle.takeSnapshot");
  skill("EconomyOracle.getLatestSnapshot");

  // Simulate progressive economy growth across 5 snapshots
  const snapshots: { label: string; agents: number; listings: number; requests: number; matches: number; escrowVol: bigint; settled: number; gdp: bigint }[] = [
    { label: "Bootstrap",      agents: 6, listings: 12, requests: 8, matches: 8,  escrowVol: ethers.parseUnits("1550", 12), settled: 6, gdp: ethers.parseUnits("750",  12) },
    { label: "Early growth",   agents: 6, listings: 12, requests: 8, matches: 8,  escrowVol: ethers.parseUnits("1550", 12), settled: 6, gdp: ethers.parseUnits("1200", 12) },
    { label: "Maturing",       agents: 6, listings: 12, requests: 8, matches: 8,  escrowVol: ethers.parseUnits("1550", 12), settled: 6, gdp: ethers.parseUnits("1730", 12) },
    { label: "Stable growth",  agents: 6, listings: 12, requests: 8, matches: 8,  escrowVol: ethers.parseUnits("1550", 12), settled: 6, gdp: ethers.parseUnits("2100", 12) },
    { label: "Peak activity",  agents: 6, listings: 12, requests: 8, matches: 8,  escrowVol: ethers.parseUnits("1550", 12), settled: 6, gdp: ethers.parseUnits("2500", 12) },
  ];

  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    await sendTx(
      `Snapshot ${i + 1}/5: ${s.label} (GDP=${fmtOKB(s.gdp)})`,
      () =>
        (oracle.connect(deployer) as ethers.Contract).takeSnapshot(
          s.agents, s.listings, s.requests, s.matches, s.escrowVol, s.settled, s.gdp,
        ),
    );
  }

  // Read latest snapshot
  try {
    const snap = await oracle.getLatestSnapshot();
    console.log("\n  Latest on-chain snapshot:");
    console.log(`    Timestamp:     ${snap.timestamp.toString()}`);
    console.log(`    Active Agents: ${snap.activeAgents.toString()}`);
    console.log(`    Listings:      ${snap.totalListings.toString()}`);
    console.log(`    Requests:      ${snap.totalRequests.toString()}`);
    console.log(`    Matches:       ${snap.totalMatches.toString()}`);
    console.log(`    Escrow Vol:    ${fmtOKB(snap.totalEscrowVolume)}`);
    console.log(`    Settled:       ${snap.totalSettled.toString()}`);
    console.log(`    GDP:           ${fmtOKB(snap.gdp)}`);
  } catch (err: any) {
    console.log(`  Could not read latest snapshot: ${err?.message ?? err}`);
  }
}

// ============================================================================
// PHASE 10 — Optional live DEX swap (LIVE_TRADE=true)
// ============================================================================

async function phase10_liveTrade(
  deployer: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
): Promise<void> {
  console.log("\n==========================================================");
  console.log("  PHASE 10: Live DEX Swap");
  console.log("==========================================================");

  if (process.env.LIVE_TRADE !== "true") {
    console.log("  Skipped — set LIVE_TRADE=true to execute a real swap.");
    return;
  }

  skill("DEX.swapExactETHForTokens");

  // OKX DEX / Uniswap-style router on X Layer (testnet may not have one)
  const DEX_ROUTER = process.env.DEX_ROUTER ?? "0x0000000000000000000000000000000000000000";
  const WOKB       = process.env.WOKB_ADDRESS ?? "0x0000000000000000000000000000000000000000";
  const USDT       = process.env.USDT_ADDRESS ?? "0x0000000000000000000000000000000000000000";

  if (DEX_ROUTER === "0x0000000000000000000000000000000000000000") {
    console.log("  No DEX_ROUTER configured — skipping live swap.");
    console.log("  Set DEX_ROUTER, WOKB_ADDRESS, USDT_ADDRESS env vars for mainnet.");
    return;
  }

  const router = new ethers.Contract(DEX_ROUTER, UNISWAP_ROUTER_ABI, deployer);
  const swapAmount = ethers.parseEther("0.001"); // small test swap
  const block = await provider.getBlock("latest");
  const swapDeadline = (block?.timestamp ?? Math.floor(Date.now() / 1000)) + 600;

  await sendTx(
    `Swap ${fmtOKB(swapAmount)} for USDT via DEX Router`,
    () =>
      router.swapExactETHForTokens(
        0, // amountOutMin = 0 for testnet
        [WOKB, USDT],
        deployer.address,
        swapDeadline,
        { value: swapAmount },
      ),
  );
}

// ============================================================================
// MAIN — orchestrates all phases
// ============================================================================

async function main(): Promise<void> {
  const startTime = Date.now();

  // -- Validate deployer key ------------------------------------------------
  const deployerPk = process.env.PRIVATE_KEY;
  if (!deployerPk) {
    throw new Error("PRIVATE_KEY env var is required (deployer / contract-owner wallet)");
  }

  // -- Provider & wallets ---------------------------------------------------
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const deployer = new ethers.Wallet(deployerPk, provider);

  // Detect chain
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log("############################################################");
  console.log("#                                                          #");
  console.log("#        SYMBIOSIS Protocol — Bootstrap Script             #");
  console.log("#        One-click economy setup & demonstration           #");
  console.log("#                                                          #");
  console.log("############################################################");
  console.log(`  RPC URL:    ${RPC_URL}`);
  console.log(`  Chain ID:   ${chainId}`);
  console.log(`  Network:    ${chainId === 196 ? "X Layer Mainnet" : chainId === 195 ? "X Layer Testnet" : `Custom (${chainId})`}`);
  console.log(`  Deployer:   ${deployer.address}`);
  console.log(`  LIVE_TRADE: ${process.env.LIVE_TRADE === "true" ? "ENABLED" : "disabled"}`);

  // Build agent wallets (prefer env vars, fall back to hardcoded testnet keys)
  const agentWallets: ethers.Wallet[] = AGENT_DEFS.map((def) => {
    const pk = process.env[def.pkEnv] ?? def.fallbackPk;
    return new ethers.Wallet(pk, provider);
  });

  console.log("\n  Agent wallets:");
  AGENT_DEFS.forEach((def, i) => {
    console.log(`    ${i} ${def.name.padEnd(18)} ${agentWallets[i].address}`);
  });

  // -- Contract instances ---------------------------------------------------
  const registry    = new ethers.Contract(ADDRESSES.AgentRegistry,      AGENT_REGISTRY_ABI,      deployer);
  const marketplace = new ethers.Contract(ADDRESSES.ServiceMarketplace, SERVICE_MARKETPLACE_ABI, deployer);
  const escrowC     = new ethers.Contract(ADDRESSES.EscrowSettlement,   ESCROW_SETTLEMENT_ABI,   deployer);
  const treasury    = new ethers.Contract(ADDRESSES.AgentTreasury,      AGENT_TREASURY_ABI,      deployer);
  const oracle      = new ethers.Contract(ADDRESSES.EconomyOracle,      ECONOMY_ORACLE_ABI,      deployer);
  const reputation  = new ethers.Contract(ADDRESSES.ReputationEngine,   REPUTATION_ENGINE_ABI,   deployer);

  console.log("\n  Contract addresses:");
  for (const [name, addr] of Object.entries(ADDRESSES)) {
    console.log(`    ${name.padEnd(20)} ${addr}`);
  }

  // Block-based deadline for service requests (100k blocks from now)
  const blockNumber = await provider.getBlockNumber();
  const deadline = blockNumber + 100_000;
  console.log(`\n  Current block: ${blockNumber}`);
  console.log(`  Request deadline: ${deadline}`);

  // ========================================================================
  // Execute all phases sequentially
  // ========================================================================

  // Phase 1: Check balances
  await phase1_checkBalances(provider, deployer, agentWallets);

  // Phase 2: Fund agents from deployer
  await phase2_fundAgents(deployer, agentWallets, provider);

  // Phase 3: Register agents
  await phase3_registerAgents(registry, agentWallets);

  // Phase 4: List services
  await phase4_listServices(marketplace, agentWallets);

  // Phase 5: Create service requests
  const startingRequestId = await phase5_createRequests(marketplace, agentWallets, deadline);

  // Phase 6: Accept & complete
  await phase6_acceptAndMatch(marketplace, agentWallets, startingRequestId);

  // Phase 7: Escrows (x402 flow)
  await phase7_escrows(escrowC, deployer, agentWallets, startingRequestId);

  // Phase 8: Treasury deposits
  await phase8_treasury(treasury, agentWallets);

  // Phase 9: Oracle snapshots
  await phase9_oracleSnapshots(oracle, deployer);

  // Phase 10: Optional live DEX swap
  await phase10_liveTrade(deployer, provider);

  // ========================================================================
  // PHASE 11 — Final summary
  // ========================================================================
  console.log("\n############################################################");
  console.log("#                     BOOTSTRAP SUMMARY                    #");
  console.log("############################################################");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Duration:            ${elapsed}s`);
  console.log(`  Transactions sent:   ${txCount}`);
  console.log(`  Successful tx hashes: ${txHashes.length}`);

  // On-chain stats
  console.log("\n  --- On-Chain Stats ---");
  try {
    const agentCount = await registry.getAgentCount();
    console.log(`  Registered agents:   ${agentCount}`);
  } catch { console.log("  Registered agents:   (unable to read)"); }

  try {
    const listingCount = await marketplace.getListingCount();
    console.log(`  Total listings:      ${listingCount}`);
  } catch { console.log("  Total listings:      (unable to read)"); }

  try {
    const requestCount = await marketplace.getRequestCount();
    console.log(`  Total requests:      ${requestCount}`);
  } catch { console.log("  Total requests:      (unable to read)"); }

  // Reputation check
  console.log("\n  --- Agent Reputations ---");
  skill("ReputationEngine.getReputation");
  for (let i = 0; i < agentWallets.length; i++) {
    try {
      const rep = await reputation.getReputation(agentWallets[i].address);
      console.log(`  ${AGENT_DEFS[i].name.padEnd(18)}: ${rep.toString()}`);
    } catch {
      console.log(`  ${AGENT_DEFS[i].name.padEnd(18)}: (no score yet)`);
    }
  }

  // Top agents
  skill("ReputationEngine.getTopAgents");
  try {
    const [topAddrs, topScores] = await reputation.getTopAgents(3);
    console.log("\n  --- Top 3 Agents ---");
    for (let i = 0; i < topAddrs.length; i++) {
      const name = AGENT_DEFS.find((_, j) => agentWallets[j].address === topAddrs[i])?.name ?? "Unknown";
      console.log(`  #${i + 1} ${name.padEnd(18)} score=${topScores[i].toString()}  addr=${topAddrs[i]}`);
    }
  } catch {
    console.log("\n  Top agents: (unable to read)");
  }

  // Final wallet balances
  console.log("\n  --- Final Wallet Balances ---");
  const deployerBal = await provider.getBalance(deployer.address);
  console.log(`  Deployer:            ${fmtOKB(deployerBal)}`);
  for (let i = 0; i < agentWallets.length; i++) {
    const bal = await provider.getBalance(agentWallets[i].address);
    console.log(`  ${AGENT_DEFS[i].name.padEnd(18)}: ${fmtOKB(bal)}`);
  }

  // Treasury PnL
  console.log("\n  --- Treasury PnL ---");
  skill("AgentTreasury.getPnL");
  for (let i = 0; i < agentWallets.length; i++) {
    try {
      const pnl = await treasury.getPnL(agentWallets[i].address);
      console.log(`  ${AGENT_DEFS[i].name.padEnd(18)}: ${pnl.toString()}`);
    } catch {
      console.log(`  ${AGENT_DEFS[i].name.padEnd(18)}: (no PnL data)`);
    }
  }

  // Skills used
  console.log("\n  --- Onchain OS API Skills Used ---");
  const sortedSkills = Array.from(skillsUsed).sort();
  sortedSkills.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s}`));
  console.log(`\n  Total unique skills: ${skillsUsed.size}`);

  // Transaction hashes
  console.log("\n  --- All Transaction Hashes ---");
  txHashes.forEach((h, i) => console.log(`  ${String(i + 1).padStart(3)}. ${h}`));

  console.log("\n############################################################");
  console.log("#                   BOOTSTRAP COMPLETE                     #");
  console.log("############################################################\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
