// lineup.ts — E2 `espn_analyze_lineup` (plan 07 E2; research 05 §2.2, §3.3, §5 Start/sit; plan 10
// A11a): the exact assignment over the league's slots (per-player `eligibleSlots`, flexes, IR kept,
// locked players never moved); the objective resolved from the seeding reading (`auto`: reading (b)
// → points_only, else `mean` while the basis is position_cv — a coarse ΔP(win) — with PF awareness
// through the PF-per-win exchange rate from the seeding simulator or the cold-start 120); modes
// protect | chase | neutral | maximise_pf (the variance sign from μ_m − μ_o under (a), plus
// maximise_pf when the PF tiebreak is in play and P(win) is saturated; under (b) a position
// relative to the season PF cutoff); Thursday / Monday / late-game option values; ESPN's
// projection as the labelled cross-check. Pure. Phase 3 (plan 10 C2, additive): `auto` on an
// all-player_sim lineup under reading (a) reads the committed switch record (calibration/
// objectiveSwitch.ts) — `pwin` only when the held-out replay showed it beats `mean` on regret.
// Stage C (changelog R7-1): what the user is told and what is logged follow plan 09 §2 guardrail 9
// change by change — a change inside the coin-flip band is held, a call whose every change is held
// is `no_move` and logged as "keep" — while the mean-optimal assignment (`recommended_lineup`,
// `rec.lineup`) is unchanged; a seat that scores a known 0 is priced exactly (sib QA-2-038's rule).
// Stage C round 3: in a playoff week (no regular-season week left) the seeding is settled, so the
// objective, mode and coin flips follow the week's matchup under either reading.
// Ported from sibling @f6ba81e (src/domain/analytics/lineup.ts), adapted: ESPN slot ids and
// eligibleSlots, the reading-driven objective and modes, the PF exchange rate, numeric player ids.
import type { Clock } from "../clock.js";
import type { SeedingMode } from "../../config/schema.js";
import type { PlayerLock } from "../league/schedule.js";
import { easternDayHour } from "../league/schedule.js";
import {
  canOccupySlot,
  slotClassOf,
  slotNameOf,
  sortSlotIds,
  startingSeats,
} from "../league/slots.js";
import type {
  BareText,
  InjuryStatus,
  IsoInstant,
  LockScheduleEntry,
  RosterEntry,
  RosterSlots,
} from "../league/types.js";
import { at } from "../scoring/numeric.js";
import type { Dist, DistBasis } from "../scoring/types.js";
import { FORBIDDEN, solveAssignment } from "./assignment.js";
import {
  OBJECTIVE_SWITCH_RECORD,
  autoObjectiveForPlayerSim,
  type ObjectiveSwitchRecord,
} from "./calibration/objectiveSwitch.js";
import { LINEUP, Z90 } from "./constants.js";
import { ensure, ensurePlayers } from "./errors.js";
import { newestAsOf } from "./inputs.js";
import { normalDist, round, sigmaOf } from "./math.js";
import type { ProjectedWeek } from "./projection.js";
import {
  diffSd,
  lineupCov,
  lineupMoments,
  pairMoments,
  pWinInterval,
  pWinNormal,
  rho,
  type PairMoments,
  type TotalMember,
} from "./totals.js";
import {
  COIN_FLIP_DPWIN,
  DISAGREEMENT_FLAG_PCT,
  PF_PER_WIN_COLD_START,
  isCoinFlip,
  seedingStatus,
  toCoarseDelta,
  type Assumption,
  type CoarseDelta,
  type DeltaVsNext,
  type InputFreshness,
  type LineupData,
  type LineupSlotAssignment,
  type MatchupMode,
  type ModeBasis,
  type Objective,
  type ObjectiveArg,
  type OptionValue,
  type Rec,
  type RecSubject,
  type SeedingModeArg,
  type SwapOf,
} from "./types.js";

/** One rostered player as the lineup engine sees him (built by the tool from B1 + E1 — `lineupPlayerOf`). */
export interface LineupPlayer {
  readonly player_id: number;
  readonly gsis_id: string | null;
  readonly name: BareText;
  /** ESPN display position (QB, RB, WR, TE, K, D/ST …). */
  readonly position: string;
  /** ESPN `eligibleSlots` — authoritative per player. */
  readonly eligible_slot_ids: readonly number[];
  readonly injury_status: InjuryStatus | null;
  readonly pro_team_id: number | null;
  /** The player's current lineup slot id. */
  readonly slot_id: number;
  /** ESPN's `lineupLocked`, or the lock instant has passed — the player cannot move. */
  readonly locked: boolean;
  readonly lock_at: IsoInstant | null;
  readonly points: Dist;
  readonly p_active: number | null;
  /** ESPN's own weekly projection (labelled; the cross-check). */
  readonly espn_projection: number | null;
  readonly percent_started: number | null;
  readonly role_games: number;
}

/** A LineupPlayer from a roster entry, its E1 week and its lock (plan 07 B1 + E1). */
export function lineupPlayerOf(
  e: RosterEntry,
  week: Pick<ProjectedWeek, "dist" | "p_active"> & { readonly role_games?: number },
  lock: Pick<PlayerLock, "lock_at" | "locked"> | null,
  gsisId: string | null = null,
): LineupPlayer {
  return {
    player_id: e.player.ref.id,
    gsis_id: gsisId,
    name: e.player.name,
    position: e.player.position,
    eligible_slot_ids: e.player.eligible_slot_ids,
    injury_status: e.player.injury_status,
    pro_team_id: e.player.pro_team_id,
    slot_id: e.slot_id,
    locked: e.lineup_locked || lock?.locked === true,
    lock_at: lock?.lock_at ?? null,
    points: week.dist,
    p_active: week.p_active,
    espn_projection: e.player.projection_week_espn,
    percent_started: e.player.ownership?.percent_started ?? null,
    role_games: week.role_games ?? 0,
  };
}

/** The season context behind PF awareness (from the seeding simulator and the standings). */
export interface LineupSeasonContext {
  /** One win in PF points (the seeding simulator under reading (a)); null → cold start. */
  readonly pf_per_win: number | null;
  readonly pf_context: {
    readonly season_pf_rank: number;
    readonly pf_gap_to_cutoff: number;
    readonly tiebreak_in_play: boolean;
  } | null;
  /**
   * Regular-season weeks left, this one included (scales the PF cutoff band under reading (b)). 0: a
   * week past the regular season — a playoff week, where the seeding is settled, so E2's objective,
   * mode and coin flips follow the week's matchup under either reading (PLAYOFF_WEEK_ASSUMPTION).
   */
  readonly remaining_weeks: number;
}

/**
 * A week past the regular season (`season.remaining_weeks` 0): the seeds are fixed and only the
 * head-to-head result advances, so neither reading's points-for objective, cutoff or tiebreak
 * applies (research 05 §2.2's objective is the regular season's; Stage C finding
 * lineup-playoff-week-seeding-objective).
 */
export const PLAYOFF_WEEK_ASSUMPTION = Object.freeze({
  text: "a playoff week: the regular season is over and the seeding settled, so only this matchup's result counts — no points-for objective, cutoff or tiebreak",
  revisit_trigger: "the league's schedule settings change",
});

