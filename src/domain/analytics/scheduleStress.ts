// scheduleStress.ts — E8 `espn_analyze_schedule` (plan 07 E8 = sib 07 E8's shape + `weight: {
// p_alive, importance }` from E3 `season` and `playoff_weeks: { bye_seeds, week17_rest_risk }`;
// research 05 §5 Bye/playoff planning, §2.3; sib research 05 §7.1–§7.3): the roster stress-tested
// week by week — each week's best lineup by the exact assignment over the league's seats with byes
// and E1's known absences applied and the stream baseline (the best available player per position,
// E4) as the hole filler; a hole is a seat the roster cannot fill better than the wire; the week's
// cost is the drop from the roster's full-strength lineup (absent starters at their typical value),
// a bye CLUSTER when ≥ 2 full-strength starters are out ("cost, not count"); each week weighted by
// `P(alive at w)` (importance = P(alive), research 05 §5: a week-15 cluster matters only with
// material P(playoffs)); the worst weighted weeks and their fixes (stream the hole: the gain that
// week against the cheapest bench drop over the horizon, the deadline the week's first kickoff — a
// Thursday hole cannot be fixed after Thursday); the playoff weeks with the bye seeds, the (weak,
// shrunk) matchup multipliers passed through from D5 with the near-noise evidence note, and the
// week-17 resting flag (unmodelled [F] without a clinch/elimination data kind — research 05 §2.3,
// §8.3). Weeks run as cooperative batches under the CPU deadline. Pure. New here.
import type { Clock } from "../clock.js";
import { gamesOfWeek, kickoffMsOf } from "../league/schedule.js";
import { canOccupySlot, slotClassOf, startingSeats } from "../league/slots.js";
import {
  isIrEligible,
  type InjuryStatus,
  type IsoInstant,
  type ProSchedule,
  type RosterSlots,
  type Week,
} from "../league/types.js";
import type { Dist } from "../scoring/types.js";
import { FORBIDDEN, solveAssignment } from "./assignment.js";
import { DEFAULT_CV, POSITION_CV } from "./constants.js";
import { loopPacer, runCooperative, type Pacer } from "./cooperative.js";
import { ensure } from "./errors.js";
import { type AnyStamp, collectInputs, mergeInputs, newestAsOf } from "./inputs.js";
import { fastLineupValue, seatPlan, type FastPlayer } from "./lineup.js";
import { clamp, normalDist, round, zeroDist } from "./math.js";
import { returnCurve } from "./rosterAudit.js";
import { lineupMoments, type TotalMember } from "./totals.js";
import type {
  Assumption,
  InputFreshness,
  Rec,
  RecSubject,
  ScheduleAnalysisData,
  SeedingStatus,
} from "./types.js";

/** E8's constants (research 05 §5; sib research 05 §7) — [U] where marked. */
export const SCHEDULE = Object.freeze({
  /** A week's projection below this share of the player's typical value is a known absence [U]. */
  absentShare: 0.25,
  /** Full-strength starters out at which a week is a bye cluster (sib research 05 §7.1). */
  clusterMin: 2,
  /** Weeks reported as the worst. */
  worstWeeks: 3,
  /** A weighted drop below this (points) is not a problem week. */
  minDrop: 0.5,
  /** The matchup multiplier's accepted range (D5's shrunk multipliers; outside → clamped). */
  multiplier: Object.freeze({ min: 0.5, max: 1.5 }),
  maxPlayers: 60,
  maxWeeks: 22,
  /** A streamer is preferred over a roster player only when strictly better by this much. */
  streamEpsilon: 1e-6,
});

/** The fixed evidence sentence (research 05 §5, sib research 05 §7.2 — preseason SOS ≈ noise). */
export const SCHEDULE_EVIDENCE_NOTE =
  "preseason and early-season strength of schedule is close to noise; in-season adjusted points allowed carries a modest, shrunk signal — a tie-breaker, never a driver (research 05 §5; sib research 05 §7.2)";

