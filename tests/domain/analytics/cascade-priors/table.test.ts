// table.test.ts — the redistribution prior table (plan 10 §3.3 "the redistribution prior table from
// pbp history"; sib research 05 §6.2): the factor `f = Σ v·Δ / Σ v²`, the context cell shrunk toward
// the pooled factor with κ = shrink × mean v², the spread and counts — hand-checked; the shrinkage
// chosen by leave-one-season-out inside the build (a context effect that repeats keeps the cells, one
// that flips between seasons falls back to the pool); options and guards; and the SHIPPED table:
// rebuilt from the committed excerpt it is the generated file exactly, and nobody can change it.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ABSENCE_RULES,
  findAbsences,
} from "../../../../src/domain/analytics/cascade-priors/absences.js";
import { CASCADE_PRIOR_TABLE_DATA } from "../../../../src/domain/analytics/cascade-priors/generated/table.js";
import { CASCADE_PRIORS } from "../../../../src/domain/analytics/cascade-priors/shipped.js";
import {
  TABLE_PARAMETERS,
  buildPriorTable,
  chooseShrink,
  heldOutError,
} from "../../../../src/domain/analytics/cascade-priors/table.js";
import type { AbsenceEvent } from "../../../../src/domain/analytics/cascade-priors/types.js";
import { TABLE_PROVENANCE_NOTE, loadManifest, loadUsageExcerpt } from "./helpers/excerpt.js";
import { cell, eventOf, mateOf, tableOf } from "./helpers/synth.js";

const rules = DEFAULT_ABSENCE_RULES;
// run|share: tilt 30/55 < 0.55, hold 0.2 < 0.21
const e1 = eventOf({
  season: 2023,
  vacated: [0.2, 0, 0.1],
  teammates: [mateOf("m", "WR", "WR1", [0.2, 0, 0.1], [0.3, 0, 0.15])],
});
// pass|lead: tilt 40/60, hold 0.25
const e2 = eventOf({
  season: 2024,
  vacated: [0.25, 0, 0.2],
  team_pre: { targets: 40, carries: 20, rz: 6 },
  teammates: [mateOf("m", "WR", "WR1", [0.15, 0, 0.1], [0.2, 0, 0.1])],
});

describe("buildPriorTable — the estimator", () => {
  const t = buildPriorTable([e1, e2], { rules, shrink_events: 3, provenance: ["p"] });
  it("pooled f = Σ v·Δ / Σ v² per role and component; spread and count", () => {
    const f = t.pooled.WR.targets.WR1;
    expect(f?.f).toBeCloseTo((0.2 * 0.1 + 0.25 * 0.05) / (0.04 + 0.0625), 4);
    expect(f?.n).toBe(2);
    expect(f?.sd).toBeCloseTo(Math.sqrt(0.045), 4); // ratios 0.5 and 0.2
    expect(t.pooled.WR.carries.WR1).toEqual({ f: 0, sd: 0, n: 2 }); // nothing vacated
    expect(t.pooled.RB.targets).toEqual({}); // no back absence
  });
  it("a context cell is shrunk toward the pooled factor with κ = shrink × mean v²", () => {
    const kappa = (3 * (0.04 + 0.0625)) / 2;
    const pf = t.pooled.WR.targets.WR1?.f ?? Number.NaN;
    expect(t.cells.WR["run|share"]?.targets.WR1?.f).toBeCloseTo(
      (0.02 + kappa * pf) / (0.04 + kappa),
      4,
    );
    expect(t.cells.WR["pass|lead"]?.targets.WR1?.f).toBeCloseTo(
      (0.0125 + kappa * pf) / (0.0625 + kappa),
      4,
    );
    expect(t.cells.WR["pass|share"]).toBeUndefined(); // no absence there: the lookup falls back
  });
  it("the table's record: version, seasons, counts, cuts, rule, shrink, provenance", () => {
    expect(t.version).toBe("cascade-priors-v2");
    expect(t.seasons).toEqual([2023, 2024]);
    expect(t.absences).toBe(2);
    expect(t.absences_by_position).toEqual({ RB: 0, WR: 2, TE: 0 });
    expect(t.tilt_cut).toBe(TABLE_PARAMETERS.tilt_cut);
    expect(t.hold_cut).toEqual(TABLE_PARAMETERS.hold_cut);
    expect(t.shrink_events).toBe(3);
    expect(t.role_rule).toBe("successor");
    expect(t.provenance).toEqual(["p"]);
    expect(t.rules).toBe(rules);
  });
  it("deterministic; a bad shrink reads as the default; an empty build is an empty table", () => {
    expect(buildPriorTable([e1, e2], { rules, shrink_events: 3, provenance: ["p"] })).toEqual(t);
    for (const k of [-1, Number.NaN, Infinity])
      expect(buildPriorTable([e1], { rules, shrink_events: k }).shrink_events).toBe(
        TABLE_PARAMETERS.shrink_default,
      );
    const empty = buildPriorTable([], { rules, role_rule: "usage" });
    expect(empty.absences).toBe(0);
    expect(empty.seasons).toEqual([]);
    expect(empty.role_rule).toBe("usage");
    expect(empty.pooled.WR).toEqual({ targets: {}, carries: {}, rz: {} });
    expect(empty.cells).toEqual({ RB: {}, WR: {}, TE: {} });
    expect(empty.provenance).toEqual([]);
  });
});

