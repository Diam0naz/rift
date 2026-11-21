import { readFileSync } from "node:fs";

import pg from "pg";

import { toRow } from "./store-sqlite.ts";
import { orderOf, whereOf, type EventQuery, type EventRow, type Store } from "./store.ts";

/**
 * Postgres store (Neon). node-postgres with a small pool, since this is one long-running process.
 * Queries use the pooled URL (DATABASE_URL, PgBouncer in transaction mode). The schema in schema.sql is
 * applied over the direct URL (DATABASE_URL_UNPOOLED), as Neon recommends for DDL. It's idempotent, so it
 * runs on every start.
 */
export class PostgresStore implements Store {
  readonly kind = "postgres";
  private pool: pg.Pool;
  private directUrl: string;

  constructor(pooledUrl: string, directUrl: string) {
    pooledUrl = strictSsl(pooledUrl);
    directUrl = strictSsl(directUrl);
    this.pool = new pg.Pool({ connectionString: pooledUrl, max: 5, idleTimeoutMillis: 30_000 });
    // A dropped idle connection (e.g. the compute scaling to zero) must not crash the process.
    this.pool.on("error", (e) => console.error(`postgres pool: ${e.message}`));
    this.directUrl = directUrl;
  }

  async init() {
    const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    const direct = new pg.Client({ connectionString: this.directUrl });
    direct.on("error", (e) => console.error(`postgres (schema): ${e.message}`));
    await direct.connect();
    try {
      await direct.query(schema);
    } finally {
      await direct.end();
    }
  }

  async cursor(chainId: number) {
    const r = await this.pool.query<{ scanned_to: string }>("SELECT scanned_to FROM cursors WHERE chain_id = $1", [chainId]);
    return r.rows[0] ? BigInt(r.rows[0].scanned_to) : undefined;
  }

  async commit(chainId: number, rows: EventRow[], scannedTo: bigint) {
    const c = await this.pool.connect();
    // A checked-out client isn't covered by the pool's error handler: without this, a connection reset
    // (e.g. Neon scaling the compute down) while committing is an unhandled 'error' that kills the process.
    let broken: Error | undefined;
    const onError = (e: Error) => {
      broken = e;
      console.error(`postgres client: ${e.message}`);
    };
    c.on("error", onError);
    try {
      await c.query("BEGIN");
      if (rows.length) {
        // One round trip per chunk: insert column arrays with unnest.
        await c.query(
          `INSERT INTO events (chain_id, block, log_index, tx_hash, contract, event, args, accounts, ts)
           SELECT * FROM unnest($1::int[], $2::bigint[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::bigint[])
           ON CONFLICT (chain_id, block, log_index) DO NOTHING`,
          [
            rows.map((r) => r.chainId),
            rows.map((r) => r.block.toString()),
            rows.map((r) => r.logIndex),
            rows.map((r) => r.txHash),
            rows.map((r) => r.contract),
            rows.map((r) => r.event),
            rows.map((r) => r.args),
            rows.map((r) => r.accounts),
            rows.map((r) => r.ts),
          ],
        );
      }
      await c.query(
        "INSERT INTO cursors (chain_id, scanned_to) VALUES ($1, $2) ON CONFLICT (chain_id) DO UPDATE SET scanned_to = EXCLUDED.scanned_to",
        [chainId, scannedTo.toString()],
      );
      await c.query("COMMIT");
    } catch (e) {
      broken ??= e instanceof Error ? e : new Error(String(e));
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.off("error", onError);
      c.release(broken); // a failed connection is destroyed rather than returned to the pool
    }
  }

  async counts() {
    const r = await this.pool.query<{ chain_id: number; n: string }>("SELECT chain_id, COUNT(*) AS n FROM events GROUP BY chain_id");
    return new Map(r.rows.map((x) => [x.chain_id, Number(x.n)]));
  }

  async query(q: EventQuery) {
    const { clause, params } = whereOf(q, (i) => `$${i}`);
    const args = params.map((v) => (typeof v === "bigint" ? v.toString() : v));
    const [total, rows] = await Promise.all([
      this.pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM events ${clause}`, args),
      this.pool.query(
        `SELECT chain_id, block, log_index, tx_hash, contract, event, args, accounts, ts FROM events ${clause} ${orderOf(q)}
         LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, q.limit, q.offset],
      ),
    ]);
    return { total: Number(total.rows[0].n), rows: rows.rows.map(toRow) };
  }

  async close() {
    await this.pool.end();
  }
}

/**
 * Neon URLs carry sslmode=require, which pg 8 already treats as verify-full (certificate and host checked)
 * and warns that v9 will weaken. Say verify-full explicitly so the check stays strict across versions.
 */
function strictSsl(url: string): string {
  const u = new URL(url);
  if (["prefer", "require", "verify-ca"].includes(u.searchParams.get("sslmode") ?? "")) u.searchParams.set("sslmode", "verify-full");
  return u.toString();
}
