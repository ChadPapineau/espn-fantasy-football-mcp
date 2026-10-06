// marketConstants.ts — every tuning constant of the Phase-2 market engines in ONE place: E5's usage
// signals, fitted demand and FAAB mode (plan 07 E5; research 05 §1.3–§1.4; sib research 05 §4.1,
// §4.3), E6 trade (plan 07 E6; research 05 §5 Trades; sib §5.1–§5.7), E7 injury cascade (plan 07
// E7; research 05 §5 Injury cascade, §4.3; sib §6.1–§6.4), E10 evidence (plan 07 E10; research 05
// §6; sib §10), E11 league activity (plan 07 E11) and E1's `player_sim` hook (plan 07 E1; sib §1
// step 9). Values marked [U] are unverified starting points the retrospective tunes (research 05
// §8.4) and [F] are community heuristics stated as hypotheses (sib §4.1); nothing is inline in the
// engines. New here (the sibling shipped none of these engines).

// --- E5 usage signals (sib research 05 §4.1, ordered by lead time) ---------------------------------

/** Usage-first detection thresholds (plan 07 E5 P1; plan 10 B3). Every signal cites a number. */
export const SIGNALS = Object.freeze({
  /** A snap-share rise of ≥ 15 points held for two straight games is a role change [F]. */
  snapJump: 0.15,
  /** Games a jump must hold (the latest N games all above the baseline + threshold). */
  holdGames: 2,
  /** Target-share rise held over the same games [U]. */
  targetShareJump: 0.06,
  /** Red-zone opportunity-share rise held over the same games [U]. */
  rzShareJump: 0.1,
  /** xFP − actual over the window, per game, at or above which opportunity has not paid yet [U]. */
  xfpGapPerGame: 2,
  /** Games the xFP gap is summed over. */
  xfpWindow: 3,
  /** The team's implied total this week above its season mean by this many points [U]. */
  impliedTotalJump: 2.5,
  /** Baseline games before the hold window (the comparison mean). */
  baselineGames: 4,
  /** Fewest baseline games a jump needs (fewer → no jump signal, never a guess). */
  minBaselineGames: 2,
  /** Fewest games before any usage signal fires. */
  minGames: 3,
});

// --- E5 demand model (research 05 §1.3; plan 10 B4) ------------------------------------------------

/**
 * The warm demand model `q_i = logistic(a + b·upgrade_i + c·log(1+trend) + d·activity_i)` fitted on
 * the league's own WAIVER / WAIVER_ERROR rows by ridge-penalised IRLS (deterministic).
 */
export const DEMAND_FIT = Object.freeze({
  /** Fewest observations (and at least one claim and one non-claim) before a fit is used. */
  minObservations: 20,
  /** Ridge penalty on the non-intercept coefficients (a weak prior toward "no effect"). */
  ridge: 1,
  maxIterations: 60,
  tolerance: 1e-9,
  /** The fitted probability is reported inside [min, max] (never certainty from a small fit). */
  pMin: 0.005,
  pMax: 0.95,
  /** z of the fitted q_i interval on the linear predictor (90 %). */
  z: 1.6448536269514722,
  /** Weeks of the candidate's value a rival's upgrade is measured over (rivals claim for now). */
  upgradeWeeks: 4,
  /** A rival is "upgraded" by a player worth at least this many points per week to his lineup. */
  upgradedMinPerWeek: 0.5,
});

/** Same-run waiver-pair learning (research 05 §1.6 eval 4; plan 07 §6 clean negative). */
export const MECHANICS = Object.freeze({
  /** ESPN transaction types that are claims (a won and a failed one). */
  claimTypes: Object.freeze(["WAIVER", "WAIVER_ERROR"]),
});

// --- E5 FAAB mode (sib research 05 §4.3; research 05 §1.4) -----------------------------------------

/** FAAB bid sizing: first-price sealed bids with shading, the price of a point and λ [U]. */
export const FAAB = Object.freeze({
  /** Cold-start price of a point: the budget buys about this many surplus points a season [U]. */
  coldPointsPerBudget: 150,
  /** Shrinkage strength (in winning bids) of the league's own price toward the cold start. */
  priceShrinkBids: 5,
  /** Rivals shade their bids to this share of value × price (first-price auction) [U]. */
  rivalShading: 0.8,
  /** CV of a rival's bid around its mean (gamma) [U]. */
  rivalBidCv: 0.5,
  /** λ scales as (league-average remaining budget / mine)^this [U]. */
  scarcityExponent: 0.5,
  scarcityMin: 0.5,
  scarcityMax: 2,
  /** A playoff reserve raises λ by this factor (plan 07 E5 `reserve`). */
  reserveFactor: 1.25,
  /** Bids reported on the curve as shares of b* (plus the bids where P(win) crosses 25/50/75 %). */
  curveShares: Object.freeze([0.5, 1, 1.5]),
  curveTargets: Object.freeze([0.25, 0.5, 0.75]),
  /** Bid grid points searched for b* (integers up to the budget, thinned beyond this many). */
  maxGridPoints: 401,
});

