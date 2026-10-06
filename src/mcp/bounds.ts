// bounds.ts — every numeric/string bound of plan 02 §5 and the plan 07 inputs (legend
// `PlayerSelector` incl. `pool`, §2 common inputs, per-tool caps) as constants plus zod v4 schemas:
// `scoringPeriodId` 0–22 outer bound and a tool's `week` 1–18 (changelog F61), `limit ≤ 100` (the
// mandatory sort is the filter builder's — plan 02 §5), ≤ 25 ids (≤ 12 for outlooks), the 8 s CPU
// deadline and N_SIMS_MAX (plan 07 A-7), and the E12 input schema composed from the envelope's
// Rec/Dist schemas. No league id argument anywhere (plan 02 §5). All values are plan 02 A-2
// assumptions, widened on evidence. Ported from sibling @d72e03b, adapted (ESPN integer ids).
import { z } from "zod/v4";
import { GSIS_ID_RE, SEASON_MIN, TEAM_ID_MAX, TEAM_ID_MIN, isNflTeam } from "../config/schema.js";
import { ESPN_TO_NFLVERSE_TEAM } from "../domain/crosswalk/types.js";
import {
  CLIENT_REF_RE,
  LOG_ID_RE,
  RECOMMENDATION_KINDS,
  TOOL_NAME_RE,
} from "../domain/reclog/types.js";
import { ESPN_PRO_TEAM_ABBREVS } from "../providers/platform.js";
import {
  INVALID_ID_MESSAGE,
  PRINTABLE_RE,
  REQUEST_ID_RE,
  alternativeSchema,
  boundedTextSchema,
  playerIdSchema,
  recSchema,
} from "./envelope.js";

export { INVALID_ID_MESSAGE, PRINTABLE_RE, REQUEST_ID_RE, boundedTextSchema, playerIdSchema };

// --- constants ------------------------------------------------------------------------------------

/** Every bound in one frozen table (plan 02 §5; plan 07 per-tool inputs). */
export const BOUNDS = Object.freeze({
  /** ESPN `scoringPeriodId`: 0 preseason … 22 (kickers carry 19–22 — research 04 §B.1.1). */
  scoringPeriod: { min: 0, max: 22 },
  /** A tool's `week` (plan 07 §2): 1–18; > 18 → VALIDATION with a hint. */
  week: { min: 1, max: 18 },
  matchupPeriod: { min: 1, max: 17 },
  /** 2018 … the current season (the upper bound is the caller's: `seasonSchemaFor`). */
  season: { min: SEASON_MIN, max: 2100 },
  teamId: { min: TEAM_ID_MIN, max: TEAM_ID_MAX },
  limit: { min: 1, max: 100, default: 25 },
  offset: { min: 0, max: 5000, default: 0 },
  searchChars: { min: 1, max: 64 },
  searchLimit: { min: 1, max: 25, default: 10 },
  playerIds: { min: 1, max: 25 },
  outlookIds: { min: 1, max: 12 },
  poolTop: { min: 1, max: 50 },
  txnCount: { min: 1, max: 200, default: 25 },
  scheduleWeeks: { min: 1, max: 6 },
  usageWindow: { min: 1, max: 17, default: 4 },
  sinceHours: { min: 1, max: 168, default: 72 },
  newsLimit: { min: 1, max: 50, default: 20 },
  sinceDays: { min: 1, max: 30, default: 7 },
  nSims: { min: 1000, max: 20_000, default: 4000 },
  seed: { min: 0, max: 2 ** 31 - 1 },
  blendWeight: { min: 0, max: 1 },
  compareSwaps: { max: 5 },
  scenarios: { max: 10 },
  waiverCandidates: { min: 1, max: 25 },
  horizonWeeks: { min: 1, max: 17 },
  lookAhead: { min: 0, max: 2, default: 1 },
  /** E5's default when `positions ⊆ {K, D/ST}` (plan 07 C5). */
  lookAheadKdstDefault: 2,
  tradeSide: { min: 1, max: 6 },
  maxPartners: { min: 1, max: 4, default: 3 },
  defenseWindowWeeks: { min: 4, max: 17, default: 10 },
  claimTextChars: 400,
  claimSourceChars: 64,
  recNoteChars: 200,
  recordInputChars: 20_000,
  minN: { min: 1, max: 10_000, default: 30 },
});

