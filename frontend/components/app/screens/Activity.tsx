"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { explorers } from "@/lib/config";
import { fmtBps, fmtToken } from "@/lib/format";
import { activityFor, useMarketLogs, type MarketLog } from "@/lib/logs";

import { Card } from "../../ui";
import { PageHeader } from "../AppShell";
import { Segmented } from "../bits";
import { ConnectCta } from "../Wallet";

type Filter = "all" | "cover" | "perp" | "pool";

const KIND: Record<string, Filter> = {
  ProtectionBought: "cover",
  PolicySettled: "cover",
  Claimed: "cover",
  PositionOpened: "perp",
  PositionClosed: "perp",
  Liquidated: "perp",
  Deposited: "pool",
  WithdrawRequested: "pool",
  WithdrawCancelled: "pool",
  Withdrawn: "pool",
};

function describe(l: MarketLog, me: string): { title: string; detail: string } {
  const a = l.args as Record<string, unknown>;
  const t = (k: string, dp = 2) => fmtToken(a[k] as bigint, dp);
  switch (l.eventName) {
    case "ProtectionBought":
      return { title: `Bought cover #${a.id}`, detail: `${t("notional", 0)} tUSD of cover for ${t("premium")} tUSD, starts ${new Date(Number(a.activeAt) * 1000).toLocaleString()}` };
    case "PolicySettled":
      return a.covered
        ? { title: `Cover #${a.id} paid out`, detail: `${t("owed")} tUSD fixed by the trip, ready to claim` }
        : { title: `Cover #${a.id} refunded`, detail: `Bought inside the waiting period: ${t("owed")} tUSD premium back` };
    case "Claimed":
      return { title: `Claimed cover #${a.id}`, detail: `${t("amount")} tUSD sent to your wallet` };
    case "PositionOpened":
      return { title: `Opened ${a.isLong ? "long" : "short"}`, detail: `${t("size", 0)} tUSD size, ${t("margin")} margin, entry ${fmtBps(a.entryMark as bigint)}` };
    case "PositionClosed": {
      const net = (a.pnl as bigint) - (a.funding as bigint);
      return { title: a.liquidated ? "Position liquidated" : "Closed position", detail: `net ${net >= 0n ? "+" : "−"}${fmtToken(net < 0n ? -net : net)} tUSD, ${t("payout")} paid out` };
    }
    case "Liquidated":
      return String(a.liquidator).toLowerCase() === me
        ? { title: "You liquidated a position", detail: `reward ${t("reward")} tUSD` }
        : { title: "Liquidated by a keeper", detail: `liquidator reward ${t("reward")} tUSD` };
    case "Deposited":
      return { title: "Deposited", detail: `${t("assets", 0)} tUSD for ${t("shares")} shares` };
    case "WithdrawRequested":
      return { title: "Requested withdrawal", detail: `${t("shares")} shares, unlocks ${new Date(Number(a.unlockAt) * 1000).toLocaleString()}` };
    case "WithdrawCancelled":
      return { title: "Cancelled withdrawal", detail: `${t("shares")} shares back` };
    case "Withdrawn":
      return { title: "Withdrew", detail: `${t("assets")} tUSD for ${t("shares")} shares` };
    default:
      return { title: l.eventName, detail: "" };
  }
}

export function ActivityScreen() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { address, isConnected } = useAccount();
  const logs = useMarketLogs();
  const [filter, setFilter] = useState<Filter>("all");
  const mine = mounted && address && logs.data ? activityFor(logs.data, address).filter((l) => KIND[l.eventName]) : [];
  const shown = filter === "all" ? mine : mine.filter((l) => KIND[l.eventName] === filter);

  return (
    <>
      <PageHeader
        kicker="05 / History · read from Unichain"
        title="Activity"
        intro="Everything your wallet has done on this market, newest first, each with its transaction."
      />
      <Card index="A" ticks title="Your activity" subtitle={logs.isFetching && !logs.data ? "Scanning the market's history…" : undefined}>
        {!mounted ? null : !isConnected ? (
          <div className="space-y-4">
            <p className="text-sm text-muted">Connect a wallet to see its history on this market.</p>
            <ConnectCta />
          </div>
        ) : (
          <>
            <div className="mb-5 max-w-xl">
              <Segmented
                value={filter}
                onChange={setFilter}
                label="Filter activity"
                options={[
                  { value: "all", label: `All · ${mine.length}` },
                  { value: "cover", label: "Cover" },
                  { value: "perp", label: "Perp" },
                  { value: "pool", label: "Pool" },
                ]}
              />
            </div>
            {logs.isLoading ? (
              <p className="text-sm text-muted" role="status">Reading the market&apos;s history from Unichain. The first load can take a minute; after that it&apos;s cached.</p>
            ) : shown.length === 0 ? (
              <p className="text-sm text-muted">{mine.length === 0 ? "Nothing yet. Buy cover, open a position or deposit, and it shows up here." : "Nothing in this filter."}</p>
            ) : (
              <ol className="divide-y" style={{ borderColor: "var(--line)" }}>
                {shown.map((l) => {
                  const d = describe(l, address!.toLowerCase());
                  const kind = KIND[l.eventName];
                  return (
                    <li key={`${l.txHash}-${l.logIndex}`} className="grid gap-1 py-4 sm:grid-cols-[7rem_1fr_auto] sm:items-center sm:gap-6" style={{ borderColor: "var(--line)" }}>
                      <span className="kicker !text-[0.6rem]" style={{ color: kind === "cover" ? "var(--rift)" : kind === "perp" ? "var(--cold)" : undefined }}>
                        {kind}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm">{d.title}</div>
                        <div className="mt-0.5 text-xs text-muted">{d.detail}</div>
                      </div>
                      <a href={`${explorers.unichain}/tx/${l.txHash}`} target="_blank" rel="noreferrer" className="mono text-xs underline underline-offset-4">
                        block {l.blockNumber.toString()} ↗
                      </a>
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
      </Card>
    </>
  );
}
