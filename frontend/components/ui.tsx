import type { ReactNode } from "react";

import type { Level } from "@/lib/risk";

export function Card({
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`min-w-0 rounded-xl border border-line bg-panel p-4 sm:p-5 ${className}`}>
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-text">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Level }) {
  const color = tone === "red" ? "text-bad" : tone === "amber" ? "text-warn" : tone === "green" ? "text-good" : "";
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className={`num mt-0.5 truncate text-lg font-medium ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

const dot: Record<Level, string> = { green: "bg-good", amber: "bg-warn", red: "bg-bad" };

export function LevelDot({ level }: { level: Level }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot[level]}`} aria-hidden />;
}

export function Pill({ children, tone }: { children: ReactNode; tone?: Level | "muted" }) {
  const styles =
    tone === "red"
      ? "border-bad/40 text-bad"
      : tone === "amber"
        ? "border-warn/40 text-warn"
        : tone === "green"
          ? "border-good/40 text-good"
          : "border-line text-muted";
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${styles}`}>
      {children}
    </span>
  );
}

/** Horizontal bar: `value` as a fraction of `max`, with an optional marker (e.g. the trip threshold). */
export function Bar({
  value,
  max,
  marker,
  tone = "green",
  label,
}: {
  value: number;
  max: number;
  marker?: number;
  tone?: Level;
  label?: string;
}) {
  const w = Math.max(0, Math.min(1, value / max)) * 100;
  const fill = tone === "red" ? "bg-bad" : tone === "amber" ? "bg-warn" : "bg-good";
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-panel-2" role="meter" aria-label={label}
      aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <div className={`h-full ${fill} transition-[width] duration-500`} style={{ width: `${w}%` }} />
      {marker !== undefined && (
        <div className="absolute top-0 h-full w-0.5 bg-text/70" style={{ left: `${Math.min(1, marker / max) * 100}%` }} />
      )}
    </div>
  );
}

export function Skeleton({ className = "h-5 w-24" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-panel-2 ${className}`} />;
}

export function ErrorNote({ what }: { what: string }) {
  return <p className="text-xs text-bad">Couldn&apos;t read {what}. Retrying…</p>;
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="num text-accent hover:underline">
      {children}
    </a>
  );
}
