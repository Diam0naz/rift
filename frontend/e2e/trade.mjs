// End-to-end drive of every /app screen over the Chrome DevTools Protocol, with a mock wallet on an anvil fork.
// Usage: node e2e/trade.mjs <url> <outDir>   (run via e2e/run.sh, which sets up the fork and the indexer)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [url, outDir] = process.argv.slice(2);
const profile = mkdtempSync(join(outDir, "cdp-"));
const chrome = spawn("google-chrome", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--window-size=1300,1800", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((res, rej) => {
  let buf = "";
  chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  setTimeout(() => rej(new Error("chrome did not start")), 20000);
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map(); const events = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); });
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
const s = (m, p) => send(m, p, sessionId);
await s("Runtime.enable"); await s("Log.enable"); await s("Page.enable");
await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await s("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1800, deviceScaleFactor: 1, mobile: false });

const evalJs = async (expr) => (await s("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const step = (msg) => { log.push(msg); console.log(msg); };

async function waitText(t, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evalJs(`document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(t.toLowerCase())})`)) return true;
    await sleep(400);
  }
  throw new Error(`timed out waiting for text: ${t}`);
}
async function waitAnyStatus(prefix, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await evalJs(`[...document.querySelectorAll('[role=status]')].map(e => e.textContent.trim()).find(t => t.startsWith(${JSON.stringify(prefix)}) && (t.includes('done.') || t.includes('failed')))`);
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`timed out waiting for status: ${prefix}`);
}
async function click(text, ms = 30000) {
  // textContent ignores CSS text-transform (the app uppercases buttons and tabs); compare case-insensitively.
  // Waits for the button to exist and be enabled, as a person would (data loads after the label renders).
  const end = Date.now() + ms;
  let last = "missing";
  while (Date.now() < end) {
    last = await evalJs(`(() => { const want = ${JSON.stringify(text.toLowerCase())}; const b = [...document.querySelectorAll('button')].find(b => { const t = b.textContent.trim().toLowerCase(); return t === want || t.startsWith(want); }); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'ok'; })()`);
    if (last === "ok") return;
    await sleep(400);
  }
  throw new Error(`button "${text}": ${last}`);
}
async function fill(label, value) {
  const ok = await evalJs(`(() => {
    const lab = [...document.querySelectorAll('label')].find(l => l.textContent.trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}));
    const el = lab && lab.querySelector('input,select,textarea'); if (!el) return 'missing';
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    return 'ok'; })()`);
  if (ok !== "ok") throw new Error(`field "${label}": ${ok}`);
}
async function shot(name) {
  const r = await s("Page.captureScreenshot", { format: "png" });
  const f = join(outDir, `${name}.png`); writeFileSync(f, Buffer.from(r.result.data, "base64")); step(`  screenshot ${f}`);
}
async function expectDone(prefix) {
  const st = await waitAnyStatus(prefix);
  if (!st.includes("done.")) throw new Error(`${prefix} -> ${st}`);
  step(`  ✓ ${st}`);
}

