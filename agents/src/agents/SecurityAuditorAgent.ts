/**
 * SecurityAuditorAgent -- comprehensive security monitoring and token scanning.
 *
 * Cycle:
 *  1. Monitor gas prices via OKX API for anomaly detection
 *  2. Check contract health: registry agent count, marketplace listings/requests,
 *     escrow status, oracle snapshots
 *  3. Detect anomalies: sudden drops in agent count, unusual escrow volumes,
 *     stale oracle data, reputation score manipulation
 *  4. Monitor token prices for abnormal movements (pump/dump detection)
 *  5. Track treasury balance changes for suspicious withdrawals
 *  6. Process pending security scan requests from other agents
 *  7. Generate SecurityReport with risk score and findings
 *  8. List SECURITY_AUDIT service on the marketplace with Dutch auction pricing
 *  9. Emit events: security:scan_complete, security:alert, security:risk_score
 *
 * Uses 3+ OKX API skills: getGasPrice, getMarketTicker24h, securityScan
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient, SecurityScanResult } from "../core/OnchainOSClient.js";
import { globalBus } from "../core/EventBus.js";
import { AgentType } from "../config/contracts.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How often (in cycles) to run deep contract health checks. */
const HEALTH_CHECK_INTERVAL = 3;

/** How often (in cycles) to check treasury balance for anomalies. */
const TREASURY_CHECK_INTERVAL = 4;

/** How often (in cycles) to check reputation scores for manipulation. */
const REPUTATION_CHECK_INTERVAL = 5;

/** Gas price (gwei) above which we flag an alert. */
const GAS_PRICE_ALERT_THRESHOLD = 80;

/** Gas price (gwei) considered critically high. */
const GAS_PRICE_CRITICAL_THRESHOLD = 150;

/** 24h price change (absolute %) that triggers a volatility alert. */
const PRICE_VOLATILITY_THRESHOLD = 15;

/** Oracle data older than this (ms) is considered stale. */
const ORACLE_STALENESS_MS = 10 * 60 * 1000;

/** Agent count drop percentage that triggers an alert. */
const AGENT_DROP_ALERT_PERCENT = 25;

/** Maximum pending requests to process per cycle. */
const MAX_REQUESTS_PER_CYCLE = 5;

/** Dutch auction pricing for the SECURITY_AUDIT service. */
const START_PRICE = ethers.parseEther("0.0005");
const FLOOR_PRICE = ethers.parseEther("0.00005");
const DECAY_RATE = ethers.parseEther("0.000005");

/** Maximum number of findings retained in history. */
const MAX_FINDINGS_HISTORY = 200;

/** Maximum number of snapshots retained for trend analysis. */
const MAX_SNAPSHOT_HISTORY = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SecurityRequest {
  tokenAddress: string;
  requester: string;
  requestId?: bigint;
}

export enum FindingSeverity {
  Info = "INFO",
  Low = "LOW",
  Medium = "MEDIUM",
  High = "HIGH",
  Critical = "CRITICAL",
}

export interface SecurityFinding {
  id: string;
  timestamp: number;
  severity: FindingSeverity;
  category: string;
  title: string;
  description: string;
  metadata: Record<string, string | number | boolean>;
}

export interface GasStatus {
  currentGwei: number;
  baseFee: string;
  maxPriorityFee: string;
  isHealthy: boolean;
  alertLevel: "normal" | "elevated" | "critical";
}

export interface ContractHealthSnapshot {
  timestamp: number;
  agentCount: number;
  listingCount: number;
  requestCount: number;
  oracleTimestamp: number;
  oracleGdp: number;
  escrowVolume: number;
  escrowSettled: number;
}

export interface SecurityReport {
  timestamp: number;
  riskScore: number;
  findings: SecurityFinding[];
  gasStatus: GasStatus;
  contractsHealthy: boolean;
  agentCount: number;
  marketVolatility: number;
  treasuryBalance: string;
  scansCompleted: number;
  cycleNumber: number;
}

interface MarketplaceMatchEvent {
  requestId: bigint;
  listingId: bigint;
  buyer: string;
  seller: string;
}

interface EscrowSettledEvent {
  escrowId: bigint;
  amount: bigint;
  buyer: string;
  seller: string;
}

