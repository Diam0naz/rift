"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { isAddress, maxUint256, type Address } from "viem";
import { useAccount } from "wagmi";

import { mockTokenAbi } from "@/lib/abi/MockToken";
import { addresses, clients, explorers } from "@/lib/config";
import { fmtBps, fmtCompact, fmtToken, shortHex } from "@/lib/format";
import { fundingPerDay, liquidationMarkBps, marginHealth } from "@/lib/market";
import { useQuery } from "@tanstack/react-query";
import {
  CHAIN_BY_ID,
  CHAIN_ID,
  factory,
  KIND_LABEL,
  NO_COVER,
  MARKETS_LIVE,
  sideOf,
  specFrom,
  spreadMarket,
  token,
  useFactoryOwner,
  useMarketAccount,
  useMarkets,
  type Cover,
  type MarketAccount,
  type MarketRow,
  type PoolRef,
} from "@/lib/markets";
import { fmtDuration } from "@/lib/risk";
import { PRESETS, SCAN_CHAINS, quoteOf, scanClient, spreadBps, type PoolSide, type ScanChain } from "@/lib/scanner";
import { useTx, useTxFlow } from "@/lib/tx";
import { MARKET_CHAIN_ID } from "@/lib/wagmi";

import { Bar, Card, Skeleton, Stat } from "../../ui";
import { PageHeader } from "../AppShell";
import { Banner, Field, Rows, Segmented } from "../bits";
import { TxFlowView, TxStatus } from "../TxFlow";
import { AccountBar, ConnectCta } from "../Wallet";
import { parseAmount } from "./Protect";
import { PoolCard, usePool } from "./Scanner";

const MAX_MARK_AGE = 3600; // RiftSpreadMarket.MAX_MARK_AGE
const chainName = (id: bigint) => SCAN_CHAINS.find((c) => c.key === sideOf({ chainId: id } as PoolRef).chain)?.short ?? `chain ${id}`;
const explorerOf = (p: PoolRef) => SCAN_CHAINS.find((c) => c.key === sideOf(p).chain)!.explorer;

function parseSide(v: string | null): PoolSide | null {
  if (!v) return null;
  const [chain, address] = v.split(":");
  return SCAN_CHAINS.some((c) => c.key === chain) && address ? { chain: chain as ScanChain, address } : null;
}

/** Why a created market isn't taking new positions, or null. */
function blockerOf(m: MarketRow): string | null {
  if (m.tripped) return `Tripped at a ${fmtBps(m.tripMark)} spread: the market is frozen. Positions close at the trip mark; cover buyers claim below.`;
  if (m.markReceivedAt === 0n) {
    const h = m.hub;
    if (h && !h.active) return h.throttled ? "Paused: one of its pools emitted too many events for the hub's budget." : "The hub isn't watching this market (paused or refused).";
    const waiting = h ? [!h.hasA && "pool A", !h.hasB && "pool B"].filter(Boolean).join(" and ") : "";
    return `No mark yet. The hub prices a pool from its next trade after the market was listed${waiting ? `; still waiting on ${waiting}` : ""}.`;
  }
  const age = Number(m.now - m.markReceivedAt);
  if (age > MAX_MARK_AGE) return `The last mark is ${fmtDuration(age)} old (limit 1h), so new positions wait for the next one.`;
  return null;
}

