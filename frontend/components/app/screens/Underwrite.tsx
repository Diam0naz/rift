"use client";

import { useEffect, useState } from "react";
import { maxUint256 } from "viem";
import { useAccount } from "wagmi";

import { mockTokenAbi } from "@/lib/abi/MockToken";
import { riftMarketAbi } from "@/lib/abi/RiftMarket";
import { useAccountState } from "@/lib/account";
import { addresses, clients, explorers } from "@/lib/config";
import { fmtBps, fmtCompact, fmtToken, shortHex } from "@/lib/format";
import { useMarket } from "@/lib/hooks";
import { useMarketLogs, type MarketLog } from "@/lib/logs";
import type { MarketState } from "@/lib/reads";
import { fmtDuration } from "@/lib/risk";
import { useTx, useTxFlow } from "@/lib/tx";
import { MARKET_CHAIN_ID } from "@/lib/wagmi";

import { Bar, Card, Skeleton } from "../../ui";
import { PageHeader } from "../AppShell";
import { Banner, Field, Rows } from "../bits";
import { TxFlowView, TxStatus } from "../TxFlow";
import { AccountBar, ConnectCta } from "../Wallet";
import { parseAmount } from "./Protect";

const market = { address: addresses.unichain.market, abi: riftMarketAbi } as const;
const token = { address: addresses.unichain.collateral, abi: mockTokenAbi } as const;

export function UnderwriteScreen() {
  const m = useMarket().data;
  return (
    <>
      <PageHeader
        kicker="03 / Underwriting · settles on Unichain"
        title="Underwrite"
        outline="the pool"
        intro="Back the cover and take the other side of the perp. You earn premiums and traders' losses, and pay out drains and traders' profits."
      />
      <AccountBar />
      {m?.tripped && <Banner tone="bad">The market has tripped, so deposits are closed. Withdrawals still work.</Banner>}
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="lg:col-span-7">{m ? <YourStake m={m} /> : <Skeleton className="h-[480px] w-full" />}</div>
        <div className="lg:col-span-5">{m ? <PoolCard m={m} /> : <Skeleton className="h-[480px] w-full" />}</div>
      </div>
      <div className="mt-5">
        <PoolHistory />
      </div>
    </>
  );
}

