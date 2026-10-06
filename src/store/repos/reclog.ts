// reclog.ts — recommendation_log + recommendation_outcome (plan 01 §9.2, never pruned; plan 07 E12
// record, E13 retrospective, E14 list; sib critic C-02b the scored outcome beside the immutable row;
// sib QA-1-061 the dedup scope is the whole RECORD_DEDUP_SCOPE). Required writes. Free text in a
// stored record is model-authored and untrusted on read (plan 07 C15): the store returns it raw,
// except `action_summary`, which is sanitised to BareText here; readers path-list RECLOG_TEXT_PATHS.
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
  type RecommendationLogRepository,
  type RecommendationOutcome,
  type RecommendationPage,
  type RecommendationRecord,
  type RecordRecommendationInput,
  type RecordResult,
} from "../../domain/reclog/types.js";
import { SETTINGS_HASH_RE } from "../../domain/scoring/types.js";
import {
  bitOrNull,
  boolOrNull,
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
}: RepoDeps): RecommendationLogRepository {
  return {
    record(input, recordedAt): RecordResult {
      validate(input);
      const ms = isoMs(recordedAt, "recorded_at");
      const json = toJson(input, "record", RECORD_JSON_MAX);
      return writes.requiredTx("recommendation_log", () => {
        const scope = recordDedupScope(input);
        if (scope !== null) {
          const prior = db
            .prepare(
              `SELECT log_id, recorded_at, week, kind FROM recommendation_log
               WHERE league_id = ? AND season = ? AND week = ? AND kind = ? AND client_ref = ?`,
            )
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
          pseudonyms.apply(json),
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
      const where = `l.league_id = :league
        AND (:season IS NULL OR l.season = :season)
        AND (:week IS NULL OR l.week = :week)
        AND (:kind IS NULL OR l.kind = :kind)`;
      const params = { league: q.league_id, season: q.season, week: q.week, kind: q.kind };
      const total = num(
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM recommendation_log AS l WHERE ${where}`)
            .get(params) as {
            n: number;
          }
        ).n,
      );
      const rows = db
        .prepare(
          `SELECT l.log_id, l.recorded_at, l.record_json, o.followed AS followed FROM recommendation_log AS l
           LEFT JOIN recommendation_outcome AS o ON o.log_id = l.log_id
           WHERE ${where} ORDER BY l.recorded_ms DESC, l.log_id DESC LIMIT :limit OFFSET :offset`,
        )
        .all({ ...params, limit, offset }) as unknown as LogRow[];
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
      const rows = db
        .prepare(
          `SELECT log_id, recorded_at, record_json FROM recommendation_log
           WHERE league_id = ? AND season = ? AND week = ? ORDER BY recorded_ms, log_id`,
        )
        .all(leagueId, season, week) as unknown as LogRow[];
      return rows.map(toRecord);
    },

    recordOutcome(o: RecommendationOutcome) {
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
      writes.required("recommendation_outcome", () => {
        // A final outcome is immutable; a provisional one is re-written (sib critic C-02b).
        db.prepare(
          `INSERT INTO recommendation_outcome (log_id, followed, realised, regret, decisive, scored_at, week_final)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (log_id) DO UPDATE SET followed = excluded.followed, realised = excluded.realised,
             regret = excluded.regret, decisive = excluded.decisive, scored_at = excluded.scored_at,
             week_final = excluded.week_final
           WHERE recommendation_outcome.week_final = 0`,
        ).run(
          o.log_id,
          bitOrNull(o.followed),
          o.realised,
          o.regret,
          bitOrNull(o.decisive),
          o.scored_at,
          o.week_final ? 1 : 0,
        );
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
