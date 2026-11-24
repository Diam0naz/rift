"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { addresses, explorers } from "@/lib/config";
import { fmtBps, fmtCompact } from "@/lib/format";
import { useMarket, useReactive } from "@/lib/hooks";

import { BottomBand } from "../BottomBand";
import { Logo, ThemeToggle, Ticker, useTheme } from "../brand";
import { WalletButton } from "./Wallet";

export const NAV = [
  { href: "/app", label: "Overview" },
  { href: "/app/protect", label: "Protect" },
  { href: "/app/trade", label: "Trade" },
  { href: "/app/underwrite", label: "Underwrite" },
  { href: "/app/monitor", label: "Monitor" },
  { href: "/app/activity", label: "Activity" },
  { href: "/app/history", label: "History" },
  { href: "/app/agent", label: "Agent" },
  { href: "/app/scanner", label: "Scanner" },
] as const;

/**
 * Chrome shared by every /app screen, in the site's three planes:
 * background (atmosphere, grid, grain), foreground (header, nav, wallet, ticker), and the closing band.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [theme, cycleTheme] = useTheme();
  const m = useMarket().data;
  const r = useReactive().data;

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
      <div className="app-backdrop" aria-hidden>
        <div className="atmos" />
        <div className="grid-field" />
        <div className="form-ring" style={{ width: 720, height: 720, right: -260, top: -220 }} />
        <div className="form-slab hatch" style={{ width: 320, height: 420, left: -120, bottom: -120, transform: "rotate(10deg)", opacity: 0.5 }} />
      </div>

      <header className="relative z-20 mx-auto w-full max-w-[1440px] px-4 pt-5 sm:px-6 lg:px-12">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-baseline gap-4">
            <Logo />
            <span className="kicker hidden sm:inline">App · testnet</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ThemeToggle theme={theme} onToggle={cycleTheme} />
            <WalletButton />
          </div>
        </div>
        <nav aria-label="App" className="mt-5 flex gap-px overflow-x-auto border" style={{ borderColor: "var(--line-strong)", background: "var(--line-strong)" }}>
          {NAV.map((item) => {
            const active = item.href === "/app" ? pathname === "/app" : pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className="kicker flex-1 whitespace-nowrap px-4 py-3 text-center transition-colors hover:!text-[var(--bone)]"
                style={active ? { background: "var(--bone)", color: "var(--ink)" } : { background: "var(--ink-2)" }}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <div className="mt-5">
        <Ticker items={ticker} />
      </div>

      <main className="relative z-10 mx-auto w-full max-w-[1440px] px-4 pb-4 pt-10 sm:px-6 lg:px-12">{children}</main>

      <BottomBand spreadBps={r?.spreadBps} tripSpreadBps={r?.params.tripSpreadBps} tripped={m?.tripped} />

      <div className="relative z-10 mx-auto flex w-full max-w-[1440px] flex-wrap gap-6 px-4 pb-8 sm:px-6 lg:px-12">
        <a className="kicker hover:text-[var(--bone)]" href={`${explorers.unichain}/address/${addresses.unichain.market}`} target="_blank" rel="noreferrer">
          RiftMarket ↗
        </a>
        <a className="kicker hover:text-[var(--bone)]" href={`${explorers.lasna}/address/${addresses.lasna.reactive}`} target="_blank" rel="noreferrer">
          RiftReactive ↗
        </a>
        <a className="kicker hover:text-[var(--bone)]" href={`${explorers.base}/address/${addresses.base.vault}`} target="_blank" rel="noreferrer">
          Vault ↗
        </a>
      </div>
    </div>
  );
}

/** Page heading used by every screen: numbered kicker, display title, one-line intro. */
export function PageHeader({ kicker, title, outline, intro }: { kicker: string; title: string; outline?: string; intro: string }) {
  return (
    <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
      <div>
        <p className="kicker mb-4">{kicker}</p>
        <h1 className="display text-[clamp(2.75rem,6.5vw,6rem)]">
          {title}
          {outline && (
            <>
              <br />
              <span className="outline-text">{outline}</span>
            </>
          )}
          <span style={{ color: "var(--rift)" }}>.</span>
        </h1>
      </div>
      <p className="max-w-md text-sm leading-relaxed text-muted">{intro}</p>
    </div>
  );
}
