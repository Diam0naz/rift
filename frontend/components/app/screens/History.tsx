"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { isAddress, type Hash } from "viem";

import { explorers } from "@/lib/config";
import { totalsOf, tripsOf, type Totals, type Trip } from "@/lib/derive";
import { fmtBps, fmtCompact, fmtPrice, fmtTime, fmtToken, shortHex } from "@/lib/format";
import { INDEXER_URL, fetchEvents, useIndexerStatus, useReactiveEvents, type IndexedEvent, type IndexerStatus } from "@/lib/indexer";
import { useMarketLogSource } from "@/lib/logs";

import { Card, LevelDot, Skeleton } from "../../ui";
import { PageHeader } from "../AppShell";
import { Banner, Segmented } from "../bits";

const PAGE = 40;

const CHAINS = [
  { id: 1301, key: "unichain", name: "Unichain Sepolia", short: "Unichain", explorer: explorers.unichain },
  { id: 84532, key: "base", name: "Base Sepolia", short: "Base", explorer: explorers.base },
  { id: 5318007, key: "lasna", name: "Reactive Lasna", short: "Lasna", explorer: explorers.lasna },
] as const;
const chainOf = (id: number) => CHAINS.find((c) => c.id === id) ?? CHAINS[0];

/** Event types per contract, grouped for the filter. */
const EVENT_GROUPS: { label: string; contract: string; events: string[] }[] = [
  { label: "Cover", contract: "market", events: ["ProtectionBought", "PolicySettled", "Claimed"] },
  { label: "Perp", contract: "market", events: ["PositionOpened", "PositionClosed", "Liquidated"] },
  { label: "Pool", contract: "market", events: ["Deposited", "WithdrawRequested", "WithdrawCancelled", "Withdrawn"] },
  { label: "Marks & trips", contract: "market", events: ["MarkUpdated", "StaleMarkIgnored", "Tripped"] },
  { label: "Reactive", contract: "reactive", events: ["MarkSent", "TripSent", "TripConfirmed", "BreachStarted", "BreachCleared", "VaultFlow", "PriceMirrored", "ThinPoolIgnored", "DemoReset"] },
  { label: "Vault", contract: "vault", events: ["Deposited", "Withdrawn", "ExploitSimulated"] },
  { label: "Pools", contract: "basePool,unichainPool", events: ["Swap", "LiquidityAdded"] },
];

type Row = { chainId: number; block: bigint; logIndex: number; txHash: Hash; contract: string; event: string; args: Record<string, unknown>; ts?: number };

