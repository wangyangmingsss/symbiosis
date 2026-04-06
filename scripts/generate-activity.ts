/**
 * generate-activity.ts
 *
 * Generates real on-chain transactions on X Layer testnet to demonstrate
 * SYMBIOSIS ecosystem participation. Run with:
 *
 *   npx tsx scripts/generate-activity.ts
 */

import "dotenv/config";
import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL = "https://testrpc.xlayer.tech";
const CHAIN_ID = 1952;

const ADDRESSES = {
  AgentRegistry: "0x33dB9d89F2f4E13470469bB4ccf7f708d8333987",
  ServiceMarketplace: "0x58Eb47a4b6F2b777730828Cb8AD77032993a9dbf",
  ReputationEngine: "0x6cAa9D8b182f1919d3F6b10AadcaCc542363463F",
  EscrowSettlement: "0x160dDA2B8dc2f0136AFA6BFbC54D3127163E428A",
  AgentTreasury: "0x1CE0CAe16F38B32a0dc1aB1fe4E34eFC4942A5F7",
  EconomyOracle: "0x72d0B059941B0603bff3593Fa2c8Ca26825AE834",
  GovernanceRegistry: "0x016C98657AEE961f5764359030aa15a2fb174351",
} as const;

// Minimal ABIs -- placeholder, filled below
// PLACEHOLDER: ABI_SECTION

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
  "function addToTab(address seller, uint256 amount) external",
  "function settleTab(address seller) external payable",
];

const AGENT_TREASURY_ABI = [
  "function deposit() external payable",
  "function getBalance(address agent) external view returns (uint256)",
];

const ECONOMY_ORACLE_ABI = [
  "function takeSnapshot(uint256 activeAgents, uint256 totalListings, uint256 totalRequests, uint256 totalMatches, uint256 totalEscrowVolume, uint256 totalSettled, uint256 gdp) external",
];

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

interface AgentDef {
  name: string;
  type: number; // AgentType enum
  pk: string;
  metadata: string;
}

const AGENTS: AgentDef[] = [
  { name: "DataProvider",     type: 0, pk: "0x9745c732f841010c6801088dcc2f7e69c953f2c064560974ba98024d0d678a75", metadata: "ipfs://agent-data-provider" },
  { name: "Trader",           type: 1, pk: "0xd2168d58a16da270a1660b09e925d9233d48d7dd1cd86440d216bce2624f4447", metadata: "ipfs://agent-trader" },
  { name: "Analyst",          type: 2, pk: "0x0ac4fa6ae65c6f157351126c2763ff898aa376d22e6999f88d3424239ab7b9b5", metadata: "ipfs://agent-analyst" },
  { name: "LiquidityManager", type: 3, pk: "0xf9033bdbbf1a611f887a710c3e424d2d613539b51e40f765109db908beb79bd7", metadata: "ipfs://agent-lp-manager" },
  { name: "SecurityAuditor",  type: 4, pk: "0xe8429961c5831f4be3c2eb73dbbfc085982a46825b74e6d88f612a39ab6263f5", metadata: "ipfs://agent-security-auditor" },
  { name: "Arbitrageur",      type: 5, pk: "0x9678d6165ed4e06608e2b6119e89dc6b9f7a017fd28b2ee6a494d9e32ce3af2e", metadata: "ipfs://agent-arbitrageur" },
];

