#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"

# --- Config ---
RPC="https://testrpc.xlayer.tech"
CHAIN_ID=195
GAS_PRICE="1gwei"
CAST="cast"

# Contract addresses
MARKETPLACE="0x58Eb47a4b6F2b777730828Cb8AD77032993a9dbf"
ESCROW="0x160dDA2B8dc2f0136AFA6BFbC54D3127163E428A"
TREASURY="0x1CE0CAe16F38B32a0dc1aB1fe4E34eFC4942A5F7"
ORACLE="0x72d0B059941B0603bff3593Fa2c8Ca26825AE834"

# Deployer (owner)
DEPLOYER_PK="0x3d474cf9f1a703bf05b5cd99f44468b5ce883ef5ec4672a5f5af6dc708d7dc9f"
DEPLOYER_ADDR="0xe403C3D6A407c391AeA0b1dCE8fAf8eE26692440"

# Agent wallets
PK0="0x9745c732f841010c6801088dcc2f7e69c953f2c064560974ba98024d0d678a75"
PK1="0xd2168d58a16da270a1660b09e925d9233d48d7dd1cd86440d216bce2624f4447"
PK2="0x0ac4fa6ae65c6f157351126c2763ff898aa376d22e6999f88d3424239ab7b9b5"
PK3="0xf9033bdbbf1a611f887a710c3e424d2d613539b51e40f765109db908beb79bd7"
PK4="0xe8429961c5831f4be3c2eb73dbbfc085982a46825b74e6d88f612a39ab6263f5"
PK5="0x9678d6165ed4e06608e2b6119e89dc6b9f7a017fd28b2ee6a494d9e32ce3af2e"

ADDR0="0x7AA421344e622a89DC2978C517466eD8955bd8f3"
ADDR1="0x81AF24718681473418C31eFeb46a2Ff961bc3993"
ADDR2="0x43A454ABcd159e3127DaF146316f3F4Ca48fCB3c"
ADDR3="0x90f706d1e70Ab0c2E7ee5EDf63563dad5588346f"
ADDR4="0xCC106C4EE978d4cbFDd5B121A8a4dD895d3e424E"
ADDR5="0x3b589f2AFc90c082836e4F6d74e63FaAec7a5f31"

# Service type hashes (keccak256)
MARKET_DATA=$($CAST keccak "MARKET_DATA")
ALPHA_SIGNAL=$($CAST keccak "ALPHA_SIGNAL")
TRADE_EXECUTION=$($CAST keccak "TRADE_EXECUTION")
SECURITY_AUDIT=$($CAST keccak "SECURITY_AUDIT")
LP_MANAGEMENT=$($CAST keccak "LP_MANAGEMENT")
ARBITRAGE_SIGNAL=$($CAST keccak "ARBITRAGE_SIGNAL")

TX_COUNT=0

# Helper: send tx and print hash
send_tx() {
  local desc="$1"
  shift
  echo "--- TX $((TX_COUNT+1)): $desc ---"
  local OUTPUT
  OUTPUT=$($CAST send "$@" --rpc-url "$RPC" --legacy --gas-price "$GAS_PRICE" --json 2>&1) || {
    echo "  FAILED: $OUTPUT"
    return 1
  }
  local HASH
  HASH=$(echo "$OUTPUT" | jq -r '.transactionHash // empty')
  if [ -n "$HASH" ]; then
    echo "  TX Hash: $HASH"
    TX_COUNT=$((TX_COUNT+1))
  else
    echo "  FAILED (no hash): $OUTPUT"
    return 1
  fi
}

echo "============================================"
echo "  SYMBIOSIS Economy Simulation"
echo "============================================"
echo ""

BLOCK=$($CAST block-number --rpc-url "$RPC")
DEADLINE=$((BLOCK + 100000))
echo "Current block: $BLOCK, Deadline for requests: $DEADLINE"
echo ""

# ===========================================
# PHASE 1: Service Listings (14 listings)
# ===========================================
echo "========== PHASE 1: Service Listings =========="

# Agent 0 (DataProvider) lists MARKET_DATA x2
send_tx "Agent0 lists MARKET_DATA #1" \
  --private-key "$PK0" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$MARKET_DATA" 500000000000000 200000000000000 1000000000 5

