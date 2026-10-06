// datasets.ts — the P0 dataset-read tools (plan 07 §3.D): D2 espn_get_injuries (ESPN's status —
// what the league enforces — beside the official nflverse report — why — with `ir_eligible` and a
// first-cut `p_active`; game day (a kickoff within 3 h) reads availability from ESPN's enum alone —
// sib ADV OBJ-16) and D3 espn_get_schedule (kickoffs, byes, lock and final flags from ESPN's pro
// schedule joined on the ESPN game id to nflverse lines, roof, rest and weather — research 04
// §B.1.6; lines/weather missing → null, never an error). Both keep openWorldHint: true (plan 07 D2,
// D3) because they may make one ESPN request.
import { z } from "zod/v4";
import { pActiveOf } from "../../domain/analytics/projection.js";
import {
  GAME_DAY_WINDOW_MS,
  type InjuriesData,
  type InjuryReport,
  type NflGame,
  type PActiveBasis,
  type ScheduleData,
  type WeatherObservation,
} from "../../domain/analytics/types.js";
import {
  byesByWeek,
  gameStateOf,
  gamesOfWeek,
  kickoffMsOf,
  kickoffOf,
  teamGame,
} from "../../domain/league/schedule.js";
import { isIrEligible, type InjuryStatus, type PlatformPlayer } from "../../domain/league/types.js";
import {
  BOUNDS,
  analyticsFreshnessShape,
  nflTeamSchema,
  playerSelectorSchema,
  weekSchema,
} from "../bounds.js";
import { TRUNCATION_HINTS, bareTextSchema, type InputStamp } from "../envelope.js";
import { EffError } from "../errors.js";
import { defineTool } from "../define.js";
import {
  crosswalkOf,
  leagueOf,
  optionalDataset,
  present,
  proTeamAbbrev,
  scheduleOf,
  weekOf,
} from "./common.js";
import {
  gsisOrNull,
  injuryStatus,
  iso,
  isoNull,
  playerId,
  playerName,
  position,
  probNull,
  proTeam,
  proTeamNull,
  utOrNull,
  week,
} from "./schemas.js";
import { selectPlayers } from "./select.js";

// --- D2 espn_get_injuries ---------------------------------------------------------------------------

/** The fixed base-rate note (sibling research §3.5). */
export const BASE_RATES_NOTE = "Questionable → played 71 % (sib §3.5)";

/** D2 data (plan 07 D2; InjuriesData). */
export const injuriesSchema = z.strictObject({
  players: z
    .array(
      z.strictObject({
        player_id: playerId.nullable(),
        gsis_id: gsisOrNull,
        name: playerName,
        position,
        pro_team: proTeamNull,
        espn: z.strictObject({
          injury_status: injuryStatus,
          injured: z.boolean(),
          ir_eligible: z.boolean().nullable(),
          last_news_at: isoNull,
          as_of: z.null(),
        }),
        official: z
          .strictObject({
            report_status: bareTextSchema("nflverse.injuries.report_status").nullable(),
            practice: z
              .array(
                z.strictObject({
                  day: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/),
                  status: bareTextSchema("nflverse.injuries.practice_status"),
                }),
              )
              .max(10),
            primary_injury: utOrNull,
            secondary_injury: utOrNull,
            report_week: week.nullable(),
            as_of: iso,
          })
          .nullable(),
        p_active: probNull,
        p_active_basis: z.enum([
          "designation_base_rate",
          "espn_gameday_status",
          "trend_model",
          "none",
        ]),
        trend: z.enum(["improving", "flat", "worsening"]).nullable(),
        sources_agree: z.boolean().nullable(),
        game_day: z.boolean(),
      }),
    )
    .max(60),
  base_rates_note: z.string().max(120),
});

/** A practice status as a score (DNP 0, limited 1, full 2); null when unreadable. */
export function practiceScore(status: string): number | null {
  const s = status.toLowerCase();
  if (s.includes("did not") || s === "dnp" || s.includes("out")) return 0;
  if (s.includes("limited")) return 1;
  if (s.includes("full")) return 2;
  return null;
}

/** The practice trend over the week's reports (first vs last readable status). */
export function practiceTrend(
  practice: readonly { readonly status: string }[],
): "improving" | "flat" | "worsening" | null {
  const scores = present(practice.map((p) => practiceScore(p.status)));
  if (scores.length < 2) return null;
  const first = scores[0] ?? 0;
  const last = scores[scores.length - 1] ?? 0;
  return last > first ? "improving" : last < first ? "worsening" : "flat";
}

