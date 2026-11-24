// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Shared by RiftMarketFactory (Unichain) and RiftHub (Lasna): what a trader-created market watches.
library RiftTypes {
    /// @dev Which event carries the pool's price.
    uint8 internal constant KIND_SYNC = 0; // Uniswap v2 pair or RiftPool: Sync(uint112 reserve0, uint112 reserve1)
    uint8 internal constant KIND_V3 = 1; // Uniswap v3 pool: Swap(..., uint160 sqrtPriceX96, uint128 liquidity, int24 tick)

    /// @notice One side of a market: a pool on some chain, and how to read its price.
    /// @dev The hub prices a pool as token1 per token0 in raw units, then multiplies by 10^decShift
    ///      (decimals0 - decimals1, giving the human price) and inverts it when `invert` is set, so that both
    ///      sides quote the same asset in the same unit.
    struct PoolRef {
        uint64 chainId;
        address pool;
        uint8 kind;
        bool invert;
        int8 decShift;
        /// Thin-pool guard: prices from an event with less than this are ignored. Sync: reserve1 (raw);
        /// v3: in-range liquidity. 0 = off.
        uint128 minLiquidity;
    }

    /// @notice A spread market: the mark is B's price over A's, in bps.
    struct Spec {
        PoolRef a;
        PoolRef b;
    }
}

/// @notice The event the hub subscribes to. Kept in an interface so both sides share one topic0.
interface IRiftMarketFactoryEvents {
    event MarketCreated(uint256 indexed id, address indexed market, address indexed creator, RiftTypes.Spec spec);
}
