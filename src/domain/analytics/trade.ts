// trade.ts — E6 `espn_analyze_trade` (plan 07 E6; plan 10 B5 hard parts; research 05 §5 Trades, §2.2;
// sib research 05 §5.1–§5.7, §14.4, §14.6): Δ for each side is the change in expected LINEUP points
// over the horizon, Σ_w weight(w) × [L(after, w) − L(before, w)] with L the E2 assignment on the
// actual roster (sib §5.1), weight = P(side alive at w) on playoff weeks; roster spots are priced —
// an uneven trade always names the implied drop of the side that receives more (sib §5.2: computed
// from the actual drop, never a chart haircut), and a seat it frees is filled from the wire when
// the wire is given (research 05 §5: the 10-team wire is rich); injury risk as a multiplier on each
// week, reported separately (sib §5.4); Δ simulated on common random numbers for its [p10, p90]
// interval; `verdict: fair` iff that interval spans 0 (sib §14.4); Δ → ΔU through the seeding
// simulator's marginal values under the configured reading, and under both when `both` is passed
// explicitly (ADV OBJ-13; research 05 §2.4); the deadline from `tradeSettings.deadlineDate`; veto as
// a risk, never a value (sib §14.6); ESPN's auction value as a labelled comparator, never Δ. The
// partner's `tradeBlock` is untrusted text and is not an input at all (research 05 §6 case 4).
// Partner search: the partner's weakest starting position and the proposal maximising Δ_me subject
// to Δ_partner ≥ ε (sib §5.7). Cooperative over Monte-Carlo paths. Pure. New here.
import type { Clock, Rng } from "../clock.js";
import type { SeedingMode } from "../../config/schema.js";
import { tradeDeadlineStatus } from "../league/rules.js";
import { slotClassOf } from "../league/slots.js";
import type { BareText, LeagueRules, RosterSlots, UntrustedText, Week } from "../league/types.js";
import { isIrEligible } from "../league/types.js";
import { P_ACTIVE_BY_STATUS } from "./constants.js";
import { loopPacer, runCooperative, type Pacer } from "./cooperative.js";
import { AnalyticsError, ensure } from "./errors.js";
import { newestAsOf } from "./inputs.js";
import { fastLineupValue, seatPlan, type FastPlayer } from "./lineup.js";
import { TRADE } from "./marketConstants.js";
import { distFromSamples, gammaMultiplier, normalDist, round, sigmaOf } from "./math.js";
import {
  PF_PER_WIN_COLD_START,
  seedingStatus,
  type Assumption,
  type DeltaU,
  type Dist,
  type InputFreshness,
  type MarginalValue,
  type Rec,
  type RecSubject,
  type SeasonReading,
  type TradeData,
  type TradeEvaluationData,
  type TradePartnersData,
} from "./types.js";

/** One player as the trade engine sees him (either roster, or the wire). */
export interface TradePlayer {
  readonly player_id: number;
  readonly gsis_id: string | null;
  readonly name: BareText;
  readonly position: string;
  readonly eligible_slot_ids: readonly number[];
  readonly injury_status: string | null;
  /** Current slot id (a wire player: the bench, 20). */
  readonly slot_id: number;
  readonly droppable: boolean | null;
  /** Projected points per value week, aligned with the request's `weeks` (null → 0; bye → 0). */
  readonly weekly: readonly (number | null)[];
  readonly bye_week: Week | null;
  /** ESPN `ownership.auctionValueAverage` — a crowd comparator, never Δ. */
  readonly auction_value_average: number | null;
}

/** One team: its roster and the seeding simulator's view of it. */
export interface TradeTeam {
  readonly team_id: number;
  readonly name: UntrustedText;
  readonly players: readonly TradePlayer[];
  /** E3 `season` readings with this team as `me` (marginal values on); null → cold start. */
  readonly readings?: readonly SeasonReading[] | null;
  /** P(this team alive) by playoff week (string keys); a playoff week without one is weighted 1. */
  readonly alive_by_week?: Readonly<Record<string, number>>;
}

/** An E6 request (validated by the tool's zod schema; re-checked here). */
export interface TradeRequest {
  readonly roster: RosterSlots;
  readonly rules: LeagueRules;
  /** The value weeks, ascending — the first week the traded players can play first. */
  readonly weeks: readonly Week[];
  readonly me: TradeTeam;
  /** Every other team (the partner is found by id). */
  readonly teams: readonly TradeTeam[];
  readonly offer?: {
    readonly partner_team_id: number;
    readonly give: readonly number[];
    readonly get: readonly number[];
  } | null;
  readonly find_partners?: {
    readonly need_position: string;
    readonly max_partners?: number;
  } | null;
  readonly horizon?: "ros" | "playoffs";
  readonly seeding_mode?: "config" | "both";
  readonly seeding_config: { readonly mode: SeedingMode; readonly confirmed_at: string | null };
  /** The best available players (the wire) — a seat a trade frees is filled from here. */
  readonly free_agents?: readonly TradePlayer[];
  readonly n_sims?: number;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly pacer?: Pacer;
  readonly inputs?: readonly InputFreshness[];
}

/** E6's outcome. */
export interface TradeOutcome {
  readonly data: TradeData;
  readonly warnings: readonly string[];
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });
const BENCH = 20;
const IR = 21;
const own = (p: TradePlayer): number =>
  p.weekly.reduce<number>((s, v) => s + Math.max(0, v ?? 0), 0);
