const WAD = 1e18;

/** 18-decimal token amount, e.g. 100000e18 -> "100,000.00". */
export function fmtToken(x: bigint, dp = 2): string {
  const n = Number(x) / WAD;
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Compact token amount, e.g. 1.2M, 950k. */
export function fmtCompact(x: bigint): string {
  return (Number(x) / WAD).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

/** Basis points as a signed percent, e.g. 403 -> "+4.03%". */
export function fmtBps(x: bigint | number, signed = true): string {
  const n = Number(x) / 100;
  const s = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return signed && n > 0 ? `+${s}%` : `${s}%`;
}

/** 1e18 fixed-point price, e.g. 2e18 -> "2.0000". */
export function fmtPrice(x: bigint, dp = 4): string {
  return (Number(x) / WAD).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtPct(wad: bigint): string {
  return `${((Number(wad) / WAD) * 100).toFixed(1)}%`;
}

export function shortHex(h: string, n = 6): string {
  return h.length <= 2 + 2 * n ? h : `${h.slice(0, 2 + n)}…${h.slice(-4)}`;
}

export function fmtTime(unix: bigint | number): string {
  return new Date(Number(unix) * 1000).toLocaleTimeString("en-US", { hour12: false });
}
