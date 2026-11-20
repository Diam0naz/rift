// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RiftMarket} from "../../src/market/RiftMarket.sol";

/// @notice Replays the recorded testnet trip (README, "Deployed addresses & transaction hashes") on a fork of
///         Unichain Sepolia: state just before the callback, then the exact callback transaction the Reactive
///         proxy delivered, then a claim. Needs UNICHAIN_SEPOLIA_RPC; skipped without it.
contract ReplayTripForkTest is Test {
    RiftMarket internal constant MARKET = RiftMarket(payable(0x45c96DC6c9f5C5A8CFe0Ac8B88DCD7F49b16Bcb0));
    address internal constant REACTIVE = 0xAD0983eBF145C8f8184bf219E795aC63fEE58B78;
    address internal constant BUYER = 0xD04927546678d4255bA0D4c6C2E4D7289baa4B5D;
    bytes32 internal constant TRIP_CALLBACK_TX = 0x12babcb0e4c12e8d297f0ba01dca2659c261780779281c1b24c11accaec5a9c4;

    function test_replayRecordedTripCallback() public {
        string memory rpc = vm.envOr("UNICHAIN_SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, TRIP_CALLBACK_TX); // state right before the callback

        assertEq(MARKET.reactive(), REACTIVE, "market linked to the deployed RiftReactive");
        assertFalse(MARKET.tripped(), "not tripped before the callback");
        assertEq(MARKET.policy(0).owed, 0);

        vm.transact(TRIP_CALLBACK_TX); // the exact callback the Reactive proxy delivered

        assertTrue(MARKET.tripped());
        assertEq(MARKET.tripMark(), -7436);
        assertEq(MARKET.payoutRatioBps(), 10_000);
        assertEq(MARKET.policy(0).owed, 10_000e18, "covered policy settled by the callback, no transfer in it");

        IERC20 usd = MARKET.collateral();
        uint256 before = usd.balanceOf(BUYER);
        MARKET.claim(0); // anyone can push the claim; funds go to the buyer
        assertEq(usd.balanceOf(BUYER) - before, 10_000e18, "policy 0 paid in full on claim");
        assertEq(MARKET.totalOwed(), 0);
    }
}
