// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AbstractReactive} from "@reactive/base/AbstractReactive.sol";
import {ISystemContract} from "@reactive/interfaces/ISystemContract.sol";

import {RiftTypes} from "../market/RiftTypes.sol";

/// @title RiftHub
/// @notice One reactive contract (Reactive Lasna) that marks, and trips, every trader-created market.
///
///  It subscribes to `MarketCreated` and `CoverApproved` on RiftMarketFactory (Unichain Sepolia). When a market is created, it
///  subscribes to that market's two pools from inside `react()`: `Sync` for Uniswap v2 pairs and RiftPools,
///  `Swap` for Uniswap v3 pools. Each pool event updates the price of every market that uses the pool, and the
///  market's time-weighted spread (B over A, in bps) goes to it in an `updateMark` callback when it moves,
///  or on a heartbeat driven by a cron.
///
///  Cost control, since anyone can list a pool: a pool's subscription is shared by all markets on it and
///  dropped when none of them is active, and a pool that emits more than `maxEventsPerHour` is throttled
///  (its uncovered markets paused, its subscription dropped once none are left) until the owner resumes them.
///
///  Cover: when the factory owner approves a market's proposed cover, the factory emits `CoverApproved`. The hub
///  then subscribes to the vault asset's `Transfer` out of and into the vault, and to the market's `Tripped`
///  event, and arms the market with an `armCover` callback; the market sells cover only after that lands.
///  It trips the market when the spread has stayed beyond the cover's threshold for `sustainSeconds` AND the
///  vault's outflow inside the window crosses its threshold: neither a pushed pool nor a big honest withdrawal
///  alone can trip it. A trip is re-sent until the market's `Tripped` comes back; then every subscription of
///  that market is dropped. Covered markets are never throttled, since a throttle would switch their cover off.
// Every external call in this contract goes to Reactive's system contract (subscribe, unsubscribe,
// requestCallbackV_1_0), which is trusted and never calls back in, so state written after those calls
// can't be reentered. Calls in a loop are callback requests to that same contract, bounded by MAX_MARKETS.
// slither-disable-start reentrancy-no-eth,reentrancy-benign,calls-loop
contract RiftHub is AbstractReactive {
    // ---------------------------------------------------------------- constants

    uint256 internal constant SYNC_TOPIC = uint256(keccak256("Sync(uint112,uint112)"));
    uint256 internal constant SWAP_TOPIC =
        uint256(keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)"));
    /// @dev MarketCreated(uint256,address,address,Spec); a test checks it against the factory's event selector.
    uint256 internal constant CREATED_TOPIC = uint256(
        keccak256(
            "MarketCreated(uint256,address,address,((uint64,address,uint8,bool,int8,uint128),(uint64,address,uint8,bool,int8,uint128)))"
        )
    );
    /// @dev CoverApproved(uint256,address,Cover,uint256); a test checks it against the factory's event selector.
    uint256 internal constant COVER_TOPIC = uint256(
        keccak256("CoverApproved(uint256,address,(uint64,address,address,uint16,uint16,uint32,uint32),uint256)")
    );
    uint256 internal constant TRANSFER_TOPIC = uint256(keccak256("Transfer(address,address,uint256)"));
    /// @dev RiftSpreadMarket's `Tripped`: the delivery confirmation of the trip callback.
    uint256 internal constant TRIPPED_TOPIC =
        uint256(keccak256("Tripped(int256,uint256,uint256,uint256,uint256,uint256,uint256)"));
    address internal constant CRON_SOURCE = 0x0000000000000000000000000000000000fffFfF;

    uint64 internal constant MARK_GAS = 300_000;
    uint64 internal constant TRIP_GAS = 3_000_000;
    uint256 public constant TRIP_RETRY_SECONDS = 30;
    uint256 internal constant MAX_WINDOW_ENTRIES = 64;
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant ONE = 1e36; // prices are human units, scaled by 1e36
    /// @notice The mark is capped at ±100%. Wider gaps are pinned there, so funding can't run away.
    int256 public constant MAX_MARK_BPS = 10_000;
    uint256 public constant MAX_MARKETS = 32;

    // ---------------------------------------------------------------- types

    struct Params {
        uint256 markEpsilonBps; // min move of the smoothed mark before a new mark is pushed
        uint256 markHeartbeat; // push at least this often (seconds), driven by the cron
        uint256 markSmoothingSeconds; // time constant of the time-weighted mark; 0 = raw spread
        uint256 maxEventsPerHour; // per pool; above it the pool is throttled
    }

    struct Market {
        address market;
        RiftTypes.Spec spec;
        bool active;
        bool throttled; // paused by the rate guard (as opposed to by the owner)
        uint256 priceA; // 1e36, human, oriented
        uint256 priceB;
        int256 smoothed;
        int256 held;
        uint64 markUpdatedAt;
        bool markInit;
        int256 lastSent;
        uint64 lastSentAt;
        uint32 marksSent;
    }

    /// @notice One market's cover: the vault mirror and the trip state.
    struct CoverState {
        RiftTypes.Cover cfg;
        bool armed; // subscribed to the vault and the market's Tripped
        bool tripped; // decided here
        bool confirmed; // the market's Tripped came back
        uint64 breachSince; // 0 = spread within the threshold
        uint64 lastTripSentAt;
        uint32 tripsSent;
        uint256 vaultBalance; // mirrored from Transfer logs, from the balance given at approval
        uint256 windowOutflow;
        // The trip as first decided; retries re-send exactly this.
        int256 tripSpread;
        uint256 tripOutflowBps;
        uint256 tripObservedAt;
        uint256 tripOriginChainId;
        uint256 tripOriginTxHash;
    }

    struct Outflow {
        uint64 ts;
        uint192 amount;
    }

    struct Window {
        uint64 start;
        uint32 count;
    }

    // ---------------------------------------------------------------- state

    address public immutable owner;
    uint256 public immutable uniChainId;
    address public immutable factory;
    uint256 public immutable cronTopic;

    Params public params;

    mapping(uint256 id => Market) internal _markets;
    mapping(uint256 id => bool) public registered;
    uint256[] internal _ids;
    /// @dev keccak(chainId, pool) -> market ids on that pool
    mapping(bytes32 poolKey => uint256[]) internal _poolMarkets;
    /// @dev keccak(chainId, pool, topic) -> active markets using that subscription
    mapping(bytes32 subKey => uint256) public subRefs;
    mapping(bytes32 poolKey => Window) public windows;

    mapping(uint256 id => CoverState) internal _covers;
    // Written through a storage pointer (`q.push` in _pushOutflow), which Slither doesn't follow.
    // slither-disable-next-line uninitialized-state
    mapping(uint256 id => Outflow[]) internal _outflows;
    mapping(uint256 id => uint256) internal _outHead;
    /// @dev keccak(chainId, asset, vault) -> covered market ids
    mapping(bytes32 vaultKey => uint256[]) internal _vaultMarkets;
    /// @dev market address -> id + 1
    mapping(address market => uint256) internal _idOf;

    // ---------------------------------------------------------------- events

    event MarketRegistered(uint256 indexed id, address market);
    event MarketFailed(uint256 indexed id, uint256 chainId, address pool);
    event MarketActive(uint256 indexed id, bool active);
    event PoolSubscribed(uint256 indexed chainId, address indexed pool, uint256 topic);
    event PoolUnsubscribed(uint256 indexed chainId, address indexed pool, uint256 topic);
    event PoolThrottled(uint256 indexed chainId, address indexed pool, uint256 eventsThisHour);
    event PriceSeen(uint256 indexed id, bool sideB, uint256 price, uint256 originBlock);
    event MarkSent(uint256 indexed id, int256 markBps, uint256 observedAt, uint256 originChainId, uint256 originTxHash);
    event ParamsUpdated(Params params);
    event CoverArmed(uint256 indexed id, uint256 chainId, address vault, uint256 vaultBalance);
    event CoverFailed(uint256 indexed id);
    event VaultFlow(uint256 indexed id, bool outflow, uint256 amount, uint256 vaultBalance, uint256 windowOutflow);
    event BreachStarted(uint256 indexed id, int256 spreadBps);
    event BreachCleared(uint256 indexed id);
    event TripSent(uint256 indexed id, int256 spreadBps, uint256 outflowBps, uint256 observedAt, uint256 attempt);
    event TripConfirmed(uint256 indexed id, uint256 marketTxHash);

    error NotOwner();
    error UnknownMarket();
    error BadParams();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 uniChainId_, address factory_, uint256 cronTopic_, Params memory params_) payable {
        owner = msg.sender;
        uniChainId = uniChainId_;
        // slither-disable-next-line missing-zero-check
        factory = factory_; // set once by the deployer; a wrong address only means no listings arrive
        cronTopic = cronTopic_;
        _setParams(params_);
        SYSTEM.subscribe(uniChainId_, factory_, CREATED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(uniChainId_, factory_, COVER_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        if (cronTopic_ != 0) {
            SYSTEM.subscribe(0, CRON_SOURCE, cronTopic_, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
    }

    // ---------------------------------------------------------------- reactive entry point

    function react(LogRecord calldata log_) external onlySystem {
        uint256 t = log_.topic0;
        if (t == CREATED_TOPIC) {
            if (log_.chainId == uniChainId && log_.contractAddress == factory) _register(log_);
        } else if (t == SYNC_TOPIC || t == SWAP_TOPIC) {
            _onPool(log_);
        } else if (t == TRANSFER_TOPIC) {
            _onTransfer(log_);
        } else if (t == TRIPPED_TOPIC) {
            _onTripped(log_);
        } else if (t == COVER_TOPIC) {
            if (log_.chainId == uniChainId && log_.contractAddress == factory) _armCover(log_);
        } else if (cronTopic != 0 && t == cronTopic) {
            _onCron(log_);
        }
    }

    // ---------------------------------------------------------------- views

    function createdTopic() external pure returns (uint256) {
        return CREATED_TOPIC;
    }

    function coverTopic() external pure returns (uint256) {
        return COVER_TOPIC;
    }

    function coverOf(uint256 id_) external view returns (CoverState memory) {
        return _covers[id_];
    }

    /// @notice Outflow inside the cover's window, in bps of the vault's balance at the window start.
    function outflowBps(uint256 id_) public view returns (uint256) {
        CoverState storage c = _covers[id_];
        uint256 denom = c.vaultBalance + c.windowOutflow;
        return denom == 0 ? 0 : (c.windowOutflow * 10_000) / denom;
    }

    function marketsCount() external view returns (uint256) {
        return _ids.length;
    }

    function marketIds() external view returns (uint256[] memory) {
        return _ids;
    }

    function marketOf(uint256 id_) external view returns (Market memory) {
        return _markets[id_];
    }

    /// @notice B over A in bps (capped at ±MAX_MARK_BPS); 0 until both prices are known.
    function spreadBps(uint256 id_) public view returns (int256) {
        Market storage m = _markets[id_];
        return _spread(m.priceA, m.priceB);
    }

    /// @notice A pool's price from one event, as `spec` reads it: 1e36-scaled, human, oriented.
    /// @return price 0 when the event can't be priced; liquidity the figure the thin-pool guard compares.
    function priceFromLog(uint256 topic0_, bytes calldata data_, int8 decShift_, bool invert_)
        external
        pure
        returns (uint256 price, uint256 liquidity)
    {
        uint256 raw;
        (raw, liquidity) = _raw(topic0_, data_);
        price = _orient(raw, decShift_, invert_);
    }

    // ---------------------------------------------------------------- owner

    function setParams(Params calldata params_) external onlyOwner {
        _setParams(params_);
    }

    /// @notice Pause or resume a market. Resuming also clears a throttle (the pool's hourly count restarts).
    function setActive(uint256 id_, bool active_) external onlyOwner {
        if (!registered[id_]) revert UnknownMarket();
        Market storage m = _markets[id_];
        if (active_) {
            delete windows[_poolKey(m.spec.a)];
            delete windows[_poolKey(m.spec.b)];
        }
        _setActive(id_, active_);
    }

    function coverDebt() external onlyOwner {
        _coverDebt();
    }

    // ---------------------------------------------------------------- internals: registration

    function _register(LogRecord calldata log_) internal {
        uint256 id = log_.topic1;
        if (registered[id] || _ids.length >= MAX_MARKETS) return; // duplicate delivery, or full
        address market = address(uint160(log_.topic2));
        RiftTypes.Spec memory spec = abi.decode(log_.data, (RiftTypes.Spec));
        registered[id] = true;
        _ids.push(id);
        Market storage m = _markets[id];
        m.market = market;
        m.spec = spec;
        _poolMarkets[_poolKey(spec.a)].push(id);
        _poolMarkets[_poolKey(spec.b)].push(id);
        emit MarketRegistered(id, market);
        _setActive(id, true);
    }

    function _setActive(uint256 id_, bool active_) internal {
        Market storage m = _markets[id_];
        if (m.active == active_) return;
        if (active_) {
            if (!_acquire(m.spec.a)) {
                emit MarketFailed(id_, m.spec.a.chainId, m.spec.a.pool);
                return;
            }
            if (!_acquire(m.spec.b)) {
                _release(m.spec.a);
                emit MarketFailed(id_, m.spec.b.chainId, m.spec.b.pool);
                return;
            }
            m.active = true;
            m.throttled = false;
        } else {
            _release(m.spec.a);
            _release(m.spec.b);
            m.active = false;
        }
        emit MarketActive(id_, active_);
    }

    function _acquire(RiftTypes.PoolRef memory p_) internal returns (bool) {
        return _sub(p_.chainId, p_.pool, _topic(p_.kind), REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _release(RiftTypes.PoolRef memory p_) internal {
        _unsub(p_.chainId, p_.pool, _topic(p_.kind), REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    /// @dev Subscribes on the first user of these criteria; counts the rest. False if Reactive refused it.
    function _sub(uint256 chainId_, address addr_, uint256 topic0_, uint256 t1_, uint256 t2_) internal returns (bool) {
        bytes32 k = _subKey(chainId_, addr_, topic0_, t1_, t2_);
        if (subRefs[k] == 0) {
            try SYSTEM.subscribe(chainId_, addr_, topic0_, t1_, t2_, REACTIVE_IGNORE) {
                emit PoolSubscribed(chainId_, addr_, topic0_);
            } catch {
                return false;
            }
        }
        subRefs[k]++;
        return true;
    }

    function _unsub(uint256 chainId_, address addr_, uint256 topic0_, uint256 t1_, uint256 t2_) internal {
        bytes32 k = _subKey(chainId_, addr_, topic0_, t1_, t2_);
        if (subRefs[k] == 0) return;
        if (--subRefs[k] == 0) {
            // Same six criteria as the subscribe, or the subscription would silently stay.
            try SYSTEM.unsubscribe(chainId_, addr_, topic0_, t1_, t2_, REACTIVE_IGNORE) {
                emit PoolUnsubscribed(chainId_, addr_, topic0_);
            } catch {}
        }
    }

    /// @dev Pool subscriptions keep their phase-1 key (chainId, pool, topic), so subRefs reads the same.
    function _subKey(uint256 chainId_, address addr_, uint256 topic0_, uint256 t1_, uint256 t2_)
        internal
        pure
        returns (bytes32)
    {
        if (t1_ == REACTIVE_IGNORE && t2_ == REACTIVE_IGNORE) {
            return keccak256(abi.encode(uint64(chainId_), addr_, topic0_));
        }
        return keccak256(abi.encode(uint64(chainId_), addr_, topic0_, t1_, t2_));
    }

    // ---------------------------------------------------------------- internals: cover

    function _armCover(LogRecord calldata log_) internal {
        uint256 id = log_.topic1;
        Market storage m = _markets[id];
        if (!registered[id] || m.market != address(uint160(log_.topic2))) {
            emit CoverFailed(id);
            return;
        }
        CoverState storage c = _covers[id];
        if (c.armed || c.tripped) return; // a re-sent approval
        (RiftTypes.Cover memory cfg, uint256 balance) = abi.decode(log_.data, (RiftTypes.Cover, uint256));
        if (!_subCover(cfg, m.market)) {
            emit CoverFailed(id);
            return;
        }
        c.cfg = cfg;
        c.vaultBalance = balance;
        c.armed = true;
        _vaultMarkets[_vaultKey(cfg.chainId, cfg.asset, cfg.vault)].push(id);
        _idOf[m.market] = id + 1;
        _send(m.market, MARK_GAS, abi.encodeWithSignature("armCover(address,uint256)", address(0), balance));
        emit CoverArmed(id, cfg.chainId, cfg.vault, balance);
    }

    /// @dev Vault outflows (topic1 = from), inflows (topic2 = to), and the market's Tripped. All or nothing.
    function _subCover(RiftTypes.Cover memory c_, address market_) internal returns (bool) {
        uint256 v = uint256(uint160(c_.vault));
        if (!_sub(c_.chainId, c_.asset, TRANSFER_TOPIC, v, REACTIVE_IGNORE)) return false;
        if (!_sub(c_.chainId, c_.asset, TRANSFER_TOPIC, REACTIVE_IGNORE, v)) {
            _unsub(c_.chainId, c_.asset, TRANSFER_TOPIC, v, REACTIVE_IGNORE);
            return false;
        }
        if (!_sub(uniChainId, market_, TRIPPED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE)) {
            _unsub(c_.chainId, c_.asset, TRANSFER_TOPIC, v, REACTIVE_IGNORE);
            _unsub(c_.chainId, c_.asset, TRANSFER_TOPIC, REACTIVE_IGNORE, v);
            return false;
        }
        return true;
    }

    function _unsubCover(RiftTypes.Cover memory c_, address market_) internal {
        uint256 v = uint256(uint160(c_.vault));
        _unsub(c_.chainId, c_.asset, TRANSFER_TOPIC, v, REACTIVE_IGNORE);
        _unsub(c_.chainId, c_.asset, TRANSFER_TOPIC, REACTIVE_IGNORE, v);
        _unsub(uniChainId, market_, TRIPPED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _onTransfer(LogRecord calldata log_) internal {
        if (log_.data.length < 32) return;
        address from = address(uint160(log_.topic1));
        address to = address(uint160(log_.topic2));
        if (from == to) return;
        uint256 amount = abi.decode(log_.data, (uint256));
        // Window entries store uint192; clamp so the window sum and its entries always agree.
        if (amount > type(uint192).max) amount = type(uint192).max;

        uint256[] storage outs = _vaultMarkets[_vaultKey(log_.chainId, log_.contractAddress, from)];
        for (uint256 i; i < outs.length; ++i) {
            uint256 id = outs[i];
            CoverState storage c = _covers[id];
            if (!c.armed || c.tripped) continue;
            c.vaultBalance = amount > c.vaultBalance ? 0 : c.vaultBalance - amount;
            c.windowOutflow += amount;
            _pushOutflow(id, c, amount);
            emit VaultFlow(id, true, amount, c.vaultBalance, c.windowOutflow);
            if (_markets[id].active) _evaluate(id, log_.chainId, log_.txHash);
        }
        uint256[] storage ins = _vaultMarkets[_vaultKey(log_.chainId, log_.contractAddress, to)];
        for (uint256 i; i < ins.length; ++i) {
            CoverState storage c = _covers[ins[i]];
            if (!c.armed || c.tripped) continue;
            c.vaultBalance += amount;
            emit VaultFlow(ins[i], false, amount, c.vaultBalance, c.windowOutflow);
        }
    }

    function _onTripped(LogRecord calldata log_) internal {
        if (log_.chainId != uniChainId) return;
        uint256 idp = _idOf[log_.contractAddress];
        if (idp == 0) return;
        uint256 id = idp - 1;
        CoverState storage c = _covers[id];
        if (!c.tripped || c.confirmed) return;
        c.confirmed = true;
        emit TripConfirmed(id, log_.txHash);
        // The market is frozen for good: stop paying for its events.
        _unsubCover(c.cfg, _markets[id].market);
        _setActive(id, false);
    }

    /// @dev The trip rule. True when it tripped the market just now.
    function _checkTrip(uint256 id_, CoverState storage c, int256 spread_, uint256 now_, uint256 chain_, uint256 tx_)
        internal
        returns (bool)
    {
        _pruneWindow(id_, c, now_);
        if (_abs(spread_) >= c.cfg.tripSpreadBps) {
            if (c.breachSince == 0) {
                c.breachSince = uint64(now_);
                emit BreachStarted(id_, spread_);
            }
        } else if (c.breachSince != 0) {
            c.breachSince = 0;
            emit BreachCleared(id_);
        }
        uint256 outBps = outflowBps(id_);
        bool sustained = c.breachSince != 0 && now_ - c.breachSince >= c.cfg.sustainSeconds;
        if (!sustained || outBps < c.cfg.tripOutflowBps) return false;

        c.tripped = true;
        c.tripSpread = spread_;
        c.tripOutflowBps = outBps;
        c.tripObservedAt = now_;
        c.tripOriginChainId = chain_;
        c.tripOriginTxHash = tx_;
        _sendTrip(id_, c);
        return true;
    }

    function _sendTrip(uint256 id_, CoverState storage c) internal {
        c.lastTripSentAt = uint64(block.timestamp);
        c.tripsSent++;
        _send(
            _markets[id_].market,
            TRIP_GAS,
            abi.encodeWithSignature(
                "trip(address,int256,uint256,uint256,uint256,uint256)",
                address(0),
                c.tripSpread,
                c.tripOutflowBps,
                c.tripObservedAt,
                c.tripOriginChainId,
                c.tripOriginTxHash
            )
        );
        emit TripSent(id_, c.tripSpread, c.tripOutflowBps, c.tripObservedAt, c.tripsSent);
    }

    function _pushOutflow(uint256 id_, CoverState storage c, uint256 amount_) internal {
        Outflow[] storage q = _outflows[id_];
        uint256 head = _outHead[id_];
        // Bounded: when full, fold the oldest entry away (it is the first to expire anyway).
        if (q.length - head >= MAX_WINDOW_ENTRIES) {
            c.windowOutflow -= q[head].amount;
            delete q[head];
            _outHead[id_] = ++head;
        }
        q.push(Outflow({ts: uint64(block.timestamp), amount: uint192(amount_)}));
    }

    function _pruneWindow(uint256 id_, CoverState storage c, uint256 now_) internal {
        Outflow[] storage q = _outflows[id_];
        uint256 cutoff = now_ > c.cfg.windowSeconds ? now_ - c.cfg.windowSeconds : 0;
        uint256 head = _outHead[id_];
        uint256 len = q.length;
        while (head < len && q[head].ts < cutoff) {
            c.windowOutflow -= q[head].amount;
            delete q[head];
            head++;
        }
        _outHead[id_] = head;
    }

    function _vaultKey(uint256 chainId_, address asset_, address vault_) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint64(chainId_), asset_, vault_));
    }

    // ---------------------------------------------------------------- internals: prices and marks

    function _onPool(LogRecord calldata log_) internal {
        bytes32 pk = keccak256(abi.encode(uint64(log_.chainId), log_.contractAddress));
        if (_throttle(pk, log_)) return;

        (uint256 raw, uint256 liq) = _raw(log_.topic0, log_.data);
        if (raw == 0) return;
        uint256 topicKind = log_.topic0 == SWAP_TOPIC ? RiftTypes.KIND_V3 : RiftTypes.KIND_SYNC;

        uint256[] storage ids = _poolMarkets[pk];
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            Market storage m = _markets[id];
            if (!m.active) continue;
            RiftTypes.PoolRef memory a = m.spec.a;
            RiftTypes.PoolRef memory b = m.spec.b;
            if (_is(a, log_) && a.kind == topicKind && liq >= a.minLiquidity) {
                m.priceA = _orient(raw, a.decShift, a.invert);
                emit PriceSeen(id, false, m.priceA, log_.blockNumber);
            } else if (_is(b, log_) && b.kind == topicKind && liq >= b.minLiquidity) {
                m.priceB = _orient(raw, b.decShift, b.invert);
                emit PriceSeen(id, true, m.priceB, log_.blockNumber);
            } else {
                continue;
            }
            _evaluate(id, log_.chainId, log_.txHash);
        }
    }

    function _onCron(LogRecord calldata log_) internal {
        uint256 n = _ids.length;
        for (uint256 i; i < n; ++i) {
            uint256 id = _ids[i];
            if (_markets[id].active) _evaluate(id, log_.chainId, log_.txHash);
        }
    }

    function _evaluate(uint256 id_, uint256 originChainId_, uint256 originTxHash_) internal {
        Market storage m = _markets[id_];
        CoverState storage c = _covers[id_];
        if (c.tripped) {
            // Re-send until the market confirms; any event on the market (or the cron) drives the retry.
            if (!c.confirmed && block.timestamp - c.lastTripSentAt >= TRIP_RETRY_SECONDS) _sendTrip(id_, c);
            return; // no marks after a trip: the market ignores them
        }
        if (m.priceA == 0 || m.priceB == 0) return;
        int256 spread = _spread(m.priceA, m.priceB);
        uint256 nowTs = block.timestamp;
        // The trip uses the raw spread (it also needs a real drain); the perp mark below is smoothed.
        if (c.armed && _checkTrip(id_, c, spread, nowTs, originChainId_, originTxHash_)) return;

        // Time-weighted mark: each spread counts for as long as it held.
        int256 mark;
        uint256 tau = params.markSmoothingSeconds;
        if (!m.markInit || tau == 0) {
            mark = spread;
            m.markInit = true;
        } else {
            mark = m.smoothed;
            uint256 dt = nowTs - m.markUpdatedAt;
            if (dt > 0) {
                uint256 w = dt < tau ? dt : tau;
                mark += ((m.held - mark) * int256(w)) / int256(tau);
            }
        }
        m.smoothed = mark;
        m.held = spread;
        m.markUpdatedAt = uint64(nowTs);

        bool moved = _abs(mark - m.lastSent) >= params.markEpsilonBps;
        bool stale = nowTs - m.lastSentAt >= params.markHeartbeat;
        if (m.marksSent != 0 && !moved && !stale) return;

        m.lastSent = mark;
        m.lastSentAt = uint64(nowTs);
        m.marksSent++;
        _send(
            m.market,
            MARK_GAS,
            abi.encodeWithSignature(
                "updateMark(address,int256,uint256,uint256,uint256)",
                address(0), // replaced with this contract's address by the callback proxy
                mark,
                nowTs,
                originChainId_,
                originTxHash_
            )
        );
        emit MarkSent(id_, mark, nowTs, originChainId_, originTxHash_);
    }

    /// @dev Counts the pool's events in a rolling hour; over the limit, pauses every uncovered market on it.
    ///      Covered markets stay on (otherwise spamming a pool would switch their cover off before a drain).
    ///      True when no market on the pool is left to update.
    function _throttle(bytes32 pk_, LogRecord calldata log_) internal returns (bool) {
        Window storage w = windows[pk_];
        if (block.timestamp - w.start >= 1 hours) {
            w.start = uint64(block.timestamp);
            w.count = 0;
        }
        w.count++;
        if (w.count <= params.maxEventsPerHour) return false;
        uint256[] storage ids = _poolMarkets[pk_];
        bool left = false;
        bool paused = false;
        for (uint256 i; i < ids.length; ++i) {
            Market storage m = _markets[ids[i]];
            if (!m.active) continue;
            if (_covers[ids[i]].armed) {
                left = true;
            } else {
                _setActive(ids[i], false);
                m.throttled = true;
                paused = true;
            }
        }
        if (paused) emit PoolThrottled(log_.chainId, log_.contractAddress, w.count);
        return !left;
    }

    function _send(address to_, uint64 gas_, bytes memory payload_) internal {
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: uniChainId, recipient: to_, gasLimit: gas_, payload: payload_
            })
        );
    }

    /// @dev token1 per token0 in raw units, scaled by 1e36, and the liquidity figure for the thin-pool guard.
    function _raw(uint256 topic0_, bytes calldata data_) internal pure returns (uint256 raw, uint256 liq) {
        if (topic0_ == SYNC_TOPIC) {
            if (data_.length < 64) return (0, 0);
            (uint112 r0, uint112 r1) = abi.decode(data_, (uint112, uint112));
            if (r0 == 0) return (0, 0);
            return (Math.mulDiv(r1, ONE, r0), r1);
        }
        if (data_.length < 160) return (0, 0);
        (,, uint160 sqrtP, uint128 l,) = abi.decode(data_, (int256, int256, uint160, uint128, int24));
        if (sqrtP == 0) return (0, 0);
        // (sqrtP / 2^96)^2 * 1e36, in two steps so nothing overflows.
        return (Math.mulDiv(Math.mulDiv(sqrtP, sqrtP, Q96), ONE, Q96), l);
    }

    /// @dev Raw -> human (× 10^decShift) -> inverted if asked. 0 when out of range.
    // Shift to human units first, then invert: prices are 1e36-scaled, so the division loses nothing that matters.
    // slither-disable-next-line divide-before-multiply
    function _orient(uint256 raw_, int8 shift_, bool invert_) internal pure returns (uint256 p) {
        p = raw_;
        if (shift_ > 0) {
            uint256 f = 10 ** uint256(uint8(shift_));
            if (p > type(uint256).max / f) return 0;
            p *= f;
        } else if (shift_ < 0) {
            p /= 10 ** uint256(uint8(-shift_));
        }
        if (p == 0) return 0;
        if (invert_) p = Math.mulDiv(ONE, ONE, p);
    }

    function _spread(uint256 pa_, uint256 pb_) internal pure returns (int256) {
        if (pa_ == 0 || pb_ == 0) return 0;
        uint256 d = pb_ >= pa_ ? pb_ - pa_ : pa_ - pb_;
        uint256 bps = Math.mulDiv(d, 10_000, pa_);
        int256 s = bps >= uint256(MAX_MARK_BPS) ? MAX_MARK_BPS : int256(bps);
        return pb_ >= pa_ ? s : -s;
    }

    function _is(RiftTypes.PoolRef memory p_, LogRecord calldata log_) internal pure returns (bool) {
        return p_.chainId == log_.chainId && p_.pool == log_.contractAddress;
    }

    function _poolKey(RiftTypes.PoolRef memory p_) internal pure returns (bytes32) {
        return keccak256(abi.encode(p_.chainId, p_.pool));
    }

    function _topic(uint8 kind_) internal pure returns (uint256) {
        return kind_ == RiftTypes.KIND_V3 ? SWAP_TOPIC : SYNC_TOPIC;
    }

    function _setParams(Params memory p_) internal {
        if (p_.markHeartbeat == 0 || p_.maxEventsPerHour == 0) revert BadParams();
        params = p_;
        emit ParamsUpdated(p_);
    }

    function _abs(int256 x_) internal pure returns (uint256) {
        return x_ >= 0 ? uint256(x_) : uint256(-x_);
    }
}
// slither-disable-end reentrancy-no-eth,reentrancy-benign,calls-loop
