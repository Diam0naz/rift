// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockVault
/// @notice Stand-in for any protocol vault on Base Sepolia that Rift sells drain protection on.
/// @dev RiftReactive never touches this contract: it watches the token's ERC-20 Transfer logs in and out
///      of the vault, so any existing vault could be covered without changes. `simulateExploit` exists
///      only so the demo can reproduce a drain on testnet.
contract MockVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    address public immutable owner;
    mapping(address account => uint256 balance) public balanceOf;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event ExploitSimulated(address indexed to, uint256 amount);

    error NotOwner();
    error Insufficient();

    constructor(IERC20 asset_) {
        asset = asset_;
        owner = msg.sender;
    }

    function deposit(uint256 amount_) external {
        asset.safeTransferFrom(msg.sender, address(this), amount_);
        balanceOf[msg.sender] += amount_;
        emit Deposited(msg.sender, amount_);
    }

    function withdraw(uint256 amount_) external {
        if (balanceOf[msg.sender] < amount_) revert Insufficient();
        balanceOf[msg.sender] -= amount_;
        asset.safeTransfer(msg.sender, amount_);
        emit Withdrawn(msg.sender, amount_);
    }

    /// @notice DEMO ONLY: move funds out as an attacker would.
    function simulateExploit(address to_, uint256 amount_) external {
        if (msg.sender != owner) revert NotOwner();
        asset.safeTransfer(to_, amount_);
        emit ExploitSimulated(to_, amount_);
    }

    function totalAssets() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }
}
