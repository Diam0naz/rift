// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPayable} from "@reactive/interfaces/IPayable.sol";

import {RiftMarketFactory} from "../src/market/RiftMarketFactory.sol";
import {RiftTypes} from "../src/market/RiftTypes.sol";
import {RiftHub} from "../src/reactive/RiftHub.sol";

// Trader-created markets, in three steps:
//   1. FACTORY:  forge script script/DeployHub.s.sol:DeployFactory --rpc-url unichain_sepolia --broadcast
//   2. HUB:      FACTORY=0x… forge script script/DeployHub.s.sol:DeployHub --rpc-url lasna --broadcast
//   3. LINK:     FACTORY=0x… HUB=0x… forge script script/DeployHub.s.sol:LinkHub --rpc-url unichain_sepolia --broadcast
// Then anyone can call createMarket (the app's Markets screen does it). DemoMarket lists the Rift twin pools
// with cover proposed on the Base MockVault; ApproveCover approves it (pass the vault's current balance):
//   VAULT_BALANCE=$(cast call <asset> "balanceOf(address)(uint256)" <vault> --rpc-url base_sepolia) \
//   FACTORY=0x… MARKET_ID=0 forge script script/DeployHub.s.sol:ApproveCover --rpc-url unichain_sepolia --broadcast

uint256 constant BASE_SEPOLIA = 84532;
uint256 constant UNICHAIN_SEPOLIA = 1301;
uint256 constant ETH_SEPOLIA = 11155111;

contract DeployFactory is Script {
    address internal constant UNICHAIN_SEPOLIA_CALLBACK_PROXY = 0x775c9B990ADe401060B78D0e98684eEf8d2466C1;
    /// tUSD, the collateral of the deployed RiftMarket.
    address internal constant TUSD = 0x7595790414E2C73ADAF3fcC70d8F07055fDDBeAA;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint256[] memory chains = new uint256[](3);
        chains[0] = BASE_SEPOLIA;
        chains[1] = UNICHAIN_SEPOLIA;
        chains[2] = ETH_SEPOLIA;
        vm.startBroadcast(pk);
        RiftMarketFactory f = new RiftMarketFactory(
            IPayable(payable(UNICHAIN_SEPOLIA_CALLBACK_PROXY)), IERC20(vm.envOr("COLLATERAL", TUSD)), chains
        );
        vm.stopBroadcast();
        console2.log("FACTORY =", address(f));
    }
}

contract DeployHub is Script {
    /// Cron1000 (~17 min): heartbeats every market so quiet pools don't go stale. About 1 lREACT/day.
    uint256 internal constant CRON1000 = 0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        RiftHub.Params memory p = RiftHub.Params({
            markEpsilonBps: vm.envOr("MARK_EPSILON_BPS", uint256(10)),
            markHeartbeat: vm.envOr("MARK_HEARTBEAT", uint256(900)),
            markSmoothingSeconds: vm.envOr("MARK_SMOOTHING_SECONDS", uint256(30)),
            maxEventsPerHour: vm.envOr("MAX_EVENTS_PER_HOUR", uint256(240))
        });
        vm.startBroadcast(pk);
        RiftHub hub = new RiftHub{value: vm.envOr("HUB_FUNDING", uint256(5 ether))}(
            UNICHAIN_SEPOLIA, vm.envAddress("FACTORY"), vm.envOr("CRON_TOPIC", CRON1000), p
        );
        vm.stopBroadcast();
        console2.log("HUB =", address(hub));
    }
}

contract LinkHub is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        RiftMarketFactory(vm.envAddress("FACTORY")).setHub(vm.envAddress("HUB"));
        vm.stopBroadcast();
    }
}

/// Lists the Rift twin pools (RiftPool on Base vs RiftPool on Unichain) as a trader-created market, proposing
/// cover on the Base MockVault with RiftReactive's trip rule (5% spread held 2s, 15% outflow in 5 minutes).
contract DemoMarket is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        RiftTypes.Spec memory s;
        s.a = RiftTypes.PoolRef({
            chainId: uint64(BASE_SEPOLIA),
            pool: vm.envOr("POOL_A", address(0xA5aB34c37F2d8C8f86a32BA007F6e421D0B5315D)),
            kind: RiftTypes.KIND_SYNC,
            invert: false,
            decShift: 0,
            minLiquidity: 0
        });
        s.b = RiftTypes.PoolRef({
            chainId: uint64(UNICHAIN_SEPOLIA),
            pool: vm.envOr("POOL_B", address(0x3bE5C66453dB2b55412Bf96b4F2df46F34e239ce)),
            kind: RiftTypes.KIND_SYNC,
            invert: false,
            decShift: 0,
            minLiquidity: 0
        });
        RiftTypes.Cover memory c;
        if (vm.envOr("COVER", true)) {
            c = RiftTypes.Cover({
                chainId: uint64(BASE_SEPOLIA),
                vault: vm.envOr("VAULT", address(0xCC83d90035bea5b69d3358479F046781146353e3)),
                asset: vm.envOr("VAULT_ASSET", address(0x540bd620182C67b3A83375259EA11a1037DC7F58)),
                tripSpreadBps: uint16(vm.envOr("TRIP_SPREAD_BPS", uint256(500))),
                tripOutflowBps: uint16(vm.envOr("TRIP_OUTFLOW_BPS", uint256(1500))),
                sustainSeconds: uint32(vm.envOr("SUSTAIN_SECONDS", uint256(2))),
                windowSeconds: uint32(vm.envOr("WINDOW_SECONDS", uint256(300)))
            });
        }
        RiftMarketFactory f = RiftMarketFactory(vm.envAddress("FACTORY"));
        vm.startBroadcast(pk);
        (uint256 id, address market) = f.createMarket{value: f.minCallbackFunding()}(s, c);
        vm.stopBroadcast();
        console2.log("MARKET ID =", id);
        console2.log("MARKET    =", market);
    }
}

/// Owner approval of a proposed cover. The hub then watches the vault and arms the market.
contract ApproveCover is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        RiftMarketFactory(vm.envAddress("FACTORY")).approveCover(vm.envUint("MARKET_ID"), vm.envUint("VAULT_BALANCE"));
        vm.stopBroadcast();
    }
}
