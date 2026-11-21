// Replays Rift's outflow condition on the Nomad bridge exploit (Ethereum, 2022-08-01).
// Reads every token transfer out of Nomad's ERC20 bridge escrow from chain history and finds, per token,
// the first moment the escrow lost >= 15% of its balance within 5 minutes (RiftReactive's default trip
// condition). Usage: node research/nomad-outflow.mjs [rpc]   (needs an archive RPC; eth.drpc.org works)
import { writeFileSync } from "node:fs";
import { createPublicClient, erc20Abi, http, parseAbiItem } from "../frontend/node_modules/viem/_esm/index.js";

const rpc = process.argv[2] ?? "https://eth.drpc.org";
const c = createPublicClient({ transport: http(rpc, { retryCount: 6, retryDelay: 1500, timeout: 30_000 }) });

const BRIDGE = "0x88A69B4E698A4B090DF6CF5Bd7B2D47325Ad30A3"; // Nomad: ERC20 bridge (escrow for bridged tokens)
const FROM = 15259000n; // a few minutes before the first exploit transaction (block 15259101, 21:32 UTC)
const TO = 15260700n; // ~5.5 hours later
const STEP = 100n; // the free RPC's getLogs range limit
const OUTFLOW_BPS = 1500; // RiftReactive default: 15%
const WINDOW_S = 300; // within 5 minutes

const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const logs = [];
for (let from = FROM; from <= TO; from += STEP) {
  const to = from + STEP - 1n > TO ? TO : from + STEP - 1n;
  logs.push(...(await c.getLogs({ event: transfer, args: { from: BRIDGE }, fromBlock: from, toBlock: to })));
  process.stderr.write(`\r${from}`);
}
process.stderr.write("\n");

const times = new Map();
const blockTime = async (n) => {
  if (!times.has(n)) times.set(n, Number((await c.getBlock({ blockNumber: n })).timestamp));
  return times.get(n);
};

const byToken = new Map();
for (const l of logs) {
  const k = l.address.toLowerCase();
  if (!byToken.has(k)) byToken.set(k, []);
  byToken.get(k).push(l);
}

const results = [];
for (const [token, ls] of byToken) {
  const [symbol, decimals, start] = await Promise.all([
    c.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    c.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [BRIDGE], blockNumber: FROM }),
  ]);
  if (start === 0n) continue;
  const outs = [];
  for (const l of ls) outs.push({ t: await blockTime(l.blockNumber), block: Number(l.blockNumber), v: l.args.value, tx: l.transactionHash });
  outs.sort((a, b) => a.block - b.block);
  // First moment the outflow in the trailing 5 minutes reaches 15% of the balance before the exploit.
  let trip = null;
  for (let i = 0; i < outs.length && !trip; i++) {
    let sum = 0n;
    for (let j = i; j >= 0 && outs[i].t - outs[j].t <= WINDOW_S; j--) sum += outs[j].v;
    if (sum * 10000n >= start * BigInt(OUTFLOW_BPS)) trip = { ...outs[i], windowOutflowPct: Number((sum * 10000n) / start) / 100 };
  }
  const total = outs.reduce((s, o) => s + o.v, 0n);
  const fmt = (x) => Number(x) / 10 ** Number(decimals);
  results.push({
    token,
    symbol,
    balanceBefore: fmt(start),
    drainedInWindow: fmt(total),
    drainedPct: Number((total * 10000n) / start) / 100,
    transfersOut: outs.length,
    firstOut: outs[0] && { block: outs[0].block, time: new Date(outs[0].t * 1000).toISOString(), tx: outs[0].tx },
    outflowConditionMet: trip && { block: trip.block, time: new Date(trip.t * 1000).toISOString(), tx: trip.tx, windowOutflowPct: trip.windowOutflowPct },
  });
}
results.sort((a, b) => b.drainedInWindow * 0 + b.drainedPct - a.drainedPct);
writeFileSync(new URL("./nomad-outflow.json", import.meta.url), JSON.stringify({ bridge: BRIDGE, blocks: [String(FROM), String(TO)], rule: "outflow >= 15% of pre-exploit balance within 5 min", results }, null, 2));
for (const r of results)
  console.log(
    `${r.symbol.padEnd(8)} before ${r.balanceBefore.toLocaleString(undefined, { maximumFractionDigits: 2 }).padStart(16)}  drained ${String(r.drainedPct).padStart(6)}%  first out ${r.firstOut?.time.slice(11, 19)}  outflow trip ${r.outflowConditionMet ? r.outflowConditionMet.time.slice(11, 19) + ` (block ${r.outflowConditionMet.block}, ${r.outflowConditionMet.windowOutflowPct}% in 5 min)` : "never"}`,
  );
