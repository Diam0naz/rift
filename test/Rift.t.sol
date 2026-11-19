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
                markHeartbeat: 60
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
        assertEq(MockSystem(payable(SYSTEM)).subsCount(), 4);
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

    // ---------------------------------------------------------------- full loop

    function test_drainTripsAndPaysProtection() public {
        _sync(BASE, poolBase, 1_000e18, 2_000e18);
        _sync(UNI, poolUni, 1_000e18, 2_000e18);
        _deliverAll();

        vm.prank(buyer);
        market.buyProtection(10_000e18, 1 days);
        uint256 before = usd.balanceOf(buyer);

        // Exploit: vault drained and loot dumped on Base -> Base price collapses.
        _transfer(vault, attacker, 300_000e18); // 30% outflow
        _sync(BASE, poolBase, 1_400e18, 1_500e18); // price ~1.07, spread ~ +86%
        assertFalse(rx.tripped(), "breach must be sustained");

        vm.warp(block.timestamp + 2);
        _transfer(vault, attacker, 50_000e18);
        assertTrue(rx.tripped());

        _deliverAll();
        assertTrue(market.tripped());
        assertEq(usd.balanceOf(buyer) - before, 10_000e18, "paid in full, same tx as the callback");
        assertEq(market.payoutRatioBps(), 10_000);
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
