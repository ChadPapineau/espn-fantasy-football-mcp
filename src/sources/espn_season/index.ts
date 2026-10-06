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

/** The rows of one proTeamSchedules_wl body (games collapsed by id; conflicting duplicates throw). */
export function proScheduleRows(
  body: unknown,
  season: number,
): { games: DatasetRow[]; teams: DatasetRow[]; skipped: number } {
  const proTeams = isObj(body) && isObj(body.settings) ? body.settings.proTeams : undefined;
  if (!Array.isArray(proTeams))
    throw new EspnSeasonSourceError(
      "schema_mismatch",
      "proTeamSchedules_wl: no settings.proTeams[]",
    );
  const games = new Map<number, DatasetRow>();
  const teams: DatasetRow[] = [];
  let skipped = 0;
  for (const t of proTeams) {
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
      if (!Array.isArray(list)) continue;
      for (const g of list) {
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
        if (games.size > MAX_SEASON_ROWS)
          throw new EspnSeasonSourceError("schema_mismatch", "proTeamSchedules_wl: too many games");
      }
    }
  }
  return {
    games: [...games.values()].sort(
      (a, b) => (a.espn_game_id as number) - (b.espn_game_id as number),
    ),
    teams,
    skipped,
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

/** The rows of one players_wl body (a root array; rows without id/name/position/team skipped). */
export function playersRows(
  body: unknown,
  season: number,
): { rows: DatasetRow[]; skipped: number } {
  if (!Array.isArray(body))
    throw new EspnSeasonSourceError("schema_mismatch", "players_wl: not a root array");
  if (body.length > MAX_SEASON_ROWS)
    throw new EspnSeasonSourceError("schema_mismatch", "players_wl: too many players");
  const seen = new Set<number>();
  const rows: DatasetRow[] = [];
  let skipped = 0;
  for (const p of body) {
    if (
      !isObj(p) ||
      !isInt(p.id) ||
      typeof p.fullName !== "string" ||
      p.fullName === "" ||
      !isInt(p.defaultPositionId) ||
      !isInt(p.proTeamId) ||
      seen.has(p.id)
    ) {
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
  return { rows: rows.sort((a, b) => (a.espn_id as number) - (b.espn_id as number)), skipped };
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
  readonly count: (body: unknown, season: number) => number;
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
      const missing: string[] = [];
      for (const f of files) {
        try {
          rows += spec.count(await readBody(f), f.season ?? 0);
        } catch (e) {
          missing.push(e instanceof EspnSeasonSourceError ? e.message : `${spec.view}: unreadable`);
        }
      }
      return {
        ok: missing.length === 0 && files.length > 0,
        missing_columns: missing,
        extra_columns: [],
        bad_codecs: [],
        rows,
        warnings: [],
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
    count: (b, s) => proScheduleRows(b, s).games.length,
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
    count: (b, s) => playersRows(b, s).rows.length,
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
