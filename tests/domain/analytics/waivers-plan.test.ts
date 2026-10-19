// waivers-plan.test.ts — Stage C round 2, finding waivers-postrun-adds-unbounded-same-drop (plan 07
// E5: the claim list, the scramble list and the Rec; research 05 §1.4 "the long ordered list because
// failing is free", §1.5 the Wednesday FA brief, §4.2 "K and D/ST: exactly one of each … drop-and-
// stream, not carry-two"). Every claim and add is valued alone against today's roster; the Rec used
// to list every one of them with its own conditional drop, unbounded — so after the run "add N free
// agents now" repeated one drop N times (the second add has no drop left, and its surplus was the
// first add's), and a kicker stream with more than ten kickers worth adding overflowed the Rec's 20
// subjects (the tool answered INTERNAL). The Rec now carries a plan whose moves can all be made
// together: claims in order with their own drop (a later claim on an earlier claim's drop is its
// fallback in the ordered list), then the free-agent adds chained greedily — each on the best drop no
// earlier move uses, valued on the roster the moves before it leave, while it still gains — one K and
// one D/ST, at most PLAN_MAX_MOVES moves. Synthetic data only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  analyzeWaivers,
  PLAN_MAX_MOVES,
  planPartialLine,
  type WaiverCandidateInput,
  type WaiverPlayer,
  type WaiverRequest,
} from "../../../src/domain/analytics/waivers.js";
import { analyzeWaiversP1 } from "../../../src/domain/analytics/waiversP1.js";
import type { RecSubject, WaiversData } from "../../../src/domain/analytics/types.js";
import { REC_LIMITS } from "../../../src/mcp/envelope.js";
import { RECORD_BOUNDS } from "../../../src/domain/reclog/record.js";
import { clockAndRng, referenceRules } from "./helpers.js";
import { myRoster, SLOT, waiverRequest, WEEKS, wc } from "./p1-helpers.js";

/** Wednesday after the run (last run 2026-10-08 07:00Z, the call at 12:00Z): the scramble. */
const POST_RUN = {
  rules: referenceRules({
    last_ms: Date.UTC(2026, 9, 8, 7, 0),
    next_ms: Date.UTC(2026, 9, 9, 7, 0),
  }),
  clock: clockAndRng("2026-10-08T12:00:00.000Z").clock,
};

/** My roster with RB 14, the last bench player, worth nothing (the finding's repro). */
const zeroBench = (): WaiverPlayer[] =>
  myRoster().map((p) => (p.player_id === 14 ? { ...p, weekly: WEEKS.map(() => 0) } : p));

const post = (over: Partial<WaiverRequest> = {}): WaiverRequest =>
  waiverRequest({ ...POST_RUN, mine: zeroBench(), ...over });

type Data = WaiversData;
const byId = (d: Data, id: number) => d.candidates.find((x) => x.player_id === id);
const moves = (subjects: readonly RecSubject[]) =>
  subjects.filter((s) => s.role === "add" || s.role === "claim");
const dropsOf = (subjects: readonly RecSubject[]) =>
  subjects.filter((s) => s.role === "drop").map((s) => s.player_id);

/** My roster after the plan's moves: each drop leaves, each add or claim sits on the bench. */
function afterPlan(
  roster: readonly WaiverPlayer[],
  subjects: readonly RecSubject[],
  candidates: readonly WaiverCandidateInput[],
): WaiverPlayer[] {
  let out = [...roster];
  for (const s of subjects) {
    if (s.role === "drop") out = out.filter((p) => p.player_id !== s.player_id);
    else {
      const c = candidates.find((x) => x.player_id === s.player_id);
      if (c !== undefined) {
        const { status: _s, waiver_process_date: _w, percent_change: _p, ...player } = c;
        out.push({ ...player, slot_id: SLOT.BE });
      }
    }
  }
  return out;
}

