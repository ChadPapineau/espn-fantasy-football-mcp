// scoring.test.ts — plan 08 §7 property invariants P1–P16 (fast-check; plan 05 T2) over the pure
// engine. P15 on the real fixture set is tests/golden/translator-agreement.test.ts; here it runs on
// synthetic rows against an ESPN-style pre-bucketed line. P14 reads the sibling's frozen Yahoo
// normaliser output (fixtures/golden/p14-yahoo.json; no shared code — plan 01 D3).
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyRounding,
  asPositionId,
  bracketize,
  CANONICAL_DEFS,
  createUnmappedLog,
  ESPN_STAT_MAP,
  espnIdOf,
  normalizeSettings,
  positionClassOf,
  renormalizeSettings,
  score,
  scoreSamples,
  type ScoringSettings,
  type StatLine,
  statLineFromEspn,
  statLineFromPlayerWeek,
  verify,
} from "../../src/domain/scoring/index.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

// --- generators ----------------------------------------------------------------------------------

/** Points with 0–3 decimals in [−10, 10] (plan 08 P1 generator). */
const arbPoints = fc.integer({ min: -10_000, max: 10_000 }).map((x) => x / 1000);
/** A small non-negative stat count / yardage. */
const arbValue = fc.integer({ min: 0, max: 400 });

/** Linear, non-family, offence-only canonicals with an ESPN id (no derivation, no zero rule). */
const LINEAR_O = CANONICAL_DEFS.filter(
  (d) =>
    d.family === null && d.zero_with === null && d.classes.length === 1 && d.classes[0] === "O",
).map((d) => d.canonical);
const LINEAR_DST = CANONICAL_DEFS.filter(
  (d) =>
    d.family === null && d.zero_with === null && d.classes.length === 1 && d.classes[0] === "DST",
).map((d) => d.canonical);

const idOf = (c: string): number => Number(espnIdOf(c));

/** Settings over distinct canonicals with given points (base only). */
function linearSettings(rules: readonly (readonly [string, number])[]): ScoringSettings {
  return normalizeSettings({
    scoringItems: rules.map(([c, p]) => ({ statId: idOf(c), points: p })),
  });
}

function lineOf(
  values: Record<string, number>,
  position: number,
  source = "espn",
  provisional = false,
): StatLine {
  return {
    values,
    present: Object.keys(values).sort(),
    position: asPositionId(position),
    position_class: positionClassOf(position),
    provisional,
    source,
  };
}

/** A random linear rule set over offence canonicals and a line over the same canonicals. */
const arbLinear = fc
  .uniqueArray(fc.constantFrom(...LINEAR_O), { minLength: 1, maxLength: 12 })
  .chain((cs) =>
    fc.record({
      rules: fc.tuple(...cs.map((c) => arbPoints.map((p) => [c, p] as const))),
      x: fc.tuple(...cs.map(() => arbValue)),
      y: fc.tuple(...cs.map(() => arbValue)),
    }),
  )
  .map(({ rules, x, y }) => ({
    rules,
    x: Object.fromEntries(rules.map(([c], i) => [c, x[i]!])),
    y: Object.fromEntries(rules.map(([c], i) => [c, y[i]!])),
  }));

const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

describe("P1 linearity outside brackets and bonuses", () => {
  it("score(a·x + b·y) = a·score(x) + b·score(y)", () => {
    fc.assert(
      fc.property(
        arbLinear,
        fc.integer({ min: -5, max: 5 }),
        fc.integer({ min: -5, max: 5 }),
        ({ rules, x, y }, a, b) => {
          const s = linearSettings(rules);
          const comb = Object.fromEntries(
            Object.keys(x).map((c) => [c, a * (x[c] ?? 0) + b * (y[c] ?? 0)]),
          );
          return close(
            score(lineOf(comb, 3), s).points,
            a * score(lineOf(x, 3), s).points + b * score(lineOf(y, 3), s).points,
          );
        },
      ),
    );
  });
});

