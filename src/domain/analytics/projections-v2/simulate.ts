// simulate.ts — the distribution by simulation, never by scaling a mean (sibling research 05 §1 step
// 9; plan 07 E1 `basis: "player_sim"`): per sample a game-script multiplier shared by the team's
// volume (gamma), a pass/rush tilt (gamma each) and the player's role draw (gamma, wider while his
// role is young) scale the expected opportunities; counts are Poisson around them (a gamma–Poisson
// mixture: negative binomial); completions / receptions are binomial on the shrunk rate; yards are a
// gamma sum over the completions, receptions and carries (right-skewed per event); touchdowns are
// Poisson on the location-based rate per drawn opportunity; turnovers are Poisson per attempt and per
// touch (research 05 §3.2 — the QB's left tail); two-point conversions per touchdown. With
// probability 1 − P(active) the line is all zeros (step 8's mixture). Every line is scored by the
// plan 08 engine under the league's S — `scoreSamples` for the Dist, `score` per line where a caller
// needs the points (the backtest's CRPS) — so half-PPR, the 5-pt TD and every bonus are the
// league's own. Pure; draws only from the injected Rng. New here.
import type { Rng } from "../../clock.js";
import { score, scoreSamples } from "../../scoring/engine.js";
import { positionClassOf } from "../../scoring/stat_map.js";
import {
  asPositionId,
  type Canonical,
  type Dist,
  type ScoringSettings,
  type StatLine,
} from "../../scoring/types.js";
import { gammaDraw, gammaMultiplier, poissonDraw } from "../math.js";
import { PROJECTION_SOURCE_V2 } from "./constants.js";
import type { V2Expectation, V2Params, V2PositionDispersion } from "./types.js";

/** The canonical keys every simulated line carries, sorted (one frozen array shared by all lines). */
const LINE_KEYS: readonly Canonical[] = Object.freeze(
  [
    "pass_att",
    "pass_cmp",
    "pass_inc",
    "pass_yd",
    "pass_ypg",
    "pass_td",
    "pass_int",
    "sacked",
    "pass_2pt",
    "rush_att",
    "rush_yd",
    "rush_ypg",
    "rush_td",
    "rush_2pt",
    "rec",
    "rec_stat",
    "targets",
    "rec_yd",
    "rec_ypg",
    "rec_td",
    "rec_2pt",
    "two_pt_total",
    "fum",
    "fum_lost",
    "turnovers",
    "gp",
  ].sort(),
);

/** A frozen canonical line in the translator's shape (the derived keys mirror nflverse.ts). */
export function lineFromCounts(
  c: {
    readonly pass_att: number;
    readonly pass_cmp: number;
    readonly pass_yd: number;
    readonly pass_td: number;
    readonly pass_int: number;
    readonly sacks: number;
    readonly rush_att: number;
    readonly rush_yd: number;
    readonly rush_td: number;
    readonly targets: number;
    readonly rec: number;
    readonly rec_yd: number;
    readonly rec_td: number;
    readonly fum_lost: number;
    readonly pass_2pt: number;
    readonly rush_2pt: number;
    readonly rec_2pt: number;
  },
  positionId: number,
  gp = 1,
): StatLine {
  const values: Record<Canonical, number> = {
    pass_att: c.pass_att,
    pass_cmp: c.pass_cmp,
    pass_inc: Math.max(0, c.pass_att - c.pass_cmp),
    pass_yd: c.pass_yd,
    pass_ypg: c.pass_yd,
    pass_td: c.pass_td,
    pass_int: c.pass_int,
    sacked: c.sacks,
    pass_2pt: c.pass_2pt,
    rush_att: c.rush_att,
    rush_yd: c.rush_yd,
    rush_ypg: c.rush_yd,
    rush_td: c.rush_td,
    rush_2pt: c.rush_2pt,
    rec: c.rec,
    rec_stat: c.rec,
    targets: c.targets,
    rec_yd: c.rec_yd,
    rec_ypg: c.rec_yd,
    rec_td: c.rec_td,
    rec_2pt: c.rec_2pt,
    two_pt_total: c.pass_2pt + c.rush_2pt + c.rec_2pt,
    fum: c.fum_lost,
    fum_lost: c.fum_lost,
    turnovers: c.pass_int + c.fum_lost,
    gp,
  };
  for (const k of LINE_KEYS) if (values[k] === 0) values[k] = 0;
  return Object.freeze({
    values: Object.freeze(values),
    present: LINE_KEYS,
    position: asPositionId(positionId),
    position_class: positionClassOf(positionId),
    provisional: false,
    source: PROJECTION_SOURCE_V2,
  });
}

