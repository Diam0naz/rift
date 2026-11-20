// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "@reactive/base/AbstractReactive.sol";
import {ISystemContract} from "@reactive/interfaces/ISystemContract.sol";

/// @title RiftReactive
/// @notice The settlement engine of Rift, deployed on Reactive (Lasna testnet).
///
///  It subscribes to:
///   - `Sync` on the twin pools (Base Sepolia + Unichain Sepolia) -> mirrors both prices, computes the spread
///   - ERC-20 `Transfer` of the vault asset into / out of the protected vault on Base -> sliding outflow window
///   - `Tripped` on RiftMarket (Unichain Sepolia) -> confirmation that the trip callback was delivered
///   - optionally a CRON tick, so time-based conditions still resolve when no swaps happen
///
///  And sends two callbacks to RiftMarket on Unichain:
///   - `updateMark(spread)` whenever the spread moves by more than `markEpsilonBps` (or on heartbeat)
///   - `trip(...)` when BOTH the spread has stayed beyond `tripSpreadBps` for `sustainSeconds`
///     AND vault outflow inside `windowSeconds` exceeds `tripOutflowBps`. Until the market's `Tripped` event
///     comes back, the same trip is re-sent on later events (at most every TRIP_RETRY_SECONDS), so a lost or
///     failed callback can't leave the market untripped forever. `trip()` on the market is idempotent.
///
///  The two-condition trigger is the anti-manipulation core: a price spike alone (someone pushing a thin pool)
///  or a large legitimate withdrawal alone cannot trip protection payouts.
///  All timers use Reactive's clock (block.timestamp, ~1s blocks) - never block counts.
contract RiftReactive is AbstractReactive {
    // ---------------------------------------------------------------- constants

    uint256 private constant SYNC_TOPIC = uint256(keccak256("Sync(uint112,uint112)"));
    uint256 private constant TRANSFER_TOPIC = uint256(keccak256("Transfer(address,address,uint256)"));
    address private constant CRON_SOURCE = 0x0000000000000000000000000000000000fffFfF;
    /// @dev RiftMarket's `Tripped` event, used as the delivery confirmation for the trip callback.
    uint256 private constant TRIPPED_TOPIC =
        uint256(keccak256("Tripped(int256,uint256,uint256,uint256,uint256,uint256,uint256)"));

    uint64 private constant MARK_GAS = 300_000;
    uint64 private constant TRIP_GAS = 3_000_000;
    uint256 private constant MAX_WINDOW_ENTRIES = 256;
    uint256 public constant TRIP_RETRY_SECONDS = 30;

    // ---------------------------------------------------------------- config

    struct Config {
        uint256 baseChainId; // origin chain with the protected vault (Base Sepolia: 84532)
        uint256 uniChainId; // chain with RiftMarket (Unichain Sepolia: 1301)
        address poolBase;
        address poolUni;
        address vaultAsset; // ERC-20 held by the vault on Base
        address vault;
        address market; // RiftMarket on Unichain
        uint256 initialVaultBalance; // vault balance at deploy time (baseline for the mirror)
        uint256 cronTopic; // 0 = no cron subscription
    }

    struct Params {
        uint256 tripSpreadBps; // |spread| that counts as a breach
        uint256 sustainSeconds; // how long the breach must last
        uint256 windowSeconds; // outflow lookback window
        uint256 tripOutflowBps; // outflow share of the vault that counts as a drain
        uint256 markEpsilonBps; // min move of the smoothed mark before a new mark is pushed
        uint256 markHeartbeat; // push a mark at least this often (seconds), even if unchanged: liveness signal
        uint256 markSmoothingSeconds; // time constant of the time-weighted mark; 0 = raw spread
        uint256 minQuoteReserve; // Syncs with a smaller token1 reserve are ignored (thin-pool guard)
    }

    struct Outflow {
        uint64 ts;
        uint192 amount;
    }

    address public immutable owner;
    uint256 public immutable baseChainId;
    uint256 public immutable uniChainId;
    address public immutable poolBase;
    address public immutable poolUni;
    address public immutable vaultAsset;
    address public immutable vault;
    address public immutable market;

    Params public params;

    // ---------------------------------------------------------------- state

    uint256 public priceBase; // 1e18, token1 per token0
    uint256 public priceUni;

    uint256 public vaultBalance; // mirrored from Transfer logs
    uint256 public windowOutflow; // sum of outflows inside the window
    Outflow[] internal _outflows;
    uint256 internal _head; // first live entry in _outflows

    uint256 public breachSince; // 0 = not in breach
    bool public tripped;
    bool public tripConfirmed; // the market's Tripped event has been seen
    uint256 public lastTripSentAt;
    uint256 public tripsSent;

    // The trip as first decided; retries re-send exactly this.
    int256 internal _tripSpread;
    uint256 internal _tripOutflowBps;
    uint256 internal _tripObservedAt;
    uint256 internal _tripOriginChainId;
    uint256 internal _tripOriginTxHash;

    // Time-weighted mark sent to the perp. Each spread is weighted by how long it actually held, so a
    // spike pushed and reverted within the same second moves the mark by nothing.
    int256 public smoothedSpreadBps;
    int256 internal _heldSpread; // the spread in force since _markUpdatedAt
    uint256 internal _markUpdatedAt;
    bool internal _markInitialized;

    int256 public lastSentMark;
    uint256 public lastSentAt;
    uint256 public marksSent;

    // ---------------------------------------------------------------- events

    event PriceMirrored(uint256 indexed chainId, uint256 price, uint256 originBlock);
    event ThinPoolIgnored(uint256 indexed chainId, uint256 reserve1, uint256 originBlock);
    event VaultFlow(bool outflow, uint256 amount, uint256 vaultBalance, uint256 windowOutflow);
    event BreachStarted(int256 spreadBps, uint256 timestamp);
    event BreachCleared(uint256 timestamp);
    event MarkSent(int256 spreadBps, uint256 observedAt, uint256 originChainId, uint256 originTxHash);
    event TripSent(
        int256 spreadBps, uint256 outflowBps, uint256 observedAt, uint256 originChainId, uint256 originTxHash
    );
    event TripConfirmed(uint256 marketTxHash);
    event DemoReset(uint256 vaultBalance);
    event ParamsUpdated(Params params);

    error NotOwner();
    error AlreadyTripped();
    error BadParams();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(Config memory cfg_, Params memory params_) payable {
        owner = msg.sender;
        baseChainId = cfg_.baseChainId;
        uniChainId = cfg_.uniChainId;
        poolBase = cfg_.poolBase;
        poolUni = cfg_.poolUni;
        vaultAsset = cfg_.vaultAsset;
        vault = cfg_.vault;
        market = cfg_.market;
        vaultBalance = cfg_.initialVaultBalance;
        _setParams(params_);

        uint256 baseId = cfg_.baseChainId;

        // Twin pools.
        SYSTEM.subscribe(baseId, cfg_.poolBase, SYNC_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(cfg_.uniChainId, cfg_.poolUni, SYNC_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);

        // Vault asset flows: out of the vault (topic1 = from) and into the vault (topic2 = to).
        uint256 vaultTopic = uint256(uint160(cfg_.vault));
        SYSTEM.subscribe(baseId, cfg_.vaultAsset, TRANSFER_TOPIC, vaultTopic, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(baseId, cfg_.vaultAsset, TRANSFER_TOPIC, REACTIVE_IGNORE, vaultTopic, REACTIVE_IGNORE);

        // Delivery confirmation: the market emits Tripped when the trip callback lands.
        SYSTEM.subscribe(cfg_.uniChainId, cfg_.market, TRIPPED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);

        // Optional clock so sustained-breach and window expiry resolve without new swaps.
        if (cfg_.cronTopic != 0) {
            SYSTEM.subscribe(0, CRON_SOURCE, cfg_.cronTopic, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
    }

    // ---------------------------------------------------------------- reactive entry point

    function react(LogRecord calldata log_) external onlySystem {
        if (log_.topic0 == TRIPPED_TOPIC) {
            _onTripped(log_);
            return;
        }
        if (log_.topic0 == SYNC_TOPIC) {
            _onSync(log_);
        } else if (log_.topic0 == TRANSFER_TOPIC && log_.contractAddress == vaultAsset && log_.chainId == baseChainId) {
            _onTransfer(log_);
        }
        // Any other subscribed log (cron tick) just re-evaluates.
        _evaluate(log_);
    }

    // ---------------------------------------------------------------- views

    /// @notice Signed spread in bps: (priceUni - priceBase) / priceBase. 0 until both prices are known.
    function spreadBps() public view returns (int256) {
        if (priceBase == 0 || priceUni == 0) return 0;
        return ((int256(priceUni) - int256(priceBase)) * 10_000) / int256(priceBase);
    }

    /// @notice Outflow inside the window as bps of the vault's balance at the window start.
    function outflowBps() public view returns (uint256) {
        uint256 denom = vaultBalance + windowOutflow;
        return denom == 0 ? 0 : (windowOutflow * 10_000) / denom;
    }

    function liveOutflowEntries() external view returns (uint256) {
        return _outflows.length - _head;
    }

    // ---------------------------------------------------------------- owner

    function setParams(Params calldata params_) external onlyOwner {
        if (tripped) revert AlreadyTripped();
        _setParams(params_);
    }

    /// @notice DEMO ONLY: re-arm after a trip so the loop can be shown again.
    function resetDemo(uint256 vaultBalance_) external onlyOwner {
        tripped = false;
        tripConfirmed = false;
        lastTripSentAt = 0;
        _markInitialized = false;
        breachSince = 0;
        vaultBalance = vaultBalance_;
        windowOutflow = 0;
        delete _outflows;
        _head = 0;
        emit DemoReset(vaultBalance_);
    }

    /// @notice Settle any debt to the system contract from this contract's balance.
    function coverDebt() external onlyOwner {
        _coverDebt();
    }

    // ---------------------------------------------------------------- internals

    function _onSync(LogRecord calldata log_) internal {
        if (log_.opCode < 1 || log_.data.length < 64) return;
        (uint112 r0, uint112 r1) = abi.decode(log_.data, (uint112, uint112));
        if (r0 == 0) return;
        if (r1 < params.minQuoteReserve) {
            // Too thin to trust: moving it costs little. Keep the last good price for this pool.
            emit ThinPoolIgnored(log_.chainId, r1, log_.blockNumber);
            return;
        }
        uint256 p = (uint256(r1) * 1e18) / r0;

        if (log_.chainId == baseChainId && log_.contractAddress == poolBase) {
            priceBase = p;
        } else if (log_.chainId == uniChainId && log_.contractAddress == poolUni) {
            priceUni = p;
        } else {
            return;
        }
        emit PriceMirrored(log_.chainId, p, log_.blockNumber);
    }

    function _onTransfer(LogRecord calldata log_) internal {
        if (log_.opCode != 3 || log_.data.length < 32) return;
        address from = address(uint160(log_.topic1));
        address to = address(uint160(log_.topic2));
        uint256 amount = abi.decode(log_.data, (uint256));
        if (from == to) return;
        // Outflow entries store uint192; clamp so windowOutflow and the window entries always agree.
        if (amount > type(uint192).max) amount = type(uint192).max;

        if (from == vault) {
            vaultBalance = amount > vaultBalance ? 0 : vaultBalance - amount;
            windowOutflow += amount;
            _pushOutflow(amount);
            emit VaultFlow(true, amount, vaultBalance, windowOutflow);
        } else if (to == vault) {
            vaultBalance += amount;
            emit VaultFlow(false, amount, vaultBalance, windowOutflow);
        }
    }

    function _onTripped(LogRecord calldata log_) internal {
        if (log_.chainId != uniChainId || log_.contractAddress != market) return;
        if (!tripped || tripConfirmed) return;
        tripConfirmed = true;
        emit TripConfirmed(log_.txHash);
    }

    function _evaluate(LogRecord calldata log_) internal {
        if (tripped) {
            // Re-send until the market confirms; any subscribed event (or a cron tick) drives the retry.
            if (!tripConfirmed && block.timestamp - lastTripSentAt >= TRIP_RETRY_SECONDS) _requestTrip();
            return;
        }
        uint256 nowTs = block.timestamp;
        _pruneWindow(nowTs);

        if (priceBase == 0 || priceUni == 0) return;
        int256 spread = spreadBps();
        uint256 absSpread = _abs(spread);

        // Track how long the spread has been broken.
        if (absSpread >= params.tripSpreadBps) {
            if (breachSince == 0) {
                breachSince = nowTs;
                emit BreachStarted(spread, nowTs);
            }
        } else if (breachSince != 0) {
            breachSince = 0;
            emit BreachCleared(nowTs);
        }

        uint256 outBps = outflowBps();
        bool sustained = breachSince != 0 && nowTs - breachSince >= params.sustainSeconds;

        if (sustained && outBps >= params.tripOutflowBps) {
            tripped = true;
            _sendTrip(spread, outBps, nowTs, log_);
            return;
        }

        // The trip above uses the raw spread (it also needs a real drain); the perp mark is smoothed.
        int256 mark = _updateSmoothedMark(spread, nowTs);
        bool moved = _abs(mark - lastSentMark) >= params.markEpsilonBps;
        bool stale = nowTs - lastSentAt >= params.markHeartbeat;
        if (marksSent == 0 || moved || stale) {
            _sendMark(mark, nowTs, log_);
        }
    }

    /// @dev Exponential moving average in continuous time: over `dt` seconds the mark moves toward the spread
    ///      that held during those seconds by min(dt, tau) / tau of the gap. The new spread only starts to count
    ///      from now on, so a price has to stay put to move the mark.
    function _updateSmoothedMark(int256 spread_, uint256 now_) internal returns (int256 mark) {
        uint256 tau = params.markSmoothingSeconds;
        if (!_markInitialized || tau == 0) {
            mark = spread_;
            _markInitialized = true;
        } else {
            mark = smoothedSpreadBps;
            uint256 dt = now_ - _markUpdatedAt;
            if (dt > 0) {
                uint256 w = dt < tau ? dt : tau;
                mark += ((_heldSpread - mark) * int256(w)) / int256(tau);
            }
        }
        smoothedSpreadBps = mark;
        _heldSpread = spread_;
        _markUpdatedAt = now_;
    }

    function _sendMark(int256 spread_, uint256 nowTs_, LogRecord calldata log_) internal {
        lastSentMark = spread_;
        lastSentAt = nowTs_;
        marksSent++;
        bytes memory payload = abi.encodeWithSignature(
            "updateMark(address,int256,uint256,uint256,uint256)",
            address(0), // replaced with this contract's address by the callback proxy
            spread_,
            nowTs_,
            log_.chainId,
            log_.txHash
        );
        _callback(payload, MARK_GAS);
        emit MarkSent(spread_, nowTs_, log_.chainId, log_.txHash);
    }

    function _sendTrip(int256 spread_, uint256 outBps_, uint256 nowTs_, LogRecord calldata log_) internal {
        _tripSpread = spread_;
        _tripOutflowBps = outBps_;
        _tripObservedAt = nowTs_;
        _tripOriginChainId = log_.chainId;
        _tripOriginTxHash = log_.txHash;
        _requestTrip();
    }

    function _requestTrip() internal {
        lastTripSentAt = block.timestamp;
        tripsSent++;
        bytes memory payload = abi.encodeWithSignature(
            "trip(address,int256,uint256,uint256,uint256,uint256)",
            address(0),
            _tripSpread,
            _tripOutflowBps,
            _tripObservedAt,
            _tripOriginChainId,
            _tripOriginTxHash
        );
        _callback(payload, TRIP_GAS);
        emit TripSent(_tripSpread, _tripOutflowBps, _tripObservedAt, _tripOriginChainId, _tripOriginTxHash);
    }

    function _callback(bytes memory payload_, uint64 gas_) internal {
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: uniChainId, recipient: market, gasLimit: gas_, payload: payload_
            })
        );
    }

    function _pushOutflow(uint256 amount_) internal {
        // Bounded: if the window fills up, fold the oldest entry away (it is the first to expire anyway).
        if (_outflows.length - _head >= MAX_WINDOW_ENTRIES) {
            windowOutflow -= _outflows[_head].amount;
            delete _outflows[_head];
            _head++;
        }
        _outflows.push(Outflow({ts: uint64(block.timestamp), amount: uint192(amount_)}));
    }

    function _pruneWindow(uint256 nowTs_) internal {
        uint256 cutoff = nowTs_ > params.windowSeconds ? nowTs_ - params.windowSeconds : 0;
        uint256 len = _outflows.length;
        while (_head < len && _outflows[_head].ts < cutoff) {
            windowOutflow -= _outflows[_head].amount;
            delete _outflows[_head];
            _head++;
        }
    }

    function _setParams(Params memory p_) internal {
        if (p_.tripSpreadBps == 0 || p_.windowSeconds == 0 || p_.tripOutflowBps == 0 || p_.tripOutflowBps > 10_000) {
            revert BadParams();
        }
        params = p_;
        emit ParamsUpdated(p_);
    }

    function _abs(int256 x_) internal pure returns (uint256) {
        return x_ >= 0 ? uint256(x_) : uint256(-x_);
    }
}
