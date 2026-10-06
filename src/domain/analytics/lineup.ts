// lineup.ts — E2 `espn_analyze_lineup` (plan 07 E2; research 05 §2.2, §3.3, §5 Start/sit; plan 10
// A11a): the exact assignment over the league's slots (per-player `eligibleSlots`, flexes, IR kept,
// locked players never moved); the objective resolved from the seeding reading (`auto`: reading (b)
// → points_only, else `mean` while the basis is position_cv — a coarse ΔP(win) — with PF awareness
// through the PF-per-win exchange rate from the seeding simulator or the cold-start 120); modes
// protect | chase | neutral | maximise_pf (the variance sign from μ_m − μ_o under (a), plus
// maximise_pf when the PF tiebreak is in play and P(win) is saturated; under (b) a position
// relative to the season PF cutoff); Thursday / Monday / late-game option values; ESPN's
// projection as the labelled cross-check. Pure.
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
import { LINEUP, Z90 } from "./constants.js";
import { ensure } from "./errors.js";
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
  DISAGREEMENT_FLAG_PCT,
  PF_PER_WIN_COLD_START,
  isCoinFlip,
  seedingStatus,
  toCoarseDelta,
  type Assumption,
  type CoarseDelta,
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
  /** Regular-season weeks left (scales the PF cutoff band under reading (b)). */
  readonly remaining_weeks: number;
}

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
}

interface Flow {
  readonly pairs: FlowPair[];
  readonly entrants: LineupPlayer[];
  readonly leavers: LineupPlayer[];
  readonly unpairedLeavers: LineupPlayer[];
  readonly slotMovers: LineupPlayer[];
  readonly changes: number;
}

/**
 * How the recommended lineup is reached from the current one, seat by seat (sibling QA-1-020): per
 * slot name each entrant takes the seat of a player leaving it, else an empty seat; a bench
 * entrant's pair follows starters who only change slots until it reaches the one who leaves.
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
  const pairs: FlowPair[] = entrants.map((e) => {
    let d = displacedBy.get(e) ?? null;
    const seen = new Set<LineupPlayer>([e]);
    while (d !== null && recIds.has(d.player_id) && !seen.has(d)) {
      seen.add(d);
      d = displacedBy.get(d) ?? null;
    }
    const out = d !== null && !recIds.has(d.player_id) ? d : null;
    if (out !== null) reached.add(out);
    return { out, in: e, slot: slotIn(rec, e.player_id) };
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
  };
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

function actionText(flow: Flow): string {
  const fills = flow.pairs.filter((p) => p.out === null).length;
  const swaps = flow.pairs.length - fills;
  const parts: string[] = [];
  if (swaps > 0) parts.push(`make ${plural(swaps, "lineup change", "lineup changes")}`);
  if (fills > 0) parts.push(`fill ${plural(fills, "empty starting slot", "empty starting slots")}`);
  if (flow.unpairedLeavers.length > 0)
    parts.push(`bench ${plural(flow.unpairedLeavers.length, "starter", "starters")}`);
  if (parts.length === 0 && flow.slotMovers.length > 0)
    parts.push(`move ${plural(flow.slotMovers.length, "starter", "starters")} between slots`);
  return parts.join(" and ");
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

interface Evaluated {
  readonly a: Assignment;
  readonly starters: LineupPlayer[];
  readonly moments: PairMoments;
  readonly pwin: number;
}

/**
 * E2. Throws AnalyticsError `invalid_request` on bounds (roster size, duplicate ids, blend weight,
 * PF weight, compare pairs). Never moves a locked player; never benches a locked starter.
 */
