// roster-audit.test.ts — E9 `espn_analyze_roster` (src/domain/analytics/rosterAudit.ts; plan 07 E9;
// plan 10 B7; research 05 §4.2, §4.3). Hard B7 parts: the IR section is reported FIRST when
// `ir.invalid` (the data object's first key, the rec's action and first driver); the hidden-bench
// play carries exactly three risks; `bench_template.qb_bench == 0` only when `streamability.QB ≥
// 0.9` (a property over every streamability map). Also: the template's arithmetic, bench roles and
// marginal values (bye cover vs injury cover vs upside), handcuffs against the slot's alternative
// use, stashes and the post-deadline "drop for a streamer", the forced drop (the hidden-bench
// acquisition first), the activation warning, effective bench, phase, competing, adds remaining,
// the cooperative deadline, hostile inputs — and the fx-10h IR variants through the real provider
// (`ir-invalid`, `hidden-bench`, `ir-open`, `inj-ir-cleared`, the base).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AnalyticsError, ROSTER_EMPTY_TEXT } from "../../../src/domain/analytics/errors.js";
import {
  COLD_STREAMABILITY,
  HIDDEN_BENCH_RISKS,
  ROSTER_AUDIT,
  analyzeRoster,
  benchTemplate,
  returnCurve,
  type AuditPlayer,
  type RosterAuditRequest,
} from "../../../src/domain/analytics/rosterAudit.js";
import type { StreamOption } from "../../../src/domain/analytics/scheduleStress.js";
import { weeklyValues } from "../../../src/domain/analytics/waivers.js";
import { remainingWeeks, tradeDeadlineStatus } from "../../../src/domain/league/rules.js";
import type { InjuryStatus, Roster } from "../../../src/domain/league/types.js";
import { clockAndRng, ELIGIBLE, instantPacer, referenceSlots, steppingPacer } from "./helpers.js";
import { FX_WEEK, MY_TEAM, fxLeague, type FxLeague } from "./fx10h-world.js";

const WEEKS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

function ap(
  id: number,
  pos: string,
  mean: number,
  slot: number,
  over: Partial<AuditPlayer> & { bye?: number | null; status?: InjuryStatus | null } = {},
): AuditPlayer {
  const { bye = null, status = null, ...rest } = over;
  return {
    player_id: id,
    position: pos,
    eligible_slot_ids: ELIGIBLE[pos] ?? [],
    slot_id: slot,
    injury_status: status,
    pro_team_id: id,
    droppable: true,
    percent_owned: 10,
    weeks: WEEKS.map((w) => ({ week: w, mean: w === bye ? 0 : mean, bye: w === bye })),
    ...rest,
  };
}

/** A legal reference roster: 9 starters, 5 bench, IR empty (2 slots). */
function roster(): AuditPlayer[] {
  return [
    ap(1, "QB", 20, 0, { bye: 9 }),
    ap(2, "RB", 15, 2, { bye: 8 }),
    ap(3, "RB", 13, 2, { bye: 10 }),
    ap(4, "WR", 14, 4, { bye: 8 }),
    ap(5, "WR", 12, 4, { bye: 11 }),
    ap(6, "TE", 9, 6, { bye: 12 }),
    ap(7, "WR", 10, 23, { bye: 13 }),
    ap(8, "D/ST", 7, 16, { bye: 14 }),
    ap(9, "K", 8, 17, { bye: 7 }),
    ap(10, "RB", 9, 20, { bye: 9 }),
    ap(11, "WR", 8.5, 20, { bye: 10 }),
    ap(12, "RB", 4, 20, { bye: 11 }),
    ap(13, "WR", 3, 20, { bye: 12 }),
    ap(14, "TE", 2, 20, { bye: 6 }),
  ];
}

const stream: StreamOption[] = WEEKS.flatMap((w) => [
  { position: "RB", week: w, player_id: 901, points: 7 },
  { position: "WR", week: w, player_id: 902, points: 7.5 },
  { position: "TE", week: w, player_id: 903, points: 6 },
  { position: "QB", week: w, player_id: 904, points: 16 },
]);

