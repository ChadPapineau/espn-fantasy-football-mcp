// rosterAudit.ts — E9 `espn_analyze_roster` (plan 07 E9; plan 10 B7; research 05 §4.2, §4.3, §5 ROS;
// sib research 05 §9.1–§9.5): rest-of-season construction for a 5-bench / 2-IR roster — the bench
// template DERIVED from E4's streamability (never imposed: K and D/ST one each, no bench QB/TE only
// where the position streams — `qb_bench == 0` only when `streamability.QB ≥ 0.9`), each bench
// player's marginal expected lineup points over the horizon (the exact lineup value with and without
// him, every week weighted by P(alive), plus an injury-cover term at a weekly absence hazard) and its
// role (stash, handcuff, bye cover, injury cover, upside), handcuff values (P(starter out) × the
// promoted lineup gain − the slot's alternative use; computed per case, never "always/never
// handcuff"), stash values (P(returns by w) × the lineup gain; zero after the deadline when he cannot
// return before the playoffs — "drop for a streamer"), consolidation candidates, droppables, and THE
// IR SECTION (research 05 §4.3 [V-docs]: eligibility OUT/IR only, the INVALID roster and its blocked
// adds, the forced drop — the hidden-bench player's acquisition first —, the hidden-bench play with
// EXACTLY its three risks, the activate-after-the-run warning, `effective_bench` = bench + IR slots
// holding a positive-value stash). When the roster is invalid the IR section is reported FIRST (the
// data object's first key, the rec's action and first driver — plan 10 B7). Bench players run as
// cooperative batches under the CPU deadline. Pure. New here (sib E9 is planned, not built).
import type { Clock } from "../clock.js";
import { auditIr, irStayStatus, type RosterSeat } from "../league/roster.js";
import { slotClassOf } from "../league/slots.js";
import {
  isIrEligible,
  type InjuryStatus,
  type IsoInstant,
  type RosterSlots,
  type Week,
} from "../league/types.js";
import type { Dist } from "../scoring/types.js";
import { DEFAULT_CV, POSITION_CV } from "./constants.js";
import { loopPacer, runCooperative, type Pacer } from "./cooperative.js";
import { ensure } from "./errors.js";
import { type AnyStamp, collectInputs, mergeInputs, newestAsOf } from "./inputs.js";
import { fastLineupValue, seatPlan, type FastPlayer } from "./lineup.js";
import { clamp, normalDist, round } from "./math.js";
import { REPLACEMENT } from "./replacement.js";
import type { StreamOption } from "./scheduleStress.js";
import type { Assumption, InputFreshness, Rec, RecSubject, RosterAnalysisData } from "./types.js";

/** E9's constants (research 05 §4.2–§4.3; sib research 05 §9) — [U] where marked. */
export const ROSTER_AUDIT = Object.freeze({
  /** A healthy starter's weekly absence hazard behind injury cover and handcuff values [U]. */
  weeklyAbsence: 0.06,
  /** Cold-start return hazards per week (research 05 §4.3 stash ranking) [U]. */
  returnHazard: Object.freeze({ OUT: 0.5, INJURY_RESERVE: 0.3, DEFAULT: 0.4 }),
  /** Weeks an INJURY_RESERVE player cannot return in (the NFL's IR minimum) [U]. */
  irMinWeeks: 4,
  /** Marginal value (points over the horizon) below which a bench player reads `upside`. */
  minRoleValue: 0.5,
  /** Bench players with marginal value below this are consolidation material [U]. */
  consolidateBelow: 2,
  /** Droppables listed. */
  maxDroppable: 5,
  /** Weeks 1..this are the `early` phase [U]; after the trade deadline is `late`. */
  earlyLastWeek: 4,
  /** Without a deadline, `late` starts this many weeks before the first playoff week [U]. */
  lateBeforePlayoffs: 2,
  /** P(playoffs) below which `competing: auto` reads eliminated. */
  eliminatedBelow: 0.01,
  /** P(returned by the first playoff week) below which a post-deadline stash has no value. */
  stashPlayoffMin: 0.05,
  maxPlayers: 60,
  maxWeeks: 22,
});

