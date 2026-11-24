"use client";

import { useQuery } from "@tanstack/react-query";
import { zeroAddress, type Address } from "viem";

import { mockTokenAbi } from "./abi/MockToken";
import { riftHubAbi } from "./abi/RiftHub";
import { riftMarketFactoryAbi } from "./abi/RiftMarketFactory";
import { riftSpreadMarketAbi } from "./abi/RiftSpreadMarket";
import { addresses, clients, POLL_MS } from "./config";
import { align, preferFlip, type PoolRead, type PoolSide, type ScanChain } from "./scanner";

/**
 * Trader-created spread markets: RiftMarketFactory on Unichain lists them, RiftHub on Lasna marks them.
 * Trading-only for now: no cover product and no trip on these markets.
 */

export const factory = { address: addresses.markets.factory, abi: riftMarketFactoryAbi } as const;
export const hub = { address: addresses.markets.hub, abi: riftHubAbi } as const;
export const spreadMarket = (address: Address) => ({ address, abi: riftSpreadMarketAbi }) as const;
export const token = { address: addresses.unichain.collateral, abi: mockTokenAbi } as const;

/** False until the factory is deployed and its address is in config. */
export const MARKETS_LIVE = (addresses.markets.factory as Address) !== zeroAddress;

export const CHAIN_BY_ID: Record<number, ScanChain> = { 84532: "base", 1301: "unichain", 11155111: "sepolia" };
export const CHAIN_ID: Record<ScanChain, number> = { base: 84532, unichain: 1301, sepolia: 11155111 };
export const KIND_SYNC = 0;
export const KIND_V3 = 1;

export type PoolRef = {
  chainId: bigint;
  pool: Address;
  kind: number;
  invert: boolean;
  decShift: number;
  minLiquidity: bigint;
};
export type Spec = { a: PoolRef; b: PoolRef };

export type MarketRow = {
  id: number;
  address: Address;
  creator: Address;
  spec: Spec;
  markBps: bigint;
  markReceivedAt: bigint;
  poolAssets: bigint;
  totalShares: bigint;
  openLongSize: bigint;
  openShortSize: bigint;
  now: bigint;
  /** From the hub on Lasna; undefined when Lasna didn't answer. */
  hub?: { active: boolean; throttled: boolean; hasA: boolean; hasB: boolean; marksSent: number };
};

export const sideOf = (p: PoolRef): PoolSide => ({ chain: CHAIN_BY_ID[Number(p.chainId)] ?? "base", address: p.pool });

async function readMarkets(): Promise<MarketRow[]> {
  const c = clients.unichain;
  const [list, block] = await Promise.all([c.readContract({ ...factory, functionName: "markets" }), c.getBlock()]);
  const rows = await Promise.all(
    list.map(async (address, id) => {
      const m = spreadMarket(address);
      const [spec, creator, markBps, markReceivedAt, poolAssets, totalShares, openLongSize, openShortSize] = await Promise.all([
        c.readContract({ ...factory, functionName: "specOf", args: [BigInt(id)] }),
        c.readContract({ ...factory, functionName: "creatorOf", args: [BigInt(id)] }),
        c.readContract({ ...m, functionName: "markBps" }),
        c.readContract({ ...m, functionName: "markReceivedAt" }),
        c.readContract({ ...m, functionName: "poolAssets" }),
        c.readContract({ ...m, functionName: "totalShares" }),
        c.readContract({ ...m, functionName: "openLongSize" }),
        c.readContract({ ...m, functionName: "openShortSize" }),
      ]);
      return { id, address, creator, spec: spec as Spec, markBps, markReceivedAt, poolAssets, totalShares, openLongSize, openShortSize, now: block.timestamp };
    }),
  );
  // The hub's view (subscribed? prices seen?) is a nice-to-have: Lasna being slow mustn't hide the list.
  const hubRows = await Promise.all(
    rows.map((r) =>
      clients.lasna
        .readContract({ ...hub, functionName: "marketOf", args: [BigInt(r.id)] })
        .then((h) => ({ active: h.active, throttled: h.throttled, hasA: h.priceA > 0n, hasB: h.priceB > 0n, marksSent: Number(h.marksSent) }))
        .catch(() => undefined),
    ),
  );
  return rows.map((r, i) => ({ ...r, hub: hubRows[i] }));
}

export const useMarkets = () =>
  useQuery({ queryKey: ["markets"], queryFn: readMarkets, enabled: MARKETS_LIVE, refetchInterval: POLL_MS * 2 });

export async function readMarketAccount(market: Address, user: Address) {
  const c = clients.unichain;
  const m = spreadMarket(market);
  const [usd, allowance, shares, request, position, equity] = await Promise.all([
    c.readContract({ ...token, functionName: "balanceOf", args: [user] }),
    c.readContract({ ...token, functionName: "allowance", args: [user, market] }),
    c.readContract({ ...m, functionName: "sharesOf", args: [user] }),
    c.readContract({ ...m, functionName: "withdrawRequests", args: [user] }),
    c.readContract({ ...m, functionName: "positions", args: [user] }),
    c.readContract({ ...m, functionName: "equityOf", args: [user] }),
  ]);
  const [lockedShares, unlockAt] = request;
  const [open, isLong, size, margin, entryMark] = position;
  const [eq, pnl, funding] = equity;
  return {
    usd,
    allowance,
    shares,
    withdrawal: lockedShares > 0n ? { shares: lockedShares, unlockAt } : null,
    position: open ? { isLong, size, margin, entryMark, equity: eq, pnl, funding } : null,
  };
}
export type MarketAccount = Awaited<ReturnType<typeof readMarketAccount>>;

export const useMarketAccount = (market: Address | undefined, user: Address | undefined) =>
  useQuery({
    queryKey: ["market-account", market, user],
    queryFn: () => readMarketAccount(market!, user!),
    enabled: !!market && !!user,
    refetchInterval: POLL_MS,
  });

/**
 * The spec the hub needs, worked out from what the Scanner read off both pools: which event carries the price,
 * the decimals shift to human units, and which side to invert so both quote the same asset in the same unit.
 * Null when the two pools don't trade the same pair.
 */
export function specFrom(a: PoolSide, pa: PoolRead, b: PoolSide, pb: PoolRead, flipA: boolean): Spec | null {
  const effFlipA = preferFlip(pa) !== flipA;
  const al = align(pa, pb, effFlipA);
  if (!al.match) return null;
  const ref = (s: PoolSide, p: PoolRead, invert: boolean): PoolRef => ({
    chainId: BigInt(CHAIN_ID[s.chain]),
    pool: s.address as Address,
    kind: p.kind === "Uniswap v3" ? KIND_V3 : KIND_SYNC,
    invert,
    decShift: p.token0.decimals - p.token1.decimals,
    minLiquidity: 0n,
  });
  return { a: ref(a, pa, al.qa.flipped), b: ref(b, pb, al.qb.flipped) };
}

export const KIND_LABEL = (k: number) => (k === KIND_V3 ? "Uniswap v3 · Swap" : "v2 / RiftPool · Sync");
