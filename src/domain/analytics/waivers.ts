// waivers.ts — E5 `espn_analyze_waivers`, `mode: priority` (plan 07 E5, C5, C11; research 05 §1.2–
// §1.6, §4.2–§4.3, §5 K/D-ST; plan 10 A9a): value at P0 is weeks-of-usable-value on MY roster,
// Σ_w P(role holds at w) × the lineup gain over the opportunity cost (the E2 assignment with and
// without the player), on ESPN's rest-of-season projection (`value_basis: "espn_ros"`), K/D-ST on the
// implied-total bracket model with a two-week look-ahead; surplus s over the best drop (and
// s_with_ir_move when an IR move frees the seat); the premium Π(k, W) from the cold-start DP with
// its ×0.5 / ×1.5 band — a candidate inside the band is `marginal`, never a crisp claim or pass, and
// never enters `claim_list` (ADV OBJ-03, R2 nit 3); claim ⇔ s ≥ Π outside it; at k = N claim
// anything positive; the Wednesday scramble list; p_clears_to_fa with its cold-start interval.
// Cooperative over (candidate, drop) units. Pure. New here (the sibling's E5 was FAAB / K-DEF only).
import type { Clock } from "../clock.js";
import { auditIr, type RosterSeat } from "../league/roster.js";
import { nextWaiverRun, waiverOrderRuleOf } from "../league/rules.js";
import { opponentOf, teamGame } from "../league/schedule.js";
import type {
  BareText,
  InjuryStatus,
  IsoInstant,
  LeagueRules,
  ProSchedule,
  RosterSlots,
  Week,
} from "../league/types.js";
import type { Dist, ScoringSettings } from "../scoring/types.js";
import {
  DEFAULT_CV,
  POSITION_CV,
  P_ACTIVE_BY_STATUS,
  ROLE_HOLDS,
  WAIVERS,
  Z90,
} from "./constants.js";
import { loopPacer, runCooperative, type Pacer } from "./cooperative.js";
import { AnalyticsError, ensure } from "./errors.js";
import { isKdst, kdstExpectation, type KdstExpectation } from "./kdst.js";
import { fastLineupValue, seatPlan, type FastPlayer } from "./lineup.js";
import { newestAsOf } from "./inputs.js";
import { clamp, normalDist, round, zeroDist } from "./math.js";
import { positionCv, type ImpliedTotal } from "./projection.js";
import { demandOf, solvePremiumTable } from "./waiverDp.js";
import {
  CLEARS_TO_FA_MIN_COLD_WIDTH,
  PREMIUM_BAND_MULTIPLIERS,
  type Assumption,
  type ClearsToFa,
  type InputFreshness,
  type KdstDetail,
  type Rec,
  type RecSubject,
  type WaiverCandidate,
  type WaiverPhase,
  type WaiversData,
  type WaiverVerdict,
} from "./types.js";

/** One player as the waiver engine sees him (my roster or the pool). */
export interface WaiverPlayer {
  readonly player_id: number;
  readonly gsis_id: string | null;
  readonly name: BareText;
  /** ESPN display position. */
  readonly position: string;
  readonly position_id: number;
  readonly eligible_slot_ids: readonly number[];
  readonly injury_status: InjuryStatus | null;
  readonly pro_team_id: number | null;
  /** Current lineup slot (a pool player: the bench, 20). */
  readonly slot_id: number;
  /** His game this week has started: he cannot be dropped or added for this week. */
  readonly locked: boolean;
  /** ESPN `droppable` (false = on the undroppable list). */
  readonly droppable: boolean | null;
  /** Projected points per value week, aligned with the request's `weeks` (null → 0). */
  readonly weekly: readonly (number | null)[];
  readonly percent_owned: number | null;
}

/** One pool candidate. */
export interface WaiverCandidateInput extends WaiverPlayer {
  readonly status: "FREEAGENT" | "WAIVERS";
  readonly waiver_process_date: IsoInstant | null;
  readonly percent_change: number | null;
}

/** A rival's position in the order and whether a healthy player in IR blocks his adds. */
export interface WaiverRival {
  readonly team_id: number;
  readonly waiver_rank: number | null;
  readonly ir_blocked: boolean;
}

