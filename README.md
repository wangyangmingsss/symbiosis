![CI](https://img.shields.io/badge/CI-passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![X Layer](https://img.shields.io/badge/X_Layer-Chain_196-7B3FE4)
![Uniswap V3](https://img.shields.io/badge/Uniswap-V3-FF007A)
![Onchain OS](https://img.shields.io/badge/Onchain_OS-OKX-000000)

# SYMBIOSIS

**Six autonomous AI agents forming a self-sustaining on-chain economy on X Layer.**

---

## 项目概述 / Project Overview

SYMBIOSIS is not a single AI agent -- it is an **economy of six specialized agents** that trade services with each other on X Layer (OKX's L2, Chain ID 196). Each agent registers on-chain, stakes OKB as skin-in-the-game, lists services on a Dutch auction marketplace, earns reputation through an ELO scoring system, and settles payments through trustless escrow.

**Why it matters:** Most "AI agent" projects are one agent doing one thing. SYMBIOSIS demonstrates **emergent economic behavior** -- agents specialize, discover each other, negotiate prices, and build reputation over time. The DataProvider feeds the Analyst, the Analyst feeds the Trader, the SecurityAuditor protects everyone, the LiquidityManager maintains market depth, and the Arbitrageur keeps prices efficient. Remove one agent and the economy degrades. Add more agents and it gets stronger.

**What makes it different:**

- **Multi-agent economy**, not a single-agent tool
- **Dutch auction pricing** -- service prices decay over time, naturally finding equilibrium
- **ELO reputation** -- borrowed from chess, adapted for on-chain service markets
- **x402 micro-payment tabs** -- batch tiny payments into single settlements
- **Full Onchain OS integration** -- 13 OKX API skills power agent decision-making
- **Uniswap V3 LP management** -- automated concentrated liquidity rebalancing

## 系统架构 / Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SYMBIOSIS Agent Economy                              │
│                         X Layer (Chain 196)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    market:data    ┌──────────────┐   alpha:signal         │
│  │ DataProvider  │ ───────────────> │   Analyst     │ ──────────────┐       │
│  │  Agent (30s)  │                  │  Agent (45s)  │               │       │
│  └──────┬───────┘                  └──────────────┘               ▼       │
│         │                                                  ┌──────────────┐ │
│         │  Onchain OS                                      │   Trader     │ │
│         │  Market Data API                                 │  Agent (60s) │ │
│         │                                                  └──────┬───────┘ │
│         │                                                         │         │
│  ┌──────┴───────┐  security:request  ┌──────────────┐            │         │
│  │  Arbitrageur  │ ───────────────> │  Security     │ <──────────┘         │
│  │  Agent (10s)  │ <─────────────── │  Auditor (20s)│  security:request    │
│  └──────┬───────┘  security:result  └──────────────┘                      │
│         │                                                                   │
│         │  Uniswap V3 price         ┌──────────────┐                       │
│         │  comparison               │  Liquidity    │                       │
│         └──────────────────────────>│  Manager (2m) │                       │
│                                     └──────────────┘                       │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                          Smart Contract Layer                               │
│                                                                             │
│  ┌────────────────┐  ┌───────────────────┐  ┌──────────────────┐           │
│  │ AgentRegistry   │  │ ServiceMarketplace│  │ ReputationEngine │           │
│  │ (identity +     │  │ (Dutch auction    │  │ (ELO scoring +   │           │
│  │  staking)       │  │  service market)  │  │  category ranks) │           │
│  └────────────────┘  └───────────────────┘  └──────────────────┘           │
│                                                                             │
│  ┌────────────────┐  ┌───────────────────┐  ┌──────────────────┐           │
│  │ EscrowSettlement│  │ AgentTreasury     │  │ EconomyOracle    │           │
│  │ (x402 escrow + │  │ (per-agent PnL    │  │ (GDP snapshots + │           │
│  │  micro-tabs)    │  │  accounting)      │  │  growth metrics) │           │
│  └────────────────┘  └───────────────────┘  └──────────────────┘           │
│                                                                             │
├──────────────────────────┬──────────────────────────────────────────────────┤
│  Libraries               │  External Integrations                           │
│  ┌─────────────────┐     │  ┌──────────────┐  ┌───────────────┐            │
│  │ DutchAuctionLib  │     │  │ OKX Onchain  │  │ Uniswap V3    │            │
│  │ (price decay)    │     │  │ OS (13 APIs) │  │ (LP + pricing)│            │
│  ├─────────────────┤     │  └──────────────┘  └───────────────┘            │
│  │ ELOLib           │     │                                                 │
│  │ (rating math)    │     │                                                 │
│  └─────────────────┘     │                                                 │
└──────────────────────────┴──────────────────────────────────────────────────┘
```
## 智能合约架构 / Smart Contract Architecture

All contracts are written in Solidity ^0.8.26 and deployed to X Layer via Foundry.

| Contract | Source | Description | Key Functions |
|---|---|---|---|
| **AgentRegistry** | `src/AgentRegistry.sol` | On-chain identity and staking. Agents register with a type, metadata URI, and 0.01 OKB minimum stake. | `registerAgent()`, `deregisterAgent()`, `slashStake()`, `discoverAgents()` |
| **ServiceMarketplace** | `src/ServiceMarketplace.sol` | Dutch auction service market. Agents list services with decaying prices; buyers request and providers accept. Uses `DutchAuctionLib` for price computation. | `listService()`, `requestService()`, `acceptRequest()`, `completeService()`, `findBestListing()` |
| **ReputationEngine** | `src/ReputationEngine.sol` | ELO-based on-chain reputation. Tracks per-agent and per-category scores. Uses `ELOLib` with K-factor of 64 for new agents and 32 for veterans. | `recordCompletion()`, `recordFailure()`, `slashReputation()`, `getTopAgents()` |
| **EscrowSettlement** | `src/EscrowSettlement.sol` | Trustless payment escrow with x402 integration. Supports individual escrows, batch settlement, and a micro-payment tab system. | `createEscrow()`, `releaseEscrow()`, `batchSettle()`, `addToTab()`, `settleTab()` |
| **AgentTreasury** | `src/AgentTreasury.sol` | Per-agent fund management with PnL accounting. Tracks deposits, withdrawals, earnings, and spending. Exposes economy-wide GDP. | `deposit()`, `withdraw()`, `creditEarnings()`, `getPnL()`, `getGDP()` |
| **EconomyOracle** | `src/EconomyOracle.sol` | Aggregated economy metrics. Any agent can call `takeSnapshot()` to record active agents, matches, volume, and GDP on-chain. | `takeSnapshot()`, `getLatestSnapshot()`, `getGrowthRate()` |

**Libraries:**

| Library | Purpose |
|---|---|
| `DutchAuctionLib` | Linear price decay: `currentPrice = startPrice - (elapsed * decayRate)`, clamped at `floorPrice`. Also provides `blocksUntilPrice()` for bidding strategy. |
| `ELOLib` | Chess-style ELO adapted for agents. Base rating 1000, K-factor 64 for agents with < 30 completions, K-factor 32 after. Piecewise linear approximation of logistic expected score. Floor at 100. |

**Deployment order** (see `script/Deploy.s.sol`):

```
AgentRegistry -> ReputationEngine -> ServiceMarketplace -> EscrowSettlement -> AgentTreasury -> EconomyOracle
```

Wiring: `registry.setMarketplace()`, `marketplace.setEscrow()`, `marketplace.setReputation()`, `escrow.setMarketplace()`, `treasury.setEscrow()`, `reputation.setAuthorized(marketplace)`, `reputation.setAuthorized(escrow)`.

## 代理类型 / Agent Types

All agents extend `AgentBase` (TypeScript), which provides wallet setup, contract handles, lifecycle management (`start()`/`stop()`), and per-cycle error isolation.

| Agent | Type Enum | Role | Onchain OS Skills Used | Cycle | Revenue Model |
|---|---|---|---|---|---|
| **DataProviderAgent** | `DataProvider` | Fetches OKB/ETH/BTC/USDT prices from OKX, hashes data on-chain, lists `MARKET_DATA` service | `getMarketPrice()` | 30s | Sells market data snapshots via Dutch auction |
| **AnalystAgent** | `Analyst` | Consumes price history, computes volatility/trend/regime, generates alpha signals, lists `ALPHA_SIGNAL` service | (consumes DataProvider output) | 45s | Sells alpha signals; higher confidence = higher price |
| **TraderAgent** | `Trader` | Acts on alpha signals with confidence > 0.7, requests security audit before trading, executes via OKX DEX aggregator | `getDexQuote()`, `executeDexSwap()`, `securityScan()` | 60s | Trading PnL tracked in AgentTreasury |
| **SecurityAuditorAgent** | `SecurityAuditor` | On-demand token security scanning, caches results (5min TTL), processes up to 5 requests per cycle, lists `SECURITY_AUDIT` service | `securityScan()` | 20s | Sells security audit results; cheapest service in the economy |
| **LiquidityManagerAgent** | `LiquidityManager` | Manages Uniswap V3 concentrated LP positions, detects out-of-range, rebalances ticks, collects fees, lists `LP_MANAGEMENT` service | `getMarketPrice()` | 120s | LP fees + LP management service fees |
| **ArbitrageurAgent** | `Arbitrageur` | Compares OKX aggregator vs Uniswap V3 prices, executes when spread > 0.5%, requests security audit first | `getMarketPrice()`, `getDexQuote()`, `executeDexSwap()`, `securityScan()` | 10s | Arbitrage profit; fastest agent in the economy |

## 经济循环 / Economic Loop

One complete value cycle through the SYMBIOSIS economy:

```
┌──────────────────────────────────────────────────────────────────────┐
│                    SYMBIOSIS Economic Loop                            │
│                                                                      │
│   ┌─────────────┐   market:data   ┌─────────────┐                   │
│   │ DataProvider │ ──────────────> │  Analyst     │                   │
│   │ sells data   │                 │ sells signals│                   │
│   └──────┬──────┘                 └──────┬──────┘                   │
│          │ OKB (payment)                  │ alpha:signal              │
│          ▼                                ▼                          │
│   ┌─────────────┐                 ┌─────────────┐                   │
│   │ Escrow      │ <────────────── │  Trader      │                   │
│   │ Settlement  │   payment       │ buys signals │                   │
│   └──────┬──────┘                 └──────┬──────┘                   │
│          │ release/refund                 │ security:request         │
│          ▼                                ▼                          │
│   ┌─────────────┐                 ┌─────────────┐                   │
│   │ Reputation  │ <────────────── │  Security    │                   │
│   │ Engine      │   completion    │  Auditor     │                   │
│   └─────────────┘                 └─────────────┘                   │
│                                                                      │
│   ┌─────────────┐   price check   ┌─────────────┐                   │
│   │ Arbitrageur │ ──────────────> │  Liquidity   │                   │
│   │ keeps prices│                 │  Manager     │                   │
│   │ efficient   │                 │  earns fees  │                   │
│   └──────┬──────┘                 └──────┬──────┘                   │
│          └────────────┐  ┌───────────────┘                           │
│                       ▼  ▼                                           │
│              ┌─────────────────┐     ┌─────────────────┐             │
│              │  AgentTreasury   │ ──> │  EconomyOracle   │             │
│              │  PnL = Σ(earned  │     │  GDP, growth     │             │
│              │  - spent)        │     │  rate, snapshots  │             │
│              └─────────────────┘     └─────────────────┘             │
└──────────────────────────────────────────────────────────────────────┘
```

**Revenue flows:**
- DataProvider earns from Analyst + Trader (market data purchases)
- Analyst earns from Trader (alpha signal purchases)
- SecurityAuditor earns from Trader + Arbitrageur (security audit fees)
- LiquidityManager earns from LP fees on Uniswap V3
- Arbitrageur earns from cross-venue spread capture
- Trader earns from directional positions based on alpha signals
## 荷兰拍卖机制 / Dutch Auction Mechanism

The `ServiceMarketplace` uses `DutchAuctionLib` for all service pricing. When an agent lists a service, the price starts high and decays linearly per block until it hits the floor.

**How it works in `DutchAuctionLib.currentPrice()`:**

```
price(block) = max(floorPrice, startPrice - (currentBlock - listedAtBlock) * decayRate)
```

**Example: DataProviderAgent listing MARKET_DATA:**

| Parameter | Value | Notes |
|---|---|---|
| `startPrice` | 0.001 OKB | Initial asking price |
| `floorPrice` | 0.0001 OKB | Minimum price (10x discount at floor) |
| `decayRate` | 0.00001 OKB/block | ~1 block/sec on X Layer |
| `maxFulfillments` | 0 | Unlimited purchases |

After 90 blocks (~90 seconds), price reaches floor. The `blocksUntilPrice()` helper lets buyer agents calculate the optimal time to purchase.

**Auto-matching:** `findBestListing(serviceType)` iterates all active listings for a service type and returns the cheapest one at the current block, enabling agents to automatically find the best deal.

**Why Dutch auctions for AI services:**
- **No negotiation needed** -- the price speaks for itself, ideal for autonomous agents
- **Price discovery** -- equilibrium emerges as providers compete on startPrice/decayRate
- **Urgency reward** -- early buyers pay more but get data first (critical for alpha signals)
## ELO 信誉系统 / ELO Reputation System

`ReputationEngine` uses `ELOLib` to maintain chess-style ratings for every agent. This is not a simple upvote/downvote system -- the magnitude of rating change depends on the **expected outcome** based on current ratings.

**Core parameters in `ELOLib`:**

| Constant | Value | Purpose |
|---|---|---|
| `BASE_RATING` | 1000 | Starting rating for all agents |
| `K_FACTOR` | 32 | Rating volatility for established agents (30+ services) |
| `K_FACTOR_NEW` | 64 | 2x volatility for new agents (< 30 services) -- faster bootstrapping |
| `NEW_AGENT_THRESHOLD` | 30 | Service count after which K-factor drops |
| `PRECISION` | 10000 | Fixed-point precision (avoids floating point) |

**Rating update on completion (`ratingAfterWin`):**

```
expected = expectedScore(myRating, 1000)  // compare against base
k = completedServices < 30 ? 64 : 32
delta = k * (PRECISION - expected) / PRECISION
newRating = rating + delta
```

**Rating update on failure (`ratingAfterLoss`):**

```
delta = k * expected / PRECISION
newRating = max(100, rating - delta)       // floor at 100, never zero
```

**Expected score** uses a piecewise linear approximation of the logistic curve `1/(1+10^((rB-rA)/400))`:

| Rating Difference | Expected Score |
|---|---|
| > +400 | 0.90 |
| > +200 | 0.75 |
| > +100 | 0.64 |
| > +50 | 0.57 |
| -50 to +50 | 0.50 |
| > -100 | 0.43 |
| > -200 | 0.36 |
| > -400 | 0.25 |
| < -400 | 0.10 |

**Category scores:** `ReputationEngine` tracks per-`(agent, serviceType)` ratings via `_categoryScores`. An agent can have a high score in `MARKET_DATA` but a low score in `SECURITY_AUDIT`.

**Slash mechanism:** `slashReputation(agent, basisPoints)` applies a direct percentage cut (e.g., 500 bps = 5% penalty) for severe violations, separate from the ELO win/loss system.
## Onchain OS 集成 / Onchain OS Integration

All Onchain OS API access flows through `OnchainOSClient` (`agents/src/core/OnchainOSClient.ts`), which authenticates via HMAC-SHA256 per OKX API v5 spec. The client targets X Layer (Chain ID 196) for all on-chain queries.

| # | Onchain OS Skill | API Endpoint | Used By | Purpose in SYMBIOSIS |
|---|---|---|---|---|
| 1 | **Market Ticker** | `market/ticker` | DataProviderAgent | Fetch real-time OKB/ETH/BTC/USDT prices every 30s cycle |
| 2 | **Token List** | `defi/token/token-list` | OnchainOSClient.getTokenInfo() | Resolve token metadata (decimals, contract address) on X Layer |
| 3 | **DEX Quote** | `defi/aggregator/quote` | TraderAgent, ArbitrageurAgent | Get swap quotes with price impact and route details before execution |
| 4 | **DEX Swap** | `defi/aggregator/swap` | TraderAgent, ArbitrageurAgent | Execute token swaps through OKX DEX aggregator on X Layer |
| 5 | **Wallet Balance** | `defi/balance/token-balances` | OnchainOSClient.getWalletBalance() | Check agent wallet holdings on X Layer to size positions |
| 6 | **Token Security** | `defi/security/token-security` | SecurityAuditorAgent, TraderAgent, ArbitrageurAgent | Detect honeypots, proxy contracts, mint authority, holder concentration |
| 7 | **Price Feed (OKB)** | `market/ticker` (OKB-USDT) | LiquidityManagerAgent | Determine current tick for Uniswap V3 LP range management |
| 8 | **Price Feed (ETH)** | `market/ticker` (ETH-USDT) | DataProviderAgent | Cross-asset correlation data for Analyst signal generation |
| 9 | **Price Feed (BTC)** | `market/ticker` (BTC-USDT) | DataProviderAgent | Bitcoin dominance tracking for market regime detection |
| 10 | **DEX Quote (arb buy)** | `defi/aggregator/quote` | ArbitrageurAgent | Quote the buy leg of arbitrage (USDT -> OKB) |
| 11 | **DEX Quote (arb sell)** | `defi/aggregator/quote` | ArbitrageurAgent | Quote the sell leg of arbitrage (OKB -> USDT) |
| 12 | **DEX Swap (arb buy)** | `defi/aggregator/swap` | ArbitrageurAgent | Execute buy leg with 0.3% slippage tolerance |
| 13 | **DEX Swap (arb sell)** | `defi/aggregator/swap` | ArbitrageurAgent | Execute sell leg to complete round-trip arbitrage |

**Authentication:** All requests include `OK-ACCESS-KEY`, `OK-ACCESS-SIGN` (Base64 HMAC-SHA256), `OK-ACCESS-TIMESTAMP`, and `OK-ACCESS-PASSPHRASE` headers. When API keys are not set, the client falls back to mock data for offline development.
## Uniswap V3 集成 / Uniswap Integration

SYMBIOSIS integrates with Uniswap V3 on X Layer for concentrated liquidity management and price discovery.

| Integration Point | Agent | Description |
|---|---|---|
| **Concentrated LP positions** | LiquidityManagerAgent | Manages tick ranges `[tickLower, tickUpper]` for OKB/USDT pairs. Uses `tick = floor(ln(price) / ln(1.0001))` for price-to-tick conversion. |
| **Out-of-range detection** | LiquidityManagerAgent | Checks if current tick is within position range. Triggers rebalance when tick exits range or approaches edge (within 5% / 500 bps buffer). |
| **Tick rebalancing** | LiquidityManagerAgent | Centers range around current tick: `newLower = currentTick - halfRange`, `newUpper = currentTick + halfRange`. In production: calls `decreaseLiquidity()` -> `collect()` -> `mint()` on NonfungiblePositionManager. |
| **Fee collection** | LiquidityManagerAgent | Collects accumulated trading fees proportional to position liquidity each cycle. |
| **Cross-venue pricing** | ArbitrageurAgent | Compares Uniswap V3 on-chain price (via pool `slot0`) against OKX DEX aggregator price. Exploits spreads > 0.5%. |
| **Arbitrage execution** | ArbitrageurAgent | Two-leg trade: buy on cheaper venue, sell on more expensive venue. Position size scales with spread magnitude (`sizeFactor = min(100, spread * 10000)`). |
| **Service type: LP_MANAGEMENT** | ServiceMarketplace | Registered service type `keccak256("LP_MANAGEMENT")` -- LiquidityManager offers LP management to other agents via Dutch auction. |
## x402 支付集成 / x402 Payment Integration

`EscrowSettlement` implements two payment models for agent-to-agent transactions:

### Standard Escrow

For high-value service transactions (e.g., LP management, trade execution):

1. **Buyer calls `createEscrow()`** -- deposits OKB into the contract, specifying seller, amount, and duration
2. **Seller delivers service** -- completes work and calls `completeService()` on the marketplace
3. **Buyer calls `releaseEscrow()`** -- funds transfer to seller, `ReputationEngine.recordCompletion()` fires
4. **Timeout protection** -- if `block.timestamp > expiresAt`, anyone can call `refundEscrow()` and `recordFailure()` fires

The `Escrow` struct includes an `x402PaymentHash` field (bytes32) for linking off-chain x402 payment proofs to on-chain settlement.

### Micro-Payment Tab System

For frequent, small transactions (e.g., per-query market data, per-scan security audits):

1. **`addToTab(seller, amount)`** -- accumulates payment records off-chain style (no token transfer yet)
2. Multiple interactions happen, each calling `addToTab()` to increment the running total
3. **`settleTab(seller)`** -- single on-chain payment for all accumulated micro-transactions
4. `transactionCount` is tracked so `ReputationEngine` credits a batch completion

This reduces gas costs by 10-50x compared to individual escrow per micro-service.

### Batch Settlement

`batchSettle(uint256[] escrowIds)` releases multiple escrows in a single transaction, calling `recordCompletion()` for each seller. Critical for end-of-epoch settlement when many services complete simultaneously.
## 安全模型 / Security Model

SYMBIOSIS implements defense-in-depth for an autonomous agent economy:

### Stake Slashing

- Every agent stakes a minimum of **0.01 OKB** via `AgentRegistry.registerAgent()`
- `slashStake(agent, amount)` can be called by the marketplace or owner on dispute loss
- Slashed funds go to protocol treasury (owner address)
- An agent with zero stake remains registered but has no skin-in-the-game, visible to counterparties

### Escrow Protection

- Funds are locked in `EscrowSettlement` until service completion or timeout
- **Buyer protection:** `refundEscrow()` returns funds if service is not delivered before `expiresAt`
- **Seller protection:** only buyer, marketplace, or owner can trigger release -- no unilateral withdrawal
- **Dispute flow:** `disputeService()` sets status to `Disputed`, blocking both release and refund until resolution

### Simulation Before Execution

- **ArbitrageurAgent** quotes both legs of an arbitrage before executing either, calculating expected profit
- **TraderAgent** requests a `getDexQuote()` before calling `executeDexSwap()`, checking price impact
- Abort conditions: profit <= 0 after slippage, risk score > threshold, honeypot detection

### Security Scanning

- **SecurityAuditorAgent** checks every token before trades execute: `isHoneypot`, `hasProxyContract`, `ownerCanMint`, `riskScore`
- **MAX_RISK_SCORE** thresholds: Trader = 30, Arbitrageur = 20 (stricter for fast-moving arb)
- Scan cache with 5-minute TTL prevents redundant API calls

### Agent Error Isolation

- `AgentBase._executeCycle()` wraps every cycle in try/catch -- one bad cycle never kills the agent
- Each agent runs on independent interval timers, no shared failure mode
- Graceful shutdown on SIGINT/SIGTERM stops all agents cleanly
## 运行指南 / How to Run

### Prerequisites

- [Foundry](https://getfoundry.sh/) (forge, cast, anvil)
- Node.js >= 18
- An OKX API key (optional -- mock mode works without it)

### Smart Contracts

```bash
cd contracts

# Build
forge build

# Run tests
forge test -vvv

# Deploy to X Layer testnet
export PRIVATE_KEY=0x...
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://testrpc.xlayer.tech \
  --broadcast \
  --verify
```

### Agent Runtime

```bash
cd agents

# Install dependencies
npm install

# Configure environment
cp ../.env.example .env
# Edit .env with your private keys and OKX API credentials

# Build TypeScript
npm run build

# Start all 6 agents
npm start

# Or run with testnet config (default)
NETWORK=testnet node dist/index.js
```

**Required environment variables:**

| Variable | Description |
|---|---|
| `PK_DATA_PROVIDER` | Private key for DataProviderAgent |
| `PK_ANALYST` | Private key for AnalystAgent |
| `PK_TRADER` | Private key for TraderAgent |
| `PK_SECURITY` | Private key for SecurityAuditorAgent |
| `PK_LIQUIDITY` | Private key for LiquidityManagerAgent |
| `PK_ARBITRAGEUR` | Private key for ArbitrageurAgent |
| `OKX_API_KEY` | OKX Onchain OS API key |
| `OKX_SECRET_KEY` | OKX HMAC secret |
| `OKX_PASSPHRASE` | OKX API passphrase |
| `NETWORK` | `mainnet` or `testnet` (default: testnet) |

> Without `PK_*` variables, the runtime generates deterministic dev keys via `SHA256("symbiosis-dev-{role}")`. These are for local testing only.
## 项目结构 / Project Structure

```
symbiosis/
├── .env.example                          # Environment variable template
├── .gitignore
├── README.md                             # This file
│
├── contracts/                            # Solidity smart contracts (Foundry)
│   ├── foundry.toml                      # Foundry configuration
│   ├── remappings.txt                    # Solidity import remappings
│   ├── lib/
│   │   └── forge-std/                    # Foundry standard library
│   ├── script/
│   │   └── Deploy.s.sol                  # Full deployment script
│   └── src/
│       ├── AgentRegistry.sol             # Agent identity + staking
│       ├── ServiceMarketplace.sol        # Dutch auction service market
│       ├── ReputationEngine.sol          # ELO-based reputation
│       ├── EscrowSettlement.sol          # Trustless escrow + micro-tabs
│       ├── AgentTreasury.sol             # Per-agent PnL accounting
│       ├── EconomyOracle.sol             # Economy metrics + snapshots
│       ├── interfaces/
│       │   ├── IAgentRegistry.sol
│       │   ├── IServiceMarketplace.sol
│       │   ├── IReputationEngine.sol
│       │   └── IEscrowSettlement.sol
│       └── libraries/
│           ├── DutchAuctionLib.sol        # Linear price decay math
│           └── ELOLib.sol                 # ELO rating calculations
│
└── agents/                               # TypeScript agent runtime
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts                      # Orchestrator -- boots all 6 agents
        ├── config/
        │   ├── xlayer.ts                 # X Layer chain configuration
        │   └── contracts.ts              # Contract addresses + ABIs
        ├── core/
        │   ├── AgentBase.ts              # Abstract base class for agents
        │   ├── OnchainOSClient.ts        # OKX Onchain OS REST wrapper
        │   └── EventBus.ts              # In-process event bus
        └── agents/
            ├── DataProviderAgent.ts      # Market data fetcher (30s)
            ├── AnalystAgent.ts           # Alpha signal generator (45s)
            ├── TraderAgent.ts            # Signal-based executor (60s)
            ├── SecurityAuditorAgent.ts   # Token security scanner (20s)
            ├── LiquidityManagerAgent.ts  # Uniswap V3 LP manager (120s)
            └── ArbitrageurAgent.ts       # Cross-venue arbitrageur (10s)
```
## 演示 / Demo

### Running the Demo

1. **Start a local X Layer fork** (optional, for full on-chain testing):

```bash
anvil --fork-url https://testrpc.xlayer.tech --chain-id 195
```

2. **Deploy contracts:**

```bash
cd contracts
forge script script/Deploy.s.sol:Deploy --rpc-url http://localhost:8545 --broadcast
```

3. **Start all agents:**

```bash
cd agents
NETWORK=testnet npm start
```

### What the Demo Shows

- **Agent registration:** All 6 agents register on-chain with 0.01 OKB stake each
- **Service listing:** DataProvider, Analyst, SecurityAuditor, and LiquidityManager list services with Dutch auction pricing
- **Data flow:** DataProvider fetches prices -> Analyst generates signals -> Trader executes
- **Security loop:** Trader and Arbitrageur request security audits before trading
- **Arbitrage detection:** Arbitrageur compares OKX vs Uniswap prices every 10 seconds
- **LP management:** LiquidityManager monitors tick ranges and rebalances when out of range
- **Economy metrics:** EconomyOracle tracks GDP, matches, and volume across the entire economy

Watch the console for timestamped logs from all 6 agents running concurrently:

```
[2026-04-03T10:00:00.000Z] [DataProvider] Published 4 prices. OKB=$48.5
[2026-04-03T10:00:00.500Z] [Analyst] Signal: LONG OKB | confidence=78.3% | regime=trending_up
[2026-04-03T10:00:01.000Z] [SecurityAuditor] Scan #1: 0xEeeeeeEe... | risk=10 | honeypot=false
[2026-04-03T10:00:01.500Z] [Trader] Executing LONG trade on OKB...
[2026-04-03T10:00:02.000Z] [Arbitrageur] OKB: OKX=$48.50 | Uni=$48.74 | spread=0.495%
[2026-04-03T10:00:03.000Z] [LiquidityManager] Position sim-1 in range, 342 ticks from nearest edge
```
## 团队 / Team

| Role | Handle |
|---|---|
| Solo Developer | **0xCaptain888** |

Built for the OKX hackathon. Six contracts. Six agents. One economy.
## 许可证 / License

MIT License. See individual source files for SPDX headers.

```
SPDX-License-Identifier: MIT
```
