// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IReputationEngine {
    struct ReputationScore {
        uint256 totalScore;
        uint256 completedServices;
        uint256 failedServices;
        uint256 totalVolumeUSDT;
        uint256 avgResponseBlocks;
        uint256 lastUpdated;
    }

    event ReputationUpdated(address indexed agent, uint256 newScore, uint256 completedServices);
    event ReputationSlashed(address indexed agent, uint256 oldScore, uint256 newScore, uint256 slashAmount);

    function recordCompletion(address agent, bytes32 serviceType, uint256 responseBlocks, uint256 amountUSDT) external;
    function recordFailure(address agent, bytes32 serviceType) external;
    function getReputation(address agent) external view returns (uint256);
    function getCategoryReputation(address agent, bytes32 serviceType) external view returns (uint256);
    function getTopAgents(uint256 count) external view returns (address[] memory, uint256[] memory);
    function getFullScore(address agent) external view returns (ReputationScore memory);
}
