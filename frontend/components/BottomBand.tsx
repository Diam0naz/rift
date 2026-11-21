"use client";

import { useMemo } from "react";

import { fmtBps } from "@/lib/format";

/** Catchphrases for the marquee. Each one is true of the contracts (see README / docs/DESIGN.md). */
const CATCHPHRASES = ["Trade the gap", "Payout fixed in ~2s", "Two conditions or nothing", "Settled by Reactive Network", "Mind the gap"];

/**
 * Closing band for the dashboard: large type plus a looping seismograph whose amplitude follows the live
 * raw spread (calm when the pools agree, jagged as the spread approaches the trip threshold, red after a trip).
 * It grows to fill whatever height the viewport has left, so tall screens never end on blank space.
 */
export function BottomBand({
  spreadBps,
  tripSpreadBps,
  tripped,
}: {
  spreadBps: bigint | undefined;
  tripSpreadBps: bigint | undefined;
  tripped: boolean | undefined;
}) {
  const stress = useMemo(() => {
    if (spreadBps === undefined || !tripSpreadBps) return 0.15;
    const abs = Number(spreadBps < 0n ? -spreadBps : spreadBps);
    return Math.max(0.12, Math.min(1, abs / Number(tripSpreadBps)));
  }, [spreadBps, tripSpreadBps]);

  // One period of the trace, drawn twice side by side and scrolled by exactly one period, so it loops seamlessly.
  const P = 600;
  const path = useMemo(() => {
    // Peak excursion is ~36 of the 50-unit half-height at full stress (~12 when calm), so even a tripped
    // market's spike stays inside the band.
    const amp = 5 + stress * 9;
    const pts: string[] = [];
    for (let x = 0; x <= P * 2; x += 4) {
      const t = (x % P) / P;
      // Low swell, a faster tremor, and one heartbeat-like spike per period.
      const swell = Math.sin(t * Math.PI * 4) * 0.35;
      const tremor = Math.sin(t * Math.PI * 38) * 0.18 * (0.4 + stress);
      const spikeCenter = 0.62;
      const d = (t - spikeCenter) * 60;
      const spike = Math.exp(-d * d) * (1.6 + stress) - Math.exp(-(d - 1.6) * (d - 1.6)) * (0.9 + stress * 0.6);
      pts.push(`${x},${(50 - (swell + tremor + spike) * amp).toFixed(1)}`);
    }
    return `M ${pts.join(" L ")}`;
  }, [stress]);

  const color = tripped ? "var(--rift)" : stress >= 0.8 ? "var(--warn)" : "var(--cold)";

  return (
    <section
      aria-label="Every second counts"
      className="relative z-10 mt-16 flex flex-1 flex-col overflow-hidden border-t"
      style={{ borderColor: "var(--line-strong)" }}
    >
      {/* Flexible strip: absorbs whatever height is left on tall screens, so the page never ends on blank space. */}
      <div className="dots relative flex min-h-[9rem] flex-1 items-center overflow-hidden border-b sm:min-h-[11rem]" style={{ borderColor: "var(--line)" }} aria-hidden>
        <div className="ticker ticker-reverse">
          {[0, 1].map((dup) => (
            <div key={dup} className="flex shrink-0 items-center">
              {CATCHPHRASES.map((phrase, i) => (
                <span key={phrase + dup} className="flex items-center">
                  <span
                    className={`display whitespace-nowrap px-8 ${i % 2 ? "outline-text" : ""}`}
                    style={{ fontSize: "clamp(3rem, 7.5vw, 6.5rem)", opacity: i % 2 ? 1 : 0.9 }}
                  >
                    {phrase}
                  </span>
                  <span className="display px-2" style={{ fontSize: "clamp(2rem, 4vw, 3.5rem)", color: "var(--rift)" }}>
                    /
                  </span>
                </span>
              ))}
            </div>
          ))}
        </div>
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: "linear-gradient(90deg, var(--ink), transparent 12%, transparent 88%, var(--ink))" }}
        />
      </div>

      <div className="mx-auto w-full max-w-[1440px] px-4 pb-8 pt-14 sm:px-6 lg:px-12">
        <p className="kicker mb-5">
          Raw spread {spreadBps === undefined ? "…" : fmtBps(spreadBps)}
          {tripped ? " · tripped" : stress >= 0.8 ? " · near the trip threshold" : " · watching both pools"}
        </p>
        <h2 className="display" style={{ fontSize: "clamp(3.25rem, 10.5vw, 9.5rem)" }}>
          Every second
          <br />
          <span className="outline-text">counts</span>
          <span style={{ color: "var(--rift)" }}>.</span>
        </h2>
      </div>

      <div className="relative h-28 w-full overflow-hidden sm:h-32" aria-hidden>
        <svg
          viewBox={`0 0 ${P * 2} 100`}
          preserveAspectRatio="none"
          className="seismo absolute inset-y-0 left-0 h-full"
          style={{ width: "200%" }}
        >
          <line x1="0" x2={P * 2} y1="50" y2="50" stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d={path} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: "linear-gradient(90deg, var(--ink), transparent 18%, transparent 82%, var(--ink))" }}
        />
      </div>

      <footer className="kicker mx-auto w-full max-w-[1440px] px-4 pb-8 pt-4 sm:px-6 lg:px-12">
        Testnet demo. Read directly from Base Sepolia, Unichain Sepolia and Reactive Lasna every few seconds.
      </footer>
    </section>
  );
}
