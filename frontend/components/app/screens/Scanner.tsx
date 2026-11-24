"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { PRESETS, SCAN_CHAINS, align, preferFlip, readPool, spreadBps, type PoolRead, type PoolSide, type ScanChain } from "@/lib/scanner";

import { Card } from "../../ui";
import { PageHeader } from "../AppShell";
import { Banner, Field, Segmented } from "../bits";

const TRIP_BPS = 500; // RiftReactive's default spread condition (5%)

const fmtPrice = (x: number) =>
  x === 0 ? "0" : x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(4) : x.toPrecision(4);
const fmtPct = (bps: number) => `${bps > 0 ? "+" : bps < 0 ? "−" : ""}${Math.abs(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;

function parseSide(v: string | null): PoolSide | null {
  if (!v) return null;
  const [chain, address] = v.split(":");
  return SCAN_CHAINS.some((c) => c.key === chain) && address ? { chain: chain as ScanChain, address } : null;
}

export const usePool = (side: PoolSide) =>
  useQuery({
    queryKey: ["scan", side.chain, side.address.toLowerCase()],
    queryFn: () => readPool(side),
    enabled: /^0x[0-9a-fA-F]{40}$/.test(side.address),
    refetchInterval: 10_000,
    retry: 1,
  });

export function ScannerScreen() {
  const [a, setA] = useState<PoolSide>(PRESETS[0].a);
  const [b, setB] = useState<PoolSide>(PRESETS[0].b);
  const [flipA, setFlipA] = useState(false);
  const [history, setHistory] = useState<{ t: number; bps: number }[]>([]);

  // Shareable: ?a=chain:address&b=chain:address
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const pa = parseSide(q.get("a"));
    const pb = parseSide(q.get("b"));
    if (pa) setA(pa);
    if (pb) setB(pb);
  }, []);
  useEffect(() => {
    const q = new URLSearchParams({ a: `${a.chain}:${a.address}`, b: `${b.chain}:${b.address}` });
    window.history.replaceState(null, "", `${window.location.pathname}?${q}`);
    setHistory([]);
  }, [a, b]);

  const pa = usePool(a);
  const pb = usePool(b);
  // A stablecoin listed first is quoted as the unit by default; the button flips from there.
  const effFlipA = pa.data ? preferFlip(pa.data) !== flipA : flipA;
  const aligned = pa.data && pb.data ? align(pa.data, pb.data, effFlipA) : null;
  const bps = aligned ? spreadBps(aligned.qa.price, aligned.qb.price) : null;

  // Spread samples since the page opened (one per refresh of both pools).
  const last = useRef(0);
  useEffect(() => {
    if (bps === null || !aligned?.match) return;
    const t = Math.max(pa.dataUpdatedAt, pb.dataUpdatedAt);
    if (t === last.current) return;
    last.current = t;
    setHistory((h) => [...h.slice(-59), { t, bps }]);
  }, [bps, aligned?.match, pa.dataUpdatedAt, pb.dataUpdatedAt]);

  const preset = PRESETS.find((p) => p.a.chain === a.chain && p.a.address.toLowerCase() === a.address.toLowerCase() && p.b.chain === b.chain && p.b.address.toLowerCase() === b.address.toLowerCase());

  return (
    <>
      <PageHeader
        kicker="08 / Scanner · any two pools"
        title="Scanner"
        intro="Watch the rift between any two pools on Base, Unichain or Ethereum Sepolia: each price, live, and the gap between them. Read-only."
      />

      <div className="mb-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <Field label="Pair">
          <select
            className="app-input w-full"
            value={preset?.id ?? "custom"}
            onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value);
              if (p) {
                setA(p.a);
                setB(p.b);
                setFlipA(false);
              }
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            {!preset && <option value="custom">Custom pools</option>}
          </select>
        </Field>
        <div className="flex flex-wrap items-center gap-3 lg:pb-2">
          <p className="max-w-xl text-xs text-muted">{preset?.note ?? "Your own two pools. Prices refresh every 10 s."}</p>
          {aligned?.match && preset?.id !== "rift" && (
            <Link className="btn-ghost btn-sm" href={`/app/markets?a=${a.chain}:${a.address}&b=${b.chain}:${b.address}`}>
              List as a market →
            </Link>
          )}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-7">
          <div className="grid gap-5 md:grid-cols-2">
            <PoolCard index="A" side={a} onChange={setA} q={pa} quote={aligned?.qa} flip={effFlipA} onFlip={() => setFlipA((f) => !f)} />
            <PoolCard index="B" side={b} onChange={setB} q={pb} quote={aligned?.qb} />
          </div>
        </div>
        <div className="lg:col-span-5">
          <SpreadCard bps={bps} match={aligned?.match ?? true} ready={!!aligned} history={history} pair={aligned ? `${aligned.qa.base}/${aligned.qa.quote}` : ""} />
        </div>
      </div>

      <div className="mt-5">
        <Card index="D" title="What this is, and isn't">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
            <li>
              It <b className="text-[var(--bone)]">observes</b>: any two pools, any of three testnets, no wallet. The spread is B&apos;s price over A&apos;s, the same index Rift
              prices everything off.
            </li>
            <li>
              The <b className="text-[var(--bone)]">main market watches one pair</b>, the Rift twin pools, fixed in RiftReactive&apos;s subscriptions. To trade the
              gap on another pair, list it on <Link className="underline underline-offset-4" href="/app/markets">Markets</Link>: RiftHub picks up the listing and
              starts watching both pools. Cover on other pairs comes next.
            </li>
            <li>A trip also needs a vault outflow (≥ 15% in 5 minutes). A wide gap alone never pays; here only the price half is shown.</li>
            <li>Testnet pools barely trade, so their gaps reflect whoever traded last, not a real market. The mechanism is what&apos;s on show.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}

export function PoolCard({
  index,
  side,
  onChange,
  q,
  quote,
  flip,
  onFlip,
}: {
  index: string;
  side: PoolSide;
  onChange: (s: PoolSide) => void;
  q: ReturnType<typeof usePool>;
  quote?: { base: string; quote: string; price: number };
  flip?: boolean;
  onFlip?: () => void;
}) {
  const [draft, setDraft] = useState(side.address);
  useEffect(() => setDraft(side.address), [side.address]);
  const chain = SCAN_CHAINS.find((c) => c.key === side.chain)!;
  const p: PoolRead | undefined = q.data;
  return (
    <Card index={index} ticks title={`Pool ${index}`} subtitle={chain.name}>
      <div className="space-y-3">
        <Segmented
          value={side.chain}
          onChange={(c) => onChange({ ...side, chain: c })}
          label={`Pool ${index} chain`}
          options={SCAN_CHAINS.map((c) => ({ value: c.key, label: c.short }))}
        />
        <Field label="Pool address">
          <input
            className="app-input mono w-full text-sm"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value.trim())}
            onBlur={() => draft !== side.address && onChange({ ...side, address: draft })}
            onKeyDown={(e) => e.key === "Enter" && onChange({ ...side, address: draft })}
            aria-invalid={!!draft && !/^0x[0-9a-fA-F]{40}$/.test(draft)}
          />
        </Field>
      </div>
      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--line-strong)" }}>
        {q.isLoading ? (
          <p className="text-sm text-muted" role="status">
            Reading the pool…
          </p>
        ) : q.isError ? (
          <p className="text-sm" style={{ color: "var(--warn)" }}>
            {(q.error as Error).message}
          </p>
        ) : p && quote ? (
          <>
            <div className="kicker !text-[0.62rem]">
              {p.kind}
              {p.feePct ? ` · ${p.feePct}%` : ""} · {p.token0.symbol}/{p.token1.symbol}
            </div>
            <div className="mono mt-2 break-all text-2xl">{fmtPrice(quote.price)}</div>
            <div className="mt-1 text-xs text-muted">
              {quote.quote} per {quote.base}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span>{p.depth}</span>
              <a className="underline underline-offset-4" href={`${chain.explorer}/address/${side.address}`} target="_blank" rel="noreferrer">
                explorer ↗
              </a>
            </div>
            {onFlip && (
              <button type="button" className="btn-ghost btn-sm mt-3" onClick={onFlip}>
                {flip ? "Quote the other way" : "Flip the quote"}
              </button>
            )}
          </>
        ) : null}
      </div>
    </Card>
  );
}

function SpreadCard({ bps, match, ready, history, pair }: { bps: number | null; match: boolean; ready: boolean; history: { t: number; bps: number }[]; pair: string }) {
  const abs = bps === null ? 0 : Math.abs(bps);
  const tone = abs >= TRIP_BPS ? "var(--rift)" : abs >= TRIP_BPS / 2 ? "var(--warn)" : "var(--ok)";
  const path = useMemo(() => {
    if (history.length < 2) return "";
    const vals = history.map((h) => h.bps);
    const lo = Math.min(...vals, -TRIP_BPS * 1.2);
    const hi = Math.max(...vals, TRIP_BPS * 1.2);
    const y = (v: number) => 8 + ((hi - v) / (hi - lo || 1)) * 104;
    return history.map((h, i) => `${i ? "L" : "M"}${(i / (history.length - 1)) * 600} ${y(h.bps).toFixed(1)}`).join(" ");
  }, [history]);
  return (
    <Card index="C" ticks title="The rift" subtitle={pair ? `B over A · ${pair}` : "B over A"}>
      {!ready ? (
        <p className="text-sm text-muted" role="status">
          Waiting for both pools…
        </p>
      ) : !match ? (
        <Banner tone="warn">These pools don&apos;t trade the same pair, so their gap means nothing. Pick two pools of the same tokens.</Banner>
      ) : (
        <>
          <div className="display text-[clamp(2.6rem,5vw,4.5rem)]" style={{ color: tone, textTransform: "none" }} aria-live="polite">
            {fmtPct(bps ?? 0)}
          </div>
          <div className="mt-4">
            <div className="mb-1.5 flex justify-between text-xs">
              <span className="text-muted">vs Rift&apos;s spread condition</span>
              <span className="mono">{abs >= TRIP_BPS ? "past 5%: would count toward a trip" : `${((abs / TRIP_BPS) * 100).toFixed(0)}% of the 5% threshold`}</span>
            </div>
            <div className="h-2 w-full" style={{ background: "var(--line)" }}>
              <div className="h-2" style={{ width: `${Math.min(100, (abs / TRIP_BPS) * 100)}%`, background: tone }} />
            </div>
          </div>
          <div className="mt-5">
            <div className="kicker mb-2 !text-[0.6rem]">Since you opened this page · every 10 s</div>
            {path ? (
              <svg viewBox="0 0 600 120" className="h-24 w-full" preserveAspectRatio="none" role="img" aria-label="Spread over time">
                <path d={path} fill="none" stroke="var(--bone)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              </svg>
            ) : (
              <p className="text-xs text-muted">Collecting samples…</p>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
