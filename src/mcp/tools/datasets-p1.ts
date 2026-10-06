// datasets-p1.ts — the four P1 dataset-read tools (plan 07 §3.D, registered under EFF_TOOLSET=full):
// D1 espn_get_player_usage (per-game opportunity rows, server-side trailing summaries — the model
// never averages rows, sib §17.1 — change points from E5's own held-jump detector, the xFP − actual
// gap; `routes_proxy` is named a proxy because routes have no free in-season source, research 04 #3),
// D4 espn_get_depth_chart (nflverse depth charts, ESPN-keyed, with snaps beside the chart — never
// the chart over snaps, sib §6.1), D5 espn_get_defense_profile (opponent-adjusted fantasy points
// allowed per position over a rolling window, regressed hard toward the mean — research 05 §1 step 6
// `1 + β_pos × w(weeks) × (aFPA − mean)/mean` — with ESPN's own positional rating as a labelled
// comparator column, never the driver) and D6 espn_get_news (RSS headlines matched to players, every
// string wrapped, the `rules_v1` claim, the hand-set reliability prior and the injection flags — plan
// 02 §6.4: claims are extracted by rules, never by the model). Dataset reads are local (D1, D4, D6:
// openWorldHint false); D5 also reads ESPN's mPositionalRatings (openWorldHint true).
import { z } from "zod/v4";
import type { NflTeam } from "../../config/schema.js";
import { detectSignals, usageWeekOf } from "../../domain/analytics/phase2.js";
import type {
  DefenseProfileData,
  DepthChartData,
  DepthChartRow,
  NewsData,
  NewsItem,
  PlayerUsageData,
  UsageGameRow,
} from "../../domain/analytics/types.js";
import { newsClaim } from "../../domain/evidence/index.js";
import { teamOfProTeamId } from "../../domain/crosswalk/teams.js";
import {
  INJECTION_FLAGS,
  bareUntrusted,
  type BareText,
  type PlatformPlayer,
  type Week,
} from "../../domain/league/types.js";
import { score } from "../../domain/scoring/index.js";
import {
  BOUNDS,
  analyticsFreshnessShape,
  detailShape,
  nflTeamSchema,
  playerSelectorSchema,
  positionsSchema,
  singlePlayerSelectorSchema,
} from "../bounds.js";
import { bareTextSchema, type InputStamp } from "../envelope.js";
import { EffError } from "../errors.js";
import { defineTool, roundDeep, type ToolContext } from "../define.js";
import {
  crosswalkOf,
  isDegradable,
  leagueOf,
  leagueRef,
  optionalDataset,
  readOpts,
  requiredDataset,
  settingsOf,
  take,
  weekOf,
  withinBudget,
} from "./common.js";
import { SELECTOR_HINT } from "./espn-p1.js";
import { espnTeamOf, meanFinite, nflverseTeam, usageOf, type UsageRead } from "./p1-common.js";
import {
  count,
  gsisOrNull,
  iso,
  playerId,
  playerName,
  position,
  prob,
  probNull,
  ut,
  week,
} from "./schemas.js";
import { selectPlayers } from "./select.js";

// --- D1 espn_get_player_usage ----------------------------------------------------------------------

const ratio = z.number().min(0).max(10).nullable();
const nflTeamOut = z
  .string()
  .regex(/^[A-Z]{2,4}$/)
  .nullable();

const usageGameSchema = z.strictObject({
  week,
  opponent: nflTeamOut,
  snaps: count.nullable(),
  snap_pct: ratio,
  routes_proxy: z.number().min(0).max(200).nullable(),
  targets: count.nullable(),
  target_share: ratio,
  air_yards: z.number().min(-500).max(2000).nullable(),
  air_yards_share: z.number().min(-10).max(10).nullable(),
  adot: z.number().min(-100).max(100).nullable(),
  wopr: z.number().min(-10).max(10).nullable(),
  racr: z.number().min(-100).max(100).nullable(),
  carries: count.nullable(),
  carry_share: ratio,
  rz_targets: count.nullable(),
  rz_carries: count.nullable(),
  gl_carries: count.nullable(),
  xfp_ep: z.number().min(-100).max(200).nullable(),
  points_league: z.number().min(-100).max(200).nullable(),
  xfp_gap: z.number().min(-300).max(300).nullable(),
});

