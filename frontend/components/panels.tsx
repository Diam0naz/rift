"use client";

import { explorers } from "@/lib/config";
import { fmtBps, fmtCompact, fmtPct, fmtPrice, fmtTime, fmtToken, shortHex } from "@/lib/format";
import type { MarkPoint, MarketState, OriginState, ReactiveState } from "@/lib/reads";
import { fmtDuration, type Level, type RiskBand } from "@/lib/risk";

import { MarkChart } from "./MarkChart";
import { Bar, Card, ExtLink, LevelDot, Pill, Stat } from "./ui";

const levelText: Record<Level, string> = { green: "Green", amber: "Amber", red: "Red" };
const levelRing: Record<Level, string> = {
  green: "",
  amber: "!border-warn/60",
  red: "!border-bad/60",
};

// ---------------------------------------------------------------- risk band

export function RiskBandPanel({ band }: { band: RiskBand }) {
  // One word in display type carries the state; the sentence underneath explains it.
  const word = band.headline.startsWith("Tripped")
    ? "Tripped"
    : band.level === "green"
      ? "Calm"
      : band.level === "amber"
        ? "Elevated"
        : "High risk";
  return (
    <section className={`app-panel corner-ticks p-5 sm:p-7 ${levelRing[band.level]}`} aria-live="polite">
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-5">
          <span className="kicker flex items-center gap-2">
            <LevelDot level={band.level} /> <span style={{ color: "var(--rift)" }}>01 /</span> Risk band · {levelText[band.level]}
          </span>
          <p
            className="display mt-5 text-[clamp(2.5rem,4.4vw,4.25rem)]"
            style={{ color: band.level === "red" ? "var(--rift)" : band.level === "amber" ? "var(--warn)" : "var(--bone)" }}
          >
            {word}.
          </p>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">{band.headline}</p>
        </div>
        <ul className="grid gap-px self-start border sm:grid-cols-2 lg:col-span-7" style={{ borderColor: "var(--line-strong)", background: "var(--line-strong)" }}>
          {band.drivers.map((d) => (
            <li key={d.key} className={`p-4 ${d.level === "red" ? "hatch" : ""}`} style={{ background: "var(--ink-2)" }} title={d.detail}>
              <div className="kicker flex items-center gap-2 !text-[0.62rem]">
                <LevelDot level={d.level} />
                {d.label}
              </div>
              <div className="num mt-2 text-base">{d.value}</div>
              <div className="mt-1 text-xs leading-snug text-muted">{d.detail}</div>
            </li>
          ))}
          {band.drivers.length % 2 === 1 && (
            // Odd count: fill the last cell with a designed pattern rather than a blank block.
            <li aria-hidden className="hatch hidden sm:block" style={{ background: "var(--ink-2)" }} />
          )}
        </ul>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- spread + mark

export function SpreadPanel({
  m,
  r,
  o,
  history,
}: {
  m: MarketState;
  r: ReactiveState;
  o: OriginState;
  history: MarkPoint[] | undefined;
}) {
  const markAge = Number(m.now - m.markReceivedAt);
  const lag = Number(r.spreadBps - r.smoothedSpreadBps);
  return (
    <Card
      index="03"
      ticks
      title="Unichain ↔ Base spread"
      subtitle="Pool prices, the spread RiftReactive computes, and the time-weighted mark the perp settles on."
      right={<Pill tone="muted">{r.marksSent.toString()} marks sent</Pill>}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Base pool price" value={fmtPrice(o.price)} hint="tQUOTE per tBASE" />
        <Stat label="Unichain pool price" value={fmtPrice(m.poolUniPrice)} hint="tQUOTE per tBASE" />
        <Stat label="Raw spread (Reactive)" value={fmtBps(r.spreadBps)} hint="drives the trip" />
        <Stat
          label="Perp mark (Unichain)"
          value={fmtBps(m.markBps)}
          hint={`landed ${fmtDuration(markAge)} ago`}
        />
      </div>
      <div className="mt-4">
        <MarkChart
          points={history}
          now={Number(m.now)}
          tripSpreadBps={Number(r.params.tripSpreadBps)}
          trip={m.tripped ? { at: Number(m.trippedAt), bps: Number(m.tripMark) } : undefined}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        {m.tripped ? (
          <>The perp is frozen at the trip mark ({fmtBps(m.tripMark)}); RiftReactive stops sending marks after a trip.</>
        ) : (
          <>
            Smoothed spread {fmtBps(r.smoothedSpreadBps)}
            {lag !== 0 && (
              <>
                {" "}
                (raw is {fmtBps(lag)} away; a move has to hold ~{r.params.markSmoothingSeconds.toString()}s to fully reach
                the mark)
              </>
            )}
            .
          </>
        )}{" "}
        Dashed red lines: trip threshold ±{fmtBps(r.params.tripSpreadBps, false)}.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------- trip conditions

export function TripPanel({ r, o }: { r: ReactiveState; o: OriginState }) {
  const p = r.params;
  const absSpread = Number(r.spreadBps < 0n ? -r.spreadBps : r.spreadBps);
  const breachFor = r.breachSince > 0n ? Number(r.now - r.breachSince) : 0;
  const spreadTone: Level = absSpread >= Number(p.tripSpreadBps) ? "red" : absSpread >= Number(p.tripSpreadBps) / 2 ? "amber" : "green";
  const outTone: Level =
    r.outflowBps >= p.tripOutflowBps ? "red" : Number(r.outflowBps) >= Number(p.tripOutflowBps) / 2 ? "amber" : "green";

  return (
    <Card
      index="04"
      title="Trip conditions"
      subtitle="A payout needs both: a sustained spread break and a real drain."
      right={
        r.tripped ? (
          <Pill tone="red">{r.tripConfirmed ? "Tripped · confirmed" : "Tripped · awaiting confirmation"}</Pill>
        ) : (
          <Pill tone="green">Armed</Pill>
        )
      }
    >
      <div className="space-y-5">
        <div>
          <div className="mb-1.5 flex justify-between text-xs">
            <span className="text-muted">|Spread| vs {fmtBps(p.tripSpreadBps, false)} for {p.sustainSeconds.toString()}s</span>
            <span className="num">{fmtBps(absSpread, false)}</span>
          </div>
          <Bar value={absSpread} max={Number(p.tripSpreadBps) * 1.5} marker={Number(p.tripSpreadBps)} tone={spreadTone} label="Spread against trip threshold" />
          <p className="mt-1.5 text-xs text-muted">
            {r.tripped
              ? "Tripped. RiftReactive stops evaluating until the demo is reset."
              : breachFor > 0
                ? `Breach running ${breachFor}s (needs ${p.sustainSeconds}s on Reactive's clock).`
                : "No breach in progress."}
          </p>
        </div>
        <div>
          <div className="mb-1.5 flex justify-between text-xs">
            <span className="text-muted">
              Vault outflow vs {fmtBps(p.tripOutflowBps, false)} in {fmtDuration(Number(p.windowSeconds))}
            </span>
            <span className="num">{fmtBps(r.outflowBps, false)}</span>
          </div>
          <Bar value={Number(r.outflowBps)} max={Number(p.tripOutflowBps) * 1.5} marker={Number(p.tripOutflowBps)} tone={outTone} label="Outflow against trip threshold" />
          <p className="mt-1.5 text-xs text-muted">
            Vault holds {fmtCompact(o.vaultAssets)} on Base; RiftReactive mirrors {fmtCompact(r.vaultBalance)} from Transfer
            logs.{" "}
            {r.tripped ? "Figures are as of the trip." : "Outflow updates when RiftReactive next reacts."}
          </p>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- pool + pricing

export function PoolPanel({ m }: { m: MarketState }) {
  const u = Number(m.utilizationWad) / 1e18;
  const kink = Number(m.premium.kinkWad) / 1e18;
  const tone: Level = u >= 0.95 ? "red" : u >= kink ? "amber" : "green";
  const sharePrice = m.totalShares > 0n ? Number(m.poolValue) / Number(m.totalShares) : 1;
  return (
    <Card index="05" title="Underwriting pool" subtitle="Backs every policy and is the counterparty to the perp.">
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Pool value" value={fmtCompact(m.poolValue)} hint={`share price ${sharePrice.toFixed(4)}`} />
        <Stat label="Cash" value={fmtCompact(m.poolAssets)} hint={`reserved ${fmtCompact(m.reservedLiquidity)}`} />
        <Stat
          label="Traders' unrealized PnL"
          value={m.tradersPnl === 0n ? "0" : `${m.tradersPnl > 0n ? "+" : "−"}${fmtCompact(m.tradersPnl > 0n ? m.tradersPnl : -m.tradersPnl)}`}
          hint={`long ${fmtCompact(m.openLongSize)} · short ${fmtCompact(m.openShortSize)}`}
        />
        <Stat label="Owed to buyers" value={fmtCompact(m.totalOwed)} hint="settled, not yet claimed" />
      </div>

      <div className="mt-5">
        <div className="mb-1.5 flex justify-between text-xs">
          <span className="text-muted">Utilization (kink at {fmtPct(m.premium.kinkWad)})</span>
          <span className="num">{fmtPct(m.utilizationWad)}</span>
        </div>
        <Bar value={u} max={1} marker={kink} tone={tone} label="Pool utilization" />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4 bg-panel-2 p-3">
        <Stat
          label="Quote: 10,000 cover · 1 day"
          value={m.quote === null ? "no capacity" : `${fmtToken(m.quote)} tUSD`}
        />
        <Stat
          label="Stress multiplier"
          value={`${(Number(m.stressMultiplierBps) / 10_000).toFixed(2)}×`}
          hint={`doubles at ${fmtBps(m.premium.stressSpreadBps, false)} spread`}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        Rate: {Number(m.premium.baseBpsPerDay) / 100}%/day idle,{" "}
        {(Number(m.premium.baseBpsPerDay + m.premium.slope1BpsPerDay) / 100).toFixed(2)}%/day at the kink,{" "}
        {(Number(m.premium.baseBpsPerDay + m.premium.slope1BpsPerDay + m.premium.slope2BpsPerDay) / 100).toFixed(2)}%/day at
        full use. Cover starts {fmtDuration(Number(m.coverDelay))} after purchase.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------- policies

function policyStatus(p: MarketState["policies"][number], now: bigint): { text: string; tone: Level | "muted" } {
  if (p.settled) {
    if (p.owed > 0n) return { text: p.owed === p.premium && p.owed !== p.notional ? "Refund to claim" : "Payout to claim", tone: "amber" };
    return { text: "Claimed", tone: "muted" };
  }
  if (p.expiry < now) return { text: "Expired", tone: "muted" };
  if (p.activeAt > now) return { text: `Starts in ${fmtDuration(Number(p.activeAt - now))}`, tone: "amber" };
  return { text: "Covered", tone: "green" };
}

export function PoliciesPanel({ m }: { m: MarketState }) {
  return (
    <Card
      index="06"
      title="Drain protection policies"
      subtitle={`${m.policiesCount.toString()} sold · ${fmtCompact(m.activeNotional)} live cover`}
    >
      {m.policies.length === 0 ? (
        <p className="text-sm text-muted">No policies yet.</p>
      ) : (
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-[400px] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-line">
                <th className="py-2 pl-4 font-normal sm:pl-0">ID</th>
                <th className="py-2 font-normal">Buyer</th>
                <th className="py-2 text-right font-normal">Notional</th>
                <th className="py-2 text-right font-normal">Premium</th>
                <th className="py-2 pr-4 text-right font-normal sm:pr-0">Status</th>
              </tr>
            </thead>
            <tbody>
              {m.policies.map((p) => {
                const s = policyStatus(p, m.now);
                return (
                  <tr key={p.id.toString()} className="border-b border-line/60 last:border-0">
                    <td className="num py-2 pl-4 sm:pl-0">#{p.id.toString()}</td>
                    <td className="py-2">
                      <ExtLink href={`${explorers.unichain}/address/${p.buyer}`}>{shortHex(p.buyer, 4)}</ExtLink>
                    </td>
                    <td className="num py-2 text-right">{fmtCompact(p.notional)}</td>
                    <td className="num py-2 text-right">{fmtToken(p.premium)}</td>
                    <td className="py-2 pr-4 text-right sm:pr-0">
                      <Pill tone={s.tone}>{s.text}</Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- latency

export function LatencyPanel({ history }: { history: MarkPoint[] | undefined }) {
  const recent = (history ?? []).slice(-8).reverse();
  const lat = (history ?? []).map((p) => p.latency);
  const median = lat.length ? [...lat].sort((a, b) => a - b)[Math.floor(lat.length / 2)] : null;
  return (
    <Card
      index="07"
      title="Callback latency"
      subtitle="Reactive's clock when the mark was computed → Unichain's clock when it landed."
      right={median !== null ? <Pill tone="muted">median {median}s</Pill> : undefined}
      className="flex flex-col"
    >
      {recent.length === 0 ? (
        <p className="text-sm text-muted" role="status">
          {history ? "No marks have reached the market yet." : "Loading mark history…"}
        </p>
      ) : (
        <ul className="divide-y divide-line/60 text-sm">
          {recent.map((p) => (
            <li key={p.txHash} className="flex items-center justify-between gap-3 py-2">
              <span className="num text-muted">{fmtTime(p.receivedAt)}</span>
              <span className="num">{fmtBps(p.markBps)}</span>
              <span className="num">{p.latency}s</span>
              <ExtLink href={`${explorers.unichain}/tx/${p.txHash}`}>{shortHex(p.txHash, 4)}</ExtLink>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">The chains&apos; clocks differ by about a second, so 0–1s readings are within noise.</p>
      {median !== null && <LatencyFigure median={median} latencies={recent.map((p) => p.latency).reverse()} />}
    </Card>
  );
}

// ---------------------------------------------------------------- system health

export function HealthPanel({ m, r, o }: { m: MarketState; r: ReactiveState; o: OriginState }) {
  return (
    <Card index="08" title="System" subtitle="Chain heads and the funding that keeps settlement running.">
      <dl className="grid grid-cols-1 gap-y-1 text-sm">
        <Row k="Base Sepolia head" v={fmtTime(o.now)} />
        <Row k="Unichain Sepolia head" v={`#${m.blockNumber.toString()} · ${fmtTime(m.now)}`} />
        <Row k="Reactive Lasna head" v={fmtTime(r.now)} />
        <Row k="RiftReactive balance" v={`${fmtToken(r.balance, 3)} lREACT`} />
        <Row k="Market callback funding" v={`${fmtToken(m.callbackFunding, 4)} ETH`} />
        <Row
          k="Trip state"
          v={r.tripped ? (r.tripConfirmed ? "tripped · confirmed" : "tripped · awaiting confirmation") : `armed · ${r.tripsSent.toString()} sent all-time`}
        />
        <Row k="Mark heartbeat" v={`every ≤ ${fmtDuration(Number(r.params.markHeartbeat))}`} />
        <Row k="Max mark age" v={fmtDuration(Number(m.maxMarkAge))} />
      </dl>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line/60 py-1.5">
      <dt className="text-muted">{k}</dt>
      <dd className="num text-right">{v}</dd>
    </div>
  );
}

/** Fills the latency card's lower half: the median as a large figure, plus one bar per recent mark. */
function LatencyFigure({ median, latencies }: { median: number; latencies: number[] }) {
  const max = Math.max(4, ...latencies);
  return (
    <div className="mt-auto flex items-end justify-between gap-6 border-t border-line pt-6">
      <div>
        <div className="text-xs text-muted">Median, mark to market</div>
        <div className="display" style={{ fontSize: "clamp(4rem, 9vw, 6.5rem)", textTransform: "none" }}>
          {median}
          <span className="text-muted" style={{ fontSize: "0.45em" }}>
            s
          </span>
        </div>
      </div>
      <div className="flex h-24 items-end gap-1.5" aria-label={`Recent latencies: ${latencies.join(", ")} seconds`} role="img">
        {latencies.map((l, i) => (
          <div
            key={i}
            className="w-3"
            style={{ background: "var(--rift)", height: `${Math.max(8, (l / max) * 100)}%` }}
            title={`${l}s`}
          />
        ))}
      </div>
    </div>
  );
}