function rq(over: Partial<RosterAuditRequest> = {}): RosterAuditRequest {
  const { clock } = clockAndRng("2026-10-13T12:00:00.000Z");
  return {
    roster: referenceSlots(),
    players: roster(),
    weeks: WEEKS,
    current_week: 6,
    playoff_weeks: [15, 16, 17],
    trade_deadline_week: 13,
    season: {
      p_playoffs: 0.7,
      eliminated: false,
      p_alive_by_week: WEEKS.map((w) => ({ week: w, p: w >= 15 ? 0.5 : 1 })),
    },
    streamability: { QB: 0.95, TE: 0.92, K: 1, "D/ST": 1, RB: 0.6, WR: 0.7 },
    stream,
    rules: {
      acquisition_limit: null,
      acquisitions_used: 3,
      next_run_at: "2026-10-14T07:00:00.000Z",
    },
    clock,
    pacer: instantPacer,
    deadline_ms: null,
    ...over,
  };
}

describe("the bench template (research 05 §4.2: derived, never imposed)", () => {
  it("10-team streamability: one K, one D/ST, no bench QB or TE, five RB/WR depth spots", () => {
    expect(benchTemplate(referenceSlots(), { QB: 0.95, TE: 0.92, K: 1, "D/ST": 1 })).toEqual({
      k: 1,
      dst: 1,
      qb_bench: 0,
      te_bench: 0,
      rb_wr_depth: 5,
    });
    expect(benchTemplate(referenceSlots(), { QB: 0.8, TE: 0.5, K: 0.85, "D/ST": 1 })).toEqual({
      k: 2,
      dst: 1,
      qb_bench: 1,
      te_bench: 1,
      rb_wr_depth: 2,
    });
    expect(benchTemplate(referenceSlots(), {})).toMatchObject({
      qb_bench: 1,
      te_bench: 1,
      k: 2,
      dst: 2,
    });
    expect(benchTemplate(referenceSlots(), COLD_STREAMABILITY).qb_bench).toBe(0);
  });

  it("B7 (hard, property): qb_bench == 0 only when streamability.QB ≥ 0.9; the template never exceeds the bench", () => {
    const val = fc.oneof(
      fc.double({ min: -1, max: 2, noNaN: false }),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
    );
    fc.assert(
      fc.property(
        fc.record({ QB: val, TE: val, K: val, "D/ST": val }, { requiredKeys: [] }),
        fc.integer({ min: 0, max: 9 }),
        (s, bench) => {
          const slots = referenceSlots({ "20": bench });
          const t = benchTemplate(slots, s);
          const qb = s.QB;
          if (t.qb_bench === 0 && !(typeof qb === "number" && Number.isFinite(qb) && qb >= 0.9))
            return false;
          if (
            t.te_bench === 0 &&
            !(typeof s.TE === "number" && Number.isFinite(s.TE) && s.TE >= 0.9)
          )
            return false;
          return (
            t.rb_wr_depth >= 0 &&
            t.qb_bench + t.te_bench + t.rb_wr_depth + (t.k - 1) + (t.dst - 1) <=
              Math.max(bench, t.qb_bench + t.te_bench + (t.k - 1) + (t.dst - 1))
          );
        },
      ),
    );
  });

  it("the analysis reports the template from E4's curves, or the cold start when none is passed", async () => {
    const warm = await analyzeRoster(rq());
    expect(warm.data.bench_template.basis).toBe("curves from espn_analyze_replacement");
    expect(warm.data.bench_template.derived.qb_bench).toBe(0);
    expect(warm.data.bench_template.streamability.QB).toBe(0.95);
    const cold = await analyzeRoster(rq({ streamability: null }));
    expect(cold.data.bench_template.basis).toMatch(/^cold start/);
    expect(cold.data.bench_template.streamability).toEqual(COLD_STREAMABILITY);
    const noStream = await analyzeRoster(
      rq({ streamability: { QB: 0.5, TE: 0.95, K: 1, "D/ST": 1 } }),
    );
    expect(noStream.data.bench_template.derived.qb_bench).toBe(1);
  });
});

