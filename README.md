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
| Jump | Drain Default Swap: pay a premium, receive `notional` if the vault is drained | the `trip` callback, paid in the same tx |

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
# Loop 1: swap on Base -> reactive tx on Lasna -> updateMark on Unichain
forge script script/Demo.s.sol:DemoSetup   --rpc-url unichain_sepolia --broadcast   # buy protection + open perp
forge script script/Demo.s.sol:DemoSwap    --rpc-url base_sepolia --broadcast

# Loop 2: vault drained on Base -> reactive tx -> trip on Unichain (policies paid in the same tx)
forge script script/Demo.s.sol:DemoExploit --rpc-url base_sepolia --broadcast
```

## Deployed addresses & transaction hashes

_To be filled in after deployment._

| | Address |
|---|---|
| RiftPool (Base) | |
| MockVault (Base) | |
| RiftPool (Unichain) | |
| RiftMarket (Unichain) | |
| RiftReactive (Lasna) | |

| Loop | Origin tx | Reactive tx | Callback tx | Latency |
|---|---|---|---|---|
| updateMark | | | | |
| trip | | | | |

## Tests

```bash
forge test -vv
```

They cover the full loop in one EVM: fake origin logs go into `react()`, the recorded callbacks are replayed through a fake proxy, and the test checks the payouts. Also covered: throttling, window expiry, each trip condition failing on its own, funding math, and callback auth.

## Known limits (hackathon scope)

- Max 64 live policies so `trip()` can pay everyone in one callback.
- The pool is the perp counterparty. Funding is linear in the spread and there is no leverage beyond 10x.
- `resetDemo()` exists on both contracts only so the demo can be replayed.

## License

MIT