/** An E2 request. */
export interface LineupRequest {
  readonly roster: RosterSlots;
  readonly players: readonly LineupPlayer[];
  /** The opponent's roster this week, or null (bye week, or not readable). */
  readonly opponent: readonly LineupPlayer[] | null;
  readonly objective?: ObjectiveArg;
  readonly blend_weight?: number;
  /** PF points per win used by `blend`; null/omitted → the exchange rate in use. */
  readonly pf_weight?: number | null;
  readonly seeding_mode?: SeedingModeArg;
  readonly seeding_config: { readonly mode: SeedingMode; readonly confirmed_at: string | null };
  readonly season?: LineupSeasonContext | null;
  readonly only_unlocked?: boolean;
  readonly exclude?: readonly number[];
  readonly force_start?: readonly number[];
  readonly compare?: readonly { readonly out: number; readonly in: number }[];
  readonly clock: Clock;
  readonly inputs?: readonly InputFreshness[];
  /**
   * The auto-default switch record (plan 10 C2; calibration/objectiveSwitch.ts): under reading (a)
   * an all-player_sim lineup resolves `auto` to `pwin` only when the record switches. Omitted → the
   * committed record (additive, Phase 3).
   */
  readonly objective_switch?: ObjectiveSwitchRecord;
  /**
   * A later week of a multi-week matchup period: the points each side already holds from the
   * period's earlier weeks (ESPN `points_by_week`). Carried into the margin wherever this week's
   * matchup decides — P(win) before and after and its interval, the `pwin`/`blend` objective, the
   * protect/chase mode and the coin-flip band's ΔP(win) — so each is the period's, never a 0–0 start
   * (research 05 §2.3; Stage C finding matchup-multiweek-prior-points-ignored). Expected points stay
   * this week's. Null / absent: the week is the whole period; ignored without an opponent.
   */
  readonly banked?: { readonly me: number; readonly opponent: number } | null;
}

// --- the solve ---------------------------------------------------------------------------------------

/** player id → slot name (a starting seat's name, `BE`, or `IR`). */
type Assignment = ReadonlyMap<number, string>;

interface Seat {
  readonly slot_id: number;
  readonly name: string;
}

const BENCH = slotNameOf(20);

function seatsOf(roster: RosterSlots): Seat[] {
  return startingSeats(roster).map((s) => ({ slot_id: s.slot_id, name: s.name }));
}

const isStartName = (roster: RosterSlots, name: string): boolean =>
  roster.slots.some((s) => s.name === name && (s.class === "starter" || s.class === "flex"));

interface SolveInput {
  readonly roster: RosterSlots;
  readonly players: readonly LineupPlayer[];
  readonly value: (p: LineupPlayer) => number;
  readonly exclude: ReadonlySet<number>;
  readonly force: ReadonlySet<number>;
}

/**
 * The exact best lineup: maximise (filled starting seats, then Σ value) subject to eligibility
 * (ESPN `eligibleSlots`), locks (a locked starter keeps his seat, a locked reserve stays out), IR
 * kept, `exclude` and `force_start`.
 */
function solve(input: SolveInput): Assignment {
  const { roster } = input;
  const seats = seatsOf(roster);
  const out = new Map<number, string>();
  const rows: LineupPlayer[] = [];
  for (const p of input.players) {
    if (slotClassOf(p.slot_id) === "ir") out.set(p.player_id, slotNameOf(p.slot_id));
    else rows.push(p);
  }
  const reserved = new Map<number, number>();
  const taken = new Set<number>();
  for (const p of rows) {
    if (!p.locked) continue;
    const idx = seats.findIndex((s, i) => s.slot_id === p.slot_id && !taken.has(i));
    if (idx >= 0) {
      reserved.set(p.player_id, idx);
      taken.add(idx);
    }
  }
  const m = seats.length + rows.length;
  const cost = rows.map((p) => {
    const res = reserved.get(p.player_id);
    const row = new Array<number>(m).fill(0);
    const v = input.value(p);
    seats.forEach((s, j) => {
      let c = FORBIDDEN;
      if (res !== undefined) {
        if (j === res) c = -(LINEUP.forceBonus * 10 + v);
      } else if (!p.locked && !input.exclude.has(p.player_id) && !taken.has(j)) {
        if (canOccupySlot(s.slot_id, p)) {
          c = -(
            LINEUP.fillBonus +
            v +
            (input.force.has(p.player_id) ? LINEUP.forceBonus : 0) +
            (p.slot_id === s.slot_id ? LINEUP.stayBonus : 0)
          );
        }
      }
      row[j] = c;
    });
    for (let j = seats.length; j < m; j++) row[j] = res !== undefined ? FORBIDDEN : 0;
    return row;
  });
  const ans = solveAssignment(cost);
  rows.forEach((p, i) => {
    const j = at(ans, i);
    const starts = j < seats.length && at(at(cost, i), j) < FORBIDDEN / 2;
    out.set(p.player_id, starts ? at(seats, j).name : BENCH);
  });
  return out;
}

const slotIn = (a: Assignment, id: number): string => a.get(id) ?? BENCH;

function startersOf(
  a: Assignment,
  players: readonly LineupPlayer[],
  roster: RosterSlots,
): LineupPlayer[] {
  return players.filter((p) => isStartName(roster, slotIn(a, p.player_id)));
}

/** The best-by-mean legal lineup's starters (locks respected) — the opponent's assumed lineup. */
export function bestLineup(roster: RosterSlots, players: readonly LineupPlayer[]): LineupPlayer[] {
  const a = solve({
    roster,
    players,
    value: (p) => p.points.mean,
    exclude: new Set(),
    force: new Set(),
  });
  return startersOf(a, players, roster);
}

/** The best-by-mean lineup's expected points (locks respected). */
export function bestLineupMean(roster: RosterSlots, players: readonly LineupPlayer[]): number {
  return bestLineup(roster, players).reduce((s, p) => s + p.points.mean, 0);
}

/** The league's starting seats as slot ids (one entry per seat) — the fast kernel's plan. */
export function seatPlan(roster: RosterSlots): number[] {
  return startingSeats(roster).map((s) => s.slot_id);
}

/** A player as the fast kernel sees him: the slot ids he may fill and his value (≥ 0). */
export interface FastPlayer {
  readonly eligible: ReadonlySet<number>;
  readonly value: number;
}

/**
 * The best lineup's total value without locks (the opportunity-cost kernel of E5, called tens of
 * thousands of times): seats are the rows of an assignment whose columns are the players plus one
 * "empty" column per seat, so an ineligible or worthless seat stays empty at no cost.
 */
export function fastLineupValue(seats: readonly number[], players: readonly FastPlayer[]): number {
  const n = seats.length;
  if (n === 0 || players.length === 0) return 0;
  const m = players.length + n;
  const cost: number[][] = seats.map((slot) => {
    const row = new Array<number>(m).fill(0);
    players.forEach((p, j) => {
      row[j] = p.eligible.has(slot) ? -Math.max(0, p.value) : FORBIDDEN;
    });
    return row;
  });
  const ans = solveAssignment(cost);
  let total = 0;
  ans.forEach((j, i) => {
    const p = players[j];
    if (p?.eligible.has(seats[i] ?? -1) === true) total += Math.max(0, p.value);
  });
  return total;
}

// --- helpers -------------------------------------------------------------------------------------------

const member = (p: LineupPlayer): TotalMember => ({
  player_id: p.player_id,
  position: p.position,
  pro_team_id: p.pro_team_id,
  points: p.points,
});

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

const lockMs = (iso: IsoInstant | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const lineupId = (a: Assignment, starters: readonly LineupPlayer[]): string =>
  starters
    .map((p) => `${String(p.player_id)}@${slotIn(a, p.player_id)}`)
    .sort()
    .join(",");

function slotOrder(roster: RosterSlots, name: string): number {
  const ids = sortSlotIds(roster.slots.map((s) => s.slot_id));
  const s = roster.slots.find((x) => x.name === name);
  if (s !== undefined) return ids.indexOf(s.slot_id);
  return name === BENCH ? ids.length : ids.length + 1;
}

function assignments(
  a: Assignment,
  players: readonly LineupPlayer[],
  roster: RosterSlots,
): LineupSlotAssignment[] {
  return players
    .map((p) => ({
      slot: slotIn(a, p.player_id),
      player_id: p.player_id,
      name: p.name,
      points: p.points,
      lock_at: p.lock_at,
      percent_started: p.percent_started,
    }))
    .sort(
      (x, y) => slotOrder(roster, x.slot) - slotOrder(roster, y.slot) || x.player_id - y.player_id,
    );
}

function lockGroups(players: readonly LineupPlayer[]): LockScheduleEntry[] {
  const by = new Map<number, Set<number>>();
  for (const p of players) {
    const t = lockMs(p.lock_at);
    if (t === null) continue;
    const set = by.get(t) ?? new Set<number>();
    set.add(p.player_id);
    by.set(t, set);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, ids]) => ({
      lock_at: new Date(t).toISOString(),
      player_ids: [...ids].sort((x, y) => x - y),
    }));
}

