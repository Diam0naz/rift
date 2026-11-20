// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IPayable} from "@reactive/interfaces/IPayable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockToken} from "../../src/origin/MockToken.sol";
import {RiftMarket} from "../../src/market/RiftMarket.sol";

/// @notice Drives RiftMarket with random sequences of every user and callback action.
contract MarketHandler is Test {
    RiftMarket public immutable market;
    MockToken public immutable usd;
    address public immutable proxy;
    address public immutable rx;

    address[] public actors;
    uint256 public tripPaidOut; // sum of payouts + refunds fixed by trips
    uint256 public poolBeforeTrip;

    constructor(RiftMarket market_, MockToken usd_, address proxy_, address rx_) {
        market = market_;
        usd = usd_;
        proxy = proxy_;
        rx = rx_;
        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(0xA11CE + i));
            actors.push(a);
            usd.mint(a, 1e30);
            vm.prank(a);
            usd.approve(address(market), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed_) internal view returns (address) {
        return actors[seed_ % actors.length];
    }

    function deposit(uint256 seed_, uint256 amount_) external {
        amount_ = bound(amount_, 1, 1e24);
        vm.prank(_actor(seed_));
        try market.deposit(amount_) {} catch {}
    }

    function requestWithdraw(uint256 seed_, uint256 shares_) external {
        address a = _actor(seed_);
        uint256 held = market.sharesOf(a);
        if (held == 0) return;
        shares_ = bound(shares_, 1, held);
        vm.prank(a);
        try market.requestWithdraw(shares_) {} catch {}
    }

    function completeWithdraw(uint256 seed_) external {
        vm.prank(_actor(seed_));
        try market.completeWithdraw() {} catch {}
    }

    function cancelWithdraw(uint256 seed_) external {
        vm.prank(_actor(seed_));
        try market.cancelWithdraw() {} catch {}
    }

    function buyProtection(uint256 seed_, uint256 notional_, uint256 duration_) external {
        notional_ = bound(notional_, 1e18, 1e23);
        duration_ = bound(duration_, market.MIN_DURATION(), market.MAX_DURATION());
        vm.prank(_actor(seed_));
        try market.buyProtection(notional_, duration_) {} catch {}
    }

    function openPosition(uint256 seed_, bool isLong_, uint256 size_, uint256 lev_) external {
        size_ = bound(size_, 1e18, 1e23);
        lev_ = bound(lev_, 1, market.MAX_LEVERAGE());
        vm.prank(_actor(seed_));
        try market.openPosition(isLong_, size_, size_ / lev_ + 1) {} catch {}
    }

    function closePosition(uint256 seed_) external {
        vm.prank(_actor(seed_));
        try market.closePosition() {} catch {}
    }

    function liquidate(uint256 seed_) external {
        try market.liquidate(_actor(seed_)) {} catch {}
    }

    function updateMark(int256 mark_) external {
        mark_ = bound(mark_, -20_000, 20_000);
        vm.prank(proxy);
        market.updateMark(rx, mark_, block.timestamp, 84532, 0);
    }

    function trip(int256 mark_) external {
        if (market.tripped()) return;
        mark_ = bound(mark_, -20_000, 20_000);
        uint256 owedBefore = market.totalOwed();
        poolBeforeTrip = market.poolAssets();
        vm.prank(proxy);
        market.trip(rx, mark_, 3_000, block.timestamp, 84532, 0);
        tripPaidOut = market.totalOwed() - owedBefore;
    }

    function claim(uint256 id_) external {
        uint256 n = market.policiesCount();
        if (n == 0) return;
        try market.claim(id_ % n) {} catch {}
    }

    function warp(uint256 dt_) external {
        vm.warp(block.timestamp + bound(dt_, 1, 2 hours));
    }
}

/// @notice Solvency properties that must hold after any sequence of actions.
contract MarketInvariantTest is Test {
    RiftMarket internal market;
    MockToken internal usd;
    MarketHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        address proxy = makeAddr("proxy");
        address rx = makeAddr("rx");
        usd = new MockToken("Test USD", "tUSD");
        market = new RiftMarket(IPayable(payable(proxy)), IERC20(address(usd)));
        market.setReactive(rx);
        handler = new MarketHandler(market, usd, proxy, rx);

        // Seed the pool and a first mark so every action is reachable.
        usd.mint(address(this), 1e24);
        usd.approve(address(market), type(uint256).max);
        market.deposit(1e24);
        vm.prank(proxy);
        market.updateMark(rx, 0, block.timestamp, 84532, 0);

        targetContract(address(handler));
    }

    /// Every unit of collateral is accounted for: pool, trader margin, or owed to buyers.
    function invariant_collateralCoversAccounting() public view {
        assertGe(usd.balanceOf(address(market)), market.poolAssets() + market.totalMargin() + market.totalOwed());
    }

    /// A trip never commits more than the pool held when it fired.
    function invariant_tripPaysAtMostThePool() public view {
        assertLe(handler.tripPaidOut(), handler.poolBeforeTrip());
    }

    /// Every share is held or locked in a withdrawal request; none appear or vanish.
    function invariant_sharesConserved() public view {
        uint256 sum = market.sharesOf(address(this));
        for (uint256 i; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            (uint128 locked,) = market.withdrawRequests(a);
            sum += market.sharesOf(a) + locked;
        }
        assertEq(sum, market.totalShares(), "shares conserved");
    }

    /// Pool value stays within what the pool could ever hold.
    function invariant_poolValueBounded() public view {
        assertLe(market.poolValue(), market.poolAssets() + market.totalMargin());
    }

    /// The O(1) aggregate of open positions matches the sum of per-position equity (within rounding).
    function invariant_aggregatePnlMatchesPositions() public view {
        int256 sum;
        uint256 open;
        for (uint256 i; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            (bool isOpen,, uint128 size, uint128 margin,,) = market.positions(a);
            if (!isOpen) continue;
            ++open;
            (int256 equity,,) = market.equityOf(a);
            sum += equity - int256(uint256(margin));
            size;
        }
        int256 agg = market.tradersUnrealizedPnl();
        int256 diff = agg > sum ? agg - sum : sum - agg;
        assertLe(diff, int256(2 * open + 2), "aggregate within per-position rounding");
    }

    /// Payout ratio is a fraction.
    function invariant_payoutRatioBounded() public view {
        assertLe(market.payoutRatioBps(), market.BPS());
    }
}
