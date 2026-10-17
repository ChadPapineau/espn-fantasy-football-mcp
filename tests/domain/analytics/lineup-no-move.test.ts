// lineup-no-move.test.ts — E2's no-move rule (changelog R7-1; plan 09 §2 guardrail 9 — a Δ whose
// interval includes 0 is "no move"; plan 07 E2; sib research 05 §14.4): what the user is told and
// what is logged follow the coin-flip band change by change, while E2's mean-optimal assignment
// (`recommended_lineup`, `rec.lineup`) is unchanged. The Stage C finding
// `lineup-coin-flip-logged-as-move`: a single coin-flip swap was `no_move: false` / "make 1 lineup
// change" while the Skills present it as no move, so the logged rec contradicted the advice. Held
// here: the finding's shape is a no-move logged as "keep" and scored as "keep" by the retrospective;
// a decisive change is made beside a held coin flip; a seat that scores a known 0 (bye, empty) is
// priced exactly and always filled; force_start / exclude are honoured; ΔP(win) decides a coin flip
// only where this week's opponent does (not without one, not under points-only, not in maximise_pf);
// and, over random rosters, the invariants that tie the advice, the log and the assignment together.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  analyzeLineup,
  bestLineup,
  type LineupPlayer,
  type LineupRequest,
} from "../../../src/domain/analytics/lineup.js";
import { gammaDist } from "../../../src/domain/analytics/math.js";
import { lineupAlternatives } from "../../../src/domain/analytics/rec.js";
import type { LineupData } from "../../../src/domain/analytics/types.js";
import { canOccupySlot, slotClassOf } from "../../../src/domain/league/slots.js";
import { TEXT_CAPS } from "../../../src/domain/league/types.js";
import { validateRecordInput } from "../../../src/domain/reclog/record.js";
import {
  factIndex,
  rosterIndex,
  scoreCall,
  type PlayerWeekFact,
  type RosterPresence,
} from "../../../src/domain/reclog/retrospective.js";
import type { RecommendationRecord } from "../../../src/domain/reclog/types.js";
import { recSchema } from "../../../src/mcp/envelope.js";
import { bare, clockAndRng, dist, ELIGIBLE, referenceSlots } from "./helpers.js";

const SLOT = { QB: 0, RB: 2, WR: 4, TE: 6, FLEX: 23, DST: 16, K: 17, BE: 20, IR: 21 } as const;
const SUNDAY = "2026-10-11T17:00:00.000Z";
const NOW = "2026-10-08T12:00:00.000Z";

function player(
  id: number,
  position: string,
  mean: number,
  slot: number,
  over: Partial<LineupPlayer> = {},
): LineupPlayer {
  return {
    player_id: id,
    gsis_id: null,
    name: bare(`Player ${String(id)}`),
    position,
    eligible_slot_ids: ELIGIBLE[position] ?? [20],
    injury_status: null,
    pro_team_id: id,
    slot_id: slot,
    locked: false,
    lock_at: SUNDAY,
    points: dist(mean, position === "QB" ? 0.4 : 0.6),
    p_active: 1,
    espn_projection: mean,
    percent_started: 50,
    role_games: 4,
    ...over,
  };
}

/**
 * The reference roster with ONE upgrade on the bench: RB 10 (12) over the FLEX WR 7 (7) — Δ +5,
 * interval about −5.7 to 15.7 at position-level spreads: the finding's coin flip.
 */
function roster(over: Readonly<Record<number, Partial<LineupPlayer>>> = {}): LineupPlayer[] {
  return [
    player(1, "QB", 20, SLOT.QB),
    player(2, "RB", 14, SLOT.RB),
    player(3, "RB", 9, SLOT.RB),
    player(4, "WR", 13, SLOT.WR),
    player(5, "WR", 8, SLOT.WR),
    player(6, "TE", 9, SLOT.TE),
    player(7, "WR", 7, SLOT.FLEX),
    player(8, "D/ST", 7, SLOT.DST),
    player(9, "K", 8, SLOT.K),
    player(10, "RB", 12, SLOT.BE),
    player(11, "WR", 1, SLOT.BE),
    player(12, "QB", 15, SLOT.BE),
    player(13, "TE", 5, SLOT.BE),
    player(14, "RB", 4, SLOT.BE),
    player(15, "WR", 0, SLOT.IR, { injury_status: "OUT", points: dist(0) }),
  ].map((p) => ({ ...p, ...(over[p.player_id] ?? {}) }));
}

