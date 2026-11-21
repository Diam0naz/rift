import type { MarkPoint } from "@/lib/reads";
import { fmtBps, fmtTime } from "@/lib/format";

/**
 * Step chart of the perp mark as delivered to RiftMarket (one step per MarkUpdated event),
 * with the trip threshold drawn at ±tripSpreadBps.
 */
export function MarkChart({
  points,
  now,
  tripSpreadBps,
  trip,
}: {
  /** undefined while the history is still loading. */
  points: MarkPoint[] | undefined;
  now: number;
  tripSpreadBps: number;
  /** The trip sets the mark through trip(), not MarkUpdated, so it's drawn as its own final step. */
  trip?: { at: number; bps: number };
}) {
  const W = 640;
  const H = 180;
  const pad = { l: 56, r: 8, t: 10, b: 22 };

  if (!points || points.length === 0) {
    return (
      <div className="flex h-[180px] items-center justify-center bg-panel-2 text-xs text-muted" role="status">
        {points ? "No marks have reached the market yet." : "Loading mark history…"}
      </div>
    );
  }

  const t0 = points[0].receivedAt;
  const t1 = Math.max(now, points[points.length - 1].receivedAt + 1);
  const maxAbs = Math.max(
    tripSpreadBps * 1.15,
    ...points.map((p) => Math.abs(p.markBps)),
    trip ? Math.abs(trip.bps) * 1.08 : 0,
    50,
  );
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (bps: number) => pad.t + ((maxAbs - bps) / (2 * maxAbs)) * (H - pad.t - pad.b);

  // Step path: hold each mark until the next one lands, then extend the last mark to now.
  let d = `M ${x(points[0].receivedAt)} ${y(points[0].markBps)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` H ${x(points[i].receivedAt)} V ${y(points[i].markBps)}`;
  }
  if (trip) d += ` H ${x(trip.at)} V ${y(trip.bps)}`;
  d += ` H ${x(t1)}`;

  // When the axis is much wider than the trip band (after a crash), label only the extremes and zero;
  // the dashed threshold lines stay, explained in the caption.
  const crowded = maxAbs > tripSpreadBps * 4;
  const ticks = crowded ? [maxAbs, 0, -maxAbs] : [tripSpreadBps, 0, -tripSpreadBps];
  const lines = crowded ? [...ticks, tripSpreadBps, -tripSpreadBps] : ticks;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Perp mark over time">
      {lines.map((b, i) => (
        <g key={i}>
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={y(b)}
            y2={y(b)}
            stroke={Math.abs(b) === tripSpreadBps ? "var(--red)" : "var(--line)"}
            strokeDasharray={Math.abs(b) === tripSpreadBps ? "4 4" : b === 0 ? "" : "2 6"}
            strokeOpacity={Math.abs(b) === tripSpreadBps ? 0.6 : 1}
          />
          {ticks.includes(b) && (
            <text x={pad.l - 6} y={y(b) + 3} textAnchor="end" fontSize="10" fill="var(--muted)" className="num">
              {fmtBps(Math.round(b))}
            </text>
          )}
        </g>
      ))}
      <path d={d} fill="none" stroke="var(--text)" strokeWidth="2" />
      {points.map((p) => (
        <circle key={p.txHash} cx={x(p.receivedAt)} cy={y(p.markBps)} r="2.5" fill="var(--text)">
          <title>{`${fmtBps(p.markBps)} at ${fmtTime(p.receivedAt)} (latency ${p.latency}s)`}</title>
        </circle>
      ))}
      {trip && (
        <g>
          <circle cx={x(trip.at)} cy={y(trip.bps)} r="4" fill="var(--red)">
            <title>{`Tripped at ${fmtBps(trip.bps)}, ${fmtTime(trip.at)}`}</title>
          </circle>
          <text x={x(trip.at) + 8} y={y(trip.bps) - 8} fontSize="10" fill="var(--red)" textAnchor="start">
            trip {fmtBps(trip.bps)}
          </text>
        </g>
      )}
      <text x={pad.l} y={H - 6} fontSize="10" fill="var(--muted)" className="num">
        {fmtTime(t0)}
      </text>
      <text x={W - pad.r} y={H - 6} fontSize="10" fill="var(--muted)" textAnchor="end" className="num">
        now
      </text>
    </svg>
  );
}
