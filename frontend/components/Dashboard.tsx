"use client";

import { useMemo } from "react";

import { addresses, explorers } from "@/lib/config";
import { fmtBps, fmtCompact } from "@/lib/format";
import { useMarkHistory, useMarket, useOrigin, useReactive } from "@/lib/hooks";
import { computeRiskBand } from "@/lib/risk";

import { BottomBand } from "./BottomBand";
import { Logo, ThemeToggle, Ticker, useTheme } from "./brand";
import { TradePanel } from "./TradePanel";
import { HealthPanel, LatencyPanel, PoliciesPanel, PoolPanel, RiskBandPanel, SpreadPanel, TripPanel } from "./panels";
import { ErrorNote, Skeleton } from "./ui";

export function Dashboard() {
  const market = useMarket();
  const reactive = useReactive();
  const origin = useOrigin();
  const history = useMarkHistory();
  const [theme, cycleTheme] = useTheme();

  const m = market.data;
  const r = reactive.data;
  const o = origin.data;
  const band = useMemo(() => (m && r ? computeRiskBand(m, r) : null), [m, r]);

  const failing = [
    market.isError && !m && "Unichain",
    reactive.isError && !r && "Lasna",
    origin.isError && !o && "Base",
  ].filter(Boolean) as string[];

  const ticker: [string, string][] = [
    ["Perp mark", m ? fmtBps(m.markBps) : "…"],
    ["Raw spread", r ? fmtBps(r.spreadBps) : "…"],
    ["Market", m ? (m.tripped ? "Tripped · claims open" : "Armed") : "…"],
    ["Pool value", m ? `${fmtCompact(m.poolValue)} tUSD` : "…"],
    ["Utilization", m ? `${((Number(m.utilizationWad) / 1e18) * 100).toFixed(1)}%` : "…"],
    ["Open interest", m ? `${fmtCompact(m.openLongSize + m.openShortSize)} tUSD` : "…"],
    ["Reactive balance", r ? `${(Number(r.balance) / 1e18).toFixed(2)} lREACT` : "…"],
  ];

  return (
    <div className="landing flex min-h-screen flex-col" data-theme={theme === "auto" ? undefined : theme}>
      <div className="grain" aria-hidden />
      {/* Background plane: the same atmosphere and grid as the site, fixed behind the app. */}
      <div className="app-backdrop" aria-hidden>
        <div className="atmos" />
        <div className="grid-field" />
        <div className="form-ring" style={{ width: 720, height: 720, right: -260, top: -220 }} />
        <div className="form-slab hatch" style={{ width: 320, height: 420, left: -120, bottom: -120, transform: "rotate(10deg)", opacity: 0.5 }} />
      </div>

      {/* Foreground: header */}
      <header className="relative z-20 mx-auto flex w-full max-w-[1440px] flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6 lg:px-12">
        <div className="flex items-baseline gap-4">
          <Logo />
          <span className="kicker hidden sm:inline">App · testnet</span>
        </div>
        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <a className="kicker hover:text-[var(--bone)]" href={`${explorers.unichain}/address/${addresses.unichain.market}`} target="_blank" rel="noreferrer">
            Market ↗
          </a>
          <a className="kicker hover:text-[var(--bone)]" href={`${explorers.lasna}/address/${addresses.lasna.reactive}`} target="_blank" rel="noreferrer">
            Reactive ↗
          </a>
          <a className="kicker hover:text-[var(--bone)]" href={`${explorers.base}/address/${addresses.base.vault}`} target="_blank" rel="noreferrer">
            Vault ↗
          </a>
          <ThemeToggle theme={theme} onToggle={cycleTheme} />
        </nav>
      </header>

      <Ticker items={ticker} />

      <main className="relative z-10 mx-auto w-full max-w-[1440px] px-4 pb-4 pt-10 sm:px-6 lg:px-12">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
          <h1 className="display text-[clamp(2.75rem,6.5vw,6rem)]">
            Live
            <br />
            <span className="outline-text">market</span>
            <span style={{ color: "var(--rift)" }}>.</span>
          </h1>
          <p className="max-w-md text-sm leading-relaxed text-muted">
            A spread perp and drain protection on the Unichain ↔ Base pool spread. Everything below is read from Base Sepolia,
            Unichain Sepolia and Reactive Lasna every few seconds; trades settle on Unichain.
          </p>
        </div>

        {failing.length > 0 && (
          <div className="app-panel mb-4 p-3">
            <ErrorNote what={`${failing.join(", ")} state`} />
          </div>
        )}

        <div className="space-y-5">
          {band ? <RiskBandPanel band={band} /> : <Skeleton className="h-56 w-full" />}

          {m ? <TradePanel m={m} /> : <Skeleton className="h-48 w-full" />}

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
        </div>
      </main>

      <BottomBand spreadBps={r?.spreadBps} tripSpreadBps={r?.params.tripSpreadBps} tripped={m?.tripped} />
    </div>
  );
}
