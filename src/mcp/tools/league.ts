// league.ts — the ESPN-fact league tools (plan 07 §3.A): A1 espn_get_league (the settings digest
// incl. the seeding reading flagged until confirmed — C12 — and the golden state), A2
// espn_get_standings, A3 espn_get_scoreboard, A4 espn_get_live_scoreboard (ESPN's live numbers,
// labelled; degrades to A3's results), A5 espn_get_box_score (the engine's recomputation and the
// golden `match` per stat and per total — C6, plan 08 §6), A6 espn_list_transactions (ESPN's feed
// merged with transactions_seen; the provisional community shape degrades to partial — ADV OBJ-19(c)).
// Every read goes through the provider (cache-first, limiter, drift) under the call's budget.
import { z } from "zod/v4";
import {
  DISPUTED_STAT_IDS,
  isLeagueWideMismatch,
  scoringEngine,
  statLineFromEspn,
  unmappedIds,
} from "../../domain/scoring/index.js";
import type { ScoringSettings } from "../../domain/scoring/types.js";
import { positionNameOf } from "../../domain/league/slots.js";
import { matchupPeriodOfWeek } from "../../domain/league/rules.js";
import { weekGameState } from "../../domain/league/schedule.js";
import { seedingDigest, seedingEvidence } from "../../domain/league/seeding.js";
import {
  LEAGUE_DIGEST_SECTIONS,
  type BoxScoreData,
  type BoxScoreEntry,
  type BoxScorePlayerRow,
  type BoxScoreSide,
  type BoxScoreSideRow,
  type LeagueDigestData,
  type LeagueDigestSection,
  type LiveMatchup,
  type LiveScoreboardData,
  type Matchup,
  type ScoreboardData,
  type ScoringDigest,
  type SeedingEvidence,
  type Standings,
  type Transaction,
  type TransactionsData,
  type TransactionType,
} from "../../domain/league/types.js";
import {
  BOUNDS,
  detailShape,
  espnFreshnessShape,
  isoInstantSchema,
  leagueIncludeSchema,
  matchupPeriodSchema,
  seasonSchema,
  teamIdSchema,
  transactionTypesSchema,
  txnCountSchema,
  weekSchema,
} from "../bounds.js";
import { TRUNCATION_HINTS, type InputStamp } from "../envelope.js";
import { EffError } from "../errors.js";
import { defineTool, dropLastTrim, type ToolContext } from "../define.js";
import {
  isDegradable,
  leagueOf,
  leagueRef,
  platformInput,
  readOpts,
  rulesOf,
  scheduleOf,
  settingsOf,
  take,
  teamOf,
  weekOf,
  withinBudget,
} from "./common.js";
import {
  canonical,
  code,
  count,
  isoNull,
  playerId,
  playerName,
  points,
  pointsNull,
  position,
  probNull,
  season,
  slotClass,
  slotName,
  statId,
  statMap,
  teamId,
  token,
  tokenNull,
  ut,
  utOrNull,
  week,
  weekMap,
  gameState,
} from "./schemas.js";

// --- A1 espn_get_league --------------------------------------------------------------------------

const scoringDigestSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        stat_id: statId,
        abbr: z.string().max(24),
        canonical: canonical.nullable(),
        points: z.number().min(-1000).max(1000),
        overrides: z.record(position, z.number().min(-1000).max(1000)),
        is_reverse: z.boolean(),
      }),
    )
    .max(500),
  families: z
    .array(
      z.strictObject({
        family: code,
        members: z
          .array(
            z.strictObject({
              stat_id: statId,
              lower: z.number(),
              upper: z.number().nullable(),
            }),
          )
          .max(40),
      }),
    )
    .max(40),
  unmapped_stat_ids: z.array(statId).max(500),
  disputed_stat_ids: z.array(statId).max(10),
  settings_hash: z.string().regex(/^[0-9a-f]{64}$/),
  golden: z.strictObject({
    last_checked_week: week.nullable(),
    status: z.enum(["match", "mismatch", "unchecked"]),
    mismatch_share: probNull,
  }),
});

const rosterSlotsSchema = z.strictObject({
  slots: z
    .array(
      z.strictObject({
        slot_id: z.number().int().min(0).max(99),
        name: slotName,
        class: slotClass,
        count: count,
        eligible_positions: z.array(position).max(30),
      }),
    )
    .max(40),
  starters: count,
  bench: count,
  ir: count,
  total: count,
  lineup_lock_type: tokenNull,
  undroppable_list: z.boolean().nullable(),
  position_limits: z.record(position, count.nullable()),
  move_limit: count.nullable(),
});

