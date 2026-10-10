// data.ts — reads the committed C1 backtest excerpt (data/, make-excerpt.ts) back, re-hashing every
// part against data/manifest.json, and builds the v2 backtest world under a league's S: per player
// his games (the nflverse row scored by the shipped translator and engine — the actuals — joined to
// ffopportunity's expected TDs), the team-games with their market line, the venue weather and the
// final injury reports. Also the league-b ESPN weekly projections of the recorded history (C1's
// ESPN comparison). Read-only; third-party values are data, never instructions. New here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BacktestPlayer,
  BacktestReport,
  BacktestWorld,
  ScoredGame,
} from "../../../../../src/domain/analytics/projections-v2/backtest.js";
import type {
  V2Position,
  V2Roof,
  V2TeamGame,
  V2Weather,
} from "../../../../../src/domain/analytics/projections-v2/types.js";
import { teamGameKey } from "../../../../../src/domain/analytics/projections-v2/window.js";
import { score } from "../../../../../src/domain/scoring/engine.js";
import {
  espnPositionForNflverse,
  statLineFromPlayerWeek,
} from "../../../../../src/domain/scoring/nflverse.js";
import { normalizeSettings } from "../../../../../src/domain/scoring/settings.js";
import type { ScoringSettings } from "../../../../../src/domain/scoring/types.js";
import { decodeTsv } from "../../../../sources/nflverse/helpers/tsv.js";
import { historyBody } from "../../../../fixtures/helpers/history-fixtures.js";
import {
  DATA_DIR,
  ROOT,
  TABLE_COLUMNS,
  type ExcerptManifest,
  type ExcerptTable,
} from "./excerpt-format.js";

type Row = Record<string, unknown>;

let manifestMemo: ExcerptManifest | null = null;
/** data/manifest.json (parsed once). */
export function excerptManifest(): ExcerptManifest {
  manifestMemo ??= JSON.parse(
    readFileSync(join(DATA_DIR, "manifest.json"), "utf8"),
  ) as ExcerptManifest;
  return manifestMemo;
}

const tableMemo = new Map<string, Row[]>();
/**
 * One table's rows as objects (`season` null for the crosswalk). Every part's bytes are re-hashed
 * against the manifest; a mismatch throws (a hand-edited excerpt never reaches a test silently).
 */