describe("P2 homogeneity in a modifier", () => {
  it("perturbing one item's points by δ moves the total by exactly δ × value", () => {
    fc.assert(
      fc.property(
        arbLinear,
        fc.nat(),
        arbPoints.map((d) => d / 2),
        ({ rules, x }, pick, delta) => {
          const i = pick % rules.length;
          const [c, p] = rules[i]!;
          const moved = rules.map((r, j) => (j === i ? ([c, p + delta] as const) : r));
          const before = score(lineOf(x, 3), linearSettings(rules)).points;
          const after = score(lineOf(x, 3), linearSettings(moved)).points;
          return close(after - before, delta * (x[c] ?? 0));
        },
      ),
    );
  });
});

describe("P3 override precedence (plan 08 §3.4: POSITION ids)", () => {
  it("an override moves only its position's lines; the base moves only lines without one", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LINEAR_O),
        arbPoints,
        arbPoints,
        arbPoints,
        arbValue,
        (c, base, ovr, delta, v) => {
          const mk = (b: number, o: number) =>
            normalizeSettings({
              scoringItems: [{ statId: idOf(c), points: b, pointsOverrides: { "2": o } }],
            });
          const rb = lineOf({ [c]: v }, 2);
          const wr = lineOf({ [c]: v }, 3);
          const s0 = mk(base, ovr);
          const sO = mk(base, ovr + delta);
          const sB = mk(base + delta, ovr);
          return (
            close(score(rb, sO).points - score(rb, s0).points, delta * v) &&
            score(wr, sO).points === score(wr, s0).points &&
            score(rb, sB).points === score(rb, s0).points &&
            close(score(wr, sB).points - score(wr, s0).points, delta * v)
          );
        },
      ),
    );
  });
});

const PA_IDS = [89, 90, 91, 92, 121, 122, 123, 124, 125];
describe("P4 bracket exclusivity", () => {
  it("one tier inside a complete range, none in a gap; removing a tier changes only its own games", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...PA_IDS), { minLength: 2, maxLength: 9 }),
        fc.integer({ min: 0, max: 70 }),
        fc.nat(),
        (ids, pa, pick) => {
          const s = normalizeSettings({
            scoringItems: ids.map((id, i) => ({
              statId: id,
              points: 0,
              pointsOverrides: { "16": i + 1 },
            })),
          });
          const fam = s.families[0];
          if (fam === undefined) return false;
          const v = bracketize(fam, pa) ?? [];
          const inside = fam.members.filter(
            (m) => m.lower <= pa && (m.upper === null || pa <= m.upper),
          );
          const ones = v.reduce((a, b) => a + b, 0);
          if (ones !== inside.length || ones > 1) return false;
          if (fam.complete_range && ones !== 1) return false;
          const drop = ids[pick % ids.length]!;
          const fewer = normalizeSettings({
            scoringItems: ids
              .filter((id) => id !== drop)
              .map((id) => ({
                statId: id,
                points: 0,
                pointsOverrides: { "16": ids.indexOf(id) + 1 },
              })),
          });
          const line = lineOf({ dst_pa_raw: pa }, 16, "nflverse");
          const dropped = fam.members.find((m) => m.platform_id === String(drop));
          const inDropped =
            dropped !== undefined &&
            dropped.lower <= pa &&
            (dropped.upper === null || pa <= dropped.upper);
          return (score(line, s).points !== score(line, fewer).points) === inDropped;
        },
      ),
    );
  });
});

