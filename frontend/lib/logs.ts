"use client";

import { useQuery } from "@tanstack/react-query";
import { decodeEventLog, type Address, type Hash } from "viem";

import { riftMarketAbi } from "./abi/RiftMarket";
import { LOG_CHUNK, MARKET_DEPLOY_BLOCK, addresses, clients } from "./config";
import { INDEXER_URL, fetchEvents } from "./indexer";
import type { MarkPoint } from "./reads";

/**
 * Every RiftMarket event since deployment, shared by the mark chart, latency, activity, history and payout
 * views. From the indexer when NEXT_PUBLIC_INDEXER_URL is set (full history, with block times); otherwise,
 * or if the indexer is unreachable, scanned from the browser. Unichain's public RPC caps eth_getLogs at
 * 1,000 blocks and rate-limits, so that scan is chunked (3 requests in flight), retried, limited to recent
 * history, and cached in memory and in this browser. Either way only new blocks are fetched after the first load.
 */

export type MarketLog = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  txHash: Hash;
  logIndex: number;
  /** Block timestamp (seconds); only known when read from the indexer. */
  ts?: number;
};

export type MarketLogs = { logs: MarketLog[]; source: "indexer" | "browser" };

const LOG_CONCURRENCY = 3;
/** Look back at most this many chunks (~1,000 blocks each, ~1.7 days on Unichain's 1 s blocks). */
const MAX_CHUNKS = 150n;
const STORAGE_KEY = `rift:marketLogs:v1:${addresses.unichain.market}`;
const INDEXER_KEY = `rift:marketLogs:idx1:${addresses.unichain.market}`;
const PAGE = 2000;

type Cache = { logs: MarketLog[]; scannedTo: bigint };
let cache: Cache | null = null;
let idxCache: Cache | null = null;

// JSON can't hold bigints; store them as {"$b":"123"} and revive them on load.
const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? { $b: v.toString() } : v);
const reviver = (_: string, v: unknown) =>
  v && typeof v === "object" && "$b" in (v as Record<string, unknown>) ? BigInt((v as { $b: string }).$b) : v;

function load(key = STORAGE_KEY): Cache | null {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    return raw ? (JSON.parse(raw, reviver) as Cache) : null;
  } catch {
    return null; // storage blocked or corrupt: rescan
  }
}

function store(c: Cache, key = STORAGE_KEY) {
  try {
    window.localStorage.setItem(key, JSON.stringify(c, replacer));
  } catch {
    // private mode / quota: keep the in-memory copy only
  }
}

