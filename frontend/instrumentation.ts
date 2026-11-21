/** Runs once when the server starts: launches the background autopilot (see lib/agent/autopilot.ts). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startBackground } = await import("./lib/agent/autopilot");
  startBackground();
}