/** An E5 request (validated by the tool's zod schema; re-checked here). */
export interface WaiverRequest {
  readonly roster: RosterSlots;
  readonly rules: LeagueRules;
  readonly league_size: number;
  /** The claim week (the scoring period a claim made now first plays). */
  readonly week: Week;
  /** The value weeks, ascending, the claim week first (rules.ts `remainingWeeks`). */
  readonly weeks: readonly Week[];
  readonly mine: readonly WaiverPlayer[];
  readonly candidates: readonly WaiverCandidateInput[];
  /** My waiver rank (Standing.waiver_rank). */
  readonly k: number | null;
  readonly rivals: readonly WaiverRival[];
  readonly mode?: "auto" | "priority" | "faab";
  readonly phase?: "auto" | WaiverPhase;
  readonly positions?: readonly string[] | null;
  /** Caps the value horizon (plan 07 E5 `horizon_weeks` 1..17). */
  readonly horizon_weeks?: number;
  /** Weeks beyond this one a K/D-ST streamer is valued (default 2). */
  readonly look_ahead?: number;
  readonly include_drop?: boolean;
  /** P(alive) by week from the seeding simulator; a playoff week without one is weighted 1. */
  readonly alive_by_week?: Readonly<Record<string, number>>;
  /** The league's S (required for the K/D-ST bracket model and the QB CV). */
  readonly settings?: ScoringSettings | null;
  /** The pro schedule and implied totals for the K/D-ST model; null → ESPN's projections as given. */
  readonly kdst?: {
    readonly schedule: Pick<ProSchedule, "games" | "teams">;
    readonly implied_totals: readonly ImpliedTotal[];
  } | null;
  readonly adds_remaining?: number | null;
  readonly learned?: Partial<WaiversData["learned"]>;
  readonly clock: Clock;
  readonly pacer?: Pacer;
  readonly inputs?: readonly InputFreshness[];
}

/** E5's outcome. */
export interface WaiverOutcome {
  readonly data: WaiversData;
  readonly warnings: readonly string[];
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });
const BENCH = 20;
/** After a run, the scramble window is assumed to last this long (the phase is read from the data) [U]. */
const POST_RUN_WINDOW_MS = 24 * 3600 * 1000;
/** p_role_holds is reported for the near term only (token budget). */
const ROLE_WEEKS_REPORTED = 4;
const INVALIDATORS = Object.freeze([
  "role_change_news",
  "injury_status_change",
  "rival_claims",
  "waiver_order_change",
]);

function cvOf(
  position: string,
  positionId: number,
  settings: ScoringSettings | null | undefined,
): number {
  if (settings !== null && settings !== undefined)
    return positionCv(position, positionId, settings);
  return Object.hasOwn(POSITION_CV, position) ? (POSITION_CV[position] ?? DEFAULT_CV) : DEFAULT_CV;
}

/** P(role holds) by horizon week: the position prior decaying weekly, the first weeks discounted by injury. */
export function roleHolds(
  position: string,
  status: InjuryStatus | null,
  weeksAhead: number,
): number {
  const base = Object.hasOwn(ROLE_HOLDS.base, position)
    ? (ROLE_HOLDS.base[position] ?? ROLE_HOLDS.defaultBase)
    : ROLE_HOLDS.defaultBase;
  const pa =
    status !== null && Object.hasOwn(P_ACTIVE_BY_STATUS, status)
      ? (P_ACTIVE_BY_STATUS[status] ?? 1)
      : 1;
  const injury = 1 - (1 - pa) * ROLE_HOLDS.injuryRecovery ** weeksAhead;
  return clamp(base * ROLE_HOLDS.weeklyDecay ** weeksAhead * injury, 0, 1);
}

/** The fast kernel's view of a player in one value week. */
const eligibleCache = new WeakMap<WaiverPlayer, ReadonlySet<number>>();
function fp(p: WaiverPlayer, w: number): FastPlayer {
  let eligible = eligibleCache.get(p);
  if (eligible === undefined) {
    eligible = new Set(p.eligible_slot_ids);
    eligibleCache.set(p, eligible);
  }
  return { eligible, value: Math.max(0, p.weekly[w] ?? 0) };
}

/** The best lineup's value of a players list in one value week (locks ignored: a season view). */
function lineupValue(
  seats: readonly number[],
  players: readonly WaiverPlayer[],
  w: number,
): number {
  return fastLineupValue(
    seats,
    players.map((p) => fp(p, w)),
  );
}

/**
 * Weekly values for the waiver engine from ESPN's numbers (helper for the tools): ESPN's weekly
 * projection for the claim week, then ESPN's rest-of-season total (split (1,0), the claim week
 * included) less that week, shared evenly over the remaining weeks with a game; a bye week is 0.
 */
