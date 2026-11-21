"use client";

import { useEffect, useState } from "react";

import type { MarkPoint } from "@/lib/reads";
import { fmtBps, fmtTime } from "@/lib/format";

/** The container's width in px, so the SVG draws at 1:1 and its labels stay legible on phones. */
function useWidth(fallback: number) {
  const [w, setW] = useState(fallback);
  // Both render branches put the ref on an outer w-full div; re-observing when that element changes is cheap.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w] as const;
}

/**
 * Step chart of the perp mark as delivered to RiftMarket (one step per MarkUpdated event), with the trip
 * threshold at ±tripSpreadBps, optional reference lines (entry, liquidation), and the current mark tagged
 * at the right edge. The y-axis fits the data, the threshold band and the reference lines, so one distant
 * line doesn't squash the rest.
 */
export function MarkChart({
  points,
  now,
  tripSpreadBps,
  trip,
  lines: refLines = [],
  height,
  range,
}: {
  /** undefined while the history is still loading. */
  points: MarkPoint[] | undefined;
  now: number;
  tripSpreadBps: number;
  /** The trip sets the mark through trip(), not MarkUpdated, so it's drawn as its own final step. */
  trip?: { at: number; bps: number };
  /** Horizontal reference lines, e.g. a position's entry and liquidation marks. */
  lines?: { bps: number; label: string; color: string }[];
  /** Taller variant for the Trade screen. */
  height?: number;
  /** Seconds of history to show (the mark in force at the window's start is carried in). All if unset. */
  range?: number;
}) {
  const [box, W] = useWidth(640);
  // Drawn at the container's real width; on narrow screens a little shorter so it keeps its proportions.
  const H = Math.round(Math.min(height ?? 180, Math.max(150, W * 0.55)));
  const pad = { l: 52, r: 62, t: 12, b: 22 };

  if (!points || points.length === 0) {
    return (
      <div ref={box} className="w-full">
        <div className="flex items-center justify-center bg-panel-2 text-xs text-muted" style={{ height: H }} role="status">
          {points ? "No marks have reached the market yet." : "Loading mark history…"}
        </div>
      </div>
    );
  }

  // Window: the marks inside it, led by the one in force when it opens.
  const t1 = Math.max(now, points[points.length - 1].receivedAt + 1);
  let shown = points;
  let t0 = points[0].receivedAt;
  if (range && t1 - range > t0) {
    t0 = t1 - range;
    const before = points.filter((p) => p.receivedAt < t0);
    const inside = points.filter((p) => p.receivedAt >= t0);
    const lead = before[before.length - 1];
    shown = lead ? [{ ...lead, receivedAt: t0 }, ...inside] : inside;
  }
  const last = trip ? trip.bps : points[points.length - 1].markBps;

  const vals = [
    tripSpreadBps * 1.15,
    -tripSpreadBps * 1.15,
    ...shown.map((p) => p.markBps),
    ...(trip ? [trip.bps] : []),
    ...refLines.filter((l) => Number.isFinite(l.bps)).map((l) => l.bps),
  ];
  const rawHi = Math.max(...vals);
  const rawLo = Math.min(...vals);
  const span = Math.max(rawHi - rawLo, 50);
  const hi = rawHi + span * 0.08;
  const lo = rawLo - span * 0.08;

  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (bps: number) => pad.t + ((hi - bps) / (hi - lo)) * (H - pad.t - pad.b);

  // Step path: hold each mark until the next one lands, then extend the last mark to now.
  let d = shown.length ? `M ${x(shown[0].receivedAt)} ${y(shown[0].markBps)}` : `M ${x(t0)} ${y(last)}`;
  for (let i = 1; i < shown.length; i++) d += ` H ${x(shown[i].receivedAt)} V ${y(shown[i].markBps)}`;
  if (trip && trip.at >= t0) d += ` H ${x(trip.at)} V ${y(trip.bps)}`;
  d += ` H ${x(t1)}`;

  // Axis labels: the threshold band and zero, plus the extremes when the data runs far outside the band.
  // Labels closer than 14px to one already placed are dropped.
  const candidates = [tripSpreadBps, 0, -tripSpreadBps, ...(span > tripSpreadBps * 5 ? [rawHi, rawLo] : [])];
  const ticks: number[] = [];
  for (const b of candidates) if (ticks.every((t) => Math.abs(y(t) - y(b)) > 14)) ticks.push(b);
  const lastColor = last > 0 ? "var(--ok)" : last < 0 ? "var(--rift)" : "var(--text)";

  return (
    <div ref={box} className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block h-auto w-full" role="img" aria-label={`Perp mark over time, now ${fmtBps(last)}`}>
        {[0, tripSpreadBps, -tripSpreadBps].map((b) => (
          <line
            key={b}
            x1={pad.l}
            x2={W - pad.r}
            y1={y(b)}
            y2={y(b)}
            stroke={b === 0 ? "var(--line)" : "var(--red)"}
            strokeDasharray={b === 0 ? "" : "4 4"}
            strokeOpacity={b === 0 ? 1 : 0.6}
          />
        ))}
        {ticks.map((b) => (
          <text key={b} x={pad.l - 6} y={y(b) + 3} textAnchor="end" fontSize="10" fill="var(--muted)" className="num">
            {fmtBps(Math.round(b))}
          </text>
        ))}
        {refLines
          .filter((l) => Number.isFinite(l.bps))
          .map((l) => (
            <g key={l.label}>
              <line x1={pad.l} x2={W - pad.r} y1={y(l.bps)} y2={y(l.bps)} stroke={l.color} strokeWidth="1.5" strokeDasharray="6 4" />
              <text x={W - pad.r - 4} y={y(l.bps) - 4} textAnchor="end" fontSize="10" fill={l.color} className="num">
                {l.label} {fmtBps(Math.round(l.bps))}
              </text>
            </g>
          ))}
        <path d={d} fill="none" stroke="var(--text)" strokeWidth="2" />
        {shown.map((p, i) => (
          <circle key={`${p.txHash}-${i}`} cx={x(p.receivedAt)} cy={y(p.markBps)} r="2.5" fill="var(--text)">
            <title>{`${fmtBps(p.markBps)} at ${fmtTime(p.receivedAt)} (latency ${p.latency}s)`}</title>
          </circle>
        ))}
        {trip && trip.at >= t0 && (
          <g>
            <circle cx={x(trip.at)} cy={y(trip.bps)} r="4" fill="var(--red)">
              <title>{`Tripped at ${fmtBps(trip.bps)}, ${fmtTime(trip.at)}`}</title>
            </circle>
            <text x={x(trip.at) - 8} y={y(trip.bps) - 8} fontSize="10" fill="var(--red)" textAnchor="end">
              trip {fmtBps(trip.bps)}
            </text>
          </g>
        )}
        {/* Live tag: the mark in force now, in the right gutter. */}
        <g>
          <line x1={x(t1)} x2={W - pad.r + 4} y1={y(last)} y2={y(last)} stroke={lastColor} />
          <rect x={W - pad.r + 4} y={y(last) - 9} width={pad.r - 6} height={18} fill={lastColor} />
          <text x={W - pad.r + 4 + (pad.r - 6) / 2} y={y(last) + 3.5} textAnchor="middle" fontSize="10" fontWeight="700" fill={last === 0 ? "var(--ink)" : "var(--on-rift)"} className="num">
            {fmtBps(last)}
          </text>
        </g>
        <text x={pad.l} y={H - 6} fontSize="10" fill="var(--muted)" className="num">
          {fmtTime(t0)}
        </text>
        <text x={W - pad.r} y={H - 6} fontSize="10" fill="var(--muted)" textAnchor="end" className="num">
          now
        </text>
      </svg>
    </div>
  );
}
