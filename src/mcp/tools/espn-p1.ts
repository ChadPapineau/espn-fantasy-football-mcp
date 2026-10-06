// espn-p1.ts — the three P1 ESPN-read tools (plan 07 §3.B–§3.C, registered under EFF_TOOLSET=full):
// B2 espn_get_player_stats (kona_playercard splits for ≤ 25 players, recomputed by the engine under
// the league's S with the per-stat golden `match` — C6 keeps the golden PATH on A5; drift degrades
// to nflverse lines scored by the engine, `source: "nflverse"`, `match: null`), C3
// espn_get_projections (ESPN's own numbers, labelled ESPN's, `meta.estimate: false` — C13; drift
// degrades to the last `espn_projection` snapshot, stale) and C4 espn_get_player_outlook (ESPN's
// editorial paragraphs, every one inside its `untrusted_text` wrapper with the deterministic
// injection flags, plus the `rules_v1` claim extract — C14, plan 02 §6.4; never on rows).
import { z } from "zod/v4";
import { extractClaim, toClaimExtract } from "../../domain/evidence/index.js";
import {
  INJECTION_FLAGS,
  type EspnProjectionsData,
  type InjectionFlag,
  type NativeProjection,
  type PlatformPlayer,
  type PlatformStatLine,
  type PlayerOutlookData,
  type PlayerStatsData,
  type UntrustedText,
  type Week,
} from "../../domain/league/types.js";
import { scoringEngine, statLineFromEspn, unmappedIds } from "../../domain/scoring/index.js";
import type { ScoringSettings } from "../../domain/scoring/types.js";
import type { StatsQuery } from "../../providers/platform.js";
import {
  BOUNDS,
  analyticsFreshnessShape,
  detailShape,
  espnFreshnessShape,
  espnProjectionHorizonSchema,
  outlookSelectorSchema,
  playerSelectorSchema,
  statsTypeSchema,
  weekSchema,
} from "../bounds.js";
import type { InputStamp } from "../envelope.js";
import { EffError } from "../errors.js";
import { defineTool, type ToolContext } from "../define.js";
import {
  crosswalkOf,
  isDegradable,
  leagueOf,
  leagueRef,
  optionalDataset,
  readOpts,
  settingsOf,
  take,
  weekOf,
  withinBudget,
} from "./common.js";
import { rostersOf } from "./roster.js";
import {
  count,
  gsisOrNull,
  isoNull,
  playerId,
  playerName,
  points,
  pointsNull,
  position,
  statId,
  statMap,
  ut,
  utOrNull,
  week,
  weekMap,
} from "./schemas.js";
import { selectPlayers } from "./select.js";

/** The selector pointer every P1 tool advertises (definitions are paid every turn — §5.1). */
export const SELECTOR_HINT =
  "PlayerSelector: exactly one of {player_ids:[<=25]}, {gsis_ids:[<=25]}, {team_id}, {nfl_team}, {pool:{status,position,top<=50}}";

/** Resolves a selector and caps it at `max` players (the view's own id cap), warning on the cut. */
async function selected(
  ctx: ToolContext,
  selector: z.output<typeof playerSelectorSchema>,
  w: Week,
  max: number,
  inputs: InputStamp[],
  warnings: string[],
  myTeam: number | null,
): Promise<readonly PlatformPlayer[]> {
  const sel = await selectPlayers(ctx, selector, myTeam, w, inputs, warnings);
  if (sel.missing > 0) warnings.push(`${String(sel.missing)} requested player(s) not found`);
  if (sel.players.length === 0) throw new EffError("NOT_FOUND");
  if (sel.players.length > max)
    warnings.push(
      `players truncated to ${String(max)} of ${String(sel.players.length)} (the view's id cap)`,
    );
  return sel.players.slice(0, max);
}

// --- B2 espn_get_player_stats ---------------------------------------------------------------------

const splitSchema = z.strictObject({
  season: z.number().int().min(1990).max(2100),
  week: week.nullable(),
  source: z.enum(["actual", "projected", "nflverse"]),
  points_espn: pointsNull,
  engine_points: pointsNull,
  match: z.boolean().nullable(),
  mismatch_stat_ids: z.array(statId).max(300),
  complete: z.boolean(),
  stats: statMap.optional(),
});