const ZERO_COUNTS = Object.freeze({
  pass_att: 0,
  pass_cmp: 0,
  pass_yd: 0,
  pass_td: 0,
  pass_int: 0,
  sacks: 0,
  rush_att: 0,
  rush_yd: 0,
  rush_td: 0,
  targets: 0,
  rec: 0,
  rec_yd: 0,
  rec_td: 0,
  fum_lost: 0,
  pass_2pt: 0,
  rush_2pt: 0,
  rec_2pt: 0,
});

/** The line of a player who did not play (every count present and 0). */
export function zeroLine(positionId: number): StatLine {
  return lineFromCounts(ZERO_COUNTS, positionId, 0);
}

/** A binomial draw by Bernoulli trials (n is a game's count — tens at most). */
function binomialDraw(rng: Rng, n: number, p: number): number {
  if (!(p > 0) || n <= 0) return 0;
  if (p >= 1) return n;
  let k = 0;
  for (let i = 0; i < n; i++) if (rng.next() < p) k += 1;
  return k;
}

/** The sum of `count` gamma event sizes with mean `mean` and per-event CV `cv`. */
function gammaSum(rng: Rng, count: number, mean: number, cv: number): number {
  if (count <= 0 || !(mean > 0)) return 0;
  if (!(cv > 0)) return count * mean;
  const shape = count / (cv * cv);
  return mean * cv * cv * gammaDraw(rng, shape);
}

/** Every multiplier 1: the global model (an anchored simulation, or no `sim.position`). */
export const NO_DISPERSION: V2PositionDispersion = Object.freeze({
  role: 1,
  yds_cmp: 1,
  yds_catch: 1,
  yds_carry: 1,
});

/**
 * The per-position dispersion a simulation of `e` applies: `sim.position[e.position]` for the
 * model's own simulation; none for the ensemble's anchored one (its mean is ESPN's — types.ts). A
 * multiplier that is not a finite non-negative number reads as 1.
 */
export function dispersionOf(params: V2Params, e: V2Expectation): V2PositionDispersion {
  const p = e.anchored === true ? undefined : params.sim.position?.[e.position];
  if (p === undefined) return NO_DISPERSION;
  const ok = (x: number): number => (Number.isFinite(x) && x >= 0 ? x : 1);
  // the hot path (once per sample): a valid entry is returned as is, no allocation
  if (
    ok(p.role) === p.role &&
    ok(p.yds_cmp) === p.yds_cmp &&
    ok(p.yds_catch) === p.yds_catch &&
    ok(p.yds_carry) === p.yds_carry
  )
    return p;
  return {
    role: ok(p.role),
    yds_cmp: ok(p.yds_cmp),
    yds_catch: ok(p.yds_catch),
    yds_carry: ok(p.yds_carry),
  };
}

/** The role draw's CV: wider while the role is young (sib §1 Output shape: role confidence). */
export function shareCv(params: V2Params, roleGames: number): number {
  const base = Math.max(0, params.sim.cv_share);
  return base * Math.sqrt(1 + Math.max(0, params.sim.share_role_games) / Math.max(1, roleGames));
}