/** D1 data (plan 07 D1; PlayerUsageData). */
export const playerUsageSchema = z.strictObject({
  players: z
    .array(
      z.strictObject({
        player_id: playerId.nullable(),
        gsis_id: gsisOrNull,
        name: playerName,
        position,
        nfl_team: nflTeamOut,
        games: z.array(usageGameSchema).max(40).optional(),
        trailing: z.strictObject({
          window_games: count,
          snap_pct: ratio,
          target_share: ratio,
          carry_share: ratio,
          rz_share: ratio,
          wopr: z.number().min(-10).max(10).nullable(),
          tprr_proxy: z.number().min(0).max(10).nullable(),
          xfp_gap_sum: z.number().min(-1000).max(1000).nullable(),
          change_point: z
            .strictObject({
              week,
              metric: z.enum(["snap_pct", "target_share", "rz_share"]),
              delta: z.number(),
            })
            .nullable(),
        }),
        role_confidence_games: count,
        data_gaps: z.array(z.string().max(200)).max(10),
      }),
    )
    .max(60),
  notes: z.array(z.string().max(200)).max(6),
});

/** D1's fixed notes (clean negatives as text the Skills quote verbatim — plan 07 C9). */
export const USAGE_NOTES = Object.freeze([
  "routes are a snap-share proxy (04 #3)",
  "xfp_ep is ffopportunity's full-PPR expectation; xfp_gap compares it with your league's points re-expressed at full PPR for receptions",
]);

/** The positions D1 has a usage model for. */
const USAGE_POSITIONS: ReadonlySet<string> = new Set(["QB", "RB", "WR", "TE"]);

const CHANGE_METRIC = {
  snap_jump: "snap_pct",
  target_share_jump: "target_share",
  rz_shift: "rz_share",
} as const;

/** The server-side trailing summary of the latest `window` games (plan 07 D1 `trailing`). */
export function trailingOf(
  games: readonly UsageGameRow[],
  window: number,
  position: string,
): PlayerUsageData["players"][number]["trailing"] {
  const last = games.slice(-window);
  const sum = (pick: (g: UsageGameRow) => number | null): number | null => {
    const v = last.map(pick).filter((x): x is number => x !== null && Number.isFinite(x));
    return v.length === 0 ? null : v.reduce((s, x) => s + x, 0);
  };
  const targets = sum((g) => g.targets);
  const routes = sum((g) => g.routes_proxy);
  const gaps = last.map((g) => g.xfp_gap).filter((x): x is number => x !== null);
  // the change point: E5's own held-jump detector over the season's games (one source of truth)
  const signals = detectSignals({ position, games: games.map((g) => usageWeekOf(g, null)) });
  const jumps = signals.filter((s) => s.kind in CHANGE_METRIC);
  const top = jumps.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
  const latest = games[games.length - 1];
  return {
    window_games: last.length,
    snap_pct: meanFinite(last.map((g) => g.snap_pct)),
    target_share: meanFinite(last.map((g) => g.target_share)),
    carry_share: meanFinite(last.map((g) => g.carry_share)),
    // the team's red-zone denominator (PbpReader.playerUsage) is not served yet: a share needs it
    rz_share: null,
    wopr: meanFinite(last.map((g) => g.wopr)),
    tprr_proxy:
      targets === null || routes === null || !(routes > 0) ? null : Math.min(10, targets / routes),
    xfp_gap_sum: gaps.length === 0 ? null : gaps.reduce((s, x) => s + x, 0),
    change_point:
      top === undefined || latest === undefined
        ? null
        : {
            week: latest.week,
            metric: CHANGE_METRIC[top.kind as keyof typeof CHANGE_METRIC],
            delta: top.value,
          },
  };
}

