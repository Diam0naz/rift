// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ISystemContract} from "@reactive/interfaces/ISystemContract.sol";

/// @notice Stand-in for Reactive's system contract (0x8888...8888), etched into that address in tests.
///         Records subscriptions and callback requests so tests can inspect and replay them.
contract MockSystem {
    struct Sub {
        uint256 chainId;
        address contractAddr;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
    }

    Sub[] public subs;
    ISystemContract.CallbackConfiguration_V_1_0[] internal _callbacks;

    receive() external payable {}

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function subscribe(uint256 c, address a, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        subs.push(Sub(c, a, t0, t1, t2, t3));
    }

    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external {}

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory config_) external {
        _callbacks.push(config_);
    }

    function subsCount() external view returns (uint256) {
        return subs.length;
    }

    function callbacksCount() external view returns (uint256) {
        return _callbacks.length;
    }

    function callbackAt(uint256 i) external view returns (ISystemContract.CallbackConfiguration_V_1_0 memory) {
        return _callbacks[i];
    }
}
