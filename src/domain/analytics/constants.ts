// constants.ts — every tuning constant of the P0 analytics in ONE place (plan 07 E1, E2, E3, E5;
// research 05 §1.2–§1.3, §2.2–§2.4, §3.2, §4.3, §5). Values marked [U] are unverified starting
// points the retrospective tunes (research 05 §8.4); nothing is inline in the engines.
// Ported from sibling @f6ba81e (src/domain/analytics/constants.ts), adapted to ESPN's native
// projection (v1-ensemble), the waiver-priority DP and the two-reading seeding simulator.

/** The projection model this module implements (plan 07 E1). */
export const MODEL_VERSION = "v1-ensemble" as const;
/** The canonical-line source tag of our projection lines (plan 08 §2 StatLineSource). */
export const PROJECTION_SOURCE = "projection:v1-ensemble" as const;

// --- E1 projections ----------------------------------------------------------------------------------

/**
 * Weekly coefficient of variation of fantasy points by ESPN display position (sibling research 05
 * §1 step 9, half-PPR 2015–2021 midpoints: RB 0.585, WR 0.625, TE 0.665; K [U]). The QB value is the
 * 4-pt-TD base of QB_CV; D/ST and the team units are [U] (no cited figure).
 */
export const POSITION_CV: Readonly<Record<string, number>> = Object.freeze({
  QB: 0.391,
  TQB: 0.391,
  RB: 0.585,
  WR: 0.625,
  TE: 0.665,
  K: 0.55,
  "D/ST": 0.75,
  HC: 0.75,
});
/** The CV of a position the table does not name [U]. */
export const DEFAULT_CV = 0.65;

/**
 * QB weekly CV moves with the pass-TD value (research 05 §3.2 [V-data]: top-12 QBs 0.391 / 0.401 /
 * 0.411 at 4 / 5 / 6 points, 2025): cv = base + perPoint × (pass_td points − refPoints), clamped.
 */
export const QB_CV = Object.freeze({
  base: 0.391,
  perPoint: 0.01,
  refPoints: 4,
  min: 0.3,
  max: 0.5,
});

/**
 * P(active) by ESPN `injuryStatus` (sibling research 05 §3.5: Questionable on the final report
 * played 71 % of the time, Doubtful 5.9 % [V Footballguys]; OUT / IR / SSPD never play). DAY_TO_DAY
 * has no base rate: it is read as Questionable [U]. ACTIVE or no designation → 1.
 */
export const P_ACTIVE_BY_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ACTIVE: 1,
  QUESTIONABLE: 0.71,
  DOUBTFUL: 0.059,
  OUT: 0,
  INJURY_RESERVE: 0,
  SUSPENSION: 0,
  DAY_TO_DAY: 0.71,
});

/**
 * The zero mass a projection Dist may carry while ESPN's mean stays the point estimate: below this
 * P(active) the active-conditional mean would exceed 1/floor × ESPN's (a Doubtful player projected
 * at 12 would need 200 points when he plays), so the shape uses the floor and the reported
 * `p_active` keeps the base rate (decision recorded; [U]).
 */
export const P_ACTIVE_SHAPE_FLOOR = 0.5;

/** The trailing nflverse window that shapes the distribution (sibling research 05 §1 step 2). */
export const TRAILING = Object.freeze({
  /** Most games kept in the window. */
  maxGames: 8,
  /** Half-life of the exponential weights, in games. */
  halfLifeGames: 3,
  /** Weight multiplier for a game of the previous season [U]. */
  priorSeasonWeight: 0.5,
});

/**
 * Turnover rates per game the trailing line is shrunk toward (sibling research 05 §1 step 4 priors:
 * QB 0.8 INT / 0.2 fumbles lost; RB 0.07, WR 0.04, TE 0.03 fumbles lost) with strength `k` games-
 * equivalent (turnovers carry little forward signal — k = 6) [U].
 */
export const TURNOVER_PRIOR: Readonly<
  Record<string, { readonly int: number; readonly fum: number }>
