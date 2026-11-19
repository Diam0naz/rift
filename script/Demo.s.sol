// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RiftPool} from "../src/origin/RiftPool.sol";
import {MockVault} from "../src/origin/MockVault.sol";
import {RiftMarket} from "../src/market/RiftMarket.sol";

/// @notice Unichain Sepolia: buy protection and open a perp position before the exploit.
///   forge script script/Demo.s.sol:DemoSetup --rpc-url unichain_sepolia --broadcast
contract DemoSetup is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        RiftMarket market = RiftMarket(payable(vm.envAddress("MARKET")));
        IERC20 usd = market.collateral();
        vm.startBroadcast(pk);
        usd.approve(address(market), type(uint256).max);
        uint256 id = market.buyProtection(10_000e18, 1 days);
        market.openPosition(true, 5_000e18, 1_000e18);
        vm.stopBroadcast();
        console2.log("Policy id:", id);
    }
}

/// @notice Base Sepolia: a small swap that moves the spread -> origin event for the `updateMark` loop.
///   forge script script/Demo.s.sol:DemoSwap --rpc-url base_sepolia --broadcast
contract DemoSwap is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        RiftPool pool = RiftPool(vm.envAddress("POOL_BASE"));
        uint256 amountIn = vm.envOr("SWAP_IN", uint256(20e18));
        vm.startBroadcast(pk);
        pool.swap(true, amountIn, 0, vm.addr(pk));
        vm.stopBroadcast();
        console2.log("Base price now:", pool.price());
    }
}

/// @notice Base Sepolia: the exploit. Drains the vault and dumps the loot into the Base pool,
///         which breaks the cross-chain spread AND spikes vault outflow -> `trip` loop.
///   forge script script/Demo.s.sol:DemoExploit --rpc-url base_sepolia --broadcast
contract DemoExploit is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        MockVault vault = MockVault(vm.envAddress("VAULT"));
        RiftPool pool = RiftPool(vm.envAddress("POOL_BASE"));
        uint256 loot = vm.envOr("EXPLOIT_AMOUNT", uint256(300_000e18));

        vm.startBroadcast(pk);
        vault.simulateExploit(me, loot);
        pool.token1().approve(address(pool), type(uint256).max);
        pool.swap(false, 2_000e18, 0, me); // dump quote -> tBASE price on Base jumps
        vm.stopBroadcast();

        console2.log("Vault left:", vault.totalAssets());
        console2.log("Base price:", pool.price());
    }
}
