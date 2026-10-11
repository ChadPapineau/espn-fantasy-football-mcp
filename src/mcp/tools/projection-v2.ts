// projection-v2.ts — E1's `v2-opportunity` under EFF_TOOLSET=full (plan 07 E1: P0 "v1-ensemble" →
// "v2-opportunity"; plan 10 §3.3 C1: `basis: "player_sim"` where the opportunity inputs exist). The
// domain model (src/domain/analytics/projections-v2) is pure; this module assembles its inputs from
// the local datasets — the player's nflverse games (stats_player_week + the snap/pbp usage extras +
// ffopportunity's expected TDs), every team-game's volume (stats_team_week) joined to its market line
// and score (schedules), the target week's market, opponent and venue weather, the season's regressed
// matchup table (every rostered player's points before the week, memoised per data version), the
// official practice report — and merges v2's FIRST-WEEK distributions into E1's v1 outcome. The
// ensemble weight is WEIGHT_ESPN_V2 (1.0: ESPN's mean stays the point estimate — ADV OBJ-02, plan 10
// B14) unless a human applied a tuned `weight_espn` with `eff tune --apply`; every other tuned value
// reaches the model through applyTunedOverrides. Players v2 does not model (K, D/ST, no gsis id, no
// NFL team, a bye, no game history) keep v1's distribution — the labels stay exactly as designed:
// `meta.estimate: true`, `data.inputs[]`, `inputs.espn` / `weight_espn` per week. Reads never block
// the loop for long: one statement per step with a turn between (plan 03 §1.2, plan 10 A16a). Any
// failure here degrades to v1 with a fixed-vocabulary warning (never an error for the call). New here.
import {
  DEFAULT_V2_PARAMS,
  MODEL_VERSION_V2,
  V2_SIMS,
  WEIGHT_ESPN_V2,
  applyTunedOverrides,
  buildMatchupTable,
  expectedCounts,
  isV2Position,
  projectV2,
  type MatchupRow,
  type V2Availability,
  type V2Game,
  type V2Market,
  type V2MatchupTable,
  type V2Outcome,
  type V2PlayerDetail,
  type V2Position,
  type V2Roof,
  type V2Target,
  type V2TeamGame,
  type V2Weather,
} from "../../domain/analytics/projections-v2/index.js";
import type {
  ProjectedPlayer,
  ProjectedWeek,
  ProjectionOutcome,
} from "../../domain/analytics/index.js";
import { GAME_DAY_WINDOW_MS, type Projection } from "../../domain/analytics/types.js";
import type { NflGame, PlayerWeekLine } from "../../domain/analytics/types.js";
import type { Rng } from "../../domain/clock.js";
import { teamOfProTeamId } from "../../domain/crosswalk/teams.js";
import type { Week } from "../../domain/league/types.js";
import { score } from "../../domain/scoring/engine.js";
import type { ScoringSettings } from "../../domain/scoring/types.js";
import type { NflTeam } from "../../config/schema.js";
import { toDataInputs, type InputStamp } from "../envelope.js";
import type { ToolContext } from "../define.js";
import { optionalDataset, turn } from "./common.js";

/** One E1 subject (analytics.ts Subject — repeated here to keep this module import-cycle free). */
export interface V2Subject {
  readonly p: {
    readonly ref: { readonly id: number };
    readonly position: string;
    readonly position_id: number;
    readonly pro_team_id: number | null;
    readonly injury_status: string | null;
    readonly name: V2Target["name"];
  };
  readonly gsis: string | null;
}

/** What v2 needs from the call besides the subjects. */
export interface V2CallOptions {
  readonly season: number;
  readonly week: Week;
  readonly settings: ScoringSettings;
  readonly rng: Rng;
  readonly allowStale: boolean;
  /** Samples per player (shared down by projectV2's line budget); default V2_SIMS.default. */
  readonly n_sims?: number;
  readonly include_stat_line?: boolean;
  readonly deadline_ms: number | null;
}

/** Why a QB/RB/WR/TE subject was not served by v2 (fixed vocabulary — no third-party text). */
export type V2Skip =
  | "no_gsis_id"
  | "no_nfl_team"
  | "bye"
  | "inputs_not_loaded"
  | "position_not_modelled"
  | "no_team"
  | "no_history";

