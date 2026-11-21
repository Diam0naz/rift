"use client";

import { useQuery } from "@tanstack/react-query";
import type { Hash } from "viem";

/**
 * Client for the Rift indexer (../indexer). Optional: set NEXT_PUBLIC_INDEXER_URL to use it. Without it the
 * app falls back to scanning Unichain from the browser (market events only, recent history only).
 */
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL?.replace(/\/$/, "") || null;

export type ChainKey = "unichain" | "base" | "lasna";

export type IndexedEvent = {
  chainId: number;
  block: bigint;
  logIndex: number;
  txHash: Hash;
  contract: string;
  event: string;
  args: Record<string, unknown>;
  /** Block timestamp, seconds. */
  ts: number;
};

export type IndexerStatus = {
  startedAt: number;
  now: number;
  chains: {
    key: ChainKey;
    id: number;
    name: string;
    head: string | null;
    scannedTo: string | null;
    lag: number | null;
    backfilling: boolean;
    lastSyncAt: number | null;
    lastError: string | null;
    events: number;
  }[];
};

// The indexer keeps bigints as {"$b":"…"}; revive them.
const reviver = (_: string, v: unknown) =>
  v && typeof v === "object" && "$b" in (v as Record<string, unknown>) ? BigInt((v as { $b: string }).$b) : v;

async function get<T>(path: string): Promise<T> {
  if (!INDEXER_URL) throw new Error("indexer not configured");
  const res = await fetch(`${INDEXER_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`indexer ${res.status}`);
  return JSON.parse(await res.text(), reviver) as T;
}

export type EventFilter = {
  chain?: number;
  contract?: string[];
  event?: string[];
  account?: string;
  fromBlock?: bigint;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export async function fetchEvents(f: EventFilter): Promise<{ total: number; scannedTo: bigint | null; events: IndexedEvent[] }> {
  const q = new URLSearchParams();
  if (f.chain) q.set("chain", String(f.chain));
  if (f.contract?.length) q.set("contract", f.contract.join(","));
  if (f.event?.length) q.set("event", f.event.join(","));
  if (f.account) q.set("account", f.account);
  if (f.fromBlock !== undefined) q.set("fromBlock", f.fromBlock.toString());
  if (f.order) q.set("order", f.order);
  q.set("limit", String(f.limit ?? 100));
  if (f.offset) q.set("offset", String(f.offset));
  const r = await get<{ total: number; scannedTo: string | null; events: (Omit<IndexedEvent, "block"> & { block: string })[] }>(`/events?${q}`);
  return {
    total: r.total,
    scannedTo: r.scannedTo ? BigInt(r.scannedTo) : null,
    events: r.events.map((e) => ({ ...e, block: BigInt(e.block) })),
  };
}

export const useIndexerStatus = () =>
  useQuery({
    queryKey: ["indexer", "status"],
    queryFn: () => get<IndexerStatus>("/status"),
    enabled: !!INDEXER_URL,
    refetchInterval: 5_000,
    retry: 1,
  });

/** Reactive Lasna events the trip and mark views need (all of them are small in number). */
export const useReactiveEvents = () =>
  useQuery({
    queryKey: ["indexer", "reactive"],
    queryFn: async () => (await fetchEvents({ chain: 5318007, event: ["TripSent", "TripConfirmed", "BreachStarted", "DemoReset"], order: "asc", limit: 2000 })).events,
    enabled: !!INDEXER_URL,
    refetchInterval: 15_000,
  });
