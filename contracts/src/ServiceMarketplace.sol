// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./interfaces/IServiceMarketplace.sol";
import "./interfaces/IAgentRegistry.sol";
import "./libraries/DutchAuctionLib.sol";

/// @title ServiceMarketplace - Dutch auction service market for AI agents
/// @notice Agents list services with decaying prices, other agents request and match
/// @dev Core economic mechanism of the SYMBIOSIS agent economy
contract ServiceMarketplace is IServiceMarketplace {
    using DutchAuctionLib for *;

    // --- State ---
    IAgentRegistry public registry;
    address public escrow;
    address public reputation;
    address public owner;
    bool public paused;

    ServiceListing[] private _listings;
    ServiceRequest[] private _requests;

    // Service type constants (precomputed keccak256 for gas efficiency)
    bytes32 public constant MARKET_DATA = keccak256("MARKET_DATA");
    bytes32 public constant ALPHA_SIGNAL = keccak256("ALPHA_SIGNAL");
    bytes32 public constant TRADE_EXECUTION = keccak256("TRADE_EXECUTION");
    bytes32 public constant SECURITY_AUDIT = keccak256("SECURITY_AUDIT");
    bytes32 public constant LP_MANAGEMENT = keccak256("LP_MANAGEMENT");
    bytes32 public constant ARBITRAGE_SIGNAL = keccak256("ARBITRAGE_SIGNAL");

    // Track active listings per provider
    mapping(address => uint256[]) public providerListings;
    // Track requests per requester
    mapping(address => uint256[]) public requesterRequests;
    // Listing count per service type
    mapping(bytes32 => uint256) public serviceTypeCount;

    // --- Stats ---
    uint256 public totalMatches;
    uint256 public totalVolumeUSDT;
    uint256 public totalCompletions;

    // --- Modifiers ---
    modifier onlyRegistered() {
        require(registry.isRegistered(msg.sender), "NOT_REGISTERED");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "PAUSED");
        _;
    }

    constructor(address _registry) {
        registry = IAgentRegistry(_registry);
        owner = msg.sender;
    }

    function setEscrow(address _escrow) external onlyOwner {
        escrow = _escrow;
    }

    function setReputation(address _reputation) external onlyOwner {
        reputation = _reputation;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    event Paused(address indexed account);
    event Unpaused(address indexed account);

    // --- Service Listing ---

    /// @notice List a service with Dutch auction pricing
    /// @param serviceType keccak256 of the service name
    /// @param startPrice Initial price (decays over time)
    /// @param floorPrice Minimum price
    /// @param decayRate Price decrease per block
    /// @param maxFulfillments How many times this listing can be purchased (0 = unlimited)
    function listService(
        bytes32 serviceType,
        uint256 startPrice,
        uint256 floorPrice,
        uint256 decayRate,
        uint256 maxFulfillments
    ) external override onlyRegistered whenNotPaused returns (uint256) {
        require(startPrice >= floorPrice, "START_BELOW_FLOOR");
        require(startPrice > 0, "ZERO_PRICE");

        uint256 listingId = _listings.length;

        _listings.push(ServiceListing({
            listingId: listingId,
            provider: msg.sender,
            serviceType: serviceType,
            startPrice: startPrice,
            floorPrice: floorPrice,
            decayRate: decayRate,
            listedAtBlock: block.number,
            maxFulfillments: maxFulfillments,
            fulfillmentCount: 0,
            isActive: true
        }));

        providerListings[msg.sender].push(listingId);
        serviceTypeCount[serviceType]++;

        emit ServiceListed(listingId, msg.sender, serviceType, startPrice);
        return listingId;
    }

    /// @notice Get current Dutch auction price for a listing
    function getCurrentPrice(uint256 listingId) public view override returns (uint256) {
        require(listingId < _listings.length, "INVALID_LISTING");
        ServiceListing storage listing = _listings[listingId];
        require(listing.isActive, "LISTING_INACTIVE");

        return DutchAuctionLib.currentPrice(
            listing.startPrice,
            listing.floorPrice,
            listing.decayRate,
            listing.listedAtBlock,
            block.number
        );
    }

    /// @notice Cancel a listing (only provider)
    function cancelListing(uint256 listingId) external {
        require(listingId < _listings.length, "INVALID_LISTING");
        ServiceListing storage listing = _listings[listingId];
        require(listing.provider == msg.sender, "NOT_PROVIDER");
        require(listing.isActive, "ALREADY_INACTIVE");

        listing.isActive = false;
        serviceTypeCount[listing.serviceType]--;
    }

    // --- Service Request ---

    /// @notice Request a service with a maximum budget
    function requestService(
        bytes32 serviceType,
        uint256 maxBudget,
        uint256 deadline
    ) external override onlyRegistered whenNotPaused returns (uint256) {
        require(maxBudget > 0, "ZERO_BUDGET");
        require(deadline > block.number, "PAST_DEADLINE");

        uint256 requestId = _requests.length;

        _requests.push(ServiceRequest({
            requestId: requestId,
            requester: msg.sender,
            serviceType: serviceType,
            maxBudget: maxBudget,
            deadline: deadline,
            assignedProvider: address(0),
            status: RequestStatus.Open
        }));

        requesterRequests[msg.sender].push(requestId);

        emit ServiceRequested(requestId, msg.sender, serviceType, maxBudget);
        return requestId;
    }

    // --- Matching ---

    /// @notice Provider accepts a service request using one of their listings
    function acceptRequest(uint256 requestId, uint256 listingId) external override onlyRegistered whenNotPaused {
        require(requestId < _requests.length, "INVALID_REQUEST");
        require(listingId < _listings.length, "INVALID_LISTING");

        ServiceRequest storage request = _requests[requestId];
        ServiceListing storage listing = _listings[listingId];

        require(request.status == RequestStatus.Open, "NOT_OPEN");
        require(block.number <= request.deadline, "EXPIRED");
        require(listing.isActive, "LISTING_INACTIVE");
        require(listing.provider == msg.sender, "NOT_YOUR_LISTING");
        require(listing.serviceType == request.serviceType, "TYPE_MISMATCH");

        // Check fulfillment limit
        if (listing.maxFulfillments > 0) {
            require(listing.fulfillmentCount < listing.maxFulfillments, "MAX_FULFILLED");
        }

        uint256 price = getCurrentPrice(listingId);
        require(price <= request.maxBudget, "PRICE_EXCEEDS_BUDGET");

        request.assignedProvider = msg.sender;
        request.status = RequestStatus.Assigned;
        listing.fulfillmentCount++;
        totalMatches++;

        emit ServiceMatched(requestId, listingId, msg.sender, price);
    }

    /// @notice Mark a service as completed (called by provider)
    function completeService(uint256 requestId, bytes32 proofHash) external override {
        require(requestId < _requests.length, "INVALID_REQUEST");
        ServiceRequest storage request = _requests[requestId];

        require(request.status == RequestStatus.Assigned, "NOT_ASSIGNED");
        require(request.assignedProvider == msg.sender, "NOT_PROVIDER");

        request.status = RequestStatus.Completed;
        totalCompletions++;

        emit ServiceCompleted(requestId, msg.sender, request.requester, request.maxBudget);
    }

    /// @notice Dispute a service (called by requester)
    function disputeService(uint256 requestId) external override {
        require(requestId < _requests.length, "INVALID_REQUEST");
        ServiceRequest storage request = _requests[requestId];

        require(request.requester == msg.sender, "NOT_REQUESTER");
        require(request.status == RequestStatus.Assigned, "NOT_ASSIGNED");

        request.status = RequestStatus.Disputed;

        emit ServiceDisputed(requestId, msg.sender);
    }

    /// @notice Cancel an expired request
    function cancelRequest(uint256 requestId) external {
        require(requestId < _requests.length, "INVALID_REQUEST");
        ServiceRequest storage request = _requests[requestId];

        require(request.requester == msg.sender || block.number > request.deadline, "NOT_EXPIRED");
        require(request.status == RequestStatus.Open, "NOT_OPEN");

        request.status = RequestStatus.Cancelled;
    }

    // --- Auto-matching (optional: called by any agent to match best provider) ---

    /// @notice Find cheapest active listing for a service type
    function findBestListing(bytes32 serviceType) external view returns (uint256 bestListingId, uint256 bestPrice) {
        bestPrice = type(uint256).max;
        bestListingId = type(uint256).max;

        for (uint256 i = 0; i < _listings.length; i++) {
            ServiceListing storage listing = _listings[i];
            if (!listing.isActive) continue;
            if (listing.serviceType != serviceType) continue;
            if (listing.maxFulfillments > 0 && listing.fulfillmentCount >= listing.maxFulfillments) continue;

            uint256 price = DutchAuctionLib.currentPrice(
                listing.startPrice, listing.floorPrice, listing.decayRate,
                listing.listedAtBlock, block.number
            );

            if (price < bestPrice) {
                bestPrice = price;
                bestListingId = i;
            }
        }
    }

    // --- View Functions ---

    function getListing(uint256 listingId) external view returns (ServiceListing memory) {
        require(listingId < _listings.length, "INVALID_LISTING");
        return _listings[listingId];
    }

    function getRequest(uint256 requestId) external view returns (ServiceRequest memory) {
        require(requestId < _requests.length, "INVALID_REQUEST");
        return _requests[requestId];
    }

    function getListingCount() external view returns (uint256) {
        return _listings.length;
    }

    function getRequestCount() external view returns (uint256) {
        return _requests.length;
    }

    function getProviderListings(address provider) external view returns (uint256[] memory) {
        return providerListings[provider];
    }

    function getRequesterRequests(address requester) external view returns (uint256[] memory) {
        return requesterRequests[requester];
    }
}
