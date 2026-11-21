import { pad, toHex, type Hash } from "viem";

import type { IndexedEvent } from "./indexer";
import type { MarketLog } from "./logs";

/** Protocol-wide totals, from the market's own events. */
export type Totals = {
  policies: number;
  coverSold: bigint;
  premiums: bigint;
  payoutsFixed: bigint;
  refunds: bigint;
  claimed: bigint;
  claims: number;
  positions: number;
  perpVolume: bigint;
  closes: number;
  liquidations: number;
  traderPnl: bigint;
  deposited: bigint;
  withdrawn: bigint;
  depositors: number;
  wallets: number;
  marks: number;
  medianLatency: number | null;
  trips: number;
  firstTs: number | null;
};

export function totalsOf(logs: MarketLog[]): Totals {
  const t: Totals = {
    policies: 0, coverSold: 0n, premiums: 0n, payoutsFixed: 0n, refunds: 0n, claimed: 0n, claims: 0,
    positions: 0, perpVolume: 0n, closes: 0, liquidations: 0, traderPnl: 0n,
    deposited: 0n, withdrawn: 0n, depositors: 0, wallets: 0, marks: 0, medianLatency: null, trips: 0, firstTs: null,
  };
  const wallets = new Set<string>();
  const depositors = new Set<string>();
  const latencies: number[] = [];
  const b = (v: unknown) => (typeof v === "bigint" ? v : 0n);
  for (const l of logs) {
    const a = l.args;
    for (const k of ["buyer", "user", "trader", "liquidator"]) if (typeof a[k] === "string") wallets.add((a[k] as string).toLowerCase());
    if (t.firstTs === null && l.ts) t.firstTs = l.ts;
    switch (l.eventName) {
      case "ProtectionBought": t.policies++; t.coverSold += b(a.notional); t.premiums += b(a.premium); break;
      case "PolicySettled": if (a.covered) t.payoutsFixed += b(a.owed); else t.refunds += b(a.owed); break;
      case "Claimed": t.claims++; t.claimed += b(a.amount); break;
      case "PositionOpened": t.positions++; t.perpVolume += b(a.size); break;
      case "PositionClosed": t.closes++; t.traderPnl += b(a.pnl) - b(a.funding); break;
      case "Liquidated": t.liquidations++; break;
      case "Deposited": t.deposited += b(a.assets); depositors.add(String(a.user).toLowerCase()); break;
      case "Withdrawn": t.withdrawn += b(a.assets); break;
      case "MarkUpdated": t.marks++; latencies.push(Number(b(a.receivedAt) - b(a.observedAt))); break;
      case "Tripped": t.trips++; break;
    }
  }
  t.wallets = wallets.size;
  t.depositors = depositors.size;
  if (latencies.length) {
    latencies.sort((x, y) => x - y);
    t.medianLatency = latencies[Math.floor(latencies.length / 2)];
  }
  return t;
}

/** One drain-to-payout, end to end: origin (Base) → reaction (Lasna, when indexed) → settlement (Unichain). */
export type Trip = {
  originChainId: number;
  originTx: Hash;
  observedAt: number;
  /** RiftReactive's TripSent on Lasna, matched by origin tx; needs the indexer. */
  reactiveTx: Hash | null;
  reactiveTs: number | null;
  settlementTx: Hash;
  settlementBlock: bigint;
  receivedAt: number;
  markBps: bigint;
  outflowBps: bigint;
  payoutRatioBps: bigint;
  /** Covered policies settled after this trip (settlement happens at claim time, policy by policy). */
  policiesPaid: number;
  claimed: bigint;
};

const asHash = (v: bigint) => pad(toHex(v), { size: 32 }) as Hash;

export function tripsOf(logs: MarketLog[], reactive: IndexedEvent[] = []): Trip[] {
  const sent = new Map<string, IndexedEvent>();
  for (const e of reactive) if (e.event === "TripSent") sent.set(String(e.args.originTxHash), e);
  const trips: Trip[] = [];
  logs.forEach((l, i) => {
    if (l.eventName !== "Tripped") return;
    const a = l.args as Record<string, bigint>;
    // From the trip's block (its own tx settles covered policies, logged just before Tripped) to the next trip.
    const next = logs.findIndex((x, j) => j > i && x.eventName === "Tripped");
    const window = logs.slice(0, next === -1 ? undefined : next).filter((x) => x.blockNumber >= l.blockNumber);
    const r = sent.get(String(a.originTxHash));
    trips.push({
      originChainId: Number(a.originChainId),
      originTx: asHash(a.originTxHash),
      observedAt: Number(a.observedAt),
      reactiveTx: r ? r.txHash : null,
      reactiveTs: r ? r.ts : null,
      settlementTx: l.txHash,
      settlementBlock: l.blockNumber,
      receivedAt: Number(a.receivedAt),
      markBps: a.markBps,
      outflowBps: a.outflowBps,
      payoutRatioBps: a.payoutRatioBps,
      policiesPaid: window.filter((x) => x.eventName === "PolicySettled" && x.args.covered).length,
      claimed: window.filter((x) => x.eventName === "Claimed").reduce((s, x) => s + (x.args.amount as bigint), 0n),
    });
  });
  return trips.reverse();
}
