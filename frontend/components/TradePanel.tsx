"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { maxUint256, parseUnits } from "viem";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { mockTokenAbi } from "@/lib/abi/MockToken";
import { riftMarketAbi } from "@/lib/abi/RiftMarket";
import { useAccountState, type AccountState } from "@/lib/account";
import { addresses, clients, explorers } from "@/lib/config";
import { fmtBps, fmtToken, shortHex } from "@/lib/format";
import type { MarketState } from "@/lib/reads";
import { fmtDuration } from "@/lib/risk";
import { useTx, type TxState } from "@/lib/tx";
import { MARKET_CHAIN_ID } from "@/lib/wagmi";

import { Card, Pill, Stat } from "./ui";

const market = { address: addresses.unichain.market, abi: riftMarketAbi } as const;
const token = { address: addresses.unichain.collateral, abi: mockTokenAbi } as const;

type Tab = "protection" | "underwrite" | "perp";

/** Parses a decimal tUSD amount; null if empty or invalid. */
function parseAmount(s: string): bigint | null {
  if (!/^\d*\.?\d*$/.test(s.trim()) || s.trim() === "" || s.trim() === ".") return null;
  try {
    return parseUnits(s.trim(), 18);
  } catch {
    return null;
  }
}

/** Why the market won't take new risk right now, or null if it will. */
function newRiskBlocker(m: MarketState): string | null {
  if (m.tripped) return "The market has tripped, so new cover, positions and deposits are closed.";
  if (m.markReceivedAt === 0n) return "No mark has reached the market yet.";
  const age = Number(m.now - m.markReceivedAt);
  if (age > Number(m.maxMarkAge))
    return `The last mark is ${fmtDuration(age)} old (limit ${fmtDuration(Number(m.maxMarkAge))}), so the market isn't taking new risk.`;
  return null;
}

