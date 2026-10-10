// predict.test.ts — cascade v2's split (plan 10 §3.3, C6; plan 10 B6 "beneficiary shares never sum
// above the vacated share"): roles (usage vs successor — the back's successor by carries, the
// receiver behind the two remaining starters by the depth chart, pools past the depth), the team
// context at the table's cuts, the cell lookup's fallback to the pooled row, and the split itself —
// `vacated × max(0, f) × P(active)`, capped — hand-checked, then as a property over random tables
// and teammates (never negative, never above the vacated share, junk read as nothing).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  cellFor,
  contextKey,
  contextOf,
  isInjuredPosition,
  isSkillPosition,
  mainComponent,
  priorSplit,
  rolesOf,
  type RoleInput,
  type SplitMate,
} from "../../../../src/domain/analytics/cascade-priors/predict.js";
import type { PriorCell } from "../../../../src/domain/analytics/cascade-priors/types.js";
import {
  BENEFICIARY_ROLES,
  PRIOR_COMPONENTS,
} from "../../../../src/domain/analytics/cascade-priors/types.js";
import { cell, tableOf } from "./helpers/synth.js";

const r = (
  key: string,
  position: string,
  opportunities: number,
  depth: number | null = null,
  main?: number,
): RoleInput => ({ key, position, opportunities, depth, ...(main === undefined ? {} : { main }) });

describe("rolesOf", () => {
  it("ranks by opportunities per position, pools past the depth, no role off the skill positions", () => {
    const roles = rolesOf([
      r("w1", "WR", 8),
      r("w2", "WR", 6),
      r("w3", "WR", 5),
      r("w4", "WR", 2),
      r("w5", "WR", 1),
      r("t1", "TE", 4),
      r("t2", "TE", 1),
      r("t3", "TE", 0),
      r("q1", "QB", 3),
      r("q2", "QB", 0),
      r("k", "K", 9),
      r("o", "OTHER", 9),
    ]);
    expect(roles).toEqual([
      "WR1",
      "WR2",
      "WR3",
      "WR4",
      "WR4",
      "TE1",
      "TE2",
      "TE2",
      "QB1",
      "QB2",
      null,
      null,
    ]);
  });
  it("ties break on depth (unlisted last), then key; junk opportunities read as 0", () => {
    expect(
      rolesOf([
        r("b", "RB", 2, null),
        r("a", "RB", 2, null),
        r("c", "RB", 2, 1),
        r("d", "RB", Number.NaN),
      ]),
    ).toEqual(["RB3", "RB2", "RB1", "RB3"]);
  });
  it("successor: at the injured back's position the rank is by carries (his main component)", () => {
    // the pass-down back p has more opportunities, the early-down back e more carries
    const mates = [r("p", "RB", 7, 2, 2), r("e", "RB", 6, 3, 6)];
    expect(rolesOf(mates, "RB", "successor")).toEqual(["RB2", "RB1"]);
    expect(rolesOf(mates, "RB", "usage")).toEqual(["RB1", "RB2"]);
    // away from the injured position, usage rules
    expect(rolesOf(mates, "WR", "successor")).toEqual(["RB1", "RB2"]);
  });
  it("successor: receivers behind the two remaining starters follow the depth chart", () => {
    const mates = [
      r("s1", "WR", 7, 1, 7),
      r("s2", "WR", 5, 1, 5),
      r("w3", "WR", 3, 3, 3),
      r("up", "WR", 0.5, 2, 0.5),
      r("un", "WR", 4, null, 4), // unlisted: last behind the starters, whatever his usage
    ];
    // the two remaining starters by targets are s1 (7) and s2 (5); behind them the chart decides:
    // depth 2 (up), depth 3 (w3), unlisted (un) — whatever their own targets
    expect(rolesOf(mates, "WR", "successor")).toEqual(["WR1", "WR2", "WR4", "WR3", "WR4"]);
    expect(rolesOf(mates, "WR", "usage")).toEqual(["WR1", "WR2", "WR4", "WR4", "WR3"]);
  });
  it("the default is successor; an empty list has no roles", () => {
    expect(rolesOf([])).toEqual([]);
    expect(rolesOf([r("x", "RB", 1, null, 0), r("y", "RB", 0.5, null, 3)], "RB")).toEqual([
      "RB2",
      "RB1",
    ]);
  });
});

describe("context, cells, guards", () => {
  const t = tableOf(cell({ WR1: 0.3 }), {
    RB: {},
    WR: { "pass|lead": cell({ WR1: 0.9 }) },
    TE: {},
  });
  it("tilt and hold at the cuts (≥ is pass / lead); no volume reads run", () => {
    expect(
      contextOf("WR", { targets: 0.21, carries: 0, rz: 0 }, { targets: 55, carries: 45, rz: 0 }, t),
    ).toEqual({
      tilt: "pass",
      hold: "lead",
    });
    expect(
      contextOf("WR", { targets: 0.2, carries: 0, rz: 0 }, { targets: 54, carries: 46, rz: 0 }, t),
    ).toEqual({
      tilt: "run",
      hold: "share",
    });
    expect(
      contextOf("RB", { targets: 0, carries: 0.5, rz: 0 }, { targets: 0, carries: 0, rz: 0 }, t),
    ).toEqual({
      tilt: "run",
      hold: "lead",
    });
    expect(
      contextOf(
        "TE",
        { targets: Number.NaN, carries: 0, rz: 0 },
        { targets: Infinity, carries: -1, rz: 0 },
        t,
      ),
    ).toEqual({ tilt: "run", hold: "share" });
    expect(contextKey({ tilt: "pass", hold: "share" })).toBe("pass|share");
  });
  it("a context with a cell reads it; one without falls back to the pooled row", () => {
    expect(cellFor(t, "WR", { tilt: "pass", hold: "lead" })).toEqual({
      cell: t.cells.WR["pass|lead"],
      pooled: false,
    });
    expect(cellFor(t, "WR", { tilt: "run", hold: "lead" })).toEqual({
      cell: t.pooled.WR,
      pooled: true,
    });
  });
  it("position guards and the main component", () => {
    expect(["RB", "WR", "TE"].every(isInjuredPosition)).toBe(true);
    expect(["QB", "K", "rb", ""].some(isInjuredPosition)).toBe(false);
    expect(["QB", "RB", "WR", "TE"].every(isSkillPosition)).toBe(true);
    expect(isSkillPosition("OTHER")).toBe(false);
    expect(mainComponent("RB")).toBe("carries");
    expect(mainComponent("WR")).toBe("targets");
    expect(mainComponent("TE")).toBe("targets");
  });
});

