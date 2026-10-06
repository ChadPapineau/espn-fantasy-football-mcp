// cascade.ts — E7 `espn_analyze_injury_cascade` (plan 07 E7; plan 10 B6 hard parts; research 05 §5
// Injury cascade, §4.3; sib research 05 §6.1–§6.4): the injured player's vacated per-game opportunity
// (targets, carries, red-zone opportunities = his share × the team's volume, the volume cut because
// the offence gets worse without its starter) is redistributed by ROLE AFFINITY × each teammate's
// own share of that component — never 1:1 to the next man up — and only a retained fraction of it
// (part of the volume leaves), so the beneficiaries' shares can never sum above the vacated share;
// the team's own evidence (≥ 2 games without the starter) is blended in and capped the same way;
// timing from the status prior or the given timeline with a revision tail (sib §6.3); per
// beneficiary P(role holds) with a committee discount; the evidence grade (team games, usage
// confirmation, market move) and `hypothesis_only` when none exists (sib §6.4); reception points
// elevate the pass-down back (research 05 §5); the IR consequence on MY roster from the STRUCTURED
// status only — eligible only for OUT / INJURY_RESERVE (research 05 §4.3; plan 10 B6); a claim /
// pass per beneficiary from E5 through an injected evaluator (plan 07 E7 "from E5"). ESPN's outlook
// text is not an input (it is a claim for E10). Pure. New here.
import type { Clock } from "../clock.js";
import { auditIr, type RosterSeat } from "../league/roster.js";
import { slotClassOf, slotNameOf } from "../league/slots.js";
import { isIrEligible } from "../league/types.js";
import type {
  BareText,
  InjuryStatus,
  IsoInstant,
  PoolStatus,
  RosterSlots,
  Week,
} from "../league/types.js";
import { P_ACTIVE_BY_STATUS } from "./constants.js";
import { ensure } from "./errors.js";
import { newestAsOf } from "./inputs.js";
import { AFFINITY, CASCADE } from "./marketConstants.js";
import { clamp, normalDist, round, zeroDist } from "./math.js";
import type {
  Assumption,
  InjuryCascadeData,
  InputFreshness,
  Rec,
  RecSubject,
  WaiverVerdict,
} from "./types.js";

/** One opportunity vector: per-game shares of the team's targets, carries and red-zone chances. */
export interface Shares {
  readonly target_share: number | null;
  readonly carry_share: number | null;
  readonly rz_share: number | null;
}

/** A teammate as the cascade sees him. */
export interface CascadeTeammate {
  readonly player_id: number | null;
  readonly gsis_id: string | null;
  readonly name: BareText;
  readonly position: string;
  readonly injury_status: InjuryStatus | null;
  /** Trailing shares with the starter playing. */
  readonly usage: Shares & { readonly snap_pct: number | null };
  /** His latest game (usage confirmation: the role already shows). */
  readonly recent?: (Shares & { readonly snap_pct: number | null }) | null;
  /** His shares in the team's games WITHOUT the starter (this and last season). */
  readonly without_starter?: Shares | null;
  /** ESPN `ownership.percentChange` — the crowd's reaction (a market move, never detection). */
  readonly percent_change: number | null;
  readonly availability: {
    readonly status: PoolStatus | null;
    readonly waiver_process_date: IsoInstant | null;
  };
  /** Points per opportunity under the league's S (from his trailing lines); null → the priors. */
  readonly efficiency?: {
    readonly points_per_target: number | null;
    readonly points_per_carry: number | null;
  } | null;
  /** His own projection per horizon week (a backup QB's baseline). */
  readonly weekly?: readonly (number | null)[];
}

/** The injured player. */
export interface CascadeInjured {
  readonly player_id: number | null;
  readonly gsis_id: string | null;
  readonly name: BareText;
  readonly nfl_team: string | null;
  readonly position: string;
  readonly injury_status: InjuryStatus | null;
  readonly usage: Shares;
  /** His projection per horizon week (a QB's role is valued from it). */
  readonly weekly?: readonly (number | null)[];
  /** On my roster: his slot and ESPN eligible slots (the IR consequence). */
  readonly mine?: {
    readonly slot_id: number;
    readonly eligible_slot_ids: readonly number[];
  } | null;
}

