// realised.ts — the realised side of a stored v2 tuning trace (plan 10 C9: the retrospective's
// re-fit compares each share's EWM and each shrunk rate with what the final week realised —
// tune.ts fitHalfLife / fitShrinkK). The projection stores its trace with `realised: null`; at
// retrospective time this fills it from the week's realised canonical line and the player's team
// volume (nflverse stats_team_week): target share = targets / team dropbacks, carry share = carries
// / team rushes; catch rate, yards per reception / carry, completion and INT rates, and the
// position's TD rate with their realised opportunities. A stored trace is data read back from disk:
// it is checked structurally and bounded here (a malformed one reads as none — never guessed).
// An inactive week realises nothing (every realised stays null). Pure. New here.
import type { Canonical } from "../scoring/types.js";
import {
  ATTRIBUTION_BOUNDS,
  RATE_NAMES,
  SHARE_NAMES,
  type ProjectionTrace,
  type RateName,
  type RateTrace,
  type ShareName,
  type ShareTrace,
} from "./attribution.js";

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const unit = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** A stored trace read back defensively; null when it is not one. */
export function readTrace(v: unknown): ProjectionTrace | null {
  if (!isObj(v)) return null;
  const { matchup, weather_mult: wm, shares, rates } = v;
  if (!Array.isArray(shares) || !Array.isArray(rates)) return null;
  if (shares.length > ATTRIBUTION_BOUNDS.shares || rates.length > ATTRIBUTION_BOUNDS.rates)
    return null;
  let m: ProjectionTrace["matchup"] = null;
  if (matchup !== null && matchup !== undefined) {
    if (!isObj(matchup) || !fin(matchup.z) || !fin(matchup.beta)) return null;
    m = { z: matchup.z, beta: matchup.beta };
  }
  if (wm !== null && wm !== undefined && !fin(wm)) return null;
  const sh: ShareTrace[] = [];
  for (const s of shares) {
    if (
      !isObj(s) ||
      typeof s.name !== "string" ||
      !(SHARE_NAMES as readonly string[]).includes(s.name)
    )
      return null;
    const h = s.history;
    if (!Array.isArray(h) || h.length > ATTRIBUTION_BOUNDS.shareHistory) return null;
    if (!h.every((x) => fin(x) && x >= 0 && x <= 1)) return null;
    if (!fin(s.half_life)) return null;
    sh.push({
      name: s.name as ShareName,
      history: h as number[],
      half_life: s.half_life,
      realised: null,
    });
  }
  const rt: RateTrace[] = [];
  for (const r of rates) {
    if (
      !isObj(r) ||
      typeof r.name !== "string" ||
      !(RATE_NAMES as readonly string[]).includes(r.name)
    )
      return null;
    if (!fin(r.n_obs) || !fin(r.observed) || !fin(r.prior) || !fin(r.k)) return null;
    rt.push({
      name: r.name as RateName,
      n_obs: r.n_obs,
      observed: r.observed,
      prior: r.prior,
      k: r.k,
      realised: null,
      realised_n: 0,
    });
  }
  return { matchup: m, weather_mult: wm ?? null, shares: sh, rates: rt };
}

/** The team's volume in the realised week (null fields: unknown). */
export interface RealisedTeamVolume {
  readonly dropbacks: number | null;
  readonly rushes: number | null;
}

/** A ratio and its opportunities, or unknown. */
function ratio(num: number | undefined, den: number | undefined): { v: number; n: number } | null {
  if (!fin(num) || !fin(den) || den <= 0) return null;
  return { v: num / den, n: den };
}

/**
 * The trace with its realised side filled (see the header). `position` is the display position (the
 * TD rate's opportunity: QB attempts, RB carries, WR/TE targets).
 */
export function traceWithRealised(
  trace: ProjectionTrace,
  position: string,
  active: boolean,
  realised: Readonly<Record<Canonical, number>>,
  team: RealisedTeamVolume | null,
): ProjectionTrace {
  if (!active) return trace;
  const v = (k: string): number | undefined => realised[k];
  const share = (name: ShareName): number | null => {
    if (team === null) return null;
    const r =
      name === "target_share"
        ? ratio(v("targets"), team.dropbacks ?? undefined)
        : name === "carry_share"
          ? ratio(v("rush_att"), team.rushes ?? undefined)
          : null;
    return r === null ? null : Math.round(unit(r.v) * 1e4) / 1e4;
  };
  const tdOpp = position === "QB" ? "pass_att" : position === "RB" ? "rush_att" : "targets";
  const tdNum = position === "QB" ? "pass_td" : position === "RB" ? "rush_td" : "rec_td";
  const rate = (name: RateName): { v: number; n: number } | null => {
    switch (name) {
      case "catch_rate":
        return ratio(v("rec"), v("targets"));
      case "yards_per_reception":
        return ratio(v("rec_yd"), v("rec"));
      case "yards_per_carry":
        return ratio(v("rush_yd"), v("rush_att"));
      case "completion_rate":
        return ratio(v("pass_cmp"), v("pass_att"));
      case "int_rate":
        return ratio(v("pass_int"), v("pass_att"));
      case "td_rate":
        return ratio(v(tdNum), v(tdOpp));
      default:
        return null; // yards_per_target / yards_per_attempt: v2 traces neither
    }
  };
  return {
    ...trace,
    shares: trace.shares.map((s) => ({ ...s, realised: share(s.name) })),
    rates: trace.rates.map((r) => {
      const x = rate(r.name);
      return x === null ? r : { ...r, realised: x.v, realised_n: x.n };
    }),
  };
}
