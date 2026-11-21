import "server-only";

import { formatUnits, parseAbiItem, parseUnits, type Address } from "viem";

import { clients, LOG_CHUNK } from "../config";
import { marginHealth } from "../market";
import { readMarket, readReactive } from "../reads";
import { computeRiskBand } from "../risk";
import { MODELS, providerAvailable, runTurn } from "./llm";
import { DEFAULT_RULES, type AutopilotRules, type LogEntry } from "./rules";
import { callVault, type VaultCall } from "./signer";
import { autopilotStore } from "./store";
import type { AgentAction } from "./types";
import { factory, readVault } from "./vault";

/**
 * Background autopilot. Every tick, for every agent vault, it applies the owner's standing rules (or the
 * defaults: liquidation guard, auto-claim, auto-complete withdrawals) and acts with the agent key through
 * the vault, so the on-chain limits hold for everything it does. Deterministic rules first (cheap,
 * predictable); a plain-language goal, if the owner set one, runs the model on its own schedule.
 * Started with the server (instrumentation.ts); POST /api/agent/autopilot runs one tick on demand.
 */

const FACTORY_FROM = BigInt(process.env.AGENT_FACTORY_FROM_BLOCK ?? 68420466);
const created = parseAbiItem("event VaultCreated(address indexed owner, address vault)");
const rank = { green: 0, amber: 1, red: 2 } as const;

type RunnerState = {
  timer?: ReturnType<typeof setInterval>;
  intervalSec: number;
  busy: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  lastActions: number;
  owners: Address[];
  scannedTo: bigint;
};
const g = globalThis as { __riftAutopilot?: RunnerState };
const state = (g.__riftAutopilot ??= { intervalSec: 0, busy: false, lastRunAt: null, lastError: null, lastActions: 0, owners: [], scannedTo: FACTORY_FROM - 1n });

async function owners(): Promise<Address[]> {
  const c = clients.unichain;
  const head = await c.getBlockNumber();
  for (let from = state.scannedTo + 1n; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    const logs = await c.getLogs({ address: factory.address, event: created, fromBlock: from, toBlock: to });
    for (const l of logs) state.owners.push(l.args.owner as Address);
    state.scannedTo = to;
  }
  return state.owners;
}

export type TickReport = { owner: Address; vault: Address; actions: LogEntry[]; note?: string }[];

/** One pass over every vault. Safe to call concurrently with the timer: overlapping calls are skipped. */
export async function tick(): Promise<TickReport> {
  if (state.busy) return [];
  state.busy = true;
  try {
    const store = autopilotStore();
    const [list, stored, m, r] = await Promise.all([owners(), store.list(), readMarket(), readReactive()]);
    const band = computeRiskBand(m, r).level;
    const rulesOf = new Map(stored.map((s) => [s.owner, s]));
    const report: TickReport = [];
    for (const owner of list) {
      const s = rulesOf.get(owner.toLowerCase());
      const rules = s?.rules ?? DEFAULT_RULES;
      const entry = await runVault(owner, rules, s?.goalLastRun ?? 0, { m, band });
      if (entry) report.push(entry);
    }
    state.lastRunAt = Math.floor(Date.now() / 1000);
    state.lastError = null;
    state.lastActions = report.reduce((n, x) => n + x.actions.length, 0);
    return report;
  } catch (e) {
    state.lastError = e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw e;
  } finally {
    state.busy = false;
  }
}