const asc = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

/** Health-adjusted availability of a player in value week `wi` (sib §5.4; the roleHolds rule). */
export function availability(
  p: Pick<TradePlayer, "position" | "injury_status">,
  wi: number,
): number {
  const miss = Object.hasOwn(TRADE.weeklyMiss, p.position)
    ? (TRADE.weeklyMiss[p.position] ?? TRADE.defaultWeeklyMiss)
    : TRADE.defaultWeeklyMiss;
  const status = p.injury_status;
  const pa =
    status !== null && Object.hasOwn(P_ACTIVE_BY_STATUS, status)
      ? (P_ACTIVE_BY_STATUS[status] ?? 1)
      : 1;
  const injury = 1 - (1 - pa) * TRADE.injuryRecovery ** wi;
  return injury * (wi === 0 ? 1 : 1 - miss);
}

const rosCv = (position: string): number =>
  Object.hasOwn(TRADE.rosCv, position)
    ? (TRADE.rosCv[position] ?? TRADE.defaultRosCv)
    : TRADE.defaultRosCv;

/** How a lineup is valued in a pass: health on/off, and per-player multipliers (a MC path). */
interface Pass {
  readonly health: boolean;
  readonly mult: ReadonlyMap<number, number> | null;
}

interface Ctx {
  readonly seats: readonly number[];
  readonly weeks: readonly Week[];
  readonly capacity: number;
  readonly irSeats: number;
  readonly eligible: Map<TradePlayer, ReadonlySet<number>>;
}

function fastOf(ctx: Ctx, p: TradePlayer, wi: number, pass: Pass): FastPlayer {
  let eligible = ctx.eligible.get(p);
  if (eligible === undefined) {
    eligible = new Set(p.eligible_slot_ids);
    ctx.eligible.set(p, eligible);
  }
  const base = Math.max(0, p.weekly[wi] ?? 0);
  const h = pass.health ? availability(p, wi) : 1;
  const m = pass.mult?.get(p.player_id) ?? 1;
  return { eligible, value: base * h * m };
}

/** The active (non-IR) players of a roster. */
const activeOf = (players: readonly TradePlayer[]): TradePlayer[] =>
  players.filter((p) => slotClassOf(p.slot_id) !== "ir");

/** L(players, w) for every value week. */
function lineupWeeks(ctx: Ctx, players: readonly TradePlayer[], pass: Pass): number[] {
  const act = activeOf(players);
  return ctx.weeks.map((_, wi) =>
    fastLineupValue(
      ctx.seats,
      act.map((p) => fastOf(ctx, p, wi, pass)),
    ),
  );
}

/** One side's roster change: the roster after, the drops, the wire fills. */
interface SideAfter {
  readonly after: TradePlayer[];
  readonly drops: readonly { readonly player: TradePlayer; readonly value: number }[];
  /** Uneven trade with an open seat: the player cut on the next add (not inside Δ). */
  readonly next_cut: { readonly player: TradePlayer; readonly value: number } | null;
  readonly fills: readonly TradePlayer[];
}

const weighted = (values: readonly number[], weight: readonly number[]): number =>
  values.reduce((s, v, i) => s + v * (weight[i] ?? 1), 0);

/**
 * The cheapest player to cut from `players` (least weighted lineup loss; ties by own total, then
 * id), never one of `keep`; undroppable players only when nothing else is left.
 */
function cheapestCut(
  ctx: Ctx,
  players: readonly TradePlayer[],
  keep: ReadonlySet<number>,
  weight: readonly number[],
): { player: TradePlayer; value: number } | null {
  const act = activeOf(players);
  const baseV = weighted(lineupWeeks(ctx, act, { health: true, mult: null }), weight);
  const pool = act.filter((p) => !keep.has(p.player_id));
  const droppable = pool.filter((p) => p.droppable !== false);
  const cands = droppable.length > 0 ? droppable : pool;
  let best: { player: TradePlayer; value: number; own: number } | null = null;
  for (const p of cands) {
    const rest = act.filter((x) => x !== p);
    const loss = baseV - weighted(lineupWeeks(ctx, rest, { health: true, mult: null }), weight);
    const o = own(p);
    if (
      best === null ||
      loss < best.value - 1e-9 ||
      (Math.abs(loss - best.value) <= 1e-9 &&
        (o < best.own || (o === best.own && p.player_id < best.player.player_id)))
    )
      best = { player: p, value: loss, own: o };
  }
  return best === null ? null : { player: best.player, value: round(best.value, 3) };
}