/** One beneficiary handed to E5 for a claim / pass (the tool wires it to `analyzeWaiversP1`). */
export interface CascadeClaimInput {
  readonly player_id: number;
  readonly status: PoolStatus;
  readonly delta_proj_by_week: readonly { readonly week: Week; readonly delta: number }[];
}

/** An E7 request. */
export interface CascadeRequest {
  readonly injured: CascadeInjured;
  readonly teammates: readonly CascadeTeammate[];
  /** The team's per-game volume (targets, carries, red-zone opportunities), trailing. */
  readonly team_volume: {
    readonly targets: number;
    readonly carries: number;
    readonly rz: number;
  };
  /** Games of team evidence without the starter (this and last season). */
  readonly team_games_without: number;
  /** The horizon weeks, ascending, the current week first. */
  readonly weeks: readonly Week[];
  /** A timeline to assume (weeks out) — overrides the status prior (basis `report`). */
  readonly assume_weeks_out?: number | null;
  /** Points per reception under S (ESPN stat 53) — elevates the pass-down back when > 0. */
  readonly reception_points: number;
  /** The team's implied total before the news and now (nflverse lines); null → no line move. */
  readonly implied_total?: { readonly before: number | null; readonly now: number | null } | null;
  /** My roster (the IR consequence); null when the injured player is not mine. */
  readonly my_roster?: {
    readonly roster: RosterSlots;
    readonly seats: readonly RosterSeat[];
  } | null;
  /** E5 for the available beneficiaries; absent → every verdict is null. */
  readonly evaluate_claims?: (
    beneficiaries: readonly CascadeClaimInput[],
  ) => Promise<ReadonlyMap<number, WaiverVerdict>>;
  readonly clock: Clock;
  readonly inputs?: readonly InputFreshness[];
}

/** E7's outcome. */
export interface CascadeOutcome {
  readonly data: InjuryCascadeData;
  readonly warnings: readonly string[];
}

type Component = "targets" | "carries" | "rz";
const COMPONENTS: readonly Component[] = Object.freeze(["targets", "carries", "rz"]);
const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });
/** A volume or projection as the cascade reads it: finite and ≥ 0 (NaN / ±∞ / null → 0). */
const nonNeg = (x: number | null | undefined): number =>
  typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
const share = (s: Shares, c: Component): number => {
  const v = c === "targets" ? s.target_share : c === "carries" ? s.carry_share : s.rz_share;
  return v !== null && Number.isFinite(v) ? clamp(v, 0, 1) : 0;
};

/** Expected weeks out (p25, p50, p75) and its basis. */
export function expectedWeeks(
  status: InjuryStatus | null,
  assume: number | null | undefined,
): InjuryCascadeData["expected_weeks"] {
  if (assume !== null && assume !== undefined && Number.isInteger(assume) && assume >= 0)
    return { p25: assume, p50: assume, p75: assume, basis: "report" };
  const prior =
    status !== null && Object.hasOwn(CASCADE.weeksPrior, status)
      ? (CASCADE.weeksPrior[status] ?? CASCADE.defaultWeeksPrior)
      : CASCADE.defaultWeeksPrior;
  return { p25: prior[0], p50: prior[1], p75: prior[2], basis: "prior" };
}

/** P(the starter is still out) `i` weeks ahead (0 = this week), with a one-week revision tail. */
export function stillOut(w: InjuryCascadeData["expected_weeks"], i: number): number {
  if (i < w.p25) return 1;
  if (i < w.p50) return 0.75;
  if (i < w.p75) return 0.5;
  if (i < w.p75 + 1) return CASCADE.tailAfterP75;
  return 0;
}