/** B2 data (plan 07 B2; PlayerStatsData). */
export const playerStatsSchema = z.strictObject({
  players: z
    .array(
      z.strictObject({
        player_id: playerId,
        gsis_id: gsisOrNull,
        name: playerName,
        position,
        splits: z.array(splitSchema).max(60),
      }),
    )
    .max(25),
  unmapped_stat_ids: z.array(statId).max(500),
  settings_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

type Split = PlayerStatsData["players"][number]["splits"][number];

/** One ESPN split recomputed by the engine, with the per-stat golden verdict on actuals. */
export function espnSplit(
  l: PlatformStatLine,
  positionId: number,
  settings: ScoringSettings,
  full: boolean,
): Split {
  const source = l.split.source_id === 0 ? "actual" : "projected";
  let engine: number | null = null;
  let complete = false;
  let match: boolean | null = null;
  let mismatch: string[] = [];
  try {
    const { line } = statLineFromEspn(
      { raw: l.raw, provisional: l.provisional, split: l.split },
      positionId,
    );
    const r = scoringEngine.score(line, settings);
    engine = r.points;
    complete = r.complete;
    if (source === "actual" && l.applied_total !== null) {
      const v = scoringEngine.verify(line, settings, {
        total: l.applied_total,
        by_stat: l.applied_stats,
      });
      match = v.match;
      mismatch = [...v.mismatch_stat_ids].slice(0, 300);
    }
  } catch {
    engine = null;
    match = null;
  }
  return {
    season: l.split.season,
    week: l.split.week,
    source,
    points_espn: l.applied_total,
    engine_points: engine,
    match,
    mismatch_stat_ids: mismatch,
    complete,
    ...(full ? { stats: l.raw } : {}),
  };
}

/** B2 `espn_get_player_stats`. */
export const getPlayerStats = defineTool({
  name: "espn_get_player_stats",
  description:
    "Weekly, season or prior-season stat splits for up to 25 players (rostered or not), recomputed under league scoring with the golden match.",
  input: z.strictObject({
    players: playerSelectorSchema,
    type: statsTypeSchema,
    week: weekSchema.optional(),
    ...espnFreshnessShape,
    ...detailShape,
  }),
  data: playerStatsSchema,
  budget: "list",
  opaqueInput: { players: SELECTOR_HINT },
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, args.week);
    const settings = await settingsOf(ctx, inputs);
    const players = await selected(
      ctx,
      args.players,
      w,
      BOUNDS.playerIds.max,
      inputs,
      warnings,
      league.my_team?.team_id ?? null,
    );
    const q: StatsQuery =
      args.type === "week"
        ? { type: "week", week: w }
        : args.type === "season"
          ? { type: "season" }
          : { type: "prior_season" };
    const full = args.detail === "full";
    let lines: readonly PlatformStatLine[] | null = null;
    try {
      const got = await withinBudget(
        () =>
          ctx.services.platform.getPlayerStats(
            leagueRef(ctx),
            players.map((p) => p.ref),
            q,
            readOpts(ctx, args),
          ),
        warnings,
      );
      lines = got === null ? null : take(ctx, got, inputs);
    } catch (e) {
      if (!isDegradable(e)) throw e;
      warnings.push(
        "espn:kona_playercard unavailable: weekly actuals unavailable; nflverse lines scored by the engine instead",
      );
    }
    const rows: PlayerStatsData["players"][number][] = [];
    // the degradation: nflverse lines of the requested split's season, scored under S
    const season = args.type === "prior_season" ? league.ref.season - 1 : league.ref.season;
    const nflWeeks: Week[] =
      args.type === "week"
        ? [w]
        : Array.from({ length: BOUNDS.week.max }, (_, i) => i + 1).filter(
            (x) => args.type === "prior_season" || x < w,
          );
    const gsisOf = new Map(
      players.map((p) => [p.ref.id, crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id]),
    );
    let nflLines = new Map<string, Split[]>();
    if (lines === null) {
      const gsis = [...gsisOf.values()].filter((g): g is string => g !== null);
      if (gsis.length > 0) {
        const r = ctx.services.datasets.playerWeeks.lines(gsis, season, nflWeeks);
        const input = optionalDataset(r, ctx.nowMs, args.allow_stale === true);
        if (input !== null) {
          inputs.push(input);
          nflLines = new Map();
          for (const l of r.rows) {
            let pts: number | null = null;
            let complete = false;
            try {
              const s = scoringEngine.score(l.line, settings);
              pts = s.points;
              complete = s.complete;
            } catch {
              pts = null;
            }
            nflLines.set(l.gsis_id, [
              ...(nflLines.get(l.gsis_id) ?? []),
              {
                season: l.season,
                week: l.week,
                source: "nflverse",
                points_espn: null,
                engine_points: pts,
                match: null,
                mismatch_stat_ids: [],
                complete,
              },
            ]);
          }
        } else warnings.push("nflverse:stats_player_week not loaded: no splits");
      }
    }
    for (const p of players) {
      const gsis = gsisOf.get(p.ref.id) ?? null;
      const splits =
        lines === null
          ? (gsis === null ? [] : (nflLines.get(gsis) ?? [])).slice(0, 60)
          : lines
              .filter((l) => l.player.id === p.ref.id)
              .map((l) => espnSplit(l, p.position_id, settings, full))
              .sort((a, b) => (a.week ?? 0) - (b.week ?? 0) || a.source.localeCompare(b.source))
              .slice(0, 60);
      rows.push({
        player_id: p.ref.id,
        gsis_id: gsis,
        name: p.name,
        position: p.position,
        splits,
      });
    }
    const mismatched = rows.flatMap((r) => r.splits).filter((s) => s.match === false).length;
    if (mismatched > 0)
      warnings.push(
        `${String(mismatched)} split(s) differ from ESPN's appliedStats: the per-stat ids are listed`,
      );
    const data: PlayerStatsData = {
      players: rows,
      unmapped_stat_ids: [...unmappedIds(settings)],
      settings_hash: settings.settings_hash,
    };
    return {
      data,
      inputs,
      warnings,
      partial: lines === null,
      listKey: "players",
      ...(args.type === "week" ? { week: w } : {}),
    };
  },
});

