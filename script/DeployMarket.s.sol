// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPayable} from "@reactive/interfaces/IPayable.sol";
import {MockToken} from "../src/origin/MockToken.sol";
import {RiftMarket} from "../src/market/RiftMarket.sol";

/// @notice Unichain Sepolia: collateral token + RiftMarket, seeded with underwriting liquidity.
///   forge script script/DeployMarket.s.sol:DeployMarket --rpc-url unichain_sepolia --broadcast
contract DeployMarket is Script {
    error FundingFailed();

    /// Reactive callback proxy on Unichain Sepolia (dev.reactive.network/origins-and-destinations)
    address internal constant UNICHAIN_SEPOLIA_CALLBACK_PROXY = 0x775c9B990ADe401060B78D0e98684eEf8d2466C1;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        uint256 callbackFunding = vm.envOr("MARKET_CALLBACK_FUNDING", uint256(0.01 ether));
        vm.startBroadcast(pk);

        MockToken usd = new MockToken("Rift Test USD", "tUSD");
        RiftMarket market = new RiftMarket(IPayable(payable(UNICHAIN_SEPOLIA_CALLBACK_PROXY)), IERC20(address(usd)));

        usd.mint(me, 200_000e18);
        usd.approve(address(market), type(uint256).max);
        market.deposit(100_000e18);

        // Callbacks are paid for by the destination contract: keep native balance in it.
        (bool ok,) = address(market).call{value: callbackFunding}("");
        if (!ok) revert FundingFailed();

        vm.stopBroadcast();

        console2.log("COLLATERAL =", address(usd));
        console2.log("MARKET     =", address(market));
    }
}

/// @notice Unichain Sepolia: one-time link of the market to the deployed RiftReactive.
///   forge script script/DeployMarket.s.sol:LinkReactive --rpc-url unichain_sepolia --broadcast
contract LinkReactive is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        RiftMarket market = RiftMarket(payable(vm.envAddress("MARKET")));
        address rx = vm.envAddress("REACTIVE");
        vm.startBroadcast(pk);
        market.setReactive(rx);
        vm.stopBroadcast();
        console2.log("Market linked to reactive:", rx);
    }
}
