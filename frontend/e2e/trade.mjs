// End-to-end drive of the Trade panel over the Chrome DevTools Protocol.
// Usage: node e2e-trade.mjs <url> <outDir>
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
async function click(text) {
  // textContent ignores CSS text-transform (the app uppercases buttons and tabs); compare case-insensitively.
  const ok = await evalJs(`(() => { const want = ${JSON.stringify(text.toLowerCase())}; const b = [...document.querySelectorAll('button')].find(b => { const t = b.textContent.trim().toLowerCase(); return t === want || t.startsWith(want); }); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'ok'; })()`);
  if (ok !== "ok") throw new Error(`button "${text}": ${ok}`);
}
async function fill(label, value) {
  const ok = await evalJs(`(() => {
    const lab = [...document.querySelectorAll('label')].find(l => l.textContent.trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}));
    const el = lab && lab.querySelector('input,select'); if (!el) return 'missing';
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
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

let failed = null;
try {
  await s("Page.navigate", { url });
  await waitText("Test wallet");
  step("1. connect test wallet");
  await click("Test wallet");
  await waitText("test tUSD");
  step("2. faucet");
  await click("Get 10,000 test tUSD");
  await expectDone("Faucet");

  step("3. protection: approve + buy 1,000 cover for 1 day");
  await waitText("Premium");
  await sleep(1500); // let the quote load
  await click("Approve & buy cover");
  await expectDone("Buy cover");
  await waitText("Your recent policies");
  await shot("e2e-1-protection");

  step("4. protection: oversized order must fail with a readable reason, before signing");
  await fill("Cover amount", "5000000");
  await sleep(2000);
  await click("Buy cover");
  const bad = await waitAnyStatus("Buy cover");
  if (!bad.includes("failed")) throw new Error(`expected a failure, got: ${bad}`);
  if (/signature: 0x|reverted with/.test(bad)) throw new Error(`revert reason not decoded: ${bad}`);
  step(`  ✓ ${bad}`);

  step("5. underwrite: approve-if-needed + deposit 1,000, request 50%, cancel");
  await click("Underwrite");
  await waitText("Your shares");
  await click("Deposit");
  await expectDone("Deposit");
  await click("Request 50%");
  await expectDone("Request 50%");
  await waitText("unlocks in");
  await shot("e2e-2-underwrite");
  await click("Cancel");
  await expectDone("Cancel withdrawal");

  step("6. perp: open 1,000 long at 5x, then close");
  await click("Spread perp");
  await waitText("Long the spread");
  await fill("Leverage", "5");
  await click("Open long");
  await expectDone("Open long");
  await waitText("Close position");
  await shot("e2e-3-perp");
  await click("Close position");
  await expectDone("Close position");
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
