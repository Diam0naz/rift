import { resolve } from "node:path";

import { serve } from "./api.ts";
import { enabledChains } from "./sources.ts";
import { openStore } from "./store.ts";
import { ChainSyncer } from "./sync.ts";

const port = Number(process.env.PORT ?? 42069);
const sqlitePath = process.env.DB_PATH ?? resolve(import.meta.dirname, "../data/rift.db");

// Postgres (Neon) when DATABASE_URL is set (`pnpm start` loads it from .env.local), SQLite otherwise.
const store = await openStore(process.env, sqlitePath);
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const syncers = enabledChains().map((c) => new ChainSyncer(c, store, log));

const where = store.kind === "postgres" ? `Postgres (${new URL(process.env.DATABASE_URL!).hostname})` : sqlitePath;
log(`indexing ${syncers.map((s) => s.status.name).join(", ")} into ${where}`);
const server = serve(store, syncers, port, Date.now());
for (const s of syncers) void s.run();

const shutdown = () => {
  for (const s of syncers) s.stop();
  server.close(() => void store.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