/** One rostered player as E8 sees him: slots, position and E1's week-by-week projection. */
export interface SchedulePlayer {
  readonly player_id: number;
  readonly position: string;
  readonly eligible_slot_ids: readonly number[];
  readonly injury_status: InjuryStatus | null;
  /** NFL team id (the week-17 resting flag and the same-team correlations); null or 0 = none. */
  readonly pro_team_id: number | null;
  /** His current slot (an IR occupant cannot start until activated). */
  readonly slot_id: number;
  /** E1 per horizon week (a bye week carries `bye: true`). */
  readonly weeks: readonly { readonly week: Week; readonly dist: Dist; readonly bye: boolean }[];
}

/** One stream option: the best available player at a position in a week (E4 `streamCandidates`). */
export interface StreamOption {
  readonly position: string;
  readonly week: Week;
  readonly player_id: number | null;
  readonly points: number;
}

/** An E8 request. */
export interface ScheduleRequest {
  readonly roster: RosterSlots;
  readonly players: readonly SchedulePlayer[];
  /** The weeks analysed (default: the remaining regular season and playoff weeks — the tool's). */
  readonly weeks: readonly Week[];
  /** The league's playoff weeks (`matchupPeriods`) and first-round byes. */
  readonly playoff: { readonly weeks: readonly Week[]; readonly bye_seeds: number | null };
  readonly include_playoffs?: boolean;
  /** E3 `season`'s `p_alive_by_week` under the reading in use; null → every week weighted 1. */
  readonly p_alive_by_week?: readonly { readonly week: Week; readonly p: number }[] | null;
  /** The reading E3's weights were simulated under. */
  readonly seeding: SeedingStatus;
  readonly stream?: readonly StreamOption[];
  /** D5's shrunk playoff-week matchup multipliers for my players (passed through, clamped). */
  readonly matchup_multipliers?: readonly {
    readonly player_id: number;
    readonly multiplier: number;
    readonly shrink_w: number;
  }[];
  /** NFL teams at risk of resting starters in week 17 (no data kind yet → omitted: unmodelled). */
  readonly resting_risk_pro_team_ids?: readonly number[];
  /** The fix deadlines (each week's first kickoff); omitted → deadlines null. */
  readonly schedule?: Pick<ProSchedule, "games">;
  readonly clock: Clock;
  readonly pacer?: Pacer;
  readonly deadline_ms?: number | null;
  readonly stamps?: readonly AnyStamp[];
  readonly inputs?: readonly InputFreshness[];
}

