/**
 * SecurityAuditorAgent -- on-demand token security scanning service.
 *
 * Cycle:
 *  1. Listen for SECURITY_AUDIT requests (via EventBus and marketplace)
 *  2. Run security scan via OnchainOSClient
 *  3. Return risk score
 *  4. Complete the service on the marketplace
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient, SecurityScanResult } from "../core/OnchainOSClient.js";
import { globalBus } from "../core/EventBus.js";
import { AgentType } from "../config/contracts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SecurityRequest {
  tokenAddress: string;
  requester: string;
  requestId?: bigint; // marketplace request ID, if on-chain
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const START_PRICE = ethers.parseEther("0.0005");
const FLOOR_PRICE = ethers.parseEther("0.00005");
const DECAY_RATE = ethers.parseEther("0.000005");

export class SecurityAuditorAgent extends AgentBase {
  private readonly okx: OnchainOSClient;
  private currentListingId: bigint | null = null;
  private pendingRequests: SecurityRequest[] = [];
  private scansCompleted = 0;

  /** Cache scans to avoid redundant API calls. TTL = 5 minutes. */
  private scanCache = new Map<string, { result: SecurityScanResult; expires: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("SecurityAuditor", AgentType.SecurityAuditor, privateKey, provider);
    this.okx = new OnchainOSClient();

    // Listen for local security scan requests
    globalBus.on<SecurityRequest>("security:request", (req) => {
      this.pendingRequests.push(req);
    });
  }

  async runCycle(): Promise<void> {
    // 1. List SECURITY_AUDIT service if not yet listed
    if (this.currentListingId === null) {
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
          } catch { /* skip */ }
        }
      } catch (err) {
        this.warn(`Failed to list service: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 2. Process pending security requests
    if (this.pendingRequests.length === 0) {
      this.log("No pending security requests");
      return;
    }

    const batch = this.pendingRequests.splice(0, 5); // process up to 5 per cycle
    this.log(`Processing ${batch.length} security scan request(s)...`);

    for (const req of batch) {
      const result = await this._scan(req.tokenAddress);

      this.scansCompleted++;
      this.log(
        `Scan #${this.scansCompleted}: ${req.tokenAddress.slice(0, 10)}... | ` +
        `risk=${result.riskScore} | honeypot=${result.isHoneypot} | ` +
        `holders=${result.holders}`
      );

      // 3. Broadcast result
      await globalBus.emit("security:result", result);

      // 4. Complete on-chain service if there's a marketplace request
      if (req.requestId !== undefined) {
        try {
          const proofHash = ethers.keccak256(
            ethers.toUtf8Bytes(JSON.stringify(result)),
          );
          const tx = await this.contracts.marketplace.completeService(
            req.requestId,
            proofHash,
          );
          await tx.wait();
          this.log(`Completed marketplace request ${req.requestId}`);
        } catch (err) {
          this.warn(`Failed to complete request: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async _scan(tokenAddress: string): Promise<SecurityScanResult> {
    // Check cache
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
}
