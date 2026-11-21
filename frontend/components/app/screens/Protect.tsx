"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { maxUint256, parseUnits } from "viem";
import { useAccount } from "wagmi";

import { mockTokenAbi } from "@/lib/abi/MockToken";
import { riftMarketAbi } from "@/lib/abi/RiftMarket";
import { addresses, clients, explorers } from "@/lib/config";
import { fmtBps, fmtCompact, fmtToken, shortHex } from "@/lib/format";
import { useMarket, useOrigin, useReactive } from "@/lib/hooks";
import { policyIdsFor, useMarketLogs } from "@/lib/logs";
import { newRiskBlocker, policyStatus } from "@/lib/market";
import type { MarketState, OriginState, ReactiveState } from "@/lib/reads";
import { fmtDuration } from "@/lib/risk";
import { useTx, useTxFlow } from "@/lib/tx";
import { MARKET_CHAIN_ID } from "@/lib/wagmi";

import { Bar, Card, Pill, Skeleton } from "../../ui";
import { PageHeader } from "../AppShell";
import { Banner, Field, Rows, Segmented } from "../bits";
import { TxFlowView, TxStatus } from "../TxFlow";
import { AccountBar, ConnectCta } from "../Wallet";

const market = { address: addresses.unichain.market, abi: riftMarketAbi } as const;
const token = { address: addresses.unichain.collateral, abi: mockTokenAbi } as const;

const DURATIONS = [
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
];

export function parseAmount(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  try {
    return parseUnits(t, 18);
  } catch {
    return null;
  }
}

export function ProtectScreen() {
  const m = useMarket().data;
  const r = useReactive().data;
  const o = useOrigin().data;
  return (
    <>
      <PageHeader
        kicker="01 / Drain protection · settles on Unichain"
        title="Protect"
        outline="the vault"
        intro="Buy cover on the watched vault. If it's drained while you're covered, the trip fixes your payout within seconds, and you claim it here."
      />
      <AccountBar />
      {m && newRiskBlocker(m) && <Banner tone={m.tripped ? "bad" : "warn"}>{newRiskBlocker(m)}</Banner>}
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="lg:col-span-5">{m && r && o ? <VaultCard m={m} r={r} o={o} /> : <Skeleton className="h-[560px] w-full" />}</div>
        <div className="lg:col-span-7">{m ? <CoverTicket m={m} /> : <Skeleton className="h-[560px] w-full" />}</div>
      </div>
      <div className="mt-5">{m ? <MyCovers now={m.now} /> : null}</div>
    </>
  );
}

// ---------------------------------------------------------------- the watched vault

