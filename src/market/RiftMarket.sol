// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AbstractPayer} from "@reactive/base/AbstractPayer.sol";
import {IPayable} from "@reactive/interfaces/IPayable.sol";

/// @title RiftMarket
/// @notice One underwriting pool, two products, settled by RiftReactive callbacks (Unichain Sepolia).
///
///  1. Drain Default Swap (jump leg): buyers pay a premium up front for coverage of `notional` until `expiry`.
///     Coverage starts `coverDelay` after purchase, so a policy bought after a drain is already public can't pay.
///     When RiftReactive calls `trip()`, every covered policy's payout is fixed in that transaction;
///     buyers (or anyone on their behalf) then `claim()` it. Policies still waiting get their premium back.
///  2. Spread perp (continuous leg): long/short the Unichain-vs-Base price spread (in bps) against the pool.
///     Funding accrues every second: when the spread is positive, longs pay; when negative, shorts pay.
///     On trip, the perp freezes and every position settles at the trip mark.
///
///  Underwriters deposit collateral, earn premiums and perp losses, and pay out protection and perp profits.
///  Shares are priced at `poolValue()`, which includes traders' unrealized perp PnL, and withdrawals wait
///  `WITHDRAW_DELAY` while the shares stay at risk.
contract RiftMarket is AbstractPayer {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_POLICIES = 64; // bounded so trip() can settle everyone in one callback
    uint256 public constant MAX_COVER_DELAY = 1 hours;
    uint256 public constant MIN_MARK_AGE_LIMIT = 5 minutes;
    uint256 public constant MAX_MARK_AGE_LIMIT = 1 days;
    uint256 public constant MIN_DURATION = 60;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant MAX_LEVERAGE = 10;
    uint256 public constant MAINTENANCE_BPS = 500; // 5% of size
    uint256 public constant LIQUIDATION_REWARD_BPS = 100; // 1% of size, paid to the liquidator from leftover margin
    /// @dev Longer than any trip takes to land (sustain + Reactive + callback), so an underwriter who sees a drain
    ///      on the origin chain can't get out before the trip settles.
    uint256 public constant WITHDRAW_DELAY = 1 hours;
    /// @dev funding owed = size * Δ(cumulative bps·seconds) / FUNDING_DENOM
    ///      -> a 100 bps spread held for one day costs the paying side 1% of size.
    uint256 public constant FUNDING_DENOM = BPS * 1 days;
    uint256 internal constant WAD = 1e18;
    /// @dev Upper bounds on owner-set pricing parameters.
    uint256 public constant MAX_RATE_BPS_PER_DAY = 1_000; // 10%/day for any one curve term
    uint256 public constant MAX_STRESS_MULTIPLIER_BPS = 30_000; // stress can at most triple the premium

    // ---------------------------------------------------------------- types

    /// @dev Packed into 3 slots: [buyer, activeAt] [expiry, settled, notional] [premium, owed].
    ///      `settled` and `owed` share slots that are already non-zero, which keeps trip() cheap.
    struct Policy {
        address buyer;
        uint64 activeAt; // coverage starts here (Unichain clock at purchase + coverDelay)
        uint64 expiry;
        bool settled; // resolved by a trip
        uint128 notional;
        uint128 premium;
        uint128 owed; // set by trip(): payout if covered, premium refund if still waiting; paid out by claim()
    }

    /// @notice Premium curve. The daily rate for the marginal unit of cover depends on utilization
    ///         u = active notional / pool cash (in WAD):
    ///         Capacity is pool cash minus premiums of live policies, so buying cover doesn't enlarge the
    ///         capacity it's priced against.
    ///           u <= kink: rate = base + slope1 * u / kink
    ///           u >  kink: rate = base + slope1 + slope2 * (u - kink) / (1 - kink)
    ///         A purchase pays the integral of the rate from u before to u after, so splitting an order
    ///         doesn't make it cheaper (an LMSR-style cost function on pool capacity). The result is
    ///         scaled up by spread stress: x(1 + |mark| / stressSpreadBps), capped at MAX_STRESS_MULTIPLIER_BPS.
    struct PremiumParams {
        uint64 baseBpsPerDay; // rate at zero utilization
        uint64 slope1BpsPerDay; // added between 0 and the kink
        uint64 slope2BpsPerDay; // added between the kink and full utilization
        uint64 kinkWad; // utilization where the steep part starts, in (0, 1e18)
        uint64 stressSpreadBps; // |mark| at which the premium doubles; 0 = no stress loading
    }

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

    // ---------------------------------------------------------------- storage

    IERC20 public immutable collateral;
    address public immutable owner;
    address public reactive; // RiftReactive on Lasna, set once after it is deployed

    PremiumParams public premiumParams = PremiumParams({
        baseBpsPerDay: 10, // 0.10%/day when the pool is idle
        slope1BpsPerDay: 10, // 0.20%/day at the kink
        slope2BpsPerDay: 200, // 2.20%/day when fully committed
        kinkWad: 0.8e18,
        stressSpreadBps: 500 // premium doubles at a 5% spread, the default trip threshold
    });
    /// @notice Waiting period before a new policy covers anything. A drain on the origin chain is public
    ///         seconds before the trip lands here; without this, anyone could buy cover after the fact.
    uint256 public coverDelay = 10 minutes;
    /// @notice Liveness guard: no new cover or positions if the last mark landed longer ago than this.
    ///         RiftReactive sends a heartbeat mark at least every `markHeartbeat` (driven by its cron), so
    ///         silence means the Reactive side is down or unfunded - and then a drain could never trip.
    uint256 public maxMarkAge = 1 hours;

    // Underwriting pool
    uint256 public poolAssets; // cash the pool holds (excludes trader margin and amounts owed to buyers)
    uint256 public totalShares; // includes shares locked in withdrawal requests
    mapping(address user => uint256 shares) public sharesOf;
    mapping(address user => WithdrawRequest request) public withdrawRequests;

    // Mark + funding
    int256 public markBps;
    uint256 public markObservedAt; // Reactive's clock when the mark was computed
    uint256 public markReceivedAt; // Unichain's clock when the callback landed
    int256 public cumFunding; // Σ markBps * dt (bps·seconds)
    uint256 public lastFundingAt;

    // Products
    mapping(uint256 id => Policy policy) internal _policies; // ids are never reused
    uint256 public nextPolicyId;
    uint256[] internal _activeIds; // unsettled policies; expired ones are pruned lazily. Bounded by MAX_POLICIES.
    mapping(address trader => Position position) public positions;
    uint256 public totalMargin;
    uint256 public openLongSize;
    uint256 public openShortSize;
    // Aggregates of open positions, so traders' total unrealized PnL is O(1): Σ size·entryMark, Σ size·entryCumFunding
    int256 internal _longSizeEntryMark;
    int256 internal _shortSizeEntryMark;
    int256 internal _longSizeEntryFunding;
    int256 internal _shortSizeEntryFunding;

    // Trip
    bool public tripped;
    int256 public tripMark;
    uint256 public tripOutflowBps;
    uint256 public trippedAt;
    uint256 public payoutRatioBps;
    uint256 public totalOwed; // settled but unclaimed payouts and refunds, already removed from poolAssets

    // ---------------------------------------------------------------- events

    event ReactiveSet(address reactive);
    event PremiumParamsUpdated(PremiumParams params);
    event CoverDelayUpdated(uint256 coverDelay);
    event MaxMarkAgeUpdated(uint256 maxMarkAge);
    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event WithdrawRequested(address indexed user, uint256 shares, uint256 unlockAt);
    event WithdrawCancelled(address indexed user, uint256 shares);
    event Withdrawn(address indexed user, uint256 assets, uint256 shares);
    event MarkUpdated(
        int256 markBps, uint256 observedAt, uint256 receivedAt, uint256 originChainId, uint256 originTxHash
    );
    event StaleMarkIgnored(int256 markBps, uint256 observedAt, uint256 currentObservedAt);
    event ProtectionBought(
        uint256 indexed id, address indexed buyer, uint256 notional, uint256 premium, uint256 activeAt, uint256 expiry
    );
    /// @param covered true = payout for a covered policy; false = premium refund for one still in its waiting period
    event PolicySettled(uint256 indexed id, address indexed buyer, uint256 owed, bool covered);
    event Claimed(uint256 indexed id, address indexed buyer, uint256 amount);
    event Tripped(
        int256 markBps,
        uint256 outflowBps,
        uint256 observedAt,
        uint256 receivedAt,
        uint256 originChainId,
        uint256 originTxHash,
        uint256 payoutRatioBps
    );
    event PositionOpened(address indexed trader, bool isLong, uint256 size, uint256 margin, int256 entryMark);
    event PositionClosed(address indexed trader, int256 pnl, int256 funding, uint256 payout, bool liquidated);
    event Liquidated(address indexed trader, address indexed liquidator, uint256 reward);

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error ReactiveAlreadySet();
    error ZeroAddress();
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
    error BadCoverDelay();
    error BadMaxMarkAge();
    error StaleMark(uint256 age);
    error NothingToClaim();
    error UnclaimedPayouts();
    error PoolInsolvent();
    error BadPremiumParams();
    error WithdrawPending();
    error NoWithdrawRequest();
    error WithdrawLocked(uint256 unlockAt);
    error InsufficientShares();

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

    /// @dev New risk is only taken while the Reactive side is provably alive.
    modifier live() {
        if (markReceivedAt == 0) revert NoMark();
        uint256 age = block.timestamp - markReceivedAt;
        if (age > maxMarkAge) revert StaleMark(age);
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
        if (reactive_ == address(0)) revert ZeroAddress();
        if (reactive != address(0)) revert ReactiveAlreadySet();
        reactive = reactive_;
        emit ReactiveSet(reactive_);
    }

    function setPremiumParams(PremiumParams calldata p_) external onlyOwner {
        if (
            p_.kinkWad == 0 || p_.kinkWad >= WAD || p_.baseBpsPerDay == 0 || p_.baseBpsPerDay > MAX_RATE_BPS_PER_DAY
                || p_.slope1BpsPerDay > MAX_RATE_BPS_PER_DAY || p_.slope2BpsPerDay > MAX_RATE_BPS_PER_DAY
        ) revert BadPremiumParams();
        premiumParams = p_;
        emit PremiumParamsUpdated(p_);
    }

    function setCoverDelay(uint256 delay_) external onlyOwner {
        if (delay_ > MAX_COVER_DELAY) revert BadCoverDelay();
        coverDelay = delay_; // applies to policies bought from now on; existing ones keep their activeAt
        emit CoverDelayUpdated(delay_);
    }

    function setMaxMarkAge(uint256 age_) external onlyOwner {
        if (age_ < MIN_MARK_AGE_LIMIT || age_ > MAX_MARK_AGE_LIMIT) revert BadMaxMarkAge();
        maxMarkAge = age_;
        emit MaxMarkAgeUpdated(age_);
    }

    /// @notice Pay outstanding callback debt to the proxy from this contract's native balance.
    function coverDebt() external {
        _coverDebt();
    }

    /// @notice DEMO ONLY: clear trip state and settled policies so the loop can be replayed.
    ///         Refuses while any payout or refund is unclaimed, so a reset can't erase what buyers are owed.
    function resetDemo() external onlyOwner {
        if (!tripped) revert NotTripped();
        if (totalOwed != 0) revert UnclaimedPayouts();
        tripped = false;
        tripMark = 0;
        tripOutflowBps = 0;
        trippedAt = 0;
        payoutRatioBps = 0;
        delete _activeIds; // already empty after a trip; settled policies stay readable by id
        lastFundingAt = block.timestamp;
    }

    // ================================================================ reactive callbacks

    function updateMark(
        address sender_,
        int256 markBps_,
        uint256 observedAt_,
        uint256 originChainId_,
        uint256 originTxHash_
    ) external onlyReactive(sender_) {
        if (tripped) return; // late marks after a trip are ignored
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

        // Settle every live policy against the trip's observation time (Reactive's clock), with no
        // external calls: one buyer that can't receive tokens must not be able to revert the whole trip.
        // Pass 1: policies still in their waiting period are voided and refunded their premium.
        uint256 n = _activeIds.length;
        uint256 coveredNotional = 0;
        for (uint256 i; i < n; ++i) {
            uint256 id = _activeIds[i];
            Policy storage p = _policies[id];
            if (p.settled || p.expiry < observedAt_) continue;
            if (p.activeAt > observedAt_) {
                uint256 refund = p.premium <= poolAssets ? p.premium : poolAssets;
                _settle(id, p, refund, false);
            } else {
                coveredNotional += p.notional;
            }
        }

        // Pass 2: covered policies get their notional, pro-rata if the pool can't cover all of them.
        // Each payout is computed from the pool snapshot in one step (no rounded ratio in between),
        // so the sum of payouts never exceeds the pool. payoutRatioBps is informational.
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
        delete _activeIds; // every entry is now settled or expired

        emit Tripped(markBps_, outflowBps_, observedAt_, block.timestamp, originChainId_, originTxHash_, ratio);
    }

    // ================================================================ underwriting pool

    /// @notice Deposit collateral for pool shares, priced at `poolValue()` (unrealized perp PnL included).
    function deposit(uint256 assets_) external notTripped returns (uint256 shares) {
        if (assets_ == 0) revert ZeroAmount();
        if (totalShares == 0) {
            shares = assets_;
        } else {
            uint256 value = poolValue();
            if (value == 0) revert PoolInsolvent();
            shares = (assets_ * totalShares) / value; // rounds down: in favour of existing holders
        }
        if (shares == 0) revert ZeroAmount();
        collateral.safeTransferFrom(msg.sender, address(this), assets_);
        poolAssets += assets_;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposited(msg.sender, assets_, shares);
    }

    /// @notice Step 1 of 2: lock shares for withdrawal. They keep earning and losing like any other share
    ///         until `completeWithdraw`, so requesting right after seeing a drain doesn't dodge the trip.
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

    /// @notice Step 2 of 2: after `WITHDRAW_DELAY`, burn the locked shares at the pool value at this moment.
    function completeWithdraw() external returns (uint256 assets) {
        WithdrawRequest memory r = withdrawRequests[msg.sender];
        if (r.shares == 0) revert NoWithdrawRequest();
        if (block.timestamp < r.unlockAt) revert WithdrawLocked(r.unlockAt);
        _accrueFunding();
        assets = (uint256(r.shares) * poolValue()) / totalShares; // rounds down: in favour of remaining holders
        // Underwriters can't pull capital that backs live coverage or open perp exposure.
        if (assets > poolAssets || poolAssets - assets < reservedLiquidity()) revert InsufficientLiquidity();
        delete withdrawRequests[msg.sender];
        totalShares -= r.shares;
        poolAssets -= assets;
        if (assets > 0) collateral.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, r.shares);
    }

    // ================================================================ drain default swap

    /// @notice Buy drain protection: pays `notional_` if the vault is drained before `now + duration_`.
    function buyProtection(uint256 notional_, uint256 duration_) external notTripped live returns (uint256 id) {
        if (notional_ == 0) revert ZeroAmount();
        if (duration_ < MIN_DURATION || duration_ > MAX_DURATION) revert BadDuration();

        uint256 premium = quotePremium(notional_, duration_);
        if (premium == 0) revert ZeroAmount();
        collateral.safeTransferFrom(msg.sender, address(this), premium);
        poolAssets += premium;

        if (activeNotional() + notional_ > poolAssets) revert InsufficientLiquidity();

        _pruneExpired();
        if (_activeIds.length >= MAX_POLICIES) revert TooManyPolicies();

        Policy memory p = Policy({
            buyer: msg.sender,
            activeAt: SafeCast.toUint64(block.timestamp + coverDelay),
            expiry: SafeCast.toUint64(block.timestamp + duration_),
            settled: false,
            notional: SafeCast.toUint128(notional_),
            premium: SafeCast.toUint128(premium),
            owed: 0
        });
        id = nextPolicyId++;
        _policies[id] = p;
        _activeIds.push(id);
        emit ProtectionBought(id, msg.sender, notional_, premium, p.activeAt, p.expiry);
    }

    /// @notice Pay out a settled policy's payout or refund. Anyone can call it; funds always go to the buyer.
    function claim(uint256 id_) external returns (uint256 amount) {
        Policy storage p = _policies[id_]; // an unknown id has owed == 0 and reverts below
        amount = p.owed;
        if (amount == 0) revert NothingToClaim();
        p.owed = 0;
        totalOwed -= amount;
        collateral.safeTransfer(p.buyer, amount);
        emit Claimed(id_, p.buyer, amount);
    }

    /// @notice Premium for `notional_` of cover over `duration_` seconds at the current utilization and mark.
    function quotePremium(uint256 notional_, uint256 duration_) public view returns (uint256) {
        (uint256 n0, uint256 capacity) = _coverAndCapacity();
        if (capacity == 0) revert InsufficientLiquidity();
        uint256 u0 = Math.mulDiv(n0, WAD, capacity);
        uint256 u1 = Math.mulDiv(n0 + notional_, WAD, capacity, Math.Rounding.Ceil);
        // ∫ rate du is in bps/day * WAD; times capacity gives bps/day * notional * WAD.
        uint256 area = _rateIntegral(u1) - _rateIntegral(u0);
        uint256 premium = Math.mulDiv(area, capacity * duration_, WAD * BPS * 1 days, Math.Rounding.Ceil);
        return Math.mulDiv(premium, stressMultiplierBps(), BPS, Math.Rounding.Ceil);
    }

    /// @notice Daily premium rate, in bps of notional, for the marginal unit of cover at utilization `u_` (WAD).
    function premiumRateBpsPerDay(uint256 u_) public view returns (uint256) {
        PremiumParams memory p = premiumParams;
        if (u_ <= p.kinkWad) return p.baseBpsPerDay + (uint256(p.slope1BpsPerDay) * u_) / p.kinkWad;
        return p.baseBpsPerDay + p.slope1BpsPerDay + (uint256(p.slope2BpsPerDay) * (u_ - p.kinkWad)) / (WAD - p.kinkWad);
    }

    /// @notice Current utilization of pool cash by live cover, in WAD.
    function utilizationWad() public view returns (uint256) {
        (uint256 cover, uint256 capacity) = _coverAndCapacity();
        return capacity == 0 ? 0 : Math.mulDiv(cover, WAD, capacity);
    }

    /// @notice Premium multiplier from spread stress, in bps (10_000 = none).
    function stressMultiplierBps() public view returns (uint256) {
        uint256 scale = premiumParams.stressSpreadBps;
        if (scale == 0) return BPS;
        uint256 absMark = markBps >= 0 ? uint256(markBps) : uint256(-markBps);
        uint256 m = BPS + (absMark * BPS) / scale;
        return m > MAX_STRESS_MULTIPLIER_BPS ? MAX_STRESS_MULTIPLIER_BPS : m;
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

    /// @notice Traders' total unrealized PnL net of funding, from the open-position aggregates.
    ///         Positive = the pool owes traders. Summed over positions without the zero floor on each
    ///         trader's equity, so deep-underwater positions count as pool gains beyond their margin until
    ///         liquidated - which the liquidation reward keeps rare.
    function tradersUnrealizedPnl() public view returns (int256) {
        int256 longSize = int256(openLongSize);
        int256 shortSize = int256(openShortSize);
        int256 cf = currentCumFunding();
        int256 pnl = (longSize * markBps - _longSizeEntryMark) - (shortSize * markBps - _shortSizeEntryMark);
        int256 funding = (longSize * cf - _longSizeEntryFunding) - (shortSize * cf - _shortSizeEntryFunding);
        return pnl / int256(BPS) - funding / int256(FUNDING_DENOM);
    }

    /// @notice What the pool is worth to share holders: cash minus what open positions are owed.
    ///         Bounded below by 0 and above by cash plus all trader margin (the most the pool could collect).
    function poolValue() public view returns (uint256) {
        int256 value = int256(poolAssets) - tradersUnrealizedPnl();
        if (value <= 0) return 0;
        uint256 cap = poolAssets + totalMargin;
        return uint256(value) > cap ? cap : uint256(value);
    }

    function activeNotional() public view returns (uint256 total) {
        (total,) = _liveCover();
    }

    /// @notice Liquidity that must stay in the pool: live coverage + net perp exposure.
    function reservedLiquidity() public view returns (uint256) {
        uint256 netPerp = openLongSize > openShortSize ? openLongSize - openShortSize : openShortSize - openLongSize;
        return activeNotional() + netPerp;
    }

    /// @notice Policies ever sold; ids run from 0 to policiesCount() - 1.
    function policiesCount() external view returns (uint256) {
        return nextPolicyId;
    }

    function activePolicyIds() external view returns (uint256[] memory) {
        return _activeIds;
    }

    function policy(uint256 id_) external view returns (Policy memory) {
        return _policies[id_];
    }

    /// @notice Callback latency of the last mark, in Unichain seconds minus Reactive seconds.
    /// @dev The two clocks can skew slightly, so this can be off by a second or so.
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

    /// @param liquidator_ address(0) for a normal close; otherwise the caller of `liquidate`, who is paid the reward.
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
            // Liquidator gets up to LIQUIDATION_REWARD_BPS of size out of what's left; the rest goes to the pool.
            // Liquidation needs equity < 5% of size <= margin, so the reward always fits inside the margin.
            uint256 maxReward = (uint256(pos.size) * LIQUIDATION_REWARD_BPS) / BPS;
            reward = payout < maxReward ? payout : maxReward;
            payout = 0;
            poolAssets += margin - reward;
        } else if (payout > margin) {
            // The pool is the counterparty: it funds (payout - margin), up to what it has.
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

    /// @dev Notional and premiums of policies that are live now.
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

    /// @dev Live notional, and the capacity premiums are priced against: pool cash minus live premiums.
    function _coverAndCapacity() internal view returns (uint256 cover, uint256 capacity) {
        uint256 premiums;
        (cover, premiums) = _liveCover();
        capacity = poolAssets > premiums ? poolAssets - premiums : 0;
    }

    /// @dev ∫_0^u rate(x) dx, in (bps/day) * WAD. The steep segment continues past u = 1, which a purchase
    ///      can only touch by its own premium's worth before the capacity check rejects it.
    function _rateIntegral(uint256 u_) internal view returns (uint256) {
        PremiumParams memory p = premiumParams;
        uint256 k = p.kinkWad;
        if (u_ <= k) {
            return p.baseBpsPerDay * u_ + Math.mulDiv(uint256(p.slope1BpsPerDay) * u_, u_, 2 * k);
        }
        uint256 d = u_ - k;
        return p.baseBpsPerDay * u_ + (uint256(p.slope1BpsPerDay) * k) / 2 + uint256(p.slope1BpsPerDay) * d
            + Math.mulDiv(uint256(p.slope2BpsPerDay) * d, d, 2 * (WAD - k));
    }

    /// @dev Drop expired policies from the active list (swap-and-pop). Their data stays readable by id.
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