/** E8's outcome. */
export interface ScheduleOutcome {
  readonly data: ScheduleAnalysisData;
  readonly partial: boolean;
  readonly warnings: readonly string[];
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

const cvOf = (position: string): number =>
  Object.hasOwn(POSITION_CV, position) ? (POSITION_CV[position] ?? DEFAULT_CV) : DEFAULT_CV;

/** A player's typical value: his mean over the horizon's non-bye weeks (0 when none). */
export function typicalValue(p: SchedulePlayer): number {
  const ws = p.weeks.filter((w) => !w.bye && Number.isFinite(w.dist.mean));
  return ws.length === 0 ? 0 : ws.reduce((s, w) => s + w.dist.mean, 0) / ws.length;
}

/** One seat's occupant in a week's solve. */
type Occupant =
  | {
      readonly kind: "player";
      readonly player: SchedulePlayer;
      readonly dist: Dist;
      readonly value: number;
    }
  | { readonly kind: "stream"; readonly option: StreamOption; readonly position: string }
  | { readonly kind: "empty" };

const EMPTY: Occupant = Object.freeze({ kind: "empty" });

interface WeekSolve {
  readonly seats: readonly { readonly name: string; readonly occupant: Occupant }[];
  readonly mean: number;
}

/**
 * The best lineup of one week by mean (exact assignment): rows are the league's starting seats,
 * columns the active roster players with a positive value that week, one stream copy per (position,
 * seat that accepts it) when `stream` is given, and one empty column per seat — so a seat no player
 * can score in stays empty (a hole) at no cost.
 */
export function solveWeek(
  roster: RosterSlots,
  players: readonly {
    readonly player: SchedulePlayer;
    readonly value: number;
    readonly dist: Dist;
  }[],
  stream: readonly StreamOption[],
): WeekSolve {
  const seats = startingSeats(roster);
  type Col =
    { kind: "player"; idx: number } | { kind: "stream"; option: StreamOption } | { kind: "empty" };
  const cols: Col[] = players.map((_, idx) => ({ kind: "player", idx }));
  for (const o of stream) {
    const copies = seats.filter((s) =>
      roster.slots.find((x) => x.slot_id === s.slot_id)?.eligible_positions.includes(o.position),
    ).length;
    for (let c = 0; c < copies; c++) cols.push({ kind: "stream", option: o });
  }
  for (const _seat of seats) cols.push({ kind: "empty" });
  const cost = seats.map((s) => {
    const accepts = roster.slots.find((x) => x.slot_id === s.slot_id)?.eligible_positions ?? [];
    return cols.map((c) => {
      if (c.kind === "empty") return 0;
      if (c.kind === "stream")
        return accepts.includes(c.option.position)
          ? -(Math.max(0, c.option.points) - SCHEDULE.streamEpsilon)
          : FORBIDDEN;
      const p = players[c.idx];
      if (p === undefined) return FORBIDDEN;
      // a player who scores nothing that week (bye, out) never fills a seat: it is a hole
      return p.value > 0 && canOccupySlot(s.slot_id, p.player) ? -p.value : FORBIDDEN;
    });
  });
  const ans = solveAssignment(cost);
  let mean = 0;
  const out = seats.map((s, i): { name: string; occupant: Occupant } => {
    const j = ans[i] ?? -1;
    const c = cols[j];
    const row = cost[i] ?? [];
    if (c === undefined || (row[j] ?? FORBIDDEN) >= FORBIDDEN / 2 || c.kind === "empty")
      return { name: s.name, occupant: EMPTY };
    if (c.kind === "stream") {
      mean += Math.max(0, c.option.points);
      return {
        name: s.name,
        occupant: { kind: "stream", option: c.option, position: c.option.position },
      };
    }
    const p = players[c.idx];
    if (p === undefined) return { name: s.name, occupant: EMPTY };
    mean += Math.max(0, p.value);
    return {
      name: s.name,
      occupant: { kind: "player", player: p.player, dist: p.dist, value: p.value },
    };
  });
  return { seats: out, mean };
}

/** The total Dist of a solved week (roster starters' Dists, streamers at a position CV, empties 0). */
function weekDist(solve: WeekSolve): Dist {
  const members: TotalMember[] = [];
  let k = 0;
  for (const s of solve.seats) {
    const o = s.occupant;
    if (o.kind === "player")
      members.push({
        player_id: o.player.player_id,
        position: o.player.position,
        pro_team_id: o.player.pro_team_id,
        points: o.dist,
      });
    else if (o.kind === "stream")
      members.push({
        player_id: -1_000_000 - k++,
        position: o.position,
        pro_team_id: null,
        points: normalDist(
          o.option.points,
          cvOf(o.position) * Math.max(0, o.option.points),
          "position_cv",
        ),
      });
  }
  const m = lineupMoments(members);
  return normalDist(m.mu, Math.sqrt(m.v), "position_cv");
}

/** The first known kickoff of a week (the fix deadline), or null. */
function firstKickoff(
  schedule: Pick<ProSchedule, "games"> | undefined,
  week: Week,
): IsoInstant | null {
  if (schedule === undefined) return null;
  const k = gamesOfWeek(schedule, week)
    .map(kickoffMsOf)
    .find((x): x is number => x !== null);
  return k === undefined ? null : new Date(k).toISOString();
}

/** E8. Throws AnalyticsError `invalid_request` on bounds. */
export async function analyzeSchedule(req: ScheduleRequest): Promise<ScheduleOutcome> {
  ensure(
    req.players.length >= 1 && req.players.length <= SCHEDULE.maxPlayers,
    "roster size out of range",
    "players",
  );
  ensure(
    req.weeks.length >= 1 &&
      req.weeks.length <= SCHEDULE.maxWeeks &&
      req.weeks.every((w) => Number.isInteger(w) && w >= 1 && w <= SCHEDULE.maxWeeks) &&
      new Set(req.weeks).size === req.weeks.length,
    "weeks out of range",
    "weeks",
  );
  const ids = new Set<number>();
  for (const p of req.players) {
    ensure(!ids.has(p.player_id), "a player is listed twice", "players");
    ids.add(p.player_id);
  }
  const includePlayoffs = req.include_playoffs !== false;
  const playoffSet = new Set(req.playoff.weeks);
  const weeks = [...req.weeks]
    .filter((w) => includePlayoffs || !playoffSet.has(w))
    .sort((a, b) => a - b);
  ensure(weeks.length >= 1, "no week left to analyse", "weeks");
  const assumptions: Assumption[] = [];
  const warnings: string[] = [];
  const nowMs = req.clock.nowMs();

  const active = req.players.filter((p) => slotClassOf(p.slot_id) !== "ir");
  const inIr = req.players.length - active.length;
  if (inIr > 0)
    assumptions.push(
      A(
        `${String(inIr)} IR occupants are out of every week (an IR player must be activated to start)`,
        "a player is activated",
      ),
    );
  const typical = new Map(active.map((p) => [p.player_id, typicalValue(p)]));
  // an injured player is out of a week whose P(returned by then) is below one half — E1 applies the
  // injury status to its first week only (projection.ts); the cold-start return hazards of E9
  const out = new Map(
    req.players
      .filter((p) => isIrEligible(p.injury_status) || p.injury_status === "SUSPENSION")
      .map((p) => {
        const curve = returnCurve({ injury_status: p.injury_status }, weeks, Math.min(...weeks));
        return [p.player_id, new Set(curve.filter((c) => c.p < 0.5).map((c) => c.week))] as const;
      }),
  );
  const weekOf = (p: SchedulePlayer, w: Week) => {
    const x = p.weeks.find((y) => y.week === w) ?? null;
    return x !== null && out.get(p.player_id)?.has(w) === true
      ? { ...x, dist: zeroDist(x.dist.basis) }
      : x;
  };
  if (out.size > 0)
    assumptions.push(
      A(
        `${String(out.size)} injured players are out of each week their cold-start return probability is below one half`,
        "D2 or E7 report an expected return",
      ),
    );
  const pAlive = new Map((req.p_alive_by_week ?? []).map((x) => [x.week, clamp(x.p, 0, 1)]));
  if (req.p_alive_by_week === null || req.p_alive_by_week === undefined)
    assumptions.push(
      A(
        "every week weighted 1: no season simulation (P(alive) unknown)",
        "espn_analyze_matchup(mode: season) runs first",
      ),
    );
  const streamByWeek = new Map<Week, StreamOption[]>();
  for (const o of req.stream ?? []) {
    if (!Number.isFinite(o.points)) continue;
    const list = streamByWeek.get(o.week) ?? [];
    // one option per position per week: the best
    const cur = list.findIndex((x) => x.position === o.position);
    if (cur < 0) list.push(o);
    else if ((list[cur]?.points ?? 0) < o.points) list[cur] = o;
    streamByWeek.set(o.week, list);
  }
  const unweighted = weeks.filter((w) => playoffSet.has(w) && !pAlive.has(w));
  if (pAlive.size > 0 && unweighted.length > 0)
    assumptions.push(
      A(
        `playoff weeks ${unweighted.join(", ")} have no simulated P(alive): weighted 1`,
        "the season simulation includes the bracket",
      ),
    );
  if ((req.stream ?? []).length === 0)
    assumptions.push(
      A(
        "no stream baseline in the input: a hole stays empty (0 points)",
        "espn_analyze_replacement's stream baseline is passed",
      ),
    );

  const seats = seatPlan(req.roster);
  const fast = (vals: readonly { p: SchedulePlayer; v: number }[]): number =>
    fastLineupValue(
      seats,
      vals.map(({ p, v }): FastPlayer => ({ eligible: new Set(p.eligible_slot_ids), value: v })),
    );

  type WeekRow = ScheduleAnalysisData["weeks"][number] & {
    readonly drop: number;
    readonly gain: number;
    readonly out: number;
    readonly streamed: readonly StreamOption[];
  };
  const rows: WeekRow[] = [];
  const run = await runCooperative(
    weeks.length,
    (i) => {
      const w = weeks[i] ?? 0;
      const vals = active.map((p) => {
        const pw = weekOf(p, w);
        const bye = pw?.bye === true;
        const dist = pw === null || bye ? zeroDist("position_cv") : pw.dist;
        return { player: p, value: bye ? 0 : Math.max(0, dist.mean), dist, bye };
      });
      // the full-strength reference: absent players (bye or a known absence) at their typical value
      const ref = vals.map((x) => {
        const t = typical.get(x.player.player_id) ?? 0;
        const absent = x.bye || x.value < SCHEDULE.absentShare * t;
        return { ...x, value: absent ? t : x.value, absent };
      });
      const full = solveWeek(req.roster, ref, []);
      const fullStarters = full.seats
        .map((s) => (s.occupant.kind === "player" ? s.occupant.player.player_id : null))
        .filter((x): x is number => x !== null);
      const out = ref.filter((x) => x.absent && fullStarters.includes(x.player.player_id)).length;
      const stream = streamByWeek.get(w) ?? [];
      const have = solveWeek(req.roster, vals, stream);
      const roster = solveWeek(req.roster, vals, []);
      const seatValue = new Map<string, number[]>();
      for (const s of full.seats)
        if (s.occupant.kind === "player")
          seatValue.set(s.name, [...(seatValue.get(s.name) ?? []), s.occupant.value]);
      const holes = have.seats
        .filter((s) => s.occupant.kind !== "player")
        .map((s) => {
          const fullVals = seatValue.get(s.name) ?? [];
          const fullV =
            fullVals.length === 0 ? 0 : fullVals.reduce((a, b) => a + b, 0) / fullVals.length;
          const o = s.occupant;
          const pts = o.kind === "stream" ? Math.max(0, o.option.points) : 0;
          return {
            slot: s.name,
            replacement_player_id: o.kind === "stream" ? o.option.player_id : null,
            cost: round(Math.max(0, fullV - pts), 2),
          };
        });
      const drop = Math.max(0, full.mean - have.mean);
      const p = pAlive.get(w) ?? 1;
      rows.push({
        week: w,
        lineup_pts: weekDist(have),
        holes,
        bye_cluster_cost: out >= SCHEDULE.clusterMin ? round(drop, 2) : 0,
        weight: { p_alive: round(p, 4), importance: round(p, 4) },
        drop,
        gain: Math.max(0, have.mean - roster.mean),
        out,
        streamed: have.seats.flatMap((s) =>
          s.occupant.kind === "stream" ? [s.occupant.option] : [],
        ),
      });
    },
    { pacer: req.pacer ?? loopPacer(req.clock), deadlineMs: req.deadline_ms },
  );
  if (run.partial)
    warnings.push(
      `partial: ${String(run.completed)} of ${String(weeks.length)} weeks before the CPU deadline`,
    );

  // the cheapest bench drop over the horizon (a stream add's cost when the bench is full)
  const benchFull =
    active.filter((p) => slotClassOf(p.slot_id) === "bench").length >= req.roster.bench;
  let dropCost = 0;
  if (benchFull) {
    let best: number | null = null;
    for (const d of active.filter((p) => slotClassOf(p.slot_id) === "bench")) {
      let loss = 0;
      for (const row of rows) {
        const w = row.week;
        const vals = active.map((p) => {
          const pw = weekOf(p, w);
          return { p, v: pw === null || pw.bye ? 0 : Math.max(0, pw.dist.mean) };
        });
        loss +=
          row.weight.importance *
          (fast(vals) - fast(vals.filter((x) => x.p.player_id !== d.player_id)));
      }
      if (best === null || loss < best) best = loss;
    }
    dropCost = best ?? 0;
  }
  const worst = [...rows]
    .filter((r) => r.drop * r.weight.importance >= SCHEDULE.minDrop)
    .sort((a, b) => b.drop * b.weight.importance - a.drop * a.weight.importance || a.week - b.week)
    .slice(0, SCHEDULE.worstWeeks);
  const fixes: ScheduleAnalysisData["fixes"][number][] = [];
  const fixSubjects: RecSubject[] = [];
  for (const r of worst) {
    if (r.streamed.length === 0 || r.gain <= 0) continue;
    const positions = [...new Set(r.streamed.map((o) => o.position))].sort();
    const deadline = firstKickoff(req.schedule, r.week);
    fixes.push({
      action: `stream ${positions.join(" and ")} for week ${String(r.week)}`,
      cost: round(dropCost, 2),
      delta: round(r.gain * r.weight.importance, 2),
      deadline: deadline !== null && Date.parse(deadline) > nowMs ? deadline : null,
    });
    if (fixSubjects.length === 0)
      for (const o of r.streamed)
        if (o.player_id !== null)
          fixSubjects.push({ player_id: o.player_id, gsis_id: null, role: "stream", slot: null });
  }
  fixes.sort((a, b) => b.delta - b.cost - (a.delta - a.cost));

  // the playoff weeks
  const mine = new Set(req.players.map((p) => p.player_id));
  const multipliers = (req.matchup_multipliers ?? [])
    .filter(
      (m) => mine.has(m.player_id) && Number.isFinite(m.multiplier) && Number.isFinite(m.shrink_w),
    )
    .map((m) => ({
      player_id: m.player_id,
      multiplier: round(clamp(m.multiplier, SCHEDULE.multiplier.min, SCHEDULE.multiplier.max), 3),
      shrink_w: round(clamp(m.shrink_w, 0, 1), 3),
    }))
    .sort((a, b) => a.player_id - b.player_id);
  const lastPlayoff = req.playoff.weeks.length === 0 ? null : Math.max(...req.playoff.weeks);
  const restTeams = req.resting_risk_pro_team_ids;
  const restFlagged =
    restTeams === undefined || lastPlayoff === null || lastPlayoff < 17
      ? []
      : active
          .filter(
            (p) =>
              p.pro_team_id !== null &&
              restTeams.includes(p.pro_team_id) &&
              (weekOf(p, lastPlayoff)?.dist.mean ?? 0) > 0,
          )
          .map((p) => p.player_id)
          .sort((a, b) => a - b);

  const inputs = mergeInputs(collectInputs(req.stamps ?? [], req.clock), req.inputs ?? []);
  const top = fixes[0] ?? null;
  const rec: Rec = {
    action: top === null ? "no schedule move needed" : top.action,
    subjects: top === null ? [] : fixSubjects,
    lineup: null,
    point_estimate: top === null ? 0 : top.delta,
    distribution:
      top === null
        ? zeroDist("position_cv")
        : normalDist(top.delta, 0.5 * Math.abs(top.delta), "position_cv"),
    delta_vs_next: {
      value: top === null ? 0 : round(top.delta - top.cost, 2),
      p10: top === null ? 0 : round(0.36 * top.delta - top.cost, 2),
      p90: top === null ? 0 : round(1.64 * top.delta - top.cost, 2),
    },
    decision_metric: "expected_points",
    drivers: worst.map((r) => ({
      name: `week_${String(r.week)}_drop`,
      contribution: round(-r.drop, 2),
    })),
    assumptions: [
      ...assumptions,
      A(
        "a hole is filled from the best available player at the position (one stream copy per seat)",
        "the pool changes",
      ),
      A(
        `week cost = full-strength lineup − the week's lineup; a cluster = ≥ ${String(SCHEDULE.clusterMin)} full-strength starters out (research 05 §5)`,
        "the projections change",
      ),
    ],
    confidence: { role_games: 0, inputs },
    as_of: newestAsOf(inputs, req.clock.nowIso()),
    latest_execution_time: top?.deadline ?? null,
    no_move: top === null,
    log_id: null,
  };
  const data: ScheduleAnalysisData = {
    seeding: req.seeding,
    weeks: rows.map(({ week, lineup_pts, holes, bye_cluster_cost, weight }) => ({
      week,
      lineup_pts,
      holes,
      bye_cluster_cost,
      weight,
    })),
    worst_weeks: worst.map((r) => r.week),
    fixes,
    playoff_weeks: {
      weeks: [...req.playoff.weeks].sort((a, b) => a - b),
      bye_seeds: req.playoff.bye_seeds,
      matchup_multipliers: multipliers,
      evidence_note: SCHEDULE_EVIDENCE_NOTE,
      week17_rest_risk: {
        flagged_players: restFlagged,
        note:
          restTeams === undefined
            ? "unmodelled [F]: no NFL clinch or elimination data"
            : "flagged from the NFL clinch/elimination state; the resting itself is unquantified [F]",
      },
    },
    rec,
    inputs,
  };
  return { data, partial: run.partial, warnings };
}