describe("P5 bonus monotonicity", () => {
  const s = normalizeSettings({
    scoringItems: [
      { statId: 24, points: 0.1 },
      { statId: 37, points: 3 },
      { statId: 38, points: 5 },
    ],
  });
  it("score is non-decreasing in a stat carrying only positive bonuses", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -20, max: 400 }),
        fc.integer({ min: 0, max: 300 }),
        (y, d) =>
          score(lineOf({ rush_yd: y }, 2, "nflverse"), s).points <=
          score(lineOf({ rush_yd: y + d }, 2, "nflverse"), s).points,
      ),
    );
  });
  it("E[bonus] from samples equals P(stat ≥ target) × points", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 260 }), { minLength: 1, maxLength: 60 }),
        (ys) => {
          const r = scoreSamples(
            ys.map((y) => lineOf({ rush_yd: y }, 2, "projection:v1-ensemble")),
            s,
            "player_sim",
          );
          const p100 = ys.filter((y) => y >= 100).length / ys.length;
          const p200 = ys.filter((y) => y >= 200).length / ys.length;
          const meanYd = ys.reduce((a, b) => a + b, 0) / ys.length;
          return (
            close(r.bonus_probability.rush_yd_100 ?? -1, p100) &&
            close(r.bonus_probability.rush_yd_200 ?? -1, p200) &&
            close(r.mean_of_exact, 0.1 * meanYd + 3 * p100 + 5 * p200)
          );
        },
      ),
    );
  });
});

describe("P6 class gating", () => {
  it("an O-only stat never counts on a D/ST line and a DST-only stat never on an O line", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LINEAR_O),
        fc.constantFrom(...LINEAR_DST),
        arbPoints,
        arbPoints,
        arbValue,
        arbValue,
        (o, d, po, pd, vo, vd) => {
          const s = linearSettings([
            [o, po],
            [d, pd],
          ]);
          const both = { [o]: vo, [d]: vd };
          return (
            close(score(lineOf(both, 3), s).points, score(lineOf({ [o]: vo }, 3), s).points) &&
            close(score(lineOf(both, 16), s).points, score(lineOf({ [d]: vd }, 16), s).points)
          );
        },
      ),
    );
  });
});

describe("P7 unmapped, ignored, underivable", () => {
  const unknownId = fc
    .integer({ min: 235, max: 9999 })
    .filter((id) => !ESPN_STAT_MAP.has(String(id)));
  it("an unknown id in S changes no score and is reported once per hash", () => {
    fc.assert(
      fc.property(arbLinear, unknownId, arbPoints, ({ rules, x }, id, p) => {
        const s = linearSettings(rules);
        const withUnknown = normalizeSettings({
          scoringItems: [
            ...rules.map(([c, q]) => ({ statId: idOf(c), points: q })),
            { statId: id, points: p },
          ],
        });
        const log = createUnmappedLog();
        const r = score(lineOf(x, 3), withUnknown);
        return (
          r.points === score(lineOf(x, 3), s).points &&
          r.unmapped.join() === String(id) &&
          log.firstReport(withUnknown)?.join() === String(id) &&
          log.firstReport(withUnknown) === null
        );
      }),
    );
  });
  it("an unknown canonical in a line is ignored; a long-TD id with an nflverse TD line is underivable", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("zz_custom", "unknown_stat", "x1"),
        arbValue,
        fc.integer({ min: 1, max: 5 }),
        (c, v, tds) => {
          const s = normalizeSettings({
            scoringItems: [
              { statId: 4, points: 4 },
              { statId: 15, points: 2 },
            ],
          });
          const ign = score(lineOf({ [c]: v, pass_td: 1 }, 1), s);
          const nv = score(lineOf({ pass_td: tds }, 1, "nflverse"), s);
          return ign.ignored.includes(c) && nv.underivable.join() === "pass_td_40" && !nv.complete;
        },
      ),
    );
  });
});

/** Random ESPN item lists: distinct mapped ids, random points and overrides. */
const arbItems = fc
  .uniqueArray(
    fc.constantFrom(
      ...[...ESPN_STAT_MAP.keys()]
        .filter((id) => !["74", "75", "76", "105"].includes(id))
        .map(Number),
    ),
    { minLength: 1, maxLength: 25 },
  )
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc.record({
          statId: fc.constant(id),
          points: arbPoints,
          pointsOverrides: fc.dictionary(
            fc.constantFrom("1", "2", "3", "4", "15", "16"),
            arbPoints,
            { maxKeys: 3 },
          ),
        }),
      ),
    ),
  );

