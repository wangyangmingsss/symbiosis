// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IAgentRegistry {
    enum AgentType { DataProvider, Trader, Analyst, LiquidityManager, SecurityAuditor, Arbitrageur }

    struct AgentProfile {
        address agentAddress;
        bytes32 agentId;
        AgentType agentType;
        string metadataURI;
        uint256 registeredAt;
        uint256 stakeAmount;
        bool isActive;
    }

    event AgentRegistered(address indexed agent, bytes32 indexed agentId, AgentType agentType, uint256 stake);
    event AgentDeregistered(address indexed agent, bytes32 indexed agentId);
    event CapabilitiesUpdated(address indexed agent, string newURI);
    event StakeSlashed(address indexed agent, uint256 amount);

    function registerAgent(AgentType agentType, string calldata metadataURI) external payable;
    function deregisterAgent() external;
    function updateCapabilities(string calldata newMetadataURI) external;
    function discoverAgents(AgentType agentType) external view returns (address[] memory);
    function getAgentProfile(address agent) external view returns (AgentProfile memory);
    function isRegistered(address agent) external view returns (bool);
    function getAgentCount() external view returns (uint256);
}