> = Object.freeze({
  QB: { int: 0.8, fum: 0.2 },
  TQB: { int: 0.8, fum: 0.2 },
  RB: { int: 0, fum: 0.07 },
  WR: { int: 0, fum: 0.04 },
  TE: { int: 0, fum: 0.03 },
});
export const TURNOVER_SHRINK_K = 6;
/** The canonical stats the turnover tail reads (ESPN 20 and 72 — plan 08 stat map). */
export const TURNOVER_STATS = Object.freeze({ int: "pass_int", fum: "fum_lost" } as const);

/**
 * Simulation sizes (plan 07 E1 `n_sims` 1000..N_SIMS_MAX, default 4000). N_SIMS_MAX is set by
 * measurement (tests/domain/analytics/nsims.perf.test.ts; docs/evals/1a-analytics.md): the worst
 * in-bounds E1 call — 50 pool players × 18 weeks — at N_SIMS_MAX samples per player-week, after
 * `maxTotalSamples` shares n_sims down, stays inside half of the 8 s CPU deadline on the
 * development Mac. The seeding simulator's paths share the same ceiling (BOUNDS.nSimsSeason).
 */
export const SIMS = Object.freeze({
  min: 1000,
  default: 4000,
  /** Measured — see the header. */
  max: 20_000,
  /**
   * The most samples one E1 call draws: n_sims is shared down evenly over the call's player-weeks
   * past this (never below `min`), so 50 players × 18 weeks never multiplies into minutes.
   */
  maxTotalSamples: 4_000_000,
});
/** The measured `n_sims` ceiling (plan 07 E1 A-7) — src/mcp/bounds.ts `N_SIMS_MAX` mirrors it. */
export const N_SIMS_MAX = SIMS.max;

/** Cooperative batching (plan 01 §1.1, plan 03 §1.2; ADV OBJ-07). */
export const COOPERATIVE = Object.freeze({
  /** Yield to the event loop after at most this much CPU in one batch (≤ 20 ms). */
  batchMs: 16,
  /** The per-call CPU deadline; past it a call returns `partial: true` (plan 07 E1; A16a). */
  deadlineMs: 8000,
  /** Steps between clock reads inside a batch (a clock read per step would dominate). */
  checkEvery: 64,
});

/** z of the 90th percentile (p10/p90 = μ ∓ z·σ under the normal approximation). */
export const Z90 = 1.2815515655446004;
/** z of the 75th percentile. */
export const Z75 = 0.6744897501960817;

// --- E2 lineup -------------------------------------------------------------------------------------

/**
 * Same-team weekly correlations (research 05 §3.2 [V-data], this format 2024–2025 at the 5-pt TD:
 * QB–WR1 0.353, QB–TE1 0.281; sibling research 05 §3.3: QB–RB +0.07, WR–WR −0.02). Others 0.
 */
export const SAME_TEAM_RHO: Readonly<Record<string, number>> = Object.freeze({
  "QB|WR": 0.353,
  "QB|TE": 0.281,
  "QB|RB": 0.07,
  "WR|WR": -0.02,
});

/** Lineup solver and objective constants (research 05 §2.2, §3.3; sibling §3.1–§3.5). */
export const LINEUP = Object.freeze({
  /** Added to every legal (player, starting seat) weight so filling seats dominates the mean. */
  fillBonus: 1e4,
  /** A player already in a seat keeps it on a tie (no churn swaps). */
  stayBonus: 1e-6,
  /** Forced starters dominate the fill bonus. */
  forceBonus: 1e7,
  /** |μ_m − μ_o| below this share of σ(M − O) reads `neutral`. */
  neutralZ: 0.1,
  /** P(win) outside [1 − x, x] is saturated: under reading (a) the PF tiebreak then drives the mode. */
  saturatedPwin: 0.9,
  /** Under reading (b), a PF gap to the cutoff beyond this many points per remaining week decides protect/chase [U]. */
  pfGapPerWeek: 5,
  /** Variance weights λ searched for `pwin`/`blend` (maximise Σμ + λΣσ² over the mean–variance hull). */
  lambdaGrid: Object.freeze([0, 0.002, 0.005, 0.01, 0.02, 0.04, 0.08, 0.16, 0.32]),
  /** Projection-mean error per started player (points, sd) behind the P(win) interval [U]. */
  muErrorSdPerPlayer: 1.5,
  /** Default blend weight on the P(win) term for `objective: blend`. */
  blendWeight: 0.5,
  /** Inactives are published about 90 minutes before kickoff — a conditional's `decided_by`. */
  inactivesLeadMs: 90 * 60 * 1000,
  /** Players one lineup solve accepts (a 16-man roster with every IR seat, plus spares). */
  maxPlayers: 60,
  /** `compare[]` pairs evaluated (plan 07 E2 ≤ 5). */
  maxCompare: 5,
});