export function analyzeLineup(req: LineupRequest): LineupData {
  const { roster, clock } = req;
  ensure(
    req.players.length >= 1 && req.players.length <= LINEUP.maxPlayers,
    "roster size out of range",
    "players",
  );
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
  const listed = req.opponent !== null && req.opponent.length > 0 ? req.opponent : null;
  const objArg = req.objective ?? "auto";
  let objective: Objective;
  let reason: string;
  if (objArg === "auto") {
    if (reading === "points_only") {
      objective = "points_only";
      reason = "auto: the points_only reading seeds by points for, so every point counts the same";
    } else {
      objective = "mean";
      reason =
        basis === "position_cv"
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
    return { a, starters, moments: mo, pwin: pWinNormal(mo) };
  };

  // the exchange rate (reading (a)): one win in PF points
  const pfRate: ModeBasis["pf_exchange_rate"] =
    reading === "points_only"
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

  // the mode (research 05 §2.2)
  const mm = meanEval.moments;
  const sd = diffSd(mm);
  const d = mm.mu_m - mm.mu_o;
  let mode: MatchupMode;
  const ctx = req.season?.pf_context ?? null;
  if (reading === "points_only" || objective === "points_only") {
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

  // current lineup and swaps
  const curA: Assignment = new Map(req.players.map((p) => [p.player_id, slotNameOf(p.slot_id)]));
  const curEval = evaluate(curA);
  const curStarters = curEval.starters;
  const recStarters = chosen.starters;
  const recIds = new Set(recStarters.map((p) => p.player_id));
  const flow = slotFlow(curA, chosen.a, curStarters, recStarters, roster);
  const byId = new Map(req.players.map((p) => [p.player_id, p]));
  const comparePairs: FlowPair[] = [];
  for (const c of req.compare ?? []) {
    const o = byId.get(c.out);
    const i = byId.get(c.in);
    if (o === undefined || i === undefined || o === i || o.locked || i.locked) continue;
    if (flow.pairs.some((p) => p.out === o && p.in === i)) continue;
    comparePairs.push({ out: o, in: i, slot: slotIn(curA, o.player_id) });
  }
  const swapRaw = [...flow.pairs, ...comparePairs].map((pr) => {
    const out = pr.out;
    const after = curStarters.filter((p) => p !== out);
    if (!after.includes(pr.in)) after.push(pr.in);
    const dp = listed === null ? 0 : pWinNormal(moments(after)) - curEval.pwin;
    let de: number;
    let interval: readonly [number, number];
    if (out === null) {
      de = pr.in.points.mean;
      interval = [round(pr.in.points.p10), round(pr.in.points.p90)];
    } else {
      de = pr.in.points.mean - out.points.mean;
      const si = sigmaOf(pr.in.points);
      const so2 = sigmaOf(out.points);
      const s = Math.sqrt(
        Math.max(0, si * si + so2 * so2 - 2 * rho(member(pr.in), member(out)) * si * so2),
      );
      interval = [round(de - Z90 * s), round(de + Z90 * s)];
    }
    return {
      out: out === null ? null : out.player_id,
      in: pr.in.player_id,
      slot: pr.slot,
      delta_e: round(de),
      dp,
      delta_pf: round(de),
      interval,
      coin_flip: isCoinFlip(basis, dp, interval),
      option_value:
        out === null
          ? null
          : optionValue({ out, in: pr.in, slot: pr.slot }, recIds, req.players, roster),
    };
  });

  // conditionals: if a starter with 0 < P(active) < 1 is ruled out, the best eligible reserve
  const conditionals: LineupData["conditionals"][number][] = [];
  for (const x of recStarters) {
    if (x.p_active === null || x.p_active <= 0 || x.p_active >= 1) continue;
    const t = lockMs(x.lock_at);
    if (t === null) continue;
    const decided = t - LINEUP.inactivesLeadMs;
    if (decided <= nowMs) continue;
    const slotName = slotIn(chosen.a, x.player_id);
    const seat = roster.slots.find((s) => s.name === slotName);
    if (seat === undefined) continue;
    const alt = req.players
      .filter(
        (y) =>
          !recIds.has(y.player_id) &&
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

  // stack flags: recommended starters sharing an NFL team with a positive-ρ pair (research 05 §3.3)
  const stackFlags: LineupData["stack_flags"][number][] = [];
  const teams = new Map<number, LineupPlayer[]>();
  for (const p of recStarters) {
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
      advice_under_reading:
        reading === "points_only"
          ? floor
            ? "points_only: comfortably above the PF cutoff — the stack's variance costs more than it adds"
            : "points_only: the stack's variance is judged against the season PF cutoff, not this opponent"
          : floor
            ? "espn_rule: as the favourite the stack's variance costs floor"
            : "espn_rule: as the underdog the stack's variance is a useful ceiling",
    });
  }
  stackFlags.sort((a, b) => a.players.join(",").localeCompare(b.players.join(",")));

  // ESPN's projection as the labelled cross-check (plan 07 C13)
  const disagreements = recStarters
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
  const movers = [...new Set([...flow.entrants, ...flow.leavers, ...flow.slotMovers])];
  const changes = flow.changes;
  const noMove = changes === 0;
  const inputs = [...(req.inputs ?? [])];

  // the Rec: Δ = recommended − current; swapped part by the normal approximation, each fill by its
  // entrant's own quantiles (a fill cannot lose points)
  const recMembers = recStarters.map(member);
  const recM = lineupMoments(recMembers);
  const curMembers = curStarters.map(member);
  const curM = lineupMoments(curMembers);
  const fills = flow.pairs.filter((pr) => pr.out === null).map((pr) => pr.in);
  const swappedMembers = recStarters.filter((p) => !fills.includes(p)).map(member);
  const swappedM = lineupMoments(swappedMembers);
  const sdSwapped = Math.sqrt(
    Math.max(0, swappedM.v + curM.v - 2 * lineupCov(swappedMembers, curMembers)),
  );
  const dMuSwapped = swappedM.mu - curM.mu;
  const fillSum = (q: (x: Dist) => number): number => fills.reduce((s, p) => s + q(p.points), 0);
  const delta = {
    value: round(recM.mu - curM.mu),
    p10: noMove ? 0 : round(dMuSwapped - Z90 * sdSwapped + fillSum((x) => x.p10)),
    p90: noMove ? 0 : round(dMuSwapped + Z90 * sdSwapped + fillSum((x) => x.p90)),
  };
  const subjects: RecSubject[] = [];
  const paired = flow.pairs.filter((pr): pr is FlowPair & { out: LineupPlayer } => pr.out !== null);
  const startOrder = [
    ...paired.map((pr) => pr.in),
    ...recStarters.filter((p) => !paired.some((pr) => pr.in === p)),
  ];
  for (const p of startOrder)
    subjects.push({
      player_id: p.player_id,
      gsis_id: p.gsis_id,
      role: "start",
      slot: slotIn(chosen.a, p.player_id),
    });
  for (const o of [...paired.map((pr) => pr.out), ...flow.unpairedLeavers])
    subjects.push({
      player_id: o.player_id,
      gsis_id: o.gsis_id,
      role: "sit",
      slot: slotIn(curA, o.player_id),
    });
  const roleGames = recStarters.map((p) => p.role_games);
  const rec: Rec = {
    action: noMove ? "keep the current lineup" : actionText(flow),
    subjects,
    lineup: assignments(chosen.a, recStarters, roster).map((s) => ({
      slot: s.slot,
      player_id: s.player_id,
    })),
    point_estimate: round(recM.mu),
    distribution: normalDist(recM.mu, Math.sqrt(recM.v), basis),
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
    recommended_lineup: view(chosen.a),
    mode,
    mode_basis: modeBasis,
    e_points_before: round(curM.mu),
    e_points_after: round(recM.mu),
    p_win_before: hasOpp ? round(curEval.pwin) : null,
    p_win_after: hasOpp ? round(chosen.pwin) : null,
    p_win_interval: hasOpp
      ? ([...pWinInterval(chosen.moments, recStarters.length + oppStarters.length)].map((x) =>
          round(x),
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