/** D1 `espn_get_player_usage`. */
export const getPlayerUsage = defineTool({
  name: "espn_get_player_usage",
  description:
    "Per-game opportunity (snaps, targets, carries, red zone, xFP) with server-side trailing summaries, change points and the xFP-minus-actual gap.",
  input: z.strictObject({
    players: playerSelectorSchema,
    window: z
      .number()
      .int()
      .min(BOUNDS.usageWindow.min)
      .max(BOUNDS.usageWindow.max)
      .default(BOUNDS.usageWindow.default),
    include_prior_season: z.boolean().default(false),
    ...analyticsFreshnessShape,
    ...detailShape,
  }),
  data: playerUsageSchema,
  budget: "list",
  opaqueInput: { players: SELECTOR_HINT },
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, undefined);
    const settings = await settingsOf(ctx, inputs).catch((e: unknown) => {
      if (!isDegradable(e)) throw e;
      warnings.push("scoring settings unavailable: points_league and xfp_gap are null");
      return null;
    });
    const sel = await selectPlayers(
      ctx,
      args.players,
      league.my_team?.team_id ?? null,
      w,
      inputs,
      warnings,
    );
    if (sel.missing > 0) warnings.push(`${String(sel.missing)} requested player(s) not found`);
    if (sel.players.length === 0) throw new EffError("NOT_FOUND");
    const subjects = sel.players.slice(0, 60).map((p) => ({
      p,
      gsis: crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id,
    }));
    const season = league.ref.season;
    const thisWeeks: Week[] = Array.from({ length: Math.max(0, w) }, (_, i) => i + 1);
    const now = usageOf(ctx, subjects, season, thisWeeks, settings, allowStale, inputs);
    const prior: Map<number, UsageRead> | null = args.include_prior_season
      ? usageOf(
          ctx,
          subjects,
          season - 1,
          Array.from({ length: BOUNDS.week.max }, (_, i) => i + 1),
          settings,
          allowStale,
          inputs,
        ).byId
      : null;
    const full = args.detail === "full";
    const notes = [...USAGE_NOTES];
    let filled = 0;
    const players: PlayerUsageData["players"][number][] = subjects.map(({ p, gsis }) => {
      const u = now.byId.get(p.ref.id);
      const games = [...(u?.games ?? [])];
      const gaps = [...now.gaps, ...(u?.data_gaps ?? [])];
      if (!USAGE_POSITIONS.has(p.position)) gaps.push(`no usage model for ${p.position}`);
      // early season: the window fills from the prior season's last games, said so
      let trailingGames = games;
      const p0 = prior?.get(p.ref.id);
      if (p0 !== undefined && games.length < args.window && p0.games.length > 0) {
        const need = args.window - games.length;
        trailingGames = [...p0.games.slice(-need), ...games];
        filled++;
      }
      return {
        player_id: p.ref.id,
        gsis_id: gsis,
        name: p.name,
        position: p.position,
        nfl_team: u?.nfl_team ?? nflverseTeam(p.pro_team),
        ...(full ? { games: games.slice(-40) } : {}),
        trailing: trailingOf(trailingGames, args.window, p.position),
        role_confidence_games: games.filter((g) => g.targets !== null || g.carries !== null).length,
        data_gaps: [...new Set(gaps)].slice(0, 10),
      };
    });
    if (filled > 0)
      notes.push(
        `${String(filled)} player(s) have fewer games than the window this season: their trailing summary includes last season's final games`,
      );
    const data: PlayerUsageData = { players, notes };
    return { data, inputs, warnings, listKey: "players", week: w };
  },
});

// --- D4 espn_get_depth_chart ---------------------------------------------------------------------

/** D4 data (plan 07 D4; DepthChartData). */
export const depthChartSchema = z.strictObject({
  teams: z
    .array(
      z.strictObject({
        nfl_team: z.string().regex(/^[A-Z]{2,4}$/),
        as_of: iso,
        groups: z
          .array(
            z.strictObject({
              pos_grp: z.string().regex(/^[A-Za-z0-9_ /-]{1,24}$/),
              slots: z
                .array(
                  z.strictObject({
                    pos_abb: z.string().regex(/^[A-Za-z0-9_/-]{1,12}$/),
                    rank: z.number().int().min(0).max(20),
                    gsis_id: gsisOrNull,
                    player_id: playerId.nullable(),
                    name: bareTextSchema("nflverse.depth_charts.name"),
                    snap_pct_last3: probNull,
                  }),
                )
                .max(120),
            }),
          )
          .max(20),
      }),
    )
    .max(2),
  sleeper_cross_check: z.enum(["agree", "disagree", "unavailable"]),
});

const POS_GRP_RE = /^[A-Za-z0-9_ /-]{1,24}$/;
const POS_ABB_RE = /^[A-Za-z0-9_/-]{1,12}$/;

/** The NFL team of a single-player selector (ESPN's pro team, through one cached filterIds read). */
async function teamOfPlayer(
  ctx: ToolContext,
  sel: z.output<typeof singlePlayerSelectorSchema>,
  w: Week,
  inputs: InputStamp[],
): Promise<PlatformPlayer> {
  let id: number | undefined;
  if ("player_ids" in sel) id = sel.player_ids[0];
  else {
    const g = sel.gsis_ids[0];
    id = g === undefined ? undefined : ctx.services.crosswalk.byGsis(g)[0]?.espn_id;
  }
  if (id === undefined) throw new EffError("NOT_FOUND");
  const got = await ctx.services.platform.getPlayers(
    leagueRef(ctx),
    [{ platform: "espn", id }],
    w,
    readOpts(ctx),
  );
  const p = take(ctx, got, inputs)[0];
  if (p === undefined) throw new EffError("NOT_FOUND");
  return p;
}