function earliestAhead(players: readonly LineupPlayer[], nowMs: number): IsoInstant | null {
  let best: number | null = null;
  for (const p of players) {
    const t = lockMs(p.lock_at);
    if (!p.locked && t !== null && t > nowMs && (best === null || t < best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

function basisOf(players: readonly LineupPlayer[]): DistBasis {
  return players.length > 0 && players.every((p) => p.points.basis === "player_sim")
    ? "player_sim"
    : "position_cv";
}

/** Whether a player is still unlocked at `t`. */
const opensAfter = (p: LineupPlayer, t: number): boolean => {
  const k = lockMs(p.lock_at);
  return !p.locked && (k === null || k > t);
};

// --- the slot flow ------------------------------------------------------------------------------------

interface FlowPair {
  readonly out: LineupPlayer | null;
  readonly in: LineupPlayer;
  readonly slot: string;
  /** The starters who only change slots on this entrant's way to his seat (his chain). */
  readonly movers: readonly LineupPlayer[];
}

interface Flow {
  readonly pairs: FlowPair[];
  readonly entrants: LineupPlayer[];
  readonly leavers: LineupPlayer[];
  readonly unpairedLeavers: LineupPlayer[];
  readonly slotMovers: LineupPlayer[];
  readonly changes: number;
  /**
   * Every slot mover lies on an entrant's chain, so the flow splits into independent changes on
   * disjoint seats (changelog R7-1). False only for a lineup the solve must reshuffle without an
   * entrant (a player set in a seat he cannot hold).
   */
  readonly decomposable: boolean;
}

/**
 * How the recommended lineup is reached from the current one, seat by seat (sibling QA-1-020): per
 * slot name each entrant takes the seat of a player leaving it, else an empty seat; a bench
 * entrant's pair follows starters who only change slots until it reaches the one who leaves — those
 * starters are its chain's movers. Chains are disjoint (each leaver of a slot is displaced by one
 * newcomer), so any subset of them applied to the current lineup is a legal lineup.
 */
function slotFlow(
  cur: Assignment,
  rec: Assignment,
  curStarters: readonly LineupPlayer[],
  recStarters: readonly LineupPlayer[],
  roster: RosterSlots,
): Flow {
  const byId = (a: LineupPlayer, b: LineupPlayer): number => a.player_id - b.player_id;
  const curIds = new Set(curStarters.map((p) => p.player_id));
  const recIds = new Set(recStarters.map((p) => p.player_id));
  const displacedBy = new Map<LineupPlayer, LineupPlayer | null>();
  const names = new Set<string>([
    ...curStarters.map((p) => slotIn(cur, p.player_id)),
    ...recStarters.map((p) => slotIn(rec, p.player_id)),
  ]);
  for (const name of names) {
    const was = curStarters
      .filter((p) => slotIn(cur, p.player_id) === name && slotIn(rec, p.player_id) !== name)
      .sort(byId);
    const now = recStarters
      .filter((p) => slotIn(rec, p.player_id) === name && slotIn(cur, p.player_id) !== name)
      .sort(byId);
    now.forEach((e, i) => displacedBy.set(e, was[i] ?? null));
  }
  const entrants = recStarters
    .filter((p) => !curIds.has(p.player_id))
    .sort(
      (x, y) =>
        slotOrder(roster, slotIn(rec, x.player_id)) - slotOrder(roster, slotIn(rec, y.player_id)) ||
        byId(x, y),
    );
  const leavers = curStarters.filter((p) => !recIds.has(p.player_id));
  const slotMovers = recStarters.filter(
    (p) => curIds.has(p.player_id) && slotIn(cur, p.player_id) !== slotIn(rec, p.player_id),
  );
  const reached = new Set<LineupPlayer>();
  const onChain = new Set<LineupPlayer>();
  /** Entrants whose chain loops back on itself (never the solve's; then the flow cannot split). */
  const cyclic = new Set<LineupPlayer>();
  const pairs: FlowPair[] = entrants.map((e) => {
    let d = displacedBy.get(e) ?? null;
    const seen = new Set<LineupPlayer>([e]);
    const movers: LineupPlayer[] = [];
    while (d !== null && recIds.has(d.player_id) && !seen.has(d)) {
      seen.add(d);
      movers.push(d);
      onChain.add(d);
      d = displacedBy.get(d) ?? null;
    }
    if (d !== null && recIds.has(d.player_id)) cyclic.add(e);
    const out = d !== null && !recIds.has(d.player_id) ? d : null;
    if (out !== null) reached.add(out);
    return { out, in: e, slot: slotIn(rec, e.player_id), movers };
  });
  const unpairedLeavers = leavers.filter((l) => !reached.has(l)).sort(byId);
  const core = entrants.length + unpairedLeavers.length;
  return {
    pairs,
    entrants,
    leavers,
    unpairedLeavers,
    slotMovers,
    changes: core > 0 ? core : slotMovers.length,
    decomposable: cyclic.size === 0 && slotMovers.every((m) => onChain.has(m)),
  };
}

/** Every ordering of `xs` (the caller bounds its length — n! orderings). */
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)]))
      out.push([x, ...rest]);
  });
  return out;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** What a lineup move does, counted by outcome (the held changes last — changelog R7-1). */
interface ActionCounts {
  readonly pairs: readonly FlowPair[];
  readonly benched: number;
  readonly slotMovers: number;
  readonly coinFlips: number;
  readonly gainNothing: number;
}

function actionText(c: ActionCounts): string {
  const fills = c.pairs.filter((p) => p.out === null).length;
  const swaps = c.pairs.length - fills;
  const parts: string[] = [];
  if (swaps > 0) parts.push(`make ${plural(swaps, "lineup change", "lineup changes")}`);
  if (fills > 0) parts.push(`fill ${plural(fills, "empty starting slot", "empty starting slots")}`);
  if (c.benched > 0) parts.push(`bench ${plural(c.benched, "starter", "starters")}`);
  if (parts.length === 0 && c.slotMovers > 0)
    parts.push(`move ${plural(c.slotMovers, "starter", "starters")} between slots`);
  if (c.coinFlips > 0) parts.push(`hold ${plural(c.coinFlips, "coin flip", "coin flips")}`);
  if (c.gainNothing > 0)
    parts.push(
      `skip ${plural(c.gainNothing, "change that gains nothing", "changes that gain nothing")}`,
    );
  return parts.join(" and ");
}

// --- the no-move rule (plan 09 §2 guardrail 9; changelog R7-1; sib research 05 §14.4) ---------------
//
// What the user is told and what is logged follow guardrail 9 — a Δ whose interval includes 0 is
// "no move" — change by change. The flow from the current lineup to E2's mean-optimal assignment
// splits into independent changes on disjoint seats: an entrant's chain (a swap, or a fill of an
// empty seat, with the starters who only change slots on his way) or a starter benched with nobody
// reaching his seat. Each change is decided on its own numbers, the ones `swaps[]` shows:
//  1. held when it is a coin flip (`coin_flip`: its Δ interval includes 0, or — when this week's
//     opponent decides it — |ΔP(win)| is under the basis threshold); held when it gains nothing
//     (Δ 0 whatever happens); made otherwise;
//  2. a seat that scores a known 0 now — empty, or held by a player who will not play (a point mass
//     at 0: on bye, ruled out) — is priced exactly, by the entrant's own quantiles: doing nothing
//     there scores exactly 0, so the change is made whenever the entrant is expected to score;
//  3. a change the user asked for (`force_start`, `exclude`), or one that moves a player out of a
//     starting seat he cannot hold, is always made.
// The lineup the user is told to set is the current one with the made changes applied; `no_move` is
// true when no change is made, and the retrospective then scores the call as "keep" (its subjects
// are the starters kept and the entrants held out). E2's mean-optimal assignment — its starters in
// `recommended_lineup` and `rec.lineup`, `e_points_after`, `p_win_after`, `p_win_interval` — is
// unchanged by the rule (R7-1: C2 replays it, and R6-1's identity with ESPN's lineup holds);
// `swaps[]` lists every change of it, a held one with `coin_flip` set. Which entrant takes which
// freed seat is the solve's tie-break, re-seated only when that makes more of the changes (below).

