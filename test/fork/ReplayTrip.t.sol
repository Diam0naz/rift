// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev The views this test reads; they exist on both the deployed (pre-safeguard) market and the current one.
interface IRiftMarketView {
    function tripped() external view returns (bool);
    function tripMark() external view returns (int256);
    function payoutRatioBps() external view returns (uint256);
    function reactive() external view returns (address);
    function collateral() external view returns (IERC20);
}

/// @notice Replays the recorded testnet trip (README, "Deployed addresses & transaction hashes") on a fork of
///         Unichain Sepolia: state just before the callback, then the exact callback transaction.
///         Needs UNICHAIN_SEPOLIA_RPC; skipped without it.
contract ReplayTripForkTest is Test {
    IRiftMarketView internal constant MARKET = IRiftMarketView(0xC8AD79Ea2E567Af771F4c7590a4de1783F6428b5);
    address internal constant REACTIVE = 0x7C8b13329EDcbFbD8405833F198024ca7E3b4276;
    address internal constant BUYER = 0xD04927546678d4255bA0D4c6C2E4D7289baa4B5D;
    bytes32 internal constant TRIP_CALLBACK_TX = 0x892cea840926429f4a003b9ac69709433824f7c1e8d8be5103df5afad8de769b;

    function test_replayRecordedTripCallback() public {
        string memory rpc = vm.envOr("UNICHAIN_SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, TRIP_CALLBACK_TX); // state right before the callback

        assertEq(MARKET.reactive(), REACTIVE, "market linked to the deployed RiftReactive");
        assertFalse(MARKET.tripped(), "not tripped before the callback");
        IERC20 usd = MARKET.collateral();
        uint256 before = usd.balanceOf(BUYER);

        vm.transact(TRIP_CALLBACK_TX); // the exact callback the Reactive proxy delivered

        assertTrue(MARKET.tripped());
        assertEq(MARKET.tripMark(), -7436);
        assertEq(MARKET.payoutRatioBps(), 10_000);
        assertEq(usd.balanceOf(BUYER) - before, 10_000e18, "policy 0 paid in full by the callback");
    }
}