/**
 * The counts one simulated player-week writes, in this order, into a Float64Array (the samples are
 * kept as numbers, not line objects, until the engine scores them: 4 000 lines × 60 players as
 * objects would hold hundreds of megabytes).
 */
export const COUNT_FIELDS = Object.freeze([
  "pass_att",
  "pass_cmp",
  "pass_yd",
  "pass_td",
  "pass_int",
  "sacks",
  "rush_att",
  "rush_yd",
  "rush_td",
  "targets",
  "rec",
  "rec_yd",
  "rec_td",
  "fum_lost",
  "pass_2pt",
  "rush_2pt",
  "rec_2pt",
  "gp",
] as const);
/** Numbers per simulated sample. */
export const SAMPLE_WIDTH = COUNT_FIELDS.length;

/**
 * Draws one sample of a player-week into `buf` at `offset` (SAMPLE_WIDTH numbers; the order of draws
 * is fixed: active, multipliers, then the passing, rushing and receiving blocks, turnovers,
 * two-point tries).
 */
export function simulateInto(
  e: V2Expectation,
  pActive: number,
  params: V2Params,
  rng: Rng,
  buf: Float64Array,
  offset: number,
): void {
  buf.fill(0, offset, offset + SAMPLE_WIDTH);
  if (rng.next() >= pActive) return;
  const s = params.sim;
  // the own simulation's per-position dispersion (never the anchored one's — types.ts sim.position);
  // every multiplier is 1 when absent, so the draws and their order are the global model's
  const d = dispersionOf(params, e);
  const common = gammaMultiplier(rng, s.cv_common);
  const passM = gammaMultiplier(rng, s.cv_pass);
  const rushM = gammaMultiplier(rng, s.cv_rush);
  const role = gammaMultiplier(
    rng,
    shareCv(params, e.role_games) *
      (e.position === "QB" ? s.qb_role_scale : 1) *
      Math.max(0, e.role_cv_scale ?? 1) *
      d.role,
  );
  // the game's efficiency: a good day lifts yards per event and touchdown rates together and cuts
  // the interception rate — the negative INT–points correlation nflverse shows (QB r −0.06 to −0.18,
  // 2023–2025), which is what makes turnovers widen the left tail (research 05 §3.2)
  const base = gammaMultiplier(rng, e.position === "QB" ? s.cv_eff_qb : s.cv_eff);
  // game script: a pass-heavy game is usually a trailing one, less efficient per attempt (nflverse
  // within-QB corr(attempts, yards per attempt) −0.15 to −0.19, 2023–2025)
  const eff = base * passM ** -s.script_coupling;
  let passAtt = 0;
  let cmp = 0;
  let passYd = 0;
  let passTd = 0;
  let ints = 0;
  let sacks = 0;
  if (e.position === "QB") {
    const per = e.att_per_dropback + e.sack_per_dropback;
    const dropbacks = poissonDraw(rng, e.team_dropbacks * per * common * passM * role);
    sacks = binomialDraw(rng, dropbacks, per > 0 ? e.sack_per_dropback / per : 0);
    passAtt = dropbacks - sacks;
    cmp = binomialDraw(rng, passAtt, e.cmp_rate);
    // an interception is an attempt not completed (drawn from the incompletions), more likely in a
    // bad game, and it ends the drive: the yards and touchdown chance the drive would still have
    // produced are lost — together these give nflverse's negative INT–points correlation. The cost
    // is CENTRED on the game's expected interceptions (Stage C): the shrunk yards-per-completion and
    // TD-per-attempt rates are measured on games that already lost their average INT-ended drives,
    // so only an interception beyond the game's expectation costs a drive (one fewer returns one).
    // Uncentred, every simulated QB-week lost its expected interceptions' drives twice — 1.28 points
    // a game on the 2023 cases (the simulation's mean 14.85 against its own expected line's 16.12 and
    // the actual 16.00), the cause of the narrow-looking QB interval (docs/evals/phase3-projections.md).
    // Centring on the game's own expectation (not the week's) keeps the per-attempt moments: a constant
    // offset in yards would read as yards per attempt falling with attempts
    const inc = passAtt - cmp;
    const pInt = e.cmp_rate < 1 ? e.int_per_att / (1 - e.cmp_rate) : 0;
    const pIntGame = Math.min(1, pInt * eff ** -s.int_eff_power);
    ints = binomialDraw(rng, inc, pIntGame);
    const extraInts = ints - inc * pIntGame;
    passYd = Math.round(
      Math.max(
        0,
        gammaSum(rng, cmp, e.yards_per_cmp * eff, s.cv_yds_cmp * d.yds_cmp) -
          extraInts * s.int_drive_yards,
      ),
    );
    passTd = poissonDraw(
      rng,
      Math.max(0, passAtt * e.td_per_att * eff - extraInts * s.int_drive_td),
    );
  }
  const targets = poissonDraw(rng, e.targets * common * passM * role);
  const rec = binomialDraw(rng, targets, e.catch_rate);
  const recYd = Math.round(gammaSum(rng, rec, e.yards_per_rec * eff, s.cv_yds_catch * d.yds_catch));
  const recTd = poissonDraw(rng, targets * e.td_per_target * eff);
  const carries = poissonDraw(rng, e.carries * common * rushM * role);
  const rushYd = Math.round(
    gammaSum(rng, carries, e.yards_per_carry * base, s.cv_yds_carry * d.yds_carry),
  );
  const rushTd = poissonDraw(rng, carries * e.td_per_carry * base);
  const fumLost = poissonDraw(rng, (rec + carries + sacks) * e.fumble_per_touch);
  const twoPt = poissonDraw(rng, (passTd + rushTd + recTd) * e.two_pt_per_td);
  buf[offset] = passAtt;
  buf[offset + 1] = cmp;
  buf[offset + 2] = passYd;
  buf[offset + 3] = passTd;
  buf[offset + 4] = ints;
  buf[offset + 5] = sacks;
  buf[offset + 6] = carries;
  buf[offset + 7] = rushYd;
  buf[offset + 8] = rushTd;
  buf[offset + 9] = targets;
  buf[offset + 10] = rec;
  buf[offset + 11] = recYd;
  buf[offset + 12] = recTd;
  buf[offset + 13] = fumLost;
  buf[offset + 14] = e.position === "QB" ? twoPt : 0;
  buf[offset + 15] = e.position === "RB" ? twoPt : 0;
  buf[offset + 16] = e.position === "WR" || e.position === "TE" ? twoPt : 0;
  buf[offset + 17] = 1;
}