const byPosition = (a: MarketLog, b: MarketLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

/** New market events from the indexer since the last read, paged. */
async function readIndexer(): Promise<MarketLog[]> {
  idxCache ??= load(INDEXER_KEY);
  const fromBlock = idxCache ? idxCache.scannedTo + 1n : 0n;
  const fresh: MarketLog[] = [];
  let scannedTo = idxCache?.scannedTo ?? -1n;
  for (let offset = 0; ; offset += PAGE) {
    const r = await fetchEvents({ chain: 1301, contract: ["market"], fromBlock, order: "asc", limit: PAGE, offset });
    for (const e of r.events) {
      fresh.push({ eventName: e.event, args: e.args, blockNumber: e.block, txHash: e.txHash, logIndex: e.logIndex, ts: e.ts });
    }
    if (r.scannedTo !== null && r.scannedTo > scannedTo) scannedTo = r.scannedTo;
    if (r.events.length < PAGE) break;
  }
  const seen = new Set((idxCache?.logs ?? []).map((l) => `${l.txHash}:${l.logIndex}`));
  const logs = [...(idxCache?.logs ?? []), ...fresh.filter((l) => !seen.has(`${l.txHash}:${l.logIndex}`))].sort(byPosition);
  idxCache = { logs, scannedTo };
  store(idxCache, INDEXER_KEY);
  return logs;
}

export async function readMarketLogs(): Promise<MarketLogs> {
  if (INDEXER_URL) {
    try {
      return { logs: await readIndexer(), source: "indexer" };
    } catch {
      // Indexer down or unreachable: fall through to the browser scan.
    }
  }
  return { logs: await scanMarketLogs(), source: "browser" };
}

export async function scanMarketLogs(): Promise<MarketLog[]> {
  const c = clients.unichain;
  cache ??= load();
  const head = await c.getBlockNumber();
  const floor = head > MAX_CHUNKS * LOG_CHUNK ? head - MAX_CHUNKS * LOG_CHUNK : 0n;
  let start = cache ? cache.scannedTo + 1n : MARKET_DEPLOY_BLOCK;
  if (start < floor) start = floor;
  if (start < MARKET_DEPLOY_BLOCK) start = MARKET_DEPLOY_BLOCK;

  const ranges: [bigint, bigint][] = [];
  for (let from = start; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n;
    ranges.push([from, to > head ? head : to]);
  }

  const fresh: MarketLog[] = [];
  for (let i = 0; i < ranges.length; i += LOG_CONCURRENCY) {
    const batch = await Promise.all(
      ranges
        .slice(i, i + LOG_CONCURRENCY)
        .map(([fromBlock, toBlock]) => c.getLogs({ address: addresses.unichain.market as Address, fromBlock, toBlock })),
    );
    for (const log of batch.flat()) {
      try {
        const d = decodeEventLog({ abi: riftMarketAbi, data: log.data, topics: log.topics });
        fresh.push({
          eventName: d.eventName,
          args: (d.args ?? {}) as Record<string, unknown>,
          blockNumber: log.blockNumber!,
          txHash: log.transactionHash!,
          logIndex: log.logIndex!,
        });
      } catch {
        // Not one of the market's own events (e.g. inherited payer events): skip.
      }
    }
  }

  const logs = [...(cache?.logs ?? []), ...fresh].sort(byPosition);
  cache = { logs, scannedTo: head };
  store(cache);
  return logs;
}

/** Market events (data.logs) and where they came from (data.source). */
export const useMarketLogSource = () =>
  useQuery({ queryKey: ["marketLogs"], queryFn: readMarketLogs, refetchInterval: INDEXER_URL ? 5_000 : 20_000 });

/** Just the events, for views that don't care about the source. */
export const useMarketLogs = () => {
  const q = useMarketLogSource();
  return { ...q, data: q.data?.logs };
};

// ---------------------------------------------------------------- derived views

export function markHistory(logs: MarketLog[]): MarkPoint[] {
  return logs
    .filter((l) => l.eventName === "MarkUpdated")
    .map((l) => {
      const a = l.args as { markBps: bigint; observedAt: bigint; receivedAt: bigint; originChainId: bigint };
      return {
        markBps: Number(a.markBps),
        observedAt: Number(a.observedAt),
        receivedAt: Number(a.receivedAt),
        latency: Number(a.receivedAt) - Number(a.observedAt),
        originChainId: Number(a.originChainId),
        txHash: l.txHash,
        blockNumber: l.blockNumber,
      };
    });
}

/** Events that concern one wallet, newest first. */
export function activityFor(logs: MarketLog[], user: Address): MarketLog[] {
  const me = user.toLowerCase();
  const isMe = (v: unknown) => typeof v === "string" && v.toLowerCase() === me;
  return logs
    .filter((l) => {
      const a = l.args;
      return isMe(a.buyer) || isMe(a.user) || isMe(a.trader) || isMe(a.liquidator);
    })
    .reverse();
}

/** Policy ids a wallet has bought, newest first. */
export function policyIdsFor(logs: MarketLog[], user: Address): bigint[] {
  const me = user.toLowerCase();
  return logs
    .filter((l) => l.eventName === "ProtectionBought" && String(l.args.buyer).toLowerCase() === me)
    .map((l) => l.args.id as bigint)
    .reverse();
}