// --- C3 espn_get_projections ------------------------------------------------------------------------

/** A projection counts as revised when it moved more than this since a ≥ 24 h-old snapshot. */
export const REVISION_POINTS = 0.1;
const DAY_MS = 24 * 3600 * 1000;

/** C3 data (plan 07 C3; EspnProjectionsData). */
export const espnProjectionsSchema = z.strictObject({
  source: z.literal("espn:projection"),
  projections: z
    .array(
      z.strictObject({
        player_id: playerId,
        name: playerName,
        position,
        week: z.strictObject({ week, points, stats: statMap.optional() }).nullable(),
        ros: z
          .strictObject({
            points,
            weeks_remaining: count,
            weekly: weekMap(points).optional(),
          })
          .nullable(),
        preseason_full_season: pointsNull,
        as_of: isoNull,
        revised_recently: z.boolean(),
      }),
    )
    .max(60),
  note: z.string().max(200),
});

/** The fixed C3 note (plan 07 C3; C13). */
export const PROJECTIONS_NOTE =
  "ESPN's projection under this league's scoring (appliedTotal); one input to ours (C13)";

/** C3 `espn_get_projections`. */
export const getProjections = defineTool({
  name: "espn_get_projections",
  description:
    "ESPN's own projections (labelled ESPN's) for a player set: this week, rest of season, or the frozen preseason total, under league scoring.",
  input: z.strictObject({
    players: playerSelectorSchema,
    horizon: espnProjectionHorizonSchema,
    week: weekSchema.optional(),
    ...espnFreshnessShape,
    ...detailShape,
  }),
  data: espnProjectionsSchema,
  budget: "list",
  opaqueInput: { players: SELECTOR_HINT },
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, args.week);
    const players = await selected(
      ctx,
      args.players,
      w,
      50,
      inputs,
      warnings,
      league.my_team?.team_id ?? null,
    );
    const full = args.detail === "full";
    let native: readonly NativeProjection[] | null = null;
    let stale = false;
    try {
      const got = await withinBudget(
        () =>
          ctx.services.platform.getNativeProjections(
            leagueRef(ctx),
            players.map((p) => p.ref),
            args.horizon,
            w,
            readOpts(ctx, args),
          ),
        warnings,
      );
      native = got === null ? null : take(ctx, got, inputs);
    } catch (e) {
      if (!isDegradable(e)) throw e;
      warnings.push("espn:kona_player_info unavailable: the last espn_projection snapshot (stale)");
    }
    const split = args.horizon === "week" ? "weekly" : args.horizon;
    if (native === null) {
      stale = true;
      const snaps = ctx.services.espnProjections.asOf(
        league.ref.season,
        w,
        ctx.services.clock.nowIso(),
      );
      const last = ctx.services.espnProjections.lastSnapshotAt();
      native = snaps
        .filter((s) => s.split === split && players.some((p) => p.ref.id === s.player_id))
        .map((s) => ({
          player: { platform: "espn" as const, id: s.player_id },
          horizon: args.horizon,
          season: s.season,
          week: s.week,
          points: s.applied_total,
          raw: s.stats_raw,
          as_of: s.snapshot_at,
        }));
      if (last !== null)
        inputs.push({
          source: "store:espn_projection",
          as_of: last,
          fetched_at: last,
          state: "stale",
        });
    }
    const before = new Date(ctx.nowMs - DAY_MS).toISOString();
    const prior = new Map<number, number>();
    try {
      for (const s of ctx.services.espnProjections.asOf(league.ref.season, w, before))
        if (s.split === split) prior.set(s.player_id, s.applied_total);
    } catch {
      // no snapshot history: nothing reads as revised
    }
    const remaining = Math.max(0, league.clock.final_scoring_period - w + 1);
    const data: EspnProjectionsData = {
      source: "espn:projection",
      projections: players.map((p) => {
        const np = native.find((x) => x.player.id === p.ref.id) ?? null;
        const was = prior.get(p.ref.id);
        return {
          player_id: p.ref.id,
          name: p.name,
          position: p.position,
          week:
            np === null || args.horizon !== "week"
              ? null
              : { week: np.week ?? w, points: np.points, ...(full ? { stats: np.raw } : {}) },
          ros:
            np === null || args.horizon !== "ros"
              ? null
              : { points: np.points, weeks_remaining: remaining },
          preseason_full_season: np !== null && args.horizon === "preseason" ? np.points : null,
          as_of: np?.as_of ?? null,
          revised_recently:
            np !== null && was !== undefined && Math.abs(np.points - was) > REVISION_POINTS,
        };
      }),
      note: PROJECTIONS_NOTE,
    };
    const absent = data.projections.filter(
      (x) => x.week === null && x.ros === null && x.preseason_full_season === null,
    ).length;
    if (absent > 0) warnings.push(`${String(absent)} player(s) carry no ESPN projection here`);
    return {
      data,
      inputs,
      warnings,
      estimate: false,
      extraSources: ["espn:projection"],
      partial: stale,
      listKey: "projections",
      week: w,
    };
  },
});

