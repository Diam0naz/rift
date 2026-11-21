"use client";

import { useEffect, useRef, useState } from "react";
import { pad, toHex } from "viem";

import { addresses, explorers } from "@/lib/config";
import { fmtBps, fmtCompact, fmtPrice, fmtTime, fmtToken, shortHex } from "@/lib/format";
import { useMarkHistory, useMarket, useOrigin, useReactive } from "@/lib/hooks";
import { useReactiveEvents } from "@/lib/indexer";
import { useMarketLogs, type MarketLog } from "@/lib/logs";
import type { MarketState, OriginState, ReactiveState } from "@/lib/reads";
import { RECORDED } from "@/lib/recorded";
import { HEARTBEAT_LREACT_PER_DAY, fmtDuration, type Level } from "@/lib/risk";

import { HealthPanel, LatencyPanel, TripPanel } from "../../panels";
import { Card, LevelDot, Skeleton } from "../../ui";
import { PageHeader } from "../AppShell";
import { Rows } from "../bits";

export function MonitorScreen() {
  const m = useMarket().data;
  const r = useReactive().data;
  const o = useOrigin().data;
  const history = useMarkHistory();
  return (
    <>
      <PageHeader
        kicker="04 / Reactive watch · three chains"
        title="Monitor"
        intro="What Reactive Network is watching right now, on each chain, and the last drain it turned into a payout."
      />
      {m && r && o ? <ChainColumns m={m} r={r} o={o} /> : <Skeleton className="h-72 w-full" />}
      <div className="mt-5">
        <LivePath />
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-12">
        <div className="lg:col-span-7">{m ? <DrainSequence m={m} /> : <Skeleton className="h-96 w-full" />}</div>
        <div className="lg:col-span-5">{r && o ? <TripPanel r={r} o={o} /> : <Skeleton className="h-96 w-full" />}</div>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <LatencyPanel history={history.data} />
        {m && r && o ? <HealthPanel m={m} r={r} o={o} /> : <Skeleton className="h-64 w-full" />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- per-chain status

function Status({ level, text }: { level: Level; text: string }) {
  return (
    <span className="kicker flex items-center gap-2 !text-[0.62rem]">
      <LevelDot level={level} />
      {text}
    </span>
  );
}

function ChainColumns({ m, r, o }: { m: MarketState; r: ReactiveState; o: OriginState }) {
  const markAge = Number(m.now - m.markReceivedAt);
  const live = markAge <= Number(m.maxMarkAge);
  const sinceMark = Number(r.now - r.lastSentAt);
  const runway = Number(r.balance) / 1e18 / HEARTBEAT_LREACT_PER_DAY;
  const breachFor = r.breachSince > 0n ? Number(r.now - r.breachSince) : 0;
  const rcState: [Level, string] = r.tripped
    ? ["red", r.tripConfirmed ? "Tripped · confirmed" : "Tripped · awaiting confirmation"]
    : breachFor > 0
      ? ["amber", `Breach running ${breachFor}s`]
      : ["green", "Watching"];

  const col = (chain: string, role: string, status: React.ReactNode, rows: [React.ReactNode, React.ReactNode][], tint: string) => (
    <div className="p-5 sm:p-6" style={{ background: "var(--ink-2)", boxShadow: `inset 0 3px 0 ${tint}` }}>
      <div className="kicker !text-[0.6rem]">{role}</div>
      <div className="display-tight mt-2 text-2xl">{chain}</div>
      <div className="mt-3">{status}</div>
      <div className="mt-4">
        <Rows rows={rows} />
      </div>
    </div>
  );

  return (
    <section className="app-panel corner-ticks grid gap-px lg:grid-cols-3" style={{ background: "var(--line-strong)" }} aria-label="Chains">
      {col(
        "Base Sepolia",
        "Origin · the vault and pool #1",
        <Status level="green" text={`Head ${fmtTime(o.now)}`} />,
        [
          ["Pool price", fmtPrice(o.price)],
          ["Vault holdings", `${fmtCompact(o.vaultAssets)} tQUOTE`],
          ["Watched events", "Sync, vault Transfer in/out"],
        ],
        "var(--cold)",
      )}
      {col(
        "Reactive Lasna",
        "RiftReactive · the watcher",
        <Status level={rcState[0]} text={rcState[1]} />,
        [
          ["Mirrored prices", `${fmtPrice(r.priceBase, 3)} · ${fmtPrice(r.priceUni, 3)}`],
          ["Raw / smoothed spread", `${fmtBps(r.spreadBps)} / ${fmtBps(r.smoothedSpreadBps)}`],
          ["Outflow in window", fmtBps(r.outflowBps, false)],
          ["Last mark sent", r.lastSentAt > 0n ? `${fmtDuration(sinceMark)} ago (#${r.marksSent.toString()})` : "none yet"],
          ["Trips sent", r.tripsSent.toString()],
          ["lREACT runway", `${(Number(r.balance) / 1e18).toFixed(2)} · ~${runway.toFixed(1)} days`],
        ],
        "var(--bone)",
      )}
      {col(
        "Unichain Sepolia",
        "RiftMarket · settlement",
        <Status level={m.tripped ? "red" : live ? "green" : "amber"} text={m.tripped ? "Tripped" : live ? "Taking new risk" : "Paused: mark stale"} />,
        [
          ["Head block", `#${m.blockNumber.toString()} · ${fmtTime(m.now)}`],
          ["Mark", `${fmtBps(m.markBps)} · ${fmtDuration(markAge)} old`],
          ["Liveness limit", fmtDuration(Number(m.maxMarkAge))],
          ["Callback funding", `${fmtToken(m.callbackFunding, 4)} ETH`],
        ],
        "var(--rift)",
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the live path

function LivePath() {
  const hops = [
    ["Origin event", "Swap or vault transfer on Base / Unichain"],
    ["react()", "RiftReactive on Lasna re-evaluates both conditions"],
    ["Callback", "updateMark or trip lands on Unichain"],
  ];
  return (
    <section className="app-panel relative overflow-hidden px-5 py-6 sm:px-8" aria-label="How an event travels">
      <div className="relative grid gap-6 sm:grid-cols-3">
        <div className="seam-line pointer-events-none absolute left-0 right-0 top-[14px] hidden h-px sm:block" aria-hidden />
        {hops.map(([title, text], i) => (
          <div key={title} className="relative">
            <span className="relative z-10 inline-block h-[10px] w-[10px]" style={{ background: i === 1 ? "var(--rift)" : "var(--bone)", marginTop: 9 }} aria-hidden />
            <div className="kicker mt-4 !text-[var(--bone)]">
              <span style={{ color: "var(--rift)" }}>0{i + 1} /</span> {title}
            </div>
            <p className="mt-1 text-sm text-muted">{text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the drain sequence

type Hop = { step: string; chain: string; title: string; text: string; href?: string; label?: string };

function DrainSequence({ m }: { m: MarketState }) {
  const logs = useMarketLogs();
  const trips = (logs.data ?? []).filter((l) => l.eventName === "Tripped");
  const trip: MarketLog | undefined = trips[trips.length - 1];
  const claims = trip ? (logs.data ?? []).filter((l) => l.eventName === "Claimed" && l.blockNumber >= trip.blockNumber) : [];
  const reactive = useReactiveEvents().data;

  let hops: Hop[];
  let elapsed: number;
  let caption: string;
  if (trip) {
    const a = trip.args as { markBps: bigint; outflowBps: bigint; observedAt: bigint; receivedAt: bigint; originChainId: bigint; originTxHash: bigint; payoutRatioBps: bigint };
    const originHash = pad(toHex(a.originTxHash), { size: 32 });
    const originExplorer = Number(a.originChainId) === 84532 ? explorers.base : explorers.unichain;
    elapsed = Number(a.receivedAt - a.observedAt);
    caption = `Latest trip on this market · block ${trip.blockNumber.toString()} · observed ${fmtTime(a.observedAt)}`;
    // With the indexer, the reaction hop is RiftReactive's actual TripSent tx on Lasna, matched by origin tx.
    const sent = reactive?.find((e) => e.event === "TripSent" && e.args.originTxHash === a.originTxHash);
    hops = [
      { step: "01", chain: Number(a.originChainId) === 84532 ? "Base Sepolia" : "Unichain Sepolia", title: "Origin", text: `The event that completed both conditions. Outflow ${fmtBps(a.outflowBps, false)}.`, href: `${originExplorer}/tx/${originHash}`, label: shortHex(originHash, 6) },
      sent
        ? { step: "02", chain: "Reactive Lasna", title: "Reaction", text: `RiftReactive saw both conditions hold and requested the trip callback, ${Math.max(0, sent.ts - Number(a.observedAt))}s after the origin block.`, href: `${explorers.lasna}/tx/${sent.txHash}`, label: shortHex(sent.txHash, 6) }
        : { step: "02", chain: "Reactive Lasna", title: "Reaction", text: "RiftReactive saw both conditions hold and requested the trip callback.", href: `${explorers.lasna}/address/${addresses.lasna.reactive}`, label: "RiftReactive ↗" },
      { step: "03", chain: "Unichain Sepolia", title: "Settlement", text: `Payouts fixed at ${Number(a.payoutRatioBps) / 100}%, perp frozen at ${fmtBps(a.markBps)}.`, href: `${explorers.unichain}/tx/${trip.txHash}`, label: shortHex(trip.txHash, 6) },
      {
        step: "04",
        chain: "Unichain Sepolia",
        title: claims.length ? "Claimed" : "Claims open",
        text: claims.length
          ? `${claims.length} claim${claims.length > 1 ? "s" : ""}, ${fmtToken(claims.reduce((s, c) => s + (c.args.amount as bigint), 0n), 0)} tUSD paid.`
          : m.totalOwed > 0n
            ? `${fmtToken(m.totalOwed, 0)} tUSD waiting to be claimed.`
            : "No covered policies were live.",
        href: claims[0] ? `${explorers.unichain}/tx/${claims[0].txHash}` : undefined,
        label: claims[0] ? shortHex(claims[0].txHash, 6) : undefined,
      },
    ];
  } else {
    elapsed = 2;
    caption = logs.isLoading
      ? "Reading this market's history… showing the recorded testnet run meanwhile"
      : "No trip on this market yet · showing the recorded testnet run";
    hops = [
      { step: "01", chain: "Base Sepolia", title: "Origin", text: "The vault is drained and the loot dumped into the pool.", href: `${explorers.base}/tx/${RECORDED.trip.origin}`, label: shortHex(RECORDED.trip.origin, 6) },
      { step: "02", chain: "Reactive Lasna", title: "Reaction", text: "RiftReactive saw both conditions hold.", href: `${explorers.lasna}/tx/${RECORDED.trip.reactive}`, label: shortHex(RECORDED.trip.reactive, 6) },
      { step: "03", chain: "Unichain Sepolia", title: "Settlement", text: "Every covered payout fixed in the callback.", href: `${explorers.unichain}/tx/${RECORDED.trip.callback}`, label: shortHex(RECORDED.trip.callback, 6) },
      { step: "04", chain: "Unichain Sepolia", title: "Claimed", text: "10,000 tUSD paid to the buyer.", href: `${explorers.unichain}/tx/${RECORDED.claim}`, label: shortHex(RECORDED.claim, 6) },
    ];
  }

  // Replay: reveal hops one by one while a timer runs to the recorded elapsed time.
  const [shown, setShown] = useState(hops.length);
  const [clock, setClock] = useState<number | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const replay = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(hops.length);
      setClock(elapsed);
      return;
    }
    setShown(0);
    setClock(0);
    const total = Math.max(elapsed, 1) * 1000;
    hops.forEach((_, i) => timers.current.push(window.setTimeout(() => setShown(i + 1), (total * (i + 0.5)) / (hops.length - 0.5))));
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      setClock(Math.min(t, elapsed));
      if (t < elapsed) timers.current.push(window.setTimeout(tick, 33));
    };
    tick();
  };

  return (
    <Card
      index="B"
      ticks
      title="Drain to payout"
      subtitle={caption}
      right={
        <button type="button" className="btn-ghost btn-sm" onClick={replay}>
          Replay
        </button>
      }
    >
      <div className="mb-5 flex items-end gap-4">
        <span className="display text-[clamp(3rem,7vw,5.5rem)]" style={{ color: "var(--rift)", textTransform: "none" }} aria-live="polite">
          {(clock ?? elapsed).toFixed(clock === null || clock >= elapsed ? 0 : 1)}s
        </span>
        <span className="pb-3 text-sm text-muted">from the observation on Reactive to settlement on Unichain (block timestamps, 1 s resolution)</span>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2">
        {hops.map((h, i) => (
          <li
            key={h.step}
            className="border p-4 transition-all duration-300"
            style={{
              borderColor: "var(--line-strong)",
              background: i === 2 ? "var(--bone)" : "var(--ink-3)",
              color: i === 2 ? "var(--ink)" : "var(--bone)",
              opacity: i < shown ? 1 : 0.15,
              transform: i < shown ? "none" : "translateY(6px)",
            }}
          >
            <div className="mono flex justify-between text-[0.65rem] uppercase tracking-[0.16em] opacity-70">
              <span>
                {h.step} · {h.title}
              </span>
              <span>{h.chain}</span>
            </div>
            <p className="mt-2 text-sm opacity-85">{h.text}</p>
            {h.href && (
              <a href={h.href} target="_blank" rel="noreferrer" className="mono mt-3 inline-block text-xs underline underline-offset-4">
                {h.label} ↗
              </a>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
