// league.ts — the ESPN-fact league tools (plan 07 §3.A): A1 espn_get_league (the settings digest
// incl. the seeding reading flagged until confirmed — C12 — and the golden state), A2
// espn_get_standings (each team's trade-block note wrapped, `espn.team.trade_block` — plan 01 §4.4;
// data a Skill quotes, never an input — plan 09 TR-INJ), A3 espn_get_scoreboard, A4 espn_get_live_scoreboard (ESPN's live numbers,
// labelled; degrades to A3's results), A5 espn_get_box_score (the engine's recomputation and the
// golden `match` per stat and per total — C6, plan 08 §6), A6 espn_list_transactions (ESPN's feed
// merged with transactions_seen; the provisional community shape degrades to partial — ADV OBJ-19(c)).
// Every read goes through the provider (cache-first, limiter, drift) under the call's budget.
import { z } from "zod/v4";
import {
  DISPUTED_STAT_IDS,
  familyVerification,
  isLeagueWideMismatch,
  scoringEngine,
  statLineFromEspn,
  unmappedIds,
} from "../../domain/scoring/index.js";
import type { ScoringSettings } from "../../domain/scoring/types.js";
import { positionNameOf } from "../../domain/league/slots.js";
import { matchupPeriodOfWeek } from "../../domain/league/rules.js";
import { lockPlan, weekGameState } from "../../domain/league/schedule.js";
import { seedingDigest, seedingEvidence } from "../../domain/league/seeding.js";
import {
  REPRODUCTION_FINDINGS,
  reproduceSeason,
  reproductionInputFrom,
  seedingEvidenceFromReproduction,
} from "../../domain/analytics/seeding-reproduce/index.js";
import {
  LEAGUE_DIGEST_SECTIONS,
  type BoxScoreData,
  type BoxScoreEntry,
  type BoxScorePlayerRow,
  type BoxScoreSide,
  type BoxScoreSideRow,
  type GameState,
  type LeagueClock,
  type LeagueDigestData,
  type LeagueDigestSection,
  type LiveMatchup,
  type LiveScoreboardData,
  type Matchup,
  type ProSchedule,
  type ScoreboardData,
  type ScoringDigest,
  type SeedingEvidence,
  type Standings,
  type Transaction,
  type TransactionsData,
  type TransactionType,
  type Week,
  type IsoInstant,
  TRANSACTIONS_RANGE_MAX,
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
  clockWeek,
  isDegradable,
  leagueOf,
  leagueRef,
  platformInput,
  readOpts,
  rulesOf,
  scheduleOf,
  seasonTransactions,
  settingsOf,
  take,
  teamOf,
  turn,
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
        verified: z.boolean(),
        unverified_stat_ids: z.array(statId).max(40),
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
  method: z.enum(["reproduction", "standings"]),
  findings: z.array(z.enum(REPRODUCTION_FINDINGS)).max(REPRODUCTION_FINDINGS.length),
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
      current_week: z.number().int().min(0).max(25),
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
  const verification = familyVerification(settings);
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
    // plan 08 §6 step 6 / plan 10 B13: `verified: false` per family the golden has not verified
    // (familyVerification returns one row per settings.families entry, in the same order)
    families: settings.families.map((f, i) => {
      const v = verification[i];
      return {
        family: f.family,
        members: f.members.map((m) => ({ stat_id: m.platform_id, lower: m.lower, upper: m.upper })),
        verified: v?.verified ?? false,
        unverified_stat_ids: [...(v?.unverified_stat_ids ?? [])],
      };
    }),
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

/**
 * The past seasons ESPN answered ESPN_LEAGUE_NOT_FOUND for, per provider (one per server process):
 * a league's earlier seasons never appear later, so a season before the league's first is asked
 * once per session, never again (Stage C finding `espn-missing-season-404-not-cached`: the seeding
 * evidence of a first-season league re-sent three 404s on every call, each spending the 30/min
 * window). Only seasons before the configured one are remembered.
 */
const ABSENT_SEASONS = new WeakMap<object, Set<number>>();

function absentSeasons(ctx: ToolContext): Set<number> {
  const key = ctx.services.platform as object;
  let set = ABSENT_SEASONS.get(key);
  if (set === undefined) {
    set = new Set();
    ABSENT_SEASONS.set(key, set);
  }
  return set;
}

function isLeagueNotFound(e: unknown): boolean {
  return (e as { effCode?: unknown } | null)?.effCode === "ESPN_LEAGUE_NOT_FOUND";
}

/** Remembers a past season ESPN has no league for (a no-op for anything else). */
export function rememberAbsentSeason(ctx: ToolContext, season: number, e: unknown): void {
  if (isLeagueNotFound(e) && season < ctx.services.league.season) absentSeasons(ctx).add(season);
}

/** ESPN_LEAGUE_NOT_FOUND without a request for a past season already known absent. */
export function refuseAbsentSeason(ctx: ToolContext, season: number): void {
  if (season < ctx.services.league.season && absentSeasons(ctx).has(season))
    throw new EffError("ESPN_LEAGUE_NOT_FOUND");
}

/** The fixed warning for evidence that cannot exist: the league has no previous season on ESPN. */
export const NO_PREVIOUS_SEASON_WARNING =
  "seeding evidence unavailable: ESPN has no previous season of this league (its first season)";

/**
 * Last season's seed table (onboard's one-time evidence — ADV OBJ-13): the previous season's exact
 * reproduction with the simulator's tiebreak chain (Stage C; `reproduceSeason` over that season's
 * playoff settings, standings, schedule and bracket-edit flag — the C4 reading), else the
 * standings-only orders when its settings or schedule cannot be read (said); null when even its
 * standings cannot. The settings are read first: without them nothing can be reproduced, and the
 * league read and every identity read of that season then reuse them (cached) — three requests in
 * all (settings, standings, schedule), the per-call budget once this season's settings are cached.
 */
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
  // a season ESPN already answered "no such league" for is not asked again this session
  if (absentSeasons(ctx).has(prev)) {
    warnings.push(NO_PREVIOUS_SEASON_WARNING);
    return null;
  }
  const ref = leagueRef(ctx, prev);
  const ABSENT = Symbol("absent");
  const read = await withinBudget(
    () => ctx.services.platform.getLeagueRules(ref, readOpts(ctx)),
    warnings,
  ).catch((e: unknown) => {
    rememberAbsentSeason(ctx, prev, e);
    return isLeagueNotFound(e) ? ABSENT : null;
  });
  // no league that season: its standings would 404 too — no further request
  if (read === ABSENT) {
    warnings.push(NO_PREVIOUS_SEASON_WARNING);
    return null;
  }
  const rules = read;
  let standings: Standings;
  try {
    const got = await withinBudget(
      () => ctx.services.platform.getStandings(ref, readOpts(ctx)),
      warnings,
    );
    if (got === null) return null;
    standings = take(ctx, got, inputs);
  } catch (e) {
    rememberAbsentSeason(ctx, prev, e);
    warnings.push(
      isLeagueNotFound(e)
        ? NO_PREVIOUS_SEASON_WARNING
        : "seeding evidence unavailable: last season could not be read",
    );
    return null;
  }
  if (rules !== null) {
    try {
      const mu = await withinBudget(
        () => ctx.services.platform.getMatchups(ref, readOpts(ctx)),
        warnings,
      );
      if (mu !== null) {
        const matchups = take(ctx, mu, inputs);
        const prevRules = take(ctx, rules, inputs);
        // the bracket-edit flag is best effort: unknown (null) when the league read fails
        const lg = await withinBudget(
          () => ctx.services.platform.getLeague(ref, readOpts(ctx)),
          warnings,
        ).catch(() => null);
        const league = lg === null ? null : take(ctx, lg, inputs);
        const reproduction = reproduceSeason(
          reproductionInputFrom({
            season: prev,
            standings: standings.teams,
            matchups,
            rules: prevRules,
            league,
          }),
        );
        return seedingEvidenceFromReproduction(
          reproduction,
          league?.playoff_matchup_edited ?? null,
          new Map(standings.teams.map((t) => [t.team_id, t.playoff_seed])),
        );
      }
    } catch {
      // fall through to the standings-only comparison, said
    }
  }
  warnings.push(
    "seeding evidence: last season's schedule or settings could not be read: the standings-only comparison is shown",
  );
  return seedingEvidence(
    prev,
    standings.teams.map((t) => ({
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
}

/**
 * The week A1's `current_week_final` / `corrections_window_open` describe (common.ts clockWeek, the
 * one rule every default week follows): re-exported where it was first defined.
 */
export { clockWeek };

/**
 * A1's clock block: ESPN's clock, `current_week` — the week it means (clockWeek: the current
 * scoring period, the league's final one after the season), which every tool's default week is —
 * and that week's two flags. Without it a model read "current_scoring_period 19" beside
 * "current_week_final true" and could not tell which week the flag described (Stage C finding
 * league-postseason-default-week-18).
 */
export type DigestClock = LeagueClock & {
  readonly current_week: Week;
  readonly current_week_final: boolean;
  readonly corrections_window_open: boolean;
};

/** A1's data: LeagueDigestData with the clock block naming its week (DigestClock). */
export type LeagueDigestOut = Omit<LeagueDigestData, "clock"> & { readonly clock?: DigestClock };

/** The A1 digest (also espn-ff://league/settings). */
export async function leagueDigest(
  ctx: ToolContext,
  args: {
    readonly season?: number | undefined;
    readonly include?: readonly LeagueDigestSection[] | undefined;
    readonly force_refresh?: boolean | undefined;
  },
): Promise<{ data: LeagueDigestOut; inputs: InputStamp[]; warnings: string[] }> {
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
  // a past season ESPN already answered "no such league" for is answered without a request
  refuseAbsentSeason(ctx, seasonY);
  const lg = await ctx.services.platform.getLeague(ref, opts).catch((e: unknown) => {
    rememberAbsentSeason(ctx, seasonY, e);
    throw e;
  });
  inputs.push(platformInput(ctx, lg.stamp));
  const league = lg.value;
  const rules = (await ctx.services.platform.getLeagueRules(ref, readOpts(ctx))).value;
  const data: { -readonly [K in keyof LeagueDigestOut]: LeagueDigestOut[K] } = {
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
      const st = weekGameState(sched.schedule, clockWeek(league.clock), ctx.nowMs);
      final = st.final;
      window = st.corrections_window_open;
    } else {
      warnings.push(
        "pro schedule unavailable: current_week_final and corrections_window_open are conservative",
      );
    }
    data.clock = {
      ...league.clock,
      current_week: clockWeek(league.clock),
      current_week_final: final,
      corrections_window_open: window,
    };
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
        trade_block: ut.nullable(),
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
        winner: z.enum(["HOME", "AWAY", "TIE", "UNDECIDED"]).nullable(),
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
  gameState: GameState = e.game_state,
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
    game_state: gameState,
    ...(full && actual !== null ? { stats: actual.raw, applied_stats: actual.applied_stats } : {}),
  };
}

function boxSide(
  s: BoxScoreSide,
  settings: ScoringSettings | null,
  full: boolean,
  states: ReadonlyMap<number, GameState> | null,
): BoxScoreSideRow {
  return {
    team_id: s.team_id,
    name: s.name,
    total_points: s.total_points,
    players: s.entries.map((e) =>
      boxRow(e, settings, full, states?.get(e.player.ref.id) ?? e.game_state),
    ),
  };
}

/**
 * Each box-score player's game state from the pro schedule — the one derivation espn_get_roster uses
 * (lockPlan: `final` once the game's stats are official, `bye` when his team has no game that week,
 * `in`/`pre`/`tbd` otherwise; a week the schedule holds no game for is `tbd`). The box score's own
 * state only knows whether ESPN sent an actual line: ESPN sends none in a bye week, so a bye player
 * read `pre` during the week, and `bye` never let the week turn final (Stage C finding
 * boxscore-bye-blocks-final). null when the schedule cannot be read this call.
 */
export function boxGameStates(
  chosen: readonly { home: BoxScoreSide; away: BoxScoreSide | null }[],
  schedule: Pick<ProSchedule, "games"> | null,
  week: Week,
  nowMs: number,
): ReadonlyMap<number, GameState> | null {
  if (schedule === null) return null;
  const subjects = chosen.flatMap((m) =>
    [...m.home.entries, ...(m.away?.entries ?? [])].map((e) => ({
      player_id: e.player.ref.id,
      pro_team_id: e.player.pro_team_id,
      lineup_locked: false,
    })),
  );
  const plan = lockPlan(subjects, schedule, week, null, nowMs);
  return new Map(plan.players.map((p) => [p.player_id, p.game_state]));
}

/** Said when a league-wide golden mismatch marked the cached settings outdated (plan 08 §6 step 3(d)). */
export const SETTINGS_REREAD_WARNING =
  "the league settings scored here were a cached copy: they are re-read on the next call (a commissioner's scoring edit raises settings_changed)";

/**
 * Whether the league settings this call scored with were a copy fetched before the call began (an
 * `espn:mSettings` input fetched earlier than its start) — a copy a commissioner's edit can have
 * outdated, unlike one ESPN answered during the call.
 */
export function settingsCachedBefore(inputs: readonly InputStamp[], callStartMs: number): boolean {
  return inputs.some((i) => {
    if (i.source !== "espn:mSettings") return false;
    const at = Date.parse(i.fetched_at);
    return Number.isFinite(at) && at < callStartMs;
  });
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
    // a week outside the league's season (week 18 of a 17-period league) has no box score:
    // NOT_FOUND before any request — never the INTERNAL a missing fixture or an empty schedule gives
    const { first_scoring_period: first, final_scoring_period: last } = league.clock;
    if (args.week < first || args.week > last) throw new EffError("NOT_FOUND");
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
    const sched = await withinBudget(
      () => scheduleOf(ctx, league.ref.season, inputs, args.allow_stale === true),
      warnings,
    ).catch(() => null);
    const states = boxGameStates(chosen, sched?.schedule ?? null, args.week, ctx.nowMs);
    const matchups = chosen.map((m) => ({
      matchup_id: m.matchup_id,
      home: boxSide(m.home, settings, full, states),
      away: m.away === null ? null : boxSide(m.away, settings, full, states),
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
    // final once the week's games are official: every player's game is final, and a player on bye
    // has no game to wait for (he never blocks it)
    const rows = matchups.flatMap((m) => [...m.home.players, ...(m.away?.players ?? [])]);
    const final =
      !flags.provisional &&
      rows.length > 0 &&
      rows.every((r) => r.game_state === "final" || r.game_state === "bye");
    if (settings !== null && checked > 0) {
      const g = ctx.services.golden;
      g.last_checked_week = args.week;
      g.status = matched === checked ? "match" : "mismatch";
      g.mismatch_share = share;
      g.settings_hash = settings.settings_hash;
      if (share !== null && isLeagueWideMismatch(checked - matched, checked)) {
        warnings.push(
          `scoring mismatch on more than 10% of checked player-weeks (${String(checked - matched)} of ${String(checked)})`,
        );
        // plan 08 §6 step 3(d), §9: a league-wide mismatch marks the settings cache dirty — the
        // settings scored here were a copy fetched before this call, and a commissioner's edit is
        // the likeliest cause: the next settings read asks ESPN again (a new hash raises
        // settings_changed). Settings fetched in this call are ESPN's current ones, and a re-read
        // would change nothing, so a mismatch that persists re-reads them once, never every call
        // (Stage C finding cache-settings-invalidation-triggers-missing)
        if (settingsCachedBefore(inputs, ctx.nowMs)) {
          try {
            ctx.services.platform.invalidateSettings(leagueRef(ctx));
            warnings.push(SETTINGS_REREAD_WARNING);
          } catch {
            // the bookkeeping is best effort: the settings' own TTL still re-reads them
          }
        }
      }
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

/** The oldest instant (processed, else proposed) among stored rows, or null when none is dated. */
export function oldestInstant(rows: readonly Transaction[]): IsoInstant | null {
  let best: number | null = null;
  let iso: IsoInstant | null = null;
  for (const t of rows) {
    const at = t.process_date ?? t.proposed_date;
    if (at === null) continue;
    const ms = Date.parse(at);
    if (Number.isFinite(ms) && (best === null || ms < best)) {
      best = ms;
      iso = at;
    }
  }
  return iso;
}

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
    // the configured league-season's stored rows only: transactions_seen keeps every season the
    // server has seen or backfilled (Stage C finding transactions-store-not-season-scoped)
    await turn();
    const stored = seasonTransactions(ctx.services.transactionsSeen, league.ref.season, null);
    if (stored.capped)
      warnings.push(
        `season ${String(league.ref.season)}: only its newest ${String(TRANSACTIONS_RANGE_MAX)} stored transactions are read`,
      );
    const sinceMs = since === null ? null : Date.parse(since);
    const seen =
      sinceMs === null
        ? stored.rows
        : stored.rows.filter((t) => {
            const at = Date.parse(t.process_date ?? t.proposed_date ?? "");
            return !Number.isFinite(at) || at >= sinceMs;
          });
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
    // this season's stored history (its oldest row), never a previous season's backfilled rows
    const oldest = oldestInstant(stored.rows);
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
