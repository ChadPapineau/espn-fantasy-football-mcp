// 003_league_scope.ts — migration 003: every league-specific record names its league (Stage C finding
// store-not-league-scoped; plan 03 §7 forward-only `up(db)`). The store is shared by every process
// on the Mac, and ESPN_LEAGUE_ID can change on it (the credential layer supports a switch; a job
// installed under another league id keeps running): seven tables had no league column, so after a
// switch A6/E11 merged the other league's moves under this league's team ids, E5's league-fitted
// premium was re-solved from the other league's seasons, C3 compared ESPN's projection with the
// other league's snapshot, E13 scored against the other league's forecasts, B1/C1 could serve the
// other league's team-N roster or pool, the snapshot jobs diffed against the other league's previous
// snapshot, and its open checks stayed open here. Each table gains `league_id`; the repositories of
// a store opened for a league (StoreOpenOptions.league) write it and read only its rows.
//
// Where a cross-league collision on the old primary key would silently drop one league's row — the
// same transaction id, or the same instant (two leagues' snapshots in one millisecond, a fixed test
// clock) — the table is rebuilt with `league_id` leading its key: transactions_seen, espn_projection,
// projection, checks. The snapshot tables keep their row ids and gain the column.
//
// Existing rows: attributed to the store's one league when exactly one league is named anywhere in
// it (credential_state, league_settings, recommendation_log, parameter_proposal, waiver_run,
// scored_claim) — the owner's single-league install keeps its history. With none or several, they
// keep `league_id = ''`: no league reads them (they were written under an unknown league), and they
// are never deleted here — prune ages the prunable ones out as before, and an export carries them.
// New here.
import type { DatabaseSync } from "node:sqlite";
import { ESPN_LEAGUE_ID_RE } from "../../config/schema.js";

/** The league-specific tables migration 003 scopes (src/store/types.ts LEAGUE_SCOPED_TABLES). */
export const MIGRATION_003_LEAGUE_TABLES = [
  "roster_snapshot",
  "pool_snapshot",
  "scoreboard_snapshot",
  "transactions_seen",
  "espn_projection",
  "projection",
  "checks",
] as const;

/** The tables that name a league already: the evidence of which league an existing store served. */
const LEAGUE_KEYED_TABLES = [
  "credential_state",
  "league_settings",
  "recommendation_log",
  "parameter_proposal",
  "waiver_run",
  "scored_claim",
] as const;

/** The DDL that adds the column where the primary key needs no league (row ids). */
const ADD_COLUMN_SQL: readonly string[] = [
  `ALTER TABLE roster_snapshot ADD COLUMN league_id TEXT NOT NULL DEFAULT ''`,
  `CREATE INDEX roster_snapshot__league_team_taken ON roster_snapshot (league_id, team_id, taken_ms)`,
  `ALTER TABLE pool_snapshot ADD COLUMN league_id TEXT NOT NULL DEFAULT ''`,
  `CREATE INDEX pool_snapshot__league_taken ON pool_snapshot (league_id, taken_ms)`,
  `ALTER TABLE scoreboard_snapshot ADD COLUMN league_id TEXT NOT NULL DEFAULT ''`,
  `CREATE INDEX scoreboard_snapshot__league_week_taken ON scoreboard_snapshot (league_id, week, taken_ms)`,
];

/** One rebuilt table: its new DDL, the columns copied, and its indexes. */
interface Rebuild {
  readonly table: string;
  readonly create: string;
  readonly columns: readonly string[];
  readonly indexes: readonly string[];
}

