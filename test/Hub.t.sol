// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IReactive} from "@reactive/interfaces/IReactive.sol";
import {IPayable} from "@reactive/interfaces/IPayable.sol";
import {ISystemContract} from "@reactive/interfaces/ISystemContract.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MockSystem} from "./mocks/MockSystem.sol";
import {MockToken} from "../src/origin/MockToken.sol";
import {RiftHub} from "../src/reactive/RiftHub.sol";
import {RiftMarketFactory} from "../src/market/RiftMarketFactory.sol";
import {RiftSpreadMarket} from "../src/market/RiftSpreadMarket.sol";
import {RiftTypes, IRiftMarketFactoryEvents} from "../src/market/RiftTypes.sol";

/// @notice Trader-created markets end to end in one EVM:
///   factory.createMarket -> its real MarketCreated log -> RiftHub.react() subscribes to the pools ->
///   pool logs -> recorded updateMark callback -> replayed through a fake proxy -> RiftSpreadMarket.
contract HubTest is Test {
    address internal constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 internal constant BASE = 84532;
    uint256 internal constant UNI = 1301;
    uint256 internal constant ETH = 11155111;
    uint256 internal constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    uint256 internal constant CRON = 0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4;
    uint256 internal constant SYNC = uint256(keccak256("Sync(uint112,uint112)"));
    uint256 internal constant SWAP = uint256(keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)"));

    address internal proxy = makeAddr("callbackProxy");
    address internal creator = makeAddr("creator");
    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");

    address internal poolA = makeAddr("poolA"); // Base
    address internal poolB = makeAddr("poolB"); // Unichain
    address internal poolC = makeAddr("poolC"); // Ethereum

    MockToken internal usd;
    RiftMarketFactory internal factory;
    RiftHub internal hub;

    uint256 internal delivered;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.etch(SYSTEM, address(new MockSystem()).code);
        usd = new MockToken("Test USD", "tUSD");

        uint256[] memory chains = new uint256[](3);
        chains[0] = BASE;
        chains[1] = UNI;
        chains[2] = ETH;
        factory = new RiftMarketFactory(IPayable(payable(proxy)), IERC20(address(usd)), chains);
        hub = new RiftHub(
            UNI,
            address(factory),
            CRON,
            RiftHub.Params({markEpsilonBps: 10, markHeartbeat: 900, markSmoothingSeconds: 0, maxEventsPerHour: 100})
        );
        factory.setHub(address(hub));
        vm.deal(creator, 10 ether);
    }

    // ---------------------------------------------------------------- wiring

    function test_topicMatchesFactoryEvent() public view {
        assertEq(hub.createdTopic(), uint256(IRiftMarketFactoryEvents.MarketCreated.selector));
    }

    function test_constructorSubscribesToFactoryAndCron() public view {
        assertEq(_live(UNI, address(factory), hub.createdTopic()), 1);
        assertEq(_live(0, 0x0000000000000000000000000000000000fffFfF, CRON), 1);
    }

    function test_createDeploysFundedMarketLinkedToHub() public {
        (uint256 id, RiftSpreadMarket m) = _create(_spec(BASE, poolA, UNI, poolB));
        assertEq(id, 0);
        assertEq(m.reactive(), address(hub));
        assertEq(m.factory(), address(factory));
        assertEq(address(m).balance, 0.002 ether);
        assertEq(factory.marketsCount(), 1);
        assertEq(factory.creatorOf(0), creator);
        assertEq(factory.specOf(0).b.pool, poolB);
    }

    function test_createChecks() public {
        RiftTypes.Spec memory s = _spec(BASE, poolA, UNI, poolB);
        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(RiftMarketFactory.Underfunded.selector, 0.002 ether));
        factory.createMarket{value: 0.001 ether}(s);

        RiftTypes.Spec memory bad = _spec(42161, poolA, UNI, poolB);
        vm.expectRevert(abi.encodeWithSelector(RiftMarketFactory.ChainNotAllowed.selector, 42161));
        factory.createMarket{value: 0.002 ether}(bad);

        bad = _spec(BASE, poolA, BASE, poolA);
        vm.expectRevert(RiftMarketFactory.SamePool.selector);
        factory.createMarket{value: 0.002 ether}(bad);

        bad = _spec(BASE, poolA, UNI, poolB);
        bad.a.kind = 2;
        vm.expectRevert(RiftMarketFactory.BadPool.selector);
        factory.createMarket{value: 0.002 ether}(bad);

        factory.createMarket{value: 0.002 ether}(s);
        vm.expectRevert(RiftMarketFactory.AlreadyListed.selector);
        factory.createMarket{value: 0.002 ether}(s);
        vm.stopPrank();
    }

    function test_createNeedsHub() public {
        RiftMarketFactory f = new RiftMarketFactory(IPayable(payable(proxy)), IERC20(address(usd)), new uint256[](0));
        vm.expectRevert(RiftMarketFactory.HubNotSet.selector);
        f.createMarket{value: 0.002 ether}(_spec(BASE, poolA, UNI, poolB));
        vm.expectRevert(RiftMarketFactory.NotOwner.selector);
        vm.prank(creator);
        f.setHub(address(hub));
    }

    function test_marketCap() public {
        for (uint256 i; i < factory.MAX_MARKETS(); ++i) {
            vm.prank(creator);
            factory.createMarket{value: 0.002 ether}(_spec(BASE, address(uint160(1000 + i)), UNI, poolB));
        }
        vm.prank(creator);
        vm.expectRevert(RiftMarketFactory.TooManyMarkets.selector);
        factory.createMarket{value: 0.002 ether}(_spec(BASE, poolC, UNI, poolB));
    }

    // ---------------------------------------------------------------- registration

    function test_hubSubscribesToBothPoolsOnCreate() public {
        _createAndRegister(_spec(BASE, poolA, UNI, poolB));
        assertTrue(hub.registered(0));
        assertTrue(hub.marketOf(0).active);
        assertEq(_live(BASE, poolA, SYNC), 1);
        assertEq(_live(UNI, poolB, SYNC), 1);
    }

    function test_duplicateCreatedLogIsIgnored() public {
        IReactive.LogRecord memory log_ = _createLog(_spec(BASE, poolA, UNI, poolB));
        _react(log_);
        _react(log_);
        assertEq(hub.marketsCount(), 1);
        assertEq(_live(BASE, poolA, SYNC), 1);
    }

    function test_createdLogFromAnotherContractIsIgnored() public {
        IReactive.LogRecord memory log_ = _createLog(_spec(BASE, poolA, UNI, poolB));
        log_.contractAddress = makeAddr("impostor");
        _react(log_);
        assertEq(hub.marketsCount(), 0);
    }

    function test_refusedSubscriptionMarksMarketFailed() public {
        MockSystem(payable(SYSTEM)).setRefuseChain(ETH);
        IReactive.LogRecord memory log_ = _createLog(_spec(BASE, poolA, ETH, poolC));
        vm.expectEmit(true, false, false, true, address(hub));
        emit RiftHub.MarketFailed(0, ETH, poolC);
        _react(log_);
        assertFalse(hub.marketOf(0).active);
        assertEq(_live(BASE, poolA, SYNC), 0, "side A released again");
    }

    // ---------------------------------------------------------------- marks

    function test_syncPricesSendMarkToTheMarket() public {
        RiftSpreadMarket m = _createAndRegister(_spec(BASE, poolA, UNI, poolB));
        _sync(BASE, poolA, 1_000e18, 2_000e18); // 2.00
        assertEq(_callbacks(), 0, "needs both prices");
        _sync(UNI, poolB, 1_000e18, 2_020e18); // 2.02: +100 bps
        assertEq(_callbacks(), 1);
        assertEq(hub.spreadBps(0), 100);
        _deliverAll(m);
        assertEq(m.markBps(), 100);
        assertGt(m.markReceivedAt(), 0);
    }

    function test_eventsOnOtherPoolsOrKindsAreIgnored() public {
        _createAndRegister(_spec(BASE, poolA, UNI, poolB));
        _sync(BASE, poolC, 1_000e18, 2_000e18);
        _swap(BASE, poolA, _sqrtX96(1e36), 1e20); // poolA is a Sync pool in this market
        assertEq(hub.marketOf(0).priceA, 0);
    }

    /// Real-world shape: Base v3 pool lists USDC (6) first, Unichain v2 pair lists WETH (18) first.
    function test_v3AndV2WithDecimalsAndInversion() public {
        RiftTypes.Spec memory s = _spec(BASE, poolA, UNI, poolB);
        s.a.kind = RiftTypes.KIND_V3;
        s.a.decShift = -12; // 6 - 18
        s.a.invert = true; // WETH per USDC -> USDC per WETH
        s.b.decShift = 12; // 18 - 6
        RiftSpreadMarket m = _createAndRegister(s);
        assertEq(_live(BASE, poolA, SWAP), 1);

        // Pool A: 3,000 USDC per WETH, i.e. raw (wei of WETH per USDC unit) = 1e12 / 3000.
        _swap(BASE, poolA, _sqrtX96(Math.mulDiv(1e12, 1e36, 3000)), 1e20);
        // Pool B: 1 WETH : 3,030 USDC.
        _sync(UNI, poolB, 1e18, 3_030e6);
        int256 spread = hub.spreadBps(0);
        assertApproxEqAbs(spread, 100, 1);
        assertApproxEqRel(hub.marketOf(0).priceA, 3_000e36, 1e12);
        assertApproxEqRel(hub.marketOf(0).priceB, 3_030e36, 1e12);
        _deliverAll(m);
        assertApproxEqAbs(m.markBps(), 100, 1);
    }

    function test_thinPoolGuardKeepsLastGoodPrice() public {
        RiftTypes.Spec memory s = _spec(BASE, poolA, UNI, poolB);
        s.a.minLiquidity = 500e18; // reserve1
        _createAndRegister(s);
        _sync(BASE, poolA, 1_000e18, 2_000e18);
        _sync(BASE, poolA, 100e18, 400e18); // reserve1 400 < 500: ignored
        assertEq(hub.marketOf(0).priceA, 2e36);
    }

    function test_markIsCappedAtOneHundredPercent() public {
        RiftSpreadMarket m = _createAndRegister(_spec(BASE, poolA, UNI, poolB));
        _sync(BASE, poolA, 1_000e18, 1_000e18);
        _sync(UNI, poolB, 1_000e18, 90_000e18); // +8,900%
        assertEq(hub.spreadBps(0), 10_000);
        _deliverAll(m);
        assertEq(m.markBps(), 10_000);
    }

    function test_smallMovesWaitForHeartbeatFromCron() public {
        _createAndRegister(_spec(BASE, poolA, UNI, poolB));
        _sync(BASE, poolA, 1_000e18, 2_000e18);
        _sync(UNI, poolB, 1_000e18, 2_000e18);
        _sync(UNI, poolB, 1_000e18, 2_001e18); // +5 bps < epsilon
        assertEq(_callbacks(), 1);
        _cron();
        assertEq(_callbacks(), 1, "not stale yet");
        vm.warp(block.timestamp + 900);
        _cron();
        assertEq(_callbacks(), 2, "heartbeat");
    }

    function test_oneEventMarksEveryMarketOnThePool() public {
        RiftSpreadMarket m0 = _createAndRegister(_spec(BASE, poolA, UNI, poolB));
        RiftSpreadMarket m1 = _createAndRegister(_spec(BASE, poolA, ETH, poolC));
        assertEq(_live(BASE, poolA, SYNC), 1, "shared subscription");
        _sync(UNI, poolB, 1_000e18, 2_000e18);
        _sync(ETH, poolC, 1_000e18, 2_200e18);
        _sync(BASE, poolA, 1_000e18, 2_000e18); // completes both
        assertEq(_callbacks(), 2);
        _deliverAll(m0, m1);
        assertEq(m0.markBps(), 0);
        assertEq(m1.markBps(), 1_000);
    }

    // ---------------------------------------------------------------- cost control

    function test_pauseDropsSubscriptionOnlyWhenUnused() public {
        _createAndRegister(_spec(BASE, poolA, UNI, poolB));
        _createAndRegister(_spec(BASE, poolA, ETH, poolC));
        hub.setActive(0, false);
        assertEq(_live(BASE, poolA, SYNC), 1, "market 1 still uses it");
        assertEq(_live(UNI, poolB, SYNC), 0);
        hub.setActive(1, false);
        assertEq(_live(BASE, poolA, SYNC), 0);
        hub.setActive(0, true);
        assertEq(_live(BASE, poolA, SYNC), 1);
        assertEq(_live(UNI, poolB, SYNC), 1);
    }

    function test_noisyPoolIsThrottled() public {
        hub.setParams(RiftHub.Params({markEpsilonBps: 10, markHeartbeat: 900, markSmoothingSeconds: 0, maxEventsPerHour: 3}));
        _createAndRegister(_spec(BASE, poolA, UNI, poolB));
        for (uint256 i; i < 3; ++i) {
            _sync(BASE, poolA, 1_000e18, 2_000e18);
        }
        assertTrue(hub.marketOf(0).active);
        _sync(BASE, poolA, 1_000e18, 2_000e18);
        assertFalse(hub.marketOf(0).active);
        assertTrue(hub.marketOf(0).throttled);
        assertEq(_live(BASE, poolA, SYNC), 0);
        assertEq(_live(UNI, poolB, SYNC), 0);

        hub.setActive(0, true);
        assertTrue(hub.marketOf(0).active);
        assertEq(_live(BASE, poolA, SYNC), 1);
    }

    function test_onlyOwnerAdmin() public {
        vm.startPrank(creator);
        vm.expectRevert(RiftHub.NotOwner.selector);
        hub.setActive(0, false);
        vm.expectRevert(RiftHub.NotOwner.selector);
        hub.setParams(RiftHub.Params({markEpsilonBps: 1, markHeartbeat: 1, markSmoothingSeconds: 0, maxEventsPerHour: 1}));
        vm.stopPrank();
    }

    function test_reactOnlyFromSystem() public {
        IReactive.LogRecord memory log_ = _createLog(_spec(BASE, poolA, UNI, poolB));
        vm.expectRevert();
        hub.react(log_);
    }

    // ---------------------------------------------------------------- market

    function test_marketRejectsOtherSenders() public {
        (, RiftSpreadMarket m) = _create(_spec(BASE, poolA, UNI, poolB));
        vm.prank(proxy);
        vm.expectRevert(abi.encodeWithSelector(RiftSpreadMarket.UnauthorizedReactive.selector, creator));
        m.updateMark(creator, 100, block.timestamp, BASE, 0);
        vm.prank(creator);
        vm.expectRevert();
        m.updateMark(address(hub), 100, block.timestamp, BASE, 0);
    }

    function test_tradeLoopOnACreatedMarket() public {
        RiftSpreadMarket m = _createAndRegister(_spec(BASE, poolA, UNI, poolB));
        _fund(lp, m, 50_000e18);
        vm.prank(lp);
        m.deposit(50_000e18);

        _fund(trader, m, 1_000e18);
        vm.prank(trader);
        vm.expectRevert(RiftSpreadMarket.NoMark.selector);
        m.openPosition(true, 5_000e18, 1_000e18);

        _sync(BASE, poolA, 1_000e18, 2_000e18);
        _sync(UNI, poolB, 1_000e18, 2_000e18);
        _deliverAll(m);
        vm.prank(trader);
        m.openPosition(true, 5_000e18, 1_000e18);

        // B rallies 4%: the long gains 4% of size (the mark was 0 until now, so no funding yet).
        vm.warp(block.timestamp + 60);
        _sync(UNI, poolB, 1_000e18, 2_080e18);
        _deliverAll(m);
        assertEq(m.markBps(), 400);
        vm.prank(trader);
        m.closePosition();
        assertEq(usd.balanceOf(trader), 1_200e18);
        assertEq(m.poolAssets(), 49_800e18);

        // A stale mark blocks new risk.
        vm.warp(block.timestamp + m.MAX_MARK_AGE() + 1);
        vm.prank(trader);
        vm.expectRevert();
        m.openPosition(true, 1_000e18, 500e18);
    }

    // ---------------------------------------------------------------- helpers

    function _spec(uint256 ca, address pa, uint256 cb, address pb) internal pure returns (RiftTypes.Spec memory s) {
        s.a = RiftTypes.PoolRef({chainId: uint64(ca), pool: pa, kind: 0, invert: false, decShift: 0, minLiquidity: 0});
        s.b = RiftTypes.PoolRef({chainId: uint64(cb), pool: pb, kind: 0, invert: false, decShift: 0, minLiquidity: 0});
    }

    function _create(RiftTypes.Spec memory s) internal returns (uint256 id, RiftSpreadMarket m) {
        vm.prank(creator);
        (uint256 id_, address m_) = factory.createMarket{value: 0.002 ether}(s);
        return (id_, RiftSpreadMarket(payable(m_)));
    }

    /// @dev Creates the market and returns the factory's actual MarketCreated log, as Reactive would deliver it.
    function _createLog(RiftTypes.Spec memory s) internal returns (IReactive.LogRecord memory) {
        vm.recordLogs();
        _create(s);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(factory)) {
                return IReactive.LogRecord({
                    chainId: UNI,
                    contractAddress: address(factory),
                    topic0: uint256(logs[i].topics[0]),
                    topic1: uint256(logs[i].topics[1]),
                    topic2: uint256(logs[i].topics[2]),
                    topic3: uint256(logs[i].topics[3]),
                    data: logs[i].data,
                    blockNumber: block.number,
                    opCode: 4,
                    blockHash: 0,
                    txHash: 0,
                    logIndex: 0
                });
            }
        }
        revert("no MarketCreated");
    }

    function _createAndRegister(RiftTypes.Spec memory s) internal returns (RiftSpreadMarket) {
        IReactive.LogRecord memory log_ = _createLog(s);
        _react(log_);
        return RiftSpreadMarket(payable(address(uint160(log_.topic2))));
    }

    function _react(IReactive.LogRecord memory log_) internal {
        vm.prank(SYSTEM);
        hub.react(log_);
    }

    function _log(uint256 chainId, address emitter, uint256 t0, bytes memory data)
        internal
        view
        returns (IReactive.LogRecord memory)
    {
        return IReactive.LogRecord({
            chainId: chainId,
            contractAddress: emitter,
            topic0: t0,
            topic1: 0,
            topic2: 0,
            topic3: 0,
            data: data,
            blockNumber: block.number,
            opCode: 1,
            blockHash: 0,
            txHash: 0,
            logIndex: 0
        });
    }

    function _sync(uint256 chainId, address pool, uint112 r0, uint112 r1) internal {
        _react(_log(chainId, pool, SYNC, abi.encode(r0, r1)));
    }

    function _swap(uint256 chainId, address pool, uint160 sqrtP, uint128 liq) internal {
        _react(_log(chainId, pool, SWAP, abi.encode(int256(1), int256(-1), sqrtP, liq, int24(0))));
    }

    function _cron() internal {
        _react(_log(5318007, 0x0000000000000000000000000000000000fffFfF, CRON, abi.encode(block.number)));
    }

    /// @dev sqrtPriceX96 for a raw price given scaled by 1e36.
    function _sqrtX96(uint256 raw1e36) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(raw1e36, 2 ** 192, 1e36)));
    }

    function _live(uint256 c, address a, uint256 t0) internal view returns (int256) {
        return MockSystem(payable(SYSTEM)).live(
            keccak256(abi.encode(c, a, t0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE))
        );
    }

    function _callbacks() internal view returns (uint256) {
        return MockSystem(payable(SYSTEM)).callbacksCount();
    }

    function _fund(address who, RiftSpreadMarket m, uint256 amt) internal {
        usd.mint(who, amt);
        vm.prank(who);
        usd.approve(address(m), type(uint256).max);
    }

    function _deliverAll(RiftSpreadMarket m) internal {
        _deliverAll(m, m);
    }

    /// @dev Replays pending callbacks as the proxy would, with the hub's address in the first argument.
    function _deliverAll(RiftSpreadMarket m0, RiftSpreadMarket m1) internal {
        uint256 n = _callbacks();
        for (; delivered < n; ++delivered) {
            ISystemContract.CallbackConfiguration_V_1_0 memory cb = MockSystem(payable(SYSTEM)).callbackAt(delivered);
            assertEq(cb.chainId, UNI);
            assertTrue(cb.recipient == address(m0) || cb.recipient == address(m1), "recipient");
            bytes memory payload = cb.payload;
            address sender = address(hub);
            assembly {
                mstore(add(payload, 36), sender)
            }
            vm.prank(proxy);
            (bool ok,) = cb.recipient.call(payload);
            assertTrue(ok, "callback reverted");
        }
    }
}
