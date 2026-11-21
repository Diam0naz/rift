# Testing the app

Three layers. The first two are scripted and touch nothing real; the third is you, with a real wallet, on testnet.

## 1. Every screen, end to end, on a fork (`pnpm e2e`)

```bash
cd frontend
pnpm e2e
```

`e2e/run.sh` forks Unichain Sepolia with anvil, makes the market accept new risk on the fork (resets it if
tripped, delivers a fresh mark), starts the indexer against the fork, builds the app with a mock "Test wallet"
(anvil's unlocked account #0) and drives headless Chrome through:

| Step | Screen | Checks |
| --- | --- | --- |
| 0 | Overview | Live state loads (risk band) |
| 1 | Header / Overview | Connect the test wallet, faucet, Add tUSD to wallet |
| 2 | Protect | Approve + buy 1,000 cover (two-step flow), policy shows "Starts in" |
| 3 | Protect | A 5,000,000 order fails **before signing**, with a readable reason |
| 4 | Underwrite | Deposit, request 50% withdrawal, cancel it |
| 5 | Trade | Open a 5× long, see the position card, close it |
| 6 | Activity | This run's cover, deposit, withdrawal and trades are listed |
| 7 | History | Indexer shows "live"; the run's events are in the event log |
| 8 | Monitor | The three-chain watch and drain sequence render |

It prints a ✓ per step, saves screenshots, and fails on any browser console error. Ports 8545, 3001 and
42070 must be free. Afterwards rebuild normally (`pnpm build`): the E2E build is test-only.

The payout path (a real drain tripping the market) isn't in this run: it needs Base and Lasna, so it's
exercised on testnet by the demo script (`script/Demo.s.sol`; see the root README).

## 2. Layout at phone, tablet and desktop widths (`e2e/responsive.mjs`)

```bash
pnpm build && pnpm start &          # or any running build
node e2e/responsive.mjs http://localhost:3000 /tmp/rift-responsive
```

Loads every page at 375 px, 768 px and 1300 px, saves a full-page screenshot of each, and fails if anything
sticks out past the screen edge (marquees excepted). Look through the phone screenshots too: overflow is
caught automatically, cramped or unreadable layouts aren't.

## 3. Manual pass with a real wallet (testnet)

Needs MetaMask (or Rabby, Coinbase, Rainbow) with a little Unichain Sepolia ETH for gas. Before a demo,
check RiftReactive's lREACT balance on the Monitor screen.

**Connect**
- [ ] Connect wallet opens RainbowKit's sheet; pick your wallet and approve.
- [ ] On the wrong network, the header shows "Switch to Unichain"; it switches in one click.
- [ ] Rejecting the connection leaves the page usable, with no error.

**Overview**
- [ ] Your balances bar shows tUSD, ETH and pool shares.
- [ ] "Get 10,000 test tUSD" sends one transaction; the balance goes up.
- [ ] "Add tUSD to wallet" shows tUSD in the wallet (MetaMask: Tokens tab, on Unichain Sepolia).

**Protect**
- [ ] Changing amount or duration updates the quote.
- [ ] Buy cover: approve (first time only), then buy; both steps tick to done with explorer links.
- [ ] The policy appears under your policies with "Starts in …" (the 10-minute cover delay).
- [ ] An amount above your balance fails before the wallet opens, with a plain reason.
- [ ] Rejecting in the wallet shows "rejected", and Retry picks up from that step.

**Underwrite**
- [ ] Deposit (approve + deposit); shares and their value appear.
- [ ] Request a withdrawal; it shows when it unlocks (1 hour); Cancel returns the shares.
- [ ] After the unlock, Withdraw pays out tUSD.

**Trade**
- [ ] Pick direction, size and leverage; margin, entry and liquidation estimates update.
- [ ] Open: the ticket becomes a position card with margin health.
- [ ] Close: a receipt appears under Last close.

**Monitor**
- [ ] The three chain columns show fresh values (mark age in seconds or minutes, not hours).
- [ ] The drain sequence shows the latest trip, with Base, Lasna and Unichain transactions (Lasna needs the indexer).

**Activity**
- [ ] Everything you did above is listed, newest first, each with its transaction.

**History**
- [ ] With the indexer: all three chains show "live" (Base "catching up" on its first run).
- [ ] Totals include your cover, deposit and trades.
- [ ] Filtering by your address shows only your events; chain and type filters work; paging works.

**Phone** (real device, or browser dev tools at 375 px)
- [ ] Repeat a buy and a trade; the nav scrolls sideways; nothing is cut off.