send_tx "Agent0 lists MARKET_DATA #2" \
  --private-key "$PK0" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$MARKET_DATA" 300000000000000 100000000000000 500000000 10

# Agent 1 (Trader) lists TRADE_EXECUTION x2, ALPHA_SIGNAL x1
send_tx "Agent1 lists TRADE_EXECUTION #1" \
  --private-key "$PK1" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$TRADE_EXECUTION" 800000000000000 300000000000000 2000000000 3

send_tx "Agent1 lists ALPHA_SIGNAL #1" \
  --private-key "$PK1" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$ALPHA_SIGNAL" 600000000000000 200000000000000 1500000000 5

# Agent 2 (Analyst) lists ALPHA_SIGNAL x2
send_tx "Agent2 lists ALPHA_SIGNAL #1" \
  --private-key "$PK2" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$ALPHA_SIGNAL" 400000000000000 150000000000000 1000000000 5

send_tx "Agent2 lists MARKET_DATA #1" \
  --private-key "$PK2" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$MARKET_DATA" 350000000000000 120000000000000 800000000 5

# Agent 3 (LiquidityManager) lists LP_MANAGEMENT x2
send_tx "Agent3 lists LP_MANAGEMENT #1" \
  --private-key "$PK3" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$LP_MANAGEMENT" 700000000000000 250000000000000 1800000000 3

send_tx "Agent3 lists LP_MANAGEMENT #2" \
  --private-key "$PK3" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$LP_MANAGEMENT" 500000000000000 200000000000000 1200000000 5

# Agent 4 (SecurityAuditor) lists SECURITY_AUDIT x2
send_tx "Agent4 lists SECURITY_AUDIT #1" \
  --private-key "$PK4" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$SECURITY_AUDIT" 900000000000000 400000000000000 2500000000 3

send_tx "Agent4 lists SECURITY_AUDIT #2" \
  --private-key "$PK4" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$SECURITY_AUDIT" 600000000000000 250000000000000 1500000000 5

# Agent 5 (Arbitrageur) lists ARBITRAGE_SIGNAL x2
send_tx "Agent5 lists ARBITRAGE_SIGNAL #1" \
  --private-key "$PK5" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$ARBITRAGE_SIGNAL" 500000000000000 180000000000000 1300000000 5

send_tx "Agent5 lists ARBITRAGE_SIGNAL #2" \
  --private-key "$PK5" "$MARKETPLACE" \
  "listService(bytes32,uint256,uint256,uint256,uint256)" \
  "$ARBITRAGE_SIGNAL" 350000000000000 120000000000000 900000000 10

echo ""

# ===========================================
# PHASE 2: Service Requests (8 requests)
# ===========================================
echo "========== PHASE 2: Service Requests =========="

# Trader requests MARKET_DATA
send_tx "Agent1(Trader) requests MARKET_DATA" \
  --private-key "$PK1" "$MARKETPLACE" \
  "requestService(bytes32,uint256,uint256)" \
  "$MARKET_DATA" 500000000000000 "$DEADLINE"

# Analyst requests MARKET_DATA
send_tx "Agent2(Analyst) requests MARKET_DATA" \
  --private-key "$PK2" "$MARKETPLACE" \
  "requestService(bytes32,uint256,uint256)" \
  "$MARKET_DATA" 400000000000000 "$DEADLINE"

# Trader requests ALPHA_SIGNAL
send_tx "Agent1(Trader) requests ALPHA_SIGNAL" \
  --private-key "$PK1" "$MARKETPLACE" \
  "requestService(bytes32,uint256,uint256)" \
  "$ALPHA_SIGNAL" 500000000000000 "$DEADLINE"

# LiquidityManager requests SECURITY_AUDIT
send_tx "Agent3(LiqManager) requests SECURITY_AUDIT" \
  --private-key "$PK3" "$MARKETPLACE" \
  "requestService(bytes32,uint256,uint256)" \
  "$SECURITY_AUDIT" 900000000000000 "$DEADLINE"

