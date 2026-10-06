// waiversP1.ts — E5 at P1 (plan 07 E5 "P1 (usage-first detection, all positions; `mode: faab`)";
// plan 10 §3.2 "E5's usage signals and `faab` mode", B3–B4 hard parts): the P0 priority engine
// (waivers.ts) values every candidate — weeks-of-usable-value on MY roster, s over the best drop,
// Π(k, W) with its band — and this layer adds, without touching that rule:
//   * `signals[]` from usage (usageSignals.ts) — each citing a numeric `evidence`; `percent_change`
//     stays a competition field and never becomes a signal (research 05 §1.3, sib §4.1);
//   * `value_basis: "ensemble"` when the weekly values are E1's (P1 "replaces proj_espn with E1");
//   * the demand model per rival (research 05 §1.3): the cold-start curve read at each rival's OWN
//     lineup gain (the assignment on his roster), or the league-fitted logistic (demand.ts) — then
//     `q_i`, `rivals_upgraded`, `p_k_win`, `p_clears_to_fa` (league_fitted basis when fitted) and the
//     two verdicts that hang on P(clears) (`pass` ↔ `fa_add_after_run`) and the scramble list;
//   * `learned.*` from the league's own feed (null until it shows the case — plan 07 §6);
//   * `mode: faab` (faab.ts): no premium (research 05 §1.4 — "no λ in a priority league", and no
//     premium in a FAAB one), a shaded first-price bid per candidate, `claim` iff the best bid has a
//     positive expected net, the claim list ranked by it, the top claim's bid as `data.faab`.
// claim ⇔ s ≥ Π outside the band, and `marginal` inside it, hold exactly as P0 computed them (plan 10
// B3: "the Π rule still holds for every candidate"). Pure. New here.
import { isKdst } from "./kdst.js";
import { fastLineupValue, seatPlan, type FastPlayer } from "./lineup.js";
import { loopPacer, runCooperative } from "./cooperative.js";
import { CLEARS_TO_FA_MIN_COLD_WIDTH, type Assumption, type ClearsToFa } from "./types.js";
import { WAIVERS, Z90 } from "./constants.js";
import { fittedQ, type DemandFit, type LearnedMechanics } from "./demand.js";
import {
  faabBid,
  lambdaOf,
  pricePerPoint,
  type FaabBid,
  type FaabRival,
  type WinningBid,
} from "./faab.js";
import { DEMAND_FIT } from "./marketConstants.js";
import { clamp, round, zeroDist } from "./math.js";
import { newestAsOf } from "./inputs.js";
import { detectSignals, type SignalInput } from "./usageSignals.js";
import { demandOf } from "./waiverDp.js";
import {
  analyzeWaivers,
  type WaiverOutcome,
  type WaiverPlayer,
  type WaiverRequest,
} from "./waivers.js";
import type {
  Rec,
  RecSubject,
  ValueBasis,
  WaiverCandidate,
  WaiverSignal,
  WaiversData,
  WaiverVerdict,
} from "./types.js";

/** A rival's active players with weekly values aligned to the request's value weeks. */
export interface RivalRoster {
  readonly team_id: number;
  readonly players: readonly WaiverPlayer[];
}

/** FAAB context (P1 `mode: faab`). */
export interface FaabContextInput {
  /** My remaining budget; null → the league budget less nothing (assumed unspent, said so). */
  readonly my_budget: number | null;
  /** Each rival's remaining budget (team → dollars; null = unknown, no cap). */
  readonly rival_budgets: ReadonlyMap<number, number | null>;
  /** The league's winning bids with the acquired player's value then (A6 history). */
  readonly history: readonly WinningBid[];
  readonly reserve?: "none" | "playoff_reserve";
}

