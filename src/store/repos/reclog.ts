// reclog.ts — recommendation_log + recommendation_outcome (plan 01 §9.2, never pruned; plan 07 E12
// record, E13 retrospective, E14 list; sib critic C-02b the scored outcome beside the immutable row;
// sib QA-1-061 the dedup scope is the whole RECORD_DEDUP_SCOPE). Required writes. Free text in a
// stored record is model-authored and untrusted on read (plan 07 C15): the store returns it raw,
// except `action_summary`, which is sanitised to BareText here; readers path-list RECLOG_TEXT_PATHS.
// The never-pruned log's reads are bounded per turn of the event loop however long it grows (plan
// 03 §1.2: the loop never blocks longer than one SQLite statement or one ≤ 20 ms CPU batch; Stage C,
// reclog-retrospective-unbounded-read): one league-week holds at most RECORDS_PER_WEEK_MAX rows and
// RECORD_WEEK_BYTES_MAX stored bytes; `weekCounts` learns which weeks hold records from the
// (league_id, season, week) index without reading a record; `forWeekPaced` reads a week in pages of
// at most WEEK_PAGE_ROWS_MAX rows and WEEK_PAGE_BYTES_MAX bytes, awaiting the caller's pace between
// pages; `recordOutcomes` writes a scored week's outcomes in one transaction.
// Ported from sibling @cf3b015, adapted (ESPN league ids; settings_hash required).
import { randomBytes } from "node:crypto";
import { ESPN_LEAGUE_ID_RE, SEEDING_MODES } from "../../config/schema.js";
import { bareUntrusted } from "../../domain/league/types.js";
import {
  CLIENT_REF_RE,
  LOG_ID_RE,
  RECOMMENDATION_KINDS,
  recordDedupScope,
  type FollowedHint,
  type RecommendationListItem,
  type RecommendationOutcome,
  type RecommendationPage,
  type RecommendationRecord,
  type RecordRecommendationInput,
  type RecordResult,
} from "../../domain/reclog/types.js";
import { SETTINGS_HASH_RE } from "../../domain/scoring/types.js";
import type { RecommendationLogStore, WeekRecordCount } from "../types.js";
import {
  bitOrNull,
  boolOrNull,
  boundedArray,
  finiteOrNull,
  intIn,
  isoMs,
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

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const FOLLOWED_HINTS: readonly FollowedHint[] = ["unknown", "user_said_yes", "user_said_no"];
/** Page bounds (plan 01 §4.2): limit 1..100, offset 0..10 000. */
export const LIST_LIMIT_MAX = 100;
export const LIST_OFFSET_MAX = 10_000;
/** The model-authored note cap (plan 07 E12: ≤ 200 chars). */
export const NOTE_MAX = 200;
/** Largest stored record. */
export const RECORD_JSON_MAX = 1024 * 1024;
/**
 * Records one league-week holds (every kind; a deduplicated re-record adds none). Normal use is 5–20
 * a week; the log is never pruned (T-07), and before this bound a week grew with every record E12
 * accepted (400 records in one week: E13 stalled the main loop 71 ms). At the bound — about 2 MB —
 * `forWeek`'s one statement plus a parse per row costs ≈ 11 ms (p95 ≈ 18 ms on the development Mac;
 * tests/store/reclog-week.perf.test.ts holds the p95 under 25 ms). The bound caps ONE week only: a
 * caller that read every week up to the scored one in one turn still stalled in proportion to the
 * season's log (17 full weeks: ≈ 240 ms), so an analytics caller reads the earlier weeks' existence
 * with `weekCounts` and a week's records with `forWeekPaced`, whose turns hold one page each.
 */
export const RECORDS_PER_WEEK_MAX = 100;
/**
 * Stored bytes (UTF-8, after pseudonymisation) one league-week holds: twice RECORD_JSON_MAX, so any
 * record the store accepts fits an empty week, and about RECORDS_PER_WEEK_MAX E12 inputs at their
 * 20 000-char cap (BOUNDS.recordInputChars). Bounds the week's read when its records are large.
 */
export const RECORD_WEEK_BYTES_MAX = 2 * RECORD_JSON_MAX;
/**
 * Records one page of `forWeekPaced` holds. With WEEK_PAGE_BYTES_MAX it bounds the work of one turn
 * of a paced week read — one statement plus a parse per row — whatever the week or the log holds.
 */
export const WEEK_PAGE_ROWS_MAX = 50;
/**
 * Stored bytes (UTF-8) one page of `forWeekPaced` holds; a record larger than this alone is a page of
 * its own (RECORD_JSON_MAX bounds it). ≈ 1.5 ms a page at the E12 input cap on the development Mac.
 */
export const WEEK_PAGE_BYTES_MAX = 256 * 1024;
/**
 * Outcomes one `recordOutcomes` call writes (one transaction): a scored week's calls, which a week's
 * bound caps at RECORDS_PER_WEEK_MAX.
 */
export const OUTCOMES_PER_BATCH_MAX = RECORDS_PER_WEEK_MAX;

/**
 * The log's statements, each held to an index that bounds it by its own week, season or ids — never
 * by the league's whole never-pruned log (tests/store/reclog-plans.test.ts pins every plan). The
 * store never runs ANALYZE, and without statistics SQLite served `ORDER BY recorded_ms` from the
 * (league_id, recorded_ms) index: one week's read walked every row the league ever logged (0.3 ms
 * at 1 700 rows, 15–17 ms at 34 000, an empty week included). A unary `+` on an ORDER BY or WHERE
 * term keeps that term from choosing an index (the lever src/store/datasets/tables.ts uses). Only
 * keys are ever sorted: rows carrying record text are read by primary key and put in the keys'
 * order in JS, because a sort carries every selected column — a full week's 2 MB of text passed
 * the sorter's memory and spilled to a temporary file (forWeek ≈ 3× slower inside E13).
 */
export const RECLOG_SQL = Object.freeze({
  /** E12's dedup probe: the (league_id, season, week, kind, client_ref) unique index. */
  dedupProbe: `SELECT log_id, recorded_at, week, kind FROM recommendation_log
    WHERE league_id = ? AND season = ? AND week = ? AND kind = ? AND client_ref = ?`,
  /** E12's week bound: rows and stored bytes, from the week's index entries and row headers. */
  weekHeld: `SELECT COUNT(*) AS n, COALESCE(SUM(octet_length(record_json)), 0) AS bytes
    FROM recommendation_log WHERE league_id = ? AND season = ? AND week = ?`,
  /** A week's keys in read order, with stored sizes (row headers only: no record text is read). */
  weekKeys: `SELECT log_id, octet_length(record_json) AS bytes FROM recommendation_log
    WHERE league_id = ? AND season = ? AND week = ? ORDER BY +recorded_ms, log_id`,
  /** Rows of one league-week by primary key: the ids are a JSON array; the caller orders them. */
  weekRowsByIds: `SELECT log_id, recorded_at, record_json FROM recommendation_log
    WHERE log_id IN (SELECT value FROM json_each(?))
      AND +league_id = ? AND +season = ? AND +week = ?`,
  /** `weekCounts`: the (league_id, season, week) index alone (covering). */
  weekCounts: `SELECT week, COUNT(*) AS n FROM recommendation_log
    WHERE league_id = ? AND season = ? GROUP BY week ORDER BY week`,
  /** `list`'s rows by primary key with `followed`: the ids are a JSON array; the caller orders them. */
  listRowsByIds: `SELECT l.log_id, l.recorded_at, l.record_json, o.followed AS followed
    FROM recommendation_log AS l LEFT JOIN recommendation_outcome AS o ON o.log_id = l.log_id
    WHERE l.log_id IN (SELECT value FROM json_each(?))`,
});

/** `rows` in the order of `ids` (each row's log_id is one of them). */
function inOrder<R extends { log_id: string }>(rows: R[], ids: readonly string[]): R[] {
  const at = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => (at.get(a.log_id) ?? 0) - (at.get(b.log_id) ?? 0));
}