const leagueRulesSchema = z.strictObject({
  waiver: z.strictObject({
    type: token,
    uses_budget: z.boolean().nullable(),
    budget: count.nullable(),
    min_bid: count.nullable(),
    waiver_hours: count.nullable(),
    process_days: z.array(token).max(14),
    process_hour: z.number().int().min(0).max(23).nullable(),
    order_reset: z.boolean().nullable(),
    next_execution: isoNull,
    last_execution: isoNull,
    acquisition_limit: count.nullable(),
    matchup_acquisition_limit: count.nullable(),
    matchup_limit_per_period: z.boolean().nullable(),
    unverified: z.array(z.string().max(80)).max(20),
  }),
  trade: z.strictObject({
    deadline: isoNull,
    revision_hours: count.nullable(),
    veto_votes_required: count.nullable(),
    max: count.nullable(),
  }),
  playoffs: z.strictObject({
    team_count: count.nullable(),
    seeding_rule: token,
    seeding_rule_by: z.number().int().nullable(),
    reseed: z.boolean().nullable(),
    matchup_period_length: count.nullable(),
    variable_length: z.boolean().nullable(),
    consolation: z.boolean().nullable(),
    regular_season_matchups: count.nullable(),
    matchup_periods: z.record(z.string().regex(/^[0-9]{1,2}$/), z.array(week).max(10)),
    playoff_weeks: z.array(week).max(10),
    bye_seeds: count.nullable(),
  }),
  ties: z.strictObject({ matchup_tie_rule: tokenNull, playoff_tie_rule: tokenNull }),
  fees: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.number()).nullable(),
  waiver_system: z.enum(["faab", "priority_move_to_last", "continuous", "unknown"]),
  predicates: z.strictObject({
    has_faab: z.boolean().nullable(),
    is_move_to_last: z.boolean().nullable(),
  }),
  unverified_fields: z.array(z.string().max(80)).max(50),
});

const seedingEvidenceSchema = z.strictObject({
  season,
  seed_order_matches_pf: z.boolean(),
  seed_order_matches_record: z.boolean(),
  playoff_edited: z.boolean().nullable(),
  suggests: z.enum(["espn_rule", "points_only", "unknown"]),
  table: z
    .array(
      z.strictObject({
        team_id: teamId,
        seed: count.nullable(),
        record_rank: count.nullable(),
        pf_rank: count.nullable(),
      }),
    )
    .max(40),
});

/** A1 data (plan 07 A1; LeagueDigestData) — a section is present only when included. */
export const leagueDigestSchema = z.strictObject({
  league: z
    .strictObject({
      season,
      size: count,
      scoring_type: token,
      is_public: z.boolean().nullable(),
      name: ut,
      my_team: z.strictObject({ team_id: teamId, name: ut }).nullable(),
      commissioner: z.boolean(),
    })
    .optional(),
  clock: z
    .strictObject({
      current_matchup_period: z.number().int().min(0).max(25),
      current_scoring_period: z.number().int().min(0).max(25),
      latest_scoring_period: z.number().int().min(0).max(25),
      final_scoring_period: z.number().int().min(0).max(25),
      first_scoring_period: z.number().int().min(0).max(25),
      transaction_scoring_period: z.number().int().min(0).max(25).nullable(),
      is_active: z.boolean(),
      is_expired: z.boolean().nullable(),
      current_week_final: z.boolean(),
      corrections_window_open: z.boolean(),
    })
    .optional(),
  scoring: scoringDigestSchema.optional(),
  roster: rosterSlotsSchema.optional(),
  rules: leagueRulesSchema.optional(),
  seeding: z
    .strictObject({
      rule: token,
      mode_configured: z.enum(["espn_rule", "points_only"]),
      confirmed: z.boolean(),
      mode_in_use: z.enum(["espn_rule", "points_only"]),
      evidence: seedingEvidenceSchema.nullable(),
    })
    .optional(),
  unverified_fields: z.array(z.string().max(80)).max(80),
});

/** The A1 scoring section from normalised settings (position overrides keyed by position name). */
export function scoringDigest(
  settings: ScoringSettings,
  golden: ScoringDigest["golden"],
): ScoringDigest {
  return {
    items: settings.rules.map((r) => ({
      stat_id: r.platform_id,
      abbr: r.abbr.slice(0, 24),
      canonical: r.canonical,
      points: r.points,
      overrides: Object.fromEntries(
        Object.entries(r.overrides).map(([k, v]) => [positionNameOf(Number(k)) ?? `POS_${k}`, v]),
      ),
      is_reverse: r.is_reverse,
    })),
    families: settings.families.map((f) => ({
      family: f.family,
      members: f.members.map((m) => ({ stat_id: m.platform_id, lower: m.lower, upper: m.upper })),
    })),
    unmapped_stat_ids: [...unmappedIds(settings)],
    disputed_stat_ids: settings.rules
      .filter((r) => r.disputed && DISPUTED_STAT_IDS.includes(r.platform_id))
      .map((r) => r.platform_id),
    settings_hash: settings.settings_hash,
    golden,
  };
}

