# Rift: design spec and screen map

Status: **draft for approval** (process steps 1–3). Nothing in this document has been built yet.
Where the brief and the contracts disagree, the contracts win; every conflict is listed in §1.6.

**Scope (decided):** this restyles the **app** (`/app` and its flows). The marketing landing page at `/`
stays as it is, headline ("Trade the gap.") included. Wallet connection uses **RainbowKit**.

**Visual direction (decided, supersedes §2.1–2.2 and the amber/serif notes below):** the app uses the
marketing site's language so the two feel continuous: the "RIFT/" wordmark; Archivo Expanded Black display,
Inter body and JetBrains Mono figures; the ink/bone palette with the red fault-line accent and cold blue; the
site's background plane (glows, grid, grain); hard-edged hairline frames with red corner ticks; numbered mono
section labels; the red live ticker; cream hard-shadow buttons. Tokens live in `app/landing.css` and the app's
component token names are mapped onto them inside `.landing`. The three-plane structure, states, screen map and
contract notes in this document still apply.

**RainbowKit blocker:** RainbowKit 2.2.11 (latest) supports wagmi ^2 only; the app is on wagmi 3.7.11.
Options: downgrade to wagmi 2.x, wait for a wagmi-3 RainbowKit release, or keep the themed injected picker.

---

## 1. What the contracts actually do

Source: `src/`, compiled ABIs in `out/`, deployment in the README.

### 1.1 Chains and contracts

