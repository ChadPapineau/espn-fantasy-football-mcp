// objectiveSwitch.ts — the auto-default switch rule for start/sit (plan 10 C2 "the regret test:
// `objective: pwin` beats `mean` on regret → it becomes the `auto` default for `player_sim`"; plan 07
// E2 objective resolution: `pwin` when basis = player_sim AND C2 has shown it beats mean on regret;
// research 05 §8.4 "every claim of improvement must hold in both seasons and not be concentrated in
// weeks 1–3"; research 05 §8.4 / sib §12.6 "no conclusion from fewer than ~30 calls"). The evidence is
// the held-out replay's per-season mean regret of the two objectives on player_sim distributions
// (tests/backtest/lineup-history.test.ts recomputes it and holds the committed record below equal to
// it — docs/evals/phase3-startsit.md carries the same numbers); the decision is a pure function of
// the evidence, and E2 reads the committed record (lineup.ts). Nothing here re-fits at run time: a
// new record lands by a reviewed commit, the same posture as `eff tune --apply` (plan 10 §3.3).
// Types and data only — no engine import (lineup.ts imports this file). New here.
import type { StartSitRow } from "./types.js";

/** The switch rule's thresholds (plan 10 C2; research 05 §8.4). */
export const SWITCH_RULE = Object.freeze({
  /** Held-out seasons the claim must hold in, each (research 05 §8.4 "both seasons"). */
  minSeasons: 2,
  /** Team-weeks where pwin and mean start different players, over all seasons (research 05 §8.4 "~30 calls"). */
  minDiffering: 30,
  /** The claim must also hold without weeks 1..this (research 05 §8.4 "not concentrated in weeks 1–3"). */
  excludeThroughWeek: 3,
});

/** One held-out season's regret of the two objectives. */
export interface ObjectiveSwitchSeason {
  readonly season: number;
  /** Team-weeks replayed. */
  readonly n: number;
  /** …where pwin and mean started different players. */
  readonly n_differing: number;
  readonly regret_mean: number;
  readonly regret_pwin: number;
  /** Team-weeks after week SWITCH_RULE.excludeThroughWeek. */
  readonly n_later: number;
  readonly regret_mean_later: number;
  readonly regret_pwin_later: number;
}

/** The evidence behind a switch decision. */
export interface ObjectiveSwitchEvidence {
  /** The distributions the replay ran on (the rule is about player_sim). */
  readonly basis: "player_sim";
  /** Share of the replayed starters whose Dist was player_sim (the rest kept position_cv). */
  readonly player_sim_share: number;
  readonly seasons: readonly ObjectiveSwitchSeason[];
}

/** The decision's status. */
export type ObjectiveSwitchStatus = "switch" | "no_switch" | "insufficient";

/** Why (fixed vocabulary plus numbers — never third-party text). */
export interface ObjectiveSwitchDecision {
  readonly status: ObjectiveSwitchStatus;
  /** pwin becomes the auto default for player_sim. */
  readonly switch: boolean;
  readonly reasons: readonly string[];
}

/** A committed decision and the evidence it was made on. */
export interface ObjectiveSwitchRecord {
  readonly evidence: ObjectiveSwitchEvidence;
  readonly decision: ObjectiveSwitchDecision;
  /** Where the numbers are reported. */
  readonly source: string;
}

const EPS = 1e-9;

