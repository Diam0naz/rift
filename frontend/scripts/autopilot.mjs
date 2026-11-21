// Calls the autopilot tick every INTERVAL seconds. Usage:
//   AUTOPILOT_SECRET=… node scripts/autopilot.mjs [http://localhost:3000] [interval=60]
const [base = "http://localhost:3000", interval = "60"] = process.argv.slice(2);
const secret = process.env.AUTOPILOT_SECRET;
if (!secret) throw new Error("set AUTOPILOT_SECRET (the same value the app has)");

async function once() {
  try {
    const res = await fetch(`${base}/api/agent/autopilot`, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
    const body = await res.json();
    const acted = (body.report ?? []).filter((r) => r.action !== "none");
    console.log(new Date().toISOString(), res.status, `${body.vaults ?? 0} vault(s) with positions`, acted.length ? JSON.stringify(acted) : "");
  } catch (e) {
    console.error(new Date().toISOString(), "tick failed:", e.message);
  }
}
await once();
setInterval(once, Number(interval) * 1000);