/**
 * The hidden-bench play's three risks (research 05 §4.3 item 3, [V-docs]) — exactly three, in this
 * order, fixed text (plan 10 B7: "the hidden-bench play carries exactly three risks").
 */
export const HIDDEN_BENCH_RISKS: readonly [string, string, string] = Object.freeze<
  [string, string, string]
>([
  "when his designation clears the roster becomes INVALID: every add is blocked (that week's scramble included) until he leaves IR, which forces a drop if the bench is full — the extra bench player acquired through the play is the designated drop",
  "activating an IR player before a pending waiver claim processes makes the claim fail when the bench is full: activate after the run, never the night before",
  "moves to and from IR count in the transaction counter and can carry a fee in leagues that charge for them",
]);

/**
 * Cold-start streamability when E4's curves are not passed (research 05 §4.1–§4.2, 10 teams: K and
 * D/ST stream at ≈ 1; QB10+ and TE5+ are replacement level, the best unslotted on the wire).
 */
export const COLD_STREAMABILITY: Readonly<Record<string, number>> = Object.freeze({
  K: 1,
  "D/ST": 1,
  QB: 0.95,
  TE: 0.95,
});

/** One rostered player as E9 sees him. */
export interface AuditPlayer {
  readonly player_id: number;
  readonly gsis_id?: string | null;
  readonly position: string;
  readonly eligible_slot_ids: readonly number[];
  readonly slot_id: number;
  readonly injury_status: InjuryStatus | null;
  readonly pro_team_id: number | null;
  /** ESPN `droppable` (false = on the undroppable list). */
  readonly droppable: boolean | null;
  readonly percent_owned: number | null;
  /** E1's per-week means over the horizon (a bye week carries `bye: true`). */
  readonly weeks: readonly { readonly week: Week; readonly mean: number; readonly bye: boolean }[];
  /** E1's ROS total Dist (droppables' `value_ros`), or null. */
  readonly ros?: Dist | null;
  /** P(returned by week) for an injured player (D2 / E7), or omitted → the cold-start hazards. */
  readonly return_by_week?: readonly { readonly week: Week; readonly p: number }[];
}

/** A handcuff case: my player behind a starter (any roster) and his promoted projection. */
export interface HandcuffCase {
  readonly handcuff: number;
  readonly starter: number;
  /** P(the starter is out) per week; omitted → the weekly absence hazard. */
  readonly p_starter_out?: readonly { readonly week: Week; readonly p: number }[];
  /** The handcuff's projected mean if promoted, per week. */
  readonly promoted: readonly { readonly week: Week; readonly mean: number }[];
}

/** An E9 request. */
export interface RosterAuditRequest {
  readonly roster: RosterSlots;
  readonly players: readonly AuditPlayer[];
  /** The horizon: the remaining weeks (regular season and playoffs). */
  readonly weeks: readonly Week[];
  readonly current_week: Week;
  readonly playoff_weeks: readonly Week[];
  /** The first week after the trade deadline (`tradeDeadlineWeeks.first_week_after`), or null. */
  readonly trade_deadline_week: Week | null;
  readonly competing?: "auto" | "yes" | "eliminated";
  /** E3 `season` under the reading in use (P(alive) weights, elimination), or null. */
  readonly season?: {
    readonly p_playoffs: number;
    readonly eliminated: boolean;
    readonly p_alive_by_week: readonly { readonly week: Week; readonly p: number }[];
  } | null;
  /** E4's streamability by position; omitted → COLD_STREAMABILITY. */
  readonly streamability?: Readonly<Record<string, number>> | null;
  /** The best available player per position and week (E4 `streamCandidates`). */
  readonly stream?: readonly StreamOption[];
  readonly handcuffs?: readonly HandcuffCase[];
  readonly rules: {
    readonly acquisition_limit: number | null;
    readonly acquisitions_used: number | null;
    readonly next_run_at: IsoInstant | null;
  };
  /** The extra bench player acquired through the hidden-bench play (the designated drop). */
  readonly hidden_bench_acquired?: number | null;
  readonly clock: Clock;
  readonly pacer?: Pacer;
  readonly deadline_ms?: number | null;
  readonly stamps?: readonly AnyStamp[];
  readonly inputs?: readonly InputFreshness[];
}