function oppRoster(mean: number): LineupPlayer[] {
  return roster().map((p, i) => ({
    ...p,
    player_id: 100 + i,
    pro_team_id: 100 + i,
    points: dist(mean / 9, 0.6),
  }));
}

function request(over: Partial<LineupRequest> = {}): LineupRequest {
  return {
    roster: referenceSlots(),
    players: roster(),
    opponent: oppRoster(100),
    seeding_config: { mode: "espn_rule", confirmed_at: null },
    clock: clockAndRng(NOW).clock,
    ...over,
  };
}

const ids = (xs: readonly { readonly player_id: number | null }[]): number[] =>
  xs.map((x) => x.player_id ?? -1).sort((a, b) => a - b);
const starts = (d: LineupData): number[] => ids(d.rec.subjects.filter((s) => s.role === "start"));
const sits = (d: LineupData): number[] => ids(d.rec.subjects.filter((s) => s.role === "sit"));
const startingRows = (rows: LineupData["current_lineup"]) =>
  rows.filter((s) => s.slot !== "BE" && s.slot !== "IR");

/** E2's rec logged as the start-sit Skill logs it (kind lineup, the domain's alternatives). */
function logged(d: LineupData): RecommendationRecord {
  return {
    league_id: "0",
    season: 2026,
    kind: "lineup",
    week: 5,
    rec: d.rec,
    alternatives: lineupAlternatives(d),
    source_calls: [{ tool: "espn_analyze_lineup", request_id: "r-0123456789ab" }],
    settings_hash: "0123456789abcdef".repeat(4),
    seeding_mode_used: "espn_rule",
    followed_hint: "unknown",
    client_ref: null,
    note: null,
    log_id: `rec-${"0".repeat(26)}`,
    recorded_at: NOW,
  };
}

/** The week as it was played: each player's slot (the user's lineup) and his points. */
function week(
  players: readonly LineupPlayer[],
  slots: Readonly<Record<number, number>>,
  points: Readonly<Record<number, number>>,
): { facts: PlayerWeekFact[]; presence: RosterPresence[] } {
  return {
    facts: players.map((p) => ({
      player_id: p.player_id,
      gsis_id: null,
      points: points[p.player_id] ?? p.points.mean,
      last_week_points: null,
      espn_projection: null,
    })),
    presence: players.map((p) => ({
      player_id: p.player_id,
      gsis_id: null,
      slot_class: slotClassOf(slots[p.player_id] ?? p.slot_id),
    })),
  };
}

