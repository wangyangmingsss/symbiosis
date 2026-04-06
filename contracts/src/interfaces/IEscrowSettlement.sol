// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IEscrowSettlement {
    struct Escrow {
        uint256 escrowId;
        uint256 requestId;
        address buyer;
        address seller;
        uint256 amount;
        uint256 createdAt;
        uint256 expiresAt;
        EscrowStatus status;
        bytes32 x402PaymentHash;
    }

    enum EscrowStatus { Funded, Released, Refunded, Disputed }

    event EscrowCreated(uint256 indexed escrowId, uint256 indexed requestId, address buyer, address seller, uint256 amount);
    event EscrowReleased(uint256 indexed escrowId, address indexed seller, uint256 amount);
    event EscrowRefunded(uint256 indexed escrowId, address indexed buyer, uint256 amount);
    event BatchSettled(uint256[] escrowIds, uint256 totalAmount);
    event DisputeResolved(uint256 indexed escrowId, uint256 buyerAmount, uint256 sellerAmount);

    function createEscrow(uint256 requestId, address seller, uint256 amount, uint256 duration) external payable returns (uint256);
    function releaseEscrow(uint256 escrowId) external;
    function refundEscrow(uint256 escrowId) external;
    function batchSettle(uint256[] calldata escrowIds) external;
    function getEscrow(uint256 escrowId) external view returns (Escrow memory);
}