/** D4 `espn_get_depth_chart`. */
export const getDepthChart = defineTool({
  name: "espn_get_depth_chart",
  description:
    "An NFL team's depth chart (ESPN-keyed) with each player's recent snap share beside his listed rank; pass nfl_team or one player.",
  input: z
    .strictObject({
      nfl_team: nflTeamSchema.optional(),
      player: singlePlayerSelectorSchema.optional(),
      positions: positionsSchema.optional(),
      ...analyticsFreshnessShape,
    })
    .refine((a) => (a.nfl_team === undefined) !== (a.player === undefined), {
      message: "nfl_team_xor_player",
      path: ["nfl_team"],
    }),
  data: depthChartSchema,
  budget: "list",
  opaqueInput: { player: "exactly one of {player_ids:[id]} or {gsis_ids:[id]}" },
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, undefined);
    let team: NflTeam | null;
    if (args.player !== undefined) {
      const p = await teamOfPlayer(ctx, args.player, w, inputs);
      team = teamOfProTeamId(p.pro_team_id) ?? nflverseTeam(p.pro_team);
      if (team === null)
        throw new EffError("VALIDATION", { field: "player", reason: "no_nfl_team" });
    } else team = nflverseTeam(args.nfl_team ?? null);
    if (team === null) throw new EffError("NOT_FOUND");
    const season = league.ref.season;
    const chart = ctx.services.datasets.depthCharts.chart(season, [team]);
    const input = requiredDataset(chart, ctx.nowMs, allowStale);
    if (input !== null) inputs.push(input);
    const wanted = args.positions === undefined ? null : new Set(args.positions);
    const rows = chart.rows.filter(
      (r) =>
        r.nfl_team === team &&
        POS_GRP_RE.test(r.pos_grp) &&
        POS_ABB_RE.test(r.pos_abb) &&
        (wanted === null || wanted.has(r.pos_abb) || wanted.has(r.pos_grp)),
    );
    // snaps beside the chart (sib §6.1): the mean snap share over the last three weeks
    const gsis = [...new Set(rows.map((r) => r.gsis_id).filter((g): g is string => g !== null))];
    const recent: Week[] = [w - 3, w - 2, w - 1].filter((x) => x >= 1);
    const snapBy = new Map<string, number | null>();
    if (gsis.length > 0 && recent.length > 0) {
      const r = ctx.services.datasets.playerWeeks.lines(gsis, season, recent);
      const li = optionalDataset(r, ctx.nowMs, allowStale);
      if (li !== null) {
        inputs.push(li);
        const acc = new Map<string, (number | null)[]>();
        for (const l of r.rows)
          acc.set(l.gsis_id, [...(acc.get(l.gsis_id) ?? []), l.usage?.snap_pct ?? null]);
        for (const [g, xs] of acc) snapBy.set(g, meanFinite(xs));
      }
    }
    if ([...snapBy.values()].every((v) => v === null))
      warnings.push("snap counts not in the store's usage rows: snap_pct_last3 is null");
    const groups = new Map<
      string,
      DepthChartData["teams"][number]["groups"][number]["slots"][number][]
    >();
    for (const r of rows) {
      const pid =
        r.espn_id ??
        (r.gsis_id === null
          ? null
          : (ctx.services.crosswalk.byGsis(r.gsis_id)[0]?.espn_id ?? null));
      const list = groups.get(r.pos_grp) ?? [];
      list.push({
        pos_abb: r.pos_abb,
        rank: Math.max(0, Math.min(20, Math.trunc(r.rank))),
        gsis_id: r.gsis_id,
        player_id: pid !== null && pid > 0 ? pid : null,
        name: r.name,
        snap_pct_last3: r.gsis_id === null ? null : clampProb(snapBy.get(r.gsis_id) ?? null),
      });
      groups.set(r.pos_grp, list);
    }
    const data: DepthChartData = {
      teams: [
        {
          nfl_team: espnTeamOf(team),
          as_of: chart.stamp?.as_of ?? new Date(ctx.nowMs).toISOString(),
          groups: [...groups.entries()].map(([pos_grp, slots]) => ({
            pos_grp,
            slots: slots
              .sort((a, b) =>
                a.pos_abb < b.pos_abb ? -1 : a.pos_abb > b.pos_abb ? 1 : a.rank - b.rank,
              )
              .slice(0, 120),
          })),
        },
      ],
      // no Sleeper depth source is loaded in this build (Sleeper trending only)
      sleeper_cross_check: "unavailable",
    };
    if (rows.length === 0) warnings.push("no depth-chart rows for that team and position filter");
    return { data, inputs, warnings, listKey: "teams" };
  },
});

function clampProb(x: number | null): number | null {
  return x === null || !Number.isFinite(x) ? null : Math.min(1, Math.max(0, x));
}

/** Re-export for tests: the depth-chart row type the tool reads. */
export type { DepthChartRow };

// --- D5 espn_get_defense_profile -----------------------------------------------------------------

