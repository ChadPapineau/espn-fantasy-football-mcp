// schedule-stress.test.ts — E8 `espn_analyze_schedule` (src/domain/analytics/scheduleStress.ts; plan
// 07 E8; research 05 §5 Bye/playoff planning, §2.3; sib research 05 §7). Synthetic: a three-starter
// bye cluster costs its drop from the full-strength lineup and is the worst week, its holes filled
// from the stream baseline with the streamers' ids, the fix's deadline the week's first kickoff; a
// single bye is a hole, not a cluster; E1's known absence counts like a bye; P(alive) weights and
// their assumptions; the playoff block (bye seeds, clamped multipliers, the week-17 flag unmodelled
// vs flagged); IR occupants never start; properties (drops and hole costs never negative, a stream
// option never lowers a week's lineup); the cooperative deadline; hostile inputs.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AnalyticsError } from "../../../src/domain/analytics/errors.js";
import {
  SCHEDULE,
  SCHEDULE_EVIDENCE_NOTE,
  analyzeSchedule,
  solveWeek,
  typicalValue,
  type ScheduleRequest,
  type SchedulePlayer,
  type StreamOption,
} from "../../../src/domain/analytics/scheduleStress.js";
import { seedingStatus } from "../../../src/domain/analytics/types.js";
import {
  clockAndRng,
  dist,
  ELIGIBLE,
  instantPacer,
  proSchedule,
  referenceSlots,
  steppingPacer,
} from "./helpers.js";

const WEEKS = [8, 9, 10, 11, 15, 16, 17];

/** A player whose NFL team is `team`, projected `mean` every week except his bye. */
function sp(
  id: number,
  pos: string,
  mean: number,
  slot: number,
  team: number,
  bye: number | null,
  over: Partial<SchedulePlayer> = {},
): SchedulePlayer {
  return {
    player_id: id,
    position: pos,
    eligible_slot_ids: ELIGIBLE[pos] ?? [],
    injury_status: null,
    pro_team_id: team,
    slot_id: slot,
    weeks: WEEKS.map((w) => ({
      week: w,
      dist: w === bye ? dist(0, 0) : dist(mean, 0.5),
      bye: w === bye,
    })),
    ...over,
  };
}

/** My roster: three starters (RB, WR, TE) share a week-9 bye; one WR alone on bye in week 10. */
function roster(): SchedulePlayer[] {
  return [
    sp(1, "QB", 20, 0, 1, 11),
    sp(2, "RB", 15, 2, 2, 9),
    sp(3, "RB", 13, 2, 3, 12),
    sp(4, "WR", 14, 4, 2, 9),
    sp(5, "WR", 12, 4, 4, 10),
    sp(6, "TE", 9, 6, 2, 9),
    sp(7, "WR", 10, 23, 5, 12),
    sp(8, "D/ST", 7, 16, 6, 12),
    sp(9, "K", 8, 17, 7, 12),
    sp(10, "RB", 8, 20, 8, 12),
    sp(11, "WR", 7, 20, 9, 12),
    sp(12, "QB", 15, 20, 10, 12),
    sp(13, "TE", 4, 20, 11, 12),
    sp(14, "RB", 5, 20, 12, 12),
  ];
}

const stream = (weeks: readonly number[]): StreamOption[] =>
  weeks.flatMap((w) => [
    { position: "QB", week: w, player_id: 900, points: 16 },
    { position: "RB", week: w, player_id: 901, points: 9 },
    { position: "WR", week: w, player_id: 902, points: 9.5 },
    { position: "TE", week: w, player_id: 903, points: 7 },
    { position: "K", week: w, player_id: 904, points: 7.5 },
    { position: "D/ST", week: w, player_id: 905, points: 6.5 },
  ]);

function rq(over: Partial<ScheduleRequest> = {}): ScheduleRequest {
  const { clock } = clockAndRng("2026-10-20T12:00:00.000Z");
  return {
    roster: referenceSlots(),
    players: roster(),
    weeks: WEEKS,
    playoff: { weeks: [15, 16, 17], bye_seeds: 2 },
    p_alive_by_week: [
      { week: 8, p: 1 },
      { week: 9, p: 1 },
      { week: 10, p: 1 },
      { week: 11, p: 1 },
      { week: 15, p: 0.6 },
      { week: 16, p: 0.35 },
      { week: 17, p: 0.18 },
    ],
    seeding: seedingStatus("espn_rule", null),
    stream: stream(WEEKS),
    schedule: proSchedule(2026, WEEKS),
    clock,
    pacer: instantPacer,
    deadline_ms: null,
    ...over,
  };
}

