// league.ts — the league-side store tables (plan 01 §9.2): league_settings (never pruned; plan 08 §9)
// with the health checks (plan 07 G1 checks[]; plan 06 §1.4 T-08; acknowledgements only by a human
// in a terminal), roster/pool snapshots (pruned after 30 days, plan 06 §1.3), scoreboard_snapshot
// (never pruned, T-07) and the append-only transactions_seen history. Every write is REQUIRED; JSON
// bound for a snapshot passes the GUID pseudonymiser (plan 02 §2.4). Ported from sibling @cf3b015,
// adapted (single-league posture: no league key on snapshots; ESPN shapes).
import { ESPN_LEAGUE_ID_RE, TEAM_ID_MAX, TEAM_ID_MIN } from "../../config/schema.js";
import {
  CHECK_IDS,
  type CheckAcknowledger,
  type CheckRow,
  type LeagueSettingsRepository,
  type LeagueSettingsRow,
  type PoolSnapshotRepository,
  type RosterSnapshotRepository,
  type ScoreboardSnapshotRepository,
  type Transaction,
  type TransactionsSeenRepository,
} from "../../domain/league/types.js";
import { SETTINGS_HASH_RE } from "../../domain/scoring/types.js";
import {
  boundedArray,
  intIn,
  isoMs,
  isoMsOrNull,
  keyString,
  matching,
  num,
  oneOf,
  parseJson,
  SEASON_MAX,
  SEASON_MIN,
  toJson,
  WEEK_MAX,
  WEEK_MIN,
  type RepoDeps,
} from "./common.js";

/** Largest `transactionsSeen.list` page. */
export const TRANSACTIONS_LIST_MAX = 1000;
/** Most transactions one `appendNew` takes. */
export const TRANSACTIONS_APPEND_MAX = 100_000;
/** Longest transaction id (ESPN ids are GUID-like strings). */
export const TRANSACTION_ID_MAX = 64;
/** A check's detail key and string value (fixed vocabulary — never platform text). */
export const CHECK_DETAIL_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const CHECK_DETAIL_VALUE_RE = /^[A-Za-z0-9_.:/+-]{0,64}$/;
/** Most detail entries one check carries. */
export const CHECK_DETAIL_MAX = 32;

const ACKNOWLEDGERS: readonly CheckAcknowledger[] = ["doctor", "setup"];
const CHECK_STATUSES = ["ok", "warn", "fail"] as const;

interface SettingsRow {
  league_id: string;
  season: number;
  settings_hash: string;
  scoring_json: string;
  slots_json: string;
  rules_json: string;
  fetched_at: string;
}

const toSettings = (r: SettingsRow): LeagueSettingsRow => ({
  league_id: r.league_id,
  season: num(r.season),
  settings_hash: r.settings_hash,
  scoring: parseJson(r.scoring_json),
  slots: parseJson(r.slots_json),
  rules: parseJson(r.rules_json),
  fetched_at: r.fetched_at,
});

function checkDetail(detail: unknown): string {
  if (typeof detail !== "object" || detail === null || Array.isArray(detail))
    throw new RangeError("store: check detail must be an object");
  const entries = Object.entries(detail);
  if (entries.length > CHECK_DETAIL_MAX) throw new RangeError("store: check detail too large");
  for (const [k, v] of entries) {
    if (!CHECK_DETAIL_KEY_RE.test(k)) throw new RangeError("store: invalid check detail key");
    if (v === null || typeof v === "boolean") continue;
    if (typeof v === "number" && Number.isFinite(v)) continue;
    if (typeof v === "string" && CHECK_DETAIL_VALUE_RE.test(v)) continue;
    throw new RangeError("store: check detail values are fixed-vocabulary codes and numbers");
  }
  return JSON.stringify(detail);
}

