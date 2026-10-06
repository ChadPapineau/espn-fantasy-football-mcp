// playerSim.ts — E1's `player_sim` hook (plan 07 E1: v1 → `basis: "player_sim"` where the
// opportunity inputs exist; plan 10 §3.2 "E1's player_sim basis where the opportunity inputs
// exist"; sib research 05 §1 step 9: a distribution simulated from volume × efficiency, never a
// positional CV): per sample, a game-script volume multiplier (gamma) scales the player's trailing
// targets and carries (Poisson), receptions are binomial on the catch rate, yards gamma per event
// batch, touchdowns Poisson on the per-opportunity rates, fumbles per touch; every line is scored
// through the plan 08 engine under the league's S (format-aware: half-PPR, per-N, bonuses), and the
// samples are rescaled so the mean is ESPN's (weight_espn = 1.0 in v1 — ADV OBJ-02; the simulation
// shapes the distribution, it never moves the point estimate). The zero mass follows P(active)
// with E1's shape floor. Receivers and rushers only (RB/WR/TE): a QB's passing volume is not an
// opportunity input yet → no player_sim (the caller keeps position_cv). Pure. New here.
import type { Rng } from "../clock.js";
import { scoreSamples } from "../scoring/engine.js";
import { positionClassOf } from "../scoring/stat_map.js";
import {
  asPositionId,
  type Canonical,
  type Dist,
  type ScoringSettings,
  type StatLine,
} from "../scoring/types.js";
import { P_ACTIVE_SHAPE_FLOOR, PROJECTION_SOURCE } from "./constants.js";
import { CASCADE, PLAYER_SIM } from "./marketConstants.js";
import { clamp, gammaMultiplier, poissonDraw, round } from "./math.js";

/** A player's trailing opportunity and efficiency (D1; per game). */
export interface OpportunityInputs {
  /** ESPN display position (RB, WR, TE). */
  readonly position: string;
  /** ESPN position id (2 RB, 3 WR, 4 TE). */
  readonly position_id: number;
  /** Games behind the rates. */
  readonly games: number;
  readonly targets_pg: number;
  readonly carries_pg: number;
  readonly catch_rate: number | null;
  readonly yards_per_reception: number | null;
  readonly yards_per_carry: number | null;
  readonly td_per_target: number | null;
  readonly td_per_carry: number | null;
}

const SIM_POSITIONS: ReadonlySet<string> = new Set(["RB", "WR", "TE"]);
const TD_PER_TARGET_PRIOR: Readonly<Record<string, number>> = Object.freeze({
  RB: 0.03,
  WR: 0.045,
  TE: 0.05,
});
const TD_PER_CARRY_PRIOR: Readonly<Record<string, number>> = Object.freeze({
  RB: 0.03,
  WR: 0.04,
  TE: 0.03,
});

const finite = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x);

/** Whether the opportunity inputs exist for a player (plan 07 E1's condition for `player_sim`). */
export function hasOpportunityInputs(
  x: OpportunityInputs | null | undefined,
): x is OpportunityInputs {
  return (
    x !== null &&
    x !== undefined &&
    SIM_POSITIONS.has(x.position) &&
    finite(x.games) &&
    x.games >= PLAYER_SIM.minGames &&
    finite(x.targets_pg) &&
    finite(x.carries_pg) &&
    x.targets_pg >= 0 &&
    x.carries_pg >= 0 &&
    x.targets_pg + x.carries_pg > 0
  );
}

/** The simulation's result: the Dist (`basis: "player_sim"`), the raw simulated mean and the rescale. */
export interface PlayerSimResult {
  readonly dist: Dist;
  readonly sim_mean: number;
  /** ESPN's mean / the simulated mean (clamped); 1 when ESPN's mean is unknown. */
  readonly factor: number;
}

function lineOf(values: Readonly<Record<Canonical, number>>, positionId: number): StatLine {
  return {
    values,
    present: Object.keys(values).sort(),
    position: asPositionId(positionId),
    position_class: positionClassOf(positionId),
    provisional: false,
    source: PROJECTION_SOURCE,
  };
}