/** The most regular-season weeks a prior season's window reads (nflverse REG weeks 1–18). */
export const V2_PRIOR_WEEKS = 18;

/** Samples per player when E1 is called in bulk (projectMany — trade, waivers, schedule). */
export const V2_BULK_SIMS = V2_SIMS.min;

/** The ensemble weight in effect: a human-applied tuned value, else the shipped one. */
export function weightEspnOf(ctx: ToolContext): number {
  const t = ctx.options.tuned?.values;
  if (t === undefined || !Object.hasOwn(t, "weight_espn")) return WEIGHT_ESPN_V2;
  return (
    applyTunedOverrides(DEFAULT_V2_PARAMS, { weight_espn: t.weight_espn ?? NaN }).weight_espn ??
    WEIGHT_ESPN_V2
  );
}

const fin = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x);
const nz = (x: number | null | undefined): number => (fin(x) ? x : 0);

/** A player-week line as v2's per-game counts (fumbles lost are read only as a sum). */
export function v2GameOf(
  l: PlayerWeekLine,
  xtd: { rec: number | null; rush: number | null; pass: number | null } | null,
): V2Game {
  const v = l.line.values;
  const u = l.usage;
  return {
    season: l.season,
    week: l.week,
    team: l.nfl_team,
    opponent: l.opponent,
    pass_att: nz(v.pass_att),
    pass_cmp: nz(v.pass_cmp),
    pass_yd: nz(v.pass_yd),
    pass_td: nz(v.pass_td),
    pass_int: nz(v.pass_int),
    sacks: nz(v.sacked),
    // the canonical line carries fumbles lost as one total; v2 reads only their sum (rates.ts)
    sack_fum_lost: 0,
    rush_att: nz(v.rush_att),
    rush_yd: nz(v.rush_yd),
    rush_td: nz(v.rush_td),
    rush_fum_lost: nz(v.fum_lost),
    targets: nz(v.targets),
    rec: nz(v.rec),
    rec_yd: nz(v.rec_yd),
    rec_td: nz(v.rec_td),
    rec_fum_lost: 0,
    two_pt: nz(v.two_pt_total),
    snap_pct: u?.snap_pct ?? null,
    rz_targets: u?.rz_targets ?? null,
    rz_carries: u?.rz_carries ?? null,
    gl_carries: u?.gl_carries ?? null,
    // the per-location TD counts are not in the store's usage extras: the league rates come from
    // ffopportunity's expectations, else the priors (expectation.ts tdRate's order)
    rz_rec_td: null,
    rz_rush_td: null,
    gl_rush_td: null,
    x_rec_td: xtd?.rec ?? null,
    x_rush_td: xtd?.rush ?? null,
    x_pass_td: xtd?.pass ?? null,
  };
}

/** The team side of one schedule row: implied total, team-side spread (> 0 favoured), total, score. */
export function teamSideOf(
  g: NflGame,
  team: NflTeam,
): {
  implied: number | null;
  spread: number | null;
  total: number | null;
  points: number | null;
  opponent: NflTeam;
} | null {
  const home = g.home === team;
  if (!home && g.away !== team) return null;
  const l = g.lines;
  const spreadHome = l?.spread_line ?? null;
  return {
    implied: l === null ? null : home ? l.implied.home : l.implied.away,
    spread: spreadHome === null ? null : home ? spreadHome : -spreadHome,
    total: l?.total_line ?? null,
    points: g.score === null ? null : home ? g.score.home : g.score.away,
    opponent: home ? g.away : g.home,
  };
}

/** The availability evidence of one subject (plan 07 D2: ESPN's status alone inside the window). */
export function availabilityOf(
  espnStatus: string | null,
  official: {
    readonly report_status: string | null;
    readonly practice: readonly { readonly status: string }[];
  } | null,
  gameDay: boolean,
): V2Availability {
  // ESPN's enum is the platform's current fact: a non-ACTIVE status wins; otherwise the official
  // designation of the week (the table was fitted on official designations), with its last practice
  const espn = espnStatus !== null && espnStatus !== "ACTIVE" ? espnStatus : null;
  if (gameDay) return { designation: espn, practice: null, game_day: true };
  const last = official?.practice[official.practice.length - 1]?.status ?? null;
  return {
    designation: espn ?? official?.report_status ?? null,
    practice: last,
  };
}