# DataProvider requests TRADE_EXECUTION
send_tx "Agent0(DataProvider) requests TRADE_EXECUTION" \
  --private-key "$PK0" "$MARKETPLACE" \
  "requestService(bytes32,uint256,uint256)" \
  "$TRADE_EXECUTION" 800000000000000 "$DEADLINE"

# Arbitrageur requests LP_MANAGEMENT
send_tx "Agent5(Arb) requests LP_MANAGEMENT" \
  --private-key "$PK5" "$MARKETPLACE" \
  "requestService(bytes32,uint256,uint256)" \
  "$LP_MANAGEMENT" 700000000000000 "$DEADLINE"

# SecurityAuditor requests ARBITRAGE_SIGNAL
send_tx "Agent4(Auditor) requests ARBITRAGE_SIGNAL" \
  --private-key "$PK4" "$MARKETPLACE" \
  "requestService(bytes32,uint256,uint256)" \
  "$ARBITRAGE_SIGNAL" 500000000000000 "$DEADLINE"

# DataProvider requests ALPHA_SIGNAL
send_tx "Agent0(DataProvider) requests ALPHA_SIGNAL" \
  --private-key "$PK0" "$MARKETPLACE" \
  "requestService(bytes32,uint256,uint256)" \
  "$ALPHA_SIGNAL" 600000000000000 "$DEADLINE"

echo ""

# ===========================================
# PHASE 3: Accept Requests (provider accepts)
# Listings: 0-11, Requests: 0-7
# Match: listing serviceType must match request serviceType
# ===========================================
echo "========== PHASE 3: Accept Requests =========="

# Request 0 (MARKET_DATA by Trader) <- Listing 0 (MARKET_DATA by Agent0)
send_tx "Agent0 accepts Request0 with Listing0 (MARKET_DATA)" \
  --private-key "$PK0" "$MARKETPLACE" \
  "acceptRequest(uint256,uint256)" 0 0

# Request 1 (MARKET_DATA by Analyst) <- Listing 1 (MARKET_DATA by Agent0)
send_tx "Agent0 accepts Request1 with Listing1 (MARKET_DATA)" \
  --private-key "$PK0" "$MARKETPLACE" \
  "acceptRequest(uint256,uint256)" 1 1

# Request 2 (ALPHA_SIGNAL by Trader) <- Listing 4 (ALPHA_SIGNAL by Agent2)
send_tx "Agent2 accepts Request2 with Listing4 (ALPHA_SIGNAL)" \
  --private-key "$PK2" "$MARKETPLACE" \
  "acceptRequest(uint256,uint256)" 2 4

# Request 3 (SECURITY_AUDIT by LiqManager) <- Listing 8 (SECURITY_AUDIT by Agent4)
send_tx "Agent4 accepts Request3 with Listing8 (SECURITY_AUDIT)" \
  --private-key "$PK4" "$MARKETPLACE" \
  "acceptRequest(uint256,uint256)" 3 8

# Request 4 (TRADE_EXECUTION by DataProvider) <- Listing 2 (TRADE_EXECUTION by Agent1)
send_tx "Agent1 accepts Request4 with Listing2 (TRADE_EXECUTION)" \
  --private-key "$PK1" "$MARKETPLACE" \
  "acceptRequest(uint256,uint256)" 4 2

# Request 5 (LP_MANAGEMENT by Arb) <- Listing 6 (LP_MANAGEMENT by Agent3)
send_tx "Agent3 accepts Request5 with Listing6 (LP_MANAGEMENT)" \
  --private-key "$PK3" "$MARKETPLACE" \
  "acceptRequest(uint256,uint256)" 5 6

# Request 6 (ARBITRAGE_SIGNAL by Auditor) <- Listing 10 (ARBITRAGE_SIGNAL by Agent5)
send_tx "Agent5 accepts Request6 with Listing10 (ARBITRAGE_SIGNAL)" \
  --private-key "$PK5" "$MARKETPLACE" \
  "acceptRequest(uint256,uint256)" 6 10

# Request 7 (ALPHA_SIGNAL by DataProvider) <- Listing 3 (ALPHA_SIGNAL by Agent1)
send_tx "Agent1 accepts Request7 with Listing3 (ALPHA_SIGNAL)" \
  --private-key "$PK1" "$MARKETPLACE" \
  "acceptRequest(uint256,uint256)" 7 3

