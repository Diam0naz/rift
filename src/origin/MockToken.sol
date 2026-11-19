// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockToken
/// @notice Testnet token with an open faucet. Used for the pool pair, the protected vault and collateral.
contract MockToken is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 10_000e18;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice Anyone can mint on testnet.
    function mint(address to_, uint256 amount_) external {
        _mint(to_, amount_);
    }

    /// @notice Convenience faucet for the demo UI.
    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