// --- E6 trade (sib research 05 §5.1–§5.7; research 05 §5 Trades) ------------------------------------

/** Trade evaluation constants [U]. */
export const TRADE = Object.freeze({
  /**
   * Monte-Carlo paths behind the Δ intervals (common random numbers before/after). The interval is
   * [p10, p90]; `fair` iff it spans 0 (sib research 05 §14.4; plan 10 B5).
   */
  nSims: 200,
  /** Rest-of-season multiplier CV per position (talent/role uncertainty, not weekly noise) [U]. */
  rosCv: Object.freeze({
    QB: 0.2,
    TQB: 0.2,
    RB: 0.3,
    WR: 0.25,
    TE: 0.3,
    K: 0.2,
    "D/ST": 0.25,
  } as Record<string, number>),
  defaultRosCv: 0.3,
  /** Per-week probability a healthy player misses a game, by position (sib §5.4 prior) [U]. */
  weeklyMiss: Object.freeze({
    QB: 0.04,
    TQB: 0.04,
    RB: 0.06,
    WR: 0.05,
    TE: 0.05,
    K: 0.01,
    "D/ST": 0,
  } as Record<string, number>),
  defaultWeeklyMiss: 0.05,
  /** An injured player's absence recovers at this rate per week (the roleHolds rule) [U]. */
  injuryRecovery: 0.5,
  /** A proposal needs Δ_partner at or above this (sib §5.7: Δ_partner < 0 is never proposed). */
  partnerEpsilon: 0.5,
  /** Counter-offers returned. */
  maxCounters: 2,
  /** Partner search: the partner's players at the need position and my players offered, per team. */
  searchGets: 4,
  searchGives: 6,
  /** Veto risk: |Δ_me − Δ_partner| above these points reads medium / high. */
  vetoMedium: 15,
  vetoHigh: 30,
  /** Cold-start ΔP(playoffs) per win at the bubble (no season simulation given) [U]. */
  coldDpPlayoffsPerWin: 0.12,
  coldDpByePerWin: 0.05,
  /** Players one side may give or get (plan 07 E6 via sib E6 1..6). */
  maxPlayersPerSide: 6,
  /** Partners returned (plan 07 E6 via sib `max_partners` 1..4). */
  maxPartners: 4,
});

// --- E7 injury cascade (sib research 05 §6.1–§6.4; research 05 §5 Injury cascade) -------------------

/**
 * Role affinity: the share of a vacated component (targets, carries, red-zone opportunities) a
 * receiving position draws, by the injured player's position (sib §6.1: "a RB1's carries go to the
 * RB2 but his targets go to the pass-down back"; outside WR targets to the other receivers and the
 * TE) [U]. Multiplied by the receiver's own current share of that component.
 */
export const AFFINITY: Readonly<
  Record<string, Readonly<Record<"targets" | "carries" | "rz", Readonly<Record<string, number>>>>>
> = Object.freeze({
  RB: Object.freeze({
    targets: Object.freeze({ RB: 0.6, WR: 0.25, TE: 0.3 }),
    carries: Object.freeze({ RB: 1, QB: 0.08, WR: 0.02 }),
    rz: Object.freeze({ RB: 1, TE: 0.3, WR: 0.2, QB: 0.1 }),
  }),
  WR: Object.freeze({
    targets: Object.freeze({ WR: 1, TE: 0.6, RB: 0.25 }),
    carries: Object.freeze({ WR: 0.1, RB: 0.05 }),
    rz: Object.freeze({ WR: 1, TE: 0.7, RB: 0.2 }),
  }),
  TE: Object.freeze({
    targets: Object.freeze({ TE: 1, WR: 0.6, RB: 0.2 }),
    carries: Object.freeze({}),
    rz: Object.freeze({ TE: 1, WR: 0.6, RB: 0.2 }),
  }),
  QB: Object.freeze({
    targets: Object.freeze({}),
    carries: Object.freeze({ QB: 1 }),
    rz: Object.freeze({ QB: 1 }),
  }),
});