describe("the finding: one coin-flip swap (R7-1)", () => {
  it("is no move — told and logged as 'keep the current lineup' — while E2's assignment still makes it", () => {
    const out = analyzeLineup(request());
    // the assignment is unchanged: RB 10 into the FLEX, the best-by-mean lineup
    expect(out.recommended_lineup.find((s) => s.player_id === 10)?.slot).toBe("FLEX");
    expect(ids(out.rec.lineup ?? [])).toEqual(ids(bestLineup(referenceSlots(), roster())));
    expect(out.e_points_after).toBeCloseTo(100, 6);
    // the swap is listed, a coin flip by its interval
    expect(out.swaps).toHaveLength(1);
    const swap = out.swaps[0];
    expect(swap).toMatchObject({ out: 7, in: 10, slot: "FLEX", delta_e: 5, coin_flip: true });
    expect(swap?.interval[0]).toBeLessThan(0);
    expect(swap?.interval[1]).toBeGreaterThan(0);
    // what the user is told and what is logged: no move
    expect(out.no_move).toBe(true);
    expect(out.rec.no_move).toBe(true);
    expect(out.rec.action).toBe("keep the current lineup");
    expect(out.rec.latest_execution_time).toBeNull();
    expect(starts(out)).toEqual(ids(startingRows(out.current_lineup)));
    expect(sits(out)).toEqual([10]);
    // the kept starter is paired with the entrant held out (the retrospective's k-th start ↔ sit)
    expect(out.rec.subjects[0]).toEqual({
      player_id: 7,
      gsis_id: null,
      role: "start",
      slot: "FLEX",
    });
    expect(out.rec.subjects.find((s) => s.role === "sit")).toEqual({
      player_id: 10,
      gsis_id: null,
      role: "sit",
      slot: "BE",
    });
    // the numbers are the kept lineup's; Δ vs next is the change not made — its interval is why
    expect(out.rec.point_estimate).toBeCloseTo(out.e_points_before, 4);
    expect(out.rec.delta_vs_next.value).toBeCloseTo(5, 4);
    expect(out.rec.delta_vs_next.p10).toBeCloseTo(swap?.interval[0] ?? NaN, 3);
    expect(out.rec.delta_vs_next.p90).toBeCloseTo(swap?.interval[1] ?? NaN, 3);
    const why = out.rec.assumptions.find((a) => a.text.includes("coin flip"));
    expect(why?.text).toContain("no move (guardrail 9)");
    expect(why?.text).toContain("includes 0");
  });

  it("is scored by the retrospective as 'keep': followed when the lineup was kept, not when the coin flip was made", () => {
    const players = roster();
    const out = analyzeLineup(request({ players }));
    const record = logged(out);
    expect(validateRecordInput(record, Date.parse(NOW))).toEqual([]);
    expect(recSchema.safeParse(out.rec).success).toBe(true);
    // the alternative offered is E2's assignment, the coin flip made
    expect(record.alternatives).toHaveLength(1);
    const pts = { 10: 20, 7: 3 }; // the held entrant boomed
    const kept = week(players, {}, pts);
    const scored = scoreCall(record, factIndex(kept.facts), rosterIndex(kept.presence), null);
    expect(scored.call.followed).toBe(true);
    const keptTotal = 20 + 14 + 9 + 13 + 8 + 9 + 3 + 7 + 8;
    expect(scored.call.realised).toBeCloseTo(keptTotal, 6);
    // the regret of holding the coin flip: the swap regret and the call's regret both see it
    expect(scored.swaps).toEqual([17]);
    expect(scored.call.regret).toBeCloseTo(17, 6);
    // made the coin flip instead: not followed
    const swapped = week(players, { 10: SLOT.FLEX, 7: SLOT.BE }, pts);
    expect(
      scoreCall(record, factIndex(swapped.facts), rosterIndex(swapped.presence), null).call
        .followed,
    ).toBe(false);
  });
});

