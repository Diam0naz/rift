"use client";

import { useMemo } from "react";

import { addresses, explorers } from "@/lib/config";
import { useMarkHistory, useMarket, useOrigin, useReactive } from "@/lib/hooks";
import { computeRiskBand } from "@/lib/risk";

import { HealthPanel, LatencyPanel, PoliciesPanel, PoolPanel, RiskBandPanel, SpreadPanel, TripPanel } from "./panels";
import { ErrorNote, ExtLink, Skeleton } from "./ui";

export function Dashboard() {
  const market = useMarket();
  const reactive = useReactive();
  const origin = useOrigin();
  const history = useMarkHistory();

  const m = market.data;
  const r = reactive.data;
  const o = origin.data;
  const band = useMemo(() => (m && r ? computeRiskBand(m, r) : null), [m, r]);

  const failing = [
    market.isError && !m && "Unichain",
    reactive.isError && !r && "Lasna",
    origin.isError && !o && "Base",
  ].filter(Boolean) as string[];

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rift</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            A spread perp and drain protection on the Unichain ↔ Base pool spread, settled by Reactive Network in seconds.
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <ExtLink href={`${explorers.unichain}/address/${addresses.unichain.market}`}>RiftMarket ↗</ExtLink>
          <ExtLink href={`${explorers.lasna}/address/${addresses.lasna.reactive}`}>RiftReactive ↗</ExtLink>
          <ExtLink href={`${explorers.base}/address/${addresses.base.vault}`}>Vault ↗</ExtLink>
        </nav>
      </header>

      {failing.length > 0 && (
        <div className="mb-4 rounded-lg border border-bad/40 bg-bad/5 p-3">
          <ErrorNote what={`${failing.join(", ")} state`} />
        </div>
      )}

      <div className="space-y-4">
        {band ? <RiskBandPanel band={band} /> : <Skeleton className="h-40 w-full rounded-xl" />}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {m && r && o ? (
              <SpreadPanel m={m} r={r} o={o} history={history.data} />
            ) : (
              <Skeleton className="h-80 w-full rounded-xl" />
            )}
          </div>
          {r && o ? <TripPanel r={r} o={o} /> : <Skeleton className="h-80 w-full rounded-xl" />}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {m ? <PoolPanel m={m} /> : <Skeleton className="h-72 w-full rounded-xl" />}
          {m ? <PoliciesPanel m={m} /> : <Skeleton className="h-72 w-full rounded-xl" />}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <LatencyPanel history={history.data} />
          {m && r && o ? <HealthPanel m={m} r={r} o={o} /> : <Skeleton className="h-64 w-full rounded-xl" />}
        </div>
      </div>

      <footer className="mt-8 text-xs text-muted">
        Testnet demo. Read directly from Base Sepolia, Unichain Sepolia and Reactive Lasna every few seconds.
      </footer>
    </div>
  );
}
