// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {RiftReactive} from "../src/reactive/RiftReactive.sol";

/// @notice Reactive Lasna: the settlement engine. Run after the Base + Unichain deployments.
///   forge script script/DeployReactive.s.sol:DeployReactive --rpc-url lasna --broadcast
contract DeployReactive is Script {
    uint256 constant BASE_SEPOLIA = 84532;
    uint256 constant UNICHAIN_SEPOLIA = 1301;
    /// Cron10 (~10s) topic from dev.reactive.network/reactive-contracts. Set CRON_TOPIC=0 to disable.
    uint256 constant CRON10 = 0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint256 funding = vm.envOr("REACTIVE_FUNDING", uint256(1 ether));

        RiftReactive.Config memory cfg = RiftReactive.Config({
            baseChainId: BASE_SEPOLIA,
            uniChainId: UNICHAIN_SEPOLIA,
            poolBase: vm.envAddress("POOL_BASE"),
            poolUni: vm.envAddress("POOL_UNI"),
            vaultAsset: vm.envAddress("VAULT_ASSET"),
            vault: vm.envAddress("VAULT"),
            market: vm.envAddress("MARKET"),
            initialVaultBalance: vm.envUint("VAULT_BAL"),
            cronTopic: vm.envOr("CRON_TOPIC", CRON10)
        });

        RiftReactive.Params memory p = RiftReactive.Params({
            tripSpreadBps: vm.envOr("TRIP_SPREAD_BPS", uint256(500)),
            sustainSeconds: vm.envOr("SUSTAIN_SECONDS", uint256(2)),
            windowSeconds: vm.envOr("WINDOW_SECONDS", uint256(300)),
            tripOutflowBps: vm.envOr("TRIP_OUTFLOW_BPS", uint256(1500)),
            markEpsilonBps: vm.envOr("MARK_EPSILON_BPS", uint256(10)),
            markHeartbeat: vm.envOr("MARK_HEARTBEAT", uint256(60))
        });

        vm.startBroadcast(pk);
        RiftReactive rx = new RiftReactive{value: funding}(cfg, p);
        vm.stopBroadcast();

        console2.log("REACTIVE =", address(rx));
    }
}