describe("P8 normaliser idempotence and hash stability", () => {
  it("normalize(normalize(s)) = normalize(s); reordering never changes the hash; any points/override change does", () => {
    fc.assert(
      fc.property(
        arbItems,
        fc.nat(),
        arbPoints.filter((d) => d !== 0),
        (items, pick, delta) => {
          const s = normalizeSettings({ scoringItems: items });
          const shuffled = [...items].reverse().map((it) => ({
            ...it,
            pointsOverrides: Object.fromEntries(Object.entries(it.pointsOverrides).reverse()),
          }));
          const i = pick % items.length;
          const changed = items.map((it, j) =>
            j === i ? { ...it, points: it.points + delta } : it,
          );
          const key = Object.keys(items[i]?.pointsOverrides ?? {})[0];
          const ovr =
            key === undefined
              ? changed
              : items.map((it, j) =>
                  j === i
                    ? {
                        ...it,
                        pointsOverrides: {
                          ...it.pointsOverrides,
                          [key]: (it.pointsOverrides[key] ?? 0) + delta,
                        },
                      }
                    : it,
                );
          return (
            JSON.stringify(renormalizeSettings(s)) === JSON.stringify(s) &&
            normalizeSettings({ scoringItems: shuffled }).settings_hash === s.settings_hash &&
            normalizeSettings({ scoringItems: changed }).settings_hash !== s.settings_hash &&
            normalizeSettings({ scoringItems: ovr }).settings_hash !== s.settings_hash
          );
        },
      ),
    );
  });
});

describe("P9 rounding bounded", () => {
  it("exact gives points = points_exact; a verified mode stays within 0.01 × rules and is idempotent", () => {
    fc.assert(
      fc.property(arbLinear, ({ rules, x }) => {
        const r = score(lineOf(x, 3), linearSettings(rules));
        if (r.points !== r.points_exact) return false;
        const per = r.contributions.map((c) => c.points);
        for (const mode of ["per_stat_2dp", "per_total_2dp"] as const) {
          const p = applyRounding(r.points_exact, per, { mode, verified: true });
          if (Math.abs(p - r.points_exact) > 0.01 * rules.length + 1e-9) return false;
        }
        const t = applyRounding(r.points_exact, per, { mode: "per_total_2dp", verified: true });
        return applyRounding(t, [t], { mode: "per_total_2dp", verified: true }) === t;
      }),
    );
  });
});

describe("P10 complete flag", () => {
  it("complete = false ⇔ provisional ∧ a scored stat is absent (ESPN lines never underivable)", () => {
    fc.assert(
      fc.property(
        arbLinear,
        fc.boolean(),
        fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
        ({ rules, x }, provisional, keep) => {
          const values = Object.fromEntries(Object.entries(x).filter((_, i) => keep[i]));
          const r = score(lineOf(values, 3, "espn", provisional), linearSettings(rules));
          const missing = rules.some(([c, p]) => p !== 0 && !(c in values));
          return (
            r.complete === !(provisional && missing) &&
            r.underivable.length === 0 &&
            (provisional || r.complete)
          );
        },
      ),
    );
  });
});

describe("P11 no NaN or Infinity ever leaves score", () => {
  it("extreme but valid inputs give finite points", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LINEAR_O),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: -1e9, max: 1e9, noNaN: true }),
        (c, p, v) => {
          const r = score(lineOf({ [c]: v }, 3), linearSettings([[c, p]]));
          return Number.isFinite(r.points) && Number.isFinite(r.points_exact);
        },
      ),
    );
  });
  it("a non-numeric ESPN value fails the entry as drift before score is reached", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constant(null),
          fc.constant(Number.NaN),
          fc.constant(Number.POSITIVE_INFINITY),
          fc.object(),
          fc.boolean(),
        ),
        (v) => {
          try {
            statLineFromEspn({ raw: { "53": v } }, 3);
            return false;
          } catch (e) {
            return (e as { code?: string }).code === "drift";
          }
        },
      ),
    );
  });
});

