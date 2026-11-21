import { NextResponse } from "next/server";

import { runnerStatus, tick } from "@/lib/agent/autopilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs one autopilot pass now. The server already runs it in the background (AUTOPILOT_INTERVAL_SEC); this
 * is for external schedulers (cron) on hosts that can't keep a timer alive, and for tests.
 */
export async function POST(req: Request) {
  const secret = process.env.AUTOPILOT_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const report = await tick();
    return NextResponse.json({ ms: Date.now() - startedAt, runner: runnerStatus(), vaults: report.length, report });
  } catch (e) {
    // Usually the RPC (rate limit, DNS); the next pass retries from where the vault scan stopped.
    console.error("autopilot tick failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message.split("\n")[0] : String(e) }, { status: 502 });
  }
}
