# Rift indexer

Follows every Rift contract on three chains and serves the decoded events over HTTP, so the app's history,
activity, trips and totals load in one request instead of thousands of rate-limited `eth_getLogs` calls.

| Chain | Contracts | Public RPC log range |
| --- | --- | --- |
| Unichain Sepolia (1301) | RiftMarket, the Unichain pool | 1,000 blocks |
| Base Sepolia (84532) | the Base pool, the watched vault | 200 blocks |
| Reactive Lasna (5318007) | RiftReactive | 30,000 blocks |

It backfills from each contract's deploy block, then polls the head (a couple of blocks behind, so shallow
reorgs can't leave a dropped event behind). Events and a per-chain cursor are committed together in one
transaction, so a restart resumes where it stopped. No build step: Node 22.18+ runs the TypeScript directly.

**Storage:** Postgres on Neon when `DATABASE_URL` is set (the deployed setup), otherwise SQLite on local
disk (Node's built-in, for local runs and the E2E test). With Neon the process itself is stateless, so it
can run on any host without a persistent disk.

## Run

```bash
cd indexer
pnpm install
pnpm start            # API on http://localhost:42069; Neon if .env.local has DATABASE_URL
pnpm start:sqlite     # same, but always SQLite in indexer/data/rift.db
```

### Neon

The directory is linked to the Neon project `rift` (branch `production`) by `neon init`; `neon.ts`
declares its services. `npx neon@latest env pull` writes `DATABASE_URL` (pooled) and
`DATABASE_URL_UNPOOLED` (direct) to `.env.local` (gitignored), which `pnpm start` loads.

- Driver: node-postgres (`pg`) with a small pool, since this is one long-running process.
- Queries go over the pooled URL; the schema (`src/schema.sql`, idempotent) is applied at startup over the
  direct URL, as Neon recommends for DDL. Each indexed chunk is one `INSERT … SELECT unnest(…)` plus the
  cursor update, in one transaction.
- On a host, set `DATABASE_URL` and `DATABASE_URL_UNPOOLED` as environment variables instead of the file.

Then point the app at it and rebuild:

```bash
cd ../frontend
NEXT_PUBLIC_INDEXER_URL=http://localhost:42069 pnpm build && pnpm start
```

First run: Unichain and Lasna catch up in under a minute. Base takes a few minutes on the public RPC
(its 200-block limit means ~2,500 requests for the history since deployment); the app's History screen
shows each chain as "catching up" until it's done. A keyed RPC makes this much faster.

Without `NEXT_PUBLIC_INDEXER_URL`, or if the indexer is unreachable, the app falls back to scanning
Unichain from the browser (market events only, the last ~1.7 days) and says so on the History screen.

## Configuration

| Variable | Default |
| --- | --- |
| `PORT` | `42069` |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | unset: SQLite. Set: Postgres (pooled / direct) |
| `DB_PATH` | `indexer/data/rift.db` (SQLite only) |
| `UNICHAIN_SEPOLIA_RPC`, `BASE_SEPOLIA_RPC`, `LASNA_RPC` | the public endpoints |
| `UNICHAIN_CHUNK`, `BASE_CHUNK`, `LASNA_CHUNK` | `1000`, `200`, `30000` (raise with a keyed RPC) |
| `UNICHAIN_FROM_BLOCK`, `BASE_FROM_BLOCK`, `LASNA_FROM_BLOCK` | the deploy blocks |
| `UNICHAIN_CONFIRMATIONS`, `BASE_CONFIRMATIONS`, `LASNA_CONFIRMATIONS` | `2`, `2`, `0` |
| `INDEX_CHAINS` | all; e.g. `unichain` (the E2E run indexes only its fork) |
| `POLL_MS` | `3000` |

After a redeploy, update the addresses and deploy blocks in `src/sources.ts` and start from an empty
database (SQLite: delete the file; Neon: a fresh branch, or truncate `events` and `cursors`).

## API

CORS-open, read-only JSON. Bigints in event args are encoded as `{"$b":"123"}`.

`GET /status`: which store it's using, and per chain the head, the indexed block, lag, event count,
whether it's still backfilling, and the last error if the RPC is failing.

`GET /events`: decoded events, newest first.

| Param | Example |
| --- | --- |
| `chain` | `1301`, `84532`, `5318007` |
| `contract` | `market`, `reactive`, `vault`, `basePool`, `unichainPool` (comma-separated) |
| `event` | `ProtectionBought,Claimed` |
| `account` | `0x…`: any address-valued argument (buyer, trader, user, liquidator, …) |
| `fromBlock` | with `chain`, for incremental reads |
| `order` | `desc` (default) or `asc` |
| `limit`, `offset` | `limit` ≤ 2000, default 100 |

```bash
curl 'localhost:42069/events?contract=market&event=Tripped'
curl 'localhost:42069/events?account=0xYourWallet&limit=20'
```

## Deploying

### Render (Blueprint in the repo)

1. render.com → **New → Blueprint** → pick this repo. It reads `render.yaml` and creates `rift-indexer`.
2. Fill in `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (the values in `indexer/.env.local`, from Neon).
   Optionally add keyed `BASE_SEPOLIA_RPC` / `UNICHAIN_SEPOLIA_RPC`.
3. When it's live, open `https://<service>.onrender.com/status`: three chains, `"store": "postgres"`.
4. In Vercel, set `NEXT_PUBLIC_INDEXER_URL=https://<service>.onrender.com` and redeploy the frontend
   (it's a build-time variable).

It resumes from the cursor in Neon, so nothing is re-indexed. The Blueprint uses the free plan for now:
it sleeps after 15 minutes without requests and stops following the chains until a visit wakes it (about a
minute, then it catches up; meanwhile the app falls back to reading Unichain from the browser). Change
`plan: free` to `plan: starter` in `render.yaml` to keep it running continuously. Run one
indexer per database: stop a local one once Render is live (two would only duplicate RPC traffic; writes
are idempotent).

### Elsewhere

One long-running Node process (it polls the chains every few seconds), so not a serverless function. With
Neon holding the data it needs no disk: any always-on host works (Render, Railway, Fly.io, a small VM).
Set `DATABASE_URL` and `DATABASE_URL_UNPOOLED` in the host's environment and run `pnpm install && pnpm start`
(it uses the environment when there is no `.env.local`). Then set `NEXT_PUBLIC_INDEXER_URL` to its
public HTTPS URL when building the frontend.