/** Points per opportunity priors under the league's reception points (TDs carried by red zone). */
function priorEfficiency(position: string, receptionPoints: number): { ppt: number; ppc: number } {
  const e = CASCADE.efficiency;
  const catchRate = e.catchRate[position] ?? 0.6;
  const ypr = e.yardsPerReception[position] ?? 10;
  const ypc = e.yardsPerCarry[position] ?? 4;
  return {
    ppt: catchRate * (Math.max(0, receptionPoints) + ypr * e.recYardPoints),
    ppc: ypc * e.rushYardPoints,
  };
}

interface Alloc {
  readonly mate: CascadeTeammate;
  readonly delta: Record<Component, number>;
}

/**
 * The redistribution (shares of team volume): per component, a retained fraction of the vacated
 * share split by affinity × own share (+ floor) × P(active); blended with the team's own evidence
 * when it exists and capped so the sum never exceeds the vacated share (plan 10 B6).
 */
export function redistribute(
  injured: Pick<CascadeInjured, "position" | "usage">,
  mates: readonly CascadeTeammate[],
  teamGames: number,
  receptionPoints: number,
): { readonly vacated: Record<Component, number>; readonly allocs: Alloc[] } {
  const table = AFFINITY[injured.position] ?? AFFINITY.WR;
  const vacated = {
    targets: share(injured.usage, "targets"),
    carries: share(injured.usage, "carries"),
    rz: share(injured.usage, "rz"),
  };
  const evidence = teamGames >= CASCADE.teamEvidenceMinGames;
  const wTeam = evidence ? teamGames / (teamGames + CASCADE.teamEvidenceShrink) : 0;
  const allocs: Alloc[] = mates.map((m) => ({ mate: m, delta: { targets: 0, carries: 0, rz: 0 } }));
  for (const c of COMPONENTS) {
    const v = vacated[c];
    if (!(v > 0)) continue;
    const aff = table?.[c] ?? {};
    const raw = mates.map((m) => {
      let a = aff[m.position] ?? 0;
      // reception points elevate the pass-down back: his target affinity rises with the PPR value
      if (c === "targets" && m.position === "RB" && injured.position === "RB")
        a *= 1 + Math.max(0, receptionPoints);
      const pa =
        m.injury_status !== null && Object.hasOwn(P_ACTIVE_BY_STATUS, m.injury_status)
          ? (P_ACTIVE_BY_STATUS[m.injury_status] ?? 1)
          : 1;
      return a * (share(m.usage, c) + CASCADE.shareFloor) * pa;
    });
    const total = raw.reduce((s, x) => s + x, 0);
    const retained = CASCADE.retention[c] * v;
    const prior = raw.map((x) => (total > 0 ? (retained * x) / total : 0));
    const observed = mates.map((m) => {
      const ws = m.without_starter ?? null;
      return ws === null ? null : Math.max(0, share(ws, c) - share(m.usage, c));
    });
    let blended = prior.map((p, i) => {
      const o = observed[i];
      return evidence && o !== null && o !== undefined ? wTeam * o + (1 - wTeam) * p : p;
    });
    const sum = blended.reduce((s, x) => s + x, 0);
    if (sum > v) blended = blended.map((x) => (x * v) / sum);
    blended.forEach((x, i) => {
      const a = allocs[i];
      if (a !== undefined) a.delta[c] = x;
    });
  }
  return { vacated, allocs };
}

