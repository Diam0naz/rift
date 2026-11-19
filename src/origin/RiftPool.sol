// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title RiftPool
/// @notice Minimal constant-product pool, deployed once on Unichain Sepolia and once on Base Sepolia.
/// @dev Emits Uniswap V2's `Sync(uint112,uint112)` so RiftReactive can mirror reserves straight from logs.
///      Price convention everywhere in Rift: token1 per token0 (reserve1 / reserve0).
contract RiftPool {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 30; // 0.3%

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint112 public reserve0;
    uint112 public reserve1;

    event Sync(uint112 reserve0, uint112 reserve1);
    event Swap(address indexed sender, bool zeroForOne, uint256 amountIn, uint256 amountOut, address indexed to);
    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1);

    error ZeroAmount();
    error Slippage(uint256 amountOut, uint256 minOut);
    error NoLiquidity();

    constructor(IERC20 token0_, IERC20 token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    /// @notice Add liquidity at any ratio. Demo pool: no LP shares, liquidity is donated.
    function addLiquidity(uint256 amount0_, uint256 amount1_) external {
        if (amount0_ == 0 || amount1_ == 0) revert ZeroAmount();
        token0.safeTransferFrom(msg.sender, address(this), amount0_);
        token1.safeTransferFrom(msg.sender, address(this), amount1_);
        emit LiquidityAdded(msg.sender, amount0_, amount1_);
        _sync();
    }

    /// @notice Swap an exact input amount.
    /// @param zeroForOne_ true to sell token0 for token1.
    function swap(bool zeroForOne_, uint256 amountIn_, uint256 minOut_, address to_) external returns (uint256 amountOut) {
        if (amountIn_ == 0) revert ZeroAmount();
        amountOut = getAmountOut(zeroForOne_, amountIn_);
        if (amountOut < minOut_) revert Slippage(amountOut, minOut_);

        (IERC20 tokenIn, IERC20 tokenOut) = zeroForOne_ ? (token0, token1) : (token1, token0);
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn_);
        tokenOut.safeTransfer(to_, amountOut);

        emit Swap(msg.sender, zeroForOne_, amountIn_, amountOut, to_);
        _sync();
    }

    function getAmountOut(bool zeroForOne_, uint256 amountIn_) public view returns (uint256) {
        (uint256 rIn, uint256 rOut) = zeroForOne_ ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
        if (rIn == 0 || rOut == 0) revert NoLiquidity();
        uint256 inWithFee = amountIn_ * (10_000 - FEE_BPS);
        return (inWithFee * rOut) / (rIn * 10_000 + inWithFee);
    }

    /// @notice Spot price, token1 per token0, 1e18 fixed point.
    function price() external view returns (uint256) {
        return reserve0 == 0 ? 0 : (uint256(reserve1) * 1e18) / reserve0;
    }

    function _sync() internal {
        reserve0 = uint112(token0.balanceOf(address(this)));
        reserve1 = uint112(token1.balanceOf(address(this)));
        emit Sync(reserve0, reserve1);
    }
}
