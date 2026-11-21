"use client";

import { useQuery } from "@tanstack/react-query";
import { decodeEventLog, type Address, type Hash } from "viem";

import { riftMarketAbi } from "./abi/RiftMarket";
import { LOG_CHUNK, MARKET_DEPLOY_BLOCK, addresses, clients } from "./config";
import type { MarkPoint } from "./reads";

/**
 * One scan of every RiftMarket event since deployment, shared by the mark chart, latency, activity and
 * payout history. Unichain's public RPC caps eth_getLogs at 1,000 blocks and rate-limits, so the range is
 * chunked (3 requests in flight), retried by the client, and cached in memory and in this browser: after
 * the first load only new blocks are fetched, even across reloads.
 */

export type MarketLog = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  txHash: Hash;
  logIndex: number;
};

const LOG_CONCURRENCY = 3;
/** Look back at most this many chunks (~1,000 blocks each, ~1.7 days on Unichain's 1 s blocks). */
const MAX_CHUNKS = 150n;
const STORAGE_KEY = `rift:marketLogs:v1:${addresses.unichain.market}`;

type Cache = { logs: MarketLog[]; scannedTo: bigint };
let cache: Cache | null = null;

// JSON can't hold bigints; store them as {"$b":"123"} and revive them on load.
const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? { $b: v.toString() } : v);
const reviver = (_: string, v: unknown) =>
  v && typeof v === "object" && "$b" in (v as Record<string, unknown>) ? BigInt((v as { $b: string }).$b) : v;

function load(): Cache | null {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    return raw ? (JSON.parse(raw, reviver) as Cache) : null;
  } catch {
    return null; // storage blocked or corrupt: rescan
  }
}

function store(c: Cache) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(c, replacer));
  } catch {
    // private mode / quota: keep the in-memory copy only
  }
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

  const logs = [...(cache?.logs ?? []), ...fresh].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  cache = { logs, scannedTo: head };
  store(cache);
  return logs;
}

export const useMarketLogs = () =>
  useQuery({ queryKey: ["marketLogs"], queryFn: scanMarketLogs, refetchInterval: 20_000 });

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
