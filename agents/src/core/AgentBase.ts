/**
 * AgentBase -- abstract base class for all SYMBIOSIS agents.
 *
 * Handles wallet setup, contract instances, lifecycle (start/stop),
 * and per-cycle error isolation so one bad cycle never kills the agent.
 */

import { ethers, JsonRpcProvider, Wallet, Contract } from "ethers";
import {
  ADDRESSES,
  AGENT_REGISTRY_ABI,
  SERVICE_MARKETPLACE_ABI,
  REPUTATION_ENGINE_ABI,
  ESCROW_SETTLEMENT_ABI,
  AGENT_TREASURY_ABI,
  ECONOMY_ORACLE_ABI,
  GOVERNANCE_REGISTRY_ABI,
  AgentType,
} from "../config/contracts.js";

export interface AgentContracts {
  registry: Contract;
  marketplace: Contract;
  reputation: Contract;
  escrow: Contract;
  treasury: Contract;
  oracle: Contract;
  governance: Contract;
}

export abstract class AgentBase {
  // Identity
  readonly name: string;
  readonly agentType: AgentType;

  // Ethers primitives
  readonly provider: JsonRpcProvider;
  readonly wallet: Wallet;

  // Contract handles (connected to wallet so they can send tx)
  readonly contracts: AgentContracts;

  // Lifecycle state
  private _running = false;
  private _intervalHandle: ReturnType<typeof setInterval> | null = null;
  private _cycleCount = 0;
  private _lastCycleTime = 0;

  constructor(
    name: string,
    agentType: AgentType,
    privateKey: string,
    provider: JsonRpcProvider,
  ) {
    this.name = name;
    this.agentType = agentType;
    this.provider = provider;
    this.wallet = new Wallet(privateKey, provider);

    // Instantiate contract handles once
    this.contracts = {
      registry: new Contract(ADDRESSES.AgentRegistry, AGENT_REGISTRY_ABI, this.wallet),
      marketplace: new Contract(ADDRESSES.ServiceMarketplace, SERVICE_MARKETPLACE_ABI, this.wallet),
      reputation: new Contract(ADDRESSES.ReputationEngine, REPUTATION_ENGINE_ABI, this.wallet),
      escrow: new Contract(ADDRESSES.EscrowSettlement, ESCROW_SETTLEMENT_ABI, this.wallet),
      treasury: new Contract(ADDRESSES.AgentTreasury, AGENT_TREASURY_ABI, this.wallet),
      oracle: new Contract(ADDRESSES.EconomyOracle, ECONOMY_ORACLE_ABI, this.wallet),
      governance: new Contract(ADDRESSES.GovernanceRegistry, GOVERNANCE_REGISTRY_ABI, this.wallet),
    };
  }

  // -----------------------------------------------------------------------
  // Abstract -- each agent implements its own cycle logic
  // -----------------------------------------------------------------------

  abstract runCycle(): Promise<void>;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start the agent loop at the given interval (ms). */
  start(intervalMs: number): void {
    if (this._running) {
      this.log("Already running, ignoring start()");
      return;
    }

    this._running = true;
    this.log(`Starting with ${intervalMs}ms cycle interval`);

    // Run first cycle immediately, then on interval
    this._executeCycle();
    this._intervalHandle = setInterval(() => this._executeCycle(), intervalMs);
  }

  /** Gracefully stop the agent loop. */
  stop(): void {
    if (!this._running) return;
    this._running = false;

    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }

    this.log(`Stopped after ${this._cycleCount} cycles`);
  }

  get isRunning(): boolean {
    return this._running;
  }

  get cycleCount(): number {
    return this._cycleCount;
  }

  get lastCycleTime(): number {
    return this._lastCycleTime;
  }

  // -----------------------------------------------------------------------
  // On-chain registration helper
  // -----------------------------------------------------------------------

  /** Register this agent in the AgentRegistry (call once on first boot). */
  async registerOnChain(metadataURI: string, stakeEther: string = "0.01"): Promise<void> {
    const already = await this.contracts.registry.isRegistered(this.wallet.address);
    if (already) {
      this.log("Already registered on-chain");
      return;
    }

    this.log(`Registering on-chain as ${AgentType[this.agentType]}...`);
    const tx = await this.contracts.registry.registerAgent(
      this.agentType,
      metadataURI,
      { value: ethers.parseEther(stakeEther) },
    );
    await tx.wait();
    this.log(`Registered. tx=${tx.hash}`);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Compute the keccak256 service-type hash matching Solidity's keccak256("..."). */
  protected serviceTypeHash(name: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(name));
  }

  /** Log with agent name prefix for easy filtering. */
  protected log(message: string): void {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${this.name}] ${message}`);
  }

  /** Log a warning. */
  protected warn(message: string): void {
    const ts = new Date().toISOString();
    console.warn(`[${ts}] [${this.name}] WARN: ${message}`);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async _executeCycle(): Promise<void> {
    if (!this._running) return;

    const start = Date.now();
    try {
      await this.runCycle();
      this._cycleCount++;
      this._lastCycleTime = Date.now() - start;
      this.log(`Cycle #${this._cycleCount} completed in ${this._lastCycleTime}ms`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.warn(`Cycle failed: ${msg}`);
      // Continue running -- never let one bad cycle kill the agent
    }
  }
}
