// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AbstractPayer} from "@reactive/base/AbstractPayer.sol";
import {IPayable} from "@reactive/interfaces/IPayable.sol";

/// @title RiftSpreadMarket
/// @notice A trader-created market on the gap between two pools (Unichain Sepolia), created by RiftMarketFactory
///         and settled by RiftHub on Reactive Lasna. One underwriting pool backs two products:
///
///  1. Spread perp: long or short the gap (B over A, in bps). Funding accrues every second (positive spread:
///     longs pay), positions are marked to the hub's time-weighted spread.
///  2. Drain cover, only once the hub has armed it: the market's creator proposed a vault, Rift approved it on
///     the factory, and the hub confirmed it is watching the vault with an `armCover` callback. Buyers pay a
///     premium for `notional` until `expiry`, starting COVER_DELAY after purchase. When the hub calls `trip()`
///     (spread broken for long enough AND the vault drained), covered policies are fixed in that transaction and
///     claimed later; policies still waiting are refunded. The perp freezes at the trip mark.
///
///  The rules are RiftMarket's, with its owner-set parameters fixed as constants: nobody owns this market.
///  New risk needs a mark younger than MAX_MARK_AGE, so a silent hub can't leave cover being sold blind.
contract RiftSpreadMarket is AbstractPayer {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_LEVERAGE = 10;
    uint256 public constant MAINTENANCE_BPS = 500; // 5% of size
    uint256 public constant LIQUIDATION_REWARD_BPS = 100; // 1% of size, paid from leftover margin
    /// @dev Longer than any trip takes to land (sustain <= 30 min + Reactive + callback), so an underwriter who
    ///      sees a drain on the vault's chain can't get out before the trip settles.
    uint256 public constant WITHDRAW_DELAY = 1 hours;
    /// @dev The hub heartbeats every market at least every 30 minutes (on a ~17 minute cron).
    uint256 public constant MAX_MARK_AGE = 1 hours;
    /// @dev funding owed = size * Δ(cumulative bps·seconds) / FUNDING_DENOM: 100 bps held for a day costs 1% of size.
    uint256 public constant FUNDING_DENOM = BPS * 1 days;

    /// @dev Bounded so one trip callback can settle every policy.
    uint256 public constant MAX_POLICIES = 32;
    /// @notice A drain is public on its own chain before the trip lands here; cover bought after it can't pay.
    uint256 public constant COVER_DELAY = 10 minutes;
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 internal constant WAD = 1e18;

    // Premium curve (RiftMarket's defaults): daily rate at utilization u = live cover / capacity.
    uint256 public constant BASE_BPS_PER_DAY = 10; // 0.10%/day idle
    uint256 public constant SLOPE1_BPS_PER_DAY = 10; // 0.20%/day at the kink
    uint256 public constant SLOPE2_BPS_PER_DAY = 200; // 2.20%/day fully committed
    uint256 public constant KINK_WAD = 0.8e18;
    uint256 public constant STRESS_SPREAD_BPS = 500; // the premium doubles at a 5% spread
    uint256 public constant MAX_STRESS_MULTIPLIER_BPS = 30_000;

    // ---------------------------------------------------------------- types

    struct WithdrawRequest {
        uint128 shares; // locked: no longer in sharesOf, still in totalShares (still at risk)
        uint64 unlockAt;
    }

    struct Position {
        bool open;
        bool isLong;
        uint128 size; // collateral units; PnL = size * Δspread(bps) / BPS
        uint128 margin;
        int256 entryMark;
        int256 entryCumFunding;
    }

    struct Policy {
        address buyer;
        uint64 activeAt; // coverage starts here
        uint64 expiry;
        bool settled; // resolved by a trip
        uint128 notional;
        uint128 premium;
        uint128 owed; // set by trip(): payout if covered, premium refund if still waiting
    }

    // ---------------------------------------------------------------- storage

    IERC20 public immutable collateral;
    /// @notice RiftHub on Lasna: the only sender whose callbacks are accepted.
    address public immutable reactive;
    address public immutable factory;
    uint256 public immutable marketId;

    uint256 public poolAssets; // cash the pool holds (excludes trader margin and amounts owed to buyers)
    uint256 public totalShares;
    mapping(address user => uint256 shares) public sharesOf;
    mapping(address user => WithdrawRequest request) public withdrawRequests;

    int256 public markBps;
    uint256 public markObservedAt; // Reactive's clock
    uint256 public markReceivedAt; // Unichain's clock
    int256 public cumFunding;
    uint256 public lastFundingAt;

    mapping(address trader => Position position) public positions;
    uint256 public totalMargin;
    uint256 public openLongSize;
    uint256 public openShortSize;
    int256 internal _longSizeEntryMark;
    int256 internal _shortSizeEntryMark;
    int256 internal _longSizeEntryFunding;
    int256 internal _shortSizeEntryFunding;

    /// @notice True once the hub watches this market's vault: only then is cover sold.
    bool public coverArmed;
    uint256 public coverArmedAt;
    mapping(uint256 id => Policy policy) internal _policies;
    uint256 public nextPolicyId;
    uint256[] internal _activeIds;

    bool public tripped;
    int256 public tripMark;
    uint256 public tripOutflowBps;
    uint256 public trippedAt;
    uint256 public payoutRatioBps;
    uint256 public totalOwed; // settled but unclaimed payouts and refunds, already out of poolAssets

    // ---------------------------------------------------------------- events

    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event WithdrawRequested(address indexed user, uint256 shares, uint256 unlockAt);
    event WithdrawCancelled(address indexed user, uint256 shares);
    event Withdrawn(address indexed user, uint256 assets, uint256 shares);
    event MarkUpdated(
        int256 markBps, uint256 observedAt, uint256 receivedAt, uint256 originChainId, uint256 originTxHash
    );
    event StaleMarkIgnored(int256 markBps, uint256 observedAt, uint256 currentObservedAt);
    event PositionOpened(address indexed trader, bool isLong, uint256 size, uint256 margin, int256 entryMark);
    event PositionClosed(address indexed trader, int256 pnl, int256 funding, uint256 payout, bool liquidated);
    event Liquidated(address indexed trader, address indexed liquidator, uint256 reward);
    event CoverArmed(uint256 vaultBalance);
    event ProtectionBought(
        uint256 indexed id, address indexed buyer, uint256 notional, uint256 premium, uint256 activeAt, uint256 expiry
    );
    event PolicySettled(uint256 indexed id, address indexed buyer, uint256 owed, bool covered);
    event Claimed(uint256 indexed id, address indexed buyer, uint256 amount);
    /// @dev The hub subscribes to this as the delivery confirmation of its trip callback.
    event Tripped(
        int256 markBps,
        uint256 outflowBps,
        uint256 observedAt,
        uint256 receivedAt,
        uint256 originChainId,
        uint256 originTxHash,
        uint256 payoutRatioBps
    );

    // ---------------------------------------------------------------- errors

    error UnauthorizedReactive(address sender);
    error ZeroAmount();
    error InsufficientLiquidity();
    error NoMark();
    error StaleMark(uint256 age);
    error PositionExists();
    error NoPosition();
    error TooMuchLeverage();
    error NotLiquidatable();
    error PoolInsolvent();
    error WithdrawPending();
    error NoWithdrawRequest();
    error WithdrawLocked(uint256 unlockAt);
    error InsufficientShares();
    error IsTripped();
    error CoverNotArmed();
    error BadDuration();
    error TooManyPolicies();
    error NothingToClaim();

    modifier onlyReactive(address sender_) {
        _onlyServiceProvider();
        if (sender_ != reactive) revert UnauthorizedReactive(sender_);
        _;
    }

    modifier live() {
        if (markReceivedAt == 0) revert NoMark();
        uint256 age = block.timestamp - markReceivedAt;
        if (age > MAX_MARK_AGE) revert StaleMark(age);
        _;
    }

    modifier notTripped() {
        if (tripped) revert IsTripped();
        _;
    }

    constructor(IPayable callbackProxy_, IERC20 collateral_, address reactive_, uint256 marketId_)
        payable
        AbstractPayer(callbackProxy_)
    {
        collateral = collateral_;
        reactive = reactive_;
        factory = msg.sender;
        marketId = marketId_;
        lastFundingAt = block.timestamp;
    }

    /// @notice Pay outstanding callback debt to the proxy from this contract's native balance.
    function coverDebt() external {
        _coverDebt();
    }

    // ================================================================ reactive callbacks

    function updateMark(
        address sender_,
        int256 markBps_,
        uint256 observedAt_,
        uint256 originChainId_,
        uint256 originTxHash_
    ) external onlyReactive(sender_) {
        if (tripped) return; // the perp is frozen at the trip mark
        // Callbacks can land out of order: never let an older observation overwrite a newer one.
        if (observedAt_ < markObservedAt) {
            emit StaleMarkIgnored(markBps_, observedAt_, markObservedAt);
            return;
        }
        _accrueFunding();
        markBps = markBps_;
        markObservedAt = observedAt_;
        markReceivedAt = block.timestamp;
        emit MarkUpdated(markBps_, observedAt_, block.timestamp, originChainId_, originTxHash_);
    }

    /// @notice The hub has subscribed to the vault's flows: cover can be sold from now on. Idempotent.
    function armCover(address sender_, uint256 vaultBalance_) external onlyReactive(sender_) {
        if (coverArmed) return;
        coverArmed = true;
        coverArmedAt = block.timestamp;
        emit CoverArmed(vaultBalance_);
    }

    /// @notice Settles every live policy against the trip's observation time and freezes the perp. Idempotent.
    function trip(
        address sender_,
        int256 markBps_,
        uint256 outflowBps_,
        uint256 observedAt_,
        uint256 originChainId_,
        uint256 originTxHash_
    ) external onlyReactive(sender_) {
        if (tripped || !coverArmed) return;
        _accrueFunding();
        tripped = true;
        markBps = markBps_;
        tripMark = markBps_;
        tripOutflowBps = outflowBps_;
        trippedAt = block.timestamp;

        // Pass 1: policies still waiting are voided and refunded. No external calls anywhere in here.
        uint256 n = _activeIds.length;
        uint256 coveredNotional;
        for (uint256 i; i < n; ++i) {
            uint256 id = _activeIds[i];
            Policy storage p = _policies[id];
            if (p.settled || p.expiry < observedAt_) continue;
            if (p.activeAt > observedAt_) {
                _settle(id, p, p.premium <= poolAssets ? p.premium : poolAssets, false);
            } else {
                coveredNotional += p.notional;
            }
        }
        // Pass 2: covered policies get their notional, pro rata if the pool can't pay all of them.
        uint256 available = poolAssets;
        bool full = coveredNotional <= available;
        uint256 ratio = full ? BPS : (available * BPS) / coveredNotional;
        payoutRatioBps = ratio;
        for (uint256 i; i < n; ++i) {
            uint256 id = _activeIds[i];
            Policy storage p = _policies[id];
            if (p.settled || p.expiry < observedAt_) continue;
            uint256 notional = p.notional;
            _settle(id, p, full ? notional : (notional * available) / coveredNotional, true);
        }
        delete _activeIds;
        emit Tripped(markBps_, outflowBps_, observedAt_, block.timestamp, originChainId_, originTxHash_, ratio);
    }

    // ================================================================ underwriting pool

    function deposit(uint256 assets_) external notTripped returns (uint256 shares) {
        if (assets_ == 0) revert ZeroAmount();
        _accrueFunding();
        if (totalShares == 0) {
            shares = assets_;
        } else {
            uint256 value = poolValue();
            if (value == 0) revert PoolInsolvent();
            shares = (assets_ * totalShares) / value;
        }
        if (shares == 0) revert ZeroAmount();
        collateral.safeTransferFrom(msg.sender, address(this), assets_);
        poolAssets += assets_;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposited(msg.sender, assets_, shares);
    }

    function requestWithdraw(uint256 shares_) external {
        if (shares_ == 0) revert ZeroAmount();
        if (withdrawRequests[msg.sender].shares != 0) revert WithdrawPending();
        if (shares_ > sharesOf[msg.sender]) revert InsufficientShares();
        sharesOf[msg.sender] -= shares_;
        uint64 unlockAt = SafeCast.toUint64(block.timestamp + WITHDRAW_DELAY);
        withdrawRequests[msg.sender] = WithdrawRequest({shares: SafeCast.toUint128(shares_), unlockAt: unlockAt});
        emit WithdrawRequested(msg.sender, shares_, unlockAt);
    }

    function cancelWithdraw() external {
        uint256 shares = withdrawRequests[msg.sender].shares;
        if (shares == 0) revert NoWithdrawRequest();
        delete withdrawRequests[msg.sender];
        sharesOf[msg.sender] += shares;
        emit WithdrawCancelled(msg.sender, shares);
    }

    function completeWithdraw() external returns (uint256 assets) {
        WithdrawRequest memory r = withdrawRequests[msg.sender];
        if (r.shares == 0) revert NoWithdrawRequest();
        if (block.timestamp < r.unlockAt) revert WithdrawLocked(r.unlockAt);
        _accrueFunding();
        assets = (uint256(r.shares) * poolValue()) / totalShares;
        // Capital backing live cover and net perp exposure stays in.
        if (assets > poolAssets || poolAssets - assets < reservedLiquidity()) revert InsufficientLiquidity();
        delete withdrawRequests[msg.sender];
        totalShares -= r.shares;
        poolAssets -= assets;
        if (assets > 0) collateral.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, r.shares);
    }

    // ================================================================ drain cover

    /// @notice Buy cover: pays `notional_` if the hub trips this market before `now + duration_`, once
    ///         COVER_DELAY has passed.
    function buyProtection(uint256 notional_, uint256 duration_) external notTripped live returns (uint256 id) {
        if (!coverArmed) revert CoverNotArmed();
        if (notional_ == 0) revert ZeroAmount();
        if (duration_ < MIN_DURATION || duration_ > MAX_DURATION) revert BadDuration();
        uint256 premium = quotePremium(notional_, duration_);
        if (premium == 0) revert ZeroAmount();
        collateral.safeTransferFrom(msg.sender, address(this), premium);
        poolAssets += premium;
        if (reservedLiquidity() + notional_ > poolAssets) revert InsufficientLiquidity();
        _pruneExpired();
        if (_activeIds.length >= MAX_POLICIES) revert TooManyPolicies();

        uint64 activeAt = SafeCast.toUint64(block.timestamp + COVER_DELAY);
        uint64 expiry = SafeCast.toUint64(block.timestamp + duration_);
        id = nextPolicyId++;
        _policies[id] = Policy({
            buyer: msg.sender,
            activeAt: activeAt,
            expiry: expiry,
            settled: false,
            notional: SafeCast.toUint128(notional_),
            premium: SafeCast.toUint128(premium),
            owed: 0
        });
        _activeIds.push(id);
        emit ProtectionBought(id, msg.sender, notional_, premium, activeAt, expiry);
    }

    /// @notice Pay out a settled policy. Anyone can call it; funds always go to the buyer.
    function claim(uint256 id_) external returns (uint256 amount) {
        Policy storage p = _policies[id_];
        amount = p.owed;
        if (amount == 0) revert NothingToClaim();
        p.owed = 0;
        totalOwed -= amount;
        collateral.safeTransfer(p.buyer, amount);
        emit Claimed(id_, p.buyer, amount);
    }

    /// @notice Premium for `notional_` over `duration_` seconds: the integral of the rate curve over the
    ///         utilization this purchase adds (so splitting an order doesn't make it cheaper), times spread stress.
    function quotePremium(uint256 notional_, uint256 duration_) public view returns (uint256) {
        (uint256 n0, uint256 capacity) = _coverAndCapacity();
        if (capacity == 0) revert InsufficientLiquidity();
        uint256 u0 = Math.mulDiv(n0, WAD, capacity);
        uint256 u1 = Math.mulDiv(n0 + notional_, WAD, capacity, Math.Rounding.Ceil);
        uint256 area = _rateIntegral(u1) - _rateIntegral(u0);
        uint256 premium = Math.mulDiv(area, capacity * duration_, WAD * BPS * 1 days, Math.Rounding.Ceil);
        return Math.mulDiv(premium, stressMultiplierBps(), BPS, Math.Rounding.Ceil);
    }

    function premiumRateBpsPerDay(uint256 u_) public pure returns (uint256) {
        if (u_ <= KINK_WAD) return BASE_BPS_PER_DAY + (SLOPE1_BPS_PER_DAY * u_) / KINK_WAD;
        return BASE_BPS_PER_DAY + SLOPE1_BPS_PER_DAY + (SLOPE2_BPS_PER_DAY * (u_ - KINK_WAD)) / (WAD - KINK_WAD);
    }

    function utilizationWad() public view returns (uint256) {
        (uint256 cover, uint256 capacity) = _coverAndCapacity();
        return capacity == 0 ? 0 : Math.mulDiv(cover, WAD, capacity);
    }

    function stressMultiplierBps() public view returns (uint256) {
        uint256 absMark = markBps >= 0 ? uint256(markBps) : uint256(-markBps);
        uint256 m = BPS + (absMark * BPS) / STRESS_SPREAD_BPS;
        return m > MAX_STRESS_MULTIPLIER_BPS ? MAX_STRESS_MULTIPLIER_BPS : m;
    }

    function activeNotional() public view returns (uint256 total) {
        (total,) = _liveCover();
    }

    function policiesCount() external view returns (uint256) {
        return nextPolicyId;
    }

    function activePolicyIds() external view returns (uint256[] memory) {
        return _activeIds;
    }

    function policy(uint256 id_) external view returns (Policy memory) {
        return _policies[id_];
    }

    // ================================================================ spread perp

    function openPosition(bool isLong_, uint256 size_, uint256 margin_) external notTripped live {
        if (size_ == 0 || margin_ == 0) revert ZeroAmount();
        if (positions[msg.sender].open) revert PositionExists();
        if (size_ > margin_ * MAX_LEVERAGE) revert TooMuchLeverage();
        if (size_ > poolAssets) revert InsufficientLiquidity();

        _accrueFunding();
        collateral.safeTransferFrom(msg.sender, address(this), margin_);
        totalMargin += margin_;
        int256 sizeEntryMark = int256(size_) * markBps;
        int256 sizeEntryFunding = int256(size_) * cumFunding;
        if (isLong_) {
            openLongSize += size_;
            _longSizeEntryMark += sizeEntryMark;
            _longSizeEntryFunding += sizeEntryFunding;
        } else {
            openShortSize += size_;
            _shortSizeEntryMark += sizeEntryMark;
            _shortSizeEntryFunding += sizeEntryFunding;
        }
        positions[msg.sender] = Position({
            open: true,
            isLong: isLong_,
            size: SafeCast.toUint128(size_),
            margin: SafeCast.toUint128(margin_),
            entryMark: markBps,
            entryCumFunding: cumFunding
        });
        emit PositionOpened(msg.sender, isLong_, size_, margin_, markBps);
    }

    function closePosition() external {
        _close(msg.sender, address(0));
    }

    function liquidate(address trader_) external {
        Position memory pos = positions[trader_];
        if (!pos.open) revert NoPosition();
        (int256 equity,,) = equityOf(trader_);
        if (equity >= int256((uint256(pos.size) * MAINTENANCE_BPS) / BPS)) revert NotLiquidatable();
        _close(trader_, msg.sender);
    }

    // ================================================================ views

    function currentCumFunding() public view returns (int256) {
        if (tripped) return cumFunding;
        return cumFunding + markBps * int256(block.timestamp - lastFundingAt);
    }

    function equityOf(address trader_) public view returns (int256 equity, int256 pnl, int256 funding) {
        Position memory pos = positions[trader_];
        if (!pos.open) return (0, 0, 0);
        int256 size = int256(uint256(pos.size));
        int256 dir = pos.isLong ? int256(1) : int256(-1);
        pnl = (dir * size * (markBps - pos.entryMark)) / int256(BPS);
        funding = (dir * size * (currentCumFunding() - pos.entryCumFunding)) / int256(FUNDING_DENOM);
        equity = int256(uint256(pos.margin)) + pnl - funding;
    }

    function tradersUnrealizedPnl() public view returns (int256) {
        int256 longSize = int256(openLongSize);
        int256 shortSize = int256(openShortSize);
        int256 cf = currentCumFunding();
        int256 pnl = (longSize * markBps - _longSizeEntryMark) - (shortSize * markBps - _shortSizeEntryMark);
        int256 funding = (longSize * cf - _longSizeEntryFunding) - (shortSize * cf - _shortSizeEntryFunding);
        return pnl / int256(BPS) - funding / int256(FUNDING_DENOM);
    }

    function poolValue() public view returns (uint256) {
        int256 value = int256(poolAssets) - tradersUnrealizedPnl();
        if (value <= 0) return 0;
        uint256 cap = poolAssets + totalMargin;
        return uint256(value) > cap ? cap : uint256(value);
    }

    /// @notice Liquidity that must stay in the pool: live cover plus net perp exposure.
    function reservedLiquidity() public view returns (uint256) {
        uint256 netPerp = openLongSize > openShortSize ? openLongSize - openShortSize : openShortSize - openLongSize;
        return activeNotional() + netPerp;
    }

    function lastMarkLatency() external view returns (int256) {
        return int256(markReceivedAt) - int256(markObservedAt);
    }

    // ================================================================ internals

    function _accrueFunding() internal {
        // Funding stops at the trip: positions settle at the trip mark.
        if (!tripped && block.timestamp > lastFundingAt) {
            cumFunding += markBps * int256(block.timestamp - lastFundingAt);
        }
        lastFundingAt = block.timestamp;
    }

    function _close(address trader_, address liquidator_) internal {
        Position memory pos = positions[trader_];
        if (!pos.open) revert NoPosition();
        _accrueFunding();
        (int256 equity, int256 pnl, int256 funding) = equityOf(trader_);
        delete positions[trader_];

        totalMargin -= pos.margin;
        int256 size = int256(uint256(pos.size));
        if (pos.isLong) {
            openLongSize -= pos.size;
            _longSizeEntryMark -= size * pos.entryMark;
            _longSizeEntryFunding -= size * pos.entryCumFunding;
        } else {
            openShortSize -= pos.size;
            _shortSizeEntryMark -= size * pos.entryMark;
            _shortSizeEntryFunding -= size * pos.entryCumFunding;
        }

        uint256 margin = pos.margin;
        bool liquidated = liquidator_ != address(0);
        uint256 payout = equity > 0 ? uint256(equity) : 0;
        uint256 reward = 0;
        if (liquidated) {
            uint256 maxReward = (uint256(pos.size) * LIQUIDATION_REWARD_BPS) / BPS;
            reward = payout < maxReward ? payout : maxReward;
            payout = 0;
            poolAssets += margin - reward;
        } else if (payout > margin) {
            uint256 owed = payout - margin;
            if (owed > poolAssets) owed = poolAssets;
            poolAssets -= owed;
            payout = margin + owed;
        } else {
            poolAssets += margin - payout;
        }

        if (payout > 0) collateral.safeTransfer(trader_, payout);
        emit PositionClosed(trader_, pnl, funding, payout, liquidated);
        if (liquidated) {
            if (reward > 0) collateral.safeTransfer(liquidator_, reward);
            emit Liquidated(trader_, liquidator_, reward);
        }
    }

    function _settle(uint256 id_, Policy storage p_, uint256 owed_, bool covered_) internal {
        p_.settled = true;
        p_.owed = SafeCast.toUint128(owed_);
        poolAssets -= owed_;
        totalOwed += owed_;
        emit PolicySettled(id_, p_.buyer, owed_, covered_);
    }

    function _liveCover() internal view returns (uint256 notional, uint256 premiums) {
        uint256 n = _activeIds.length;
        for (uint256 i; i < n; ++i) {
            Policy storage p = _policies[_activeIds[i]];
            if (!p.settled && p.expiry >= block.timestamp) {
                notional += p.notional;
                premiums += p.premium;
            }
        }
    }

    /// @dev Capacity is pool cash minus live premiums, so buying cover doesn't enlarge what it's priced against.
    function _coverAndCapacity() internal view returns (uint256 cover, uint256 capacity) {
        uint256 premiums;
        (cover, premiums) = _liveCover();
        capacity = poolAssets > premiums ? poolAssets - premiums : 0;
    }

    /// @dev ∫_0^u rate(x) dx, in (bps/day) * WAD.
    function _rateIntegral(uint256 u_) internal pure returns (uint256) {
        if (u_ <= KINK_WAD) {
            return BASE_BPS_PER_DAY * u_ + Math.mulDiv(SLOPE1_BPS_PER_DAY * u_, u_, 2 * KINK_WAD);
        }
        uint256 d = u_ - KINK_WAD;
        return BASE_BPS_PER_DAY * u_ + (SLOPE1_BPS_PER_DAY * KINK_WAD) / 2 + SLOPE1_BPS_PER_DAY * d
            + Math.mulDiv(SLOPE2_BPS_PER_DAY * d, d, 2 * (WAD - KINK_WAD));
    }

    function _pruneExpired() internal {
        uint256 i;
        while (i < _activeIds.length) {
            if (_policies[_activeIds[i]].expiry < block.timestamp) {
                _activeIds[i] = _activeIds[_activeIds.length - 1];
                _activeIds.pop();
            } else {
                ++i;
            }
        }
    }
}
