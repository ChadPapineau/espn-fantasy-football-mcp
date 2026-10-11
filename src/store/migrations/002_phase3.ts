// 002_phase3.ts — migration 002 (plan 10 §3.3, the Phase 3 records; plan 03 §7 forward-only `up(db)`):
// the retrospective's parameter proposal sets that `eff tune` reads (C9), the v2 projection's
// attribution fields beside each stored projection (P(active), the reported mean and the tuning
// trace — C9), one row per waiver processing run E5 priced (the league's own surplus feed — C5), and
// the news claims E10 logged, scored once their game is final (the calibration table — C8). Every new
// table is NEVER PRUNED (plan 06 §1.3's list gains them): they are the audit trail and the corpora the
// fits read. STRICT, instants as given plus an `*_ms` epoch column where the store orders by time. A
// shipped migration never changes: tests/store/migrations.test.ts pins its table list to
// MIGRATION_002_TABLES (src/store/types.ts). New here.
import type { DatabaseSync } from "node:sqlite";

/** The columns migration 002 adds to `projection`. */
export const MIGRATION_002_PROJECTION_COLUMNS = [
  "p_active",
  "reported_mean",
  "trace_json",
] as const;

/** The DDL, one statement per entry. */
export const MIGRATION_002_SQL: readonly string[] = Object.freeze([
  // NEVER PRUNED (plan 10 C9): every proposal set the retrospective made — what `eff tune` shows and
  // a human may apply. Idempotent on (league_id, hash): a re-run of the same week adds no row.
  `CREATE TABLE parameter_proposal (
  league_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  set_json TEXT NOT NULL,
  PRIMARY KEY (league_id, hash)
) STRICT`,
  `CREATE INDEX parameter_proposal__newest ON parameter_proposal (league_id, season, created_ms)`,

  // The v2 projection's attribution fields (plan 10 C9; src/domain/reclog/attribution.ts): the
  // P(active) it used, the point estimate the tool reported, and the tuning trace (shares, rates,
  // matchup, weather). `expectation_json` stays the expected line CONDITIONAL ON PLAYING.
  `ALTER TABLE projection ADD COLUMN p_active REAL`,
  `ALTER TABLE projection ADD COLUMN reported_mean REAL`,
  `ALTER TABLE projection ADD COLUMN trace_json TEXT`,

  // NEVER PRUNED (plan 10 C5; research 05 §1.6 eval 3): one row per waiver processing run E5 priced —
  // the last priority-mode call before the run wins — the league's own surplus feed the fitted
  // premium re-solves from.
  `CREATE TABLE waiver_run (
  league_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  run_at TEXT NOT NULL,
  run_ms INTEGER NOT NULL,
  w REAL NOT NULL,
  surplus_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, run_ms)
) STRICT`,

  // NEVER PRUNED (plan 10 C8; plan 07 E10): the news claims E10 weighed, logged value-free (no text —
  // source, type, signal, the prior), scored once their game is final; the calibration table reads
  // the scored rows. Idempotent on claim_key (one claim per player-week, source, type and signal).
  `CREATE TABLE scored_claim (
  claim_key TEXT PRIMARY KEY,
  league_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  logged_at TEXT NOT NULL,
  logged_ms INTEGER NOT NULL,
  claim_json TEXT NOT NULL,
  scored_at TEXT,
  outcome_json TEXT
) STRICT`,
  `CREATE INDEX scored_claim__week ON scored_claim (league_id, season, week, scored_at)`,
]);

/** Applies migration 002 (the runner wraps it in BEGIN IMMEDIATE and records schema_version). */
export function up(db: DatabaseSync): void {
  for (const sql of MIGRATION_002_SQL) db.exec(sql);
}