export function HistoryScreen() {
  const source = useMarketLogSource();
  const status = useIndexerStatus();
  const reactive = useReactiveEvents();
  const logs = source.data?.logs;
  const indexed = source.data?.source === "indexer";
  const totals = useMemo(() => (logs ? totalsOf(logs) : null), [logs]);
  const trips = useMemo(() => (logs ? tripsOf(logs, reactive.data ?? []) : null), [logs, reactive.data]);

  return (
    <>
      <PageHeader
        kicker="06 / History · three chains, indexed"
        title="History"
        intro="Everything that has happened on Rift since deployment: totals, every drain-to-payout end to end, and each event on Unichain, Base and Lasna."
      />
      <SourcePanel indexed={indexed} status={status.data} loading={source.isLoading} unreachable={!!INDEXER_URL && !!source.data && !indexed} />
      <div className="space-y-5">
        <Card index="A" ticks title="Totals" subtitle={indexed ? "Everything the indexer has read" : "From the events your browser has read"}>
          {totals ? <TotalsGrid t={totals} /> : <Skeleton className="h-40 w-full" />}
        </Card>
        <Card index="B" ticks title="Drain to payout, every time" subtitle={indexed ? "Origin on Base, reaction on Lasna, settlement on Unichain" : "Unichain side only without the indexer"}>
          {trips ? <TripList trips={trips} /> : <Skeleton className="h-32 w-full" />}
        </Card>
        <EventLog indexed={indexed} logs={logs} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- source

function SourcePanel({ indexed, status, loading, unreachable }: { indexed: boolean; status?: IndexerStatus; loading: boolean; unreachable: boolean }) {
  if (unreachable) {
    return (
      <Banner tone="bad">
        The indexer at <span className="mono break-all">{INDEXER_URL}</span> isn&apos;t answering, so this page is reading Unichain from your browser instead: market events
        from the last ~1.7 days only, no Base or Lasna.
      </Banner>
    );
  }
  if (!INDEXER_URL) {
    return (
      <Banner tone="info">
        No indexer configured, so this page reads Unichain from your browser: market events from the last ~1.7 days only, no Base or Lasna. Run the indexer
        (<span className="mono">indexer/</span>) and set <span className="mono">NEXT_PUBLIC_INDEXER_URL</span> for full history on all three chains.
      </Banner>
    );
  }
  return (
    <section aria-label="Indexer status" className="app-panel mb-6 grid gap-px sm:grid-cols-3" style={{ background: "var(--line)" }}>
      {CHAINS.map((c) => {
        const s = status?.chains.find((x) => x.id === c.id);
        const level = !s ? "amber" : s.lastError ? "red" : s.backfilling ? "amber" : "green";
        return (
          <div key={c.id} className="p-4" style={{ background: "var(--ink-2)" }}>
            <div className="flex items-center justify-between gap-2">
              <span className="kicker !text-[0.62rem]">{c.name}</span>
              <span className="flex items-center gap-2 text-xs">
                <LevelDot level={level} />
                {!s ? (loading || !indexed ? "…" : "not indexed") : s.lastError ? "retrying" : s.backfilling ? "catching up" : "live"}
              </span>
            </div>
            <div className="mono mt-2 text-lg">{s ? `${s.events.toLocaleString()} events` : "…"}</div>
            <div className="mt-1 text-xs text-muted">
              {s?.scannedTo ? `to block ${Number(s.scannedTo).toLocaleString()}` : "starting"}
              {s?.lag != null && ` · ${s.lag.toLocaleString()} behind head`}
            </div>
            {s?.lastError && <div className="mt-1 truncate text-xs" style={{ color: "var(--rift)" }} title={s.lastError}>{s.lastError}</div>}
          </div>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------- totals

function TotalsGrid({ t }: { t: Totals }) {
  const tiles: [string, string, string?][] = [
    ["Cover sold", `${fmtCompact(t.coverSold)} tUSD`, `${t.policies} ${t.policies === 1 ? "policy" : "policies"}`],
    ["Premiums", `${fmtToken(t.premiums)} tUSD`, "earned by the pool"],
    ["Payouts fixed", `${fmtCompact(t.payoutsFixed)} tUSD`, `${fmtCompact(t.claimed)} claimed in ${t.claims}`],
    ["Trips", String(t.trips), t.medianLatency !== null ? `marks land in ~${t.medianLatency}s (median)` : undefined],
    ["Perp volume", `${fmtCompact(t.perpVolume)} tUSD`, `${t.positions} opened · ${t.closes} closed`],
    ["Traders' net PnL", `${t.traderPnl >= 0n ? "+" : "−"}${fmtToken(t.traderPnl < 0n ? -t.traderPnl : t.traderPnl)} tUSD`, `${t.liquidations} liquidated`],
    ["Deposited", `${fmtCompact(t.deposited)} tUSD`, `${t.depositors} ${t.depositors === 1 ? "depositor" : "depositors"} · ${fmtCompact(t.withdrawn)} withdrawn`],
    ["Wallets", String(t.wallets), `${t.marks} ${t.marks === 1 ? "mark" : "marks"} delivered`],
  ];
  return (
    <dl className="grid grid-cols-2 gap-px lg:grid-cols-4" style={{ background: "var(--line)" }}>
      {tiles.map(([k, v, hint]) => (
        <div key={k} className="min-w-0 p-4" style={{ background: "var(--ink-2)" }}>
          <dt className="kicker !text-[0.6rem]">{k}</dt>
          <dd className="mono mt-2 break-words text-base sm:text-lg">{v}</dd>
          {hint && <dd className="mt-1 text-xs text-muted">{hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- trips

function TripList({ trips }: { trips: Trip[] }) {
  if (!trips.length) return <p className="text-sm text-muted">No trip yet. When a drain completes both conditions it appears here with all three transactions.</p>;
  return (
    <ol className="space-y-4">
      {trips.map((t) => {
        const origin = chainOf(t.originChainId);
        const hops: [string, string, string, string | null, string][] = [
          ["01", "Origin", origin.short, `${origin.explorer}/tx/${t.originTx}`, `observed ${fmtTime(t.observedAt)}`],
          ["02", "Reaction", "Lasna", t.reactiveTx ? `${explorers.lasna}/tx/${t.reactiveTx}` : null, t.reactiveTs ? `+${Math.max(0, t.reactiveTs - t.observedAt)}s` : "needs the indexer"],
          ["03", "Settlement", "Unichain", `${explorers.unichain}/tx/${t.settlementTx}`, `+${t.receivedAt - t.observedAt}s`],
        ];
        return (
          <li key={t.settlementTx} className="border p-4" style={{ borderColor: "var(--line-strong)" }}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="display text-3xl" style={{ color: "var(--rift)", textTransform: "none" }}>
                {t.receivedAt - t.observedAt}s
              </span>
              <span className="text-xs text-muted">
                mark {fmtBps(t.markBps)} · outflow {fmtBps(t.outflowBps, false)} · paid {Number(t.payoutRatioBps) / 100}% · {t.policiesPaid} paid · {fmtCompact(t.claimed)} tUSD claimed
              </span>
            </div>
            <ol className="mt-3 grid gap-2 sm:grid-cols-3">
              {hops.map(([n, title, chain, href, note]) => (
                <li key={n} className="p-3 text-sm" style={{ background: "var(--ink-3)" }}>
                  <div className="mono text-[0.65rem] uppercase tracking-[0.16em] text-muted">
                    {n} · {title} · {chain}
                  </div>
                  <div className="mt-1 flex justify-between gap-2">
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer" className="mono text-xs underline underline-offset-4">
                        {shortHex(href.split("/tx/")[1], 5)} ↗
                      </a>
                    ) : (
                      <span className="mono text-xs text-muted">—</span>
                    )}
                    <span className="mono text-xs">{note}</span>
                  </div>
                </li>
              ))}
            </ol>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- event log

function EventLog({ indexed, logs }: { indexed: boolean; logs?: { eventName: string; args: Record<string, unknown>; blockNumber: bigint; txHash: Hash; logIndex: number; ts?: number }[] }) {
  const [chain, setChain] = useState<number>(0);
  const [group, setGroup] = useState<string>("");
  const [account, setAccount] = useState("");
  const [page, setPage] = useState(0);
  const acct = isAddress(account.trim()) ? account.trim() : undefined;
  const g = EVENT_GROUPS.find((x) => x.label === group);

  const remote = useQuery({
    queryKey: ["indexer", "events", chain, group, acct, page],
    queryFn: () =>
      fetchEvents({
        chain: chain || undefined,
        contract: g?.contract.split(","),
        event: g?.events,
        account: acct,
        order: "desc",
        limit: PAGE,
        offset: page * PAGE,
      }),
    enabled: indexed,
    placeholderData: keepPreviousData,
    refetchInterval: page === 0 ? 5_000 : false,
  });

  // Without the indexer: the browser's market events, filtered here.
  const local = useMemo(() => {
    if (indexed || !logs) return null;
    const me = acct?.toLowerCase();
    const rows: Row[] = logs
      .filter((l) => (!g || (g.contract === "market" && g.events.includes(l.eventName))) && (!chain || chain === 1301))
      .filter((l) => !me || Object.values(l.args).some((v) => typeof v === "string" && v.toLowerCase() === me))
      .map((l) => ({ chainId: 1301, block: l.blockNumber, logIndex: l.logIndex, txHash: l.txHash, contract: "market", event: l.eventName, args: l.args, ts: l.ts }))
      .reverse();
    return { total: rows.length, rows: rows.slice(page * PAGE, (page + 1) * PAGE) };
  }, [indexed, logs, g, chain, acct, page]);

  const rows: Row[] | undefined = indexed ? remote.data?.events.map((e: IndexedEvent) => ({ ...e })) : local?.rows;
  const total = indexed ? (remote.data?.total ?? 0) : (local?.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(0);
  };

  return (
    <Card index="C" ticks title="Event log" subtitle={`${total.toLocaleString()} events${indexed ? "" : " · Unichain market only"}`}>
      <div className="mb-5 grid gap-3 lg:grid-cols-[minmax(0,26rem)_1fr_minmax(0,22rem)] lg:items-end">
        <Segmented
          value={chain}
          onChange={reset(setChain)}
          label="Chain"
          options={[{ value: 0, label: "All" }, ...CHAINS.map((c) => ({ value: c.id, label: c.short }))]}
        />
        <label className="block">
          <span className="kicker mb-1.5 block !text-[0.6rem]">Type</span>
          <select className="app-input w-full" value={group} onChange={(e) => reset(setGroup)(e.target.value)}>
            <option value="">All events</option>
            {EVENT_GROUPS.map((x) => (
              <option key={x.label} value={x.label}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="kicker mb-1.5 block !text-[0.6rem]">Address</span>
          <input
            className="app-input mono w-full"
            placeholder="0x… (any role)"
            value={account}
            onChange={(e) => reset(setAccount)(e.target.value)}
            spellCheck={false}
            aria-invalid={account.trim() !== "" && !acct}
          />
        </label>
      </div>

      {!rows ? (
        <p className="text-sm text-muted" role="status">
          {indexed ? "Loading events from the indexer…" : "Reading the market's history from Unichain. The first load can take a minute; after that it's cached."}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No events match.</p>
      ) : (
        <ol className="divide-y" style={{ borderColor: "var(--line)", opacity: remote.isPlaceholderData ? 0.6 : 1 }}>
          {rows.map((r) => {
            const c = chainOf(r.chainId);
            const d = describe(r);
            return (
              <li
                key={`${r.chainId}-${r.txHash}-${r.logIndex}`}
                className="grid gap-1 py-3 sm:grid-cols-[6.5rem_9rem_1fr_auto] sm:items-center sm:gap-5"
                style={{ borderColor: "var(--line)" }}
              >
                <span className="kicker !text-[0.6rem]" style={{ color: c.key === "lasna" ? "var(--cold)" : c.key === "base" ? "var(--warn)" : "var(--rift)" }}>
                  {c.short} · {r.contract.replace(/Pool$/, " pool")}
                </span>
                <span className="mono text-xs text-muted">{r.ts ? fmtTime(r.ts) : `block ${r.block.toString()}`}</span>
                <div className="min-w-0">
                  <div className="text-sm">{d.title}</div>
                  {d.detail && <div className="mt-0.5 break-words text-xs text-muted">{d.detail}</div>}
                </div>
                <a href={`${c.explorer}/tx/${r.txHash}`} target="_blank" rel="noreferrer" className="mono text-xs underline underline-offset-4">
                  {shortHex(r.txHash, 4)} ↗
                </a>
              </li>
            );
          })}
        </ol>
      )}

      {total > PAGE && (
        <div className="mt-5 flex items-center justify-between gap-3">
          <button type="button" className="btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ← Newer
          </button>
          <span className="mono text-xs text-muted">
            page {page + 1} / {pages}
          </span>
          <button type="button" className="btn-ghost btn-sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            Older →
          </button>
        </div>
      )}
    </Card>
  );
}

/** A neutral, one-line reading of any watched event. Amounts are 18-decimal tokens. */
function describe(r: Row): { title: string; detail: string } {
  const a = r.args;
  const t = (k: string, dp = 2) => (typeof a[k] === "bigint" ? fmtToken(a[k] as bigint, dp) : "?");
  const who = (k: string) => (typeof a[k] === "string" ? shortHex(a[k] as string, 4) : "?");
  const when = (k: string) => (typeof a[k] === "bigint" ? fmtTime(a[k] as bigint) : "?");
  const key = `${r.contract}.${r.event}`;
  switch (key) {
    case "market.ProtectionBought": return { title: `Cover #${a.id} bought`, detail: `${t("notional", 0)} tUSD for ${t("premium")} premium by ${who("buyer")}, active ${when("activeAt")}` };
    case "market.PolicySettled": return a.covered ? { title: `Cover #${a.id} paid out`, detail: `${t("owed")} tUSD fixed for ${who("buyer")}` } : { title: `Cover #${a.id} refunded`, detail: `${t("owed")} tUSD premium back to ${who("buyer")} (still in its waiting period)` };
    case "market.Claimed": return { title: `Cover #${a.id} claimed`, detail: `${t("amount")} tUSD to ${who("buyer")}` };
    case "market.PositionOpened": return { title: `${a.isLong ? "Long" : "Short"} opened`, detail: `${t("size", 0)} tUSD size, ${t("margin")} margin at ${fmtBps(a.entryMark as bigint)} by ${who("trader")}` };
    case "market.PositionClosed": {
      const net = (a.pnl as bigint) - (a.funding as bigint);
      return { title: a.liquidated ? "Position liquidated" : "Position closed", detail: `net ${net >= 0n ? "+" : "−"}${fmtToken(net < 0n ? -net : net)} tUSD, ${t("payout")} paid to ${who("trader")}` };
    }
    case "market.Liquidated": return { title: "Liquidation", detail: `${who("trader")} liquidated by ${who("liquidator")}, reward ${t("reward")} tUSD` };
    case "market.Deposited": return { title: "Pool deposit", detail: `${t("assets", 0)} tUSD for ${t("shares")} shares by ${who("user")}` };
    case "market.WithdrawRequested": return { title: "Withdrawal requested", detail: `${t("shares")} shares by ${who("user")}, unlocks ${when("unlockAt")}` };
    case "market.WithdrawCancelled": return { title: "Withdrawal cancelled", detail: `${t("shares")} shares by ${who("user")}` };
    case "market.Withdrawn": return { title: "Pool withdrawal", detail: `${t("assets")} tUSD for ${t("shares")} shares by ${who("user")}` };
    case "market.MarkUpdated": return { title: `Mark ${fmtBps(a.markBps as bigint)}`, detail: `observed ${when("observedAt")}, landed ${Number((a.receivedAt as bigint) - (a.observedAt as bigint))}s later` };
    case "market.StaleMarkIgnored": return { title: "Stale mark ignored", detail: `${fmtBps(a.markBps as bigint)} observed ${when("observedAt")}, older than the current one` };
    case "market.Tripped": return { title: "Market tripped", detail: `mark ${fmtBps(a.markBps as bigint)}, outflow ${fmtBps(a.outflowBps as bigint, false)}, payouts at ${Number(a.payoutRatioBps) / 100}%` };
    case "reactive.MarkSent": return { title: `Mark sent ${fmtBps(a.spreadBps as bigint)}`, detail: Number(a.originChainId) === 5318007 ? `cron heartbeat at ${when("observedAt")}` : `after a swap on ${chainOf(Number(a.originChainId)).short} at ${when("observedAt")}` };
    case "reactive.TripSent": return { title: "Trip sent", detail: `spread ${fmtBps(a.spreadBps as bigint)}, outflow ${fmtBps(a.outflowBps as bigint, false)}` };
    case "reactive.TripConfirmed": return { title: "Trip confirmed by the market", detail: "" };
    case "reactive.BreachStarted": return { title: "Spread breach started", detail: `${fmtBps(a.spreadBps as bigint)} at ${when("timestamp")}` };
    case "reactive.BreachCleared": return { title: "Spread breach cleared", detail: `at ${when("timestamp")}` };
    case "reactive.VaultFlow": return { title: `Vault ${a.outflow ? "outflow" : "inflow"} seen`, detail: `${t("amount", 0)} moved, vault holds ${t("vaultBalance", 0)}, 5-min outflow ${t("windowOutflow", 0)}` };
    case "reactive.PriceMirrored": return { title: `Price mirrored from ${chainOf(Number(a.chainId)).short}`, detail: fmtPrice(a.price as bigint) };
    case "reactive.ThinPoolIgnored": return { title: "Thin pool ignored", detail: `chain ${a.chainId}, reserve ${t("reserve1", 0)}` };
    case "reactive.DemoReset": return { title: "Watcher reset", detail: `vault baseline ${t("vaultBalance", 0)}` };
    case "vault.Deposited": return { title: "Vault deposit", detail: `${t("amount", 0)} by ${who("user")}` };
    case "vault.Withdrawn": return { title: "Vault withdrawal", detail: `${t("amount", 0)} by ${who("user")}` };
    case "vault.ExploitSimulated": return { title: "Vault drained", detail: `${t("amount", 0)} to ${who("to")}` };
    case "basePool.Swap":
    case "unichainPool.Swap": return { title: "Swap", detail: `${t("amountIn")} in → ${t("amountOut")} out (${a.zeroForOne ? "base → quote" : "quote → base"})` };
    case "basePool.Sync":
    case "unichainPool.Sync": return { title: "Reserves synced", detail: `${t("reserve0", 0)} / ${t("reserve1", 0)}` };
    case "basePool.LiquidityAdded":
    case "unichainPool.LiquidityAdded": return { title: "Liquidity added", detail: `${t("amount0", 0)} + ${t("amount1", 0)} by ${who("provider")}` };
    default: return { title: r.event, detail: r.contract === "market" || r.contract === "reactive" ? "configuration change" : "" };
  }
}
