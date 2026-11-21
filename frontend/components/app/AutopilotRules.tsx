"use client";

import { useCallback, useEffect, useState } from "react";

import type { AutopilotRules as Rules, LogEntry } from "@/lib/agent/rules";
import type { useAgentSession } from "@/lib/agent/session";
import { explorers } from "@/lib/config";
import { shortHex } from "@/lib/format";

import { Card } from "../ui";
import { Field } from "./bits";

type Res = {
  rules: Rules;
  saved: boolean;
  log: LogEntry[];
  runner: { running: boolean; intervalSec: number; lastRunAt: number | null; lastError: string | null };
  store: "postgres" | "file";
  minGoalMinutes: number;
};

const ago = (t: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`;
};

/**
 * The vault's standing orders for the background autopilot, and what it has done. Everything it does goes
 * through the vault, so the on-chain limits still apply; these rules decide *when* it acts.
 */
export function AutopilotRules({ session }: { session: ReturnType<typeof useAgentSession> }) {
  const [data, setData] = useState<Res | null>(null);
  const [draft, setDraft] = useState<Rules | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const s = session.session;

  const call = useCallback(
    async (op: "get" | "set", rules?: Rules) => {
      if (!s) return;
      const res = await fetch("/api/agent/rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: s, op, rules }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Failed (${res.status})`);
      setData(body as Res);
      return body as Res;
    },
    [s],
  );

  // Load once signed, then refresh the log and runner status every 15 s.
  useEffect(() => {
    if (!s) return;
    let live = true;
    const load = () => call("get").then((r) => live && r && setDraft((d) => d ?? r.rules)).catch((e) => live && setMsg({ tone: "warn", text: e.message }));
    void load();
    const t = window.setInterval(() => void call("get").catch(() => {}), 15_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [s, call]);

  if (!s) {
    return (
      <Card index="D" title="Autopilot rules" subtitle="Standing orders the agent runs in the background">
        <p className="mb-3 text-sm text-muted">Sign the agent session to see and set your vault&apos;s background rules.</p>
        <button type="button" className="btn-ghost btn-sm" disabled={session.signing} onClick={() => void session.sign()}>
          {session.signing ? "Check your wallet…" : "Sign session"}
        </button>
      </Card>
    );
  }
  if (!data || !draft) return <Card index="D" title="Autopilot rules"><p className="text-sm text-muted" role="status">Loading…</p></Card>;

  const set = (patch: Partial<Rules>) => setDraft({ ...draft, ...patch });
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await call("set", draft);
      if (r) setDraft(r.rules);
      setMsg({ tone: "ok", text: "Saved. The background autopilot uses these from its next pass." });
    } catch (e) {
      setMsg({ tone: "warn", text: e instanceof Error ? e.message : "Couldn't save." });
    } finally {
      setBusy(false);
    }
  };
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
  const r = data.runner;

  return (
    <Card
      index="D"
      ticks
      title="Autopilot rules"
      subtitle={r.running ? `Running every ${r.intervalSec}s${r.lastRunAt ? ` · last pass ${ago(r.lastRunAt)}` : ""}` : "Background runner is off on this server"}
      right={<span className="mono text-[0.62rem] uppercase tracking-[0.14em]" style={{ color: draft.enabled && r.running ? "var(--ok)" : "var(--warn)" }}>{draft.enabled ? (r.running ? "on" : "idle") : "off"}</span>}
    >
      {r.lastError && <p className="mb-3 text-xs" style={{ color: "var(--warn)" }}>Last pass failed: {r.lastError}</p>}
      <form
        className="space-y-3"
        aria-label="Autopilot rules"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Toggle label="Run my rules in the background" checked={draft.enabled} onChange={(v) => set({ enabled: v })} />
        <div className="grid grid-cols-3 gap-2">
          <Field label="Guard below ×" hint="0 = off">
            <input className="app-input mono" inputMode="decimal" value={draft.closeBelowHealth} onChange={(e) => set({ closeBelowHealth: Number(e.target.value) })} />
          </Field>
          <Field label="Take profit">
            <input className="app-input mono" inputMode="decimal" placeholder="off" value={draft.takeProfit ?? ""} onChange={(e) => set({ takeProfit: numOrNull(e.target.value) })} />
          </Field>
          <Field label="Stop loss">
            <input className="app-input mono" inputMode="decimal" placeholder="off" value={draft.stopLoss ?? ""} onChange={(e) => set({ stopLoss: numOrNull(e.target.value) })} />
          </Field>
        </div>
        <Toggle label="Claim payouts and refunds automatically" checked={draft.autoClaim} onChange={(v) => set({ autoClaim: v })} />
        <Toggle label="Finish pool withdrawals when they unlock" checked={draft.autoCompleteWithdraw} onChange={(v) => set({ autoCompleteWithdraw: v })} />

        <div className="border-t pt-3" style={{ borderColor: "var(--line)" }}>
          <Toggle label="Auto-hedge: keep cover while risk is up" checked={draft.hedge.enabled} onChange={(v) => set({ hedge: { ...draft.hedge, enabled: v } })} />
          {draft.hedge.enabled && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Field label="When band is">
                <select className="app-input" value={draft.hedge.when} onChange={(e) => set({ hedge: { ...draft.hedge, when: e.target.value as "amber" | "red" } })}>
                  <option value="amber">amber+</option>
                  <option value="red">red</option>
                </select>
              </Field>
              <Field label="Cover tUSD">
                <input className="app-input mono" inputMode="decimal" value={draft.hedge.notional} onChange={(e) => set({ hedge: { ...draft.hedge, notional: Number(e.target.value) } })} />
              </Field>
              <Field label="Days">
                <input className="app-input mono" inputMode="decimal" value={draft.hedge.days} onChange={(e) => set({ hedge: { ...draft.hedge, days: Number(e.target.value) } })} />
              </Field>
            </div>
          )}
        </div>

        <div className="border-t pt-3" style={{ borderColor: "var(--line)" }}>
          <Toggle label="Goal: let the model check a standing goal" checked={draft.goal.enabled} onChange={(v) => set({ goal: { ...draft.goal, enabled: v } })} />
          {draft.goal.enabled && (
            <div className="mt-2 space-y-2">
              <Field label="Goal, in your words">
                <textarea
                  className="app-input min-h-[4.5rem] w-full"
                  maxLength={1000}
                  placeholder="e.g. Keep about 1,000 tUSD in the pool, and close any position that loses more than 50 tUSD"
                  value={draft.goal.text}
                  onChange={(e) => set({ goal: { ...draft.goal, text: e.target.value } })}
                />
              </Field>
              <Field label={`Check every (min, ≥ ${data.minGoalMinutes})`}>
                <input className="app-input mono" inputMode="numeric" value={draft.goal.everyMinutes} onChange={(e) => set({ goal: { ...draft.goal, everyMinutes: Number(e.target.value) } })} />
              </Field>
            </div>
          )}
        </div>

        <button type="submit" className="btn-brutal btn-sm" disabled={busy}>
          {busy ? "Saving…" : "Save rules"}
        </button>
        {msg && (
          <p className="text-xs" role="status" style={{ color: msg.tone === "ok" ? "var(--ok)" : "var(--warn)" }}>
            {msg.text}
          </p>
        )}
        {!data.saved && <p className="text-xs text-muted">Not saved yet: the defaults (guard at 1.3×, auto-claim, auto-withdraw) apply.</p>}
      </form>

      <div className="mt-5 border-t pt-3" style={{ borderColor: "var(--line)" }}>
        <div className="kicker mb-2 !text-[0.6rem]">Background activity</div>
        {data.log.length === 0 ? (
          <p className="text-xs text-muted">Nothing yet. Actions the autopilot takes on its own show up here.</p>
        ) : (
          <ol className="space-y-2" aria-label="Autopilot log">
            {data.log.map((e, i) => (
              <li key={i} className="text-xs" data-log-status={e.status}>
                <span className="mono" style={{ color: e.status === "done" ? "var(--ok)" : e.status === "rejected" ? "var(--rift)" : "var(--bone-dim)" }}>
                  {e.rule} · {e.status}
                </span>{" "}
                <span className="text-muted">{ago(e.at)}</span>
                <div className="[overflow-wrap:anywhere]">{e.summary}</div>
                {e.reason && <div style={{ color: "var(--warn)" }}>{e.reason}</div>}
                {e.tx && (
                  <a className="mono underline underline-offset-4" href={`${explorers.unichain}/tx/${e.tx}`} target="_blank" rel="noreferrer">
                    {shortHex(e.tx, 5)} ↗
                  </a>
                )}
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-[0.65rem] text-muted">Stored in {data.store === "postgres" ? "Neon Postgres" : "a local file"} on the server.</p>
      </div>
    </Card>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