const sm = (
  key: string,
  position: string,
  opp: number,
  p_active = 1,
  depth: number | null = null,
): SplitMate => ({
  key,
  position,
  opportunities: opp,
  main: opp,
  depth,
  p_active,
});

describe("priorSplit", () => {
  it("vacated × f per role, P(active) scaling, negative f clamped, missing role nothing", () => {
    const t = tableOf(cell({ WR1: 0.4, WR2: 0.2, TE1: -0.1, RB1: 0.05 }));
    const s = priorSplit(
      t,
      "WR",
      { targets: 0.25, carries: 0, rz: 0.2 },
      { targets: 30, carries: 25, rz: 6 },
      [
        sm("a", "WR", 6),
        sm("b", "WR", 4, 0.5),
        sm("c", "TE", 5),
        sm("d", "QB", 1), // QB1 not in the cell
        sm("e", "K", 3), // no role
      ],
    );
    expect(s.pooled).toBe(true);
    expect(s.roles).toEqual(["WR1", "WR2", "TE1", "QB1", null]);
    expect(s.delta[0]?.targets).toBeCloseTo(0.1, 12);
    expect(s.delta[1]?.targets).toBeCloseTo(0.25 * 0.2 * 0.5, 12);
    expect(s.delta[2]?.targets).toBe(0);
    expect(s.delta[3]?.targets).toBe(0);
    expect(s.delta[4]?.targets).toBe(0);
    expect(s.delta[0]?.carries).toBe(0); // nothing vacated
    expect(s.delta[0]?.rz).toBeCloseTo(0.08, 12);
  });
  it("factors summing past 1 are scaled down to exactly the vacated share", () => {
    const t = tableOf(cell({ WR1: 0.9, WR2: 0.8, WR3: Infinity }));
    const s = priorSplit(
      t,
      "WR",
      { targets: 0.3, carries: 0, rz: 0 },
      { targets: 30, carries: 25, rz: 6 },
      [sm("a", "WR", 6), sm("b", "WR", 4), sm("c", "WR", 2)],
    );
    const sum = s.delta.reduce((x, d) => x + d.targets, 0);
    expect(sum).toBeCloseTo(0.3, 12);
    expect(s.delta[2]?.targets).toBe(0); // a non-finite factor reads as nothing
    expect((s.delta[0]?.targets ?? 0) / (s.delta[1]?.targets ?? 1)).toBeCloseTo(0.9 / 0.8, 12);
  });
  it("PROPERTY (plan 10 B6): never negative, never above min(1, vacated), whatever the table and mates", () => {
    const factor = fc.oneof(
      fc.double({ min: -3, max: 3, noNaN: true }),
      fc.constantFrom(Number.NaN, Infinity, -Infinity, 1e9),
    );
    const cellArb = fc
      .dictionary(fc.constantFrom(...BENEFICIARY_ROLES), factor)
      .map((d): PriorCell => {
        const row = Object.fromEntries(
          Object.entries(d).map(([k, v]) => [k, { f: v, sd: 0, n: 1 }]),
        );
        return { targets: row, carries: row, rz: row };
      });
    const share = fc.oneof(
      fc.double({ min: 0, max: 1.5, noNaN: true }),
      fc.constantFrom(Number.NaN, -0.2),
    );
    fc.assert(
      fc.property(
        cellArb,
        fc.constantFrom("RB" as const, "WR" as const, "TE" as const),
        share,
        share,
        share,
        fc.array(
          fc.record({
            position: fc.constantFrom("QB", "RB", "WR", "TE", "K"),
            opp: fc.double({ min: -1, max: 20, noNaN: true }),
            pa: fc.oneof(fc.double({ min: -1, max: 2, noNaN: true }), fc.constant(Number.NaN)),
            depth: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
          }),
          { maxLength: 14 },
        ),
        (c, pos, t, ca, rz, ms) => {
          const vac = { targets: t, carries: ca, rz };
          const s = priorSplit(
            tableOf(c),
            pos,
            vac,
            { targets: 30, carries: 25, rz: 6 },
            ms.map((m, i) => sm(String(i), m.position, m.opp, m.pa, m.depth)),
          );
          for (const k of PRIOR_COMPONENTS) {
            const v = Number.isFinite(vac[k]) && vac[k] > 0 ? Math.min(1, vac[k]) : 0;
            let sum = 0;
            for (const d of s.delta) {
              expect(d[k]).toBeGreaterThanOrEqual(0);
              expect(Number.isFinite(d[k])).toBe(true);
              sum += d[k];
            }
            expect(sum).toBeLessThanOrEqual(v + 1e-12);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
