"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Logo, ThemeToggle, useTheme } from "./brand";

const SCREENS = [
  { href: "/app", label: "Overview" },
  { href: "/app/protect", label: "Protect" },
  { href: "/app/trade", label: "Trade" },
  { href: "/app/monitor", label: "Monitor" },
  { href: "/app/history", label: "History" },
  { href: "/app/agent", label: "Agent" },
];

/** 404, in the site's language: the line runs flat, then breaks at the rift. */
export function NotFound() {
  const [theme, cycleTheme] = useTheme();
  // This page is pre-rendered once at build time, so the missing URL is only known in the browser:
  // reading it after mount keeps the server HTML and the first client render identical.
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => setPath(window.location.pathname), []);
  return (
    <div className="landing relative flex min-h-screen flex-col overflow-hidden" data-theme={theme === "auto" ? undefined : theme}>
      <div className="grain" aria-hidden />
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="atmos" />
        <div className="grid-field" />
      </div>

      <header className="relative z-10 mx-auto flex w-full max-w-[1440px] items-center justify-between px-4 pt-6 sm:px-6 lg:px-12">
        <Logo />
        <ThemeToggle theme={theme} onToggle={cycleTheme} />
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-[1440px] flex-1 flex-col justify-center px-4 py-16 sm:px-6 lg:px-12">
        <p className="kicker mb-6">
          <span style={{ color: "var(--rift)" }}>404</span> / off the index
        </p>
        <h1 className="display text-[clamp(3.5rem,12vw,11rem)]">
          Lost
          <br />
          <span className="outline-text">in the</span> <span style={{ color: "var(--rift)" }}>gap</span>.
        </h1>

        {/* A flat mark, then the break: the page isn't on any chain. */}
        <svg viewBox="0 0 1200 80" className="mt-10 h-16 w-full max-w-4xl" preserveAspectRatio="none" aria-hidden>
          <path d="M0 40 H520 L548 30 L560 52" fill="none" stroke="var(--bone)" strokeWidth="2" />
          <path d="M640 40 H1200" fill="none" stroke="var(--bone)" strokeWidth="2" strokeDasharray="6 8" opacity="0.4" />
          <path d="M586 8 L604 72" stroke="var(--rift)" strokeWidth="8" />
        </svg>

        <p className="mt-8 max-w-xl text-base leading-relaxed" style={{ color: "var(--bone-dim)" }}>
          Nothing lives at {path ? <span className="mono break-all" style={{ color: "var(--bone)" }}>{path}</span> : "this address"}, on Unichain, Base or Lasna. The
          market is still where you left it.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link href="/app" className="btn-brutal">
            Open the app <span aria-hidden>→</span>
          </Link>
          <Link href="/" className="btn-ghost">
            Back to the site
          </Link>
        </div>

        <nav aria-label="App screens" className="mt-12">
          <p className="kicker mb-3 !text-[0.62rem]">Or jump to</p>
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {SCREENS.map((s) => (
              <li key={s.href}>
                <Link href={s.href} className="mono text-sm underline underline-offset-4 transition-colors hover:!text-[var(--rift)]">
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </main>

      <footer className="relative z-10 border-t" style={{ borderColor: "var(--line)" }}>
        <div className="kicker mx-auto flex max-w-[1440px] flex-wrap justify-between gap-4 px-4 py-6 sm:px-6 lg:px-12">
          <span>Rift · testnet demo</span>
          <span>Error 404</span>
        </div>
      </footer>
    </div>
  );
}