/** The golden state A1 reports for `settings` (A5 writes it; unchecked for any other hash). */
export function goldenFor(ctx: ToolContext, settings: ScoringSettings): ScoringDigest["golden"] {
  const g = ctx.services.golden;
  if (g.settings_hash !== settings.settings_hash || g.status === "unchecked")
    return { last_checked_week: null, status: "unchecked", mismatch_share: null };
  return {
    last_checked_week: g.last_checked_week,
    status: g.status,
    mismatch_share: g.mismatch_share,
  };
}

/** Last season's seed-vs-PF table (onboard's one-time evidence — ADV OBJ-13); null on failure. */
async function evidenceOf(
  ctx: ToolContext,
  seasonY: number,
  rule: string,
  teamCount: number | null,
  inputs: InputStamp[],
  warnings: string[],
): Promise<SeedingEvidence | null> {
  const prev = seasonY - 1;
  if (prev < BOUNDS.season.min) return null;
  try {
    const got = await withinBudget(
      () => ctx.services.platform.getStandings(leagueRef(ctx, prev), readOpts(ctx)),
      warnings,
    );
    if (got === null) return null;
    const st = take(ctx, got, inputs);
    return seedingEvidence(
      prev,
      st.teams.map((t) => ({
        team_id: t.team_id,
        seed: t.playoff_seed,
        division_id: t.division_id,
        wins: t.wins,
        losses: t.losses,
        ties: t.ties,
        points_for: t.points_for,
      })),
      { team_count: teamCount, seeding_rule: rule, playoff_edited: null },
    );
  } catch {
    warnings.push("seeding evidence unavailable: last season could not be read");
    return null;
  }
}

/** The A1 digest (also espn-ff://league/settings). */
export async function leagueDigest(
  ctx: ToolContext,
  args: {
    readonly season?: number | undefined;
    readonly include?: readonly LeagueDigestSection[] | undefined;
    readonly force_refresh?: boolean | undefined;
  },
): Promise<{ data: LeagueDigestData; inputs: InputStamp[]; warnings: string[] }> {
  const inputs: InputStamp[] = [];
  const warnings: string[] = [];
  const configured = ctx.services.league.season;
  const seasonY = args.season ?? configured;
  if (seasonY > configured)
    throw new EffError("VALIDATION", { field: "season", reason: "too_big" });
  const include = new Set<LeagueDigestSection>(
    args.include ?? LEAGUE_DIGEST_SECTIONS.filter((s) => s !== "seeding_evidence"),
  );
  const ref = leagueRef(ctx, seasonY);
  const opts = readOpts(ctx, args);
  const lg = await ctx.services.platform.getLeague(ref, opts);
  inputs.push(platformInput(ctx, lg.stamp));
  const league = lg.value;
  const rules = (await ctx.services.platform.getLeagueRules(ref, readOpts(ctx))).value;
  const data: { -readonly [K in keyof LeagueDigestData]: LeagueDigestData[K] } = {
    unverified_fields: [...rules.unverified_fields],
  };
  if (include.has("league"))
    data.league = {
      season: league.ref.season,
      size: league.size,
      scoring_type: league.scoring_type,
      is_public: league.is_public,
      name: league.name,
      my_team: league.my_team,
      commissioner: league.commissioner,
    };
  if (include.has("clock")) {
    let final = false;
    let window = true;
    const sched = await withinBudget(() => scheduleOf(ctx, seasonY, inputs), warnings).catch(
      () => null,
    );
    if (sched !== null) {
      const st = weekGameState(sched.schedule, league.clock.current_scoring_period, ctx.nowMs);
      final = st.final;
      window = st.corrections_window_open;
    } else {
      warnings.push(
        "pro schedule unavailable: current_week_final and corrections_window_open are conservative",
      );
    }
    data.clock = { ...league.clock, current_week_final: final, corrections_window_open: window };
  }
  if (include.has("scoring")) {
    const settings = (await ctx.services.platform.getScoringSettings(ref, readOpts(ctx))).value;
    data.scoring = scoringDigest(settings, goldenFor(ctx, settings));
  }
  if (include.has("roster"))
    data.roster = (await ctx.services.platform.getRosterSlots(ref, readOpts(ctx))).value;
  if (include.has("rules")) data.rules = rules;
  if (include.has("seeding") || include.has("seeding_evidence")) {
    const evidence = include.has("seeding_evidence")
      ? await evidenceOf(
          ctx,
          seasonY,
          rules.playoffs.seeding_rule,
          rules.playoffs.team_count,
          inputs,
          warnings,
        )
      : null;
    data.seeding = seedingDigest(
      rules.playoffs.seeding_rule,
      {
        seeding_mode: ctx.services.seedingMode,
        seeding_confirmed_at: ctx.services.seedingConfirmedAt,
      },
      evidence,
    );
    if (!data.seeding.confirmed)
      warnings.push("seeding reading not confirmed: run the onboard Skill (eff setup --seeding)");
  }
  return { data, inputs, warnings };
}