describe("bench roles and marginal values (sib research 05 §9.1)", () => {
  it("a bench player who starts on byes is bye cover; the deep bench is upside; values sorted", async () => {
    const out = await analyzeRoster(rq());
    const role = new Map(out.data.bench_plan.map((b) => [b.player_id, b]));
    expect(role.get(10)?.role).toBe("bye_cover");
    expect(role.get(10)?.marginal_value).toBeGreaterThan(5);
    // the backup TE starts on the TE's bye (week 12): bye cover — his 2 points that week plus the
    // absence term (the TE out at the weekly hazard), never more than his points over the horizon
    expect(role.get(14)?.role).toBe("bye_cover");
    expect(role.get(14)?.marginal_value).toBeGreaterThanOrEqual(2);
    expect(role.get(14)?.marginal_value).toBeLessThanOrEqual(2 * 11);
    // the deep bench never starts on a bye: at most the small absence term (injury cover) or nothing
    for (const id of [12, 13]) {
      expect(["upside", "injury_cover"]).toContain(role.get(id)?.role);
      expect(role.get(id)?.marginal_value ?? 99).toBeLessThan(role.get(11)?.marginal_value ?? 0);
    }
    const mvs = out.data.bench_plan.map((b) => b.marginal_value);
    expect([...mvs].sort((a, b) => b - a)).toEqual(mvs);
    expect(out.data.bench_plan.every((b) => b.slot === "BE")).toBe(true);
  });

  it("a bench player who never fills a bye but covers injuries is injury cover", async () => {
    // a backup QB on the starter's own bye week never starts on a bye; his value is the absence term
    const players = [
      ...roster().filter((p) => p.player_id !== 14),
      ap(15, "QB", 19, 20, { bye: 9 }),
    ];
    const out = await analyzeRoster(rq({ players }));
    expect(out.data.bench_plan.find((b) => b.player_id === 15)?.role).toBe("injury_cover");
  });

  it("eliminated: every week weighted 0, the rec says nothing changes the season", async () => {
    const out = await analyzeRoster(
      rq({ season: { p_playoffs: 0, eliminated: true, p_alive_by_week: [] } }),
    );
    expect(out.data.competing).toBe("eliminated");
    expect(out.data.bench_plan.every((b) => b.marginal_value === 0)).toBe(true);
    expect(out.data.rec.action).toMatch(/^eliminated/);
    expect(out.data.rec.no_move).toBe(true);
    const forced = await analyzeRoster(
      rq({ competing: "yes", season: { p_playoffs: 0, eliminated: true, p_alive_by_week: [] } }),
    );
    expect(forced.data.competing).toBe("yes");
    const auto = await analyzeRoster(
      rq({ season: { p_playoffs: 0.005, eliminated: false, p_alive_by_week: [] } }),
    );
    expect(auto.data.competing).toBe("eliminated");
  });

  it("consolidation: two bench players who never start, while competing and before the deadline", async () => {
    const out = await analyzeRoster(rq());
    expect(out.data.consolidation_candidates).toHaveLength(1);
    expect(out.data.consolidation_candidates[0]?.give).toHaveLength(2);
    expect(out.data.consolidation_candidates[0]?.target_profile).toMatch(
      /^one (QB|RB|WR|TE) who starts over/,
    );
    const late = await analyzeRoster(rq({ current_week: 14 }));
    expect(late.data.consolidation_candidates).toEqual([]);
  });

  it("droppables: lowest marginal value first, undroppable last and flagged, re-add risk from ownership", async () => {
    const players = roster().map((p) => (p.player_id === 14 ? { ...p, droppable: false } : p));
    const out = await analyzeRoster(rq({ players }));
    const d = out.data.droppable;
    expect(d.length).toBeLessThanOrEqual(ROSTER_AUDIT.maxDroppable);
    expect(d[d.length - 1]).toMatchObject({ player_id: 14, undroppable: true });
    expect(d[0]?.player_id).toBe(13); // ties at marginal value 0 break on the lower ROS value
    expect(d[0]?.re_add_risk).toEqual({ percent_owned: 10, rivals_claiming: null });
  });
});

