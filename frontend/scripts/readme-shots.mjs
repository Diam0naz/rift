// Regenerates the README screenshots (docs/images/*.webp) from a running app, in dark mode.
// Usage: node scripts/readme-shots.mjs [http://localhost:3000] [../docs/images] [name,name,...]
// The app should be the production build with the indexer and a Gemini key, so every panel has live data.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [base = "http://localhost:3000", out = join(import.meta.dirname, "..", "..", "docs", "images"), only] = process.argv.slice(2);
const want = (n) => !only || only.split(",").includes(n);

const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${mkdtempSync(join(tmpdir(), "cdp-"))}`, "--remote-debugging-port=0", "about:blank"], {
  stdio: ["ignore", "ignore", "pipe"],
});
const wsUrl = await new Promise((res) => {
  let b = "";
  chrome.stderr.on("data", (d) => {
    b += d;
    const m = b.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) res(m[1]);
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
const s = (m, q) => send(m, q, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (x) => (await s("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
await s("Page.enable");
await s("Runtime.enable");
// Dark theme; reduced motion so marquees and parallax are still for the capture.
await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] });

/** Waits until `text` is gone from the page (a loading message) or the timeout passes. */
async function settle(texts, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await ev(`(${JSON.stringify(texts)}).some(t => document.body.innerText.includes(t))`))) return;
    await sleep(1000);
  }
}

async function shot(name, { path, w = 1440, h = 900, scrollTo = 0, before }) {
  await s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  await s("Page.navigate", { url: base + path });
  await sleep(4000);
  await settle(["Loading mark history", "Reading the market", "starting", "Loading events", "needs the indexer"], 60000);
  if (before) await before();
  await ev(`window.scrollTo(0, ${scrollTo})`);
  await sleep(1500);
  const r = await s("Page.captureScreenshot", { format: "webp", quality: 82 });
  writeFileSync(join(out, `${name}.webp`), Buffer.from(r.result.data, "base64"));
  console.log(`${name}.webp`);
}

if (want("landing")) await shot("landing", { path: "/" });
if (want("overview")) await shot("overview", { path: "/app", h: 1250 });
if (want("trade")) await shot("trade", { path: "/app/trade", scrollTo: 200, h: 1000 });
if (want("monitor")) await shot("monitor", { path: "/app/monitor", h: 1300 });
if (want("history")) await shot("history", { path: "/app/history", scrollTo: 200, h: 1100 });
if (want("agent"))
  await shot("agent", {
    path: "/app/agent",
    h: 820,
    scrollTo: 340,
    before: async () => {
      const q = "What's the market like right now, and what would 5,000 tUSD of cover for 2 days cost? Propose it.";
      await ev(`(() => { const el = document.getElementById('agent-input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(q)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send').click(); })()`);
      await sleep(2000);
      await settle(["is reading the chain"], 120000);
    },
  });
if (want("phone")) await shot("phone", { path: "/app", w: 390, h: 844 });

ws.close();
chrome.kill();