/** D5's positions and their ESPN position ids (mPositionalRatings keys: 1–5, 16). */
export const DEFENSE_POSITIONS = Object.freeze({ QB: 1, RB: 2, WR: 3, TE: 4, K: 5, "D/ST": 16 });
type DefensePosition = keyof typeof DEFENSE_POSITIONS;

/**
 * The cold-start regression (research 05 §1 step 6): β_pos = the year-over-year correlation of
 * defensive fantasy points allowed (QB .27, RB .22, WR .15, TE .16 — 4for4/Eakins 2015–2025; K and
 * D/ST [U] at WR's), and w(weeks) rising from 0 to 1 by week `rampGames` [U].
 */
export const DEFENSE = Object.freeze({
  beta: { QB: 0.27, RB: 0.22, WR: 0.15, TE: 0.16, K: 0.15, "D/ST": 0.15 },
  rampGames: 9,
});

/** The fixed evidence note (plan 07 D5; research 05 §18). */
export const DEFENSE_EVIDENCE_NOTE =
  "YoY r QB .27 RB .22 WR .15 TE .16 (05 §18); multiplier is shrunk and ramps with weeks";

const afpaSchema = z.strictObject({
  allowed_per_game: z.number(),
  league_mean: z.number(),
  adjusted: z.number(),
  shrink_w: prob,
  multiplier: z.number().min(0).max(3),
  espn_positional_rating: z
    .strictObject({ average: z.number(), rank: z.number().int() })
    .nullable(),
});

/** D5 data (plan 07 D5; DefenseProfileData). */
export const defenseProfileSchema = z.strictObject({
  defenses: z
    .array(
      z.strictObject({
        nfl_team: z.string().regex(/^[A-Z]{2,4}$/),
        window_games: count,
        afpa: z.record(z.string().regex(/^(?:QB|RB|WR|TE|K|D\/ST)$/), afpaSchema),
        pace_plays_per_game: z.number().nullable(),
        pass_rate: probNull,
        proe: z.number().nullable(),
        pressure_rate: probNull,
        sack_rate: probNull,
        takeaway_rate: probNull,
        epa_allowed: z.strictObject({ pass: z.number(), rush: z.number() }).nullable(),
      }),
    )
    .max(32),
  evidence_note: z.string().max(200),
});

/** One game's points to one position against a defence. */
interface Allowed {
  readonly defense: NflTeam;
  readonly offense: NflTeam;
  readonly week: Week;
  readonly position: DefensePosition;
  readonly points: number;
}

/**
 * aFPA (research 05 §1 step 6): the league mean plus the mean residual of each game's points
 * against that offence's own per-game mean at the position — points allowed adjusted for the
 * offences faced, never raw points allowed.
 */
export function afpaOf(
  games: readonly Allowed[],
  pos: DefensePosition,
): Map<NflTeam, { allowed: number; adjusted: number; n: number; mean: number }> {
  const at = games.filter((g) => g.position === pos);
  // per (offence, week) totals, then each offence's per-game mean
  const og = new Map<string, { o: NflTeam; d: NflTeam; pts: number }>();
  for (const g of at) {
    const k = `${g.offense}:${String(g.week)}`;
    const cur = og.get(k);
    og.set(k, { o: g.offense, d: g.defense, pts: (cur?.pts ?? 0) + g.points });
  }
  const offAcc = new Map<NflTeam, number[]>();
  for (const v of og.values()) offAcc.set(v.o, [...(offAcc.get(v.o) ?? []), v.pts]);
  const offMean = new Map<NflTeam, number>();
  for (const [o, xs] of offAcc) offMean.set(o, xs.reduce((s, x) => s + x, 0) / xs.length);
  const all = [...og.values()].map((v) => v.pts);
  const mean = all.length === 0 ? 0 : all.reduce((s, x) => s + x, 0) / all.length;
  const def = new Map<NflTeam, { raw: number[]; res: number[] }>();
  for (const v of og.values()) {
    const cur = def.get(v.d) ?? { raw: [], res: [] };
    cur.raw.push(v.pts);
    cur.res.push(v.pts - (offMean.get(v.o) ?? mean));
    def.set(v.d, cur);
  }
  const out = new Map<NflTeam, { allowed: number; adjusted: number; n: number; mean: number }>();
  for (const [d, v] of def) {
    const n = v.raw.length;
    out.set(d, {
      allowed: v.raw.reduce((s, x) => s + x, 0) / n,
      adjusted: mean + v.res.reduce((s, x) => s + x, 0) / n,
      n,
      mean,
    });
  }
  return out;
}