function YourStake({ m }: { m: MarketState }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { address, isConnected, chainId } = useAccount();
  const acct = useAccountState(isConnected && chainId === MARKET_CHAIN_ID ? address : undefined);
  const a = acct.data;
  const [deposit, setDeposit] = useState("1000");
  const amount = parseAmount(deposit);
  const flow = useTxFlow();
  const tx = useTx();
  const value = (shares: bigint) => (m.totalShares > 0n ? (shares * m.poolValue) / m.totalShares : 0n);
  const sharePrice = m.totalShares > 0n ? Number(m.poolValue) / Number(m.totalShares) : 1;
  const w = a?.withdrawal;
  const unlocked = w ? m.now >= w.unlockAt : false;

  const doDeposit = () => {
    if (!amount || !address) return;
    flow.start([
      {
        label: "Approve tUSD",
        explain: "Lets RiftMarket take your deposit. Skipped if it already can.",
        call: { ...token, functionName: "approve", args: [addresses.unichain.market, maxUint256] },
        skip: async () =>
          (await clients.unichain.readContract({ ...token, functionName: "allowance", args: [address, addresses.unichain.market] })) >= amount,
      },
      {
        label: "Deposit",
        explain: `Adds ${fmtToken(amount, 0)} tUSD to the pool for ~${fmtToken((amount * m.totalShares) / (m.poolValue || 1n))} shares at the current share price.`,
        call: { ...market, functionName: "deposit", args: [amount] },
      },
    ]);
  };

  return (
    <Card index="A" ticks title="Your stake" subtitle="Shares are priced at pool value, which includes traders' open PnL.">
      <div className="grid grid-cols-2 gap-6">
        <div>
          <div className="kicker !text-[0.62rem]">Your shares are worth</div>
          <div className="display mt-2 text-[clamp(2.25rem,4.5vw,3.5rem)]" style={{ textTransform: "none" }}>
            {mounted && a ? fmtToken(value(a.shares + (w?.shares ?? 0n))) : "—"}
          </div>
          <div className="mono mt-1 text-xs text-muted">tUSD · {mounted && a ? fmtToken(a.shares + (w?.shares ?? 0n)) : "—"} shares</div>
        </div>
        <div>
          <div className="kicker !text-[0.62rem]">Share price</div>
          <div className="display mt-2 text-[clamp(2.25rem,4.5vw,3.5rem)]" style={{ textTransform: "none" }}>
            {sharePrice.toFixed(4)}
          </div>
          <div className="mono mt-1 text-xs text-muted">tUSD per share</div>
        </div>
      </div>

      <div className="mt-6 border-t pt-5" style={{ borderColor: "var(--line-strong)" }}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem] flex-1">
            <Field label="Deposit (tUSD)">
              <input inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} className="app-input mono" aria-invalid={!amount} />
            </Field>
          </div>
          {!mounted ? null : !isConnected ? (
            <ConnectCta>Connect wallet to deposit</ConnectCta>
          ) : (
            <button type="button" className="btn-brutal btn-sm" onClick={doDeposit} disabled={!a || m.tripped || flow.running || !amount}>
              Deposit
            </button>
          )}
        </div>
        <div className="mt-4">
          <TxFlowView steps={flow.steps} states={flow.states} onRetry={flow.retry} running={flow.running} />
        </div>
      </div>

      <div className="mt-6 border-t pt-5" style={{ borderColor: "var(--line-strong)" }}>
        <div className="kicker mb-1 !text-[0.62rem]">Withdraw</div>
        <p className="mb-4 text-sm text-muted">
          Two steps: request, wait {a ? fmtDuration(Number(a.withdrawDelay)) : "1h"}, then complete at the share price at that moment. Requested
          shares stay in the pool until then, so they still share any payout that lands in the meantime.
        </p>
        {!mounted || !isConnected ? (
          <p className="text-sm text-muted">Connect a wallet to manage withdrawals.</p>
        ) : !a ? (
          <Skeleton className="h-12 w-full" />
        ) : w ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="mono text-sm">
              {fmtToken(w.shares)} shares (~{fmtToken(value(w.shares))} tUSD) ·{" "}
              <span style={{ color: unlocked ? "var(--ok)" : "var(--warn)" }}>
                {unlocked ? "ready" : `unlocks in ${fmtDuration(Number(w.unlockAt - m.now))}`}
              </span>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost btn-sm" disabled={tx.busy} onClick={() => tx.run("Cancel withdrawal", { ...market, functionName: "cancelWithdraw" })}>
                Cancel
              </button>
              <button type="button" className="btn-brutal btn-sm" disabled={tx.busy || !unlocked} onClick={() => tx.run("Withdraw", { ...market, functionName: "completeWithdraw" })}>
                Complete
              </button>
            </div>
          </div>
        ) : a.shares === 0n ? (
          <p className="text-sm text-muted">No shares to withdraw yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {[25n, 50n, 100n].map((pct) => (
              <button
                key={pct.toString()}
                type="button"
                className="btn-ghost btn-sm"
                disabled={tx.busy}
                onClick={() => tx.run(`Request ${pct}%`, { ...market, functionName: "requestWithdraw", args: [(a.shares * pct) / 100n] })}
              >
                Request {pct.toString()}%
              </button>
            ))}
          </div>
        )}
        <div className="mt-3">
          <TxStatus state={tx.state} />
        </div>
      </div>
    </Card>
  );
}