/** Which of `list`'s filters a query sets (the rest are absent from its statements). */
export interface ListFilters {
  readonly season: boolean;
  readonly week: boolean;
  readonly kind: boolean;
}

/**
 * `list`'s count and page-of-ids statements for the filters set: plain equality terms only (an
 * `(? IS NULL OR col = ?)` term can never choose an index, so every list walked the league's whole
 * log, row by row). With a season — E14 always sets one — the (league_id, season, week) index bounds
 * both by that season's rows and only the page's keys are sorted. With none (the rec resources'
 * league-wide completion) the (league_id, recorded_ms) index serves the newest first and stops at
 * offset + limit (LIST_OFFSET_MAX bounds it); a week or kind without a season, which no product
 * caller asks, is filtered over the league's rows on that walk. Parameters, in order: league_id,
 * then season, week and kind where set; the page statement adds limit and offset.
 */
export function listSql(f: ListFilters): { readonly count: string; readonly ids: string } {
  const where = [
    "league_id = ?",
    ...(f.season ? ["season = ?"] : []),
    ...(f.week ? ["week = ?"] : []),
    ...(f.kind ? ["kind = ?"] : []),
  ].join(" AND ");
  const order = f.season ? "+recorded_ms DESC, log_id DESC" : "recorded_ms DESC, log_id DESC";
  return {
    count: `SELECT COUNT(*) AS n FROM recommendation_log WHERE ${where}`,
    ids: `SELECT log_id FROM recommendation_log WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
  };
}

/**
 * A record refused because its league-week is full (RECORDS_PER_WEEK_MAX rows, or the record would
 * carry the week past RECORD_WEEK_BYTES_MAX). Carries a VALIDATION `effCode` (src/mcp/errors.ts
 * reads it): the tool answers a typed refusal with reason `week_record_limit`, never INTERNAL;
 * nothing is written.
 */
export class RecordWeekFullError extends Error {
  readonly effCode = "VALIDATION" as const;
  readonly effDetails = { reason: "week_record_limit" } as const;
  constructor() {
    super("store: this league-week already holds the most recommendations one week may hold");
    this.name = "RecordWeekFullError";
  }
}

/** A `rec-` + ULID log id: 48-bit time from `ms`, 80 random bits (LOG_ID_RE). */
export function newLogId(ms: number): string {
  let t = Math.max(0, Math.min(Math.floor(ms), 2 ** 48 - 1));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = (CROCKFORD[t % 32] ?? "0") + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(rnd[i] ?? 0) & 31] ?? "0";
  return `rec-${time}${rand}`;
}

/** One record of a league-week in `forWeek`'s order, with its stored UTF-8 size. */
export interface WeekKey {
  readonly log_id: string;
  readonly bytes: number;
}

/**
 * Splits a week's keys (in read order) into the pages `forWeekPaced` reads, greedily and in order: a
 * page closes before the key that would take it past `rows` records or `bytes` stored bytes, and a key
 * larger than `bytes` alone is a page of its own. Every key lands in exactly one page; order is kept.
 */
export function planWeekPages(
  keys: readonly WeekKey[],
  rows: number = WEEK_PAGE_ROWS_MAX,
  bytes: number = WEEK_PAGE_BYTES_MAX,
): string[][] {
  const pages: string[][] = [];
  let page: string[] = [];
  let held = 0;
  for (const k of keys) {
    if (page.length > 0 && (page.length >= rows || held + k.bytes > bytes)) {
      pages.push(page);
      page = [];
      held = 0;
    }
    page.push(k.log_id);
    held += k.bytes;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/** Throws RangeError unless `o` is a storable outcome (the checks `recordOutcome` makes). */
function checkOutcome(o: RecommendationOutcome): void {
  matching(o.log_id, LOG_ID_RE, "log_id");
  isoMs(o.scored_at, "scored_at");
  finiteOrNull(o.realised, "realised");
  finiteOrNull(o.regret, "regret");
  for (const [k, v] of [
    ["followed", o.followed],
    ["decisive", o.decisive],
  ] as const)
    if (v !== null && typeof v !== "boolean")
      throw new RangeError(`store: ${k} must be a boolean or null`);
  if (typeof o.week_final !== "boolean")
    throw new RangeError("store: week_final must be a boolean");
}

/** A final outcome is immutable; a provisional one is re-written (sib critic C-02b). */
const UPSERT_OUTCOME = `INSERT INTO recommendation_outcome (log_id, followed, realised, regret, decisive, scored_at, week_final)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (log_id) DO UPDATE SET followed = excluded.followed, realised = excluded.realised,
     regret = excluded.regret, decisive = excluded.decisive, scored_at = excluded.scored_at,
     week_final = excluded.week_final
   WHERE recommendation_outcome.week_final = 0`;

/** The UPSERT_OUTCOME parameters of `o`. */
function outcomeParams(o: RecommendationOutcome): (string | number | null)[] {
  return [
    o.log_id,
    bitOrNull(o.followed),
    o.realised,
    o.regret,
    bitOrNull(o.decisive),
    o.scored_at,
    o.week_final ? 1 : 0,
  ];
}

function validate(input: RecordRecommendationInput): void {
  matching(input.league_id, ESPN_LEAGUE_ID_RE, "league_id");
  intIn(input.season, SEASON_MIN, SEASON_MAX, "season");
  intIn(input.week, WEEK_MIN, WEEK_MAX, "week");
  oneOf(input.kind, RECOMMENDATION_KINDS, "recommendation kind");
  matching(input.settings_hash, SETTINGS_HASH_RE, "settings_hash");
  if (input.client_ref !== null) matching(input.client_ref, CLIENT_REF_RE, "client_ref");
  if (input.note !== null && (typeof input.note !== "string" || input.note.length > NOTE_MAX))
    throw new RangeError(`store: note must be at most ${String(NOTE_MAX)} chars`);
  if (input.seeding_mode_used !== null && input.seeding_mode_used !== "both")
    oneOf(input.seeding_mode_used, SEEDING_MODES, "seeding_mode_used");
  oneOf(input.followed_hint, FOLLOWED_HINTS, "followed_hint");
  const rec: unknown = input.rec;
  if (
    typeof rec !== "object" ||
    rec === null ||
    typeof (rec as { action?: unknown }).action !== "string"
  )
    throw new RangeError("store: rec must carry an action");
}

interface LogRow {
  log_id: string;
  recorded_at: string;
  record_json: string;
  followed?: number | null;
}

function toRecord(r: LogRow): RecommendationRecord {
  const input = parseJson<RecordRecommendationInput>(r.record_json);
  return { ...input, log_id: r.log_id, recorded_at: r.recorded_at };
}

interface OutcomeRow {
  log_id: string;
  followed: number | null;
  realised: number | null;
  regret: number | null;
  decisive: number | null;
  scored_at: string;
  week_final: number;
}

export function recommendationLogRepository({
  db,
  writes,
  pseudonyms,
}: RepoDeps): RecommendationLogStore {
  /** A league-week's keys in read order (recorded_ms, then log_id), with their stored sizes. */
  const weekKeys = (leagueId: string, season: number, week: number): WeekKey[] =>
    (
      db.prepare(RECLOG_SQL.weekKeys).all(leagueId, season, week) as {
        log_id: string;
        bytes: number;
      }[]
    ).map((k) => ({ log_id: k.log_id, bytes: num(k.bytes) }));
  /** The records of `ids` (keys of one league-week), in that order: one statement. */
  const weekRecords = (
    ids: readonly string[],
    leagueId: string,
    season: number,
    week: number,
  ): RecommendationRecord[] => {
    if (ids.length === 0) return [];
    const rows = db
      .prepare(RECLOG_SQL.weekRowsByIds)
      .all(JSON.stringify(ids), leagueId, season, week) as unknown as LogRow[];
    return inOrder(rows, ids).map(toRecord);
  };
  return {
    record(input, recordedAt): RecordResult {
      validate(input);
      const ms = isoMs(recordedAt, "recorded_at");
      const json = toJson(input, "record", RECORD_JSON_MAX);
      return writes.requiredTx("recommendation_log", () => {
        const scope = recordDedupScope(input);
        if (scope !== null) {
          const prior = db
            .prepare(RECLOG_SQL.dedupProbe)
            .get(scope.league_id, scope.season, scope.week, scope.kind, scope.client_ref) as
            { log_id: string; recorded_at: string; week: number; kind: string } | undefined;
          if (prior !== undefined)
            return {
              log_id: prior.log_id,
              recorded_at: prior.recorded_at,
              week: num(prior.week),
              kind: prior.kind as RecordResult["kind"],
              deduplicated: true,
            };
        }
        // the text as stored (a refusal below rolls back any pseudonym row this added)
        const stored = pseudonyms.apply(json);
        // the week's bound, checked inside the same write transaction (BEGIN IMMEDIATE), so two
        // recorders can never both take the last place; bytes on both sides (octet_length = the
        // stored UTF-8 bytes, read from each row's header: no record text is loaded)
        const held = db
          .prepare(RECLOG_SQL.weekHeld)
          .get(input.league_id, input.season, input.week) as { n: number; bytes: number };
        if (
          num(held.n) >= RECORDS_PER_WEEK_MAX ||
          num(held.bytes) + Buffer.byteLength(stored, "utf8") > RECORD_WEEK_BYTES_MAX
        )
          throw new RecordWeekFullError();
        const logId = newLogId(ms);
        db.prepare(
          `INSERT INTO recommendation_log
           (log_id, league_id, season, week, kind, recorded_at, recorded_ms, settings_hash, client_ref, record_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          logId,
          input.league_id,
          input.season,
          input.week,
          input.kind,
          recordedAt,
          ms,
          input.settings_hash,
          input.client_ref,
          stored,
        );
        return {
          log_id: logId,
          recorded_at: recordedAt,
          week: input.week,
          kind: input.kind,
          deduplicated: false,
        };
      });
    },

    get(logId) {
      if (typeof logId !== "string" || !LOG_ID_RE.test(logId)) return null;
      const r = db
        .prepare("SELECT log_id, recorded_at, record_json FROM recommendation_log WHERE log_id = ?")
        .get(logId) as LogRow | undefined;
      return r === undefined ? null : toRecord(r);
    },

    list(q): RecommendationPage {
      matching(q.league_id, ESPN_LEAGUE_ID_RE, "league_id");
      const limit = intIn(q.limit, 1, LIST_LIMIT_MAX, "limit");
      const offset = intIn(q.offset, 0, LIST_OFFSET_MAX, "offset");
      if (q.season !== null) intIn(q.season, SEASON_MIN, SEASON_MAX, "season");
      if (q.week !== null) intIn(q.week, WEEK_MIN, WEEK_MAX, "week");
      if (q.kind !== null) oneOf(q.kind, RECOMMENDATION_KINDS, "recommendation kind");
      const sql = listSql({
        season: q.season !== null,
        week: q.week !== null,
        kind: q.kind !== null,
      });
      const params: (string | number)[] = [q.league_id];
      if (q.season !== null) params.push(q.season);
      if (q.week !== null) params.push(q.week);
      if (q.kind !== null) params.push(q.kind);
      const total = num((db.prepare(sql.count).get(...params) as { n: number }).n);
      // the page's ids first (keys only), then those rows by primary key: no record text is read
      // for a row the page does not show, however deep the offset
      const ids = (db.prepare(sql.ids).all(...params, limit, offset) as { log_id: string }[]).map(
        (r) => r.log_id,
      );
      const rows =
        ids.length === 0
          ? []
          : inOrder(
              db.prepare(RECLOG_SQL.listRowsByIds).all(JSON.stringify(ids)) as unknown as LogRow[],
              ids,
            );
      const items = rows.map((r): RecommendationListItem => {
        const rec = toRecord(r);
        return {
          log_id: r.log_id,
          kind: rec.kind,
          week: rec.week,
          recorded_at: r.recorded_at,
          action_summary: bareUntrusted(rec.rec.action, "rec_log_text"),
          followed: boolOrNull(r.followed),
        };
      });
      return { items, total };
    },

    forWeek(leagueId, season, week) {
      // the keys, then the rows by primary key: neither reads another week, and no sort carries text
      const ids = weekKeys(leagueId, season, week).map((k) => k.log_id);
      return weekRecords(ids, leagueId, season, week);
    },

    weekCounts(leagueId, season): readonly WeekRecordCount[] {
      matching(leagueId, ESPN_LEAGUE_ID_RE, "league_id");
      intIn(season, SEASON_MIN, SEASON_MAX, "season");
      const rows = db.prepare(RECLOG_SQL.weekCounts).all(leagueId, season) as {
        week: number;
        n: number;
      }[];
      return rows.map((r) => ({ week: num(r.week), n: num(r.n) }));
    },

    async forWeekPaced(leagueId, season, week, pace) {
      matching(leagueId, ESPN_LEAGUE_ID_RE, "league_id");
      intIn(season, SEASON_MIN, SEASON_MAX, "season");
      intIn(week, WEEK_MIN, WEEK_MAX, "week");
      // the caller's synchronous work before the read keeps a turn of its own
      await pace();
      // the week's membership is fixed here, from the keys and each row's header (no record text):
      // a record logged while the read is paced belongs to the next read, never half to this one
      const pages = planWeekPages(weekKeys(leagueId, season, week));
      const out: RecommendationRecord[] = [];
      for (const [i, ids] of pages.entries()) {
        if (i > 0) await pace();
        out.push(...weekRecords(ids, leagueId, season, week));
      }
      // …and so does the caller's work after it
      if (pages.length > 0) await pace();
      return out;
    },

    recordOutcome(o: RecommendationOutcome) {
      checkOutcome(o);
      writes.required("recommendation_outcome", () => {
        db.prepare(UPSERT_OUTCOME).run(...outcomeParams(o));
      });
    },

    recordOutcomes(outcomes) {
      boundedArray(outcomes, OUTCOMES_PER_BATCH_MAX, "outcomes");
      // every row is checked before any is written; the batch is one transaction (all or none)
      for (const o of outcomes) checkOutcome(o);
      if (outcomes.length === 0) return;
      writes.requiredTx("recommendation_outcome", () => {
        const upsert = db.prepare(UPSERT_OUTCOME);
        for (const o of outcomes) upsert.run(...outcomeParams(o));
      });
    },

    outcome(logId) {
      if (typeof logId !== "string" || !LOG_ID_RE.test(logId)) return null;
      const r = db.prepare("SELECT * FROM recommendation_outcome WHERE log_id = ?").get(logId) as
        OutcomeRow | undefined;
      if (r === undefined) return null;
      return {
        log_id: r.log_id,
        followed: boolOrNull(r.followed),
        realised: r.realised,
        regret: r.regret,
        decisive: boolOrNull(r.decisive),
        scored_at: r.scored_at,
        week_final: num(r.week_final) === 1,
      };
    },
  };
}