/** The regressed multiplier (research 05 §1 step 6), clamped to [0, 3]. */
export function matchupMultiplier(
  adjusted: number,
  mean: number,
  pos: DefensePosition,
  games: number,
): { readonly shrink_w: number; readonly multiplier: number } {
  const w = Math.min(1, Math.max(0, games / DEFENSE.rampGames));
  const shrink = DEFENSE.beta[pos] * w;
  const m = mean > 0 ? 1 + shrink * ((adjusted - mean) / mean) : 1;
  return { shrink_w: shrink, multiplier: Math.min(3, Math.max(0, m)) };
}

/** D5 `espn_get_defense_profile`. */
export const getDefenseProfile = defineTool({
  name: "espn_get_defense_profile",
  description:
    "Opponent-adjusted fantasy points allowed per position by NFL defenses over a rolling window, regressed hard, with ESPN's positional rating beside it.",
  input: z.strictObject({
    nfl_team: z.union([z.literal("all"), nflTeamSchema]).default("all"),
    position: z.enum(["QB", "RB", "WR", "TE", "K", "D/ST"]).optional(),
    window_weeks: z
      .number()
      .int()
      .min(BOUNDS.defenseWindowWeeks.min)
      .max(BOUNDS.defenseWindowWeeks.max)
      .default(BOUNDS.defenseWindowWeeks.default),
    ...analyticsFreshnessShape,
    ...detailShape,
  }),
  data: defenseProfileSchema,
  budget: "list",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, undefined);
    const settings = await settingsOf(ctx, inputs);
    const season = league.ref.season;
    const weeks: Week[] = [];
    for (let x = w - 1; x >= 1 && weeks.length < args.window_weeks; x--) weeks.unshift(x);
    const positions: DefensePosition[] =
      args.position !== undefined
        ? [args.position]
        : args.detail === "full"
          ? ["QB", "RB", "WR", "TE", "K", "D/ST"]
          : ["QB", "RB", "WR", "TE"];
    const allowed: Allowed[] = [];
    if (weeks.length > 0) {
      const roster = ctx.services.rosterWeekly.latest(season);
      const rIn = optionalDataset(roster, ctx.nowMs, allowStale);
      const gsis = rIn === null ? [] : [...new Set(roster.rows.map((r) => r.gsis_id))];
      if (rIn !== null) inputs.push(rIn);
      if (gsis.length > 0) {
        const r = ctx.services.datasets.playerWeeks.lines(gsis, season, weeks);
        const li = requiredDataset(r, ctx.nowMs, allowStale);
        if (li !== null) inputs.push(li);
        for (const l of r.rows) {
          const pos = l.position === "FB" ? "RB" : l.position;
          if (!(pos in DEFENSE_POSITIONS) || pos === "D/ST" || l.opponent === null) continue;
          let pts: number;
          try {
            pts = score(l.line, settings).points;
          } catch {
            continue;
          }
          allowed.push({
            defense: l.opponent,
            offense: l.nfl_team,
            week: l.week,
            position: pos as DefensePosition,
            points: pts,
          });
        }
      } else warnings.push("nflverse:roster_weekly not loaded: no player universe to aggregate");
      if (positions.includes("D/ST")) {
        const teams = [...new Set(allowed.map((a) => a.offense))];
        const d = ctx.services.datasets.playerWeeks.defenseLines(teams, season, weeks);
        const di = optionalDataset(d, ctx.nowMs, allowStale);
        if (di !== null) {
          inputs.push(di);
          // a D/ST's points are what the OPPOSING offence allows to D/STs: keyed by that offence
          for (const l of d.rows) {
            if (l.opponent === null) continue;
            try {
              allowed.push({
                defense: l.opponent,
                offense: l.nfl_team,
                week: l.week,
                position: "D/ST",
                points: score(l.line, settings).points,
              });
            } catch {
              // an underivable D/ST line is left out
            }
          }
        }
      }
    } else warnings.push("no completed week in the window yet: every multiplier is 1");
    const ratings = await withinBudget(
      () => ctx.services.platform.getPositionalRatings(leagueRef(ctx), w, readOpts(ctx)),
      warnings,
    ).catch((e: unknown) => {
      if (!isDegradable(e)) throw e;
      warnings.push("espn:mPositionalRatings unavailable: espn_positional_rating is null");
      return null;
    });
    const ratingRows = ratings === null ? [] : take(ctx, ratings, inputs);
    const byPos = new Map(positions.map((p) => [p, afpaOf(allowed, p)]));
    const all = [...new Set(allowed.map((a) => a.defense))].sort();
    const want =
      args.nfl_team === "all"
        ? all
        : [nflverseTeam(args.nfl_team)].filter((t): t is NflTeam => t !== null);
    if (args.nfl_team !== "all" && want.length === 0) throw new EffError("NOT_FOUND");
    const proTeamIdOf = (t: NflTeam): number | null => {
      for (let id = 1; id <= 34; id++) if (teamOfProTeamId(id) === t) return id;
      return null;
    };
    const defenses: DefenseProfileData["defenses"][number][] = want.map((t) => {
      const afpa: Record<string, DefenseProfileData["defenses"][number]["afpa"][string]> = {};
      let games = 0;
      for (const p of positions) {
        const v = byPos.get(p)?.get(t);
        if (v === undefined) continue;
        games = Math.max(games, v.n);
        const m = matchupMultiplier(v.adjusted, v.mean, p, v.n);
        const pid = proTeamIdOf(t);
        const rr = ratingRows.find(
          (x) => x.opponent_pro_team_id === pid && x.position_id === DEFENSE_POSITIONS[p],
        );
        afpa[p] = {
          allowed_per_game: v.allowed,
          league_mean: v.mean,
          adjusted: v.adjusted,
          shrink_w: m.shrink_w,
          multiplier: m.multiplier,
          espn_positional_rating:
            rr?.average == null || rr.rank === null
              ? null
              : { average: rr.average, rank: Math.trunc(rr.rank) },
        };
      }
      return {
        nfl_team: espnTeamOf(t),
        window_games: games,
        afpa,
        // pace, pass rate, PROE, pressure, sack and takeaway rates and EPA need the pbp team profile,
        // which the store's readers do not serve yet: null, said so
        pace_plays_per_game: null,
        pass_rate: null,
        proe: null,
        pressure_rate: null,
        sack_rate: null,
        takeaway_rate: null,
        epa_allowed: null,
      };
    });
    warnings.push(
      "pace, pass rate, PROE, pressure, sack, takeaway and EPA profiles need the pbp team profile reader: null in this build",
    );
    // our numbers, rounded as every analytics number is (plan 07 C8): list budget, compact rows
    const data = roundDeep({
      defenses,
      evidence_note: DEFENSE_EVIDENCE_NOTE,
    }) as DefenseProfileData;
    return {
      data,
      inputs,
      warnings,
      estimate: true,
      listKey: "defenses",
      week: w,
    };
  },
});