describe("change by change (R7-1)", () => {
  it("a decisive change is made beside a held coin flip; Δ is the made change's", () => {
    // WR 11 (11) over WR 5 (now 1): Δ +10, interval excludes 0 — decisive; RB 10 over the FLEX WR 7:
    // the coin flip, held
    const players = roster({ 5: { points: dist(1, 0.6) }, 11: { points: dist(11, 0.6) } });
    const out = analyzeLineup(request({ players }));
    expect(out.swaps.find((s) => s.in === 11)).toMatchObject({ out: 5, coin_flip: false });
    expect(out.swaps.find((s) => s.in === 10)).toMatchObject({ out: 7, coin_flip: true });
    // the assignment makes both
    expect(ids(startingRows(out.recommended_lineup)).filter((x) => x === 10 || x === 11)).toEqual([
      10, 11,
    ]);
    expect(out.no_move).toBe(false);
    expect(out.rec.action).toBe("make 1 lineup change and hold 1 coin flip");
    expect(starts(out)).toContain(11);
    expect(starts(out)).toContain(7);
    expect(starts(out)).not.toContain(10);
    expect(sits(out)).toEqual([5, 10]);
    // the k-th start ↔ the k-th sit: the made entrant against the starter he replaces, then the kept
    // starter against the entrant held out
    const s = out.rec.subjects;
    expect([s[0]?.player_id, s[1]?.player_id]).toEqual([11, 7]);
    const sitOrder = s.filter((x) => x.role === "sit").map((x) => x.player_id);
    expect(sitOrder).toEqual([5, 10]);
    expect(out.rec.delta_vs_next.value).toBeCloseTo(10, 4);
    expect(out.rec.delta_vs_next.p10).toBeGreaterThan(0);
    expect(out.rec.point_estimate).toBeCloseTo(out.e_points_before + 10, 4);
    expect(out.rec.latest_execution_time).toBe(SUNDAY);
    expect(
      out.rec.assumptions.some((a) =>
        a.text.startsWith("changes made: outside the coin-flip band"),
      ),
    ).toBe(true);
    // the log offers both: keeping, and E2's assignment with the coin flip made
    expect(lineupAlternatives(out).map((a) => a.action)).toEqual([
      "keep the current lineup",
      "set the best-by-mean lineup, every coin flip made",
    ]);
  });

  it("a starter who will not play (bye) is always replaced: the swap is priced exactly, never a coin flip", () => {
    // WR 5 on bye (a point mass at 0); the replacement is skewed, so a symmetric interval around his
    // mean would dip below 0 while his own p10 does not
    const entrant = gammaDist(6, 0.9, "position_cv");
    expect(entrant.p10).toBeGreaterThan(0);
    const players = roster({
      5: { points: dist(0), p_active: null },
      10: { points: dist(1, 0.6) }, // no other upgrade: WR 11 is the replacement
      11: { points: entrant },
    });
    const out = analyzeLineup(request({ players }));
    const swap = out.swaps.find((s) => s.out === 5);
    expect(swap?.in).toBe(11);
    expect(swap?.interval).toEqual([entrant.p10, entrant.p90]);
    expect(swap?.coin_flip).toBe(false);
    expect(out.no_move).toBe(false);
    expect(starts(out)).toContain(11);
    expect(sits(out)).toContain(5);
    // the rec's Δ prices the bye seat by the entrant's own quantiles too
    expect(out.rec.delta_vs_next.p10).toBeGreaterThan(0);
  });

  it("an empty starting seat is filled even when the entrant could score below 0", () => {
    // the D/ST seat is empty; the bench D/ST's p10 is negative, but an empty seat scores exactly 0
    const players = [
      ...roster().filter((p) => p.player_id !== 8),
      player(16, "D/ST", 5, SLOT.BE, { points: dist(5, 1) }),
    ];
    const out = analyzeLineup(request({ players }));
    const fill = out.swaps.find((s) => s.out === null);
    expect(fill?.in).toBe(16);
    expect(fill?.interval[0]).toBeLessThan(0);
    expect(fill?.coin_flip).toBe(false);
    expect(out.no_move).toBe(false);
    expect(starts(out)).toContain(16);
    expect(out.rec.action).toBe("fill 1 empty starting slot and hold 1 coin flip");
  });

  it("force_start and exclude are always made, coin flips or not", () => {
    const ex = analyzeLineup(request({ exclude: [7] }));
    expect(ex.swaps.find((s) => s.out === 7)?.coin_flip).toBe(true);
    expect(ex.no_move).toBe(false);
    expect(starts(ex)).not.toContain(7);
    expect(ex.rec.action).toBe("make 1 lineup change");
    const fs = analyzeLineup(request({ force_start: [14] }));
    expect(starts(fs)).toContain(14);
    expect(fs.no_move).toBe(false);
  });

  it("a starter excluded with nobody to take his seat is benched — a made change, never held", () => {
    // the only K is excluded: his seat stays empty; no coin flip elsewhere (RB 10 at 1)
    const players = roster({ 10: { points: dist(1, 0.6) } });
    const out = analyzeLineup(request({ players, exclude: [9] }));
    expect(out.swaps).toEqual([]);
    expect(out.no_move).toBe(false);
    expect(out.rec.action).toBe("bench 1 starter");
    expect(sits(out)).toEqual([9]);
    expect(starts(out)).not.toContain(9);
    expect(out.rec.delta_vs_next.value).toBeCloseTo(-8, 4);
    // a second K set in the D/ST seat (no D/ST rostered) cannot hold it: benched, though not excluded
    const misplaced = analyzeLineup(
      request({
        players: [...players.filter((p) => p.player_id !== 8), player(16, "K", 6, SLOT.DST)],
      }),
    );
    expect(misplaced.no_move).toBe(false);
    expect(misplaced.rec.action).toBe("bench 1 starter");
    expect(sits(misplaced)).toEqual([16]);
  });

  it("a player set in a seat he cannot hold is moved: a reshuffle with no entrant, and a chain that carries a coin flip", () => {
    // WR 7 set in the TE seat, TE 6 at FLEX: the two trade seats — no entrant, no Δ, always made
    const swapped = roster({
      6: { slot_id: SLOT.FLEX },
      7: { slot_id: SLOT.TE },
      10: { points: dist(1, 0.6) },
    });
    const out = analyzeLineup(request({ players: swapped }));
    expect(out.swaps).toEqual([]);
    expect(out.no_move).toBe(false);
    expect(out.rec.action).toBe("move 2 starters between slots");
    expect(out.rec.latest_execution_time).toBe(SUNDAY);
    // with RB 10 (12) back on the bench his entry is a coin flip, yet it carries WR 7 out of the TE
    // seat he cannot hold, so the change is made
    const chain = analyzeLineup(
      request({ players: roster({ 6: { slot_id: SLOT.FLEX }, 7: { slot_id: SLOT.TE } }) }),
    );
    const swap = chain.swaps.find((s) => s.in === 10);
    expect(swap).toMatchObject({ out: 7, coin_flip: true });
    expect(chain.no_move).toBe(false);
    expect(chain.rec.action).toBe("make 1 lineup change");
    expect(starts(chain)).toContain(10);
    expect(starts(chain)).not.toContain(7);
  });

  it("which entrant takes which freed seat never costs a made change: a forced start benches the weakest starter", () => {
    // RB 14 forced in; RB 10 is the coin flip. Seated by the solve's tie-break, 14 took RB 3's seat
    // (9 points) and the advice benched him for 4; re-seated, 14 takes the FLEX WR's (7)
    const out = analyzeLineup(request({ force_start: [14] }));
    expect(out.rec.action).toBe("make 1 lineup change and hold 1 coin flip");
    expect(starts(out)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 14]);
    expect(sits(out)).toEqual([7, 10]);
    expect(out.rec.point_estimate).toBeCloseTo(out.e_points_before - 3, 4);
    // the assignment's starters are the solve's, whatever seat each takes
    expect(ids(out.rec.lineup ?? [])).toEqual([1, 2, 4, 5, 6, 8, 9, 10, 14]);
  });

  it("in a bye week the best entrant fills the seat that scores 0; the weaker change is the coin flip held", () => {
    // RB 3 on bye; RB 10 (12) and RB 14 (8) both start in E2's assignment — at RB 3's seat and the
    // FLEX WR 7's (7). 10 for the bye seat is made (+12) and 14 for WR 7 (+1) held; the other pairing
    // would make 14 for the bye seat (+8) and hold 10 — a worse lineup to tell the user to set
    const players = roster({
      3: { points: dist(0), p_active: null },
      14: { points: dist(8, 0.6) },
    });
    for (const order of [players, [...players].reverse()]) {
      const out = analyzeLineup(request({ players: order }));
      expect(out.rec.action).toBe("make 1 lineup change and hold 1 coin flip");
      expect(out.swaps.find((s) => s.out === 3)).toMatchObject({ in: 10, coin_flip: false });
      expect(out.swaps.find((s) => s.out === 7)).toMatchObject({ in: 14, coin_flip: true });
      expect(starts(out)).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10]);
      expect(sits(out)).toEqual([3, 14]);
      expect(out.rec.point_estimate).toBeCloseTo(out.e_points_before + 12, 4);
    }
  });
});

