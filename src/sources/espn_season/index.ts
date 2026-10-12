// espn_season — the two keyless ESPN season sources (plan 10 §3.1a *Sources*; plan 06 §1.3
// `refresh espn:schedule` / `refresh espn:players`, J3; plan 01 §5.5 refresh pipeline; tables.ts
// DS_PRO_SCHEDULE / DS_PRO_TEAMS / DS_PLAYERS): `proTeamSchedules_wl` → ds_pro_schedule +
// ds_pro_teams, and `players_wl` (root-level `filterActive`) → ds_players. Keyless, read host only:
// the requests go through the injected HttpGet (the CLI hands these sources a GET that records each
// request in the cross-process ESPN limiter — the jobs' keyless cap, plan 06 §1.4). A source never
// touches store.sqlite: it writes a temp file per season, asserts its shape, and publishes into a
// fresh dataset file. Versioning is a time bucket (no release marker exists): the hour for the
// schedule (it runs hourly on game days), the UTC day for the player index; the runner skips a
// bucket already published. A new season's 404 is "not published yet".
// The schema assertion is the drift gate (plan 01 §5.5 "missing/renamed → job fails loudly, previous
// load stays"; plan 10 B1 "fails naming the column"): a body that yields no games or no players, or
// in which an entry misses or mistypes a field the drift manifest marks required
// (fixtures/drift/manifest.json `probes.host.required` — the per-period map and every game's epoch
// `date` included), fails with `schema_mismatch` naming the field, so a drifted body never replaces
// the good dataset (a schedule without kickoffs would read off-season and stop every in-season job).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SOURCE_REGISTRY } from "../../config/freshness.js";
import { ESPN_READ_HOST_DEFAULT } from "../../config/schema.js";
import { HttpError } from "../../http/errors.js";
import { boolToInt, byeWeek, epochMs } from "../../store/datasets/derive.js";
import {
  columnsHash,
  DS_PLAYERS,
  DS_PRO_SCHEDULE,
  DS_PRO_TEAMS,
} from "../../store/datasets/tables.js";
import type { DatasetRow } from "../../store/types.js";
import {
  SOURCE_RATE_LIMITS,
  type DataSource,
  type DatasetWriter,
  type PublishStats,
  type ReleaseVersion,
  type SchemaReport,
  type SourceContext,
  type TempFile,
} from "../source.js";
import type { SourceErrorCode } from "../../config/freshness.js";

/** The largest season-view body read (players_wl was 754 KB in 2026). */
export const ESPN_SEASON_MAX_BYTES = 8 * 1024 * 1024;
/** The player index's root-level filter, exactly as recorded (research 03 §A.2 row 20). */
export const PLAYERS_WL_FILTER = '{"filterActive":{"value":true}}';
/** Most rows a season view may yield (a guard against a runaway body; 2026: 272 games, 2,669 players). */
export const MAX_SEASON_ROWS = 20_000;
/**
 * The share of players_wl entries that may be skipped (no id, name, position or team, or a duplicate
 * id) before the view counts as drifted: the recorded 2026 index skips 0 of 2,669, a renamed or
 * retyped field skips them all.
 */
export const MAX_SKIPPED_PLAYER_SHARE = 0.01;
/** ESPN's free-agent pseudo-team (id 0): listed with an empty per-period map, plays no game. */
export const FREE_AGENT_PRO_TEAM_ID = 0;