/**
 * Adds a dataset stamp unless the call already carries the same one (source, version instant and
 * fetch instant): v2 re-reads files v1 already stamped (the stats file, the weekly rosters), and a
 * repeated row would only spend the C8 size budget.
 */
export function addInput(inputs: InputStamp[], st: InputStamp): void {
  if (
    inputs.some(
      (i) => i.source === st.source && i.as_of === st.as_of && i.fetched_at === st.fetched_at,
    )
  )
    return;
  inputs.push(st);
}

/** The process-wide matchup-table memo (keyed by season, week, S and both files' versions). */
const MATCHUP_MEMO = new Map<string, V2MatchupTable | null>();
/** Most tables kept (a server sees one league; a week change adds one). */
export const MATCHUP_MEMO_MAX = 8;

/** Player-weeks the matchup table scores per turn of the event loop. */
export const MATCHUP_SCORE_PER_TURN = 400;

/** Clears the memo (tests). */
export function clearMatchupMemo(): void {
  MATCHUP_MEMO.clear();
}

/**
 * The season's regressed matchup table before `week` (projections-v2 buildMatchupTable): every
 * rostered player's points under S per week — one statement and one scoring pass per turn — memoised
 * per (season, week, settings hash, the stats and weekly-roster files' versions). Null without a
 * completed week or a player universe (the multiplier is then neutral, said once).
 */
export async function matchupTableFor(
  ctx: ToolContext,
  season: number,
  week: Week,
  settings: ScoringSettings,
  allowStale: boolean,
  inputs: InputStamp[],
  warnings: string[],
): Promise<V2MatchupTable | null> {
  if (week <= 1) return null;
  const statsV = ctx.services.refreshLog.latest("nflverse:stats_player_week")?.file_version ?? "-";
  const rosterV = ctx.services.refreshLog.latest("nflverse:roster_weekly")?.file_version ?? "-";
  const key = [season, week, settings.settings_hash, statsV, rosterV].join("|");
  if (MATCHUP_MEMO.has(key)) return MATCHUP_MEMO.get(key) ?? null;
  const roster = ctx.services.rosterWeekly.latest(season);
  const rIn = optionalDataset(roster, ctx.nowMs, allowStale);
  const gsis = rIn === null ? [] : [...new Set(roster.rows.map((r) => r.gsis_id))];
  if (rIn === null || gsis.length === 0) {
    warnings.push("v2-opportunity: no player universe for the matchup table: the multiplier is 1");
    return null;
  }
  addInput(inputs, rIn);
  const rows: MatchupRow[] = [];
  let version: string | null = null;
  for (let w = 1; w < week; w++) {
    await turn();
    const r = ctx.services.datasets.playerWeeks.lines(gsis, season, [w], { usage: false });
    const stamp = optionalDataset(r, ctx.nowMs, allowStale);
    if (stamp === null) break;
    const v = r.stamp?.file_version ?? null;
    if (version === null) {
      version = v;
      addInput(inputs, stamp);
    } else if (v !== version) {
      // a refresh published a new file between two weeks: answer without the table this call
      warnings.push("v2-opportunity: the stats file changed mid-read: the matchup multiplier is 1");
      return null;
    }
    for (const [n, l] of r.rows.entries()) {
      // a week of the whole NFL is scored in slices, a turn between (plan 03 §1.2: no long task)
      if (n > 0 && n % MATCHUP_SCORE_PER_TURN === 0) await turn();
      const pos = l.position === "FB" ? "RB" : l.position;
      if (!isV2Position(pos)) continue;
      let pts: number;
      try {
        pts = score(l.line, settings).points;
      } catch {
        continue;
      }
      rows.push({
        season: l.season,
        week: l.week,
        team: l.nfl_team,
        opponent: l.opponent,
        position: pos,
        points: pts,
      });
    }
  }
  await turn();
  const table = rows.length === 0 ? null : buildMatchupTable(rows, season, week);
  if (MATCHUP_MEMO.size >= MATCHUP_MEMO_MAX) {
    const oldest = MATCHUP_MEMO.keys().next().value;
    if (oldest !== undefined) MATCHUP_MEMO.delete(oldest);
  }
  MATCHUP_MEMO.set(key, table);
  return table;
}

