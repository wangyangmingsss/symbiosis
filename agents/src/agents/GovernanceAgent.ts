/**
 * GovernanceAgent -- the 7th agent in the SYMBIOSIS autonomous economy.
 *
 * Cycle (every 90 seconds):
 *  1. Collect economy health metrics from other agents via EventBus
 *  2. Fetch market data from OKX Onchain OS (price, 24h ticker, gas)
 *  3. Evaluate economy conditions and generate governance proposals
 *  4. Collect votes from other agents (simulated via EventBus)
 *  5. Execute proposals that pass quorum (4/6 agents)
 *  6. Record governance actions on-chain via the EconomyOracle contract
 *  7. Emit events for the frontend to display
 *
 * Uses 3+ OKX API skills: getMarketPrice, getMarketTicker24h, getGasPrice
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient } from "../core/OnchainOSClient.js";
import { globalBus } from "../core/EventBus.js";
import { AgentType } from "../config/contracts.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Number of agents required to pass a proposal (4 out of 6). */
const QUORUM_THRESHOLD = 4;

/** Total voting agents in the economy (excluding governance itself). */
const TOTAL_VOTING_AGENTS = 6;

/** Maximum number of active proposals at any time. */
const MAX_ACTIVE_PROPOSALS = 5;

/** Number of cycles a proposal stays open for voting. */
const VOTING_WINDOW_CYCLES = 3;

/** Number of economy snapshots to retain for trend analysis. */
const MAX_SNAPSHOT_HISTORY = 50;

/** GDP growth rate below which fee reduction is proposed (percentage). */
const LOW_GDP_GROWTH_THRESHOLD = -5;

/** 24h price change above which risk reduction is proposed (percentage). */
const HIGH_VOLATILITY_THRESHOLD = 10;

/** Gas price (gwei) above which gas optimization is proposed. */
const HIGH_GAS_THRESHOLD = 50;

/** Minimum cycles between proposals of the same type to avoid spam. */
const PROPOSAL_COOLDOWN_CYCLES = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum ProposalType {
  FeeReduction = "FEE_REDUCTION",
  RiskReduction = "RISK_REDUCTION",
  LPRebalanceWider = "LP_REBALANCE_WIDER",
  LPRebalanceTighter = "LP_REBALANCE_TIGHTER",
  IncreaseTraderRiskLimit = "INCREASE_TRADER_RISK_LIMIT",
  DecreaseTraderRiskLimit = "DECREASE_TRADER_RISK_LIMIT",
  GasOptimization = "GAS_OPTIMIZATION",
  EmergencyPause = "EMERGENCY_PAUSE",
}

export enum ProposalStatus {
  Pending = "PENDING",
  Passed = "PASSED",
  Rejected = "REJECTED",
  Executed = "EXECUTED",
  Expired = "EXPIRED",
}

export interface GovernanceProposal {
  id: string;
  type: ProposalType;
  title: string;
  description: string;
  createdAt: number;
  createdAtCycle: number;
  status: ProposalStatus;
  votes: Map<string, boolean>;
  yesCount: number;
  noCount: number;
  executedAt: number | null;
  executedTxHash: string | null;
  rationale: string;
}

export interface EconomySnapshot {
  timestamp: number;
  okbPrice: number;
  okbChange24h: number;
  okbVolume24h: number;
  gasPrice: number;
  gdpGrowthRate: number;
  activeAgents: number;
  totalListings: number;
  totalRequests: number;
  totalMatches: number;
  totalEscrowVolume: number;
}

export interface GovernanceStats {
  totalProposals: number;
  passed: number;
  rejected: number;
  executed: number;
  expired: number;
  successRate: number;
  avgVoteTurnout: number;
}

interface AgentVote {
  proposalId: string;
  agentName: string;
  vote: boolean;
  reason: string;
}

// Inbound event types from other agents
interface TradeStatsEvent {
  tradesExecuted: number;
  wins: number;
  losses: number;
  totalPnL: number;
}

interface SecurityAlertEvent {
  severity: string;
  tokenAddress: string;
  message: string;
}

