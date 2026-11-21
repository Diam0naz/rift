import { parseAbiItem, type Address } from "viem";

import { mockVaultAbi } from "./abi/MockVault";
import { riftMarketAbi } from "./abi/RiftMarket";
import { riftPoolAbi } from "./abi/RiftPool";
import { riftReactiveAbi } from "./abi/RiftReactive";
import { LOG_CHUNK, MARKET_DEPLOY_BLOCK, addresses, clients } from "./config";

const market = { address: addresses.unichain.market, abi: riftMarketAbi } as const;
const reactive = { address: addresses.lasna.reactive, abi: riftReactiveAbi } as const;

/** Notional and duration used for the live premium quote shown on the dashboard. */
export const QUOTE_NOTIONAL = 10_000n * 10n ** 18n;
export const QUOTE_DURATION = 86_400n;

// ---------------------------------------------------------------- Unichain: RiftMarket

export async function readMarket() {
  const c = clients.unichain;
  const [
    block,
    markBps,
    markObservedAt,
    markReceivedAt,
    tripped,
    tripMark,
    trippedAt,
    payoutRatioBps,
    totalOwed,
    poolAssets,
    poolValue,
    tradersPnl,
    totalShares,
    totalMargin,
    openLongSize,
    openShortSize,
    utilizationWad,
    stressMultiplierBps,
    premiumParams,
    coverDelay,
    maxMarkAge,
    policiesCount,
    activeNotional,
    reservedLiquidity,
    quote,
    callbackFunding,
    poolUniPrice,
  ] = await Promise.all([
    c.getBlock(),
    c.readContract({ ...market, functionName: "markBps" }),
    c.readContract({ ...market, functionName: "markObservedAt" }),
    c.readContract({ ...market, functionName: "markReceivedAt" }),
    c.readContract({ ...market, functionName: "tripped" }),
    c.readContract({ ...market, functionName: "tripMark" }),
    c.readContract({ ...market, functionName: "trippedAt" }),
    c.readContract({ ...market, functionName: "payoutRatioBps" }),
    c.readContract({ ...market, functionName: "totalOwed" }),
    c.readContract({ ...market, functionName: "poolAssets" }),
    c.readContract({ ...market, functionName: "poolValue" }),
    c.readContract({ ...market, functionName: "tradersUnrealizedPnl" }),
    c.readContract({ ...market, functionName: "totalShares" }),
    c.readContract({ ...market, functionName: "totalMargin" }),
    c.readContract({ ...market, functionName: "openLongSize" }),
    c.readContract({ ...market, functionName: "openShortSize" }),
    c.readContract({ ...market, functionName: "utilizationWad" }),
    c.readContract({ ...market, functionName: "stressMultiplierBps" }),
    c.readContract({ ...market, functionName: "premiumParams" }),
    c.readContract({ ...market, functionName: "coverDelay" }),
    c.readContract({ ...market, functionName: "maxMarkAge" }),
    c.readContract({ ...market, functionName: "policiesCount" }),
    c.readContract({ ...market, functionName: "activeNotional" }),
    c.readContract({ ...market, functionName: "reservedLiquidity" }),
    c
      .readContract({ ...market, functionName: "quotePremium", args: [QUOTE_NOTIONAL, QUOTE_DURATION] })
      .catch(() => null), // reverts when the pool has no capacity
    c.getBalance({ address: addresses.unichain.market }),
    c.readContract({ address: addresses.unichain.pool, abi: riftPoolAbi, functionName: "price" }),
  ]);

  const [baseBpsPerDay, slope1BpsPerDay, slope2BpsPerDay, kinkWad, stressSpreadBps] = premiumParams;

  // Most recent policies (ids never repeat; the market keeps at most 64 live at once).
  const first = policiesCount > 20n ? policiesCount - 20n : 0n;
  const ids: bigint[] = [];
  for (let i = policiesCount - 1n; i >= first && i >= 0n; i--) ids.push(i);
  const policies = await Promise.all(
    ids.map(async (id) => ({ id, ...(await c.readContract({ ...market, functionName: "policy", args: [id] })) })),
  );

  return {
    now: block.timestamp,
    blockNumber: block.number,
    markBps,
    markObservedAt,
    markReceivedAt,
    tripped,
    tripMark,
    trippedAt,
    payoutRatioBps,
    totalOwed,
    poolAssets,
    poolValue,
    tradersPnl,
    totalShares,
    totalMargin,
    openLongSize,
    openShortSize,
    utilizationWad,
    stressMultiplierBps,
    premium: { baseBpsPerDay, slope1BpsPerDay, slope2BpsPerDay, kinkWad, stressSpreadBps },
    coverDelay,
    maxMarkAge,
    policiesCount,
    activeNotional,
    reservedLiquidity,
    quote,
    callbackFunding,
    poolUniPrice,
    policies,
  };
}
export type MarketState = Awaited<ReturnType<typeof readMarket>>;