/** How the no-move rule decided one change. */
type Verdict = "made" | "coin_flip" | "gains_nothing";

/** One independent change on the way from the current lineup to the mean-optimal one. */
interface Change {
  /** The swap or fill; null for a starter benched with nobody reaching his seat. */
  readonly pair: FlowPair | null;
  readonly leaver: LineupPlayer | null;
  /** Everyone whose seat the change moves. */
  readonly members: readonly LineupPlayer[];
  /** The change's Δ points (unrounded). */
  readonly de: number;
  /** The change's own Δ-points interval (as `swaps[]` reports it for a pair). */
  readonly interval: readonly [number, number];
  /** It is a coin flip by ΔP(win) alone (its interval excludes 0) — worded apart. */
  readonly by_pwin: boolean;
  readonly verdict: Verdict;
}

/** A Dist with no spread: the player scores exactly `mean`. */
const pointMass = (d: Dist): boolean => d.p10 === d.p90 && d.p10 === d.mean;

/** A Dist that is a point mass at 0: a player who will not score this week (bye, ruled out). */
const scoresZero = (d: Dist): boolean => d.mean === 0 && d.p10 === 0 && d.p90 === 0;

/** A swap into a seat that scores a known 0 now: an empty one, or one held by a player who will not score. */
const freesZeroSeat = (pr: { readonly out: LineupPlayer | null }): boolean =>
  pr.out === null || scoresZero(pr.out.points);

/** A Δ interval that is 0 whatever happens. */
const gainsNothing = (iv: readonly [number, number]): boolean => iv[0] === 0 && iv[1] === 0;

/**
 * A swap's Δ points (`in` − `out`) and its p10–p90 interval. A side with no spread (an empty seat, a
 * player who will not play) is a constant, so Δ's quantiles are the other side's, exactly — the
 * symmetric approximation put p10 below 0 for a replacement who cannot lose points against a player
 * on bye (rule 2); two uncertain sides use the normal approximation with the pair's same-team
 * correlation (research 05 §3.2).
 */
function pairDelta(pr: { readonly out: LineupPlayer | null; readonly in: LineupPlayer }): {
  de: number;
  interval: readonly [number, number];
} {
  const inn = pr.in.points;
  const out = pr.out;
  if (out === null || pointMass(out.points)) {
    const c = out?.points.mean ?? 0;
    return { de: inn.mean - c, interval: [round(inn.p10 - c), round(inn.p90 - c)] };
  }
  if (pointMass(inn))
    return {
      de: inn.mean - out.points.mean,
      interval: [round(inn.mean - out.points.p90), round(inn.mean - out.points.p10)],
    };
  const de = inn.mean - out.points.mean;
  const si = sigmaOf(inn);
  const so = sigmaOf(out.points);
  const s = Math.sqrt(
    Math.max(0, si * si + so * so - 2 * rho(member(pr.in), member(out)) * si * so),
  );
  return { de, interval: [round(de - Z90 * s), round(de + Z90 * s)] };
}

/** Rule 1 for a change that is not forced: made, or held as a coin flip or as gaining nothing. */
function heldOrMade(coinFlip: boolean, zeroSeat: boolean, iv: readonly [number, number]): Verdict {
  if (!coinFlip) return "made";
  return zeroSeat || gainsNothing(iv) ? "gains_nothing" : "coin_flip";
}

/**
 * The assumption that says why held changes were not made, the coin flips and the changes that gain
 * nothing worded apart; every text within the Rec's 200-character cap (TEXT_CAPS.rec_log_text).
 */
function heldAssumption(
  held: readonly Change[],
  noMove: boolean,
  pwinThreshold: number,
): Assumption | null {
  const coin = held.filter((c) => c.verdict === "coin_flip");
  const zero = held.filter((c) => c.verdict === "gains_nothing");
  if (coin.length === 0 && zero.length === 0) return null;
  const trigger = "a status or projection change moves a held change's interval off 0";
  const only = coin[0];
  if (noMove && zero.length === 0 && coin.length === 1 && only !== undefined) {
    const why = only.by_pwin
      ? `it moves the win chance by under ${String(pwinThreshold)}`
      : `its Δ interval, ${String(round(only.interval[0], 1))} to ${String(round(only.interval[1], 1))} points, includes 0`;
    return A(
      `the best lineup change is a coin flip (${why}), so the call is no move (guardrail 9); recommended_lineup shows it made`,
      trigger,
    );
  }
  const parts: string[] = [];
  if (coin.length > 0)
    parts.push(
      `${plural(coin.length, "coin flip", "coin flips")} (Δ interval includes 0 or |ΔP(win)| < ${String(pwinThreshold)})`,
    );
  if (zero.length > 0)
    parts.push(plural(zero.length, "change that gains nothing", "changes that gain nothing"));
  const listed = parts.join(" and ");
  return A(
    noMove
      ? `no move (guardrail 9): every change of the best lineup is held — ${listed}; recommended_lineup shows them made`
      : `changes made: outside the coin-flip band; held (guardrail 9): ${listed}; recommended_lineup shows all made`,
    trigger,
  );
}

// --- option value (research 05 §5 Start/sit; sibling §3.4) ---------------------------------------------

function optionValue(
  pr: { readonly out: LineupPlayer; readonly in: LineupPlayer; readonly slot: string },
  recIds: ReadonlySet<number>,
  players: readonly LineupPlayer[],
  roster: RosterSlots,
): OptionValue | null {
  const ki = lockMs(pr.in.lock_at);
  const ko = lockMs(pr.out.lock_at);
  if (ki === null || ko === null || ki === ko) return null;
  const inFirst = ki < ko;
  const later = inFirst ? pr.out : pr.in;
  const pLater = later.p_active ?? 1;
  const kind: OptionValue["kind"] | null =
    easternDayHour(Math.min(ki, ko)).day === "thursday"
      ? "thursday"
      : easternDayHour(Math.max(ki, ko)).day === "monday"
        ? "monday"
        : pLater < 1
          ? "late_game"
          : null;
  if (kind === null) return null;
  const decided = Math.max(ki, ko) - LINEUP.inactivesLeadMs;
  const seat = roster.slots.find((s) => s.name === pr.slot);
  const reserve = players
    .filter(
      (y) =>
        y !== pr.in &&
        y !== pr.out &&
        !recIds.has(y.player_id) &&
        slotClassOf(y.slot_id) !== "ir" &&
        opensAfter(y, decided) &&
        (seat === undefined || canOccupySlot(seat.slot_id, y)),
    )
    .reduce((best, y) => Math.max(best, y.points.mean), 0);
  const value = round((1 - pLater) * reserve, 3);
  const gain = pr.in.points.mean - pr.out.points.mean;
  const verdict = inFirst
    ? gain >= value
      ? "commit: the gain covers the option value of waiting"
      : "hold: the gain does not cover the option value of the later game"
    : "commit: starting the later player keeps the option open";
  return { kind, value, verdict };
}

// --- the season context ---------------------------------------------------------------------------------

/** One team's standing as the PF context reads it. */
export interface StandingRow {
  readonly team_id: number;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly points_for: number;
}

/**
 * E2's `pf_context` from the standings (plan 07 E2 `mode_basis.pf_context`): my PF rank; the gap to
 * the PF cutoff (my PF minus the first team out's when I am inside the line, minus the last team
 * in's when outside — positive = above it); whether the PF tiebreak decides the line (my win-%
 * group straddles the playoff line under reading (a)). Null when I am not in the standings.
 */