export function weeklyValues(
  weeks: readonly Week[],
  espnWeek: number | null,
  espnRos: number | null,
  byeWeek: number | null,
): (number | null)[] {
  const playing = weeks.map((w) => w !== byeWeek);
  const shared = weeks.filter(
    (_, i) => playing[i] === true && !(i === 0 && espnWeek !== null),
  ).length;
  const rest =
    espnRos === null ? null : Math.max(0, espnRos - (espnWeek ?? 0)) / Math.max(1, shared);
  return weeks.map((_, i) =>
    playing[i] !== true ? 0 : i === 0 && espnWeek !== null ? espnWeek : rest,
  );
}

interface Scored {
  readonly c: WaiverCandidateInput;
  readonly s: number;
  readonly sIr: number | null;
  readonly drop: WaiverPlayer | null;
  readonly value: Dist;
  readonly roles: readonly { readonly week: Week; readonly p: number }[];
  readonly kdst: KdstDetail | null;
  readonly horizon: number;
}

/**
 * E5 priority (and the K/D-ST slice in any league). Throws AnalyticsError `invalid_request` on
 * bounds, `not_in_phase` for FAAB bidding outside the K/D-ST slice (P1).
 */
export async function analyzeWaivers(req: WaiverRequest): Promise<WaiverOutcome> {
  const N = req.league_size;
  ensure(Number.isInteger(N) && N >= 2 && N <= 20, "league size out of range", "league_size");
  ensure(
    req.weeks.length >= 1 && req.weeks.length <= WAIVERS.maxWeeks,
    "value weeks out of range",
    "weeks",
  );
  ensure(req.weeks[0] === req.week, "the value weeks must start at the claim week", "weeks");
  ensure(req.candidates.length <= WAIVERS.maxCandidates, "too many candidates", "candidates");
  ensure(req.mine.length >= 1 && req.mine.length <= 60, "roster size out of range", "team_id");
  for (const p of [...req.mine, ...req.candidates])
    ensure(
      p.weekly.length === req.weeks.length,
      "weekly values must align with the value weeks",
      "weeks",
    );
  const look = req.look_ahead ?? 2;
  ensure(Number.isInteger(look) && look >= 0 && look <= 2, "look_ahead must be 0..2", "look_ahead");
  const horizonCap = req.horizon_weeks ?? req.weeks.length;
  ensure(
    Number.isInteger(horizonCap) && horizonCap >= 1 && horizonCap <= 22,
    "horizon_weeks out of range",
    "horizon_weeks",
  );
  const positions = req.positions ?? null;
  const kdstOnly = positions !== null && positions.length > 0 && positions.every((p) => isKdst(p));
  const usesBudget = req.rules.waiver.uses_budget === true;
  const modeArg = req.mode ?? "auto";
  const modeUsed = modeArg === "auto" ? (usesBudget ? "faab" : "priority") : modeArg;
  if (modeUsed === "faab" && !kdstOnly)
    throw new AnalyticsError(
      "not_in_phase",
      "FAAB bidding is a P1 capability; the K/D-ST slice works in any league",
      "mode",
    );

  const nowMs = req.clock.nowMs();
  const assumptions: Assumption[] = [];
  const warnings: string[] = [];
  const waiver = req.rules.waiver;
  const last = waiver.last_execution === null ? null : Date.parse(waiver.last_execution);
  const phase: WaiverPhase =
    req.phase !== undefined && req.phase !== "auto"
      ? req.phase
      : last !== null &&
          Number.isFinite(last) &&
          last <= nowMs &&
          nowMs - last <= POST_RUN_WINDOW_MS
        ? "post_run"
        : "pre_run";
  const next = nextWaiverRun(waiver, nowMs);
  if (next.basis !== "status")
    assumptions.push(
      A(
        "the next waiver run is not stated by ESPN: it is read from the process days (ET) or unknown",
        "status.waiverNextExecutionDate is present",
      ),
    );

  // W: the usable weeks AFTER the claim week, playoff weeks weighted by P(alive)
  const playoffWeeks = new Set(req.rules.playoffs.playoff_weeks);
  const alive = (w: Week): number => {
    const v = req.alive_by_week?.[String(w)];
    if (v !== undefined && Number.isFinite(v)) return clamp(v, 0, 1);
    return 1;
  };
  if (req.alive_by_week === undefined && req.weeks.some((w) => playoffWeeks.has(w)))
    assumptions.push(
      A(
        "playoff weeks are weighted 1: P(alive) from the seeding simulator was not given",
        "the seeding simulator runs",
      ),
    );
  const weight = req.weeks.map((w) => (playoffWeeks.has(w) ? alive(w) : 1));
  const W = req.weeks
    .slice(1)
    .reduce((s, w, i) => s + (weight[i + 1] ?? 1) * (w > req.week ? 1 : 0), 0);

  // the premium
  const orderRule = waiverOrderRuleOf(waiver);
  let k = req.k;
  if (k === null || !Number.isInteger(k) || k < 1 || k > N) {
    k = Math.ceil(N / 2);
    assumptions.push(
      A(
        `my waiver rank is unknown: the premium is read at the middle of the order (k = ${String(k)})`,
        "the standings carry waiverRank",
      ),
    );
  }
  const wEff = orderRule === "weekly_reset" ? 0 : W;
  if (orderRule === "weekly_reset")
    assumptions.push(
      A(
        "the order resets weekly: a claim costs one week of position, so the premium is 0",
        "waiverOrderReset proves to mean move-to-last",
      ),
    );
  if (orderRule === "unknown")
    assumptions.push(
      A(
        "the waiver order rule is unverified: read as move-to-last (rolling)",
        "waiverOrderReset is identified",
      ),
    );
  const atLast = k >= N;
  const tables = {
    base: solvePremiumTable({ teams: N }),
    low: solvePremiumTable({ teams: N, surplusScale: PREMIUM_BAND_MULTIPLIERS.low }),
    high: solvePremiumTable({ teams: N, surplusScale: PREMIUM_BAND_MULTIPLIERS.high }),
  };
  const premium = atLast || modeUsed === "faab" ? 0 : round(tables.base.premium(k, wEff), 3);
  const band =
    atLast || modeUsed === "faab"
      ? { low: 0, high: 0 }
      : {
          low: round(tables.low.premium(k, wEff), 3),
          high: round(tables.high.premium(k, wEff), 3),
        };
  if (atLast)
    assumptions.push(
      A("last in the order: claim anything positive (the premium is 0)", "my position improves"),
    );
  if (modeUsed === "faab")
    assumptions.push(
      A("FAAB bidding is P1: K/D-ST streamers only, no bid advice", "the FAAB engine ships"),
    );
  const perWeek = round(premium / (wEff + 1), 3);

  // the IR audit (research 05 §4.3): an open IR seat and an IR-eligible player frees a roster seat
  const seats: RosterSeat[] = req.mine.map((p) => ({
    player_id: p.player_id,
    slot_id: p.slot_id,
    eligible_slot_ids: p.eligible_slot_ids,
    injury_status: p.injury_status,
    position: p.position,
    pro_team_id: p.pro_team_id,
  }));
  const ir = auditIr(seats, req.roster);
  const irMovable =
    ir.open_slots > 0 ? req.mine.filter((p) => ir.eligible_now.includes(p.player_id)) : [];
  if (ir.invalid)
    assumptions.push(
      A(
        "my roster is invalid (a healthy player in IR): ESPN blocks every add until it is fixed",
        "the IR slot is cleared",
      ),
    );
  const active = req.mine.filter(
    (p) => req.roster.slots.find((s) => s.slot_id === p.slot_id)?.class !== "ir",
  );
  const full = active.length >= req.roster.starters + req.roster.bench;

  // K/D-ST weekly values from the bracket model when the implied totals are known
  const settings = req.settings ?? null;
  const kd = req.kdst ?? null;
  const impliedOf = new Map<string, number | null>();
  for (const r of kd?.implied_totals ?? [])
    impliedOf.set(`${String(r.week)}:${String(r.pro_team_id)}`, r.implied);
  const kdstCache = new Map<string, KdstExpectation | null>();
  const kdstOf = (p: WaiverPlayer, wi: number): KdstExpectation | null => {
    if (
      !isKdst(p.position) ||
      kd === null ||
      settings === null ||
      p.pro_team_id === null ||
      p.pro_team_id === 0
    )
      return null;
    const w = req.weeks[wi] ?? req.week;
    const key = `${String(p.player_id)}:${String(w)}`;
    const hit = kdstCache.get(key);
    if (hit !== undefined) return hit;
    const wg = kd.schedule.games.filter((g) => g.week === w);
    const g = teamGame(wg, p.pro_team_id);
    let out: KdstExpectation | null = null;
    if (g !== null) {
      const opp = opponentOf(g, p.pro_team_id);
      out = kdstExpectation(
        p.position,
        settings,
        impliedOf.get(`${String(w)}:${String(p.pro_team_id)}`) ?? null,
        impliedOf.get(`${String(w)}:${String(opp)}`) ?? null,
      );
    }
    kdstCache.set(key, out);
    return out;
  };
  const kdstWeeks = Math.min(req.weeks.length, look + 1);
  const valueWeeks = (p: WaiverPlayer): number =>
    isKdst(p.position) ? kdstWeeks : Math.min(req.weeks.length, horizonCap);
  const withModel = <T extends WaiverPlayer>(p: T): T => {
    if (!isKdst(p.position) || kd === null || settings === null) return p;
    const weekly = p.weekly.map((v, wi) => {
      if (wi >= kdstWeeks) return v;
      const e = kdstOf(p, wi);
      return e === null ? v : e.e;
    });
    return { ...p, weekly };
  };
  if (
    kd !== null &&
    settings !== null &&
    (kdstOnly || req.candidates.some((c) => isKdst(c.position)))
  )
    assumptions.push(
      A(
        "K and D/ST are valued on the implied-total bracket model under this league's S; ESPN's own K/D-ST projections are comparators",
        "the model's backtest says otherwise",
      ),
    );
  const mine = req.mine.map(withModel);
  const pool = req.candidates
    .filter((c) => positions === null || positions.length === 0 || positions.includes(c.position))
    .filter((c) => !c.locked)
    .map((c) => withModel(c));
  const lockedOut = req.candidates.length - pool.length;
  if (lockedOut > 0 && positions === null)
    warnings.push(`${String(lockedOut)} candidates skipped (game started)`);
  const activeMine = mine.filter(
    (p) => req.roster.slots.find((s) => s.slot_id === p.slot_id)?.class !== "ir",
  );
  const seatsPlan = seatPlan(req.roster);
  const base = req.weeks.map((_, wi) => lineupValue(seatsPlan, activeMine, wi));
  // drop candidates, least valuable first: equal lineup losses (bench players who never start) are
  // broken by the player's own projected total — the bench effect (research 05 §4.1)
  const own = (p: WaiverPlayer): number =>
    p.weekly.reduce<number>((a, v) => a + Math.max(0, v ?? 0), 0);
  const drops = activeMine
    .filter((p) => p.droppable !== false && !p.locked)
    .sort((a, b) => own(a) - own(b) || a.player_id - b.player_id);
  // L(R − d) per drop and week does not depend on the candidate: solved once, cooperatively (one
  // drop per step — a whole-roster precompute in one turn stalled the main loop, plan 10 A16a)
  const pacer = req.pacer ?? loopPacer(req.clock);
  const restOf = new Map<WaiverPlayer | null, { players: WaiverPlayer[]; values: number[] }>();
  restOf.set(null, { players: activeMine, values: base });
  await runCooperative(
    drops.length,
    (i) => {
      const d = drops[i];
      if (d === undefined) return;
      const players = activeMine.filter((p) => p !== d);
      restOf.set(d, {
        players,
        values: req.weeks.map((_, wi) => lineupValue(seatsPlan, players, wi)),
      });
    },
    { pacer, deadlineMs: null },
  );
  if (req.include_drop === false)
    assumptions.push(A("no drop considered: surplus is the add alone", "include_drop"));

  // per candidate: s over the best drop (or none when a seat is open), and the IR-move version.
  // The cooperative unit is one (candidate, drop) gain — H assignments — and then one assembly step
  // per candidate, so no step holds the main loop for a whole candidate's drops × weeks (A16a).
  const byDrop = full && req.include_drop !== false;
  const withIr = byDrop && irMovable.length > 0;
  // the gains each candidate needs, in order: every drop (or only "no drop"), then the IR move
  const options: readonly (WaiverPlayer | null)[] = byDrop
    ? [...drops, ...(withIr ? [null] : [])]
    : [null];
  const prepared = pool.map((c) => {
    const H = valueWeeks(c);
    const roles = req.weeks
      .slice(0, H)
      .map((w, wi) => ({ week: w, p: round(roleHolds(c.position, c.injury_status, wi), 3) }));
    const cAsBench: WaiverPlayer = { ...c, slot_id: BENCH };
    return { c, H, roles, cAsBench, gains: new Array<number>(options.length).fill(0) };
  });
  const gainWith = (cand: (typeof prepared)[number], d: WaiverPlayer | null): number => {
    const rest = restOf.get(d);
    if (rest === undefined) return 0;
    let s = 0;
    for (let wi = 0; wi < cand.H; wi++) {
      const pr = cand.roles[wi]?.p ?? 0;
      const withP = lineupValue(seatsPlan, [...rest.players, cand.cAsBench], wi);
      s += (weight[wi] ?? 1) * (pr * withP + (1 - pr) * (rest.values[wi] ?? 0) - (base[wi] ?? 0));
    }
    return s;
  };
  const scored: Scored[] = [];
  const perCandidate = options.length + 1;
  await runCooperative(
    prepared.length * perCandidate,
    (u) => {
      const cand = prepared[Math.floor(u / perCandidate)];
      const j = u % perCandidate;
      if (cand === undefined) return;
      if (j < options.length) {
        cand.gains[j] = gainWith(cand, options[j] ?? null);
        return;
      }
      const { c, H, roles, gains } = cand;
      let s: number;
      let drop: WaiverPlayer | null = null;
      if (!byDrop) s = gains[0] ?? 0;
      else {
        s = -Infinity;
        for (let di = 0; di < drops.length; di++) {
          const v = gains[di] ?? 0;
          if (v > s + 1e-12) {
            s = v;
            drop = drops[di] ?? null;
          }
        }
        if (drop === null) s = 0;
      }
      const sIr = withIr ? (gains[drops.length] ?? 0) : null;
      let mean = 0;
      let v = 0;
      const cv = cvOf(c.position, c.position_id, settings);
      for (let wi = 0; wi < H; wi++) {
        const x = Math.max(0, c.weekly[wi] ?? 0) * (roles[wi]?.p ?? 0) * (weight[wi] ?? 1);
        mean += x;
        v += (cv * x) ** 2;
      }
      let detail: KdstDetail | null = null;
      if (isKdst(c.position)) {
        const e0 = kdstOf(c, 0);
        const e1 = req.weeks.length > 1 && look >= 1 ? kdstOf(c, 1) : null;
        const w1 = req.weeks[1];
        let oppAbbrev: string | null = null;
        if (kd !== null && w1 !== undefined && c.pro_team_id !== null) {
          const g = teamGame(
            kd.schedule.games.filter((x) => x.week === w1),
            c.pro_team_id,
          );
          const oid = g === null ? null : opponentOf(g, c.pro_team_id);
          oppAbbrev =
            oid === null ? null : (kd.schedule.teams.find((t) => t.id === oid)?.abbrev ?? null);
        }
        detail = {
          implied_total: e0?.implied_total ?? null,
          opp_implied_total: e0?.opp_implied_total ?? null,
          brackets_e: e0?.brackets_e ?? null,
          sacks_e: e0?.sacks_e ?? null,
          takeaways_e: e0?.takeaways_e ?? null,
          rare_c: e0?.rare_c ?? null,
          next_week:
            w1 === undefined || look < 1
              ? null
              : {
                  opponent: oppAbbrev,
                  implied_total:
                    c.position === "K"
                      ? (e1?.implied_total ?? null)
                      : (e1?.opp_implied_total ?? null),
                  e: e1?.e ?? c.weekly[1] ?? null,
                },
        };
      }
      scored.push({
        c,
        s: round(s, 3),
        sIr: sIr === null ? null : round(sIr, 3),
        drop,
        value: mean === 0 ? zeroDist("position_cv") : normalDist(mean, Math.sqrt(v), "position_cv"),
        roles,
        kdst: detail,
        horizon: H,
      });
    },
    { pacer, deadlineMs: null },
  );

  // demand (research 05 §1.3, cold start): every rival not IR-blocked claims with q(r)
  const ahead = req.rivals.filter((r) => r.waiver_rank !== null && r.waiver_rank < k);
  const blocked = req.rivals
    .filter((r) => r.ir_blocked)
    .map((r) => r.team_id)
    .sort((a, b) => a - b);
  const able = req.rivals.filter((r) => !r.ir_blocked);
  const aheadAble = ahead.filter((r) => !r.ir_blocked).length;
  const candidates: WaiverCandidate[] = scored.map((x) => {
    const r = x.horizon > 0 ? Math.max(0, x.s) / x.horizon : 0;
    const q = demandOf(r);
    const pClear = (scale: number): number => (1 - Math.min(1, demandOf(r, scale))) ** able.length;
    let clears: ClearsToFa | null = null;
    if (x.c.status === "WAIVERS") {
      const p = pClear(1);
      let lo = pClear(WAIVERS.demandBand.high);
      let hi = pClear(WAIVERS.demandBand.low);
      if (hi - lo < CLEARS_TO_FA_MIN_COLD_WIDTH) {
        const half = CLEARS_TO_FA_MIN_COLD_WIDTH / 2;
        lo = Math.max(0, Math.min(lo, p - half));
        hi = Math.min(1, Math.max(hi, p + half));
        if (hi - lo < CLEARS_TO_FA_MIN_COLD_WIDTH) {
          if (lo === 0) hi = CLEARS_TO_FA_MIN_COLD_WIDTH;
          else lo = 1 - CLEARS_TO_FA_MIN_COLD_WIDTH;
        }
      }
      clears = {
        p: round(p, 4),
        interval: [round(Math.min(lo, p), 4), round(Math.max(hi, p), 4)],
        basis: "cold_start",
      };
    }
    const inBand = band.low < band.high && x.s >= band.low && x.s <= band.high;
    let verdict: WaiverVerdict;
    if (x.s <= 0) verdict = "pass";
    else if (x.c.status === "FREEAGENT") verdict = "fa_add_now";
    else if (inBand) verdict = "marginal";
    else if (x.s >= premium) verdict = "claim";
    else
      verdict =
        clears !== null && clears.p >= WAIVERS.faAfterRunMinClear ? "fa_add_after_run" : "pass";
    const flip =
      x.s <= 0
        ? "no lineup gain over the drop candidate in the horizon"
        : premium <= 0
          ? "any positive surplus is claimed (premium 0)"
          : x.s >= premium
            ? `P(role holds) below ×${String(round(premium / x.s, 2))} of the prior flips it to pass`
            : `needs P(role holds) ×${String(round(premium / x.s, 2))} of the prior to clear the premium`;
    const irWarn =
      x.sIr !== null
        ? "an IR move frees the seat instead: move the IR-eligible player before the run and activate him only after it (a claim fails if the bench fills first)"
        : null;
    return {
      player_id: x.c.player_id,
      name: x.c.name,
      position: x.c.position,
      status: x.c.status,
      waiver_process_date: x.c.waiver_process_date,
      signals: x.kdst !== null ? [{ kind: "stream", value: round(x.c.weekly[0] ?? 0, 2) }] : [],
      value: x.value,
      s: x.s,
      s_with_ir_move: x.sIr,
      p_role_holds: x.roles.slice(0, ROLE_WEEKS_REPORTED),
      p_k_win: x.c.status === "WAIVERS" ? round((1 - q) ** aheadAble, 4) : null,
      p_clears_to_fa: clears,
      demand: {
        rivals_upgraded: [],
        q_i: req.rivals
          .map((rv) => ({ team_id: rv.team_id, p: rv.ir_blocked ? 0 : round(q, 4) }))
          .sort((a, b) => a.team_id - b.team_id),
        percent_change: x.c.percent_change,
        competition_signal: true,
        sleeper_trend: null,
        rivals_ir_blocked: blocked,
      },
      verdict,
      claim_rank: null,
      conditional_drop:
        x.drop === null
          ? null
          : {
              player_id: x.drop.player_id,
              name: x.drop.name,
              value_ros: dropValue(x.drop, req.weeks.length, settings),
              re_add_risk: { percent_owned: x.drop.percent_owned, rivals_claiming: null },
              is_ir_move: false,
              activation_warning: irWarn,
            },
      flip_driver: flip,
      invalidators: INVALIDATORS,
      kdst: x.kdst,
    };
  });
  const bySurplus = (a: WaiverCandidate, b: WaiverCandidate): number =>
    b.s - a.s || a.player_id - b.player_id;
  candidates.sort(bySurplus);
  const claims = candidates.filter((c) => c.verdict === "claim");
  const ranked = candidates.map((c) =>
    c.verdict === "claim" ? { ...c, claim_rank: claims.indexOf(c) + 1 } : c,
  );
  const marginal = ranked.filter((c) => c.verdict === "marginal").map((c) => c.player_id);
  const scramble = ranked
    .filter(
      (c) =>
        (c.status === "WAIVERS" &&
          c.verdict !== "pass" &&
          (c.p_clears_to_fa?.p ?? 0) >= WAIVERS.scrambleMinClear) ||
        (phase === "post_run" && c.verdict === "fa_add_now"),
    )
    .map((c) => c.player_id);

  // hold vs stream (K/D-ST slice): the best streamer against my starter, over the look-ahead
  let holdVsStream: WaiversData["hold_vs_stream"] = null;
  if (kdstOnly) {
    let best: { delta: number; streamability: number } | null = null;
    for (const pos of positions) {
      const starter = mine
        .filter(
          (p) =>
            p.position === pos &&
            req.roster.slots.find((s) => s.slot_id === p.slot_id)?.class === "starter",
        )
        .sort((a, b) => (b.weekly[0] ?? 0) - (a.weekly[0] ?? 0))[0];
      const cands = pool.filter((c) => c.position === pos);
      if (cands.length === 0) continue;
      let ok = 0;
      for (let wi = 0; wi < kdstWeeks; wi++) {
        const top = Math.max(...cands.map((c) => c.weekly[wi] ?? 0));
        if (top >= (starter?.weekly[wi] ?? 0) - 1) ok += 1;
      }
      const delta = Math.max(...cands.map((c) => c.weekly[0] ?? 0)) - (starter?.weekly[0] ?? 0);
      if (best === null || delta > best.delta) best = { delta, streamability: ok / kdstWeeks };
    }
    holdVsStream =
      best === null
        ? null
        : {
            streamability: round(best.streamability, 3),
            current_starter_delta: round(best.delta, 3),
          };
  }

  const learned = {
    second_claim_at_new_position: req.learned?.second_claim_at_new_position ?? null,
    unowned_to_waivers_at_kickoff: req.learned?.unowned_to_waivers_at_kickoff ?? null,
    order_reset_rule: req.learned?.order_reset_rule ?? null,
  };
  const inputs = [...(req.inputs ?? [])];
  const top =
    ranked.find((c) => c.verdict === "claim") ??
    ranked.find((c) => c.verdict === "fa_add_now") ??
    null;
  const adds = ranked.filter((c) => c.verdict === "fa_add_now");
  const subjects: RecSubject[] = [];
  for (const c of [...ranked.filter((x) => x.verdict === "claim"), ...adds]) {
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
  const parts: string[] = [];
  if (claims.length > 0)
    parts.push(`submit ${String(claims.length)} ordered claim${claims.length === 1 ? "" : "s"}`);
  if (adds.length > 0)
    parts.push(`add ${String(adds.length)} free agent${adds.length === 1 ? "" : "s"} now`);
  if (marginal.length > 0) parts.push(`${String(marginal.length)} marginal (your call)`);
  if (scramble.length > 0 && phase === "pre_run")
    parts.push(`${String(scramble.length)} on the scramble list after the run`);
  const noMove = claims.length === 0 && adds.length === 0;
  const sd = top === null ? 0 : (top.value.p90 - top.value.p10) / (2 * Z90);
  const rec: Rec = {
    action: noMove
      ? parts.length > 0
        ? `no clear move: ${parts.join("; ")}`
        : "no claim clears the premium"
      : parts.join("; "),
    subjects,
    lineup: null,
    point_estimate: top === null ? 0 : top.s,
    distribution: top === null ? zeroDist("position_cv") : top.value,
    delta_vs_next: {
      value: top === null ? 0 : round(top.s - premium, 3),
      p10: top === null ? 0 : round(top.s - premium - Z90 * sd, 3),
      p90: top === null ? 0 : round(top.s - premium + Z90 * sd, 3),
    },
    decision_metric: "surplus_vs_premium",
    drivers: [
      { name: "premium", contribution: -premium },
      ...ranked
        .slice(0, 3)
        .map((c) => ({ name: `surplus:${String(c.player_id)}`, contribution: c.s })),
    ],
    assumptions,
    confidence: { role_games: 0, inputs },
    as_of: newestAsOf(inputs, req.clock.nowIso()),
    latest_execution_time: noMove ? null : claims.length > 0 ? next.at : null,
    no_move: noMove,
    log_id: null,
  };
  return {
    data: {
      mode_used: modeUsed,
      phase,
      next_run_at: next.at,
      last_run_at: waiver.last_execution,
      k: req.k,
      W: round(wEff, 3),
      premium,
      premium_band: band,
      premium_basis: "cold_start_table",
      per_week_threshold: perWeek,
      value_basis: "espn_ros",
      candidates: ranked,
      claim_list: claims.map((c) => c.player_id),
      marginal,
      scramble_list: scramble,
      hold_vs_stream: holdVsStream,
      adds_remaining: req.adds_remaining ?? null,
      faab: null,
      learned,
      rec,
      inputs,
    },
    warnings,
  };
}

function dropValue(p: WaiverPlayer, weeks: number, settings: ScoringSettings | null): Dist {
  let mean = 0;
  let v = 0;
  const cv = cvOf(p.position, p.position_id, settings);
  for (let wi = 0; wi < weeks; wi++) {
    const x = Math.max(0, p.weekly[wi] ?? 0);
    mean += x;
    v += (cv * x) ** 2;
  }
  return mean === 0 ? zeroDist("position_cv") : normalDist(mean, Math.sqrt(v), "position_cv");
}