// ---------------------------------------------------------------- Lasna: RiftReactive

export async function readReactive() {
  const c = clients.lasna;
  const r = <F extends ReactiveView>(functionName: F) => c.readContract({ ...reactive, functionName });
  const [
    block,
    priceBase,
    priceUni,
    spreadBps,
    smoothedSpreadBps,
    outflowBps,
    vaultBalance,
    windowOutflow,
    breachSince,
    tripped,
    tripConfirmed,
    tripsSent,
    lastSentMark,
    lastSentAt,
    marksSent,
    params,
    balance,
  ] = await Promise.all([
    c.getBlock(),
    r("priceBase"),
    r("priceUni"),
    r("spreadBps"),
    r("smoothedSpreadBps"),
    r("outflowBps"),
    r("vaultBalance"),
    r("windowOutflow"),
    r("breachSince"),
    r("tripped"),
    r("tripConfirmed"),
    r("tripsSent"),
    r("lastSentMark"),
    r("lastSentAt"),
    r("marksSent"),
    c.readContract({ ...reactive, functionName: "params" }),
    c.getBalance({ address: addresses.lasna.reactive }),
  ]);
  const [
    tripSpreadBps,
    sustainSeconds,
    windowSeconds,
    tripOutflowBps,
    markEpsilonBps,
    markHeartbeat,
    markSmoothingSeconds,
    minQuoteReserve,
  ] = params;

  return {
    now: block.timestamp,
    priceBase: priceBase as bigint,
    priceUni: priceUni as bigint,
    spreadBps: spreadBps as bigint,
    smoothedSpreadBps: smoothedSpreadBps as bigint,
    outflowBps: outflowBps as bigint,
    vaultBalance: vaultBalance as bigint,
    windowOutflow: windowOutflow as bigint,
    breachSince: breachSince as bigint,
    tripped: tripped as boolean,
    tripConfirmed: tripConfirmed as boolean,
    tripsSent: tripsSent as bigint,
    lastSentMark: lastSentMark as bigint,
    lastSentAt: lastSentAt as bigint,
    marksSent: marksSent as bigint,
    params: {
      tripSpreadBps,
      sustainSeconds,
      windowSeconds,
      tripOutflowBps,
      markEpsilonBps,
      markHeartbeat,
      markSmoothingSeconds,
      minQuoteReserve,
    },
    balance,
  };
}
export type ReactiveState = Awaited<ReturnType<typeof readReactive>>;

/** RiftReactive's no-argument views that return a single value. */
type ReactiveView =
  | "priceBase"
  | "priceUni"
  | "spreadBps"
  | "smoothedSpreadBps"
  | "outflowBps"
  | "vaultBalance"
  | "windowOutflow"
  | "breachSince"
  | "tripped"
  | "tripConfirmed"
  | "tripsSent"
  | "lastSentMark"
  | "lastSentAt"
  | "marksSent";

// ---------------------------------------------------------------- Base: origin pool + vault

export async function readOrigin() {
  const c = clients.base;
  const [block, price, reserve0, reserve1, vaultAssets] = await Promise.all([
    c.getBlock(),
    c.readContract({ address: addresses.base.pool, abi: riftPoolAbi, functionName: "price" }),
    c.readContract({ address: addresses.base.pool, abi: riftPoolAbi, functionName: "reserve0" }),
    c.readContract({ address: addresses.base.pool, abi: riftPoolAbi, functionName: "reserve1" }),
    c.readContract({ address: addresses.base.vault, abi: mockVaultAbi, functionName: "totalAssets" }),
  ]);
  return { now: block.timestamp, price, reserve0, reserve1, vaultAssets };
}
export type OriginState = Awaited<ReturnType<typeof readOrigin>>;