| Chain | Role | Contracts |
|---|---|---|
| **Base Sepolia** (84532) | Origin | `RiftPool` (twin pool #1, emits `Sync`), `MockVault` (the protected vault), vault asset `tQUOTE` |
| **Unichain Sepolia** (1301) | Origin + destination | `RiftPool` (twin pool #2), **`RiftMarket`** (cover, perp, underwriting, callbacks), collateral `tUSD`. **Users only ever sign here.** |
| **Reactive Lasna** (5318007) | Reactive | `RiftReactive`: subscribes to `Sync` on both pools, vault-asset `Transfer` into/out of the vault, the market's own `Tripped` (trip confirmation), and Cron1000 (heartbeat) |

There is **one vault**, **one pool pair**, **one market** and **one collateral token** per deployment.

### 1.2 User actions (all on `RiftMarket`, Unichain)

| Action | Function | Notes |
|---|---|---|
| Get test funds | `tUSD.faucet()` | 10,000 tUSD per call |
| Approve | `tUSD.approve(market, amount)` | Needed before buy, deposit, open |
| Buy cover | `buyProtection(notional, duration) → id` | 60 s ≤ duration ≤ 30 d. Cover starts `coverDelay` (10 min) later. Max 64 live policies. Needs a mark < `maxMarkAge` (1 h) old and an untripped market. |
| Claim | `claim(id)` | Anyone can call; tokens always go to the buyer. Pays a payout (covered) or a premium refund (bought too late). |
| Deposit (underwrite) | `deposit(assets)` | Shares priced at `poolValue()` (cash − traders' unrealized PnL). Closed when tripped. |
| Withdraw | `requestWithdraw(shares)` → wait `WITHDRAW_DELAY` (1 h) → `completeWithdraw()`; or `cancelWithdraw()` | Locked shares stay at risk; paid at pool value at completion. |
| Open perp | `openPosition(isLong, size, margin)` | size ≤ 10 × margin; size ≤ pool cash; fresh mark; untripped. One position per wallet. |
| Close perp | `closePosition()` | Always allowed (also after a trip: settles at the trip mark). |
| Liquidate | `liquidate(trader)` | When equity < 5 % of size; caller earns up to 1 % of size. |

Not available: cancel or top up cover, add/remove margin, partial close, multiple positions, choosing a vault or market.

### 1.3 Events the UI can use

- **RiftMarket (Unichain):** `ProtectionBought`, `PolicySettled(id, buyer, owed, covered)`, `Claimed`, `Tripped(mark, outflowBps, observedAt, receivedAt, originChainId, originTxHash, payoutRatioBps)`, `MarkUpdated(mark, observedAt, receivedAt, originChainId, originTxHash)`, `StaleMarkIgnored`, `PositionOpened`, `PositionClosed(pnl, funding, payout, liquidated)`, `Liquidated`, `Deposited`, `WithdrawRequested`, `WithdrawCancelled`, `Withdrawn`.
- **RiftReactive (Lasna):** `PriceMirrored`, `ThinPoolIgnored`, `VaultFlow`, `BreachStarted`, `BreachCleared`, `MarkSent`, `TripSent`, `TripConfirmed`.
- **Origin:** `Sync`, `Swap` (pools); `Transfer` (vault asset); `ExploitSimulated` (vault, owner-only).

`MarkUpdated` and `Tripped` carry the origin chain and origin tx hash, so every callback can be linked back to its cause.

### 1.4 The trigger (exact)

A trip fires when **both** hold, timed on Reactive's clock:

1. |raw spread| ≥ `tripSpreadBps` (**5 %**) and has stayed there ≥ `sustainSeconds` (**2 s**), **and**
2. vault outflow inside `windowSeconds` (**5 min**) ≥ `tripOutflowBps` (**15 %**) of the vault's balance at the window start.

It's re-checked whenever RiftReactive reacts (a swap, a vault transfer, the heartbeat). On a trip, the market in one callback:
- settles each live policy: covered if `activeAt ≤ observedAt` → payout = notional (pro-rata if the pool is short); otherwise → premium refund;
- freezes the perp at the trip mark (raw spread).
Until the market's `Tripped` event comes back, RiftReactive re-sends the trip at most every 30 s.

**Plain-language trigger copy:** "Pays out if the vault loses at least 15 % in 5 minutes *while* its pool's price breaks at least 5 % from the twin pool for 2 seconds."

### 1.5 Numbers the UI shows, and where they come from

| Number | Source |
|---|---|
| Premium quote | `quotePremium(notional, duration)`: kinked utilization curve (0.10 %/day idle → 0.20 % at 80 % → 2.20 % at 100 %) × stress (1 + |mark|/5 %, max 3×) |
| Spread / mark | raw `spreadBps()` (Lasna), smoothed `smoothedSpreadBps()` (Lasna, 30 s time-weighted), delivered `markBps` (Unichain) |
| Funding | longs pay while mark > 0: `size × mark × Δt / (10,000 × 1 day)`; rate per day = mark in bps of size |
| PnL / equity | `equityOf(trader)` → (equity, pnl, funding) |
| Liquidation price | Not stored. Client-side: long liquidates at mark ≤ entry − (margin − funding owed − 5 % × size) × 10,000 / size (mirror for shorts) |
| Pool value / share price | `poolValue()`, `totalShares` |
| Callback latency | `receivedAt − observedAt` from `MarkUpdated`/`Tripped` (1-second resolution) |
| Liveness | `markReceivedAt` vs `maxMarkAge`; RiftReactive lREACT balance |

### 1.6 Conflicts between the brief and the contracts

| # | Brief says | Contracts do | Proposed resolution |
|---|---|---|---|
| C1 | Choose a protocol/vault from searchable tiles (TVL, risk tier, premium rate) | One vault per deployment; no registry, no risk tier | One real "watched vault" tile. In demo mode only, extra tiles clearly labelled **Simulated**. A multi-vault registry would be a contract change. |
| C2 | "Pays out automatically, no claims process" | The trip **fixes** every payout automatically in ~2 s; tokens move when anyone calls `claim(id)` | Copy: "Payout locked in 2 s. One tap to collect." The drain screen auto-offers the claim. A batch auto-claim (or a keeper) would be a small contract/infra addition. |
| C3 | Trigger "TVL falls X % within Y blocks" | Two conditions, time-based on Reactive's clock (§1.4) | Use the real copy in §1.4. |
| C4 | Cancel or top up an active cover | Not supported | Remove. Show "buy another cover" instead. |
| C5 | Pick a perp market (asset + chain pair, e.g. ETH A vs B) | One market: tBASE/tQUOTE pool on Base vs Unichain | Single market header (no picker); a picker can come with more deployments. |
| C6 | Liquidation price, funding, **fees**, **add margin** | No trading fees; no add-margin; no liquidation-price view | Show funding and computed liquidation price; no fee row; no add-margin. |
| C7 | Close → settlement with cross-chain wait | Close settles instantly on Unichain | No cross-chain wait on close. The cross-chain state shown is **mark age** (how fresh the price is), plus trip status. |
| C8 | LP APY, payout-impact history | No on-chain APY | Derive from share-price history and `PolicySettled`/`Tripped` events; label as trailing/derived. |
| C9 | RainbowKit/ConnectKit picker | wagmi with injected wallets today | RainbowKit needs a WalletConnect (Reown) project ID; **your call** (§4). |
| C10 | Millisecond timer from detection to payout | Chain timestamps have 1 s resolution; recorded hops take ~2–3 s | Show whole/decimal seconds from block timestamps as the record; a ms-ticking timer only as live client-observed time in-session or in demo replay, and labelled that way. |
| C11 | Scripted drain for judges | `MockVault.simulateExploit` is owner-only | Demo mode simulates in the browser and replays the recorded testnet trip (real hashes). Live drains stay an operator action. |
| C12 | Activity history across both products | Needs event scans; Unichain's RPC limits `eth_getLogs` to 1,000 blocks | The current client-side scan already hits the public RPC's rate limit on a first visit (≈70 chunks and growing ~86/day; retries recover). Restyle: load recent history first and older on demand, and add a small indexer (or a keyed RPC) before a public demo. |
| C13 | "Trade the spread of ETH on two chains" framing | Spread is between two pools of test tokens (bps) | Copy says "the same pool on two chains"; numbers in bps/%. |

Also affected: the dashboard and trade panel built so far use a plain system-font look; this spec restyles them. The landing page (red/Archivo brutalist) is out of scope and stays. The data layer (`lib/reads`, `lib/account`, `lib/tx`, `lib/errors`, `lib/wagmi`) is kept and moved behind `lib/rift/`.

---

## 2. Design spec

### 2.1 Typography

| Role | Face | Why |
|---|---|---|
| Display | **Instrument Serif** (regular + italic) | A condensed, high-contrast editorial serif reads as calm and precise, and sets Rift apart from every sans-heavy crypto UI. |
| UI / body | **Geist** | Neutral, crisp at 14–18 px, pairs with its mono sibling. |
| Mono | **Geist Mono**, tabular figures | Every number, address, hash, block and timer. |

Scale (fluid): display-xl `clamp(4rem, 11vw, 11rem)` / 0.9 / −0.03em · display-l `clamp(3rem, 7vw, 7rem)` / 0.95 · display-m `clamp(2.25rem, 4vw, 3.75rem)` / 1.0 · title 1.5rem / 1.2 · body 1rem–1.125rem / 1.6, max 65ch · small 0.875rem · micro-label (mono, 0.6875rem, +0.18em, uppercase). Fallback stacks: serif display → `"Iowan Old Style", Georgia, serif`; sans → `system-ui, …`; mono → `ui-monospace, …`.

### 2.2 Palette tokens (contrast measured, WCAG AA)

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `--bg` | `#0E0F11` graphite | `#F3F0E8` | page |
| `--surface` | `#16181B` | `#FBF9F4` | mid-ground cards |
| `--raised` | `#1E2024` | `#ECE8DE` | inputs, nested panels |
| `--text` | `#EDE8DE` (15.7:1) | `#15161A` (15.9:1) | primary type |
| `--muted` | `#9A958A` (6.4:1; 5.5:1 on raised) | `#5E5A52` (6.0:1) | secondary |
| `--hairline` | `rgba(237,232,222,.10)` | `rgba(21,22,26,.10)` | borders |
| `--fault` (amber) | `#FF9A1F` (9.0:1 on bg) | `#9E4705` for text (5.5:1); `#FF9A1F` decorative only | the seam, the one accent, primary CTA fill (graphite text on it: 9.0:1) |
| `--chain-b` (cool) | `#7FA8FF` (8.2:1) | `#2F5BD3` (5.2:1) | the second chain (Base) |
| `--ok` | `#3DD68C` (10.2:1) | `#157A4A` (4.7:1) | success signals only |
| `--danger` | `#FF5D5D` (6.4:1) | `#C2302A` (4.9:1) | danger signals only |

Chain identity is fixed everywhere: **Unichain = graphite/off-white plane**, **Base = cool plane**, **Reactive = the amber seam between them**.

### 2.3 Plane tokens

| Token | `--plane-bg` | `--plane-mid` | `--plane-fg` |
|---|---|---|---|
| z-index | 0 | 10 | 20 (sheets/toasts 40+) |
| scale | 1.04 | 0.985 | 1 |
| opacity | 0.55 | 1 | 1 |
| blur / saturation | 1 px / 0.6 | 0 / 1 | 0 / 1 |
| shadow | none | hairline + 3 stacked: `0 1px 0 var(--hairline)`, `0 8px 24px -12px rgb(0 0 0/.30)`, `0 32px 64px -32px rgb(0 0 0/.40)`, `0 72px 120px -56px rgb(0 0 0/.35)` | none (CTAs get a 1 px inset highlight) |
| parallax (scroll) | 0.88× | 1.0× | 1.06× |
| hover | n/a | lift: scale 0.985 → 1, shadow deepens (moves toward fg) | press: translateY(1px) |

`<Plane depth="fg|mid|bg">` applies these. Every element on every screen lives in exactly one.

### 2.4 Space, shape, grid

4 px base: 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 · 128 · 192. Radius: 2 px (architectural), sheets 12 px top only. 12-column asymmetric grid on desktop (content usually 5 + 7), 6 on tablet, 4 on mobile; 24/32/48 px gutters.

### 2.5 Motion

| Rule | Value |
|---|---|
| Durations | 120 (press) · 200 (hover/fade) · 320 (enter) · 560 (plane shifts) · 900 (seam pulse) |
| Easing | settle `cubic-bezier(.2,0,0,1)`; emphasis `cubic-bezier(.3,0,0,1)`; never bounce |
| Page exit | fg out 160 ms → mid shifts 220 ms → bg drifts 320 ms |
| Page enter | assembles bg → mid → fg, 60 ms stagger |
| Live numbers | digit roll ≤ 320 ms; never animate a value the user is about to sign |
| Reduced motion | no parallax/transform motion; depth kept via shadow, scale and opacity; state changes cross-fade only |

### 2.6 The rift motif

- **Seam:** a 1 px amber line with a soft glow, splitting each hero composition (≈8° on desktop, horizontal on mobile). Left of it, the Base plane (cool perspective grid); right of it, the Unichain plane (graphite grid). Reactive is the seam itself.
- **Seismograph:** a thin trace of the live spread running along the seam, with amplitude tied to |raw spread| / 5 %.
- **The seam reacts to real events** (or to the demo script):
  - **calm:** a slow 6 s breathing glow;
  - **`MarkUpdated`:** one pulse travelling along the seam;
  - **`BreachStarted`:** an amber tremor (3 × 60 ms, ±2 px), the seam widens 2 px, the trace's amplitude rises;
  - **`Tripped`:** a crack: the seam opens, the planes separate by 12 px, a red flash settles back to amber.
- **Block counters and timers:** Geist Mono, tabular figures, a micro-label above each.

---

## 3. Screen map

Each screen: **F** = focal moment, then what lives on each plane (fg / mid / bg). All screens share `RiftBackground` (bg) and the top bar (fg).

### 3.1 Landing `/`: out of scope
The existing marketing page stays, headline included. Its "Launch app" buttons lead into the restyled app.

### 3.2 Connect (sheet over any screen)
- **F:** "Connect to sign on Unichain Sepolia."
- fg: wallet list, plain-language note ("Connecting lets Rift read your balances and ask you to sign. Nothing moves without your approval in your wallet."). mid: sheet. bg: dimmed page.
- States: no wallet detected (install links) · connecting · user rejected · unsupported network (one-click switch / add Unichain Sepolia) · connected.

### 3.3 Onboarding `/start` (3 steps, skippable later)
1. **Choose a path:** Protect / Trade / Underwrite. **F:** the three doors.
2. **How Reactive watches:** **F:** the three-chain diagram, with the seam animating the real trigger (§1.4).
3. **Risk acknowledgement:** **F:** four short, numbered statements, acknowledged one at a time (testnet only; payouts need both conditions; cover starts after 10 min; perp can be liquidated). Not a wall of text.
- States: first visit · returning (skip) · reduced motion.

### 3.4 Dashboard `/app`
- **F:** the user's total exposure in one large figure.
- fg: exposure, primary actions. mid: active covers, open position, LP balance, a **Watch** panel (per chain: listener status, last event, latest block; mark age; RiftReactive lREACT runway; trip state). bg: the seam in calm/pulse/tremor state.
- States: not connected (market-only view) · first-time empty (three designed empty cards that become the doors) · populated · market tripped (claims banner) · liveness stale (new risk paused).

### 3.5 Protect flow `/protect`
1. **Vault:** **F:** the watched vault tile (TVL, trigger, rate). Demo: extra Simulated tiles (C1).
2. **Amount + duration:** **F:** the live premium. fg: amount/duration inputs, quote, stress multiplier, utilization effect. mid: a "your cover starts at hh:mm" timeline.
3. **Review:** **F:** the trigger sentence from §1.4. Payout = notional; pro-rata note; refund-if-early note.
4. **Sign:** `TxFlow` approve → buy (two-step progress).
- States: loading quote · no capacity · stale mark (paused) · tripped (closed) · insufficient tUSD (faucet) · each TxFlow state.
- **Active cover `/protect/[id]`:** **F:** a calm seismograph with "time remaining"; details; "starts in…" countdown during the cover delay; expired; settled → claim.

### 3.6 Drain event: the hero moment `/drain` (opens itself when `Tripped` lands; replayable)
- **F:** a single huge timer, then the payout amount filling the screen.
- Sequence: seam cracks → hop cards appear one by one, crossing the seam: **Origin** (Base: drain + dump tx) → **Reactive** (Lasna: trip tx) → **Settlement** (Unichain: trip callback) → **Claim** (your tx). Each card has a chain, block, timestamp and explorer link.
- Terminal: payout amount (display-xl), receipt card (policy, notional, ratio, hashes), elapsed seconds (origin block → callback block), share.
- States: live (watching) · detected (breach started) · tripped (awaiting confirmation) · settled (payout fixed, claim) · claimed · refund (bought too late) · not covered (no policy) · replay (demo).

### 3.7 Trade the spread `/trade`
- **F:** the large live spread chart (edge-cropped), with both pool prices beside it.
- fg: long/short, size, leverage, margin, liquidation price, funding/day; CTA. mid: chart, market stats (mark age, OI long/short, pool cash). bg: seam and planes.
- Review → `TxFlow` (approve → open). No cross-chain wait (C7); shows the mark it will open at and its age.
- **Position `/trade/position`:** **F:** live PnL. Chart with entry and liquidation lines; margin-health meter; close.
- **Warning:** health < 2× maintenance (amber, plain explanation). **Liquidated:** calm terminal card, with what happened, the numbers and the tx.
- **Close → receipt:** realised PnL, funding, duration, payout, tx links, share.
- States: no position · stale mark · tripped (frozen, close at trip mark) · each TxFlow state.

### 3.8 Underwrite `/underwrite`
- **F:** your share value.
- fg: deposit / request / complete / cancel. mid: pool value vs cash, utilization, open perp PnL, derived APY (trailing, labelled), payout-impact history (`Tripped` + `PolicySettled`). bg: planes.
- States: no shares · deposit closed (tripped) · withdrawal locked (countdown) · ready · insufficient liquidity.

### 3.9 Supporting screens
- **Activity `/activity`:** **F:** the latest event. A filterable list of covers, claims, positions, deposits and withdrawals, each with every cross-chain hop linked. States: scanning (progress) · empty · RPC limited.
- **Cover / position detail:** reuse §3.5 / §3.7.
- **Settings `/settings`:** network, theme, demo mode, RPC endpoints, disconnect.
- **404 / global error:** **F:** "Nothing on this side of the rift." / the error and a retry.

### 3.10 Reusable `TxFlow`
Pre-sign explainer → awaiting wallet → submitted → confirming (block count) → [cross-chain pending, only for actions that wait on Reactive] → confirmed; failed at any step → readable reason (from `lib/errors`) + retry. Announced via `aria-live="polite"`. Mobile: a bottom sheet.

### 3.11 Demo mode (`lib/rift/demo`)
Same interface as the live adapter. Scripted: spread drift; a breach; a drain; a trip with the recorded real hashes; a claim. Always badged **Demo**, and never sends a transaction.

---

## 4. Decisions

Decided: app-only scope · RainbowKit · landing page and headline unchanged.

Still open:
1. **Approve the contract resolutions** C1–C13 (especially C1 single vault, C2 claim step, C10 timer honesty).
2. **Direction after reviewing the current design:** go ahead with this spec for the app, or adjust it.
3. **WalletConnect (Reown) project ID** for RainbowKit. Without one, RainbowKit can still list browser/injected wallets, but WalletConnect-based wallets (mobile, QR) won't work.
4. **New dependencies:** Framer Motion, RainbowKit, Instrument Serif + Geist via `next/font`.
