// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./interfaces/IEscrowSettlement.sol";
import "./interfaces/IReputationEngine.sol";

/// @title EscrowSettlement - Trustless payment escrow with x402 integration
/// @notice Holds funds during service fulfillment, supports batch micro-payment settlement
/// @dev Integrates with ReputationEngine to update scores after settlement
contract EscrowSettlement is IEscrowSettlement {
    // --- State ---
    Escrow[] private _escrows;
    IReputationEngine public reputationEngine;
    address public marketplace;
    address public owner;

    // Micro-payment tab system: accumulate small payments, settle in batch
    struct PaymentTab {
        address buyer;
        address seller;
        uint256 accumulated;
        uint256 transactionCount;
        uint256 lastUpdated;
    }

    // buyer => seller => tab
    mapping(address => mapping(address => PaymentTab)) public tabs;

    // Stats
    uint256 public totalEscrowVolume;
    uint256 public totalSettled;
    uint256 public totalEscrowsCreated;

    // --- Modifiers ---
    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyMarketplace() {
        require(msg.sender == marketplace || msg.sender == owner, "NOT_MARKETPLACE");
        _;
    }

    constructor(address _reputationEngine) {
        reputationEngine = IReputationEngine(_reputationEngine);
        owner = msg.sender;
    }

    function setMarketplace(address _marketplace) external onlyOwner {
        marketplace = _marketplace;
    }

    // --- Escrow Functions ---

    /// @notice Create an escrow for a service request (buyer deposits native token)
    function createEscrow(
        uint256 requestId,
        address seller,
        uint256 amount,
        uint256 duration
    ) external payable override returns (uint256) {
        require(msg.value >= amount, "INSUFFICIENT_DEPOSIT");
        require(seller != address(0), "ZERO_SELLER");
        require(seller != msg.sender, "SELF_ESCROW");
        require(duration > 0, "ZERO_DURATION");

        uint256 escrowId = _escrows.length;

        _escrows.push(Escrow({
            escrowId: escrowId,
            requestId: requestId,
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            createdAt: block.timestamp,
            expiresAt: block.timestamp + duration,
            status: EscrowStatus.Funded,
            x402PaymentHash: bytes32(0)
        }));

        totalEscrowsCreated++;
        totalEscrowVolume += amount;

        emit EscrowCreated(escrowId, requestId, msg.sender, seller, amount);

        // Refund excess
        if (msg.value > amount) {
            (bool ok, ) = msg.sender.call{value: msg.value - amount}("");
            require(ok, "REFUND_FAILED");
        }

        return escrowId;
    }

    /// @notice Release escrow to seller (called by buyer or marketplace after completion)
    function releaseEscrow(uint256 escrowId) external override {
        require(escrowId < _escrows.length, "INVALID_ESCROW");
        Escrow storage e = _escrows[escrowId];

        require(e.status == EscrowStatus.Funded, "NOT_FUNDED");
        require(
            msg.sender == e.buyer || msg.sender == marketplace || msg.sender == owner,
            "NOT_AUTHORIZED"
        );

        e.status = EscrowStatus.Released;
        totalSettled++;

        // Update reputation: successful completion
        uint256 responseBlocks = (block.timestamp - e.createdAt); // approximate in seconds
        reputationEngine.recordCompletion(
            e.seller,
            bytes32(e.requestId), // use requestId as category proxy
            responseBlocks,
            e.amount
        );

        emit EscrowReleased(escrowId, e.seller, e.amount);

        (bool ok, ) = e.seller.call{value: e.amount}("");
        require(ok, "RELEASE_FAILED");
    }

    /// @notice Refund escrow to buyer (expired or disputed)
    function refundEscrow(uint256 escrowId) external override {
        require(escrowId < _escrows.length, "INVALID_ESCROW");
        Escrow storage e = _escrows[escrowId];

        require(e.status == EscrowStatus.Funded, "NOT_FUNDED");

        bool isExpired = block.timestamp > e.expiresAt;
        bool isAuthorized = msg.sender == e.buyer || msg.sender == marketplace || msg.sender == owner;

        require(isExpired || isAuthorized, "NOT_AUTHORIZED_OR_EXPIRED");

        e.status = EscrowStatus.Refunded;

        // Record failure for seller
        reputationEngine.recordFailure(e.seller, bytes32(e.requestId));

        emit EscrowRefunded(escrowId, e.buyer, e.amount);

        (bool ok, ) = e.buyer.call{value: e.amount}("");
        require(ok, "REFUND_FAILED");
    }

    /// @notice Batch settle multiple escrows in one transaction (gas optimization)
    function batchSettle(uint256[] calldata escrowIds) external override {
        uint256 totalAmount = 0;

        for (uint256 i = 0; i < escrowIds.length; i++) {
            uint256 eid = escrowIds[i];
            require(eid < _escrows.length, "INVALID_ESCROW");
            Escrow storage e = _escrows[eid];

            require(e.status == EscrowStatus.Funded, "NOT_FUNDED");
            require(
                msg.sender == e.buyer || msg.sender == marketplace || msg.sender == owner,
                "NOT_AUTHORIZED"
            );

            e.status = EscrowStatus.Released;
            totalSettled++;
            totalAmount += e.amount;

            reputationEngine.recordCompletion(
                e.seller,
                bytes32(e.requestId),
                block.timestamp - e.createdAt,
                e.amount
            );

            (bool ok, ) = e.seller.call{value: e.amount}("");
            require(ok, "BATCH_RELEASE_FAILED");
        }

        emit BatchSettled(escrowIds, totalAmount);
    }

    // --- Micro-payment Tab System ---

    /// @notice Add to a running tab between buyer and seller (no on-chain payment yet)
    function addToTab(address seller, uint256 amount) external {
        PaymentTab storage tab = tabs[msg.sender][seller];
        tab.buyer = msg.sender;
        tab.seller = seller;
        tab.accumulated += amount;
        tab.transactionCount++;
        tab.lastUpdated = block.timestamp;
    }

    /// @notice Settle an accumulated tab in a single payment
    function settleTab(address seller) external payable {
        PaymentTab storage tab = tabs[msg.sender][seller];
        require(tab.accumulated > 0, "NO_TAB");
        require(msg.value >= tab.accumulated, "INSUFFICIENT_PAYMENT");

        uint256 amount = tab.accumulated;
        uint256 count = tab.transactionCount;

        // Reset tab
        tab.accumulated = 0;
        tab.transactionCount = 0;

        totalSettled += count;
        totalEscrowVolume += amount;

        // Update reputation for batch
        reputationEngine.recordCompletion(seller, keccak256("TAB_SETTLEMENT"), 1, amount);

        (bool ok, ) = seller.call{value: amount}("");
        require(ok, "TAB_SETTLE_FAILED");

        // Refund excess
        if (msg.value > amount) {
            (bool ok2, ) = msg.sender.call{value: msg.value - amount}("");
            require(ok2, "TAB_REFUND_FAILED");
        }
    }

    // --- View Functions ---

    function getEscrow(uint256 escrowId) external view override returns (Escrow memory) {
        require(escrowId < _escrows.length, "INVALID_ESCROW");
        return _escrows[escrowId];
    }

    function getEscrowCount() external view returns (uint256) {
        return _escrows.length;
    }

    function getTab(address buyer, address seller) external view returns (PaymentTab memory) {
        return tabs[buyer][seller];
    }

    receive() external payable {}
}
