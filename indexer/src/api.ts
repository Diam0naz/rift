import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Store } from "./store.ts";
import type { ChainSyncer } from "./sync.ts";

const MAX_LIMIT = 2000;

/**
 * Read-only JSON API, CORS-open (it serves public chain data):
 *   GET /status                 per-chain head, indexed block, lag, event count
 *   GET /events?…               decoded events, filterable and paginated
 *     chain=1301|84532|5318007  contract=market,reactive,…  event=Tripped,…  account=0x…
 *     fromBlock=N (with chain)  order=asc|desc (default desc)  limit (≤2000, default 100)  offset
 * Event args keep bigints as {"$b":"…"}.
 */
export function serve(store: Store, syncers: ChainSyncer[], port: number, startedAt: number) {
  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      // Bad input is the caller's fault; anything else (e.g. the database is unreachable) is ours.
      send(res, e instanceof BadRequest ? 400 : 503, { error: msg });
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "OPTIONS") return send(res, 204, null);
    if (req.method !== "GET") return send(res, 405, { error: "GET only" });
    const url = new URL(req.url ?? "/", "http://indexer");

    if (url.pathname === "/" || url.pathname === "/status") {
      const counts = await store.counts();
      const chains = syncers.map(({ status: s }) => ({
        ...s,
        head: s.head?.toString() ?? null,
        scannedTo: s.scannedTo?.toString() ?? null,
        lag: s.head !== null && s.scannedTo !== null ? Number(s.head - s.scannedTo) : null,
        events: counts.get(s.id) ?? 0,
      }));
      return send(res, 200, { service: "rift-indexer", store: store.kind, startedAt, now: Date.now(), chains }, 2);
    }

    if (url.pathname === "/events") {
      const p = url.searchParams;
      const list = (k: string) => p.get(k)?.split(",").map((s) => s.trim()).filter(Boolean);
      const int = (k: string, d: number) => (p.has(k) ? Math.max(0, Number.parseInt(p.get(k)!, 10) || 0) : d);
      const chain = p.get("chain");
      const account = p.get("account");
      if (account && !/^0x[0-9a-fA-F]{40}$/.test(account)) throw new BadRequest("account must be a 0x address");
      if (p.has("fromBlock") && !/^\d+$/.test(p.get("fromBlock")!)) throw new BadRequest("fromBlock must be a block number");
      if (chain && !/^\d+$/.test(chain)) throw new BadRequest("chain must be a chain id");
      // Read the cursor before querying: everything up to it is already committed, so a client that resumes
      // from scannedTo + 1 can't skip events committed while this query runs.
      const scannedTo = chain ? (syncers.find((s) => s.status.id === Number(chain))?.status.scannedTo?.toString() ?? null) : null;
      const { rows, total } = await store.query({
        chainId: chain ? Number(chain) : undefined,
        contracts: list("contract"),
        events: list("event"),
        account: account ?? undefined,
        fromBlock: p.has("fromBlock") ? BigInt(p.get("fromBlock")!) : undefined,
        order: p.get("order") === "asc" ? "asc" : "desc",
        limit: Math.min(int("limit", 100) || 100, MAX_LIMIT),
        offset: int("offset", 0),
      });
      return send(res, 200, {
        total,
        scannedTo,
        events: rows.map((r) => ({
          chainId: r.chainId,
          block: r.block.toString(),
          logIndex: r.logIndex,
          txHash: r.txHash,
          contract: r.contract,
          event: r.event,
          args: JSON.parse(r.args),
          ts: r.ts,
        })),
      });
    }

    send(res, 404, { error: "not found", routes: ["/status", "/events"] });
  }

  server.listen(port, () => console.log(`rift-indexer API on http://localhost:${port}`));
  return server;
}

class BadRequest extends Error {}

function send(res: ServerResponse, code: number, body: unknown, indent?: number) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "cache-control": "no-store",
  });
  res.end(body === null ? undefined : JSON.stringify(body, null, indent));
}