/** The canonical line of the sample at `offset` (a gp of 0 is a player who did not play). */
export function lineAt(buf: Float64Array, offset: number, positionId: number): StatLine {
  const v = (i: number): number => buf[offset + i] ?? 0;
  return lineFromCounts(
    {
      pass_att: v(0),
      pass_cmp: v(1),
      pass_yd: v(2),
      pass_td: v(3),
      pass_int: v(4),
      sacks: v(5),
      rush_att: v(6),
      rush_yd: v(7),
      rush_td: v(8),
      targets: v(9),
      rec: v(10),
      rec_yd: v(11),
      rec_td: v(12),
      fum_lost: v(13),
      pass_2pt: v(14),
      rush_2pt: v(15),
      rec_2pt: v(16),
    },
    positionId,
    v(17),
  );
}

/** The lines of samples [from, to) of a buffer. */
export function linesOf(
  buf: Float64Array,
  from: number,
  to: number,
  positionId: number,
): StatLine[] {
  const out: StatLine[] = [];
  for (let i = from; i < to; i++) out.push(lineAt(buf, i * SAMPLE_WIDTH, positionId));
  return out;
}

/** One simulated line of a player-week (simulateInto on a scratch buffer). */
export function simulateLine(
  e: V2Expectation,
  pActive: number,
  params: V2Params,
  rng: Rng,
): StatLine {
  const buf = new Float64Array(SAMPLE_WIDTH);
  simulateInto(e, pActive, params, rng, buf, 0);
  return lineAt(buf, 0, e.position_id);
}