/** The roster after giving `out` and receiving `inc`: received IR-eligible players use open IR seats. */
function sideAfter(
  ctx: Ctx,
  before: readonly TradePlayer[],
  out: ReadonlySet<number>,
  inc: readonly TradePlayer[],
  weight: readonly number[],
  wire: readonly TradePlayer[],
): SideAfter {
  const kept = before.filter((p) => !out.has(p.player_id));
  let irUsed = kept.filter((p) => slotClassOf(p.slot_id) === "ir").length;
  const received = inc.map((p) => {
    if (isIrEligible(p.injury_status) && p.eligible_slot_ids.includes(IR) && irUsed < ctx.irSeats) {
      irUsed += 1;
      return { ...p, slot_id: IR };
    }
    return { ...p, slot_id: BENCH };
  });
  let after = [...kept, ...received];
  const keep = new Set(received.map((p) => p.player_id));
  const drops: { player: TradePlayer; value: number }[] = [];
  while (activeOf(after).length > ctx.capacity) {
    const cut = cheapestCut(ctx, after, keep, weight);
    if (cut === null) break;
    drops.push(cut);
    after = after.filter((p) => p !== cut.player);
  }
  const uneven = inc.length > out.size;
  const nextCut = uneven && drops.length === 0 ? cheapestCut(ctx, after, keep, weight) : null;
  // a seat freed by the trade (fewer active players than before, below capacity) is filled from the wire
  const fills: TradePlayer[] = [];
  const freed = Math.min(
    ctx.capacity - activeOf(after).length,
    activeOf(before).length - activeOf(after).length,
  );
  const used = new Set<number>();
  for (let f = 0; f < freed; f++) {
    const cur = weighted(lineupWeeks(ctx, after, { health: true, mult: null }), weight);
    let best: { p: TradePlayer; gain: number } | null = null;
    for (const w of wire) {
      if (used.has(w.player_id) || after.some((x) => x.player_id === w.player_id)) continue;
      const gain =
        weighted(
          lineupWeeks(ctx, [...after, { ...w, slot_id: BENCH }], { health: true, mult: null }),
          weight,
        ) - cur;
      if (gain > 1e-9 && (best === null || gain > best.gain + 1e-12)) best = { p: w, gain };
    }
    if (best === null) break;
    used.add(best.p.player_id);
    const filled = { ...best.p, slot_id: BENCH };
    fills.push(filled);
    after = [...after, filled];
  }
  return { after, drops, next_cut: nextCut, fills };
}

/** The value weights of a team: playoff weeks by P(alive) (1 when not given); `playoffs` horizon → only those. */
function weightsOf(
  weeks: readonly Week[],
  rules: LeagueRules,
  team: TradeTeam,
  horizon: "ros" | "playoffs",
): number[] {
  const playoff = new Set(rules.playoffs.playoff_weeks);
  return weeks.map((w) => {
    if (!playoff.has(w)) return horizon === "playoffs" ? 0 : 1;
    const v = team.alive_by_week?.[String(w)];
    return v !== undefined && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  });
}

interface SideEval {
  readonly delta: number;
  readonly raw: number;
  readonly weekly: number[];
  readonly after: SideAfter;
  readonly beforeVals: number[];
  readonly afterVals: number[];
}

function evalSide(
  ctx: Ctx,
  before: readonly TradePlayer[],
  out: ReadonlySet<number>,
  inc: readonly TradePlayer[],
  weight: readonly number[],
  wire: readonly TradePlayer[],
): SideEval {
  const after = sideAfter(ctx, before, out, inc, weight, wire);
  const healthy: Pass = { health: true, mult: null };
  const rawPass: Pass = { health: false, mult: null };
  const b = lineupWeeks(ctx, before, healthy);
  const a = lineupWeeks(ctx, after.after, healthy);
  const weekly = a.map((v, i) => (v - (b[i] ?? 0)) * (weight[i] ?? 1));
  const delta = weekly.reduce((s, v) => s + v, 0);
  const raw =
    weighted(lineupWeeks(ctx, after.after, rawPass), weight) -
    weighted(lineupWeeks(ctx, before, rawPass), weight);
  return { delta, raw, weekly, after, beforeVals: b, afterVals: a };
}

/** ΔU of one side under one reading: the +3 points-per-week marginal scaled linearly (research 05 §2.4). */
function deltaUOf(
  reading: SeasonReading | undefined,
  regDelta: number,
  regWeeks: number,
): MarginalValue {
  if (regWeeks <= 0) return { d_p_playoffs: 0, d_p_bye: 0 };
  if (reading === undefined) {
    const wins = regDelta / PF_PER_WIN_COLD_START;
    return {
      d_p_playoffs: round(wins * TRADE.coldDpPlayoffsPerWin, 4),
      d_p_bye: round(wins * TRADE.coldDpByePerWin, 4),
    };
  }
  const scale = regDelta / regWeeks / 3;
  const mv = reading.marginal_values.plus_3_ppw;
  const clampTo = (d: number, p: number): number => round(Math.min(1 - p, Math.max(-p, d)), 4);
  return {
    d_p_playoffs: clampTo(scale * mv.d_p_playoffs, reading.p_playoffs),
    d_p_bye: clampTo(scale * mv.d_p_bye, reading.p_bye),
  };
}

function readingsToRun(req: TradeRequest): SeedingMode[] {
  return req.seeding_mode === "both" ? ["espn_rule", "points_only"] : [req.seeding_config.mode];
}

