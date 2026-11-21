import { NextResponse } from "next/server";

import { runnerStatus } from "@/lib/agent/autopilot";
import { verifySession } from "@/lib/agent/guard";
import { DEFAULT_RULES, MIN_GOAL_MINUTES, parseRules, type AutopilotRules, type LogEntry } from "@/lib/agent/rules";
import { autopilotStore, storeKind } from "@/lib/agent/store";
import type { Session } from "@/lib/agent/types";
import { vaultAddressOf } from "@/lib/agent/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type RulesResponse = {
  rules: AutopilotRules;
  saved: boolean;
  log: LogEntry[];
  runner: ReturnType<typeof runnerStatus>;
  store: "postgres" | "file";
  minGoalMinutes: number;
};

const minGoal = () => Number(process.env.AUTOPILOT_MIN_GOAL_MINUTES ?? MIN_GOAL_MINUTES);

/**
 * Read or change the caller's standing autopilot rules, and read the background action log.
 * Body: { session, op: "get" } or { session, op: "set", rules }. Both need a wallet-signed session: rules
 * steer what the agent does with the vault, and the log is the owner's own history.
 */
export async function POST(req: Request) {
  let body: { session?: Session; op?: string; rules?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const owner = await verifySession(body.session);
  if (!owner) return NextResponse.json({ error: "Sign the agent session in your wallet first.", needSession: true }, { status: 401 });
  const key = owner.toLowerCase();
  const store = autopilotStore();

  try {
    if (body.op === "set") {
      const vault = await vaultAddressOf(owner);
      if (!vault) return NextResponse.json({ error: "Create an agent vault first." }, { status: 400 });
      let rules: AutopilotRules;
      try {
        rules = parseRules(body.rules, minGoal());
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid rules." }, { status: 400 });
      }
      const prev = await store.get(key);
      await store.put({ owner: key, vault: vault.toLowerCase(), rules, goalLastRun: prev?.goalLastRun ?? 0, updatedAt: Math.floor(Date.now() / 1000) });
    } else if (body.op !== "get") {
      return NextResponse.json({ error: "op must be get or set." }, { status: 400 });
    }
    const [s, log] = await Promise.all([store.get(key), store.recent(key, 30)]);
    const res: RulesResponse = { rules: s?.rules ?? DEFAULT_RULES, saved: !!s, log, runner: runnerStatus(), store: storeKind(), minGoalMinutes: minGoal() };
    return NextResponse.json(res);
  } catch (e) {
    console.error("autopilot rules", e);
    return NextResponse.json({ error: "Couldn't reach the rules store. Try again." }, { status: 503 });
  }
}
