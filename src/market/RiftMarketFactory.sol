// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPayable} from "@reactive/interfaces/IPayable.sol";

import {RiftSpreadMarket} from "./RiftSpreadMarket.sol";
import {RiftTypes, IRiftMarketFactoryEvents} from "./RiftTypes.sol";

/// @title RiftMarketFactory
/// @notice Anyone can open a spread market on any two pools (Unichain Sepolia). `createMarket` deploys a
///         RiftSpreadMarket and emits `MarketCreated`; RiftHub on Lasna subscribes to that event, starts watching
///         both pools inside `react()`, and from then on marks the new market. No deploy on Lasna per market.
///
///  The creator funds the market's callback gas (native token, kept by the market for the callback proxy).
///  Pools must sit on chains Reactive watches (`allowedChain`), and the same two pools can only be listed once.
contract RiftMarketFactory is IRiftMarketFactoryEvents {
    /// @dev Bounds the hub's per-event and per-cron loops.
    uint256 public constant MAX_MARKETS = 32;
    int8 internal constant MAX_DEC_SHIFT = 36;

    IPayable public immutable callbackProxy;
    IERC20 public immutable collateral;
    address public immutable owner;
    /// @notice RiftHub on Lasna, set once after it is deployed (it needs this factory's address first).
    address public hub;
    /// @notice Native token each new market must be funded with for its callbacks.
    uint256 public minCallbackFunding = 0.002 ether;

    mapping(uint256 chainId => bool) public allowedChain;
    mapping(bytes32 key => bool) public listed;
    address[] internal _markets;
    mapping(uint256 id => RiftTypes.Spec) internal _specs;
    mapping(uint256 id => address) public creatorOf;

    event HubSet(address hub);
    event ChainAllowed(uint256 chainId, bool allowed);
    event MinCallbackFundingSet(uint256 amount);

    error NotOwner();
    error HubNotSet();
    error HubAlreadySet();
    error ZeroAddress();
    error ChainNotAllowed(uint256 chainId);
    error BadPool();
    error SamePool();
    error AlreadyListed();
    error TooManyMarkets();
    error Underfunded(uint256 required);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IPayable callbackProxy_, IERC20 collateral_, uint256[] memory chains_) {
        callbackProxy = callbackProxy_;
        collateral = collateral_;
        owner = msg.sender;
        for (uint256 i; i < chains_.length; ++i) {
            allowedChain[chains_[i]] = true;
            emit ChainAllowed(chains_[i], true);
        }
    }

    // ---------------------------------------------------------------- owner

    function setHub(address hub_) external onlyOwner {
        if (hub_ == address(0)) revert ZeroAddress();
        if (hub != address(0)) revert HubAlreadySet();
        hub = hub_;
        emit HubSet(hub_);
    }

    function setAllowedChain(uint256 chainId_, bool allowed_) external onlyOwner {
        allowedChain[chainId_] = allowed_;
        emit ChainAllowed(chainId_, allowed_);
    }

    function setMinCallbackFunding(uint256 amount_) external onlyOwner {
        minCallbackFunding = amount_;
        emit MinCallbackFundingSet(amount_);
    }

    // ---------------------------------------------------------------- create

    /// @notice Deploys a spread market on `spec_` (B's price over A's). Send at least `minCallbackFunding`.
    function createMarket(RiftTypes.Spec calldata spec_) external payable returns (uint256 id, address market) {
        if (hub == address(0)) revert HubNotSet();
        if (msg.value < minCallbackFunding) revert Underfunded(minCallbackFunding);
        if (_markets.length >= MAX_MARKETS) revert TooManyMarkets();
        _check(spec_.a);
        _check(spec_.b);
        if (spec_.a.chainId == spec_.b.chainId && spec_.a.pool == spec_.b.pool) revert SamePool();
        bytes32 k = key(spec_);
        if (listed[k]) revert AlreadyListed();
        listed[k] = true;

        id = _markets.length;
        market = address(new RiftSpreadMarket{value: msg.value}(callbackProxy, collateral, hub, id));
        _markets.push(market);
        _specs[id] = spec_;
        creatorOf[id] = msg.sender;
        emit MarketCreated(id, market, msg.sender, spec_);
    }

    // ---------------------------------------------------------------- views

    /// @notice One listing per ordered pair of pools.
    function key(RiftTypes.Spec calldata spec_) public pure returns (bytes32) {
        return keccak256(abi.encode(spec_.a.chainId, spec_.a.pool, spec_.b.chainId, spec_.b.pool));
    }

    function marketsCount() external view returns (uint256) {
        return _markets.length;
    }

    function marketAt(uint256 id_) external view returns (address) {
        return _markets[id_];
    }

    function markets() external view returns (address[] memory) {
        return _markets;
    }

    function specOf(uint256 id_) external view returns (RiftTypes.Spec memory) {
        return _specs[id_];
    }

    // ---------------------------------------------------------------- internals

    function _check(RiftTypes.PoolRef calldata p_) internal view {
        if (!allowedChain[p_.chainId]) revert ChainNotAllowed(p_.chainId);
        if (p_.pool == address(0) || p_.kind > RiftTypes.KIND_V3) revert BadPool();
        if (p_.decShift > MAX_DEC_SHIFT || p_.decShift < -MAX_DEC_SHIFT) revert BadPool();
    }
}