/** Types into the agent chat and sends; waits for the reply (or a note) to land. */
async function chat(text) {
  const before = await evalJs(`document.querySelectorAll('[data-action-status], .kicker').length`);
  const ok = await evalJs(`(() => { const el = document.getElementById('agent-input'); if (!el) return 'missing';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
  if (ok !== "ok") throw new Error(`chat input: ${ok}`);
  await click("Send");
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const busy = await evalJs(`document.body.innerText.includes('is reading the chain')`);
    const n = await evalJs(`document.querySelectorAll('[data-action-status], .kicker').length`);
    if (!busy && n > before) return;
    await sleep(400);
  }
  throw new Error(`no reply to: ${text}`);
}
/** Waits for the newest agent action card to reach `status`; returns its reason text (if any). */
async function expectAction(status, ms = 120000) {
  const end = Date.now() + ms;
  let last = "none";
  while (Date.now() < end) {
    last = await evalJs(`(() => { const all = [...document.querySelectorAll('[data-action-status]')]; const a = all[all.length - 1]; return a ? a.dataset.actionStatus + '|' + a.innerText : 'none'; })()`);
    if (last.startsWith(status + "|")) return last.split("|").slice(1).join("|");
    await sleep(500);
  }
  const notes = await evalJs(`[...document.querySelectorAll('.mono')].map(e => e.innerText).filter(t => t.length > 20).slice(-3).join(' / ')`);
  throw new Error(`agent action not ${status}: ${last.slice(0, 200)} | ${notes.slice(0, 300)}`);
}

/** Clicks the <label> whose text starts with `text` (toggles its checkbox). */
async function clickLabel(text) {
  const ok = await evalJs(`(() => { const l = [...document.querySelectorAll('label')].find(l => l.textContent.trim().toLowerCase().startsWith(${JSON.stringify(text.toLowerCase())})); if (!l) return 'missing'; l.click(); return 'ok'; })()`);
  if (ok !== "ok") throw new Error(`label "${text}": ${ok}`);
}

async function clickLink(text) {
  const ok = await evalJs(`(() => { const want = ${JSON.stringify(text.toLowerCase())}; const a = [...document.querySelectorAll('nav a')].find(a => a.textContent.trim().toLowerCase() === want); if (!a) return 'missing'; a.click(); return 'ok'; })()`);
  if (ok !== "ok") throw new Error(`link "${text}": ${ok}`);
}
/** Waits for a TxFlow (numbered steps) to finish; returns the failure message if a step failed. */
async function waitFlow(ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await evalJs(`(() => { const steps = [...document.querySelectorAll('[data-step-status]')]; if (!steps.length) return null; const st = steps.map(e => e.dataset.stepStatus); if (st.includes('failed')) { const el = steps[st.indexOf('failed')].querySelector('[role=alert]'); return { failed: el ? el.textContent.trim() : 'failed' }; } if (st.every(x => x === 'done' || x === 'skipped')) return { done: st }; return null; })()`);
    if (r) return r;
    await sleep(500);
  }
  throw new Error("timed out waiting for the transaction flow");
}
async function expectFlowDone(label) {
  const r = await waitFlow();
  if (r.failed) throw new Error(`${label} flow failed: ${r.failed}`);
  step(`  ✓ ${label}: ${r.done.join(" → ")}`);
}

let failed = null;
try {
  step("0. overview loads live state");
  await s("Page.navigate", { url });
  await waitText("Risk band");
  await waitText("Test wallet");
  step("1. connect test wallet and get tUSD");
  await click("Test wallet");
  await waitText("test tUSD");
  await click("Get 10,000 test tUSD");
  await expectDone("Faucet");
  await click("Add tUSD to wallet");
  await waitText("tUSD added");
  step("  ✓ Add tUSD to wallet: added");

  step("2. protect: approve + buy 1,000 cover for 1 day (two-step flow)");
  await clickLink("Protect");
  await waitText("Holdings on Base");
  await sleep(2500); // quote
  await click("Buy cover");
  await expectFlowDone("Buy cover");
  await waitText("Starts in");
  await shot("e2e-1-protect");

  step("3. protect: oversized order fails with a readable reason, before signing");
  await fill("Cover amount", "5000000");
  await sleep(2500);
  await click("Buy cover");
  const bad = await waitFlow();
  if (!bad.failed) throw new Error("expected the oversized order to fail");
  if (/signature: 0x|reverted with/.test(bad.failed)) throw new Error(`revert reason not decoded: ${bad.failed}`);
  step(`  ✓ failed as expected: ${bad.failed}`);

  step("4. underwrite: deposit 1,000, request 50%, cancel");
  await clickLink("Underwrite");
  await waitText("Your shares are worth");
  await click("Deposit");
  await expectFlowDone("Deposit");
  await click("Request 50%");
  await expectDone("Request 50%");
  await waitText("unlocks in");
  await shot("e2e-2-underwrite");
  await click("Cancel");
  await expectDone("Cancel withdrawal");

  step("5. trade: open 1,000 long at 5x, then close");
  await clickLink("Trade");
  await waitText("New position");
  await click("5×");
  await click("Open long");
  // On success the ticket (and its step list) is replaced by the position card, so wait for that,
  // while still surfacing a failed step if one appears first.
  {
    const end = Date.now() + 120000;
    let opened = false;
    while (Date.now() < end && !opened) {
      const r = await evalJs(`(() => { if (document.body.textContent.includes('Margin health')) return 'open'; const f = document.querySelector('[data-step-status=failed] [role=alert]'); return f ? 'failed: ' + f.textContent.trim() : null; })()`);
      if (r === "open") opened = true;
      else if (r) throw new Error(`Open long ${r}`);
      else await sleep(500);
    }
    if (!opened) throw new Error("timed out waiting for the position to open");
    step("  ✓ Open long: position card shown");
  }
  await shot("e2e-3-trade");
  await click("Close position");
  // On success the position card is replaced by a fresh order ticket; a failure leaves an error status.
  {
    const end = Date.now() + 120000;
    let closed = false;
    while (Date.now() < end && !closed) {
      const r = await evalJs(`(() => { if (document.body.textContent.includes('New position')) return 'closed'; const st = [...document.querySelectorAll('[role=status]')].map(e => e.textContent).find(t => t.startsWith('Close position failed')); return st || null; })()`);
      if (r === "closed") closed = true;
      else if (r) throw new Error(r);
      else await sleep(500);
    }
    if (!closed) throw new Error("timed out waiting for the position to close");
    step("  ✓ Close position: ticket back, position settled");
  }

  step("6. activity: this wallet's cover, deposit and trades are listed");
  await clickLink("Activity");
  for (const t of ["Bought cover", "Deposited", "Cancelled withdrawal", "Opened long", "Closed position"]) await waitText(t, 90000);
  step("  ✓ Activity lists cover, pool and perp events");
  await shot("e2e-4-activity");

  step("7. history: indexer live, totals and the event log include this run");
  await clickLink("History");
  await waitText("Unichain Sepolia");
  await waitText("Long opened", 90000);
  await waitText("Cover #", 30000);
  const live = await evalJs(`document.querySelector('[aria-label="Indexer status"]')?.textContent ?? ''`);
  if (!/live/i.test(live)) throw new Error(`indexer not live on History: ${live.slice(0, 200)}`);
  step("  ✓ History: indexer live, run's events in the log");
  await shot("e2e-5-history");

  step("8. monitor: three-chain watch and the drain sequence render");
  await clickLink("Monitor");
  await waitText("Drain to payout");
  step("  ✓ Monitor rendered");

  step("9. agent: create an agent vault (default limits: 1,000/day, 5,000 max size, 5x) and fund it");
  await clickLink("Agent");
  await waitText("Create your agent vault");
  await click("Create vault");
  await expectDone("Create vault");
  await waitText("agent on", 30000);
  await click("Fund");
  await expectDone("Fund vault");
  await shot("e2e-6-agent-vault");

  step("10. autopilot: the agent opens a position from the vault with its own key");
  await click("Autopilot");
  await chat("open a 1000 tUSD long at 2x");
  await expectAction("done");
  step("  ✓ position opened through the vault (session signed in the wallet)");

  step("11. contract-enforced limit: a deposit over today's spend cap is rejected on-chain");
  await chat("deposit 900");
  const reason = await expectAction("rejected");
  if (!/daily spend limit/i.test(reason)) throw new Error(`expected the spend-limit reason, got: ${reason}`);
  step(`  ✓ rejected: ${reason.split("\n").find((l) => /limit/i.test(l))}`);

  step("12. agent payment: a premium (Claude) message is charged from the vault under its fee cap");
  await click("Claude");
  await chat("how is the market");
  await waitText("premium fee", 90000);
  step("  ✓ premium fee charged on-chain");
  await click("Gemini");

  step("13. co-pilot: the agent proposes, the user signs in the wallet");
  await click("Co-pilot");
  await chat("buy cover 1000 for 1 day");
  await expectAction("proposed");
  await click("Review & sign");
  await expectFlowDone("Proposal");
  await shot("e2e-7-agent-chat");

  step("14. background autopilot: a stop-loss rule closes the vault's position on its own");
  await waitText("Autopilot rules");
  await waitText("Background activity");
  await fill("Stop loss", "0"); // any loss after funding (a long pays funding while the mark is positive)
  await click("Save rules");
  await waitText("Saved.");
  await waitText("Stopped out", 90000); // the runner's next pass (every 4 s), no user action
  step("  ✓ closed by the background runner, logged with its tx");

  step("15. background goal: the model checks the owner's standing goal and acts through the vault");
  await clickLabel("Goal: let the model");
  await fill("Goal, in your words", "deposit 50");
  await fill("Check every", "0");
  await click("Save rules");
  await waitText("Saved.");
  await waitText("Deposit 50", 90000);
  step("  ✓ goal acted on in the background");
  await shot("e2e-8-autopilot");

  step("16. the on-demand tick endpoint (for external cron) still answers");
  const tick = await fetch(new URL("/api/agent/autopilot", url), { method: "POST", headers: { authorization: `Bearer ${process.env.AUTOPILOT_SECRET}` } });
  const tickBody = await tick.json();
  if (tick.status !== 200 || !tickBody.runner?.running) throw new Error(`autopilot tick: ${tick.status} ${JSON.stringify(tickBody).slice(0, 200)}`);
  step(`  ✓ runner on every ${tickBody.runner.intervalSec}s, ${tickBody.runner.vaultsKnown} vault(s) known`);
} catch (e) {
  failed = e.message;
  step(`✗ ${e.message}`);
  await shot("e2e-failure");
}

const errors = events.filter((e) => e.sessionId === sessionId).flatMap((e) => {
  if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") return [`console.error: ${e.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300)}`];
  if (e.method === "Runtime.exceptionThrown") return [`exception: ${(e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text).slice(0, 300)}`];
  if (e.method === "Log.entryAdded" && e.params.entry.level === "error") return [`log.error: ${e.params.entry.text} ${e.params.entry.url ?? ""}`];
  return [];
});
console.log(JSON.stringify({ passed: !failed, failed, errors }, null, 2));
ws.close(); chrome.kill(); process.exit(failed ? 1 : 0);
