#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"

# --- Config ---
RPC="https://testrpc.xlayer.tech"
CHAIN_ID=1952
DEPLOYER_PK="0x3d474cf9f1a703bf05b5cd99f44468b5ce883ef5ec4672a5f5af6dc708d7dc9f"
AGENT_REGISTRY="0x33dB9d89F2f4E13470469bB4ccf7f708d8333987"
STAKE="0.01ether"
FUND_AMOUNT="0.02ether"
GAS_PRICE="1gwei"

# Enum: 0=DataProvider, 1=Trader, 2=Analyst, 3=LiquidityManager, 4=SecurityAuditor, 5=Arbitrageur
AGENT_TYPES=(0 1 2 3 4 5)
AGENT_TYPE_NAMES=("DataProvider" "Trader" "Analyst" "LiquidityManager" "SecurityAuditor" "Arbitrageur")

# --- Step 1: Generate 6 agent wallets deterministically ---
echo "=== Generating 6 agent wallets ==="
AGENT_PKS=()
AGENT_ADDRS=()

for i in $(seq 1 6); do
  PK=$(cast keccak "symbiosis-agent-seed-${i}-v1")
  ADDR=$(cast wallet address "$PK")
  AGENT_PKS+=("$PK")
  AGENT_ADDRS+=("$ADDR")
  echo "Agent $i (${AGENT_TYPE_NAMES[$((i-1))]}): Address=$ADDR"
done

echo ""

# --- Step 2: Fund each agent wallet with 0.02 OKB ---
echo "=== Funding agent wallets with 0.02 OKB each ==="
DEPLOYER_ADDR=$(cast wallet address "$DEPLOYER_PK")
echo "Deployer: $DEPLOYER_ADDR"
echo "Deployer balance: $(cast balance "$DEPLOYER_ADDR" --rpc-url "$RPC" --ether) OKB"
echo ""

for i in $(seq 0 5); do
  ADDR="${AGENT_ADDRS[$i]}"
  # Check if already funded
  BAL=$(cast balance "$ADDR" --rpc-url "$RPC")
  if [ "$BAL" != "0" ]; then
    echo "Agent $((i+1)) ($ADDR) already has balance: $(cast balance "$ADDR" --rpc-url "$RPC" --ether) OKB - skipping funding"
    continue
  fi
  echo "Funding Agent $((i+1)) ($ADDR) with 0.02 OKB..."
  cast send --private-key "$DEPLOYER_PK" \
    --rpc-url "$RPC" \
    --chain "$CHAIN_ID" \
    --legacy \
    --gas-price "$GAS_PRICE" \
    --value "$FUND_AMOUNT" \
    "$ADDR" > /dev/null 2>&1
  echo "  Funded. Balance: $(cast balance "$ADDR" --rpc-url "$RPC" --ether) OKB"
done

echo ""

# --- Step 3: Register each agent on-chain ---
echo "=== Registering agents on AgentRegistry ==="
# Function: registerAgent(uint8 agentType, string metadataURI) payable
# MIN_STAKE = 0.01 ether

for i in $(seq 0 5); do
  PK="${AGENT_PKS[$i]}"
  ADDR="${AGENT_ADDRS[$i]}"
  AGENT_TYPE="${AGENT_TYPES[$i]}"
  TYPE_NAME="${AGENT_TYPE_NAMES[$i]}"
  METADATA="ipfs://symbiosis-agent-$((i+1))-${TYPE_NAME}"

  # Check if already registered
  IS_REG=$(cast call "$AGENT_REGISTRY" "isRegistered(address)(bool)" "$ADDR" --rpc-url "$RPC" 2>/dev/null || echo "false")
  if [ "$IS_REG" = "true" ]; then
    echo "Agent $((i+1)) ($TYPE_NAME @ $ADDR) already registered - skipping"
    continue
  fi

  echo "Registering Agent $((i+1)): type=$AGENT_TYPE ($TYPE_NAME), metadata=$METADATA"

  cast send --private-key "$PK" \
    --rpc-url "$RPC" \
    --chain "$CHAIN_ID" \
    --legacy \
    --gas-price "$GAS_PRICE" \
    --value "$STAKE" \
    "$AGENT_REGISTRY" \
    "registerAgent(uint8,string)" \
    "$AGENT_TYPE" \
    "$METADATA" > /dev/null 2>&1

  echo "  Registered successfully."
done

echo ""

# --- Step 4: Verify registrations ---
echo "=== Verification ==="

ACTIVE_COUNT=$(cast call "$AGENT_REGISTRY" "getAgentCount()(uint256)" --rpc-url "$RPC" 2>/dev/null || echo "N/A")
echo "Active agent count: $ACTIVE_COUNT"
echo ""

echo "Individual agent checks:"
for i in $(seq 0 5); do
  ADDR="${AGENT_ADDRS[$i]}"
  TYPE_NAME="${AGENT_TYPE_NAMES[$i]}"
  IS_REG=$(cast call "$AGENT_REGISTRY" "isRegistered(address)(bool)" "$ADDR" --rpc-url "$RPC" 2>/dev/null || echo "unknown")
  echo "  Agent $((i+1)) ($TYPE_NAME @ $ADDR): registered=$IS_REG"
done

echo ""

# --- Step 5: Print summary ---
echo "=========================================="
echo "=== AGENT WALLET SUMMARY ==="
echo "=========================================="
for i in $(seq 0 5); do
  echo "Agent $((i+1)) - ${AGENT_TYPE_NAMES[$i]}:"
  echo "  Address:     ${AGENT_ADDRS[$i]}"
  echo "  Private Key: ${AGENT_PKS[$i]}"
  echo ""
done

echo "=== Contract Addresses ==="
echo "AgentRegistry:      $AGENT_REGISTRY"
echo "ReputationEngine:   0x6cAa9D8b182f1919d3F6b10AadcaCc542363463F"
echo "ServiceMarketplace: 0x58Eb47a4b6F2b777730828Cb8AD77032993a9dbf"
echo "EscrowSettlement:   0x160dDA2B8dc2f0136AFA6BFbC54D3127163E428A"
echo "AgentTreasury:      0x1CE0CAe16F38B32a0dc1aB1fe4E34eFC4942A5F7"
echo "EconomyOracle:      0x72d0B059941B0603bff3593Fa2c8Ca26825AE834"
echo ""
echo "Done!"
