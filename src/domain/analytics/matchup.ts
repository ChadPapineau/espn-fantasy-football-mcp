// matchup.ts — E3 `espn_analyze_matchup` modes `pre` and `live` (plan 07 E3 P1; plan 10 B9; sib
// research 05 §11.1–§11.2; research 04 §B.1.7): H2H P(win) of my lineup as set against the
// opponent's (pre-week: his best legal lineup by mean, locks respected; live: his lineup as set),
// by the normal approximation of the sums (same-team correlations from the research 05 §3.2 table,
// cross-roster covariance through shared NFL teams) or by Monte Carlo over the Gaussian copula of
// the unfinished players (ties count half, cooperative batches under the CPU deadline). Live
// conditioning: a FINAL game (ESPN `statsOfficial`, or a bye) is a point mass at the player's ESPN
// actual (`appliedTotal`, statSourceId 0); a game IN PROGRESS keeps the points so far and adds the
// remaining fraction of the pre-game distribution (mean × f, variance × f — independent increments;
// f from the kickoff and a nominal game length, research 04 §B.1.7: ESPN carries no per-player
// in-game clock); a PENDING game keeps the full distribution. A live call WITHOUT its live facts
// (the box score unread, the week's pro games unknown) conditions nothing — plan 01 §5.6–§5.7,
// never fabricate: the lineups as set at their pre-game distributions, `live: null`, `partial`,
// the omission an assumption (an unread actual is not 0 points, an unknown game not a bye).
// `actionable_slots` lists only my starting seats whose occupant can still move (never a locked,
// live or final player; an empty seat only when an unlocked eligible reserve can fill it). ESPN's
// own live win probability is the labelled cross-check, never an input. Pure: clock, rng and
// pacer injected.
// Ported from sibling @e70c47b (src/domain/analytics/matchup.ts: distQuantile, cholesky, the copula
// sampler, the interval shift), adapted: ESPN slots and locks, live conditioning, cooperative MC.
import type { Clock, Rng } from "../clock.js";
import { canOccupySlot, slotClassOf, sortSlotIds } from "../league/slots.js";
import type { PlayerLock } from "../league/schedule.js";
import type { GameState, IsoInstant, RosterSlots } from "../league/types.js";
import type { Dist, DistBasis } from "../scoring/types.js";
import { LINEUP, SIMS, Z90 } from "./constants.js";
import { loopPacer, runCooperative, type Pacer } from "./cooperative.js";
import { AnalyticsError, ensure } from "./errors.js";
import { type AnyStamp, collectInputs, mergeInputs, newestAsOf } from "./inputs.js";
import { bestLineup, type LineupPlayer } from "./lineup.js";
import { clamp, normalCdf, normalDist, normalDraw, round, sigmaOf } from "./math.js";
import { rho, type TotalMember } from "./totals.js";
import type {
  Assumption,
  InputFreshness,
  MatchupWinData,
  Rec,
  RecSubject,
  WinProbMethod,
} from "./types.js";

/** E3 live constants (research 04 §B.1.7; sib research 05 §11.2) — [U] where marked. */
export const LIVE = Object.freeze({
  /** A nominal NFL game from kickoff to final whistle [U] (3 h 10 min; overtime runs past it). */
  gameMs: 190 * 60 * 1000,
  /** The smallest remaining fraction of a game still in progress (overtime, a late final) [U]. */
  minRemaining: 0.02,
  /** The remaining fraction assumed when a live game's kickoff is unknown [U]. */
  unknownRemaining: 0.5,
});

/** One rostered player as E3 sees him: the lineup view plus the live facts of his game. */
export interface MatchupPlayer {
  readonly player: LineupPlayer;
  /**
   * His own game's state this week from the PRO SCHEDULE (`lockPlan` → league/schedule
   * `gameStateOf`: `final` once that game's stats are official) — never the box score's
   * period-level state, which reads `in` for every player with an actual until the whole period is
   * official (src/providers/espn/normalize.ts). `matchupPlayerOf` builds it that way.
   */
  readonly game_state: GameState;
  /** ESPN's actual points this period (`appliedTotal`, statSourceId 0); null before kickoff. */
  readonly points_so_far: number | null;
  /** His game's kickoff (epoch ms), or null (bye, TBD, unknown). */
  readonly kickoff_ms: number | null;
}

