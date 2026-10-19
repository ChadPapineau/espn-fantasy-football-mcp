// waivers-p1-plan.test.ts — the P1 layer carries the P0 engine's plan (Stage C round 2, finding
// waivers-postrun-adds-unbounded-same-drop; plan 07 E5 P1): it re-plans over its own verdicts — FAAB
// claims by expected net — through the planner analyzeWaivers returns, so its Rec is bounded and its
// action text reads as P0's; a plan the CPU deadline stops makes the answer partial, said once. The
// deadline case wraps the engine (vi.mock) so its planner reports the stop, everything else real.
// Synthetic data only.
import { describe, expect, it, vi } from "vitest";
import type * as WaiversModule from "../../../src/domain/analytics/waivers.js";
import { analyzeWaiversP1 } from "../../../src/domain/analytics/waiversP1.js";
import { clockAndRng, referenceRules } from "./helpers.js";
import { myRoster, waiverRequest, WEEKS, wc } from "./p1-helpers.js";

const stopPlans = vi.hoisted(() => ({ on: false }));

vi.mock("../../../src/domain/analytics/waivers.js", async (orig) => {
  const real = await orig<typeof WaiversModule>();
  return {
    ...real,
    analyzeWaivers: async (req: Parameters<typeof real.analyzeWaivers>[0]) => {
      const out = await real.analyzeWaivers(req);
      if (!stopPlans.on) return out;
      // the planner as the CPU deadline leaves it: the first move only, the rest for a later call
      const planner: typeof out.planner = async (pr) => {
        const plan = await out.planner({ ...pr, deadline_ms: null });
        return {
          ...plan,
          moves: plan.moves.slice(0, 1),
          subjects: plan.subjects.slice(0, plan.moves[0]?.drop === null ? 1 : 2),
          later_adds: plan.later_adds + Math.max(0, plan.moves.length - 1),
          partial: true,
        };
      };
      return { ...out, planner };
    },
  };
});

/** After the run, my RB 14 worth nothing, three free-agent WRs (each alone worth adding). */
const scramble = (
  rules = referenceRules({
    last_ms: Date.UTC(2026, 9, 8, 7, 0),
    next_ms: Date.UTC(2026, 9, 9, 7, 0),
  }),
) => ({
  ...waiverRequest({
    rules,
    clock: clockAndRng("2026-10-08T12:00:00.000Z").clock,
    mine: myRoster().map((p) => (p.player_id === 14 ? { ...p, weekly: WEEKS.map(() => 0) } : p)),
    candidates: [
      wc(201, "WR", 9.5, "FREEAGENT"),
      wc(203, "WR", 9.4, "FREEAGENT"),
      wc(205, "WR", 9.3, "FREEAGENT"),
    ],
  }),
  value_basis: "espn_ros" as const,
});

describe("the P1 Rec is the P0 engine's plan", () => {
  it("priority: the same plan and action as P0 — two adds on distinct drops, the third for a later call", async () => {
    stopPlans.on = false;
    const out = await analyzeWaiversP1(scramble());
    expect(out.data.rec.subjects.map((s) => [s.player_id, s.role])).toEqual([
      [201, "add"],
      [14, "drop"],
      [203, "add"],
      [13, "drop"],
    ]);
    expect(out.data.rec.action).toBe(
      "add 2 free agents now; 1 more free agent after these moves: call again then",
    );
  });

  it("FAAB: the same plan, said in the FAAB template", async () => {
    stopPlans.on = false;
    const out = await analyzeWaiversP1({
      ...scramble(
        referenceRules({
          uses_budget: true,
          last_ms: Date.UTC(2026, 9, 8, 7, 0),
          next_ms: Date.UTC(2026, 9, 9, 7, 0),
        }),
      ),
      mode: "faab",
    });
    expect(out.data.mode_used).toBe("faab");
    expect(out.data.rec.subjects.filter((s) => s.role === "add")).toHaveLength(2);
    expect(out.data.rec.action).toBe(
      "add 2 free agents now; 1 more free agent after these moves: call again then",
    );
  });

  it("a plan the CPU deadline stops: the answer is partial, the stop said once, the first move kept", async () => {
    stopPlans.on = true;
    try {
      const out = await analyzeWaiversP1(scramble());
      expect(out.partial).toBe(true);
      const line =
        "partial: the plan stops at 1 move before the CPU deadline: call again after making them";
      expect(out.warnings.filter((w) => w === line)).toHaveLength(1);
      expect(out.data.rec.subjects.map((s) => s.player_id)).toEqual([201, 14]);
      expect(out.data.rec.action).toBe(
        "add 1 free agent now; 2 more free agents after these moves: call again then",
      );
    } finally {
      stopPlans.on = false;
    }
  });
});