/** The per-call CPU deadline of the samplers (plan 07 E1 A-7; plan 01 §1.1 cooperative batches). */
export const ANALYTICS_CPU_DEADLINE_MS = 8000;
/** Samplers yield to the event loop every ≤ 20 ms of CPU; the stall bound is 50 ms (plan 03 §1.2). */
export const COOPERATIVE_BATCH_MS = 20;
export const MAX_LOOP_STALL_MS = 50;
/** The `n_sims` ceiling, bounded against the CPU deadline (re-measured at plan 10 A16a). */
export const N_SIMS_MAX = BOUNDS.nSims.max;

// --- primitives --------------------------------------------------------------------------------------

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** ESPN `scoringPeriodId` 0..22 (internal; tools take `week`). */
export const scoringPeriodSchema = int(BOUNDS.scoringPeriod.min, BOUNDS.scoringPeriod.max);
/** A tool's `week` 1..18 (omitted = the current matchup period's scoring period, resolved by the tool). */
export const weekSchema = int(BOUNDS.week.min, BOUNDS.week.max);
/** `matchup_period` 1..17. */
export const matchupPeriodSchema = int(BOUNDS.matchupPeriod.min, BOUNDS.matchupPeriod.max);
/** `team_id` 1..20 (omitted = my team). */
export const teamIdSchema = int(BOUNDS.teamId.min, BOUNDS.teamId.max);
/** A season with a static bound 2018..2100 — prefer `seasonSchemaFor(currentSeason)`. */
export const seasonSchema = int(BOUNDS.season.min, BOUNDS.season.max);
/** A season 2018..current (older → VALIDATION; plan 02 §5, research 03 §A.1). */
export function seasonSchemaFor(currentSeason: number) {
  if (!Number.isInteger(currentSeason) || currentSeason < SEASON_MIN)
    throw new RangeError("bounds: invalid current season");
  return int(SEASON_MIN, currentSeason);
}
/** Page size 1..100, default 25. */
export const limitSchema = int(BOUNDS.limit.min, BOUNDS.limit.max).default(BOUNDS.limit.default);
/** Page offset 0..5 000, default 0. */
export const offsetSchema = int(BOUNDS.offset.min, BOUNDS.offset.max).default(
  BOUNDS.offset.default,
);
/** `detail` (plan 07 C2), default `compact`. */
export const detailSchema = z.enum(["compact", "full"]).default("compact");
/** A gsis id. */
export const gsisIdSchema = z.string().regex(GSIS_ID_RE, { message: INVALID_ID_MESSAGE });
/** An ISO-8601 instant, ≤ 40 chars. */
export const isoInstantSchema = z.iso.datetime({ offset: true }).max(40);
/** A stat id (`stats{statId}` keys). */
export const STAT_ID_RE = /^[0-9]{1,4}$/;
export const statIdSchema = z.string().regex(STAT_ID_RE);
/** A position or slot name; the tool validates it against the league's own `roster.slots[]`. */
export const POSITION_NAME_RE = /^[A-Za-z][A-Za-z/]{0,9}$/;
export const positionSchema = z.string().regex(POSITION_NAME_RE);

/**
 * An NFL team: ESPN's abbreviations (as rows show them) or nflverse's spellings of the two that
 * differ (`WAS`, `LA`), normalised to ESPN's.
 */
const NFLVERSE_TO_ESPN: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(ESPN_TO_NFLVERSE_TEAM).map(([espn, nfl]) => [nfl, espn])),
);
export const nflTeamSchema = z
  .string()
  .refine((s) => ESPN_PRO_TEAM_ABBREVS.includes(s) || (isNflTeam(s) && s in NFLVERSE_TO_ESPN), {
    message: "unknown_team",
  })
  .transform((s) => NFLVERSE_TO_ESPN[s] ?? s);

