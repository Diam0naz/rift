import { createPublicClient, http, parseAbiItem } from "../frontend/node_modules/viem/_esm/index.js";
const c = createPublicClient({ transport: http("https://moonbeam.api.onfinality.io/public", { retryCount: 5, retryDelay: 1500, timeout: 30_000 }) });
const TOKEN = "0x8f552a71EFE5eeFc207Bf75485b356A0b3f01eC9"; // Nomad-bridged USDC on Moonbeam
const ev = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const from = 1563268n, to = 1563268n + 1500n;
let logs = [], step = 500n;
for (let b = from; b <= to; b += step) {
  const e = b + step - 1n > to ? to : b + step - 1n;
  try { logs.push(...(await c.getLogs({ address: TOKEN, event: ev, fromBlock: b, toBlock: e }))); }
  catch (err) { console.error("range", b, e, err.shortMessage); }
}
const vol = new Map();
for (const l of logs) for (const a of [l.args.from, l.args.to]) vol.set(a, (vol.get(a) ?? 0n) + l.args.value);
const pairAbi = [
  { type: "function", name: "token0", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "token1", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
];
const sym = [{ type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }];
console.log("transfers", logs.length);
for (const [a, v] of [...vol].sort((x, y) => (y[1] > x[1] ? 1 : -1)).slice(0, 10)) {
  let kind = "";
  try {
    const [t0, t1] = await Promise.all([c.readContract({ address: a, abi: pairAbi, functionName: "token0" }), c.readContract({ address: a, abi: pairAbi, functionName: "token1" })]);
    const [s0, s1] = await Promise.all([c.readContract({ address: t0, abi: sym, functionName: "symbol" }), c.readContract({ address: t1, abi: sym, functionName: "symbol" })]);
    kind = `V2 pair ${s0}(${t0.slice(0, 8)})/${s1}(${t1.slice(0, 8)})`;
  } catch { kind = (await c.getCode({ address: a }))?.length > 2 ? "contract" : "account"; }
  console.log(a, (Number(v) / 1e6).toFixed(0).padStart(12), kind);
}