interface MarketDataEvent {
  timestamp: number;
  prices: Array<{ token: string; price: number }>;
  gasPrice?: string;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class SecurityAuditorAgent extends AgentBase {
  private readonly okx: OnchainOSClient;
  private currentListingId: bigint | null = null;

  // Pending scan requests from other agents
  private pendingRequests: SecurityRequest[] = [];
  private scansCompleted = 0;

  // Scan cache to avoid redundant API calls (TTL = 5 minutes)
  private scanCache = new Map<string, { result: SecurityScanResult; expires: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  // Internal cycle counter for interval-based tasks
  private internalCycleCount = 0;

  // Findings and reports
  private findingCounter = 0;
  private readonly findingsHistory: SecurityFinding[] = [];
  private readonly reportHistory: SecurityReport[] = [];

  // Contract health snapshots for trend detection
  private readonly healthSnapshots: ContractHealthSnapshot[] = [];

  // Context gathered from other agents via EventBus
  private recentMatches: MarketplaceMatchEvent[] = [];
  private recentSettlements: EscrowSettledEvent[] = [];
  private latestMarketData: MarketDataEvent | null = null;

  // Previous-cycle values for delta detection
  private previousAgentCount: number | null = null;
  private previousTreasuryBalance: bigint | null = null;
  private previousEscrowVolume: number | null = null;

  // Reputation tracking for manipulation detection
  private reputationSnapshots = new Map<string, number[]>();

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("SecurityAuditor", AgentType.SecurityAuditor, privateKey, provider);
    this.okx = new OnchainOSClient();

    this.log("Initialized SecurityAuditorAgent");
    this.log(
      `Gas alert threshold: ${GAS_PRICE_ALERT_THRESHOLD} gwei | ` +
      `Volatility threshold: ${PRICE_VOLATILITY_THRESHOLD}% | ` +
      `Oracle staleness: ${ORACLE_STALENESS_MS / 1000}s`,
    );

    this._subscribeToEvents();
  }

  // -------------------------------------------------------------------------
  // EventBus subscriptions
  // -------------------------------------------------------------------------

  private _subscribeToEvents(): void {
    globalBus.on<SecurityRequest>("security:request", (req) => {
      this.pendingRequests.push(req);
      this.log(`Queued security scan request for ${req.tokenAddress} from ${req.requester}`);
    });

    globalBus.on<MarketplaceMatchEvent>("marketplace:match", (data) => {
      this.recentMatches.push(data);
      if (this.recentMatches.length > 100) {
        this.recentMatches = this.recentMatches.slice(-50);
      }
    });

    globalBus.on<EscrowSettledEvent>("escrow:settled", (data) => {
      this.recentSettlements.push(data);
      if (this.recentSettlements.length > 100) {
        this.recentSettlements = this.recentSettlements.slice(-50);
      }
    });

    globalBus.on<MarketDataEvent>("market:data", (data) => {
      this.latestMarketData = data;
    });

    this.log(
      "Subscribed to EventBus channels: security:request, marketplace:match, " +
      "escrow:settled, market:data",
    );
  }

  // -------------------------------------------------------------------------
  // Main cycle
  // -------------------------------------------------------------------------

  async runCycle(): Promise<void> {
    this.internalCycleCount++;
    const cycleStart = Date.now();
    const currentFindings: SecurityFinding[] = [];

    this.log(`--- Security audit cycle #${this.internalCycleCount} ---`);

    // Step 1: Monitor gas prices via OKX API
    const gasStatus = await this._checkGasPrice(currentFindings);

    // Step 2: Monitor token price volatility via OKX API
    const marketVolatility = await this._checkMarketVolatility(currentFindings);

    // Step 3: Check contract health (registry, marketplace, oracle)
    let contractsHealthy = true;
    let agentCount = 0;
    if (this.internalCycleCount % HEALTH_CHECK_INTERVAL === 0 || this.internalCycleCount === 1) {
      const healthResult = await this._checkContractHealth(currentFindings);
      contractsHealthy = healthResult.healthy;
      agentCount = healthResult.agentCount;
    } else if (this.healthSnapshots.length > 0) {
      const last = this.healthSnapshots[this.healthSnapshots.length - 1];
      agentCount = last.agentCount;
    }

    // Step 4: Check treasury balance for suspicious changes
    let treasuryBalance = "0";
    if (this.internalCycleCount % TREASURY_CHECK_INTERVAL === 0 || this.internalCycleCount === 1) {
      treasuryBalance = await this._checkTreasuryBalance(currentFindings);
    }

    // Step 5: Check reputation scores for manipulation patterns
    if (this.internalCycleCount % REPUTATION_CHECK_INTERVAL === 0) {
      await this._checkReputationManipulation(currentFindings);
    }

    // Step 6: Analyze recent escrow activity for anomalies
    this._analyzeEscrowActivity(currentFindings);

    // Step 7: Process pending token security scan requests
    await this._processPendingScans(currentFindings);

    // Step 8: List SECURITY_AUDIT service if not yet listed
    if (this.currentListingId === null) {
      await this._listSecurityService();
    }

    // Step 9: Compute overall risk score
    const riskScore = this._computeRiskScore(currentFindings, gasStatus, contractsHealthy);

    // Step 10: Build and emit the security report
    const report: SecurityReport = {
      timestamp: Date.now(),
      riskScore,
      findings: currentFindings,
      gasStatus,
      contractsHealthy,
      agentCount,
      marketVolatility,
      treasuryBalance,
      scansCompleted: this.scansCompleted,
      cycleNumber: this.internalCycleCount,
    };

    this.reportHistory.push(report);
    if (this.reportHistory.length > MAX_SNAPSHOT_HISTORY) {
      this.reportHistory.shift();
    }

    // Store findings in history
    for (const f of currentFindings) {
      this.findingsHistory.push(f);
    }
    while (this.findingsHistory.length > MAX_FINDINGS_HISTORY) {
      this.findingsHistory.shift();
    }

    // Emit events
    await globalBus.emit("security:scan_complete", {
      timestamp: report.timestamp,
      riskScore: report.riskScore,
      findingsCount: currentFindings.length,
      contractsHealthy: report.contractsHealthy,
      gasStatus: report.gasStatus,
    });

    await globalBus.emit("security:risk_score", {
      timestamp: report.timestamp,
      riskScore: report.riskScore,
      trend: this._computeRiskTrend(),
      cycleNumber: this.internalCycleCount,
    });

    // Emit individual alerts for high-severity findings
    for (const finding of currentFindings) {
      if (finding.severity === FindingSeverity.High || finding.severity === FindingSeverity.Critical) {
        await globalBus.emit("security:alert", {
          severity: finding.severity,
          tokenAddress: String(finding.metadata.tokenAddress ?? ""),
          message: `${finding.title}: ${finding.description}`,
        });
      }
    }

    // Log cycle summary
    const cycleLatency = Date.now() - cycleStart;
    const critCount = currentFindings.filter((f) => f.severity === FindingSeverity.Critical).length;
    const highCount = currentFindings.filter((f) => f.severity === FindingSeverity.High).length;
    const medCount = currentFindings.filter((f) => f.severity === FindingSeverity.Medium).length;

    this.log(
      `Risk score: ${riskScore}/100 | ` +
      `Findings: ${currentFindings.length} (C:${critCount} H:${highCount} M:${medCount}) | ` +
      `Gas: ${gasStatus.currentGwei.toFixed(2)} gwei [${gasStatus.alertLevel}] | ` +
      `Contracts: ${contractsHealthy ? "HEALTHY" : "DEGRADED"} | ` +
      `Scans total: ${this.scansCompleted} | ` +
      `Cycle latency: ${cycleLatency}ms`,
    );
  }

  // -------------------------------------------------------------------------
  // Gas price monitoring
  // -------------------------------------------------------------------------

  private async _checkGasPrice(findings: SecurityFinding[]): Promise<GasStatus> {
    const fallback: GasStatus = {
      currentGwei: 0,
      baseFee: "0",
      maxPriorityFee: "0",
      isHealthy: true,
      alertLevel: "normal",
    };

    try {
      const gas = await this.okx.getGasPrice();
      if (!gas) {
        this.warn("Gas price API returned null");
        return fallback;
      }

      const currentGwei = parseFloat(gas.gasPrice);
      let alertLevel: GasStatus["alertLevel"] = "normal";
      let isHealthy = true;

      if (currentGwei > GAS_PRICE_CRITICAL_THRESHOLD) {
        alertLevel = "critical";
        isHealthy = false;
        findings.push(this._createFinding(
          FindingSeverity.High,
          "gas",
          "Critical gas price spike",
          `Gas price is ${currentGwei.toFixed(2)} gwei, exceeding the critical ` +
          `threshold of ${GAS_PRICE_CRITICAL_THRESHOLD} gwei. On-chain operations ` +
          `may fail or be prohibitively expensive.`,
          { gasGwei: currentGwei, threshold: GAS_PRICE_CRITICAL_THRESHOLD },
        ));
      } else if (currentGwei > GAS_PRICE_ALERT_THRESHOLD) {
        alertLevel = "elevated";
        findings.push(this._createFinding(
          FindingSeverity.Medium,
          "gas",
          "Elevated gas price",
          `Gas price is ${currentGwei.toFixed(2)} gwei, above the alert ` +
          `threshold of ${GAS_PRICE_ALERT_THRESHOLD} gwei. Agents should ` +
          `consider batching transactions.`,
          { gasGwei: currentGwei, threshold: GAS_PRICE_ALERT_THRESHOLD },
        ));
      }

      this.log(`Gas price: ${currentGwei.toFixed(2)} gwei | base=${gas.baseFee} | priority=${gas.maxPriorityFee}`);

      return {
        currentGwei,
        baseFee: gas.baseFee,
        maxPriorityFee: gas.maxPriorityFee,
        isHealthy,
        alertLevel,
      };
    } catch (err) {
      this.warn(`Gas price check failed: ${err instanceof Error ? err.message : err}`);
      return fallback;
    }
  }

  // -------------------------------------------------------------------------
  // Market volatility monitoring
  // -------------------------------------------------------------------------

  private async _checkMarketVolatility(findings: SecurityFinding[]): Promise<number> {
    try {
      const ticker = await this.okx.getMarketTicker24h("OKB");
      const absChange = Math.abs(ticker.change24h);

      this.log(
        `Market: OKB 24h change=${ticker.change24h.toFixed(2)}% | ` +
        `vol=${ticker.volume24h.toFixed(0)} | ` +
        `H=${ticker.high24h.toFixed(2)} L=${ticker.low24h.toFixed(2)}`,
      );

      if (absChange > PRICE_VOLATILITY_THRESHOLD) {
        const direction = ticker.change24h > 0 ? "surge" : "crash";
        findings.push(this._createFinding(
          FindingSeverity.High,
          "market",
          `Extreme OKB price ${direction}`,
          `OKB 24h price change is ${ticker.change24h.toFixed(2)}%, ` +
          `exceeding the ${PRICE_VOLATILITY_THRESHOLD}% volatility threshold. ` +
          `This may indicate market manipulation or a black swan event. ` +
          `Volume: ${ticker.volume24h.toFixed(0)}.`,
          {
            change24h: ticker.change24h,
            volume24h: ticker.volume24h,
            high24h: ticker.high24h,
            low24h: ticker.low24h,
            threshold: PRICE_VOLATILITY_THRESHOLD,
          },
        ));
      } else if (absChange > PRICE_VOLATILITY_THRESHOLD * 0.6) {
        findings.push(this._createFinding(
          FindingSeverity.Low,
          "market",
          "Notable OKB price movement",
          `OKB 24h price change is ${ticker.change24h.toFixed(2)}%, approaching ` +
          `the volatility threshold. Monitoring closely.`,
          { change24h: ticker.change24h, volume24h: ticker.volume24h },
        ));
      }

      return absChange;
    } catch (err) {
      this.warn(`Market volatility check failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Contract health checks
  // -------------------------------------------------------------------------

  private async _checkContractHealth(
    findings: SecurityFinding[],
  ): Promise<{ healthy: boolean; agentCount: number }> {
    let healthy = true;
    let agentCount = 0;

    try {
      // Read on-chain metrics in parallel
      const [agentCountRaw, listingCount, requestCount, oracleSnapshot] = await Promise.all([
        this.contracts.registry.getAgentCount().catch(() => 0n),
        this.contracts.marketplace.getListingCount().catch(() => 0n),
        this.contracts.marketplace.getRequestCount().catch(() => 0n),
        this.contracts.oracle.getLatestSnapshot().catch(() => null),
      ]);

      agentCount = Number(agentCountRaw);
      const listings = Number(listingCount);
      const requests = Number(requestCount);

      let oracleTimestamp = 0;
      let oracleGdp = 0;
      let escrowVolume = 0;
      let escrowSettled = 0;

      if (oracleSnapshot) {
        oracleTimestamp = Number(oracleSnapshot.timestamp) * 1000;
        oracleGdp = Number(ethers.formatEther(oracleSnapshot.gdp));
        escrowVolume = Number(ethers.formatEther(oracleSnapshot.totalEscrowVolume));
        escrowSettled = Number(ethers.formatEther(oracleSnapshot.totalSettled));
      }

      this.log(
        `Contract health: agents=${agentCount} | listings=${listings} | ` +
        `requests=${requests} | oracleAge=${oracleTimestamp > 0 ? Math.round((Date.now() - oracleTimestamp) / 1000) + "s" : "N/A"} | ` +
        `escrowVol=${escrowVolume.toFixed(4)}`,
      );

      // Store health snapshot
      const snapshot: ContractHealthSnapshot = {
        timestamp: Date.now(),
        agentCount,
        listingCount: listings,
        requestCount: requests,
        oracleTimestamp,
        oracleGdp,
        escrowVolume,
        escrowSettled,
      };
      this.healthSnapshots.push(snapshot);
      if (this.healthSnapshots.length > MAX_SNAPSHOT_HISTORY) {
        this.healthSnapshots.shift();
      }

      // Check 1: Agent count drop
      if (this.previousAgentCount !== null && this.previousAgentCount > 0) {
        const dropPercent = ((this.previousAgentCount - agentCount) / this.previousAgentCount) * 100;
        if (dropPercent >= AGENT_DROP_ALERT_PERCENT) {
          healthy = false;
          findings.push(this._createFinding(
            FindingSeverity.Critical,
            "registry",
            "Sudden drop in registered agents",
            `Agent count dropped from ${this.previousAgentCount} to ${agentCount} ` +
            `(${dropPercent.toFixed(1)}% decrease). This may indicate mass ` +
            `deregistration, a contract bug, or a coordinated attack.`,
            {
              previousCount: this.previousAgentCount,
              currentCount: agentCount,
              dropPercent: Math.round(dropPercent),
            },
          ));
        }
      }
      this.previousAgentCount = agentCount;

      // Check 2: Stale oracle data
      if (oracleTimestamp > 0) {
        const oracleAge = Date.now() - oracleTimestamp;
        if (oracleAge > ORACLE_STALENESS_MS) {
          healthy = false;
          findings.push(this._createFinding(
            FindingSeverity.Medium,
            "oracle",
            "Stale oracle data",
            `Economy oracle last updated ${Math.round(oracleAge / 1000)}s ago, ` +
            `exceeding the ${ORACLE_STALENESS_MS / 1000}s staleness threshold. ` +
            `Agents relying on oracle data may make decisions on outdated information.`,
            { oracleAgeSeconds: Math.round(oracleAge / 1000), threshold: ORACLE_STALENESS_MS / 1000 },
          ));
        }
      }

      // Check 3: Unusual escrow volume spike
      if (this.previousEscrowVolume !== null && this.previousEscrowVolume > 0) {
        const volumeChange = escrowVolume - this.previousEscrowVolume;
        const changePercent = (volumeChange / this.previousEscrowVolume) * 100;
        if (changePercent > 200) {
          findings.push(this._createFinding(
            FindingSeverity.High,
            "escrow",
            "Abnormal escrow volume spike",
            `Escrow volume increased by ${changePercent.toFixed(1)}% ` +
            `(${this.previousEscrowVolume.toFixed(4)} -> ${escrowVolume.toFixed(4)}). ` +
            `This could indicate wash trading or an exploit targeting the escrow contract.`,
            {
              previousVolume: this.previousEscrowVolume,
              currentVolume: escrowVolume,
              changePercent: Math.round(changePercent),
            },
          ));
        }
      }
      this.previousEscrowVolume = escrowVolume;

      // Check 4: Zero agent count when previously non-zero
      if (agentCount === 0 && this.internalCycleCount > 1) {
        healthy = false;
        findings.push(this._createFinding(
          FindingSeverity.Critical,
          "registry",
          "No registered agents detected",
          "The agent registry reports zero registered agents. This is a critical " +
          "state that may indicate a contract reset or catastrophic failure.",
          { agentCount: 0 },
        ));
      }
    } catch (err) {
      healthy = false;
      this.warn(`Contract health check failed: ${err instanceof Error ? err.message : err}`);
      findings.push(this._createFinding(
        FindingSeverity.High,
        "contracts",
        "Contract health check failure",
        `Unable to read on-chain state: ${err instanceof Error ? err.message : String(err)}. ` +
        `RPC node may be down or contracts may be inaccessible.`,
        { error: String(err instanceof Error ? err.message : err) },
      ));
    }

    return { healthy, agentCount };
  }

  // -------------------------------------------------------------------------
  // Treasury balance monitoring
  // -------------------------------------------------------------------------

  private async _checkTreasuryBalance(findings: SecurityFinding[]): Promise<string> {
    try {
      const balanceWei = await this.contracts.treasury.getBalance(this.wallet.address);
      const balanceEth = ethers.formatEther(balanceWei);

      this.log(`Treasury balance: ${balanceEth} ETH`);

      // Detect large unexpected withdrawals
      if (this.previousTreasuryBalance !== null) {
        const diff = this.previousTreasuryBalance - balanceWei;
        if (diff > 0n) {
          const diffEth = parseFloat(ethers.formatEther(diff));
          const prevEth = parseFloat(ethers.formatEther(this.previousTreasuryBalance));
          const dropPercent = prevEth > 0 ? (diffEth / prevEth) * 100 : 0;

          if (dropPercent > 50 && diffEth > 0.01) {
            findings.push(this._createFinding(
              FindingSeverity.High,
              "treasury",
              "Large treasury balance decrease",
              `Treasury balance dropped by ${diffEth.toFixed(6)} ETH ` +
              `(${dropPercent.toFixed(1)}%). Previous: ${prevEth.toFixed(6)} ETH, ` +
              `Current: ${balanceEth} ETH. Investigate for unauthorized withdrawals.`,
              {
                previousBalance: prevEth,
                currentBalance: parseFloat(balanceEth),
                dropPercent: Math.round(dropPercent),
              },
            ));
          }
        }
      }
      this.previousTreasuryBalance = balanceWei;

      return balanceEth;
    } catch (err) {
      this.warn(`Treasury balance check failed: ${err instanceof Error ? err.message : err}`);
      return "0";
    }
  }

  // -------------------------------------------------------------------------
  // Reputation manipulation detection
  // -------------------------------------------------------------------------

  private async _checkReputationManipulation(findings: SecurityFinding[]): Promise<void> {
    try {
      const topAgentsResult = await this.contracts.reputation.getTopAgents(10);
      const addresses: string[] = topAgentsResult[0] ?? [];
      const scores: bigint[] = topAgentsResult[1] ?? [];

      for (let i = 0; i < addresses.length; i++) {
        const addr = addresses[i];
        const score = Number(scores[i]);
        if (!addr || score === 0) continue;

        const history = this.reputationSnapshots.get(addr) ?? [];
        history.push(score);
        if (history.length > 10) {
          history.shift();
        }
        this.reputationSnapshots.set(addr, history);

        // Detect rapid reputation increase (possible manipulation)
        if (history.length >= 3) {
          const oldest = history[0];
          const newest = history[history.length - 1];
          const changePercent = oldest > 0 ? ((newest - oldest) / oldest) * 100 : 0;

          if (changePercent > 100 && newest > 50) {
            findings.push(this._createFinding(
              FindingSeverity.Medium,
              "reputation",
              "Rapid reputation score increase",
              `Agent ${addr.slice(0, 10)}... reputation increased by ` +
              `${changePercent.toFixed(1)}% (${oldest} -> ${newest}) over ` +
              `${history.length} check intervals. This may indicate ` +
              `self-dealing or sybil-based reputation farming.`,
              {
                agentAddress: addr,
                oldScore: oldest,
                newScore: newest,
                changePercent: Math.round(changePercent),
              },
            ));
          }
        }
      }

      this.log(`Reputation check: monitored ${addresses.length} top agents`);
    } catch (err) {
      this.warn(`Reputation check failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // -------------------------------------------------------------------------
  // Escrow activity analysis
  // -------------------------------------------------------------------------

  private _analyzeEscrowActivity(findings: SecurityFinding[]): void {
    if (this.recentSettlements.length === 0) return;

    // Check for repeated buyer-seller pairs (potential wash trading)
    const pairCounts = new Map<string, number>();
    for (const s of this.recentSettlements) {
      const key = `${s.buyer}:${s.seller}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }

    for (const [pair, count] of pairCounts) {
      if (count >= 5) {
        const [buyer, seller] = pair.split(":");
        findings.push(this._createFinding(
          FindingSeverity.Medium,
          "escrow",
          "Repeated escrow settlements between same parties",
          `Detected ${count} escrow settlements between buyer ` +
          `${buyer?.slice(0, 10)}... and seller ${seller?.slice(0, 10)}... ` +
          `in recent history. This pattern is consistent with wash trading ` +
          `or reputation farming.`,
          { buyer: buyer ?? "", seller: seller ?? "", settlementCount: count },
        ));
      }
    }

    // Check for rapid-fire settlements (bot-like behavior)
    if (this.recentSettlements.length > 20) {
      findings.push(this._createFinding(
        FindingSeverity.Low,
        "escrow",
        "High escrow settlement frequency",
        `${this.recentSettlements.length} escrow settlements observed in ` +
        `recent monitoring window. While not necessarily malicious, this ` +
        `rate warrants monitoring.`,
        { settlementCount: this.recentSettlements.length },
      ));
    }

    // Clear old settlements after analysis
    if (this.recentSettlements.length > 50) {
      this.recentSettlements = this.recentSettlements.slice(-25);
    }
  }

  // -------------------------------------------------------------------------
  // Token security scan processing
  // -------------------------------------------------------------------------

  private async _processPendingScans(findings: SecurityFinding[]): Promise<void> {
    if (this.pendingRequests.length === 0) {
      return;
    }

    const batch = this.pendingRequests.splice(0, MAX_REQUESTS_PER_CYCLE);
    this.log(`Processing ${batch.length} security scan request(s)...`);

    for (const req of batch) {
      const result = await this._scan(req.tokenAddress);
      this.scansCompleted++;

      this.log(
        `Scan #${this.scansCompleted}: ${req.tokenAddress.slice(0, 10)}... | ` +
        `risk=${result.riskScore} | honeypot=${result.isHoneypot} | ` +
        `holders=${result.holders}`,
      );

      // Create findings from scan results
      if (result.isHoneypot) {
        findings.push(this._createFinding(
          FindingSeverity.Critical,
          "token_scan",
          "Honeypot token detected",
          `Token ${req.tokenAddress.slice(0, 10)}... identified as a honeypot. ` +
          `Risk score: ${result.riskScore}. Holders: ${result.holders}. ` +
          `Warnings: ${result.warnings.join(", ") || "none"}.`,
          {
            tokenAddress: req.tokenAddress,
            riskScore: result.riskScore,
            isHoneypot: true,
            holders: result.holders,
          },
        ));
      } else if (result.riskScore > 70) {
        findings.push(this._createFinding(
          FindingSeverity.High,
          "token_scan",
          "High-risk token detected",
          `Token ${req.tokenAddress.slice(0, 10)}... has risk score ${result.riskScore}. ` +
          `Proxy: ${result.hasProxyContract}, OwnerCanMint: ${result.ownerCanMint}. ` +
          `Warnings: ${result.warnings.join(", ") || "none"}.`,
          {
            tokenAddress: req.tokenAddress,
            riskScore: result.riskScore,
            hasProxy: result.hasProxyContract,
            ownerCanMint: result.ownerCanMint,
            holders: result.holders,
          },
        ));
      } else if (result.riskScore > 40) {
        findings.push(this._createFinding(
          FindingSeverity.Medium,
          "token_scan",
          "Moderate-risk token flagged",
          `Token ${req.tokenAddress.slice(0, 10)}... has risk score ${result.riskScore}. ` +
          `Holders: ${result.holders}. Proxy: ${result.hasProxyContract}.`,
          {
            tokenAddress: req.tokenAddress,
            riskScore: result.riskScore,
            holders: result.holders,
          },
        ));
      }

      // Broadcast scan result
      await globalBus.emit("security:result", result);

      // Complete or dispute on-chain marketplace request
      if (req.requestId !== undefined) {
        await this._settleMarketplaceRequest(req, result);
      }
    }
  }

  private async _scan(tokenAddress: string): Promise<SecurityScanResult> {
    const cached = this.scanCache.get(tokenAddress);
    if (cached && cached.expires > Date.now()) {
      return cached.result;
    }

    const result = await this.okx.securityScan(tokenAddress);
    this.scanCache.set(tokenAddress, {
      result,
      expires: Date.now() + this.CACHE_TTL_MS,
    });

    return result;
  }

  private async _settleMarketplaceRequest(
    req: SecurityRequest,
    result: SecurityScanResult,
  ): Promise<void> {
    try {
      const proofHash = ethers.keccak256(
        ethers.toUtf8Bytes(JSON.stringify(result)),
      );

      if (result.riskScore > 50 || result.isHoneypot) {
        this.log(
          `High risk detected (score=${result.riskScore}, honeypot=${result.isHoneypot}), ` +
          `disputing request ${req.requestId}`,
        );
        const tx = await this.contracts.marketplace.disputeService(req.requestId);
        await tx.wait();
        this.log(`Disputed marketplace request ${req.requestId} | tx=${tx.hash}`);
      } else {
        const tx = await this.contracts.marketplace.completeService(req.requestId, proofHash);
        await tx.wait();
        this.log(`Completed marketplace request ${req.requestId} | tx=${tx.hash}`);
      }
    } catch (err) {
      this.warn(
        `Failed to complete/dispute request ${req.requestId}: ` +
        `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Service listing
  // -------------------------------------------------------------------------

  private async _listSecurityService(): Promise<void> {
    try {
      const serviceType = this.serviceTypeHash("SECURITY_AUDIT");
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
            this.log(`Listed SECURITY_AUDIT service, listingId=${this.currentListingId}`);
          }
        } catch {
          // skip non-matching logs
        }
      }
    } catch (err) {
      this.warn(`Failed to list service: ${err instanceof Error ? err.message : err}`);
    }
  }

  // -------------------------------------------------------------------------
  // Risk score computation
  // -------------------------------------------------------------------------

  private _computeRiskScore(
    findings: SecurityFinding[],
    gasStatus: GasStatus,
    contractsHealthy: boolean,
  ): number {
    let score = 0;

    // Weight findings by severity
    for (const f of findings) {
      switch (f.severity) {
        case FindingSeverity.Critical: score += 25; break;
        case FindingSeverity.High:     score += 15; break;
        case FindingSeverity.Medium:   score += 8;  break;
        case FindingSeverity.Low:      score += 3;  break;
        case FindingSeverity.Info:     score += 1;  break;
      }
    }

    // Gas status contribution
    if (gasStatus.alertLevel === "critical") {
      score += 10;
    } else if (gasStatus.alertLevel === "elevated") {
      score += 5;
    }

    // Contract health contribution
    if (!contractsHealthy) {
      score += 15;
    }

    // Clamp to 0-100
    return Math.min(100, Math.max(0, score));
  }

  private _computeRiskTrend(): "increasing" | "decreasing" | "stable" {
    if (this.reportHistory.length < 3) return "stable";

    const recent = this.reportHistory.slice(-3);
    const scores = recent.map((r) => r.riskScore);
    const first = scores[0];
    const last = scores[scores.length - 1];
    const diff = last - first;

    if (diff > 10) return "increasing";
    if (diff < -10) return "decreasing";
    return "stable";
  }

  // -------------------------------------------------------------------------
  // Finding factory
  // -------------------------------------------------------------------------

  private _createFinding(
    severity: FindingSeverity,
    category: string,
    title: string,
    description: string,
    metadata: Record<string, string | number | boolean>,
  ): SecurityFinding {
    this.findingCounter++;
    return {
      id: `SEC-${String(this.findingCounter).padStart(5, "0")}`,
      timestamp: Date.now(),
      severity,
      category,
      title,
      description,
      metadata,
    };
  }
}
