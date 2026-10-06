// 001_initial.ts — migration 001 (plan 01 §9.2 every store table, T-07; plan 03 §7 forward-only
// `up(db)`): exactly MIGRATION_001_TABLES, STRICT. The ds_* tables are NOT here — they live in the
// per-source dataset files (plan 01 §5.1). Instants are stored as given (ISO-8601) plus an `*_ms`
// epoch column wherever the store orders or compares by time. A shipped migration never changes:
// tests/store/migrations.test.ts pins its table list to MIGRATION_001_TABLES.
import type { DatabaseSync } from "node:sqlite";

/** The DDL, one statement per entry. */
export const MIGRATION_001_SQL: readonly string[] = Object.freeze([
  `CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT`,

  // Prunable (plan 06 §1.3): the parsed ESPN response cache (plan 01 §5.3). raw_body only in
  // fixture-recording mode.
  `CREATE TABLE espn_cache (
  key TEXT PRIMARY KEY,
  parsed_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  fetched_ms INTEGER NOT NULL,
  server_time TEXT,
  etag TEXT,
  http_status INTEGER NOT NULL,
  raw_body TEXT
) STRICT`,
  `CREATE INDEX espn_cache__fetched_ms ON espn_cache (fetched_ms)`,

  // NEVER PRUNED (plan 06 §1.3): recommendation_log.settings_hash references these rows.
  `CREATE TABLE league_settings (
  league_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  settings_hash TEXT NOT NULL,
  scoring_json TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  fetched_ms INTEGER NOT NULL,
  PRIMARY KEY (league_id, season, settings_hash)
) STRICT`,
  `CREATE INDEX league_settings__settings_hash ON league_settings (settings_hash, fetched_ms)`,
  `CREATE INDEX league_settings__league_season ON league_settings (league_id, season, fetched_ms)`,

  `CREATE TABLE crosswalk (
  espn_id INTEGER PRIMARY KEY,
  gsis_id TEXT NOT NULL,
  method TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_seen_ms INTEGER NOT NULL
) STRICT`,
  `CREATE INDEX crosswalk__gsis_id ON crosswalk (gsis_id)`,

  `CREATE TABLE drift_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  since TEXT,
  last_probe_at TEXT,
  manifest_hash TEXT,
  manifest_version INTEGER,
  host TEXT NOT NULL,
  host_moved_at TEXT,
  diff_json TEXT NOT NULL,
  additive_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT`,

  `CREATE TABLE probe_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status TEXT NOT NULL,
  upstream_status INTEGER,
  error TEXT
) STRICT`,
  `CREATE INDEX probe_log__kind_ok_at ON probe_log (kind, ok, at_ms)`,

  // Dataset bookkeeping (plan 01 §5.5): which version of each per-source file is current.
  `CREATE TABLE refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  file TEXT,
  file_version TEXT,
  release_updated_at TEXT,
  seasons_json TEXT NOT NULL,
  rows INTEGER,
  columns_hash TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  checked_at TEXT NOT NULL
) STRICT`,
  `CREATE INDEX refresh_log__source_ok_id ON refresh_log (source, ok, id)`,

  `CREATE TABLE job_lock (
  job TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  acquired_ms INTEGER NOT NULL
) STRICT`,

  // The cross-process limiter (plan 01 §6; changelog V7): one row per ESPN request. ts = epoch ms.
  `CREATE TABLE espn_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  keyless INTEGER NOT NULL,
  origin TEXT NOT NULL,
  outcome TEXT NOT NULL
) STRICT`,
  `CREATE INDEX espn_requests__ts ON espn_requests (ts)`,
  `CREATE INDEX espn_requests__origin_keyless_ts ON espn_requests (origin, keyless, ts)`,

  // The credential's state and observations — never the secret (plan 02 §2.1; changelog V5).
  `CREATE TABLE credential_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  league_id TEXT NOT NULL,
  state TEXT NOT NULL,
  store TEXT NOT NULL,
  stored_at TEXT,
  last_accepted_at TEXT,
  last_rejected_at TEXT,
  rejected_since TEXT,
  next_probe_at TEXT,
  rejected_view TEXT,
  board_probe_discriminates INTEGER,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
) STRICT`,

  // Prunable after 30 days (plan 06 §1.3).
  `CREATE TABLE roster_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  week INTEGER NOT NULL,
  taken_at TEXT NOT NULL,
  taken_ms INTEGER NOT NULL,
  roster_json TEXT NOT NULL
) STRICT`,
  `CREATE INDEX roster_snapshot__team_taken ON roster_snapshot (team_id, taken_ms)`,
  `CREATE INDEX roster_snapshot__taken ON roster_snapshot (taken_ms)`,

  // Prunable after 30 days (plan 06 §1.3).
  `CREATE TABLE pool_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week INTEGER NOT NULL,
  taken_at TEXT NOT NULL,
  taken_ms INTEGER NOT NULL,
  players_json TEXT NOT NULL
) STRICT`,
  `CREATE INDEX pool_snapshot__taken ON pool_snapshot (taken_ms)`,

  // NEVER PRUNED (plan 06 §1.3): the ESPN projection snapshots — the backtest corpus.
  `CREATE TABLE espn_projection (
  player_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER,
  week_key INTEGER NOT NULL,
  split TEXT NOT NULL,
  applied_total REAL NOT NULL,
  stats_raw_json TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  snapshot_ms INTEGER NOT NULL,
  PRIMARY KEY (player_id, season, week_key, split, snapshot_ms)
) STRICT`,
  `CREATE INDEX espn_projection__season_week ON espn_projection (season, week_key, snapshot_ms)`,
  `CREATE INDEX espn_projection__snapshot ON espn_projection (snapshot_ms)`,

  // NEVER PRUNED (plan 06 §1.3; T-07): the pre-week ESPN win probability / playoff % per matchup.
  `CREATE TABLE scoreboard_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week INTEGER NOT NULL,
  taken_at TEXT NOT NULL,
  taken_ms INTEGER NOT NULL,
  matchups_json TEXT NOT NULL,
  playoff_pct_json TEXT NOT NULL
) STRICT`,
  `CREATE INDEX scoreboard_snapshot__week_taken ON scoreboard_snapshot (week, taken_ms)`,

  // Append-only history from install day (plan 07 A6).
  `CREATE TABLE transactions_seen (
  transaction_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  seen_at TEXT NOT NULL,
  seen_ms INTEGER NOT NULL,
  txn_json TEXT NOT NULL
) STRICT`,
  `CREATE INDEX transactions_seen__ts ON transactions_seen (ts_ms)`,

  // NEVER PRUNED (plan 08 §5, §9): append-only per (player, season, week, model, made_at).
  `CREATE TABLE projection (
  player_id INTEGER NOT NULL,
  gsis_id TEXT,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  model_version TEXT NOT NULL,
  made_at TEXT NOT NULL,
  made_ms INTEGER NOT NULL,
  inputs_as_of TEXT NOT NULL,
  expectation_json TEXT NOT NULL,
  samples BLOB NOT NULL,
  PRIMARY KEY (player_id, season, week, model_version, made_ms)
) STRICT`,

  // Prunable (bounded LRU by last write — plan 06 §1.3; plan 08 §9).
  `CREATE TABLE points_cache (
  line_hash TEXT NOT NULL,
  settings_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  used_ms INTEGER NOT NULL,
  PRIMARY KEY (line_hash, settings_hash)
) STRICT`,
  `CREATE INDEX points_cache__used ON points_cache (used_ms)`,

  // NEVER PRUNED (plan 01 §9.2; plan 06 §1.3). Free text in record_json is model-authored and
  // untrusted on read (plan 07 C15). Dedup scope: the whole RECORD_DEDUP_SCOPE (sib QA-1-061).
  `CREATE TABLE recommendation_log (
  log_id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  kind TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_ms INTEGER NOT NULL,
  settings_hash TEXT NOT NULL,
  client_ref TEXT,
  record_json TEXT NOT NULL
) STRICT`,
  `CREATE UNIQUE INDEX recommendation_log__dedup_scope ON recommendation_log (league_id, season, week, kind, client_ref) WHERE client_ref IS NOT NULL`,
  `CREATE INDEX recommendation_log__league_week ON recommendation_log (league_id, season, week)`,
  `CREATE INDEX recommendation_log__league_recorded ON recommendation_log (league_id, recorded_ms)`,

  // NEVER PRUNED (sib critic C-02b): the scored outcome beside each immutable log row.
  `CREATE TABLE recommendation_outcome (
  log_id TEXT PRIMARY KEY REFERENCES recommendation_log (log_id),
  followed INTEGER,
  realised REAL,
  regret REAL,
  decisive INTEGER,
  scored_at TEXT NOT NULL,
  week_final INTEGER NOT NULL
) STRICT`,

  // Health checks (plan 07 G1 checks[]; plan 06 §1.4 T-08): one row per (id, raise).
  `CREATE TABLE checks (
  id TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  raised_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  settings_hash TEXT,
  acknowledged INTEGER NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  PRIMARY KEY (id, raised_ms)
) STRICT`,
  `CREATE INDEX checks__open ON checks (acknowledged, raised_ms)`,

  // NEVER PRUNED. PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11): the write
  // journal (plan 02 §4.4) is created empty; nothing in this build writes it.
  `CREATE TABLE write_journal (
  journal_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT`,
  `CREATE INDEX write_journal__status_created ON write_journal (status, created_ms)`,

  // NEVER PRUNED (plan 02 §2.4 "one map per store"): sha256 of the upper-cased brace-GUID → n.
  `CREATE TABLE guid_pseudonym (
  guid_sha256 TEXT PRIMARY KEY,
  n INTEGER NOT NULL UNIQUE
) STRICT`,
]);

/** Applies migration 001 (the runner wraps it in BEGIN IMMEDIATE and records schema_version). */
export function up(db: DatabaseSync): void {
  for (const sql of MIGRATION_001_SQL) db.exec(sql);
}