describe("the week-by-week stress test", () => {
  it("a three-starter bye week is a cluster: its cost is the drop from full strength, and it is the worst week", async () => {
    const out = await analyzeSchedule(rq());
    const w9 = out.data.weeks.find((w) => w.week === 9);
    const w8 = out.data.weeks.find((w) => w.week === 8);
    expect(w9?.bye_cluster_cost).toBeGreaterThan(0);
    expect(w8?.bye_cluster_cost).toBe(0);
    expect(out.data.worst_weeks[0]).toBe(9);
    // full strength 108 (20+15+13+14+12+9+10+7+8); week 9: the RB, WR and TE seats lose
    // 15→9 (bench RB 8 vs stream RB 9), 14→10 (FLEX WR moves) + FLEX 10→9.5 (stream WR), TE 9→7
    expect(w9?.lineup_pts.mean).toBeCloseTo(20 + 13 + 9 + 12 + 10 + 7 + 9.5 + 7 + 8, 3);
    expect(w9?.bye_cluster_cost).toBeCloseTo(108 - (20 + 13 + 9 + 12 + 10 + 7 + 9.5 + 7 + 8), 2);
    expect(w9?.holes.map((h) => h.replacement_player_id).sort()).toEqual([901, 902, 903]);
    expect(w9?.holes.every((h) => h.cost >= 0)).toBe(true);
  });

  it("a single starter on bye is a hole only when the wire beats the bench; never a cluster", async () => {
    const out = await analyzeSchedule(rq());
    const w10 = out.data.weeks.find((w) => w.week === 10);
    expect(w10?.bye_cluster_cost).toBe(0);
    // the WR seat: the FLEX WR (10) slides in and the stream WR (9.5) fills the FLEX
    expect(w10?.holes).toEqual([{ slot: "FLEX", replacement_player_id: 902, cost: 0.5 }]);
    const w11 = out.data.weeks.find((w) => w.week === 11);
    // the QB on bye: the stream QB (16) beats the bench QB (15)
    expect(w11?.holes.map((h) => h.slot)).toEqual(["QB"]);
  });

  it("E1's known absence counts like a bye (a starter projected near 0 that week)", async () => {
    const players = roster().map((p) =>
      p.player_id === 3
        ? { ...p, weeks: p.weeks.map((w) => (w.week === 8 ? { ...w, dist: dist(1, 0.5) } : w)) }
        : p,
    );
    const out = await analyzeSchedule(rq({ players }));
    const w8 = out.data.weeks.find((w) => w.week === 8);
    expect(w8?.holes.length).toBeGreaterThan(0);
    expect(typicalValue(players[2]!)).toBeCloseTo((1 + 13 * 6) / 7, 6);
  });

  it("an injured starter is out of every week his cold-start return probability is below one half", async () => {
    // INJURY_RESERVE from week 8: no return before 4 weeks (weeks 8–11 out), back by week 15
    const players = roster().map((p) =>
      p.player_id === 2 ? { ...p, injury_status: "INJURY_RESERVE" as const } : p,
    );
    const out = await analyzeSchedule(rq({ players }));
    const w8 = out.data.weeks.find((w) => w.week === 8);
    const w15 = out.data.weeks.find((w) => w.week === 15);
    const base = await analyzeSchedule(rq());
    expect(w8?.lineup_pts.mean).toBeLessThan(
      base.data.weeks.find((w) => w.week === 8)?.lineup_pts.mean ?? 0,
    );
    expect(w15?.lineup_pts.mean).toBeCloseTo(
      base.data.weeks.find((w) => w.week === 15)?.lineup_pts.mean ?? -1,
      6,
    );
    expect(
      out.data.rec.assumptions.some((a) => a.text.startsWith("1 injured players are out")),
    ).toBe(true);
  });

  it("fixes: stream the worst week's holes, gain weighted by importance, deadline the week's first kickoff", async () => {
    const out = await analyzeSchedule(rq());
    const fix = out.data.fixes.find((f) => f.action.endsWith("week 9"));
    expect(fix?.action).toBe("stream RB and TE and WR for week 9");
    expect(fix?.delta).toBeGreaterThan(0);
    expect(fix?.cost).toBeGreaterThanOrEqual(0);
    expect(fix?.deadline).toBe(new Date(Date.UTC(2026, 8, 6 + 7 * 8, 17)).toISOString());
    expect(out.data.rec.action).toBe(out.data.fixes[0]?.action);
    expect(out.data.rec.no_move).toBe(false);
    expect(out.data.rec.subjects.every((s) => s.role === "stream")).toBe(true);
    expect(out.data.rec.latest_execution_time).toBe(out.data.fixes[0]?.deadline);
  });

  it("weights: P(alive) by week; a playoff week without one is weighted 1 and named; none at all → every week 1", async () => {
    const out = await analyzeSchedule(rq());
    expect(out.data.weeks.find((w) => w.week === 16)?.weight).toEqual({
      p_alive: 0.35,
      importance: 0.35,
    });
    const partial = await analyzeSchedule(
      rq({
        p_alive_by_week: [
          { week: 8, p: 1 },
          { week: 15, p: 0.5 },
        ],
      }),
    );
    expect(partial.data.weeks.find((w) => w.week === 16)?.weight.p_alive).toBe(1);
    expect(
      partial.data.rec.assumptions.some((a) =>
        a.text.startsWith("playoff weeks 16, 17 have no simulated"),
      ),
    ).toBe(true);
    const none = await analyzeSchedule(rq({ p_alive_by_week: null }));
    expect(none.data.weeks.every((w) => w.weight.p_alive === 1)).toBe(true);
    expect(none.data.rec.assumptions[0]?.text).toMatch(/^every week weighted 1/);
  });

  it("a week-15 cluster matters only with material P(playoffs): at P(alive) 0 it is never a worst week", async () => {
    const players = roster().map((p) =>
      [2, 4, 6].includes(p.player_id)
        ? sp(
            p.player_id,
            p.position,
            p.player_id === 2 ? 15 : p.player_id === 4 ? 14 : 9,
            p.slot_id,
            2,
            15,
          )
        : p,
    );
    const alive = await analyzeSchedule(rq({ players }));
    expect(alive.data.worst_weeks).toContain(15);
    const dead = await analyzeSchedule(
      rq({ players, p_alive_by_week: WEEKS.map((w) => ({ week: w, p: w >= 15 ? 0 : 1 })) }),
    );
    expect(dead.data.worst_weeks).not.toContain(15);
  });

  it("include_playoffs: false drops the playoff weeks; IR occupants never start", async () => {
    const out = await analyzeSchedule(rq({ include_playoffs: false }));
    expect(out.data.weeks.map((w) => w.week)).toEqual([8, 9, 10, 11]);
    const players = roster().map((p) => (p.player_id === 1 ? { ...p, slot_id: 21 } : p));
    const ir = await analyzeSchedule(rq({ players }));
    expect(ir.data.weeks.find((w) => w.week === 8)?.lineup_pts.mean).toBeCloseTo(108 - 20 + 16, 3);
    expect(ir.data.rec.assumptions[0]?.text).toMatch(/IR occupants are out of every week/);
  });

  it("no stream baseline: the bench covers what it can; a seat it cannot fill stays empty at 0", async () => {
    const full = await analyzeSchedule(rq({ stream: [] }));
    expect(full.data.weeks.find((w) => w.week === 9)?.holes).toEqual([]); // a deep bench
    const out = await analyzeSchedule(
      rq({ stream: [], players: roster().filter((p) => p.player_id !== 13) }),
    );
    const w9 = out.data.weeks.find((w) => w.week === 9);
    expect(w9?.holes).toEqual([{ slot: "TE", replacement_player_id: null, cost: 9 }]);
    expect(out.data.rec.assumptions.some((a) => a.text.startsWith("no stream baseline"))).toBe(
      true,
    );
    expect(out.data.fixes).toEqual([]);
    expect(out.data.rec.no_move).toBe(true);
  });
});