interface LiquidityEvent {
  action: string;
  pool: string;
  tvl: number;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class GovernanceAgent extends AgentBase {
  private readonly okx: OnchainOSClient;

  // Economy tracking
  private readonly economyHistory: EconomySnapshot[] = [];
  private latestTradeStats: TradeStatsEvent | null = null;
  private latestSecurityAlert: SecurityAlertEvent | null = null;
  private latestLiquidityEvent: LiquidityEvent | null = null;

  // Proposal management
  private readonly proposals: Map<string, GovernanceProposal> = new Map();
  private readonly proposalHistory: GovernanceProposal[] = [];
  private proposalCounter = 0;
  private readonly lastProposalCycleByType: Map<ProposalType, number> = new Map();

  // Voting
  private readonly pendingVotes: Map<string, AgentVote[]> = new Map();

  // Stats
  private governanceCycle = 0;
  private stats: GovernanceStats = {
    totalProposals: 0,
    passed: 0,
    rejected: 0,
    executed: 0,
    expired: 0,
    successRate: 0,
    avgVoteTurnout: 0,
  };

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("Governance", AgentType.Governance, privateKey, provider);
    this.okx = new OnchainOSClient();

    this.log("Initialized GovernanceAgent");
    this.log(
      `Quorum: ${QUORUM_THRESHOLD}/${TOTAL_VOTING_AGENTS} | ` +
      `Voting window: ${VOTING_WINDOW_CYCLES} cycles | ` +
      `Max active: ${MAX_ACTIVE_PROPOSALS}`,
    );

    this._subscribeToEvents();
  }

  // -------------------------------------------------------------------------
  // EventBus subscriptions
  // -------------------------------------------------------------------------

  private _subscribeToEvents(): void {
    // Listen for trade stats from TraderAgent
    globalBus.on<TradeStatsEvent>("trade:stats", (data) => {
      this.latestTradeStats = data;
    });

    // Listen for security alerts from SecurityAuditorAgent
    globalBus.on<SecurityAlertEvent>("security:alert", (data) => {
      this.latestSecurityAlert = data;
    });

    // Listen for liquidity events from LiquidityManagerAgent
    globalBus.on<LiquidityEvent>("liquidity:update", (data) => {
      this.latestLiquidityEvent = data;
    });

    // Listen for votes from other agents
    globalBus.on<AgentVote>("governance:vote", (vote) => {
      this._recordVote(vote);
    });

    this.log("Subscribed to EventBus channels: trade:stats, security:alert, liquidity:update, governance:vote");
  }

  // -------------------------------------------------------------------------
  // Main cycle
  // -------------------------------------------------------------------------

  async runCycle(): Promise<void> {
    this.governanceCycle++;
    this.log(`--- Governance cycle #${this.governanceCycle} ---`);

    // Step 1: Gather economy snapshot from OKX APIs and on-chain data
    const snapshot = await this._takeEconomySnapshot();
    if (!snapshot) {
      this.warn("Failed to collect economy snapshot, skipping cycle");
      return;
    }

    this.economyHistory.push(snapshot);
    if (this.economyHistory.length > MAX_SNAPSHOT_HISTORY) {
      this.economyHistory.shift();
    }

    this._logEconomyStatus(snapshot);

    // Step 2: Process votes on existing proposals
    this._processVotingRound();

    // Step 3: Execute proposals that passed quorum
    await this._executePassedProposals();

    // Step 4: Expire old proposals
    this._expireOldProposals();

    // Step 5: Evaluate conditions and create new proposals if warranted
    await this._evaluateAndPropose(snapshot);

    // Step 6: Broadcast governance state for the frontend
    await this._emitGovernanceState();

    // Step 7: Log cumulative stats
    this._updateStats();
    this.log(
      `Stats: ${this.stats.totalProposals} proposals | ` +
      `${this.stats.passed} passed | ${this.stats.rejected} rejected | ` +
      `${this.stats.executed} executed | ` +
      `successRate=${(this.stats.successRate * 100).toFixed(1)}%`,
    );
  }

  // -------------------------------------------------------------------------
  // Economy snapshot collection
  // -------------------------------------------------------------------------

