import type { MarketState } from "./reads";
import { fmtDuration } from "./risk";

export const BPS = 10_000n;
export const MAINTENANCE_BPS = 500n; // RiftMarket.MAINTENANCE_BPS: liquidatable when equity < 5% of size

/** Why the market won't take new risk (cover, positions) right now, or null if it will. */
export function newRiskBlocker(m: MarketState): string | null {
  if (m.tripped) return "The market has tripped, so new cover, positions and deposits are closed. Claims, closes and withdrawals still work.";
  if (m.markReceivedAt === 0n) return "No mark has reached the market yet, so it can't price new risk.";
  const age = Number(m.now - m.markReceivedAt);
  if (age > Number(m.maxMarkAge))
    return `The last mark is ${fmtDuration(age)} old (limit ${fmtDuration(Number(m.maxMarkAge))}), so the market isn't taking new risk until RiftReactive sends a fresh one.`;
  return null;
}

export type PolicyView = MarketState["policies"][number];

export type PolicyStatus =
  | { kind: "waiting"; startsIn: number }
  | { kind: "covered"; endsIn: number }
  | { kind: "expired" }
  | { kind: "claimable"; amount: bigint; refund: boolean }
  | { kind: "claimed" };

export function policyStatus(p: Omit<PolicyView, "id">, now: bigint): PolicyStatus {
  if (p.settled) {
    if (p.owed > 0n) return { kind: "claimable", amount: p.owed, refund: p.owed === p.premium && p.owed !== p.notional };
    return { kind: "claimed" };
  }
  if (p.expiry < now) return { kind: "expired" };
  if (p.activeAt > now) return { kind: "waiting", startsIn: Number(p.activeAt - now) };
  return { kind: "covered", endsIn: Number(p.expiry - now) };
}

/**
 * Mark (bps) at which a position becomes liquidatable, from the contract's rule
 *   equity = margin + dir·size·(mark − entry)/BPS − funding  <  5% · size.
 * `fundingOwed` is what the position owes so far (negative = received).
 */
export function liquidationMarkBps(p: {
  isLong: boolean;
  size: bigint;
  margin: bigint;
  entryMark: bigint;
  fundingOwed?: bigint;
}): number {
  const size = Number(p.size);
  if (size === 0) return NaN;
  const cushion = Number(p.margin) - Number(p.fundingOwed ?? 0n) - (size * Number(MAINTENANCE_BPS)) / Number(BPS);
  const move = (cushion * Number(BPS)) / size; // bps the mark can move against the position
  return p.isLong ? Number(p.entryMark) - move : Number(p.entryMark) + move;
}

/**
 * Funding over one day at the current mark, from the position's point of view: positive = it pays.
 * Longs pay while the mark is positive, shorts while it's negative: size × mark / BPS per day.
 */
export function fundingPerDay(isLong: boolean, size: bigint, markBps: bigint): bigint {
  const longPays = (size * markBps) / BPS;
  return isLong ? longPays : -longPays;
}

/** Margin health: equity over the maintenance requirement (1.0 = liquidatable). */
export function marginHealth(equity: bigint, size: bigint): number {
  const maint = (size * MAINTENANCE_BPS) / BPS;
  return maint === 0n ? Infinity : Number(equity) / Number(maint);
}