describe("the playoff weeks", () => {
  it("bye seeds, the evidence note, multipliers clamped and limited to my players", async () => {
    const out = await analyzeSchedule(
      rq({
        matchup_multipliers: [
          { player_id: 2, multiplier: 1.9, shrink_w: 0.4 },
          { player_id: 4, multiplier: 0.95, shrink_w: 1.7 },
          { player_id: 777, multiplier: 1.1, shrink_w: 0.5 },
          { player_id: 5, multiplier: Number.NaN, shrink_w: 0.5 },
        ],
      }),
    );
    const pw = out.data.playoff_weeks;
    expect(pw.weeks).toEqual([15, 16, 17]);
    expect(pw.bye_seeds).toBe(2);
    expect(pw.evidence_note).toBe(SCHEDULE_EVIDENCE_NOTE);
    expect(pw.matchup_multipliers).toEqual([
      { player_id: 2, multiplier: SCHEDULE.multiplier.max, shrink_w: 0.4 },
      { player_id: 4, multiplier: 0.95, shrink_w: 1 },
    ]);
  });

  it("week-17 resting risk: unmodelled without data; flagged for my players on the named NFL teams", async () => {
    const out = await analyzeSchedule(rq());
    expect(out.data.playoff_weeks.week17_rest_risk).toEqual({
      flagged_players: [],
      note: "unmodelled [F]: no NFL clinch or elimination data",
    });
    const flagged = await analyzeSchedule(rq({ resting_risk_pro_team_ids: [2, 7] }));
    expect(flagged.data.playoff_weeks.week17_rest_risk.flagged_players).toEqual([2, 4, 6, 9]);
    const early = await analyzeSchedule(
      rq({ playoff: { weeks: [14, 15, 16], bye_seeds: 2 }, resting_risk_pro_team_ids: [2] }),
    );
    expect(early.data.playoff_weeks.week17_rest_risk.flagged_players).toEqual([]);
  });
});