async function runVault(
  owner: Address,
  rules: AutopilotRules,
  goalLastRun: number,
  ctx: { m: Awaited<ReturnType<typeof readMarket>>; band: keyof typeof rank },
): Promise<TickReport[number] | null> {
  if (!rules.enabled) return null;
  const v = await readVault(owner);
  if (!v) return null;
  if (v.paused || !v.agentActive) return { owner, vault: v.address, actions: [], note: v.paused ? "vault paused" : "agent revoked" };

  const store = autopilotStore();
  const key = owner.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const done: LogEntry[] = [];
  const act = async (rule: string, summary: string, call: VaultCall) => {
    const res = await callVault(v.address, call);
    const e: LogEntry = res.ok ? { at: now, rule, summary, status: "done", tx: res.tx } : { at: now, rule, summary, status: "rejected", reason: res.reason };
    await store.log(key, e);
    done.push(e);
    return res.ok;
  };

  // 1. The position: liquidation guard, then take-profit / stop-loss. At most one close per tick.
  if (v.position) {
    const p = v.position;
    const health = marginHealth(p.equity, p.size);
    const net = Number(formatUnits(p.pnl - p.funding, 18));
    const close: VaultCall = { fn: "closePosition", args: [] };
    if (rules.closeBelowHealth > 0 && health < rules.closeBelowHealth) {
      await act("guard", `Closed the ${p.isLong ? "long" : "short"}: margin health ${health.toFixed(2)}× fell below ${rules.closeBelowHealth}×`, close);
    } else if (rules.takeProfit !== null && net >= rules.takeProfit) {
      await act("take_profit", `Took profit: closed at ${net >= 0 ? "+" : ""}${net.toFixed(2)} tUSD (target ${rules.takeProfit})`, close);
    } else if (rules.stopLoss !== null && -net >= rules.stopLoss) {
      await act("stop_loss", `Stopped out: closed at ${net.toFixed(2)} tUSD (limit −${rules.stopLoss})`, close);
    }
  }

  // 2. Settled payouts and refunds sitting in the market for this vault.
  if (rules.autoClaim) {
    for (const pol of ctx.m.policies) {
      if (pol.buyer.toLowerCase() === v.address.toLowerCase() && pol.owed > 0n) {
        await act("claim", `Claimed ${Number(formatUnits(pol.owed, 18)).toFixed(2)} tUSD on policy #${pol.id}`, { fn: "claim", args: [pol.id] });
      }
    }
  }

  // 3. A pool withdrawal that has unlocked.
  if (rules.autoCompleteWithdraw && v.withdrawal && Number(v.withdrawal.unlockAt) <= now) {
    await act("withdraw", "Completed the unlocked pool withdrawal", { fn: "completeWithdraw", args: [] });
  }

  // 4. Keep cover while risk is up: only when the vault has none live and the market takes new risk.
  const liveCover = ctx.m.policies.some((pol) => pol.buyer.toLowerCase() === v.address.toLowerCase() && !pol.settled && Number(pol.expiry) > now);
  if (rules.hedge.enabled && rank[ctx.band] >= rank[rules.hedge.when] && !liveCover && !ctx.m.tripped) {
    const notional = parseUnits(String(rules.hedge.notional), 18);
    const seconds = BigInt(Math.round(rules.hedge.days * 86400));
    await act("hedge", `Risk band ${ctx.band}: bought ${rules.hedge.notional} tUSD of cover for ${rules.hedge.days} day(s)`, { fn: "buyProtection", args: [notional, seconds] });
  }

  // 5. The owner's plain-language goal, on its own schedule (a model call, so rarer than the rules).
  if (rules.goal.enabled && rules.goal.text.trim() && now - goalLastRun >= rules.goal.everyMinutes * 60) {
    await store.markGoalRun(key, now); // first, so a slow or failing run isn't retried every tick
    if (!providerAvailable("gemini")) {
      const e: LogEntry = { at: now, rule: "goal", summary: "Goal not checked: no model is configured on the server", status: "skipped" };
      await store.log(key, e);
      done.push(e);
    } else {
      const actions: AgentAction[] = [];
      try {
        const turn = await runTurn(
          "gemini",
          [],
          `Background check of the owner's standing goal. Act only if the goal calls for it right now; otherwise do nothing and say why in one sentence.\n\nGoal: ${rules.goal.text}`,
          { mode: "autopilot", account: owner, verified: owner, actions },
        );
        for (const a of actions) {
          const e: LogEntry = { at: now, rule: "goal", summary: a.summary, status: a.status === "done" ? "done" : "rejected", tx: a.tx, reason: a.reason };
          await store.log(key, e);
          done.push(e);
        }
        const note: LogEntry = { at: now, rule: "goal", summary: `${MODELS.gemini}: ${turn.reply.slice(0, 400)}`, status: actions.length ? "done" : "skipped" };
        await store.log(key, note);
        done.push(note);
      } catch (e) {
        const err: LogEntry = { at: now, rule: "goal", summary: "Goal check failed", status: "rejected", reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
        await store.log(key, err);
        done.push(err);
      }
    }
  }

  return { owner, vault: v.address, actions: done };
}

/** Starts the background timer once per server process (instrumentation.ts). 0 or unset key = off. */
export function startBackground() {
  const intervalSec = Number(process.env.AUTOPILOT_INTERVAL_SEC ?? 60);
  if (state.timer || !intervalSec || !process.env.AGENT_PRIVATE_KEY) return;
  state.intervalSec = intervalSec;
  const run = () =>
    tick().then(
      (rep) => {
        const n = rep.reduce((k, x) => k + x.actions.length, 0);
        if (n) console.log(`autopilot: ${n} action(s)`, JSON.stringify(rep.filter((x) => x.actions.length)));
      },
      (e) => console.error("autopilot tick failed:", e instanceof Error ? e.message.split("\n")[0] : e),
    );
  state.timer = setInterval(run, intervalSec * 1000);
  state.timer.unref?.();
  setTimeout(run, 5_000); // first pass shortly after boot
  console.log(`autopilot: running in the background every ${intervalSec}s`);
}

export const runnerStatus = () => ({
  running: !!state.timer,
  intervalSec: state.intervalSec,
  lastRunAt: state.lastRunAt,
  lastError: state.lastError,
  vaultsKnown: state.owners.length,
});
