// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev The slice of RiftMarket the vault drives. Every call acts for msg.sender, i.e. the vault.
interface IRiftMarket {
    function collateral() external view returns (IERC20);
    function quotePremium(uint256 notional, uint256 duration) external view returns (uint256);
    function buyProtection(uint256 notional, uint256 duration) external returns (uint256 id);
    function claim(uint256 id) external returns (uint256 amount);
    function openPosition(bool isLong, uint256 size, uint256 margin) external;
    function closePosition() external;
    function deposit(uint256 assets) external returns (uint256 shares);
    function requestWithdraw(uint256 shares) external;
    function cancelWithdraw() external;
    function completeWithdraw() external returns (uint256 assets);
}

/// @title RiftAgentVault
/// @notice A per-user account an AI agent can trade from, inside limits the owner sets and this contract
///         enforces. The owner funds it and sets the limits; the agent key can only call RiftMarket through
///         it. Money can leave in three ways only: into RiftMarket (margin, premiums, pool deposits, each
///         counted against the daily spend cap), back to the owner, or to the fee recipient as agent
///         payment under the daily fee cap. Positions, cover and pool shares belong to the vault, so payouts,
///         closes and withdrawals come back to it.
/// @dev One vault per owner because RiftMarket keys positions by msg.sender. Day buckets are UTC days
///      (block.timestamp / 1 days), so a cap resets at 00:00 UTC rather than on a rolling window.
contract RiftAgentVault {
    using SafeERC20 for IERC20;

    uint8 public constant ALLOW_TRADE = 1; // open and close perp positions
    uint8 public constant ALLOW_PROTECT = 2; // buy drain cover
    uint8 public constant ALLOW_UNDERWRITE = 4; // deposit into and withdraw from the pool
    uint256 public constant MAX_LEVERAGE = 10; // RiftMarket's own ceiling

    struct Limits {
        uint128 maxSpendPerDay; // tUSD into the market per UTC day (margin + premiums + deposits)
        uint128 maxNotional; // largest perp size or cover notional per action
        uint128 maxFeePerDay; // tUSD the agent may charge per UTC day
        uint8 maxLeverage; // 1..10
        uint8 allowed; // ALLOW_* bitmask
    }

    IRiftMarket public immutable market;
    IERC20 public immutable token;
    address public immutable owner;
    address public immutable feeRecipient;

    address public agent; // the key allowed to act; zero = revoked
    bool public paused;
    Limits public limits;

    uint64 public spendDay;
    uint128 public spentToday;
    uint64 public feeDay;
    uint128 public feesToday;

    event AgentSet(address agent);
    event Paused(bool paused);
    event LimitsSet(Limits limits);
    event Withdrawn(address to, uint256 amount);
    event Spent(uint8 action, uint256 amount, uint256 spentToday);
    event FeeCharged(address to, uint256 amount, uint256 feesToday, string memo);
    event Acted(address by, bytes4 action);

    error NotOwner();
    error NotOperator();
    error IsPaused();
    error NotAllowed(uint8 action);
    error OverDailySpend(uint256 wanted, uint256 left);
    error OverNotional(uint256 wanted, uint256 max);
    error OverLeverage(uint256 size, uint256 margin, uint256 maxLeverage);
    error OverDailyFee(uint256 wanted, uint256 left);
    error BadLimits();
    error ZeroAddress();

    constructor(IRiftMarket market_, address owner_, address agent_, address feeRecipient_, Limits memory limits_) {
        if (
            address(market_) == address(0) || owner_ == address(0) || agent_ == address(0)
                || feeRecipient_ == address(0)
        ) {
            revert ZeroAddress();
        }
        market = market_;
        token = market_.collateral();
        owner = owner_;
        agent = agent_;
        feeRecipient = feeRecipient_;
        _setLimits(limits_);
        emit AgentSet(agent_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev The owner can always act (and isn't bound by the limits: they're the owner's own rules for the
    ///      agent). The agent can act only while not paused.
    modifier onlyOperator() {
        if (msg.sender != owner) {
            if (msg.sender != agent || agent == address(0)) revert NotOperator();
            if (paused) revert IsPaused();
        }
        _;
        emit Acted(msg.sender, msg.sig);
    }

    // ================================================================ owner controls

    function setLimits(Limits calldata limits_) external onlyOwner {
        _setLimits(limits_);
    }

    /// @notice Replace the agent key.
    function setAgent(address agent_) external onlyOwner {
        if (agent_ == address(0)) revert ZeroAddress();
        agent = agent_;
        emit AgentSet(agent_);
    }

    /// @notice Cut the agent off entirely; setAgent re-enables one.
    function revokeAgent() external onlyOwner {
        agent = address(0);
        emit AgentSet(address(0));
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    /// @notice Take tUSD out of the vault. Only ever to the owner.
    function withdraw(uint256 amount) external onlyOwner {
        token.safeTransfer(owner, amount);
        emit Withdrawn(owner, amount);
    }

    // ================================================================ market actions (owner or agent)

    function openPosition(bool isLong, uint256 size, uint256 margin) external onlyOperator {
        _check(ALLOW_TRADE);
        if (msg.sender != owner) {
            if (size > limits.maxNotional) revert OverNotional(size, limits.maxNotional);
            if (size > margin * limits.maxLeverage) revert OverLeverage(size, margin, limits.maxLeverage);
        }
        _spend(ALLOW_TRADE, margin);
        token.forceApprove(address(market), margin);
        market.openPosition(isLong, size, margin);
    }

    function closePosition() external onlyOperator {
        // Closing only ever returns funds and cuts risk, so it stays allowed whatever the trade flag says.
        market.closePosition();
    }

    function buyProtection(uint256 notional, uint256 duration) external onlyOperator returns (uint256 id) {
        _check(ALLOW_PROTECT);
        if (msg.sender != owner && notional > limits.maxNotional) revert OverNotional(notional, limits.maxNotional);
        uint256 premium = market.quotePremium(notional, duration); // same block, so it's what the market charges
        _spend(ALLOW_PROTECT, premium);
        token.forceApprove(address(market), premium);
        id = market.buyProtection(notional, duration);
    }

    /// @notice Pays a settled policy into the vault. Anyone can claim on RiftMarket; funds go to the buyer.
    function claim(uint256 id) external onlyOperator returns (uint256) {
        return market.claim(id);
    }

    function deposit(uint256 assets) external onlyOperator returns (uint256 shares) {
        _check(ALLOW_UNDERWRITE);
        _spend(ALLOW_UNDERWRITE, assets);
        token.forceApprove(address(market), assets);
        shares = market.deposit(assets);
    }

    function requestWithdraw(uint256 shares) external onlyOperator {
        _check(ALLOW_UNDERWRITE);
        market.requestWithdraw(shares);
    }

    function cancelWithdraw() external onlyOperator {
        _check(ALLOW_UNDERWRITE);
        market.cancelWithdraw();
    }

    function completeWithdraw() external onlyOperator returns (uint256) {
        return market.completeWithdraw(); // returns pool funds to the vault, so no flag needed
    }

    // ================================================================ agent payment

    /// @notice The agent charges for its work (e.g. a premium-model message), up to the owner's daily fee cap.
    ///         Paid to the fee recipient fixed at creation; the owner can't be charged beyond the cap.
    function chargeFee(uint256 amount, string calldata memo) external {
        if (msg.sender != agent || agent == address(0)) revert NotOperator();
        if (paused) revert IsPaused();
        uint64 today = uint64(block.timestamp / 1 days);
        if (feeDay != today) {
            feeDay = today;
            feesToday = 0;
        }
        uint256 left = limits.maxFeePerDay - feesToday;
        if (amount > left) revert OverDailyFee(amount, left);
        feesToday += uint128(amount);
        token.safeTransfer(feeRecipient, amount);
        emit FeeCharged(feeRecipient, amount, feesToday, memo);
    }

    // ================================================================ views

    /// @notice What the agent may still spend into the market and charge in fees today.
    function remainingToday() external view returns (uint256 spend, uint256 fees) {
        uint64 today = uint64(block.timestamp / 1 days);
        spend = limits.maxSpendPerDay - (spendDay == today ? spentToday : 0);
        fees = limits.maxFeePerDay - (feeDay == today ? feesToday : 0);
    }

    // ================================================================ internals

    function _check(uint8 action) private view {
        if (msg.sender != owner && limits.allowed & action == 0) revert NotAllowed(action);
    }

    /// @dev The owner's own actions don't count against the agent's daily cap.
    function _spend(uint8 action, uint256 amount) private {
        if (msg.sender == owner) return;
        uint64 today = uint64(block.timestamp / 1 days);
        if (spendDay != today) {
            spendDay = today;
            spentToday = 0;
        }
        uint256 left = limits.maxSpendPerDay - spentToday;
        if (amount > left) revert OverDailySpend(amount, left);
        spentToday += uint128(amount);
        emit Spent(action, amount, spentToday);
    }

    function _setLimits(Limits memory l) private {
        if (l.maxLeverage == 0 || l.maxLeverage > MAX_LEVERAGE || l.allowed > 7) revert BadLimits();
        limits = l;
        // A cap lowered below today's use leaves nothing to spend rather than underflowing.
        uint64 today = uint64(block.timestamp / 1 days);
        if (spendDay == today && spentToday > l.maxSpendPerDay) spentToday = l.maxSpendPerDay;
        if (feeDay == today && feesToday > l.maxFeePerDay) feesToday = l.maxFeePerDay;
        emit LimitsSet(l);
    }
}

/// @title RiftAgentVaultFactory
/// @notice Creates one RiftAgentVault per owner, with the operator's agent key and fee recipient filled in,
///         so the app can find a user's vault from their address.
contract RiftAgentVaultFactory {
    IRiftMarket public immutable market;
    address public immutable agent;
    address public immutable feeRecipient;

    mapping(address owner => RiftAgentVault vault) public vaultOf;

    event VaultCreated(address indexed owner, address vault);

    error VaultExists(address vault);

    constructor(IRiftMarket market_, address agent_, address feeRecipient_) {
        if (address(market_) == address(0) || agent_ == address(0) || feeRecipient_ == address(0)) {
            revert RiftAgentVault.ZeroAddress();
        }
        market = market_;
        agent = agent_;
        feeRecipient = feeRecipient_;
    }

    function createVault(RiftAgentVault.Limits calldata limits_) external returns (RiftAgentVault vault) {
        if (address(vaultOf[msg.sender]) != address(0)) revert VaultExists(address(vaultOf[msg.sender]));
        vault = new RiftAgentVault(market, msg.sender, agent, feeRecipient, limits_);
        vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, address(vault));
    }
}