interface CheckDbRow {
  id: string;
  raised_at: string;
  status: string;
  detail_json: string;
  settings_hash: string | null;
  acknowledged: number;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

const toCheck = (r: CheckDbRow): CheckRow => ({
  id: r.id as CheckRow["id"],
  status: r.status as CheckRow["status"],
  detail: parseJson(r.detail_json),
  raised_at: r.raised_at,
  settings_hash: r.settings_hash,
  acknowledged: num(r.acknowledged) === 1,
  acknowledged_at: r.acknowledged_at,
  acknowledged_by: r.acknowledged_by as CheckAcknowledger | null,
});

export function leagueSettingsRepository({ db, writes }: RepoDeps): LeagueSettingsRepository {
  return {
    put(row) {
      matching(row.league_id, ESPN_LEAGUE_ID_RE, "league_id");
      intIn(row.season, SEASON_MIN, SEASON_MAX, "season");
      matching(row.settings_hash, SETTINGS_HASH_RE, "settings_hash");
      const ms = isoMs(row.fetched_at, "fetched_at");
      const scoring = toJson(row.scoring, "scoring");
      const slots = toJson(row.slots, "slots");
      const rules = toJson(row.rules, "rules");
      writes.required("league_settings", () => {
        // The hash identifies the content: a repeat put only advances fetched_at (never back).
        db.prepare(
          `INSERT INTO league_settings (league_id, season, settings_hash, scoring_json, slots_json, rules_json, fetched_at, fetched_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (league_id, season, settings_hash) DO UPDATE SET fetched_at = excluded.fetched_at,
             fetched_ms = excluded.fetched_ms WHERE excluded.fetched_ms > league_settings.fetched_ms`,
        ).run(
          row.league_id,
          row.season,
          row.settings_hash,
          scoring,
          slots,
          rules,
          row.fetched_at,
          ms,
        );
      });
    },
    byHash(settingsHash) {
      if (typeof settingsHash !== "string" || !SETTINGS_HASH_RE.test(settingsHash)) return null;
      const r = db
        .prepare(
          "SELECT * FROM league_settings WHERE settings_hash = ? ORDER BY fetched_ms DESC, rowid DESC LIMIT 1",
        )
        .get(settingsHash) as SettingsRow | undefined;
      return r === undefined ? null : toSettings(r);
    },
    latest(leagueId, season) {
      const r = db
        .prepare(
          "SELECT * FROM league_settings WHERE league_id = ? AND season = ? ORDER BY fetched_ms DESC, rowid DESC LIMIT 1",
        )
        .get(leagueId, season) as SettingsRow | undefined;
      return r === undefined ? null : toSettings(r);
    },
    raiseCheck(check) {
      oneOf(check.id, CHECK_IDS, "check id");
      oneOf(check.status, CHECK_STATUSES, "check status");
      const detail = checkDetail(check.detail);
      const raisedMs = isoMs(check.raised_at, "raised_at");
      if (check.settings_hash !== null)
        matching(check.settings_hash, SETTINGS_HASH_RE, "settings_hash");
      if (typeof check.acknowledged !== "boolean")
        throw new RangeError("store: acknowledged must be a boolean");
      isoMsOrNull(check.acknowledged_at, "acknowledged_at");
      if (check.acknowledged_by !== null)
        oneOf(check.acknowledged_by, ACKNOWLEDGERS, "acknowledger");
      writes.required("checks", () => {
        // A repeat raise of the same (id, raised_at) refreshes status/detail; its ack state stays.
        db.prepare(
          `INSERT INTO checks (id, raised_at, raised_ms, status, detail_json, settings_hash, acknowledged, acknowledged_at, acknowledged_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id, raised_ms) DO UPDATE SET status = excluded.status,
             detail_json = excluded.detail_json, settings_hash = excluded.settings_hash`,
        ).run(
          check.id,
          check.raised_at,
          raisedMs,
          check.status,
          detail,
          check.settings_hash,
          check.acknowledged ? 1 : 0,
          check.acknowledged_at,
          check.acknowledged_by,
        );
      });
    },
    openChecks() {
      return (
        db
          .prepare("SELECT * FROM checks WHERE acknowledged = 0 ORDER BY raised_ms, id")
          .all() as unknown as CheckDbRow[]
      ).map(toCheck);
    },
    acknowledgeChecks(id, upTo, by, at) {
      oneOf(id, CHECK_IDS, "check id");
      const upToMs = isoMs(upTo, "upTo");
      oneOf(by, ACKNOWLEDGERS, "acknowledger");
      isoMs(at, "at");
      return writes.required("checks", () =>
        Number(
          db
            .prepare(
              `UPDATE checks SET acknowledged = 1, acknowledged_at = ?, acknowledged_by = ?
               WHERE id = ? AND acknowledged = 0 AND raised_ms <= ?`,
            )
            .run(at, by, id, upToMs).changes,
        ),
      );
    },
  };
}

export function rosterSnapshotRepository({
  db,
  writes,
  pseudonyms,
}: RepoDeps): RosterSnapshotRepository {
  return {
    put(s) {
      intIn(s.team_id, TEAM_ID_MIN, TEAM_ID_MAX, "team_id");
      intIn(s.week, WEEK_MIN, WEEK_MAX, "week");
      const ms = isoMs(s.taken_at, "taken_at");
      const json = toJson(s.roster, "roster");
      writes.requiredTx("roster_snapshot", () => {
        db.prepare(
          "INSERT INTO roster_snapshot (team_id, week, taken_at, taken_ms, roster_json) VALUES (?, ?, ?, ?, ?)",
        ).run(s.team_id, s.week, s.taken_at, ms, pseudonyms.apply(json));
      });
    },
    latestTwo(teamId) {
      const rows = db
        .prepare(
          "SELECT team_id, week, taken_at, roster_json FROM roster_snapshot WHERE team_id = ? ORDER BY taken_ms DESC, id DESC LIMIT 2",
        )
        .all(teamId) as unknown as {
        team_id: number;
        week: number;
        taken_at: string;
        roster_json: string;
      }[];
      return rows.map((r) => ({
        team_id: num(r.team_id),
        week: num(r.week),
        taken_at: r.taken_at,
        roster: parseJson(r.roster_json),
      }));
    },
  };
}

export function poolSnapshotRepository({
  db,
  writes,
  pseudonyms,
}: RepoDeps): PoolSnapshotRepository {
  return {
    put(s) {
      intIn(s.week, WEEK_MIN, WEEK_MAX, "week");
      const ms = isoMs(s.taken_at, "taken_at");
      if (!Array.isArray(s.players)) throw new RangeError("store: players must be an array");
      const json = toJson(s.players, "players");
      writes.requiredTx("pool_snapshot", () => {
        db.prepare(
          "INSERT INTO pool_snapshot (week, taken_at, taken_ms, players_json) VALUES (?, ?, ?, ?)",
        ).run(s.week, s.taken_at, ms, pseudonyms.apply(json));
      });
    },
    latestTwo() {
      const rows = db
        .prepare(
          "SELECT week, taken_at, players_json FROM pool_snapshot ORDER BY taken_ms DESC, id DESC LIMIT 2",
        )
        .all() as unknown as { week: number; taken_at: string; players_json: string }[];
      return rows.map((r) => ({
        week: num(r.week),
        taken_at: r.taken_at,
        players: parseJson(r.players_json),
      }));
    },
  };
}

export function scoreboardSnapshotRepository({
  db,
  writes,
  pseudonyms,
}: RepoDeps): ScoreboardSnapshotRepository {
  return {
    put(s) {
      intIn(s.week, WEEK_MIN, WEEK_MAX, "week");
      const ms = isoMs(s.taken_at, "taken_at");
      if (!Array.isArray(s.matchups)) throw new RangeError("store: matchups must be an array");
      const pct: unknown = s.playoff_pct_espn;
      if (typeof pct !== "object" || pct === null || Array.isArray(pct))
        throw new RangeError("store: playoff_pct_espn must be an object");
      for (const v of Object.values(pct))
        if (v !== null && (typeof v !== "number" || !Number.isFinite(v)))
          throw new RangeError("store: playoff_pct_espn values must be finite numbers or null");
      const matchups = toJson(s.matchups, "matchups");
      const playoff = toJson(pct, "playoff_pct_espn");
      writes.requiredTx("scoreboard_snapshot", () => {
        db.prepare(
          "INSERT INTO scoreboard_snapshot (week, taken_at, taken_ms, matchups_json, playoff_pct_json) VALUES (?, ?, ?, ?, ?)",
        ).run(s.week, s.taken_at, ms, pseudonyms.apply(matchups), pseudonyms.apply(playoff));
      });
    },
    forWeek(week) {
      const rows = db
        .prepare(
          "SELECT week, taken_at, matchups_json, playoff_pct_json FROM scoreboard_snapshot WHERE week = ? ORDER BY taken_ms, id",
        )
        .all(week) as unknown as {
        week: number;
        taken_at: string;
        matchups_json: string;
        playoff_pct_json: string;
      }[];
      return rows.map((r) => ({
        week: num(r.week),
        taken_at: r.taken_at,
        matchups: parseJson(r.matchups_json),
        playoff_pct_espn: parseJson(r.playoff_pct_json),
      }));
    },
  };
}

/** The instant a transaction is ordered by: processed, else proposed, else first seen. */
function txnInstant(t: Transaction, seenAt: string): string {
  return t.process_date ?? t.proposed_date ?? seenAt;
}

export function transactionsSeenRepository({
  db,
  writes,
  pseudonyms,
}: RepoDeps): TransactionsSeenRepository {
  return {
    appendNew(txns, seenAt) {
      const seenMs = isoMs(seenAt, "seen_at");
      const rows = boundedArray(txns, TRANSACTIONS_APPEND_MAX, "transactions").map((t) => {
        keyString(t.transaction_id, "transaction_id", TRANSACTION_ID_MAX);
        isoMsOrNull(t.process_date, "process_date");
        isoMsOrNull(t.proposed_date, "proposed_date");
        const ts = txnInstant(t, seenAt);
        return {
          id: t.transaction_id,
          ts,
          ms: isoMs(ts, "transaction instant"),
          json: toJson(t, "transaction"),
        };
      });
      if (rows.length === 0) return 0;
      return writes.requiredTx("transactions_seen", () => {
        const ins = db.prepare(
          `INSERT OR IGNORE INTO transactions_seen (transaction_id, ts, ts_ms, seen_at, seen_ms, txn_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        let n = 0;
        for (const r of rows)
          n += Number(ins.run(r.id, r.ts, r.ms, seenAt, seenMs, pseudonyms.apply(r.json)).changes);
        return n;
      });
    },
    list(since, limit) {
      const lim = intIn(limit, 1, TRANSACTIONS_LIST_MAX, "limit");
      const sinceMs = since === null ? null : isoMs(since, "since");
      const rows = db
        .prepare(
          `SELECT txn_json FROM transactions_seen WHERE (:since IS NULL OR ts_ms >= :since)
           ORDER BY ts_ms DESC, transaction_id DESC LIMIT :lim`,
        )
        .all({ since: sinceMs, lim }) as unknown as { txn_json: string }[];
      return rows.map((r) => parseJson<Transaction>(r.txn_json));
    },
    oldestSeen() {
      const r = db
        .prepare("SELECT ts FROM transactions_seen ORDER BY ts_ms, transaction_id LIMIT 1")
        .get() as { ts: string } | undefined;
      return r?.ts ?? null;
    },
  };
}
