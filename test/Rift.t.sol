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
