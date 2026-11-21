/**
 * Tightly cropped, zoomed-in "imagery" drawn from Rift's own mechanics, so the page needs no stock photos.
 * Colours come from the landing theme tokens (--bone, --rift, --cold, --line...), so every visual works in
 * light and dark. Each SVG has an aria-label describing what it depicts.
 */

const ink = { fill: "var(--bone)" };
const dim = { fill: "var(--bone-dim)" };
const red = { fill: "var(--rift)" };

/** Macro crop of the recorded trip: the mark sits at +4.03%, then drops to −74.36% in one callback. */
export function TripCrop({ className = "" }: { className?: string }) {
  const steps = [
    [0, 30],
    [118, 30],
    [118, 31],
    [236, 31],
    [236, 30],
    [300, 30],
  ];
  const path = steps.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${y}`).join(" ");
  return (
    <svg viewBox="0 0 420 300" className={className} role="img" aria-label="Zoomed chart of the recorded trip: the mark falls from +4.03% to −74.36%">
      <defs>
        <linearGradient id="trip-fall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--rift)", stopOpacity: 0.5 }} />
          <stop offset="1" style={{ stopColor: "var(--rift)", stopOpacity: 0 }} />
        </linearGradient>
        <pattern id="trip-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" style={{ stroke: "var(--line)" }} strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="420" height="300" fill="url(#trip-grid)" />
      <line x1="0" y1="52" x2="420" y2="52" style={{ stroke: "var(--rift)" }} strokeOpacity="0.6" strokeDasharray="6 6" />
      <text x="8" y="46" style={{ ...red, fontFamily: "var(--lf-mono), monospace" }} fontSize="11" opacity="0.85">
        TRIP +5.00%
      </text>
      <path d="M 300 30 L 300 262 L 420 262 L 420 300 L 300 300 Z" fill="url(#trip-fall)" />
      <path d={`${path} L 300 262 L 420 262`} fill="none" style={{ stroke: "var(--bone)" }} strokeWidth="3" />
      <circle cx="300" cy="262" r="7" style={red} />
      <circle cx="300" cy="262" r="16" fill="none" style={{ stroke: "var(--rift)" }} strokeOpacity="0.5" />
      <text x="312" y="250" style={{ ...ink, fontFamily: "var(--lf-display), 'Arial Black', sans-serif" }} fontSize="22" fontWeight="800">
        −74.36%
      </text>
      <text x="8" y="22" style={{ ...dim, fontFamily: "var(--lf-mono), monospace" }} fontSize="11">
        MARK +4.03%
      </text>
    </svg>
  );
}

/** Extreme close-up of the constant-product curve, with the pool's price pushed down the curve by the dump. */
export function CurveCrop({ className = "" }: { className?: string }) {
  const pts: string[] = [];
  for (let x = 40; x <= 400; x += 6) {
    const y = 18000 / x;
    pts.push(`${x},${Math.min(300, y)}`);
  }
  return (
    <svg viewBox="40 40 360 260" className={className} role="img" aria-label="Close-up of a constant-product pool curve with the price moved along it">
      <defs>
        <pattern id="curve-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" style={{ stroke: "var(--cold)" }} strokeOpacity="0.22" strokeWidth="2" />
        </pattern>
      </defs>
      <polygon points={`40,300 ${pts.join(" ")} 400,300`} fill="url(#curve-hatch)" />
      <polyline points={pts.join(" ")} fill="none" style={{ stroke: "var(--cold)" }} strokeWidth="3" />
      <circle cx="90" cy={18000 / 90} r="6" style={ink} />
      <circle cx="210" cy={18000 / 210} r="7" style={red} />
      <path
        d={`M 96 ${18000 / 96} Q 150 ${18000 / 130 - 30} 203 ${18000 / 210 - 6}`}
        fill="none"
        style={{ stroke: "var(--rift)" }}
        strokeWidth="2"
        strokeDasharray="4 5"
      />
      <text x="218" y={18000 / 210 - 10} style={{ ...ink, fontFamily: "var(--lf-mono), monospace" }} fontSize="13">
        x·y = k
      </text>
    </svg>
  );
}

/** A strip of blocks across the three chains: Base origin, Lasna reaction, Unichain callback. */
export function BlockStrip({ className = "" }: { className?: string }) {
  const rows = [
    { chain: "BASE", color: "var(--cold)", hit: 5 },
    { chain: "LASNA", color: "var(--bone)", hit: 5 },
    { chain: "UNICHAIN", color: "var(--rift)", hit: 8 },
  ];
  return (
    <svg viewBox="0 0 420 150" className={className} role="img" aria-label="Blocks on Base, Lasna and Unichain, with the origin event, reaction and callback highlighted">
      {rows.map((r, ri) => (
        <g key={r.chain} transform={`translate(0 ${ri * 48 + 8})`}>
          <text x="0" y="22" style={{ ...dim, fontFamily: "var(--lf-mono), monospace" }} fontSize="10" letterSpacing="2">
            {r.chain}
          </text>
          {Array.from({ length: 11 }, (_, i) => (
            <rect
              key={i}
              x={88 + i * 30}
              y="6"
              width="24"
              height="24"
              style={{ fill: i === r.hit ? r.color : "transparent", stroke: i === r.hit ? r.color : "var(--line-strong)" }}
            />
          ))}
        </g>
      ))}
      <path
        d="M 250 38 L 250 62 M 250 86 L 250 98 L 340 98 L 340 110"
        fill="none"
        style={{ stroke: "var(--rift)" }}
        strokeWidth="1.5"
        strokeDasharray="3 4"
      />
    </svg>
  );
}