/** A season source failure with a fixed refresh_log code (never upstream text). */
export class EspnSeasonSourceError extends Error {
  readonly code: SourceErrorCode;
  constructor(code: SourceErrorCode, message: string) {
    super(message);
    this.name = "EspnSeasonSourceError";
    this.code = code;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** The rows of one proTeamSchedules_wl body plus what the drift gate needs to know about it. */
export interface ProScheduleParse {
  readonly games: DatasetRow[];
  readonly teams: DatasetRow[];
  /** Team or game entries not published (a field the row needs is missing or mistyped). */
  readonly skipped: number;
  /** Entries missing or mistyping a field the drift manifest marks required (rows kept or not). */
  readonly invalid: number;
  /** The required fields (manifest spelling) that failed in at least one entry, sorted. */
  readonly failed_fields: readonly string[];
  /** Pro teams (the free-agent pseudo-team excluded) that play in no published game. */
  readonly teams_without_games: number;
}

/** The required fields of one `settings.proTeams[]` entry that fail (drift manifest `probes.host`). */
function teamFailures(t: unknown): string[] {
  if (!isObj(t)) return ["settings.proTeams"];
  const out: string[] = [];
  if (!isInt(t.id)) out.push("id");
  if (typeof t.abbrev !== "string" || t.abbrev === "") out.push("abbrev");
  if (!isInt(t.byeWeek)) out.push("byeWeek");
  if (!isObj(t.proGamesByScoringPeriod)) out.push("proGamesByScoringPeriod");
  return out;
}

/** The required fields of one game entry that fail (an epoch-ms integer `date` included). */
function gameFailures(g: unknown): string[] {
  if (!isObj(g)) return ["proGamesByScoringPeriod"];
  const out: string[] = [];
  for (const k of ["id", "scoringPeriodId", "homeProTeamId", "awayProTeamId"] as const)
    if (!isInt(g[k])) out.push(k);
  if (epochMs(g.date) === null) out.push("date");
  for (const k of ["startTimeTBD", "validForLocking", "statsOfficial"] as const)
    if (boolToInt(g[k]) === null) out.push(k);
  return out;
}

/** The rows of one proTeamSchedules_wl body (games collapsed by id; conflicting duplicates throw). */
export function proScheduleRows(body: unknown, season: number): ProScheduleParse {
  const proTeams = isObj(body) && isObj(body.settings) ? body.settings.proTeams : undefined;
  if (!Array.isArray(proTeams))
    throw new EspnSeasonSourceError(
      "schema_mismatch",
      "proTeamSchedules_wl: no settings.proTeams[]",
    );
  const games = new Map<number, DatasetRow>();
  const teams: DatasetRow[] = [];
  const failed = new Set<string>();
  const playing = new Set<number>();
  let skipped = 0;
  let invalid = 0;
  const note = (failures: readonly string[]): void => {
    if (failures.length === 0) return;
    invalid++;
    for (const f of failures) failed.add(f);
  };
  for (const t of proTeams) {
    note(teamFailures(t));
    if (!isObj(t) || !isInt(t.id) || typeof t.abbrev !== "string" || t.abbrev === "") {
      skipped++;
      continue;
    }
    teams.push({
      season,
      pro_team_id: t.id,
      abbrev: t.abbrev,
      location: typeof t.location === "string" ? t.location : null,
      name: typeof t.name === "string" ? t.name : null,
      bye_week: byeWeek(t.byeWeek),
    });
    const byPeriod = t.proGamesByScoringPeriod;
    if (!isObj(byPeriod)) continue;
    for (const list of Object.values(byPeriod)) {
      if (!Array.isArray(list)) {
        note(["proGamesByScoringPeriod"]);
        continue;
      }
      for (const g of list) {
        note(gameFailures(g));
        const row = gameRow(g, season);
        if (row === null) {
          skipped++;
          continue;
        }
        const id = row.espn_game_id as number;
        const prev = games.get(id);
        if (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(row))
          throw new EspnSeasonSourceError(
            "schema_mismatch",
            "proTeamSchedules_wl: one game id listed with different fields",
          );
        games.set(id, row);
        playing.add(row.home_pro_team_id as number);
        playing.add(row.away_pro_team_id as number);
        if (games.size > MAX_SEASON_ROWS)
          throw new EspnSeasonSourceError("schema_mismatch", "proTeamSchedules_wl: too many games");
      }
    }
  }
  const idle = teams.filter(
    (t) => t.pro_team_id !== FREE_AGENT_PRO_TEAM_ID && !playing.has(t.pro_team_id as number),
  ).length;
  return {
    games: [...games.values()].sort(
      (a, b) => (a.espn_game_id as number) - (b.espn_game_id as number),
    ),
    teams,
    skipped,
    invalid,
    failed_fields: [...failed].sort(),
    teams_without_games: idle,
  };
}

function gameRow(g: unknown, season: number): DatasetRow | null {
  if (!isObj(g) || !isInt(g.id) || !isInt(g.scoringPeriodId)) return null;
  if (!isInt(g.homeProTeamId) || !isInt(g.awayProTeamId)) return null;
  const tbd = boolToInt(g.startTimeTBD);
  const lock = boolToInt(g.validForLocking);
  const official = boolToInt(g.statsOfficial);
  if (tbd === null || lock === null || official === null) return null;
  return {
    season,
    espn_game_id: g.id,
    week: g.scoringPeriodId,
    date_ms: epochMs(g.date),
    start_time_tbd: tbd,
    valid_for_locking: lock,
    stats_official: official,
    home_pro_team_id: g.homeProTeamId,
    away_pro_team_id: g.awayProTeamId,
  };
}

/** The rows of one players_wl body plus what the drift gate needs to know about it. */
export interface PlayersParse {
  readonly rows: DatasetRow[];
  /** Entries not published: a required field missing or mistyped, or a duplicate id. */
  readonly skipped: number;
  /** Entries the body held (the skipped share's denominator). */
  readonly entries: number;
  /** The required fields that failed in at least one entry (`id` also for a duplicate), sorted. */
  readonly failed_fields: readonly string[];
}

/** The rows of one players_wl body (a root array; rows without id/name/position/team skipped). */
export function playersRows(body: unknown, season: number): PlayersParse {
  if (!Array.isArray(body))
    throw new EspnSeasonSourceError("schema_mismatch", "players_wl: not a root array");
  if (body.length > MAX_SEASON_ROWS)
    throw new EspnSeasonSourceError("schema_mismatch", "players_wl: too many players");
  const seen = new Set<number>();
  const rows: DatasetRow[] = [];
  const failed = new Set<string>();
  let skipped = 0;
  for (const p of body) {
    if (!isObj(p)) {
      failed.add("players_wl");
      skipped++;
      continue;
    }
    if (
      !isInt(p.id) ||
      seen.has(p.id) ||
      typeof p.fullName !== "string" ||
      p.fullName === "" ||
      !isInt(p.defaultPositionId) ||
      !isInt(p.proTeamId)
    ) {
      if (!isInt(p.id) || seen.has(p.id)) failed.add("id");
      if (typeof p.fullName !== "string" || p.fullName === "") failed.add("fullName");
      if (!isInt(p.defaultPositionId)) failed.add("defaultPositionId");
      if (!isInt(p.proTeamId)) failed.add("proTeamId");
      skipped++;
      continue;
    }
    seen.add(p.id);
    const slots = p.eligibleSlots;
    const owned = isObj(p.ownership) ? p.ownership.percentOwned : undefined;
    rows.push({
      season,
      espn_id: p.id,
      full_name: p.fullName,
      first_name: typeof p.firstName === "string" ? p.firstName : null,
      last_name: typeof p.lastName === "string" ? p.lastName : null,
      position_id: p.defaultPositionId,
      pro_team_id: p.proTeamId,
      eligible_slots: Array.isArray(slots) && slots.every(isInt) ? JSON.stringify(slots) : null,
      percent_owned:
        typeof owned === "number" && Number.isFinite(owned) && owned >= 0 && owned <= 100
          ? owned
          : null,
      droppable: boolToInt(p.droppable),
      last_news_date_ms: epochMs(p.lastNewsDate),
    });
  }
  return {
    rows: rows.sort((a, b) => (a.espn_id as number) - (b.espn_id as number)),
    skipped,
    entries: body.length,
    failed_fields: [...failed].sort(),
  };
}

/** What the drift gate decides about one season view body. */
export interface SeasonViewCheck {
  /** Rows the body would publish (games for the schedule, players for the index). */
  readonly rows: number;
  /** The fields that failed (manifest spelling; plan 10 B1 names them), sorted; empty = passes. */
  readonly fields: readonly string[];
  /** One server-authored line per problem (counts and field names only, never upstream text). */
  readonly problems: readonly string[];
}

/**
 * The drift gate over a proTeamSchedules_wl body: it passes only when it yields games, every team
 * and game entry carries the drift manifest's required fields with their types (an epoch-ms `date`
 * per game — a kickoff the season gate and the in-game TTLs read), and every pro team but the
 * free-agent pseudo-team plays in at least one game. Throws EspnSeasonSourceError on a body with no
 * `settings.proTeams[]` (the caller reports it).
 */
export function checkProSchedule(body: unknown, season: number): SeasonViewCheck {
  const r = proScheduleRows(body, season);
  const fields = new Set(r.failed_fields);
  const problems: string[] = [];
  if (r.invalid > 0)
    problems.push(
      `${String(r.invalid)} team or game entries miss or mistype a required field (${r.failed_fields.join(", ")})`,
    );
  if (r.games.length === 0) {
    fields.add("proGamesByScoringPeriod");
    problems.push("no games");
  }
  if (r.teams_without_games > 0) {
    fields.add("proGamesByScoringPeriod");
    problems.push(`${String(r.teams_without_games)} pro team(s) play in no game`);
  }
  return { rows: r.games.length, fields: [...fields].sort(), problems };
}

/**
 * The drift gate over a players_wl body: it passes only when it yields players and at most
 * MAX_SKIPPED_PLAYER_SHARE of its entries are skipped. Throws EspnSeasonSourceError on a body that
 * is not a root array (the caller reports it).
 */
export function checkPlayers(body: unknown, season: number): SeasonViewCheck {
  const r = playersRows(body, season);
  const fields = new Set(r.failed_fields);
  const problems: string[] = [];
  if (r.rows.length === 0) {
    if (fields.size === 0) fields.add("players_wl");
    problems.push(`no players (${String(r.entries)} entries)`);
  } else if (r.skipped > r.entries * MAX_SKIPPED_PLAYER_SHARE) {
    problems.push(
      `${String(r.skipped)} of ${String(r.entries)} entries skipped (${r.failed_fields.join(", ")})`,
    );
  } else {
    fields.clear(); // a tolerated skip: publish reports the count
  }
  return { rows: r.rows.length, fields: [...fields].sort(), problems };
}

/** `YYYYMMDDHH` (UTC) of an instant, or `YYYYMMDD` for a day bucket. */
function bucket(ms: number, unit: "hour" | "day"): string {
  const iso = new Date(ms).toISOString();
  const day = iso.slice(0, 10).replace(/-/g, "");
  return unit === "day" ? day : `${day}${iso.slice(11, 13)}`;
}

interface SpecOf {
  readonly id: "espn:pro_schedule" | "espn:players";
  readonly view: "proTeamSchedules_wl" | "players_wl";
  readonly unit: "hour" | "day";
  readonly url: (season: number) => string;
  readonly filter: string | null;
  readonly tables: DataSource["tables"];
  readonly check: (body: unknown, season: number) => SeasonViewCheck;
  readonly write: (
    files: readonly { season: number; body: unknown }[],
    into: DatasetWriter,
  ) => { rows: number; tables: { name: string; rows: number }[]; warnings: string[] };
}

async function readBody(f: TempFile): Promise<unknown> {
  const text = await readFile(f.path, "utf8");
  try {
    return JSON.parse(text, (k: string, v: unknown) =>
      k === "__proto__" ? undefined : v,
    ) as unknown;
  } catch {
    throw new EspnSeasonSourceError("schema_mismatch", "season view: the body is not JSON");
  }
}

function makeSource(spec: SpecOf): DataSource {
  const reg = SOURCE_REGISTRY[spec.id];
  return Object.freeze({
    id: spec.id,
    license: reg.license,
    attribution: reg.attribution,
    freshness: reg.freshness,
    job: reg.job,
    limiter: SOURCE_RATE_LIMITS.espn_season,
    versioning: "time_bucket" as const,
    seasonGate: "always" as const,
    tables: spec.tables,
    version(ctx: SourceContext): Promise<ReleaseVersion> {
      return Promise.resolve({
        version: `${bucket(ctx.clock.nowMs(), spec.unit)}_${ctx.seasons.join("-")}`,
        released_at: null,
      });
    },
    async fetch(_v: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]> {
      const out: TempFile[] = [];
      for (const season of ctx.seasons) {
        let r;
        try {
          r = await ctx.http(spec.url(season), {
            signal: ctx.signal,
            maxBytes: ESPN_SEASON_MAX_BYTES,
            accept: "application/json",
            ...(spec.filter === null ? {} : { fantasyFilter: spec.filter }),
          });
        } catch (e) {
          if (e instanceof HttpError && e.status === 404) {
            ctx.notPublished(season);
            continue;
          }
          throw e;
        }
        // an HttpGet may also answer a non-2xx status instead of throwing (the HttpGet contract)
        if (r.status === 404) {
          ctx.notPublished(season);
          continue;
        }
        if (r.status < 200 || r.status > 299) {
          const host = new URL(spec.url(season)).hostname;
          const kind =
            r.status === 429 ? "rate_limited" : r.status >= 500 ? "http_5xx" : "http_4xx";
          throw new HttpError({ kind, host, status: r.status, espn: true });
        }
        const file = path.join(ctx.tempDir, `${spec.view}.${String(season)}.json`);
        await writeFile(file, r.body, { mode: 0o600, flag: "wx" });
        out.push({ path: file, bytes: r.body.byteLength, season });
      }
      return out;
    },
    async assertSchema(files: readonly TempFile[]): Promise<SchemaReport> {
      let rows = 0;
      const missing = new Set<string>();
      const warnings: string[] = [];
      for (const f of files) {
        const label = `${spec.view} season ${String(f.season ?? 0)}`;
        try {
          const c = spec.check(await readBody(f), f.season ?? 0);
          rows += c.rows;
          for (const field of c.fields) missing.add(field);
          for (const p of c.problems) warnings.push(`${label}: ${p}`);
        } catch (e) {
          const why = e instanceof EspnSeasonSourceError ? e.message : `${spec.view}: unreadable`;
          missing.add(why);
          warnings.push(`${label}: ${why}`);
        }
      }
      if (files.length === 0) warnings.push(`${spec.view}: no files to check`);
      return {
        ok: missing.size === 0 && files.length > 0 && rows > 0,
        missing_columns: [...missing],
        extra_columns: [],
        bad_codecs: [],
        rows,
        warnings,
      };
    },
    async publish(files: readonly TempFile[], into: DatasetWriter): Promise<PublishStats> {
      const bodies = [];
      for (const f of files) bodies.push({ season: f.season ?? 0, body: await readBody(f) });
      const w = spec.write(bodies, into);
      const stats: PublishStats & { warnings: readonly string[] } = {
        rows: w.rows,
        tables: w.tables,
        seasons: [...new Set(files.map((f) => f.season ?? 0))].sort((a, b) => a - b),
        columns_hash: columnsHash(spec.id),
        warnings: w.warnings,
      };
      return stats;
    },
  });
}

/** The two keyless ESPN season sources over a read host (default: config's default read host). */
export function espnSeasonSources(readHost: string = ESPN_READ_HOST_DEFAULT): {
  readonly proSchedule: DataSource;
  readonly players: DataSource;
} {
  if (!/^[a-z0-9.-]{1,253}$/.test(readHost)) throw new RangeError("espn season: a bad read host");
  const base = (season: number): string =>
    `https://${readHost}/apis/v3/games/ffl/seasons/${String(season)}`;
  const proSchedule = makeSource({
    id: "espn:pro_schedule",
    view: "proTeamSchedules_wl",
    unit: "hour",
    url: (s) => `${base(s)}?view=proTeamSchedules_wl`,
    filter: null,
    tables: [DS_PRO_SCHEDULE, DS_PRO_TEAMS],
    check: checkProSchedule,
    write: (bodies, into) => {
      into.createTable(DS_PRO_SCHEDULE);
      into.createTable(DS_PRO_TEAMS);
      let g = 0;
      let t = 0;
      let skipped = 0;
      for (const { season, body } of bodies) {
        const rows = proScheduleRows(body, season);
        g += into.insert("ds_pro_schedule", rows.games);
        t += into.insert("ds_pro_teams", rows.teams);
        skipped += rows.skipped;
      }
      return {
        rows: g + t,
        tables: [
          { name: "ds_pro_schedule", rows: g },
          { name: "ds_pro_teams", rows: t },
        ],
        warnings:
          skipped === 0
            ? []
            : [`espn:pro_schedule: ${String(skipped)} entries skipped (missing or invalid fields)`],
      };
    },
  });
  const players = makeSource({
    id: "espn:players",
    view: "players_wl",
    unit: "day",
    url: (s) => `${base(s)}/players?view=players_wl`,
    filter: PLAYERS_WL_FILTER,
    tables: [DS_PLAYERS],
    check: checkPlayers,
    write: (bodies, into) => {
      into.createTable(DS_PLAYERS);
      let n = 0;
      let skipped = 0;
      for (const { season, body } of bodies) {
        const rows = playersRows(body, season);
        n += into.insert("ds_players", rows.rows);
        skipped += rows.skipped;
      }
      return {
        rows: n,
        tables: [{ name: "ds_players", rows: n }],
        warnings:
          skipped === 0
            ? []
            : [`espn:players: ${String(skipped)} entries skipped (no id, name, position or team)`],
      };
    },
  });
  return Object.freeze({ proSchedule, players });
}
