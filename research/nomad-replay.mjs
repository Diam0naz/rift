// Replays Rift's two-condition trip on the Nomad bridge exploit (2022-08-01), from chain history only.
//
//   Vault (outflow condition): Nomad's ERC20 bridge escrow on Ethereum, USDC balance.
//   Twin market (spread):      Nomad-bridged USDC on Moonbeam, priced in FRAX (not Nomad-bridged) through
//                              a stable-swap pool. Par is 1.0; the "spread" is how far below par it trades.
//   Rule (RiftReactive defaults): |spread| >= 5% AND escrow outflow >= 15% of its pre-exploit balance
//                              within 5 minutes. Both must hold at the same moment.
//
// Usage: node research/nomad-replay.mjs   (public archive RPCs: eth.drpc.org, onfinality Moonbeam)
import { writeFileSync } from "node:fs";
import { createPublicClient, erc20Abi, http, parseAbiItem } from "../frontend/node_modules/viem/_esm/index.js";

const eth = createPublicClient({ transport: http("https://eth.drpc.org", { retryCount: 6, retryDelay: 1500, timeout: 30_000 }) });
const glmr = createPublicClient({ transport: http("https://moonbeam.api.onfinality.io/public", { retryCount: 6, retryDelay: 1500, timeout: 30_000 }) });

const ESCROW = "0x88A69B4E698A4B090DF6CF5Bd7B2D47325Ad30A3"; // Nomad ERC20 bridge, Ethereum
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_FROM = 15259000n, ETH_TO = 15260700n;
const POOL = "0x247b71D57Ac80883364599ad5c9D74ea5EDc8660"; // Saddle-style pool: [0] FRAX, [1] Nomad USDC (Moonbeam)
const GLMR_FROM = 1563200n, GLMR_TO = 1564500n, GLMR_STEP = 5n; // ~12 s blocks: a sample every ~1 min
const QUOTE_IN = 1000n * 10n ** 6n; // 1,000 bridged USDC
const SPREAD_BPS = 500, OUTFLOW_BPS = 1500, WINDOW_S = 300;

// ---------------------------------------------------------------- Ethereum: USDC leaving the escrow
const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const outs = [];
for (let b = ETH_FROM; b <= ETH_TO; b += 100n) {
  const e = b + 99n > ETH_TO ? ETH_TO : b + 99n;
  for (const l of await eth.getLogs({ address: USDC, event: transfer, args: { from: ESCROW }, fromBlock: b, toBlock: e })) {
    const t = Number((await eth.getBlock({ blockNumber: l.blockNumber })).timestamp);
    outs.push({ t, block: Number(l.blockNumber), v: l.args.value, tx: l.transactionHash });
  }
}
const start = await eth.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [ESCROW], blockNumber: ETH_FROM });
const windowOutflowBps = (t) => {
  const sum = outs.filter((o) => o.t <= t && t - o.t <= WINDOW_S).reduce((s, o) => s + o.v, 0n);
  return Number((sum * 10000n) / start);
};
const drainedBy = (t) => outs.filter((o) => o.t <= t).reduce((s, o) => s + o.v, 0n);

// ---------------------------------------------------------------- Moonbeam: bridged USDC vs par
const saddle = [{ type: "function", name: "calculateSwap", stateMutability: "view", inputs: [{ type: "uint8" }, { type: "uint8" }, { type: "uint256" }], outputs: [{ type: "uint256" }] }];
const prices = [];
for (let b = GLMR_FROM; b <= GLMR_TO; b += GLMR_STEP) {
  const [out, blk] = await Promise.all([
    glmr.readContract({ address: POOL, abi: saddle, functionName: "calculateSwap", args: [1, 0, QUOTE_IN], blockNumber: b }).catch(() => null),
    glmr.getBlock({ blockNumber: b }),
  ]);
  if (out === null) continue;
  const price = Number(out) / 1e18 / 1000; // FRAX per bridged USDC
  prices.push({ t: Number(blk.timestamp), block: Number(b), price, spreadBps: Math.round((price - 1) * 10000) });
}

// ---------------------------------------------------------------- Rift's rule over the merged timeline
const events = [...new Set([...outs.map((o) => o.t), ...prices.map((p) => p.t)])].sort((a, b) => a - b);
const priceAt = (t) => [...prices].reverse().find((p) => p.t <= t);
let firstDepeg = prices.find((p) => -p.spreadBps >= SPREAD_BPS) ?? null;
let trip = null;
for (const t of events) {
  const p = priceAt(t);
  if (!p) continue;
  const w = windowOutflowBps(t);
  if (-p.spreadBps >= SPREAD_BPS && w >= OUTFLOW_BPS) {
    trip = { t, spreadBps: p.spreadBps, windowOutflowBps: w };
    break;
  }
}

const iso = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
const usd = (x) => Number(x) / 1e6;
const lastOut = outs.at(-1);
const result = {
  sources: { escrow: ESCROW, usdc: USDC, ethBlocks: [String(ETH_FROM), String(ETH_TO)], moonbeamPool: POOL, moonbeamBlocks: [String(GLMR_FROM), String(GLMR_TO)] },
  rule: `spread <= -${SPREAD_BPS / 100}% AND outflow >= ${OUTFLOW_BPS / 100}% of the pre-exploit balance within ${WINDOW_S / 60} min`,
  escrowUsdcBefore: usd(start),
  firstUsdcOut: outs[0] && { time: iso(outs[0].t), block: outs[0].block, tx: outs[0].tx },
  lastUsdcOut: lastOut && { time: iso(lastOut.t), block: lastOut.block },
  priceBefore: prices[0]?.price,
  firstDepegPast5pct: firstDepeg && { time: iso(firstDepeg.t), moonbeamBlock: firstDepeg.block, price: firstDepeg.price },
  lowestPrice: prices.reduce((m, p) => (p.price < m.price ? p : m), prices[0]),
  trip: trip && {
    time: iso(trip.t),
    spreadPct: trip.spreadBps / 100,
    windowOutflowPct: trip.windowOutflowBps / 100,
    usdcAlreadyDrained: usd(drainedBy(trip.t)),
    usdcStillInEscrow: usd(start - drainedBy(trip.t)),
    minutesAfterFirstUsdcOut: outs[0] ? Math.round((trip.t - outs[0].t) / 60) : null,
    minutesBeforeLastUsdcOut: lastOut ? Math.round((lastOut.t - trip.t) / 60) : null,
  },
  priceSeries: prices.map((p) => ({ time: iso(p.t), price: Number(p.price.toFixed(4)) })),
};
writeFileSync(new URL("./nomad-replay.json", import.meta.url), JSON.stringify(result, null, 2));
const { priceSeries, ...summary } = result;
console.log(JSON.stringify(summary, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