const REBUILDS: readonly Rebuild[] = [
  {
    // Append-only history from install day (plan 07 A6), per league.
    table: "transactions_seen",
    create: `CREATE TABLE transactions_seen__003 (
  league_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  seen_at TEXT NOT NULL,
  seen_ms INTEGER NOT NULL,
  txn_json TEXT NOT NULL,
  PRIMARY KEY (league_id, transaction_id)
) STRICT`,
    columns: ["transaction_id", "ts", "ts_ms", "seen_at", "seen_ms", "txn_json"],
    indexes: [`CREATE INDEX transactions_seen__league_ts ON transactions_seen (league_id, ts_ms)`],
  },
  {
    // NEVER PRUNED (plan 06 §1.3): the ESPN projection snapshots — the backtest corpus, per league
    // (applied_total is under the league's own scoring).
    table: "espn_projection",
    create: `CREATE TABLE espn_projection__003 (
  league_id TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER,
  week_key INTEGER NOT NULL,
  split TEXT NOT NULL,
  applied_total REAL NOT NULL,
  stats_raw_json TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  snapshot_ms INTEGER NOT NULL,
  PRIMARY KEY (league_id, player_id, season, week_key, split, snapshot_ms)
) STRICT`,
    columns: [
      "player_id",
      "season",
      "week",
      "week_key",
      "split",
      "applied_total",
      "stats_raw_json",
      "snapshot_at",
      "snapshot_ms",
    ],
    indexes: [
      `CREATE INDEX espn_projection__league_season_week ON espn_projection (league_id, season, week_key, snapshot_ms)`,
      `CREATE INDEX espn_projection__league_snapshot ON espn_projection (league_id, snapshot_ms)`,
    ],
  },
  {
    // NEVER PRUNED (plan 08 §5, §9): append-only per (player, season, week, model, made_at), per
    // league (reported_mean and the samples are in the league's points).
    table: "projection",
    create: `CREATE TABLE projection__003 (
  league_id TEXT NOT NULL,
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
  p_active REAL,
  reported_mean REAL,
  trace_json TEXT,
  PRIMARY KEY (league_id, player_id, season, week, model_version, made_ms)
) STRICT`,
    columns: [
      "player_id",
      "gsis_id",
      "season",
      "week",
      "model_version",
      "made_at",
      "made_ms",
      "inputs_as_of",
      "expectation_json",
      "samples",
      "p_active",
      "reported_mean",
      "trace_json",
    ],
    indexes: [],
  },
  {
    // Health checks (plan 07 G1 checks[]; plan 06 §1.4 T-08): one row per (league, id, raise).
    table: "checks",
    create: `CREATE TABLE checks__003 (
  league_id TEXT NOT NULL,
  id TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  raised_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  settings_hash TEXT,
  acknowledged INTEGER NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  PRIMARY KEY (league_id, id, raised_ms)
) STRICT`,
    columns: [
      "id",
      "raised_at",
      "raised_ms",
      "status",
      "detail_json",
      "settings_hash",
      "acknowledged",
      "acknowledged_at",
      "acknowledged_by",
    ],
    indexes: [`CREATE INDEX checks__league_open ON checks (league_id, acknowledged, raised_ms)`],
  },
];

/**
 * The one league an existing store's rows can be attributed to: the single league id the
 * league-keyed tables name (credential_state's included), or null when they name none or several.
 */
export function storeLeagueOf(db: DatabaseSync): string | null {
  const ids = new Set<string>();
  for (const t of LEAGUE_KEYED_TABLES)
    for (const r of db.prepare(`SELECT DISTINCT league_id AS l FROM ${t}`).all() as unknown as {
      l: unknown;
    }[])
      if (typeof r.l === "string" && ESPN_LEAGUE_ID_RE.test(r.l)) ids.add(r.l);
  return ids.size === 1 ? ([...ids][0] ?? null) : null;
}

/** Applies migration 003 (the runner wraps it in BEGIN IMMEDIATE and records schema_version). */
export function up(db: DatabaseSync): void {
  const league = storeLeagueOf(db) ?? "";
  for (const sql of ADD_COLUMN_SQL) db.exec(sql);
  for (const t of ["roster_snapshot", "pool_snapshot", "scoreboard_snapshot"])
    db.prepare(`UPDATE ${t} SET league_id = ? WHERE league_id = ''`).run(league);
  for (const r of REBUILDS) {
    db.exec(r.create);
    const cols = r.columns.join(", ");
    db.prepare(
      `INSERT INTO ${r.table}__003 (league_id, ${cols}) SELECT ?, ${cols} FROM ${r.table}`,
    ).run(league);
    db.exec(`DROP TABLE ${r.table}`);
    db.exec(`ALTER TABLE ${r.table}__003 RENAME TO ${r.table}`);
    for (const sql of r.indexes) db.exec(sql);
  }
}