describe("handcuffs and stashes (research 05 §4.2–§4.3)", () => {
  it("a handcuff is worth P(starter out) × the promoted gain − the slot's alternative use, per case", async () => {
    const promoted = WEEKS.map((w) => ({ week: w, mean: 16 }));
    const big = await analyzeRoster(
      rq({
        handcuffs: [
          {
            handcuff: 12,
            starter: 2,
            promoted,
            p_starter_out: WEEKS.map((w) => ({ week: w, p: 0.5 })),
          },
        ],
      }),
    );
    const v = big.data.handcuff_values[0];
    expect(v?.handcuff).toBe(12);
    expect(v?.value.mean).toBeGreaterThan(0);
    expect(v?.verdict).toMatch(/^hold/);
    expect(big.data.bench_plan.find((b) => b.player_id === 12)?.role).toBe("handcuff");
    expect(big.data.droppable.map((d) => d.player_id)).not.toContain(12);
    const small = await analyzeRoster(rq({ handcuffs: [{ handcuff: 12, starter: 2, promoted }] }));
    expect(small.data.handcuff_values[0]?.verdict).toMatch(/^drop/);
    // an unknown or IR handcuff is skipped
    const none = await analyzeRoster(rq({ handcuffs: [{ handcuff: 999, starter: 2, promoted }] }));
    expect(none.data.handcuff_values).toEqual([]);
  });

  it("a handcuff behind MY starter replaces him when he is out (the starter's absence is scored)", async () => {
    // week 6 only: RB 2 (15) out for sure, RB 12 promoted to 16. Without RB 12 the RB seats hold RB 3
    // (13) and RB 10 (9); with him RB 12 (16) and RB 3, RB 10 losing the FLEX to WR 7 (10): +7
    const out = await analyzeRoster(
      rq({
        stream: [],
        handcuffs: [
          {
            handcuff: 12,
            starter: 2,
            p_starter_out: WEEKS.map((w) => ({ week: w, p: w === 6 ? 1 : 0 })),
            promoted: [{ week: 6, mean: 16 }],
          },
        ],
      }),
    );
    expect(out.data.handcuff_values[0]?.value.mean).toBeCloseTo(7, 6);
    // the same case behind a RIVAL's starter: no absence on my roster — RB 12 at 16 beside RB 2
    const rival = await analyzeRoster(
      rq({
        stream: [],
        handcuffs: [
          {
            handcuff: 12,
            starter: 555,
            p_starter_out: WEEKS.map((w) => ({ week: w, p: w === 6 ? 1 : 0 })),
            promoted: [{ week: 6, mean: 16 }],
          },
        ],
      }),
    );
    // RB 12 (16) and RB 2 (15) take the RB seats, RB 3 (13) the FLEX over WR 7 (10): +6 vs without him
    expect(rival.data.handcuff_values[0]?.value.mean).toBeCloseTo(16 + 15 + 13 - (15 + 13 + 10), 6);
  });

  it("an injured bench player counts at P(returned by then): never more than when healthy; a sure return equals healthy", async () => {
    const healthy = roster().map((p) =>
      p.player_id === 10
        ? { ...p, weeks: p.weeks.map((w) => ({ ...w, mean: w.bye ? 0 : 20 })) }
        : p,
    );
    const out = healthy.map((p) =>
      p.player_id === 10 ? { ...p, injury_status: "OUT" as const } : p,
    );
    const sure = out.map((p) =>
      p.player_id === 10 ? { ...p, return_by_week: WEEKS.map((w) => ({ week: w, p: 1 })) } : p,
    );
    const mv = async (players: AuditPlayer[]) =>
      (await analyzeRoster(rq({ players, stream: [] }))).data.bench_plan.find(
        (b) => b.player_id === 10,
      )?.marginal_value ?? -1;
    const [h, o, s1] = [await mv(healthy), await mv(out), await mv(sure)];
    expect(o).toBeLessThan(h);
    expect(s1).toBeCloseTo(h, 6);
  });

  it("returnCurve: OUT returns at the weekly hazard from next week; IR not before 4 weeks; Q/D now; input wins", () => {
    const out = returnCurve({ injury_status: "OUT" }, [6, 7, 8], 6);
    expect(out.map((x) => x.p)).toEqual([0, 0.5, 0.75]);
    const ir = returnCurve({ injury_status: "INJURY_RESERVE" }, [6, 7, 8, 9, 10], 6);
    expect(ir.map((x) => x.p)).toEqual([0, 0, 0, 0, 0.3]);
    expect(returnCurve({ injury_status: "QUESTIONABLE" }, [6, 7], 6).map((x) => x.p)).toEqual([
      1, 1,
    ]);
    const given = returnCurve(
      {
        injury_status: "OUT",
        return_by_week: [
          { week: 7, p: 0.2 },
          { week: 9, p: 0.9 },
        ],
      },
      [6, 7, 8, 9],
      6,
    );
    expect(given.map((x) => x.p)).toEqual([0, 0.2, 0.2, 0.9]);
  });

  it("an IR stash holds value; past the deadline one who cannot return before the playoffs is a streamer", async () => {
    const players = [...roster(), ap(20, "WR", 16, 21, { status: "INJURY_RESERVE" })];
    const out = await analyzeRoster(rq({ players }));
    const s = out.data.stash_values.find((x) => x.player_id === 20);
    expect(s?.value.mean).toBeGreaterThan(0);
    expect(s?.verdict).toBe("hold");
    expect(out.data.ir.effective_bench).toBe(6);
    const late = await analyzeRoster(
      rq({
        players: players.map((p) =>
          p.player_id === 20 ? { ...p, return_by_week: [{ week: 17, p: 0.02 }] } : p,
        ),
        current_week: 14,
        weeks: [14, 15, 16, 17],
      }),
    );
    const ls = late.data.stash_values.find((x) => x.player_id === 20);
    expect(ls?.value.mean).toBe(0);
    expect(ls?.verdict).toBe("drop for a streamer");
    expect(ls?.playoff_horizon_note).toMatch(/drop for a streamer$/);
    expect(late.data.ir.effective_bench).toBe(5);
    expect(late.data.phase).toBe("late");
  });
});

