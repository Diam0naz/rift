"use client";

import type { ReactNode } from "react";

/**
 * A labelled control. Use `group` for button sets (segmented controls): a <label> would forward clicks on its
 * text to the first button inside it.
 */
export function Field({ label, hint, children, group = false }: { label: string; hint?: ReactNode; children: ReactNode; group?: boolean }) {
  const inner = (
    <>
      <span className="kicker mb-2 block !text-[0.62rem]">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </>
  );
  return group ? (
    <div className="block" role="group" aria-label={label}>
      {inner}
    </div>
  ) : (
    <label className="block">{inner}</label>
  );
}

/** A condition that blocks an action, said plainly; amber for "not now", red for "closed". */
export function Banner({ tone = "warn", children }: { tone?: "warn" | "bad" | "info"; children: ReactNode }) {
  const color = tone === "bad" ? "var(--rift)" : tone === "info" ? "var(--cold)" : "var(--warn)";
  return (
    <div className="app-panel mb-6 flex items-start gap-3 px-5 py-4 text-sm" style={{ borderColor: color }} role="status">
      <span className="mt-1.5 inline-block h-2 w-2 shrink-0" style={{ background: color }} aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** Two-to-four way segmented control in the site's style. */
export function Segmented<T extends string | number | boolean>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; tone?: "ok" | "bad" }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex border" style={{ borderColor: "var(--line-strong)" }} role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        const accent = o.tone === "ok" ? "var(--ok)" : o.tone === "bad" ? "var(--rift)" : "var(--bone)";
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className="kicker flex-1 whitespace-nowrap px-2 py-3 hover:!text-[var(--bone)]"
            style={on ? { background: "var(--ink-3)", color: accent, boxShadow: `inset 0 -3px 0 ${accent}` } : undefined}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Label/value rows for review and detail panels. */
export function Rows({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="divide-y" style={{ borderColor: "var(--line)" }}>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex justify-between gap-4 py-2.5 text-sm" style={{ borderColor: "var(--line)" }}>
          <dt className="text-muted">{k}</dt>
          <dd className="mono text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
