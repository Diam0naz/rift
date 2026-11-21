/**
 * Where indexed events live. Postgres (Neon) when DATABASE_URL is set, SQLite on local disk otherwise.
 * One table of decoded events for every watched contract on every chain, plus a per-chain cursor.
 * Args are JSON with bigints encoded as {"$b":"123"} (the frontend revives them the same way).
 */
export type EventRow = {
  chainId: number;
  block: bigint;
  logIndex: number;
  txHash: string;
  contract: string;
  event: string;
  args: string;
  /** Every address-valued arg, lowercased, as ",a,b," so ",addr," matches exactly. */
  accounts: string;
  ts: number;
};

export type EventQuery = {
  chainId?: number;
  contracts?: string[];
  events?: string[];
  account?: string;
  fromBlock?: bigint;
  order: "asc" | "desc";
  limit: number;
  offset: number;
};

export interface Store {
  readonly kind: "postgres" | "sqlite";
  /** Creates the schema if it isn't there yet (idempotent). */
  init(): Promise<void>;
  cursor(chainId: number): Promise<bigint | undefined>;
  /** Stores a chunk's events and advances the cursor in one transaction, so a crash never skips blocks. */
  commit(chainId: number, rows: EventRow[], scannedTo: bigint): Promise<void>;
  counts(): Promise<Map<number, number>>;
  query(q: EventQuery): Promise<{ rows: EventRow[]; total: number }>;
  close(): Promise<void>;
}

export async function openStore(env: NodeJS.ProcessEnv, sqlitePath: string): Promise<Store> {
  const store = env.DATABASE_URL
    ? new (await import("./store-postgres.ts")).PostgresStore(env.DATABASE_URL, env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL)
    : new (await import("./store-sqlite.ts")).SqliteStore(sqlitePath);
  await store.init();
  return store;
}

/** WHERE clause shared by both stores; `p(i)` renders the i-th placeholder ($1 for Postgres, ? for SQLite). */
export function whereOf(q: EventQuery, p: (i: number) => string): { clause: string; params: (string | number | bigint)[] } {
  const where: string[] = [];
  const params: (string | number | bigint)[] = [];
  const add = (v: string | number | bigint) => {
    params.push(v);
    return p(params.length);
  };
  if (q.chainId !== undefined) where.push(`chain_id = ${add(q.chainId)}`);
  if (q.contracts?.length) where.push(`contract IN (${q.contracts.map(add).join(",")})`);
  if (q.events?.length) where.push(`event IN (${q.events.map(add).join(",")})`);
  if (q.account) where.push(`accounts LIKE ${add(`%,${q.account.toLowerCase()},%`)}`);
  if (q.fromBlock !== undefined) where.push(`block >= ${add(q.fromBlock)}`);
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export const orderOf = (q: EventQuery) => {
  const dir = q.order === "asc" ? "ASC" : "DESC";
  return `ORDER BY ts ${dir}, chain_id ${dir}, block ${dir}, log_index ${dir}`;
};
