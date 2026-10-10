// rates.ts — efficiency with regression to the mean (sibling research 05 §1 step 0 and step 4):
// rate_hat = (n × rate_obs + k × prior) / (n + k), `n` the player's (weighted) opportunities, `prior`
// the positional mean, `k` the per-stat stabilisation constant — yards per carry is effectively pure
// prior, yards per target nearly so, TD rate is never the player's own (step 5) — and the priors
// themselves, pooled from league history (`buildV2Priors`: the caller passes seasons BEFORE the one
// projected, so a backtest never sees its own outcomes). Pure. New here.
import { DEFAULT_V2_PRIORS, V2_POSITIONS } from "./constants.js";
import type {
  V2Game,
  V2Position,
  V2PositionPriors,
  V2Priors,
  V2Shrinkage,
  V2TeamGame,
} from "./types.js";

/**
 * The shrunk rate of `num / den` toward `prior` with strength `k` (opportunity units): (num + k ×
 * prior) / (den + k). A non-finite or negative input is treated as no observation; k ≤ 0 with no
 * observation returns the prior.
 */
export function shrinkRate(
  rate: string,
  num: number,
  den: number,
  k: number,
  prior: number,
): V2Shrinkage {
  const okObs = Number.isFinite(num) && Number.isFinite(den) && den > 0;
  const n = okObs ? den : 0;
  const s = okObs ? num : 0;
  const kk = Number.isFinite(k) && k > 0 ? k : 0;
  const value = n + kk > 0 ? (s + kk * prior) / (n + kk) : prior;
  return {
    rate,
    n: round4(n),
    k: kk,
    observed: okObs ? round4(s / n) : null,
    prior,
    value: Number.isFinite(value) ? value : prior,
  };
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** Pooled counts of one position. */
interface Pool {
  games: number;
  share_tgt: number;
  share_db: number;
  share_car: number;
  share_ru: number;
  share_qdb: number;
  targets: number;
  rec: number;
  rec_yd: number;
  rec_td: number;
  rush_att: number;
  rush_yd: number;
  rush_td: number;
  pass_att: number;
  pass_cmp: number;
  pass_yd: number;
  pass_td: number;
  pass_int: number;
  sacks: number;
  fum_lost: number;
  two_pt: number;
  x_rec_td: number;
  x_rec_den: number;
  x_rush_td: number;
  x_rush_den: number;
  x_pass_td: number;
  x_pass_den: number;
  rz_t: number;
  rz_t_td: number;
  rz_c: number;
  rz_c_td: number;
  gl_c: number;
  gl_c_td: number;
  loc_t: number;
  loc_t_td: number;
  loc_c: number;
  loc_c_td: number;
}

const emptyPool = (): Pool => ({
  games: 0,
  share_tgt: 0,
  share_db: 0,
  share_car: 0,
  share_ru: 0,
  share_qdb: 0,
  targets: 0,
  rec: 0,
  rec_yd: 0,
  rec_td: 0,
  rush_att: 0,
  rush_yd: 0,
  rush_td: 0,
  pass_att: 0,
  pass_cmp: 0,
  pass_yd: 0,
  pass_td: 0,
  pass_int: 0,
  sacks: 0,
  fum_lost: 0,
  two_pt: 0,
  x_rec_td: 0,
  x_rec_den: 0,
  x_rush_td: 0,
  x_rush_den: 0,
  x_pass_td: 0,
  x_pass_den: 0,
  rz_t: 0,
  rz_t_td: 0,
  rz_c: 0,
  rz_c_td: 0,
  gl_c: 0,
  gl_c_td: 0,
  loc_t: 0,
  loc_t_td: 0,
  loc_c: 0,
  loc_c_td: 0,
});

const fin = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x);

/** Opportunities a pooled rate needs before it replaces the default prior. */
const MIN_POOL = Object.freeze({
  team_plays: 3000,
  targets: 300,
  rec: 200,
  rush_att: 300,
  pass_att: 1000,
  pass_cmp: 600,
  touches: 1000,
  rz: 150,
  gl: 60,
  tds: 60,
});

/** The pooled rate, or the default when the pool is thinner than `min`. */
function pooled(num: number, den: number, min: number, fallback: number): number {
  return den >= min && Number.isFinite(num / den) ? round4(num / den) : fallback;
}

/**
 * Positional priors and league team means pooled from history (sib §1 step 4: "prior is the
 * positional mean"). `games` maps a position to its players' games; only the seasons the caller
 * passes are read. A thin pool keeps DEFAULT_V2_PRIORS' value for that rate.
 */