/** An E3 `pre` / `live` request. */
export interface MatchupWinRequest {
  readonly mode: "pre" | "live";
  readonly roster: RosterSlots;
  /** My roster in its current slots. */
  readonly me: readonly MatchupPlayer[];
  /** The opponent's roster in its current slots; null or empty → refused (bye week / unreadable). */
  readonly opponent: readonly MatchupPlayer[] | null;
  readonly method?: WinProbMethod;
  readonly n_sims?: number;
  /** ESPN's own numbers (mMatchupScore) — the labelled cross-check. */
  readonly espn_cross_check?: MatchupWinData["espn_cross_check"];
  readonly clock: Clock;
  readonly rng: Rng;
  readonly pacer?: Pacer;
  readonly deadline_ms?: number | null;
  readonly stamps?: readonly AnyStamp[];
  readonly inputs?: readonly InputFreshness[];
  /**
   * `live` only: the live facts this call could not read, one fixed phrase each (the box score's
   * points so far, the pro schedule's game states), or empty / absent when both were read. Without
   * them nothing is conditioned (plan 01 §5.6–§5.7: return what it has, never fabricate — an unread
   * box score is not 0 points and an unknown game is not a bye): every started player keeps his whole
   * pre-game distribution on the lineups as set, `live` is null, the omission is an assumption and a
   * warning, and the outcome is `partial`.
   */
  readonly live_unread?: readonly string[];
}

/** E3 `pre` / `live`'s outcome. */
export interface MatchupWinOutcome {
  readonly data: MatchupWinData;
  /**
   * `partial` (never cached): the Monte-Carlo sampler stopped at the CPU deadline, or a live call
   * ran without the live facts it names (`live_unread`).
   */
  readonly partial: boolean;
  /** Paths completed (0 for `method: normal`). */
  readonly completed_paths: number;
  readonly warnings: readonly string[];
}

/**
 * A MatchupPlayer from E2's LineupPlayer, the player's lock-plan row (his game's state and kickoff
 * from the pro schedule) and ESPN's actual this period (the box score's `actual.applied_total`). No
 * lock row reads as `tbd` — his game is unknown, which is neither a bye nor a final (a no-team
 * player's row says `bye` itself), so a live call keeps his pre-game distribution.
 */
export function matchupPlayerOf(
  player: LineupPlayer,
  lock: Pick<PlayerLock, "game_state" | "kickoff"> | null,
  actual: number | null,
): MatchupPlayer {
  const k = lock?.kickoff ?? null;
  const ms = k === null ? null : Date.parse(k);
  return {
    player,
    game_state: lock?.game_state ?? "tbd",
    points_so_far: actual,
    kickoff_ms: ms === null || !Number.isFinite(ms) ? null : ms,
  };
}

// --- distributions (ported) -------------------------------------------------------------------------

/**
 * The inverse CDF of a Dist, piecewise linear through its knots (0 → a floor below p10, then
 * p10…p90, 1 → a cap above p90); the zero mass `p_zero` is honoured first.
 */
export function distQuantile(d: Dist, u: number): number {
  if (u < d.p_zero) return 0;
  const lo = Math.min(0, d.p10 - (d.p25 - d.p10));
  const hi = d.p90 + (d.p90 - d.p75) * 1.5;
  const knots: readonly (readonly [number, number])[] = [
    [0, Math.min(lo, d.p10)],
    [0.1, d.p10],
    [0.25, d.p25],
    [0.5, d.p50],
    [0.75, d.p75],
    [0.9, d.p90],
    [1, Math.max(hi, d.p90)],
  ];
  const x = clamp(u, 0, 1);
  const i = Math.max(
    1,
    knots.findIndex(([k]) => x <= k),
  );
  const [u0, v0] = knots[i - 1] ?? [0, 0];
  const [u1, v1] = knots[i] ?? [1, 0];
  return u1 === u0 ? v1 : v0 + ((x - u0) / (u1 - u0)) * (v1 - v0);
}

/** Lower-triangular Cholesky factor of a correlation matrix; a non-PD pivot falls back to 1e-9. */
export function cholesky(c: readonly (readonly number[])[]): number[][] {
  const n = c.length;
  const l = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const li = l[i] ?? [];
      const lj = l[j] ?? [];
      let s = c[i]?.[j] ?? 0;
      for (let k = 0; k < j; k++) s -= (li[k] ?? 0) * (lj[k] ?? 0);
      li[j] = i === j ? Math.sqrt(Math.max(s, 1e-9)) : s / (lj[j] ?? 1);
    }
  }
  return l;
}