function VaultCard({ m, r, o }: { m: MarketState; r: ReactiveState; o: OriginState }) {
  const p = r.params;
  const absSpread = Number(r.spreadBps < 0n ? -r.spreadBps : r.spreadBps);
  return (
    <Card index="A" ticks title="Watched vault · Base Sepolia" subtitle="The one vault this market covers.">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <div className="kicker !text-[0.62rem]">Holdings on Base</div>
          <div className="display mt-2 text-[clamp(2.25rem,4vw,3.25rem)]" style={{ textTransform: "none" }}>
            {fmtCompact(o.vaultAssets)}
          </div>
          <div className="mono mt-1 text-xs text-muted">tQUOTE · mirrored by Reactive: {fmtCompact(r.vaultBalance)}</div>
        </div>
        <a
          href={`${explorers.base}/address/${addresses.base.vault}`}
          target="_blank"
          rel="noreferrer"
          className="mono text-xs underline underline-offset-4 opacity-80 hover:opacity-100"
        >
          {shortHex(addresses.base.vault, 4)} ↗
        </a>
      </div>

      <div className="border-t pt-5" style={{ borderColor: "var(--line)" }}>
        <div className="kicker mb-3 !text-[0.62rem]">Pays out when both hold</div>
        <p className="mb-5 text-sm leading-relaxed">
          The vault loses at least <strong>{Number(p.tripOutflowBps) / 100}%</strong> within{" "}
          <strong>{fmtDuration(Number(p.windowSeconds))}</strong>, <em>while</em> its pool&apos;s price breaks at least{" "}
          <strong>{Number(p.tripSpreadBps) / 100}%</strong> from the twin pool on Unichain for{" "}
          <strong>{p.sustainSeconds.toString()}s</strong>. Either one alone pays nothing.
        </p>
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 flex justify-between text-xs">
              <span className="text-muted">Spread now</span>
              <span className="mono">
                {fmtBps(r.spreadBps)} / ±{Number(p.tripSpreadBps) / 100}%
              </span>
            </div>
            <Bar value={absSpread} max={Number(p.tripSpreadBps) * 1.5} marker={Number(p.tripSpreadBps)} tone={absSpread >= Number(p.tripSpreadBps) ? "red" : "green"} label="Spread against trip threshold" />
          </div>
          <div>
            <div className="mb-1.5 flex justify-between text-xs">
              <span className="text-muted">Outflow in window</span>
              <span className="mono">
                {fmtBps(r.outflowBps, false)} / {Number(p.tripOutflowBps) / 100}%
              </span>
            </div>
            <Bar value={Number(r.outflowBps)} max={Number(p.tripOutflowBps) * 1.5} marker={Number(p.tripOutflowBps)} tone={r.outflowBps >= p.tripOutflowBps ? "red" : "green"} label="Outflow against trip threshold" />
          </div>
        </div>
      </div>

      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--line)" }}>
        <Rows
          rows={[
            ["Cover starts", `${fmtDuration(Number(m.coverDelay))} after purchase`],
            ["Pool utilization", `${((Number(m.utilizationWad) / 1e18) * 100).toFixed(1)}% (kink ${(Number(m.premium.kinkWad) / 1e16).toFixed(0)}%)`],
            ["Stress loading", `${(Number(m.stressMultiplierBps) / 10_000).toFixed(2)}×`],
            ["Live cover", `${fmtCompact(m.activeNotional)} tUSD`],
            ["Market", m.tripped ? "Tripped · claims open" : "Armed"],
          ]}
        />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- buy ticket

function CoverTicket({ m }: { m: MarketState }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { address, isConnected, chainId } = useAccount();
  const [notional, setNotional] = useState("1000");
  const [duration, setDuration] = useState("86400");
  const flow = useTxFlow();
  const amount = parseAmount(notional);
  const dur = BigInt(duration);
  const blocker = newRiskBlocker(m);

  const quote = useQuery({
    queryKey: ["quote", amount?.toString(), duration, m.blockNumber.toString()],
    queryFn: () => clients.unichain.readContract({ ...market, functionName: "quotePremium", args: [amount!, dur] }),
    enabled: !!amount && amount > 0n,
    retry: false,
  });

  const now = Date.now() / 1000;
  const startsAt = new Date((now + Number(m.coverDelay)) * 1000);
  const endsAt = new Date((now + Number(dur)) * 1000);
  const ready = isConnected && chainId === MARKET_CHAIN_ID;

  const buy = () => {
    if (!amount || quote.data === undefined || !address) return;
    const premium = quote.data;
    flow.start([
      {
        label: "Approve tUSD",
        explain: "Lets RiftMarket take the premium from your wallet. Skipped if it already can.",
        call: { ...token, functionName: "approve", args: [addresses.unichain.market, maxUint256] },
        skip: async () =>
          (await clients.unichain.readContract({ ...token, functionName: "allowance", args: [address, addresses.unichain.market] })) >= premium,
      },
      {
        label: "Buy cover",
        explain: `Pays ${fmtToken(premium)} tUSD for ${fmtToken(amount, 0)} tUSD of cover for ${DURATIONS.find((d) => d.value === duration)?.label}.`,
        call: { ...market, functionName: "buyProtection", args: [amount, dur] },
      },
    ]);
  };

  return (
    <Card index="B" title="Buy cover" subtitle="Quotes are live and need no wallet. You sign only on Unichain Sepolia.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Cover amount (tUSD)" hint="Paid out in full if the vault is drained while you're covered.">
          <input inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value)} className="app-input mono" aria-invalid={!amount} />
        </Field>
        <Field label="Duration" group>
          <Segmented value={duration} options={DURATIONS} onChange={setDuration} label="Cover duration" />
        </Field>
      </div>

      <div className="mt-6 flex flex-wrap items-end justify-between gap-4 border-y py-5" style={{ borderColor: "var(--line-strong)" }}>
        <div>
          <div className="kicker !text-[0.62rem]">Premium</div>
          <div className="display mt-2 text-[clamp(2.25rem,4.5vw,3.5rem)]" style={{ textTransform: "none" }} aria-live="polite">
            {!amount ? "—" : quote.isLoading ? "…" : quote.data !== undefined ? fmtToken(quote.data) : "No capacity"}
            {quote.data !== undefined && <span className="mono ml-2 text-base text-muted">tUSD</span>}
          </div>
        </div>
        <div className="text-right text-xs text-muted">
          {amount && quote.data !== undefined && (
            <>
              {((Number(quote.data) / Number(amount)) * 100).toFixed(3)}% of cover
              <br />
              stress {(Number(m.stressMultiplierBps) / 10_000).toFixed(2)}× · utilization-priced
            </>
          )}
        </div>
      </div>

      <div className="mt-5">
        <div className="kicker mb-2 !text-[0.62rem]">Review</div>
        <Rows
          rows={[
            ["Cover starts", `${startsAt.toLocaleString()} (in ${fmtDuration(Number(m.coverDelay))})`],
            ["Cover ends", endsAt.toLocaleString()],
            ["If the vault is drained after it starts", `${amount ? fmtToken(amount, 0) : "—"} tUSD, pro-rata if the pool is short`],
            ["If it's drained before it starts", "Your premium back"],
            ["How you get paid", "The trip fixes your payout; you claim it (anyone can, funds go to you)"],
          ]}
        />
      </div>

      <div className="mt-6 space-y-4">
        {!mounted ? null : !isConnected ? (
          <ConnectCta>Connect wallet to buy cover</ConnectCta>
        ) : (
          <button
            type="button"
            className="btn-brutal btn-sm"
            onClick={buy}
            disabled={!ready || !!blocker || flow.running || !amount || quote.data === undefined}
          >
            Buy cover
          </button>
        )}
        {blocker && <p className="text-xs" style={{ color: "var(--warn)" }}>{blocker}</p>}
        <TxFlowView steps={flow.steps} states={flow.states} onRetry={flow.retry} running={flow.running} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- your covers

function MyCovers({ now }: { now: bigint }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { address, isConnected } = useAccount();
  const logs = useMarketLogs();
  const ids = address && logs.data ? policyIdsFor(logs.data, address) : [];
  const policies = useQuery({
    queryKey: ["myPolicies", ids.map(String).join(","), now.toString()],
    queryFn: () => Promise.all(ids.map(async (id) => ({ id, ...(await clients.unichain.readContract({ ...market, functionName: "policy", args: [id] })) }))),
    enabled: ids.length > 0,
  });
  const tx = useTx();
  if (!mounted) return null;

  return (
    <Card index="C" title="Your covers" subtitle="Everything you've bought on this market, newest first.">
      {!isConnected ? (
        <p className="text-sm text-muted">Connect a wallet to see your covers.</p>
      ) : logs.isLoading ? (
        <p className="text-sm text-muted" role="status">Reading your history from Unichain…</p>
      ) : ids.length === 0 ? (
        <p className="text-sm text-muted">No covers yet. Your first one appears here, with a countdown until it starts.</p>
      ) : !policies.data ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="-mx-5 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b" style={{ borderColor: "var(--line-strong)" }}>
                {["Cover", "Amount", "Premium", "Ends", "Status", ""].map((h) => (
                  <th key={h} className="kicker !text-[0.6rem] py-2 pr-3 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {policies.data.map((p) => {
                const st = policyStatus(p, now);
                return (
                  <tr key={p.id.toString()} className="border-b last:border-0" style={{ borderColor: "var(--line)" }}>
                    <td className="mono py-3 pr-3">#{p.id.toString()}</td>
                    <td className="mono py-3 pr-3">{fmtToken(p.notional, 0)}</td>
                    <td className="mono py-3 pr-3">{fmtToken(p.premium)}</td>
                    <td className="mono py-3 pr-3 text-xs text-muted">{new Date(Number(p.expiry) * 1000).toLocaleString()}</td>
                    <td className="py-3 pr-3">
                      {st.kind === "waiting" && <Pill tone="amber">Starts in {fmtDuration(st.startsIn)}</Pill>}
                      {st.kind === "covered" && <Pill tone="green">Covered · {fmtDuration(st.endsIn)} left</Pill>}
                      {st.kind === "expired" && <Pill tone="muted">Expired</Pill>}
                      {st.kind === "claimable" && <Pill tone="amber">{st.refund ? "Refund" : "Payout"} {fmtToken(st.amount)}</Pill>}
                      {st.kind === "claimed" && <Pill tone="muted">Claimed</Pill>}
                    </td>
                    <td className="py-3 text-right">
                      {st.kind === "claimable" && (
                        <button
                          type="button"
                          className="btn-brutal btn-sm"
                          disabled={tx.busy}
                          onClick={() => tx.run(`Claim #${p.id}`, { ...market, functionName: "claim", args: [p.id] })}
                        >
                          Claim
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3">
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}