describe("the shrinkage is chosen inside the build (leave one season out)", () => {
  const ev = (season: number, ctx: "pass" | "run", gain: number): AbsenceEvent =>
    eventOf({
      season,
      vacated: ctx === "pass" ? [0.3, 0, 0] : [0.15, 0, 0],
      team_pre:
        ctx === "pass" ? { targets: 40, carries: 20, rz: 6 } : { targets: 20, carries: 40, rz: 6 },
      teammates: [
        mateOf("m", "WR", "WR1", [0.1, 0, 0], [0.1 + gain * (ctx === "pass" ? 0.3 : 0.15), 0, 0]),
      ],
    });
  it("fewer than two seasons → the default", () => {
    expect(chooseShrink([e1])).toBe(TABLE_PARAMETERS.shrink_default);
    expect(chooseShrink([])).toBe(TABLE_PARAMETERS.shrink_default);
  });
  it("a context effect that repeats every season keeps the cells (κ = 0)", () => {
    const evs = [
      ev(2023, "pass", 0.8),
      ev(2023, "run", 0.1),
      ev(2024, "pass", 0.8),
      ev(2024, "run", 0.1),
    ];
    expect(chooseShrink(evs)).toBe(0);
    const t = buildPriorTable(evs, { rules });
    expect(t.shrink_events).toBe(0);
    expect(t.cells.WR["pass|lead"]?.targets.WR1?.f).toBeCloseTo(0.8, 4);
    expect(t.cells.WR["run|share"]?.targets.WR1?.f).toBeCloseTo(0.1, 4);
  });
  it("a context effect that flips between seasons falls back to the pool (the grid's top)", () => {
    const evs = [
      ev(2023, "pass", 0.8),
      ev(2023, "run", 0.1),
      ev(2024, "pass", 0.1),
      ev(2024, "run", 0.8),
    ];
    const grid = TABLE_PARAMETERS.shrink_grid;
    expect(chooseShrink(evs)).toBe(grid[grid.length - 1]);
  });
  it("heldOutError: Σ (Δ − v·max(0, f))² over teammates and components; a missing role predicts 0", () => {
    const t = tableOf(cell({ WR1: 0.5, WR2: -0.4 }));
    const e = eventOf({
      vacated: [0.2, 0, 0],
      teammates: [
        mateOf("a", "WR", "WR1", [0.1, 0, 0], [0.25, 0, 0]), // pred 0.1, real 0.15
        mateOf("b", "WR", "WR2", [0.1, 0, 0], [0.12, 0, 0]), // f < 0 → 0, real 0.02
        mateOf("c", "TE", "TE1", [0.1, 0, 0], [0.13, 0, 0.02]), // no role: 0; real 0.03 and rz 0.02
      ],
    });
    expect(heldOutError(t, [e])).toBeCloseTo(0.05 ** 2 + 0.02 ** 2 + 0.03 ** 2 + 0.02 ** 2, 12);
    expect(heldOutError(t, [])).toBe(0);
  });
});

describe("the shipped table", () => {
  it("is the build of the committed excerpt, exactly (provenance included)", () => {
    const rows = loadUsageExcerpt();
    const m = loadManifest();
    const rebuilt = buildPriorTable(findAbsences(rows, rules), {
      rules,
      provenance: [TABLE_PROVENANCE_NOTE, ...m.upstream.map((u) => `${u.url} sha256:${u.sha256}`)],
    });
    expect(rebuilt).toEqual(CASCADE_PRIOR_TABLE_DATA);
  });
  it("covers ≥ 3 seasons and ≥ 10 absences (plan 10 §3.3 [A-3], B6), every injured position", () => {
    expect(CASCADE_PRIORS.seasons).toEqual([2023, 2024, 2025]);
    expect(CASCADE_PRIORS.absences).toBeGreaterThanOrEqual(10);
    for (const p of ["RB", "WR", "TE"] as const)
      expect(CASCADE_PRIORS.absences_by_position[p]).toBeGreaterThan(0);
    expect(CASCADE_PRIORS.role_rule).toBe("successor");
    expect(CASCADE_PRIORS.provenance.every((p) => !/[0-9]{2}-[0-9]{7}/.test(p))).toBe(true);
  });
  it("its factors are finite and the successor gains the most of his kind (a back's carries)", () => {
    for (const p of ["RB", "WR", "TE"] as const)
      for (const c of ["targets", "carries", "rz"] as const)
        for (const f of Object.values(CASCADE_PRIORS.pooled[p][c])) {
          expect(Number.isFinite(f.f)).toBe(true);
          expect(f.n).toBeGreaterThan(0);
        }
    const rb = CASCADE_PRIORS.pooled.RB.carries;
    expect(rb.RB1?.f).toBeGreaterThan(rb.RB2?.f ?? Infinity);
    expect(rb.RB1?.f).toBeLessThan(1); // never 1:1 inheritance
  });
  it("is deep-frozen", () => {
    expect(Object.isFrozen(CASCADE_PRIORS)).toBe(true);
    expect(Object.isFrozen(CASCADE_PRIORS.pooled.RB.carries)).toBe(true);
    expect(() => {
      (CASCADE_PRIORS as { absences: number }).absences = 1;
    }).toThrow(TypeError);
  });
});
