// projection.ts — our `projection` store (plan 08 §5, §9; best-effort writes, never pruned):
// append-only per (player, season, week, model_version, made_at) so `getAsOf(before)` reads only
// projections made before lock; samples stored compressed (plan 08 §9 `samples_blob`). A run whose
// recorded inputs equal those of the newest earlier row adds no row (sib QA-1-031). And
// `espn_projection` (plan 06 §1.4 snapshots — the prospective backtest corpus; required writes,
// never pruned). Ported from sibling @cf3b015, adapted (ESPN player ids; deflate codec).
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { GSIS_ID_RE } from "../../config/schema.js";
import type {
  EspnProjectionRepository,
  EspnProjectionSnapshot,
  ModelVersion,
  ProjectionRepository,
  StoredProjection,
} from "../../domain/analytics/types.js";
import type { StatLine } from "../../domain/scoring/types.js";
import {
  boundedArray,
  finite,
  intIn,
  isoMs,
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

const MODELS: readonly ModelVersion[] = ["v1-ensemble", "v2-opportunity"];
const SPLITS = ["weekly", "ros", "preseason"] as const;
/** Most samples one projection stores, and the largest decoded samples JSON. */
export const SAMPLES_MAX = 20_000;
export const SAMPLES_JSON_MAX = 64 * 1024 * 1024;
/** Most stat keys one map carries; an ESPN stat id / canonical name grammar. */
export const STAT_MAP_MAX = 512;
export const STAT_KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
/** Most rows one `putMany` takes. */
export const PUT_MANY_MAX = 100_000;

function checkStatMap(m: unknown, what: string): Readonly<Record<string, number>> {
  if (typeof m !== "object" || m === null || Array.isArray(m))
    throw new RangeError(`store: ${what} must be an object`);
  const entries = Object.entries(m);
  if (entries.length > STAT_MAP_MAX) throw new RangeError(`store: ${what} too large`);
  for (const [k, v] of entries) {
    if (!STAT_KEY_RE.test(k)) throw new RangeError(`store: invalid ${what} key`);
    finite(v, `${what} value`);
  }
  return m as Readonly<Record<string, number>>;
}

/** Samples → compressed JSON bytes. */
export function encodeSamples(samples: readonly StatLine[]): Uint8Array {
  if (!Array.isArray(samples) || samples.length > SAMPLES_MAX)
    throw new RangeError(`store: at most ${String(SAMPLES_MAX)} samples`);
  return deflateRawSync(Buffer.from(toJson(samples, "samples", SAMPLES_JSON_MAX), "utf8"));
}

/** Compressed bytes → samples (bounded output: a corrupt blob cannot inflate without limit). */
export function decodeSamples(blob: unknown): StatLine[] {
  if (!(blob instanceof Uint8Array)) throw new Error("store: corrupt samples column");
  const text = inflateRawSync(blob, { maxOutputLength: SAMPLES_JSON_MAX }).toString("utf8");
  return parseJson<StatLine[]>(text);
}

interface Row {
  player_id: number;
  gsis_id: string | null;
  season: number;
  week: number;
  model_version: string;
  made_at: string;
  inputs_as_of: string;
  expectation_json: string;
  samples: Uint8Array;
}

const toStored = (r: Row): StoredProjection => ({
  player_id: num(r.player_id),
  gsis_id: r.gsis_id,
  season: num(r.season),
  week: num(r.week),
  model_version: r.model_version as ModelVersion,
  made_at: r.made_at,
  inputs_as_of: r.inputs_as_of,
  expectation: parseJson(r.expectation_json),
  samples: decodeSamples(r.samples),
});

/** The newest earlier row of the key recorded the same inputs_as_of and expectation. */
const REPEATS_PREVIOUS_SQL = `SELECT 1 FROM (
    SELECT inputs_as_of, expectation_json FROM projection
    WHERE player_id = :player AND season = :season AND week = :week AND model_version = :model
      AND made_ms <= :made
    ORDER BY made_ms DESC LIMIT 1
  ) AS prev WHERE prev.inputs_as_of = :inputs AND prev.expectation_json = :expectation`;

export function projectionRepository({ db, writes }: RepoDeps): ProjectionRepository {
  const newest = (extra: string) =>
    db.prepare(
      `SELECT * FROM projection WHERE player_id = :player AND season = :season AND week = :week
       AND model_version = :model ${extra} ORDER BY made_ms DESC LIMIT 1`,
    );
  return {
    put(p) {
      intIn(p.player_id, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "player_id");
      if (p.player_id === 0) throw new RangeError("store: player_id 0 is not a player");
      if (p.gsis_id !== null) matching(p.gsis_id, GSIS_ID_RE, "gsis_id");
      intIn(p.season, SEASON_MIN, SEASON_MAX, "season");
      intIn(p.week, WEEK_MIN, WEEK_MAX, "week");
      oneOf(p.model_version, MODELS, "model_version");
      const madeMs = isoMs(p.made_at, "made_at");
      isoMs(p.inputs_as_of, "inputs_as_of");
      const expectation = JSON.stringify(checkStatMap(p.expectation, "expectation"));
      const key = {
        player: p.player_id,
        season: p.season,
        week: p.week,
        model: p.model_version,
        made: madeMs,
        inputs: p.inputs_as_of,
        expectation,
      };
      // A repeat of the newest earlier run's recorded inputs is already stored: no encode, no write.
      if (db.prepare(REPEATS_PREVIOUS_SQL).get(key) !== undefined) return { written: true };
      const samples = encodeSamples(p.samples);
      return writes.bestEffort(() => {
        db.prepare(
          `INSERT OR IGNORE INTO projection
           (player_id, gsis_id, season, week, model_version, made_at, made_ms, inputs_as_of, expectation_json, samples)
           SELECT :player, :gsis, :season, :week, :model, :made_at, :made, :inputs, :expectation, :samples
           WHERE NOT EXISTS (${REPEATS_PREVIOUS_SQL})`,
        ).run({ ...key, gsis: p.gsis_id, made_at: p.made_at, samples });
      });
    },
    latest(playerId, season, week, model) {
      const r = newest("").get({ player: playerId, season, week, model }) as Row | undefined;
      return r === undefined ? null : toStored(r);
    },
    getAsOf(playerId, season, week, model, before) {
      const r = newest("AND made_ms < :before").get({
        player: playerId,
        season,
        week,
        model,
        before: isoMs(before, "before"),
      }) as Row | undefined;
      return r === undefined ? null : toStored(r);
    },
  };
}

function checkSnapshot(s: EspnProjectionSnapshot): number {
  intIn(s.player_id, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "player_id");
  if (s.player_id === 0) throw new RangeError("store: player_id 0 is not a player");
  intIn(s.season, SEASON_MIN, SEASON_MAX, "season");
  if (s.week !== null) intIn(s.week, WEEK_MIN, WEEK_MAX, "week");
  oneOf(s.split, SPLITS, "projection split");
  finite(s.applied_total, "applied_total");
  checkStatMap(s.stats_raw, "stats_raw");
  return isoMs(s.snapshot_at, "snapshot_at");
}

interface SnapshotRow {
  player_id: number;
  season: number;
  week: number | null;
  split: string;
  applied_total: number;
  stats_raw_json: string;
  snapshot_at: string;
}

const toSnapshot = (r: SnapshotRow): EspnProjectionSnapshot => ({
  player_id: num(r.player_id),
  season: num(r.season),
  week: r.week === null ? null : num(r.week),
  split: r.split as EspnProjectionSnapshot["split"],
  applied_total: r.applied_total,
  stats_raw: parseJson(r.stats_raw_json),
  snapshot_at: r.snapshot_at,
});

export function espnProjectionRepository({ db, writes }: RepoDeps): EspnProjectionRepository {
  return {
    putMany(rows) {
      const checked = boundedArray(rows, PUT_MANY_MAX, "rows").map((r) => ({
        r,
        ms: checkSnapshot(r),
      }));
      if (checked.length === 0) return 0;
      return writes.requiredTx("espn_projection", () => {
        const ins = db.prepare(
          `INSERT OR IGNORE INTO espn_projection
           (player_id, season, week, week_key, split, applied_total, stats_raw_json, snapshot_at, snapshot_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        let n = 0;
        for (const { r, ms } of checked)
          n += Number(
            ins.run(
              r.player_id,
              r.season,
              r.week,
              r.week ?? -1,
              r.split,
              r.applied_total,
              JSON.stringify(r.stats_raw),
              r.snapshot_at,
              ms,
            ).changes,
          );
        return n;
      });
    },
    asOf(season, week, before) {
      const beforeMs = isoMs(before, "before");
      // The newest snapshot before `before` per (player, split) recorded for that week.
      const rows = db
        .prepare(
          `SELECT p.* FROM espn_projection AS p
           JOIN (SELECT player_id, split, MAX(snapshot_ms) AS m FROM espn_projection
                 WHERE season = :season AND week_key = :week AND snapshot_ms < :before
                 GROUP BY player_id, split) AS n
             ON n.player_id = p.player_id AND n.split = p.split AND n.m = p.snapshot_ms
           WHERE p.season = :season AND p.week_key = :week
           ORDER BY p.player_id, p.split`,
        )
        .all({ season, week, before: beforeMs }) as unknown as SnapshotRow[];
      return rows.map(toSnapshot);
    },
    lastSnapshotAt() {
      const r = db.prepare("SELECT MAX(snapshot_ms) AS m FROM espn_projection").get() as {
        m: number | null;
      };
      return r.m === null ? null : msToIso(num(r.m));
    },
  };
}
