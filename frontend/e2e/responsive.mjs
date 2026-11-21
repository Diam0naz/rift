// Responsive check: loads every page at phone, tablet and desktop widths, screenshots each, and fails on
// horizontal page overflow (anything wider than the viewport). Read-only: it never connects a wallet.
// Usage: node e2e/responsive.mjs <baseUrl> <outDir> [path ...]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [base, outDir, ...only] = process.argv.slice(2);
if (!base || !outDir) {
  console.error("usage: node e2e/responsive.mjs <baseUrl> <outDir> [path ...]");
  process.exit(2);
}
const PATHS = only.length ? only : ["/", "/app", "/app/protect", "/app/trade", "/app/underwrite", "/app/monitor", "/app/activity", "/app/history"];
const WIDTHS = [
  { name: "phone", width: 375, height: 812, mobile: true },
  { name: "tablet", width: 768, height: 1024, mobile: true },
  { name: "desktop", width: 1300, height: 900, mobile: false },
];

mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(outDir, "cdp-"));
const chrome = spawn("google-chrome", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((res, rej) => {
  let buf = "";
  chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  setTimeout(() => rej(new Error("chrome did not start")), 20000);
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map(); const errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? "exception");
});
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
const s = (m, p) => send(m, p, sessionId);
await s("Runtime.enable"); await s("Page.enable");
const evalJs = async (expr) => (await s("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Elements that stick out past the right edge, outermost first, skipping intentional clippers (marquees).
const OVERFLOW = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= vw + 1) continue;
    let p = el.parentElement, clipped = false;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (/(hidden|clip|auto|scroll)/.test(cs.overflowX) && p.getBoundingClientRect().right <= vw + 1) { clipped = true; break; }
      p = p.parentElement;
    }
    if (clipped) continue;
    if (out.some((o) => o.el.contains(el))) continue;
    out.push({ el, desc: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '') + ' → ' + Math.round(r.right) + 'px: ' + (el.textContent || '').trim().slice(0, 40) });
  }
  return { scroll: document.documentElement.scrollWidth, vw, items: out.slice(0, 8).map((o) => o.desc) };
})()`;

let failed = 0;
for (const w of WIDTHS) {
  await s("Emulation.setDeviceMetricsOverride", { width: w.width, height: w.height, deviceScaleFactor: 1, mobile: w.mobile });
  for (const path of PATHS) {
    await s("Page.navigate", { url: base.replace(/\/$/, "") + path });
    await sleep(6000); // live data and fonts settle
    const r = await evalJs(OVERFLOW);
    const shot = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: await fullClip() });
    const file = join(outDir, `${w.name}${path.replace(/\//g, "_") || "_root"}.png`);
    writeFileSync(file, Buffer.from(shot.result.data, "base64"));
    const bad = r.scroll > r.vw + 1 || r.items.length > 0;
    if (bad) failed++;
    console.log(`${bad ? "✗" : "✓"} ${w.name.padEnd(7)} ${path.padEnd(16)} ${bad ? `overflow (page ${r.scroll}px / ${r.vw}px)` : "fits"}  ${file}`);
    for (const i of r.items) console.log(`      ${i}`);
  }
}

async function fullClip() {
  const h = await evalJs("Math.min(document.documentElement.scrollHeight, 6000)");
  const w = await evalJs("document.documentElement.clientWidth");
  return { x: 0, y: 0, width: w, height: h, scale: 1 };
}

console.log(JSON.stringify({ passed: failed === 0, failed, errors: [...new Set(errors)].slice(0, 10) }, null, 2));
ws.close(); chrome.kill();
process.exit(failed === 0 ? 0 : 1);