// --- D6 espn_get_news ----------------------------------------------------------------------------

/** The matcher's lowest confidence: what an item matched by id alone (no per-ref confidence) reads. */
export const NEWS_MATCH_FLOOR = 0.6;

const claimSchema = z
  .strictObject({
    type: z.enum(["availability", "role", "health", "coaching_intent", "transaction", "other"]),
    direction: z.enum(["up", "down", "neutral"]),
    extractor: z.literal("rules_v1"),
  })
  .nullable();

/** D6 data (plan 07 D6; NewsData). */
export const newsSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[0-9a-f]{32}$/),
        source: z.enum(["rotowire", "espn", "cbs"]),
        published_at: iso,
        players_matched: z
          .array(
            z.strictObject({
              gsis_id: gsisOrNull,
              player_id: playerId.nullable(),
              name: playerName,
              match_confidence: prob,
            }),
          )
          .max(10),
        title: ut,
        blurb: ut,
        url: ut,
        claim: claimSchema,
        reliability_prior: probNull,
        flags: z.array(z.enum(INJECTION_FLAGS)).max(4),
      }),
    )
    .max(50),
});

/** The refs a reader may carry beside a NewsItem (evidence `newsItemWithRefs`), read defensively. */
function refsOf(item: NewsItem): readonly {
  readonly espn_id: number | null;
  readonly gsis_id: string | null;
  readonly c: number;
}[] {
  const raw = (item as unknown as { refs?: unknown }).refs;
  if (Array.isArray(raw)) {
    const out: { espn_id: number | null; gsis_id: string | null; c: number }[] = [];
    for (const r of raw.slice(0, 10)) {
      if (typeof r !== "object" || r === null) continue;
      const o = r as Record<string, unknown>;
      const e = typeof o.espn_id === "number" && Number.isSafeInteger(o.espn_id) ? o.espn_id : null;
      const g = typeof o.gsis_id === "string" ? o.gsis_id : null;
      const c =
        typeof o.match_confidence === "number" && o.match_confidence >= 0 && o.match_confidence <= 1
          ? o.match_confidence
          : NEWS_MATCH_FLOOR;
      if (e !== null || g !== null) out.push({ espn_id: e, gsis_id: g, c });
    }
    return out;
  }
  return item.gsis_ids
    .slice(0, 10)
    .map((g) => ({ espn_id: null, gsis_id: g, c: NEWS_MATCH_FLOOR }));
}