export function pfContextOf(
  standings: readonly StandingRow[],
  me: number,
  playoffTeams: number,
): LineupSeasonContext["pf_context"] {
  const mine = standings.find((s) => s.team_id === me);
  if (mine === undefined || standings.length < 2) return null;
  const byPf = [...standings].sort((a, b) => b.points_for - a.points_for || a.team_id - b.team_id);
  const rank = byPf.indexOf(mine) + 1;
  const P = Math.max(1, Math.min(playoffTeams, standings.length));
  const ref = rank <= P ? byPf[P] : byPf[P - 1];
  const gap = ref === undefined ? mine.points_for : mine.points_for - ref.points_for;
  const pct = (s: StandingRow): number => {
    const g = s.wins + s.losses + s.ties;
    return g > 0 ? (s.wins + s.ties / 2) / g : 0;
  };
  const myPct = pct(mine);
  const ahead = standings.filter((s) => pct(s) > myPct + 1e-9).length;
  const group = standings.filter((s) => Math.abs(pct(s) - myPct) <= 1e-9).length;
  return {
    season_pf_rank: rank,
    pf_gap_to_cutoff: round(gap, 2),
    tiebreak_in_play: ahead < P && ahead + group > P,
  };
}

// --- the engine -----------------------------------------------------------------------------------------

/** A `compare` pair as E2 takes it (plan 07 E2). */
interface ComparePair {
  readonly out: number;
  readonly in: number;
}

/**
 * Why E2 cannot evaluate a `compare` pair against this roster — each reason names the player id:
 * the same player out and in, a player not on the roster, or a locked player (a locked player never
 * moves — A11a). Empty when the pair can be evaluated. analyzeLineup skips exactly the pairs with a
 * reason and compareWarnings reports them, so a pair is never dropped silently (changelog R5).
 */
function compareIssues(byId: ReadonlyMap<number, LineupPlayer>, c: ComparePair): string[] {
  if (c.out === c.in) return [`out and in are the same player ${String(c.out)}`];
  const issues: string[] = [];
  for (const id of [c.out, c.in]) {
    const p = byId.get(id);
    if (p === undefined) issues.push(`player ${String(id)} is not on the roster`);
    else if (p.locked) issues.push(`player ${String(id)} is locked`);
  }
  return issues;
}

/**
 * The warnings[] entries for the `compare` pairs analyzeLineup does not evaluate (one per pair,
 * naming each offending player id; ids only — no third-party text). The tool adds them to the
 * envelope's warnings (changelog R5).
 */
export function compareWarnings(
  players: readonly LineupPlayer[],
  compare: readonly ComparePair[] | undefined,
): string[] {
  const byId = new Map(players.map((p) => [p.player_id, p]));
  const out: string[] = [];
  for (const c of compare ?? []) {
    const issues = compareIssues(byId, c);
    if (issues.length > 0)
      out.push(
        `compare pair out ${String(c.out)} / in ${String(c.in)} not evaluated: ${issues.join("; ")}`,
      );
  }
  return out;
}

interface Evaluated {
  readonly a: Assignment;
  readonly starters: LineupPlayer[];
  readonly moments: PairMoments;
  readonly pwin: number;
}

/**
 * E2. Throws AnalyticsError `roster_empty` on an empty roster, `invalid_request` on bounds (roster
 * size, duplicate ids, blend weight, PF weight, compare pairs). Never moves a locked player; never
 * benches a locked starter.
 */