describe("the IR section (research 05 §4.3; plan 10 B7)", () => {
  const invalidRoster = (): AuditPlayer[] => [
    ...roster(),
    ap(20, "WR", 16, 21, { status: "ACTIVE" }), // cleared while in IR → INVALID
    ap(21, "RB", 6, 21, { status: "OUT" }),
  ];

  it("B7 (hard): an invalid roster reports the IR section FIRST — the first key, the rec's action and driver", async () => {
    const out = await analyzeRoster(rq({ players: invalidRoster() }));
    expect(Object.keys(out.data)[0]).toBe("ir");
    expect(JSON.stringify(out.data).startsWith('{"ir":')).toBe(true);
    expect(out.data.ir.invalid).toBe(true);
    expect(out.data.ir.invalid_players).toEqual([20]);
    expect(out.data.rec.action).toMatch(/^roster INVALID: move 1 player out of IR before any add/);
    expect(out.data.rec.drivers[0]?.name).toBe("ir_invalid");
    expect(out.data.rec.subjects[0]).toMatchObject({ player_id: 20, role: "ir_move", slot: "IR" });
    expect(out.data.rec.no_move).toBe(false);
    expect(out.data.rec.latest_execution_time).toBe("2026-10-14T07:00:00.000Z");
    // a valid roster keeps the documented field order (ir last)
    const ok = await analyzeRoster(rq());
    expect(Object.keys(ok.data)[0]).toBe("phase");
    expect(Object.keys(ok.data).at(-1)).toBe("ir");
  });

  it("the forced drop: needed only when the active roster overflows; the hidden-bench acquisition first", async () => {
    const out = await analyzeRoster(rq({ players: invalidRoster() }));
    // the cleared player returns to a full bench: 15 active on 14 seats → a forced drop, the lowest
    // marginal value (ties on the lower ROS value)
    expect(out.data.ir.forced_drop).toBe(13);
    expect(out.data.rec.subjects.map((s) => s.role)).toEqual(["ir_move", "drop"]);
    const designated = await analyzeRoster(
      rq({ players: invalidRoster(), hidden_bench_acquired: 11 }),
    );
    expect(designated.data.ir.forced_drop).toBe(11);
    const room = invalidRoster().filter((p) => p.player_id !== 14);
    expect((await analyzeRoster(rq({ players: room }))).data.ir.forced_drop).toBeNull();
  });

  it("B7 (hard): the hidden-bench play carries exactly three risks — in progress, possible, or not available", async () => {
    expect(HIDDEN_BENCH_RISKS).toHaveLength(3);
    // in progress: a Questionable player stays in IR
    const prog = await analyzeRoster(
      rq({ players: [...roster(), ap(20, "WR", 12, 21, { status: "QUESTIONABLE" })] }),
    );
    expect(prog.data.ir.hidden_bench_play).toEqual({
      available: true,
      player_id: 20,
      risks: HIDDEN_BENCH_RISKS,
    });
    expect(prog.data.ir.invalid).toBe(false);
    expect(prog.data.ir.activation_timing_warning).toMatch(
      /after the next waiver run \(2026-10-14T07:00:00.000Z\)/,
    );
    // possible: an OUT player on the bench and an open IR slot → the rec moves him
    const players = roster().map((p) =>
      p.player_id === 11 ? { ...p, injury_status: "OUT" as const } : p,
    );
    const poss = await analyzeRoster(rq({ players }));
    expect(poss.data.ir.hidden_bench_play).toEqual({
      available: true,
      player_id: 11,
      risks: HIDDEN_BENCH_RISKS,
    });
    expect(poss.data.ir.eligible_now).toEqual([{ player_id: 11, tag: "OUT" }]);
    expect(poss.data.rec.subjects).toEqual([
      { player_id: 11, gsis_id: null, role: "ir_move", slot: "IR" },
    ]);
    expect(poss.data.rec.action).toMatch(/three risks/);
    // not available: nobody OUT; no IR slots → null
    const none = await analyzeRoster(rq());
    expect(none.data.ir.hidden_bench_play).toEqual({
      available: false,
      player_id: null,
      risks: HIDDEN_BENCH_RISKS,
    });
    expect(none.data.ir.activation_timing_warning).toBeNull();
    const noIr = await analyzeRoster(rq({ roster: referenceSlots({ "21": 0 }) }));
    expect(noIr.data.ir.hidden_bench_play).toBeNull();
    for (const r of [prog, poss, none]) expect(r.data.ir.hidden_bench_play?.risks.length).toBe(3);
  });

  it("two cleared IR players: the plural action; no next run known → the timing warning without a time", async () => {
    const players = [
      ...roster().filter((p) => p.player_id !== 13 && p.player_id !== 14),
      ap(20, "WR", 16, 21, { status: "ACTIVE" }),
      ap(21, "RB", 6, 21, { status: null }),
    ];
    const out = await analyzeRoster(
      rq({
        players,
        rules: { acquisition_limit: null, acquisitions_used: null, next_run_at: null },
      }),
    );
    expect(out.data.rec.action).toMatch(/^roster INVALID: move 2 players out of IR/);
    expect(out.data.ir.invalid_players).toEqual([20, 21]);
    expect(out.data.ir.activation_timing_warning).toBe(
      "activate an IR player after a waiver run, never the night before — a pending claim fails if the bench fills before it processes",
    );
    expect(out.data.rec.latest_execution_time).toBeNull();
  });

  it("no playoff weeks known: a stash is valued over the horizon, never zeroed by the playoff rule", async () => {
    const players = [...roster(), ap(20, "WR", 16, 21, { status: "INJURY_RESERVE" })];
    const out = await analyzeRoster(
      rq({
        players,
        playoff_weeks: [],
        trade_deadline_week: null,
        current_week: 14,
        weeks: [14, 15, 16, 17],
      }),
    );
    expect(out.data.phase).toBe("mid");
    expect(out.data.stash_values[0]?.playoff_horizon_note).toBeNull();
  });

  it("an IR occupant whose status no ESPN page rules on is named, never silently counted", async () => {
    const out = await analyzeRoster(
      rq({ players: [...roster(), ap(20, "WR", 12, 21, { status: "DAY_TO_DAY" })] }),
    );
    expect(out.warnings[0]).toMatch(/status no ESPN page rules on/);
    expect(out.data.ir.invalid).toBe(false);
  });
});