// --- live conditioning ----------------------------------------------------------------------------

/** Where a started player stands (plan 07 E3 `live`). */
export type LiveStatus = "final" | "live" | "pending";

/** One started player's contribution to his side's total. */
export interface Contribution {
  readonly player_id: number;
  readonly side: "me" | "opp";
  readonly status: LiveStatus;
  readonly so_far: number;
  /** The remaining fraction of his game (1 pending, 0 final). */
  readonly fraction_remaining: number;
  readonly rem_mean: number;
  readonly rem_sd: number;
  readonly dist: Dist;
  readonly position: string;
  readonly pro_team_id: number | null;
}

/** The remaining fraction of a game in progress at `nowMs` (research 04 §B.1.7; [U] game length). */
export function fractionRemaining(kickoffMs: number | null, nowMs: number): number {
  if (kickoffMs === null || !Number.isFinite(kickoffMs)) return LIVE.unknownRemaining;
  const f = 1 - (nowMs - kickoffMs) / LIVE.gameMs;
  return clamp(f, LIVE.minRemaining, 1);
}

/** How one started player contributes in `mode` at `nowMs`. */
export function contributionOf(
  p: MatchupPlayer,
  side: "me" | "opp",
  mode: "pre" | "live",
  nowMs: number,
): Contribution {
  const d = p.player.points;
  const sd = sigmaOf(d);
  const base = {
    player_id: p.player.player_id,
    side,
    dist: d,
    position: p.player.position,
    pro_team_id: p.player.pro_team_id,
  };
  const pts = p.points_so_far !== null && Number.isFinite(p.points_so_far) ? p.points_so_far : 0;
  if (mode === "live" && (p.game_state === "final" || p.game_state === "bye"))
    return { ...base, status: "final", so_far: pts, fraction_remaining: 0, rem_mean: 0, rem_sd: 0 };
  if (mode === "live" && p.game_state === "in") {
    const f = fractionRemaining(p.kickoff_ms, nowMs);
    return {
      ...base,
      status: "live",
      so_far: pts,
      fraction_remaining: f,
      rem_mean: f * d.mean,
      rem_sd: Math.sqrt(f) * sd,
    };
  }
  return {
    ...base,
    status: "pending",
    so_far: 0,
    fraction_remaining: 1,
    rem_mean: d.mean,
    rem_sd: sd,
  };
}

const memberOf = (c: Contribution): TotalMember => ({
  player_id: c.player_id,
  position: c.position,
  pro_team_id: c.pro_team_id,
  points: normalDist(c.rem_mean, c.rem_sd, c.dist.basis),
});

