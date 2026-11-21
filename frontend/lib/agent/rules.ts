/** Standing autopilot rules, shared by the API (server) and the rules editor (browser). */

export type AutopilotRules = {
  /** Master switch for background actions on this vault (the vault's own pause still applies on top). */
  enabled: boolean;
  /** Close the vault's position when margin health falls below this multiple of maintenance (0 = off). */
  closeBelowHealth: number;
  /** Close when unrealized PnL after funding reaches this many tUSD (null = off). */
  takeProfit: number | null;
  /** Close when the loss after funding reaches this many tUSD (positive number; null = off). */
  stopLoss: number | null;
  /** Claim settled payouts and refunds into the vault. */
  autoClaim: boolean;
  /** Finish a pool withdrawal once it unlocks. */
  autoCompleteWithdraw: boolean;
  /** Keep cover on while the risk band is at or above `when`. */
  hedge: { enabled: boolean; when: "amber" | "red"; notional: number; days: number };
  /** A plain-language goal the model re-checks on a schedule, acting through the vault. */
  goal: { enabled: boolean; text: string; everyMinutes: number };
};

export const DEFAULT_RULES: AutopilotRules = {
  enabled: true,
  closeBelowHealth: 1.3,
  takeProfit: null,
  stopLoss: null,
  autoClaim: true,
  autoCompleteWithdraw: true,
  hedge: { enabled: false, when: "amber", notional: 1000, days: 1 },
  goal: { enabled: false, text: "", everyMinutes: 30 },
};

/** Lowest goal interval: each run is a model call, so it's bounded (tests lower it with AUTOPILOT_MIN_GOAL_MINUTES). */
export const MIN_GOAL_MINUTES = 15;

export type LogEntry = {
  at: number; // unix seconds
  rule: string; // guard | take_profit | stop_loss | claim | withdraw | hedge | goal
  summary: string;
  status: "done" | "rejected" | "skipped";
  tx?: string;
  reason?: string;
};

/** Validates and normalises rules from a client; throws a readable message on bad input. */
export function parseRules(x: unknown, minGoalMinutes = MIN_GOAL_MINUTES): AutopilotRules {
  const r = (x ?? {}) as Partial<AutopilotRules>;
  const num = (v: unknown, name: string, lo: number, hi: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}`);
    return n;
  };
  const opt = (v: unknown, name: string) => (v === null || v === undefined || v === "" ? null : num(v, name, 0, 10_000_000));
  const hedge = (r.hedge ?? DEFAULT_RULES.hedge) as AutopilotRules["hedge"];
  const goal = (r.goal ?? DEFAULT_RULES.goal) as AutopilotRules["goal"];
  const text = String(goal.text ?? "").slice(0, 1000);
  if (goal.enabled && !text.trim()) throw new Error("Write the goal, or turn it off");
  return {
    enabled: !!r.enabled,
    closeBelowHealth: num(r.closeBelowHealth ?? 0, "Liquidation guard", 0, 10),
    takeProfit: opt(r.takeProfit, "Take-profit"),
    stopLoss: opt(r.stopLoss, "Stop-loss"),
    autoClaim: !!r.autoClaim,
    autoCompleteWithdraw: !!r.autoCompleteWithdraw,
    hedge: {
      enabled: !!hedge.enabled,
      when: hedge.when === "red" ? "red" : "amber",
      notional: num(hedge.notional, "Hedge cover", 1, 10_000_000),
      days: num(hedge.days, "Hedge days", 0.01, 30),
    },
    goal: { enabled: !!goal.enabled, text, everyMinutes: num(goal.everyMinutes, "Goal interval (minutes)", minGoalMinutes, 24 * 60) },
  };
}
