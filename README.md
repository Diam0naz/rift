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

Deployed 2026-11-20 from `0xD04927546678d4255bA0D4c6C2E4D7289baa4B5D`. The two pools share an address because the deployer used the same nonces on both chains.

| | Address |
|---|---|
| RiftPool (Base Sepolia) | [`0xAD0983eBF145C8f8184bf219E795aC63fEE58B78`](https://sepolia.basescan.org/address/0xAD0983eBF145C8f8184bf219E795aC63fEE58B78) |
| MockVault (Base Sepolia) | [`0x3dE37BbE25Df1CF63b2fB9093A8DDdAd69dDABC5`](https://sepolia.basescan.org/address/0x3dE37BbE25Df1CF63b2fB9093A8DDdAd69dDABC5) |
| Vault asset / tQUOTE (Base Sepolia) | [`0x7C8b13329EDcbFbD8405833F198024ca7E3b4276`](https://sepolia.basescan.org/address/0x7C8b13329EDcbFbD8405833F198024ca7E3b4276) |
| RiftPool (Unichain Sepolia) | [`0xAD0983eBF145C8f8184bf219E795aC63fEE58B78`](https://sepolia.uniscan.xyz/address/0xAD0983eBF145C8f8184bf219E795aC63fEE58B78) |
| RiftMarket (Unichain Sepolia) | [`0xC8AD79Ea2E567Af771F4c7590a4de1783F6428b5`](https://sepolia.uniscan.xyz/address/0xC8AD79Ea2E567Af771F4c7590a4de1783F6428b5) |
| Market collateral / tUSD (Unichain Sepolia) | [`0x459deD748c12aF276B1D73892b921f96A6290C93`](https://sepolia.uniscan.xyz/address/0x459deD748c12aF276B1D73892b921f96A6290C93) |
| RiftReactive (Lasna) | [`0x7C8b13329EDcbFbD8405833F198024ca7E3b4276`](https://lasna.reactscan.net/address/0x7C8b13329EDcbFbD8405833F198024ca7E3b4276) |

| Loop | Origin tx | Reactive tx | Callback tx | Latency |
|---|---|---|---|---|
| updateMark | [`0x3514e617…`](https://sepolia.basescan.org/tx/0x3514e61751d55e70b2e736ad5abf8afa51de4a2b67565907776bcfb47cea7fcd) | [`0x856a34ab…`](https://lasna.reactscan.net/tx/0x856a34ab462d63f8aed11bcade9b9f2c219faec9f08c5a9435c332980d9715cd) | [`0xfd8f961b…`](https://sepolia.uniscan.xyz/tx/0xfd8f961b68165388b26b42613f785415bf360ab7b732e86913f94e21301917c9) | ~2 s |
| trip | [`0x24f36c19…`](https://sepolia.basescan.org/tx/0x24f36c19bf2593744b35c6e4c8e9d2d5e8c814a2c479e2e34ecc665a14b891fd) | [`0x32d61ca9…`](https://lasna.reactscan.net/tx/0x32d61ca9e07c490c6aa6b462fb63806f2cf6a30d1c530282d3f02a306aedb28c) | [`0x892cea84…`](https://sepolia.uniscan.xyz/tx/0x892cea840926429f4a003b9ac69709433824f7c1e8d8be5103df5afad8de769b) | ~3 s |

Latency is the Unichain callback block's timestamp minus the Base origin block's timestamp. Clocks on the three chains differ by about a second.

What the run showed (2026-11-20). This run used the contracts deployed above, which predate the settlement safeguards: payouts went out inside the trip callback, with no waiting period or claim step.

- **updateMark:** a 20 tBASE swap on Base moved the spread to +403 bps, and the market's mark updated to +403 about 2 s later.
- **trip:** [`DemoExploit`](https://sepolia.basescan.org/tx/0xe1f1b9bd672729ab8d39dfd1a86cb4d8db0a6fa92b7abd982e278a7e33545122) drained 30% of the vault and dumped the loot into the Base pool, pushing the spread to −7,446 bps. RiftReactive recorded the breach but didn't trip until the follow-up swap arrived, after the 2 s sustain period. The trip callback paid policy 0 its full 10,000 tUSD notional (payout ratio 100%) in the same transaction and froze the perp at −7,436 bps.

## Tests

```bash
forge test -vv
```

They cover the full loop in one EVM: fake origin logs go into `react()`, the recorded callbacks are replayed through a fake proxy, and the test checks the payouts. Also covered: throttling, window expiry, each trip condition failing on its own, funding math, callback auth, the cover waiting period, claims (including a buyer that can't receive tokens), trip retry until confirmed, and out-of-order marks.

## Known limits (hackathon scope)

- Max 64 live policies so `trip()` can pay everyone in one callback.
- The pool is the perp counterparty. Funding is linear in the spread and there is no leverage beyond 10x.
- `resetDemo()` exists on both contracts only so the demo can be replayed.

## License

MIT