export function TradePanel({ m }: { m: MarketState }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { address, chainId, isConnected } = useAccount();
  const acct = useAccountState(isConnected ? address : undefined);
  const [tab, setTab] = useState<Tab>("protection");

  // Wallet state only exists in the browser; render the shell until hydrated.
  if (!mounted) return <Card index="02" ticks title="Trade" subtitle="Connect a wallet on Unichain Sepolia.">{null}</Card>;

  const wrongChain = isConnected && chainId !== MARKET_CHAIN_ID;
  return (
    <Card
      index="02"
      ticks
      title="Trade"
      subtitle="Buy drain protection, underwrite the pool, or trade the spread perp. Everything settles on Unichain Sepolia."
      right={<WalletButton />}
    >
      {!isConnected ? (
        <p className="text-sm text-muted">Connect a wallet to trade. The dashboard above works without one.</p>
      ) : wrongChain ? (
        <SwitchNetwork />
      ) : !acct.data ? (
        <p className="text-sm text-muted">Loading your balances…</p>
      ) : (
        <>
          <Balances a={acct.data} />
          <div className="mt-6 flex border" style={{ borderColor: "var(--line-strong)" }} role="tablist">
            {(
              [
                ["protection", "Protection"],
                ["underwrite", "Underwrite"],
                ["perp", "Spread perp"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`kicker flex-1 px-3 py-3 transition-colors ${
                  tab === id ? "!text-[var(--ink)]" : "hover:!text-[var(--bone)]"
                }`}
                style={tab === id ? { background: "var(--bone)" } : undefined}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-4">
            {tab === "protection" && <ProtectionForm m={m} a={acct.data} user={address!} />}
            {tab === "underwrite" && <UnderwriteForm m={m} a={acct.data} />}
            {tab === "perp" && <PerpForm m={m} a={acct.data} />}
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- wallet

function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <Pill tone="green">{shortHex(address, 4)}</Pill>
        <button onClick={() => disconnect()} className="text-xs text-muted hover:text-text">
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        {connectors.map((c) => (
          <Button key={c.uid} onClick={() => connect({ connector: c })} disabled={isPending} small>
            {c.type === "mock" ? "Test wallet" : c.name === "Injected" ? "Browser wallet" : c.name}
          </Button>
        ))}
      </div>
      {error && <span className="text-xs text-bad">{error.message.split("\n")[0]}</span>}
    </div>
  );
}

function SwitchNetwork() {
  const { switchChain, isPending, error } = useSwitchChain();
  return (
    <div className="space-y-2">
      <p className="text-sm">Your wallet is on another network. Rift trades on Unichain Sepolia.</p>
      <Button onClick={() => switchChain({ chainId: MARKET_CHAIN_ID })} disabled={isPending}>
        Switch to Unichain Sepolia
      </Button>
      {error && <p className="text-xs text-bad">{error.message.split("\n")[0]}</p>}
    </div>
  );
}

function Balances({ a }: { a: AccountState }) {
  const tx = useTx();
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex gap-6">
        <Stat label="tUSD" value={fmtToken(a.usd)} />
        <Stat label="ETH (gas)" value={fmtToken(a.eth, 4)} tone={a.eth === 0n ? "red" : undefined} />
      </div>
      <div className="flex flex-col items-end gap-1">
        <Button small disabled={tx.busy} onClick={() => tx.run("Faucet", { ...token, functionName: "faucet" })}>
          Get {fmtToken(a.faucetAmount, 0)} test tUSD
        </Button>
        <TxStatus state={tx.state} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- protection

const DURATIONS = [
  ["1 hour", 3_600n],
  ["1 day", 86_400n],
  ["7 days", 604_800n],
  ["30 days", 2_592_000n],
] as const;

function ProtectionForm({ m, a, user }: { m: MarketState; a: AccountState; user: `0x${string}` }) {
  const [notional, setNotional] = useState("1000");
  const [duration, setDuration] = useState<bigint>(86_400n);
  const tx = useTx();
  const amount = parseAmount(notional);
  const blocker = newRiskBlocker(m);

  const quote = useQuery({
    queryKey: ["quote", amount?.toString(), duration.toString(), m.blockNumber.toString()],
    queryFn: () =>
      clients.unichain.readContract({ ...market, functionName: "quotePremium", args: [amount!, duration] }),
    enabled: !!amount && amount > 0n,
    retry: false,
  });

  const mine = m.policies.filter((p) => p.buyer.toLowerCase() === user.toLowerCase());

  const buy = async () => {
    if (!amount || quote.data === undefined) return;
    if (a.allowance < quote.data) {
      const ok = await tx.run("Approve tUSD", { ...token, functionName: "approve", args: [addresses.unichain.market, maxUint256] });
      if (!ok) return;
    }
    await tx.run("Buy cover", { ...market, functionName: "buyProtection", args: [amount, duration] });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Cover amount (tUSD)">
          <input
            inputMode="decimal"
            value={notional}
            onChange={(e) => setNotional(e.target.value)}
            className="app-input num"
          />
        </Field>
        <Field label="Duration">
          <select
            value={duration.toString()}
            onChange={(e) => setDuration(BigInt(e.target.value))}
            className="app-input"
          >
            {DURATIONS.map(([label, s]) => (
              <option key={label} value={s.toString()}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 bg-panel-2 p-3 text-sm">
        <span className="text-muted">Premium</span>
        <span className="num">
          {!amount ? "—" : quote.isLoading ? "…" : quote.data !== undefined ? `${fmtToken(quote.data)} tUSD` : "no capacity"}
        </span>
      </div>
      <p className="text-xs text-muted">
        Cover starts {fmtDuration(Number(m.coverDelay))} after purchase. If the vault is drained after that, the trip
        fixes your payout and you claim it here. Stress loading is {(Number(m.stressMultiplierBps) / 10_000).toFixed(2)}× right now.
      </p>
      <ActionRow
        blocker={blocker}
        tx={tx.state}
        button={
          <Button onClick={buy} disabled={!!blocker || tx.busy || !amount || quote.data === undefined}>
            {a.allowance < (quote.data ?? 0n) ? "Approve & buy cover" : "Buy cover"}
          </Button>
        }
      />
      <MyPolicies policies={mine} now={m.now} />
    </div>
  );
}

function MyPolicies({ policies, now }: { policies: MarketState["policies"]; now: bigint }) {
  const tx = useTx();
  if (policies.length === 0) return null;
  return (
    <div className="border-t border-line pt-3">
      <h3 className="mb-2 text-xs font-semibold text-muted">Your recent policies</h3>
      <ul className="space-y-2 text-sm">
        {policies.map((p) => (
          <li key={p.id.toString()} className="flex flex-wrap items-center justify-between gap-2">
            <span className="num">
              #{p.id.toString()} · {fmtToken(p.notional, 0)} tUSD
            </span>
            {p.owed > 0n ? (
              <Button
                small
                disabled={tx.busy}
                onClick={() => tx.run(`Claim #${p.id}`, { ...market, functionName: "claim", args: [p.id] })}
              >
                Claim {fmtToken(p.owed)}
              </Button>
            ) : (
              <Pill tone="muted">
                {p.settled
                  ? "Claimed"
                  : p.expiry < now
                    ? "Expired"
                    : p.activeAt > now
                      ? `Starts in ${fmtDuration(Number(p.activeAt - now))}`
                      : "Covered"}
              </Pill>
            )}
          </li>
        ))}
      </ul>
      <TxStatus state={tx.state} />
    </div>
  );
}

// ---------------------------------------------------------------- underwrite

function UnderwriteForm({ m, a }: { m: MarketState; a: AccountState }) {
  const [deposit, setDeposit] = useState("1000");
  const tx = useTx();
  const amount = parseAmount(deposit);
  const value = (shares: bigint) => (m.totalShares > 0n ? (shares * m.poolValue) / m.totalShares : 0n);
  const depositBlocker = m.tripped ? "The market has tripped, so deposits are closed. Withdrawals still work." : null;

  const doDeposit = async () => {
    if (!amount) return;
    if (a.allowance < amount) {
      const ok = await tx.run("Approve tUSD", { ...token, functionName: "approve", args: [addresses.unichain.market, maxUint256] });
      if (!ok) return;
    }
    await tx.run("Deposit", { ...market, functionName: "deposit", args: [amount] });
  };

  const w = a.withdrawal;
  const unlocked = w ? m.now >= w.unlockAt : false;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Your shares" value={fmtToken(a.shares)} hint={`worth ${fmtToken(value(a.shares))} tUSD`} />
        <Stat
          label="Share price"
          value={m.totalShares > 0n ? (Number(m.poolValue) / Number(m.totalShares)).toFixed(4) : "1.0000"}
          hint="includes open perp PnL"
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field label="Deposit (tUSD)">
            <input
              inputMode="decimal"
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
              className="app-input num"
            />
          </Field>
        </div>
        <Button onClick={doDeposit} disabled={!!depositBlocker || tx.busy || !amount}>
          {amount && a.allowance < amount ? "Approve & deposit" : "Deposit"}
        </Button>
      </div>
      {depositBlocker && <p className="text-xs text-warn">{depositBlocker}</p>}

      <div className="border-t border-line pt-3">
        <h3 className="mb-2 text-xs font-semibold text-muted">
          Withdraw · waits {fmtDuration(Number(a.withdrawDelay))}, and the locked shares stay at risk until then
        </h3>
        {w ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="num">
              {fmtToken(w.shares)} shares (~{fmtToken(value(w.shares))} tUSD) ·{" "}
              {unlocked ? "ready" : `unlocks in ${fmtDuration(Number(w.unlockAt - m.now))}`}
            </span>
            <div className="flex gap-2">
              <Button small disabled={tx.busy} onClick={() => tx.run("Cancel withdrawal", { ...market, functionName: "cancelWithdraw" })}>
                Cancel
              </Button>
              <Button small disabled={tx.busy || !unlocked} onClick={() => tx.run("Withdraw", { ...market, functionName: "completeWithdraw" })}>
                Complete
              </Button>
            </div>
          </div>
        ) : a.shares === 0n ? (
          <p className="text-sm text-muted">No shares to withdraw.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {[25n, 50n, 100n].map((pct) => (
              <Button
                key={pct.toString()}
                small
                disabled={tx.busy}
                onClick={() =>
                  tx.run(`Request ${pct}%`, { ...market, functionName: "requestWithdraw", args: [(a.shares * pct) / 100n] })
                }
              >
                Request {pct.toString()}%
              </Button>
            ))}
          </div>
        )}
      </div>
      <TxStatus state={tx.state} />
    </div>
  );
}

// ---------------------------------------------------------------- perp

function PerpForm({ m, a }: { m: MarketState; a: AccountState }) {
  const [isLong, setIsLong] = useState(true);
  const [size, setSize] = useState("1000");
  const [lev, setLev] = useState(5n);
  const tx = useTx();
  const amount = parseAmount(size);
  const margin = amount ? (amount + lev - 1n) / lev : null;
  const blocker = newRiskBlocker(m);
  const p = a.position;

  if (p) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Side" value={p.isLong ? "Long" : "Short"} hint={`entry ${fmtBps(p.entryMark)}`} />
          <Stat label="Size" value={fmtToken(p.size, 0)} hint={`margin ${fmtToken(p.margin, 0)}`} />
          <Stat label="PnL" value={`${p.pnl >= 0n ? "+" : ""}${fmtToken(p.pnl)}`} tone={p.pnl >= 0n ? "green" : "red"} />
          <Stat
            label="Equity"
            value={fmtToken(p.equity)}
            hint={`funding ${p.funding > 0n ? "paid" : "received"} ${fmtToken(p.funding < 0n ? -p.funding : p.funding)}`}
            tone={p.equity < (p.size * 500n) / 10_000n ? "red" : undefined}
          />
        </div>
        <p className="text-xs text-muted">
          Mark now {fmtBps(m.markBps)}
          {m.tripped ? " (frozen at the trip). Closing settles at the trip mark." : ". Funding accrues every second while the spread is non-zero."}
        </p>
        <ActionRow
          blocker={null}
          tx={tx.state}
          button={
            <Button disabled={tx.busy} onClick={() => tx.run("Close position", { ...market, functionName: "closePosition" })}>
              Close position
            </Button>
          }
        />
      </div>
    );
  }

  const open = async () => {
    if (!amount || !margin) return;
    if (a.allowance < margin) {
      const ok = await tx.run("Approve tUSD", { ...token, functionName: "approve", args: [addresses.unichain.market, maxUint256] });
      if (!ok) return;
    }
    await tx.run(`Open ${isLong ? "long" : "short"}`, { ...market, functionName: "openPosition", args: [isLong, amount, margin] });
  };

  return (
    <div className="space-y-4">
      <div className="flex border" style={{ borderColor: "var(--line-strong)" }}>
        {[true, false].map((long) => (
          <button
            key={String(long)}
            type="button"
            aria-pressed={isLong === long}
            onClick={() => setIsLong(long)}
            className={`kicker flex-1 px-3 py-3 ${isLong === long ? (long ? "!text-good" : "!text-bad") : "hover:!text-[var(--bone)]"}`}
            style={isLong === long ? { background: "var(--ink-3)", boxShadow: `inset 0 -3px 0 ${long ? "var(--ok)" : "var(--rift)"}` } : undefined}
          >
            {long ? "Long the spread" : "Short the spread"}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Size (tUSD)">
          <input
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            className="app-input num"
          />
        </Field>
        <Field label="Leverage">
          <select
            value={lev.toString()}
            onChange={(e) => setLev(BigInt(e.target.value))}
            className="app-input"
          >
            {[1n, 2n, 5n, 10n].map((l) => (
              <option key={l.toString()} value={l.toString()}>
                {l.toString()}×
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex justify-between bg-panel-2 p-3 text-sm">
        <span className="text-muted">Margin</span>
        <span className="num">{margin ? `${fmtToken(margin)} tUSD` : "—"}</span>
      </div>
      <p className="text-xs text-muted">
        PnL is size × the change in spread. Longs pay funding while the spread is positive, shorts while it&apos;s
        negative. Liquidation below 5% of size. Current mark {fmtBps(m.markBps)}.
      </p>
      <ActionRow
        blocker={blocker}
        tx={tx.state}
        button={
          <Button onClick={open} disabled={!!blocker || tx.busy || !amount}>
            {margin && a.allowance < margin ? "Approve & open" : `Open ${isLong ? "long" : "short"}`}
          </Button>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------- shared bits

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

function Button({
  children,
  onClick,
  disabled,
  small,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  small?: boolean;
}) {
  // Primary actions use the site's cream button with the hard red shadow; secondary ones are outlined.
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={small ? "btn-ghost btn-sm" : "btn-brutal btn-sm"}>
      {children}
    </button>
  );
}

function ActionRow({ blocker, tx, button }: { blocker: string | null; tx: TxState; button: ReactNode }) {
  return (
    <div className="space-y-2">
      {button}
      {blocker && <p className="text-xs text-warn">{blocker}</p>}
      <TxStatus state={tx} />
    </div>
  );
}

function TxStatus({ state }: { state: TxState }) {
  if (state.status === "idle") return null;
  const link = "hash" in state && state.hash ? (
    <a href={`${explorers.unichain}/tx/${state.hash}`} target="_blank" rel="noreferrer" className="num text-accent hover:underline">
      {shortHex(state.hash, 4)}
    </a>
  ) : null;
  const text =
    state.status === "simulating"
      ? `${state.label}: checking…`
      : state.status === "signing"
        ? `${state.label}: confirm in your wallet…`
        : state.status === "pending"
          ? `${state.label}: waiting for Unichain…`
          : state.status === "success"
            ? `${state.label}: done.`
            : `${state.label} failed: ${state.message}`;
  const color = state.status === "error" ? "text-bad" : state.status === "success" ? "text-good" : "text-muted";
  return (
    <p className={`text-xs ${color}`} role="status" data-tx-status={state.status}>
      {text} {link}
    </p>
  );
}