describe("the alternatives the log is offered (R7-1)", () => {
  it("only_unlocked: a locked starter is in every option's starters, so their realised totals compare", () => {
    // QB 1 locked (his game has started); the views leave him out, the rec keeps him a starter
    const players = roster({ 1: { locked: true } });
    const out = analyzeLineup(request({ players, only_unlocked: true }));
    expect(out.no_move).toBe(true);
    expect(out.current_lineup.some((s) => s.player_id === 1)).toBe(false);
    const alts = lineupAlternatives(out);
    expect(alts).toHaveLength(1);
    const altStarts = ids((alts[0]?.subjects ?? []).filter((s) => s.role === "start"));
    expect(altStarts).toContain(1);
    expect(altStarts).toEqual(ids(out.rec.lineup ?? []));
    expect(starts(out)).toContain(1);
    // scored on a week the user kept: the alternative's regret is the held coin flip's
    const kept = week(players, {}, { 10: 15, 7: 5 });
    const scored = scoreCall(logged(out), factIndex(kept.facts), rosterIndex(kept.presence), null);
    expect(scored.call.followed).toBe(true);
    expect(scored.call.regret).toBeCloseTo(10, 6);
  });

  it("a move with nothing held offers only 'keep the current lineup'", () => {
    const players = roster({ 7: { points: dist(1, 0.6) } });
    const out = analyzeLineup(request({ players }));
    expect(out.no_move).toBe(false);
    expect(out.swaps.every((s) => !s.coin_flip)).toBe(true);
    expect(lineupAlternatives(out).map((a) => a.action)).toEqual(["keep the current lineup"]);
  });
});

