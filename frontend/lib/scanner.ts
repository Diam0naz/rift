import { createPublicClient, erc20Abi, http, isAddress, type Address, type PublicClient } from "viem";
import { sepolia } from "viem/chains";

import { clients } from "./config";

/**
 * Read-only spread scanner: the live price of any two pools on any of the supported testnets, and the gap
 * between them. It observes; it doesn't trade or insure. The deployed RiftMarket watches one fixed pair
 * (RiftReactive's subscriptions); a market on another pair means deploying another RiftReactive and
 * RiftMarket for it.
 */

export type ScanChain = "base" | "unichain" | "sepolia";

export const SCAN_CHAINS: { key: ScanChain; name: string; short: string; explorer: string }[] = [
  { key: "base", name: "Base Sepolia", short: "Base", explorer: "https://sepolia.basescan.org" },
  { key: "unichain", name: "Unichain Sepolia", short: "Unichain", explorer: "https://sepolia.uniscan.xyz" },
  { key: "sepolia", name: "Ethereum Sepolia", short: "Ethereum", explorer: "https://sepolia.etherscan.io" },
];

const sepoliaClient = createPublicClient({
  chain: sepolia,
  transport: http(process.env.NEXT_PUBLIC_ETH_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com", { retryCount: 3 }),
  batch: { multicall: true },
});

export const scanClient = (c: ScanChain): PublicClient => (c === "sepolia" ? sepoliaClient : clients[c]) as PublicClient;

export type PoolSide = { chain: ScanChain; address: string };

export type TokenInfo = { address: Address; symbol: string; decimals: number };

export type PoolRead = {
  kind: "Uniswap v3" | "Uniswap v2" | "RiftPool";
  token0: TokenInfo;
  token1: TokenInfo;
  /** token1 per token0, in human units. */
  price: number;
  /** v3 fee tier, when known. */
  feePct?: number;
  /** A short liquidity note for the card. */
  depth: string;
};

const v3 = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const;
const v2 = [{ type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] }] as const;
const rift = [
  { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "reserve0", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }] },
  { type: "function", name: "reserve1", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }] },
] as const;
const pair = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

async function token(c: PublicClient, address: Address): Promise<TokenInfo> {
  const [symbol, decimals] = await Promise.all([
    c.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => address.slice(0, 6)),
    c.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
  ]);
  return { address, symbol, decimals: Number(decimals) };
}

const compact = (x: number) => (x >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : x.toFixed(2));

/** Reads any supported pool: Uniswap v3 (slot0), Uniswap v2 (getReserves) or a RiftPool (price). */
export async function readPool(side: PoolSide): Promise<PoolRead> {
  if (!isAddress(side.address)) throw new Error("Enter a pool address (0x…).");
  const c = scanClient(side.chain);
  const address = side.address as Address;
  const [t0, t1] = await Promise.all([
    c.readContract({ address, abi: pair, functionName: "token0" }),
    c.readContract({ address, abi: pair, functionName: "token1" }),
  ]).catch(() => {
    throw new Error("Not a pool on this chain (no token0/token1). Check the address and the chain.");
  });
  const [token0, token1] = await Promise.all([token(c, t0), token(c, t1)]);
  const scale = 10 ** (token0.decimals - token1.decimals);

  const slot0 = await c.readContract({ address, abi: v3, functionName: "slot0" }).catch(() => null);
  if (slot0) {
    const [liq, fee] = await Promise.all([
      c.readContract({ address, abi: v3, functionName: "liquidity" }).catch(() => 0n),
      c.readContract({ address, abi: v3, functionName: "fee" }).catch(() => 0),
    ]);
    const sqrt = Number(slot0[0]) / 2 ** 96;
    return { kind: "Uniswap v3", token0, token1, price: sqrt * sqrt * scale, feePct: Number(fee) / 1e4, depth: `liquidity ${compact(Number(liq))}` };
  }
  const isRift = await c.readContract({ address, abi: rift, functionName: "price" }).catch(() => null);
  if (isRift !== null) {
    const [r0, r1] = await Promise.all([c.readContract({ address, abi: rift, functionName: "reserve0" }), c.readContract({ address, abi: rift, functionName: "reserve1" })]);
    return {
      kind: "RiftPool",
      token0,
      token1,
      price: Number(isRift) / 1e18,
      depth: `${compact(Number(r0) / 10 ** token0.decimals)} ${token0.symbol} · ${compact(Number(r1) / 10 ** token1.decimals)} ${token1.symbol}`,
    };
  }
  const res = await c.readContract({ address, abi: v2, functionName: "getReserves" }).catch(() => null);
  if (res) {
    const r0 = Number(res[0]) / 10 ** token0.decimals;
    const r1 = Number(res[1]) / 10 ** token1.decimals;
    return { kind: "Uniswap v2", token0, token1, price: r0 > 0 ? r1 / r0 : 0, depth: `${compact(r0)} ${token0.symbol} · ${compact(r1)} ${token1.symbol}` };
  }
  throw new Error("Unsupported pool: not Uniswap v2, v3 or a RiftPool.");
}