function deltaU(req: TradeRequest, partner: TradeTeam, me: SideEval, pe: SideEval): DeltaU {
  const regular = req.weeks.map((w) => !req.rules.playoffs.playoff_weeks.includes(w));
  const regWeeks = regular.filter(Boolean).length;
  const reg = (e: SideEval): number =>
    e.weekly.reduce((s, v, i) => s + (regular[i] === true ? v : 0), 0);
  const modes = readingsToRun(req);
  const rows = modes.map((mode) => ({
    seeding_mode: mode,
    me: deltaUOf(
      req.me.readings?.find((r) => r.seeding_mode === mode),
      reg(me),
      regWeeks,
    ),
    partner: deltaUOf(
      partner.readings?.find((r) => r.seeding_mode === mode),
      reg(pe),
      regWeeks,
    ),
  }));
  const cfg = rows.find((r) => r.seeding_mode === req.seeding_config.mode) ?? rows[0];
  const sim = modes.every(
    (m) =>
      req.me.readings?.some((r) => r.seeding_mode === m) === true &&
      partner.readings?.some((r) => r.seeding_mode === m) === true,
  );
  return {
    me: cfg?.me ?? { d_p_playoffs: 0, d_p_bye: 0 },
    partner: cfg?.partner ?? { d_p_playoffs: 0, d_p_bye: 0 },
    reading: req.seeding_mode === "both" ? "both" : req.seeding_config.mode,
    basis: sim ? "season_sim" : "cold_start",
    by_reading: rows,
  };
}

/** The fields a depth comparison reads (a trade player, an activity rival's player). */
export type DepthPlayer = Pick<TradePlayer, "position" | "slot_id" | "weekly">;

/**
 * Each starting position's gap to the league median at the same depth (the mean of a team's top-n
 * active players at the position, n = its starting seats), largest gap first (ties by name).
 */
export function positionGaps(
  team: readonly DepthPlayer[],
  league: readonly (readonly DepthPlayer[])[],
  roster: RosterSlots,
): { readonly position: string; readonly gap: number }[] {
  const counts = new Map<string, number>();
  for (const s of roster.slots) {
    if (s.class !== "starter") continue;
    const pos = startPosition(s.slot_id);
    if (pos !== null) counts.set(pos, (counts.get(pos) ?? 0) + s.count);
  }
  const total = (p: DepthPlayer): number =>
    p.weekly.reduce<number>((s, v) => s + Math.max(0, v ?? 0), 0);
  const out: { position: string; gap: number }[] = [];
  for (const [pos, n] of counts) {
    const depth = (players: readonly DepthPlayer[]): number => {
      const vals = players
        .filter((p) => slotClassOf(p.slot_id) !== "ir" && p.position === pos)
        .map(total)
        .sort((a, b) => b - a);
      return vals.slice(0, n).reduce((s, v) => s + v, 0) / n;
    };
    const mine = depth(team);
    const all = league.map(depth).sort((a, b) => a - b);
    const median = all.length === 0 ? mine : (all[Math.floor((all.length - 1) / 2)] ?? mine);
    out.push({ position: pos, gap: round(median - mine, 3) });
  }
  return out.sort((a, b) => b.gap - a.gap || (a.position < b.position ? -1 : 1));
}

/** A team's weakest starting position: the largest gap to the league median at the same depth. */
export function weakestPosition(
  team: readonly DepthPlayer[],
  league: readonly (readonly DepthPlayer[])[],
  roster: RosterSlots,
): string | null {
  return positionGaps(team, league, roster)[0]?.position ?? null;
}

const START_POSITIONS: Readonly<Record<number, string>> = Object.freeze({
  0: "QB",
  2: "RB",
  4: "WR",
  6: "TE",
  16: "D/ST",
  17: "K",
});
const startPosition = (slotId: number): string | null => START_POSITIONS[slotId] ?? null;

function findPlayers(players: readonly TradePlayer[], ids: readonly number[]): TradePlayer[] {
  return ids.map((id) => {
    const p = players.find((x) => x.player_id === id);
    if (p === undefined)
      throw new AnalyticsError("invalid_request", "a traded player is not on that roster", "offer");
    return p;
  });
}

function validate(req: TradeRequest): void {
  ensure(req.weeks.length >= 1 && req.weeks.length <= 22, "value weeks out of range", "weeks");
  ensure(
    req.weeks.every((w, i) => i === 0 || w > (req.weeks[i - 1] ?? 0)),
    "value weeks must ascend",
    "weeks",
  );
  for (const t of [req.me, ...req.teams])
    for (const p of t.players)
      ensure(
        p.weekly.length === req.weeks.length,
        "weekly values must align with the weeks",
        "weeks",
      );
  for (const p of req.free_agents ?? [])
    ensure(
      p.weekly.length === req.weeks.length,
      "weekly values must align with the weeks",
      "weeks",
    );
  const hasOffer = req.offer !== undefined && req.offer !== null;
  const hasSearch = req.find_partners !== undefined && req.find_partners !== null;
  ensure(hasOffer !== hasSearch, "exactly one of offer and find_partners", "offer");
  ensure(
    req.me.players.length >= 1 && req.me.players.length <= 60,
    "roster size out of range",
    "team_id",
  );
}