/** Injury-cascade constants [U]. */
export const CASCADE = Object.freeze({
  /** Share of each vacated component redistributed among the listed teammates (the rest leaves). */
  retention: Object.freeze({ targets: 0.85, carries: 0.9, rz: 0.85 }),
  /** A teammate with no share of a component still draws this floor share of it. */
  shareFloor: 0.02,
  /** Team evidence counts once this many games without the starter exist (sib §6.2). */
  teamEvidenceMinGames: 2,
  /** Team evidence weight g / (g + this). */
  teamEvidenceShrink: 2,
  /** The offence loses volume without its starter: team volume × this when no line moved [U]. */
  volumeFactorNoLine: 0.97,
  volumeFactorMin: 0.5,
  /** Expected weeks out by ESPN status when no timeline is given (p25, p50, p75) [U]. */
  weeksPrior: Object.freeze({
    QUESTIONABLE: Object.freeze([0, 0, 1]),
    DAY_TO_DAY: Object.freeze([0, 0, 1]),
    DOUBTFUL: Object.freeze([0, 1, 1]),
    OUT: Object.freeze([1, 2, 4]),
    INJURY_RESERVE: Object.freeze([4, 6, 10]),
    SUSPENSION: Object.freeze([1, 2, 6]),
  } as Record<string, readonly [number, number, number]>),
  defaultWeeksPrior: [1, 1, 2] as const,
  /** P(still out) one week past p75 (timelines get revised — sib §6 pitfalls). */
  tailAfterP75: 0.25,
  /** The returning starter's ramp (sib §6.3: a backup who performed keeps a share) [U]. */
  ramp: Object.freeze({ weeks: 1, factor: 0.85 }),
  /** A committee forms with this weight on the beneficiary's non-dominant share [U]. */
  committeeRisk: 0.5,
  /** A backup QB plays at this share of the starter's projection [U]. */
  qbBackupFactor: 0.75,
  /** |percent_change| below this is not a market move (the crowd did not react). */
  marketMoveMin: 0.5,
  /** A beneficiary's own snap / opportunity-share jump that confirms the role (§4 signals). */
  usageConfirmSnap: 0.15,
  usageConfirmShare: 0.06,
  /** Beneficiaries returned. */
  maxBeneficiaries: 8,
  /** CV of a beneficiary's cascade gain (the role's size is uncertain) [U]. */
  gainCv: 0.6,
  /** Below this per-week gain a teammate is not listed. */
  minWeeklyGain: 0.1,
  /** Points per opportunity priors under the league's reception points (TDs carried by `rz`) [U]. */
  efficiency: Object.freeze({
    catchRate: Object.freeze({ RB: 0.78, WR: 0.64, TE: 0.7, QB: 0 } as Record<string, number>),
    yardsPerReception: Object.freeze({ RB: 7.5, WR: 12.5, TE: 10.5, QB: 0 } as Record<
      string,
      number
    >),
    yardsPerCarry: Object.freeze({ RB: 4.3, WR: 6, TE: 3, QB: 4.5 } as Record<string, number>),
    tdPerRzOpportunity: 0.2,
    recYardPoints: 0.1,
    rushYardPoints: 0.1,
    tdPoints: 6,
  }),
});

// --- E10 evidence (research 05 §6; sib research 05 §10) -----------------------------------------------

/**
 * The reliability of OFFICIAL evidence (the nflverse injury report and practice participation —
 * structured enums, not free text) [U]. Text claims take the evidence domain's hand-set table
 * (src/domain/evidence/reliability.ts) — one table, never two.
 */
export const OFFICIAL_RELIABILITY = Object.freeze({ availability: 0.9, health: 0.85 });

/** E10 constants. */
export const EVIDENCE = Object.freeze({
  /** `lastNewsDate` within this window counts as "moved". */
  newsFreshMs: 7 * 24 * 3600 * 1000,
  /** A role claim is confirmed by a usage jump this large (snap or opportunity share). */
  roleConfirmSnap: 0.1,
  roleConfirmShare: 0.05,
  /** Evidence items one result carries. */
  maxEvidence: 12,
});

// --- E11 league activity (plan 07 E11) ------------------------------------------------------------------

export const ACTIVITY = Object.freeze({
  /** Notable moves listed per team. */
  maxNotable: 5,
  /** Most-added / most-dropped players listed. */
  maxTop: 5,
  /** Weakest starting slots named per rival, and likely targets per rival. */
  maxWeakSlots: 2,
  maxTargets: 3,
  /** Transactions one call reads. */
  maxTransactions: 2000,
});

// --- E1 player_sim hook (plan 07 E1: `basis: "player_sim"` where the opportunity inputs exist) -------

/** The opportunity simulation (sib research 05 §1 step 9: volume × efficiency draws) [U]. */
export const PLAYER_SIM = Object.freeze({
  /** Fewest trailing games before the opportunity inputs count as existing. */
  minGames: 3,
  /** Game-script volume multiplier CV (gamma, shared by targets and carries). */
  volumeCv: 0.25,
  /** Yards per reception / per carry CV (gamma per event batch). */
  yardsCv: 0.45,
  /** Fumbles lost per touch [U]. */
  fumblePerTouch: 0.006,
  /** Samples drawn per player-week (bounded by the caller's n_sims). */
  defaultSamples: 2000,
  maxSamples: 20_000,
  /** The ESPN-anchored rescale is applied only within [1/x, x] of the simulated mean. */
  maxRescale: 3,
});