export function buildV2Priors(
  games: ReadonlyMap<V2Position, readonly V2Game[]>,
  teamGames: readonly V2TeamGame[],
  base: V2Priors = DEFAULT_V2_PRIORS,
): V2Priors {
  const positions = {} as Record<V2Position, V2PositionPriors>;
  const teamOf = new Map<string, V2TeamGame>();
  for (const t of teamGames) teamOf.set(`${t.team}|${String(t.season)}|${String(t.week)}`, t);
  for (const pos of V2_POSITIONS) {
    const p = emptyPool();
    for (const g of games.get(pos) ?? []) {
      p.games += 1;
      const t = teamOf.get(`${g.team}|${String(g.season)}|${String(g.week)}`);
      if (t !== undefined && fin(t.dropbacks) && t.dropbacks > 0) {
        p.share_tgt += g.targets;
        p.share_qdb += g.pass_att + g.sacks;
        p.share_db += t.dropbacks;
      }
      if (t !== undefined && fin(t.rushes) && t.rushes > 0) {
        p.share_car += g.rush_att;
        p.share_ru += t.rushes;
      }
      p.targets += g.targets;
      p.rec += g.rec;
      p.rec_yd += g.rec_yd;
      p.rec_td += g.rec_td;
      p.rush_att += g.rush_att;
      p.rush_yd += g.rush_yd;
      p.rush_td += g.rush_td;
      p.pass_att += g.pass_att;
      p.pass_cmp += g.pass_cmp;
      p.pass_yd += g.pass_yd;
      p.pass_td += g.pass_td;
      p.pass_int += g.pass_int;
      p.sacks += g.sacks;
      p.fum_lost += g.sack_fum_lost + g.rush_fum_lost + g.rec_fum_lost;
      p.two_pt += g.two_pt;
      if (fin(g.x_rec_td)) {
        p.x_rec_td += g.x_rec_td;
        p.x_rec_den += g.targets;
      }
      if (fin(g.x_rush_td)) {
        p.x_rush_td += g.x_rush_td;
        p.x_rush_den += g.rush_att;
      }
      if (fin(g.x_pass_td)) {
        p.x_pass_td += g.x_pass_td;
        p.x_pass_den += g.pass_att;
      }
      if (fin(g.rz_targets) && fin(g.rz_rec_td)) {
        p.rz_t += g.rz_targets;
        p.rz_t_td += g.rz_rec_td;
        p.loc_t += g.targets;
        p.loc_t_td += g.rec_td;
      }
      if (fin(g.rz_carries) && fin(g.rz_rush_td) && fin(g.gl_carries) && fin(g.gl_rush_td)) {
        p.rz_c += g.rz_carries;
        p.rz_c_td += g.rz_rush_td;
        p.gl_c += g.gl_carries;
        p.gl_c_td += g.gl_rush_td;
        p.loc_c += g.rush_att;
        p.loc_c_td += g.rush_td;
      }
    }
    const d = base.positions[pos];
    const tds = p.rec_td + p.rush_td + (pos === "QB" ? p.pass_td : 0);
    positions[pos] = Object.freeze({
      target_share: pooled(p.share_tgt, p.share_db, MIN_POOL.team_plays, d.target_share),
      carry_share: pooled(p.share_car, p.share_ru, MIN_POOL.team_plays, d.carry_share),
      dropback_share: pooled(p.share_qdb, p.share_db, MIN_POOL.team_plays, d.dropback_share),
      catch_rate: pooled(p.rec, p.targets, MIN_POOL.targets, d.catch_rate),
      yards_per_rec: pooled(p.rec_yd, p.rec, MIN_POOL.rec, d.yards_per_rec),
      yards_per_carry: pooled(p.rush_yd, p.rush_att, MIN_POOL.rush_att, d.yards_per_carry),
      cmp_rate: pooled(p.pass_cmp, p.pass_att, MIN_POOL.pass_att, d.cmp_rate),
      yards_per_cmp: pooled(p.pass_yd, p.pass_cmp, MIN_POOL.pass_cmp, d.yards_per_cmp),
      int_rate: pooled(p.pass_int, p.pass_att, MIN_POOL.pass_att, d.int_rate),
      sack_rate: pooled(p.sacks, p.pass_att + p.sacks, MIN_POOL.pass_att, d.sack_rate),
      fumble_rate: pooled(
        p.fum_lost,
        p.rec + p.rush_att + p.sacks,
        MIN_POOL.touches,
        d.fumble_rate,
      ),
      xtd_per_target: pooled(p.x_rec_td, p.x_rec_den, MIN_POOL.targets, d.xtd_per_target),
      xtd_per_carry: pooled(p.x_rush_td, p.x_rush_den, MIN_POOL.rush_att, d.xtd_per_carry),
      xtd_per_att: pooled(p.x_pass_td, p.x_pass_den, MIN_POOL.pass_att, d.xtd_per_att),
      td_rz_target: pooled(p.rz_t_td, p.rz_t, MIN_POOL.rz, d.td_rz_target),
      td_other_target: pooled(
        p.loc_t_td - p.rz_t_td,
        p.loc_t - p.rz_t,
        MIN_POOL.targets,
        d.td_other_target,
      ),
      td_gl_carry: pooled(p.gl_c_td, p.gl_c, MIN_POOL.gl, d.td_gl_carry),
      td_rz_carry: pooled(p.rz_c_td - p.gl_c_td, p.rz_c - p.gl_c, MIN_POOL.rz, d.td_rz_carry),
      td_other_carry: pooled(
        p.loc_c_td - p.rz_c_td,
        p.loc_c - p.rz_c,
        MIN_POOL.rush_att,
        d.td_other_carry,
      ),
      two_pt_per_td: pooled(p.two_pt, tds, MIN_POOL.tds, d.two_pt_per_td),
    });
  }
  const db: number[] = [];
  const ru: number[] = [];
  const im: number[] = [];
  for (const t of teamGames) {
    if (fin(t.dropbacks)) db.push(t.dropbacks);
    if (fin(t.rushes)) ru.push(t.rushes);
    if (fin(t.implied)) im.push(t.implied);
  }
  const mean = (xs: number[], min: number, fb: number): number =>
    xs.length >= min ? round4(xs.reduce((s, x) => s + x, 0) / xs.length) : fb;
  return Object.freeze({
    positions: Object.freeze(positions),
    team_dropbacks: mean(db, 32, base.team_dropbacks),
    team_rushes: mean(ru, 32, base.team_rushes),
    team_implied: mean(im, 32, base.team_implied),
  });
}