describe("P12 determinism", () => {
  it("same inputs give byte-identical results; scoreSamples is reproducible", () => {
    fc.assert(
      fc.property(arbLinear, ({ rules, x, y }) => {
        const s = linearSettings(rules);
        const lines = [
          lineOf(x, 3, "projection:v1-ensemble"),
          lineOf(y, 3, "projection:v1-ensemble"),
        ];
        return (
          JSON.stringify(score(lines[0]!, s)) ===
            JSON.stringify(score(lines[0]!, linearSettings(rules))) &&
          JSON.stringify(scoreSamples(lines, s, "player_sim")) ===
            JSON.stringify(scoreSamples(lines, linearSettings(rules), "player_sim"))
        );
      }),
    );
  });
});

describe("P13 sample-mean consistency", () => {
  it("dist.mean ≈ mean_of_exact within 3σ/√n (equal under the exact rule)", () => {
    fc.assert(
      fc.property(
        fc.array(arbLinear, { minLength: 1, maxLength: 1 }),
        fc.array(fc.integer({ min: 0, max: 300 }), { minLength: 2, maxLength: 80 }),
        ([g], ys) => {
          if (g === undefined) return false;
          const s = linearSettings(g.rules);
          const c = g.rules[0]?.[0] ?? "pass_yd";
          const r = scoreSamples(
            ys.map((y) => lineOf({ [c]: y }, 3, "projection:v1-ensemble")),
            s,
            "player_sim",
          );
          const pts = ys.map(
            (y) => score(lineOf({ [c]: y }, 3, "projection:v1-ensemble"), s).points,
          );
          const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
          const sd = Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / pts.length);
          return (
            Math.abs(r.dist.mean - r.mean_of_exact) <=
            Math.max(1e-9, (3 * sd) / Math.sqrt(pts.length))
          );
        },
      ),
    );
  });
});

interface P14File {
  readonly rule_table: readonly {
    canonical: string;
    points: number;
    position_type: "O" | "K" | "DT";
  }[];
  readonly yahoo_settings: {
    readonly rules: readonly {
      canonical: string | null;
      position_types: readonly string[];
      modifier: number | null;
    }[];
  };
  readonly cases: readonly {
    position_type: "O" | "K" | "DT";
    values: Record<string, number>;
    yahoo_points: number;
  }[];
}
const P14 = JSON.parse(
  readFileSync(path.join(ROOT, "fixtures/golden/p14-yahoo.json"), "utf8"),
) as P14File;
const P14_POSITION = { O: 3, K: 5, DT: 16 } as const;

describe("P14 platform round trip (the fantasy-core guard)", () => {
  const espn = normalizeSettings({
    scoringItems: P14.rule_table.map((r) => ({ statId: idOf(r.canonical), points: r.points })),
  });
  /** Scores a canonical line under the FROZEN Yahoo settings (modifier rules gated by position type). */
  const yahoo = (pt: string, values: Record<string, number>): number =>
    P14.yahoo_settings.rules
      .filter((r) => r.canonical !== null && r.position_types.includes(pt))
      .reduce((a, r) => a + (r.modifier ?? 0) * (values[r.canonical!] ?? 0), 0);
  it("the sibling engine's frozen points equal this engine's under ESPN settings from the same table", () => {
    expect(P14.cases).toHaveLength(150);
    for (const c of P14.cases) {
      expect(score(lineOf(c.values, P14_POSITION[c.position_type]), espn).points).toBeCloseTo(
        c.yahoo_points,
        9,
      );
    }
  });
  it("property: any canonical line over the shared names scores identically under both", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("O", "K", "DT"),
        fc.array(arbValue, { minLength: P14.rule_table.length, maxLength: P14.rule_table.length }),
        (pt, vs) => {
          const values = Object.fromEntries(
            P14.rule_table
              .filter((r) => r.position_type === pt)
              .map((r) => [r.canonical, vs[P14.rule_table.indexOf(r)] ?? 0]),
          );
          return close(score(lineOf(values, P14_POSITION[pt]), espn).points, yahoo(pt, values));
        },
      ),
    );
  });
});