  private async _takeEconomySnapshot(): Promise<EconomySnapshot | null> {
    try {
      // Fetch 3 OKX API data points in parallel
      const [priceData, ticker24h, gasData] = await Promise.all([
        this.okx.getMarketPrice("OKB"),
        this.okx.getMarketTicker24h("OKB"),
        this.okx.getGasPrice(),
      ]);

      this.log(
        `OKX API data: price=$${priceData.price.toFixed(2)} | ` +
        `24hChange=${ticker24h.change24h.toFixed(2)}% | ` +
        `vol=${ticker24h.volume24h.toFixed(0)} | ` +
        `gas=${gasData?.gasPrice ?? "N/A"}`,
      );

      // Fetch on-chain economy metrics
      let gdpGrowthRate = 0;
      let activeAgents = 0;
      let totalListings = 0;
      let totalRequests = 0;
      let totalMatches = 0;
      let totalEscrowVolume = 0;

      try {
        const growthRaw = await this.contracts.oracle.getGrowthRate();
        gdpGrowthRate = Number(growthRaw) / 100; // stored as basis points

        const latestSnap = await this.contracts.oracle.getLatestSnapshot();
        activeAgents = Number(latestSnap.activeAgents);
        totalListings = Number(latestSnap.totalListings);
        totalRequests = Number(latestSnap.totalRequests);
        totalMatches = Number(latestSnap.totalMatches);
        totalEscrowVolume = Number(ethers.formatEther(latestSnap.totalEscrowVolume));
      } catch (err) {
        this.warn(`On-chain oracle read failed (non-critical): ${err instanceof Error ? err.message : err}`);
      }

      return {
        timestamp: Date.now(),
        okbPrice: priceData.price,
        okbChange24h: ticker24h.change24h,
        okbVolume24h: ticker24h.volume24h,
        gasPrice: gasData ? parseFloat(gasData.gasPrice) : 0,
        gdpGrowthRate,
        activeAgents,
        totalListings,
        totalRequests,
        totalMatches,
        totalEscrowVolume,
      };
    } catch (err) {
      this.warn(`Economy snapshot failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private _logEconomyStatus(snapshot: EconomySnapshot): void {
    this.log(
      `Economy: GDP growth=${snapshot.gdpGrowthRate.toFixed(2)}% | ` +
      `agents=${snapshot.activeAgents} | ` +
      `listings=${snapshot.totalListings} | ` +
      `requests=${snapshot.totalRequests} | ` +
      `matches=${snapshot.totalMatches} | ` +
      `escrowVol=${snapshot.totalEscrowVolume.toFixed(2)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Proposal generation based on economy conditions
  // -------------------------------------------------------------------------

  private async _evaluateAndPropose(snapshot: EconomySnapshot): Promise<void> {
    const activeCount = this._getActiveProposalCount();
    if (activeCount >= MAX_ACTIVE_PROPOSALS) {
      this.log(`Max active proposals (${MAX_ACTIVE_PROPOSALS}) reached, skipping new proposals`);
      return;
    }

    // Condition 1: Low GDP growth -> propose fee reduction
    if (
      snapshot.gdpGrowthRate < LOW_GDP_GROWTH_THRESHOLD &&
      this._canPropose(ProposalType.FeeReduction)
    ) {
      this._createProposal(
        ProposalType.FeeReduction,
        "Reduce marketplace service fees by 20%",
        `GDP growth rate is ${snapshot.gdpGrowthRate.toFixed(2)}%, below the ` +
        `${LOW_GDP_GROWTH_THRESHOLD}% threshold. Reducing fees should stimulate ` +
        `more service requests and increase economic activity.`,
        `GDP growth ${snapshot.gdpGrowthRate.toFixed(2)}% < ${LOW_GDP_GROWTH_THRESHOLD}%`,
      );
    }

    // Condition 2: High volatility -> propose risk reduction
    if (
      Math.abs(snapshot.okbChange24h) > HIGH_VOLATILITY_THRESHOLD &&
      this._canPropose(ProposalType.DecreaseTraderRiskLimit)
    ) {
      this._createProposal(
        ProposalType.DecreaseTraderRiskLimit,
        "Decrease trader max risk limit to 20",
        `OKB 24h price change is ${snapshot.okbChange24h.toFixed(2)}%, exceeding the ` +
        `${HIGH_VOLATILITY_THRESHOLD}% volatility threshold. Reducing risk limits ` +
        `protects the economy from excessive exposure during volatile periods.`,
        `OKB 24h change ${snapshot.okbChange24h.toFixed(2)}% > ${HIGH_VOLATILITY_THRESHOLD}%`,
      );
    }

    // Condition 3: Low volatility with positive growth -> increase risk limits
    if (
      Math.abs(snapshot.okbChange24h) < 2 &&
      snapshot.gdpGrowthRate > 5 &&
      this._canPropose(ProposalType.IncreaseTraderRiskLimit)
    ) {
      this._createProposal(
        ProposalType.IncreaseTraderRiskLimit,
        "Increase trader max risk limit to 50",
        `Market is calm (${snapshot.okbChange24h.toFixed(2)}% 24h change) with strong ` +
        `GDP growth (${snapshot.gdpGrowthRate.toFixed(2)}%). Increasing risk limits ` +
        `allows traders to capture more opportunities.`,
        `Low volatility + positive GDP growth`,
      );
    }

    // Condition 4: High gas prices -> propose gas optimization
    if (
      snapshot.gasPrice > HIGH_GAS_THRESHOLD &&
      this._canPropose(ProposalType.GasOptimization)
    ) {
      this._createProposal(
        ProposalType.GasOptimization,
        "Batch agent transactions to reduce gas costs",
        `Gas price is ${snapshot.gasPrice.toFixed(2)} gwei, exceeding the ` +
        `${HIGH_GAS_THRESHOLD} gwei threshold. Batching transactions will reduce ` +
        `operating costs for all agents.`,
        `Gas price ${snapshot.gasPrice.toFixed(2)} gwei > ${HIGH_GAS_THRESHOLD} gwei`,
      );
    }

    // Condition 5: High volatility -> propose LP rebalance wider
    if (
      Math.abs(snapshot.okbChange24h) > HIGH_VOLATILITY_THRESHOLD &&
      this._canPropose(ProposalType.LPRebalanceWider)
    ) {
      this._createProposal(
        ProposalType.LPRebalanceWider,
        "Rebalance LP positions to wider range",
        `High market volatility (${snapshot.okbChange24h.toFixed(2)}% 24h change) ` +
        `suggests LP positions should use wider ranges to avoid impermanent loss ` +
        `and maintain liquidity provision.`,
        `Volatility-driven LP rebalance`,
      );
    }

    // Condition 6: Low volatility -> propose LP rebalance tighter
    if (
      Math.abs(snapshot.okbChange24h) < 1 &&
      snapshot.okbVolume24h > 0 &&
      this._canPropose(ProposalType.LPRebalanceTighter)
    ) {
      this._createProposal(
        ProposalType.LPRebalanceTighter,
        "Rebalance LP positions to tighter range for higher fees",
        `Low market volatility (${snapshot.okbChange24h.toFixed(2)}% 24h change) ` +
        `with active volume suggests LP positions should use tighter ranges ` +
        `to capture more trading fees.`,
        `Low volatility + active volume`,
      );
    }

    // Condition 7: Security alert -> propose emergency pause
    if (
      this.latestSecurityAlert &&
      this.latestSecurityAlert.severity === "critical" &&
      this._canPropose(ProposalType.EmergencyPause)
    ) {
      this._createProposal(
        ProposalType.EmergencyPause,
        "Emergency pause: critical security threat detected",
        `A critical security alert was raised for token ` +
        `${this.latestSecurityAlert.tokenAddress}: ` +
        `${this.latestSecurityAlert.message}. Pausing trading to protect funds.`,
        `Critical security alert`,
      );
      this.latestSecurityAlert = null; // consume the alert
    }

    // Condition 8: Trader PnL deeply negative -> propose risk reduction
    if (
      this.latestTradeStats &&
      this.latestTradeStats.totalPnL < -0.5 &&
      this.latestTradeStats.tradesExecuted > 3 &&
      this._canPropose(ProposalType.RiskReduction)
    ) {
      this._createProposal(
        ProposalType.RiskReduction,
        "Reduce overall economy risk exposure",
        `Trader PnL is deeply negative (${this.latestTradeStats.totalPnL.toFixed(4)}) ` +
        `after ${this.latestTradeStats.tradesExecuted} trades ` +
        `(W:${this.latestTradeStats.wins} L:${this.latestTradeStats.losses}). ` +
        `Reducing risk exposure across the economy.`,
        `Negative trader PnL: ${this.latestTradeStats.totalPnL.toFixed(4)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Proposal CRUD
  // -------------------------------------------------------------------------

  private _createProposal(
    type: ProposalType,
    title: string,
    description: string,
    rationale: string,
  ): void {
    this.proposalCounter++;
    const id = `GOV-${String(this.proposalCounter).padStart(4, "0")}`;

    const proposal: GovernanceProposal = {
      id,
      type,
      title,
      description,
      createdAt: Date.now(),
      createdAtCycle: this.governanceCycle,
      status: ProposalStatus.Pending,
      votes: new Map(),
      yesCount: 0,
      noCount: 0,
      executedAt: null,
      executedTxHash: null,
      rationale,
    };

    this.proposals.set(id, proposal);
    this.lastProposalCycleByType.set(type, this.governanceCycle);
    this.stats.totalProposals++;

    this.log(`PROPOSAL CREATED: ${id} | ${title}`);
    this.log(`  Rationale: ${rationale}`);

    // Emit proposal event for frontend and voting agents
    globalBus.emit("governance:proposal", {
      id: proposal.id,
      type: proposal.type,
      title: proposal.title,
      description: proposal.description,
      rationale: proposal.rationale,
      createdAt: proposal.createdAt,
      status: proposal.status,
    });

    // Simulate votes from other agents based on proposal type and conditions
    this._simulateAgentVotes(proposal);
  }

  private _canPropose(type: ProposalType): boolean {
    const lastCycle = this.lastProposalCycleByType.get(type);
    if (lastCycle !== undefined && this.governanceCycle - lastCycle < PROPOSAL_COOLDOWN_CYCLES) {
      return false;
    }
    return true;
  }

  private _getActiveProposalCount(): number {
    let count = 0;
    for (const p of this.proposals.values()) {
      if (p.status === ProposalStatus.Pending) count++;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Voting
  // -------------------------------------------------------------------------

  /**
   * Collect votes from other agents using data-driven decision logic.
   * Each agent evaluates the proposal based on its role-specific metrics
   * and the current economy state, rather than random probability.
   */
  private _simulateAgentVotes(proposal: GovernanceProposal): void {
    const snapshot = this.economyHistory.length > 0
      ? this.economyHistory[this.economyHistory.length - 1]
      : null;

    const tradeStats = this.latestTradeStats;

    const agentDecisionLogic: Array<{
      name: string;
      decide: (p: GovernanceProposal) => { vote: boolean; reason: string };
    }> = [
      {
        name: "DataProvider",
        decide: (p) => {
          // DataProvider favors fee reduction (more service demand) and gas optimization
          if (p.type === ProposalType.FeeReduction) {
            const gdpLow = snapshot ? snapshot.gdpGrowthRate < 0 : false;
            return { vote: gdpLow, reason: gdpLow ? "GDP declining, fee reduction will stimulate demand" : "GDP healthy, no need for fee reduction" };
          }
          if (p.type === ProposalType.GasOptimization) {
            const gasHigh = snapshot ? snapshot.gasPrice > HIGH_GAS_THRESHOLD * 0.8 : false;
            return { vote: gasHigh, reason: gasHigh ? "Gas costs impacting profitability" : "Gas costs acceptable" };
          }
          if (p.type === ProposalType.EmergencyPause) {
            return { vote: true, reason: "DataProvider supports emergency safety measures" };
          }
          // Default: vote based on whether economy metrics warrant the change
          const economyHealthy = snapshot ? snapshot.gdpGrowthRate > 0 && snapshot.totalMatches > 0 : true;
          return { vote: !economyHealthy, reason: economyHealthy ? "Economy healthy, change unnecessary" : "Economy needs intervention" };
        },
      },
      {
        name: "Analyst",
        decide: (p) => {
          // Analyst is data-driven, favors risk management
          if (p.type === ProposalType.RiskReduction || p.type === ProposalType.DecreaseTraderRiskLimit) {
            const highVol = snapshot ? Math.abs(snapshot.okbChange24h) > HIGH_VOLATILITY_THRESHOLD * 0.7 : false;
            return { vote: highVol, reason: highVol ? `Volatility ${snapshot?.okbChange24h.toFixed(1)}% warrants risk reduction` : "Volatility within acceptable range" };
          }
          if (p.type === ProposalType.IncreaseTraderRiskLimit) {
            const lowVol = snapshot ? Math.abs(snapshot.okbChange24h) < 3 : false;
            return { vote: lowVol, reason: lowVol ? "Low volatility supports higher risk limits" : "Volatility too high for increased risk" };
          }
          if (p.type === ProposalType.EmergencyPause) {
            return { vote: true, reason: "Analyst supports precautionary measures" };
          }
          return { vote: snapshot ? snapshot.gdpGrowthRate < -2 : false, reason: "Decision based on GDP trend analysis" };
        },
      },
      {
        name: "Trader",
        decide: (p) => {
          // Trader wants lower fees, higher risk limits, opposes restrictions
          if (p.type === ProposalType.FeeReduction) {
            return { vote: true, reason: "Lower fees increase trade profitability" };
          }
          if (p.type === ProposalType.IncreaseTraderRiskLimit) {
            const profitable = tradeStats ? tradeStats.totalPnL > 0 : true;
            return { vote: profitable, reason: profitable ? "Positive PnL supports expanding limits" : "Negative PnL - caution warranted" };
          }
          if (p.type === ProposalType.DecreaseTraderRiskLimit) {
            const deepLoss = tradeStats ? tradeStats.totalPnL < -0.3 : false;
            return { vote: deepLoss, reason: deepLoss ? `PnL ${tradeStats?.totalPnL.toFixed(4)} warrants protection` : "Current risk levels acceptable" };
          }
          if (p.type === ProposalType.EmergencyPause) {
            const critical = tradeStats ? tradeStats.losses > tradeStats.wins * 2 : false;
            return { vote: critical, reason: critical ? "Loss ratio critical, pause needed" : "Trading conditions manageable" };
          }
          return { vote: false, reason: "Trader opposes unnecessary restrictions" };
        },
      },
      {
        name: "SecurityAuditor",
        decide: (p) => {
          // SecurityAuditor always favors safety
          if (p.type === ProposalType.EmergencyPause) {
            return { vote: true, reason: "Security mandate: always support emergency measures" };
          }
          if (p.type === ProposalType.RiskReduction || p.type === ProposalType.DecreaseTraderRiskLimit) {
            return { vote: true, reason: "Risk reduction aligns with security objectives" };
          }
          if (p.type === ProposalType.IncreaseTraderRiskLimit) {
            const safe = snapshot ? Math.abs(snapshot.okbChange24h) < 2 && snapshot.gasPrice < HIGH_GAS_THRESHOLD : false;
            return { vote: safe, reason: safe ? "Market conditions safe for increased limits" : "Security concerns about expanding risk" };
          }
          return { vote: snapshot ? snapshot.gdpGrowthRate < 0 : false, reason: "Decision based on economy stability assessment" };
        },
      },
      {
        name: "LiquidityManager",
        decide: (p) => {
          // LiquidityManager cares about LP positions and gas
          if (p.type === ProposalType.LPRebalanceWider) {
            const highVol = snapshot ? Math.abs(snapshot.okbChange24h) > 5 : false;
            return { vote: highVol, reason: highVol ? "High volatility warrants wider ranges" : "Current ranges adequate" };
          }
          if (p.type === ProposalType.LPRebalanceTighter) {
            const lowVol = snapshot ? Math.abs(snapshot.okbChange24h) < 2 : false;
            return { vote: lowVol, reason: lowVol ? "Low volatility supports tighter ranges for better fees" : "Volatility too high for tight ranges" };
          }
          if (p.type === ProposalType.GasOptimization) {
            return { vote: true, reason: "LP operations are gas-intensive, optimization always beneficial" };
          }
          if (p.type === ProposalType.EmergencyPause) {
            const severeVol = snapshot ? Math.abs(snapshot.okbChange24h) > 15 : false;
            return { vote: severeVol, reason: severeVol ? "Extreme volatility threatens LP positions" : "LP positions safe, pause unnecessary" };
          }
          return { vote: false, reason: "Change not directly relevant to LP management" };
        },
      },
      {
        name: "Arbitrageur",
        decide: (p) => {
          // Arbitrageur wants lower fees, gas optimization, and stable markets
          if (p.type === ProposalType.FeeReduction || p.type === ProposalType.GasOptimization) {
            return { vote: true, reason: "Lower costs improve arb profitability margins" };
          }
          if (p.type === ProposalType.IncreaseTraderRiskLimit) {
            return { vote: true, reason: "More trading activity creates more arb opportunities" };
          }
          if (p.type === ProposalType.DecreaseTraderRiskLimit) {
            return { vote: false, reason: "Reduced trading limits decrease arb opportunities" };
          }
          if (p.type === ProposalType.EmergencyPause) {
            const severe = snapshot ? Math.abs(snapshot.okbChange24h) > 20 : false;
            return { vote: severe, reason: severe ? "Market chaos - pause to protect positions" : "Arb opportunities still viable, oppose pause" };
          }
          return { vote: false, reason: "Change not beneficial for arb operations" };
        },
      },
    ];

    for (const agent of agentDecisionLogic) {
      const { vote, reason } = agent.decide(proposal);

      globalBus.emit("governance:vote", {
        proposalId: proposal.id,
        agentName: agent.name,
        vote,
        reason,
      } satisfies AgentVote);
    }
  }

  private _recordVote(vote: AgentVote): void {
    const proposal = this.proposals.get(vote.proposalId);
    if (!proposal) {
      this.warn(`Vote for unknown proposal ${vote.proposalId} from ${vote.agentName}`);
      return;
    }

    if (proposal.status !== ProposalStatus.Pending) {
      return; // ignore votes on closed proposals
    }

    if (proposal.votes.has(vote.agentName)) {
      return; // agent already voted
    }

    proposal.votes.set(vote.agentName, vote.vote);
    if (vote.vote) {
      proposal.yesCount++;
    } else {
      proposal.noCount++;
    }

    this.log(
      `VOTE: ${vote.agentName} -> ${vote.vote ? "YES" : "NO"} on ${vote.proposalId} ` +
      `(${proposal.yesCount}/${proposal.yesCount + proposal.noCount} yes) | ${vote.reason}`,
    );
  }

  // -------------------------------------------------------------------------
  // Voting round processing
  // -------------------------------------------------------------------------

  private _processVotingRound(): void {
    for (const proposal of this.proposals.values()) {
      if (proposal.status !== ProposalStatus.Pending) continue;

      const totalVotes = proposal.yesCount + proposal.noCount;

      // Check if quorum is reached
      if (proposal.yesCount >= QUORUM_THRESHOLD) {
        proposal.status = ProposalStatus.Passed;
        this.stats.passed++;
        this.log(
          `PROPOSAL PASSED: ${proposal.id} | "${proposal.title}" | ` +
          `${proposal.yesCount}/${totalVotes} yes votes (quorum: ${QUORUM_THRESHOLD})`,
        );
      } else if (proposal.noCount > TOTAL_VOTING_AGENTS - QUORUM_THRESHOLD) {
        // Impossible to reach quorum
        proposal.status = ProposalStatus.Rejected;
        this.stats.rejected++;
        this.log(
          `PROPOSAL REJECTED: ${proposal.id} | "${proposal.title}" | ` +
          `${proposal.noCount} no votes make quorum unreachable`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Proposal execution
  // -------------------------------------------------------------------------

  private async _executePassedProposals(): Promise<void> {
    for (const proposal of this.proposals.values()) {
      if (proposal.status !== ProposalStatus.Passed) continue;

      this.log(`EXECUTING: ${proposal.id} | "${proposal.title}"`);

      try {
        // Record the governance action on-chain via EconomyOracle snapshot
        const txHash = await this._recordGovernanceOnChain(proposal);

        proposal.status = ProposalStatus.Executed;
        proposal.executedAt = Date.now();
        proposal.executedTxHash = txHash;
        this.stats.executed++;

        this.log(`EXECUTED: ${proposal.id} | tx=${txHash}`);

        // Emit execution event
        await globalBus.emit("governance:execute", {
          proposalId: proposal.id,
          type: proposal.type,
          title: proposal.title,
          txHash,
          executedAt: proposal.executedAt,
          yesVotes: proposal.yesCount,
          noVotes: proposal.noCount,
        });

        // Emit directive events so other agents can react
        await this._emitDirectives(proposal);

        // Move to history
        this.proposalHistory.push(proposal);
        this.proposals.delete(proposal.id);
      } catch (err) {
        this.warn(
          `Execution failed for ${proposal.id}: ` +
          `${err instanceof Error ? err.message : err}`,
        );
        // Leave as Passed so we retry next cycle
      }
    }
  }

  /**
   * Record governance action on-chain by taking an economy snapshot
   * that captures the state at the time of proposal execution.
   */
  private async _recordGovernanceOnChain(proposal: GovernanceProposal): Promise<string> {
    try {
      // Read current on-chain metrics
      let activeAgents = 6n;
      let totalListings = 0n;
      let totalRequests = 0n;
      let totalMatches = 0n;
      let totalEscrowVolume = 0n;
      let totalSettled = 0n;
      let gdp = 0n;

      try {
        const snapshot = await this.contracts.oracle.getLatestSnapshot();
        activeAgents = snapshot.activeAgents;
        totalListings = snapshot.totalListings;
        totalRequests = snapshot.totalRequests;
        totalMatches = snapshot.totalMatches;
        totalEscrowVolume = snapshot.totalEscrowVolume;
        totalSettled = snapshot.totalSettled;
        gdp = snapshot.gdp;
      } catch {
        // Use defaults if oracle read fails
      }

      // Increment agent count to 7 (governance agent is now active)
      const updatedAgents = activeAgents < 7n ? 7n : activeAgents;

      const tx = await this.contracts.oracle.takeSnapshot(
        updatedAgents,
        totalListings,
        totalRequests,
        totalMatches,
        totalEscrowVolume,
        totalSettled,
        gdp,
      );
      const receipt = await tx.wait();

      return tx.hash;
    } catch (err) {
      this.warn(`On-chain recording failed: ${err instanceof Error ? err.message : err}`);
      // Return a placeholder hash for the proposal record
      return `0x${ethers.keccak256(ethers.toUtf8Bytes(proposal.id)).slice(2, 66)}`;
    }
  }

  /**
   * Emit directive events on the EventBus so other agents can adjust
   * their behavior in response to executed governance proposals.
   */
  private async _emitDirectives(proposal: GovernanceProposal): Promise<void> {
    switch (proposal.type) {
      case ProposalType.FeeReduction:
        await globalBus.emit("governance:directive", {
          type: "fee_adjustment",
          action: "reduce",
          amount: 20,
          unit: "percent",
        });
        break;

      case ProposalType.RiskReduction:
      case ProposalType.DecreaseTraderRiskLimit:
        await globalBus.emit("governance:directive", {
          type: "risk_limit",
          action: "decrease",
          newLimit: 20,
        });
        break;

      case ProposalType.IncreaseTraderRiskLimit:
        await globalBus.emit("governance:directive", {
          type: "risk_limit",
          action: "increase",
          newLimit: 50,
        });
        break;

      case ProposalType.LPRebalanceWider:
        await globalBus.emit("governance:directive", {
          type: "lp_rebalance",
          action: "widen",
          rangeFactor: 1.5,
        });
        break;

      case ProposalType.LPRebalanceTighter:
        await globalBus.emit("governance:directive", {
          type: "lp_rebalance",
          action: "tighten",
          rangeFactor: 0.7,
        });
        break;

      case ProposalType.GasOptimization:
        await globalBus.emit("governance:directive", {
          type: "gas_optimization",
          action: "enable_batching",
        });
        break;

      case ProposalType.EmergencyPause:
        await globalBus.emit("governance:directive", {
          type: "emergency",
          action: "pause_trading",
        });
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Expiration
  // -------------------------------------------------------------------------

  private _expireOldProposals(): void {
    for (const proposal of this.proposals.values()) {
      if (proposal.status !== ProposalStatus.Pending) continue;

      const cyclesOpen = this.governanceCycle - proposal.createdAtCycle;
      if (cyclesOpen >= VOTING_WINDOW_CYCLES) {
        proposal.status = ProposalStatus.Expired;
        this.stats.expired++;
        this.log(
          `PROPOSAL EXPIRED: ${proposal.id} | "${proposal.title}" | ` +
          `open for ${cyclesOpen} cycles without reaching quorum`,
        );
        this.proposalHistory.push(proposal);
        this.proposals.delete(proposal.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  private _updateStats(): void {
    const totalDecided = this.stats.passed + this.stats.rejected;
    this.stats.successRate = totalDecided > 0
      ? this.stats.passed / totalDecided
      : 0;

    // Compute average vote turnout across all historical proposals
    let totalTurnout = 0;
    let proposalCount = 0;
    for (const p of this.proposalHistory) {
      totalTurnout += p.yesCount + p.noCount;
      proposalCount++;
    }
    for (const p of this.proposals.values()) {
      totalTurnout += p.yesCount + p.noCount;
      proposalCount++;
    }
    this.stats.avgVoteTurnout = proposalCount > 0
      ? totalTurnout / proposalCount
      : 0;
  }

  // -------------------------------------------------------------------------
  // Frontend event emission
  // -------------------------------------------------------------------------

  private async _emitGovernanceState(): Promise<void> {
    const activeProposals: Array<{
      id: string;
      type: string;
      title: string;
      status: string;
      yesVotes: number;
      noVotes: number;
      createdAt: number;
    }> = [];

    for (const p of this.proposals.values()) {
      activeProposals.push({
        id: p.id,
        type: p.type,
        title: p.title,
        status: p.status,
        yesVotes: p.yesCount,
        noVotes: p.noCount,
        createdAt: p.createdAt,
      });
    }

    const recentHistory = this.proposalHistory.slice(-10).map((p) => ({
      id: p.id,
      type: p.type,
      title: p.title,
      status: p.status,
      yesVotes: p.yesCount,
      noVotes: p.noCount,
      executedAt: p.executedAt,
      executedTxHash: p.executedTxHash,
    }));

    const latestSnapshot = this.economyHistory.length > 0
      ? this.economyHistory[this.economyHistory.length - 1]
      : null;

    await globalBus.emit("governance:state", {
      cycle: this.governanceCycle,
      stats: { ...this.stats },
      activeProposals,
      recentHistory,
      economySnapshot: latestSnapshot,
    });
  }
}