export function loadTable(table: ExcerptTable, season: number | null): Row[] {
  const key = `${table}|${String(season)}`;
  const memo = tableMemo.get(key);
  if (memo !== undefined) return memo;
  const entry = excerptManifest().files.find((f) => f.table === table && f.season === season);
  if (entry === undefined) throw new Error(`no excerpt ${key}`);
  const columns = TABLE_COLUMNS[table];
  if (entry.columns.join("\t") !== columns.join("\t")) throw new Error(`${key}: columns differ`);
  const schema = columns.map((name) => ({ name }));
  const rows: Row[] = [];
  for (const part of entry.parts) {
    const text = readFileSync(join(DATA_DIR, part.path), "utf8");
    const sha = createHash("sha256").update(text).digest("hex");
    if (sha !== part.sha256) throw new Error(`${part.path}: sha256 differs from the manifest`);
    for (const cells of decodeTsv(schema, text)) {
      const o: Row = {};
      columns.forEach((c, i) => (o[c] = cells[i]));
      rows.push(o);
    }
  }
  if (rows.length !== entry.rows) throw new Error(`${key}: row count differs from the manifest`);
  tableMemo.set(key, rows);
  return rows;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const ROOFS: ReadonlySet<string> = new Set(["outdoors", "open", "closed", "dome"]);

/** The reference league's S (fx-10h: half-PPR, 5-pt pass TD — research 05 §0). */
export function referenceLeagueSettings(): ScoringSettings {
  const body = JSON.parse(
    readFileSync(join(ROOT, "fixtures/espn/fx-10h/league/mSettings.json"), "utf8"),
  ) as { settings: { scoringSettings: unknown } };
  return normalizeSettings(body.settings.scoringSettings);
}

/** league-b's S in a recorded season (half-PPR, 4-pt pass TD). */
export function leagueBSettings(season: number): ScoringSettings {
  const body = historyBody(season, "league-b", "mSettings") as {
    settings?: { scoringSettings?: unknown };
  };
  return normalizeSettings(body.settings?.scoringSettings);
}

/** The team-games of the given seasons (dropbacks = attempts + sacks; implied from the line). */
export function teamGames(seasons: readonly number[]): V2TeamGame[] {
  const out: V2TeamGame[] = [];
  for (const s of seasons)
    for (const r of loadTable("team_week", s)) {
      const spread = numOrNull(r.spread);
      const total = numOrNull(r.total_line);
      out.push({
        team: String(r.team),
        season: num(r.season),
        week: num(r.week),
        opponent: str(r.opponent),
        dropbacks: num(r.attempts) + num(r.sacks_suffered),
        rushes: num(r.carries),
        rz_plays: numOrNull(r.rz_plays),
        implied: spread === null || total === null ? null : (total + spread) / 2,
        spread,
        total,
        points_for: numOrNull(r.points_for),
      });
    }
  return out;
}

const worldMemo = new Map<string, BacktestWorld>();
/** The backtest world of the given seasons under `settings` (memoised per label). */
export function buildWorld(
  label: string,
  settings: ScoringSettings,
  seasons: readonly number[] = [2023, 2024, 2025],
): BacktestWorld {
  const key = `${label}|${seasons.join(",")}`;
  const memo = worldMemo.get(key);
  if (memo !== undefined) return memo;
  const ep = new Map<string, Row>();
  for (const s of seasons)
    for (const r of loadTable("ep_week", s))
      ep.set(`${String(r.player_id)}|${String(r.season)}|${String(r.week)}`, r);
  const games = new Map<string, ScoredGame[]>();
  const votes = new Map<string, Map<V2Position, number>>();
  for (const s of seasons)
    for (const r of loadTable("player_week", s)) {
      const id = String(r.player_id);
      const pos = String(r.position) as V2Position;
      const pid = espnPositionForNflverse(pos);
      if (pid === null) continue;
      const e = ep.get(`${id}|${String(r.season)}|${String(r.week)}`);
      const g: ScoredGame = {
        season: num(r.season),
        week: num(r.week),
        team: String(r.team),
        opponent: str(r.opponent_team),
        pass_att: num(r.attempts),
        pass_cmp: num(r.completions),
        pass_yd: num(r.passing_yards),
        pass_td: num(r.passing_tds),
        pass_int: num(r.passing_interceptions),
        sacks: num(r.sacks_suffered),
        sack_fum_lost: num(r.sack_fumbles_lost),
        rush_att: num(r.carries),
        rush_yd: num(r.rushing_yards),
        rush_td: num(r.rushing_tds),
        rush_fum_lost: num(r.rushing_fumbles_lost),
        targets: num(r.targets),
        rec: num(r.receptions),
        rec_yd: num(r.receiving_yards),
        rec_td: num(r.receiving_tds),
        rec_fum_lost: num(r.receiving_fumbles_lost),
        two_pt:
          num(r.passing_2pt_conversions) +
          num(r.rushing_2pt_conversions) +
          num(r.receiving_2pt_conversions),
        snap_pct: numOrNull(r.offense_pct),
        rz_targets: numOrNull(r.rz_targets),
        rz_carries: numOrNull(r.rz_carries),
        gl_carries: numOrNull(r.gl_carries),
        rz_rec_td: numOrNull(r.rz_rec_tds),
        rz_rush_td: numOrNull(r.rz_rush_tds),
        gl_rush_td: numOrNull(r.gl_rush_tds),
        x_rec_td: e === undefined ? null : numOrNull(e.rec_touchdown_exp),
        x_rush_td: e === undefined ? null : numOrNull(e.rush_touchdown_exp),
        x_pass_td: e === undefined ? null : numOrNull(e.pass_touchdown_exp),
        points: score(statLineFromPlayerWeek(r, { position: pid }), settings).points,
      };
      const list = games.get(id) ?? [];
      list.push(g);
      games.set(id, list);
      const v = votes.get(id) ?? new Map<V2Position, number>();
      v.set(pos, (v.get(pos) ?? 0) + 1);
      votes.set(id, v);
    }
  const players: BacktestPlayer[] = [];
  for (const [id, list] of [...games].sort(([a], [b]) => a.localeCompare(b))) {
    const v = votes.get(id) ?? new Map<V2Position, number>();
    let best: V2Position = "WR";
    let n = -1;
    for (const [p, c] of v) if (c > n || (c === n && p < best)) [best, n] = [p, c];
    players.push({ gsis_id: id, position: best, games: list });
  }
  const weather = new Map<string, V2Weather>();
  for (const s of seasons)
    for (const r of loadTable("team_week", s)) {
      const roof = str(r.roof);
      weather.set(teamGameKey(String(r.team), num(r.season), num(r.week)), {
        roof: roof !== null && ROOFS.has(roof) ? (roof as V2Roof) : null,
        temp_f: numOrNull(r.temp),
        wind_mph: numOrNull(r.wind),
        precip_prob: null,
      });
    }
  const reports = new Map<string, BacktestReport>();
  for (const s of seasons)
    for (const r of loadTable("injury_week", s))
      reports.set(`${String(r.gsis_id)}|${String(r.season)}|${String(r.week)}`, {
        designation: str(r.report_status),
        practice: str(r.practice_status),
        team: str(r.team),
      });
  const world: BacktestWorld = {
    players,
    team_games: teamGames(seasons),
    weather,
    reports,
    settings,
  };
  worldMemo.set(key, world);
  return world;
}

/** One league-b box-score entry with ESPN's weekly projection. */
export interface EspnWeekRow {
  readonly espn_id: number;
  readonly gsis_id: string | null;
  readonly position_id: number;
  readonly season: number;
  readonly week: number;
  /** ESPN's projection (statSourceId 1, the week's split) under league-b's S. */
  readonly projection: number;
  /** ESPN's actual (statSourceId 0) under league-b's S; 0 when he recorded none. */
  readonly actual: number;
}

/**
 * league-b's recorded QB/RB/WR/TE box-score entries with a weekly projection, weeks 1–17 of the
 * given seasons (one row per player-week; withheld entries are simply absent — the history
 * manifest's `incomplete` names them).
 */
export function espnWeekRows(seasons: readonly number[] = [2024, 2025]): EspnWeekRow[] {
  const xwalk = new Map<string, string>();
  for (const r of loadTable("espn_xwalk", null)) xwalk.set(String(r.espn_id), String(r.gsis_id));
  const out: EspnWeekRow[] = [];
  for (const season of seasons)
    for (let week = 1; week <= 17; week++) {
      const body = historyBody(season, "league-b", `mBoxscore.sp${String(week)}`) as {
        schedule?: { home?: Side; away?: Side }[];
      };
      const seen = new Set<number>();
      for (const m of body.schedule ?? [])
        for (const side of [m.home, m.away])
          for (const e of side?.rosterForCurrentScoringPeriod?.entries ?? []) {
            const pl = e.playerPoolEntry?.player;
            const id = pl?.id;
            const pos = pl?.defaultPositionId;
            if (typeof id !== "number" || typeof pos !== "number" || pos < 1 || pos > 4) continue;
            if (seen.has(id)) continue;
            const stats = pl?.stats ?? [];
            const proj = stats.find(
              (s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && s.scoringPeriodId === week,
            );
            if (proj === undefined || typeof proj.appliedTotal !== "number") continue;
            const act = stats.find(
              (s) => s.statSourceId === 0 && s.statSplitTypeId === 1 && s.scoringPeriodId === week,
            );
            seen.add(id);
            out.push({
              espn_id: id,
              gsis_id: xwalk.get(String(id)) ?? null,
              position_id: pos,
              season,
              week,
              projection: proj.appliedTotal,
              actual: typeof act?.appliedTotal === "number" ? act.appliedTotal : 0,
            });
          }
    }
  return out;
}

interface EspnStat {
  readonly statSourceId?: number;
  readonly statSplitTypeId?: number;
  readonly scoringPeriodId?: number;
  readonly appliedTotal?: number;
}
interface Side {
  readonly rosterForCurrentScoringPeriod?: {
    readonly entries?: readonly {
      readonly playerPoolEntry?: {
        readonly player?: {
          readonly id?: number;
          readonly defaultPositionId?: number;
          readonly stats?: readonly EspnStat[];
        };
      };
    }[];
  };
}
