// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./interfaces/IReputationEngine.sol";
import "./libraries/ELOLib.sol";

/// @title ReputationEngine - ELO-based on-chain reputation for AI agents
/// @notice Tracks agent performance across service categories with ELO-style scoring
/// @dev Called by EscrowSettlement and ServiceMarketplace after each interaction
contract ReputationEngine is IReputationEngine {
    using ELOLib for uint256;

    // --- State ---
    mapping(address => ReputationScore) private _scores;
    mapping(address => mapping(bytes32 => uint256)) private _categoryScores;
    address[] private _rankedAgents; // sorted by score (maintained lazily)

    address public owner;
    mapping(address => bool) public authorizedCallers; // marketplace, escrow

    // --- Modifiers ---
    modifier onlyAuthorized() {
        require(authorizedCallers[msg.sender] || msg.sender == owner, "NOT_AUTHORIZED");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setAuthorized(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
    }

    // --- Core Functions ---

    /// @notice Record a successful service completion
    /// @param agent The service provider's address
    /// @param serviceType keccak256 of the service category
    /// @param responseBlocks How many blocks it took to fulfill
    /// @param amountUSDT Payment amount in USDT (6 decimals)
    function recordCompletion(
        address agent,
        bytes32 serviceType,
        uint256 responseBlocks,
        uint256 amountUSDT
    ) external override onlyAuthorized {
        ReputationScore storage score = _scores[agent];

        // Initialize if first interaction
        if (score.totalScore == 0) {
            score.totalScore = ELOLib.BASE_RATING;
            _rankedAgents.push(agent);
        }

        // ELO update: treat completion as a "win" against average opponent (1000)
        score.totalScore = ELOLib.ratingAfterWin(
            score.totalScore,
            ELOLib.BASE_RATING,
            score.completedServices
        );

        score.completedServices += 1;
        score.totalVolumeUSDT += amountUSDT;
        score.lastUpdated = block.timestamp;

        // Update rolling average response time
        if (score.avgResponseBlocks == 0) {
            score.avgResponseBlocks = responseBlocks;
        } else {
            // Exponential moving average: new = old * 0.8 + current * 0.2
            score.avgResponseBlocks = (score.avgResponseBlocks * 80 + responseBlocks * 20) / 100;
        }

        // Update category score
        uint256 catScore = _categoryScores[agent][serviceType];
        if (catScore == 0) catScore = ELOLib.BASE_RATING;
        _categoryScores[agent][serviceType] = ELOLib.ratingAfterWin(catScore, ELOLib.BASE_RATING, score.completedServices);

        emit ReputationUpdated(agent, score.totalScore, score.completedServices);
    }

    /// @notice Record a service failure (timeout, dispute loss)
    function recordFailure(
        address agent,
        bytes32 serviceType
    ) external override onlyAuthorized {
        ReputationScore storage score = _scores[agent];

        if (score.totalScore == 0) {
            score.totalScore = ELOLib.BASE_RATING;
            _rankedAgents.push(agent);
        }

        uint256 oldScore = score.totalScore;
        score.totalScore = ELOLib.ratingAfterLoss(
            score.totalScore,
            ELOLib.BASE_RATING,
            score.completedServices + score.failedServices
        );

        score.failedServices += 1;
        score.lastUpdated = block.timestamp;

        // Category score also takes a hit
        uint256 catScore = _categoryScores[agent][serviceType];
        if (catScore == 0) catScore = ELOLib.BASE_RATING;
        _categoryScores[agent][serviceType] = ELOLib.ratingAfterLoss(catScore, ELOLib.BASE_RATING, score.completedServices);

        emit ReputationSlashed(agent, oldScore, score.totalScore, oldScore - score.totalScore);
    }

    /// @notice Slash reputation by basis points (for severe violations)
    function slashReputation(address agent, uint256 basisPoints) external onlyAuthorized {
        ReputationScore storage score = _scores[agent];
        require(score.totalScore > 0, "NO_SCORE");

        uint256 oldScore = score.totalScore;
        score.totalScore = ELOLib.slash(score.totalScore, basisPoints);
        score.lastUpdated = block.timestamp;

        emit ReputationSlashed(agent, oldScore, score.totalScore, oldScore - score.totalScore);
    }

    // --- View Functions ---

    function getReputation(address agent) external view override returns (uint256) {
        uint256 s = _scores[agent].totalScore;
        return s == 0 ? ELOLib.BASE_RATING : s;
    }

    function getCategoryReputation(address agent, bytes32 serviceType) external view override returns (uint256) {
        uint256 s = _categoryScores[agent][serviceType];
        return s == 0 ? ELOLib.BASE_RATING : s;
    }

    function getFullScore(address agent) external view override returns (ReputationScore memory) {
        ReputationScore memory s = _scores[agent];
        if (s.totalScore == 0) s.totalScore = ELOLib.BASE_RATING;
        return s;
    }

    /// @notice Get top N agents by reputation
    /// @dev Simple selection sort - fine for < 100 agents
    function getTopAgents(uint256 count) external view override returns (address[] memory, uint256[] memory) {
        uint256 len = _rankedAgents.length;
        if (count > len) count = len;

        // Copy to memory for sorting
        address[] memory agents = new address[](len);
        uint256[] memory scores = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            agents[i] = _rankedAgents[i];
            scores[i] = _scores[agents[i]].totalScore;
        }

        // Partial selection sort for top `count`
        for (uint256 i = 0; i < count; i++) {
            uint256 maxIdx = i;
            for (uint256 j = i + 1; j < len; j++) {
                if (scores[j] > scores[maxIdx]) maxIdx = j;
            }
            if (maxIdx != i) {
                (agents[i], agents[maxIdx]) = (agents[maxIdx], agents[i]);
                (scores[i], scores[maxIdx]) = (scores[maxIdx], scores[i]);
            }
        }

        // Truncate to count
        address[] memory topAgents = new address[](count);
        uint256[] memory topScores = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            topAgents[i] = agents[i];
            topScores[i] = scores[i];
        }

        return (topAgents, topScores);
    }

    function getAgentCount() external view returns (uint256) {
        return _rankedAgents.length;
    }
}
