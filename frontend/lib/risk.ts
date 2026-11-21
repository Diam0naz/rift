import type { MarketState, ReactiveState } from "./reads";

export type Level = "green" | "amber" | "red";

export type Driver = {
  key: string;
  label: string;
  level: Level;
  value: string;
  detail: string;
};

export type RiskBand = {
  level: Level;
  headline: string;
  drivers: Driver[];
};

const WAD = 10n ** 18n;
const rank: Record<Level, number> = { green: 0, amber: 1, red: 2 };
const worst = (levels: Level[]): Level => levels.reduce((a, b) => (rank[b] > rank[a] ? b : a), "green");

/**
 * Heartbeat-only burn of RiftReactive's lREACT: Cron1000 fires ~86 times a day at ~0.012 lREACT per
 * reaction (measured on Lasna). Swaps and transfers add to this, so the runway shown is an upper bound.
 */
export const HEARTBEAT_LREACT_PER_DAY = 1.05;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const toNum = (wad: bigint) => Number(wad) / 1e18;

/**
 * Deterministic risk band from on-chain state. Every input is a contract read; nothing here is a guess,
 * except the heartbeat burn estimate above, which is labelled as one.
 */
export function computeRiskBand(m: MarketState, r: ReactiveState): RiskBand {
  const drivers: Driver[] = [];
  const p = r.params;

  // 1. Distance to trip (both conditions must hold for a payout).
  const absSpread = r.spreadBps < 0n ? -r.spreadBps : r.spreadBps;
  const spreadFrac = Number(absSpread) / Number(p.tripSpreadBps);
  const outflowFrac = Number(r.outflowBps) / Number(p.tripOutflowBps);
  const breachFor = r.breachSince > 0n ? Number(r.now - r.breachSince) : 0;
  const tripLevel: Level = r.tripped
    ? "red"
    : spreadFrac >= 0.8 && outflowFrac >= 0.8
      ? "red"
      : spreadFrac >= 0.5 || outflowFrac >= 0.5
        ? "amber"
        : "green";
  drivers.push({
    key: "trip",
    label: "Distance to trip",
    level: tripLevel,
    value: r.tripped
      ? "Tripped"
      : `spread ${pct(Math.min(spreadFrac, 9.99))} · outflow ${pct(Math.min(outflowFrac, 9.99))}`,
    detail: r.tripped
      ? r.tripConfirmed
        ? "The market confirmed the trip; payouts are fixed and claimable."
        : "Trip sent; waiting for the market's confirmation."
      : `A trip needs |spread| ≥ ${Number(p.tripSpreadBps) / 100}% held ${p.sustainSeconds}s and outflow ≥ ${
          Number(p.tripOutflowBps) / 100
        }% of the vault.${breachFor > 0 ? ` Spread breach running for ${breachFor}s.` : ""}`,
  });

  // 2. Pool utilization against the premium curve's kink.
  const u = Number(m.utilizationWad) / 1e18;
  const kink = Number(m.premium.kinkWad) / 1e18;
  const utilLevel: Level = u >= 0.95 ? "red" : u >= kink ? "amber" : "green";
  drivers.push({
    key: "utilization",
    label: "Pool utilization",
    level: utilLevel,
    value: pct(u),
    detail:
      u >= kink
        ? `Past the ${pct(kink)} kink: new cover is priced on the steep part of the curve.`
        : `Below the ${pct(kink)} kink: cover is priced near the base rate.`,
  });

  // 3. Open perp PnL against the pool.
  const owedToTraders = toNum(m.tradersPnl > 0n ? m.tradersPnl : 0n);
  const cash = toNum(m.poolAssets);
  const perpFrac = cash > 0 ? owedToTraders / cash : 0;
  drivers.push({
    key: "perp",
    label: "Open perp exposure",
    level: perpFrac >= 0.1 ? "red" : perpFrac >= 0.02 ? "amber" : "green",
    value: m.tradersPnl > 0n ? `pool owes ${pct(perpFrac)}` : "pool not owing",
    detail: "Traders' unrealized PnL net of funding, already counted in the share price.",
  });

  // 4. Spread stress loading on premiums.
  const stress = Number(m.stressMultiplierBps) / 10_000;
  drivers.push({
    key: "stress",
    label: "Premium stress",
    level: stress >= 2.5 ? "red" : stress >= 1.5 ? "amber" : "green",
    value: `${stress.toFixed(2)}×`,
    detail: "Premiums scale with |mark| (doubling at the stress spread), capped at 3×.",
  });

  // 5. Liveness: the market halts new risk when marks stop arriving.
  const markAge = m.markReceivedAt > 0n ? Number(m.now - m.markReceivedAt) : Infinity;
  const maxAge = Number(m.maxMarkAge);
  drivers.push({
    key: "liveness",
    label: "Mark freshness",
    level: markAge > maxAge ? "red" : markAge > maxAge / 2 ? "amber" : "green",
    value: Number.isFinite(markAge) ? `${fmtDuration(markAge)} old` : "no mark yet",
    detail:
      markAge > maxAge
        ? `Older than ${fmtDuration(maxAge)}: the market refuses new cover and positions.`
        : `New cover and positions stop if no mark lands for ${fmtDuration(maxAge)}.`,
  });

  // 6. Reactive-side funding: if RiftReactive runs dry, nothing can trip.
  const runwayDays = toNum(r.balance) / HEARTBEAT_LREACT_PER_DAY;
  drivers.push({
    key: "runway",
    label: "Reactive runway",
    level: runwayDays < 1 ? "red" : runwayDays < 3 ? "amber" : "green",
    value: `${toNum(r.balance).toFixed(2)} lREACT`,
    detail: `About ${runwayDays.toFixed(1)} days of heartbeats at ~${HEARTBEAT_LREACT_PER_DAY} lREACT/day (less if markets are busy).`,
  });

  // 7. Callback funding on Unichain.
  const cb = toNum(m.callbackFunding);
  drivers.push({
    key: "callbacks",
    label: "Callback funding",
    level: cb < 0.0005 ? "red" : cb < 0.002 ? "amber" : "green",
    value: `${cb.toFixed(4)} ETH`,
    detail: "Paid by the market for each Reactive callback it receives.",
  });

  const level = worst(drivers.map((d) => d.level));
  return { level, headline: headline(level, drivers, m), drivers };
}

function headline(level: Level, drivers: Driver[], m: MarketState): string {
  if (m.tripped) {
    const owed = Number((m.totalOwed * 100n) / WAD) / 100;
    return owed > 0
      ? `Tripped: payouts fixed at ${Number(m.payoutRatioBps) / 100}%, ${owed.toLocaleString()} tUSD still to claim.`
      : `Tripped: payouts fixed at ${Number(m.payoutRatioBps) / 100}% and fully claimed.`;
  }
  if (level === "green") return "Calm: spread and vault flows are far from the trip conditions.";
  const top = drivers.filter((d) => d.level === level).map((d) => d.label.toLowerCase());
  return `${level === "red" ? "High" : "Elevated"} risk: ${top.join(", ")}.`;
}

export function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return "∞";
  if (s < 90) return `${Math.max(0, Math.round(s))}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}
