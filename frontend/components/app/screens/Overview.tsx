"use client";

import Link from "next/link";
import { useMemo } from "react";

import { fmtBps, fmtCompact, fmtToken } from "@/lib/format";
import { useMarkHistory, useMarket, useOrigin, useReactive } from "@/lib/hooks";
import { computeRiskBand } from "@/lib/risk";

import { HealthPanel, LatencyPanel, PoliciesPanel, PoolPanel, RiskBandPanel, SpreadPanel, TripPanel } from "../../panels";
import { ErrorNote, Skeleton } from "../../ui";
import { PageHeader } from "../AppShell";
import { AccountBar } from "../Wallet";

export function OverviewScreen() {
  const market = useMarket();
  const reactive = useReactive();
  const origin = useOrigin();
  const history = useMarkHistory();
  const m = market.data;
  const r = reactive.data;
  const o = origin.data;
  const band = useMemo(() => (m && r ? computeRiskBand(m, r) : null), [m, r]);
  const failing = [market.isError && !m && "Unichain", reactive.isError && !r && "Lasna", origin.isError && !o && "Base"].filter(Boolean) as string[];

  const doors = [
    {
      href: "/app/protect",
      n: "01",
      title: "Protect",
      text: "Cover the watched vault. Payout fixed within seconds of a real drain.",
      figure: m?.quote != null ? `${fmtToken(m.quote)} tUSD` : "…",
      figureLabel: "10k cover · 1 day",
    },
    {
      href: "/app/trade",
      n: "02",
      title: "Trade",
      text: "Long or short the Unichain ↔ Base spread at up to 10×.",
      figure: m ? fmtBps(m.markBps) : "…",
      figureLabel: "perp mark",
    },
    {
      href: "/app/underwrite",
      n: "03",
      title: "Underwrite",
      text: "Back the cover and the perp. Earn premiums and traders' losses.",
      figure: m ? (m.totalShares > 0n ? (Number(m.poolValue) / Number(m.totalShares)).toFixed(4) : "1.0000") : "…",
      figureLabel: "share price",
    },
  ];

  return (
    <>
      <PageHeader
        kicker="00 / Overview · live from three chains"
        title="Live"
        outline="market"
        intro="The state of the market right now. Pick a door below to act: everything settles on Unichain Sepolia."
      />
      <AccountBar />
      {failing.length > 0 && (
        <div className="app-panel mb-4 p-3">
          <ErrorNote what={`${failing.join(", ")} state`} />
        </div>
      )}
      <div className="space-y-5">
        {band ? <RiskBandPanel band={band} /> : <Skeleton className="h-56 w-full" />}

        <nav aria-label="Products" className="grid gap-5 md:grid-cols-3">
          {doors.map((d) => (
            <Link key={d.href} href={d.href} className="app-panel corner-ticks group block p-6 transition-transform hover:-translate-y-1">
              <div className="flex items-start justify-between">
                <span className="kicker" style={{ color: "var(--rift)" }}>
                  {d.n} /
                </span>
                <span className="kicker transition-colors group-hover:!text-[var(--bone)]">Open →</span>
              </div>
              <div className="display mt-6 break-words text-[clamp(1.75rem,2.7vw,2.75rem)]">{d.title}</div>
              <p className="mt-3 text-sm text-muted">{d.text}</p>
              <div className="mt-6 flex items-end justify-between border-t pt-4" style={{ borderColor: "var(--line)" }}>
                <span className="kicker !text-[0.6rem]">{d.figureLabel}</span>
                <span className="mono text-lg">{d.figure}</span>
              </div>
            </Link>
          ))}
        </nav>

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {m && r && o ? <SpreadPanel m={m} r={r} o={o} history={history.data} /> : <Skeleton className="h-80 w-full" />}
          </div>
          {r && o ? <TripPanel r={r} o={o} /> : <Skeleton className="h-80 w-full" />}
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          {m ? <PoolPanel m={m} /> : <Skeleton className="h-72 w-full" />}
          {m ? <PoliciesPanel m={m} /> : <Skeleton className="h-72 w-full" />}
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <LatencyPanel history={history.data} />
          {m && r && o ? <HealthPanel m={m} r={r} o={o} /> : <Skeleton className="h-64 w-full" />}
        </div>
        <p className="kicker">
          Live cover {m ? `${fmtCompact(m.activeNotional)} tUSD` : "…"} · open interest {m ? `${fmtCompact(m.openLongSize + m.openShortSize)} tUSD` : "…"}
        </p>
      </div>
    </>
  );
}