// --- E3 seeding simulator ---------------------------------------------------------------------------

/** The seeding simulator (research 05 §2.4; plan 07 E3; plan 10 A10a). */
export const SEEDING = Object.freeze({
  /** Paths by default (research 05 §2.4: ≥ 10 000). */
  defaultPaths: 10_000,
  /** The fewest paths a call may ask for (plan 07 E3 n_sims 1000..). */
  minPaths: 1000,
  /** The season-to-date mean is shrunk toward the league mean with weight n / (n + shrinkGames). */
  shrinkGames: 4,
  /** σ when fewer than two team-weeks exist to pool from [U] (half-PPR 10-team weekly totals ~20). */
  defaultSigma: 20,
  /** The league mean when no week has been played and no projection is given [U]. */
  defaultMean: 100,
  /** Marginal-value perturbations (research 05 §2.4 outputs). */
  pfDeltas: Object.freeze([20, 40, 80]),
  plusPointsPerWeek: 3,
  sigmaScales: Object.freeze([0.7, 1.4]),
  /** The PF perturbation the exchange rate is read from (one win ≈ X·ΔP(win)/ΔP(+X PF)). */
  exchangeRatePf: 40,
  /** Below this ΔP(playoffs) the +X PF effect is noise and the exchange rate is null. */
  minExchangeDelta: 0.002,
  /** Exchange rates are reported inside [0, this]. */
  maxPfPerWin: 1000,
  /** Teams one simulation accepts (ESPN leagues hold at most 20). */
  maxTeams: 20,
  /** Scenarios one call applies (plan 07 E3 ≤ 10). */
  maxScenarios: 10,
});

// --- E5 waivers -------------------------------------------------------------------------------------

/**
 * The cold-start waiver-priority DP (research 05 §1.2 [V-data, waiver_dp.py]): the per-week
 * surplus rate of the best weekly claim, the demand curve q(r) = min(qCap, q0 + q1·r) and the drift
 * c (a rival's per-week probability of a successful claim), for a reference N = 10. Reproduces the
 * research table cell for cell (tests/domain/analytics/waiver-dp.test.ts).
 */
export const WAIVER_DP = Object.freeze({
  rates: Object.freeze([
    Object.freeze({ r: 0, p: 0.3 }),
    Object.freeze({ r: 1, p: 0.3 }),
    Object.freeze({ r: 2.5, p: 0.2 }),
    Object.freeze({ r: 4.5, p: 0.12 }),
    Object.freeze({ r: 7, p: 0.06 }),
    Object.freeze({ r: 10, p: 0.02 }),
  ]),
  q0: 0.05,
  q1: 0.08,
  qCap: 0.85,
  drift: 0.25,
  /** The DP is solved for horizons up to this many weeks (an NFL season plus margin). */
  maxHorizon: 22,
  /** League sizes the DP accepts. */
  minTeams: 2,
  maxTeams: 20,
});

/**
 * P(role holds) cold-start prior by position (plan 07 E5 "a cold-start prior by position × injury
 * status"): the first week's probability and a weekly decay [U]. The injury status multiplies the
 * first week by its P(active) and recovers at `injuryRecovery` per week.
 */