/** Whether ESPN's enum and the official report status say the same thing (null when not comparable). */
export function sourcesAgree(espn: InjuryStatus | null, report: string | null): boolean | null {
  if (espn === null || report === null) return null;
  const r = report.toLowerCase();
  const official: InjuryStatus | null = r.startsWith("out")
    ? "OUT"
    : r.startsWith("doubt")
      ? "DOUBTFUL"
      : r.startsWith("quest")
        ? "QUESTIONABLE"
        : null;
  if (official === null) return null;
  const e = espn === "INJURY_RESERVE" ? "OUT" : espn;
  return e === official;
}

/** D2 `espn_get_injuries`. */
export const getInjuries = defineTool({
  name: "espn_get_injuries",
  description:
    "Injuries (default: my roster): ESPN's designation (league-enforced, ir_eligible) beside the official report and practice trend; base-rate p_active.",
  input: z.strictObject({
    players: playerSelectorSchema.optional(),
    only_flagged: z.boolean().default(false),
    week: weekSchema.optional(),
    ...analyticsFreshnessShape,
  }),
  data: injuriesSchema,
  budget: "list",
  opaqueInput: {
    players:
      "PlayerSelector: exactly one of {player_ids:[<=25]}, {gsis_ids:[<=25]}, {team_id}, {nfl_team}, {pool:{status,position,top<=50}}; default my roster",
  },
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const league = await leagueOf(ctx, inputs);
    const w = weekOf(league, args.week);
    const allowStale = args.allow_stale === true;
    const sel = await selectPlayers(
      ctx,
      args.players,
      league.my_team?.team_id ?? null,
      w,
      inputs,
      warnings,
    );
    if (sel.missing > 0) warnings.push(`${String(sel.missing)} requested player(s) not found`);
    const sched = await scheduleOf(ctx, league.ref.season, inputs, allowStale).catch(() => null);
    const games = sched === null ? [] : gamesOfWeek(sched.schedule, w);
    const ids = sel.players.map((p) => ({ p, xw: crosswalkOf(ctx, p.ref.id, p.position_id) }));
    const gsis = present(ids.map((x) => x.xw.gsis_id));
    const reports = ctx.services.datasets.injuries.reports(league.ref.season, w, gsis);
    const repInput = optionalDataset(reports, ctx.nowMs, allowStale);
    if (repInput !== null) inputs.push(repInput);
    else warnings.push("nflverse:injuries unavailable or past its hard limit: official is null");
    const byGsis = new Map<string, InjuryReport>();
    if (repInput !== null) for (const r of reports.rows) byGsis.set(r.gsis_id, r);
    const rows: InjuriesData["players"][number][] = [];
    for (const { p, xw } of ids) {
      const game = p.pro_team_id > 0 ? teamGame(games, p.pro_team_id) : null;
      const kickoff = game === null ? null : kickoffMsOf(game);
      const gameDay =
        kickoff !== null && kickoff > ctx.nowMs && kickoff - ctx.nowMs <= GAME_DAY_WINDOW_MS;
      const rep = xw.gsis_id === null ? undefined : byGsis.get(xw.gsis_id);
      const pa = pActiveOf(p.injury_status, kickoff, ctx.nowMs);
      const basis: PActiveBasis = pa.basis;
      const official =
        rep === undefined
          ? null
          : {
              report_status: rep.report_status,
              practice: rep.practice
                .filter((x) => /^[A-Za-z0-9_-]{1,16}$/.test(x.day))
                .slice(0, 10)
                .map((x) => ({ day: x.day, status: x.status })),
              primary_injury: rep.primary_injury,
              secondary_injury: rep.secondary_injury,
              report_week: rep.week,
              as_of: rep.as_of,
            };
      const flagged =
        (p.injury_status !== null && p.injury_status !== "ACTIVE") ||
        (official?.report_status ?? null) !== null;
      if (args.only_flagged && !flagged) continue;
      rows.push({
        player_id: p.ref.id,
        gsis_id: xw.gsis_id,
        name: p.name,
        position: p.position,
        pro_team: p.pro_team,
        espn: {
          injury_status: p.injury_status,
          injured: p.injured,
          ir_eligible: isIrEligible(p.injury_status),
          last_news_at: p.last_news_at,
          as_of: null,
        },
        official,
        p_active: pa.p,
        p_active_basis: basis,
        trend: official === null ? null : practiceTrend(official.practice),
        sources_agree: gameDay
          ? null
          : sourcesAgree(p.injury_status, official?.report_status ?? null),
        game_day: gameDay,
      });
    }
    const data: InjuriesData = { players: rows, base_rates_note: BASE_RATES_NOTE };
    return { data, inputs, warnings, listKey: "players", week: w };
  },
});