describe("phase, adds, bounds", () => {
  it("phase: early through week 4, late from the deadline (or two weeks before the playoffs without one)", async () => {
    expect((await analyzeRoster(rq({ current_week: 3 }))).data.phase).toBe("early");
    expect((await analyzeRoster(rq({ current_week: 8 }))).data.phase).toBe("mid");
    expect((await analyzeRoster(rq({ current_week: 13 }))).data.phase).toBe("late");
    expect(
      (await analyzeRoster(rq({ current_week: 13, trade_deadline_week: null }))).data.phase,
    ).toBe("late");
    expect(
      (await analyzeRoster(rq({ current_week: 12, trade_deadline_week: null }))).data.phase,
    ).toBe("mid");
  });

  it("adds remaining: null when unlimited, the limit less the used adds, never negative", async () => {
    expect((await analyzeRoster(rq())).data.adds_remaining).toBeNull();
    const lim = { acquisition_limit: 10, acquisitions_used: 3, next_run_at: null };
    expect((await analyzeRoster(rq({ rules: lim }))).data.adds_remaining).toBe(7);
    expect(
      (await analyzeRoster(rq({ rules: { ...lim, acquisitions_used: 12 } }))).data.adds_remaining,
    ).toBe(0);
    expect(
      (await analyzeRoster(rq({ rules: { ...lim, acquisitions_used: null } }))).data.adds_remaining,
    ).toBe(10);
  });

  it("cooperative: the CPU deadline returns partial; hostile inputs are refused", async () => {
    const out = await analyzeRoster(rq({ pacer: steppingPacer(10), deadline_ms: 12 }));
    expect(out.partial).toBe(true);
    expect(out.data.bench_plan.length).toBeLessThan(5);
    await expect(analyzeRoster(rq({ players: [] }))).rejects.toBeInstanceOf(AnalyticsError);
    // Stage C round 2 (analytics-empty-roster-validation): a league state, never VALIDATION
    await expect(analyzeRoster(rq({ players: [] }))).rejects.toMatchObject({
      code: "roster_empty",
      effCode: "NOT_FOUND",
      effDetails: {
        reason: "roster_empty",
        message: ROSTER_EMPTY_TEXT.message,
        hint: ROSTER_EMPTY_TEXT.hint,
      },
    });
    await expect(analyzeRoster(rq({ players: [...roster(), roster()[0]!] }))).rejects.toThrow(
      /twice/,
    );
    await expect(analyzeRoster(rq({ weeks: [] }))).rejects.toThrow(/weeks/);
    await expect(analyzeRoster(rq({ weeks: [23] }))).rejects.toThrow(/weeks/);
    await expect(analyzeRoster(rq({ current_week: 0 }))).rejects.toThrow(/week/);
  });

  it("no stream baseline: values against an empty seat, named in the assumptions", async () => {
    const out = await analyzeRoster(rq({ stream: [] }));
    expect(out.data.rec.assumptions.some((a) => a.text.startsWith("no stream baseline"))).toBe(
      true,
    );
  });
});