const ROLE_BASE: Readonly<Record<string, number>> = Object.freeze({
  QB: 0.9,
  TQB: 0.9,
  RB: 0.8,
  WR: 0.85,
  TE: 0.85,
  K: 0.97,
  "D/ST": 0.98,
});
export const ROLE_HOLDS = Object.freeze({
  base: ROLE_BASE,
  defaultBase: 0.8,
  weeklyDecay: 0.97,
  injuryRecovery: 0.5,
});

/** E5 verdict constants (research 05 §1.2–§1.5). */
export const WAIVERS = Object.freeze({
  /** P(clears to FA) at or above which a candidate goes on the scramble list. */
  scrambleMinClear: 0.3,
  /** A passed candidate that clears with at least this probability reads `fa_add_after_run`. */
  faAfterRunMinClear: 0.5,
  /** Demand sensitivity behind the `p_clears_to_fa` interval (research 05 §1.2 ×0.5 / ×1.5). */
  demandBand: Object.freeze({ low: 0.5, high: 1.5 }),
  /** Candidates one call accepts (plan 07 E5 `candidates` ≤ 25, pool pages ≤ 3 × 50). */
  maxCandidates: 150,
  /** Weeks of value one call accepts (plan 07 E5 horizon_weeks ≤ 17, plus playoff margin). */
  maxWeeks: 22,
});

/** K/D-ST streaming (research 05 §5 K/D-ST, §4.2; sibling §8) [U]. */
export const KDST = Object.freeze({
  /** Look-ahead default for K/D-ST (plan 07 C5: `look_ahead` default 2). */
  lookAheadDefault: 2,
  lookAheadMax: 2,
  /** Hold the current starter unless the best streamer beats him by more than this (points). */
  holdMargin: 1,
  /** Candidates returned per position. */
  maxCandidatesPerPosition: 10,
  /** Samples behind the bracket expectation (a ranking needs means, not tails). */
  nSims: 2000,
  /** League-average implied team total when a game has no line (nflverse 2024–2025 ≈ 22.5). */
  leagueImplied: 22.5,
  /** Points allowed ~ Gamma(mean = opponent implied total, cv) (sibling DEF_SIM). */
  pointsAllowedCv: 0.42,
  /** Yards allowed ~ Gamma(mean = base × (opp implied / league implied)^β, cv). */
  yardsAllowedBase: 330,
  yardsAllowedBeta: 0.5,
  yardsAllowedCv: 0.2,
  /** Per-game D/ST event rates (sibling PRIOR_LINES.DEF) [U]. */
  rates: Object.freeze({
    dst_sack: 2.4,
    dst_int: 0.75,
    dst_fr: 0.55,
    dst_td: 0.12,
    dst_safety: 0.03,
    dst_blk: 0.07,
  }),
  /** Sacks and takeaways scale with the opponent's implied total as (league / opp)^β [U]. */
  eventBeta: 0.5,
  /** Kicker: FG attempts per game at the league-average implied total, and their distance mix [U]. */
  fgAttempts: 1.8,
  fgAttemptsBeta: 0.6,
  fgMix: Object.freeze([
    Object.freeze({ distance: 30, share: 0.45, make: 0.95 }),
    Object.freeze({ distance: 45, share: 0.35, make: 0.82 }),
    Object.freeze({ distance: 54, share: 0.18, make: 0.68 }),
    Object.freeze({ distance: 61, share: 0.02, make: 0.4 }),
  ]),
  /** PAT attempts per game per implied point (≈ 2.3 at 22.5) and the make rate. */
  patPerPoint: 0.1,
  patMake: 0.95,
});

// --- request bounds the engines enforce themselves (the tools' zod schemas are stricter) -------------

export const LIMITS = Object.freeze({
  /** Players projected in one call (E1 selector ≤ 25 or pool top ≤ 50; rosters ≤ 60). */
  maxTargets: 64,
  /** Weeks projected in one call (a ROS horizon). */
  maxWeeks: 22,
  /** Trailing lines read per player. */
  maxTrailing: 40,
});
