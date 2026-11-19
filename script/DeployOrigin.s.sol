// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockToken} from "../src/origin/MockToken.sol";
import {RiftPool} from "../src/origin/RiftPool.sol";
import {MockVault} from "../src/origin/MockVault.sol";

/// @notice Base Sepolia: twin pool #1 + the protected vault.
///   forge script script/DeployOrigin.s.sol:DeployBase --rpc-url base_sepolia --broadcast
contract DeployBase is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);

        MockToken t0 = new MockToken("Rift Base Asset", "tBASE");
        MockToken t1 = new MockToken("Rift Quote", "tQUOTE");
        RiftPool pool = new RiftPool(IERC20(address(t0)), IERC20(address(t1)));
        MockVault vault = new MockVault(IERC20(address(t1)));

        t0.mint(me, 10_000e18);
        t1.mint(me, 2_000_000e18);
        t0.approve(address(pool), type(uint256).max);
        t1.approve(address(pool), type(uint256).max);
        t1.approve(address(vault), type(uint256).max);

        pool.addLiquidity(1_000e18, 2_000e18); // price 2.0 tQUOTE per tBASE
        vault.deposit(1_000_000e18);

        vm.stopBroadcast();

        console2.log("BASE_TOKEN0 =", address(t0));
        console2.log("BASE_TOKEN1 =", address(t1));
        console2.log("POOL_BASE   =", address(pool));
        console2.log("VAULT       =", address(vault));
        console2.log("VAULT_ASSET =", address(t1));
        console2.log("VAULT_BAL   =", vault.totalAssets());
    }
}

/// @notice Unichain Sepolia: twin pool #2 (market is deployed separately in DeployMarket).
///   forge script script/DeployOrigin.s.sol:DeployUnichainPool --rpc-url unichain_sepolia --broadcast
contract DeployUnichainPool is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);

        MockToken t0 = new MockToken("Rift Base Asset", "tBASE");
        MockToken t1 = new MockToken("Rift Quote", "tQUOTE");
        RiftPool pool = new RiftPool(IERC20(address(t0)), IERC20(address(t1)));

        t0.mint(me, 10_000e18);
        t1.mint(me, 100_000e18);
        t0.approve(address(pool), type(uint256).max);
        t1.approve(address(pool), type(uint256).max);
        pool.addLiquidity(1_000e18, 2_000e18);

        vm.stopBroadcast();

        console2.log("UNI_TOKEN0 =", address(t0));
        console2.log("UNI_TOKEN1 =", address(t1));
        console2.log("POOL_UNI   =", address(pool));
    }
}
