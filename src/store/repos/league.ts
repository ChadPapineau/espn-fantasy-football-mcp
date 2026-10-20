// league.ts — the league-side store tables (plan 01 §9.2): league_settings (never pruned; plan 08 §9)
// with the health checks (plan 07 G1 checks[]; plan 06 §1.4 T-08; closed by a human in a terminal,
// an ir_invalid check also by the nightly roster snapshot that reads the IR valid again),
// roster/pool snapshots (pruned after 30 days, plan 06 §1.3), scoreboard_snapshot (never pruned,
// T-07) and the append-only transactions_seen history. Every write is REQUIRED; JSON
// bound for a snapshot passes the GUID pseudonymiser (plan 02 §2.4). A settings snapshot that
// changes the league-season's newest settings raises `settings_changed` in the same transaction
// (plan 08 §9; plan 03 §5 #22; T-08 — Stage C, league-settings-changed-never-raised: nothing compared
// a new snapshot with the last one, so the check could never open). The change is judged on the
// league's own settings — never on what this build derives from them (its stat registry, bound table
// and pinned rounding, all inside settings_hash), so an upgrade never reads as the commissioner's
// edit — and a fetch already recorded takes no write lock (put belongs on the settings read path,
// plan 08 §9, where every cache hit re-records the fetch it was served from: a busy store must not
// stall a read that changes nothing). Ported from sibling @cf3b015, adapted (single-league posture:
// no league key on snapshots; ESPN shapes).
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { ESPN_LEAGUE_ID_RE, TEAM_ID_MAX, TEAM_ID_MIN } from "../../config/schema.js";
import {
  CHECK_IDS,
  SNAPSHOT_CLOSES,
  TRANSACTIONS_RANGE_MAX,
  type CheckAcknowledger,
  type CheckRow,
  type LeagueRules,
  type LeagueSettingsRepository,
  type LeagueSettingsRow,
  type PoolSnapshotRepository,
  type RosterSnapshotRepository,
  type ScoreboardSnapshotRepository,
  type Transaction,
  type TransactionsSeenRepository,
  type WaiverRules,
} from "../../domain/league/types.js";
import {
  SETTINGS_HASH_RE,
  type ScoringRule,
  type ScoringSettings,
} from "../../domain/scoring/types.js";
import {
  boundedArray,
  canonicalJson,
  intIn,
  isoMs,
  isoMsOrNull,
  keyString,
  matching,
  msToIso,
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

const ACKNOWLEDGERS: readonly CheckAcknowledger[] = ["doctor", "setup", "snapshot"];
const CHECK_STATUSES = ["ok", "warn", "fail"] as const;

interface SettingsRow {
  league_id: string;
  season: number;
  settings_hash: string;
  scoring_json: string;
  slots_json: string;
  rules_json: string;
  fetched_at: string;
  fetched_ms: number;
}

/** The newest settings snapshot of a league-season (the `latest` order: newest fetch, then newest row). */
const NEWEST_SETTINGS_SQL =
  "SELECT * FROM league_settings WHERE league_id = ? AND season = ? ORDER BY fetched_ms DESC, rowid DESC LIMIT 1";
/** The fetch instant one settings hash of a league-season is recorded at (a primary-key seek). */
export const RECORDED_FETCH_SQL =
  "SELECT fetched_ms FROM league_settings WHERE league_id = ? AND season = ? AND settings_hash = ?";

/**
 * The fields of a snapshot that are league STATUS or this build's own vocabulary, not settings: they
 * move with no edit at all, so they never count as a settings change. The waiver clock is ESPN's
 * `status.waiverNextExecutionDate`/`waiverLastExecutionDate` (it moves every week); `unverified` and
 * `unverified_fields` list what this build has not verified. Typed against the domain shapes, so a
 * renamed field fails the build here.
 */
const WAIVER_STATUS_FIELDS = [
  "next_execution",
  "last_execution",
  "unverified",
] as const satisfies readonly (keyof WaiverRules)[];
const RULES_STATUS_FIELDS = ["unverified_fields"] as const satisfies readonly (keyof LeagueRules)[];
/**
 * What the scoring normaliser derives from THIS build, never from the league (src/domain/scoring/
 * settings.ts): a rule's canonical name, abbreviation, position classes and E9 disputed flag are its
 * statId looked up in the build's stat registry; `families` are built from the rules and the build's
 * bound table; `rounding` is the engine's pinned rule (ESPN_ROUNDING) and its golden flag; and
 * `settings_hash` is computed over all of them. Within one build each is a function of the league's
 * own items, so dropping them misses no edit; across builds they move with the code — an upgrade that
 * re-normalises the same league settings to another hash is not the commissioner's edit. What the
 * league states is the rest: each item's statId, points, pointsOverrides and isReverseItem, and the
 * matchup items (tie rules, home bonuses — outside the hash). A field the domain adds later counts
 * until it is listed here.
 */
const RULE_DERIVED_FIELDS = [
  "canonical",
  "abbr",
  "applies_to",
  "disputed",
] as const satisfies readonly (keyof ScoringRule)[];
const SCORING_DERIVED_FIELDS = [
  "families",
  "rounding",
  "settings_hash",
] as const satisfies readonly (keyof ScoringSettings)[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `obj` without `keys` (own data properties only — a parsed `__proto__` key stays plain data). */
function omit(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

/**
 * A stored JSON column as a comparison key: canonical, with its status fields and (scoring) what this
 * build derives dropped; the scoring items compare as a set (the normaliser sorts them by statId).
 */
function settingsKey(column: "scoring" | "slots" | "rules", text: string): string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return `text:${text}`; // never written by this repository; compared as written
  }
  if (column === "scoring" && isRecord(v))
    v = {
      ...omit(v, SCORING_DERIVED_FIELDS),
      ...(Array.isArray(v.rules)
        ? {
            rules: v.rules
              .map((r: unknown) => canonicalJson(isRecord(r) ? omit(r, RULE_DERIVED_FIELDS) : r))
              .sort(),
          }
        : {}),
    };
  if (column === "rules" && isRecord(v))
    v = {
      ...omit(v, RULES_STATUS_FIELDS),
      ...(isRecord(v.waiver) ? { waiver: omit(v.waiver, WAIVER_STATUS_FIELDS) } : {}),
    };
  return canonicalJson(v);
}

/**
 * The `settings_changed` detail when the newest snapshot of a league-season moved from `before` to
 * `after` with a different scoring (the league's items and matchup items), roster slots or league
 * rules; null when the league's settings are the same — whatever their settings_hash, which also
 * encodes this build's registry (SCORING_DERIVED_FIELDS). Fixed vocabulary only: flags, the season,
 * a hash, an instant.
 */
function settingsChange(
  before: SettingsRow,
  after: SettingsRow,
): Record<string, string | number | boolean | null> | null {
  const scoring =
    settingsKey("scoring", before.scoring_json) !== settingsKey("scoring", after.scoring_json);
  const slots = settingsKey("slots", before.slots_json) !== settingsKey("slots", after.slots_json);
  const rules = settingsKey("rules", before.rules_json) !== settingsKey("rules", after.rules_json);
  if (!scoring && !slots && !rules) return null;
  return {
    season: num(after.season),
    scoring_changed: scoring,
    slots_changed: slots,
    rules_changed: rules,
    previous_settings_hash: SETTINGS_HASH_RE.test(before.settings_hash)
      ? before.settings_hash
      : null,
    previous_fetched_at: msToIso(num(before.fetched_ms)),
  };
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

/**
 * One checks row. A repeat raise of the same (id, raised_at) refreshes status/detail; its ack state
 * stays. Callers validate first and run it inside their write.
 */
function insertCheck(
  db: DatabaseSync,
  c: {
    readonly id: CheckRow["id"];
    readonly raised_at: string;
    readonly raised_ms: number;
    readonly status: CheckRow["status"];
    readonly detail_json: string;
    readonly settings_hash: string | null;
    readonly acknowledged: boolean;
    readonly acknowledged_at: string | null;
    readonly acknowledged_by: CheckAcknowledger | null;
  },
): void {
  db.prepare(
    `INSERT INTO checks (id, raised_at, raised_ms, status, detail_json, settings_hash, acknowledged, acknowledged_at, acknowledged_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id, raised_ms) DO UPDATE SET status = excluded.status,
       detail_json = excluded.detail_json, settings_hash = excluded.settings_hash`,
  ).run(
    c.id,
    c.raised_at,
    c.raised_ms,
    c.status,
    c.detail_json,
    c.settings_hash,
    c.acknowledged ? 1 : 0,
    c.acknowledged_at,
    c.acknowledged_by,
  );
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
  const newest = (leagueId: string, season: number): SettingsRow | undefined =>
    db.prepare(NEWEST_SETTINGS_SQL).get(leagueId, season) as SettingsRow | undefined;
  // Prepared once per connection, on first use: put belongs on the settings read path (plan 08 §9 —
  // the provider persists each answer it normalises), and compiling a statement — the guard's
  // authorizer called back per column — costs more than the seek it runs. node:sqlite resets a
  // statement after each run, so it never holds a read snapshot open.
  let recordedFetch: StatementSync | undefined;
  const recordedMs = (leagueId: string, season: number, hash: string): number | null => {
    recordedFetch ??= db.prepare(RECORDED_FETCH_SQL);
    const r = recordedFetch.get(leagueId, season, hash) as { fetched_ms: number } | undefined;
    return r === undefined ? null : num(r.fetched_ms);
  };
  return {
    /**
     * Records a settings snapshot and, in the SAME transaction, raises `settings_changed` when it
     * changed the league-season's newest settings (plan 08 §9: "if the hash changed — … checks[] row
     * settings_changed", so `onboard` can explain the commissioner's edit; plan 03 §5 #22; T-08).
     * A change is a different scoring (the league's items and matchup items), roster slots or league
     * rules — a switch to FAAB or a new playoff seeding rule leaves the scoring hash alone and changes
     * the advice all the same — never a status field, nor what this build derives (its registry,
     * bound table and pinned rounding, all inside settings_hash: an upgrade that re-normalises the
     * same settings to a new hash stores the new hash's row and raises nothing — settingsKey). The
     * league-season's first snapshot is the baseline (no check); a repeat of the newest settings, or
     * a snapshot older than the newest (a late answer), raises nothing; two processes recording one
     * change raise it once (the second reads the first's row as the newest). The check (warn) carries
     * the new hash and the change's flags; a human closes it (`eff setup --seeding`, `eff doctor
     * --ack settings_changed`). A fetch already recorded — this hash's row holds this fetch or a newer
     * one — would change nothing, so it returns after one read and takes NO write lock: on the read
     * path every cache hit re-records the fetch it was served from, and a required write blocks the
     * thread up to BUSY_TIMEOUT_MS behind another process's writer.
     */
    put(row) {
      matching(row.league_id, ESPN_LEAGUE_ID_RE, "league_id");
      intIn(row.season, SEASON_MIN, SEASON_MAX, "season");
      matching(row.settings_hash, SETTINGS_HASH_RE, "settings_hash");
      const ms = isoMs(row.fetched_at, "fetched_at");
      const scoring = toJson(row.scoring, "scoring");
      const slots = toJson(row.slots, "slots");
      const rules = toJson(row.rules, "rules");
      // The upsert below never moves a row back (WHERE excluded.fetched_ms > fetched_ms), so with a
      // row of this hash at or after this fetch it writes nothing, the newest row stays the newest and
      // no check opens: the same answer the transaction gives, without waiting for its lock. A row's
      // fetched_ms only grows (and league_settings is never pruned), so a writer that commits after
      // this read cannot make the skip wrong; under WAL the read does not wait for that writer.
      const known = recordedMs(row.league_id, row.season, row.settings_hash);
      if (known !== null && known >= ms) return;
      writes.requiredTx("league_settings", () => {
        const before = newest(row.league_id, row.season);
        // One row per settings_hash (the log's referent): a repeat put of a hash records the newer
        // fetch's slots and rules (the hash covers the scoring rules only) — never an older fetch's.
        db.prepare(
          `INSERT INTO league_settings (league_id, season, settings_hash, scoring_json, slots_json, rules_json, fetched_at, fetched_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (league_id, season, settings_hash) DO UPDATE SET scoring_json = excluded.scoring_json,
             slots_json = excluded.slots_json, rules_json = excluded.rules_json,
             fetched_at = excluded.fetched_at, fetched_ms = excluded.fetched_ms
           WHERE excluded.fetched_ms > league_settings.fetched_ms`,
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
        const after = newest(row.league_id, row.season);
        // the only write here is this snapshot: when the newest settings differ, this one made them so
        const change =
          before === undefined || after === undefined ? null : settingsChange(before, after);
        if (change === null || after === undefined) return;
        insertCheck(db, {
          id: "settings_changed",
          raised_at: after.fetched_at,
          raised_ms: num(after.fetched_ms),
          status: "warn",
          detail_json: checkDetail(change),
          settings_hash: after.settings_hash,
          acknowledged: false,
          acknowledged_at: null,
          acknowledged_by: null,
        });
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
        insertCheck(db, {
          id: check.id,
          raised_at: check.raised_at,
          raised_ms: raisedMs,
          status: check.status,
          detail_json: detail,
          settings_hash: check.settings_hash,
          acknowledged: check.acknowledged,
          acknowledged_at: check.acknowledged_at,
          acknowledged_by: check.acknowledged_by,
        });
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
      // the nightly snapshot closes only the condition it re-reads (an event check needs the human)
      if (by === "snapshot" && !SNAPSHOT_CLOSES.includes(id))
        throw new RangeError("store: the roster snapshot closes only ir_invalid checks");
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
    listRange(from, until, limit) {
      const lim = intIn(limit, 1, TRANSACTIONS_RANGE_MAX, "limit");
      const fromMs = isoMs(from, "from");
      const untilMs = isoMs(until, "until");
      if (untilMs <= fromMs) return [];
      const rows = db
        .prepare(
          `SELECT txn_json FROM transactions_seen WHERE ts_ms >= :from AND ts_ms < :until
           ORDER BY ts_ms DESC, transaction_id DESC LIMIT :lim`,
        )
        .all({ from: fromMs, until: untilMs, lim }) as unknown as { txn_json: string }[];
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