/** A1 `espn_get_league`. */
export const getLeague = defineTool({
  name: "espn_get_league",
  description:
    "League settings digest: identity, clock, scoring rules with the golden check, roster slots, waiver/trade/playoff rules, seeding reading. Read once per session.",
  input: z.strictObject({
    season: seasonSchema.optional(),
    include: leagueIncludeSchema.optional(),
    ...espnFreshnessShape,
    ...detailShape,
  }),
  data: leagueDigestSchema,
  budget: "list",
  run: async (args, ctx) => {
    const r = await leagueDigest(ctx, args);
    return { data: r.data, inputs: r.inputs, warnings: r.warnings };
  },
});

// --- A2 espn_get_standings -----------------------------------------------------------------------

const transactionCounterSchema = z.strictObject({
  acquisitions: count,
  drops: count,
  trades: count,
  move_to_ir: count,
  move_to_active: count,
  budget_spent: z.number().min(0).nullable(),
  matchup_acquisitions: weekMap(count),
});

/** A2 data (plan 07 A2; Standings). */
export const standingsSchema = z.strictObject({
  teams: z
    .array(
      z.strictObject({
        team_id: teamId,
        name: ut,
        abbrev: ut,
        division_id: z.number().int().min(0).nullable(),
        rank: count.nullable(),
        playoff_seed: count.nullable(),
        wins: count,
        losses: count,
        ties: count,
        pct: probNull,
        points_for: points,
        points_against: points,
        streak: z.strictObject({ type: token, length: count }).nullable(),
        waiver_rank: count.nullable(),
        transaction_counter: transactionCounterSchema,
        playoff_pct_espn: probNull,
        projected_rank_espn: count.nullable(),
        clinch: tokenNull,
        eliminated: z.boolean().nullable(),
        is_transaction_locked: z.boolean().nullable(),
        is_mine: z.boolean(),
      }),
    )
    .max(40),
  waiver_order: z.array(teamId).max(40),
  playoff_line: z.strictObject({
    team_count: count.nullable(),
    seeding_rule: token,
    bye_seeds: count.nullable(),
  }),
  divisions: z
    .array(
      z.strictObject({ id: z.number().int().min(0), name: ut, team_ids: z.array(teamId).max(40) }),
    )
    .max(10),
});

/** A2 `espn_get_standings`. */
export const getStandings = defineTool({
  name: "espn_get_standings",
  description:
    "Standings with record, points for/against, waiver rank, transaction counters and ESPN playoff % (labelled).",
  input: z.strictObject({ ...espnFreshnessShape, ...detailShape }),
  data: standingsSchema,
  budget: "list",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const got = await ctx.services.platform.getStandings(leagueRef(ctx), readOpts(ctx, args));
    const data: Standings = take(ctx, got, inputs);
    return { data, inputs };
  },
});

// --- A3 espn_get_scoreboard ----------------------------------------------------------------------

const matchupSideSchema = z.strictObject({
  team_id: teamId,
  name: ut,
  points: pointsNull,
  points_by_week: weekMap(points),
  is_mine: z.boolean(),
});

/** A3 data (plan 07 A3; ScoreboardData). */
export const scoreboardSchema = z.strictObject({
  matchup_period: z.number().int().min(0).max(25),
  weeks: z.array(week).max(10),
  matchups: z
    .array(
      z.strictObject({
        matchup_id: z.number().int().min(0),
        matchup_period: z.number().int().min(0).max(25),
        playoff_tier: tokenNull,
        winner: z.enum(["HOME", "AWAY", "UNDECIDED"]).nullable(),
        is_bye: z.boolean(),
        home: matchupSideSchema,
        away: matchupSideSchema.nullable(),
      }),
    )
    .max(40),
});