echo ""

# ===========================================
# PHASE 4: Create Escrows (buyer funds)
# Small amounts: 0.0001 to 0.0005 OKB
# ===========================================
echo "========== PHASE 4: Create Escrows =========="

# Escrow for Req0: buyer=Agent1(Trader), seller=Agent0(DataProvider), 0.0002 OKB
send_tx "Escrow Req0: Trader->DataProvider 0.0002 OKB" \
  --private-key "$PK1" "$ESCROW" \
  "createEscrow(uint256,address,uint256,uint256)" \
  0 "$ADDR0" 200000000000000 3600 \
  --value 200000000000000

# Escrow for Req1: buyer=Agent2(Analyst), seller=Agent0(DataProvider), 0.00015 OKB
send_tx "Escrow Req1: Analyst->DataProvider 0.00015 OKB" \
  --private-key "$PK2" "$ESCROW" \
  "createEscrow(uint256,address,uint256,uint256)" \
  1 "$ADDR0" 150000000000000 3600 \
  --value 150000000000000

# Escrow for Req2: buyer=Agent1(Trader), seller=Agent2(Analyst), 0.0002 OKB
send_tx "Escrow Req2: Trader->Analyst 0.0002 OKB" \
  --private-key "$PK1" "$ESCROW" \
  "createEscrow(uint256,address,uint256,uint256)" \
  2 "$ADDR2" 200000000000000 3600 \
  --value 200000000000000

# Escrow for Req3: buyer=Agent3(LiqManager), seller=Agent4(Auditor), 0.0004 OKB
send_tx "Escrow Req3: LiqManager->Auditor 0.0004 OKB" \
  --private-key "$PK3" "$ESCROW" \
  "createEscrow(uint256,address,uint256,uint256)" \
  3 "$ADDR4" 400000000000000 3600 \
  --value 400000000000000

# Escrow for Req4: buyer=Agent0(DataProvider), seller=Agent1(Trader), 0.0003 OKB
send_tx "Escrow Req4: DataProvider->Trader 0.0003 OKB" \
  --private-key "$PK0" "$ESCROW" \
  "createEscrow(uint256,address,uint256,uint256)" \
  4 "$ADDR1" 300000000000000 3600 \
  --value 300000000000000

# Escrow for Req5: buyer=Agent5(Arb), seller=Agent3(LiqManager), 0.0003 OKB
send_tx "Escrow Req5: Arb->LiqManager 0.0003 OKB" \
  --private-key "$PK5" "$ESCROW" \
  "createEscrow(uint256,address,uint256,uint256)" \
  5 "$ADDR3" 300000000000000 3600 \
  --value 300000000000000

echo ""

# ===========================================
# PHASE 5: Release Escrows (owner releases)
# ===========================================
echo "========== PHASE 5: Release Escrows =========="

for ESCROW_ID in 0 1 2 3 4 5; do
  send_tx "Owner releases Escrow $ESCROW_ID" \
    --private-key "$DEPLOYER_PK" "$ESCROW" \
    "releaseEscrow(uint256)" "$ESCROW_ID"
done

echo ""

# ===========================================
# PHASE 6: Treasury Deposits
# ===========================================
echo "========== PHASE 6: Treasury Deposits =========="

# Each agent deposits a small amount
DEPOSIT_AMOUNTS=(100000000000000 150000000000000 120000000000000 130000000000000 110000000000000 140000000000000)
AGENT_PKS_ARR=("$PK0" "$PK1" "$PK2" "$PK3" "$PK4" "$PK5")
AGENT_NAMES=("DataProvider" "Trader" "Analyst" "LiqManager" "Auditor" "Arbitrageur")

for i in 0 1 2 3 4 5; do
  send_tx "Agent${i}(${AGENT_NAMES[$i]}) deposits into Treasury" \
    --private-key "${AGENT_PKS_ARR[$i]}" "$TREASURY" \
    "deposit()" \
    --value "${DEPOSIT_AMOUNTS[$i]}"
done

echo ""

# ===========================================
# PHASE 7: Credit Earnings & Debit Spending
# ===========================================
echo "========== PHASE 7: Credit Earnings & Debit Spending =========="