describe("P15 translator agreement (synthetic rows; the fixture set is tests/golden/translator-agreement.test.ts)", () => {
  const s = normalizeSettings({
    scoringItems: [3, 4, 20, 24, 25, 42, 43, 53, 72, 8, 28, 48, 54, 17, 18, 37, 38, 56, 57].map(
      (id, i) => ({ statId: id, points: (i % 5) + 0.5 }),
    ),
  });
  /** What ESPN's pre-bucketed line would carry for the same raw week (per-N, threshold bonuses). */
  const espnFrom = (r: Record<string, number>) => {
    const per = (v: number, n: number) => Math.max(0, Math.floor(v / n));
    const raw: Record<string, number> = {
      "3": r.passing_yards ?? 0,
      "4": r.passing_tds ?? 0,
      "20": r.passing_interceptions ?? 0,
      "24": r.rushing_yards ?? 0,
      "25": r.rushing_tds ?? 0,
      "42": r.receiving_yards ?? 0,
      "43": r.receiving_tds ?? 0,
      "53": r.receptions ?? 0,
      "72": (r.rushing_fumbles_lost ?? 0) + (r.receiving_fumbles_lost ?? 0),
      "8": per(r.passing_yards ?? 0, 25),
      "28": per(r.rushing_yards ?? 0, 10),
      "48": per(r.receiving_yards ?? 0, 10),
      "54": per(r.receptions ?? 0, 5),
      "17": (r.passing_yards ?? 0) >= 300 ? 1 : 0,
      "18": (r.passing_yards ?? 0) >= 400 ? 1 : 0,
      "37": (r.rushing_yards ?? 0) >= 100 ? 1 : 0,
      "38": (r.rushing_yards ?? 0) >= 200 ? 1 : 0,
      "56": (r.receiving_yards ?? 0) >= 100 ? 1 : 0,
      "57": (r.receiving_yards ?? 0) >= 200 ? 1 : 0,
    };
    return statLineFromEspn({ raw }, 1).line;
  };
  it("the same raw week scores identically from the nflverse row and the ESPN line", () => {
    fc.assert(
      fc.property(
        fc.record({
          passing_yards: fc.integer({ min: -10, max: 480 }),
          passing_tds: fc.integer({ min: 0, max: 5 }),
          passing_interceptions: fc.integer({ min: 0, max: 3 }),
          rushing_yards: fc.integer({ min: -10, max: 230 }),
          rushing_tds: fc.integer({ min: 0, max: 3 }),
          receiving_yards: fc.integer({ min: -5, max: 230 }),
          receiving_tds: fc.integer({ min: 0, max: 3 }),
          receptions: fc.integer({ min: 0, max: 14 }),
          rushing_fumbles_lost: fc.integer({ min: 0, max: 2 }),
          receiving_fumbles_lost: fc.integer({ min: 0, max: 1 }),
        }),
        (row) =>
          close(
            score(statLineFromPlayerWeek({ ...row, position: "QB" }), s).points,
            score(espnFrom(row), s).points,
          ),
      ),
    );
  });
});

describe("P16 verify soundness", () => {
  it("match iff every per-stat delta ≤ 0.005 and the total ≤ 0.01; a perturbed stat is named", () => {
    fc.assert(
      fc.property(
        arbLinear,
        fc.nat(),
        fc.double({ min: -0.05, max: 0.05, noNaN: true }),
        ({ rules, x }, pick, d) => {
          const s = linearSettings(rules);
          const line = lineOf(x, 3);
          const r = score(line, s);
          const byStat: Record<string, number> = Object.fromEntries(
            r.contributions.map((c) => [c.platform_id, c.points]),
          );
          const ids = Object.keys(byStat);
          if (ids.length === 0) return verify(line, s, { total: r.points, by_stat: {} }).match;
          const id = ids[pick % ids.length]!;
          const perturbed = { ...byStat, [id]: (byStat[id] ?? 0) + d };
          const v = verify(line, s, { total: r.points + d, by_stat: perturbed });
          const bad = Math.abs(d) > 0.005 + 1e-9;
          return (
            v.match === !bad &&
            (bad ? v.mismatch_stat_ids.join() === id : v.mismatch_stat_ids.length === 0)
          );
        },
      ),
    );
  });
});
