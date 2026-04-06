// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/AgentRegistry.sol";
import "../src/ReputationEngine.sol";
import "../src/ServiceMarketplace.sol";
import "../src/EscrowSettlement.sol";
import "../src/AgentTreasury.sol";
import "../src/EconomyOracle.sol";

contract SymbiosisTest is Test {
    AgentRegistry registry;
    ReputationEngine reputation;
    ServiceMarketplace marketplace;
    EscrowSettlement escrow;
    AgentTreasury treasury;
    EconomyOracle oracle;

    address agent1 = address(1);
    address agent2 = address(2);
    address agent3 = address(3);
    address agent4 = address(4);
    address agent5 = address(5);
    address agent6 = address(6);
    address deployer;

    uint256 constant STAKE = 0.05 ether;
    uint256 constant MIN_STAKE = 0.01 ether;
    bytes32 constant MARKET_DATA = keccak256("MARKET_DATA");
    bytes32 constant ALPHA_SIGNAL = keccak256("ALPHA_SIGNAL");
    bytes32 constant TRADE_EXECUTION = keccak256("TRADE_EXECUTION");

    function setUp() public {
        deployer = address(this);

        // Deploy all contracts
        registry = new AgentRegistry();
        reputation = new ReputationEngine();
        marketplace = new ServiceMarketplace(address(registry));
        escrow = new EscrowSettlement(address(reputation));
        treasury = new AgentTreasury();
        oracle = new EconomyOracle(
            address(registry),
            address(marketplace),
            address(escrow),
            address(reputation),
            address(treasury)
        );

        // Wire contracts together
        registry.setMarketplace(address(marketplace));
        reputation.setAuthorized(address(escrow), true);
        reputation.setAuthorized(address(marketplace), true);
        reputation.setAuthorized(deployer, true);
        marketplace.setEscrow(address(escrow));
        marketplace.setReputation(address(reputation));
        escrow.setMarketplace(address(marketplace));
        treasury.setEscrow(address(escrow));

        // Fund test agents
        vm.deal(agent1, 10 ether);
        vm.deal(agent2, 10 ether);
        vm.deal(agent3, 10 ether);
        vm.deal(agent4, 10 ether);
        vm.deal(agent5, 10 ether);
        vm.deal(agent6, 10 ether);
    }

    // =====================================================================
    //  HELPERS
    // =====================================================================

    function _registerAgent(address agent, IAgentRegistry.AgentType t, string memory uri) internal {
        vm.prank(agent);
        registry.registerAgent{value: STAKE}(t, uri);
    }

    function _registerDefaultAgents() internal {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://agent1");
        _registerAgent(agent2, IAgentRegistry.AgentType.Trader, "ipfs://agent2");
        _registerAgent(agent3, IAgentRegistry.AgentType.Analyst, "ipfs://agent3");
        _registerAgent(agent4, IAgentRegistry.AgentType.LiquidityManager, "ipfs://agent4");
        _registerAgent(agent5, IAgentRegistry.AgentType.SecurityAuditor, "ipfs://agent5");
        _registerAgent(agent6, IAgentRegistry.AgentType.Arbitrageur, "ipfs://agent6");
    }

    // =====================================================================
    //  1. AGENT REGISTRY TESTS
    // =====================================================================

    function test_Registry_RegisterAgent() public {
        vm.prank(agent1);
        registry.registerAgent{value: STAKE}(IAgentRegistry.AgentType.DataProvider, "ipfs://agent1");

        assertTrue(registry.isRegistered(agent1));
        assertEq(registry.getAgentCount(), 1);

        IAgentRegistry.AgentProfile memory p = registry.getAgentProfile(agent1);
        assertEq(p.agentAddress, agent1);
        assertTrue(p.isActive);
        assertEq(p.stakeAmount, STAKE);
        assertEq(uint8(p.agentType), uint8(IAgentRegistry.AgentType.DataProvider));
    }

    function test_Registry_RegisterRevertsIfAlreadyRegistered() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        vm.prank(agent1);
        vm.expectRevert("ALREADY_REGISTERED");
        registry.registerAgent{value: STAKE}(IAgentRegistry.AgentType.Trader, "ipfs://a1b");
    }

    function test_Registry_RegisterRevertsInsufficientStake() public {
        vm.prank(agent1);
        vm.expectRevert("INSUFFICIENT_STAKE");
        registry.registerAgent{value: 0.001 ether}(IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
    }

    function test_Registry_RegisterRevertsEmptyURI() public {
        vm.prank(agent1);
        vm.expectRevert("EMPTY_URI");
        registry.registerAgent{value: STAKE}(IAgentRegistry.AgentType.DataProvider, "");
    }

    function test_Registry_Deregister() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        uint256 balBefore = agent1.balance;

        vm.prank(agent1);
        registry.deregisterAgent();

        assertFalse(registry.isRegistered(agent1));
        assertEq(registry.getAgentCount(), 0);
        assertEq(agent1.balance, balBefore + STAKE);
    }

    function test_Registry_DeregisterRevertsIfNotRegistered() public {
        vm.prank(agent1);
        vm.expectRevert("NOT_REGISTERED");
        registry.deregisterAgent();
    }

    function test_Registry_DiscoverAgents() public {
        _registerDefaultAgents();
        address[] memory dataProviders = registry.discoverAgents(IAgentRegistry.AgentType.DataProvider);
        assertEq(dataProviders.length, 1);
        assertEq(dataProviders[0], agent1);

        address[] memory traders = registry.discoverAgents(IAgentRegistry.AgentType.Trader);
        assertEq(traders.length, 1);
        assertEq(traders[0], agent2);
    }

    function test_Registry_DiscoverExcludesDeregistered() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        _registerAgent(agent2, IAgentRegistry.AgentType.DataProvider, "ipfs://a2");

        vm.prank(agent1);
        registry.deregisterAgent();

        address[] memory providers = registry.discoverAgents(IAgentRegistry.AgentType.DataProvider);
        assertEq(providers.length, 1);
        assertEq(providers[0], agent2);
    }

    function test_Registry_UpdateCapabilities() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://old");
        vm.prank(agent1);
        registry.updateCapabilities("ipfs://new");

        IAgentRegistry.AgentProfile memory p = registry.getAgentProfile(agent1);
        assertEq(p.metadataURI, "ipfs://new");
    }

    function test_Registry_UpdateCapabilitiesRevertsEmptyURI() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a");
        vm.prank(agent1);
        vm.expectRevert("EMPTY_URI");
        registry.updateCapabilities("");
    }

    function test_Registry_SlashStake() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        uint256 ownerBalBefore = deployer.balance;

        registry.slashStake(agent1, 0.02 ether);

        IAgentRegistry.AgentProfile memory p = registry.getAgentProfile(agent1);
        assertEq(p.stakeAmount, STAKE - 0.02 ether);
        assertEq(deployer.balance, ownerBalBefore + 0.02 ether);
    }

    function test_Registry_SlashStakeCapsAtStakeAmount() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        registry.slashStake(agent1, 100 ether);

        IAgentRegistry.AgentProfile memory p = registry.getAgentProfile(agent1);
        assertEq(p.stakeAmount, 0);
    }

    function test_Registry_GetAllAgents() public {
        _registerDefaultAgents();
        address[] memory all = registry.getAllAgents();
        assertEq(all.length, 6);
    }

    function test_Registry_TransferOwnership() public {
        registry.transferOwnership(agent1);
        assertEq(registry.owner(), agent1);
    }

    function test_Registry_TransferOwnershipRevertsZero() public {
        vm.expectRevert("ZERO_ADDRESS");
        registry.transferOwnership(address(0));
    }

    // =====================================================================
    //  2. REPUTATION ENGINE TESTS
    // =====================================================================

    function test_Reputation_RecordCompletion() public {
        reputation.recordCompletion(agent1, MARKET_DATA, 10, 1000);

        IReputationEngine.ReputationScore memory s = reputation.getFullScore(agent1);
        assertGt(s.totalScore, 1000); // should increase from base
        assertEq(s.completedServices, 1);
        assertEq(s.totalVolumeUSDT, 1000);
        assertEq(s.avgResponseBlocks, 10);
    }

    function test_Reputation_RecordFailure() public {
        // First give agent a score
        reputation.recordCompletion(agent1, MARKET_DATA, 5, 500);
        uint256 scoreBefore = reputation.getReputation(agent1);

        reputation.recordFailure(agent1, MARKET_DATA);

        uint256 scoreAfter = reputation.getReputation(agent1);
        assertLt(scoreAfter, scoreBefore);

        IReputationEngine.ReputationScore memory s = reputation.getFullScore(agent1);
        assertEq(s.failedServices, 1);
    }

    function test_Reputation_ELOScoring_MultipleWins() public {
        uint256 prevScore = 1000;
        for (uint256 i = 0; i < 5; i++) {
            reputation.recordCompletion(agent1, MARKET_DATA, 5, 100);
        }
        uint256 finalScore = reputation.getReputation(agent1);
        assertGt(finalScore, prevScore);
    }

    function test_Reputation_TopAgents() public {
        // agent1 gets 5 completions, agent2 gets 2, agent3 gets 1
        for (uint256 i = 0; i < 5; i++) {
            reputation.recordCompletion(agent1, MARKET_DATA, 5, 100);
        }
        for (uint256 i = 0; i < 2; i++) {
            reputation.recordCompletion(agent2, MARKET_DATA, 5, 100);
        }
        reputation.recordCompletion(agent3, MARKET_DATA, 5, 100);

        (address[] memory topAddr, uint256[] memory topScores) = reputation.getTopAgents(2);
        assertEq(topAddr.length, 2);
        assertEq(topAddr[0], agent1);
        assertGt(topScores[0], topScores[1]);
    }

    function test_Reputation_CategoryReputation() public {
        reputation.recordCompletion(agent1, MARKET_DATA, 5, 100);
        reputation.recordCompletion(agent1, ALPHA_SIGNAL, 3, 200);

        uint256 catMarket = reputation.getCategoryReputation(agent1, MARKET_DATA);
        uint256 catAlpha = reputation.getCategoryReputation(agent1, ALPHA_SIGNAL);
        assertGt(catMarket, 1000);
        assertGt(catAlpha, 1000);
    }

    function test_Reputation_SlashReputation() public {
        reputation.recordCompletion(agent1, MARKET_DATA, 5, 100);
        uint256 scoreBefore = reputation.getReputation(agent1);

        reputation.slashReputation(agent1, 1000); // 10%

        uint256 scoreAfter = reputation.getReputation(agent1);
        assertLt(scoreAfter, scoreBefore);
    }

    function test_Reputation_GetReputationDefaultBase() public {
        // Agent with no interactions should return base rating
        uint256 score = reputation.getReputation(agent1);
        assertEq(score, 1000);
    }

    function test_Reputation_AvgResponseBlocksEMA() public {
        reputation.recordCompletion(agent1, MARKET_DATA, 100, 100);
        reputation.recordCompletion(agent1, MARKET_DATA, 50, 100);

        IReputationEngine.ReputationScore memory s = reputation.getFullScore(agent1);
        // EMA: (100 * 80 + 50 * 20) / 100 = 90
        assertEq(s.avgResponseBlocks, 90);
    }

    // =====================================================================
    //  3. SERVICE MARKETPLACE TESTS
    // =====================================================================

    function test_Marketplace_ListService() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");

        vm.prank(agent1);
        uint256 listingId = marketplace.listService(MARKET_DATA, 1 ether, 0.1 ether, 0.01 ether, 10);

        assertEq(listingId, 0);
        assertEq(marketplace.getListingCount(), 1);

        IServiceMarketplace.ServiceListing memory l = marketplace.getListing(0);
        assertEq(l.provider, agent1);
        assertEq(l.startPrice, 1 ether);
        assertEq(l.floorPrice, 0.1 ether);
        assertTrue(l.isActive);
    }

    function test_Marketplace_ListServiceRevertsNotRegistered() public {
        vm.prank(agent1);
        vm.expectRevert("NOT_REGISTERED");
        marketplace.listService(MARKET_DATA, 1 ether, 0.1 ether, 0.01 ether, 10);
    }

    function test_Marketplace_ListServiceRevertsStartBelowFloor() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        vm.prank(agent1);
        vm.expectRevert("START_BELOW_FLOOR");
        marketplace.listService(MARKET_DATA, 0.05 ether, 0.1 ether, 0.01 ether, 10);
    }

    function test_Marketplace_DutchAuctionPriceDecay() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");

        vm.prank(agent1);
        marketplace.listService(MARKET_DATA, 1 ether, 0.1 ether, 0.01 ether, 10);

        uint256 priceAtStart = marketplace.getCurrentPrice(0);
        assertEq(priceAtStart, 1 ether);

        // Advance 10 blocks => price should drop by 0.1 ether
        vm.roll(block.number + 10);
        uint256 priceAfter10 = marketplace.getCurrentPrice(0);
        assertEq(priceAfter10, 0.9 ether);

        // Advance enough blocks to reach floor
        vm.roll(block.number + 1000);
        uint256 priceFloor = marketplace.getCurrentPrice(0);
        assertEq(priceFloor, 0.1 ether);
    }

    function test_Marketplace_RequestService() public {
        _registerAgent(agent2, IAgentRegistry.AgentType.Trader, "ipfs://a2");

        vm.prank(agent2);
        uint256 reqId = marketplace.requestService(MARKET_DATA, 1 ether, block.number + 100);

        assertEq(reqId, 0);
        assertEq(marketplace.getRequestCount(), 1);

        IServiceMarketplace.ServiceRequest memory r = marketplace.getRequest(0);
        assertEq(r.requester, agent2);
        assertEq(r.maxBudget, 1 ether);
        assertEq(uint8(r.status), uint8(IServiceMarketplace.RequestStatus.Open));
    }

    function test_Marketplace_AcceptRequest() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        _registerAgent(agent2, IAgentRegistry.AgentType.Trader, "ipfs://a2");

        vm.prank(agent1);
        marketplace.listService(MARKET_DATA, 0.5 ether, 0.1 ether, 0.001 ether, 5);

        vm.prank(agent2);
        marketplace.requestService(MARKET_DATA, 1 ether, block.number + 100);

        vm.prank(agent1);
        marketplace.acceptRequest(0, 0);

        IServiceMarketplace.ServiceRequest memory r = marketplace.getRequest(0);
        assertEq(r.assignedProvider, agent1);
        assertEq(uint8(r.status), uint8(IServiceMarketplace.RequestStatus.Assigned));
        assertEq(marketplace.totalMatches(), 1);
    }

    function test_Marketplace_CompleteService() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        _registerAgent(agent2, IAgentRegistry.AgentType.Trader, "ipfs://a2");

        vm.prank(agent1);
        marketplace.listService(MARKET_DATA, 0.5 ether, 0.1 ether, 0.001 ether, 5);
        vm.prank(agent2);
        marketplace.requestService(MARKET_DATA, 1 ether, block.number + 100);
        vm.prank(agent1);
        marketplace.acceptRequest(0, 0);

        vm.prank(agent1);
        marketplace.completeService(0, keccak256("proof"));

        IServiceMarketplace.ServiceRequest memory r = marketplace.getRequest(0);
        assertEq(uint8(r.status), uint8(IServiceMarketplace.RequestStatus.Completed));
        assertEq(marketplace.totalCompletions(), 1);
    }

    function test_Marketplace_DisputeService() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        _registerAgent(agent2, IAgentRegistry.AgentType.Trader, "ipfs://a2");

        vm.prank(agent1);
        marketplace.listService(MARKET_DATA, 0.5 ether, 0.1 ether, 0.001 ether, 5);
        vm.prank(agent2);
        marketplace.requestService(MARKET_DATA, 1 ether, block.number + 100);
        vm.prank(agent1);
        marketplace.acceptRequest(0, 0);

        vm.prank(agent2);
        marketplace.disputeService(0);

        IServiceMarketplace.ServiceRequest memory r = marketplace.getRequest(0);
        assertEq(uint8(r.status), uint8(IServiceMarketplace.RequestStatus.Disputed));
    }

    function test_Marketplace_FindBestListing() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        _registerAgent(agent3, IAgentRegistry.AgentType.Analyst, "ipfs://a3");

        // agent1 lists at 1 ether start, agent3 lists at 0.5 ether start (same type)
        vm.prank(agent1);
        marketplace.listService(MARKET_DATA, 1 ether, 0.1 ether, 0.01 ether, 0);
        vm.prank(agent3);
        marketplace.listService(MARKET_DATA, 0.5 ether, 0.05 ether, 0.005 ether, 0);

        (uint256 bestId, uint256 bestPrice) = marketplace.findBestListing(MARKET_DATA);
        assertEq(bestId, 1); // agent3's listing is cheaper
        assertEq(bestPrice, 0.5 ether);
    }

    function test_Marketplace_CancelListing() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        vm.prank(agent1);
        marketplace.listService(MARKET_DATA, 1 ether, 0.1 ether, 0.01 ether, 0);

        vm.prank(agent1);
        marketplace.cancelListing(0);

        IServiceMarketplace.ServiceListing memory l = marketplace.getListing(0);
        assertFalse(l.isActive);
    }

    function test_Marketplace_CancelRequest() public {
        _registerAgent(agent2, IAgentRegistry.AgentType.Trader, "ipfs://a2");
        vm.prank(agent2);
        marketplace.requestService(MARKET_DATA, 1 ether, block.number + 100);

        vm.prank(agent2);
        marketplace.cancelRequest(0);

        IServiceMarketplace.ServiceRequest memory r = marketplace.getRequest(0);
        assertEq(uint8(r.status), uint8(IServiceMarketplace.RequestStatus.Cancelled));
    }

    function test_Marketplace_AcceptRevertsTypeMismatch() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        _registerAgent(agent2, IAgentRegistry.AgentType.Trader, "ipfs://a2");

        vm.prank(agent1);
        marketplace.listService(MARKET_DATA, 0.5 ether, 0.1 ether, 0.001 ether, 5);
        vm.prank(agent2);
        marketplace.requestService(ALPHA_SIGNAL, 1 ether, block.number + 100);

        vm.prank(agent1);
        vm.expectRevert("TYPE_MISMATCH");
        marketplace.acceptRequest(0, 0);
    }

    // =====================================================================
    //  4. ESCROW SETTLEMENT TESTS
    // =====================================================================

    function test_Escrow_CreateEscrow() public {
        vm.prank(agent1);
        uint256 eid = escrow.createEscrow{value: 1 ether}(0, agent2, 1 ether, 3600);

        assertEq(eid, 0);
        assertEq(escrow.getEscrowCount(), 1);
        assertEq(escrow.totalEscrowsCreated(), 1);
        assertEq(escrow.totalEscrowVolume(), 1 ether);

        IEscrowSettlement.Escrow memory e = escrow.getEscrow(0);
        assertEq(e.buyer, agent1);
        assertEq(e.seller, agent2);
        assertEq(e.amount, 1 ether);
        assertEq(uint8(e.status), uint8(IEscrowSettlement.EscrowStatus.Funded));
    }

    function test_Escrow_CreateRevertsInsufficientDeposit() public {
        vm.prank(agent1);
        vm.expectRevert("INSUFFICIENT_DEPOSIT");
        escrow.createEscrow{value: 0.5 ether}(0, agent2, 1 ether, 3600);
    }

    function test_Escrow_CreateRevertsSelfEscrow() public {
        vm.prank(agent1);
        vm.expectRevert("SELF_ESCROW");
        escrow.createEscrow{value: 1 ether}(0, agent1, 1 ether, 3600);
    }

    function test_Escrow_ReleaseEscrow() public {
        vm.prank(agent1);
        escrow.createEscrow{value: 1 ether}(0, agent2, 1 ether, 3600);

        uint256 sellerBalBefore = agent2.balance;

        vm.prank(agent1);
        escrow.releaseEscrow(0);

        IEscrowSettlement.Escrow memory e = escrow.getEscrow(0);
        assertEq(uint8(e.status), uint8(IEscrowSettlement.EscrowStatus.Released));
        assertEq(agent2.balance, sellerBalBefore + 1 ether);
        assertEq(escrow.totalSettled(), 1);
    }

    function test_Escrow_RefundEscrow() public {
        vm.prank(agent1);
        escrow.createEscrow{value: 1 ether}(0, agent2, 1 ether, 3600);

        uint256 buyerBalBefore = agent1.balance;

        vm.prank(agent1);
        escrow.refundEscrow(0);

        IEscrowSettlement.Escrow memory e = escrow.getEscrow(0);
        assertEq(uint8(e.status), uint8(IEscrowSettlement.EscrowStatus.Refunded));
        assertEq(agent1.balance, buyerBalBefore + 1 ether);
    }

    function test_Escrow_RefundAfterExpiry() public {
        vm.prank(agent1);
        escrow.createEscrow{value: 1 ether}(0, agent2, 1 ether, 100);

        // Warp past expiry
        vm.warp(block.timestamp + 200);

        // Anyone can refund after expiry
        vm.prank(agent3);
        escrow.refundEscrow(0);

        IEscrowSettlement.Escrow memory e = escrow.getEscrow(0);
        assertEq(uint8(e.status), uint8(IEscrowSettlement.EscrowStatus.Refunded));
    }

    function test_Escrow_BatchSettle() public {
        vm.prank(agent1);
        escrow.createEscrow{value: 0.5 ether}(0, agent2, 0.5 ether, 3600);
        vm.prank(agent1);
        escrow.createEscrow{value: 0.3 ether}(1, agent2, 0.3 ether, 3600);

        uint256 sellerBalBefore = agent2.balance;

        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;

        vm.prank(agent1);
        escrow.batchSettle(ids);

        assertEq(agent2.balance, sellerBalBefore + 0.8 ether);
        assertEq(escrow.totalSettled(), 2);
    }

    function test_Escrow_MicroPaymentTab() public {
        // Add to tab
        vm.prank(agent1);
        escrow.addToTab(agent2, 100);
        vm.prank(agent1);
        escrow.addToTab(agent2, 200);

        EscrowSettlement.PaymentTab memory tab = escrow.getTab(agent1, agent2);
        assertEq(tab.accumulated, 300);
        assertEq(tab.transactionCount, 2);

        // Settle the tab
        uint256 sellerBal = agent2.balance;
        vm.prank(agent1);
        escrow.settleTab{value: 300}(agent2);

        tab = escrow.getTab(agent1, agent2);
        assertEq(tab.accumulated, 0);
        assertEq(tab.transactionCount, 0);
        assertEq(agent2.balance, sellerBal + 300);
    }

    function test_Escrow_ExcessRefundOnCreate() public {
        uint256 balBefore = agent1.balance;
        vm.prank(agent1);
        escrow.createEscrow{value: 2 ether}(0, agent2, 1 ether, 3600);

        // Should have refunded 1 ether excess
        assertEq(agent1.balance, balBefore - 1 ether);
    }

    function test_Escrow_ReleaseUpdatesReputation() public {
        vm.prank(agent1);
        escrow.createEscrow{value: 1 ether}(0, agent2, 1 ether, 3600);

        vm.prank(agent1);
        escrow.releaseEscrow(0);

        // seller's reputation should be updated
        IReputationEngine.ReputationScore memory s = reputation.getFullScore(agent2);
        assertEq(s.completedServices, 1);
        assertGt(s.totalScore, 1000);
    }

    // =====================================================================
    //  5. AGENT TREASURY TESTS
    // =====================================================================

    function test_Treasury_Deposit() public {
        vm.prank(agent1);
        treasury.deposit{value: 1 ether}();

        assertEq(treasury.getBalance(agent1), 1 ether);
        assertEq(treasury.totalDeposits(), 1 ether);
        assertEq(treasury.getAgentCount(), 1);
    }

    function test_Treasury_DepositRevertsZero() public {
        vm.prank(agent1);
        vm.expectRevert("ZERO_DEPOSIT");
        treasury.deposit{value: 0}();
    }

    function test_Treasury_Withdraw() public {
        vm.prank(agent1);
        treasury.deposit{value: 2 ether}();

        uint256 balBefore = agent1.balance;
        vm.prank(agent1);
        treasury.withdraw(1 ether);

        assertEq(treasury.getBalance(agent1), 1 ether);
        assertEq(agent1.balance, balBefore + 1 ether);
    }

    function test_Treasury_WithdrawRevertsInsufficient() public {
        vm.prank(agent1);
        treasury.deposit{value: 1 ether}();

        vm.prank(agent1);
        vm.expectRevert("INSUFFICIENT_BALANCE");
        treasury.withdraw(2 ether);
    }

    function test_Treasury_CreditEarnings() public {
        vm.prank(agent1);
        treasury.deposit{value: 1 ether}();

        // Owner can credit
        treasury.creditEarnings(agent1, 0.5 ether);

        assertEq(treasury.getBalance(agent1), 1.5 ether);
        assertEq(treasury.totalEarnings(), 0.5 ether);
    }

    function test_Treasury_DebitSpending() public {
        vm.prank(agent1);
        treasury.deposit{value: 2 ether}();

        treasury.debitSpending(agent1, 0.5 ether);

        assertEq(treasury.getBalance(agent1), 1.5 ether);
        assertEq(treasury.totalSpending(), 0.5 ether);
    }

    function test_Treasury_PnL() public {
        vm.prank(agent1);
        treasury.deposit{value: 1 ether}();

        treasury.creditEarnings(agent1, 2 ether);
        treasury.debitSpending(agent1, 0.5 ether);

        int256 pnl = treasury.getPnL(agent1);
        assertEq(pnl, 1.5 ether);
    }

    function test_Treasury_GDP() public {
        treasury.creditEarnings(agent1, 1 ether);
        treasury.creditEarnings(agent2, 2 ether);

        assertEq(treasury.getGDP(), 3 ether);
    }

    function test_Treasury_GetAllAgents() public {
        vm.prank(agent1);
        treasury.deposit{value: 1 ether}();
        vm.prank(agent2);
        treasury.deposit{value: 1 ether}();

        address[] memory agents = treasury.getAllAgents();
        assertEq(agents.length, 2);
    }

    // =====================================================================
    //  6. ECONOMY ORACLE TESTS
    // =====================================================================

    function test_Oracle_TakeSnapshot() public {
        oracle.takeSnapshot(5, 10, 8, 3, 1000, 2, 500);

        assertEq(oracle.snapshotCount(), 1);
        EconomyOracle.EconomySnapshot memory snap = oracle.getLatestSnapshot();
        assertEq(snap.activeAgents, 5);
        assertEq(snap.gdp, 500);
    }

    function test_Oracle_GrowthRate() public {
        oracle.takeSnapshot(5, 10, 8, 3, 1000, 2, 500);
        oracle.takeSnapshot(6, 12, 10, 5, 2000, 4, 800);

        int256 growth = oracle.getGrowthRate();
        assertEq(growth, 300); // 800 - 500
    }

    function test_Oracle_GrowthRateNoSnapshots() public {
        int256 growth = oracle.getGrowthRate();
        assertEq(growth, 0);
    }

    function test_Oracle_GetSnapshotByIndex() public {
        oracle.takeSnapshot(1, 2, 3, 4, 5, 6, 7);
        oracle.takeSnapshot(10, 20, 30, 40, 50, 60, 70);

        EconomyOracle.EconomySnapshot memory s = oracle.getSnapshot(0);
        assertEq(s.activeAgents, 1);

        EconomyOracle.EconomySnapshot memory s2 = oracle.getSnapshot(1);
        assertEq(s2.activeAgents, 10);
    }

    function test_Oracle_LatestRevertsNoSnapshots() public {
        vm.expectRevert("NO_SNAPSHOTS");
        oracle.getLatestSnapshot();
    }

    // =====================================================================
    //  7. INTEGRATION TEST
    // =====================================================================

    function test_Integration_FullEconomicCycle() public {
        // Step 1: Register agents
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://provider");
        _registerAgent(agent2, IAgentRegistry.AgentType.Trader, "ipfs://consumer");
        assertEq(registry.getAgentCount(), 2);

        // Step 2: Provider lists a service
        vm.prank(agent1);
        uint256 listingId = marketplace.listService(MARKET_DATA, 1 ether, 0.1 ether, 0.01 ether, 5);

        // Step 3: Consumer requests a service
        vm.prank(agent2);
        uint256 requestId = marketplace.requestService(MARKET_DATA, 2 ether, block.number + 100);

        // Step 4: Provider accepts the request
        vm.prank(agent1);
        marketplace.acceptRequest(requestId, listingId);

        IServiceMarketplace.ServiceRequest memory req = marketplace.getRequest(requestId);
        assertEq(req.assignedProvider, agent1);

        // Step 5: Consumer creates escrow
        uint256 price = 1 ether; // current price at start
        vm.prank(agent2);
        uint256 escrowId = escrow.createEscrow{value: price}(requestId, agent1, price, 3600);

        // Step 6: Provider completes the service
        vm.prank(agent1);
        marketplace.completeService(requestId, keccak256("proof_data"));

        // Step 7: Consumer releases escrow (payment + reputation update)
        uint256 providerBalBefore = agent1.balance;
        vm.prank(agent2);
        escrow.releaseEscrow(escrowId);

        // Verify payment
        assertEq(agent1.balance, providerBalBefore + price);

        // Verify reputation was updated
        IReputationEngine.ReputationScore memory score = reputation.getFullScore(agent1);
        assertEq(score.completedServices, 1);
        assertGt(score.totalScore, 1000);
        assertEq(score.totalVolumeUSDT, price);

        // Step 8: Take economy snapshot
        oracle.takeSnapshot(
            registry.getAgentCount(),
            marketplace.getListingCount(),
            marketplace.getRequestCount(),
            marketplace.totalMatches(),
            escrow.totalEscrowVolume(),
            escrow.totalSettled(),
            treasury.getGDP()
        );

        EconomyOracle.EconomySnapshot memory snap = oracle.getLatestSnapshot();
        assertEq(snap.activeAgents, 2);
        assertEq(snap.totalMatches, 1);
        assertEq(snap.totalSettled, 1);
    }

    function test_Integration_MultiAgentMarketWithDispute() public {
        // Register multiple providers and a consumer
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://p1");
        _registerAgent(agent3, IAgentRegistry.AgentType.Analyst, "ipfs://p2");
        _registerAgent(agent2, IAgentRegistry.AgentType.Trader, "ipfs://consumer");

        // Two providers list the same service type
        vm.prank(agent1);
        marketplace.listService(MARKET_DATA, 1 ether, 0.2 ether, 0.01 ether, 3);
        vm.prank(agent3);
        marketplace.listService(MARKET_DATA, 0.8 ether, 0.1 ether, 0.005 ether, 3);

        // Consumer finds best listing
        (uint256 bestId, uint256 bestPrice) = marketplace.findBestListing(MARKET_DATA);
        assertEq(bestId, 1); // agent3's listing is cheaper

        // Consumer requests service
        vm.prank(agent2);
        uint256 reqId = marketplace.requestService(MARKET_DATA, 2 ether, block.number + 100);

        // Best provider accepts
        vm.prank(agent3);
        marketplace.acceptRequest(reqId, bestId);

        // Consumer creates escrow
        vm.prank(agent2);
        uint256 eid = escrow.createEscrow{value: bestPrice}(reqId, agent3, bestPrice, 3600);

        // Consumer disputes
        vm.prank(agent2);
        marketplace.disputeService(reqId);

        // Refund escrow (records failure for seller)
        vm.prank(agent2);
        escrow.refundEscrow(eid);

        // Verify reputation was penalized
        IReputationEngine.ReputationScore memory score = reputation.getFullScore(agent3);
        assertEq(score.failedServices, 1);
        assertLt(score.totalScore, 1000);
    }

    // =====================================================================
    //  8. PAUSABLE TESTS
    // =====================================================================

    function test_Registry_PauseUnpause() public {
        registry.pause();
        assertTrue(registry.paused());

        vm.prank(agent1);
        vm.expectRevert("PAUSED");
        registry.registerAgent{value: STAKE}(IAgentRegistry.AgentType.DataProvider, "ipfs://a1");

        registry.unpause();
        assertFalse(registry.paused());

        vm.prank(agent1);
        registry.registerAgent{value: STAKE}(IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        assertTrue(registry.isRegistered(agent1));
    }

    function test_Registry_PauseOnlyOwner() public {
        vm.prank(agent1);
        vm.expectRevert("NOT_OWNER");
        registry.pause();
    }

    function test_Marketplace_Pause() public {
        marketplace.pause();

        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        vm.prank(agent1);
        vm.expectRevert("PAUSED");
        marketplace.listService(MARKET_DATA, 1 ether, 0.1 ether, 0.01 ether, 10);

        marketplace.unpause();
        vm.prank(agent1);
        marketplace.listService(MARKET_DATA, 1 ether, 0.1 ether, 0.01 ether, 10);
        assertEq(marketplace.getListingCount(), 1);
    }

    function test_Escrow_Pause() public {
        escrow.pause();

        vm.prank(agent1);
        vm.expectRevert("PAUSED");
        escrow.createEscrow{value: 1 ether}(0, agent2, 1 ether, 3600);

        escrow.unpause();
        vm.prank(agent1);
        escrow.createEscrow{value: 1 ether}(0, agent2, 1 ether, 3600);
        assertEq(escrow.getEscrowCount(), 1);
    }

    // =====================================================================
    //  9. DISPUTE RESOLUTION TESTS
    // =====================================================================

    function test_Escrow_ResolveDispute_BuyerWins() public {
        vm.prank(agent1);
        escrow.createEscrow{value: 1 ether}(0, agent2, 1 ether, 3600);

        uint256 buyerBal = agent1.balance;
        uint256 sellerBal = agent2.balance;

        // Owner resolves: 70% to buyer
        escrow.resolveDispute(0, 70);

        assertEq(agent1.balance, buyerBal + 0.7 ether);
        assertEq(agent2.balance, sellerBal + 0.3 ether);

        // Seller should have failure recorded (buyer > 50%)
        IReputationEngine.ReputationScore memory s = reputation.getFullScore(agent2);
        assertEq(s.failedServices, 1);
    }

    function test_Escrow_ResolveDispute_SellerWins() public {
        vm.prank(agent1);
        escrow.createEscrow{value: 1 ether}(0, agent2, 1 ether, 3600);

        uint256 sellerBal = agent2.balance;

        // Owner resolves: 30% to buyer (seller wins)
        escrow.resolveDispute(0, 30);

        assertEq(agent2.balance, sellerBal + 0.7 ether);

        // Seller should have completion recorded
        IReputationEngine.ReputationScore memory s = reputation.getFullScore(agent2);
        assertEq(s.completedServices, 1);
    }

    // =====================================================================
    //  10. GOVERNANCE AGENT TYPE TEST
    // =====================================================================

    function test_Registry_GovernanceAgentType() public {
        vm.deal(address(7), 10 ether);
        vm.prank(address(7));
        registry.registerAgent{value: STAKE}(IAgentRegistry.AgentType.Governance, "ipfs://governance");

        assertTrue(registry.isRegistered(address(7)));

        IAgentRegistry.AgentProfile memory p = registry.getAgentProfile(address(7));
        assertEq(uint8(p.agentType), uint8(IAgentRegistry.AgentType.Governance));

        address[] memory govAgents = registry.discoverAgents(IAgentRegistry.AgentType.Governance);
        assertEq(govAgents.length, 1);
        assertEq(govAgents[0], address(7));
    }

    // =====================================================================
    //  11. EDGE CASE & STRESS TESTS
    // =====================================================================

    function test_Reputation_MultipleFailures_FloorProtection() public {
        // Record many failures - score should never go below floor (100)
        for (uint256 i = 0; i < 20; i++) {
            reputation.recordFailure(agent1, MARKET_DATA);
        }
        uint256 score = reputation.getReputation(agent1);
        assertGe(score, 100); // ELO floor
    }

    function test_Marketplace_MaxFulfillments() public {
        _registerAgent(agent1, IAgentRegistry.AgentType.DataProvider, "ipfs://a1");
        _registerAgent(agent2, IAgentRegistry.AgentType.Trader, "ipfs://a2");

        // List with max 1 fulfillment
        vm.prank(agent1);
        marketplace.listService(MARKET_DATA, 0.5 ether, 0.1 ether, 0.001 ether, 1);

        // First request and accept succeeds
        vm.prank(agent2);
        marketplace.requestService(MARKET_DATA, 1 ether, block.number + 100);
        vm.prank(agent1);
        marketplace.acceptRequest(0, 0);

        // Second request should fail (max fulfillments reached)
        vm.prank(agent2);
        marketplace.requestService(MARKET_DATA, 1 ether, block.number + 100);
        vm.prank(agent1);
        vm.expectRevert("MAX_FULFILLED");
        marketplace.acceptRequest(1, 0);
    }

    function test_Escrow_DoubleRelease_Reverts() public {
        vm.prank(agent1);
        escrow.createEscrow{value: 1 ether}(0, agent2, 1 ether, 3600);

        vm.prank(agent1);
        escrow.releaseEscrow(0);

        vm.prank(agent1);
        vm.expectRevert("NOT_FUNDED");
        escrow.releaseEscrow(0);
    }

    function test_Treasury_NegativePnL() public {
        vm.prank(agent1);
        treasury.deposit{value: 1 ether}();

        treasury.debitSpending(agent1, 2 ether);

        int256 pnl = treasury.getPnL(agent1);
        assertEq(pnl, -2 ether);
    }

    function test_Oracle_MultipleSnapshots_GrowthRate() public {
        oracle.takeSnapshot(5, 10, 8, 3, 1000, 2, 100);
        oracle.takeSnapshot(6, 12, 10, 5, 2000, 4, 200);
        oracle.takeSnapshot(7, 15, 12, 8, 3000, 6, 500);

        int256 growth = oracle.getGrowthRate();
        assertEq(growth, 300); // 500 - 200 (last two snapshots)
    }

    function test_Integration_SevenAgentEconomy() public {
        // Register all 7 agent types including Governance
        _registerDefaultAgents();
        vm.deal(address(7), 10 ether);
        vm.prank(address(7));
        registry.registerAgent{value: STAKE}(IAgentRegistry.AgentType.Governance, "ipfs://governance");

        assertEq(registry.getAgentCount(), 7);

        // DataProvider lists service
        vm.prank(agent1);
        marketplace.listService(MARKET_DATA, 0.5 ether, 0.1 ether, 0.001 ether, 10);

        // Analyst lists signal service
        vm.prank(agent3);
        marketplace.listService(ALPHA_SIGNAL, 0.3 ether, 0.05 ether, 0.001 ether, 10);

        // Trader requests data
        vm.prank(agent2);
        marketplace.requestService(MARKET_DATA, 1 ether, block.number + 100);

        // DataProvider accepts
        vm.prank(agent1);
        marketplace.acceptRequest(0, 0);

        // Create escrow
        vm.prank(agent2);
        uint256 eid = escrow.createEscrow{value: 0.5 ether}(0, agent1, 0.5 ether, 3600);

        // Complete and release
        vm.prank(agent1);
        marketplace.completeService(0, keccak256("data_hash"));
        vm.prank(agent2);
        escrow.releaseEscrow(eid);

        // Verify full flow
        assertEq(marketplace.totalCompletions(), 1);
        assertEq(escrow.totalSettled(), 1);
        assertGt(reputation.getReputation(agent1), 1000);

        // Governance takes snapshot
        vm.prank(address(7));
        oracle.takeSnapshot(7, 2, 1, 1, 0.5 ether, 1, treasury.getGDP());

        assertEq(oracle.snapshotCount(), 1);
    }

    receive() external payable {}
}
