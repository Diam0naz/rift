"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** The Rift wordmark: "RIFT" in the display face with the red fault-line slash. Links home. */
export function Logo({ className = "text-2xl" }: { className?: string }) {
  return (
    <Link href="/" className={`display tracking-tight ${className}`} aria-label="Rift home">
      Rift<span style={{ color: "var(--rift)" }}>/</span>
    </Link>
  );
}

type Theme = "auto" | "light" | "dark";
const THEME_KEY = "rift:landing-theme";

/** Auto follows the OS; light/dark pin it. Remembered per browser, and fine if storage is unavailable. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("auto");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") setTheme(saved);
    } catch {
      // Storage blocked: stay on auto.
    }
  }, []);
  const cycle = () => {
    const next: Theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    setTheme(next);
    try {
      if (next === "auto") window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
  };
  return [theme, cycle];
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const label = theme === "auto" ? "Auto" : theme === "light" ? "Light" : "Dark";
  return (
    <button
      type="button"
      onClick={onToggle}
      className="kicker flex items-center gap-2 border px-3 py-2 hover:text-[var(--bone)]"
      style={{ borderColor: "var(--line-strong)" }}
      aria-label={`Theme: ${label}. Click to change.`}
      title="Theme: auto follows your system"
    >
      <span
        aria-hidden
        className="inline-block h-3 w-3 rounded-full border"
        style={{
          borderColor: "var(--bone)",
          background: theme === "auto" ? "linear-gradient(90deg, var(--bone) 50%, transparent 50%)" : theme === "dark" ? "var(--bone)" : "transparent",
        }}
      />
      {label}
    </button>
  );
}

/** The red live-figures band from the site. Content is duplicated once so the scroll loops seamlessly. */
export function Ticker({ items, tilt = false }: { items: [string, string][]; tilt?: boolean }) {
  return (
    <div
      className={`relative z-10 border-y py-3 ${tilt ? "-rotate-1 py-4" : ""}`}
      style={{ borderColor: "var(--line-strong)", background: "var(--rift)", color: "var(--on-rift)" }}
    >
      <div className="overflow-hidden" aria-label="Live market figures">
        <div className="ticker">
          {[0, 1].map((dup) => (
            <div key={dup} className="flex shrink-0" aria-hidden={dup === 1}>
              {items.map(([k, v]) => (
                <span key={k + dup} className="mono flex items-center gap-3 whitespace-nowrap px-8 text-sm font-medium uppercase">
                  <span className="opacity-60">{k}</span>
                  <span className="text-base font-bold">{v}</span>
                  <span aria-hidden>■</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
