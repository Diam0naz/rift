// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IReactive} from "@reactive/interfaces/IReactive.sol";
import {IPayable} from "@reactive/interfaces/IPayable.sol";
import {ISystemContract} from "@reactive/interfaces/ISystemContract.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {MockSystem} from "./mocks/MockSystem.sol";
import {MockToken} from "../src/origin/MockToken.sol";
import {RiftReactive} from "../src/reactive/RiftReactive.sol";
import {RiftMarket} from "../src/market/RiftMarket.sol";

/// @notice End-to-end loop in one EVM:
///   fake origin logs -> RiftReactive.react() -> recorded callback -> replayed through a fake proxy -> RiftMarket.
contract RiftTest is Test {
    address internal constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 internal constant BASE = 84532;
    uint256 internal constant UNI = 1301;

    uint256 internal constant SYNC = uint256(keccak256("Sync(uint112,uint112)"));
    uint256 internal constant TRANSFER = uint256(keccak256("Transfer(address,address,uint256)"));
    uint256 internal constant TRIPPED =
        uint256(keccak256("Tripped(int256,uint256,uint256,uint256,uint256,uint256,uint256)"));

    address internal poolBase = makeAddr("poolBase");
    address internal poolUni = makeAddr("poolUni");
    address internal vaultAsset = makeAddr("vaultAsset");
    address internal vault = makeAddr("vault");
    address internal proxy = makeAddr("callbackProxy");

    address internal underwriter = makeAddr("underwriter");
    address internal buyer = makeAddr("buyer");
    address internal trader = makeAddr("trader");
    address internal attacker = makeAddr("attacker");

    MockToken internal usd;
    RiftMarket internal market;
    RiftReactive internal rx;

    uint256 internal constant VAULT_BAL = 1_000_000e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.etch(SYSTEM, address(new MockSystem()).code);

        usd = new MockToken("Test USD", "tUSD");
        market = new RiftMarket(IPayable(payable(proxy)), IERC20(address(usd)));

        rx = new RiftReactive(
            RiftReactive.Config({
                baseChainId: BASE,
                uniChainId: UNI,
                poolBase: poolBase,
                poolUni: poolUni,
                vaultAsset: vaultAsset,
                vault: vault,
                market: address(market),
                initialVaultBalance: VAULT_BAL,
                cronTopic: 0
            }),
            RiftReactive.Params({
                tripSpreadBps: 500, // 5%
                sustainSeconds: 2,
                windowSeconds: 300,
                tripOutflowBps: 1500, // 15%
                markEpsilonBps: 10,
                markHeartbeat: 60,
                markSmoothingSeconds: 30,
                minQuoteReserve: 100e18
            })
        );
        market.setReactive(address(rx));

        _fund(underwriter, 100_000e18);
        _fund(buyer, 1_000e18);
        _fund(trader, 10_000e18);

        vm.prank(underwriter);
        market.deposit(100_000e18);
    }

    // ---------------------------------------------------------------- reactive side

    function test_subscriptions() public view {
        assertEq(MockSystem(payable(SYSTEM)).subsCount(), 5); // 2 Sync, 2 vault Transfer, 1 market Tripped
    }

    function test_firstSyncPairSendsMark() public {
        _sync(BASE, poolBase, 1_000e18, 2_000e18); // price 2.0
        assertEq(_callbacks(), 0, "needs both prices");
        _sync(UNI, poolUni, 1_000e18, 2_020e18); // price 2.02 -> +100 bps
        assertEq(_callbacks(), 1);
        assertEq(rx.spreadBps(), 100);

        _deliverAll();
        assertEq(market.markBps(), 100);
    }

    function test_smallMoveIsThrottled() public {
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        _sync(UNI, poolUni, 1_000e18, 2_000e18);
        _sync(UNI, poolUni, 1_000e18, 2_001e18); // +5 bps < epsilon
        assertEq(_callbacks(), 1);
    }

    function test_priceSpikeAloneDoesNotTrip() public {
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        _sync(UNI, poolUni, 1_000e18, 2_000e18);
        _sync(BASE, poolBase, 1_000e18, 1_600e18); // -20% on Base
        vm.warp(block.timestamp + 10);
        _sync(BASE, poolBase, 1_000e18, 1_600e18);
        assertFalse(rx.tripped(), "no outflow, no trip");
    }

    function test_withdrawalAloneDoesNotTrip() public {
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        _sync(UNI, poolUni, 1_000e18, 2_000e18);
        _transfer(vault, attacker, 400_000e18); // 40% out, but prices aligned
        vm.warp(block.timestamp + 10);
        _transfer(vault, attacker, 1e18);
        assertFalse(rx.tripped(), "no spread breach, no trip");
    }

    function test_outflowExpiresFromWindow() public {
        _transfer(vault, attacker, 200_000e18);
        assertEq(rx.outflowBps(), 2000);
        vm.warp(block.timestamp + 301);
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        assertEq(rx.outflowBps(), 0);
    }

    function test_hugeOutflowIsClampedAndFullyExpires() public {
        // Window entries store uint192; a larger amount must not leave windowOutflow stuck after pruning.
        _transfer(vault, attacker, uint256(1) << 200);
        assertEq(rx.windowOutflow(), type(uint192).max);
        vm.warp(block.timestamp + 301);
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        assertEq(rx.windowOutflow(), 0);
    }

    // ---------------------------------------------------------------- mark hardening

    function test_spikeRevertedInSameSecondDoesNotMoveMark() public {
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        _sync(UNI, poolUni, 1_000e18, 2_000e18);
        uint256 sent = _callbacks();
        assertEq(rx.smoothedSpreadBps(), 0);

        // Push the Base pool hard and put it back inside one Reactive second.
        _sync(BASE, poolBase, 1_000e18, 2_400e18); // spot spread -1,667 bps
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        assertEq(rx.smoothedSpreadBps(), 0, "zero-duration spike has zero weight");
        assertEq(_callbacks(), sent, "no mark pushed");

        vm.warp(block.timestamp + 60);
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        assertEq(rx.smoothedSpreadBps(), 0, "the reverted price is what held");
    }

    function test_sustainedMoveReachesMarkOverSmoothingWindow() public {
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        _sync(UNI, poolUni, 1_000e18, 2_000e18);
        _sync(UNI, poolUni, 1_000e18, 2_040e18); // spot +200 bps from now on
        assertEq(rx.smoothedSpreadBps(), 0);

        vm.warp(block.timestamp + 15); // half of markSmoothingSeconds (30)
        _sync(UNI, poolUni, 1_000e18, 2_040e18);
        assertEq(rx.smoothedSpreadBps(), 100);
        _deliverAll();
        assertEq(market.markBps(), 100, "smoothed mark is what the perp sees");

        vm.warp(block.timestamp + 30);
        _sync(UNI, poolUni, 1_000e18, 2_040e18);
        assertEq(rx.smoothedSpreadBps(), 200);
    }

    function test_thinPoolSyncIsIgnored() public {
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        vm.expectEmit(address(rx));
        emit RiftReactive.ThinPoolIgnored(BASE, 50e18, block.number);
        _sync(BASE, poolBase, 10e18, 50e18); // below minQuoteReserve (100e18)
        assertEq(rx.priceBase(), 2e18, "last good price kept");
    }

    function test_heartbeatResendsUnchangedMark() public {
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        _sync(UNI, poolUni, 1_000e18, 2_000e18);
        uint256 sent = _callbacks();

        vm.warp(block.timestamp + 30);
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        assertEq(_callbacks(), sent, "before heartbeat: nothing new");

        vm.warp(block.timestamp + 31); // past markHeartbeat (60)
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        assertEq(_callbacks(), sent + 1, "liveness ping with the same mark");
    }

    // ---------------------------------------------------------------- liveness guard

    function test_staleMarkBlocksNewRiskButNotExits() public {
        _pushMark(0);
        vm.startPrank(trader);
        usd.approve(address(market), type(uint256).max);
        market.openPosition(true, 1_000e18, 500e18);
        vm.stopPrank();

        uint256 age = market.maxMarkAge() + 1;
        vm.warp(block.timestamp + age);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(RiftMarket.StaleMark.selector, age));
        market.buyProtection(1_000e18, 1 days);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(RiftMarket.StaleMark.selector, age));
        market.openPosition(true, 1_000e18, 500e18);

        vm.prank(trader);
        market.closePosition(); // exits always work

        _pushMark(0); // Reactive side is back
        vm.prank(buyer);
        market.buyProtection(1_000e18, 1 days);
    }

    function test_maxMarkAgeIsBounded() public {
        vm.expectRevert(RiftMarket.BadMaxMarkAge.selector);
        market.setMaxMarkAge(1 minutes);
        vm.expectRevert(RiftMarket.BadMaxMarkAge.selector);
        market.setMaxMarkAge(2 days);
        market.setMaxMarkAge(30 minutes);
        assertEq(market.maxMarkAge(), 30 minutes);
    }

    // ---------------------------------------------------------------- underwriting accounting

    function _openLong(int256 entryMark, uint256 size, uint256 margin) internal {
        _pushMark(entryMark);
        vm.startPrank(trader);
        usd.approve(address(market), type(uint256).max);
        market.openPosition(true, size, margin);
        vm.stopPrank();
    }

    function _withdrawAll(address who) internal returns (uint256 received) {
        uint256 before = usd.balanceOf(who);
        uint256 shares = market.sharesOf(who);
        vm.prank(who);
        market.requestWithdraw(shares);
        vm.warp(block.timestamp + market.WITHDRAW_DELAY());
        vm.prank(who);
        market.completeWithdraw();
        received = usd.balanceOf(who) - before;
    }

    function test_poolValueIncludesUnrealizedPerpPnl() public {
        _openLong(0, 10_000e18, 1_000e18);
        assertEq(market.poolValue(), 100_000e18);
        _pushMark(1_000); // long up 10% of size: the pool owes the trader 1,000
        assertEq(market.tradersUnrealizedPnl(), 1_000e18);
        assertEq(market.poolValue(), 99_000e18);
        _pushMark(-1_000); // long down 1,000: the pool is owed it
        assertEq(market.poolValue(), 101_000e18);
    }

    function test_newcomerCannotBuyIntoUnrealizedGains() public {
        _openLong(0, 10_000e18, 1_000e18);
        _pushMark(-1_000); // trader losing 1,000 to the pool, not yet realized

        address newcomer = makeAddr("newcomer");
        _fund(newcomer, 10_000e18);
        vm.prank(newcomer);
        market.deposit(10_000e18);

        vm.prank(trader);
        market.closePosition(); // the pool realizes the 1,000

        _pushMark(0); // keep the mark fresh; no positions left, so funding is irrelevant
        uint256 back = _withdrawAll(newcomer);
        assertLe(back, 10_000e18, "no share of gains that predate the deposit");
        assertApproxEqAbs(back, 10_000e18, 1e6, "but nothing lost either");
    }

    function test_withdrawerBearsUnrealizedPerpLoss() public {
        address u2 = makeAddr("u2");
        _fund(u2, 100_000e18);
        vm.prank(u2);
        market.deposit(100_000e18);

        _openLong(0, 10_000e18, 1_000e18);
        _pushMark(1_000); // the pool owes the trader 1,000

        uint256 u2Shares = market.sharesOf(u2);
        vm.prank(u2);
        market.requestWithdraw(u2Shares);
        vm.warp(block.timestamp + market.WITHDRAW_DELAY());
        _pushMark(1_000);
        uint256 expected = (100_000e18 * market.poolValue()) / market.totalShares();
        uint256 before = usd.balanceOf(u2);
        vm.prank(u2);
        market.completeWithdraw();
        uint256 back = usd.balanceOf(u2) - before;
        assertEq(back, expected, "priced at pool value at completion");
        assertLt(back, 100_000e18, "takes its half of the open loss");
    }

    function test_withdrawalWaitsAndCanBeCancelled() public {
        uint256 shares = market.sharesOf(underwriter);
        vm.startPrank(underwriter);
        market.requestWithdraw(shares / 2);
        assertEq(market.sharesOf(underwriter), shares - shares / 2);
        assertEq(market.totalShares(), shares, "locked shares stay in the pool");

        uint256 unlockAt = block.timestamp + market.WITHDRAW_DELAY();
        vm.expectRevert(abi.encodeWithSelector(RiftMarket.WithdrawLocked.selector, unlockAt));
        market.completeWithdraw();

        vm.expectRevert(RiftMarket.WithdrawPending.selector);
        market.requestWithdraw(1);

        market.cancelWithdraw();
        assertEq(market.sharesOf(underwriter), shares);
        vm.expectRevert(RiftMarket.NoWithdrawRequest.selector);
        market.completeWithdraw();
        vm.stopPrank();
    }

    function test_lockedSharesStillPayForATripDuringTheDelay() public {
        _pushMark(0);
        vm.prank(buyer);
        uint256 id = market.buyProtection(10_000e18, 1 days);
        uint256 premium = market.policy(id).premium;
        vm.warp(block.timestamp + market.coverDelay());

        // The underwriter sees the drain on Base and asks to leave...
        uint256 shares = market.sharesOf(underwriter);
        vm.prank(underwriter);
        market.requestWithdraw(shares);
        // ...but the trip lands inside the delay.
        _forceTrip();

        vm.warp(block.timestamp + market.WITHDRAW_DELAY());
        vm.prank(underwriter);
        market.completeWithdraw();
        assertEq(usd.balanceOf(underwriter), 100_000e18 + premium - 10_000e18, "paid the claim like everyone");
    }

    function test_liquidatorIsPaidFromLeftoverMargin() public {
        _openLong(0, 10_000e18, 1_000e18);
        _pushMark(-960); // equity 40 < maintenance 500
        uint256 poolBefore = market.poolAssets();

        vm.expectEmit(address(market));
        emit RiftMarket.Liquidated(trader, attacker, 40e18);
        vm.prank(attacker);
        market.liquidate(trader);
        assertEq(usd.balanceOf(attacker), 40e18, "reward = leftover equity, under the 1% cap");
        assertEq(market.poolAssets(), poolBefore + 960e18, "pool keeps the rest of the margin");
    }

    function test_liquidationRewardIsCapped() public {
        _openLong(0, 10_000e18, 1_000e18);
        _pushMark(-800); // equity 200: liquidatable, leftover above the cap
        uint256 poolBefore = market.poolAssets();
        vm.prank(attacker);
        market.liquidate(trader);
        assertEq(usd.balanceOf(attacker), 100e18, "1% of size");
        assertEq(market.poolAssets(), poolBefore + 900e18);
    }

    function test_policyIdsAreNeverReused() public {
        _pushMark(0);
        vm.prank(buyer);
        uint256 first = market.buyProtection(1_000e18, 1 hours);
        vm.warp(block.timestamp + 2 hours);
        _pushMark(0);

        address other = makeAddr("other");
        _fund(other, 1_000e18);
        vm.prank(other);
        uint256 second = market.buyProtection(1_000e18, 1 days);

        assertEq(second, first + 1);
        assertEq(market.policy(first).buyer, buyer, "old id still points at the old policy");
        assertEq(market.policy(second).buyer, other);
        uint256[] memory ids = market.activePolicyIds();
        assertEq(ids.length, 1, "expired policy pruned from the active list");
        assertEq(ids[0], second);
    }

    function test_activePolicyCapFreesUpAsPoliciesExpire() public {
        _pushMark(0);
        _fund(buyer, 1_000_000e18);
        vm.startPrank(buyer);
        for (uint256 i; i < market.MAX_POLICIES(); ++i) {
            market.buyProtection(100e18, 1 hours);
        }
        vm.expectRevert(RiftMarket.TooManyPolicies.selector);
        market.buyProtection(100e18, 1 hours);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 hours);
        _pushMark(0);
        vm.prank(buyer);
        uint256 id = market.buyProtection(100e18, 1 hours);
        assertEq(id, market.MAX_POLICIES(), "next fresh id, not a recycled slot");
    }

    // ---------------------------------------------------------------- premium pricing

    function test_premiumAtLowUtilizationIsNearBaseRate() public {
        _pushMark(0);
        // 10k of cover on a 100k pool: u goes 0 -> 0.1. Area = 10*0.1 + 10*0.1^2/(2*0.8) = 1.0625 bps-days per unit.
        assertApproxEqAbs(market.quotePremium(10_000e18, 1 days), 10.625e18, 1e3);
        assertApproxEqAbs(market.quotePremium(10_000e18, 2 days), 21.25e18, 1e3, "linear in duration");
    }

    function test_premiumRateKinksUpAtHighUtilization() public view {
        assertEq(market.premiumRateBpsPerDay(0), 10);
        assertEq(market.premiumRateBpsPerDay(0.4e18), 15);
        assertEq(market.premiumRateBpsPerDay(0.8e18), 20, "kink");
        assertEq(market.premiumRateBpsPerDay(0.9e18), 120, "steep past the kink");
        assertEq(market.premiumRateBpsPerDay(1e18), 220);
    }

    function test_coverGetsDearerAsThePoolFillsUp() public {
        _pushMark(0);
        _fund(buyer, 1_000_000e18);
        uint256 first = market.quotePremium(10_000e18, 1 days);
        uint256 last;
        for (uint256 i; i < 9; ++i) {
            uint256 q = market.quotePremium(10_000e18, 1 days);
            assertGt(q, last, "each 10% slice costs more than the one before");
            last = q;
            vm.prank(buyer);
            market.buyProtection(10_000e18, 1 days);
        }
        // Premiums don't count as capacity, so u is exactly 0.9 here. The last slice (0.9 -> 1.0) pays
        // 10*0.1 + 10*0.1 + 200*(0.2^2 - 0.1^2)/(2*0.2) = 17 bps-days per unit: 170 on 100k.
        assertEq(market.utilizationWad(), 0.9e18);
        uint256 top = market.quotePremium(10_000e18, 1 days);
        assertApproxEqAbs(top, 170e18, 1e3);
        assertGt(top, 15 * first, "the last slice costs ~16x the first");
    }

    function testFuzz_splittingAnOrderIsNotCheaper(uint256 a, uint256 b, uint256 duration) public {
        _pushMark(0);
        a = bound(a, 1e18, 50_000e18);
        b = bound(b, 1e18, 45_000e18);
        duration = bound(duration, market.MIN_DURATION(), market.MAX_DURATION());
        _fund(buyer, 10_000_000e18);

        uint256 whole = market.quotePremium(a + b, duration);
        uint256 before = usd.balanceOf(buyer);
        vm.startPrank(buyer);
        market.buyProtection(a, duration);
        market.buyProtection(b, duration);
        vm.stopPrank();
        uint256 split = before - usd.balanceOf(buyer);
        assertGe(split + 2, whole, "two halves cost at least the whole (up to rounding)");
        assertApproxEqRel(split, whole, 1e12, "and essentially the same");
    }

    function test_spreadStressLoadsThePremium() public {
        _pushMark(0);
        uint256 calm = market.quotePremium(10_000e18, 1 days);
        _pushMark(250); // half the stress scale
        assertEq(market.stressMultiplierBps(), 15_000);
        assertApproxEqAbs(market.quotePremium(10_000e18, 1 days), calm * 3 / 2, 1e3);
        _pushMark(-5_000); // way past the scale: capped at 3x
        assertEq(market.stressMultiplierBps(), 30_000);
        assertApproxEqAbs(market.quotePremium(10_000e18, 1 days), calm * 3, 1e3);
    }

    function test_premiumParamsAreBounded() public {
        RiftMarket.PremiumParams memory p = RiftMarket.PremiumParams({
            baseBpsPerDay: 10, slope1BpsPerDay: 10, slope2BpsPerDay: 200, kinkWad: 1e18, stressSpreadBps: 500
        });
        vm.expectRevert(RiftMarket.BadPremiumParams.selector);
        market.setPremiumParams(p); // kink must be < 100%
        p.kinkWad = 0.5e18;
        p.slope2BpsPerDay = 5_000;
        vm.expectRevert(RiftMarket.BadPremiumParams.selector);
        market.setPremiumParams(p); // slope above 10%/day
        p.slope2BpsPerDay = 300;
        market.setPremiumParams(p);
        (,, uint64 slope2, uint64 kink,) = market.premiumParams();
        assertEq(slope2, 300);
        assertEq(kink, 0.5e18);

        vm.prank(attacker);
        vm.expectRevert(RiftMarket.NotOwner.selector);
        market.setPremiumParams(p);
    }

    // ---------------------------------------------------------------- full loop

    function test_drainTripsAndPaysProtection() public {
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        _sync(UNI, poolUni, 1_000e18, 2_000e18);
        _deliverAll();

        vm.prank(buyer);
        uint256 id = market.buyProtection(10_000e18, 1 days);
        uint256 before = usd.balanceOf(buyer);
        vm.warp(block.timestamp + market.coverDelay()); // coverage is live

        // Exploit: vault drained and loot dumped on Base -> Base price collapses.
        _transfer(vault, attacker, 300_000e18); // 30% outflow
        _sync(BASE, poolBase, 1_400e18, 1_500e18); // price ~1.07, spread ~ +86%
        assertFalse(rx.tripped(), "breach must be sustained");

        vm.warp(block.timestamp + 2);
        _transfer(vault, attacker, 50_000e18);
        assertTrue(rx.tripped());

        _deliverAll();
        assertTrue(market.tripped());
        assertEq(market.payoutRatioBps(), 10_000);
        assertEq(market.policy(id).owed, 10_000e18, "payout fixed by the trip callback");

        market.claim(id); // anyone can trigger it; funds go to the buyer
        assertEq(usd.balanceOf(buyer) - before, 10_000e18, "paid in full");
        assertEq(market.totalOwed(), 0);
    }

    // ---------------------------------------------------------------- fix 1: cover waiting period

    function test_policyBoughtInsideCoverDelayIsRefundedNotPaid() public {
        _pushMark(0); // the market only sells cover while marks are fresh
        address late = makeAddr("late");
        _fund(late, 1_000e18);

        vm.prank(buyer);
        uint256 early = market.buyProtection(10_000e18, 1 days);
        vm.warp(block.timestamp + market.coverDelay());

        // The drain is public on Base; someone buys cover seconds before the trip lands.
        uint256 lateBefore = usd.balanceOf(late);
        vm.prank(late);
        uint256 lateId = market.buyProtection(50_000e18, 1 days);
        uint256 premium = lateBefore - usd.balanceOf(late);
        assertGt(premium, 0);

        _forceTrip();

        RiftMarket.Policy memory pe = market.policy(early);
        RiftMarket.Policy memory pl = market.policy(lateId);
        assertEq(pe.owed, 10_000e18, "covered policy paid");
        assertEq(pl.owed, premium, "late policy only gets its premium back");
        assertEq(market.payoutRatioBps(), 10_000, "late notional doesn't dilute covered buyers");

        market.claim(lateId);
        assertEq(usd.balanceOf(late), lateBefore, "late buyer made whole, no payout");
    }

    function test_coverDelayIsBoundedAndNotRetroactive() public {
        _pushMark(0); // the market only sells cover while marks are fresh
        vm.expectRevert(RiftMarket.BadCoverDelay.selector);
        market.setCoverDelay(2 hours);

        vm.prank(buyer);
        uint256 id = market.buyProtection(10_000e18, 1 days);
        uint64 activeAt = market.policy(id).activeAt;
        assertEq(activeAt, block.timestamp + 10 minutes);

        market.setCoverDelay(0);
        assertEq(market.policy(id).activeAt, activeAt, "existing policy keeps its start");

        _forceTrip(); // trip observed now, before the policy's start
        assertEq(market.policy(id).owed, market.policy(id).premium, "still refunded, not paid");
    }

    // ---------------------------------------------------------------- fix 3: pull payouts + trip retry

    function test_claimIsOneShotAndBlocksDemoReset() public {
        _pushMark(0); // the market only sells cover while marks are fresh
        vm.prank(buyer);
        uint256 id = market.buyProtection(10_000e18, 1 days);
        vm.warp(block.timestamp + market.coverDelay());
        _forceTrip();

        vm.expectRevert(RiftMarket.UnclaimedPayouts.selector);
        market.resetDemo();

        vm.prank(attacker); // a third party can push the claim; it still pays the buyer
        market.claim(id);
        assertEq(usd.balanceOf(buyer), 1_000e18 - market.policy(id).premium + 10_000e18);

        vm.expectRevert(RiftMarket.NothingToClaim.selector);
        market.claim(id);

        market.resetDemo(); // fine once everything is claimed
        assertFalse(market.tripped());
    }

    function test_tripSucceedsWhenOneBuyerCannotReceive() public {
        BlockingToken btk = new BlockingToken();
        RiftMarket m = new RiftMarket(IPayable(payable(proxy)), IERC20(address(btk)));
        m.setReactive(address(rx));
        vm.prank(proxy);
        m.updateMark(address(rx), 0, block.timestamp, BASE, 0);
        btk.mint(address(this), 100_000e18);
        btk.approve(address(m), type(uint256).max);
        m.deposit(100_000e18);

        address blocked = makeAddr("blocked");
        uint256[2] memory ids;
        address[2] memory buyers = [blocked, buyer];
        for (uint256 i; i < 2; ++i) {
            btk.mint(buyers[i], 1_000e18);
            vm.startPrank(buyers[i]);
            btk.approve(address(m), type(uint256).max);
            ids[i] = m.buyProtection(10_000e18, 1 days);
            vm.stopPrank();
        }
        vm.warp(block.timestamp + m.coverDelay());
        btk.setBlocked(blocked, true);

        vm.prank(proxy);
        m.trip(address(rx), 900, 3000, block.timestamp, BASE, 0); // no transfers here, so it can't revert
        assertTrue(m.tripped());

        m.claim(ids[1]);
        assertEq(btk.balanceOf(buyer), 1_000e18 - m.policy(ids[1]).premium + 10_000e18);

        vm.expectRevert(BlockingToken.Blocked.selector);
        m.claim(ids[0]); // only the blocked buyer's own claim fails
        assertEq(m.policy(ids[0]).owed, 10_000e18, "still owed, claimable once unblocked");
    }

    function test_tripIsResentUntilMarketConfirms() public {
        _driveToTrip();
        uint256 first = _callbacks();
        assertEq(rx.tripsSent(), 1);

        // Callback lost: no confirmation. A later event inside the retry interval doesn't resend...
        vm.warp(block.timestamp + 10);
        _transfer(vault, attacker, 1e18);
        assertEq(_callbacks(), first);

        // ...but one after it does, with the original trip data.
        vm.warp(block.timestamp + rx.TRIP_RETRY_SECONDS());
        _transfer(vault, attacker, 1e18);
        assertEq(_callbacks(), first + 1);
        assertEq(rx.tripsSent(), 2);

        _deliverAll(); // first delivery trips the market; the duplicate is a no-op
        assertTrue(market.tripped());

        // A Tripped log from the wrong chain or contract is not a confirmation.
        _trippedLog(BASE, address(market));
        _trippedLog(UNI, attacker);
        assertFalse(rx.tripConfirmed());

        _trippedLog(UNI, address(market));
        assertTrue(rx.tripConfirmed());

        vm.warp(block.timestamp + rx.TRIP_RETRY_SECONDS() + 1);
        _transfer(vault, attacker, 1e18);
        assertEq(_callbacks(), first + 1, "no resend after confirmation");
    }

    // ---------------------------------------------------------------- fix 4: out-of-order marks

    function test_olderMarkDoesNotOverwriteNewer() public {
        uint256 t = block.timestamp;
        vm.prank(proxy);
        market.updateMark(address(rx), 300, t, BASE, 0);

        vm.expectEmit(address(market));
        emit RiftMarket.StaleMarkIgnored(100, t - 5, t);
        vm.prank(proxy);
        market.updateMark(address(rx), 100, t - 5, BASE, 0); // delivered late
        assertEq(market.markBps(), 300);
        assertEq(market.markObservedAt(), t);

        vm.prank(proxy);
        market.updateMark(address(rx), 250, t, BASE, 0); // same observation second still applies
        assertEq(market.markBps(), 250);
    }

    function test_tripIsIdempotentAndBlocksNewBusiness() public {
        _forceTrip();
        vm.prank(buyer);
        vm.expectRevert(RiftMarket.IsTripped.selector);
        market.buyProtection(1e18, 1 days);
    }

    // ---------------------------------------------------------------- perp

    function test_perpPnlAndFunding() public {
        _pushMark(0);
        vm.startPrank(trader);
        usd.approve(address(market), type(uint256).max);
        market.openPosition(true, 10_000e18, 1_000e18); // 10x long the spread
        vm.stopPrank();

        _pushMark(200); // spread +200 bps -> long PnL = 10_000 * 2% = 200
        (, int256 pnl,) = market.equityOf(trader);
        assertEq(pnl, 200e18);

        // Hold for one day at +200 bps: long pays 2% of size = 200.
        vm.warp(block.timestamp + 1 days);
        (int256 equity,, int256 funding) = market.equityOf(trader);
        assertEq(funding, 200e18);
        assertEq(equity, 1_000e18);

        uint256 poolBefore = market.poolAssets();
        vm.prank(trader);
        market.closePosition();
        assertEq(usd.balanceOf(trader), 10_000e18, "net zero after pnl - funding");
        assertEq(market.poolAssets(), poolBefore);
    }

    function test_oversizedMarginRevertsInsteadOfTruncating() public {
        _pushMark(0);
        uint256 margin = uint256(type(uint128).max) + 1;
        _fund(trader, margin);
        vm.startPrank(trader);
        usd.approve(address(market), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 128, margin));
        market.openPosition(true, 1_000e18, margin);
        vm.stopPrank();
    }

    function test_setReactiveRejectsZeroAddress() public {
        RiftMarket fresh = new RiftMarket(IPayable(payable(proxy)), IERC20(address(usd)));
        vm.expectRevert(RiftMarket.ZeroAddress.selector);
        fresh.setReactive(address(0));
    }

    function test_unauthorizedCallbackReverts() public {
        vm.prank(proxy);
        vm.expectRevert(abi.encodeWithSelector(RiftMarket.UnauthorizedReactive.selector, attacker));
        market.updateMark(attacker, 1, 0, 0, 0);

        vm.prank(attacker);
        vm.expectRevert();
        market.updateMark(address(rx), 1, 0, 0, 0);
    }

    // ---------------------------------------------------------------- helpers

    function _fund(address who, uint256 amt) internal {
        usd.mint(who, amt);
        vm.prank(who);
        usd.approve(address(market), type(uint256).max);
    }

    function _log(uint256 chainId, address emitter, uint256 t0, uint256 t1, uint256 t2, uint256 op, bytes memory data)
        internal
        view
        returns (IReactive.LogRecord memory)
    {
        return IReactive.LogRecord({
            chainId: chainId,
            contractAddress: emitter,
            topic0: t0,
            topic1: t1,
            topic2: t2,
            topic3: 0,
            data: data,
            blockNumber: block.number,
            opCode: op,
            blockHash: 0,
            txHash: uint256(keccak256(abi.encode(block.timestamp, data))),
            logIndex: 0
        });
    }

    function _sync(uint256 chainId, address pool, uint112 r0, uint112 r1) internal {
        vm.prank(SYSTEM);
        rx.react(_log(chainId, pool, SYNC, 0, 0, 1, abi.encode(r0, r1)));
    }

    function _transfer(address from, address to, uint256 amount) internal {
        vm.prank(SYSTEM);
        rx.react(_log(BASE, vaultAsset, TRANSFER, uint256(uint160(from)), uint256(uint160(to)), 3, abi.encode(amount)));
    }

    function _callbacks() internal view returns (uint256) {
        return MockSystem(payable(SYSTEM)).callbacksCount();
    }

    uint256 internal delivered;

    /// @dev Replays every pending callback the way the proxy would: first 20 bytes of the address arg = sender.
    function _deliverAll() internal {
        uint256 n = _callbacks();
        for (; delivered < n; ++delivered) {
            ISystemContract.CallbackConfiguration_V_1_0 memory cb = MockSystem(payable(SYSTEM)).callbackAt(delivered);
            assertEq(cb.chainId, UNI);
            assertEq(cb.recipient, address(market));
            bytes memory payload = cb.payload;
            address sender = address(rx);
            assembly {
                mstore(add(payload, 36), sender) // overwrite first arg (after 4-byte selector)
            }
            vm.prank(proxy);
            (bool ok, bytes memory ret) = cb.recipient.call(payload);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }

    function _trippedLog(uint256 chainId, address emitter) internal {
        vm.prank(SYSTEM);
        rx.react(_log(chainId, emitter, TRIPPED, 0, 0, 1, abi.encode(int256(0), 0, 0, 0, 0, 0, 0)));
    }

    /// @dev Same breach as test_drainTripsAndPaysProtection, without delivering the trip callback.
    function _driveToTrip() internal {
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        _sync(UNI, poolUni, 1_000e18, 2_000e18);
        _deliverAll();
        _transfer(vault, attacker, 300_000e18);
        _sync(BASE, poolBase, 1_400e18, 1_500e18);
        vm.warp(block.timestamp + 2);
        _transfer(vault, attacker, 50_000e18);
        assertTrue(rx.tripped());
    }

    function _pushMark(int256 bps) internal {
        vm.prank(proxy);
        market.updateMark(address(rx), bps, block.timestamp, BASE, 0);
    }

    function _forceTrip() internal {
        vm.prank(proxy);
        market.trip(address(rx), 900, 3000, block.timestamp, BASE, 0);
        vm.prank(proxy);
        market.trip(address(rx), 900, 3000, block.timestamp, BASE, 0); // no-op
    }
}

/// @notice Collateral that can refuse transfers to one address, like a USDC-style blocklist.
contract BlockingToken is MockToken {
    mapping(address account => bool blocked) public blocked;

    error Blocked();

    constructor() MockToken("Blocking USD", "bUSD") {}

    function setBlocked(address account_, bool blocked_) external {
        blocked[account_] = blocked_;
    }

    function _update(address from_, address to_, uint256 value_) internal override {
        if (blocked[to_]) revert Blocked();
        super._update(from_, to_, value_);
    }
}