/** D6 `espn_get_news`. */
export const getNews = defineTool({
  name: "espn_get_news",
  description:
    "Recent RSS headlines (RotoWire, ESPN, CBS) matched to players, all untrusted text, with a rules-based claim and a hand-set reliability prior.",
  input: z
    .strictObject({
      players: playerSelectorSchema.optional(),
      nfl_team: nflTeamSchema.optional(),
      since_hours: z
        .number()
        .int()
        .min(BOUNDS.sinceHours.min)
        .max(BOUNDS.sinceHours.max)
        .default(BOUNDS.sinceHours.default),
      limit: z
        .number()
        .int()
        .min(BOUNDS.newsLimit.min)
        .max(BOUNDS.newsLimit.max)
        .default(BOUNDS.newsLimit.default),
      sources: z
        .array(z.enum(["rotowire", "espn", "cbs"]))
        .min(1)
        .max(3)
        .refine((a) => new Set(a).size === a.length, { message: "duplicate_sources" })
        .optional(),
      ...analyticsFreshnessShape,
    })
    .refine((a) => a.players === undefined || a.nfl_team === undefined, {
      message: "players_or_nfl_team",
      path: ["nfl_team"],
    }),
  data: newsSchema,
  budget: "list",
  opaqueInput: { players: SELECTOR_HINT },
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const league = await leagueOf(ctx, inputs);
    const w = weekOf(league, undefined);
    let gsis: string[] | null = null;
    if (args.players !== undefined) {
      const sel = await selectPlayers(
        ctx,
        args.players,
        league.my_team?.team_id ?? null,
        w,
        inputs,
        warnings,
      );
      gsis = sel.players
        .map((p) => crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id)
        .filter((g): g is string => g !== null);
      if (gsis.length === 0) {
        warnings.push("no crosswalk pair for the selected players: no news can be matched");
        return { data: { items: [] }, inputs, warnings, listKey: "items", week: w };
      }
    } else if (args.nfl_team !== undefined) {
      const team = args.nfl_team;
      const uni = ctx.services.playerUniverse.all(league.ref.season);
      if (uni.stamp === null)
        throw new EffError("STALE_ONLY", {
          hint: "That dataset was never loaded: run eff refresh in a terminal, then retry.",
        });
      gsis = uni.rows
        .filter((r) => r.pro_team === team && r.espn_id > 0)
        .map((r) => crosswalkOf(ctx, r.espn_id, r.position_id).gsis_id)
        .filter((g): g is string => g !== null);
    }
    const since = new Date(ctx.nowMs - args.since_hours * 3600 * 1000).toISOString();
    const res = ctx.services.datasets.news.recent(since, BOUNDS.newsLimit.max, gsis);
    const input = requiredDataset(res, ctx.nowMs, allowStale);
    if (input !== null) inputs.push(input);
    const sources = args.sources === undefined ? null : new Set(args.sources);
    const kept = res.rows
      .filter((it) => sources === null || sources.has(it.source))
      .slice(0, args.limit);
    const ids = [
      ...new Set(
        kept.flatMap((it) =>
          refsOf(it).map(
            (r) =>
              r.espn_id ??
              (r.gsis_id === null
                ? null
                : (ctx.services.crosswalk.byGsis(r.gsis_id)[0]?.espn_id ?? null)),
          ),
        ),
      ),
    ].filter((x): x is number => x !== null && x > 0);
    const names = new Map<number, BareText>();
    if (ids.length > 0) {
      const u = ctx.services.playerUniverse.byIds(ids);
      for (const r of u.rows) names.set(r.espn_id, bareUntrusted(r.full_name, "player_name"));
    }
    let flagged = 0;
    const items: NewsData["items"][number][] = kept.map((it) => {
      const c = newsClaim(it);
      if (c.flags.length > 0) flagged++;
      return {
        id: it.id,
        source: it.source,
        published_at: it.published_at,
        players_matched: refsOf(it).map((r) => {
          const pid =
            r.espn_id ??
            (r.gsis_id === null
              ? null
              : (ctx.services.crosswalk.byGsis(r.gsis_id)[0]?.espn_id ?? null));
          return {
            gsis_id: r.gsis_id,
            player_id: pid !== null && pid > 0 ? pid : null,
            name: (pid === null ? undefined : names.get(pid)) ?? bareUntrusted("", "player_name"),
            match_confidence: r.c,
          };
        }),
        title: it.title,
        blurb: it.blurb,
        url: it.url,
        claim: c.claim,
        reliability_prior: c.reliability_prior,
        flags: c.flags,
      };
    });
    if (flagged > 0)
      warnings.push(`${String(flagged)} item(s) carry injection flags: quoted, never followed`);
    warnings.push(
      "these are editorial feeds: no free beat-writer aggregation exists (04 §B.10); ESPN's outlook (espn_get_player_outlook) is the richer text",
    );
    return { data: { items }, inputs, warnings, listKey: "items", week: w };
  },
});