// --- the fx-10h IR variants through the provider ----------------------------------------------------

function auditPlayers(fx: FxLeague, r: Roster, weeks: readonly number[]): AuditPlayer[] {
  return r.entries.map((e) => {
    const vals = weeklyValues(
      weeks,
      e.player.projection_week_espn,
      e.player.projection_ros_espn,
      e.player.bye_week,
    );
    return {
      player_id: e.player.ref.id,
      position: e.player.position,
      eligible_slot_ids: e.player.eligible_slot_ids,
      slot_id: e.slot_id,
      injury_status: e.player.injury_status,
      pro_team_id: e.player.pro_team_id,
      droppable: e.player.droppable,
      percent_owned: e.player.ownership?.percent_owned ?? null,
      weeks: weeks.map((w, i) => ({ week: w, mean: vals[i] ?? 0, bye: w === e.player.bye_week })),
    };
  });
}

async function auditVariant(variant: string) {
  const fx = await fxLeague(variant);
  const r = fx.rosters.find((x) => x.team.team_id === MY_TEAM);
  if (r === undefined) throw new Error("no roster");
  const weeks = remainingWeeks(fx.rules.playoffs, FX_WEEK);
  return analyzeRoster({
    roster: fx.slots,
    players: auditPlayers(fx, r, weeks),
    weeks,
    current_week: FX_WEEK,
    playoff_weeks: fx.rules.playoffs.playoff_weeks,
    trade_deadline_week: 13,
    rules: {
      acquisition_limit: fx.rules.waiver.acquisition_limit,
      acquisitions_used: null,
      next_run_at: fx.rules.waiver.next_execution,
    },
    clock: fx.clock,
    pacer: instantPacer,
    deadline_ms: null,
  });
}

describe("fx-10h IR variants (research 05 §4.3; plan 09 RA-2..RA-4, RA-INJ)", () => {
  it("ir-invalid: an ACTIVE player in IR → INVALID, the IR section first, adds blocked", async () => {
    const out = await auditVariant("ir-invalid");
    expect(Object.keys(out.data)[0]).toBe("ir");
    expect(out.data.ir.invalid).toBe(true);
    expect(out.data.ir.invalid_players).toHaveLength(1);
    expect(out.data.rec.action).toMatch(/^roster INVALID/);
  });

  it("hidden-bench: a Questionable player in IR may stay — the play in progress, three risks, the timing warning", async () => {
    const out = await auditVariant("hidden-bench");
    expect(out.data.ir.invalid).toBe(false);
    expect(out.data.ir.hidden_bench_play?.available).toBe(true);
    expect(out.data.ir.hidden_bench_play?.risks).toEqual(HIDDEN_BENCH_RISKS);
    expect(out.data.ir.activation_timing_warning).not.toBeNull();
    expect(Object.keys(out.data)[0]).toBe("phase");
  });

  it("ir-open and the base: an OUT bench player and an open IR slot → move him (the slot freed)", async () => {
    for (const v of ["ir-open", ""]) {
      const out = await auditVariant(v);
      expect(out.data.ir.invalid, v).toBe(false);
      expect(out.data.ir.eligible_now.length, v).toBeGreaterThan(0);
      expect(
        out.data.ir.eligible_now.every((x) => x.tag === "OUT" || x.tag === "INJURY_RESERVE"),
        v,
      ).toBe(true);
      expect(out.data.rec.subjects[0]?.role, v).toBe("ir_move");
    }
  });

  it("inj-ir-cleared: the IR player is still OUT — IR valid, no forced move", async () => {
    const out = await auditVariant("inj-ir-cleared");
    expect(out.data.ir.invalid).toBe(false);
    expect(out.data.ir.forced_drop).toBeNull();
    expect(out.data.rec.action).not.toMatch(/INVALID/);
  });
});

