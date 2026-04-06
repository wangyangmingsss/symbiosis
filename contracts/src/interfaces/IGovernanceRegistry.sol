// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IGovernanceRegistry - Interface for on-chain governance by autonomous agents
/// @notice Defines the proposal and voting lifecycle for the SYMBIOSIS economy
interface IGovernanceRegistry {
    enum ProposalType {
        FeeReduction,
        RiskIncrease,
        RiskDecrease,
        LPWidenRange,
        LPTightenRange,
        GasOptimization,
        EmergencyPause,
        CustomAction
    }

    enum ProposalStatus {
        Created,
        Voting,
        Passed,
        Rejected,
        Executed
    }

    struct Proposal {
        uint256 id;
        address proposer;
        ProposalType proposalType;
        string description;
        uint256 createdAtBlock;
        uint256 votingEndsAtBlock;
        uint256 yesVotes;
        uint256 noVotes;
        ProposalStatus status;
        bool executed;
    }

    // --- Events ---
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        ProposalType proposalType,
        string description,
        uint256 votingEndsAtBlock
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalRejected(uint256 indexed proposalId);

    // --- Core Functions ---
    function createProposal(ProposalType proposalType, string calldata description) external returns (uint256);
    function vote(uint256 proposalId, bool support) external;
    function finalizeProposal(uint256 proposalId) external;
    function executeProposal(uint256 proposalId) external;

    // --- View Functions ---
    function getProposal(uint256 proposalId) external view returns (Proposal memory);
    function getProposalCount() external view returns (uint256);
    function getVote(uint256 proposalId, address voter) external view returns (bool support, bool hasVoted);
    function hasVoted(uint256 proposalId, address voter) external view returns (bool);
    function isProposalActive(uint256 proposalId) external view returns (bool);
}
