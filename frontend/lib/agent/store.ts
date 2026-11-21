import "server-only";

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import pg from "pg";

import type { AutopilotRules, LogEntry } from "./rules";

/**
 * Autopilot rules and the background action log, keyed by vault owner (lowercased address).
 * Postgres on Neon when DATABASE_URL is set (the same "rift" project as the indexer, its own tables);
 * AUTOPILOT_DB=file forces a local JSON file instead, which the E2E run uses so fork data never reaches Neon.
 */

export type Stored = { owner: string; vault: string; rules: AutopilotRules; goalLastRun: number; updatedAt: number };

interface Store {
  list(): Promise<Stored[]>;
  get(owner: string): Promise<Stored | null>;
  put(s: Stored): Promise<void>;
  markGoalRun(owner: string, at: number): Promise<void>;
  log(owner: string, e: LogEntry): Promise<void>;
  recent(owner: string, limit: number): Promise<LogEntry[]>;
}

// ---------------------------------------------------------------- Postgres (Neon)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS autopilot_rules (
  owner         text PRIMARY KEY,
  vault         text NOT NULL,
  rules         jsonb NOT NULL,
  goal_last_run bigint NOT NULL DEFAULT 0,
  updated_at    bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS autopilot_log (
  id      bigserial PRIMARY KEY,
  owner   text NOT NULL,
  at      bigint NOT NULL,
  rule    text NOT NULL,
  summary text NOT NULL,
  status  text NOT NULL,
  tx      text,
  reason  text
);
CREATE INDEX IF NOT EXISTS autopilot_log_owner ON autopilot_log (owner, at DESC);
`;

/** Neon URLs say sslmode=require, which pg 8 treats as verify-full; say so explicitly (v9 weakens it). */
const strictSsl = (url: string) => {
  const u = new URL(url);
  if (["prefer", "require", "verify-ca"].includes(u.searchParams.get("sslmode") ?? "")) u.searchParams.set("sslmode", "verify-full");
  return u.toString();
};

class PgStore implements Store {
  private pool: pg.Pool;
  private ready: Promise<void>;

  constructor(pooled: string, direct: string) {
    this.pool = new pg.Pool({ connectionString: strictSsl(pooled), max: 3, idleTimeoutMillis: 30_000 });
    this.pool.on("error", (e) => console.error(`autopilot db: ${e.message}`));
    // Schema over the direct connection (DDL), once per process; idempotent.
    this.ready = (async () => {
      const c = new pg.Client({ connectionString: strictSsl(direct) });
      await c.connect();
      try {
        await c.query(SCHEMA);
      } finally {
        await c.end();
      }
    })();
    this.ready.catch((e) => console.error(`autopilot db schema: ${e.message}`));
  }

  private async q<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
    await this.ready;
    return (await this.pool.query<T>(sql, params)).rows;
  }

  private static row = (r: { owner: string; vault: string; rules: AutopilotRules; goal_last_run: string; updated_at: string }): Stored => ({
    owner: r.owner,
    vault: r.vault,
    rules: r.rules,
    goalLastRun: Number(r.goal_last_run),
    updatedAt: Number(r.updated_at),
  });

  async list() {
    return (await this.q<never>("SELECT owner, vault, rules, goal_last_run, updated_at FROM autopilot_rules")).map(PgStore.row);
  }
  async get(owner: string) {
    const rows = await this.q<never>("SELECT owner, vault, rules, goal_last_run, updated_at FROM autopilot_rules WHERE owner = $1", [owner]);
    return rows[0] ? PgStore.row(rows[0]) : null;
  }
  async put(s: Stored) {
    await this.q(
      `INSERT INTO autopilot_rules (owner, vault, rules, goal_last_run, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner) DO UPDATE SET vault = EXCLUDED.vault, rules = EXCLUDED.rules, updated_at = EXCLUDED.updated_at`,
      [s.owner, s.vault, JSON.stringify(s.rules), s.goalLastRun, s.updatedAt],
    );
  }
  async markGoalRun(owner: string, at: number) {
    await this.q("UPDATE autopilot_rules SET goal_last_run = $2 WHERE owner = $1", [owner, at]);
  }
  async log(owner: string, e: LogEntry) {
    await this.q("INSERT INTO autopilot_log (owner, at, rule, summary, status, tx, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
      owner,
      e.at,
      e.rule,
      e.summary,
      e.status,
      e.tx ?? null,
      e.reason ?? null,
    ]);
  }
  async recent(owner: string, limit: number) {
    const rows = await this.q<{ at: string; rule: string; summary: string; status: LogEntry["status"]; tx: string | null; reason: string | null }>(
      "SELECT at, rule, summary, status, tx, reason FROM autopilot_log WHERE owner = $1 ORDER BY at DESC, id DESC LIMIT $2",
      [owner, limit],
    );
    return rows.map((r) => ({ at: Number(r.at), rule: r.rule, summary: r.summary, status: r.status, tx: r.tx ?? undefined, reason: r.reason ?? undefined }));
  }
}

// ---------------------------------------------------------------- local file (dev / E2E)

type FileData = { rules: Record<string, Stored>; log: Record<string, LogEntry[]> };

class FileStore implements Store {
  constructor(private path: string) {}
  private read(): FileData {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as FileData;
    } catch {
      return { rules: {}, log: {} };
    }
  }
  private write(d: FileData) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(d));
    renameSync(`${this.path}.tmp`, this.path); // atomic replace
  }
  async list() {
    return Object.values(this.read().rules);
  }
  async get(owner: string) {
    return this.read().rules[owner] ?? null;
  }
  async put(s: Stored) {
    const d = this.read();
    d.rules[s.owner] = { ...s, goalLastRun: d.rules[s.owner]?.goalLastRun ?? s.goalLastRun };
    this.write(d);
  }
  async markGoalRun(owner: string, at: number) {
    const d = this.read();
    if (d.rules[owner]) d.rules[owner].goalLastRun = at;
    this.write(d);
  }
  async log(owner: string, e: LogEntry) {
    const d = this.read();
    d.log[owner] = [e, ...(d.log[owner] ?? [])].slice(0, 200);
    this.write(d);
  }
  async recent(owner: string, limit: number) {
    return (this.read().log[owner] ?? []).slice(0, limit);
  }
}

// One instance per server process (route handlers and the background runner share it).
const g = globalThis as { __riftAutopilotStore?: Store };
export function autopilotStore(): Store {
  if (!g.__riftAutopilotStore) {
    const url = process.env.DATABASE_URL;
    g.__riftAutopilotStore =
      url && process.env.AUTOPILOT_DB !== "file"
        ? new PgStore(url, process.env.DATABASE_URL_UNPOOLED || url)
        : new FileStore(process.env.AUTOPILOT_FILE || join(process.cwd(), ".data", "autopilot.json"));
  }
  return g.__riftAutopilotStore;
}

export const storeKind = () => (process.env.DATABASE_URL && process.env.AUTOPILOT_DB !== "file" ? "postgres" : "file");
