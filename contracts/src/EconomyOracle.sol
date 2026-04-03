// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title EconomyOracle - Aggregated economy metrics and health monitoring
/// @notice Single entry point to read the entire SYMBIOSIS economy state
/// @dev Reads from all other contracts to provide dashboard-friendly data
contract EconomyOracle {
    // Contract references
    address public registry;
    address public marketplace;
    address public escrow;
    address public reputation;
    address public treasury;
    address public owner;

    // Economy snapshots (updated periodically by any agent)
    struct EconomySnapshot {
        uint256 timestamp;
        uint256 activeAgents;
        uint256 totalListings;
        uint256 totalRequests;
        uint256 totalMatches;
        uint256 totalEscrowVolume;
        uint256 totalSettled;
        uint256 gdp;
    }

    EconomySnapshot[] public snapshots;
    uint256 public snapshotCount;

    event SnapshotTaken(uint256 indexed snapshotId, uint256 timestamp, uint256 gdp);
    event EconomyMilestone(string milestone, uint256 value);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(
        address _registry,
        address _marketplace,
        address _escrow,
        address _reputation,
        address _treasury
    ) {
        registry = _registry;
        marketplace = _marketplace;
        escrow = _escrow;
        reputation = _reputation;
        treasury = _treasury;
        owner = msg.sender;
    }

    /// @notice Take a snapshot of current economy state
    /// @dev Can be called by any agent; creates an on-chain record
    function takeSnapshot(
        uint256 activeAgents,
        uint256 totalListings,
        uint256 totalRequests,
        uint256 totalMatches,
        uint256 totalEscrowVolume,
        uint256 totalSettled,
        uint256 gdp
    ) external {
        uint256 snapshotId = snapshots.length;

        snapshots.push(EconomySnapshot({
            timestamp: block.timestamp,
            activeAgents: activeAgents,
            totalListings: totalListings,
            totalRequests: totalRequests,
            totalMatches: totalMatches,
            totalEscrowVolume: totalEscrowVolume,
            totalSettled: totalSettled,
            gdp: gdp
        }));

        snapshotCount++;

        emit SnapshotTaken(snapshotId, block.timestamp, gdp);

        // Emit milestones
        if (totalMatches == 100) emit EconomyMilestone("100_MATCHES", totalMatches);
        if (totalMatches == 1000) emit EconomyMilestone("1000_MATCHES", totalMatches);
        if (gdp >= 1e6) emit EconomyMilestone("GDP_1M_MICRO_USDT", gdp); // 1 USDT in 6 decimals
    }

    /// @notice Get latest snapshot
    function getLatestSnapshot() external view returns (EconomySnapshot memory) {
        require(snapshots.length > 0, "NO_SNAPSHOTS");
        return snapshots[snapshots.length - 1];
    }

    /// @notice Get snapshot by index
    function getSnapshot(uint256 index) external view returns (EconomySnapshot memory) {
        require(index < snapshots.length, "INVALID_INDEX");
        return snapshots[index];
    }

    /// @notice Get economy growth rate (GDP change between last two snapshots)
    function getGrowthRate() external view returns (int256) {
        if (snapshots.length < 2) return 0;
        EconomySnapshot storage latest = snapshots[snapshots.length - 1];
        EconomySnapshot storage previous = snapshots[snapshots.length - 2];

        if (previous.gdp == 0) return int256(latest.gdp);
        return int256(latest.gdp) - int256(previous.gdp);
    }
}
