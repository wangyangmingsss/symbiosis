// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./interfaces/IGovernanceRegistry.sol";
import "./interfaces/IAgentRegistry.sol";

/// @title GovernanceRegistry - On-chain governance proposals and voting for AI agents
/// @notice Only registered agents can create proposals and vote; quorum of 4 YES votes required
/// @dev Part of the SYMBIOSIS autonomous agent economy on X Layer
contract GovernanceRegistry is IGovernanceRegistry {
    // --- State ---
    IAgentRegistry public agentRegistry;
    address public owner;

    uint256 public votingWindow; // number of blocks for voting period
    uint256 public constant QUORUM = 4; // minimum YES votes to pass

    Proposal[] private _proposals;
    mapping(uint256 => mapping(address => bool)) private _hasVoted;
    mapping(uint256 => mapping(address => bool)) private _voteSupport;

    // --- Modifiers ---
    modifier onlyRegisteredAgent() {
        require(agentRegistry.isRegistered(msg.sender), "NOT_REGISTERED");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    // --- Constructor ---
    /// @param _agentRegistry Address of the deployed AgentRegistry contract
    /// @param _votingWindow Number of blocks the voting period lasts (default recommendation: 100)
    constructor(address _agentRegistry, uint256 _votingWindow) {
        require(_agentRegistry != address(0), "ZERO_ADDRESS");
        require(_votingWindow > 0, "ZERO_WINDOW");
        agentRegistry = IAgentRegistry(_agentRegistry);
        votingWindow = _votingWindow;
        owner = msg.sender;
    }

    // --- Admin ---

    /// @notice Update the voting window for future proposals
    /// @param _votingWindow New voting window in blocks
    function setVotingWindow(uint256 _votingWindow) external onlyOwner {
        require(_votingWindow > 0, "ZERO_WINDOW");
        votingWindow = _votingWindow;
    }

    /// @notice Transfer ownership of the governance contract
    /// @param newOwner Address of the new owner
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_ADDRESS");
        owner = newOwner;
    }

    // --- Core Functions ---

    /// @notice Create a new governance proposal
    /// @param proposalType The category of the proposal
    /// @param description Human-readable description of the proposal
    /// @return proposalId The ID of the newly created proposal
    function createProposal(
        ProposalType proposalType,
        string calldata description
    ) external override onlyRegisteredAgent returns (uint256) {
        require(bytes(description).length > 0, "EMPTY_DESCRIPTION");

        uint256 proposalId = _proposals.length;
        uint256 votingEndsAt = block.number + votingWindow;

        _proposals.push(Proposal({
            id: proposalId,
            proposer: msg.sender,
            proposalType: proposalType,
            description: description,
            createdAtBlock: block.number,
            votingEndsAtBlock: votingEndsAt,
            yesVotes: 0,
            noVotes: 0,
            status: ProposalStatus.Voting,
            executed: false
        }));

        emit ProposalCreated(proposalId, msg.sender, proposalType, description, votingEndsAt);

        return proposalId;
    }

    /// @notice Cast a vote on an active proposal
    /// @param proposalId The ID of the proposal to vote on
    /// @param support True for YES, false for NO
    function vote(uint256 proposalId, bool support) external override onlyRegisteredAgent {
        require(proposalId < _proposals.length, "INVALID_PROPOSAL");

        Proposal storage proposal = _proposals[proposalId];
        require(proposal.status == ProposalStatus.Voting, "NOT_VOTING");
        require(block.number <= proposal.votingEndsAtBlock, "VOTING_ENDED");
        require(!_hasVoted[proposalId][msg.sender], "ALREADY_VOTED");

        _hasVoted[proposalId][msg.sender] = true;
        _voteSupport[proposalId][msg.sender] = support;

        if (support) {
            proposal.yesVotes++;
        } else {
            proposal.noVotes++;
        }

        emit VoteCast(proposalId, msg.sender, support);
    }

    /// @notice Finalize a proposal after the voting window has closed
    /// @dev Transitions proposal to Passed or Rejected based on quorum
    /// @param proposalId The ID of the proposal to finalize
    function finalizeProposal(uint256 proposalId) external override {
        require(proposalId < _proposals.length, "INVALID_PROPOSAL");

        Proposal storage proposal = _proposals[proposalId];
        require(proposal.status == ProposalStatus.Voting, "NOT_VOTING");
        require(block.number > proposal.votingEndsAtBlock, "VOTING_NOT_ENDED");

        if (proposal.yesVotes >= QUORUM) {
            proposal.status = ProposalStatus.Passed;
        } else {
            proposal.status = ProposalStatus.Rejected;
            emit ProposalRejected(proposalId);
        }
    }

    /// @notice Execute a proposal that has passed governance
    /// @dev Only the contract owner can execute; marks proposal as Executed
    /// @param proposalId The ID of the proposal to execute
    function executeProposal(uint256 proposalId) external override onlyOwner {
        require(proposalId < _proposals.length, "INVALID_PROPOSAL");

        Proposal storage proposal = _proposals[proposalId];
        require(proposal.status == ProposalStatus.Passed, "NOT_PASSED");
        require(!proposal.executed, "ALREADY_EXECUTED");

        proposal.executed = true;
        proposal.status = ProposalStatus.Executed;

        emit ProposalExecuted(proposalId);
    }

    // --- View Functions ---

    /// @notice Get full proposal details by ID
    /// @param proposalId The ID of the proposal
    /// @return The Proposal struct
    function getProposal(uint256 proposalId) external view override returns (Proposal memory) {
        require(proposalId < _proposals.length, "INVALID_PROPOSAL");
        return _proposals[proposalId];
    }

    /// @notice Get the total number of proposals created
    /// @return Total proposal count
    function getProposalCount() external view override returns (uint256) {
        return _proposals.length;
    }

    /// @notice Get a specific agent's vote on a proposal
    /// @param proposalId The proposal ID
    /// @param voter The agent's address
    /// @return support Whether the agent voted YES
    /// @return voted Whether the agent has voted at all
    function getVote(
        uint256 proposalId,
        address voter
    ) external view override returns (bool support, bool voted) {
        require(proposalId < _proposals.length, "INVALID_PROPOSAL");
        voted = _hasVoted[proposalId][voter];
        support = _voteSupport[proposalId][voter];
    }

    /// @notice Check if an agent has voted on a specific proposal
    /// @param proposalId The proposal ID
    /// @param voter The agent's address
    /// @return True if the agent has already voted
    function hasVoted(uint256 proposalId, address voter) external view override returns (bool) {
        require(proposalId < _proposals.length, "INVALID_PROPOSAL");
        return _hasVoted[proposalId][voter];
    }

    /// @notice Check if a proposal is currently in the active voting window
    /// @param proposalId The proposal ID
    /// @return True if the proposal is in Voting status and the window has not closed
    function isProposalActive(uint256 proposalId) external view override returns (bool) {
        if (proposalId >= _proposals.length) return false;
        Proposal storage proposal = _proposals[proposalId];
        return proposal.status == ProposalStatus.Voting && block.number <= proposal.votingEndsAtBlock;
    }
}