describe("the post-run scramble: adds chained on distinct drops (the finding's repro c)", () => {
  const CANDS = [wc(201, "WR", 9.5, "FREEAGENT"), wc(202, "RB", 9, "FREEAGENT")];

  it("the second add never reuses the first add's drop; its surplus is the one it has once the first is made", async () => {
    const out = await analyzeWaivers(post({ candidates: CANDS }));
    // alone, both name RB 14 (the regression listed add 201 / drop 14 / add 202 / drop 14)
    expect(byId(out.data, 201)?.conditional_drop?.player_id).toBe(14);
    expect(byId(out.data, 202)?.conditional_drop?.player_id).toBe(14);
    // the same call made after the first add: what 202 is worth then, and the drop he needs
    const rerun = await analyzeWaivers(
      post({
        mine: afterPlan(zeroBench(), out.data.rec.subjects.slice(0, 2), CANDS),
        candidates: [wc(202, "RB", 9, "FREEAGENT")],
      }),
    );
    const second = byId(rerun.data, 202);
    expect(second?.verdict).toBe("fa_add_now");
    expect(second?.conditional_drop?.player_id).not.toBe(14);
    expect(out.data.rec.subjects).toEqual([
      { player_id: 201, gsis_id: null, role: "add", slot: null },
      { player_id: 14, gsis_id: null, role: "drop", slot: null },
      { player_id: 202, gsis_id: null, role: "add", slot: null },
      { player_id: second?.conditional_drop?.player_id, gsis_id: null, role: "drop", slot: null },
    ]);
    // its own s in the plan: the driver carries the chained value, not the alone value
    expect(out.data.rec.drivers).toContainEqual({ name: "surplus:202", contribution: second?.s });
    expect(second?.s ?? 0).toBeLessThan(byId(out.data, 202)?.s ?? 0);
    expect(out.data.rec.action).toBe("add 2 free agents now");
    // and the drop it names differs from the one it names alone: said
    const said = out.data.rec.assumptions.find((a) =>
      a.text.startsWith("the plan's adds are chained"),
    );
    expect(said?.text).toContain(`202 drops ${String(second?.conditional_drop?.player_id)}`);
  });

  it("an add that gains nothing once the earlier adds are made stays out of the plan, said in the action", async () => {
    // three WRs of 9.5, 9.4 and 9.3: each alone starts over my WR 8 / FLEX 7.5 — but once the first
    // two are in (WR2 and FLEX), the third never starts: he waits for a call after those moves
    const cands = [
      wc(201, "WR", 9.5, "FREEAGENT"),
      wc(203, "WR", 9.4, "FREEAGENT"),
      wc(205, "WR", 9.3, "FREEAGENT"),
    ];
    const out = await analyzeWaivers(post({ candidates: cands }));
    for (const id of [201, 203, 205]) expect(byId(out.data, id)?.verdict).toBe("fa_add_now");
    expect(out.data.rec.subjects).toEqual([
      { player_id: 201, gsis_id: null, role: "add", slot: null },
      { player_id: 14, gsis_id: null, role: "drop", slot: null },
      { player_id: 203, gsis_id: null, role: "add", slot: null },
      { player_id: 13, gsis_id: null, role: "drop", slot: null },
    ]);
    expect(out.data.rec.action).toBe(
      "add 2 free agents now; 1 more free agent after these moves: call again then",
    );
  });
});

