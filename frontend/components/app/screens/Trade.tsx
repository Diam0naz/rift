"use client";

import { useEffect, useState } from "react";
import { maxUint256 } from "viem";
import { useAccount } from "wagmi";

import { mockTokenAbi } from "@/lib/abi/MockToken";
import { riftMarketAbi } from "@/lib/abi/RiftMarket";
import { useAccountState, type AccountState } from "@/lib/account";
import { addresses, clients, explorers } from "@/lib/config";
import { fmtBps, fmtCompact, fmtPrice, fmtToken } from "@/lib/format";
import { useMarkHistory, useMarket, useOrigin, useReactive } from "@/lib/hooks";
import { activityFor, useMarketLogs } from "@/lib/logs";
import { fundingPerDay, liquidationMarkBps, marginHealth, newRiskBlocker } from "@/lib/market";
import type { MarketState } from "@/lib/reads";
import { fmtDuration } from "@/lib/risk";
import { useTx, useTxFlow } from "@/lib/tx";
import { MARKET_CHAIN_ID } from "@/lib/wagmi";

import { MarkChart } from "../../MarkChart";
import { Bar, Card, Skeleton, Stat } from "../../ui";
import { PageHeader } from "../AppShell";
import { Banner, Field, Rows, Segmented } from "../bits";
import { TxFlowView, TxStatus } from "../TxFlow";
import { AccountBar, ConnectCta } from "../Wallet";
import { parseAmount } from "./Protect";

const market = { address: addresses.unichain.market, abi: riftMarketAbi } as const;
const token = { address: addresses.unichain.collateral, abi: mockTokenAbi } as const;

const signed = (x: bigint) => `${x > 0n ? "+" : x < 0n ? "−" : ""}${fmtToken(x < 0n ? -x : x)}`;

