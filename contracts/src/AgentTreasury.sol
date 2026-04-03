// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title AgentTreasury - Per-agent fund management with PnL tracking
/// @notice Each agent has an isolated treasury for deposits, withdrawals, and PnL accounting
contract AgentTreasury {
    struct Treasury {
        uint256 deposited;
        uint256 withdrawn;
        uint256 earned;       // from service provision
        uint256 spent;        // on service purchases
        uint256 lastActivity;
    }

    mapping(address => Treasury) public treasuries;
    address[] private _agents;
    address public owner;
    address public escrow; // authorized to credit earnings

    uint256 public totalDeposits;
    uint256 public totalEarnings;
    uint256 public totalSpending;

    event Deposited(address indexed agent, uint256 amount);
    event Withdrawn(address indexed agent, uint256 amount);
    event EarningsCredited(address indexed agent, uint256 amount);
    event SpendingDebited(address indexed agent, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setEscrow(address _escrow) external onlyOwner {
        escrow = _escrow;
    }

    /// @notice Deposit funds into agent's treasury
    function deposit() external payable {
        require(msg.value > 0, "ZERO_DEPOSIT");

        Treasury storage t = treasuries[msg.sender];
        if (t.lastActivity == 0) {
            _agents.push(msg.sender);
        }

        t.deposited += msg.value;
        t.lastActivity = block.timestamp;
        totalDeposits += msg.value;

        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraw funds from agent's treasury
    function withdraw(uint256 amount) external {
        Treasury storage t = treasuries[msg.sender];
        uint256 balance = getBalance(msg.sender);
        require(balance >= amount, "INSUFFICIENT_BALANCE");

        t.withdrawn += amount;
        t.lastActivity = block.timestamp;

        emit Withdrawn(msg.sender, amount);

        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "WITHDRAW_FAILED");
    }

    /// @notice Credit earnings to an agent (called after service completion)
    function creditEarnings(address agent, uint256 amount) external {
        require(msg.sender == escrow || msg.sender == owner, "NOT_AUTHORIZED");

        Treasury storage t = treasuries[agent];
        t.earned += amount;
        t.lastActivity = block.timestamp;
        totalEarnings += amount;

        emit EarningsCredited(agent, amount);
    }

    /// @notice Debit spending from an agent (called when purchasing a service)
    function debitSpending(address agent, uint256 amount) external {
        require(msg.sender == escrow || msg.sender == owner, "NOT_AUTHORIZED");

        Treasury storage t = treasuries[agent];
        t.spent += amount;
        t.lastActivity = block.timestamp;
        totalSpending += amount;

        emit SpendingDebited(agent, amount);
    }

    // --- View Functions ---

    function getBalance(address agent) public view returns (uint256) {
        Treasury storage t = treasuries[agent];
        uint256 totalIn = t.deposited + t.earned;
        uint256 totalOut = t.withdrawn + t.spent;
        if (totalOut >= totalIn) return 0;
        return totalIn - totalOut;
    }

    /// @notice Get PnL (earned - spent) for an agent
    function getPnL(address agent) external view returns (int256) {
        Treasury storage t = treasuries[agent];
        return int256(t.earned) - int256(t.spent);
    }

    function getTreasury(address agent) external view returns (Treasury memory) {
        return treasuries[agent];
    }

    function getAgentCount() external view returns (uint256) {
        return _agents.length;
    }

    function getAllAgents() external view returns (address[] memory) {
        return _agents;
    }

    /// @notice Economy-wide GDP (total earnings across all agents)
    function getGDP() external view returns (uint256) {
        return totalEarnings;
    }

    receive() external payable {}
}