/** E6. Throws AnalyticsError `invalid_request` on a malformed offer or search. */
export async function analyzeTrade(req: TradeRequest): Promise<TradeOutcome> {
  validate(req);
  const ctx: Ctx = {
    seats: seatPlan(req.roster),
    weeks: req.weeks,
    capacity: req.roster.starters + req.roster.bench,
    irSeats: req.roster.ir,
    eligible: new Map(),
  };
  const horizon = req.horizon ?? "ros";
  const nowMs = req.clock.nowMs();
  const dl = tradeDeadlineStatus(req.rules.trade, nowMs);
  const assumptions: Assumption[] = [];
  const warnings: string[] = [];
  if (dl.deadline === null)
    assumptions.push(A("the league states no trade deadline", "tradeSettings.deadlineDate is set"));
  else if (dl.passed === true)
    assumptions.push(A("the trade deadline has passed: no trade can be made", "never (read-only)"));
  if (horizon === "playoffs") assumptions.push(A("only playoff weeks are valued", "horizon: ros"));
  assumptions.push(
    A(
      "injury risk is a per-week availability multiplier by position and ESPN status (reported as health_adjustment)",
      "a per-player injury model ships",
    ),
  );
  if ((req.free_agents ?? []).length === 0)
    assumptions.push(
      A(
        "a seat the trade frees is valued at 0 (no wire given)",
        "the wire is passed as free_agents",
      ),
    );
  const pacer = req.pacer ?? loopPacer(req.clock);
  return req.offer !== undefined && req.offer !== null
    ? evaluateOffer(
        req,
        req.offer,
        ctx,
        horizon,
        dl.deadline,
        dl.passed === true,
        assumptions,
        warnings,
        pacer,
      )
    : searchPartners(req, ctx, horizon, dl.deadline, dl.passed === true, assumptions, warnings);
}

