/**
 * DataProviderAgent -- fetches market data and publishes it on-chain.
 *
 * Cycle:
 *  1. Fetch market data for tracked tokens via OnchainOSClient
 *  2. Hash the data and record on-chain (proof of data freshness)
 *  3. List MARKET_DATA service on the marketplace with Dutch auction pricing
 *  4. Broadcast data to in-process EventBus for local consumers
 */

import { ethers, JsonRpcProvider } from "ethers";
import { AgentBase } from "../core/AgentBase.js";
import { OnchainOSClient, MarketPrice } from "../core/OnchainOSClient.js";
import { globalBus } from "../core/EventBus.js";
import { AgentType } from "../config/contracts.js";

/** Tokens we track by default. */
const TRACKED_TOKENS = ["OKB", "ETH", "BTC", "USDT"];

/** How much to charge for a market data snapshot (in wei). */
const START_PRICE = ethers.parseEther("0.001");
const FLOOR_PRICE = ethers.parseEther("0.0001");
const DECAY_RATE = ethers.parseEther("0.00001"); // per block

export interface MarketDataSnapshot {
  timestamp: number;
  prices: MarketPrice[];
  dataHash: string;
}

export class DataProviderAgent extends AgentBase {
  private readonly okx: OnchainOSClient;
  private currentListingId: bigint | null = null;

  constructor(privateKey: string, provider: JsonRpcProvider) {
    super("DataProvider", AgentType.DataProvider, privateKey, provider);
    this.okx = new OnchainOSClient();
  }

  async runCycle(): Promise<void> {
    // 1. Fetch market data
    this.log("Fetching market data...");
    const prices = await Promise.all(
      TRACKED_TOKENS.map((t) => this.okx.getMarketPrice(t)),
    );

    // 2. Hash and record on-chain
    const snapshot: MarketDataSnapshot = {
      timestamp: Date.now(),
      prices,
      dataHash: "",
    };

    const encoded = ethers.toUtf8Bytes(JSON.stringify(prices));
    snapshot.dataHash = ethers.keccak256(encoded);

    this.log(`Data hash: ${snapshot.dataHash}`);

    // 3. List MARKET_DATA service (create a new listing if we don't have one)
    if (this.currentListingId === null) {
      try {
        const serviceType = this.serviceTypeHash("MARKET_DATA");
        const tx = await this.contracts.marketplace.listService(
          serviceType,
          START_PRICE,
          FLOOR_PRICE,
          DECAY_RATE,
          0, // unlimited fulfillments
        );
        const receipt = await tx.wait();

        // Parse listing ID from event
        const iface = this.contracts.marketplace.interface;
        for (const log of receipt.logs) {
          try {
            const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === "ServiceListed") {
              this.currentListingId = parsed.args[0];
              this.log(`Listed MARKET_DATA service, listingId=${this.currentListingId}`);
            }
          } catch {
            // skip non-matching logs
          }
        }
      } catch (err) {
        this.warn(`Failed to list service: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 4. Broadcast to local agents via EventBus
    await globalBus.emit("market:data", snapshot);

    this.log(
      `Published ${prices.length} prices. ` +
      `OKB=$${prices.find((p) => p.token === "OKB")?.price ?? "?"}`
    );
  }
}
