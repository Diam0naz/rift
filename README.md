# Rift

**Trade the gap between chains.** Cross-chain spread perps and instant drain protection on Unichain Sepolia and Base Sepolia, settled by a Reactive Omni contract. No oracles, no keepers.

Built for the [Reactive Omni Buildathon](https://dorahacks.io/hackathon/reactive-omni-buildathon/detail) (track: *Every Second Counts*).

## The idea

The same pool runs on two chains, and their prices should agree. When they don't, the gap (the **spread**) is information:

- Small, everyday gaps are normal market drift, so Rift lets people **trade** them (spread perp, funding every second).
- A sudden, sustained gap together with money leaving a vault is what an exploit looks like, so Rift sells **protection** against it (Drain Default Swap) and pays out within seconds of the drain.

Both products run off **one index**: the spread computed by `RiftReactive`. One pool of underwriters backs both.

| Leg | Product | Settles on |
|---|---|---|
| Continuous | Spread perp: long/short the Unichain-vs-Base spread in bps | every `updateMark` callback |
| Jump | Drain Default Swap: pay a premium, receive `notional` if the vault is drained | the `trip` callback fixes every payout; buyers `claim()` it |

## Why it needs Reactive Omni

- The signal lives on **two chains** (pools on Base + Unichain, vault on Base). No single contract can see both, so `RiftReactive` is the only thing that connects them.
- Payout speed is the product. Insurance that pays weeks later doesn't help you during a hack; one that pays **~1s after the drain** lets holders hedge or exit while the market is still moving. On ~7s blocks that window was gone.

## Architecture

```
 Base Sepolia (84532)                Reactive Lasna                       Unichain Sepolia (1301)
 ┌───────────────┐  Sync         ┌──────────────────────┐   updateMark   ┌──────────────────────┐
 │ RiftPool (B)  │──────────────▶│                      │───────────────▶│ RiftMarket           │
 └───────────────┘               │    RiftReactive      │                │  · underwriting pool │
 ┌───────────────┐  Transfer     │  · mirrors prices    │      trip      │  · drain protection  │
 │ MockVault     │──(in / out)──▶│  · spread (bps)      │───────────────▶│  · spread perp       │
 └───────────────┘               │  · outflow window    │                └──────────────────────┘
                                 │  · trip rule         │                ┌──────────────────────┐
                    Sync         │                      │◀───────────────│ RiftPool (U)         │
                                 └──────────────────────┘                └──────────────────────┘
```

### The trip rule (anti-manipulation)

`trip()` fires only when **both** of these are true:

1. `|spread| ≥ tripSpreadBps` **for at least** `sustainSeconds` (timed on Reactive's clock), **and**
2. vault outflow inside `windowSeconds` ≥ `tripOutflowBps` of the vault.

A price spike alone (someone pushing a thin pool to collect on protection) can't trip it, and neither can a large legitimate withdrawal alone. Both cases are covered by tests. All timers use timestamps, never block counts (Base Sepolia runs 200ms blocks).

### Settlement safeguards

- **Cover waiting period.** A drain is public on Base seconds before the trip lands on Unichain. A policy covers nothing until `coverDelay` (default 10 minutes, owner-settable up to 1 hour) after purchase; the delay is fixed on the policy when it's bought. At a trip, policies still waiting are refunded their premium instead of paid, and they don't dilute the payout ratio of covered buyers. Timing is checked against the trip's `observedAt` on Reactive's clock.
- **Claim-based payouts.** `trip()` makes no token transfers: it records what each policy is owed (`PolicySettled`), and `claim(id)` pays it. Anyone can call `claim`, but funds always go to the buyer. A buyer who can't receive tokens (for example a blocklisted address) can't make the trip revert for everyone else.
- **Trip retry with confirmation.** RiftReactive subscribes to the market's own `Tripped` event on Unichain. Until it sees it, every later event re-sends the same trip, at most every `TRIP_RETRY_SECONDS` (30 s). `trip()` is idempotent, so duplicates are harmless.
- **Out-of-order marks.** `updateMark` ignores a mark observed earlier than the current one and emits `StaleMarkIgnored`.

### Perp mark hardening

The trip already needs a real drain, but the perp mark comes straight from pool prices, so it gets its own defences in RiftReactive:

- **Time-weighted mark.** The mark sent to the perp is a continuous-time moving average of the spread (`markSmoothingSeconds`, default 30 s). Each spread is weighted by how long it actually held, so a price pushed and put back within one Reactive second moves the mark by nothing, and a move has to persist to reach the mark. The trip still uses the raw spread, because the trip settles at the crash level, and the outflow condition already guards it.
- **Thin-pool guard.** A `Sync` whose token1 reserve is below `minQuoteReserve` is ignored, and the pool's last good price is kept (`ThinPoolIgnored`).

### Premium pricing

A flat premium sells cover cheaply exactly when it's most dangerous: when the pool is nearly fully committed, or when the spread already shows stress. It also lets anyone buy up all the capacity cheaply and lock other buyers out. So the premium responds to both:

- **Utilization curve.** The daily rate for the marginal unit of cover depends on utilization `u` (live notional / capacity). It rises gently up to a kink (default: 0.10%/day idle, 0.20%/day at 80%) and steeply after it (2.20%/day at 100%).
- **Priced as a cost function.** A purchase pays the area under the rate curve from the utilization before it to the utilization after it, times duration. That's the LMSR idea applied to pool capacity: the price depends only on where you start and end, so splitting an order into pieces costs the same as buying it at once (a fuzz test checks this). Capacity is pool cash *minus the premiums of live policies*, so a purchase's own premium doesn't make the next slice cheaper.
- **Stress loading.** The premium is multiplied by `1 + |mark| / stressSpreadBps` (default 500 bps, the trip threshold), capped at 3x. Cover bought while the spread is already wide costs more.
- `quotePremium(notional, duration)` returns the exact price; `premiumRateBpsPerDay(u)`, `utilizationWad()` and `stressMultiplierBps()` expose the parts. The owner can tune the curve with `setPremiumParams` within hard bounds (each term ≤ 10%/day, kink strictly between 0 and 100%).

Example on a 100k pool with no stress: the first 10k of one-day cover costs 10.63, and the last 10k (90% → 100%) costs 170, about 16x as much.

### Underwriting accounting

- **Shares priced at pool value.** `deposit` and `completeWithdraw` price shares at `poolValue()`: the pool's cash minus traders' unrealized perp PnL net of funding (`tradersUnrealizedPnl()`). A newcomer can't buy into gains the pool hasn't realized yet, and a leaver can't exit before a loss lands. The total comes from running sums of open positions (size × entry mark, size × entry funding), so it costs the same however many positions are open. Rounding always favours the holders who stay.
- **Two-step withdrawals.** `requestWithdraw` locks shares, and `completeWithdraw` pays them out after `WITHDRAW_DELAY` (1 h) at the pool value at that moment. Locked shares stay in the pool, so they still pay for a trip that lands during the wait. An underwriter who sees a drain on Base can't get out first. `cancelWithdraw` unlocks them.
- **Liquidation reward.** `liquidate` pays the caller up to `LIQUIDATION_REWARD_BPS` (1%) of the position's size out of its leftover margin, and the rest goes to the pool. That gives someone a reason to close underwater positions before they turn into bad debt.
- **Stable policy ids.** Ids only ever increase and are never reused, so `policy(id)` and `claim(id)` always refer to the same purchase. A separate list of active policies (`activePolicyIds()`, pruned as policies expire) keeps `trip()` bounded at `MAX_POLICIES`.

### Liveness guard

If RiftReactive stops (out of lREACT, or callbacks unfunded), a drain could never trip, yet the market would keep selling cover. So:

- RiftReactive resends the mark at least every `markHeartbeat` (default 600 s), even when it hasn't changed. Its Cron1000 subscription (default, ~17 min, ~1 lREACT/day) keeps this going when nobody trades.
- RiftMarket refuses new cover and new positions when the last mark landed more than `maxMarkAge` ago (default 1 h, owner-settable between 5 min and 1 day) and reverts with `StaleMark(age)`. Closing positions and claiming always work.

## Contracts

| Contract | Chain | Role |
|---|---|---|
| `src/origin/RiftPool.sol` | Base + Unichain | Constant-product pool emitting Uniswap V2 `Sync` |
| `src/origin/MockVault.sol` | Base | Protected vault (Rift watches its token transfers; the vault needs no changes) |
| `src/origin/MockToken.sol` | all | Faucet tokens |
| `src/reactive/RiftReactive.sol` | Lasna | Subscriptions, spread, outflow window, trip rule, callbacks |
| `src/market/RiftMarket.sol` | Unichain | Underwriting pool, policies, perp, callback receiver |

Callback auth: `RiftMarket` accepts callbacks only from the Reactive callback proxy **and** only when the injected sender is the linked `RiftReactive`.

## Setup

```bash
./setup.sh          # git init + forge install (forge-std, openzeppelin-contracts, reactive-lib-omni) + build + test
cp .env.example .env
```

## Deploy

Deployment order matters: the reactive contract needs every other address.

```bash
source .env
# 1. Base Sepolia: pool + vault       -> fill POOL_BASE, VAULT, VAULT_ASSET, VAULT_BAL
forge script script/DeployOrigin.s.sol:DeployBase --rpc-url base_sepolia --broadcast
# 2. Unichain Sepolia: twin pool      -> fill POOL_UNI
forge script script/DeployOrigin.s.sol:DeployUnichainPool --rpc-url unichain_sepolia --broadcast
# 3. Unichain Sepolia: market         -> fill MARKET
forge script script/DeployMarket.s.sol:DeployMarket --rpc-url unichain_sepolia --broadcast
# 4. Lasna: reactive contract         -> fill REACTIVE
forge script script/DeployReactive.s.sol:DeployReactive --rpc-url lasna --broadcast
# 5. Unichain Sepolia: link market -> reactive
forge script script/DeployMarket.s.sol:LinkReactive --rpc-url unichain_sepolia --broadcast
```

## Demo loops

```bash
source .env
# 0. Prime: RiftReactive only learns prices from Sync events emitted after it subscribed.
#    A price-neutral addLiquidity on Unichain gives it the Unichain price.
cast send $POOL_UNI "addLiquidity(uint256,uint256)" 1e18 2e18 --rpc-url unichain_sepolia --private-key $PRIVATE_KEY

# Loop 1: swap on Base -> reactive tx on Lasna -> updateMark on Unichain
forge script script/Demo.s.sol:DemoSwap    --rpc-url base_sepolia --broadcast
# Needs a mark on the market (from loop 1) before it can open the perp.
forge script script/Demo.s.sol:DemoSetup   --rpc-url unichain_sepolia --broadcast   # buy protection + open perp

# Coverage starts coverDelay (10 min) after purchase: wait that long after DemoSetup before the exploit,
# or have the owner call setCoverDelay(0) before DemoSetup for a quick demo. Otherwise the policy is only refunded.

# Loop 2: vault drained on Base -> reactive tx -> trip on Unichain (payouts fixed in that tx)
forge script script/Demo.s.sol:DemoExploit --rpc-url base_sepolia --broadcast
# The breach must hold for SUSTAIN_SECONDS (2s) on Reactive's clock, and it is only re-checked on a new event.
# With cron off (the default), send any later Base event (within WINDOW_SECONDS) to trip:
SWAP_IN=1000000000000000000 forge script script/Demo.s.sol:DemoSwap --rpc-url base_sepolia --broadcast

# Collect the payout for policy 0
cast send $MARKET "claim(uint256)" 0 --rpc-url unichain_sepolia --private-key $PRIVATE_KEY
```

## Deployed addresses & transaction hashes

Current deployment: 2026-11-20 from `0xD04927546678d4255bA0D4c6C2E4D7289baa4B5D`, with every safeguard above (cover waiting period, claim-based payouts, trip confirmation, time-weighted mark, liveness guard, utilization pricing, delayed withdrawals). RiftReactive runs the Cron1000 heartbeat.

| | Address |
|---|---|
| RiftPool (Base Sepolia) | [`0xA5aB34c37F2d8C8f86a32BA007F6e421D0B5315D`](https://sepolia.basescan.org/address/0xA5aB34c37F2d8C8f86a32BA007F6e421D0B5315D) |
| MockVault (Base Sepolia) | [`0xCC83d90035bea5b69d3358479F046781146353e3`](https://sepolia.basescan.org/address/0xCC83d90035bea5b69d3358479F046781146353e3) |
| Vault asset / tQUOTE (Base Sepolia) | [`0x540bd620182C67b3A83375259EA11a1037DC7F58`](https://sepolia.basescan.org/address/0x540bd620182C67b3A83375259EA11a1037DC7F58) |
| RiftPool (Unichain Sepolia) | [`0x3bE5C66453dB2b55412Bf96b4F2df46F34e239ce`](https://sepolia.uniscan.xyz/address/0x3bE5C66453dB2b55412Bf96b4F2df46F34e239ce) |
| RiftMarket (Unichain Sepolia) | [`0x45c96DC6c9f5C5A8CFe0Ac8B88DCD7F49b16Bcb0`](https://sepolia.uniscan.xyz/address/0x45c96DC6c9f5C5A8CFe0Ac8B88DCD7F49b16Bcb0) |
| Market collateral / tUSD (Unichain Sepolia) | [`0x7595790414E2C73ADAF3fcC70d8F07055fDDBeAA`](https://sepolia.uniscan.xyz/address/0x7595790414E2C73ADAF3fcC70d8F07055fDDBeAA) |
| RiftReactive (Lasna) | [`0xAD0983eBF145C8f8184bf219E795aC63fEE58B78`](https://lasna.reactscan.net/address/0xAD0983eBF145C8f8184bf219E795aC63fEE58B78) |

| Loop | Origin tx | Reactive tx | Callback tx | Latency |
|---|---|---|---|---|
| updateMark | [`0xc2b7e42a…`](https://sepolia.basescan.org/tx/0xc2b7e42a455f552976787d6db6f694bbdede8344b2d15101161b166954686211) | [`0xb98be7f1…`](https://lasna.reactscan.net/tx/0xb98be7f1893c3098ea95dc76384f7ce8d776e1dc11848a604e0f865bca68ecea) | [`0x60f12571…`](https://sepolia.uniscan.xyz/tx/0x60f12571f05d83fa4831517c27fecb121e38ecb6c4c976c2dc0b96402aff77ea) | ~3 s |
| trip | [`0x443b4c59…`](https://sepolia.basescan.org/tx/0x443b4c59ce762b180c7828dc5fc77011d61c07cb4b20202bf597006c32f2dcf6) | [`0xe46d223e…`](https://lasna.reactscan.net/tx/0xe46d223e4e394afa5f28797659bb2db8f2d6c42f0ea1b5c41289cb572b8316ed) | [`0x12babcb0…`](https://sepolia.uniscan.xyz/tx/0x12babcb0e4c12e8d297f0ba01dca2659c261780779281c1b24c11accaec5a9c4) | ~2 s |

Latency is the Unichain callback block's timestamp minus the Base origin block's timestamp. Clocks on the three chains differ by about a second.

What the run showed (2026-11-20):

- **updateMark:** a 20 tBASE swap on Base moved the spread to +403 bps, and the market's mark updated to +403 about 3 s later.
- **Cover priced under stress:** policy 0 (10,000 tUSD, 1 day) cost 19.19 tUSD: the 10.63 utilization price times a 1.81x stress multiplier, because the spread was already at +403 bps.
- **trip:** after the 10-minute cover waiting period, [`DemoExploit`](https://sepolia.basescan.org/tx/0xeee9710ad6f0281a559fd02c266f013522169c22d32f687e79a71473dd158bba) drained 30% of the vault and dumped the loot into the Base pool, pushing the spread to −7,446 bps. RiftReactive recorded the breach, and the follow-up swap tripped it after the 2 s sustain period. The trip callback settled policy 0 at its full 10,000 tUSD (payout ratio 100%) with no transfers inside the callback, and froze the perp at −7,436 bps.
- **Confirmation:** RiftReactive saw the market's `Tripped` event and set `tripConfirmed`. It sent the trip once, with no retries needed.
- **Claim:** [`claim(0)`](https://sepolia.uniscan.xyz/tx/0xe2190ea1ed408063a07b6b94e2cda6ec4e58ffcca9d02e4a2d109575ce545b41) paid the buyer 10,000 tUSD.

The fork test in `test/fork/` replays this trip callback and the claim against Unichain Sepolia state.

An earlier deployment, before the safeguards, is still on-chain (market `0xC8AD79Ea2E567Af771F4c7590a4de1783F6428b5`, RiftReactive `0x7C8b13329EDcbFbD8405833F198024ca7E3b4276`) but no longer used.

## Frontend

`frontend/` is a Next.js app that reads the live deployment straight from Base Sepolia, Unichain Sepolia and Lasna, with no backend. `/` is the site; `/app` is the dashboard and trading, in the same visual language (light and dark). The dashboard needs no wallet. It shows:

- a risk band (green/amber/red) computed by fixed rules from on-chain numbers: distance to trip, pool utilization, open perp exposure, premium stress, mark freshness, RiftReactive's lREACT runway and callback funding;
- pool prices, the raw and smoothed spread, and the perp mark over time, including the trip;
- both trip conditions against their thresholds, the underwriting pool, live premium quotes, policies, and callback latency.

**Trading** (wallet on Unichain Sepolia, via any injected wallet such as MetaMask):

- **Protection:** live premium quote, buy cover, see when your cover starts, and claim payouts or refunds.
- **Underwrite:** deposit, then request, cancel or complete a withdrawal after the delay. Shares are priced at the pool's value.
- **Spread perp:** long or short at 1–10×, with live PnL, funding and equity, and a close button.
- A faucet for test tUSD.
- Every action is simulated before you sign, so a revert shows a plain reason ("market has tripped", "mark is stale", "not enough tUSD") instead of failing on-chain. Gas is estimated with a 25% buffer, because funding accrues every second and an exact estimate can run out by the time the transaction is mined.

```bash
cd frontend
pnpm install
pnpm dev            # http://localhost:3000
pnpm e2e            # end-to-end trading test on a local anvil fork (needs foundry + google-chrome)
```

`pnpm e2e` forks Unichain Sepolia with anvil. On the fork only, it resets the demo and delivers a fresh mark, then builds the app with a test-only wallet connector (anvil's unlocked account) and drives the faucet, buying cover, a deliberate revert, deposit and withdraw, and opening and closing a position in headless Chrome. Nothing touches the real testnet, and the test connector only exists in builds made with `NEXT_PUBLIC_E2E=1`.

Contract addresses live in `frontend/lib/config.ts`. After changing contracts, run `forge build` and then `pnpm abis` to regenerate the ABIs. The public Unichain RPC rate-limits, so for a shared demo set `NEXT_PUBLIC_UNICHAIN_SEPOLIA_RPC` (also `NEXT_PUBLIC_BASE_SEPOLIA_RPC`, `NEXT_PUBLIC_LASNA_RPC`) to a keyed endpoint.

## Tests and verification

```bash
forge test -vv
```

- **Unit tests** (`test/Rift.t.sol`): the full loop in one EVM. Fake origin logs go into `react()`, the recorded callbacks are replayed through a fake proxy, and the test checks the payouts. Also covered: throttling, window expiry, each trip condition failing on its own, funding math, callback auth, the cover waiting period, claims (including a buyer that can't receive tokens), trip retry until confirmed, out-of-order marks, the time-weighted mark, the thin-pool guard, the liveness guard, share pricing with open perp PnL, delayed withdrawals, the liquidation reward, stable policy ids, and premium pricing (curve values, rising cost as the pool fills, stress loading, parameter bounds, and a fuzz test that splitting an order is never cheaper).
- **Invariant fuzzing** (`test/invariant/`): random sequences of deposits, withdrawal requests, completions and cancellations, cover purchases, positions, liquidations, marks, trips, claims and time jumps (256 runs × 500 calls). Checked after every call:
  - the market's collateral covers `poolAssets + totalMargin + totalOwed`;
  - a trip never commits more than the pool held;
  - shares are conserved, counting those locked in withdrawal requests;
  - pool value never exceeds cash plus trader margin;
  - the O(1) PnL total matches the sum of per-position equity, within rounding;
  - the payout ratio stays ≤ 100%.
- **Fork replay** (`test/fork/ReplayTrip.t.sol`): forks Unichain Sepolia just before the recorded trip callback below and replays that exact transaction with `vm.transact`, checking the trip and the 10,000 tUSD payout. Runs when `UNICHAIN_SEPOLIA_RPC` is set, and is skipped otherwise.
- **Slither** (`slither.config.json`): 0 findings on `src/`. Three detectors are excluded on purpose: `timestamp` (all timing is timestamp-based by design), `incorrect-equality` (only zero checks), and `reentrancy-events` (the only external call before those events is to Reactive's system contract).
- **CI** (`.github/workflows/ci.yml`): formatting, build, all tests and Slither on every push and pull request. Add an `UNICHAIN_SEPOLIA_RPC` repository secret to run the fork test there too.

## Known limits (hackathon scope)

- Max 64 live policies so `trip()` can settle everyone in one callback (about 1.6M gas at 64).
- `poolValue()` nets all open positions together without the zero floor on each trader's equity, so a position far below zero counts as a pool gain beyond its margin until someone liquidates it. The liquidation reward is there to keep that rare.
- The pool is the perp counterparty. Funding is linear in the spread and there is no leverage beyond 10x.
- `resetDemo()` exists on both contracts only so the demo can be replayed.

## License

MIT