// Stage C round 2, finding roster-audit-deadline-by-week (plan 07 E9 "zero after the deadline";
// research 05 §4.3 item 2; changelog R6 era): the owner's deadline is 2026-12-02 17:00Z and week 13's
// first kickoff is Thursday the 3rd, so `first_week_after` = 13 — but ESPN rolls the scoring period
// to 13 by Tuesday, and E9 judged the phase by that week number: from Tuesday until Wednesday noon
// ET, while trades were still open, it dropped the consolidation idea and zeroed stash trade value
// "past the trade deadline", contradicting espn_analyze_trade at the same instant. With the deadline
// instant passed, the phase is the instant against the clock — tradeDeadlineStatus, E6's own rule.
describe("the trade deadline is an instant, not a week (finding roster-audit-deadline-by-week)", () => {
  const DEADLINE = "2026-12-02T17:00:00.000Z";
  const LATE_WEEKS = [13, 14, 15, 16, 17];
  /**
   * A stash unlikely back by the playoffs (P(returned by week 15) 0.04) but likely by week 17 (0.9):
   * worth holding while he can still be traded, a streamer once he cannot.
   */
  const stashed = (): AuditPlayer[] => [
    ...roster(),
    ap(20, "WR", 16, 21, {
      status: "INJURY_RESERVE",
      return_by_week: [
        { week: 15, p: 0.04 },
        { week: 17, p: 0.9 },
      ],
    }),
  ];
  const at = (iso: string, week: number, over: Partial<RosterAuditRequest> = {}) =>
    analyzeRoster(
      rq({
        clock: clockAndRng(iso).clock,
        current_week: week,
        weeks: LATE_WEEKS.filter((w) => w >= week).length > 0 ? LATE_WEEKS : [week],
        players: stashed(),
        trade_deadline_week: 13,
        trade_deadline: DEADLINE,
        ...over,
      }),
    );
  const stashOf = (d: Awaited<ReturnType<typeof analyzeRoster>>["data"]) =>
    d.stash_values.find((x) => x.player_id === 20);

  it("Tuesday and Wednesday morning of week 13, before the deadline: still mid — consolidation offered, the stash keeps its trade value", async () => {
    // regression: the scoring period was already 13, so both instants read "late"
    for (const iso of ["2026-12-02T03:00:00.000Z", "2026-12-02T16:00:00.000Z"]) {
      const out = await at(iso, 13);
      expect(out.data.phase, iso).toBe("mid");
      expect(out.data.consolidation_candidates.length, iso).toBeGreaterThan(0);
      expect(stashOf(out.data)?.playoff_horizon_note, iso).toBeNull();
      expect(stashOf(out.data)?.value.mean ?? 0, iso).toBeGreaterThan(0);
      expect(stashOf(out.data)?.verdict, iso).toBe("hold");
    }
  });

  it("from the deadline instant on (inclusive): late — no consolidation, the stash is a streamer", async () => {
    for (const iso of [DEADLINE, "2026-12-02T18:00:00.000Z", "2026-12-08T12:00:00.000Z"]) {
      const out = await at(iso, 13);
      expect(out.data.phase, iso).toBe("late");
      expect(out.data.consolidation_candidates, iso).toEqual([]);
      expect(stashOf(out.data)?.value.mean, iso).toBe(0);
      expect(stashOf(out.data)?.verdict, iso).toBe("drop for a streamer");
      expect(stashOf(out.data)?.playoff_horizon_note, iso).toMatch(/^past the trade deadline/);
    }
  });

  it("property: E9 is late exactly when E6's tradeDeadlineStatus says the deadline passed", async () => {
    const at0 = Date.parse(DEADLINE);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -4 * 86_400_000, max: 4 * 86_400_000 }),
        fc.constantFrom(12, 13, 14),
        async (offset, week) => {
          const iso = new Date(at0 + offset).toISOString();
          const out = await at(iso, week, { players: roster() });
          const passed = tradeDeadlineStatus({ deadline: DEADLINE }, at0 + offset).passed;
          expect(out.data.phase === "late").toBe(passed === true);
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);

  it("a league without a deadline (null): the playoff fallback; the week alone (no instant passed) is read as before", async () => {
    expect((await at("2026-12-02T03:00:00.000Z", 13, { trade_deadline: null })).data.phase).toBe(
      "late",
    );
    expect((await at("2026-11-24T03:00:00.000Z", 12, { trade_deadline: null })).data.phase).toBe(
      "mid",
    );
    const { trade_deadline: _omit, ...legacy } = rq({
      clock: clockAndRng("2026-12-02T03:00:00.000Z").clock,
      current_week: 13,
      weeks: LATE_WEEKS,
    });
    expect((await analyzeRoster(legacy)).data.phase).toBe("late");
  });
});
