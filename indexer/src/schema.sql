-- Rift indexer schema (Postgres). Idempotent: applied on every start over the direct connection.
-- Change it by adding statements that are safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS events (
  chain_id  integer NOT NULL,
  block     bigint  NOT NULL,
  log_index integer NOT NULL,
  tx_hash   text    NOT NULL,
  contract  text    NOT NULL,
  event     text    NOT NULL,
  args      text    NOT NULL,           -- JSON, bigints as {"$b":"…"}
  accounts  text    NOT NULL DEFAULT '', -- ",0xabc…,0xdef…," for exact address filters
  ts        bigint  NOT NULL,           -- block timestamp, seconds
  PRIMARY KEY (chain_id, block, log_index)
);

CREATE INDEX IF NOT EXISTS events_contract ON events (contract, event);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);

CREATE TABLE IF NOT EXISTS cursors (
  chain_id   integer PRIMARY KEY,
  scanned_to bigint  NOT NULL
);