/** Distinct ids, 1..max. */
const idList = (max: number) =>
  z
    .array(playerIdSchema)
    .min(1)
    .max(max)
    .refine((a) => new Set(a).size === a.length, { message: "duplicate_ids" });

/** 1..25 distinct ESPN player ids (plan 02 §5; larger sets go through a selector — T-11). */
export const playerIdsSchema = idList(BOUNDS.playerIds.max);
/** 1..25 distinct gsis ids. */
export const gsisIdsSchema = z
  .array(gsisIdSchema)
  .min(1)
  .max(BOUNDS.playerIds.max)
  .refine((a) => new Set(a).size === a.length, { message: "duplicate_ids" });

/** The pool selector (plan 07 legend) — the sanctioned way past 25 players. */
export const poolSelectorSchema = z.strictObject({
  pool: z.strictObject({
    status: z.enum(["FREEAGENT", "WAIVERS", "AVAILABLE"]),
    position: positionSchema,
    top: int(BOUNDS.poolTop.min, BOUNDS.poolTop.max),
  }),
});

/** `PlayerSelector` (plan 07 legend): exactly one of ids, gsis ids, a team, an NFL team, a pool. */
export const playerSelectorSchema = z.union([
  z.strictObject({ player_ids: playerIdsSchema }),
  z.strictObject({ gsis_ids: gsisIdsSchema }),
  z.strictObject({ team_id: teamIdSchema }),
  z.strictObject({ nfl_team: nflTeamSchema }),
  poolSelectorSchema,
]);
export type PlayerSelector = z.output<typeof playerSelectorSchema>;

/** A single-player selector (E7 `player`, E10 `player`): one id or one gsis id. */
export const singlePlayerSelectorSchema = z.union([
  z.strictObject({ player_ids: idList(1) }),
  z.strictObject({ gsis_ids: gsisIdsSchema.refine((a) => a.length === 1, { message: "too_big" }) }),
]);

/** C4's selector: ≤ 12 ids (the worst case stays under 20 000 chars — plan 07 C4). */
export const outlookSelectorSchema = z.union([
  z.strictObject({ player_ids: idList(BOUNDS.outlookIds.max) }),
  z.strictObject({ team_id: teamIdSchema }),
]);

/** A free-text search: 1..64 printable characters, trimmed (plan 02 §5). */
export const searchQuerySchema = z
  .string()
  .trim()
  .min(BOUNDS.searchChars.min)
  .max(BOUNDS.searchChars.max)
  .regex(PRINTABLE_RE, { message: "unprintable_characters" });

/** `client_ref` (plan 07 E12). */
export const clientRefSchema = z.string().regex(CLIENT_REF_RE);
/** A recommendation `log_id`. */
export const logIdSchema = z.string().max(30).regex(LOG_ID_RE, { message: INVALID_ID_MESSAGE });
/** A request id (`meta.request_id`). */
export const requestIdSchema = z.string().regex(REQUEST_ID_RE, { message: INVALID_ID_MESSAGE });
/** E1/E3 `seed`. */
export const seedSchema = int(BOUNDS.seed.min, BOUNDS.seed.max);
/** E1/E3 `n_sims`. */
export const nSimsSchema = int(BOUNDS.nSims.min, N_SIMS_MAX).default(BOUNDS.nSims.default);
/** A6 `count`. */
export const txnCountSchema = int(BOUNDS.txnCount.min, BOUNDS.txnCount.max).default(
  BOUNDS.txnCount.default,
);

// --- enums of the plan 07 inputs -----------------------------------------------------------------

/** C2 `status`. */
export const playerStatusSchema = z.enum(["FREEAGENT", "WAIVERS", "AVAILABLE", "ONTEAM", "ALL"]);
/** C2 `sort`. */
export const playerSortSchema = z.enum([
  "percOwned",
  "percChanged",
  "projection_week",
  "projection_ros",
  "draftRank",
  "name",
]);
/** A6 `types`. */
export const transactionTypesSchema = z
  .array(
    z.enum([
      "FREEAGENT",
      "WAIVER",
      "WAIVER_ERROR",
      "TRADE_ACCEPT",
      "TRADE_PROPOSAL",
      "TRADE_DECLINE",
      "ROSTER",
      "DRAFT",
    ]),
  )
  .min(1)
  .max(8);
