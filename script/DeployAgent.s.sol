// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {IRiftMarket, RiftAgentVaultFactory} from "../src/agent/RiftAgentVault.sol";

/// @notice Unichain Sepolia: the agent vault factory, wired to the market, the app's agent key and the fee
///         recipient (the deployer, by default). Also tops up the agent key with gas.
///   AGENT_ADDRESS=0x… forge script script/DeployAgent.s.sol:DeployAgent --rpc-url unichain_sepolia --broadcast
contract DeployAgent is Script {
    error FundingFailed();

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        address market = vm.envAddress("MARKET");
        address agent = vm.envAddress("AGENT_ADDRESS");
        address feeRecipient = vm.envOr("FEE_RECIPIENT", me);
        uint256 agentGas = vm.envOr("AGENT_GAS_FUNDING", uint256(0.002 ether));

        vm.startBroadcast(pk);
        RiftAgentVaultFactory factory = new RiftAgentVaultFactory(IRiftMarket(market), agent, feeRecipient);
        if (agent.balance < agentGas) {
            (bool ok,) = payable(agent).call{value: agentGas - agent.balance}("");
            if (!ok) revert FundingFailed();
        }
        vm.stopBroadcast();

        console2.log("AGENT_FACTORY =", address(factory));
        console2.log("AGENT         =", agent);
        console2.log("FEE_RECIPIENT =", feeRecipient);
    }
}