/** What v2 produced for a call (the merge input) plus the skipped subjects. */
export interface V2Run {
  readonly outcome: V2Outcome | null;
  readonly skipped: ReadonlyMap<number, V2Skip>;
}

const ROOFS: ReadonlySet<string> = new Set(["outdoors", "open", "closed", "dome"]);

/**
 * Runs projectV2 over the subjects v2 can model this week. `v1` is E1's v1 outcome (its first-week
 * facts: bye, ESPN mean, kickoff). Returns null outcome when nothing is modelled or a required
 * dataset was never loaded (the skips say why).
 */
export async function runV2(
  ctx: ToolContext,
  subjects: readonly V2Subject[],
  v1: ProjectionOutcome,
  o: V2CallOptions,
  inputs: InputStamp[],
  warnings: string[],
): Promise<V2Run> {
  const skipped = new Map<number, V2Skip>();
  const firstOf = new Map<number, ProjectedWeek>();
  for (const pp of v1.players) {
    const w0 = pp.weeks[0];
    if (pp.target.player_id !== null && w0 !== undefined) firstOf.set(pp.target.player_id, w0);
  }
  const eligible: { s: V2Subject; team: NflTeam; gsis: string; first: ProjectedWeek }[] = [];
  for (const s of subjects) {
    if (!isV2Position(s.p.position)) continue;
    const id = s.p.ref.id;
    const team = teamOfProTeamId(s.p.pro_team_id);
    const first = firstOf.get(id);
    if (s.gsis === null) skipped.set(id, "no_gsis_id");
    else if (team === null) skipped.set(id, "no_nfl_team");
    else if (first === undefined || first.bye || first.week !== o.week) skipped.set(id, "bye");
    else eligible.push({ s, team, gsis: s.gsis, first });
  }
  if (eligible.length === 0) return { outcome: null, skipped };
  const notLoaded = (why: string): V2Run => {
    warnings.push(`v2-opportunity: ${why} not loaded: v1-ensemble serves`);
    for (const e of eligible) skipped.set(e.s.p.ref.id, "inputs_not_loaded");
    return { outcome: null, skipped };
  };
  const season = o.season;
  const now: Week[] = Array.from({ length: Math.max(0, o.week - 1) }, (_, i) => i + 1);
  const prior: Week[] = Array.from({ length: V2_PRIOR_WEEKS }, (_, i) => i + 1);
  const windows = [
    [season, now],
    [season - 1, prior],
  ] as const;
  const gsis = [...new Set(eligible.map((e) => e.gsis))];

  // the players' games (stat lines with the usage extras) and their expected TDs
  const lines: PlayerWeekLine[] = [];
  let anyLines = false;
  for (const [yr, weeks] of windows) {
    if (weeks.length === 0) continue;
    await turn();
    // the usage extras (snap share, red-zone counts) for the current season only: the prior
    // season's eighteen weeks of them were one long statement (the stall bound), and v2 reads the
    // role metric and location from the recent games first (null → opportunity share / xTD)
    const r = ctx.services.datasets.playerWeeks.lines(gsis, yr, weeks, { usage: yr === season });
    const st = optionalDataset(r, ctx.nowMs, o.allowStale);
    if (st === null) continue;
    anyLines = true;
    addInput(inputs, st);
    lines.push(...r.rows);
  }
  if (!anyLines) return notLoaded("nflverse:stats_player_week");
  const xtd = new Map<string, { rec: number | null; rush: number | null; pass: number | null }>();
  for (const [yr, weeks] of windows) {
    if (weeks.length === 0) continue;
    await turn();
    const r = ctx.services.datasets.epWeekly.rows(gsis, yr, weeks);
    const st = optionalDataset(r, ctx.nowMs, o.allowStale);
    if (st === null) continue;
    addInput(inputs, st);
    for (const e of r.rows)
      xtd.set(`${e.gsis_id}|${String(e.season)}|${String(e.week)}`, {
        rec: e.x_rec_td ?? null,
        rush: e.x_rush_td ?? null,
        pass: e.x_pass_td ?? null,
      });
  }
  const gamesOf = new Map<string, V2Game[]>();
  const rzTeam = new Map<string, number>();
  for (const l of lines) {
    const k = `${l.gsis_id}|${String(l.season)}|${String(l.week)}`;
    const list = gamesOf.get(l.gsis_id) ?? [];
    list.push(v2GameOf(l, xtd.get(k) ?? null));
    gamesOf.set(l.gsis_id, list);
    const rz = l.usage?.rz_team;
    if (fin(rz)) rzTeam.set(`${l.nfl_team}|${String(l.season)}|${String(l.week)}`, rz);
  }

  // every team-game the windows touch: volume (stats_team_week) + the line and score (schedules)
  const reader = ctx.services.datasets.teamWeek;
  if (reader === undefined) return notLoaded("nflverse:stats_team_week");
  const teams = new Set<NflTeam>(eligible.map((e) => e.team));
  for (const l of lines) teams.add(l.nfl_team);
  const teamGames: V2TeamGame[] = [];
  let anyTeam = false;
  const marketOf = new Map<NflTeam, V2Market>();
  const opponentOf = new Map<NflTeam, NflTeam>();
  const gameIdOf = new Map<NflTeam, { id: string; roof: string | null }>();
  for (const [yr, weeks] of windows) {
    const target = yr === season ? [...weeks, o.week] : [...weeks];
    await turn();
    const g = ctx.services.datasets.nflGames.games(yr, target);
    const gi = optionalDataset(g, ctx.nowMs, o.allowStale);
    if (gi !== null) addInput(inputs, gi);
    const side = new Map<string, ReturnType<typeof teamSideOf>>();
    for (const row of g.rows)
      for (const t of [row.home, row.away]) {
        const s = teamSideOf(row, t);
        side.set(`${t}|${String(row.week)}`, s);
        if (yr === season && row.week === o.week && s !== null) {
          marketOf.set(t, { implied: s.implied, spread: s.spread, total: s.total });
          opponentOf.set(t, s.opponent);
          gameIdOf.set(t, { id: row.game_id, roof: row.roof });
        }
      }
    if (weeks.length === 0) continue;
    await turn();
    const r = reader.lines([...teams], yr, weeks);
    const st = optionalDataset(r, ctx.nowMs, o.allowStale);
    if (st === null) continue;
    anyTeam = true;
    addInput(inputs, st);
    for (const t of r.rows) {
      if (t.season_type !== "REG") continue;
      const s = side.get(`${t.nfl_team}|${String(t.week)}`) ?? null;
      teamGames.push({
        team: t.nfl_team,
        season: t.season,
        week: t.week,
        opponent: t.opponent ?? s?.opponent ?? null,
        dropbacks: fin(t.attempts) && fin(t.sacks) ? t.attempts + t.sacks : null,
        rushes: t.carries,
        rz_plays: rzTeam.get(`${t.nfl_team}|${String(t.season)}|${String(t.week)}`) ?? null,
        implied: s?.implied ?? null,
        spread: s?.spread ?? null,
        total: s?.total ?? null,
        points_for: s?.points ?? null,
      });
    }
  }
  if (!anyTeam) return notLoaded("nflverse:stats_team_week");

  // the target week's venue weather (outdoor terms only — weather.ts) and the matchup table
  const weather: Record<string, V2Weather> = {};
  const ids = [...new Set([...gameIdOf.values()].map((x) => x.id))];
  if (ids.length > 0) {
    await turn();
    const wx = ctx.services.datasets.weather.forGames(ids);
    const wi = optionalDataset(wx, ctx.nowMs, o.allowStale);
    if (wi !== null) addInput(inputs, wi);
    const obs = new Map(wx.rows.map((r) => [r.game_id, r]));
    for (const [t, g] of gameIdOf) {
      const roof = g.roof !== null && ROOFS.has(g.roof) ? (g.roof as V2Roof) : null;
      const ob = obs.get(g.id);
      weather[t] = {
        roof,
        temp_f: ob?.temp_f ?? null,
        wind_mph: ob?.wind_mph ?? null,
        precip_prob: ob?.precip_prob ?? null,
      };
    }
  }
  const matchup = await matchupTableFor(
    ctx,
    season,
    o.week,
    o.settings,
    o.allowStale,
    inputs,
    warnings,
  );

  // availability: ESPN's status, the week's official report and its last practice
  await turn();
  const reports = ctx.services.datasets.injuries.reports(season, o.week, gsis);
  const ri = optionalDataset(reports, ctx.nowMs, o.allowStale);
  if (ri !== null) addInput(inputs, ri);
  const reportOf = new Map(reports.rows.map((r) => [r.gsis_id, r]));

  const nowMs = ctx.nowMs;
  const targets: V2Target[] = eligible.map((e) => {
    const k = e.first.kickoff_ms;
    const gameDay = k !== null && k > nowMs && k - nowMs <= GAME_DAY_WINDOW_MS;
    const rep = reportOf.get(e.gsis) ?? null;
    return {
      player_id: e.s.p.ref.id,
      gsis_id: e.gsis,
      name: e.s.p.name,
      position: e.s.p.position as V2Position,
      position_id: e.s.p.position_id,
      team: e.team,
      games: gamesOf.get(e.gsis) ?? [],
      espn_mean: e.first.espn,
      availability: availabilityOf(
        e.s.p.injury_status,
        rep === null
          ? null
          : {
              report_status: rep.report_status,
              practice: rep.practice.map((x) => ({ status: x.status })),
            },
        gameDay,
      ),
    };
  });
  const opponents: Record<string, string | null> = {};
  const markets: Record<string, V2Market> = {};
  for (const e of eligible) {
    opponents[e.team] = opponentOf.get(e.team) ?? null;
    const m = marketOf.get(e.team);
    if (m !== undefined) markets[e.team] = m;
  }
  const tuned = applyTunedOverrides(DEFAULT_V2_PARAMS, ctx.options.tuned?.values ?? {});
  await turn();
  const outcome = await projectV2({
    targets,
    season,
    week: o.week,
    settings: o.settings,
    team_games: teamGames,
    markets,
    weather,
    opponents,
    matchup,
    params: tuned.params,
    weight_espn: weightEspnOf(ctx),
    n_sims: o.n_sims ?? V2_SIMS.default,
    clock: ctx.services.clock,
    rng: o.rng,
    deadline_ms: o.deadline_ms,
    include_stat_line: o.include_stat_line === true,
    inputs: toDataInputs(inputs, ctx.nowMs),
  });
  for (const d of outcome.details)
    if (d.skipped !== null && d.player_id !== null) skipped.set(d.player_id, d.skipped as V2Skip);
  return { outcome, skipped };
}