export function analyzeLineup(req: LineupRequest): LineupData {
  const { roster, clock } = req;
  // an empty roster is a league state (before the draft), not an argument error (Stage C round 2)
  ensurePlayers(req.players.length, "players");
  ensure(req.players.length <= LINEUP.maxPlayers, "roster size out of range", "players");
  ensure(
    new Set(req.players.map((p) => p.player_id)).size === req.players.length,
    "duplicate player id",
    "players",
  );
  const blendW = req.blend_weight ?? LINEUP.blendWeight;
  ensure(blendW >= 0 && blendW <= 1, "blend_weight must be in 0..1", "blend_weight");
  ensure(
    req.pf_weight === undefined ||
      req.pf_weight === null ||
      (Number.isFinite(req.pf_weight) && req.pf_weight > 0),
    "pf_weight must be a positive number",
    "pf_weight",
  );
  ensure((req.compare ?? []).length <= LINEUP.maxCompare, "too many compare pairs", "compare");
  const nowMs = clock.nowMs();
  const basis = basisOf(req.players);
  const modeArg = req.seeding_mode ?? "config";
  const reading: SeedingMode =
    modeArg === "config" ? req.seeding_config.mode : modeArg === "both" ? "espn_rule" : modeArg;
  const modeUsed: SeedingMode | "both" = modeArg === "both" ? "both" : reading;
  const assumptions: Assumption[] = [
    A(
      "each player's spread is read from his p10–p90 (normal approximation); same-team correlations from research 05 §3.2",
      "basis player_sim carries per-player variance",
    ),
    A("locked players are never moved", "never"),
  ];
  if (modeArg === "both")
    assumptions.push(
      A(
        "both readings were asked: the lineup and mode follow espn_rule; under points_only the same lineup maximises PF in v1",
        "the operator confirms one reading",
      ),
    );
  // no regular-season week left (a playoff week): the seeding is settled under either reading, so the
  // week's objective, mode and coin flips follow its matchup alone — the reading decides nothing
  const settled = req.season?.remaining_weeks === 0;
  /** Reading (b)'s points-for objective: only while the regular season, which it seeds, runs. */
  const pfSeeding = reading === "points_only" && !settled;
  if (settled) assumptions.push(PLAYOFF_WEEK_ASSUMPTION);
  const listed = req.opponent !== null && req.opponent.length > 0 ? req.opponent : null;
  const objArg = req.objective ?? "auto";
  let objective: Objective;
  let reason: string;
  if (objArg === "auto") {
    if (pfSeeding) {
      objective = "points_only";
      reason = "auto: the points_only reading seeds by points for, so every point counts the same";
    } else if (
      basis === "player_sim" &&
      autoObjectiveForPlayerSim(req.objective_switch ?? OBJECTIVE_SWITCH_RECORD) === "pwin"
    ) {
      // plan 10 C2 / plan 07 E2: the committed switch record shows pwin beats mean on regret
      objective = "pwin";
      reason = settled
        ? "auto: a playoff week — the seeding is settled and only this matchup advances: pwin, which beat mean on regret in the held-out replay (plan 10 C2)"
        : "auto: espn_rule with player_sim — pwin beat mean on regret in the held-out replay (plan 10 C2)";
    } else {
      objective = "mean";
      reason = settled
        ? `auto: a playoff week — the seeding is settled and only this matchup advances: the mean${listed === null ? "" : " against the opponent"}`
        : basis === "position_cv"
          ? "auto: espn_rule with position_cv spreads — the mean, with PF awareness through the exchange rate"
          : "auto: espn_rule — the mean until player_sim P(win) is shown to beat it on regret";
    }
  } else {
    objective = objArg;
    reason = `requested: ${objArg}`;
  }
  if ((objective === "pwin" || objective === "blend") && listed === null) {
    assumptions.push(
      A(
        `no opponent roster this week: the objective is mean (not ${objective})`,
        "the opponent's roster is readable",
      ),
    );
    objective = "mean";
    reason = "degraded: no opponent roster";
  }
  const exclude = new Set(req.exclude ?? []);
  const force = new Set(req.force_start ?? []);
  const oppStarters = listed === null ? [] : bestLineup(roster, listed);
  if (listed !== null)
    assumptions.push(
      A(
        "the opponent starts his highest-projected legal lineup",
        "the opponent's set lineup differs",
      ),
    );
  else
    assumptions.push(
      A(
        "no opponent roster: P(win) is not reported and the mode is neutral",
        "the opponent's roster is readable",
      ),
    );
  const oppMembers = oppStarters.map(member);
  // the period's earlier weeks' margin (mine minus the opponent's): only an opponent's matchup has one
  const banked = listed === null ? null : (req.banked ?? null);
  if (banked !== null) {
    ensure(
      Number.isFinite(banked.me) && Number.isFinite(banked.opponent),
      "the banked points must be finite",
      "week",
    );
    assumptions.push(
      A(
        `a multi-week matchup period: the earlier weeks' ${String(round(banked.me, 1))}–${String(round(banked.opponent, 1))} is carried into P(win) and the mode, which are the period's`,
        "the period's earlier scores are corrected",
      ),
    );
  }
  const carry = banked === null ? 0 : banked.me - banked.opponent;
  /** This week's moments with the carried margin: what P(win) and the mode read. */
  const carried = (mo: PairMoments): PairMoments =>
    carry === 0 ? mo : { ...mo, mu_m: mo.mu_m + carry };

  const meanA = solve({
    roster,
    players: req.players,
    value: (p) => p.points.mean,
    exclude,
    force,
  });
  const meanStarters = startersOf(meanA, req.players, roster);
  const meanM = lineupMoments(meanStarters.map(member));
  const moments = (st: readonly LineupPlayer[]): PairMoments => {
    const mem = st.map(member);
    if (listed !== null) return pairMoments(mem, oppMembers);
    const m = lineupMoments(mem);
    return { mu_m: m.mu, v_m: m.v, mu_o: meanM.mu, v_o: meanM.v, cov: 0 };
  };
  const evaluate = (a: Assignment): Evaluated => {
    const starters = startersOf(a, req.players, roster);
    const mo = moments(starters);
    return { a, starters, moments: mo, pwin: pWinNormal(carried(mo)) };
  };

  // the exchange rate (reading (a)): one win in PF points — none once the seeding is settled
  const pfRate: ModeBasis["pf_exchange_rate"] =
    reading === "points_only" || settled
      ? { pf_per_win: null, source: null }
      : req.season?.pf_per_win !== undefined && req.season.pf_per_win !== null
        ? { pf_per_win: round(req.season.pf_per_win, 1), source: "season_sim" }
        : { pf_per_win: PF_PER_WIN_COLD_START, source: "cold_start" };
  if (reading === "espn_rule" && pfRate.source === "cold_start")
    assumptions.push(
      A(
        `one win ≈ ${String(PF_PER_WIN_COLD_START)} PF (cold start, research 05 §2.2: 90–200)`,
        "the seeding simulator has run",
      ),
    );

  const meanEval = evaluate(meanA);
  let chosen = meanEval;
  if (objective === "pwin" || objective === "blend") {
    const seen = new Map<string, Evaluated>([[lineupId(meanA, meanEval.starters), meanEval]]);
    for (const lam of LINEUP.lambdaGrid)
      for (const sign of [1, -1]) {
        if (lam === 0 && sign === -1) continue;
        const a = solve({
          roster,
          players: req.players,
          value: (p) => p.points.mean + sign * lam * sigmaOf(p.points) ** 2,
          exclude,
          force,
        });
        const id = lineupId(a, startersOf(a, req.players, roster));
        if (!seen.has(id)) seen.set(id, evaluate(a));
      }
    const pfPerWin = req.pf_weight ?? pfRate.pf_per_win ?? PF_PER_WIN_COLD_START;
    const utility = (c: Evaluated): number =>
      objective === "pwin" ? c.pwin : blendW * c.pwin + (1 - blendW) * (c.moments.mu_m / pfPerWin);
    for (const c of [...seen.values()]) if (utility(c) > utility(chosen) + 1e-12) chosen = c;
  }

  // the mode (research 05 §2.2) — in a playoff week the matchup's alone: the regular season's PF
  // context (its cutoff, its tiebreak) is final and no longer bears on the week
  const mm = meanEval.moments;
  const sd = diffSd(mm);
  const d = mm.mu_m - mm.mu_o + carry;
  let mode: MatchupMode;
  const ctx = settled ? null : (req.season?.pf_context ?? null);
  if (!settled && (reading === "points_only" || objective === "points_only")) {
    const band = LINEUP.pfGapPerWeek * Math.max(1, req.season?.remaining_weeks ?? 1);
    mode =
      ctx === null
        ? "maximise_pf"
        : ctx.pf_gap_to_cutoff > band
          ? "protect"
          : ctx.pf_gap_to_cutoff < -band
            ? "chase"
            : "maximise_pf";
  } else if (listed === null) {
    mode = "neutral";
  } else if (
    ctx?.tiebreak_in_play === true &&
    (meanEval.pwin >= LINEUP.saturatedPwin || meanEval.pwin <= 1 - LINEUP.saturatedPwin)
  ) {
    mode = "maximise_pf";
  } else {
    mode = Math.abs(d) <= LINEUP.neutralZ * sd ? "neutral" : d > 0 ? "protect" : "chase";
  }
  const sm = Math.sqrt(mm.v_m);
  const so = Math.sqrt(mm.v_o);
  const modeBasis: ModeBasis = {
    mu_m: round(mm.mu_m),
    mu_o: listed === null ? 0 : round(mm.mu_o),
    sigma_m: round(sm),
    sigma_o: listed === null ? 0 : round(so),
    rho_lineup: listed !== null && sm > 0 && so > 0 ? round(mm.cov / (sm * so)) : 0,
    pf_exchange_rate: pfRate,
    pf_context: ctx,
  };

  // current lineup, its changes and the no-move rule (above the Change type)
  const curA: Assignment = new Map(req.players.map((p) => [p.player_id, slotNameOf(p.slot_id)]));
  const curEval = evaluate(curA);
  const curStarters = curEval.starters;
  const recStarters = chosen.starters;
  const recIds = new Set(recStarters.map((p) => p.player_id));
  const byId = new Map(req.players.map((p) => [p.player_id, p]));
  // ΔP(win) can make a change a coin flip only when this week's opponent decides it: one is listed,
  // the objective counts the matchup, and P(win) is not saturated — under reading (b) in the
  // regular season or `points_only` every point counts the same, and in `maximise_pf` the
  // points-for tiebreak is the currency (there |ΔP(win)| is near 0 for every change); then the
  // interval alone decides (R7-1). A playoff week's opponent decides it under either reading.
  const pwinDecides =
    listed !== null && mode !== "maximise_pf" && !pfSeeding && objective !== "points_only";
  const dpOf = (after: readonly LineupPlayer[]): number =>
    listed === null ? 0 : pWinNormal(carried(moments(after))) - curEval.pwin;
  /** The `swaps[]` row of a pair (its Δ unrounded in `de` for the search below). */
  const rawSwap = (pr: FlowPair) => {
    const out = pr.out;
    const after = curStarters.filter((p) => p !== out);
    if (!after.includes(pr.in)) after.push(pr.in);
    const dp = dpOf(after);
    const { de, interval } = pairDelta(pr);
    return {
      out: out === null ? null : out.player_id,
      in: pr.in.player_id,
      slot: pr.slot,
      de,
      delta_e: round(de),
      dp,
      delta_pf: round(de),
      interval,
      // rule 2: doing nothing at a seat that scores 0 scores exactly 0 — never a coin flip while
      // the entrant is expected to score
      coin_flip: freesZeroSeat(pr)
        ? !(de > 0)
        : isCoinFlip(basis, pwinDecides ? dp : null, interval),
      option_value:
        out === null
          ? null
          : optionValue({ out, in: pr.in, slot: pr.slot }, recIds, req.players, roster),
    };
  };
  type RawSwap = ReturnType<typeof rawSwap>;
  const cannotHold = (p: LineupPlayer): boolean => {
    const c = slotClassOf(p.slot_id);
    return (c === "starter" || c === "flex") && !canOccupySlot(p.slot_id, p);
  };
  const spans = (iv: readonly [number, number]): boolean => iv[0] <= 0 && iv[1] >= 0;
  /** Every change of a flow with its verdict: its pairs (in flow order), its benched starters. */
  const decide = (f: Flow, raw: readonly RawSwap[]): Change[] => {
    const out: Change[] = f.pairs.map((pr, i) => {
      const s = at(raw, i);
      const members = [pr.in, ...pr.movers, ...(pr.out === null ? [] : [pr.out])];
      const forced =
        !f.decomposable ||
        force.has(pr.in.player_id) ||
        (pr.out !== null && exclude.has(pr.out.player_id)) ||
        members.some(cannotHold);
      return {
        pair: pr,
        leaver: null,
        members,
        de: s.de,
        interval: s.interval,
        by_pwin: s.coin_flip && !spans(s.interval),
        verdict: forced ? "made" : heldOrMade(s.coin_flip, freesZeroSeat(pr), s.interval),
      };
    });
    for (const l of f.unpairedLeavers) {
      // benched with nobody reaching his seat: Δ is minus his own points (his quantiles, exactly)
      const interval: readonly [number, number] = [round(-l.points.p90), round(-l.points.p10)];
      const coin = isCoinFlip(
        basis,
        pwinDecides ? dpOf(curStarters.filter((p) => p !== l)) : null,
        interval,
      );
      const forced = !f.decomposable || exclude.has(l.player_id) || cannotHold(l);
      out.push({
        pair: null,
        leaver: l,
        members: [l],
        de: -l.points.mean,
        interval,
        by_pwin: coin && !spans(interval),
        verdict: forced ? "made" : heldOrMade(coin, scoresZero(l.points), interval),
      });
    }
    const onChains = new Set(f.pairs.flatMap((pr) => pr.movers));
    const loose = f.slotMovers.filter((m) => !onChains.has(m));
    // starters reshuffled with no entrant (a lineup set illegally): one change, always made
    if (loose.length > 0)
      out.push({
        pair: null,
        leaver: null,
        members: loose,
        de: 0,
        interval: [0, 0],
        by_pwin: false,
        verdict: "made",
      });
    return out;
  };
  const madeGain = (cs: readonly Change[]): number =>
    cs.reduce((s, c) => s + (c.verdict === "made" ? c.de : 0), 0);

  // which entrant takes which freed seat is the solve's tie-break (every seating of its starters has
  // the same total), yet it decides each change's pairing and so what is held: the solve's seating
  // stands unless seating its entrants differently among the seats they take makes a larger gain
  // from the changes made (sib QA-2-062's first criterion; searched only when a change is held). The
  // starter set, its totals and P(win) are the solve's either way — R7-1's assignment
  let seatA: Assignment = chosen.a;
  let flow = slotFlow(curA, seatA, curStarters, recStarters, roster);
  let flowRaw = flow.pairs.map(rawSwap);
  let changes = decide(flow, flowRaw);
  const entrants = flow.pairs.map((pr) => pr.in);
  if (
    entrants.length >= 2 &&
    entrants.length <= LINEUP.maxReseatEntrants &&
    changes.some((c) => c.verdict !== "made")
  ) {
    const seats = entrants.map((e) =>
      roster.slots.find((s) => s.name === slotIn(seatA, e.player_id)),
    );
    let best = madeGain(changes);
    for (const perm of permutations(entrants)) {
      if (!perm.every((e, i) => canOccupySlot(seats[i]?.slot_id ?? -1, e))) continue;
      const a = new Map(seatA);
      perm.forEach((e, i) => a.set(e.player_id, seats[i]?.name ?? BENCH));
      const f = slotFlow(curA, a, curStarters, recStarters, roster);
      if (!f.decomposable) continue;
      const raw = f.pairs.map(rawSwap);
      const cs = decide(f, raw);
      const g = madeGain(cs);
      if (g > best + 1e-9) {
        best = g;
        seatA = a;
        flow = f;
        flowRaw = raw;
        changes = cs;
      }
    }
  }
  const comparePairs: FlowPair[] = [];
  for (const c of req.compare ?? []) {
    const o = byId.get(c.out);
    const i = byId.get(c.in);
    // a pair with a reason is skipped here and reported by compareWarnings (never silently)
    if (o === undefined || i === undefined || compareIssues(byId, c).length > 0) continue;
    if (flow.pairs.some((p) => p.out === o && p.in === i)) continue;
    comparePairs.push({ out: o, in: i, slot: slotIn(curA, o.player_id), movers: [] });
  }
  const swapRaw = [...flowRaw, ...comparePairs.map(rawSwap)];
  const made = changes.filter((c) => c.verdict === "made");
  const held = changes.filter((c) => c.verdict !== "made");
  const noMove = made.length === 0;
  // the lineup the user is told to set: the current one with the made changes applied (every change
  // made: E2's assignment itself)
  let toldA: Assignment = seatA;
  if (held.length > 0) {
    const a = new Map(curA);
    for (const c of made) for (const p of c.members) a.set(p.player_id, slotIn(seatA, p.player_id));
    toldA = a;
  }
  const told = held.length === 0 ? chosen : evaluate(toldA);
  const toldStarters = told.starters;
  const toldIds = new Set(toldStarters.map((p) => p.player_id));

  // conditionals: if a starter of the lineup the user is told to set, with 0 < P(active) < 1, is
  // ruled out, the best eligible reserve
  const conditionals: LineupData["conditionals"][number][] = [];
  for (const x of toldStarters) {
    if (x.p_active === null || x.p_active <= 0 || x.p_active >= 1) continue;
    const t = lockMs(x.lock_at);
    if (t === null) continue;
    const decided = t - LINEUP.inactivesLeadMs;
    if (decided <= nowMs) continue;
    const slotName = slotIn(toldA, x.player_id);
    const seat = roster.slots.find((s) => s.name === slotName);
    if (seat === undefined) continue;
    const alt = req.players
      .filter(
        (y) =>
          !toldIds.has(y.player_id) &&
          slotClassOf(y.slot_id) !== "ir" &&
          !exclude.has(y.player_id) &&
          (y.p_active ?? 1) > 0 &&
          y.points.mean > 0 &&
          opensAfter(y, decided) &&
          canOccupySlot(seat.slot_id, y),
      )
      .sort((a, b) => b.points.mean - a.points.mean || a.player_id - b.player_id)[0];
    if (alt === undefined) continue;
    conditionals.push({
      if: {
        player_id: x.player_id,
        event: "inactive",
        decided_by: new Date(decided).toISOString(),
      },
      then: { slot: slotName, in: alt.player_id },
    });
  }

  // stack flags: the told lineup's starters sharing an NFL team with a positive-ρ pair (research 05
  // §3.3)
  const stackFlags: LineupData["stack_flags"][number][] = [];
  const teams = new Map<number, LineupPlayer[]>();
  for (const p of toldStarters) {
    if (p.pro_team_id === null || p.pro_team_id === 0) continue;
    teams.set(p.pro_team_id, [...(teams.get(p.pro_team_id) ?? []), p]);
  }
  for (const group of teams.values()) {
    if (!group.some((a, i) => group.some((b, j) => j > i && rho(member(a), member(b)) > 0)))
      continue;
    const floor = mode === "protect";
    stackFlags.push({
      players: group.map((p) => p.player_id).sort((a, b) => a - b),
      effect: floor ? "floor-" : "ceiling+",
      advice_under_reading: settled
        ? floor
          ? "playoffs: as the favourite the stack's variance costs floor"
          : "playoffs: as the underdog the stack's variance is a useful ceiling"
        : reading === "points_only"
          ? floor
            ? "points_only: comfortably above the PF cutoff — the stack's variance costs more than it adds"
            : "points_only: the stack's variance is judged against the season PF cutoff, not this opponent"
          : floor
            ? "espn_rule: as the favourite the stack's variance costs floor"
            : "espn_rule: as the underdog the stack's variance is a useful ceiling",
    });
  }
  stackFlags.sort((a, b) => a.players.join(",").localeCompare(b.players.join(",")));

  // ESPN's projection as the labelled cross-check (plan 07 C13), on the told lineup's starters
  const disagreements = toldStarters
    .filter((p) => p.espn_projection !== null && p.espn_projection > 0)
    .map((p) => {
      const espn = p.espn_projection ?? 0;
      return {
        player_id: p.player_id,
        ours: round(p.points.mean, 2),
        espn: round(espn, 2),
        pct: round(Math.abs(p.points.mean - espn) / espn, 3),
      };
    })
    .filter((x) => x.pct > DISAGREEMENT_FLAG_PCT)
    .sort((a, b) => a.player_id - b.player_id);

  const schedule = lockGroups(req.players);
  const latest = earliestAhead(req.players, nowMs);
  const inputs = [...(req.inputs ?? [])];

  // the Rec describes the lineup the user is told to set (`lineup` aside: E2's assignment — R7-1)
  const recM = lineupMoments(recStarters.map(member));
  const toldM = lineupMoments(toldStarters.map(member));
  const curMembers = curStarters.map(member);
  const curM = lineupMoments(curMembers);
  // Δ = `to` − current: an entrant into a seat that scores 0 by his own quantiles (rule 2 — that
  // change cannot lose points against the seat), the rest by the normal approximation
  const deltaOf = (to: readonly LineupPlayer[], pairs: readonly FlowPair[]): DeltaVsNext => {
    const exact = pairs.filter(freesZeroSeat).map((pr) => pr.in);
    const swapped = to.filter((p) => !exact.includes(p)).map(member);
    const sm = lineupMoments(swapped);
    const sd = Math.sqrt(Math.max(0, sm.v + curM.v - 2 * lineupCov(swapped, curMembers)));
    const d = sm.mu - curM.mu;
    const q = (f: (x: Dist) => number): number => exact.reduce((s, p) => s + f(p.points), 0);
    return {
      value: round(lineupMoments(to.map(member)).mu - curM.mu),
      p10: round(d - Z90 * sd + q((x) => x.p10)),
      p90: round(d + Z90 * sd + q((x) => x.p90)),
    };
  };
  const madePairs = made.flatMap((c) => (c.pair === null ? [] : [c.pair]));
  // a move: the made changes against keeping; no move: the best lineup's change that was not made
  // (its interval is why — guardrail 9); 0 when the current lineup is already the best
  const delta: DeltaVsNext =
    flow.changes === 0
      ? { value: round(recM.mu - curM.mu), p10: 0, p90: 0 }
      : noMove
        ? deltaOf(recStarters, flow.pairs)
        : deltaOf(toldStarters, madePairs);
  const heldNote = heldAssumption(held, noMove, COIN_FLIP_DPWIN[basis]);
  if (heldNote !== null) assumptions.push(heldNote);
  // subjects — the k-th start ↔ the k-th sit (the retrospective's swap regret): a made swap's
  // entrant against the starter he replaces, then a held swap's kept starter against the entrant
  // held out, then the other starters of the told lineup; a made bench-only change's starter last
  const pairedOf = (cs: readonly Change[]): { out: LineupPlayer; in: LineupPlayer }[] =>
    cs.flatMap((c) => {
      const out = c.pair?.out ?? null;
      return c.pair === null || out === null ? [] : [{ out, in: c.pair.in }];
    });
  const madePaired = pairedOf(made);
  const heldPaired = pairedOf(held);
  const lead = [...madePaired.map((x) => x.in), ...heldPaired.map((x) => x.out)];
  const sits = [
    ...madePaired.map((x) => x.out),
    ...heldPaired.map((x) => x.in),
    ...made.flatMap((c) => (c.leaver === null ? [] : [c.leaver])),
  ];
  const subjectOf = (p: LineupPlayer, role: "start" | "sit", a: Assignment): RecSubject => ({
    player_id: p.player_id,
    gsis_id: p.gsis_id,
    role,
    slot: slotIn(a, p.player_id),
  });
  const subjects: RecSubject[] = [
    ...[...lead, ...toldStarters.filter((p) => !lead.includes(p))].map((p) =>
      subjectOf(p, "start", toldA),
    ),
    ...sits.map((p) => subjectOf(p, "sit", curA)),
  ];
  const movers = [...new Set(made.flatMap((c) => c.members))];
  const roleGames = toldStarters.map((p) => p.role_games);
  const rec: Rec = {
    action: noMove
      ? "keep the current lineup"
      : actionText({
          pairs: madePairs,
          benched: made.filter((c) => c.leaver !== null).length,
          slotMovers: made.some((c) => c.pair === null && c.leaver === null)
            ? flow.slotMovers.length
            : 0,
          coinFlips: held.filter((c) => c.verdict === "coin_flip").length,
          gainNothing: held.filter((c) => c.verdict === "gains_nothing").length,
        }),
    subjects,
    lineup: assignments(seatA, recStarters, roster).map((s) => ({
      slot: s.slot,
      player_id: s.player_id,
    })),
    point_estimate: round(toldM.mu),
    distribution: normalDist(toldM.mu, Math.sqrt(toldM.v), basis),
    delta_vs_next: delta,
    decision_metric:
      objective === "pwin"
        ? "p_win"
        : objective === "blend"
          ? "blend"
          : objective === "points_only"
            ? "points_for"
            : "expected_points",
    drivers: swapRaw
      .slice(0, flow.pairs.length)
      .map((s) => ({ name: `swap:${s.slot}:${String(s.in)}`, contribution: s.delta_e })),
    assumptions,
    confidence: { role_games: roleGames.length === 0 ? 0 : Math.min(...roleGames), inputs },
    as_of: newestAsOf(inputs, clock.nowIso()),
    latest_execution_time: noMove ? null : earliestAhead(movers, nowMs),
    no_move: noMove,
    log_id: null,
  };

  const view = (a: Assignment): LineupSlotAssignment[] => {
    const all = assignments(a, req.players, roster);
    if (req.only_unlocked !== true) return all;
    const locked = new Set(req.players.filter((p) => p.locked).map((p) => p.player_id));
    return all.filter((s) => !locked.has(s.player_id));
  };
  const hasOpp = listed !== null;
  const base = {
    objective_used: objective,
    objective_reason: reason,
    seeding_mode_used: modeUsed,
    seeding: seedingStatus(modeUsed, req.seeding_config.confirmed_at),
    current_lineup: view(curA),
    recommended_lineup: view(seatA),
    mode,
    mode_basis: modeBasis,
    e_points_before: round(curM.mu),
    e_points_after: round(recM.mu),
    p_win_before: hasOpp ? round(curEval.pwin) : null,
    p_win_after: hasOpp ? round(chosen.pwin) : null,
    p_win_interval: hasOpp
      ? ([...pWinInterval(carried(chosen.moments), recStarters.length + oppStarters.length)].map(
          (x) => round(x),
        ) as [number, number])
      : null,
    conditionals,
    stack_flags: stackFlags,
    espn_cross_check: { starter_disagreements: disagreements },
    lock_schedule: schedule,
    latest_execution_time: latest,
    no_move: noMove,
    rec,
    inputs,
  };
  if (basis === "position_cv") {
    const swaps: SwapOf<CoarseDelta>[] = swapRaw.map((s) => ({
      out: s.out,
      in: s.in,
      slot: s.slot,
      delta_e: s.delta_e,
      delta_pwin: toCoarseDelta(s.dp),
      delta_pf: s.delta_pf,
      interval: s.interval,
      coin_flip: s.coin_flip,
      option_value: s.option_value,
    }));
    return { ...base, basis: "position_cv", p_win_reporting: "sign_and_band", swaps };
  }
  const swaps: SwapOf<number>[] = swapRaw.map((s) => ({
    out: s.out,
    in: s.in,
    slot: s.slot,
    delta_e: s.delta_e,
    delta_pwin: round(s.dp, 3),
    delta_pf: s.delta_pf,
    interval: s.interval,
    coin_flip: s.coin_flip,
    option_value: s.option_value,
  }));
  return { ...base, basis: "player_sim", p_win_reporting: "calibrated", swaps };
}
