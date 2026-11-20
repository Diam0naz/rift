// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {RiftReactive} from "../src/reactive/RiftReactive.sol";

/// @notice Reactive Lasna: the settlement engine. Run after the Base + Unichain deployments.
///   forge script script/DeployReactive.s.sol:DeployReactive --rpc-url lasna --broadcast
contract DeployReactive is Script {
    uint256 internal constant BASE_SEPOLIA = 84532;
    uint256 internal constant UNICHAIN_SEPOLIA = 1301;
    /// Cron topics from dev.reactive.network/reactive-contracts. Every tick is billed: Cron10 (~10s) costs
    /// ~100 lREACT/day, Cron1000 (~17 min) ~1 lREACT/day. Default is Cron1000: it drives the mark heartbeat
    /// the market's liveness check relies on (RiftMarket.maxMarkAge), and trip retries when nothing else
    /// happens. CRON_TOPIC=0 disables it.
    uint256 internal constant CRON1000 = 0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4;

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
            cronTopic: vm.envOr("CRON_TOPIC", CRON1000)
        });

        RiftReactive.Params memory p = RiftReactive.Params({
            tripSpreadBps: vm.envOr("TRIP_SPREAD_BPS", uint256(500)),
            sustainSeconds: vm.envOr("SUSTAIN_SECONDS", uint256(2)),
            windowSeconds: vm.envOr("WINDOW_SECONDS", uint256(300)),
            tripOutflowBps: vm.envOr("TRIP_OUTFLOW_BPS", uint256(1500)),
            markEpsilonBps: vm.envOr("MARK_EPSILON_BPS", uint256(10)),
            markHeartbeat: vm.envOr("MARK_HEARTBEAT", uint256(600)),
            markSmoothingSeconds: vm.envOr("MARK_SMOOTHING_SECONDS", uint256(30)),
            minQuoteReserve: vm.envOr("MIN_QUOTE_RESERVE", uint256(1_000e18))
        });

        vm.startBroadcast(pk);
        RiftReactive rx = new RiftReactive{value: funding}(cfg, p);
        vm.stopBroadcast();

        console2.log("REACTIVE =", address(rx));
    }
}