describe("properties", () => {
  const arbRoster = fc.array(
    fc.record({
      mean: fc.double({ min: 0, max: 30, noNaN: true }),
      bye: fc.constantFrom(8, 9, 10, 11, 12),
    }),
    { minLength: 14, maxLength: 14 },
  );

  it("drops, cluster costs and hole costs are never negative; weights stay in [0, 1]", async () => {
    await fc.assert(
      fc.asyncProperty(arbRoster, async (xs) => {
        const players = roster().map((p, i) => {
          const x = xs[i] ?? { mean: 5, bye: 12 };
          return sp(p.player_id, p.position, x.mean, p.slot_id, p.pro_team_id ?? 0, x.bye);
        });
        const out = await analyzeSchedule(rq({ players }));
        return out.data.weeks.every(
          (w) =>
            w.bye_cluster_cost >= 0 &&
            w.holes.every((h) => h.cost >= 0) &&
            w.weight.p_alive >= 0 &&
            w.weight.p_alive <= 1 &&
            Number.isFinite(w.lineup_pts.mean),
        );
      }),
      { numRuns: 40 },
    );
  });

  it("a stream option never lowers a week's lineup (solveWeek)", () => {
    fc.assert(
      fc.property(arbRoster, fc.double({ min: 0, max: 25, noNaN: true }), (xs, pts) => {
        const players = roster().map((p, i) => ({
          player: p,
          value: xs[i]?.mean ?? 0,
          dist: dist(xs[i]?.mean ?? 0, 0.5),
        }));
        const slots = referenceSlots();
        const without = solveWeek(slots, players, []);
        const withStream = solveWeek(slots, players, [
          { position: "WR", week: 9, player_id: 1, points: pts },
        ]);
        return withStream.mean >= without.mean - 1e-9;
      }),
    );
  });
});

describe("cooperative batching and hostile inputs", () => {
  it("the CPU deadline returns partial with the completed weeks", async () => {
    const out = await analyzeSchedule(rq({ pacer: steppingPacer(5), deadline_ms: 8 }));
    expect(out.partial).toBe(true);
    expect(out.data.weeks.length).toBeLessThan(WEEKS.length);
    expect(out.warnings[0]).toMatch(/^partial: /);
  });

  it("refuses empty rosters, duplicated players, bad or duplicated weeks, no week left", async () => {
    await expect(analyzeSchedule(rq({ players: [] }))).rejects.toBeInstanceOf(AnalyticsError);
    await expect(analyzeSchedule(rq({ players: [...roster(), roster()[0]!] }))).rejects.toThrow(
      /twice/,
    );
    await expect(analyzeSchedule(rq({ weeks: [] }))).rejects.toThrow(/weeks/);
    await expect(analyzeSchedule(rq({ weeks: [8, 8] }))).rejects.toThrow(/weeks/);
    await expect(analyzeSchedule(rq({ weeks: [0] }))).rejects.toThrow(/weeks/);
    await expect(analyzeSchedule(rq({ weeks: [15, 16], include_playoffs: false }))).rejects.toThrow(
      /no week left/,
    );
  });

  it("no pro schedule: fixes carry no deadline; of two options at a position the better one fills", async () => {
    const { schedule: _s, ...noSchedule } = rq();
    const out = await analyzeSchedule(noSchedule);
    expect(out.data.fixes.length).toBeGreaterThan(0);
    expect(out.data.fixes.every((f) => f.deadline === null)).toBe(true);
    const better = await analyzeSchedule(
      rq({ stream: [...stream(WEEKS), { position: "TE", week: 9, player_id: 913, points: 8.5 }] }),
    );
    const w9 = better.data.weeks.find((w) => w.week === 9);
    expect(w9?.holes.find((h) => h.slot === "TE")?.replacement_player_id).toBe(913);
  });

  it("a non-finite stream option is ignored; a fix deadline already past is null", async () => {
    const out = await analyzeSchedule(
      rq({
        stream: [...stream(WEEKS), { position: "TE", week: 9, player_id: 999, points: Number.NaN }],
        clock: clockAndRng("2026-12-31T00:00:00.000Z").clock,
      }),
    );
    expect(
      out.data.weeks.flatMap((w) => w.holes).some((h) => h.replacement_player_id === 999),
    ).toBe(false);
    expect(out.data.fixes.every((f) => f.deadline === null)).toBe(true);
  });
});