const STABLES = /^(USDC|USDT|DAI|TUSD|FRAX|USDBC|USDC\.E|PYUSD|LUSD)$/i;

/** Quote a stablecoin as the unit (USDC per WETH, not WETH per USDC) when the pool lists it first. */
export const preferFlip = (p: PoolRead) => STABLES.test(p.token0.symbol) && !STABLES.test(p.token1.symbol);

/** A pool's price, quoted as `quote` per one `base`. */
export type Quote = { base: string; quote: string; price: number; flipped: boolean };

export function quoteOf(p: PoolRead, flip: boolean): Quote {
  return flip
    ? { base: p.token1.symbol, quote: p.token0.symbol, price: p.price > 0 ? 1 / p.price : 0, flipped: true }
    : { base: p.token0.symbol, quote: p.token1.symbol, price: p.price, flipped: false };
}

/**
 * Lines B up with A: if B's tokens are A's the other way round, B is flipped so both quote the same
 * direction. `match` is false when the two pools don't trade the same pair (the spread is then meaningless).
 */
export function align(a: PoolRead, b: PoolRead, flipA: boolean): { qa: Quote; qb: Quote; match: boolean } {
  const qa = quoteOf(a, flipA);
  const same = (x: string, y: string) => x.replace(/^w/i, "").toUpperCase() === y.replace(/^w/i, "").toUpperCase();
  const direct = quoteOf(b, false);
  if (same(direct.base, qa.base) && same(direct.quote, qa.quote)) return { qa, qb: direct, match: true };
  const flipped = quoteOf(b, true);
  if (same(flipped.base, qa.base) && same(flipped.quote, qa.quote)) return { qa, qb: flipped, match: true };
  return { qa, qb: direct, match: false };
}

/** Spread of B over A in basis points (Rift's convention: positive when B prices above A). */
export const spreadBps = (pa: number, pb: number) => (pa > 0 ? ((pb - pa) / pa) * 10_000 : 0);

export const PRESETS: { id: string; label: string; note: string; a: PoolSide; b: PoolSide }[] = [
  {
    id: "rift",
    label: "Rift twin pools (the deployed market)",
    note: "The pair RiftReactive watches: tBASE/tQUOTE on Base and Unichain. Its gap is the perp's mark.",
    a: { chain: "base", address: "0xA5aB34c37F2d8C8f86a32BA007F6e421D0B5315D" },
    b: { chain: "unichain", address: "0x3bE5C66453dB2b55412Bf96b4F2df46F34e239ce" },
  },
  {
    id: "weth-005",
    label: "WETH/USDC · Uniswap v3 0.05% · Base vs Unichain",
    note: "Real Uniswap pools on both testnets. Testnet prices are set by whoever last traded, so gaps are large and mean nothing.",
    a: { chain: "base", address: "0x94bfc0574FF48E92cE43d495376C477B1d0EEeC0" },
    b: { chain: "unichain", address: "0xBeAD5792bB6C299AB11Eaa425aC3fE11ebA47b3B" },
  },
  {
    id: "weth-03",
    label: "WETH/USDC · Uniswap v3 0.3% · Base vs Unichain",
    note: "The same pair at the 0.3% fee tier.",
    a: { chain: "base", address: "0x46880b404CD35c165EDdefF7421019F8dD25F4Ad" },
    b: { chain: "unichain", address: "0x8F463126bBEA80A10DF9Bf6FF5455B6B0292B34e" },
  },
  {
    id: "weth-eth",
    label: "WETH/USDC · Uniswap v3 0.05% · Ethereum vs Unichain",
    note: "Ethereum Sepolia against Unichain Sepolia.",
    a: { chain: "sepolia", address: "0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1" },
    b: { chain: "unichain", address: "0xBeAD5792bB6C299AB11Eaa425aC3fE11ebA47b3B" },
  },
];
