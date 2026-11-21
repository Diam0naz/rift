"use client";

import { explorers } from "@/lib/config";
import { shortHex } from "@/lib/format";
import type { FlowStep, StepState, TxState } from "@/lib/tx";

const phaseText: Record<string, string> = {
  waiting: "Waiting",
  skipped: "Not needed",
  simulating: "Checking…",
  signing: "Confirm in your wallet…",
  pending: "Submitted, waiting for Unichain…",
  done: "Confirmed",
  failed: "Failed",
};

function TxLink({ hash }: { hash?: `0x${string}` }) {
  if (!hash) return null;
  return (
    <a
      href={`${explorers.unichain}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="mono text-xs underline underline-offset-4 opacity-80 hover:opacity-100"
    >
      {shortHex(hash, 4)} ↗
    </a>
  );
}

/**
 * Numbered steps for a multi-signature flow (e.g. approve, then buy): what each signature does, where it is,
 * its tx link, and a readable error with retry. Announced to assistive tech via aria-live.
 */
export function TxFlowView({
  steps,
  states,
  onRetry,
  running,
}: {
  steps: FlowStep[];
  states: StepState[];
  onRetry: () => void;
  running: boolean;
}) {
  if (steps.length === 0) return null;
  return (
    <ol className="border" style={{ borderColor: "var(--line-strong)" }} aria-live="polite">
      {steps.map((step, i) => {
        const st = states[i] ?? { status: "waiting" };
        const active = st.status === "simulating" || st.status === "signing" || st.status === "pending";
        const color =
          st.status === "done"
            ? "var(--ok)"
            : st.status === "failed"
              ? "var(--rift)"
              : active
                ? "var(--bone)"
                : "var(--bone-dim)";
        return (
          <li
            key={step.label}
            className="flex gap-4 border-b p-4 last:border-b-0"
            style={{ borderColor: "var(--line)", background: active ? "var(--ink-3)" : undefined }}
            data-step-status={st.status}
          >
            <span className="display text-2xl leading-none" style={{ color, textTransform: "none" }}>
              {st.status === "done" ? "✓" : String(i + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="kicker !text-[var(--bone)]">{step.label}</span>
                <span className="mono text-xs" style={{ color }}>
                  {phaseText[st.status]}
                  {st.status === "done" && ` · block ${st.block.toString()}`}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted">{step.explain}</p>
              {st.status === "failed" && (
                <p className="mt-2 text-sm" style={{ color: "var(--rift)" }} role="alert">
                  {st.message}
                </p>
              )}
              <div className="mt-2 flex items-center gap-4">
                {"hash" in st && <TxLink hash={st.hash} />}
                {st.status === "failed" && !running && (
                  <button type="button" className="btn-ghost btn-sm" onClick={onRetry}>
                    Retry from here
                  </button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** One-line status for single actions (claim, close, faucet, withdraw...). */
export function TxStatus({ state }: { state: TxState }) {
  if (state.status === "idle") return null;
  let text: string;
  switch (state.status) {
    case "simulating":
      text = `${state.label}: checking…`;
      break;
    case "signing":
      text = `${state.label}: confirm in your wallet…`;
      break;
    case "pending":
      text = `${state.label}: waiting for Unichain…`;
      break;
    case "success":
      text = `${state.label}: done.`;
      break;
    case "error":
      text = `${state.label} failed: ${state.message}`;
      break;
  }
  const color = state.status === "error" ? "var(--rift)" : state.status === "success" ? "var(--ok)" : "var(--bone-dim)";
  return (
    <p className="text-sm" style={{ color }} role="status" aria-live="polite" data-tx-status={state.status}>
      {text} <TxLink hash={"hash" in state ? state.hash : undefined} />
    </p>
  );
}
