![CI](https://img.shields.io/badge/CI-passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![X Layer](https://img.shields.io/badge/X_Layer-Chain_196-7B3FE4)
![Uniswap V3](https://img.shields.io/badge/Uniswap-V3-FF007A)
![Onchain OS](https://img.shields.io/badge/Onchain_OS-OKX-000000)

# SYMBIOSIS

**七个自主 AI 代理在 X Layer 上构建的自维持链上经济体。**

> GitHub: https://github.com/wangyangmingsss/symbiosis
> 演示站点: [https://gm5bevqp.mule.page/](https://gm5bevqp.mule.page/)

---

## 项目概述

SYMBIOSIS 不是一个单独的 AI 代理 -- 它是一个由**七个专业化代理组成的经济体**，在 X Layer（OKX 的 L2，Chain ID 196）上相互交易服务。每个代理在链上注册身份、质押 OKB 作为保证金、通过荷兰拍卖市场挂牌服务、借助 ELO 评分系统积累信誉，并通过无需信任的托管合约完成支付结算。

**为什么这很重要：** 大多数"AI 代理"项目只是一个代理做一件事。SYMBIOSIS 展示了**涌现的经济行为** -- 代理各自专精、相互发现、协商价格、随时间建立信誉。DataProvider 为 Analyst 提供数据，Analyst 为 Trader 提供信号，SecurityAuditor 守护所有人的安全，LiquidityManager 维持市场深度，Arbitrageur 保持价格效率。移除一个代理，经济体会退化；增加更多代理，经济体会变得更强。

**核心差异化：**

- **多代理经济体**，而非单代理工具
- **荷兰拍卖定价** -- 服务价格随时间衰减，自然达到均衡
- **ELO 信誉系统** -- 借鉴国际象棋等级分，适配链上服务市场
- **x402 微支付标签** -- 将大量小额支付批量合并为单次结算
- **完整 Onchain OS 集成** -- 13 个 OKX API skill 驱动代理决策
- **Uniswap V3 LP 管理** -- 自动化集中流动性再平衡

## 系统架构

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
│  库                       │  外部集成                                        │
│  ┌─────────────────┐     │  ┌──────────────┐  ┌───────────────┐            │
│  │ DutchAuctionLib  │     │  │ OKX Onchain  │  │ Uniswap V3    │            │
│  │ (price decay)    │     │  │ OS (13 APIs) │  │ (LP + pricing)│            │
│  ├─────────────────┤     │  └──────────────┘  └───────────────┘            │
│  │ ELOLib           │     │                                                 │
│  │ (rating math)    │     │                                                 │
│  └─────────────────┘     │                                                 │
└──────────────────────────┴──────────────────────────────────────────────────┘
```

## 智能合约架构

所有合约使用 Solidity ^0.8.26 编写，通过 Foundry 部署到 X Layer。

| 合约 | 源文件 | 说明 | 关键函数 |
|---|---|---|---|
| **AgentRegistry** | `src/AgentRegistry.sol` | 链上身份与质押。代理通过类型、metadata URI 及最低 0.01 OKB 质押完成注册。支持发现同类代理、注销退款、罚没质押等操作。 | `registerAgent()`, `deregisterAgent()`, `slashStake()`, `discoverAgents()` |
| **ServiceMarketplace** | `src/ServiceMarketplace.sol` | 荷兰拍卖服务市场。代理以衰减价格挂牌服务；买方发起请求，卖方接受匹配。使用 `DutchAuctionLib` 计算实时价格。支持 6 种预定义服务类型：`MARKET_DATA`、`ALPHA_SIGNAL`、`TRADE_EXECUTION`、`SECURITY_AUDIT`、`LP_MANAGEMENT`、`ARBITRAGE_SIGNAL`。 | `listService()`, `requestService()`, `acceptRequest()`, `completeService()`, `findBestListing()` |
| **ReputationEngine** | `src/ReputationEngine.sol` | 基于 ELO 的链上信誉系统。追踪每个代理的总分和分类别评分。使用 `ELOLib`，新代理（服务次数 < 30）K 值为 64，资深代理 K 值为 32。支持基于 basis points 的直接罚没。 | `recordCompletion()`, `recordFailure()`, `slashReputation()`, `getTopAgents()` |
| **EscrowSettlement** | `src/EscrowSettlement.sol` | 无需信任的支付托管，集成 x402 协议。支持标准托管、批量结算和微支付标签系统。`Escrow` 结构体包含 `x402PaymentHash` 字段用于关联链下支付证明。 | `createEscrow()`, `releaseEscrow()`, `batchSettle()`, `addToTab()`, `settleTab()` |
| **AgentTreasury** | `src/AgentTreasury.sol` | 按代理隔离的资金管理与 PnL 核算。追踪存款、取款、收入、支出。提供经济体层面的 GDP 查询。 | `deposit()`, `withdraw()`, `creditEarnings()`, `getPnL()`, `getGDP()` |
| **EconomyOracle** | `src/EconomyOracle.sol` | 聚合经济指标。任何代理均可调用 `takeSnapshot()` 在链上记录活跃代理数、匹配数、交易量和 GDP。支持里程碑事件（100/1000 次匹配、GDP 达到 1 USDT）。 | `takeSnapshot()`, `getLatestSnapshot()`, `getGrowthRate()` |

**库：**

| 库名 | 用途 |
|---|---|
| `DutchAuctionLib` | 线性价格衰减：`currentPrice = startPrice - (elapsed * decayRate)`，下限钳制在 `floorPrice`。另提供 `blocksUntilPrice()` 供买方计算最佳购买时机。 |
| `ELOLib` | 国际象棋风格 ELO 评分适配版。基础评分 1000，服务次数 < 30 时 K 值为 64，之后降为 32。使用分段线性近似计算期望得分。评分下限 100，永不归零。 |

**部署顺序**（参见 `script/Deploy.s.sol`）：

```
AgentRegistry -> ReputationEngine -> ServiceMarketplace -> EscrowSettlement -> AgentTreasury -> EconomyOracle
```

合约关联配置：`registry.setMarketplace()`、`marketplace.setEscrow()`、`marketplace.setReputation()`、`escrow.setMarketplace()`、`treasury.setEscrow()`、`reputation.setAuthorized(marketplace)`、`reputation.setAuthorized(escrow)`。

## 链上部署

合约已部署至 **X Layer Mainnet（Chain ID 196）**。

- **RPC 端点：** `https://rpc.xlayer.tech`
- **区块浏览器：** [OKX X Layer Explorer](https://www.okx.com/web3/explorer/xlayer)

### 已部署合约地址

| 合约 | 地址 |
|---|---|
| **AgentRegistry** | `0x33dB9d89F2f4E13470469bB4ccf7f708d8333987` |
| **ReputationEngine** | `0x6cAa9D8b182f1919d3F6b10AadcaCc542363463F` |
| **ServiceMarketplace** | `0x58Eb47a4b6F2b777730828Cb8AD77032993a9dbf` |
| **EscrowSettlement** | `0x160dDA2B8dc2f0136AFA6BFbC54D3127163E428A` |
| **AgentTreasury** | `0x1CE0CAe16F38B32a0dc1aB1fe4E34eFC4942A5F7` |
| **EconomyOracle** | `0x72d0B059941B0603bff3593Fa2c8Ca26825AE834` |
| **GovernanceRegistry** | `0x016C98657AEE961f5764359030aa15a2fb174351` |

### 已注册代理钱包

| 代理 | 类型 | 地址 |
|---|---|---|
| #0 | DataProvider | `0xe403C3D6A407c391AeA0b1dCE8fAf8eE26692440` |
| #1 | Trader | `0xe403C3D6A407c391AeA0b1dCE8fAf8eE26692440` |
| #2 | Analyst | `0xe403C3D6A407c391AeA0b1dCE8fAf8eE26692440` |
| #3 | LiquidityManager | `0xe403C3D6A407c391AeA0b1dCE8fAf8eE26692440` |
| #4 | SecurityAuditor | `0xe403C3D6A407c391AeA0b1dCE8fAf8eE26692440` |
| #5 | Arbitrageur | `0xe403C3D6A407c391AeA0b1dCE8fAf8eE26692440` |

> 所有合约和代理钱包均可通过上方区块浏览器链接在 X Layer Mainnet（Chain ID 196）上验证。

## 快速开始

### 环境要求
- [Foundry](https://book.getfoundry.sh/) (Solidity 编译与测试)
- Node.js >= 18 (Agent 运行时)

### 1. 克隆仓库

```bash
git clone https://github.com/wangyangmingsss/symbiosis.git
cd symbiosis
```

### 2. 编译与测试合约

```bash
cd contracts
forge build
forge test -vvv
```

### 3. 部署到 X Layer 主网

```bash
cp .env.example .env
# 填入你的私钥和 OKX API 密钥
forge script script/Deploy.s.sol:Deploy --rpc-url https://rpc.xlayer.tech --broadcast --legacy
```

### 4. 启动 Agent

```bash
cd ../agents
npm install
npx tsx src/index.ts
```

### 5. 查看 Dashboard

打开 https://gm5bevqp.mule.page/
或本地:

```bash
cd docs && python3 -m http.server 8000
```

### 前端交互功能

演示站点包含以下交互功能模块：

- **Agent AI Chat Terminal** -- 与代理进行自然语言交互的终端界面
- **DEX Quote Simulator** -- 模拟 DEX 报价并查看路由与价格影响
- **Cross-Venue Arbitrage Monitor** -- 实时监控 OKX 与 Uniswap V3 之间的跨平台套利机会
- **Uniswap V3 LP Position Visualizer** -- 可视化集中流动性仓位的 tick 范围与资金分布
- **Economy Time Machine** -- 回溯经济体历史快照，观察 GDP、匹配数和交易量的演变
- **One-Click Economy Demo** -- 一键启动完整经济循环演示
- **Multi-Agent Collaboration Arena** -- 提出话题，所有 Agent 以各自性格和策略进行实时多轮讨论（DeepSeek V3 驱动）
- **Economy Stress Tester** -- 调节参数实时模拟 Agent 经济体在牛市/崩盘/平稳等不同压力场景下的表现
- **Agent Strategy Configurator** -- 选择 Agent 调整策略参数，实时预览预测 PnL、风险/收益分布和能力雷达图
- **Cross-Chain Bridge Explorer** -- 查询 OKX 跨链桥报价，可视化桥接路由、费用和安全评分
- **Agent Performance Tournament** -- 选择两个 Agent 进行面对面能力对比和模拟对战

## 代理类型

所有代理继承自 `AgentBase`（TypeScript），该基类提供钱包配置、合约句柄、生命周期管理（`start()`/`stop()`）以及单次循环错误隔离。

| 代理 | 类型枚举 | 角色 | 使用的 Onchain OS Skill | 周期 | 收入模式 |
|---|---|---|---|---|---|
| **DataProviderAgent** | `DataProvider` | 从 OKX 获取 OKB/ETH/BTC/USDT 价格，将数据哈希上链，挂牌 `MARKET_DATA` 服务 | `getMarketPrice()` | 30s | 通过荷兰拍卖出售市场数据快照 |
| **AnalystAgent** | `Analyst` | 消费价格历史，计算波动率/趋势/市场状态，生成 alpha 信号，挂牌 `ALPHA_SIGNAL` 服务 | （消费 DataProvider 输出） | 45s | 出售 alpha 信号；置信度越高价格越高 |
| **TraderAgent** | `Trader` | 根据置信度 > 0.7 的 alpha 信号行动，交易前请求安全审计，通过 OKX DEX 聚合器执行 | `getDexQuote()`, `executeDexSwap()`, `securityScan()` | 60s | 交易盈亏记录在 AgentTreasury |
| **SecurityAuditorAgent** | `SecurityAuditor` | 按需执行代币安全扫描，结果缓存（5 分钟 TTL），每周期处理最多 5 个请求，挂牌 `SECURITY_AUDIT` 服务 | `securityScan()` | 20s | 出售安全审计结果；经济体中最便宜的服务 |
| **LiquidityManagerAgent** | `LiquidityManager` | 管理 Uniswap V3 集中 LP 仓位，检测超出范围，再平衡 tick，收取手续费，挂牌 `LP_MANAGEMENT` 服务 | `getMarketPrice()` | 120s | LP 手续费 + LP 管理服务费 |
| **ArbitrageurAgent** | `Arbitrageur` | 比较 OKX 聚合器与 Uniswap V3 价格，价差 > 0.5% 时执行，交易前请求安全审计 | `getMarketPrice()`, `getDexQuote()`, `executeDexSwap()`, `securityScan()` | 10s | 套利利润；经济体中最快的代理 |
| **GovernanceAgent** | `Governance` | 监控链上治理提案，自动分析投票影响，代表经济体参与治理决策 | `getMarketPrice()` | 90s | 治理参与奖励与投票激励 |

## 经济循环

SYMBIOSIS 经济体中一个完整的价值循环：

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

**收入流向：**
- DataProvider 从 Analyst + Trader 处获得收入（市场数据购买）
- Analyst 从 Trader 处获得收入（alpha 信号购买）
- SecurityAuditor 从 Trader + Arbitrageur 处获得收入（安全审计费用）
- LiquidityManager 从 Uniswap V3 LP 手续费中获得收入
- Arbitrageur 通过跨平台价差捕获获得收入
- Trader 基于 alpha 信号的方向性头寸获得收入

## 荷兰拍卖机制

`ServiceMarketplace` 使用 `DutchAuctionLib` 为所有服务定价。当代理挂牌服务时，价格从高位起始并按区块线性衰减，直至触及底价。

**`DutchAuctionLib.currentPrice()` 的计算方式：**

```
price(block) = max(floorPrice, startPrice - (currentBlock - listedAtBlock) * decayRate)
```

**示例：DataProviderAgent 挂牌 MARKET_DATA 服务：**

| 参数 | 值 | 说明 |
|---|---|---|
| `startPrice` | 0.001 OKB | 初始挂牌价 |
| `floorPrice` | 0.0001 OKB | 最低价格（底价时折扣 10 倍） |
| `decayRate` | 0.00001 OKB/block | X Layer 上约 1 block/sec |
| `maxFulfillments` | 0 | 无限次购买 |

经过 90 个区块（约 90 秒）后，价格到达底价。`blocksUntilPrice()` 辅助函数让买方代理可以计算最优购买时机。

**自动匹配：** `findBestListing(serviceType)` 遍历指定服务类型的所有活跃挂牌，返回当前区块最便宜的选项，使代理能自动找到最优交易。

**为什么 AI 服务适合荷兰拍卖：**
- **无需协商** -- 价格自身说明一切，非常适合自主代理
- **价格发现** -- 提供者通过 startPrice/decayRate 竞争，均衡价格自然涌现
- **紧迫性奖励** -- 先买者付更多但更早获得数据（对 alpha 信号至关重要）

## ELO 信誉系统

`ReputationEngine` 使用 `ELOLib` 为每个代理维护国际象棋风格的等级分。这不是简单的点赞/踩系统 -- 评分变动的幅度取决于基于当前评分计算的**期望结果**。

**`ELOLib` 核心参数：**

| 常量 | 值 | 用途 |
|---|---|---|
| `BASE_RATING` | 1000 | 所有代理的初始评分 |
| `K_FACTOR` | 32 | 资深代理（30+ 次服务）的评分波动系数 |
| `K_FACTOR_NEW` | 64 | 新代理（< 30 次服务）2 倍波动系数 -- 加速冷启动 |
| `NEW_AGENT_THRESHOLD` | 30 | K 值下降的服务次数阈值 |
| `PRECISION` | 10000 | 定点数精度（避免浮点运算） |

**完成服务后的评分更新（`ratingAfterWin`）：**

```
expected = expectedScore(myRating, 1000)  // 与基准分比较
k = completedServices < 30 ? 64 : 32
delta = k * (PRECISION - expected) / PRECISION
newRating = rating + delta
```

**服务失败后的评分更新（`ratingAfterLoss`）：**

```
delta = k * expected / PRECISION
newRating = max(100, rating - delta)       // 下限 100，永不归零
```

**期望得分**使用分段线性近似逻辑曲线 `1/(1+10^((rB-rA)/400))`：

| 评分差值 | 期望得分 |
|---|---|
| > +400 | 0.90 |
| > +200 | 0.75 |
| > +100 | 0.64 |
| > +50 | 0.57 |
| -50 至 +50 | 0.50 |
| > -100 | 0.43 |
| > -200 | 0.36 |
| > -400 | 0.25 |
| < -400 | 0.10 |

**分类评分：** `ReputationEngine` 通过 `_categoryScores` 追踪每个 `(agent, serviceType)` 组合的评分。一个代理可以在 `MARKET_DATA` 类别拥有高分，同时在 `SECURITY_AUDIT` 类别评分较低。

**罚没机制：** `slashReputation(agent, basisPoints)` 对严重违规直接按百分比扣减（例如 500 bps = 5% 惩罚），独立于 ELO 胜/负系统。

## Onchain OS 集成

所有 Onchain OS API 访问均通过 `OnchainOSClient`（`agents/src/core/OnchainOSClient.ts`）进行，该客户端按 OKX API v5 规范使用 HMAC-SHA256 签名认证。客户端默认对 X Layer（Chain ID 196）发起所有链上查询。

| # | Onchain OS Skill | API 端点 | 使用者 | 在 SYMBIOSIS 中的用途 |
|---|---|---|---|---|
| 1 | **Market Ticker** | `market/ticker` | DataProviderAgent | 每 30 秒周期获取 OKB/ETH/BTC/USDT 实时价格 |
| 2 | **Token List** | `defi/token/token-list` | OnchainOSClient.getTokenInfo() | 解析 X Layer 上的代币元数据（精度、合约地址） |
| 3 | **DEX Quote** | `defi/aggregator/quote` | TraderAgent, ArbitrageurAgent | 执行前获取包含价格影响和路由详情的报价 |
| 4 | **DEX Swap** | `defi/aggregator/swap` | TraderAgent, ArbitrageurAgent | 通过 OKX DEX 聚合器在 X Layer 上执行代币兑换 |
| 5 | **Wallet Balance** | `defi/balance/token-balances` | OnchainOSClient.getWalletBalance() | 查询代理钱包在 X Layer 上的持仓以确定头寸规模 |
| 6 | **Token Security** | `defi/security/token-security` | SecurityAuditorAgent, TraderAgent, ArbitrageurAgent | 检测蜜罐、代理合约、铸币权限、持仓集中度 |
| 7 | **Price Feed (OKB)** | `market/ticker` (OKB-USDT) | LiquidityManagerAgent | 确定当前 tick 以管理 Uniswap V3 LP 范围 |
| 8 | **Price Feed (ETH)** | `market/ticker` (ETH-USDT) | DataProviderAgent | 跨资产关联数据，用于 Analyst 信号生成 |
| 9 | **Price Feed (BTC)** | `market/ticker` (BTC-USDT) | DataProviderAgent | 比特币主导度追踪，用于市场状态检测 |
| 10 | **DEX Quote (arb buy)** | `defi/aggregator/quote` | ArbitrageurAgent | 套利买入端报价（USDT -> OKB） |
| 11 | **DEX Quote (arb sell)** | `defi/aggregator/quote` | ArbitrageurAgent | 套利卖出端报价（OKB -> USDT） |
| 12 | **DEX Swap (arb buy)** | `defi/aggregator/swap` | ArbitrageurAgent | 以 0.3% 滑点容忍度执行买入端 |
| 13 | **DEX Swap (arb sell)** | `defi/aggregator/swap` | ArbitrageurAgent | 执行卖出端以完成套利往返交易 |

**认证方式：** 所有请求包含 `OK-ACCESS-KEY`、`OK-ACCESS-SIGN`（Base64 HMAC-SHA256）、`OK-ACCESS-TIMESTAMP` 和 `OK-ACCESS-PASSPHRASE` 请求头。当 API 密钥未设置时，客户端回退到模拟数据以支持离线开发。

## Uniswap V3 集成

SYMBIOSIS 集成 Uniswap V3 于 X Layer 上，用于集中流动性管理和价格发现。

| 集成点 | 代理 | 说明 |
|---|---|---|
| **集中 LP 仓位** | LiquidityManagerAgent | 管理 OKB/USDT 交易对的 tick 范围 `[tickLower, tickUpper]`。使用 `tick = floor(ln(price) / ln(1.0001))` 进行价格到 tick 的转换。 |
| **超出范围检测** | LiquidityManagerAgent | 检查当前 tick 是否在仓位范围内。当 tick 离开范围或接近边缘（5% / 500 bps 缓冲区内）时触发再平衡。 |
| **Tick 再平衡** | LiquidityManagerAgent | 以当前 tick 为中心调整范围：`newLower = currentTick - halfRange`，`newUpper = currentTick + halfRange`。生产环境调用 NonfungiblePositionManager 的 `decreaseLiquidity()` -> `collect()` -> `mint()`。 |
| **手续费收取** | LiquidityManagerAgent | 每个周期按仓位流动性比例收取累积的交易手续费。 |
| **跨平台定价** | ArbitrageurAgent | 比较 Uniswap V3 链上价格（通过 pool `slot0`）与 OKX DEX 聚合器价格。利用 > 0.5% 的价差。 |
| **套利执行** | ArbitrageurAgent | 双腿交易：在便宜的平台买入，在贵的平台卖出。头寸规模随价差幅度缩放（`sizeFactor = min(100, spread * 10000)`）。 |
| **服务类型：LP_MANAGEMENT** | ServiceMarketplace | 已注册服务类型 `keccak256("LP_MANAGEMENT")` -- LiquidityManager 通过荷兰拍卖向其他代理提供 LP 管理服务。 |

## x402 支付集成

`EscrowSettlement` 为代理间交易实现了两种支付模式：

### 标准托管

用于高价值服务交易（如 LP 管理、交易执行）：

1. **买方调用 `createEscrow()`** -- 将 OKB 存入合约，指定卖方、金额和有效期
2. **卖方交付服务** -- 完成工作并在 marketplace 上调用 `completeService()`
3. **买方调用 `releaseEscrow()`** -- 资金转给卖方，`ReputationEngine.recordCompletion()` 触发
4. **超时保护** -- 若 `block.timestamp > expiresAt`，任何人可调用 `refundEscrow()`，同时 `recordFailure()` 触发

`Escrow` 结构体包含 `x402PaymentHash` 字段（bytes32），用于将链下 x402 支付证明关联到链上结算。

### 微支付标签系统

用于频繁的小额交易（如按次查询市场数据、按次安全扫描）：

1. **`addToTab(seller, amount)`** -- 以链下方式累积支付记录（尚无代币转账）
2. 多次交互发生，每次调用 `addToTab()` 增加累计金额
3. **`settleTab(seller)`** -- 对所有累积的微交易进行单次链上支付
4. 追踪 `transactionCount` 以便 `ReputationEngine` 计入批量完成

与为每笔微服务创建独立托管相比，该方案可降低 10-50 倍 gas 成本。

### 批量结算

`batchSettle(uint256[] escrowIds)` 在单笔交易中释放多个托管，为每个卖方调用 `recordCompletion()`。对于多个服务同时完成的周期末结算至关重要。

## 安全模型

SYMBIOSIS 为自主代理经济体实施纵深防御策略：

### 质押罚没

- 每个代理通过 `AgentRegistry.registerAgent()` 最低质押 **0.01 OKB**
- `slashStake(agent, amount)` 可由 marketplace 或 owner 在争议败诉时调用
- 罚没资金进入协议金库（owner 地址）
- 质押归零的代理仍保持注册状态，但对手方可见其已无保证金

### 托管保护

- 资金在 `EscrowSettlement` 中锁定，直到服务完成或超时
- **买方保护：** 若服务在 `expiresAt` 前未交付，`refundEscrow()` 退还资金
- **卖方保护：** 仅买方、marketplace 或 owner 可触发释放 -- 不允许单方面提取
- **争议流程：** `disputeService()` 将状态设为 `Disputed`，阻止释放和退款直至解决

### 执行前模拟

- **ArbitrageurAgent** 在执行任一腿之前先对两腿报价，计算预期利润
- **TraderAgent** 在调用 `executeDexSwap()` 之前先请求 `getDexQuote()`，检查价格影响
- 中止条件：滑点后利润 <= 0、风险评分超过阈值、蜜罐检测

### 安全扫描

- **SecurityAuditorAgent** 在交易执行前检查每个代币：`isHoneypot`、`hasProxyContract`、`ownerCanMint`、`riskScore`
- **MAX_RISK_SCORE** 阈值：Trader = 30，Arbitrageur = 20（套利需更严格）
- 扫描缓存 5 分钟 TTL，避免冗余 API 调用

### 代理错误隔离

- `AgentBase._executeCycle()` 将每个周期包裹在 try/catch 中 -- 一次异常周期永远不会终止代理
- 每个代理在独立的定时器上运行，无共享故障模式
- 收到 SIGINT/SIGTERM 时优雅关闭所有代理

## 运行指南

### 前置条件

- [Foundry](https://getfoundry.sh/)（forge, cast, anvil）
- Node.js >= 18
- OKX API 密钥（可选 -- 无密钥时以模拟模式运行）

### 智能合约

```bash
cd contracts

# 编译
forge build

# 运行测试
forge test -vvv

# 部署到 X Layer 主网
export PRIVATE_KEY=0x...
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.xlayer.tech \
  --broadcast \
  --verify
```

### 代理运行时

```bash
cd agents

# 安装依赖
npm install

# 配置环境变量
cp ../.env.example .env
# 编辑 .env 填入私钥和 OKX API 凭证

# 编译 TypeScript
npm run build

# 启动全部 7 个代理
npm start

# 或以主网配置运行（默认）
NETWORK=mainnet node dist/index.js
```

**必需的环境变量：**

| 变量 | 说明 |
|---|---|
| `PK_DATA_PROVIDER` | DataProviderAgent 的私钥 |
| `PK_ANALYST` | AnalystAgent 的私钥 |
| `PK_TRADER` | TraderAgent 的私钥 |
| `PK_SECURITY` | SecurityAuditorAgent 的私钥 |
| `PK_LIQUIDITY` | LiquidityManagerAgent 的私钥 |
| `PK_ARBITRAGEUR` | ArbitrageurAgent 的私钥 |
| `PK_GOVERNANCE` | GovernanceAgent 的私钥 |
| `OKX_API_KEY` | OKX Onchain OS API 密钥 |
| `OKX_SECRET_KEY` | OKX HMAC 签名密钥 |
| `OKX_PASSPHRASE` | OKX API 口令 |
| `NETWORK` | `mainnet` 或 `testnet`（默认：mainnet） |

> 未设置 `PK_*` 变量时，运行时通过 `SHA256("symbiosis-dev-{role}")` 生成确定性开发密钥。仅用于本地测试。

## 项目结构

```
symbiosis/
├── .env.example                          # 环境变量模板
├── .gitignore
├── README.md                             # 本文件
│
├── contracts/                            # Solidity 智能合约（Foundry）
│   ├── foundry.toml                      # Foundry 配置
│   ├── remappings.txt                    # Solidity 导入重映射
│   ├── lib/
│   │   └── forge-std/                    # Foundry 标准库
│   ├── script/
│   │   └── Deploy.s.sol                  # 完整部署脚本
│   └── src/
│       ├── AgentRegistry.sol             # 代理身份 + 质押
│       ├── ServiceMarketplace.sol        # 荷兰拍卖服务市场
│       ├── ReputationEngine.sol          # 基于 ELO 的信誉系统
│       ├── EscrowSettlement.sol          # 无信任托管 + 微支付标签
│       ├── AgentTreasury.sol             # 按代理 PnL 核算
│       ├── EconomyOracle.sol             # 经济指标 + 快照
│       ├── interfaces/
│       │   ├── IAgentRegistry.sol
│       │   ├── IServiceMarketplace.sol
│       │   ├── IReputationEngine.sol
│       │   └── IEscrowSettlement.sol
│       └── libraries/
│           ├── DutchAuctionLib.sol        # 线性价格衰减数学
│           └── ELOLib.sol                 # ELO 评分计算
│
└── agents/                               # TypeScript 代理运行时
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts                      # 编排器 -- 启动全部 7 个代理
        ├── config/
        │   ├── xlayer.ts                 # X Layer 链配置
        │   └── contracts.ts              # 合约地址 + ABI
        ├── core/
        │   ├── AgentBase.ts              # 代理抽象基类
        │   ├── OnchainOSClient.ts        # OKX Onchain OS REST 封装
        │   └── EventBus.ts              # 进程内事件总线
        └── agents/
            ├── DataProviderAgent.ts      # 市场数据采集器 (30s)
            ├── AnalystAgent.ts           # Alpha 信号生成器 (45s)
            ├── TraderAgent.ts            # 基于信号的执行器 (60s)
            ├── SecurityAuditorAgent.ts   # 代币安全扫描器 (20s)
            ├── LiquidityManagerAgent.ts  # Uniswap V3 LP 管理器 (120s)
            ├── ArbitrageurAgent.ts       # 跨平台套利器 (10s)
            └── GovernanceAgent.ts       # 治理参与代理 (90s)
```

## 演示

### 运行演示

1. **启动本地 X Layer 分叉**（可选，用于完整链上测试）：

```bash
anvil --fork-url https://rpc.xlayer.tech --chain-id 196
```

2. **部署合约：**

```bash
cd contracts
forge script script/Deploy.s.sol:Deploy --rpc-url http://localhost:8545 --broadcast
```

3. **启动全部代理：**

```bash
cd agents
NETWORK=mainnet npm start
```

### 演示展示内容

- **代理注册：** 全部 7 个代理在链上注册并各自质押 0.01 OKB
- **服务挂牌：** DataProvider、Analyst、SecurityAuditor 和 LiquidityManager 以荷兰拍卖定价挂牌服务
- **数据流：** DataProvider 获取价格 -> Analyst 生成信号 -> Trader 执行交易
- **安全循环：** Trader 和 Arbitrageur 在交易前请求安全审计
- **套利检测：** Arbitrageur 每 10 秒比较 OKX 与 Uniswap 价格
- **LP 管理：** LiquidityManager 监控 tick 范围并在超出范围时再平衡
- **经济指标：** EconomyOracle 追踪整个经济体的 GDP、匹配数和交易量

观察控制台中 7 个代理并发运行的带时间戳日志：

```
[2026-04-03T10:00:00.000Z] [DataProvider] Published 4 prices. OKB=$48.5
[2026-04-03T10:00:00.500Z] [Analyst] Signal: LONG OKB | confidence=78.3% | regime=trending_up
[2026-04-03T10:00:01.000Z] [SecurityAuditor] Scan #1: 0xEeeeeeEe... | risk=10 | honeypot=false
[2026-04-03T10:00:01.500Z] [Trader] Executing LONG trade on OKB...
[2026-04-03T10:00:02.000Z] [Arbitrageur] OKB: OKX=$48.50 | Uni=$48.74 | spread=0.495%
[2026-04-03T10:00:03.000Z] [LiquidityManager] Position sim-1 in range, 342 ticks from nearest edge
```

## 团队

| 角色 | 账号 |
|---|---|
| 独立开发者 | **wangyangmingssssss** |

为 OKX 黑客松打造。六个合约。七个代理。一个经济体。

## 许可证

MIT 许可证。各源文件中有 SPDX 声明。

```
SPDX-License-Identifier: MIT
```