async function evaluateOffer(
  req: TradeRequest,
  offer: NonNullable<TradeRequest["offer"]>,
  ctx: Ctx,
  horizon: "ros" | "playoffs",
  deadline: string | null,
  passed: boolean,
  assumptions: Assumption[],
  warnings: string[],
  pacer: Pacer,
): Promise<TradeOutcome> {
  const partner = req.teams.find((t) => t.team_id === offer.partner_team_id);
  if (partner === undefined || partner.team_id === req.me.team_id)
    throw new AnalyticsError("invalid_request", "the partner team is not in the league", "offer");
  for (const side of [offer.give, offer.get]) {
    ensure(
      side.length >= 1 && side.length <= TRADE.maxPlayersPerSide,
      "a trade side holds 1..6 players",
      "offer",
    );
    ensure(new Set(side).size === side.length, "a player is listed twice", "offer");
  }
  const give = findPlayers(req.me.players, offer.give);
  const get = findPlayers(partner.players, offer.get);
  const wire = req.free_agents ?? [];
  const wMe = weightsOf(req.weeks, req.rules, req.me, horizon);
  const wP = weightsOf(req.weeks, req.rules, partner, horizon);
  const giveIds = new Set(offer.give);
  const getIds = new Set(offer.get);
  const me = evalSide(ctx, req.me.players, giveIds, get, wMe, wire);
  const pe = evalSide(ctx, partner.players, getIds, give, wP, wire);

  // Monte Carlo on common random numbers (the drops and fills held at their deterministic choice)
  const nSims = Math.max(20, Math.min(2000, req.n_sims ?? TRADE.nSims));
  const everyone = [
    ...new Map(
      [...req.me.players, ...partner.players, ...me.after.fills, ...pe.after.fills].map((p) => [
        p.player_id,
        p,
      ]),
    ).values(),
  ].sort((a, b) => a.player_id - b.player_id);
  const rng = req.rng.fork("trade");
  const sMe: number[] = [];
  const sP: number[] = [];
  await runCooperative(
    nSims,
    () => {
      const mult = new Map<number, number>();
      for (const p of everyone) mult.set(p.player_id, gammaMultiplier(rng, rosCv(p.position)));
      const pass: Pass = { health: true, mult };
      const dm =
        weighted(lineupWeeks(ctx, me.after.after, pass), wMe) -
        weighted(lineupWeeks(ctx, req.me.players, pass), wMe);
      const dp =
        weighted(lineupWeeks(ctx, pe.after.after, pass), wP) -
        weighted(lineupWeeks(ctx, partner.players, pass), wP);
      sMe.push(dm);
      sP.push(dp);
    },
    { pacer, deadlineMs: null },
  );
  const deltaMe = distFromSamples(sMe, "position_cv", me.delta);
  const deltaPartner = distFromSamples(sP, "position_cv", pe.delta);

  // verdict: fair iff [p10, p90] spans 0 (sib §14.4; plan 10 B5)
  const spans = deltaMe.p10 <= 0 && deltaMe.p90 >= 0;
  const counters =
    spans || deltaMe.p90 < 0
      ? counterOffers(req, ctx, partner, offer, wMe, wP, deltaMe, deltaPartner)
      : [];
  const verdict: TradeEvaluationData["verdict"] = spans
    ? "fair"
    : deltaMe.p10 > 0
      ? "accept"
      : counters.length > 0
        ? "counter"
        : "decline";

  const uneven = offer.give.length !== offer.get.length;
  const receiving = offer.get.length > offer.give.length ? "me" : "partner";
  const side = receiving === "me" ? me : pe;
  const forced = side.after.drops[0] ?? null;
  const cut = forced ?? side.after.next_cut;
  const impliedDrop: TradeEvaluationData["implied_drop"] =
    uneven && cut !== null
      ? {
          side: receiving,
          player_id: cut.player.player_id,
          name: cut.player.name,
          value: cut.value,
          forced: forced !== null,
        }
      : null;
  if (uneven && impliedDrop === null)
    warnings.push("an uneven trade with no player left to cut: the implied drop is unknown");
  if (me.after.drops.length + pe.after.drops.length > 1)
    assumptions.push(
      A(
        "more than one forced drop: each side's cheapest players beyond the first are cut too",
        "an even trade is proposed",
      ),
    );

  const du = deltaU(req, partner, me, pe);
  if (du.basis === "cold_start")
    assumptions.push(
      A(
        `ΔU at cold start: ${String(PF_PER_WIN_COLD_START)} points per win and a bubble slope (the seeding simulator was not run for both teams)`,
        "the seeding simulator runs for both teams",
      ),
    );
  else
    assumptions.push(
      A(
        "ΔU scales the seeding simulator's +3 points-per-week marginal value linearly",
        "a re-run of the simulator on the traded rosters",
      ),
    );

  const playoff = new Set(req.rules.playoffs.playoff_weeks);
  const weekly_impact = req.weeks.map((w, i) => ({
    week: w,
    me: round(me.weekly[i] ?? 0, 3),
    partner: round(pe.weekly[i] ?? 0, 3),
  }));
  const playoffImpact = {
    me: round(
      weekly_impact.filter((x) => playoff.has(x.week)).reduce((s, x) => s + x.me, 0),
      3,
    ),
    partner: round(
      weekly_impact.filter((x) => playoff.has(x.week)).reduce((s, x) => s + x.partner, 0),
      3,
    ),
  };

  // byes: an acquired player sharing a bye week with a same-position player I keep
  const conflicts = new Map<number, Set<number>>();
  const horizonWeeks = new Set(req.weeks);
  for (const a of get) {
    if (a.bye_week === null || !horizonWeeks.has(a.bye_week)) continue;
    const others = me.after.after.filter(
      (p) => p.player_id !== a.player_id && p.position === a.position && p.bye_week === a.bye_week,
    );
    if (others.length === 0) continue;
    const set = conflicts.get(a.bye_week) ?? new Set<number>();
    set.add(a.player_id);
    for (const o of others) set.add(o.player_id);
    conflicts.set(a.bye_week, set);
  }
  const bye_conflicts = [...conflicts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, ids]) => ({ week, player_ids: asc([...ids]) }));

  const veto =
    req.rules.trade.veto_votes_required === null
      ? null
      : {
          votes_required: req.rules.trade.veto_votes_required,
          risk: vetoRisk(req.rules.trade.veto_votes_required, me.delta, pe.delta),
        };
  const auction = (ps: readonly TradePlayer[]): number | null =>
    ps.every((p) => p.auction_value_average !== null && Number.isFinite(p.auction_value_average))
      ? round(
          ps.reduce((s, p) => s + (p.auction_value_average ?? 0), 0),
          2,
        )
      : null;
  const aGive = auction(give);
  const aGet = auction(get);
  const crowd =
    aGive === null || aGet === null ? null : { auction_value_average: { give: aGive, get: aGet } };

  const why = whyTheyAccept(req, partner, pe, du, get, give);
  const seeding = seedingStatus(du.reading, req.seeding_config.confirmed_at);

  // the recommendation
  const subjects: RecSubject[] = [
    ...asc(offer.get).map((id) => ({
      player_id: id,
      gsis_id: null,
      role: "trade_in" as const,
      slot: null,
    })),
    ...asc(offer.give).map((id) => ({
      player_id: id,
      gsis_id: null,
      role: "trade_out" as const,
      slot: null,
    })),
  ];
  if (impliedDrop !== null && impliedDrop.side === "me" && impliedDrop.forced)
    subjects.push({ player_id: impliedDrop.player_id, gsis_id: null, role: "drop", slot: null });
  const actionOf = (): string => {
    if (passed) return "the trade deadline has passed: no trade can be made";
    switch (verdict) {
      case "accept":
        return `accept: Δ ${fmt(deltaMe.mean)} points (p10 ${fmt(deltaMe.p10)}, p90 ${fmt(deltaMe.p90)})`;
      case "fair":
        return "a fair trade: the Δ interval spans 0 — your call";
      case "counter":
        return `counter: the offer as made loses points (Δ ${fmt(deltaMe.mean)}); ${String(counters.length)} counter${counters.length === 1 ? "" : "s"} gain for both sides`;
      default:
        return `decline: Δ ${fmt(deltaMe.mean)} points (p90 ${fmt(deltaMe.p90)})`;
    }
  };
  const noMove = passed || verdict === "decline" || verdict === "fair";
  const inputs = [...(req.inputs ?? [])];
  const rec: Rec = {
    action: actionOf(),
    subjects,
    lineup: null,
    point_estimate: round(deltaMe.mean, 3),
    distribution: deltaMe,
    delta_vs_next: { value: round(deltaMe.mean, 3), p10: deltaMe.p10, p90: deltaMe.p90 },
    decision_metric: "delta_u",
    drivers: [
      { name: "delta_points_me", contribution: round(me.delta, 3) },
      { name: "health_adjustment", contribution: round(me.delta - me.raw, 3) },
      ...(impliedDrop !== null && impliedDrop.side === "me" && impliedDrop.forced
        ? [
            {
              name: `implied_drop:${String(impliedDrop.player_id)}`,
              contribution: -impliedDrop.value,
            },
          ]
        : []),
      { name: "d_p_playoffs_me", contribution: du.me.d_p_playoffs },
    ],
    assumptions,
    confidence: { role_games: 0, inputs },
    as_of: newestAsOf(inputs, req.clock.nowIso()),
    latest_execution_time: passed || noMove ? null : deadline,
    no_move: noMove,
    log_id: null,
  };
  const data: TradeEvaluationData = {
    kind: "evaluation",
    delta_me: deltaMe,
    delta_partner: deltaPartner,
    delta_u: du,
    seeding,
    weekly_impact,
    playoff_weeks_impact: playoffImpact,
    implied_drop: impliedDrop,
    health_adjustment: { me: round(me.delta - me.raw, 3), partner: round(pe.delta - pe.raw, 3) },
    bye_conflicts,
    why_they_accept: why,
    veto,
    crowd_value_espn: crowd,
    consolidation: { is_2_for_1: uneven, implied_drop: impliedDrop?.player_id ?? null },
    counters,
    verdict,
    deadline,
    rec,
    inputs,
  };
  return { data, warnings };
}