export function TradeScreen() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const m = useMarket().data;
  const r = useReactive().data;
  const o = useOrigin().data;
  const history = useMarkHistory();
  const { address, isConnected, chainId } = useAccount();
  const acct = useAccountState(isConnected && chainId === MARKET_CHAIN_ID ? address : undefined);
  const pos = mounted ? acct.data?.position : undefined;

  const lines = pos
    ? [
        { bps: Number(pos.entryMark), label: "entry", color: "var(--cold)" },
        {
          bps: liquidationMarkBps({ ...pos, fundingOwed: pos.funding }),
          label: "liquidation",
          color: "var(--rift)",
        },
      ]
    : [];

  return (
    <>
      <PageHeader
        kicker="02 / Spread perp · settles on Unichain"
        title="Trade"
        outline="the spread"
        intro="Go long or short the gap between the same pool on Unichain and Base, up to 10×. Funding accrues every second; on a trip, positions settle at the trip mark."
      />
      <AccountBar />
      {m && newRiskBlocker(m) && <Banner tone={m.tripped ? "bad" : "warn"}>{newRiskBlocker(m)}</Banner>}

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="lg:col-span-8">
          {m && r && o ? (
            <Card index="A" ticks title="Unichain ↔ Base spread" subtitle="The perp settles on the time-weighted mark RiftReactive delivers to Unichain.">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Unichain pool" value={fmtPrice(m.poolUniPrice)} hint="tQUOTE per tBASE" />
                <Stat label="Base pool" value={fmtPrice(o.price)} hint="tQUOTE per tBASE" />
                <Stat label="Raw spread" value={fmtBps(r.spreadBps)} hint={`smoothed ${fmtBps(r.smoothedSpreadBps)}`} />
                <Stat label="Perp mark" value={fmtBps(m.markBps)} hint={`landed ${fmtDuration(Number(m.now - m.markReceivedAt))} ago`} />
              </div>
              <div className="mt-5">
                <MarkChart
                  points={history.data}
                  now={Number(m.now)}
                  tripSpreadBps={Number(r.params.tripSpreadBps)}
                  trip={m.tripped ? { at: Number(m.trippedAt), bps: Number(m.tripMark) } : undefined}
                  lines={lines}
                  height={280}
                />
              </div>
              <p className="mt-2 text-xs text-muted">
                Long gains when the spread rises (Unichain priced above Base), short when it falls. Dashed lines: trip threshold
                {pos ? ", your entry and liquidation marks" : ""}.
              </p>
            </Card>
          ) : (
            <Skeleton className="h-[480px] w-full" />
          )}
        </div>
        <div className="lg:col-span-4">
          {!m ? (
            <Skeleton className="h-[480px] w-full" />
          ) : pos && acct.data ? (
            <PositionCard m={m} a={acct.data} />
          ) : (
            <OrderTicket m={m} a={mounted && isConnected ? acct.data : undefined} />
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {m && (
          <Card index="C" title="Market" subtitle="The underwriting pool is every trader's counterparty.">
            <Rows
              rows={[
                ["Open interest · long", `${fmtCompact(m.openLongSize)} tUSD`],
                ["Open interest · short", `${fmtCompact(m.openShortSize)} tUSD`],
                ["Pool cash (max size per trade)", `${fmtCompact(m.poolAssets)} tUSD`],
                ["Funding now", m.markBps === 0n ? "None (spread is flat)" : `${m.markBps > 0n ? "Longs" : "Shorts"} pay ${fmtBps(m.markBps < 0n ? -m.markBps : m.markBps, false)} of size per day`],
                ["Liquidation", "Equity below 5% of size; the liquidator earns up to 1%"],
                ["Fees", "None; funding only"],
              ]}
            />
          </Card>
        )}
        <LastReceipt />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- order ticket

function OrderTicket({ m, a }: { m: MarketState; a: AccountState | undefined }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { address, isConnected } = useAccount();
  const [side, setSide] = useState<"long" | "short">("long");
  const [size, setSize] = useState("1000");
  const [lev, setLev] = useState("5");
  const flow = useTxFlow();
  const amount = parseAmount(size);
  const levB = BigInt(lev);
  const margin = amount ? (amount + levB - 1n) / levB : null;
  const isLong = side === "long";
  const blocker = newRiskBlocker(m);
  const liq = amount && margin ? liquidationMarkBps({ isLong, size: amount, margin, entryMark: m.markBps }) : NaN;
  const fund = amount ? fundingPerDay(isLong, amount, m.markBps) : 0n;

  const open = () => {
    if (!amount || !margin || !address) return;
    flow.start([
      {
        label: "Approve tUSD",
        explain: "Lets RiftMarket take your margin. Skipped if it already can.",
        call: { ...token, functionName: "approve", args: [addresses.unichain.market, maxUint256] },
        skip: async () =>
          (await clients.unichain.readContract({ ...token, functionName: "allowance", args: [address, addresses.unichain.market] })) >= margin,
      },
      {
        label: `Open ${side}`,
        explain: `Deposits ${fmtToken(margin)} tUSD margin for a ${fmtToken(amount, 0)} tUSD ${side} at the current mark (${fmtBps(m.markBps)}).`,
        call: { ...market, functionName: "openPosition", args: [isLong, amount, margin] },
      },
    ]);
  };

  return (
    <Card index="B" ticks title="New position" subtitle="One position per wallet. Close it any time.">
      <div className="space-y-4">
        <Field label="Direction" group>
          <Segmented
            value={side}
            onChange={setSide}
            label="Direction"
            options={[
              { value: "long", label: "Long spread", tone: "ok" },
              { value: "short", label: "Short spread", tone: "bad" },
            ]}
          />
        </Field>
        <Field label="Size (tUSD)">
          <input inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} className="app-input mono" aria-invalid={!amount} />
        </Field>
        <Field label="Leverage" group>
          <Segmented
            value={lev}
            onChange={setLev}
            label="Leverage"
            options={["1", "2", "5", "10"].map((v) => ({ value: v, label: `${v}×` }))}
          />
        </Field>
      </div>

      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--line-strong)" }}>
        <Rows
          rows={[
            ["Margin", margin ? `${fmtToken(margin)} tUSD` : "—"],
            ["Entry mark", fmtBps(m.markBps)],
            ["Liquidation mark (est.)", Number.isFinite(liq) ? fmtBps(Math.round(liq)) : "—"],
            ["Funding per day (now)", amount ? `${fund > 0n ? "you pay" : fund < 0n ? "you receive" : "none"} ${fund !== 0n ? fmtToken(fund < 0n ? -fund : fund) : ""}` : "—"],
          ]}
        />
      </div>

      <div className="mt-5 space-y-4">
        {!mounted ? null : !isConnected ? (
          <ConnectCta>Connect wallet to trade</ConnectCta>
        ) : (
          <button
            type="button"
            className="btn-brutal btn-sm"
            onClick={open}
            disabled={!a || !!blocker || flow.running || !amount}
          >
            Open {side}
          </button>
        )}
        {blocker && <p className="text-xs" style={{ color: "var(--warn)" }}>{blocker}</p>}
        <TxFlowView steps={flow.steps} states={flow.states} onRetry={flow.retry} running={flow.running} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- open position

function PositionCard({ m, a }: { m: MarketState; a: AccountState }) {
  const p = a.position!;
  const tx = useTx();
  const health = marginHealth(p.equity, p.size);
  const liq = liquidationMarkBps({ ...p, fundingOwed: p.funding });
  const warn = health < 2;
  return (
    <Card index="B" ticks title={`Your ${p.isLong ? "long" : "short"}`} subtitle={`Opened at ${fmtBps(p.entryMark)} · size ${fmtToken(p.size, 0)} tUSD`}>
      <div className="kicker !text-[0.62rem]">Unrealised PnL</div>
      <div
        className="display mt-2 text-[clamp(2.25rem,4vw,3.25rem)]"
        style={{ textTransform: "none", color: p.pnl >= 0n ? "var(--ok)" : "var(--rift)" }}
        aria-live="polite"
      >
        {signed(p.pnl)}
      </div>

      <div className="mt-5">
        <div className="mb-1.5 flex justify-between text-xs">
          <span className="text-muted">Margin health</span>
          <span className="mono">{Number.isFinite(health) ? `${health.toFixed(2)}× maintenance` : "—"}</span>
        </div>
        <Bar value={Math.min(health, 4)} max={4} marker={1} tone={health < 1.25 ? "red" : warn ? "amber" : "green"} label="Margin health" />
      </div>
      {warn && (
        <p className="mt-3 text-sm" style={{ color: health < 1.25 ? "var(--rift)" : "var(--warn)" }} role="status">
          {health < 1 ? "Liquidatable now: anyone can close this position and keep up to 1% of size." : `Close to liquidation: it triggers at a mark of ${fmtBps(Math.round(liq))}.`}
        </p>
      )}

      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--line-strong)" }}>
        <Rows
          rows={[
            ["Mark now", fmtBps(m.markBps) + (m.tripped ? " (frozen at trip)" : "")],
            ["Funding so far", `${p.funding > 0n ? "paid" : "received"} ${fmtToken(p.funding < 0n ? -p.funding : p.funding)}`],
            ["Margin", fmtToken(p.margin)],
            ["Equity", fmtToken(p.equity)],
            ["Liquidation mark", Number.isFinite(liq) ? fmtBps(Math.round(liq)) : "—"],
          ]}
        />
      </div>
      <div className="mt-5 space-y-3">
        <button type="button" className="btn-brutal btn-sm" disabled={tx.busy} onClick={() => tx.run("Close position", { ...market, functionName: "closePosition" })}>
          Close position
        </button>
        <p className="text-xs text-muted">Closing pays out your equity now{m.tripped ? ", settled at the trip mark" : ""}. No cross-chain wait.</p>
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- receipt

function LastReceipt() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { address } = useAccount();
  const logs = useMarketLogs();
  if (!mounted || !address || !logs.data) {
    return (
      <Card index="D" title="Last close" subtitle="Your most recent closed position.">
        <p className="text-sm text-muted">{address ? "Reading your history…" : "Connect a wallet to see your receipts."}</p>
      </Card>
    );
  }
  const mine = activityFor(logs.data, address);
  const closed = mine.find((l) => l.eventName === "PositionClosed");
  const opened = closed ? mine.find((l) => l.eventName === "PositionOpened" && l.blockNumber <= closed.blockNumber) : undefined;
  if (!closed) {
    return (
      <Card index="D" title="Last close" subtitle="Your most recent closed position.">
        <p className="text-sm text-muted">No closed positions yet. When you close one, the receipt appears here.</p>
      </Card>
    );
  }
  const a = closed.args as { pnl: bigint; funding: bigint; payout: bigint; liquidated: boolean };
  const blocks = opened ? Number(closed.blockNumber - opened.blockNumber) : null;
  return (
    <Card index="D" ticks title={a.liquidated ? "Liquidated" : "Last close · receipt"} subtitle="Realised on Unichain.">
      <div className="kicker !text-[0.62rem]">Realised PnL (after funding)</div>
      <div className="display mt-2 text-[clamp(2.25rem,4vw,3.25rem)]" style={{ textTransform: "none", color: a.pnl - a.funding >= 0n ? "var(--ok)" : "var(--rift)" }}>
        {signed(a.pnl - a.funding)}
      </div>
      <div className="mt-4">
        <Rows
          rows={[
            ["Price PnL", signed(a.pnl)],
            ["Funding", `${a.funding > 0n ? "paid" : "received"} ${fmtToken(a.funding < 0n ? -a.funding : a.funding)}`],
            ["Paid out", `${fmtToken(a.payout)} tUSD`],
            ["Held for", blocks !== null ? `~${fmtDuration(blocks)} (${blocks} blocks)` : "—"],
            [
              "Transaction",
              <a key="tx" href={`${explorers.unichain}/tx/${closed.txHash}`} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                {closed.txHash.slice(0, 10)}… ↗
              </a>,
            ],
          ]}
        />
      </div>
      {a.liquidated && <p className="mt-3 text-sm text-muted">The position fell below maintenance margin and was closed by a liquidator.</p>}
    </Card>
  );
}
