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
///  Pools must sit on chains Reactive watches (`allowedChain`), and the same two pools are listed once at a time:
///  a pair can be listed again only after its market has tripped (a tripped market is frozen for good).
///
///  Cover: a creator can propose drain cover on a vault with the listing. It goes live only when the owner
///  approves it (`approveCover`), because whoever controls a vault and two thin pools could trip their own cover
///  against the underwriters. Approval emits `CoverApproved`; the hub then watches the vault and arms the market.
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
    /// @dev key -> id + 1 of the market currently listed on it (0 = free)
    mapping(bytes32 key => uint256) internal _listing;
    address[] internal _markets;
    mapping(uint256 id => RiftTypes.Spec) internal _specs;
    mapping(uint256 id => address) public creatorOf;

    enum CoverStatus {
        None,
        Proposed,
        Approved,
        Rejected
    }

    mapping(uint256 id => RiftTypes.Cover) internal _covers;
    mapping(uint256 id => CoverStatus) public coverStatus;

    uint256 public constant MIN_TRIP_BPS = 100;
    /// @dev The trip must land before an underwriter's WITHDRAW_DELAY (1 hour) runs out.
    uint32 public constant MAX_SUSTAIN = 30 minutes;
    uint32 public constant MIN_WINDOW = 1 minutes;
    uint32 public constant MAX_WINDOW = 1 days;

    event HubSet(address hub);
    event ChainAllowed(uint256 chainId, bool allowed);
    event MinCallbackFundingSet(uint256 amount);
    event CoverProposed(uint256 indexed id, RiftTypes.Cover cover);
    event CoverRejected(uint256 indexed id);

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
    error BadCover();
    error NoCoverProposed();

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

    /// @notice Approve the cover proposed for market `id_`. `vaultBalance_` is the vault's `asset` balance now
    ///         (read on the vault's chain): the hub counts outflows against it. Calling it again re-emits the
    ///         event, so a delivery that was missed can be retried; the hub ignores repeats.
    function approveCover(uint256 id_, uint256 vaultBalance_) external onlyOwner {
        CoverStatus st = coverStatus[id_];
        if (st != CoverStatus.Proposed && st != CoverStatus.Approved) revert NoCoverProposed();
        coverStatus[id_] = CoverStatus.Approved;
        emit CoverApproved(id_, _markets[id_], _covers[id_], vaultBalance_);
    }

    function rejectCover(uint256 id_) external onlyOwner {
        if (coverStatus[id_] != CoverStatus.Proposed) revert NoCoverProposed();
        coverStatus[id_] = CoverStatus.Rejected;
        emit CoverRejected(id_);
    }

    // ---------------------------------------------------------------- create

    /// @notice Deploys a spread market on `spec_` (B's price over A's). Send at least `minCallbackFunding`.
    ///         `cover_.chainId == 0` lists it without cover; otherwise the cover waits for the owner's approval.
    function createMarket(RiftTypes.Spec calldata spec_, RiftTypes.Cover calldata cover_)
        external
        payable
        returns (uint256 id, address market)
    {
        if (hub == address(0)) revert HubNotSet();
        if (msg.value < minCallbackFunding) revert Underfunded(minCallbackFunding);
        if (_markets.length >= MAX_MARKETS) revert TooManyMarkets();
        _check(spec_.a);
        _check(spec_.b);
        if (spec_.a.chainId == spec_.b.chainId && spec_.a.pool == spec_.b.pool) revert SamePool();
        bytes32 k = key(spec_);
        uint256 cur = _listing[k];
        if (cur != 0 && !RiftSpreadMarket(payable(_markets[cur - 1])).tripped()) revert AlreadyListed();
        if (cover_.chainId != 0) _checkCover(cover_);

        id = _markets.length;
        _listing[k] = id + 1;
        market = address(new RiftSpreadMarket{value: msg.value}(callbackProxy, collateral, hub, id));
        _markets.push(market);
        _specs[id] = spec_;
        creatorOf[id] = msg.sender;
        emit MarketCreated(id, market, msg.sender, spec_);
        if (cover_.chainId != 0) {
            _covers[id] = cover_;
            coverStatus[id] = CoverStatus.Proposed;
            emit CoverProposed(id, cover_);
        }
    }

    // ---------------------------------------------------------------- views

    /// @notice One listing per ordered pair of pools.
    function key(RiftTypes.Spec calldata spec_) public pure returns (bytes32) {
        return keccak256(abi.encode(spec_.a.chainId, spec_.a.pool, spec_.b.chainId, spec_.b.pool));
    }

    /// @notice Whether these two pools are listed on a market that hasn't tripped.
    function listed(bytes32 key_) public view returns (bool) {
        uint256 cur = _listing[key_];
        return cur != 0 && !RiftSpreadMarket(payable(_markets[cur - 1])).tripped();
    }

    function coverOf(uint256 id_) external view returns (RiftTypes.Cover memory) {
        return _covers[id_];
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

    function _checkCover(RiftTypes.Cover calldata c_) internal view {
        if (!allowedChain[c_.chainId]) revert ChainNotAllowed(c_.chainId);
        if (c_.vault == address(0) || c_.asset == address(0)) revert BadCover();
        if (c_.tripSpreadBps < MIN_TRIP_BPS || c_.tripSpreadBps > 10_000) revert BadCover();
        if (c_.tripOutflowBps < MIN_TRIP_BPS || c_.tripOutflowBps > 10_000) revert BadCover();
        if (c_.sustainSeconds > MAX_SUSTAIN) revert BadCover();
        if (c_.windowSeconds < MIN_WINDOW || c_.windowSeconds > MAX_WINDOW) revert BadCover();
    }
}
