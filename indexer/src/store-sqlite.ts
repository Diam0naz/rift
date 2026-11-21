import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { orderOf, whereOf, type EventQuery, type EventRow, type Store } from "./store.ts";

/** Local-disk store (Node's built-in SQLite). The default when DATABASE_URL isn't set; the E2E run uses it. */
export class SqliteStore implements Store {
  readonly kind = "sqlite";
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }

  async init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        chain_id  INTEGER NOT NULL,
        block     INTEGER NOT NULL,
        log_index INTEGER NOT NULL,
        tx_hash   TEXT    NOT NULL,
        contract  TEXT    NOT NULL,
        event     TEXT    NOT NULL,
        args      TEXT    NOT NULL,
        accounts  TEXT    NOT NULL DEFAULT '',
        ts        INTEGER NOT NULL,
        PRIMARY KEY (chain_id, block, log_index)
      );
      CREATE INDEX IF NOT EXISTS events_contract ON events (contract, event);
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      CREATE TABLE IF NOT EXISTS cursors (
        chain_id   INTEGER PRIMARY KEY,
        scanned_to INTEGER NOT NULL
      );
    `);
  }

  async cursor(chainId: number) {
    const row = this.db.prepare("SELECT scanned_to FROM cursors WHERE chain_id = ?").get(chainId) as { scanned_to: number } | undefined;
    return row ? BigInt(row.scanned_to) : undefined;
  }

  async commit(chainId: number, rows: EventRow[], scannedTo: bigint) {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO events (chain_id, block, log_index, tx_hash, contract, event, args, accounts, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const cursor = this.db.prepare(
      "INSERT INTO cursors (chain_id, scanned_to) VALUES (?, ?) ON CONFLICT (chain_id) DO UPDATE SET scanned_to = excluded.scanned_to",
    );
    this.db.exec("BEGIN");
    try {
      for (const r of rows) insert.run(r.chainId, r.block, r.logIndex, r.txHash, r.contract, r.event, r.args, r.accounts, r.ts);
      cursor.run(chainId, scannedTo);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async counts() {
    const rows = this.db.prepare("SELECT chain_id, COUNT(*) AS n FROM events GROUP BY chain_id").all() as { chain_id: number; n: number }[];
    return new Map(rows.map((r) => [r.chain_id, r.n]));
  }

  async query(q: EventQuery) {
    const { clause, params } = whereOf(q, () => "?");
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM events ${clause}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT chain_id, block, log_index, tx_hash, contract, event, args, accounts, ts FROM events ${clause} ${orderOf(q)} LIMIT ? OFFSET ?`)
      .all(...params, q.limit, q.offset) as Record<string, string | number>[];
    return { total, rows: rows.map(toRow) };
  }

  async close() {
    this.db.close();
  }
}

export const toRow = (r: Record<string, string | number>): EventRow => ({
  chainId: Number(r.chain_id),
  block: BigInt(r.block),
  logIndex: Number(r.log_index),
  txHash: String(r.tx_hash),
  contract: String(r.contract),
  event: String(r.event),
  args: String(r.args),
  accounts: String(r.accounts),
  ts: Number(r.ts),
});
