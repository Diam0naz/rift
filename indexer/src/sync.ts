import { createPublicClient, decodeEventLog, http, type Address, type Log, type PublicClient } from "viem";

import type { EventRow, Store } from "./store.ts";
import type { Chain } from "./sources.ts";

export type ChainStatus = {
  key: string;
  id: number;
  name: string;
  head: bigint | null;
  scannedTo: bigint | null;
  backfilling: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
};

const POLL_MS = Number(process.env.POLL_MS ?? 3000);
const SAVE_EVERY_MS = 5000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// JSON can't hold bigints; the frontend revives {"$b":"…"} back into bigint.
const encode = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { $b: x.toString() } : x));

/** Every address-valued argument, lowercased, as ",a,b," for exact LIKE matches. */
function accountsOf(args: unknown): string {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string" && ADDRESS.test(v)) out.add(v.toLowerCase());
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(args);
  return out.size ? `,${[...out].join(",")},` : "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Follows one chain: backfills from the earliest watched contract's deploy block in RPC-sized chunks
 * (a few in flight, committed in order), then polls the head. Errors back off and retry; the cursor
 * only moves after a chunk is stored, so restarts resume where they stopped.
 */
export class ChainSyncer {
  readonly status: ChainStatus;
  private client: PublicClient;
  private byAddress: Map<string, Chain["contracts"][number]>;
  private blockTimes = new Map<bigint, number>();
  private stopped = false;
  /** Last block scanned. Loaded from the store once, then kept here: the store is remote with Postgres. */
  private cursor: bigint | null | undefined = undefined;
  private savedAt = 0;
  private chain: Chain;
  private store: Store;
  private log: (msg: string) => void;

  constructor(chain: Chain, store: Store, log: (msg: string) => void) {
    this.chain = chain;
    this.store = store;
    this.log = log;
    this.client = createPublicClient({ transport: http(chain.rpc, { retryCount: 6, retryDelay: 800, timeout: 30_000 }) });
    this.byAddress = new Map(chain.contracts.map((c) => [c.address.toLowerCase(), c]));
    this.status = {
      key: chain.key,
      id: chain.id,
      name: chain.name,
      head: null,
      scannedTo: null,
      backfilling: true,
      lastSyncAt: null,
      lastError: null,
    };
  }

  stop() {
    this.stopped = true;
  }

  async run() {
    let backoff = POLL_MS;
    while (!this.stopped) {
      try {
        const caughtUp = await this.step();
        this.status.lastError = null;
        backoff = POLL_MS;
        if (caughtUp) await sleep(POLL_MS);
      } catch (e) {
        const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
        this.status.lastError = msg;
        this.log(`${this.chain.key}: ${msg} (retrying in ${Math.round(backoff / 1000)}s)`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Indexes up to `concurrency` chunks. Returns true when caught up with the (confirmed) head. */
  private async step(): Promise<boolean> {
    const { chunk, confirmations, concurrency, contracts } = this.chain;
    const latest = await this.client.getBlockNumber();
    const head = latest > confirmations ? latest - confirmations : 0n;
    this.status.head = latest;
    if (this.cursor === undefined) {
      this.cursor = (await this.store.cursor(this.chain.id)) ?? null;
      this.status.scannedTo = this.cursor;
    }
    const start = (this.cursor ?? minBlock(contracts) - 1n) + 1n;
    if (start > head) {
      this.status.backfilling = false;
      this.status.lastSyncAt = Date.now();
      return true;
    }

    const ranges: [bigint, bigint][] = [];
    for (let from = start; from <= head && ranges.length < concurrency; from += chunk) {
      const to = from + chunk - 1n;
      ranges.push([from, to > head ? head : to]);
    }
    const results = await Promise.all(
      ranges.map(([fromBlock, toBlock]) =>
        this.client.getLogs({ address: contracts.map((c) => c.address as Address), fromBlock, toBlock }),
      ),
    );
    const rows = await this.decode(results.flat());
    const scannedTo = ranges[ranges.length - 1][1];
    // Chunks with events are always stored before the cursor moves past them. Empty chunks during a
    // backfill only save the cursor every few seconds (one round trip instead of one per step); after a
    // crash they're simply re-scanned, and re-inserted events are ignored.
    if (rows.length || scannedTo >= head || Date.now() - this.savedAt > SAVE_EVERY_MS) {
      await this.store.commit(this.chain.id, rows, scannedTo);
      this.savedAt = Date.now();
    }
    this.cursor = scannedTo;
    this.status.scannedTo = scannedTo;
    this.status.lastSyncAt = Date.now();
    this.status.backfilling = head - scannedTo > chunk;
    if (rows.length) this.log(`${this.chain.key}: +${rows.length} events to block ${scannedTo}`);
    return scannedTo >= head;
  }

  private async decode(logs: Log[]): Promise<EventRow[]> {
    const rows: Omit<EventRow, "ts">[] = [];
    for (const l of logs) {
      const c = this.byAddress.get(l.address.toLowerCase());
      if (!c) continue;
      try {
        const d = decodeEventLog({ abi: c.abi, data: l.data, topics: l.topics });
        rows.push({
          chainId: this.chain.id,
          block: l.blockNumber!,
          logIndex: l.logIndex!,
          txHash: l.transactionHash!,
          contract: c.name,
          event: String(d.eventName),
          args: encode(d.args ?? {}),
          accounts: accountsOf(d.args),
        });
      } catch {
        // Not in this contract's ABI (e.g. an inherited payer event): skip.
      }
    }
    // Block timestamps: some RPCs include them on logs; otherwise fetch each block once.
    for (const l of logs as (Log & { blockTimestamp?: bigint | string | null })[]) {
      if (l.blockTimestamp) this.blockTimes.set(l.blockNumber!, Number(l.blockTimestamp));
    }
    const missing = [...new Set(rows.map((r) => r.block))].filter((b) => !this.blockTimes.has(b));
    for (let i = 0; i < missing.length; i += 5) {
      const blocks = await Promise.all(missing.slice(i, i + 5).map((n) => this.client.getBlock({ blockNumber: n })));
      for (const b of blocks) this.blockTimes.set(b.number!, Number(b.timestamp));
    }
    const out = rows.map((r) => ({ ...r, ts: this.blockTimes.get(r.block) ?? 0 }));
    if (this.blockTimes.size > 5000) this.blockTimes.clear();
    return out;
  }
}

const minBlock = (contracts: Chain["contracts"]) => contracts.reduce((m, c) => (c.fromBlock < m ? c.fromBlock : m), contracts[0].fromBlock);