// --- D3 espn_get_schedule ---------------------------------------------------------------------------

/** A game's assumed duration for lock windows (a window closes this long after its kickoff) [A]. */
export const GAME_DURATION_MS = 3.5 * 60 * 60 * 1000;

const linesSchema = z.strictObject({
  spread_line: z.number().nullable(),
  total_line: z.number().nullable(),
  implied: z.strictObject({ away: z.number().nullable(), home: z.number().nullable() }),
  moneyline: z.strictObject({ away: z.number().nullable(), home: z.number().nullable() }),
  as_of: iso,
});

/** D3 data (plan 07 D3; ScheduleData). */
export const scheduleSchema = z.strictObject({
  games: z
    .array(
      z.strictObject({
        espn_game_id: z.number().int().min(0),
        week,
        kickoff: isoNull,
        start_time_tbd: z.boolean(),
        valid_for_locking: z.boolean(),
        stats_official: z.boolean(),
        state: z.enum(["pre", "in", "final", "tbd"]),
        away: proTeam,
        home: proTeam,
        roof: z
          .string()
          .regex(/^[a-z_]{1,16}$/)
          .nullable(),
        surface: z
          .string()
          .regex(/^[a-z_]{1,24}$/)
          .nullable(),
        divisional: z.boolean().nullable(),
        rest_days: z.strictObject({
          away: z.number().int().nullable(),
          home: z.number().int().nullable(),
        }),
        lines: linesSchema
          .extend({ source: z.literal("nflverse:schedules"), secondary: linesSchema.nullable() })
          .nullable(),
        weather: z
          .strictObject({
            temp_f: z.number().nullable(),
            wind_mph: z.number().nullable(),
            gust_mph: z.number().nullable(),
            precip_prob: z.number().nullable(),
            as_of: iso,
            source: z.enum(["weather:open_meteo", "weather:nws"]),
          })
          .nullable(),
        score: z.strictObject({ away: z.number().int(), home: z.number().int() }).nullable(),
      }),
    )
    .max(120),
  byes: z.record(z.string().regex(/^[0-9]{1,2}$/), z.array(proTeam).max(32)),
  lock_windows: z
    .array(
      z.strictObject({
        open_at: iso,
        close_at: iso,
        espn_game_ids: z.array(z.number().int()).max(20),
      }),
    )
    .max(60),
});

const ROOF_RE = /^[a-z_]{1,16}$/;
const SURFACE_RE = /^[a-z_]{1,24}$/;

