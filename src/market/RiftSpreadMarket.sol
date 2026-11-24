// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AbstractPayer} from "@reactive/base/AbstractPayer.sol";
import {IPayable} from "@reactive/interfaces/IPayable.sol";

/// @title RiftSpreadMarket
/// @notice A trader-created spread perp (Unichain Sepolia): long or short the gap between two pools, against an
///         underwriting pool. Created by RiftMarketFactory for any two pools of the same pair; marked by RiftHub
///         on Reactive Lasna, which watches both pools.
///
///  It is RiftMarket's perp and underwriting pool without the cover product: no policies and no trip. The mark
///  and funding rules are the same: funding accrues every second (positive spread: longs pay), positions are
///  marked to the hub's time-weighted spread, and new positions need a mark younger than MAX_MARK_AGE.
///  Nobody owns it: there are no admin functions.
contract RiftSpreadMarket is AbstractPayer {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_LEVERAGE = 10;
    uint256 public constant MAINTENANCE_BPS = 500; // 5% of size
    uint256 public constant LIQUIDATION_REWARD_BPS = 100; // 1% of size, paid from leftover margin
    /// @dev Underwriters who see a pool move on its own chain can't leave before the mark catches up.
    uint256 public constant WITHDRAW_DELAY = 1 hours;
    /// @dev The hub heartbeats every market at least every 30 minutes (on a ~17 minute cron).
    uint256 public constant MAX_MARK_AGE = 1 hours;
    /// @dev funding owed = size * Δ(cumulative bps·seconds) / FUNDING_DENOM: 100 bps held for a day costs 1% of size.
    uint256 public constant FUNDING_DENOM = BPS * 1 days;

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

    // ---------------------------------------------------------------- storage

    IERC20 public immutable collateral;
    /// @notice RiftHub on Lasna: the only sender whose marks are accepted.
    address public immutable reactive;
    address public immutable factory;
    uint256 public immutable marketId;

    uint256 public poolAssets;
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

    // ================================================================ reactive callback

    function updateMark(
        address sender_,
        int256 markBps_,
        uint256 observedAt_,
        uint256 originChainId_,
        uint256 originTxHash_
    ) external onlyReactive(sender_) {
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

    // ================================================================ underwriting pool

    function deposit(uint256 assets_) external returns (uint256 shares) {
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
        if (assets > poolAssets || poolAssets - assets < reservedLiquidity()) revert InsufficientLiquidity();
        delete withdrawRequests[msg.sender];
        totalShares -= r.shares;
        poolAssets -= assets;
        if (assets > 0) collateral.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, r.shares);
    }

    // ================================================================ spread perp

    function openPosition(bool isLong_, uint256 size_, uint256 margin_) external live {
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

    /// @notice Liquidity that must stay in the pool: the net perp exposure.
    function reservedLiquidity() public view returns (uint256) {
        return openLongSize > openShortSize ? openLongSize - openShortSize : openShortSize - openLongSize;
    }

    function lastMarkLatency() external view returns (int256) {
        return int256(markReceivedAt) - int256(markObservedAt);
    }

    // ================================================================ internals

    function _accrueFunding() internal {
        if (block.timestamp > lastFundingAt) {
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
}