describe("where ΔP(win) decides a coin flip (R7-1)", () => {
  // a tight swap: K 16 (3 ± 0.15) over K 9 (1 ± 0.05) — Δ +2, interval about 1.8 to 2.2 (excludes 0),
  // |ΔP(win)| ≈ 0.03 against a ≈ 28-point matchup spread (under position_cv's 0.04)
  const tight = (): LineupPlayer[] => [
    ...roster({ 9: { points: dist(1, 0.05) } }),
    player(16, "K", 3, SLOT.BE, { points: dist(3, 0.05) }),
  ];

  it("against this week's opponent a swap that barely moves the win chance is a coin flip, held", () => {
    const out = analyzeLineup(request({ players: tight() }));
    const k = out.swaps.find((s) => s.in === 16);
    expect(k?.interval[0]).toBeGreaterThan(0);
    expect(k?.coin_flip).toBe(true);
    expect(out.swaps.find((s) => s.in === 10)?.coin_flip).toBe(true);
    expect(out.no_move).toBe(true);
    expect(out.rec.assumptions.some((a) => a.text.includes("|ΔP(win)| < 0.04"))).toBe(true);
  });

  it("without an opponent ΔP(win) is not read: the interval alone decides", () => {
    const out = analyzeLineup(request({ players: tight(), opponent: null }));
    expect(out.swaps.find((s) => s.in === 16)?.coin_flip).toBe(false);
    expect(out.swaps.find((s) => s.in === 10)?.coin_flip).toBe(true);
    expect(out.no_move).toBe(false);
    expect(out.rec.action).toBe("make 1 lineup change and hold 1 coin flip");
    expect(starts(out)).toContain(16);
  });

  it("under points-only seeding every point counts: the interval alone decides", () => {
    const out = analyzeLineup(
      request({ players: tight(), seeding_config: { mode: "points_only", confirmed_at: null } }),
    );
    expect(out.objective_used).toBe("points_only");
    expect(out.swaps.find((s) => s.in === 16)?.coin_flip).toBe(false);
    expect(starts(out)).toContain(16);
  });

  it("in maximise_pf (the PF tiebreak in play, P(win) saturated) the interval alone decides", () => {
    const out = analyzeLineup(
      request({
        players: tight(),
        opponent: oppRoster(40),
        season: {
          pf_per_win: null,
          pf_context: { season_pf_rank: 6, pf_gap_to_cutoff: -3, tiebreak_in_play: true },
          remaining_weeks: 5,
        },
      }),
    );
    expect(out.mode).toBe("maximise_pf");
    expect(out.swaps.find((s) => s.in === 16)?.coin_flip).toBe(false);
    expect(starts(out)).toContain(16);
  });
});