/** The assumption a QB/RB/WR/TE subject not served by v2 carries (server text). */
export function skipAssumption(why: V2Skip): { text: string; revisit_trigger: string } {
  return {
    text: `v2-opportunity did not model this player (${why}): v1-ensemble's distribution is served`,
    revisit_trigger: "the opportunity inputs exist for him",
  };
}

const ASSUMPTIONS_MAX = 20;
const DRIVERS_MAX = 20;

/**
 * Merges v2's first-week projections into the v1 outcome: for each player v2 modelled, week 1's
 * Dist (basis player_sim), P(active) and its basis, the own mean, the turnover tail, the drivers, the
 * role confidence and (when asked) the expected stat line come from v2; the opponent and implied
 * total keep E1's ESPN spelling; later weeks and the ROS total stay v1's. `model_version` becomes
 * "v2-opportunity" when at least one player was served by it.
 */
export function mergeV2(
  v1: ProjectionOutcome,
  run: V2Run,
  includeStatLine: boolean,
): ProjectionOutcome {
  const out = run.outcome;
  const byId = new Map<number, { proj: Projection; detail: V2PlayerDetail }>();
  if (out !== null) {
    const details = new Map(out.details.map((d) => [d.player_id, d]));
    for (const p of out.data.projections) {
      const d = p.player_id === null ? undefined : details.get(p.player_id);
      if (p.player_id !== null && d !== undefined && d.dist !== null)
        byId.set(p.player_id, { proj: p, detail: d });
    }
  }
  let served = 0;
  const players: ProjectedPlayer[] = v1.players.map((pp) => {
    const id = pp.target.player_id;
    const hit = id === null ? undefined : byId.get(id);
    if (hit === undefined) {
      const why = id === null ? undefined : run.skipped.get(id);
      if (why === undefined) return pp;
      const a = skipAssumption(why);
      const assumptions = [...pp.projection.assumptions, a].slice(0, ASSUMPTIONS_MAX);
      return { ...pp, projection: { ...pp.projection, assumptions } };
    }
    served += 1;
    const { proj, detail } = hit;
    const v2w = proj.weeks[0];
    const w0 = pp.weeks[0];
    const pw0 = pp.projection.weeks[0];
    if (v2w === undefined || w0 === undefined || pw0 === undefined || detail.dist === null)
      return pp;
    const week0: ProjectedWeek = {
      ...w0,
      dist: detail.dist,
      p_active: detail.p_active,
      p_active_basis: detail.p_active_basis,
      own: detail.own?.mean ?? w0.own,
      turnover_e: detail.turnover?.expected_points ?? 0,
    };
    const seen = new Set<string>();
    const assumptions = [...proj.assumptions, ...pp.projection.assumptions]
      .filter((a) => {
        if (seen.has(a.text)) return false;
        seen.add(a.text);
        return true;
      })
      .slice(0, ASSUMPTIONS_MAX);
    const projection: Projection = {
      ...pp.projection,
      weeks: [
        {
          ...v2w,
          opponent: pw0.opponent,
          implied_total: pw0.implied_total ?? v2w.implied_total,
        },
        ...pp.projection.weeks.slice(1),
      ],
      drivers: proj.drivers.slice(0, DRIVERS_MAX),
      role_confidence_games: proj.role_confidence_games,
      assumptions,
      ...(includeStatLine && detail.expectation !== null
        ? { stat_line_expectation: expectedCounts(detail.expectation) }
        : {}),
    };
    return { ...pp, projection, weeks: [week0, ...pp.weeks.slice(1)] };
  });
  if (out === null && served === 0 && run.skipped.size === 0) return v1;
  const warnings = [...v1.warnings];
  for (const w of out?.warnings ?? []) if (!warnings.includes(w)) warnings.push(w);
  return {
    data: {
      ...v1.data,
      model_version: served > 0 ? MODEL_VERSION_V2 : v1.data.model_version,
      projections: players.map((p) => p.projection),
    },
    players,
    partial: v1.partial || (out?.partial ?? false),
    warnings,
  };
}