/** An E5 request at P1: the P0 request plus the usage, demand and FAAB inputs. */
export interface WaiverP1Request extends WaiverRequest {
  /** Where the weekly values came from: E1's ensemble (P1) or ESPN's rest-of-season (P0 basis). */
  readonly value_basis: ValueBasis;
  /** Usage by candidate player id (D1 + D4 + D3 + E7). */
  readonly usage?: ReadonlyMap<number, SignalInput>;
  /** Rivals' rosters, for each rival's own lineup gain (research 05 §1.3 input 1). */
  readonly rival_rosters?: readonly RivalRoster[];
  /** Sleeper trending adds by candidate player id (secondary). */
  readonly sleeper_trend?: ReadonlyMap<number, number>;
  /** The league-fitted demand model (demand.ts `fitDemand`); null/absent → the cold-start curve. */
  readonly demand_fit?: DemandFit | null;
  /** Each team's processed claims so far (A6 history; the fit's `activity_i`). */
  readonly activity?: ReadonlyMap<number, number>;
  /** What the league's feed has shown about the mechanics (demand.ts `learnWaiverMechanics`). */
  readonly mechanics?: LearnedMechanics | null;
  /** `learnKickoffWaivers` over the pool snapshots; null/absent = not shown yet. */
  readonly kickoff_waivers?: boolean | null;
  readonly faab?: FaabContextInput | null;
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });
/** The P0 engine's "last in the order" assumption — dropped when k = N was only FAAB's device. */
const AT_LAST_TRIGGER = "my position improves";

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The P0 engine's action text from the verdict counts (kept identical so a P1 call with nothing new
 * reads exactly as P0 — waiversP1.test.ts pins the equality).
 */
export function waiverActionText(
  claims: number,
  adds: number,
  marginal: number,
  scramble: number,
  phase: WaiversData["phase"],
): string {
  const parts: string[] = [];
  if (claims > 0) parts.push(`submit ${String(claims)} ordered claim${plural(claims, "", "s")}`);
  if (adds > 0) parts.push(`add ${String(adds)} free agent${plural(adds, "", "s")} now`);
  if (marginal > 0) parts.push(`${String(marginal)} marginal (your call)`);
  if (scramble > 0 && phase === "pre_run")
    parts.push(`${String(scramble)} on the scramble list after the run`);
  const noMove = claims === 0 && adds === 0;
  if (!noMove) return parts.join("; ");
  return parts.length > 0 ? `no clear move: ${parts.join("; ")}` : "no claim clears the premium";
}

/** The P0 engine's interval widening, so a cold-start P(clears) never reads as certain. */
function coldInterval(p: number, lo0: number, hi0: number): readonly [number, number] {
  let lo = lo0;
  let hi = hi0;
  if (hi - lo < CLEARS_TO_FA_MIN_COLD_WIDTH) {
    const half = CLEARS_TO_FA_MIN_COLD_WIDTH / 2;
    lo = Math.max(0, Math.min(lo, p - half));
    hi = Math.min(1, Math.max(hi, p + half));
    if (hi - lo < CLEARS_TO_FA_MIN_COLD_WIDTH) {
      if (lo === 0) hi = CLEARS_TO_FA_MIN_COLD_WIDTH;
      else lo = 1 - CLEARS_TO_FA_MIN_COLD_WIDTH;
    }
  }
  return [round(Math.min(lo, p), 4), round(Math.max(hi, p), 4)];
}

interface RivalQ {
  readonly team_id: number;
  readonly p: number;
  readonly lo: number;
  readonly hi: number;
}

/**
 * E5 at P1. Same refusals as `analyzeWaivers` (it runs first); FAAB bidding works for every
 * position here.
 */