/** The provisional / corrections flags of a set of weeks from the pro schedule (plan 01 §5.4). */
async function periodFlags(
  ctx: ToolContext,
  seasonY: number,
  weeks: readonly number[],
  inputs: InputStamp[],
  warnings: string[],
): Promise<{ provisional: boolean; corrections: boolean }> {
  const sched = await withinBudget(() => scheduleOf(ctx, seasonY, inputs), warnings).catch(
    () => null,
  );
  if (sched === null) return { provisional: true, corrections: true };
  let provisional = false;
  let corrections = false;
  for (const w of weeks) {
    const st = weekGameState(sched.schedule, w, ctx.nowMs);
    if (st.games > 0 && st.provisional) provisional = true;
    if (st.corrections_window_open) corrections = true;
  }
  return { provisional, corrections };
}

/** A3 `espn_get_scoreboard`. */
export const getScoreboard = defineTool({
  name: "espn_get_scoreboard",
  description:
    "Schedule and results for one matchup period (default: current): matchups, winners, points, byes. No live numbers.",
  input: z
    .strictObject({
      week: weekSchema.optional(),
      matchup_period: matchupPeriodSchema.optional(),
      team_id: teamIdSchema.optional(),
      ...espnFreshnessShape,
      ...detailShape,
    })
    .refine((a) => a.week === undefined || a.matchup_period === undefined, {
      message: "week_or_matchup_period",
      path: ["matchup_period"],
    }),
  data: scoreboardSchema,
  budget: "list",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const league = await leagueOf(ctx, inputs, args);
    let period = league.clock.current_matchup_period;
    if (args.matchup_period !== undefined) period = args.matchup_period;
    else if (args.week !== undefined) {
      const rules = await rulesOf(ctx, inputs);
      const mp = matchupPeriodOfWeek(rules.playoffs, args.week);
      if (mp === null) throw new EffError("NOT_FOUND");
      period = mp;
    }
    const got = await ctx.services.platform.getMatchups(leagueRef(ctx), readOpts(ctx, args));
    const all = take(ctx, got, inputs);
    let matchups = all.filter((m) => m.matchup_period === period);
    if (args.team_id !== undefined) {
      const t = args.team_id;
      matchups = matchups.filter((m) => m.home.team_id === t || m.away?.team_id === t);
      if (!all.some((m) => m.home.team_id === t || m.away?.team_id === t))
        throw new EffError("NOT_FOUND");
    }
    const rules = await rulesOf(ctx, inputs);
    const weeks = [...(rules.playoffs.matchup_periods[String(period)] ?? [])];
    const compact = args.detail !== "full";
    const data: ScoreboardData = {
      matchup_period: period,
      weeks,
      matchups: compact ? matchups.map(slimMatchup) : matchups,
    };
    const flags = await periodFlags(ctx, league.ref.season, weeks, inputs, warnings);
    return {
      data,
      inputs,
      warnings,
      provisional: flags.provisional,
      correctionsWindowOpen: flags.corrections,
      listKey: "matchups",
    };
  },
});

/** `compact`: a side's per-week map only when the period spans more than one week. */
function slimMatchup(m: Matchup): Matchup {
  const slim = (s: Matchup["home"]): Matchup["home"] =>
    Object.keys(s.points_by_week).length > 1 ? s : { ...s, points_by_week: {} };
  return { ...m, home: slim(m.home), away: m.away === null ? null : slim(m.away) };
}

// --- A4 espn_get_live_scoreboard -----------------------------------------------------------------

const liveSideSchema = z.strictObject({
  team_id: teamId,
  name: ut,
  points_live: pointsNull,
  projected_pre_espn: pointsNull,
  projected_live_espn: pointsNull,
  win_probability_espn: probNull,
  players: z.strictObject({ final: count, live: count, pending: count }).nullable(),
});

/** A4 data (plan 07 A4; LiveScoreboardData). */
export const liveScoreboardSchema = z.strictObject({
  week,
  game_window: z.strictObject({
    open: z.boolean(),
    games_in_progress: z.array(z.number().int()).max(20),
    next_kickoff: isoNull,
  }),
  matchups: z
    .array(
      z.strictObject({
        matchup_id: z.number().int().min(0),
        home: liveSideSchema,
        away: liveSideSchema.nullable(),
        is_mine: z.boolean(),
      }),
    )
    .max(40),
  my_matchup: z.number().int().min(0).nullable(),
});

/** A season matchup as a live row without live numbers (A4's degradation to A3 — plan 01 §7). */
function asLive(m: Matchup): LiveMatchup {
  const side = (s: Matchup["home"]): LiveMatchup["home"] => ({
    team_id: s.team_id,
    name: s.name,
    points_live: s.points,
    projected_pre_espn: null,
    projected_live_espn: null,
    win_probability_espn: null,
    players: null,
  });
  return {
    matchup_id: m.matchup_id,
    home: side(m.home),
    away: m.away === null ? null : side(m.away),
    is_mine: m.home.is_mine || m.away?.is_mine === true,
  };
}

