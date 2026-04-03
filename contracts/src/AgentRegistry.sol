// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./interfaces/IAgentRegistry.sol";

/// @title AgentRegistry - On-chain identity and capability registration for AI agents
/// @notice Each agent stakes USDT and registers its type and capabilities
/// @dev Core identity layer of the SYMBIOSIS agent economy
contract AgentRegistry is IAgentRegistry {
    // --- State ---
    mapping(address => AgentProfile) private _profiles;
    mapping(uint8 => address[]) private _agentsByType;
    address[] private _allAgents;

    uint256 public constant MIN_STAKE = 0.01 ether; // 0.01 native token as skin-in-the-game
    uint256 public immutable deployedAt;
    address public owner;
    address public marketplace; // authorized to slash

    // --- Modifiers ---
    modifier onlyRegistered() {
        require(_profiles[msg.sender].isActive, "NOT_REGISTERED");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyAuthorized() {
        require(msg.sender == owner || msg.sender == marketplace, "NOT_AUTHORIZED");
        _;
    }

    constructor() {
        owner = msg.sender;
        deployedAt = block.timestamp;
    }

    // --- Admin ---
    function setMarketplace(address _marketplace) external onlyOwner {
        marketplace = _marketplace;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_ADDRESS");
        owner = newOwner;
    }

    // --- Core Functions ---
    function registerAgent(AgentType agentType, string calldata metadataURI) external payable override {
        require(!_profiles[msg.sender].isActive, "ALREADY_REGISTERED");
        require(msg.value >= MIN_STAKE, "INSUFFICIENT_STAKE");
        require(bytes(metadataURI).length > 0, "EMPTY_URI");

        bytes32 agentId = keccak256(abi.encodePacked(msg.sender, block.timestamp, agentType));

        _profiles[msg.sender] = AgentProfile({
            agentAddress: msg.sender,
            agentId: agentId,
            agentType: agentType,
            metadataURI: metadataURI,
            registeredAt: block.timestamp,
            stakeAmount: msg.value,
            isActive: true
        });

        _agentsByType[uint8(agentType)].push(msg.sender);
        _allAgents.push(msg.sender);

        emit AgentRegistered(msg.sender, agentId, agentType, msg.value);
    }

    function deregisterAgent() external override onlyRegistered {
        AgentProfile storage profile = _profiles[msg.sender];
        profile.isActive = false;

        uint256 refund = profile.stakeAmount;
        profile.stakeAmount = 0;

        // Remove from type array
        _removeFromTypeArray(uint8(profile.agentType), msg.sender);

        emit AgentDeregistered(msg.sender, profile.agentId);

        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            require(ok, "REFUND_FAILED");
        }
    }

    function updateCapabilities(string calldata newMetadataURI) external override onlyRegistered {
        require(bytes(newMetadataURI).length > 0, "EMPTY_URI");
        _profiles[msg.sender].metadataURI = newMetadataURI;
        emit CapabilitiesUpdated(msg.sender, newMetadataURI);
    }

    /// @notice Slash an agent's stake (called by marketplace on dispute loss)
    function slashStake(address agent, uint256 amount) external onlyAuthorized {
        AgentProfile storage profile = _profiles[agent];
        require(profile.isActive, "NOT_ACTIVE");

        uint256 slashAmount = amount > profile.stakeAmount ? profile.stakeAmount : amount;
        profile.stakeAmount -= slashAmount;

        emit StakeSlashed(agent, slashAmount);

        // Send slashed funds to owner (protocol treasury)
        if (slashAmount > 0) {
            (bool ok, ) = owner.call{value: slashAmount}("");
            require(ok, "SLASH_TRANSFER_FAILED");
        }
    }

    // --- View Functions ---
    function discoverAgents(AgentType agentType) external view override returns (address[] memory) {
        address[] storage candidates = _agentsByType[uint8(agentType)];
        // Count active
        uint256 activeCount = 0;
        for (uint256 i = 0; i < candidates.length; i++) {
            if (_profiles[candidates[i]].isActive) activeCount++;
        }
        // Build result
        address[] memory result = new address[](activeCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < candidates.length; i++) {
            if (_profiles[candidates[i]].isActive) {
                result[idx++] = candidates[i];
            }
        }
        return result;
    }

    function getAgentProfile(address agent) external view override returns (AgentProfile memory) {
        return _profiles[agent];
    }

    function isRegistered(address agent) external view override returns (bool) {
        return _profiles[agent].isActive;
    }

    function getAgentCount() external view override returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 0; i < _allAgents.length; i++) {
            if (_profiles[_allAgents[i]].isActive) count++;
        }
        return count;
    }

    function getAllAgents() external view returns (address[] memory) {
        return _allAgents;
    }

    // --- Internal ---
    function _removeFromTypeArray(uint8 agentType, address agent) internal {
        address[] storage arr = _agentsByType[agentType];
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == agent) {
                arr[i] = arr[arr.length - 1];
                arr.pop();
                return;
            }
        }
    }

    receive() external payable {}
}