/** `n` simulated lines of one player-week from its own stream. */
export function simulateLines(
  e: V2Expectation,
  pActive: number,
  params: V2Params,
  rng: Rng,
  n: number,
): StatLine[] {
  const buf = new Float64Array(Math.max(0, n) * SAMPLE_WIDTH);
  for (let i = 0; i < n; i++) simulateInto(e, pActive, params, rng, buf, i * SAMPLE_WIDTH);
  return linesOf(buf, 0, Math.max(0, n), e.position_id);
}

/** The engine's Dist over simulated lines (`basis: "player_sim"`). */
export function simDist(lines: readonly StatLine[], settings: ScoringSettings): Dist {
  return scoreSamples(lines, settings, "player_sim").dist;
}

/** Each line's points under S (the same engine), for callers that need the samples (CRPS). */
export function simPoints(lines: readonly StatLine[], settings: ScoringSettings): Float64Array {
  const out = new Float64Array(lines.length);
  lines.forEach((l, i) => (out[i] = score(l, settings).points));
  return out;
}

/** The expected counts of a player-week if active, rounded to 3 decimals (one struct, two views). */
function expectedStruct(e: V2Expectation) {
  const qb = e.position === "QB";
  const att = qb ? e.pass_att : 0;
  const sacks = qb ? e.team_dropbacks * e.sack_per_dropback : 0;
  const cmp = att * e.cmp_rate;
  const rec = e.targets * e.catch_rate;
  const passTd = att * e.td_per_att;
  const recTd = e.targets * e.td_per_target;
  const rushTd = e.carries * e.td_per_carry;
  const r = (x: number): number => Math.round(x * 1000) / 1000;
  return {
    pass_att: r(att),
    pass_cmp: r(cmp),
    pass_yd: r(cmp * e.yards_per_cmp),
    pass_td: r(passTd),
    pass_int: r(att * e.int_per_att),
    sacked: r(sacks),
    rush_att: r(e.carries),
    rush_yd: r(e.carries * e.yards_per_carry),
    rush_td: r(rushTd),
    targets: r(e.targets),
    rec: r(rec),
    rec_yd: r(rec * e.yards_per_rec),
    rec_td: r(recTd),
    fum_lost: r((rec + e.carries + sacks) * e.fumble_per_touch),
    two_pt_total: r((passTd + recTd + rushTd) * e.two_pt_per_td),
  };
}

/**
 * The expected line (fractional counts) of a player-week if active — the stat_line_expectation of
 * plan 07 E1 and the drivers' basis (linear in the stats; bonuses need the simulation).
 */
export function expectedCounts(e: V2Expectation): Readonly<Record<Canonical, number>> {
  return Object.freeze(expectedStruct(e));
}

/** The expected counts as a canonical line the engine can score (2-pt tries by position). */
export function expectedLine(e: V2Expectation): StatLine {
  const c = expectedStruct(e);
  const two = c.two_pt_total;
  return lineFromCounts(
    {
      pass_att: c.pass_att,
      pass_cmp: c.pass_cmp,
      pass_yd: c.pass_yd,
      pass_td: c.pass_td,
      pass_int: c.pass_int,
      sacks: c.sacked,
      rush_att: c.rush_att,
      rush_yd: c.rush_yd,
      rush_td: c.rush_td,
      targets: c.targets,
      rec: c.rec,
      rec_yd: c.rec_yd,
      rec_td: c.rec_td,
      fum_lost: c.fum_lost,
      pass_2pt: e.position === "QB" ? two : 0,
      rush_2pt: e.position === "RB" ? two : 0,
      rec_2pt: e.position === "WR" || e.position === "TE" ? two : 0,
    },
    e.position_id,
  );
}
