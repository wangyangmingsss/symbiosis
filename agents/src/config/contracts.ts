/**
 * Contract addresses and minimal ABIs for the SYMBIOSIS protocol.
 *
 * Addresses are placeholders -- replace after deployment.
 * ABIs contain only the function signatures each agent actually calls,
 * keeping the bundle lean.
 */

// ---------------------------------------------------------------------------
// Deployed addresses (fill in after `forge script Deploy`)
// ---------------------------------------------------------------------------

export const ADDRESSES = {
  AgentRegistry: "0x0000000000000000000000000000000000000001",
  ServiceMarketplace: "0x0000000000000000000000000000000000000002",
  ReputationEngine: "0x0000000000000000000000000000000000000003",
  EscrowSettlement: "0x0000000000000000000000000000000000000004",
  AgentTreasury: "0x0000000000000000000000000000000000000005",
  EconomyOracle: "0x0000000000000000000000000000000000000006",
} as const;

// ---------------------------------------------------------------------------
// Service type hashes (must match ServiceMarketplace.sol constants)
// ethers.keccak256(ethers.toUtf8Bytes("..."))
// ---------------------------------------------------------------------------

export const SERVICE_TYPES = {
  MARKET_DATA: "MARKET_DATA",
  ALPHA_SIGNAL: "ALPHA_SIGNAL",
  TRADE_EXECUTION: "TRADE_EXECUTION",
  SECURITY_AUDIT: "SECURITY_AUDIT",
  LP_MANAGEMENT: "LP_MANAGEMENT",
  ARBITRAGE_SIGNAL: "ARBITRAGE_SIGNAL",
} as const;

// ---------------------------------------------------------------------------
// Agent type enum (mirrors IAgentRegistry.AgentType)
// ---------------------------------------------------------------------------

export enum AgentType {
  DataProvider = 0,
  Trader = 1,
  Analyst = 2,
  LiquidityManager = 3,
  SecurityAuditor = 4,
  Arbitrageur = 5,
}

// ---------------------------------------------------------------------------
// Minimal ABIs -- only functions each agent needs
// ---------------------------------------------------------------------------

export const AGENT_REGISTRY_ABI = [
  "function registerAgent(uint8 agentType, string metadataURI) external payable",
  "function deregisterAgent() external",
  "function updateCapabilities(string newMetadataURI) external",
  "function discoverAgents(uint8 agentType) external view returns (address[])",
  "function getAgentProfile(address agent) external view returns (tuple(address agentAddress, bytes32 agentId, uint8 agentType, string metadataURI, uint256 registeredAt, uint256 stakeAmount, bool isActive))",
  "function isRegistered(address agent) external view returns (bool)",
  "function getAgentCount() external view returns (uint256)",
] as const;

export const SERVICE_MARKETPLACE_ABI = [
  "function listService(bytes32 serviceType, uint256 startPrice, uint256 floorPrice, uint256 decayRate, uint256 maxFulfillments) external returns (uint256)",
  "function getCurrentPrice(uint256 listingId) external view returns (uint256)",
  "function requestService(bytes32 serviceType, uint256 maxBudget, uint256 deadline) external returns (uint256)",
  "function acceptRequest(uint256 requestId, uint256 listingId) external",
  "function completeService(uint256 requestId, bytes32 proofHash) external",
  "function disputeService(uint256 requestId) external",
  "function findBestListing(bytes32 serviceType) external view returns (uint256 bestListingId, uint256 bestPrice)",
  "function getListing(uint256 listingId) external view returns (tuple(uint256 listingId, address provider, bytes32 serviceType, uint256 startPrice, uint256 floorPrice, uint256 decayRate, uint256 listedAtBlock, uint256 maxFulfillments, uint256 fulfillmentCount, bool isActive))",
  "function getRequest(uint256 requestId) external view returns (tuple(uint256 requestId, address requester, bytes32 serviceType, uint256 maxBudget, uint256 deadline, address assignedProvider, uint8 status))",
  "function getListingCount() external view returns (uint256)",
  "function getRequestCount() external view returns (uint256)",
] as const;

export const REPUTATION_ENGINE_ABI = [
  "function getReputation(address agent) external view returns (uint256)",
  "function getCategoryReputation(address agent, bytes32 serviceType) external view returns (uint256)",
  "function getTopAgents(uint256 count) external view returns (address[], uint256[])",
  "function getFullScore(address agent) external view returns (tuple(uint256 totalScore, uint256 completedServices, uint256 failedServices, uint256 totalVolumeUSDT, uint256 avgResponseBlocks, uint256 lastUpdated))",
] as const;

export const ESCROW_SETTLEMENT_ABI = [
  "function createEscrow(uint256 requestId, address seller, uint256 amount, uint256 duration) external payable returns (uint256)",
  "function releaseEscrow(uint256 escrowId) external",
  "function refundEscrow(uint256 escrowId) external",
  "function batchSettle(uint256[] escrowIds) external",
  "function getEscrow(uint256 escrowId) external view returns (tuple(uint256 escrowId, uint256 requestId, address buyer, address seller, uint256 amount, uint256 createdAt, uint256 expiresAt, uint8 status, bytes32 x402PaymentHash))",
] as const;

export const AGENT_TREASURY_ABI = [
  "function deposit() external payable",
  "function withdraw(uint256 amount) external",
  "function getBalance(address agent) external view returns (uint256)",
  "function getPnL(address agent) external view returns (int256)",
  "function getTreasury(address agent) external view returns (tuple(uint256 deposited, uint256 withdrawn, uint256 earned, uint256 spent, uint256 lastActivity))",
] as const;

export const ECONOMY_ORACLE_ABI = [
  "function takeSnapshot(uint256 activeAgents, uint256 totalListings, uint256 totalRequests, uint256 totalMatches, uint256 totalEscrowVolume, uint256 totalSettled, uint256 gdp) external",
  "function getLatestSnapshot() external view returns (tuple(uint256 timestamp, uint256 activeAgents, uint256 totalListings, uint256 totalRequests, uint256 totalMatches, uint256 totalEscrowVolume, uint256 totalSettled, uint256 gdp))",
  "function getGrowthRate() external view returns (int256)",
] as const;