/** A4 `espn_get_live_scoreboard`. */
export const getLiveScoreboard = defineTool({
  name: "espn_get_live_scoreboard",
  description:
    "ESPN's live totals, live projections and win probability for a week (labelled _espn), plus the NFL game window.",
  input: z.strictObject({
    week: weekSchema.optional(),
    team_id: teamIdSchema.optional(),
    force_refresh: z.boolean().optional(),
    allow_stale: z.boolean().optional(),
  }),
  data: liveScoreboardSchema,
  budget: "list",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, args.week);
    let matchups: readonly LiveMatchup[];
    try {
      const got = await ctx.services.platform.getLiveMatchups(
        leagueRef(ctx),
        w,
        readOpts(ctx, args),
      );
      matchups = take(ctx, got, inputs);
    } catch (e) {
      if (!isDegradable(e)) throw e;
      const rules = await rulesOf(ctx, inputs);
      const mp = matchupPeriodOfWeek(rules.playoffs, w);
      const got = await ctx.services.platform.getMatchups(leagueRef(ctx), readOpts(ctx));
      matchups = take(ctx, got, inputs)
        .filter((m) => m.matchup_period === mp)
        .map(asLive);
      warnings.push("live totals and win probability unavailable: season results only");
    }
    if (args.team_id !== undefined) {
      const t = args.team_id;
      matchups = matchups.filter((m) => m.home.team_id === t || m.away?.team_id === t);
      if (matchups.length === 0) throw new EffError("NOT_FOUND");
    }
    const sched = await withinBudget(
      () => scheduleOf(ctx, league.ref.season, inputs),
      warnings,
    ).catch(() => null);
    const st = sched === null ? null : weekGameState(sched.schedule, w, ctx.nowMs);
    if (st === null) warnings.push("pro schedule unavailable: game window unknown");
    const data: LiveScoreboardData = {
      week: w,
      game_window: {
        open: st?.game_window_open ?? false,
        games_in_progress: st === null ? [] : [...st.games_in_progress],
        next_kickoff: st?.next_kickoff ?? null,
      },
      matchups,
      my_matchup: matchups.find((m) => m.is_mine)?.matchup_id ?? null,
    };
    return {
      data,
      inputs,
      warnings,
      provisional: st === null ? true : st.provisional,
      correctionsWindowOpen: st?.corrections_window_open ?? true,
      week: w,
    };
  },
});

// --- A5 espn_get_box_score -----------------------------------------------------------------------

const boxPlayerSchema = z.strictObject({
  player_id: playerId,
  name: playerName,
  position,
  slot: slotName,
  slot_class: slotClass,
  points_espn: pointsNull,
  engine_points: pointsNull,
  match: z.boolean().nullable(),
  mismatch_stat_ids: z.array(statId).max(200),
  projected_espn: pointsNull,
  game_state: gameState,
  stats: statMap.optional(),
  applied_stats: statMap.optional(),
});

const boxSideSchema = z.strictObject({
  team_id: teamId,
  name: ut,
  total_points: pointsNull,
  players: z.array(boxPlayerSchema).max(60),
});