describe("the post-run kicker stream (the finding's repro a): one K, bounded", () => {
  // twelve free-agent kickers, every one better than my K (8 a week)
  const KICKERS = Array.from({ length: 12 }, (_, i) =>
    wc(400 + i, "K", 9 + i, "FREEAGENT", { pro_team_id: (i % 30) + 1 }),
  );

  it("never more than 20 subjects: one kicker added, my K dropped — never a second K", async () => {
    // regression: 12 fa_add_now kickers each with a drop → 24 subjects → the tool's schema refused
    // the result (INTERNAL)
    const out = await analyzeWaivers(
      post({ positions: ["K"], candidates: KICKERS, look_ahead: 2 }),
    );
    const faNow = out.data.candidates.filter((c) => c.verdict === "fa_add_now");
    expect(faNow.length).toBe(12);
    for (const c of faNow) expect(c.conditional_drop?.player_id).toBe(9);
    expect(out.data.rec.subjects).toEqual([
      { player_id: 411, gsis_id: null, role: "add", slot: null },
      { player_id: 9, gsis_id: null, role: "drop", slot: null },
    ]);
    expect(out.data.rec.action).toBe(
      "add 1 free agent now; 11 more free agents after these moves: call again then",
    );
    const roster = afterPlan(zeroBench(), out.data.rec.subjects, KICKERS);
    expect(roster.filter((p) => p.position === "K")).toHaveLength(1);
  });

  it("K and D/ST in one call: one of each", async () => {
    const dsts = Array.from({ length: 6 }, (_, i) =>
      wc(500 + i, "D/ST", 8 + i, "FREEAGENT", { pro_team_id: (i % 30) + 2 }),
    );
    const out = await analyzeWaivers(
      post({ positions: ["K", "D/ST"], candidates: [...KICKERS, ...dsts] }),
    );
    const roster = afterPlan(zeroBench(), out.data.rec.subjects, [...KICKERS, ...dsts]);
    expect(roster.filter((p) => p.position === "K")).toHaveLength(1);
    expect(roster.filter((p) => p.position === "D/ST")).toHaveLength(1);
    expect(moves(out.data.rec.subjects).map((s) => s.player_id)).toEqual([411, 505]);
    expect(dropsOf(out.data.rec.subjects).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([8, 9]);
  });

  it("with my K slot empty, a kicker may take any drop — but the plan still adds only one", async () => {
    const noK = zeroBench().filter((p) => p.player_id !== 9);
    const out = await analyzeWaivers(post({ mine: noK, positions: ["K"], candidates: KICKERS }));
    // a seat is open (13 active): the best kicker takes it; no second kicker joins
    expect(out.data.rec.subjects).toEqual([
      { player_id: 411, gsis_id: null, role: "add", slot: null },
    ]);
  });
});

describe("K and D/ST stream in place (research 05 §4.2: drop-and-stream, not carry-two)", () => {
  it("a streamer drops the K he replaces: a worse one passes on the loss; an open IR move changes nothing for him", async () => {
    const roster = myRoster()
      .map((x) => (x.player_id === 11 ? { ...x, injury_status: "OUT" as const } : x))
      .filter((x) => x.player_id !== 15); // an open IR seat and an IR-eligible bench player
    const out = await analyzeWaivers(
      waiverRequest({
        mine: roster,
        candidates: [wc(106, "K", 6), wc(107, "K", 12, "FREEAGENT"), wc(101, "WR", 14)],
      }),
    );
    const worse = byId(out.data, 106);
    const better = byId(out.data, 107);
    expect(worse).toMatchObject({ verdict: "pass", conditional_drop: { player_id: 9 } });
    expect(worse?.s ?? 0).toBeLessThan(0);
    expect(better).toMatchObject({ verdict: "fa_add_now", conditional_drop: { player_id: 9 } });
    // the IR-move version: the streamer still drops the one he replaces — the same s, no warning
    expect(better?.s_with_ir_move).toBe(better?.s);
    expect(better?.conditional_drop?.activation_warning).toBeNull();
    // a WR still sees both versions, with the IR warning
    expect(byId(out.data, 101)?.s_with_ir_move ?? 0).toBeGreaterThanOrEqual(
      byId(out.data, 101)?.s ?? 0,
    );
    expect(byId(out.data, 101)?.conditional_drop?.activation_warning).toContain("IR move");
  });

  it("include_drop false: no drop at all, even for a streamer", async () => {
    const out = await analyzeWaivers(
      waiverRequest({ include_drop: false, candidates: [wc(107, "K", 12, "FREEAGENT")] }),
    );
    expect(byId(out.data, 107)?.conditional_drop).toBeNull();
    expect(out.data.rec.subjects).toEqual([
      { player_id: 107, gsis_id: null, role: "add", slot: null },
    ]);
  });
});

describe("claims: the ordered list stays whole, the Rec holds what can win together", () => {
  it("at k = N every positive claim is listed and submitted; the Rec stays within its 20 subjects", async () => {
    // regression: 14 claims × (claim + drop) = 28 subjects
    const cands = Array.from({ length: 14 }, (_, i) =>
      wc(600 + i, i % 2 === 0 ? "WR" : "RB", 10 + i * 0.5, "WAIVERS"),
    );
    const out = await analyzeWaivers(waiverRequest({ k: 10, candidates: cands }));
    expect(out.data.claim_list.length).toBe(14);
    expect(out.data.rec.action).toMatch(/^submit 14 ordered claims(;|$)/);
    expect(out.data.rec.subjects.length).toBeLessThanOrEqual(REC_LIMITS.subjects);
    // the top claim leads with its own drop; a claim on an earlier claim's drop is its fallback
    const top = out.data.candidates.find((c) => c.claim_rank === 1);
    expect(out.data.rec.subjects.slice(0, 2)).toEqual([
      { player_id: top?.player_id, gsis_id: null, role: "claim", slot: null },
      { player_id: top?.conditional_drop?.player_id, gsis_id: null, role: "drop", slot: null },
    ]);
    for (const s of moves(out.data.rec.subjects)) {
      const c = byId(out.data, s.player_id ?? -1);
      const i = out.data.rec.subjects.indexOf(s);
      expect(out.data.rec.subjects[i + 1]).toEqual({
        player_id: c?.conditional_drop?.player_id,
        gsis_id: null,
        role: "drop",
        slot: null,
      });
    }
    expect(new Set(dropsOf(out.data.rec.subjects)).size).toBe(
      dropsOf(out.data.rec.subjects).length,
    );
  });

  it("a claim and an immediate add on the same drop: the claim keeps it, the add takes another", async () => {
    // the reference scenario: claim 101 (drop 14) and free agent 105 (alone: drop 14)
    const out = await analyzeWaivers(waiverRequest());
    expect(byId(out.data, 105)?.conditional_drop?.player_id).toBe(14);
    const subj = out.data.rec.subjects;
    expect(subj.slice(0, 2)).toEqual([
      { player_id: 101, gsis_id: null, role: "claim", slot: null },
      { player_id: 14, gsis_id: null, role: "drop", slot: null },
    ]);
    expect(new Set(dropsOf(subj)).size).toBe(dropsOf(subj).length);
    if (moves(subj).some((s) => s.player_id === 105))
      expect(dropsOf(subj).filter((d) => d === 14)).toHaveLength(1);
  });
});

describe("bounds and the P1 layer", () => {
  it("the plan's bound is the Rec's subject cap, held equal to the envelope and the log", () => {
    expect(PLAN_MAX_MOVES * 2).toBe(REC_LIMITS.subjects);
    expect(REC_LIMITS.subjects).toBe(RECORD_BOUNDS.subjects);
  });

  it("FAAB at P1: the bids re-planned — each claim with its own drop, bounded, no drop twice", async () => {
    const cands = Array.from({ length: 14 }, (_, i) =>
      wc(700 + i, i % 2 === 0 ? "WR" : "RB", 11 + i, "WAIVERS"),
    );
    const out = await analyzeWaiversP1({
      ...waiverRequest({ rules: referenceRules({ uses_budget: true }), candidates: cands }),
      value_basis: "espn_ros",
      mode: "faab",
    });
    expect(out.data.mode_used).toBe("faab");
    const subj = out.data.rec.subjects;
    expect(subj.length).toBeLessThanOrEqual(REC_LIMITS.subjects);
    expect(new Set(dropsOf(subj)).size).toBe(dropsOf(subj).length);
    for (const s of moves(subj)) expect(byId(out.data, s.player_id ?? -1)?.verdict).toBe("claim");
  });

  it("a deadline-stopped plan keeps its first move — made before any budgeted work — and says it stopped", async () => {
    const cands = Array.from({ length: 6 }, (_, i) => wc(800 + i, "WR", 9 + i, "FREEAGENT"));
    const out = await analyzeWaivers(post({ candidates: cands }));
    const adds = out.data.candidates.filter((c) => c.verdict === "fa_add_now");
    expect(adds.length).toBe(6);
    expect(moves(out.data.rec.subjects).length).toBeGreaterThan(1);
    // the same plan with no CPU left: the first move only, partial
    const plan = await out.planner({ claims: [], adds, deadline_ms: 0 });
    expect(plan.partial).toBe(true);
    expect(plan.moves.map((m) => m.player_id)).toEqual([adds[0]?.player_id]);
    expect(plan.later_adds).toBe(5);
    expect(planPartialLine(plan)).toBe(
      "partial: the plan stops at 1 move before the CPU deadline: call again after making them",
    );
  });

  it("property: the Rec is always a plan that can be carried out — bounded, every drop once, one K and one D/ST, led by the top move", async () => {
    const POS = ["QB", "RB", "WR", "TE", "K", "D/ST"] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            pos: fc.constantFrom(...POS),
            v: fc.double({ min: 0, max: 22, noNaN: true }),
            fa: fc.boolean(),
          }),
          { minLength: 1, maxLength: 24 },
        ),
        fc.integer({ min: 1, max: 10 }),
        fc.boolean(),
        fc.boolean(),
        async (spec, k, after, openSeat) => {
          const candidates = spec.map((x, i) =>
            wc(900 + i, x.pos, x.v, x.fa ? "FREEAGENT" : "WAIVERS", {
              pro_team_id: (i % 30) + 1,
            }),
          );
          const mine = openSeat ? zeroBench().filter((p) => p.player_id !== 14) : zeroBench();
          const req = after
            ? post({ mine, candidates, k })
            : waiverRequest({ mine, candidates, k });
          const { data } = await analyzeWaivers(req);
          const subj = data.rec.subjects;
          expect(subj.length).toBeLessThanOrEqual(REC_LIMITS.subjects);
          const acts = moves(subj);
          expect(acts.length).toBeLessThanOrEqual(PLAN_MAX_MOVES);
          const drops = dropsOf(subj);
          expect(new Set(drops).size).toBe(drops.length);
          expect(new Set(acts.map((s) => s.player_id)).size).toBe(acts.length);
          for (const d of drops) expect(acts.some((s) => s.player_id === d)).toBe(false);
          for (const s of acts) {
            const c = byId(data, s.player_id ?? -1);
            expect(s.role === "claim" ? c?.verdict === "claim" : c?.verdict === "fa_add_now").toBe(
              true,
            );
          }
          // claims keep their own drop
          for (const s of acts.filter((x) => x.role === "claim")) {
            const own = byId(data, s.player_id ?? -1)?.conditional_drop?.player_id ?? null;
            const next = subj[subj.indexOf(s) + 1];
            expect(next?.role === "drop" ? next.player_id : null).toBe(own);
          }
          // led by the top move; nothing to do ⇔ no subject
          const top =
            data.candidates.find((c) => c.claim_rank === 1) ??
            data.candidates.find((c) => c.verdict === "fa_add_now");
          expect(acts[0]?.player_id).toBe(top?.player_id);
          expect(data.rec.no_move).toBe(subj.length === 0);
          // one K and one D/ST once the plan is made
          const roster = afterPlan(mine, subj, candidates);
          for (const pos of ["K", "D/ST"])
            expect(roster.filter((p) => p.position === pos).length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 40 },
    );
  }, 240_000);
});