/** Freezes a record and everything under it (the committed record is read-only). */
function deepFreeze<T>(x: T): T {
  if (typeof x === "object" && x !== null) {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 + 0;

/** The evidence from replayed rows (player_sim distributions), per season ascending. */
export function switchEvidenceOf(rows: readonly StartSitRow[]): ObjectiveSwitchEvidence {
  const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
  const reg = (r: StartSitRow, k: "mean" | "pwin"): number | null => {
    const h = r.realised.hindsight;
    const x = r.realised[k];
    return h === null || x === null ? null : h - x;
  };
  const meanOf = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : r4(xs.reduce((a, b) => a + b, 0) / xs.length);
  const out: ObjectiveSwitchSeason[] = seasons.map((season) => {
    const all = rows.filter(
      (r) => r.season === season && reg(r, "mean") !== null && reg(r, "pwin") !== null,
    );
    const later = all.filter((r) => r.week > SWITCH_RULE.excludeThroughWeek);
    const regs = (xs: readonly StartSitRow[], k: "mean" | "pwin"): number[] =>
      xs.map((r) => reg(r, k) ?? 0);
    return {
      season,
      n: all.length,
      n_differing: all.filter((r) => r.lineup_key.mean !== r.lineup_key.pwin).length,
      regret_mean: meanOf(regs(all, "mean")),
      regret_pwin: meanOf(regs(all, "pwin")),
      n_later: later.length,
      regret_mean_later: meanOf(regs(later, "mean")),
      regret_pwin_later: meanOf(regs(later, "pwin")),
    };
  });
  const shares = rows.map((r) => r.player_sim_share);
  return {
    basis: "player_sim",
    player_sim_share:
      shares.length === 0 ? 0 : r4(shares.reduce((a, b) => a + b, 0) / shares.length),
    seasons: out,
  };
}

/**
 * The switch decision (plan 10 C2): `insufficient` with fewer than SWITCH_RULE.minSeasons seasons or
 * fewer than SWITCH_RULE.minDiffering differing team-weeks; else `switch` iff pwin's mean regret is
 * strictly below mean's in every season, both over every week and after week 3; else `no_switch`.
 * Every failed condition is listed.
 */
export function decideObjectiveSwitch(e: ObjectiveSwitchEvidence): ObjectiveSwitchDecision {
  const reasons: string[] = [];
  const differing = e.seasons.reduce((s, x) => s + x.n_differing, 0);
  const tooFewSeasons = e.seasons.length < SWITCH_RULE.minSeasons;
  const tooFewCalls = differing < SWITCH_RULE.minDiffering;
  if (tooFewSeasons)
    reasons.push(
      `${String(e.seasons.length)} held-out season(s) < ${String(SWITCH_RULE.minSeasons)} required`,
    );
  if (tooFewCalls)
    reasons.push(
      `pwin and mean differ in ${String(differing)} team-week(s) < ${String(SWITCH_RULE.minDiffering)} required`,
    );
  let beats = e.seasons.length > 0;
  for (const s of e.seasons) {
    if (!(s.n > 0 && s.regret_pwin < s.regret_mean - EPS)) {
      beats = false;
      reasons.push(
        `${String(s.season)}: pwin regret ${s.regret_pwin.toFixed(4)} is not below mean's ${s.regret_mean.toFixed(4)}`,
      );
    }
    if (!(s.n_later > 0 && s.regret_pwin_later < s.regret_mean_later - EPS)) {
      beats = false;
      reasons.push(
        `${String(s.season)} after week ${String(SWITCH_RULE.excludeThroughWeek)}: pwin regret ${s.regret_pwin_later.toFixed(4)} is not below mean's ${s.regret_mean_later.toFixed(4)}`,
      );
    }
  }
  const status: ObjectiveSwitchStatus =
    tooFewSeasons || tooFewCalls ? "insufficient" : beats ? "switch" : "no_switch";
  if (status === "switch")
    reasons.push("pwin's regret is below mean's in every held-out season, also after week 3");
  return { status, switch: status === "switch", reasons };
}

/**
 * The committed record: the held-out replay of `league-b`'s 2024 and 2025 seasons on E1's
 * player_sim distributions (docs/evals/phase3-startsit.md). Held equal to a fresh replay by
 * tests/backtest/lineup-history.test.ts; a changed model lands a new record by a reviewed commit.
 */
export const OBJECTIVE_SWITCH_RECORD: ObjectiveSwitchRecord = deepFreeze({
  evidence: {
    basis: "player_sim",
    player_sim_share: 0.5747,
    seasons: [
      {
        season: 2024,
        n: 154,
        n_differing: 4,
        regret_mean: 12.2099,
        regret_pwin: 12.3891,
        n_later: 127,
        regret_mean_later: 12.1701,
        regret_pwin_later: 12.3874,
      },
      {
        season: 2025,
        n: 154,
        n_differing: 5,
        regret_mean: 14.5453,
        regret_pwin: 14.5508,
        n_later: 127,
        regret_mean_later: 14.4334,
        regret_pwin_later: 14.4896,
      },
    ],
  },
  decision: {
    status: "insufficient",
    switch: false,
    reasons: [
      "pwin and mean differ in 9 team-week(s) < 30 required",
      "2024: pwin regret 12.3891 is not below mean's 12.2099",
      "2024 after week 3: pwin regret 12.3874 is not below mean's 12.1701",
      "2025: pwin regret 14.5508 is not below mean's 14.5453",
      "2025 after week 3: pwin regret 14.4896 is not below mean's 14.4334",
    ],
  },
  source: "docs/evals/phase3-startsit.md",
});

/** E2's `auto` objective on a player_sim lineup under reading (a): pwin only when the record switches. */
export function autoObjectiveForPlayerSim(
  record: ObjectiveSwitchRecord = OBJECTIVE_SWITCH_RECORD,
): "pwin" | "mean" {
  return record.decision.switch && record.decision.status === "switch" ? "pwin" : "mean";
}