// ---------------------------------------------------------------- history: marks delivered to the market

const markUpdated = parseAbiItem(
  "event MarkUpdated(int256 markBps, uint256 observedAt, uint256 receivedAt, uint256 originChainId, uint256 originTxHash)",
);

export type MarkPoint = {
  markBps: number;
  observedAt: number;
  receivedAt: number;
  latency: number;
  originChainId: number;
  txHash: `0x${string}`;
  blockNumber: bigint;
};

/** Max getLogs calls in flight at once, to stay under the public RPC's rate limit. */
const LOG_CONCURRENCY = 3;
/** Look back at most this many chunks (~1,000 blocks each, ~1.4 days on Unichain's 1s blocks). */
const MAX_CHUNKS = 120n;

type HistoryCache = { points: MarkPoint[]; scannedTo: bigint };
const STORAGE_KEY = `rift:markHistory:${addresses.unichain.market}`;
let historyCache: HistoryCache | null = null;

/** History saved in this browser, so a reload only scans new blocks. Absent or unreadable -> rescan. */
function loadStoredHistory(): HistoryCache | null {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const v = JSON.parse(raw) as { scannedTo: string; points: (Omit<MarkPoint, "blockNumber"> & { blockNumber: string })[] };
    return {
      scannedTo: BigInt(v.scannedTo),
      points: v.points.map((p) => ({ ...p, blockNumber: BigInt(p.blockNumber) })),
    };
  } catch {
    return null;
  }
}

function storeHistory(c: HistoryCache) {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        scannedTo: c.scannedTo.toString(),
        points: c.points.map((p) => ({ ...p, blockNumber: p.blockNumber.toString() })),
      }),
    );
  } catch {
    // Private mode or blocked storage: keep the in-memory copy only.
  }
}

/**
 * Every MarkUpdated event since the market was deployed (capped at MAX_CHUNKS back), oldest first.
 * Unichain's RPC limits eth_getLogs to 1,000 blocks, so the range is split into chunks. After the
 * first load, only blocks not yet scanned are fetched.
 */
export async function readMarkHistory(): Promise<MarkPoint[]> {
  const c = clients.unichain;
  historyCache ??= loadStoredHistory();
  const head = await c.getBlockNumber();
  const floor = head > MAX_CHUNKS * LOG_CHUNK ? head - MAX_CHUNKS * LOG_CHUNK : 0n;
  let start = historyCache ? historyCache.scannedTo + 1n : MARKET_DEPLOY_BLOCK;
  if (start < floor) start = floor;
  if (start < MARKET_DEPLOY_BLOCK) start = MARKET_DEPLOY_BLOCK;

  const ranges: [bigint, bigint][] = [];
  for (let from = start; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n;
    ranges.push([from, to > head ? head : to]);
  }

  const logs = [];
  for (let i = 0; i < ranges.length; i += LOG_CONCURRENCY) {
    const batch = await Promise.all(
      ranges
        .slice(i, i + LOG_CONCURRENCY)
        .map(([fromBlock, toBlock]) =>
          c.getLogs({ address: addresses.unichain.market as Address, event: markUpdated, fromBlock, toBlock }),
        ),
    );
    logs.push(...batch.flat());
  }

  const fresh: MarkPoint[] = logs.map((l) => ({
    markBps: Number(l.args.markBps!),
    observedAt: Number(l.args.observedAt!),
    receivedAt: Number(l.args.receivedAt!),
    latency: Number(l.args.receivedAt!) - Number(l.args.observedAt!),
    originChainId: Number(l.args.originChainId!),
    txHash: l.transactionHash!,
    blockNumber: l.blockNumber!,
  }));
  const points = [...(historyCache?.points ?? []), ...fresh].sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
  );
  historyCache = { points, scannedTo: head };
  storeHistory(historyCache);
  return points;
}