/**
 * The `player_sim` distribution of one player-week, or null when the opportunity inputs do not
 * exist. `espn_mean` anchors the mean (v1); `p_active` sets the zero mass (floored as in E1).
 */
export function playerSimDist(input: {
  readonly opportunity: OpportunityInputs | null | undefined;
  readonly settings: ScoringSettings;
  readonly espn_mean: number | null;
  readonly p_active: number;
  readonly n_sims?: number;
  readonly rng: Rng;
}): PlayerSimResult | null {
  const o = input.opportunity;
  if (!hasOpportunityInputs(o)) return null;
  const n = clamp(
    Math.round(input.n_sims ?? PLAYER_SIM.defaultSamples),
    100,
    PLAYER_SIM.maxSamples,
  );
  const e = CASCADE.efficiency;
  const catchRate = clamp(o.catch_rate ?? e.catchRate[o.position] ?? 0.65, 0, 1);
  const ypr = Math.max(0, o.yards_per_reception ?? e.yardsPerReception[o.position] ?? 10);
  const ypc = Math.max(0, o.yards_per_carry ?? e.yardsPerCarry[o.position] ?? 4);
  const tdT = Math.max(0, o.td_per_target ?? TD_PER_TARGET_PRIOR[o.position] ?? 0.04);
  const tdC = Math.max(0, o.td_per_carry ?? TD_PER_CARRY_PRIOR[o.position] ?? 0.03);
  const pPlay = clamp(Math.max(input.p_active, P_ACTIVE_SHAPE_FLOOR), 0, 1);
  const rng = input.rng.fork(`player_sim:${o.position}`);
  const lines: StatLine[] = [];
  for (let i = 0; i < n; i++) {
    if (rng.next() >= pPlay) {
      lines.push(lineOf({ targets: 0, rec: 0, rush_att: 0 }, o.position_id));
      continue;
    }
    const m = gammaMultiplier(rng, PLAYER_SIM.volumeCv);
    const targets = poissonDraw(rng, o.targets_pg * m);
    let rec = 0;
    for (let t = 0; t < targets; t++) if (rng.next() < catchRate) rec += 1;
    const recYd =
      rec > 0 ? rec * ypr * gammaMultiplier(rng, PLAYER_SIM.yardsCv / Math.sqrt(rec)) : 0;
    const carries = poissonDraw(rng, o.carries_pg * m);
    const rushYd =
      carries > 0
        ? carries * ypc * gammaMultiplier(rng, PLAYER_SIM.yardsCv / Math.sqrt(carries))
        : 0;
    const recTd = poissonDraw(rng, targets * tdT);
    const rushTd = poissonDraw(rng, carries * tdC);
    const fumLost = poissonDraw(rng, (rec + carries) * PLAYER_SIM.fumblePerTouch);
    lines.push(
      lineOf(
        {
          targets,
          rec,
          rec_yd: Math.round(recYd),
          rec_td: recTd,
          rush_att: carries,
          rush_yd: Math.round(rushYd),
          rush_td: rushTd,
          fum: fumLost,
          fum_lost: fumLost,
        },
        o.position_id,
      ),
    );
  }
  const sim = scoreSamples(lines, input.settings, "player_sim").dist;
  const simMean = sim.mean;
  const espn = input.espn_mean;
  let factor = 1;
  if (finite(espn) && espn >= 0 && simMean > 0)
    factor = clamp(espn / simMean, 1 / PLAYER_SIM.maxRescale, PLAYER_SIM.maxRescale);
  const exact = finite(espn) && espn >= 0 && simMean > 0 && factor === espn / simMean;
  const s = (x: number): number => round(x * factor);
  return {
    dist: {
      mean: exact ? round(espn) : s(sim.mean),
      p10: s(sim.p10),
      p25: s(sim.p25),
      p50: s(sim.p50),
      p75: s(sim.p75),
      p90: s(sim.p90),
      p_zero: sim.p_zero,
      basis: "player_sim",
    },
    sim_mean: round(simMean),
    factor: round(factor, 6),
  };
}