/** E7. Throws AnalyticsError `invalid_request` on malformed bounds. */
export async function analyzeInjuryCascade(req: CascadeRequest): Promise<CascadeOutcome> {
  ensure(req.weeks.length >= 1 && req.weeks.length <= 22, "horizon weeks out of range", "weeks");
  ensure(req.teammates.length <= 40, "too many teammates", "player");
  ensure(
    Number.isFinite(req.team_games_without) && req.team_games_without >= 0,
    "team games out of range",
    "player",
  );
  const warnings: string[] = [];
  const assumptions: Assumption[] = [];
  const inj = req.injured;
  const weeksOut = expectedWeeks(inj.injury_status, req.assume_weeks_out);
  if (weeksOut.basis === "prior")
    assumptions.push(
      A(
        "the absence length is a prior by ESPN status (timelines in first reports get revised)",
        "a timeline is reported or assumed",
      ),
    );
  // the offence loses volume without its starter (sib §6.2): the line move, else a prior factor
  const before = req.implied_total?.before ?? null;
  const nowTotal = req.implied_total?.now ?? null;
  const lineMove =
    before !== null && nowTotal !== null && before > 0 && Number.isFinite(nowTotal)
      ? nowTotal - before
      : null;
  const factor =
    lineMove !== null && before !== null
      ? clamp((before + lineMove) / before, CASCADE.volumeFactorMin, 1)
      : CASCADE.volumeFactorNoLine;
  if (lineMove === null)
    assumptions.push(
      A(
        `no line move is known: the team's volume is cut by ${String(round((1 - CASCADE.volumeFactorNoLine) * 100, 1))} % without the starter`,
        "the betting line moves",
      ),
    );
  const vol = {
    targets: nonNeg(req.team_volume.targets) * factor,
    carries: nonNeg(req.team_volume.carries) * factor,
    rz: nonNeg(req.team_volume.rz) * factor,
  };
  const mates = req.teammates.filter((m) => m.player_id === null || m.player_id !== inj.player_id);
  const { vacated, allocs } = redistribute(
    inj,
    mates,
    req.team_games_without,
    req.reception_points,
  );
  const evidenceTeam = req.team_games_without >= CASCADE.teamEvidenceMinGames;
  if (!evidenceTeam)
    assumptions.push(
      A(
        "no team evidence without the starter: the split is the role-affinity prior, not this team's history",
        "two games without the starter",
      ),
    );

  // per beneficiary: opportunity per game, projection delta by week, P(role holds), evidence
  const qbCase = inj.position === "QB";
  const samePosTotal = new Map<string, number>();
  for (const a of allocs) {
    const t = a.delta.targets + a.delta.carries + a.delta.rz;
    samePosTotal.set(a.mate.position, (samePosTotal.get(a.mate.position) ?? 0) + t);
  }
  const rows = allocs.map((a) => {
    const m = a.mate;
    const opp = {
      targets: a.delta.targets * vol.targets,
      carries: a.delta.carries * vol.carries,
      rz: a.delta.rz * vol.rz,
    };
    const eff = priorEfficiency(m.position, req.reception_points);
    const ppt = m.efficiency?.points_per_target ?? eff.ppt;
    const ppc = m.efficiency?.points_per_carry ?? eff.ppc;
    const pprz = CASCADE.efficiency.tdPerRzOpportunity * CASCADE.efficiency.tdPoints;
    const perGame = opp.targets * ppt + opp.carries * ppc + opp.rz * pprz;
    const byWeek = req.weeks.map((w, i) => {
      const out = stillOut(weeksOut, i);
      let delta = out * perGame;
      if (qbCase && m.position === "QB") {
        const starter = nonNeg(inj.weekly?.[i]);
        const mine = nonNeg(m.weekly?.[i]);
        delta = out * Math.max(0, starter * CASCADE.qbBackupFactor - mine);
      }
      return { week: w, delta: round(delta, 3) };
    });
    const total = a.delta.targets + a.delta.carries + a.delta.rz;
    const group = samePosTotal.get(m.position) ?? 0;
    const dominance = group > 0 ? total / group : qbCase && m.position === "QB" ? 1 : 0;
    const pRole = round(stillOut(weeksOut, 0) * (1 - CASCADE.committeeRisk * (1 - dominance)), 3);
    const rec = m.recent ?? null;
    const usageConfirmed =
      rec !== null &&
      ((rec.snap_pct !== null &&
        m.usage.snap_pct !== null &&
        rec.snap_pct - m.usage.snap_pct >= CASCADE.usageConfirmSnap) ||
        COMPONENTS.some((c) => share(rec, c) - share(m.usage, c) >= CASCADE.usageConfirmShare));
    const market =
      m.percent_change !== null && Number.isFinite(m.percent_change) ? m.percent_change : null;
    return { m, opp, byWeek, pRole, usageConfirmed, market };
  });
  const listed = rows
    .filter((r) => r.byWeek.some((x) => x.delta >= CASCADE.minWeeklyGain))
    .sort(
      (a, b) =>
        b.byWeek.reduce((s, x) => s + x.delta, 0) - a.byWeek.reduce((s, x) => s + x.delta, 0) ||
        (a.m.player_id ?? 0) - (b.m.player_id ?? 0),
    )
    .slice(0, CASCADE.maxBeneficiaries);

  // E5 verdicts for the available beneficiaries
  let verdicts: ReadonlyMap<number, WaiverVerdict> = new Map();
  const claimable: CascadeClaimInput[] = listed
    .filter(
      (r) =>
        r.m.player_id !== null &&
        (r.m.availability.status === "FREEAGENT" || r.m.availability.status === "WAIVERS"),
    )
    .map((r) => ({
      player_id: r.m.player_id ?? 0,
      status: r.m.availability.status ?? "WAIVERS",
      delta_proj_by_week: r.byWeek,
    }));
  if (req.evaluate_claims !== undefined && claimable.length > 0)
    verdicts = await req.evaluate_claims(claimable);
  else if (claimable.length > 0)
    assumptions.push(
      A("no claim verdicts: E5 was not run on the beneficiaries", "the waiver engine runs"),
    );

  const beneficiaries: InjuryCascadeData["beneficiaries"] = listed.map((r) => ({
    player_id: r.m.player_id,
    gsis_id: r.m.gsis_id,
    name: r.m.name,
    delta_opportunity: {
      targets: round(r.opp.targets, 3),
      carries: round(r.opp.carries, 3),
      rz: round(r.opp.rz, 3),
    },
    delta_proj_by_week: r.byWeek,
    p_role_holds: r.pRole,
    evidence: {
      team_games: req.team_games_without,
      usage_confirmed: r.usageConfirmed,
      market_move: r.market,
    },
    availability: {
      status: r.m.availability.status,
      waiver_process_date: r.m.availability.waiver_process_date,
    },
    verdict:
      r.m.player_id !== null &&
      (r.m.availability.status === "FREEAGENT" || r.m.availability.status === "WAIVERS")
        ? (verdicts.get(r.m.player_id) ?? null)
        : null,
  }));

  // hypothesis_only (sib §6.4): no team evidence, no usage confirmation, no (material) market move
  const hypothesis =
    req.team_games_without === 0 &&
    beneficiaries.every(
      (b) =>
        !b.evidence.usage_confirmed &&
        (b.evidence.market_move === null ||
          Math.abs(b.evidence.market_move) < CASCADE.marketMoveMin),
    );
  if (hypothesis)
    assumptions.push(
      A(
        "a hypothesis only: no team evidence, no usage confirmation and no market move",
        "a game without the starter, or a beneficiary's usage jump",
      ),
    );

  // the IR consequence on MY roster: the STRUCTURED status only (research 05 §4.3; plan 10 B6)
  let ir: InjuryCascadeData["ir_consequence"] = null;
  const mine = inj.mine ?? null;
  const roster = req.my_roster ?? null;
  if (mine !== null) {
    const eligible = isIrEligible(inj.injury_status);
    const inIr = slotClassOf(mine.slot_id) === "ir";
    const open = roster === null ? 0 : auditIr(roster.seats, roster.roster).open_slots;
    const movable = eligible && !inIr && open > 0 && mine.eligible_slot_ids.includes(21);
    ir = {
      on_my_roster: true,
      ir_eligible: eligible,
      move: movable ? { from_slot: slotNameOf(mine.slot_id), to: "IR" } : null,
      frees_bench_slot: movable,
    };
    if (eligible && !inIr && open === 0)
      assumptions.push(A("IR-eligible, but no IR seat is open", "an IR seat opens"));
  }

  // half-PPR elevates the pass-down back (research 05 §5)
  let note: string | null = null;
  if (inj.position === "RB" && req.reception_points > 0) {
    const rbs = listed.filter((r) => r.m.position === "RB");
    const byTargets = [...rbs].sort((a, b) => b.opp.targets - a.opp.targets)[0];
    const byCarries = [...rbs].sort((a, b) => b.opp.carries - a.opp.carries)[0];
    note =
      byTargets !== undefined && byCarries !== undefined && byTargets !== byCarries
        ? `${String(req.reception_points)} points per reception elevate the pass-down back: player ${String(byTargets.m.player_id)} inherits most targets, player ${String(byCarries.m.player_id)} most carries`
        : `${String(req.reception_points)} points per reception elevate the pass-down back among the beneficiaries`;
  }

  // the recommendation (structured fields only)
  const top = beneficiaries[0] ?? null;
  const subjects: RecSubject[] = [];
  for (const b of beneficiaries)
    if (b.verdict === "claim" || b.verdict === "fa_add_now")
      subjects.push({
        player_id: b.player_id,
        gsis_id: b.gsis_id,
        role: b.verdict === "claim" ? "claim" : "add",
        slot: null,
      });
  if (ir?.move !== null && ir?.move !== undefined)
    subjects.push({ player_id: inj.player_id, gsis_id: inj.gsis_id, role: "ir_move", slot: "IR" });
  const topTotal = top === null ? 0 : top.delta_proj_by_week.reduce((s, x) => s + x.delta, 0);
  const claimTop = beneficiaries.find((b) => b.verdict === "claim" || b.verdict === "fa_add_now");
  const parts: string[] = [];
  if (ir?.move !== null && ir?.move !== undefined) parts.push("move the injured player to IR");
  if (claimTop !== undefined)
    parts.push(
      `${claimTop.verdict === "claim" ? "claim" : "add"} player ${String(claimTop.player_id)}`,
    );
  const noMove = parts.length === 0;
  const action = noMove
    ? hypothesis
      ? "no move: the cascade is a hypothesis only"
      : top === null
        ? "no beneficiary gains enough to list"
        : "no move: no beneficiary clears the waiver rule"
    : parts.join("; ");
  const inputs = [...(req.inputs ?? [])];
  const gain =
    topTotal > 0
      ? normalDist(topTotal, topTotal * CASCADE.gainCv, "position_cv")
      : zeroDist("position_cv");
  const recOut: Rec = {
    action,
    subjects,
    lineup: null,
    point_estimate: round(topTotal, 3),
    distribution: gain,
    delta_vs_next: { value: round(topTotal, 3), p10: gain.p10, p90: gain.p90 },
    decision_metric: "weeks_of_value",
    drivers: beneficiaries.slice(0, 3).map((b) => ({
      name: `beneficiary:${String(b.player_id)}`,
      contribution: round(
        b.delta_proj_by_week.reduce((s, x) => s + x.delta, 0),
        3,
      ),
    })),
    assumptions,
    confidence: { role_games: req.team_games_without, inputs },
    as_of: newestAsOf(inputs, req.clock.nowIso()),
    latest_execution_time: claimTop?.availability.waiver_process_date ?? null,
    no_move: noMove,
    log_id: null,
  };
  return {
    data: {
      injured: {
        player_id: inj.player_id,
        gsis_id: inj.gsis_id,
        name: inj.name,
        nfl_team: inj.nfl_team,
        position: inj.position,
        injury_status: inj.injury_status,
      },
      expected_weeks: weeksOut,
      beneficiaries,
      team_volume_change: { implied_total_delta: lineMove === null ? null : round(lineMove, 2) },
      vacated: {
        targets: round(vacated.targets * vol.targets, 3),
        carries: round(vacated.carries * vol.carries, 3),
        rz: round(vacated.rz * vol.rz, 3),
      },
      returning_ramp: { weeks: CASCADE.ramp.weeks, factor: CASCADE.ramp.factor },
      ir_consequence: ir,
      pass_down_back_note: note,
      hypothesis_only: hypothesis,
      rec: recOut,
      inputs,
    },
    warnings,
  };
}
