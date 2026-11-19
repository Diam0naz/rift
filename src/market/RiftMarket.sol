// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AbstractPayer} from "@reactive/base/AbstractPayer.sol";
import {IPayable} from "@reactive/interfaces/IPayable.sol";

/// @title RiftMarket
/// @notice One underwriting pool, two products, settled by RiftReactive callbacks (Unichain Sepolia).
///
///  1. Drain Default Swap (jump leg): buyers pay a premium up front for coverage of `notional` until `expiry`.
///     When RiftReactive calls `trip()`, every live policy is paid in the same transaction - no claim process.
///  2. Spread perp (continuous leg): long/short the Unichain-vs-Base price spread (in bps) against the pool.
///     Funding accrues every second: when the spread is positive, longs pay; when negative, shorts pay.
///     On trip, the perp freezes and every position settles at the trip mark.
///
///  Underwriters deposit collateral, earn premiums and perp losses, and pay out protection and perp profits.
contract RiftMarket is AbstractPayer {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_POLICIES = 64; // bounded so trip() can pay everyone in one callback
    uint256 public constant MIN_DURATION = 60;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant MAX_LEVERAGE = 10;
    uint256 public constant MAINTENANCE_BPS = 500; // 5% of size
    /// @dev funding owed = size * Δ(cumulative bps·seconds) / FUNDING_DENOM
    ///      -> a 100 bps spread held for one day costs the paying side 1% of size.
    uint256 public constant FUNDING_DENOM = BPS * 1 days;

    // ---------------------------------------------------------------- types

    struct Policy {
        address buyer;
        uint128 notional;
        uint64 expiry;
        bool settled;
    }

    struct Position {
        bool open;
        bool isLong;
        uint128 size; // collateral units; PnL = size * Δspread(bps) / BPS
        uint128 margin;
        int256 entryMark;
        int256 entryCumFunding;
    }

    // ---------------------------------------------------------------- storage

    IERC20 public immutable collateral;
    address public immutable owner;
    address public reactive; // RiftReactive on Lasna, set once after it is deployed

    uint256 public premiumBpsPerDay = 10; // 0.10% of notional per day

    // Underwriting pool
    uint256 public poolAssets;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    // Mark + funding
    int256 public markBps;
    uint256 public markObservedAt; // Reactive's clock when the mark was computed
    uint256 public markReceivedAt; // Unichain's clock when the callback landed
    int256 public cumFunding; // Σ markBps * dt (bps·seconds)
    uint256 public lastFundingAt;

    // Products
    Policy[] internal _policies;
    mapping(address => Position) public positions;
    uint256 public totalMargin;
    uint256 public openLongSize;
    uint256 public openShortSize;

    // Trip
    bool public tripped;
    int256 public tripMark;
    uint256 public tripOutflowBps;
    uint256 public trippedAt;
    uint256 public payoutRatioBps;

    // ---------------------------------------------------------------- events

    event ReactiveSet(address reactive);
    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event Withdrawn(address indexed user, uint256 assets, uint256 shares);
    event MarkUpdated(int256 markBps, uint256 observedAt, uint256 receivedAt, uint256 originChainId, uint256 originTxHash);
    event ProtectionBought(uint256 indexed id, address indexed buyer, uint256 notional, uint256 premium, uint256 expiry);
    event PolicyPaid(uint256 indexed id, address indexed buyer, uint256 amount);
    event Tripped(int256 markBps, uint256 outflowBps, uint256 observedAt, uint256 receivedAt, uint256 originChainId, uint256 originTxHash, uint256 payoutRatioBps);
    event PositionOpened(address indexed trader, bool isLong, uint256 size, uint256 margin, int256 entryMark);
    event PositionClosed(address indexed trader, int256 pnl, int256 funding, uint256 payout, bool liquidated);

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error ReactiveAlreadySet();
    error UnauthorizedReactive(address sender);
    error IsTripped();
    error NotTripped();
    error ZeroAmount();
    error BadDuration();
    error InsufficientLiquidity();
    error TooManyPolicies();
    error NoMark();
    error PositionExists();
    error NoPosition();
    error TooMuchLeverage();
    error NotLiquidatable();

    // ---------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Callback must come through the Reactive callback proxy AND originate from our reactive contract.
    modifier onlyReactive(address sender_) {
        _onlyServiceProvider();
        if (sender_ != reactive || sender_ == address(0)) revert UnauthorizedReactive(sender_);
        _;
    }

    modifier notTripped() {
        if (tripped) revert IsTripped();
        _;
    }

    constructor(IPayable callbackProxy_, IERC20 collateral_) AbstractPayer(callbackProxy_) {
        collateral = collateral_;
        owner = msg.sender;
        lastFundingAt = block.timestamp;
    }

    // ================================================================ admin

    /// @notice One-time link to the reactive contract (it is deployed after this market).
    function setReactive(address reactive_) external onlyOwner {
        if (reactive != address(0)) revert ReactiveAlreadySet();
        reactive = reactive_;
        emit ReactiveSet(reactive_);
    }

    function setPremiumBpsPerDay(uint256 bps_) external onlyOwner {
        premiumBpsPerDay = bps_;
    }

    /// @notice Pay outstanding callback debt to the proxy from this contract's native balance.
    function coverDebt() external {
        _coverDebt();
    }

    /// @notice DEMO ONLY: clear trip state and settled policies so the loop can be replayed.
    function resetDemo() external onlyOwner {
        if (!tripped) revert NotTripped();
        tripped = false;
        tripMark = 0;
        tripOutflowBps = 0;
        trippedAt = 0;
        payoutRatioBps = 0;
        delete _policies;
        lastFundingAt = block.timestamp;
    }

    // ================================================================ reactive callbacks

    function updateMark(address sender_, int256 markBps_, uint256 observedAt_, uint256 originChainId_, uint256 originTxHash_)
        external
        onlyReactive(sender_)
    {
        if (tripped) return; // late marks after a trip are ignored
        _accrueFunding();
        markBps = markBps_;
        markObservedAt = observedAt_;
        markReceivedAt = block.timestamp;
        emit MarkUpdated(markBps_, observedAt_, block.timestamp, originChainId_, originTxHash_);
    }

    function trip(
        address sender_,
        int256 markBps_,
        uint256 outflowBps_,
        uint256 observedAt_,
        uint256 originChainId_,
        uint256 originTxHash_
    ) external onlyReactive(sender_) {
        if (tripped) return; // idempotent
        _accrueFunding();
        tripped = true;
        markBps = markBps_;
        tripMark = markBps_;
        tripOutflowBps = outflowBps_;
        trippedAt = block.timestamp;

        // Pay every live policy now, pro-rata if the pool can't cover all of them.
        uint256 live = activeNotional();
        uint256 ratio = live == 0 ? BPS : (poolAssets >= live ? BPS : (poolAssets * BPS) / live);
        payoutRatioBps = ratio;

        uint256 n = _policies.length;
        for (uint256 i; i < n; ++i) {
            Policy storage p = _policies[i];
            if (p.settled || p.expiry < block.timestamp) continue;
            p.settled = true;
            uint256 amount = (uint256(p.notional) * ratio) / BPS;
            poolAssets -= amount;
            collateral.safeTransfer(p.buyer, amount);
            emit PolicyPaid(i, p.buyer, amount);
        }

        emit Tripped(markBps_, outflowBps_, observedAt_, block.timestamp, originChainId_, originTxHash_, ratio);
    }

    // ================================================================ underwriting pool

    function deposit(uint256 assets_) external notTripped returns (uint256 shares) {
        if (assets_ == 0) revert ZeroAmount();
        shares = totalShares == 0 || poolAssets == 0 ? assets_ : (assets_ * totalShares) / poolAssets;
        collateral.safeTransferFrom(msg.sender, address(this), assets_);
        poolAssets += assets_;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposited(msg.sender, assets_, shares);
    }

    function withdraw(uint256 shares_) external returns (uint256 assets) {
        if (shares_ == 0) revert ZeroAmount();
        assets = (shares_ * poolAssets) / totalShares;
        // Underwriters can't pull capital that backs live coverage or open perp exposure.
        if (poolAssets - assets < reservedLiquidity()) revert InsufficientLiquidity();
        sharesOf[msg.sender] -= shares_;
        totalShares -= shares_;
        poolAssets -= assets;
        collateral.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares_);
    }

    // ================================================================ drain default swap

    /// @notice Buy drain protection: pays `notional_` if the vault is drained before `now + duration_`.
    function buyProtection(uint256 notional_, uint256 duration_) external notTripped returns (uint256 id) {
        if (notional_ == 0) revert ZeroAmount();
        if (duration_ < MIN_DURATION || duration_ > MAX_DURATION) revert BadDuration();

        uint256 premium = quotePremium(notional_, duration_);
        if (premium == 0) revert ZeroAmount();
        collateral.safeTransferFrom(msg.sender, address(this), premium);
        poolAssets += premium;

        if (activeNotional() + notional_ > poolAssets) revert InsufficientLiquidity();

        Policy memory p = Policy({
            buyer: msg.sender,
            notional: uint128(notional_),
            expiry: uint64(block.timestamp + duration_),
            settled: false
        });
        id = _storePolicy(p);
        emit ProtectionBought(id, msg.sender, notional_, premium, p.expiry);
    }

    function quotePremium(uint256 notional_, uint256 duration_) public view returns (uint256) {
        return (notional_ * premiumBpsPerDay * duration_) / (BPS * 1 days);
    }

    // ================================================================ spread perp

    function openPosition(bool isLong_, uint256 size_, uint256 margin_) external notTripped {
        if (markObservedAt == 0) revert NoMark();
        if (size_ == 0 || margin_ == 0) revert ZeroAmount();
        if (positions[msg.sender].open) revert PositionExists();
        if (size_ > margin_ * MAX_LEVERAGE) revert TooMuchLeverage();
        if (size_ > poolAssets) revert InsufficientLiquidity();

        _accrueFunding();
        collateral.safeTransferFrom(msg.sender, address(this), margin_);
        totalMargin += margin_;
        if (isLong_) openLongSize += size_;
        else openShortSize += size_;

        positions[msg.sender] = Position({
            open: true,
            isLong: isLong_,
            size: uint128(size_),
            margin: uint128(margin_),
            entryMark: markBps,
            entryCumFunding: cumFunding
        });
        emit PositionOpened(msg.sender, isLong_, size_, margin_, markBps);
    }

    function closePosition() external {
        _close(msg.sender, false);
    }

    function liquidate(address trader_) external {
        Position memory pos = positions[trader_];
        if (!pos.open) revert NoPosition();
        (int256 equity,,) = equityOf(trader_);
        if (equity >= int256((uint256(pos.size) * MAINTENANCE_BPS) / BPS)) revert NotLiquidatable();
        _close(trader_, true);
    }

    // ================================================================ views

    function currentCumFunding() public view returns (int256) {
        if (tripped) return cumFunding;
        return cumFunding + markBps * int256(block.timestamp - lastFundingAt);
    }

    /// @return equity margin + pnl - funding
    /// @return pnl mark-to-market PnL
    /// @return funding funding owed by the position (negative = received)
    function equityOf(address trader_) public view returns (int256 equity, int256 pnl, int256 funding) {
        Position memory pos = positions[trader_];
        if (!pos.open) return (0, 0, 0);
        int256 size = int256(uint256(pos.size));
        int256 dir = pos.isLong ? int256(1) : int256(-1);
        pnl = (dir * size * (markBps - pos.entryMark)) / int256(BPS);
        funding = (dir * size * (currentCumFunding() - pos.entryCumFunding)) / int256(FUNDING_DENOM);
        equity = int256(uint256(pos.margin)) + pnl - funding;
    }

    function activeNotional() public view returns (uint256 total) {
        uint256 n = _policies.length;
        for (uint256 i; i < n; ++i) {
            Policy memory p = _policies[i];
            if (!p.settled && p.expiry >= block.timestamp) total += p.notional;
        }
    }

    /// @notice Liquidity that must stay in the pool: live coverage + net perp exposure.
    function reservedLiquidity() public view returns (uint256) {
        uint256 netPerp = openLongSize > openShortSize ? openLongSize - openShortSize : openShortSize - openLongSize;
        return activeNotional() + netPerp;
    }

    function policiesCount() external view returns (uint256) {
        return _policies.length;
    }

    function policy(uint256 id_) external view returns (Policy memory) {
        return _policies[id_];
    }

    /// @notice Callback latency of the last mark, in Unichain seconds minus Reactive seconds (clocks can skew slightly).
    function lastMarkLatency() external view returns (int256) {
        return int256(markReceivedAt) - int256(markObservedAt);
    }

    // ================================================================ internals

    function _accrueFunding() internal {
        // Funding stops at the trip: positions settle at the trip mark with funding frozen.
        if (!tripped && block.timestamp > lastFundingAt) {
            cumFunding += markBps * int256(block.timestamp - lastFundingAt);
        }
        lastFundingAt = block.timestamp;
    }

    function _close(address trader_, bool liquidated_) internal {
        Position memory pos = positions[trader_];
        if (!pos.open) revert NoPosition();
        _accrueFunding();
        (int256 equity, int256 pnl, int256 funding) = equityOf(trader_);
        delete positions[trader_];

        totalMargin -= pos.margin;
        if (pos.isLong) openLongSize -= pos.size;
        else openShortSize -= pos.size;

        // The pool is the counterparty: it absorbs (margin - payout) or funds (payout - margin).
        uint256 payout = equity > 0 ? uint256(equity) : 0;
        if (liquidated_) payout = 0; // remaining equity goes to underwriters
        uint256 margin = pos.margin;
        if (payout > margin) {
            uint256 owed = payout - margin;
            if (owed > poolAssets) owed = poolAssets; // pool can't go negative
            poolAssets -= owed;
            payout = margin + owed;
        } else {
            poolAssets += margin - payout;
        }

        if (payout > 0) collateral.safeTransfer(trader_, payout);
        emit PositionClosed(trader_, pnl, funding, payout, liquidated_);
    }

    function _storePolicy(Policy memory p_) internal returns (uint256) {
        uint256 n = _policies.length;
        // Reuse a settled or expired slot before growing the array.
        for (uint256 i; i < n; ++i) {
            Policy memory old = _policies[i];
            if (old.settled || old.expiry < block.timestamp) {
                _policies[i] = p_;
                return i;
            }
        }
        if (n >= MAX_POLICIES) revert TooManyPolicies();
        _policies.push(p_);
        return n;
    }
}