/** A1 `include`. */
export const leagueIncludeSchema = z
  .array(z.enum(["league", "clock", "scoring", "roster", "rules", "seeding", "seeding_evidence"]))
  .min(1)
  .max(7);
/** E2 `objective`. */
export const objectiveSchema = z.enum(["auto", "mean", "pwin", "blend", "points_only"]);
/** E2/E3/E6 `seeding_mode` (`both` only when passed explicitly — ADV OBJ-13). */
export const seedingModeArgSchema = z.enum(["config", "espn_rule", "points_only", "both"]);
/** E5 `mode`, `phase`, `value_source`, `reserve`. */
export const waiverModeSchema = z.enum(["auto", "priority", "faab"]);
export const waiverPhaseSchema = z.enum(["auto", "pre_run", "post_run"]);
export const valueSourceSchema = z.enum(["auto", "espn_ros", "ensemble"]);
export const reserveSchema = z.enum(["none", "playoff_reserve"]);
/** E3 `mode`, `method`, `horizon`. */
export const matchupModeSchema = z.enum(["pre", "live", "season"]);
export const winProbMethodSchema = z.enum(["normal", "mc"]);
export const seasonHorizonSchema = z.enum(["regular", "through_playoffs"]);
/** E1 `horizon`; C3 `horizon`; B2 `type`. */
export const projectionHorizonSchema = z.enum(["week", "ros", "season"]);
export const espnProjectionHorizonSchema = z.enum(["week", "ros", "preseason"]);
export const statsTypeSchema = z.enum(["week", "season", "prior_season"]);

// --- common input shapes (plan 07 §2) --------------------------------------------------------------

/** `force_refresh?` + `allow_stale?` — ESPN-fact tools. */
export const espnFreshnessShape = {
  force_refresh: z.boolean().optional(),
  allow_stale: z.boolean().optional(),
} as const;
/** `allow_stale?` — analytics and dataset tools (they never force an ESPN refresh). */
export const analyticsFreshnessShape = { allow_stale: z.boolean().optional() } as const;
/** `detail` (default `compact`). */
export const detailShape = { detail: detailSchema } as const;
/** `limit` + `offset`. */
export const pageInputShape = { limit: limitSchema, offset: offsetSchema } as const;

// --- E12 espn_record_recommendation input (plan 07 E12) ------------------------------------------

/** `source_calls[]` item. */
export const sourceCallSchema = z.strictObject({
  tool: z.string().regex(TOOL_NAME_RE),
  request_id: requestIdSchema,
});

/** The most alternatives / source calls one record may carry. */
export const RECORD_LIMITS = Object.freeze({ alternatives: 10, sourceCalls: 25 });

/**
 * The E12 input schema. The league id and season are NOT inputs (the tool fills them); `rec.log_id`
 * must be null; the serialised input is capped at 20 000 characters.
 */
export const recordRecommendationInputSchema = z
  .strictObject({
    kind: z.enum(RECOMMENDATION_KINDS),
    /** 0..18: an onboarding or session record may be made in the preseason (period 0). */
    week: int(0, BOUNDS.week.max),
    rec: recSchema,
    alternatives: z.array(alternativeSchema).max(RECORD_LIMITS.alternatives).default([]),
    source_calls: z.array(sourceCallSchema).max(RECORD_LIMITS.sourceCalls).default([]),
    settings_hash: z.string().regex(/^[0-9a-f]{64}$/),
    seeding_mode_used: z.enum(["espn_rule", "points_only", "both"]).optional(),
    followed_hint: z.enum(["unknown", "user_said_yes", "user_said_no"]).default("unknown"),
    client_ref: clientRefSchema.optional(),
    note: boundedTextSchema(BOUNDS.recNoteChars).optional(),
  })
  .refine((v) => JSON.stringify(v).length <= BOUNDS.recordInputChars, {
    message: "input_too_large",
  });
export type RecordRecommendationArgs = z.output<typeof recordRecommendationInputSchema>;