/** Mean and variance of a side's total, and the cross-side covariance (unfinished players only). */
export function liveMoments(
  mine: readonly Contribution[],
  theirs: readonly Contribution[],
): { mu_m: number; mu_o: number; v_m: number; v_o: number; cov: number } {
  const side = (cs: readonly Contribution[]): { mu: number; v: number } => {
    let mu = 0;
    let v = 0;
    cs.forEach((a, i) => {
      mu += a.so_far + a.rem_mean;
      v += a.rem_sd * a.rem_sd;
      for (let j = i + 1; j < cs.length; j++) {
        const b = cs[j];
        if (b !== undefined) v += 2 * rho(memberOf(a), memberOf(b)) * a.rem_sd * b.rem_sd;
      }
    });
    return { mu, v: Math.max(0, v) };
  };
  const m = side(mine);
  const o = side(theirs);
  let cov = 0;
  for (const a of mine)
    if (a.rem_sd > 0)
      for (const b of theirs) cov += rho(memberOf(a), memberOf(b)) * a.rem_sd * b.rem_sd;
  return { mu_m: m.mu, mu_o: o.mu, v_m: m.v, v_o: o.v, cov };
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

const isStart = (roster: RosterSlots, slotId: number): boolean => {
  const c = slotClassOf(slotId);
  return (c === "starter" || c === "flex") && roster.slots.some((s) => s.slot_id === slotId);
};

/** Whether a player can still be moved at `nowMs` (never once ESPN locks him or his game starts). */
export function canMove(p: MatchupPlayer, nowMs: number): boolean {
  if (p.player.locked) return false;
  if (p.game_state === "in" || p.game_state === "final") return false;
  const t = p.player.lock_at === null ? null : Date.parse(p.player.lock_at);
  return t === null || !Number.isFinite(t) || t > nowMs;
}

/**
 * My starting seats that can still change (plan 07 E3 `actionable_slots`; sib research 05 §11
 * pitfall "a live update cannot be acted on for locked slots"): an occupied seat whose occupant can
 * move; an empty seat only when an unlocked, non-IR reserve eligible for it exists. Sorted in
 * ESPN's display order.
 */
export function actionableSlots(
  roster: RosterSlots,
  me: readonly MatchupPlayer[],
  nowMs: number,
): { slot: string; lock_at: IsoInstant | null }[] {
  const out: { slot: string; lock_at: IsoInstant | null; order: number }[] = [];
  const order = sortSlotIds(roster.slots.map((s) => s.slot_id));
  const reserves = me.filter(
    (p) => !isStart(roster, p.player.slot_id) && slotClassOf(p.player.slot_id) !== "ir",
  );
  for (const s of roster.slots) {
    if (s.class !== "starter" && s.class !== "flex") continue;
    const occupants = me.filter((p) => p.player.slot_id === s.slot_id);
    for (const p of occupants)
      if (canMove(p, nowMs))
        out.push({ slot: s.name, lock_at: p.player.lock_at, order: order.indexOf(s.slot_id) });
    const empty = s.count - occupants.length;
    if (empty > 0 && reserves.some((r) => canMove(r, nowMs) && canOccupySlot(s.slot_id, r.player)))
      for (let i = 0; i < empty; i++)
        out.push({ slot: s.name, lock_at: null, order: order.indexOf(s.slot_id) });
  }
  return out
    .sort((a, b) => a.order - b.order || (a.lock_at ?? "").localeCompare(b.lock_at ?? ""))
    .map(({ slot, lock_at }) => ({ slot, lock_at }));
}

// --- E3 pre / live ---------------------------------------------------------------------------------

/** One unfinished player's draw: pending = his Dist; live = so far + f·μ + √f·(Dist − μ). */
function drawOf(c: Contribution, u: number): number {
  if (c.status === "final") return c.so_far;
  const x = distQuantile(c.dist, u);
  if (c.status === "pending") return x;
  const f = c.fraction_remaining;
  return c.so_far + f * c.dist.mean + Math.sqrt(f) * (x - c.dist.mean);
}

/** E3 `pre` / `live`. Throws AnalyticsError `invalid_request` (no opponent, bounds). */
export async function analyzeMatchupWin(req: MatchupWinRequest): Promise<MatchupWinOutcome> {
  const opponent = req.opponent;
  if (opponent === null || opponent.length === 0)
    throw new AnalyticsError("invalid_request", "no opponent roster for this week", "week");
  ensure(
    req.me.length > 0 && req.me.length <= LINEUP.maxPlayers && opponent.length <= LINEUP.maxPlayers,
    "roster size out of range",
    "players",
  );
  const method: WinProbMethod = req.method ?? "mc";
  const n = req.n_sims ?? SIMS.default;
  ensure(Number.isInteger(n) && n >= SIMS.min && n <= SIMS.max, "n_sims out of range", "n_sims");
  const ids = new Set<number>();
  for (const p of [...req.me, ...opponent]) {
    ensure(!ids.has(p.player.player_id), "a player is listed twice", "players");
    ids.add(p.player.player_id);
  }
  const nowMs = req.clock.nowMs();
  const mode = req.mode;
  const assumptions: Assumption[] = [];
  const warnings: string[] = [];
  // live facts this call did not read: nothing is conditioned on them (an unread box score is not
  // 0 points, an unknown game is not a bye) — every started player keeps his pre-game distribution
  const unread = mode === "live" ? [...new Set(req.live_unread ?? [])] : [];
  const conditioned = unread.length === 0;

  const myStarters = req.me.filter((p) => isStart(req.roster, p.player.slot_id));
  let oppStarters: MatchupPlayer[];
  if (mode === "pre") {
    const best = new Set(
      bestLineup(
        req.roster,
        opponent.map((p) => p.player),
      ).map((p) => p.player_id),
    );
    oppStarters = opponent.filter((p) => best.has(p.player.player_id));
    assumptions.push(
      A(
        "the opponent starts his highest-projected legal lineup (locks respected)",
        "the opponent's set lineup differs",
      ),
    );
  } else {
    oppStarters = opponent.filter((p) => isStart(req.roster, p.player.slot_id));
    assumptions.push(
      A("both lineups as set: only unlocked seats can still change", "a lineup is edited"),
    );
    if (!conditioned) {
      assumptions.push(
        A(
          `live facts not read (${unread.join("; ")}): every started player is scored from his pre-game projection, with no points so far and no game state`,
          "the same call again reads them (what this call read is cached)",
        ),
      );
      warnings.push(
        `live conditioning unavailable: ${unread.join(" and ")} not read; p_win is the pre-game number for the lineups as set (live: null) — call again for the live one`,
      );
    } else if ([...myStarters, ...oppStarters].some((p) => p.game_state === "in"))
      assumptions.push(
        A(
          `a game in progress scores its points so far plus the remaining fraction of the pre-game projection (a ${String(Math.round(LIVE.gameMs / 60000))}-minute game; ESPN sends no in-game clock)`,
          "a live game state feed is read",
        ),
      );
    const unknownKick = [...myStarters, ...oppStarters].filter(
      (p) => p.game_state === "in" && p.kickoff_ms === null,
    ).length;
    if (conditioned && unknownKick > 0)
      warnings.push(
        `${String(unknownKick)} live players without a kickoff: half the game assumed to remain`,
      );
    const finalNoPoints = [...myStarters, ...oppStarters].filter(
      (p) => p.game_state === "final" && p.points_so_far === null,
    ).length;
    if (conditioned && finalNoPoints > 0)
      warnings.push(`${String(finalNoPoints)} finished players without an ESPN actual: scored 0`);
  }
  if (myStarters.length === 0)
    throw new AnalyticsError("invalid_request", "my lineup has no starter", "team_id");
  if (oppStarters.length === 0)
    throw new AnalyticsError("invalid_request", "the opponent's lineup has no starter", "week");

  const scoring = conditioned ? mode : "pre";
  const mine = myStarters.map((p) => contributionOf(p, "me", scoring, nowMs));
  const theirs = oppStarters.map((p) => contributionOf(p, "opp", scoring, nowMs));
  const mo = liveMoments(mine, theirs);
  const dMu = mo.mu_m - mo.mu_o;
  const sd = Math.sqrt(Math.max(0, mo.v_m + mo.v_o - 2 * mo.cov));
  const cdf = (x: number): number => (sd === 0 ? (x > 0 ? 1 : x < 0 ? 0 : 0.5) : normalCdf(x / sd));
  const pNormal = cdf(dMu);

  // Monte Carlo over the copula of the unfinished players (finished ones are constants)
  let pWin = pNormal;
  let completed = 0;
  let partial = false;
  const open = [...mine, ...theirs].filter((c) => c.status !== "final");
  if (method === "mc" && open.length > 0 && sd > 0) {
    const constM = mine.filter((c) => c.status === "final").reduce((s, c) => s + c.so_far, 0);
    const constO = theirs.filter((c) => c.status === "final").reduce((s, c) => s + c.so_far, 0);
    const k = open.length;
    const corr = open.map((a) => open.map((b) => (a === b ? 1 : rho(memberOf(a), memberOf(b)))));
    const l = cholesky(corr);
    const stream = req.rng.fork(`matchup:${mode}`);
    const eps = new Float64Array(k);
    let wins = 0;
    const run = await runCooperative(
      n,
      () => {
        for (let i = 0; i < k; i++) eps[i] = normalDraw(stream);
        let m = constM;
        let o = constO;
        for (let i = 0; i < k; i++) {
          const row = l[i] ?? [];
          let z = 0;
          for (let j = 0; j <= i; j++) z += (row[j] ?? 0) * (eps[j] ?? 0);
          const c = open[i];
          if (c === undefined) continue;
          const x = drawOf(c, normalCdf(z));
          if (c.side === "me") m += x;
          else o += x;
        }
        wins += m > o ? 1 : m === o ? 0.5 : 0;
      },
      { pacer: req.pacer ?? loopPacer(req.clock), deadlineMs: req.deadline_ms },
    );
    completed = run.completed;
    partial = run.partial;
    if (completed > 0) pWin = wins / completed;
    if (partial)
      warnings.push(`partial: ${String(completed)} of ${String(n)} paths before the CPU deadline`);
  } else if (method === "mc" && (open.length === 0 || sd === 0)) {
    assumptions.push(A("no score left to draw: the result is decided", "a stat correction"));
  }

  // the interval: projection-mean error over the unfinished share of both lineups, on the number
  const openShare = [...mine, ...theirs].reduce((s, c) => s + c.fraction_remaining, 0);
  const e = LINEUP.muErrorSdPerPlayer * Math.sqrt(openShare);
  const shift = pWin - pNormal;
  const interval: readonly [number, number] = [
    round(clamp(cdf(dMu - Z90 * e) + shift, 0, 1)),
    round(clamp(cdf(dMu + Z90 * e) + shift, 0, 1)),
  ];
  assumptions.push(
    A(
      "player spreads from each Dist's p10–p90; same-team correlations from the research 05 §3.2 table",
      "basis player_sim carries per-player variance",
    ),
    A(
      "the interval reflects projection-mean error, not only sampling error",
      "the retrospective calibrates P(win)",
    ),
  );

  const basis: DistBasis = myStarters.every((p) => p.player.points.basis === "player_sim")
    ? "player_sim"
    : "position_cv";
  const actionable = actionableSlots(req.roster, req.me, nowMs);
  const sortedIds = (cs: readonly Contribution[], st: LiveStatus): number[] =>
    cs
      .filter((c) => c.status === st)
      .map((c) => c.player_id)
      .sort((a, b) => a - b);
  const both = [...mine, ...theirs];
  const live: MatchupWinData["live"] =
    mode === "pre" || !conditioned
      ? null
      : {
          players_final: sortedIds(both, "final"),
          players_live: both
            .filter((c) => c.status === "live")
            .sort((a, b) => a.player_id - b.player_id)
            .map((c) => ({
              player_id: c.player_id,
              points_so_far: round(c.so_far, 2),
              fraction_remaining: round(c.fraction_remaining, 3),
            })),
          players_pending: sortedIds(both, "pending"),
          points_so_far: {
            me: round(
              mine.reduce((s, c) => s + c.so_far, 0),
              2,
            ),
            opp: round(
              theirs.reduce((s, c) => s + c.so_far, 0),
              2,
            ),
          },
        };
  const inputs = mergeInputs(collectInputs(req.stamps ?? [], req.clock), req.inputs ?? []);
  const subjects: RecSubject[] = myStarters
    .map((p) => ({
      player_id: p.player.player_id,
      gsis_id: p.player.gsis_id,
      role: "start" as const,
      slot: req.roster.slots.find((s) => s.slot_id === p.player.slot_id)?.name ?? null,
    }))
    .sort((a, b) => a.player_id - b.player_id);
  const sm = Math.sqrt(mo.v_m);
  const nextLock = actionable
    .map((a) => (a.lock_at === null ? null : Date.parse(a.lock_at)))
    .filter((t): t is number => t !== null && Number.isFinite(t) && t > nowMs)
    .sort((a, b) => a - b)[0];
  const rec: Rec = {
    action:
      mode === "pre"
        ? "no lineup action: pre-week win probability of the current lineup"
        : !conditioned
          ? "no lineup action: pre-game win probability of the lineups as set (live facts not read)"
          : actionable.length === 0
            ? "nothing actionable: every starting seat is locked"
            : "no lineup action: live win probability of the lineup as set",
    subjects,
    lineup: null,
    point_estimate: round(mo.mu_m),
    distribution: normalDist(mo.mu_m, sm, basis),
    delta_vs_next: { value: round(dMu), p10: round(dMu - Z90 * sd), p90: round(dMu + Z90 * sd) },
    decision_metric: "p_win",
    drivers: [
      { name: "projected_margin", contribution: round(dMu) },
      ...(live === null
        ? []
        : [
            {
              name: "points_so_far_margin",
              contribution: round(live.points_so_far.me - live.points_so_far.opp),
            },
          ]),
    ],
    assumptions,
    confidence: {
      role_games: Math.min(...myStarters.map((p) => p.player.role_games)),
      inputs,
    },
    as_of: newestAsOf(inputs, req.clock.nowIso()),
    latest_execution_time: nextLock === undefined ? null : new Date(nextLock).toISOString(),
    no_move: true,
    log_id: null,
  };
  return {
    data: {
      mode,
      p_win: round(pWin),
      interval,
      mu_m: round(mo.mu_m),
      sigma_m: round(sm),
      mu_o: round(mo.mu_o),
      sigma_o: round(Math.sqrt(mo.v_o)),
      cov: round(mo.cov),
      method,
      basis,
      live,
      espn_cross_check: req.espn_cross_check ?? null,
      actionable_slots: actionable,
      rec,
      inputs,
    },
    partial: partial || !conditioned,
    completed_paths: completed,
    warnings,
  };
}