/** D3 `espn_get_schedule`. */
export const getSchedule = defineTool({
  name: "espn_get_schedule",
  description:
    "NFL games for up to 6 weeks (default: this week): kickoffs, lock/final flags, byes, lock windows, lines with implied totals, roof, rest, weather.",
  input: z.strictObject({
    weeks: z
      .array(weekSchema)
      .min(BOUNDS.scheduleWeeks.min)
      .max(BOUNDS.scheduleWeeks.max)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate_weeks" })
      .optional(),
    nfl_team: nflTeamSchema.optional(),
    include_weather: z.boolean().default(true),
    include_lines: z.boolean().default(true),
    ...analyticsFreshnessShape,
  }),
  data: scheduleSchema,
  budget: "list",
  hint: TRUNCATION_HINTS.schedule,
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const league = await leagueOf(ctx, inputs);
    const weeks = args.weeks ?? [weekOf(league, undefined)];
    const sched = await scheduleOf(ctx, league.ref.season, inputs, allowStale);
    const teams = sched.schedule.teams;
    let teamId: number | null = null;
    if (args.nfl_team !== undefined) {
      teamId = teams.find((t) => t.abbrev === args.nfl_team)?.id ?? null;
      if (teamId === null) throw new EffError("NOT_FOUND");
    }
    const games = sched.schedule.games
      .filter((g) => weeks.includes(g.week))
      .filter(
        (g) => teamId === null || g.home_pro_team_id === teamId || g.away_pro_team_id === teamId,
      )
      .sort(
        (a, b) =>
          a.week - b.week ||
          (kickoffMsOf(a) ?? 0) - (kickoffMsOf(b) ?? 0) ||
          a.espn_game_id - b.espn_game_id,
      );
    const ids = games.map((g) => g.espn_game_id);
    const nfl = ids.length === 0 ? null : ctx.services.datasets.nflGames.byEspnGameId(ids);
    const nflInput = nfl === null ? null : optionalDataset(nfl, ctx.nowMs, allowStale);
    const byEspn = new Map<number, NflGame>();
    if (nfl !== null && nflInput !== null) {
      inputs.push(nflInput);
      for (const g of nfl.rows) if (g.espn_game_id !== null) byEspn.set(g.espn_game_id, g);
    } else if (ids.length > 0)
      warnings.push("nflverse:schedules unavailable: lines, roof and rest are null");
    const weatherBy = new Map<string, WeatherObservation>();
    if (args.include_weather && byEspn.size > 0) {
      const wx = ctx.services.datasets.weather.forGames([...byEspn.values()].map((g) => g.game_id));
      const wxInput = optionalDataset(wx, ctx.nowMs, allowStale);
      if (wxInput !== null) {
        inputs.push(wxInput);
        for (const o of wx.rows) weatherBy.set(o.game_id, o);
      } else warnings.push("weather unavailable: weather is null");
    }
    const abbrev = (id: number): string => proTeamAbbrev(teams, id) ?? "FA";
    const rows: ScheduleData["games"][number][] = games.map((g) => {
      const n = byEspn.get(g.espn_game_id) ?? null;
      const wx = n === null ? undefined : weatherBy.get(n.game_id);
      const state = gameStateOf(g, ctx.nowMs);
      return {
        espn_game_id: g.espn_game_id,
        week: g.week,
        kickoff: kickoffOf(g),
        start_time_tbd: g.start_time_tbd,
        valid_for_locking: g.valid_for_locking,
        stats_official: g.stats_official,
        state: state === "bye" ? "pre" : state,
        away: abbrev(g.away_pro_team_id),
        home: abbrev(g.home_pro_team_id),
        roof: n?.roof !== undefined && n.roof !== null && ROOF_RE.test(n.roof) ? n.roof : null,
        surface:
          n?.surface !== undefined && n.surface !== null && SURFACE_RE.test(n.surface)
            ? n.surface
            : null,
        divisional: n?.divisional ?? null,
        rest_days: n?.rest_days ?? { away: null, home: null },
        lines:
          args.include_lines && n?.lines !== undefined && n.lines !== null
            ? { ...n.lines, source: "nflverse:schedules", secondary: null }
            : null,
        weather:
          wx === undefined
            ? null
            : {
                temp_f: wx.temp_f,
                wind_mph: wx.wind_mph,
                gust_mph: wx.gust_mph,
                precip_prob: wx.precip_prob,
                as_of: wx.as_of,
                source: wx.source,
              },
        score: n?.score ?? null,
      };
    });
    const allByes = byesByWeek(sched.schedule);
    const byes: Record<string, string[]> = {};
    for (const w of weeks) {
      const list = (allByes[String(w)] ?? []).filter((id) => teamId === null || id === teamId);
      byes[String(w)] = list.map(abbrev);
    }
    const windows = new Map<number, number[]>();
    for (const g of games) {
      const k = kickoffMsOf(g);
      if (k !== null) windows.set(k, [...(windows.get(k) ?? []), g.espn_game_id]);
    }
    const lock_windows = [...windows.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, gids]) => ({
        open_at: new Date(k).toISOString(),
        close_at: new Date(k + GAME_DURATION_MS).toISOString(),
        espn_game_ids: [...gids].sort((a, b) => a - b),
      }));
    const data: ScheduleData = { games: rows, byes, lock_windows };
    const tbd = games.filter((g) => g.start_time_tbd).length;
    if (tbd > 0) warnings.push(`${String(tbd)} game(s) have a TBD kickoff: no time is shown`);
    return { data, inputs, warnings, listKey: "games" };
  },
});

export type { PlatformPlayer };