/** Projections stored per turn of the event loop (best-effort SQLite writes — plan 03 §1.2). */
export const STORE_PER_TURN = 10;

/**
 * Stores each v2-served player's projection for the retrospective (plan 08 §5 `projection`; plan 10
 * C9: the attribution joins it to the final box score): the expected line CONDITIONAL ON PLAYING,
 * the P(active) used, the reported mean and the tuning trace — no samples (attribution needs none).
 * Best-effort: a busy store skips a row; a row with the same inputs and expectation as the newest
 * earlier one adds nothing (repo dedup), so repeated calls do not grow the table.
 */
export async function storeV2(
  ctx: ToolContext,
  run: V2Run,
  season: number,
  week: Week,
  inputs: readonly InputStamp[],
): Promise<number> {
  const out = run.outcome;
  if (out === null) return 0;
  const asOf = inputs.reduce<string | null>(
    (m, i) => (m === null || i.as_of > m ? i.as_of : m),
    null,
  );
  const madeAt = ctx.services.clock.nowIso();
  let stored = 0;
  let k = 0;
  for (const d of out.details) {
    if (d.player_id === null || d.player_id === 0 || d.expectation === null || d.dist === null)
      continue;
    if (k > 0 && k % STORE_PER_TURN === 0) await turn();
    k += 1;
    try {
      const r = ctx.services.projections.put({
        player_id: d.player_id,
        gsis_id: d.gsis_id,
        season,
        week,
        model_version: MODEL_VERSION_V2,
        made_at: madeAt,
        inputs_as_of: asOf ?? madeAt,
        expectation: expectedCounts(d.expectation),
        samples: [],
        p_active: d.p_active,
        reported_mean: d.dist.mean,
        trace:
          d.trace === undefined ? null : (d.trace as unknown as Readonly<Record<string, unknown>>),
      });
      if (r.written) stored += 1;
    } catch {
      // a row the store refuses is skipped: the answer never depends on the write
    }
  }
  return stored;
}
