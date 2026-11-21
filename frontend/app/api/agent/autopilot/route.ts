import { NextResponse } from "next/server";

import { runnerStatus, tick } from "@/lib/agent/autopilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs one autopilot pass now. A long-running server already runs it in the background
 * (AUTOPILOT_INTERVAL_SEC); serverless hosts like Vercel can't keep that timer alive, so a scheduler calls
 * this instead (Vercel Cron: GET with CRON_SECRET; anything else: POST with AUTOPILOT_SECRET).
 */
export const maxDuration = 60;

/** AUTOPILOT_SECRET for your own scheduler; CRON_SECRET is what Vercel Cron sends (as a Bearer token, via GET). */
function authorized(req: Request) {
  const auth = req.headers.get("authorization");
  return [process.env.AUTOPILOT_SECRET, process.env.CRON_SECRET].some((s) => !!s && auth === `Bearer ${s}`);
}

export const GET = (req: Request) => POST(req);

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