describe("invariants over random rosters (R7-1)", () => {
  const means = fc.array(fc.double({ min: 0, max: 30, noNaN: true }), {
    minLength: 14,
    maxLength: 14,
  });

  it("property: the advice is a legal lineup between the current one and E2's assignment; held changes are exactly the coin flips; the log carries it", () => {
    fc.assert(
      fc.property(means, fc.boolean(), (ms, withOpp) => {
        const players = roster().map((p, i) =>
          p.player_id === 15
            ? p
            : { ...p, points: dist(ms[i] ?? 0, p.position === "QB" ? 0.4 : 0.6) },
        );
        const out = analyzeLineup(request({ players, opponent: withOpp ? oppRoster(100) : null }));
        const rec = out.rec;
        const byId = new Map(players.map((p) => [p.player_id, p]));
        // the flags agree
        if (out.no_move !== rec.no_move) return false;
        // E2's assignment is unchanged: rec.lineup is the best-by-mean lineup
        if (ids(rec.lineup ?? []).join() !== ids(bestLineup(referenceSlots(), players)).join())
          return false;
        // the advice is legal: every start subject may hold his slot, no seat over its count
        const counts = new Map<string, number>();
        for (const s of rec.subjects.filter((x) => x.role === "start")) {
          const p = byId.get(s.player_id ?? -1);
          const seat = referenceSlots().slots.find((x) => x.name === s.slot);
          if (p === undefined || seat === undefined || !canOccupySlot(seat.slot_id, p))
            return false;
          counts.set(seat.name, (counts.get(seat.name) ?? 0) + 1);
        }
        for (const seat of referenceSlots().slots)
          if ((counts.get(seat.name) ?? 0) > (seat.class === "bench" ? 99 : seat.count))
            return false;
        // held ⟺ coin flip, change by change: a coin flip's entrant never starts in the advice, a
        // decisive one always does
        const told = new Set(starts(out));
        for (const s of out.swaps) {
          if (s.coin_flip && told.has(s.in)) return false;
          if (!s.coin_flip && !told.has(s.in)) return false;
        }
        // no move ⟺ nothing made: the current starters, the kept lineup's numbers, no deadline
        const cur = ids(startingRows(out.current_lineup));
        if (rec.no_move !== out.swaps.every((s) => s.coin_flip)) return false;
        if (rec.no_move) {
          if (starts(out).join() !== cur.join()) return false;
          if (Math.abs(rec.point_estimate - out.e_points_before) > 1e-3) return false;
          if (rec.latest_execution_time !== null) return false;
        }
        // nothing held: the advice is E2's assignment
        if (
          out.swaps.every((s) => !s.coin_flip) &&
          starts(out).join() !== ids(rec.lineup ?? []).join()
        )
          return false;
        // the advice lies between the current lineup and the assignment
        if (rec.point_estimate < out.e_points_before - 1e-3) return false;
        if (rec.point_estimate > out.e_points_after + 1e-3) return false;
        // the rec fits the tool's schema and the log, every text within the 200-char cap
        const texts = [
          rec.action,
          ...rec.drivers.map((d) => d.name),
          ...rec.assumptions.flatMap((a) => [a.text, a.revisit_trigger]),
        ];
        if (texts.some((t) => t.length > TEXT_CAPS.rec_log_text)) return false;
        if (!recSchema.safeParse(rec).success) return false;
        return validateRecordInput(logged(out), Date.parse(NOW)).length === 0;
      }),
      { numRuns: 150 },
    );
  });
});