AGENT_ADDRS_ARR=("$ADDR0" "$ADDR1" "$ADDR2" "$ADDR3" "$ADDR4" "$ADDR5")
EARN_AMOUNTS=(350000000000000 300000000000000 200000000000000 300000000000000 400000000000000 180000000000000)
SPEND_AMOUNTS=(300000000000000 400000000000000 150000000000000 400000000000000 200000000000000 300000000000000)

for i in 0 1 2 3 4 5; do
  send_tx "Credit earnings to Agent${i}(${AGENT_NAMES[$i]})" \
    --private-key "$DEPLOYER_PK" "$TREASURY" \
    "creditEarnings(address,uint256)" \
    "${AGENT_ADDRS_ARR[$i]}" "${EARN_AMOUNTS[$i]}"

  send_tx "Debit spending from Agent${i}(${AGENT_NAMES[$i]})" \
    --private-key "$DEPLOYER_PK" "$TREASURY" \
    "debitSpending(address,uint256)" \
    "${AGENT_ADDRS_ARR[$i]}" "${SPEND_AMOUNTS[$i]}"
done

echo ""

# ===========================================
# PHASE 8: Economy Snapshots (5 snapshots)
# ===========================================
echo "========== PHASE 8: Economy Snapshots =========="

# takeSnapshot(activeAgents, totalListings, totalRequests, totalMatches, totalEscrowVolume, totalSettled, gdp)
send_tx "Snapshot 1: Early economy" \
  --private-key "$DEPLOYER_PK" "$ORACLE" \
  "takeSnapshot(uint256,uint256,uint256,uint256,uint256,uint256,uint256)" \
  6 12 8 8 1550000000000000 6 750000000000000

send_tx "Snapshot 2: Growing economy" \
  --private-key "$DEPLOYER_PK" "$ORACLE" \
  "takeSnapshot(uint256,uint256,uint256,uint256,uint256,uint256,uint256)" \
  6 12 8 8 1550000000000000 6 1200000000000000

send_tx "Snapshot 3: Maturing economy" \
  --private-key "$DEPLOYER_PK" "$ORACLE" \
  "takeSnapshot(uint256,uint256,uint256,uint256,uint256,uint256,uint256)" \
  6 12 8 8 1550000000000000 6 1730000000000000

send_tx "Snapshot 4: Stable growth" \
  --private-key "$DEPLOYER_PK" "$ORACLE" \
  "takeSnapshot(uint256,uint256,uint256,uint256,uint256,uint256,uint256)" \
  6 12 8 8 1550000000000000 6 2100000000000000

send_tx "Snapshot 5: Peak activity" \
  --private-key "$DEPLOYER_PK" "$ORACLE" \
  "takeSnapshot(uint256,uint256,uint256,uint256,uint256,uint256,uint256)" \
  6 12 8 8 1550000000000000 6 2500000000000000

echo ""

# ===========================================
# SUMMARY
# ===========================================
echo "============================================"
echo "  SIMULATION COMPLETE"
echo "============================================"
echo "Total transactions: $TX_COUNT"
echo ""
echo "Final state:"
echo "  Listings:  $($CAST call "$MARKETPLACE" 'getListingCount()(uint256)' --rpc-url "$RPC")"
echo "  Requests:  $($CAST call "$MARKETPLACE" 'getRequestCount()(uint256)' --rpc-url "$RPC")"
echo "  Matches:   $($CAST call "$MARKETPLACE" 'totalMatches()(uint256)' --rpc-url "$RPC")"
echo "  Escrows:   $($CAST call "$ESCROW" 'getEscrowCount()(uint256)' --rpc-url "$RPC")"
echo "  Settled:   $($CAST call "$ESCROW" 'totalSettled()(uint256)' --rpc-url "$RPC")"
echo "  Snapshots: $($CAST call "$ORACLE" 'snapshotCount()(uint256)' --rpc-url "$RPC")"
echo "  Treasury deposits: $($CAST call "$TREASURY" 'totalDeposits()(uint256)' --rpc-url "$RPC")"
echo "  Treasury earnings: $($CAST call "$TREASURY" 'totalEarnings()(uint256)' --rpc-url "$RPC")"
echo ""
echo "Done!"