/** A5 data (plan 07 A5; BoxScoreData). */
export const boxScoreSchema = z.strictObject({
  week,
  final: z.boolean(),
  matchups: z
    .array(
      z.strictObject({
        matchup_id: z.number().int().min(0),
        home: boxSideSchema,
        away: boxSideSchema.nullable(),
      }),
    )
    .max(40),
  golden: z.strictObject({
    checked: count,
    matched: count,
    mismatch_share: probNull,
    settings_hash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

/** One box-score row with the engine's recomputation and the per-stat golden verdict. */
export function boxRow(
  e: BoxScoreEntry,
  settings: ScoringSettings | null,
  full: boolean,
): BoxScorePlayerRow {
  const actual = e.actual;
  let engine: number | null = null;
  let match: boolean | null = null;
  let mismatch: string[] = [];
  if (actual !== null && settings !== null) {
    try {
      const { line } = statLineFromEspn(
        { raw: actual.raw, provisional: actual.provisional, split: actual.split },
        e.player.position_id,
      );
      engine = scoringEngine.score(line, settings).points;
      if (actual.applied_total !== null) {
        const v = scoringEngine.verify(line, settings, {
          total: actual.applied_total,
          by_stat: actual.applied_stats,
        });
        match = v.match;
        mismatch = [...v.mismatch_stat_ids];
      }
    } catch {
      engine = null;
      match = null;
    }
  }
  return {
    player_id: e.player.ref.id,
    name: e.player.name,
    position: e.player.position,
    slot: e.slot,
    slot_class: e.slot_class,
    points_espn: actual?.applied_total ?? null,
    engine_points: engine,
    match,
    mismatch_stat_ids: mismatch,
    projected_espn: e.projected?.applied_total ?? null,
    game_state: e.game_state,
    ...(full && actual !== null ? { stats: actual.raw, applied_stats: actual.applied_stats } : {}),
  };
}

function boxSide(
  s: BoxScoreSide,
  settings: ScoringSettings | null,
  full: boolean,
): BoxScoreSideRow {
  return {
    team_id: s.team_id,
    name: s.name,
    total_points: s.total_points,
    players: s.entries.map((e) => boxRow(e, settings, full)),
  };
}

/** A5 `espn_get_box_score`. */
export const getBoxScore = defineTool({
  name: "espn_get_box_score",
  description:
    "Per-player actual and projected lines for a week (default: my matchup), recomputed under league scoring with the golden match per stat.",
  input: z
    .strictObject({
      week: weekSchema,
      matchup_id: z.number().int().min(0).max(10_000).optional(),
      team_id: teamIdSchema.optional(),
      all_matchups: z.boolean().default(false),
      ...espnFreshnessShape,
      ...detailShape,
    })
    .refine((a) => [a.matchup_id, a.team_id].filter((x) => x !== undefined).length <= 1, {
      message: "matchup_id_or_team_id",
      path: ["team_id"],
    }),
  data: boxScoreSchema,
  budget: "list",
  hint: TRUNCATION_HINTS.boxScore,
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const league = await leagueOf(ctx, inputs, args);
    let settings: ScoringSettings | null = null;
    try {
      settings = await settingsOf(ctx, inputs);
    } catch (e) {
      if ((e as { effCode?: unknown }).effCode !== "ESPN_DRIFT_DETECTED") throw e;
      warnings.push(
        "scoring settings drifted: engine_points and match are null (the server refuses to score)",
      );
    }
    const got = await ctx.services.platform.getBoxScores(
      leagueRef(ctx),
      args.week,
      readOpts(ctx, args),
    );
    const all = take(ctx, got, inputs);
    let chosen = all;
    if (!args.all_matchups) {
      if (args.matchup_id !== undefined)
        chosen = all.filter((m) => m.matchup_id === args.matchup_id);
      else {
        const t = teamOf(league, args.team_id);
        chosen = all.filter((m) => m.home.team_id === t || m.away?.team_id === t);
      }
      if (chosen.length === 0) throw new EffError("NOT_FOUND");
    }
    const full = args.detail === "full";
    const matchups = chosen.map((m) => ({
      matchup_id: m.matchup_id,
      home: boxSide(m.home, settings, full),
      away: m.away === null ? null : boxSide(m.away, settings, full),
    }));
    let checked = 0;
    let matched = 0;
    for (const m of matchups)
      for (const side of [m.home, m.away])
        for (const p of side?.players ?? [])
          if (p.match !== null) {
            checked++;
            if (p.match) matched++;
          }
    const share = checked === 0 ? null : (checked - matched) / checked;
    const flags = await periodFlags(ctx, league.ref.season, [args.week], inputs, warnings);
    const allEntries = chosen.flatMap((m) => [...m.home.entries, ...(m.away?.entries ?? [])]);
    const final =
      !flags.provisional &&
      allEntries.length > 0 &&
      allEntries.every((e) => e.game_state === "final");
    if (settings !== null && checked > 0) {
      const g = ctx.services.golden;
      g.last_checked_week = args.week;
      g.status = matched === checked ? "match" : "mismatch";
      g.mismatch_share = share;
      g.settings_hash = settings.settings_hash;
      if (share !== null && isLeagueWideMismatch(checked - matched, checked))
        warnings.push(
          `scoring mismatch on more than 10% of checked player-weeks (${String(checked - matched)} of ${String(checked)})`,
        );
    }
    const data: BoxScoreData = {
      week: args.week,
      final,
      matchups,
      golden: {
        checked,
        matched,
        mismatch_share: share,
        settings_hash: settings?.settings_hash ?? "0".repeat(64),
      },
    };
    return {
      data,
      inputs,
      warnings,
      provisional: !final,
      correctionsWindowOpen: flags.corrections,
      listKey: "matchups",
      trims: [dropLastTrim("matchups", matchups.length, TRUNCATION_HINTS.boxScore)],
      week: args.week,
    };
  },
});

// --- A6 espn_list_transactions -------------------------------------------------------------------

const txnSchema = z.strictObject({
  transaction_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  type: token,
  status: tokenNull,
  team_id: teamId.nullable(),
  team_name: utOrNull,
  scoring_period: z.number().int().min(0).max(25).nullable(),
  process_date: isoNull,
  proposed_date: isoNull,
  bid_amount: z.number().min(0).nullable(),
  items: z
    .array(
      z.strictObject({
        type: token,
        player_id: playerId,
        name: playerName.nullable(),
        from_team_id: z.number().int().min(-1).max(999).nullable(),
        to_team_id: z.number().int().min(-1).max(999).nullable(),
        from_slot: slotName.nullable(),
        to_slot: slotName.nullable(),
      }),
    )
    .max(40),
  related_transaction_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .nullable(),
  note: utOrNull,
});

/** A6 data (plan 07 A6; TransactionsData). */
export const transactionsSchema = z.strictObject({
  transactions: z.array(txnSchema).max(200),
  pending: z.array(txnSchema).max(200).nullable(),
  history_coverage: z.strictObject({ oldest_seen: isoNull, gap_suspected: z.boolean() }),
  learned: z.strictObject({
    second_claim_at_new_position: z.boolean().nullable(),
    waiver_rank_moves_on_success: z.boolean().nullable(),
  }),
});

const DEFAULT_TXN_TYPES: readonly TransactionType[] = Object.freeze([
  "FREEAGENT",
  "WAIVER",
  "WAIVER_ERROR",
  "TRADE_ACCEPT",
]);

/** A6 `espn_list_transactions`. */
export const listTransactions = defineTool({
  name: "espn_list_transactions",
  description:
    "Adds, drops, waiver claims (incl. losing) and trades: ESPN's feed merged with persisted history. A private league needs cookies.",
  input: z.strictObject({
    types: transactionTypesSchema.optional(),
    week: weekSchema.optional(),
    since: isoInstantSchema.optional(),
    count: txnCountSchema,
    pending: z.boolean().default(false),
    team_id: teamIdSchema.optional(),
    ...espnFreshnessShape,
    ...detailShape,
  }),
  data: transactionsSchema,
  budget: "list",
  pageable: false,
  hint: TRUNCATION_HINTS.transactions,
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, args.week);
    const since = args.since ?? null;
    const types = args.types ?? DEFAULT_TXN_TYPES;
    let espnTxns: readonly Transaction[] = [];
    let total: number | null = null;
    let fromHistory = false;
    try {
      const got = await ctx.services.platform.listTransactions(
        leagueRef(ctx),
        { types, week: w, since, count: args.count, team_id: args.team_id ?? null },
        readOpts(ctx, args),
      );
      const page = take(ctx, got, inputs);
      espnTxns = page.items;
      total = page.total;
    } catch (e) {
      if (!isDegradable(e)) throw e;
      fromHistory = true;
      warnings.push(
        "espn:mTransactions2 unavailable: served from the server's persisted history (stale)",
      );
    }
    const seen = ctx.services.transactionsSeen.list(since, args.count);
    const byId = new Map<string, Transaction>();
    for (const t of espnTxns) byId.set(t.transaction_id, t);
    for (const t of seen) {
      if (byId.has(t.transaction_id)) continue;
      if (!types.includes(t.type)) continue;
      if (args.team_id !== undefined && t.team_id !== args.team_id) continue;
      if (args.week !== undefined && t.scoring_period !== null && t.scoring_period !== args.week)
        continue;
      byId.set(t.transaction_id, t);
    }
    const order = (t: Transaction): number =>
      Date.parse(t.process_date ?? t.proposed_date ?? "1970-01-01T00:00:00Z") || 0;
    const merged = [...byId.values()].sort((a, b) => order(b) - order(a)).slice(0, args.count);
    let pending: Transaction[] | null = null;
    if (args.pending) {
      const got = await withinBudget(
        () => ctx.services.platform.listPendingTransactions(leagueRef(ctx), readOpts(ctx, args)),
        warnings,
      ).catch((e: unknown) => {
        if (!isDegradable(e)) throw e;
        warnings.push("espn:mPendingTransactions unavailable");
        return null;
      });
      pending = got === null ? null : [...take(ctx, got, inputs)];
    }
    const oldest = ctx.services.transactionsSeen.oldestSeen();
    const data: TransactionsData = {
      transactions: merged,
      pending,
      history_coverage: {
        oldest_seen: oldest,
        gap_suspected:
          oldest === null ||
          (since !== null && Date.parse(since) < Date.parse(oldest)) ||
          fromHistory,
      },
      learned: { second_claim_at_new_position: null, waiver_rank_moves_on_success: null },
    };
    return {
      data,
      inputs,
      warnings,
      partial: fromHistory,
      page: {
        limit: args.count,
        offset: 0,
        count: merged.length,
        total,
        has_more: total !== null ? merged.length < total : false,
        next_offset: null,
      },
      listKey: "transactions",
    };
  },
});
