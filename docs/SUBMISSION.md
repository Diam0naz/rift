# Rift: bridge-failure cover that pays in seconds

**Track:** Every Second Counts · **Live app:** [rift-bice.vercel.app](https://rift-bice.vercel.app) · **Code:** [github.com/Diam0naz/rift](https://github.com/Diam0naz/rift)

![Rift overview](https://raw.githubusercontent.com/Diam0naz/rift/main/docs/images/overview.webp)

## The problem

When a bridge is drained, the tokens it minted on other chains lose their backing and crash, and their holders can't sell their way out. Existing DeFi cover depends on someone judging the claim, which takes days to weeks, long after the damage is done.

We replayed the 2022 Nomad exploit from public chain data to measure this. Nomad-bridged USDC on Moonbeam went from $0.9995 to $0.045 in about a minute. That happened before a single USDC had left the bridge's escrow on Ethereum, and the only exit pool then paid about 2 cents. What holders needed was a payout they could count on, fixed the moment the failure is real, from a pool funded in advance.

## How it works

Rift reads one signal across chains: the **spread** between the same asset's markets on two chains, plus **outflows from a vault**, such as a bridge's escrow.

1. **RiftReactive** (Reactive Network) subscribes to pool `Sync` events on both chains and to the vault's `Transfer` events. It computes the spread and a 5-minute outflow window on every event, plus a cron heartbeat.
2. Every meaningful spread change is sent to **RiftMarket** (Unichain) as a mark via callback. That's what the perp trades on.
3. When **both** conditions hold (|spread| ≥ 5% sustained for 2 s **and** ≥ 15% of the vault gone within 5 minutes), RiftReactive sends `trip`. That one callback fixes every covered payout and freezes the perp. Buyers then `claim()`; nobody judges anything.

A price move alone, or a large withdrawal alone, never pays. Manipulating a thin pool doesn't trip it.

**Proof on real data.** Replaying the Nomad exploit from Ethereum and Moonbeam chain history, Rift's rule trips at 22:46:36 UTC with **$71.2M of the $87.5M USDC escrow still in place**, 65 minutes before it was emptied. The scripts are in [`research/`](https://github.com/Diam0naz/rift/tree/main/research), and anyone can re-run them.

## Key features

- **Protect (drain cover):** buy cover on a watched vault, with an exact quote. The premium prices utilization and stress. Coverage starts after a waiting period, so nobody can buy cover once a drain is already visible. Payouts are fixed in the trip transaction.
- **Trade (spread perp):** long or short the cross-chain spread at up to 10×, with funding every second. Settles on the time-weighted mark; liquidation pays a reward.
- **Underwrite:** deposit into the pool that sells cover and takes the other side of every perp trade. Shares are priced on the pool's real value, withdrawals take two steps with a 1-hour delay, and capital backing live cover is reserved.
- **AI agent (Gemini default, Claude as a paid tier):**
  - **co-pilot:** it reads live state, explains, quotes, and proposes transactions you sign;
  - **autopilot:** it acts from your **RiftAgentVault**, where the contract enforces your limits (daily spend, size, leverage, allowed actions, and a fee cap for paying the agent);
  - **background rules:** stop-loss, take-profit, liquidation guard, auto-claim, auto-hedge, and plain-language goals.
- **Scanner:** paste any two pools (Uniswap v2, Uniswap v3 or RiftPool) on Base, Unichain or Ethereum Sepolia to see their live prices and the gap between them. It only reads prices, and it shows which pair could become the next market.
- **Monitor and History:** the whole path from Base origin to Lasna reaction to Unichain settlement, with timings, from an indexer that follows all three chains.

## Why Reactive Omni

The signal lives on two chains, and the vault lives on one of them. No single contract can see both, and polling would be both slower and trusted. RiftReactive is the only thing that connects them, and it settles in seconds. Measured on testnet: **swap on Base → mark on Unichain in ~3 s; vault drain → every payout fixed in ~2 s.**

## Tech stack

- **Contracts:**
  - Solidity 0.8.30 with Foundry and OpenZeppelin;
  - Reactive Network Omni: system contract subscriptions, `react()`, callback proxy, Cron1000 heartbeat.
- **Chains:** Base Sepolia (origin: pool and vault), Reactive Lasna (RiftReactive), Unichain Sepolia (RiftMarket, agent vaults).
- **App:**
  - Next.js 16, React 19, Tailwind 4;
  - viem, wagmi 2 and RainbowKit for wallets;
  - TanStack Query for data.
- **Agent:** Google Gemini (`@google/genai`) and Anthropic Claude (`@anthropic-ai/sdk`), with a tool loop over live chain state.
- **Data:** an indexer for all three chains, running on Node with Neon Postgres and hosted on Render.
- **Hosting:** Vercel. The autopilot runs on a GitHub Actions schedule.
- **Quality:** 62 tests, including invariant fuzzing and a fork replay of the real testnet trip. Slither reports no findings. A 16-step browser test drives every screen on a fork.

## Hackathon requirements

**Deployed contracts**

| Contract | Chain | Address |
|---|---|---|
| RiftReactive | Reactive Lasna | [`0xAD0983eBF145C8f8184bf219E795aC63fEE58B78`](https://lasna.reactscan.net/address/0xAD0983eBF145C8f8184bf219E795aC63fEE58B78) |
| RiftMarket | Unichain Sepolia | [`0x45c96DC6c9f5C5A8CFe0Ac8B88DCD7F49b16Bcb0`](https://sepolia.uniscan.xyz/address/0x45c96DC6c9f5C5A8CFe0Ac8B88DCD7F49b16Bcb0) |
| RiftAgentVaultFactory | Unichain Sepolia | [`0x390232484C2873945a1Dc1425370Ef3080495b8B`](https://sepolia.uniscan.xyz/address/0x390232484C2873945a1Dc1425370Ef3080495b8B) |
| RiftPool | Unichain Sepolia | [`0x3bE5C66453dB2b55412Bf96b4F2df46F34e239ce`](https://sepolia.uniscan.xyz/address/0x3bE5C66453dB2b55412Bf96b4F2df46F34e239ce) |
| RiftPool | Base Sepolia | [`0xA5aB34c37F2d8C8f86a32BA007F6e421D0B5315D`](https://sepolia.basescan.org/address/0xA5aB34c37F2d8C8f86a32BA007F6e421D0B5315D) |
| MockVault (watched vault) | Base Sepolia | [`0xCC83d90035bea5b69d3358479F046781146353e3`](https://sepolia.basescan.org/address/0xCC83d90035bea5b69d3358479F046781146353e3) |

**The full Reactive loop, on testnet**

| Loop | Origin (Base) | Reaction (Lasna) | Callback (Unichain) | Latency |
|---|---|---|---|---|
| Mark update | [`0xc2b7e42a…`](https://sepolia.basescan.org/tx/0xc2b7e42a455f552976787d6db6f694bbdede8344b2d15101161b166954686211) | [`0xb98be7f1…`](https://lasna.reactscan.net/tx/0xb98be7f1893c3098ea95dc76384f7ce8d776e1dc11848a604e0f865bca68ecea) | [`0x60f12571…`](https://sepolia.uniscan.xyz/tx/0x60f12571f05d83fa4831517c27fecb121e38ecb6c4c976c2dc0b96402aff77ea) | ~3 s |
| Drain → trip | [`0x443b4c59…`](https://sepolia.basescan.org/tx/0x443b4c59ce762b180c7828dc5fc77011d61c07cb4b20202bf597006c32f2dcf6) | [`0xe46d223e…`](https://lasna.reactscan.net/tx/0xe46d223e4e394afa5f28797659bb2db8f2d6c42f0ea1b5c41289cb572b8316ed) | [`0x12babcb0…`](https://sepolia.uniscan.xyz/tx/0x12babcb0e4c12e8d297f0ba01dca2659c261780779281c1b24c11accaec5a9c4) | ~2 s |

The trip settled a 10,000 tUSD policy at 100%, and it was claimed in [`0xe2190ea1…`](https://sepolia.uniscan.xyz/tx/0xe2190ea1ed408063a07b6b94e2cda6ec4e58ffcca9d02e4a2d109575ce545b41).

**Demo video:** _add your link here_

**Scope, honestly:** this is a testnet demo with mock twin pools and a mock vault. The design targets bridge escrows and bridged assets, where the spread *is* the holders' loss. The README's "Strengths and scope" section marks each limit as inherent or current, with what improves it.