// Service type name -> keccak256 hash
const SERVICE_TYPES = {
  MARKET_DATA:      ethers.keccak256(ethers.toUtf8Bytes("MARKET_DATA")),
  ALPHA_SIGNAL:     ethers.keccak256(ethers.toUtf8Bytes("ALPHA_SIGNAL")),
  SECURITY_AUDIT:   ethers.keccak256(ethers.toUtf8Bytes("SECURITY_AUDIT")),
  LP_MANAGEMENT:    ethers.keccak256(ethers.toUtf8Bytes("LP_MANAGEMENT")),
  TRADE_EXECUTION:  ethers.keccak256(ethers.toUtf8Bytes("TRADE_EXECUTION")),
  ARBITRAGE_SIGNAL: ethers.keccak256(ethers.toUtf8Bytes("ARBITRAGE_SIGNAL")),
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let txCount = 0;

async function sendTx(
  description: string,
  fn: () => Promise<ethers.ContractTransactionResponse>,
): Promise<ethers.ContractTransactionReceipt | null> {
  txCount++;
  const label = `TX #${txCount}`;
  try {
    console.log(`\n--- ${label}: ${description} ---`);
    const tx = await fn();
    console.log(`  Hash:    ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Status:  ${receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);
    console.log(`  Gas:     ${receipt?.gasUsed?.toString()}`);
    return receipt;
  } catch (err: any) {
    const reason = err?.reason ?? err?.shortMessage ?? err?.message ?? String(err);
    console.error(`  FAILED:  ${reason}`);
    return null;
  }
}

function wallet(pk: string, provider: ethers.JsonRpcProvider): ethers.Wallet {
  return new ethers.Wallet(pk, provider);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // -- Setup ----------------------------------------------------------------
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY env var is required (deployer / owner key)");
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const deployer = new ethers.Wallet(privateKey, provider);
  console.log("============================================");
  console.log("  SYMBIOSIS Activity Generator");
  console.log("============================================");
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`RPC:       ${RPC_URL}`);
  console.log(`Chain ID:  ${CHAIN_ID}`);

  const blockNumber = await provider.getBlockNumber();
  const deadline = blockNumber + 100_000;
  console.log(`Block:     ${blockNumber}`);
  console.log(`Deadline:  ${deadline}`);

  // Build wallets for each agent
  const wallets = AGENTS.map((a) => wallet(a.pk, provider));
  const addresses = wallets.map((w) => w.address);
  console.log("\nAgent wallets:");
  AGENTS.forEach((a, i) => console.log(`  ${i} ${a.name.padEnd(18)} ${addresses[i]}`));

  // Contract instances (deployer-connected by default)
  const registry = new ethers.Contract(ADDRESSES.AgentRegistry, AGENT_REGISTRY_ABI, deployer);
  const marketplace = new ethers.Contract(ADDRESSES.ServiceMarketplace, SERVICE_MARKETPLACE_ABI, deployer);
  const escrow = new ethers.Contract(ADDRESSES.EscrowSettlement, ESCROW_SETTLEMENT_ABI, deployer);
  const treasury = new ethers.Contract(ADDRESSES.AgentTreasury, AGENT_TREASURY_ABI, deployer);
  const oracle = new ethers.Contract(ADDRESSES.EconomyOracle, ECONOMY_ORACLE_ABI, deployer);

  // =========================================================================
  // PHASE 1: Register Agents
  // =========================================================================
  console.log("\n========== PHASE 1: Register Agents ==========");

  for (let i = 0; i < AGENTS.length; i++) {
    const agent = AGENTS[i];
    const w = wallets[i];
    try {
      const already = await registry.connect(w).isRegistered(w.address);
      if (already) {
        console.log(`  Agent${i} (${agent.name}) already registered, skipping.`);
        continue;
      }
    } catch {
      // isRegistered may revert if agent never interacted; continue to register
    }
    await sendTx(
      `Register Agent${i} (${agent.name})`,
      () =>
        (registry.connect(w) as ethers.Contract).registerAgent(
          agent.type,
          agent.metadata,
          { value: ethers.parseEther("0.0001") },
        ),
    );
  }

  // =========================================================================
  // PHASE 2: List Services
  // =========================================================================
  console.log("\n========== PHASE 2: List Services ==========");

  const listings: { agent: number; serviceType: string; typeName: string }[] = [
    // Agent 0 (DataProvider) - MARKET_DATA x2
    { agent: 0, serviceType: SERVICE_TYPES.MARKET_DATA, typeName: "MARKET_DATA" },
    { agent: 0, serviceType: SERVICE_TYPES.MARKET_DATA, typeName: "MARKET_DATA" },
    // Agent 1 (Trader) - TRADE_EXECUTION, ALPHA_SIGNAL
    { agent: 1, serviceType: SERVICE_TYPES.TRADE_EXECUTION, typeName: "TRADE_EXECUTION" },
    { agent: 1, serviceType: SERVICE_TYPES.ALPHA_SIGNAL, typeName: "ALPHA_SIGNAL" },
    // Agent 2 (Analyst) - ALPHA_SIGNAL, MARKET_DATA
    { agent: 2, serviceType: SERVICE_TYPES.ALPHA_SIGNAL, typeName: "ALPHA_SIGNAL" },
    { agent: 2, serviceType: SERVICE_TYPES.MARKET_DATA, typeName: "MARKET_DATA" },
    // Agent 3 (LiquidityManager) - LP_MANAGEMENT x2
    { agent: 3, serviceType: SERVICE_TYPES.LP_MANAGEMENT, typeName: "LP_MANAGEMENT" },
    { agent: 3, serviceType: SERVICE_TYPES.LP_MANAGEMENT, typeName: "LP_MANAGEMENT" },
    // Agent 4 (SecurityAuditor) - SECURITY_AUDIT x2
    { agent: 4, serviceType: SERVICE_TYPES.SECURITY_AUDIT, typeName: "SECURITY_AUDIT" },
    { agent: 4, serviceType: SERVICE_TYPES.SECURITY_AUDIT, typeName: "SECURITY_AUDIT" },
    // Agent 5 (Arbitrageur) - ARBITRAGE_SIGNAL x2
    { agent: 5, serviceType: SERVICE_TYPES.ARBITRAGE_SIGNAL, typeName: "ARBITRAGE_SIGNAL" },
    { agent: 5, serviceType: SERVICE_TYPES.ARBITRAGE_SIGNAL, typeName: "ARBITRAGE_SIGNAL" },
  ];

  const startPrices  = [500, 300, 800, 600, 400, 350, 700, 500, 900, 600, 500, 350].map((v) => ethers.parseUnits(String(v), 12));
  const floorPrices  = [200, 100, 300, 200, 150, 120, 250, 200, 400, 250, 180, 120].map((v) => ethers.parseUnits(String(v), 12));
  const decayRates   = [1_000_000_000n, 500_000_000n, 2_000_000_000n, 1_500_000_000n, 1_000_000_000n, 800_000_000n, 1_800_000_000n, 1_200_000_000n, 2_500_000_000n, 1_500_000_000n, 1_300_000_000n, 900_000_000n];
  const maxFulfill   = [5, 10, 3, 5, 5, 5, 3, 5, 3, 5, 5, 10];

  for (let i = 0; i < listings.length; i++) {
    const l = listings[i];
    const w = wallets[l.agent];
    await sendTx(
      `Agent${l.agent} (${AGENTS[l.agent].name}) lists ${l.typeName}`,
      () =>
        (marketplace.connect(w) as ethers.Contract).listService(
          l.serviceType,
          startPrices[i],
          floorPrices[i],
          decayRates[i],
          maxFulfill[i],
        ),
    );
  }

  // =========================================================================
  // PHASE 3: Create Service Requests
  // =========================================================================
  console.log("\n========== PHASE 3: Service Requests ==========");

  const requests: { agent: number; serviceType: string; typeName: string; budget: bigint }[] = [
    { agent: 1, serviceType: SERVICE_TYPES.MARKET_DATA,      typeName: "MARKET_DATA",      budget: ethers.parseUnits("500", 12) },
    { agent: 2, serviceType: SERVICE_TYPES.MARKET_DATA,      typeName: "MARKET_DATA",      budget: ethers.parseUnits("400", 12) },
    { agent: 1, serviceType: SERVICE_TYPES.ALPHA_SIGNAL,     typeName: "ALPHA_SIGNAL",     budget: ethers.parseUnits("500", 12) },
    { agent: 3, serviceType: SERVICE_TYPES.SECURITY_AUDIT,   typeName: "SECURITY_AUDIT",   budget: ethers.parseUnits("900", 12) },
    { agent: 0, serviceType: SERVICE_TYPES.TRADE_EXECUTION,  typeName: "TRADE_EXECUTION",  budget: ethers.parseUnits("800", 12) },
    { agent: 5, serviceType: SERVICE_TYPES.LP_MANAGEMENT,    typeName: "LP_MANAGEMENT",    budget: ethers.parseUnits("700", 12) },
    { agent: 4, serviceType: SERVICE_TYPES.ARBITRAGE_SIGNAL, typeName: "ARBITRAGE_SIGNAL", budget: ethers.parseUnits("500", 12) },
    { agent: 0, serviceType: SERVICE_TYPES.ALPHA_SIGNAL,     typeName: "ALPHA_SIGNAL",     budget: ethers.parseUnits("600", 12) },
  ];

  // We need to know the starting request ID offset
  let startingRequestId: number;
  try {
    startingRequestId = Number(await marketplace.getRequestCount());
  } catch {
    startingRequestId = 0;
  }
  console.log(`  Existing requests on-chain: ${startingRequestId}`);

  for (const r of requests) {
    const w = wallets[r.agent];
    await sendTx(
      `Agent${r.agent} (${AGENTS[r.agent].name}) requests ${r.typeName}`,
      () =>
        (marketplace.connect(w) as ethers.Contract).requestService(
          r.serviceType,
          r.budget,
          deadline,
        ),
    );
  }

  // =========================================================================
  // PHASE 4: Accept / Match Requests
  // =========================================================================
  console.log("\n========== PHASE 4: Accept Requests ==========");

  // Starting listing offset
  let startingListingId: number;
  try {
    startingListingId = Number(await marketplace.getListingCount()) - listings.length;
    if (startingListingId < 0) startingListingId = 0;
  } catch {
    startingListingId = 0;
  }

  // Match table: [requestIndex, listingIndex, providerAgentIndex]
  // Listing index relative to our batch; request index relative to our batch
  const matches: [number, number, number][] = [
    [0, 0, 0],   // Req0 (MARKET_DATA) <- Listing0 (Agent0 MARKET_DATA)
    [1, 1, 0],   // Req1 (MARKET_DATA) <- Listing1 (Agent0 MARKET_DATA)
    [2, 4, 2],   // Req2 (ALPHA_SIGNAL) <- Listing4 (Agent2 ALPHA_SIGNAL)
    [3, 8, 4],   // Req3 (SECURITY_AUDIT) <- Listing8 (Agent4 SECURITY_AUDIT)
    [4, 2, 1],   // Req4 (TRADE_EXECUTION) <- Listing2 (Agent1 TRADE_EXECUTION)
    [5, 6, 3],   // Req5 (LP_MANAGEMENT) <- Listing6 (Agent3 LP_MANAGEMENT)
    [6, 10, 5],  // Req6 (ARBITRAGE_SIGNAL) <- Listing10 (Agent5 ARBITRAGE_SIGNAL)
    [7, 3, 1],   // Req7 (ALPHA_SIGNAL) <- Listing3 (Agent1 ALPHA_SIGNAL)
  ];

  for (const [reqIdx, listIdx, providerIdx] of matches) {
    const reqId = startingRequestId + reqIdx;
    const listId = startingListingId + listIdx;
    const w = wallets[providerIdx];
    await sendTx(
      `Agent${providerIdx} (${AGENTS[providerIdx].name}) accepts Request${reqId} with Listing${listId}`,
      () =>
        (marketplace.connect(w) as ethers.Contract).acceptRequest(reqId, listId),
    );
  }

  // =========================================================================
  // PHASE 5: Complete Services with Proof Hashes
  // =========================================================================
  console.log("\n========== PHASE 5: Complete Services ==========");

  for (const [reqIdx, , providerIdx] of matches) {
    const reqId = startingRequestId + reqIdx;
    const w = wallets[providerIdx];
    const proofHash = ethers.keccak256(
      ethers.toUtf8Bytes(`proof-req-${reqId}-agent-${providerIdx}-${Date.now()}`),
    );
    await sendTx(
      `Agent${providerIdx} completes Request${reqId} (proof: ${proofHash.slice(0, 18)}...)`,
      () =>
        (marketplace.connect(w) as ethers.Contract).completeService(reqId, proofHash),
    );
  }

  // =========================================================================
  // PHASE 6: Create Escrows and Release
  // =========================================================================
  console.log("\n========== PHASE 6: Create & Release Escrows ==========");

  // Escrow entries: [requestIndex, buyerAgentIndex, sellerAgentIndex, amountWei]
  const escrowDefs: [number, number, number, bigint][] = [
    [0, 1, 0, ethers.parseUnits("200", 12)],   // Req0: Trader -> DataProvider
    [1, 2, 0, ethers.parseUnits("150", 12)],   // Req1: Analyst -> DataProvider
    [2, 1, 2, ethers.parseUnits("200", 12)],   // Req2: Trader -> Analyst
    [3, 3, 4, ethers.parseUnits("400", 12)],   // Req3: LiqManager -> Auditor
    [4, 0, 1, ethers.parseUnits("300", 12)],   // Req4: DataProvider -> Trader
    [5, 5, 3, ethers.parseUnits("300", 12)],   // Req5: Arb -> LiqManager
  ];

  const createdEscrowIds: number[] = [];

  for (const [reqIdx, buyerIdx, sellerIdx, amount] of escrowDefs) {
    const reqId = startingRequestId + reqIdx;
    const buyerWallet = wallets[buyerIdx];
    const sellerAddr = addresses[sellerIdx];

    const receipt = await sendTx(
      `Escrow Req${reqId}: ${AGENTS[buyerIdx].name} -> ${AGENTS[sellerIdx].name} (${ethers.formatEther(amount)} OKB)`,
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
      // Try to extract escrow ID from logs; fall back to sequential index
      const iface = new ethers.Interface(["event EscrowCreated(uint256 indexed escrowId, uint256 indexed requestId, address buyer, address seller, uint256 amount)"]);
      let escrowId: number | null = null;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "EscrowCreated") {
            escrowId = Number(parsed.args[0]);
            break;
          }
        } catch { /* not our event */ }
      }
      if (escrowId !== null) {
        createdEscrowIds.push(escrowId);
        console.log(`  Escrow ID: ${escrowId}`);
      } else {
        createdEscrowIds.push(createdEscrowIds.length);
        console.log(`  Escrow ID (estimated): ${createdEscrowIds.length - 1}`);
      }
    }
  }

  // Release escrows (owner releases)
  console.log("\n  --- Releasing Escrows ---");
  for (const eid of createdEscrowIds) {
    await sendTx(
      `Release Escrow ${eid}`,
      () => (escrow.connect(deployer) as ethers.Contract).releaseEscrow(eid),
    );
  }

  // =========================================================================
  // PHASE 7: Payment Tabs (addToTab + settleTab)
  // =========================================================================
  console.log("\n========== PHASE 7: Payment Tabs ==========");

  // Buyer adds to tab with seller, then settles
  const tabDefs: [number, number, bigint][] = [
    [1, 0, ethers.parseUnits("100", 12)],  // Trader tabs DataProvider
    [0, 2, ethers.parseUnits("80", 12)],   // DataProvider tabs Analyst
    [5, 4, ethers.parseUnits("120", 12)],  // Arb tabs Auditor
  ];

  for (const [buyerIdx, sellerIdx, amount] of tabDefs) {
    const buyerWallet = wallets[buyerIdx];
    const sellerAddr = addresses[sellerIdx];

    await sendTx(
      `Agent${buyerIdx} adds tab for Agent${sellerIdx}: ${ethers.formatEther(amount)} OKB`,
      () =>
        (escrow.connect(buyerWallet) as ethers.Contract).addToTab(sellerAddr, amount),
    );

    await sendTx(
      `Agent${buyerIdx} settles tab with Agent${sellerIdx}`,
      () =>
        (escrow.connect(buyerWallet) as ethers.Contract).settleTab(sellerAddr, { value: amount }),
    );
  }

  // =========================================================================
  // PHASE 8: Economy Snapshots
  // =========================================================================
  console.log("\n========== PHASE 8: Economy Snapshots ==========");

  const snapshots: [number, number, number, number, bigint, number, bigint][] = [
    [6, 12, 8, 8, ethers.parseUnits("1550", 12), 6, ethers.parseUnits("750",  12)],
    [6, 12, 8, 8, ethers.parseUnits("1550", 12), 6, ethers.parseUnits("1200", 12)],
    [6, 12, 8, 8, ethers.parseUnits("1550", 12), 6, ethers.parseUnits("1730", 12)],
    [6, 12, 8, 8, ethers.parseUnits("1550", 12), 6, ethers.parseUnits("2100", 12)],
    [6, 12, 8, 8, ethers.parseUnits("1550", 12), 6, ethers.parseUnits("2500", 12)],
  ];

  const snapshotLabels = ["Early economy", "Growing economy", "Maturing economy", "Stable growth", "Peak activity"];

  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    await sendTx(
      `Snapshot ${i + 1}: ${snapshotLabels[i]}`,
      () =>
        (oracle.connect(deployer) as ethers.Contract).takeSnapshot(
          s[0], s[1], s[2], s[3], s[4], s[5], s[6],
        ),
    );
  }

  // =========================================================================
  // PHASE 9: Treasury Deposits
  // =========================================================================
  console.log("\n========== PHASE 9: Treasury Deposits ==========");

  const depositAmounts = [
    ethers.parseUnits("100", 12),
    ethers.parseUnits("150", 12),
    ethers.parseUnits("120", 12),
    ethers.parseUnits("130", 12),
    ethers.parseUnits("110", 12),
    ethers.parseUnits("140", 12),
  ];

  for (let i = 0; i < AGENTS.length; i++) {
    const w = wallets[i];
    await sendTx(
      `Agent${i} (${AGENTS[i].name}) deposits ${ethers.formatEther(depositAmounts[i])} OKB into Treasury`,
      () =>
        (treasury.connect(w) as ethers.Contract).deposit({ value: depositAmounts[i] }),
    );
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log("\n============================================");
  console.log("  ACTIVITY GENERATION COMPLETE");
  console.log("============================================");
  console.log(`Total transactions attempted: ${txCount}`);

  try {
    const agentCount = await registry.getAgentCount();
    console.log(`  Registered agents:  ${agentCount}`);
  } catch { /* ignore */ }

  try {
    const listingCount = await marketplace.getListingCount();
    const requestCount = await marketplace.getRequestCount();
    console.log(`  Total listings:     ${listingCount}`);
    console.log(`  Total requests:     ${requestCount}`);
  } catch { /* ignore */ }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
