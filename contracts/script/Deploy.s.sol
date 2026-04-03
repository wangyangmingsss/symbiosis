// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/AgentRegistry.sol";
import "../src/ReputationEngine.sol";
import "../src/ServiceMarketplace.sol";
import "../src/EscrowSettlement.sol";
import "../src/AgentTreasury.sol";
import "../src/EconomyOracle.sol";

/// @title Deploy - Deploys the entire SYMBIOSIS economy to X Layer
contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy core identity
        AgentRegistry registry = new AgentRegistry();
        console.log("AgentRegistry:", address(registry));

        // 2. Deploy reputation
        ReputationEngine reputation = new ReputationEngine();
        console.log("ReputationEngine:", address(reputation));

        // 3. Deploy marketplace
        ServiceMarketplace marketplace = new ServiceMarketplace(address(registry));
        console.log("ServiceMarketplace:", address(marketplace));

        // 4. Deploy escrow
        EscrowSettlement escrow = new EscrowSettlement(address(reputation));
        console.log("EscrowSettlement:", address(escrow));

        // 5. Deploy treasury
        AgentTreasury treasury = new AgentTreasury();
        console.log("AgentTreasury:", address(treasury));

        // 6. Deploy economy oracle
        EconomyOracle oracle = new EconomyOracle(
            address(registry),
            address(marketplace),
            address(escrow),
            address(reputation),
            address(treasury)
        );
        console.log("EconomyOracle:", address(oracle));

        // --- Wire up permissions ---
        registry.setMarketplace(address(marketplace));
        marketplace.setEscrow(address(escrow));
        marketplace.setReputation(address(reputation));
        escrow.setMarketplace(address(marketplace));
        treasury.setEscrow(address(escrow));

        // Authorize marketplace and escrow to update reputation
        reputation.setAuthorized(address(marketplace), true);
        reputation.setAuthorized(address(escrow), true);

        console.log("\n=== SYMBIOSIS Economy Deployed ===");
        console.log("Chain ID:", block.chainid);
        console.log("Block:", block.number);

        vm.stopBroadcast();
    }
}
