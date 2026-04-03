// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IServiceMarketplace {
    struct ServiceListing {
        uint256 listingId;
        address provider;
        bytes32 serviceType;
        uint256 startPrice;
        uint256 floorPrice;
        uint256 decayRate;
        uint256 listedAtBlock;
        uint256 maxFulfillments;
        uint256 fulfillmentCount;
        bool isActive;
    }

    struct ServiceRequest {
        uint256 requestId;
        address requester;
        bytes32 serviceType;
        uint256 maxBudget;
        uint256 deadline;
        address assignedProvider;
        RequestStatus status;
    }

    enum RequestStatus { Open, Assigned, Completed, Disputed, Cancelled }

    event ServiceListed(uint256 indexed listingId, address indexed provider, bytes32 serviceType, uint256 startPrice);
    event ServiceRequested(uint256 indexed requestId, address indexed requester, bytes32 serviceType, uint256 maxBudget);
    event ServiceMatched(uint256 indexed requestId, uint256 indexed listingId, address provider, uint256 price);
    event ServiceCompleted(uint256 indexed requestId, address indexed provider, address indexed requester, uint256 amount);
    event ServiceDisputed(uint256 indexed requestId, address indexed disputer);

    function listService(bytes32 serviceType, uint256 startPrice, uint256 floorPrice, uint256 decayRate, uint256 maxFulfillments) external returns (uint256);
    function getCurrentPrice(uint256 listingId) external view returns (uint256);
    function requestService(bytes32 serviceType, uint256 maxBudget, uint256 deadline) external returns (uint256);
    function acceptRequest(uint256 requestId, uint256 listingId) external;
    function completeService(uint256 requestId, bytes32 proofHash) external;
    function disputeService(uint256 requestId) external;
}