// --- C4 espn_get_player_outlook ------------------------------------------------------------------

/** C4 data (plan 07 C4; PlayerOutlookData). */
export const playerOutlookSchema = z.strictObject({
  players: z
    .array(
      z.strictObject({
        player_id: playerId,
        name: playerName,
        last_news_at: isoNull,
        season_outlook: utOrNull,
        weekly: weekMap(ut),
        flags: z.array(z.enum(INJECTION_FLAGS)).max(4),
        claim: z
          .strictObject({
            type: z.enum([
              "availability",
              "role",
              "health",
              "coaching_intent",
              "transaction",
              "other",
            ]),
            direction: z.enum(["up", "down", "neutral"]),
            extractor: z.literal("rules_v1"),
          })
          .nullable(),
      }),
    )
    .max(25),
});

/** The union of the wrappers' flags, in the fixed vocabulary order. */
function flagsOf(texts: readonly (UntrustedText | null)[]): InjectionFlag[] {
  const seen = new Set<InjectionFlag>();
  for (const t of texts) for (const f of t?.untrusted_text.flags ?? []) seen.add(f);
  return INJECTION_FLAGS.filter((f) => seen.has(f));
}

/** C4 `espn_get_player_outlook`. */
export const getPlayerOutlook = defineTool({
  name: "espn_get_player_outlook",
  description:
    "ESPN's editorial outlook paragraphs (untrusted text, injection-flagged) for up to 12 players or a team, with a rules-based claim extract.",
  input: z.strictObject({
    players: outlookSelectorSchema,
    weeks: z
      .array(weekSchema)
      .min(1)
      .max(BOUNDS.scheduleWeeks.max)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate_weeks" })
      .optional(),
    include_season_outlook: z.boolean().default(false),
    ...analyticsFreshnessShape,
  }),
  data: playerOutlookSchema,
  budget: "list",
  opaqueInput: { players: "exactly one of {player_ids:[<=12]} or {team_id}" },
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const league = await leagueOf(ctx, inputs, args);
    const current = weekOf(league, undefined);
    const weeks = args.weeks ?? [current];
    const top = Math.max(...weeks);
    let players: readonly PlatformPlayer[];
    if ("team_id" in args.players) {
      const team = args.players.team_id;
      const rosters = await rostersOf(ctx, current, inputs, warnings, args, team);
      const r = rosters.find((x) => x.team.team_id === team);
      if (r === undefined) throw new EffError("NOT_FOUND");
      players = r.entries.map((e) => e.player);
    } else {
      const got = await ctx.services.platform.getPlayers(
        leagueRef(ctx),
        args.players.player_ids.map((id) => ({ platform: "espn" as const, id })),
        top,
        readOpts(ctx, args),
      );
      players = take(ctx, got, inputs);
      const missing = args.players.player_ids.length - players.length;
      if (missing > 0) warnings.push(`${String(missing)} requested player(s) not found`);
    }
    if (players.length === 0) throw new EffError("NOT_FOUND");
    if (players.length > BOUNDS.outlookIds.max)
      warnings.push(
        `outlooks for ${String(players.length)} players: the result may be cut to the budget`,
      );
    let outlooks: Awaited<ReturnType<typeof ctx.services.platform.getPlayerOutlooks>>["value"] = [];
    try {
      const got = await withinBudget(
        () =>
          ctx.services.platform.getPlayerOutlooks(
            leagueRef(ctx),
            players.slice(0, 50).map((p) => p.ref),
            weeks,
            readOpts(ctx, args),
          ),
        warnings,
      );
      if (got !== null) outlooks = take(ctx, got, inputs);
    } catch (e) {
      if (!isDegradable(e)) throw e;
      warnings.push(
        "espn:kona_player_info unavailable: the ESPN outlook paragraphs are missing (espn_get_news has headlines)",
      );
    }
    const byId = new Map(outlooks.map((o) => [o.player.id, o]));
    const data: PlayerOutlookData = {
      players: players.map((p) => {
        const o = byId.get(p.ref.id);
        const weekly: Record<string, UntrustedText> = {};
        for (const w of [...weeks].sort((a, b) => a - b)) {
          const t = o?.weekly[String(w)];
          if (t !== undefined) weekly[String(w)] = t;
        }
        const season = args.include_season_outlook ? (o?.season ?? null) : null;
        const newest = [...weeks].sort((a, b) => b - a).map((w) => weekly[String(w)]);
        const text: UntrustedText | null = newest.find((t) => t !== undefined) ?? season;
        const claim = toClaimExtract(
          text === null ? null : extractClaim(text.untrusted_text.value),
        );
        return {
          player_id: p.ref.id,
          name: p.name,
          last_news_at: p.last_news_at,
          season_outlook: season,
          weekly,
          flags: flagsOf([season, ...Object.values(weekly)]),
          claim,
        };
      }),
    };
    return { data, inputs, warnings, listKey: "players", week: current };
  },
});
