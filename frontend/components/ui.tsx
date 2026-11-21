import type { ReactNode } from "react";

import type { Level } from "@/lib/risk";

/** Mid-ground panel in the site's language: hard edges, hairlines, a numbered mono title. */
export function Card({
  title,
  subtitle,
  right,
  children,
  className = "",
  index,
  ticks = false,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Section number shown before the title, e.g. "03". */
  index?: string;
  /** Red corner ticks, for the panels that matter most. */
  ticks?: boolean;
}) {
  return (
    <section className={`app-panel min-w-0 p-5 sm:p-6 ${ticks ? "corner-ticks" : ""} ${className}`}>
      <header className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="kicker !text-[0.7rem] !text-[var(--bone)]">
            {index && <span style={{ color: "var(--rift)" }}>{index} / </span>}
            {title}
          </h2>
          {subtitle && <p className="mt-1.5 text-xs leading-relaxed text-muted">{subtitle}</p>}
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
      <div className="kicker !text-[0.62rem]">{label}</div>
      <div className={`num mt-1 truncate text-lg font-medium ${color}`}>{value}</div>
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
    <span
      className={`num inline-flex items-center gap-1 whitespace-nowrap border px-2 py-0.5 text-[0.65rem] uppercase tracking-[0.12em] ${styles}`}
    >
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
    <div className="relative h-2.5 w-full overflow-hidden bg-panel-2" role="meter" aria-label={label}
      aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <div className={`h-full ${fill} transition-[width] duration-500`} style={{ width: `${w}%` }} />
      {marker !== undefined && (
        <div className="absolute top-0 h-full w-0.5 bg-text/70" style={{ left: `${Math.min(1, marker / max) * 100}%` }} />
      )}
    </div>
  );
}

export function Skeleton({ className = "h-5 w-24" }: { className?: string }) {
  return <div className={`app-panel animate-pulse ${className}`} />;
}

export function ErrorNote({ what }: { what: string }) {
  return <p className="text-xs text-bad">Couldn&apos;t read {what}. Retrying…</p>;
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="num text-accent underline-offset-4 hover:underline">
      {children}
    </a>
  );
}