const fmt = (x: number): string => `${x >= 0 ? "+" : ""}${String(round(x, 1))}`;

function vetoRisk(votes: number, dMe: number, dPartner: number): "low" | "medium" | "high" {
  if (votes <= 0) return "low";
  const gap = Math.abs(dMe - dPartner);
  const lopsided = (dMe > 0 && dPartner < 0) || (dPartner > 0 && dMe < 0);
  if (lopsided && gap >= TRADE.vetoHigh) return "high";
  if (gap >= TRADE.vetoMedium) return "medium";
  return "low";
}

function whyTheyAccept(
  req: TradeRequest,
  partner: TradeTeam,
  pe: SideEval,
  du: DeltaU,
  get: readonly TradePlayer[],
  give: readonly TradePlayer[],
): string[] {
  const out: string[] = [];
  out.push(
    pe.delta > 0
      ? `their lineup gains ${String(round(pe.delta, 1))} points over the horizon`
      : `their lineup loses ${String(round(-pe.delta, 1))} points: unlikely to accept as offered`,
  );
  const weak = weakestPosition(
    partner.players,
    req.teams
      .filter((t) => t.team_id !== partner.team_id)
      .map((t) => t.players)
      .concat([req.me.players]),
    req.roster,
  );
  if (weak !== null && give.some((p) => p.position === weak))
    out.push(`it fills their weakest starting position (${weak})`);
  if (get.length > give.length)
    out.push("they consolidate: two of theirs become one starter and a free roster seat");
  const mode = req.seeding_config.mode;
  const reading = partner.readings?.find((r) => r.seeding_mode === mode);
  if (reading !== undefined) {
    const p = reading.p_playoffs;
    const d = du.partner.d_p_playoffs;
    if (mode === "points_only")
      out.push(
        `under the points-only reading their seed follows points-for: ΔP(playoffs) ${fmt(d * 100)} pts`,
      );
    else if (p >= 0.6) out.push("a contender under the record-first reading: buying now");
    else if (p >= 0.2)
      out.push(
        `on the bubble under the record-first reading: ΔP(playoffs) ${fmt(d * 100)} pts matters to them`,
      );
    else out.push("a long shot under the record-first reading: future value matters more to them");
  }
  return out;
}

/** Counters: drop one of my given players, or add one of the partner's bench players to the get side. */
function counterOffers(
  req: TradeRequest,
  ctx: Ctx,
  partner: TradeTeam,
  offer: NonNullable<TradeRequest["offer"]>,
  wMe: readonly number[],
  wP: readonly number[],
  dMe: Dist,
  dP: Dist,
): TradeEvaluationData["counters"] {
  const variants: { give: number[]; get: number[] }[] = [];
  if (offer.give.length >= 2)
    for (const id of offer.give)
      variants.push({ give: offer.give.filter((x) => x !== id), get: [...offer.get] });
  if (offer.get.length < TRADE.maxPlayersPerSide) {
    const extra = partner.players
      .filter((p) => !offer.get.includes(p.player_id) && slotClassOf(p.slot_id) === "bench")
      .sort((a, b) => own(b) - own(a) || a.player_id - b.player_id)
      .slice(0, 3);
    for (const p of extra)
      variants.push({ give: [...offer.give], get: [...offer.get, p.player_id] });
  }
  const wire = req.free_agents ?? [];
  const sdMe = sigmaOf(dMe);
  const sdP = sigmaOf(dP);
  const out: { give: number[]; get: number[]; me: number; partner: number }[] = [];
  for (const v of variants) {
    const g = findPlayers(req.me.players, v.give);
    const t = findPlayers(partner.players, v.get);
    const m = evalSide(ctx, req.me.players, new Set(v.give), t, wMe, wire).delta;
    const p = evalSide(ctx, partner.players, new Set(v.get), g, wP, wire).delta;
    if (m > 0 && p >= TRADE.partnerEpsilon) out.push({ ...v, me: m, partner: p });
  }
  return out
    .sort((a, b) => b.me - a.me || b.partner - a.partner)
    .slice(0, TRADE.maxCounters)
    .map((c) => ({
      give: asc(c.give),
      get: asc(c.get),
      delta_me: normalDist(c.me, sdMe, "position_cv"),
      delta_partner: normalDist(c.partner, sdP, "position_cv"),
    }));
}