/** E9's outcome. */
export interface RosterAuditOutcome {
  readonly data: RosterAnalysisData;
  readonly partial: boolean;
  readonly warnings: readonly string[];
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

const cvOf = (position: string): number =>
  Object.hasOwn(POSITION_CV, position) ? (POSITION_CV[position] ?? DEFAULT_CV) : DEFAULT_CV;

/** The bench template derived from streamability (research 05 §4.2; plan 10 B7's implication). */
export function benchTemplate(
  roster: RosterSlots,
  streamability: Readonly<Record<string, number>>,
): RosterAnalysisData["bench_template"]["derived"] {
  const seatsOf = (pos: string): number =>
    roster.slots
      .filter(
        (s) =>
          s.class === "starter" &&
          s.eligible_positions.length === 1 &&
          s.eligible_positions[0] === pos,
      )
      .reduce((a, s) => a + s.count, 0);
  const streams = (pos: string): boolean => {
    const v = streamability[pos];
    return typeof v === "number" && Number.isFinite(v) && v >= REPLACEMENT.streamableMin;
  };
  const kSeats = seatsOf("K");
  const dstSeats = seatsOf("D/ST");
  const k = kSeats + (kSeats > 0 && !streams("K") ? 1 : 0);
  const dst = dstSeats + (dstSeats > 0 && !streams("D/ST") ? 1 : 0);
  const qb_bench = streams("QB") ? 0 : 1;
  const te_bench = streams("TE") ? 0 : 1;
  const rb_wr_depth = Math.max(
    0,
    roster.bench - qb_bench - te_bench - (k - kSeats) - (dst - dstSeats),
  );
  return { k, dst, qb_bench, te_bench, rb_wr_depth };
}

/** P(returned by each week) of an injured player: the input, else the cold-start hazards. */
export function returnCurve(
  p: Pick<AuditPlayer, "injury_status" | "return_by_week">,
  weeks: readonly Week[],
  currentWeek: Week,
): { week: Week; p: number }[] {
  const given = new Map((p.return_by_week ?? []).map((x) => [x.week, clamp(x.p, 0, 1)]));
  if (given.size > 0) {
    let last = 0;
    return weeks.map((w) => {
      last = Math.max(last, given.get(w) ?? last);
      return { week: w, p: round(last, 4) };
    });
  }
  const status = irStayStatus(p.injury_status);
  if (status === "may_stay" || status === "invalid") return weeks.map((w) => ({ week: w, p: 1 }));
  const s = p.injury_status;
  const h =
    s === "OUT"
      ? ROSTER_AUDIT.returnHazard.OUT
      : s === "INJURY_RESERVE"
        ? ROSTER_AUDIT.returnHazard.INJURY_RESERVE
        : ROSTER_AUDIT.returnHazard.DEFAULT;
  const blocked = s === "INJURY_RESERVE" ? ROSTER_AUDIT.irMinWeeks : 1;
  return weeks.map((w) => {
    const t = w - currentWeek - blocked + 1;
    return { week: w, p: round(t <= 0 ? 0 : 1 - (1 - h) ** t, 4) };
  });
}

/** E9. Throws AnalyticsError `invalid_request` on bounds. */
export async function analyzeRoster(req: RosterAuditRequest): Promise<RosterAuditOutcome> {
  ensure(
    req.players.length >= 1 && req.players.length <= ROSTER_AUDIT.maxPlayers,
    "roster size out of range",
    "players",
  );
  ensure(
    req.weeks.length >= 1 &&
      req.weeks.length <= ROSTER_AUDIT.maxWeeks &&
      req.weeks.every((w) => Number.isInteger(w) && w >= 1 && w <= ROSTER_AUDIT.maxWeeks),
    "weeks out of range",
    "weeks",
  );
  ensure(
    Number.isInteger(req.current_week) && req.current_week >= 1 && req.current_week <= 22,
    "current week out of range",
    "week",
  );
  const ids = new Set<number>();
  for (const p of req.players) {
    ensure(!ids.has(p.player_id), "a player is listed twice", "players");
    ids.add(p.player_id);
  }
  const nowMs = req.clock.nowMs();
  const weeks = [...new Set(req.weeks)].sort((a, b) => a - b);
  const assumptions: Assumption[] = [];
  const warnings: string[] = [];
  const byId = new Map(req.players.map((p) => [p.player_id, p]));

  // competing, phase, weights
  const season = req.season ?? null;
  const competing: "yes" | "eliminated" =
    req.competing === "yes" || req.competing === "eliminated"
      ? req.competing
      : season !== null && (season.eliminated || season.p_playoffs < ROSTER_AUDIT.eliminatedBelow)
        ? "eliminated"
        : "yes";
  if (season === null && (req.competing ?? "auto") === "auto")
    assumptions.push(
      A("competing assumed: no season simulation", "espn_analyze_matchup(mode: season) runs"),
    );
  const firstPlayoff = req.playoff_weeks.length === 0 ? null : Math.min(...req.playoff_weeks);
  const late =
    req.trade_deadline_week !== null
      ? req.current_week >= req.trade_deadline_week
      : firstPlayoff !== null && req.current_week >= firstPlayoff - ROSTER_AUDIT.lateBeforePlayoffs;
  const phase: RosterAnalysisData["phase"] = late
    ? "late"
    : req.current_week <= ROSTER_AUDIT.earlyLastWeek
      ? "early"
      : "mid";
  const alive = new Map((season?.p_alive_by_week ?? []).map((x) => [x.week, clamp(x.p, 0, 1)]));
  const weightOf = (w: Week): number => (competing === "eliminated" ? 0 : (alive.get(w) ?? 1));

  // the IR audit (research 05 §4.3; league/roster.ts)
  const seats: RosterSeat[] = req.players.map((p) => ({
    player_id: p.player_id,
    slot_id: p.slot_id,
    eligible_slot_ids: p.eligible_slot_ids,
    injury_status: p.injury_status,
    position: p.position,
    pro_team_id: p.pro_team_id,
  }));
  const audit = auditIr(seats, req.roster);

  // lineup values by week (the fast kernel; IR occupants cannot start)
  const plan = seatPlan(req.roster);
  const active = req.players.filter((p) => slotClassOf(p.slot_id) !== "ir");
  const bench = active.filter((p) => slotClassOf(p.slot_id) === "bench");
  const weekMean = (p: AuditPlayer, w: Week): number => {
    const x = p.weeks.find((y) => y.week === w);
    return x === undefined || x.bye || !Number.isFinite(x.mean) ? 0 : Math.max(0, x.mean);
  };
  const eligibleSets = new Map(req.players.map((p) => [p.player_id, new Set(p.eligible_slot_ids)]));
  const fastOf = (p: AuditPlayer, v: number): FastPlayer => ({
    eligible: eligibleSets.get(p.player_id) ?? new Set(),
    value: v,
  });
  const lineupValue = (
    players: readonly AuditPlayer[],
    w: Week,
    over?: ReadonlyMap<number, number>,
  ) =>
    fastLineupValue(
      plan,
      players.map((p) => fastOf(p, over?.get(p.player_id) ?? weekMean(p, w))),
    );
  const streamOf = (pos: string, w: Week): number =>
    Math.max(
      0,
      ...(req.stream ?? [])
        .filter((o) => o.week === w && o.position === pos && Number.isFinite(o.points))
        .map((o) => o.points),
    );
  if ((req.stream ?? []).length === 0)
    assumptions.push(
      A(
        "no stream baseline in the input: injury cover and the slot's alternative use are measured against an empty seat",
        "espn_analyze_replacement's stream baseline is passed",
      ),
    );

  // the best available player at a position as a fast-kernel player (null when none is read)
  const streamerFor = (pos: string, w: Week): FastPlayer | null => {
    const v = streamOf(pos, w);
    if (v <= 0) return null;
    return {
      eligible: new Set(
        req.roster.slots
          .filter(
            (x) => x.class !== "ir" && x.class !== "bench" && x.eligible_positions.includes(pos),
          )
          .map((x) => x.slot_id),
      ),
      value: v,
    };
  };
  /** The lineup value of `players` in week w, one of them zeroed (absent), an extra player added. */
  const lineupWith = (
    players: readonly AuditPlayer[],
    w: Week,
    zero: number | null,
    extra: FastPlayer | null,
  ): number =>
    fastLineupValue(plan, [
      ...players.map((x) => fastOf(x, x.player_id === zero ? 0 : weekMean(x, w))),
      ...(extra === null ? [] : [extra]),
    ]);

  // the slot's alternative use: the best available add's marginal value over the horizon
  const streamPositions = [...new Set((req.stream ?? []).map((o) => o.position))].sort();
  const addValue = (pos: string): number => {
    let v = 0;
    for (const w of weeks) {
      const st = streamerFor(pos, w);
      if (st !== null)
        v += weightOf(w) * (lineupWith(active, w, null, st) - lineupWith(active, w, null, null));
    }
    return v;
  };

  // bench marginal values (cooperative: one bench player per step), all on the roster as it stands
  // (the wire enters once, as the slot's alternative use): m0 = V(R) − V(R \ p) by week — byes and
  // E1's known absences; the injury term adds, for every other player s at the weekly absence hazard
  // h, h · max(0, m_s − m0) with m_s = V(R \ s) − V(R \ {s, p}) — p's value when s is out
  const cuffs = new Map((req.handcuffs ?? []).map((h) => [h.handcuff, h]));
  const benchRows: { p: AuditPlayer; lineup: number; injury: number }[] = [];
  const run = await runCooperative(
    bench.length,
    (i) => {
      const p = bench[i];
      if (p === undefined) return;
      const without = active.filter((x) => x.player_id !== p.player_id);
      let lineup = 0;
      let injury = 0;
      for (const w of weeks) {
        const wt = weightOf(w);
        if (wt === 0) continue;
        const m0 = lineupWith(active, w, null, null) - lineupWith(without, w, null, null);
        lineup += wt * m0;
        if (weekMean(p, w) <= 0) continue;
        for (const s of active) {
          if (s.player_id === p.player_id || weekMean(s, w) <= 0) continue;
          const ms =
            lineupWith(active, w, s.player_id, null) - lineupWith(without, w, s.player_id, null);
          injury += wt * ROSTER_AUDIT.weeklyAbsence * Math.max(0, ms - m0);
        }
      }
      benchRows.push({ p, lineup, injury });
    },
    { pacer: req.pacer ?? loopPacer(req.clock), deadlineMs: req.deadline_ms },
  );
  if (run.partial)
    warnings.push(
      `partial: ${String(run.completed)} of ${String(bench.length)} bench players before the CPU deadline`,
    );

  const altUse = Math.max(0, ...streamPositions.map(addValue));

  // handcuffs (computed per case — sib research 05 §9.2)
  const handcuffValues: RosterAnalysisData["handcuff_values"][number][] = [];
  for (const h of req.handcuffs ?? []) {
    const p = byId.get(h.handcuff);
    if (p === undefined || slotClassOf(p.slot_id) === "ir") continue;
    const outBy = new Map((h.p_starter_out ?? []).map((x) => [x.week, clamp(x.p, 0, 1)]));
    const promoted = new Map(h.promoted.map((x) => [x.week, Math.max(0, x.mean)]));
    let v = 0;
    for (const w of weeks) {
      const pOut = outBy.get(w) ?? ROSTER_AUDIT.weeklyAbsence;
      const up = promoted.get(w);
      if (up === undefined) continue;
      const gain = lineupValue(active, w, new Map([[p.player_id, up]])) - lineupValue(active, w);
      v += weightOf(w) * pOut * Math.max(0, gain);
    }
    const value = v - altUse;
    handcuffValues.push({
      handcuff: h.handcuff,
      starter: h.starter,
      value: normalDist(round(value, 2), round(Math.abs(v) * 0.6, 2), "position_cv"),
      verdict:
        value > 0
          ? "hold: positive value over the slot's alternative use"
          : "drop: the slot is worth more",
    });
  }
  const positiveCuffs = new Set(
    handcuffValues.filter((h) => h.value.mean > 0).map((h) => h.handcuff),
  );

  // stashes: every IR occupant and every IR-eligible bench player (research 05 §4.3 item 1)
  const stashPlayers = req.players.filter(
    (p) =>
      slotClassOf(p.slot_id) === "ir" ||
      (slotClassOf(p.slot_id) === "bench" && isIrEligible(p.injury_status)),
  );
  const stashValues: RosterAnalysisData["stash_values"][number][] = [];
  const stashPositive = new Set<number>();
  for (const s of stashPlayers) {
    const curve = returnCurve(s, weeks, req.current_week);
    const pBy = new Map(curve.map((c) => [c.week, c.p]));
    let v = 0;
    const without = active.filter((x) => x.player_id !== s.player_id);
    const withS = [...without, s];
    for (const w of weeks)
      v +=
        weightOf(w) *
        (pBy.get(w) ?? 0) *
        Math.max(0, lineupValue(withS, w) - lineupValue(without, w));
    const pAtPlayoffs = firstPlayoff === null ? 1 : (pBy.get(firstPlayoff) ?? 0);
    const deadOnArrival = late && pAtPlayoffs < ROSTER_AUDIT.stashPlayoffMin;
    const value = deadOnArrival ? 0 : v;
    if (value > 0) stashPositive.add(s.player_id);
    stashValues.push({
      player_id: s.player_id,
      p_return_by_week: curve,
      value: normalDist(round(value, 2), round(value * 0.6, 2), "position_cv"),
      verdict: value > 0 ? "hold" : "drop for a streamer",
      playoff_horizon_note: deadOnArrival
        ? "past the trade deadline and unlikely back before the playoffs: no trade value either — drop for a streamer"
        : null,
    });
  }

  // the bench plan and its roles
  const benchPlan: RosterAnalysisData["bench_plan"][number][] = benchRows
    .map((r) => {
      const mv = r.lineup + r.injury;
      const role: RosterAnalysisData["bench_plan"][number]["role"] = stashPositive.has(
        r.p.player_id,
      )
        ? "stash"
        : cuffs.has(r.p.player_id)
          ? "handcuff"
          : mv < ROSTER_AUDIT.minRoleValue
            ? "upside"
            : r.lineup >= r.injury
              ? "bye_cover"
              : "injury_cover";
      return { slot: "BE", role, player_id: r.p.player_id, marginal_value: round(mv, 2) };
    })
    .sort((a, b) => b.marginal_value - a.marginal_value || a.player_id - b.player_id);
  const mvOf = new Map(benchPlan.map((b) => [b.player_id, b.marginal_value]));

  // droppables: the lowest marginal value first, protected stashes and handcuffs left out
  const rosValue = (p: AuditPlayer): Dist => {
    if (p.ros !== null && p.ros !== undefined) return p.ros;
    const total = weeks.reduce((s, w) => s + weekMean(p, w), 0);
    const ss = weeks.reduce((s, w) => s + weekMean(p, w) ** 2, 0);
    return normalDist(round(total, 2), round(cvOf(p.position) * Math.sqrt(ss), 2), "position_cv");
  };
  const droppable = bench
    .filter((p) => !stashPositive.has(p.player_id) && !positiveCuffs.has(p.player_id))
    .map((p) => ({ p, mv: mvOf.get(p.player_id) ?? 0 }))
    .sort(
      (a, b) =>
        Number(a.p.droppable === false) - Number(b.p.droppable === false) ||
        a.mv - b.mv ||
        rosValue(a.p).mean - rosValue(b.p).mean ||
        a.p.player_id - b.p.player_id,
    )
    .slice(0, ROSTER_AUDIT.maxDroppable)
    .map(({ p }) => ({
      player_id: p.player_id,
      value_ros: rosValue(p),
      re_add_risk: { percent_owned: p.percent_owned, rivals_claiming: null },
      undroppable: p.droppable === false,
    }));

  // consolidation (sib research 05 §9.4): bench players who never start, while depth is not binding
  const idle = benchPlan
    .filter(
      (b) =>
        b.role !== "stash" &&
        b.role !== "handcuff" &&
        b.marginal_value < ROSTER_AUDIT.consolidateBelow,
    )
    .map((b) => byId.get(b.player_id))
    .filter((p): p is AuditPlayer => p !== undefined)
    .sort((a, b) => rosValue(b).mean - rosValue(a).mean || a.player_id - b.player_id);
  const consolidation: RosterAnalysisData["consolidation_candidates"][number][] = [];
  if (idle.length >= 2 && competing === "yes" && !late) {
    const starters = active.filter((p) => {
      const c = slotClassOf(p.slot_id);
      return (c === "starter" || c === "flex") && p.position !== "K" && p.position !== "D/ST";
    });
    const typ = (p: AuditPlayer): number =>
      weeks.reduce((s, w) => s + weekMean(p, w), 0) / Math.max(1, weeks.length);
    const weakest = [...starters].sort((a, b) => typ(a) - typ(b) || a.player_id - b.player_id)[0];
    const give = idle.slice(0, 2).map((p) => p.player_id);
    consolidation.push({
      give,
      target_profile:
        weakest === undefined
          ? "one starter who outscores both"
          : `one ${weakest.position} who starts over your weakest ${weakest.position}`,
    });
  }

  // the IR section (research 05 §4.3)
  const forcedDrop = !audit.forced_drop_needed
    ? null
    : req.hidden_bench_acquired !== null &&
        req.hidden_bench_acquired !== undefined &&
        bench.some((p) => p.player_id === req.hidden_bench_acquired)
      ? req.hidden_bench_acquired
      : (droppable.find((d) => !d.undroppable)?.player_id ?? null);
  const inIrMayStay = audit.may_stay_players;
  const outCandidates = active
    .filter(
      (p) =>
        p.injury_status === "OUT" &&
        p.eligible_slot_ids.includes(21) &&
        slotClassOf(p.slot_id) !== "ir",
    )
    .sort((a, b) => rosValue(b).mean - rosValue(a).mean || a.player_id - b.player_id);
  let hidden: RosterAnalysisData["ir"]["hidden_bench_play"] = null;
  if (req.roster.ir > 0) {
    const inProgress = inIrMayStay[0];
    const candidate = outCandidates[0];
    hidden =
      inProgress !== undefined
        ? { available: true, player_id: inProgress, risks: HIDDEN_BENCH_RISKS }
        : candidate !== undefined && audit.open_slots > 0
          ? { available: true, player_id: candidate.player_id, risks: HIDDEN_BENCH_RISKS }
          : { available: false, player_id: null, risks: HIDDEN_BENCH_RISKS };
  }
  const returning = req.players.filter(
    (p) =>
      slotClassOf(p.slot_id) === "ir" &&
      (irStayStatus(p.injury_status) === "may_stay" || irStayStatus(p.injury_status) === "invalid"),
  );
  const activationWarning =
    returning.length === 0 && hidden?.available !== true
      ? null
      : req.rules.next_run_at !== null
        ? `activate an IR player after the next waiver run (${req.rules.next_run_at}), never the night before — a pending claim fails if the bench fills before it processes`
        : "activate an IR player after a waiver run, never the night before — a pending claim fails if the bench fills before it processes";
  const irPositive = req.players.filter(
    (p) => slotClassOf(p.slot_id) === "ir" && stashPositive.has(p.player_id),
  ).length;
  const ir: RosterAnalysisData["ir"] = {
    slots: audit.slots,
    eligible_now: audit.eligible_now.map((id) => ({
      player_id: id,
      tag: byId.get(id)?.injury_status ?? null,
    })),
    invalid: audit.invalid,
    invalid_players: [...audit.invalid_players],
    forced_drop: forcedDrop,
    blocked_until: null,
    hidden_bench_play: hidden,
    activation_timing_warning: activationWarning,
    effective_bench: req.roster.bench + Math.min(audit.slots, irPositive),
  };
  if (audit.uncertain_players.length > 0)
    warnings.push(
      `${String(audit.uncertain_players.length)} IR occupants with a status no ESPN page rules on: check by hand`,
    );

  // the bench template (derived and displayed, never imposed)
  const given = req.streamability ?? null;
  const streamability: Record<string, number> = {};
  for (const [k, v] of Object.entries(given ?? COLD_STREAMABILITY))
    if (Number.isFinite(v)) streamability[k] = round(v, 3);
  const template = benchTemplate(req.roster, streamability);

  const limit = req.rules.acquisition_limit;
  const used = req.rules.acquisitions_used;
  const addsRemaining =
    limit === null
      ? null
      : Math.max(0, limit - (used !== null && Number.isFinite(used) ? used : 0));

  // the recommendation — the IR section first when the roster is invalid
  const inputs = mergeInputs(collectInputs(req.stamps ?? [], req.clock), req.inputs ?? []);
  let action: string;
  let subjects: RecSubject[] = [];
  let point = 0;
  let noMove = true;
  const drivers: { name: string; contribution: number }[] = [];
  const subject = (id: number, role: RecSubject["role"]): RecSubject => ({
    player_id: id,
    gsis_id: byId.get(id)?.gsis_id ?? null,
    role,
    slot: role === "ir_move" ? "IR" : null,
  });
  if (audit.invalid) {
    const n = audit.invalid_players.length;
    action = `roster INVALID: move ${String(n)} player${n === 1 ? "" : "s"} out of IR before any add — adds are blocked until then${forcedDrop === null ? "" : "; the forced drop is named"}`;
    subjects = [
      ...audit.invalid_players.map((id) => subject(id, "ir_move")),
      ...(forcedDrop === null ? [] : [subject(forcedDrop, "drop")]),
    ];
    drivers.push({ name: "ir_invalid", contribution: 0 });
    noMove = false;
  } else if (hidden?.available === true && hidden.player_id !== null && inIrMayStay.length === 0) {
    action =
      "move the OUT player to IR to open a bench spot — see the hidden-bench play's three risks; activate after a waiver run";
    subjects = [subject(hidden.player_id, "ir_move")];
    point = round(altUse, 2);
    drivers.push({ name: "bench_spot_alternative_use", contribution: round(altUse, 2) });
    noMove = false;
  } else if (competing === "eliminated") {
    action = "eliminated: no roster move changes the season — nothing to optimise";
  } else {
    const top = droppable.find((d) => !d.undroppable);
    action = "no roster move: the bench plan as derived";
    if (top !== undefined)
      drivers.push({
        name: "lowest_bench_marginal_value",
        contribution: mvOf.get(top.player_id) ?? 0,
      });
  }
  if (competing === "eliminated")
    assumptions.push(
      A(
        "eliminated: every week weighted 0 — values are reported, not acted on",
        "the season changes",
      ),
    );
  assumptions.push(
    A(
      `a healthy starter misses a week with probability ${String(ROSTER_AUDIT.weeklyAbsence)} (injury cover, handcuffs) [U]`,
      "the league's own absence history is read",
    ),
    A(
      given === null
        ? "streamability from the research 05 §4.1–§4.2 cold start (10 teams)"
        : "streamability from espn_analyze_replacement's curves",
      "the replacement curves are recomputed",
    ),
  );
  const rec: Rec = {
    action,
    subjects,
    lineup: null,
    point_estimate: point,
    distribution: normalDist(point, Math.abs(point) * 0.5, "position_cv"),
    delta_vs_next: { value: point, p10: round(point * 0.36, 2), p90: round(point * 1.64, 2) },
    decision_metric: "marginal_value",
    drivers,
    assumptions,
    confidence: { role_games: 0, inputs },
    as_of: newestAsOf(inputs, req.clock.nowIso()),
    latest_execution_time:
      audit.invalid && req.rules.next_run_at !== null && Date.parse(req.rules.next_run_at) > nowMs
        ? req.rules.next_run_at
        : null,
    no_move: noMove,
    log_id: null,
  };
  const rest = {
    phase,
    competing,
    bench_template: {
      derived: template,
      basis:
        given === null
          ? "cold start: research 05 §4.1–§4.2 (10 teams)"
          : "curves from espn_analyze_replacement",
      streamability,
    },
    bench_plan: benchPlan,
    handcuff_values: handcuffValues,
    stash_values: stashValues,
    consolidation_candidates: consolidation,
    droppable,
    adds_remaining: addsRemaining,
    rec,
    inputs,
  };
  // the IR section FIRST when the roster is invalid (plan 10 B7; research 05 §4.3)
  const data: RosterAnalysisData = audit.invalid ? { ir, ...rest } : { ...rest, ir };
  return { data, partial: run.partial, warnings };
}