export function MarketsScreen() {
  const params = useSearchParams();
  const id = params.get("id");
  const markets = useMarkets();
  const selected = id !== null ? markets.data?.find((m) => m.id === Number(id)) : undefined;

  return (
    <>
      <PageHeader
        kicker="09 / Markets · open your own"
        title="Markets"
        outline="any pair"
        intro="List a spread perp on any two pools of the same pair, on Base, Unichain or Ethereum Sepolia, and optionally propose drain cover on a vault. One Reactive contract picks the listing up from its event, watches the pools (and, once cover is approved, the vault), marks the market and trips it."
      />
      <AccountBar />
      {!MARKETS_LIVE && <Banner tone="info">The market factory isn&apos;t deployed yet. You can line up a market below; listing opens once it is.</Banner>}

      {id !== null ? (
        selected ? (
          <MarketDetail m={selected} />
        ) : markets.isLoading ? (
          <Skeleton className="h-[480px] w-full" />
        ) : (
          <Banner tone="warn">No market #{id}. <Link href="/app/markets" className="underline">See all markets</Link></Banner>
        )
      ) : (
        <div className="grid gap-5 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <MarketList rows={markets.data} loading={markets.isLoading} />
          </div>
          <div className="lg:col-span-5">
            <HowItWorks />
          </div>
          <div className="lg:col-span-12">
            <CreateMarket />
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- list

function MarketList({ rows, loading }: { rows?: MarketRow[]; loading: boolean }) {
  return (
    <Card index="A" ticks title="Listed markets" subtitle="Every market anyone has opened, newest first.">
      {!MARKETS_LIVE ? (
        <p className="text-sm text-muted">None yet: the factory isn&apos;t deployed.</p>
      ) : loading || !rows ? (
        <p className="text-sm text-muted" role="status">Reading the factory…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No markets yet. Be the first: pick two pools below.</p>
      ) : (
        <ol className="divide-y" style={{ borderColor: "var(--line)" }}>
          {[...rows].reverse().map((m) => {
            const blocked = blockerOf(m);
            return (
              <li key={m.id} style={{ borderColor: "var(--line)" }}>
                <Link href={`/app/markets?id=${m.id}`} className="grid grid-cols-[3rem_1fr_auto] items-center gap-3 py-3 hover:bg-[var(--ink-3)]">
                  <span className="mono text-xs text-muted">#{m.id}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm">
                      {chainName(m.spec.a.chainId)} {shortHex(m.spec.a.pool, 3)} <span className="text-muted">vs</span> {chainName(m.spec.b.chainId)} {shortHex(m.spec.b.pool, 3)}
                    </span>
                    <span className="mono block text-[0.65rem] text-muted">
                      pool {fmtCompact(m.poolAssets)} tUSD · OI {fmtCompact(m.openLongSize + m.openShortSize)} · {m.tripped ? "tripped" : blocked ? "not live" : "live"}
                      {m.cover ? ` · cover ${m.cover.armed ? (m.tripped ? "paid out" : "on sale") : m.cover.status}` : ""}
                    </span>
                  </span>
                  <span className="mono text-right text-lg" style={{ color: blocked ? "var(--bone-dim)" : undefined }}>
                    {m.markReceivedAt === 0n ? "—" : fmtBps(m.markBps)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function HowItWorks() {
  return (
    <Card index="B" title="How a listing goes live" subtitle="No deploy on Reactive per market.">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
        <li>
          <b className="text-[var(--bone)]">You list it</b> on Unichain: RiftMarketFactory deploys the market and emits <span className="mono">MarketCreated</span>. You
          pay its callback gas (0.0005 ETH) up front.
        </li>
        <li>
          <b className="text-[var(--bone)]">RiftHub reacts</b> on Lasna: it is subscribed to that event, and inside <span className="mono">react()</span> it
          subscribes to both of your pools.
        </li>
        <li>
          <b className="text-[var(--bone)]">Every trade on either pool</b> reprices the market; the hub sends the time-weighted spread to it as the mark, plus
          a heartbeat every ~17 minutes.
        </li>
        <li>
          <b className="text-[var(--bone)]">Underwriters fund it</b>, and traders go long or short the gap, up to 10×. The mark is capped at ±100%.
        </li>
        <li>
          <b className="text-[var(--bone)]">Cover, if you proposed it</b>: once Rift approves it, the hub subscribes to the vault&apos;s transfers and arms the
          market. It trips when the spread stays broken <i>and</i> the vault drains, and covered buyers are paid in that callback.
        </li>
      </ol>
      <p className="mt-3 text-xs text-muted">
        Pools that fire more than 240 events an hour get paused, so one busy pool can&apos;t burn the hub&apos;s REACT for everyone. Covered markets are never
        paused: that would switch their cover off. Cover needs approval because whoever controls a vault and two thin pools could trip their own cover.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------- create

function CreateMarket() {
  const params = useSearchParams();
  const router = useRouter();
  const [a, setA] = useState<PoolSide>(PRESETS[1].a);
  const [b, setB] = useState<PoolSide>(PRESETS[1].b);
  const [flipA, setFlipA] = useState(false);
  const { isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const tx = useTx();

  // Prefilled from the Scanner: /app/markets?a=chain:pool&b=chain:pool
  useEffect(() => {
    const pa = parseSide(params.get("a"));
    const pb = parseSide(params.get("b"));
    if (pa) setA(pa);
    if (pb) setB(pb);
  }, [params]);

  const [withCover, setWithCover] = useState(false);
  const [cf, setCf] = useState<CoverForm>(DEFAULT_COVER);
  const cover = withCover ? coverFrom(cf) : NO_COVER;
  const coverBad = withCover && !cover;

  const pa = usePool(a);
  const pb = usePool(b);
  const spec = pa.data && pb.data ? specFrom(a, pa.data, b, pb.data, flipA) : null;
  const qa = spec && pa.data ? quoteOf(pa.data, spec.a.invert) : null;
  const qb = spec && pb.data ? quoteOf(pb.data, spec.b.invert) : null;
  const bps = qa && qb ? spreadBps(qa.price, qb.price) : null;

  const create = async () => {
    if (!spec || !cover) return;
    const fee = await clients.unichain.readContract({ ...factory, functionName: "minCallbackFunding" });
    const ok = await tx.run("List market", { ...factory, functionName: "createMarket", args: [spec, cover], value: fee });
    if (ok) {
      const n = await clients.unichain.readContract({ ...factory, functionName: "marketsCount" });
      router.push(`/app/markets?id=${Number(n) - 1}`);
    }
  };

  return (
    <Card index="C" ticks title="List a market" subtitle="Two pools of the same pair. The mark is B's price over A's.">
      <div className="grid gap-5 md:grid-cols-2">
        <PoolCard index="A" side={a} onChange={setA} q={pa} quote={qa ?? undefined} flip={flipA} onFlip={() => setFlipA((f) => !f)} />
        <PoolCard index="B" side={b} onChange={setB} q={pb} quote={qb ?? undefined} />
      </div>
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <div>
          {pa.data && pb.data && !spec ? (
            <Banner tone="warn">These pools don&apos;t trade the same pair. Pick two pools of the same tokens.</Banner>
          ) : spec ? (
            <Rows
              rows={[
                ["Spread now (from the pools)", bps === null ? "—" : `${fmtBps(Math.round(bps))}${Math.abs(bps) > 10_000 ? " · the mark caps at ±100%" : ""}`],
                ["Pool A is read from", `${KIND_LABEL(spec.a.kind)} · ×10^${spec.a.decShift}${spec.a.invert ? " · inverted" : ""}`],
                ["Pool B is read from", `${KIND_LABEL(spec.b.kind)} · ×10^${spec.b.decShift}${spec.b.invert ? " · inverted" : ""}`],
                ["Collateral", "tUSD"],
                ["Cover", withCover ? (cover ? `proposed on ${shortHex(cover.vault, 3)}, needs Rift's approval` : "check the cover fields") : "none (trading only)"],
                ["You pay", "0.0005 ETH of callback gas, held by the market"],
              ]}
            />
          ) : (
            <p className="text-sm text-muted">Reading both pools…</p>
          )}
        </div>
        <div className="space-y-3">
          <p className="text-sm text-muted">
            The hub only learns a price from a pool&apos;s next trade after listing (logs before a subscription are never replayed), so a quiet testnet pool
            stays unpriced until someone swaps on it. Real testnet pools also carry stale prices: their gap reflects whoever traded last.
          </p>
          {!mounted ? null : !isConnected ? (
            <ConnectCta>Connect wallet to list</ConnectCta>
          ) : (
            <button type="button" className="btn-brutal btn-sm" disabled={!MARKETS_LIVE || !spec || coverBad || tx.busy} onClick={create}>
              List this market
            </button>
          )}
          <TxStatus state={tx.state} />
        </div>
      </div>
      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--line-strong)" }}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={withCover} onChange={(e) => setWithCover(e.target.checked)} />
          Propose drain cover on a vault
        </label>
        {withCover && <CoverFields f={cf} onChange={setCf} />}
      </div>
    </Card>
  );
}

type CoverForm = { chain: ScanChain; vault: string; asset: string; spread: string; outflow: string; sustain: string; window: string };
/** Prefilled with the demo MockVault on Base, at RiftReactive's trip rule. */
const DEFAULT_COVER: CoverForm = {
  chain: "base",
  vault: addresses.base.vault,
  asset: addresses.base.vaultAsset,
  spread: "500",
  outflow: "1500",
  sustain: "2",
  window: "300",
};

/** Mirrors RiftMarketFactory._checkCover; null when a field is out of range. */
function coverFrom(f: CoverForm): Cover | null {
  const n = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : NaN);
  const [spread, outflow, sustain, win] = [n(f.spread), n(f.outflow), n(f.sustain), n(f.window)];
  if (!isAddress(f.vault) || !isAddress(f.asset)) return null;
  if (!(spread >= 100 && spread <= 10_000) || !(outflow >= 100 && outflow <= 10_000)) return null;
  if (!(sustain >= 0 && sustain <= 1800) || !(win >= 60 && win <= 86_400)) return null;
  return {
    chainId: BigInt(CHAIN_ID[f.chain]),
    vault: f.vault as Address,
    asset: f.asset as Address,
    tripSpreadBps: spread,
    tripOutflowBps: outflow,
    sustainSeconds: sustain,
    windowSeconds: win,
  };
}

function CoverFields({ f, onChange }: { f: CoverForm; onChange: (f: CoverForm) => void }) {
  const set = (k: keyof CoverForm) => (e: { target: { value: string } }) => onChange({ ...f, [k]: e.target.value });
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <Field label="Vault's chain" group>
        <Segmented value={f.chain} onChange={(v) => onChange({ ...f, chain: v })} label="Vault's chain" options={SCAN_CHAINS.map((c) => ({ value: c.key, label: c.short }))} />
      </Field>
      <Field label="Vault address" hint="The contract whose funds the cover protects.">
        <input value={f.vault} onChange={set("vault")} className="app-input mono" aria-invalid={!isAddress(f.vault)} />
      </Field>
      <Field label="Asset it holds (ERC-20)" hint="The hub watches this token's transfers in and out of the vault.">
        <input value={f.asset} onChange={set("asset")} className="app-input mono" aria-invalid={!isAddress(f.asset)} />
      </Field>
      <Field label="Trip spread (bps)" hint="100 to 10,000. The spread must stay at least this wide…">
        <input inputMode="numeric" value={f.spread} onChange={set("spread")} className="app-input mono" />
      </Field>
      <Field label="…for (seconds)" hint="Up to 1,800, so the trip lands before underwriters can withdraw.">
        <input inputMode="numeric" value={f.sustain} onChange={set("sustain")} className="app-input mono" />
      </Field>
      <Field label="And outflow of (bps of the vault)" hint="100 to 10,000.">
        <input inputMode="numeric" value={f.outflow} onChange={set("outflow")} className="app-input mono" />
      </Field>
      <Field label="Within (seconds)" hint="The outflow window, 60 to 86,400.">
        <input inputMode="numeric" value={f.window} onChange={set("window")} className="app-input mono" />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------- detail

function MarketDetail({ m }: { m: MarketRow }) {
  const { address, isConnected, chainId } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const acct = useMarketAccount(m.address, mounted && isConnected && chainId === MARKET_CHAIN_ID ? address : undefined);
  const pa = usePool(sideOf(m.spec.a));
  const pb = usePool(sideOf(m.spec.b));
  const qa = pa.data ? quoteOf(pa.data, m.spec.a.invert) : null;
  const qb = pb.data ? quoteOf(pb.data, m.spec.b.invert) : null;
  const live = qa && qb ? spreadBps(qa.price, qb.price) : null;
  const blocker = blockerOf(m);
  const pair = qa ? `${qa.base}/${qa.quote}` : "…";

  return (
    <>
      <p className="mb-4 text-sm">
        <Link href="/app/markets" className="underline underline-offset-4">
          ← All markets
        </Link>
      </p>
      {blocker && <Banner tone="warn">{blocker}</Banner>}
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-8">
          <Card index="A" ticks title={`Market #${m.id} · ${pair}`} subtitle={`${chainName(m.spec.b.chainId)} over ${chainName(m.spec.a.chainId)} · listed by ${shortHex(m.creator, 4)}`}>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Perp mark" value={m.markReceivedAt === 0n ? "—" : fmtBps(m.markBps)} hint={m.markReceivedAt === 0n ? "none yet" : `landed ${fmtDuration(Number(m.now - m.markReceivedAt))} ago`} />
              <Stat label="Spread now" value={live === null ? "…" : fmtBps(Math.round(Math.max(-10_000, Math.min(10_000, live))))} hint="from the pools, read here" />
              <Stat label="Pool cash" value={`${fmtCompact(m.poolAssets)}`} hint="tUSD, max size per trade" />
              <Stat label="Open interest" value={fmtCompact(m.openLongSize + m.openShortSize)} hint={`${fmtCompact(m.openLongSize)} long · ${fmtCompact(m.openShortSize)} short`} />
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <PoolLine label="A" p={m.spec.a} price={qa ? `${qa.price.toPrecision(6)} ${qa.quote} per ${qa.base}` : "…"} seen={m.hub?.hasA} />
              <PoolLine label="B" p={m.spec.b} price={qb ? `${qb.price.toPrecision(6)} ${qb.quote} per ${qb.base}` : "…"} seen={m.hub?.hasB} />
            </div>
            <p className="mt-4 text-xs text-muted">
              Long gains when B prices further above A. Funding: when the mark is positive longs pay mark% of size per day, when negative shorts do. The
              market contract:{" "}
              <a className="underline underline-offset-4" href={`${explorers.unichain}/address/${m.address}`} target="_blank" rel="noreferrer">
                {shortHex(m.address, 4)} ↗
              </a>
              {m.hub ? ` · ${m.hub.marksSent} marks sent by the hub` : ""}
            </p>
          </Card>
          {m.cover && <CoverPanel m={m} a={acct.data} />}
          <Underwrite m={m} a={acct.data} />
        </div>
        <div className="space-y-5 lg:col-span-4">
          {acct.data?.position ? <Position m={m} a={acct.data} /> : m.tripped ? null : <Ticket m={m} a={mounted && isConnected ? acct.data : undefined} blocker={blocker} />}
          {m.cover?.armed && !m.tripped && <BuyCover m={m} a={mounted && isConnected ? acct.data : undefined} blocker={blocker} />}
        </div>
      </div>
    </>
  );
}

function PoolLine({ label, p, price, seen }: { label: string; p: PoolRef; price: string; seen?: boolean }) {
  return (
    <div className="border p-3" style={{ borderColor: "var(--line-strong)" }}>
      <div className="kicker !text-[0.6rem]">
        Pool {label} · {chainName(p.chainId)} · {KIND_LABEL(p.kind)}
      </div>
      <div className="mono mt-1 text-sm">{price}</div>
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span>{seen === undefined ? "" : seen ? "hub has a price" : "hub waiting for a trade"}</span>
        <a className="underline underline-offset-4" href={`${explorerOf(p)}/address/${p.pool}`} target="_blank" rel="noreferrer">
          {shortHex(p.pool, 3)} ↗
        </a>
      </div>
    </div>
  );
}

function Ticket({ m, a, blocker }: { m: MarketRow; a?: MarketAccount; blocker: string | null }) {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [side, setSide] = useState<"long" | "short">("long");
  const [size, setSize] = useState("1000");
  const [lev, setLev] = useState("5");
  const flow = useTxFlow();
  const amount = parseAmount(size);
  const levB = BigInt(lev);
  const margin = amount ? (amount + levB - 1n) / levB : null;
  const isLong = side === "long";
  const liq = amount && margin ? liquidationMarkBps({ isLong, size: amount, margin, entryMark: m.markBps }) : NaN;
  const fund = amount ? fundingPerDay(isLong, amount, m.markBps) : 0n;
  const problem =
    amount && amount > m.poolAssets
      ? `Above the pool's cash (${fmtToken(m.poolAssets, 0)} tUSD). Underwrite it first, or size down.`
      : a && margin && margin > a.usd
        ? `Needs ${fmtToken(margin)} tUSD margin; your wallet has ${fmtToken(a.usd)}.`
        : null;
  const mk = spreadMarket(m.address);

  const open = () => {
    if (!amount || !margin || !address) return;
    flow.start([
      {
        label: "Approve tUSD",
        explain: "Lets this market take your margin. Skipped if it already can.",
        call: { ...token, functionName: "approve", args: [m.address as Address, maxUint256] },
        skip: async () => (await clients.unichain.readContract({ ...token, functionName: "allowance", args: [address, m.address] })) >= margin,
      },
      {
        label: `Open ${side}`,
        explain: `${fmtToken(margin)} tUSD margin for a ${fmtToken(amount, 0)} tUSD ${side} at ${fmtBps(m.markBps)}.`,
        call: { ...mk, functionName: "openPosition", args: [isLong, amount, margin] },
      },
    ]);
  };

  return (
    <Card index="B" ticks title="New position" subtitle="One position per wallet on each market.">
      <div className="space-y-4">
        <Field label="Direction" group>
          <Segmented
            value={side}
            onChange={setSide}
            label="Direction"
            options={[
              { value: "long", label: "Long spread", tone: "ok" },
              { value: "short", label: "Short spread", tone: "bad" },
            ]}
          />
        </Field>
        <Field label="Size (tUSD)">
          <input inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} className="app-input mono" aria-invalid={!amount || !!problem} />
        </Field>
        <Field label="Leverage" group>
          <Segmented value={lev} onChange={setLev} label="Leverage" options={["1", "2", "5", "10"].map((v) => ({ value: v, label: `${v}×` }))} />
        </Field>
      </div>
      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--line-strong)" }}>
        <Rows
          rows={[
            ["Margin", margin ? `${fmtToken(margin)} tUSD` : "—"],
            ["Entry mark", m.markReceivedAt === 0n ? "—" : fmtBps(m.markBps)],
            ["Liquidation mark (est.)", Number.isFinite(liq) ? fmtBps(Math.round(liq)) : "—"],
            ["Funding per day (now)", amount ? `${fund > 0n ? "you pay" : fund < 0n ? "you receive" : "none"} ${fund !== 0n ? fmtToken(fund < 0n ? -fund : fund) : ""}` : "—"],
          ]}
        />
      </div>
      <div className="mt-5 space-y-3">
        {!mounted ? null : !isConnected ? (
          <ConnectCta>Connect wallet to trade</ConnectCta>
        ) : (
          <button type="button" className="btn-brutal btn-sm" onClick={open} disabled={!a || !!blocker || !!problem || !amount || flow.running}>
            Open {side}
          </button>
        )}
        {problem && <p className="text-xs" style={{ color: "var(--warn)" }}>{problem}</p>}
        <TxFlowView steps={flow.steps} states={flow.states} onRetry={flow.retry} running={flow.running} />
      </div>
    </Card>
  );
}

function Position({ m, a }: { m: MarketRow; a: MarketAccount }) {
  const p = a.position!;
  const tx = useTx();
  const health = marginHealth(p.equity, p.size);
  const liq = liquidationMarkBps({ ...p, fundingOwed: p.funding });
  const sign = (x: bigint) => `${x > 0n ? "+" : x < 0n ? "−" : ""}${fmtToken(x < 0n ? -x : x)}`;
  return (
    <Card index="B" ticks title={`Your ${p.isLong ? "long" : "short"}`} subtitle={`Opened at ${fmtBps(p.entryMark)} · size ${fmtToken(p.size, 0)} tUSD`}>
      <div className="kicker !text-[0.62rem]">Unrealised PnL</div>
      <div className="display mt-2 text-[clamp(2.25rem,4vw,3.25rem)]" style={{ textTransform: "none", color: p.pnl >= 0n ? "var(--ok)" : "var(--rift)" }}>
        {sign(p.pnl)}
      </div>
      <div className="mt-4">
        <Bar value={Math.min(health, 4)} max={4} marker={1} tone={health < 1.25 ? "red" : health < 2 ? "amber" : "green"} label="Margin health" />
      </div>
      <div className="mt-4">
        <Rows
          rows={[
            ["Mark now", fmtBps(m.markBps)],
            ["Funding so far", `${p.funding > 0n ? "paid" : "received"} ${fmtToken(p.funding < 0n ? -p.funding : p.funding)}`],
            ["Equity", fmtToken(p.equity)],
            ["Liquidation mark", Number.isFinite(liq) ? fmtBps(Math.round(liq)) : "—"],
          ]}
        />
      </div>
      <div className="mt-5 space-y-3">
        <button type="button" className="btn-brutal btn-sm" disabled={tx.busy} onClick={() => tx.run("Close position", { ...spreadMarket(m.address), functionName: "closePosition" })}>
          Close position
        </button>
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}

function Underwrite({ m, a }: { m: MarketRow; a?: MarketAccount }) {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [amt, setAmt] = useState("10000");
  const flow = useTxFlow();
  const tx = useTx();
  const amount = parseAmount(amt);
  const mk = spreadMarket(m.address);
  const value = a && m.totalShares > 0n ? (a.shares * m.poolAssets) / m.totalShares : 0n;
  const w = a?.withdrawal;
  const unlocked = w ? m.now >= w.unlockAt : false;

  const deposit = () => {
    if (!amount || !address) return;
    flow.start([
      {
        label: "Approve tUSD",
        explain: "Lets this market take your deposit. Skipped if it already can.",
        call: { ...token, functionName: "approve", args: [m.address as Address, maxUint256] },
        skip: async () => (await clients.unichain.readContract({ ...token, functionName: "allowance", args: [address, m.address] })) >= amount,
      },
      { label: "Deposit", explain: `Adds ${fmtToken(amount, 0)} tUSD to this market's underwriting pool for shares.`, call: { ...mk, functionName: "deposit", args: [amount] } },
    ]);
  };

  return (
    <Card index="C" title="Underwrite this market" subtitle="The pool is every trader's counterparty: it earns their losses and funding, and pays their gains.">
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-3">
          <Field label="Deposit (tUSD)">
            <input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} className="app-input mono" aria-invalid={!amount} />
          </Field>
          {!mounted ? null : !isConnected ? (
            <ConnectCta>Connect wallet to underwrite</ConnectCta>
          ) : (
            <button type="button" className="btn-brutal btn-sm" disabled={m.tripped || !amount || flow.running || (!!a && !!amount && amount > a.usd)} onClick={deposit}>
              Deposit
            </button>
          )}
          <TxFlowView steps={flow.steps} states={flow.states} onRetry={flow.retry} running={flow.running} />
        </div>
        <div>
          <Rows
            rows={[
              ["Your shares", a ? fmtToken(a.shares) : "—"],
              ["Worth about", a ? `${fmtToken(value)} tUSD` : "—"],
              ["Withdrawals", "Request, then complete after 1 hour"],
            ]}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {w ? (
              unlocked ? (
                <button type="button" className="btn-ghost btn-sm" disabled={tx.busy} onClick={() => tx.run("Withdraw", { ...mk, functionName: "completeWithdraw" })}>
                  Complete withdrawal
                </button>
              ) : (
                <>
                  <span className="text-xs text-muted">Unlocks in {fmtDuration(Number(w.unlockAt - m.now))}</span>
                  <button type="button" className="btn-ghost btn-sm" disabled={tx.busy} onClick={() => tx.run("Cancel withdrawal", { ...mk, functionName: "cancelWithdraw" })}>
                    Cancel
                  </button>
                </>
              )
            ) : (
              <button type="button" className="btn-ghost btn-sm" disabled={!a || a.shares === 0n || tx.busy} onClick={() => tx.run("Request withdrawal", { ...mk, functionName: "requestWithdraw", args: [a!.shares] })}>
                Withdraw all
              </button>
            )}
          </div>
          <div className="mt-2">
            <TxStatus state={tx.state} />
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- cover

function CoverPanel({ m, a }: { m: MarketRow; a?: MarketAccount }) {
  const c = m.cover!;
  const cfg = c.cfg;
  const { address } = useAccount();
  const owner = useFactoryOwner();
  const isOwner = !!address && !!owner.data && owner.data.toLowerCase() === address.toLowerCase();
  const tx = useTx();
  const h = c.hub;
  const vaultChain = CHAIN_BY_ID[Number(cfg.chainId)] ?? "base";
  const vaultExplorer = SCAN_CHAINS.find((x) => x.key === vaultChain)!.explorer;

  const approve = async () => {
    // The hub counts outflows against the vault's balance at approval, read on the vault's own chain.
    const bal = await scanClient(vaultChain).readContract({ address: cfg.asset, abi: mockTokenAbi, functionName: "balanceOf", args: [cfg.vault] });
    await tx.run("Approve cover", { ...factory, functionName: "approveCover", args: [BigInt(m.id), bal] });
  };

  const stage = m.tripped
    ? `Tripped · covered policies paid at ${Number(m.payoutRatioBps) / 100}%`
    : c.armed
      ? "On sale: the hub is watching the vault"
      : c.status === "approved"
        ? h?.armed
          ? "Approved · the hub is watching; the arm callback is on its way"
          : "Approved · waiting for the hub to subscribe to the vault"
        : c.status === "proposed"
          ? "Proposed · waiting for Rift's approval"
          : "Rejected · this market trades without cover";
  const breachFor = h && h.breachSince > 0 ? Number(m.now) - h.breachSince : 0;

  return (
    <Card index="E" title="Drain cover" subtitle={stage}>
      <div className="grid gap-5 md:grid-cols-2">
        <Rows
          rows={[
            [
              "Vault",
              <a key="v" className="underline underline-offset-4" href={`${vaultExplorer}/address/${cfg.vault}`} target="_blank" rel="noreferrer">
                {chainName(cfg.chainId)} {shortHex(cfg.vault, 3)} ↗
              </a>,
            ],
            ["Asset watched", shortHex(cfg.asset, 3)],
            ["Trips when", `|spread| ≥ ${fmtBps(cfg.tripSpreadBps, false)} for ${cfg.sustainSeconds}s`],
            ["and", `outflow ≥ ${fmtBps(cfg.tripOutflowBps, false)} of the vault within ${fmtDuration(cfg.windowSeconds)}`],
            ["Live cover", `${fmtCompact(c.activeNotional)} tUSD · ${c.policies} ${c.policies === 1 ? "policy" : "policies"} sold`],
          ]}
        />
        <div>
          {h && c.armed && !m.tripped ? (
            <div className="space-y-3">
              <div className="flex justify-between text-xs">
                <span className="kicker !text-[0.6rem]">Vault outflow in the window</span>
                <span className="mono">
                  {fmtBps(h.outflowBps, false)} / {fmtBps(cfg.tripOutflowBps, false)}
                </span>
              </div>
              <Bar value={Math.min(h.outflowBps, cfg.tripOutflowBps)} max={cfg.tripOutflowBps} tone={h.outflowBps >= cfg.tripOutflowBps ? "red" : h.outflowBps > 0 ? "amber" : "green"} label={`Vault outflow ${fmtBps(h.outflowBps, false)} of ${fmtBps(cfg.tripOutflowBps, false)}`} />
              <p className="text-xs text-muted">
                {h.breachSince > 0 ? `Spread beyond the threshold for ${fmtDuration(breachFor)}.` : "Spread within the threshold."} The hub mirrors a vault balance of{" "}
                {fmtCompact(h.vaultBalance)}. Both conditions must hold at once; a pushed pool or an honest big withdrawal alone doesn&apos;t trip it.
              </p>
            </div>
          ) : m.tripped ? (
            <p className="text-sm text-muted">
              The hub tripped this market at a {fmtBps(m.tripMark)} spread{h ? ` (${h.tripsSent} trip callback${h.tripsSent === 1 ? "" : "s"} sent${h.confirmed ? ", confirmed" : ""})` : ""}.
              Each covered policy&apos;s payout was fixed in that transaction; policies still in their 10-minute wait got their premium back.
            </p>
          ) : (
            <p className="text-sm text-muted">
              Cover goes on sale once Rift approves the vault and the hub confirms, with a callback, that it is subscribed to the vault&apos;s transfers.
            </p>
          )}
          {isOwner && (c.status === "proposed" || (c.status === "approved" && !c.armed)) && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn-brutal btn-sm" disabled={tx.busy} onClick={approve}>
                {c.status === "approved" ? "Re-send approval" : "Approve cover"}
              </button>
              {c.status === "proposed" && (
                <button type="button" className="btn-ghost btn-sm" disabled={tx.busy} onClick={() => tx.run("Reject cover", { ...factory, functionName: "rejectCover", args: [BigInt(m.id)] })}>
                  Reject
                </button>
              )}
            </div>
          )}
          <div className="mt-2">
            <TxStatus state={tx.state} />
          </div>
        </div>
      </div>
      {a && a.policies.length > 0 && <Policies m={m} a={a} />}
    </Card>
  );
}

function Policies({ m, a }: { m: MarketRow; a: MarketAccount }) {
  const tx = useTx();
  return (
    <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--line-strong)" }}>
      <div className="kicker !text-[0.62rem]">Your policies</div>
      <ul className="mt-2 space-y-2">
        {a.policies.map((p) => {
          const now = Number(m.now);
          const state = p.settled
            ? p.owed > 0n
              ? `owed ${fmtToken(p.owed)} tUSD`
              : "claimed"
            : now > Number(p.expiry)
              ? "expired"
              : now < Number(p.activeAt)
                ? `starts in ${fmtDuration(Number(p.activeAt) - now)}`
                : `covering, ${fmtDuration(Number(p.expiry) - now)} left`;
          return (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="mono">
                #{p.id} · {fmtToken(p.notional, 0)} tUSD for {fmtToken(p.premium)} · <span className="text-muted">{state}</span>
              </span>
              {p.owed > 0n && (
                <button type="button" className="btn-brutal btn-sm" disabled={tx.busy} onClick={() => tx.run("Claim", { ...spreadMarket(m.address), functionName: "claim", args: [BigInt(p.id)] })}>
                  Claim
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-2">
        <TxStatus state={tx.state} />
      </div>
    </div>
  );
}

const DURATIONS = [
  { value: "86400", label: "1 day" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
];

function BuyCover({ m, a, blocker }: { m: MarketRow; a?: MarketAccount; blocker: string | null }) {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [amt, setAmt] = useState("1000");
  const [dur, setDur] = useState("86400");
  const flow = useTxFlow();
  const notional = parseAmount(amt);
  const mk = spreadMarket(m.address);
  const quote = useQuery({
    queryKey: ["cover-quote", m.address, notional?.toString(), dur],
    queryFn: () => clients.unichain.readContract({ ...mk, functionName: "quotePremium", args: [notional!, BigInt(dur)] }),
    enabled: !!notional,
    retry: false,
  });
  const room = m.poolAssets - (m.cover?.activeNotional ?? 0n);
  const problem =
    notional && notional > room
      ? `Above what the pool can still cover (${fmtToken(room > 0n ? room : 0n, 0)} tUSD). Underwrite it first, or size down.`
      : a && quote.data && quote.data > a.usd
        ? `The premium is ${fmtToken(quote.data)} tUSD; your wallet has ${fmtToken(a.usd)}.`
        : null;

  const buy = () => {
    if (!notional || !address || !quote.data) return;
    const premium = quote.data;
    flow.start([
      {
        label: "Approve tUSD",
        explain: "Lets this market take the premium. Skipped if it already can.",
        call: { ...token, functionName: "approve", args: [m.address as Address, maxUint256] },
        skip: async () => (await clients.unichain.readContract({ ...token, functionName: "allowance", args: [address, m.address] })) >= premium,
      },
      {
        label: "Buy cover",
        explain: `${fmtToken(notional, 0)} tUSD of cover for about ${fmtToken(premium)} tUSD. It starts covering in 10 minutes.`,
        call: { ...mk, functionName: "buyProtection", args: [notional, BigInt(dur)] },
      },
    ]);
  };

  return (
    <Card index="D" ticks title="Buy cover" subtitle="Pays the full amount if the hub trips this market while your policy is covering.">
      <div className="space-y-4">
        <Field label="Cover amount (tUSD)">
          <input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} className="app-input mono" aria-invalid={!notional || !!problem} />
        </Field>
        <Field label="For" group>
          <Segmented value={dur} onChange={setDur} label="Duration" options={DURATIONS} />
        </Field>
      </div>
      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--line-strong)" }}>
        <Rows
          rows={[
            ["Premium", quote.data !== undefined ? `${fmtToken(quote.data)} tUSD` : quote.isError ? "pool can't quote it" : "…"],
            ["Starts covering", "10 minutes after purchase"],
            ["If the pool runs short", "every covered policy is paid pro rata"],
          ]}
        />
      </div>
      <div className="mt-5 space-y-3">
        {!mounted ? null : !isConnected ? (
          <ConnectCta>Connect wallet to buy cover</ConnectCta>
        ) : (
          <button type="button" className="btn-brutal btn-sm" onClick={buy} disabled={!a || !!blocker || !!problem || !quote.data || flow.running}>
            Buy cover
          </button>
        )}
        {problem && <p className="text-xs" style={{ color: "var(--warn)" }}>{problem}</p>}
        <TxFlowView steps={flow.steps} states={flow.states} onRetry={flow.retry} running={flow.running} />
      </div>
    </Card>
  );
}