function PoolCard({ m }: { m: MarketState }) {
  const u = Number(m.utilizationWad) / 1e18;
  const kink = Number(m.premium.kinkWad) / 1e18;
  const rate = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%/day`;
  return (
    <Card index="B" title="The pool" subtitle="Where your stake sits and what it's exposed to.">
      <div className="kicker !text-[0.62rem]">Pool value</div>
      <div className="display mt-2 text-[clamp(2.25rem,4vw,3.25rem)]" style={{ textTransform: "none" }}>
        {fmtCompact(m.poolValue)}
      </div>
      <div className="mt-5">
        <Rows
          rows={[
            ["Cash", `${fmtCompact(m.poolAssets)} tUSD`],
            ["Reserved (live cover + net perp)", `${fmtCompact(m.reservedLiquidity)} tUSD`],
            ["Traders' open PnL", `${m.tradersPnl > 0n ? "pool owes " : m.tradersPnl < 0n ? "pool is owed " : ""}${fmtCompact(m.tradersPnl < 0n ? -m.tradersPnl : m.tradersPnl)}`],
            ["Owed to buyers (unclaimed)", `${fmtCompact(m.totalOwed)} tUSD`],
            ["Live cover", `${fmtCompact(m.activeNotional)} tUSD`],
          ]}
        />
      </div>
      <div className="mt-5">
        <div className="mb-1.5 flex justify-between text-xs">
          <span className="text-muted">Utilization (premiums steepen past {Math.round(kink * 100)}%)</span>
          <span className="mono">{(u * 100).toFixed(1)}%</span>
        </div>
        <Bar value={u} max={1} marker={kink} tone={u >= 0.95 ? "red" : u >= kink ? "amber" : "green"} label="Pool utilization" />
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted">
        Cover is priced {rate(m.premium.baseBpsPerDay)} idle, {rate(m.premium.baseBpsPerDay + m.premium.slope1BpsPerDay)} at the kink and{" "}
        {rate(m.premium.baseBpsPerDay + m.premium.slope1BpsPerDay + m.premium.slope2BpsPerDay)} at full use, ×{" "}
        {(Number(m.stressMultiplierBps) / 10_000).toFixed(2)} for spread stress right now.
      </p>
    </Card>
  );
}

const flowLabel: Record<string, string> = {
  Deposited: "Deposit",
  Withdrawn: "Withdrawal",
  WithdrawRequested: "Withdrawal requested",
  Tripped: "Trip · payouts fixed",
};

function PoolHistory() {
  const logs = useMarketLogs();
  const rows: MarketLog[] = (logs.data ?? []).filter((l) => l.eventName in flowLabel).reverse().slice(0, 20);
  const settled = (logs.data ?? []).filter((l) => l.eventName === "PolicySettled");
  return (
    <Card index="C" title="Payouts and flows" subtitle="Trips that hit the pool, and money in and out, newest first.">
      {logs.isLoading ? (
        <p className="text-sm text-muted" role="status">Reading the market&apos;s history from Unichain…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet.</p>
      ) : (
        <ul className="divide-y" style={{ borderColor: "var(--line)" }}>
          {rows.map((l) => {
            const a = l.args as Record<string, bigint | string>;
            let detail = "";
            if (l.eventName === "Tripped") {
              const paid = settled
                .filter((s) => s.txHash === l.txHash && s.args.covered)
                .reduce((sum, s) => sum + (s.args.owed as bigint), 0n);
              detail = `mark ${fmtBps(a.markBps as bigint)} · outflow ${fmtBps(a.outflowBps as bigint, false)} · ratio ${Number(a.payoutRatioBps) / 100}% · ${fmtToken(paid, 0)} tUSD fixed for buyers`;
            } else if (l.eventName === "WithdrawRequested") {
              detail = `${fmtToken(a.shares as bigint)} shares by ${shortHex(String(a.user), 4)}`;
            } else {
              detail = `${fmtToken(a.assets as bigint, 0)} tUSD by ${shortHex(String(a.user), 4)}`;
            }
            return (
              <li key={`${l.txHash}-${l.logIndex}`} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm" style={{ borderColor: "var(--line)" }}>
                <span className="kicker !text-[0.65rem]" style={{ color: l.eventName === "Tripped" ? "var(--rift)" : undefined }}>
                  {flowLabel[l.eventName]}
                </span>
                <span className="min-w-0 flex-1 text-muted">{detail}</span>
                <a href={`${explorers.unichain}/tx/${l.txHash}`} target="_blank" rel="noreferrer" className="mono text-xs underline underline-offset-4">
                  #{l.blockNumber.toString()} ↗
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