export async function analyzeWaiversP1(req: WaiverP1Request): Promise<WaiverOutcome> {
  const N = req.league_size;
  const usesBudget = req.rules.waiver.uses_budget === true;
  const modeArg = req.mode ?? "auto";
  const modeUsed = modeArg === "auto" ? (usesBudget ? "faab" : "priority") : modeArg;
  const faabMode = modeUsed === "faab";
  // FAAB: value candidates with no priority premium (k = N reads "claim anything positive") and with
  // the move-to-last order so W counts the weeks ahead (λ needs them); the device's assumption goes
  const base = await analyzeWaivers(
    faabMode
      ? {
          ...req,
          mode: "priority",
          k: N,
          rules: { ...req.rules, waiver: { ...req.rules.waiver, order_reset: false } },
        }
      : { ...req, mode: "priority" },
  );
  const d = base.data;
  const assumptions: Assumption[] = d.rec.assumptions.filter(
    (a) => !(faabMode && a.revisit_trigger === AT_LAST_TRIGGER),
  );
  const pacer = req.pacer ?? loopPacer(req.clock);

  // each rival's own lineup gain per week from each candidate (research 05 §1.3 input 1)
  const inputOf = new Map(req.candidates.map((c) => [c.player_id, c]));
  const rosters = req.rival_rosters ?? null;
  const upgrades = new Map<string, number>();
  if (rosters !== null && rosters.length > 0) {
    const seats = seatPlan(req.roster);
    const H = Math.max(1, Math.min(DEMAND_FIT.upgradeWeeks, req.weeks.length));
    const fp = (p: WaiverPlayer, w: number): FastPlayer => ({
      eligible: new Set(p.eligible_slot_ids),
      value: Math.max(0, p.weekly[w] ?? 0),
    });
    const baseOf = new Map<number, number[]>();
    for (const r of rosters)
      baseOf.set(
        r.team_id,
        Array.from({ length: H }, (_, w) =>
          fastLineupValue(
            seats,
            r.players.map((p) => fp(p, w)),
          ),
        ),
      );
    const work = d.candidates.flatMap((c) => rosters.map((r) => ({ c, r })));
    await runCooperative(
      work.length,
      (i) => {
        const unit = work[i];
        if (unit === undefined) return;
        const cand = inputOf.get(unit.c.player_id);
        if (cand === undefined) return;
        let gain = 0;
        for (let w = 0; w < H; w++) {
          const withP = fastLineupValue(seats, [
            ...unit.r.players.map((p) => fp(p, w)),
            fp(cand, w),
          ]);
          gain += withP - (baseOf.get(unit.r.team_id)?.[w] ?? 0);
        }
        upgrades.set(`${String(unit.r.team_id)}:${String(unit.c.player_id)}`, gain / H);
      },
      { pacer, deadlineMs: null },
    );
  }

  const fit = req.demand_fit ?? null;
  const usage = req.usage ?? null;
  const trendOf = req.sleeper_trend ?? null;
  const kMine =
    req.k !== null && Number.isInteger(req.k) && req.k >= 1 && req.k <= N ? req.k : null;
  const ahead = new Set(
    req.rivals
      .filter((r) => r.waiver_rank !== null && kMine !== null && r.waiver_rank < kMine)
      .map((r) => r.team_id),
  );
  const demandNew = fit !== null || upgrades.size > 0;
  const look = req.look_ahead ?? 2;
  const horizonOf = (c: WaiverCandidate): number =>
    isKdst(c.position)
      ? Math.min(req.weeks.length, look + 1)
      : Math.min(req.weeks.length, req.horizon_weeks ?? req.weeks.length);

  // FAAB context
  const faab = req.faab ?? null;
  const budgetTotal = req.rules.waiver.budget ?? 0;
  const myBudget = faab?.my_budget ?? budgetTotal;
  const price = pricePerPoint(faab?.history ?? [], budgetTotal > 0 ? budgetTotal : myBudget);
  const seasonWeeks = Math.max(
    1,
    Object.values(req.rules.playoffs.matchup_periods).reduce((s, ws) => s + ws.length, 0),
  );
  const lambda = faabMode
    ? lambdaOf({
        price,
        weeks_remaining: d.W,
        weeks_season: seasonWeeks,
        my_budget: myBudget,
        rival_budgets: req.rivals.map((r) => faab?.rival_budgets.get(r.team_id) ?? null),
        reserve: faab?.reserve ?? "none",
      })
    : 0;
  const minBid = req.rules.waiver.min_bid ?? 0;
  const bids = new Map<number, FaabBid>();

  const candidates: WaiverCandidate[] = d.candidates.map((c) => {
    // signals: the P0 stream signal gains its numeric evidence; the usage signals follow
    const signals: WaiverSignal[] = c.signals.map((s) =>
      s.kind === "stream" && typeof s.evidence !== "number"
        ? { ...s, evidence: round(c.kdst?.implied_total ?? s.value, 3) }
        : s,
    );
    const u = usage?.get(c.player_id);
    if (u !== undefined) signals.push(...detectSignals(u));
    const trend = trendOf?.get(c.player_id) ?? null;
    const H = Math.max(1, horizonOf(c));
    const rate = Math.max(0, c.s) / H;

    let qs: RivalQ[];
    if (demandNew) {
      qs = req.rivals.map((rv) => {
        if (rv.ir_blocked) return { team_id: rv.team_id, p: 0, lo: 0, hi: 0 };
        const up = upgrades.get(`${String(rv.team_id)}:${String(c.player_id)}`);
        if (fit !== null) {
          const q = fittedQ(fit, {
            r: rate,
            upgrade: up ?? null,
            trend,
            activity: req.activity?.get(rv.team_id) ?? 0,
          });
          return { team_id: rv.team_id, p: q.p, lo: q.lo, hi: q.hi };
        }
        const x = up ?? rate;
        return {
          team_id: rv.team_id,
          p: round(demandOf(x), 4),
          lo: round(Math.min(1, demandOf(x, WAIVERS.demandBand.low)), 4),
          hi: round(Math.min(1, demandOf(x, WAIVERS.demandBand.high)), 4),
        };
      });
    } else {
      qs = c.demand.q_i.map((q) => ({ team_id: q.team_id, p: q.p, lo: q.p, hi: q.p }));
    }
    qs.sort((a, b) => a.team_id - b.team_id);
    const rivalsUpgraded = req.rivals
      .filter(
        (rv) =>
          (upgrades.get(`${String(rv.team_id)}:${String(c.player_id)}`) ?? 0) >=
          DEMAND_FIT.upgradedMinPerWeek,
      )
      .map((rv) => rv.team_id)
      .sort((a, b) => a - b);

    let clears = c.p_clears_to_fa;
    let pk = c.p_k_win;
    if (demandNew && c.status === "WAIVERS") {
      const able = qs.filter((q) => !req.rivals.find((r) => r.team_id === q.team_id)?.ir_blocked);
      const prod = (f: (q: RivalQ) => number): number =>
        able.reduce((s, q) => s * (1 - clamp(f(q), 0, 1)), 1);
      const p = prod((q) => q.p);
      const interval: readonly [number, number] =
        fit !== null
          ? [
              round(
                Math.min(
                  p,
                  prod((q) => q.hi),
                ),
                4,
              ),
              round(
                Math.max(
                  p,
                  prod((q) => q.lo),
                ),
                4,
              ),
            ]
          : coldInterval(
              p,
              prod((q) => q.hi),
              prod((q) => q.lo),
            );
      clears = {
        p: round(p, 4),
        interval,
        basis: fit !== null ? "league_fitted" : "cold_start",
      } satisfies ClearsToFa;
      pk = round(
        able.filter((q) => ahead.has(q.team_id)).reduce((s, q) => s * (1 - q.p), 1),
        4,
      );
    }

    // the verdicts that hang on P(clears) — s, Π and the band are P0's, untouched
    let verdict: WaiverVerdict = c.verdict;
    let bid: NonNullable<WaiverCandidate["bid"]> | null = null;
    const stillOpen = c.status === "WAIVERS" && c.s > 0;
    if (faabMode) {
      if (stillOpen) {
        const rivals: FaabRival[] = req.rivals
          .filter((rv) => !rv.ir_blocked)
          .map((rv) => {
            const up = upgrades.get(`${String(rv.team_id)}:${String(c.player_id)}`);
            return {
              team_id: rv.team_id,
              q: qs.find((q) => q.team_id === rv.team_id)?.p ?? 0,
              value: up === undefined ? c.s : up * H,
              budget_remaining: faab?.rival_budgets.get(rv.team_id) ?? null,
            };
          });
        const b = faabBid({
          value: c.s,
          my_budget: myBudget,
          min_bid: minBid,
          price,
          rivals,
          lambda,
        });
        bids.set(c.player_id, b);
        bid = { b_star: b.b_star, p_win: b.p_win, expected_net: b.expected_net };
        pk = b.p_win;
        verdict =
          b.expected_net > 0 && b.b_star >= minBid
            ? "claim"
            : (clears?.p ?? 0) >= WAIVERS.faAfterRunMinClear
              ? "fa_add_after_run"
              : "pass";
      }
    } else if (stillOpen && (c.verdict === "pass" || c.verdict === "fa_add_after_run")) {
      verdict = (clears?.p ?? 0) >= WAIVERS.faAfterRunMinClear ? "fa_add_after_run" : "pass";
    }

    const out: WaiverCandidate = {
      ...c,
      signals,
      p_k_win: c.status === "WAIVERS" ? pk : null,
      p_clears_to_fa: clears,
      demand: {
        ...c.demand,
        rivals_upgraded: rivalsUpgraded,
        q_i: qs.map((q) => ({ team_id: q.team_id, p: q.p })),
        sleeper_trend: trend,
      },
      verdict,
      claim_rank: null,
    };
    return faabMode ? { ...out, bid } : out;
  });

  // ranks and lists (P0's order: by s; FAAB claims by expected net)
  const claimOrder = candidates
    .filter((c) => c.verdict === "claim")
    .sort((a, b) =>
      faabMode
        ? (b.bid?.expected_net ?? 0) - (a.bid?.expected_net ?? 0) || a.player_id - b.player_id
        : b.s - a.s || a.player_id - b.player_id,
    );
  const rankOf = new Map(claimOrder.map((c, i) => [c.player_id, i + 1]));
  const ranked = candidates.map((c) =>
    c.verdict === "claim" ? { ...c, claim_rank: rankOf.get(c.player_id) ?? null } : c,
  );
  const marginal = ranked.filter((c) => c.verdict === "marginal").map((c) => c.player_id);
  const scramble = ranked
    .filter(
      (c) =>
        (c.status === "WAIVERS" &&
          c.verdict !== "pass" &&
          (c.p_clears_to_fa?.p ?? 0) >= WAIVERS.scrambleMinClear) ||
        (d.phase === "post_run" && c.verdict === "fa_add_now"),
    )
    .map((c) => c.player_id);
  const adds = ranked.filter((c) => c.verdict === "fa_add_now");

  // assumptions the P1 layer adds
  assumptions.push(
    req.value_basis === "ensemble"
      ? A(
          "values are E1's ensemble projections (ESPN's mean is the point estimate, weight_espn = 1.0)",
          "the backtest moves weight_espn below 1",
        )
      : A("values are ESPN's rest-of-season projections", "E1's ensemble values are passed"),
  );
  if (usage !== null)
    assumptions.push(
      A(
        "usage signals detect and explain; P(role holds) stays the cold-start prior and the surplus rule decides",
        "usage-based P(role holds) ships",
      ),
    );
  if (fit !== null)
    assumptions.push(
      A(
        `q_i is fitted on ${String(fit.n)} of the league's own claim rows (Brier ${String(fit.brier_fitted)} vs ${String(fit.brier_cold)} for the cold-start curve)`,
        "the fit's out-of-run Brier stops beating the cold-start curve",
      ),
    );
  else if (upgrades.size > 0)
    assumptions.push(
      A(
        "q_i is the cold-start curve read at each rival's own lineup gain (no fitted demand model)",
        "the league's claim history supports a fit",
      ),
    );
  if (faabMode) {
    assumptions.push(
      A(
        `FAAB: first-price bids against shaded rival bids around the league's price of a point ($${String(price.value)}/pt from ${String(price.n)} winning bids, shrunk to the cold start)`,
        "more winning bids are recorded",
      ),
      A(
        `λ = ${String(lambda)} points per dollar; it falls to 0 after the last run before the playoffs`,
        "the budget or the weeks remaining change",
      ),
    );
    if (faab?.my_budget === null || faab === null)
      assumptions.push(
        A("my remaining budget is unknown: read as the league budget", "budget_spent is known"),
      );
  }

  const claims = ranked
    .filter((c) => c.verdict === "claim")
    .sort((a, b) => (a.claim_rank ?? 0) - (b.claim_rank ?? 0));
  const top = claims[0] ?? adds[0] ?? null;
  const subjects: RecSubject[] = [];
  for (const c of [...claims, ...adds]) {
    subjects.push({
      player_id: c.player_id,
      gsis_id: null,
      role: c.verdict === "claim" ? "claim" : "add",
      slot: null,
    });
    if (c.conditional_drop !== null)
      subjects.push({
        player_id: c.conditional_drop.player_id,
        gsis_id: null,
        role: "drop",
        slot: null,
      });
  }
  const noMove = claims.length === 0 && adds.length === 0;
  const premium = faabMode ? 0 : d.premium;
  const sd = top === null ? 0 : (top.value.p90 - top.value.p10) / (2 * Z90);
  const action = faabMode
    ? faabActionText(claims, adds.length, scramble.length, d.phase)
    : waiverActionText(claims.length, adds.length, marginal.length, scramble.length, d.phase);
  const rec: Rec = {
    ...d.rec,
    action,
    subjects,
    point_estimate: top === null ? 0 : top.s,
    distribution: top === null ? zeroDist("position_cv") : top.value,
    delta_vs_next: {
      value: top === null ? 0 : round(top.s - premium, 3),
      p10: top === null ? 0 : round(top.s - premium - Z90 * sd, 3),
      p90: top === null ? 0 : round(top.s - premium + Z90 * sd, 3),
    },
    decision_metric: faabMode ? "marginal_value" : d.rec.decision_metric,
    drivers: faabMode
      ? [
          { name: "lambda", contribution: -round(lambda * (claims[0]?.bid?.b_star ?? 0), 3) },
          ...ranked
            .slice(0, 3)
            .map((c) => ({ name: `surplus:${String(c.player_id)}`, contribution: c.s })),
        ]
      : d.rec.drivers,
    assumptions,
    as_of: newestAsOf(d.inputs, req.clock.nowIso()),
    latest_execution_time: noMove ? null : claims.length > 0 ? d.next_run_at : null,
    no_move: noMove,
  };

  const mech = req.mechanics ?? null;
  const topClaim = claims[0];
  const topBid = faabMode && topClaim !== undefined ? (bids.get(topClaim.player_id) ?? null) : null;
  const data: WaiversData = {
    ...d,
    mode_used: faabMode ? "faab" : d.mode_used,
    k: req.k,
    premium,
    premium_band: faabMode ? { low: 0, high: 0 } : d.premium_band,
    per_week_threshold: faabMode ? 0 : d.per_week_threshold,
    value_basis: req.value_basis,
    candidates: ranked,
    claim_list: claims.map((c) => c.player_id),
    marginal,
    scramble_list: scramble,
    faab:
      topBid === null
        ? null
        : {
            b_star: topBid.b_star,
            p_win_curve: topBid.curve,
            lambda,
            dollars_per_point: price,
          },
    learned: {
      second_claim_at_new_position:
        mech?.second_claim_at_new_position ?? d.learned.second_claim_at_new_position,
      unowned_to_waivers_at_kickoff: req.kickoff_waivers ?? d.learned.unowned_to_waivers_at_kickoff,
      order_reset_rule:
        mech?.waiver_rank_moves_on_success === true ? "move_to_last" : d.learned.order_reset_rule,
    },
    rec,
  };
  return { data, warnings: base.warnings };
}

function faabActionText(
  claims: readonly WaiverCandidate[],
  adds: number,
  scramble: number,
  phase: WaiversData["phase"],
): string {
  const parts: string[] = [];
  const top = claims[0];
  if (top !== undefined)
    parts.push(
      `bid on ${String(claims.length)} player${plural(claims.length, "", "s")} (top bid $${String(top.bid?.b_star ?? 0)})`,
    );
  if (adds > 0) parts.push(`add ${String(adds)} free agent${plural(adds, "", "s")} now`);
  if (scramble > 0 && phase === "pre_run")
    parts.push(`${String(scramble)} on the scramble list after the run`);
  if (claims.length > 0 || adds > 0) return parts.join("; ");
  return parts.length > 0
    ? `no clear move: ${parts.join("; ")}`
    : "no bid has a positive expected value";
}