function searchPartners(
  req: TradeRequest,
  ctx: Ctx,
  horizon: "ros" | "playoffs",
  deadline: string | null,
  passed: boolean,
  assumptions: Assumption[],
  warnings: string[],
): TradeOutcome {
  const search = req.find_partners;
  if (search === undefined || search === null)
    throw new AnalyticsError("invalid_request", "find_partners is required", "find_partners");
  const max = search.max_partners ?? 3;
  ensure(
    Number.isInteger(max) && max >= 1 && max <= TRADE.maxPartners,
    "max_partners must be 1..4",
    "find_partners",
  );
  const need = search.need_position;
  const wire = req.free_agents ?? [];
  const wMe = weightsOf(req.weeks, req.rules, req.me, horizon);
  const league = [req.me, ...req.teams];
  const partners: TradePartnersData["partners"][number][] = [];
  for (const t of [...req.teams].sort((a, b) => a.team_id - b.team_id)) {
    if (t.team_id === req.me.team_id) continue;
    const weak = weakestPosition(
      t.players,
      league.filter((x) => x.team_id !== t.team_id).map((x) => x.players),
      req.roster,
    );
    const gets = activeOf(t.players)
      .filter((p) => p.position === need)
      .sort((a, b) => own(b) - own(a) || a.player_id - b.player_id)
      .slice(0, TRADE.searchGets);
    const gives = activeOf(req.me.players)
      .filter((p) => p.position !== need && p.droppable !== false)
      .sort(
        (a, b) =>
          Number(b.position === weak) - Number(a.position === weak) ||
          own(b) - own(a) ||
          a.player_id - b.player_id,
      )
      .slice(0, TRADE.searchGives);
    const wP = weightsOf(req.weeks, req.rules, t, horizon);
    const combos: number[][] = gives.map((g) => [g.player_id]);
    for (let i = 0; i < Math.min(3, gives.length); i++)
      for (let j = i + 1; j < Math.min(3, gives.length); j++)
        combos.push([gives[i]?.player_id ?? 0, gives[j]?.player_id ?? 0]);
    let best: {
      give: number[];
      get: number[];
      me: number;
      partner: number;
      moved: TradePlayer[];
    } | null = null;
    for (const g of gets)
      for (const giveIds of combos) {
        const gp = findPlayers(req.me.players, giveIds);
        const m = evalSide(ctx, req.me.players, new Set(giveIds), [g], wMe, wire).delta;
        const p = evalSide(ctx, t.players, new Set([g.player_id]), gp, wP, wire).delta;
        if (p < TRADE.partnerEpsilon || m <= 0) continue;
        if (
          best === null ||
          m > best.me + 1e-9 ||
          (Math.abs(m - best.me) <= 1e-9 && p > best.partner)
        )
          best = { give: giveIds, get: [g.player_id], me: m, partner: p, moved: [...gp, g] };
      }
    if (best === null) continue;
    const sd = Math.sqrt(best.moved.reduce((s, p) => s + (rosCv(p.position) * own(p)) ** 2, 0));
    partners.push({
      team_id: t.team_id,
      name: t.name,
      weakest_slot: weak ?? "none",
      proposal: { give: asc(best.give), get: asc(best.get) },
      delta_me: normalDist(best.me, sd, "position_cv"),
      delta_partner: normalDist(best.partner, sd, "position_cv"),
    });
  }
  partners.sort((a, b) => b.delta_me.mean - a.delta_me.mean || a.team_id - b.team_id);
  const top = partners.slice(0, max);
  if (top.length === 0)
    warnings.push(
      `no partner gains from a trade for a ${need} with Δ_partner ≥ ${String(TRADE.partnerEpsilon)}`,
    );
  assumptions.push(
    A(
      "partner search: 1-for-1 and 2-for-1 packages, the partner's Δ at least ε, Δ intervals from the moved players' rest-of-season spread",
      "an offer is evaluated with analyze (offer)",
    ),
  );
  const inputs = [...(req.inputs ?? [])];
  const first = top[0];
  const rec: Rec | null =
    first === undefined
      ? null
      : {
          action: passed
            ? "the trade deadline has passed: no trade can be made"
            : `propose to team ${String(first.team_id)}: give ${first.proposal.give.join(", ")}, get ${first.proposal.get.join(", ")}`,
          subjects: [
            ...first.proposal.get.map((id) => ({
              player_id: id,
              gsis_id: null,
              role: "trade_in" as const,
              slot: null,
            })),
            ...first.proposal.give.map((id) => ({
              player_id: id,
              gsis_id: null,
              role: "trade_out" as const,
              slot: null,
            })),
          ],
          lineup: null,
          point_estimate: round(first.delta_me.mean, 3),
          distribution: first.delta_me,
          delta_vs_next: {
            value: round(first.delta_me.mean, 3),
            p10: first.delta_me.p10,
            p90: first.delta_me.p90,
          },
          decision_metric: "marginal_value",
          drivers: top.map((p) => ({
            name: `partner:${String(p.team_id)}`,
            contribution: round(p.delta_me.mean, 3),
          })),
          assumptions,
          confidence: { role_games: 0, inputs },
          as_of: newestAsOf(inputs, req.clock.nowIso()),
          latest_execution_time: passed ? null : deadline,
          no_move: passed,
          log_id: null,
        };
  return {
    data: { kind: "partners", partners: top, deadline, rec, inputs },
    warnings,
  };
}
