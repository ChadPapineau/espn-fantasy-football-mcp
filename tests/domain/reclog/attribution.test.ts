// attribution.test.ts — plan 10 C9's retrospective attribution (src/domain/reclog/attribution.ts;
// sib research 05 §12.4): the layers sum to the error exactly (a fast-check property over hostile
// but valid rows), a hand-computed RB week under the reference league's scoring, the inactive and
// QB-turnover cases, the volume fallbacks, multiplier lifts, refusals of malformed rows and traces,
// per-call attribution by signed role, and the flat wire map (keys ≤ 40 chars, n-gating, the
// per-call cap). Adversarial by default: every refusal is a count, never a throw.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_BOUNDS,
  ATTRIBUTION_LAYERS,
  CALL_ROLE_WEIGHT,
  MAX_WIRE_CALLS,
  activeLayers,
  attributeCall,
  attributePlayerWeek,
  attributionMap,
  cleanStatMap,
  cleanTrace,
  familyOf,
  lineGroups,
  multiplierLift,
  round3,
  type AttributionRow,
  type CallAttribution,
  type PlayerWeekAttribution,
} from "../../../src/domain/reclog/attribution.js";
import { asPositionId } from "../../../src/domain/scoring/types.js";
import { POS_ID, attributed, leagueScoring, row, trace } from "./attribution-helpers.js";
import { QB1, RB1, RB2, WR1, record, rec, subj } from "./helpers.js";

const S = leagueScoring();

function ok(r: AttributionRow): PlayerWeekAttribution {
  const a = attributePlayerWeek(r, S);
  if (!a.ok) throw new Error(`refused: ${a.reason}`);
  return a.value;
}

const sumLayers = (a: PlayerWeekAttribution): number =>
  ATTRIBUTION_LAYERS.reduce((s, l) => s + a.layers[l], 0);

describe("the hand-computed RB week (reference scoring: 0.5/rec, 0.1/yd, 6/TD)", () => {
  // expected (conditional on playing): rush 15 att / 60 yd / 0.5 TD = 6.0 + 3.0; receiving 4 targets,
  // 3 rec, 25 yd = 1.5 + 2.5 → E = 13.0. Realised: rush 20 / 100 / 1 = 10 + 6; receiving 2 / 2 / 10
  // = 1 + 1 → R = 18.0. p = 0.9, reported 14, realised 18 (ESPN appliedTotal = the engine's).
  const a = ok(row());

  it("expected and realised engine points", () => {
    expect(a.expected_points).toBeCloseTo(13, 9);
    expect(a.realised_engine).toBeCloseTo(18, 9);
    expect(a.model_mean).toBeCloseTo(11.7, 9);
  });

  it("each layer by hand", () => {
    // rush: e_E = 6/15 = 0.4 per carry; opp = (20 − 15)·0.4 = 2.0, eff = 4.0 − 2.0 = 2.0
    // receiving: e_E = 4/4 = 1.0 per target; opp = (2 − 4)·1.0 = −2.0, eff = −2.0 − (−2.0) = 0
    expect(a.layers.opportunity).toBeCloseTo(0, 9);
    expect(a.layers.efficiency).toBeCloseTo(2, 9);
    expect(a.layers.touchdowns).toBeCloseTo(3, 9);
    expect(a.layers.turnovers).toBeCloseTo(0, 9);
    expect(a.layers.other).toBeCloseTo(0, 9);
    expect(a.layers.availability).toBeCloseTo(0.1 * 13, 9);
    expect(a.layers.anchor).toBeCloseTo(11.7 - 14, 9);
    expect(a.layers.scoring).toBeCloseTo(0, 9);
    expect(a.error).toBe(4);
    expect(sumLayers(a)).toBeCloseTo(a.error, 9);
  });

  it("with p_active unknown the expectation is the mean (no availability layer when active)", () => {
    const b = ok(row({ p_active: null }));
    expect(b.layers.availability).toBe(0);
    expect(b.model_mean).toBeCloseTo(13, 9);
    expect(sumLayers(b)).toBeCloseTo(b.error, 9);
  });

  it("a scoring mismatch lands in `scoring`, never in a model layer", () => {
    const b = ok(row({ realised_points: 18.5 }));
    expect(b.layers.scoring).toBeCloseTo(0.5, 9);
    expect(b.layers.efficiency).toBeCloseTo(a.layers.efficiency, 9);
  });
});

describe("the inactive week", () => {
  it("realises nothing: availability takes −p·E, every active layer is 0, the sum holds", () => {
    const a = ok(row({ active: false, realised_points: 0 }));
    expect(a.realised_engine).toBe(0);
    for (const l of ["opportunity", "efficiency", "touchdowns", "turnovers", "other"] as const)
      expect(a.layers[l]).toBe(0);
    expect(a.layers.availability).toBeCloseTo(-0.9 * 13, 9);
    expect(sumLayers(a)).toBeCloseTo(a.error, 9);
  });

  it("an inactive row's stray realised line is ignored (ESPN's 0 is in `scoring` only if non-zero)", () => {
    const a = ok(row({ active: false, realised_points: 1.5 }));
    expect(a.layers.efficiency).toBe(0);
    expect(a.layers.scoring).toBeCloseTo(1.5, 9);
  });
});

describe("a QB week: passing volume, efficiency, TDs and the −2 INT", () => {
  const qb = (over: Partial<AttributionRow> = {}): AttributionRow =>
    row({
      player_id: QB1.id,
      gsis_id: QB1.gsis,
      position: "QB",
      position_id: POS_ID.QB,
      expected: {
        pass_att: 34,
        pass_cmp: 22,
        pass_yd: 250,
        pass_td: 1.8,
        pass_int: 0.8,
        rush_att: 4,
        rush_yd: 18,
      },
      realised: {
        pass_att: 40,
        pass_cmp: 25,
        pass_yd: 300,
        pass_td: 2,
        pass_int: 2,
        rush_att: 3,
        rush_yd: 10,
      },
      reported_mean: 20,
      realised_points: 0,
      p_active: 1,
      ...over,
    });

  it("turnovers = −2 × ΔINT; passing opportunity at the expected yards per attempt", () => {
    const base = ok(qb());
    const a = ok(qb({ realised_points: base.realised_engine }));
    expect(a.layers.turnovers).toBeCloseTo(-2 * (2 - 0.8), 9);
    // e_E = 250·0.04 / 34 per attempt; opp = (40 − 34)·e_E; rush: (3 − 4)·(1.8/4)
    expect(a.layers.opportunity).toBeCloseTo(6 * (10 / 34) + -1 * (1.8 / 4), 9);
    expect(a.layers.touchdowns).toBeCloseTo(5 * (2 - 1.8), 9);
    expect(a.layers.scoring).toBeCloseTo(0, 9);
    expect(sumLayers(a)).toBeCloseTo(a.error, 9);
  });
});

describe("volume fallbacks", () => {
  it("receptions stand in for targets when targets are not in both lines", () => {
    const a = ok(
      row({
        expected: { rec: 4, rec_yd: 40 },
        realised: { rec: 6, rec_yd: 50, targets: 9 },
        realised_points: 8,
      }),
    );
    // e_E = (2 + 4)/4 = 1.5 per reception; opp = 2·1.5 = 3; ΔP = 8 − 6 = 2 → eff −1
    expect(a.layers.opportunity).toBeCloseTo(3, 9);
    expect(a.layers.efficiency).toBeCloseTo(-1, 9);
  });

  it("volume the model did not expect is all opportunity; no volume pair is all efficiency", () => {
    const a = ok(
      row({
        expected: { rush_att: 0, rush_yd: 0 },
        realised: { rush_att: 5, rush_yd: 30 },
        realised_points: 3,
      }),
    );
    expect(a.layers.opportunity).toBeCloseTo(3, 9);
    expect(a.layers.efficiency).toBeCloseTo(0, 9);
    const b = ok(row({ expected: { rush_yd: 50 }, realised: { rush_yd: 30 }, realised_points: 3 }));
    expect(b.layers.opportunity).toBe(0);
    expect(b.layers.efficiency).toBeCloseTo(-2, 9);
  });

  it("a volume that vanished is all opportunity at the expected efficiency", () => {
    const a = ok(
      row({
        expected: { rush_att: 10, rush_yd: 40 },
        realised: { rush_att: 0, rush_yd: 0 },
        realised_points: 0,
      }),
    );
    expect(a.layers.opportunity).toBeCloseTo(-4, 9);
    expect(a.layers.efficiency).toBeCloseTo(0, 9);
  });

  it("a volume under VOLUME_EPS is none (no cancellation of enormous terms)", () => {
    const a = ok(
      row({
        position: "QB",
        position_id: POS_ID.QB,
        expected: { targets: 5e-324, rec_yd: -1e-118, rec_2pt: 1 },
        realised: { targets: 1e-189 },
        p_active: 0,
        reported_mean: 0,
        realised_points: 0,
      }),
    );
    expect(a.layers.opportunity).toBe(0);
    expect(Math.abs(sumLayers(a) - a.error)).toBeLessThan(1e-9);
  });

  it("a negative volume is not a volume (the family falls back to efficiency)", () => {
    expect(
      activeLayers(
        lineGroups(
          {
            values: { rush_yd: 50 },
            present: ["rush_yd"],
            position: asPositionId(2),
            position_class: "O",
            provisional: false,
            source: "projection:v2-opportunity",
          },
          S,
        ),
        lineGroups(
          {
            values: { rush_yd: 30 },
            present: ["rush_yd"],
            position: asPositionId(2),
            position_class: "O",
            provisional: false,
            source: "espn",
          },
          S,
        ),
        { rush_att: -1, rush_yd: 50 },
        { rush_att: 5, rush_yd: 30 },
      ).opportunity,
    ).toBe(0);
  });
});

describe("families and groups", () => {
  it.each([
    ["pass_yd", "pass"],
    ["per_n_pass_yd_25", "pass"],
    ["sacked", "pass"],
    ["pass_td_40", "pass"],
    ["rush_att", "rush"],
    ["per_n_rush_yd_10", "rush"],
    ["rec", "rec"],
    ["targets", "rec"],
    ["rec_yd_100", "rec"],
    ["per_n_rec_5", "rec"],
    ["rec_2pt", null],
    ["pass_2pt", null],
    ["two_pt_total", null],
    ["kr_td", null],
    ["dst_sack", null],
    ["fg_0_39", null],
  ] as const)("%s → %s", (c, f) => {
    expect(familyOf(c)).toBe(f);
  });

  it("a K or D/ST line is all `other` (no opportunity family)", () => {
    const a = ok(
      row({
        position: "K",
        position_id: POS_ID.K,
        expected: { fg_0_39: 1.2, pat_made: 2 },
        realised: { fg_0_39: 2, pat_made: 3 },
        reported_mean: 7,
        realised_points: 9,
        p_active: 1,
      }),
    );
    expect(a.layers.other).toBeCloseTo(a.realised_engine - a.expected_points, 9);
    expect(a.layers.opportunity).toBe(0);
    expect(sumLayers(a)).toBeCloseTo(a.error, 9);
  });

  it("lineGroups' groups sum to the engine total (other absorbs the rest)", () => {
    const g = lineGroups(
      {
        values: {
          pass_yd: 280,
          pass_td: 2,
          pass_int: 1,
          pass_2pt: 1,
          rush_yd: 20,
          rec: 1,
          rec_yd: 5,
          fum_lost: 1,
          fum_rec_td_off: 1,
        },
        present: [],
        position: asPositionId(1),
        position_class: "O",
        provisional: false,
        source: "espn",
      },
      S,
    );
    const sum =
      g.nonTd.pass +
      g.nonTd.rush +
      g.nonTd.rec +
      g.td.pass +
      g.td.rush +
      g.td.rec +
      g.turnovers +
      g.other;
    expect(sum).toBeCloseTo(g.total, 9);
    expect(g.turnovers).toBeCloseTo(-4, 9);
    expect(g.other).toBeCloseTo(2 + 6, 9);
  });
});

describe("the identity: Σ layers = realised − reported, for any valid row (property)", () => {
  const stat = fc.double({ min: 0, max: 400, noNaN: true });
  const line = fc.record(
    {
      pass_att: stat,
      pass_cmp: stat,
      pass_yd: fc.double({ min: -20, max: 500, noNaN: true }),
      pass_td: fc.double({ min: 0, max: 6, noNaN: true }),
      pass_int: fc.double({ min: 0, max: 5, noNaN: true }),
      rush_att: stat,
      rush_yd: fc.double({ min: -30, max: 300, noNaN: true }),
      rush_td: fc.double({ min: 0, max: 4, noNaN: true }),
      targets: stat,
      rec: stat,
      rec_yd: fc.double({ min: -10, max: 300, noNaN: true }),
      rec_td: fc.double({ min: 0, max: 4, noNaN: true }),
      fum_lost: fc.double({ min: 0, max: 3, noNaN: true }),
      rec_2pt: fc.integer({ min: 0, max: 2 }),
    },
    { requiredKeys: [] },
  );
  it("holds within 1e-6 (positions QB/RB/WR/TE, active or not, any p and means)", () => {
    fc.assert(
      fc.property(
        line,
        line,
        fc.constantFrom("QB", "RB", "WR", "TE"),
        fc.boolean(),
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
        fc.double({ min: -50, max: 80, noNaN: true }),
        fc.double({ min: -50, max: 80, noNaN: true }),
        (e, r, pos, active, p, reported, realised) => {
          const a = attributePlayerWeek(
            row({
              position: pos,
              position_id: POS_ID[pos],
              expected: e,
              realised: r,
              active,
              p_active: p,
              reported_mean: reported,
              realised_points: realised,
            }),
            S,
          );
          expect(a.ok).toBe(true);
          if (!a.ok) return;
          expect(Math.abs(sumLayers(a.value) - a.value.error)).toBeLessThan(1e-6);
          for (const l of ATTRIBUTION_LAYERS) expect(Number.isFinite(a.value.layers[l])).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("refusals (counted by the caller, never thrown)", () => {
  const refuse = (over: Partial<AttributionRow> | Record<string, unknown>): string | null => {
    const a = attributePlayerWeek({ ...row(), ...(over as Partial<AttributionRow>) }, S);
    return a.ok ? null : a.reason;
  };

  it.each([
    ["a bad position", { position: "__proto__" }],
    ["a lowercase position", { position: "rb" }],
    ["a NaN reported mean", { reported_mean: Number.NaN }],
    ["an infinite realised value", { realised_points: Number.POSITIVE_INFINITY }],
    ["an out-of-range realised value", { realised_points: 1e7 }],
    ["p_active above 1", { p_active: 1.5 }],
    ["p_active below 0", { p_active: -0.1 }],
    ["an unknown model", { model_version: "v9" }],
    ["an unknown realised source", { realised_source: "yahoo" }],
    ["a non-boolean active", { active: "yes" }],
    ["a fractional week", { week: 2.5 }],
    ["a non-integer player id", { player_id: 1.5 }],
    ["a non-string gsis id", { gsis_id: 7 }],
    ["a stat key that is not canonical", { expected: { __proto__x: 1 } }],
    ["a capitalised stat key", { realised: { Rush_yd: 1 } }],
    ["a NaN stat", { expected: { rush_yd: Number.NaN } }],
    ["an array stat map", { expected: [1, 2] }],
    ["a null stat map", { realised: null }],
    ["an ESPN espn_mean that is not finite", { espn_mean: Number.NaN }],
  ])("%s → invalid_row", (_name, over) => {
    expect(refuse(over)).toBe("invalid_row");
  });

  it("a non-object row is invalid", () => {
    expect(attributePlayerWeek(null as unknown as AttributionRow, S)).toEqual({
      ok: false,
      reason: "invalid_row",
    });
  });

  it("more stat keys than the bound is invalid", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i <= ATTRIBUTION_BOUNDS.statKeys; i++) big[`s${String(i)}`] = 1;
    expect(refuse({ expected: big })).toBe("invalid_row");
    expect(cleanStatMap(big)).toBeNull();
  });

  it("an unknown position id or two exclusive tiers at once are unscorable", () => {
    expect(refuse({ position_id: 200 })).toBe("unscorable_line");
    expect(refuse({ position_id: 77 })).toBe("unscorable_line");
    expect(
      refuse({
        position: "D/ST",
        position_id: POS_ID["D/ST"],
        expected: { dst_pa_0: 1, dst_pa_1_6: 1 },
      }),
    ).toBe("unscorable_line");
  });

  it("an own-property `constructor` stat is data, never a prototype hook", () => {
    const a = ok(row({ expected: { ...row().expected, constructor: 3 } }));
    expect(a.expected_points).toBeCloseTo(13, 9);
  });
});

describe("traces", () => {
  it("a valid trace is kept; the matchup and weather lifts are measured on the model's mean", () => {
    const a = ok(row({ trace: trace({ weather_mult: 0.9 }) }));
    expect(a.trace?.shares).toHaveLength(1);
    const m = 1 + 0.2 * 0.5;
    expect(a.matchup_lift).toBeCloseTo(
      Math.abs(18 - a.model_mean / m) - Math.abs(18 - a.model_mean),
      9,
    );
    expect(a.weather_lift).toBeCloseTo(
      Math.abs(18 - a.model_mean / 0.9) - Math.abs(18 - a.model_mean),
      9,
    );
  });

  it("no multiplier → no lift; m = 1 → no lift", () => {
    expect(multiplierLift(10, 8, null)).toBeNull();
    expect(multiplierLift(10, 8, 1)).toBeNull();
    expect(multiplierLift(10, 8, 0)).toBeNull();
    expect(multiplierLift(10, 8, 1.25)).toBeCloseTo(Math.abs(10 - 6.4) - 2, 9);
    const a = ok(row({ trace: trace({ matchup: null }) }));
    expect(a.matchup_lift).toBeNull();
  });

  it.each([
    [
      "an unknown share name",
      { shares: [{ name: "vibes", history: [0.5], half_life: 3, realised: 0.5 }] },
    ],
    [
      "an empty share history",
      { shares: [{ name: "target_share", history: [], half_life: 3, realised: 0.5 }] },
    ],
    [
      "a share above 1",
      { shares: [{ name: "target_share", history: [1.2], half_life: 3, realised: 0.5 }] },
    ],
    [
      "a zero half-life",
      { shares: [{ name: "target_share", history: [0.2], half_life: 0, realised: 0.5 }] },
    ],
    [
      "a realised share above 1",
      { shares: [{ name: "target_share", history: [0.2], half_life: 3, realised: 2 }] },
    ],
    [
      "too many shares",
      {
        shares: Array.from({ length: 17 }, () => ({
          name: "target_share",
          history: [0.2],
          half_life: 3,
          realised: 0.2,
        })),
      },
    ],
    [
      "an unknown rate",
      {
        rates: [
          { name: "hope", n_obs: 1, observed: 1, prior: 1, k: 1, realised: 1, realised_n: 1 },
        ],
      },
    ],
    [
      "a zero k",
      {
        rates: [
          { name: "catch_rate", n_obs: 1, observed: 1, prior: 1, k: 0, realised: 1, realised_n: 1 },
        ],
      },
    ],
    [
      "a negative n_obs",
      {
        rates: [
          {
            name: "catch_rate",
            n_obs: -1,
            observed: 1,
            prior: 1,
            k: 1,
            realised: 1,
            realised_n: 1,
          },
        ],
      },
    ],
    [
      "a NaN prior",
      {
        rates: [
          {
            name: "catch_rate",
            n_obs: 1,
            observed: 1,
            prior: Number.NaN,
            k: 1,
            realised: 1,
            realised_n: 1,
          },
        ],
      },
    ],
    [
      "a negative realised_n",
      {
        rates: [
          {
            name: "catch_rate",
            n_obs: 1,
            observed: 1,
            prior: 1,
            k: 1,
            realised: 1,
            realised_n: -1,
          },
        ],
      },
    ],
    [
      "a NaN realised rate",
      {
        rates: [
          {
            name: "catch_rate",
            n_obs: 1,
            observed: 1,
            prior: 1,
            k: 1,
            realised: Number.NaN,
            realised_n: 1,
          },
        ],
      },
    ],
    ["a matchup making m ≤ 0", { matchup: { z: -20, beta: 0.1 } }],
    ["a huge z", { matchup: { z: 1000, beta: 0.1 } }],
    ["a negative beta", { matchup: { z: 1, beta: -0.1 } }],
    ["a matchup that is not an object", { matchup: 3 }],
    ["a zero weather multiplier", { weather_mult: 0 }],
    ["shares that are not an array", { shares: {} }],
    ["rates that are not an array", { rates: null }],
  ])("%s drops the trace, keeps the row", (_name, over) => {
    const t = { ...trace(), ...over } as unknown;
    expect(cleanTrace(t)).toBeNull();
    const a = ok(row({ trace: t as never }));
    expect(a.trace).toBeNull();
    expect(a.matchup_lift).toBeNull();
  });

  it("a non-object trace is null", () => {
    expect(cleanTrace(null)).toBeNull();
    expect(cleanTrace("trace")).toBeNull();
  });
});

describe("per-call attribution by signed role", () => {
  const rows = new Map<number, PlayerWeekAttribution>([
    [RB1.id, ok(row())],
    [RB2.id, ok(row({ player_id: RB2.id, gsis_id: RB2.gsis, realised_points: 6, active: true }))],
  ]);
  const lookup = (s: { player_id: number | null }) =>
    s.player_id === null ? undefined : rows.get(s.player_id);

  it("start RB1 / sit RB2: the call's error and layers are RB1's minus RB2's", () => {
    const c = attributeCall(record(), 0, lookup);
    const a = rows.get(RB1.id)!;
    const b = rows.get(RB2.id)!;
    expect(c.projection_backed).toBe(true);
    expect(c.complete).toBe(true);
    expect(c.subjects_weighted).toBe(2);
    expect(c.error).toBeCloseTo(a.error - b.error, 9);
    for (const l of ATTRIBUTION_LAYERS)
      expect(c.layers?.[l]).toBeCloseTo(a.layers[l] - b.layers[l], 9);
  });

  it("a subject without a row leaves the call incomplete; none → not backed", () => {
    const c = attributeCall(
      record({ rec: rec({ subjects: [subj(RB1, "start"), subj(WR1, "sit")] }) }),
      3,
      lookup,
    );
    expect(c).toMatchObject({
      index: 3,
      projection_backed: true,
      complete: false,
      subjects_attributed: 1,
    });
    const d = attributeCall(
      record({ rec: rec({ subjects: [subj(WR1, "claim"), subj(QB1, "drop")] }) }),
      1,
      lookup,
    );
    expect(d).toMatchObject({
      projection_backed: false,
      complete: false,
      error: null,
      layers: null,
    });
  });

  it("an ambiguous row (null) counts as missing; an IR move weighs nothing", () => {
    const c = attributeCall(
      record({ rec: rec({ subjects: [subj(RB1, "start")] }) }),
      0,
      () => null,
    );
    expect(c.projection_backed).toBe(false);
    const d = attributeCall(record({ rec: rec({ subjects: [subj(RB1, "ir_move")] }) }), 0, lookup);
    expect(d.subjects_weighted).toBe(0);
    expect(d.projection_backed).toBe(false);
  });

  it("every role has a weight in {−1, 0, 1}", () => {
    for (const w of Object.values(CALL_ROLE_WEIGHT)) expect([-1, 0, 1]).toContain(w);
  });
});

describe("the wire map", () => {
  const many = (n: number, over: Partial<PlayerWeekAttribution> = {}): PlayerWeekAttribution[] =>
    Array.from({ length: n }, (_, i) => attributed({ week: 1 + (i % 4), error: i % 3, ...over }));
  const backed = (index: number): CallAttribution => ({
    log_id: `rec-${"0".repeat(25)}${String(index % 10)}`,
    index,
    projection_backed: true,
    complete: index % 2 === 0,
    subjects_weighted: 2,
    subjects_attributed: index % 2 === 0 ? 2 : 1,
    error: 1.23456,
    layers: Object.fromEntries(
      ATTRIBUTION_LAYERS.map((l) => [l, 0.1]),
    ) as CallAttribution["layers"],
  });

  it("under min_n: counts and per-call keys only, and one caveat", () => {
    const agg = attributionMap(many(5), [backed(0)], 30);
    expect(agg.map.n_player_weeks).toBe(5);
    expect(agg.map["error.mean"]).toBeUndefined();
    expect(agg.map["calls.0.error"]).toBe(1.235);
    expect(agg.map["calls.0.complete"]).toBe(1);
    expect(agg.caveats).toEqual(["attribution: n too small (5 of 30)"]);
  });

  it("at min_n: means and MAEs per layer, per position once that position reaches min_n", () => {
    const rows = [...many(30), ...many(10, { position: "TE" })];
    const agg = attributionMap(rows, [], 30);
    // errors i % 3: 30 RB rows → 10·0 + 10·1 + 10·2 = 30; 10 TE rows → 0,1,2,0,1,2,0,1,2,0 = 9
    expect(agg.map["error.mae"]).toBe(round3(39 / 40));
    for (const l of ATTRIBUTION_LAYERS) {
      expect(agg.map[`${l}.mean`]).toBe(0);
      expect(agg.map[`${l}.mae`]).toBe(0);
    }
    expect(agg.map["RB.n"]).toBe(30);
    expect(agg.map["TE.n"]).toBeUndefined();
    expect(agg.caveats).toEqual([]);
  });

  it("lifts: n always, the mean once n ≥ min_n", () => {
    const agg = attributionMap(many(3, { matchup_lift: 0.5, weather_lift: -1 }), [], 2);
    expect(agg.map["matchup_lift.n"]).toBe(3);
    expect(agg.map["matchup_lift.mean"]).toBe(0.5);
    expect(agg.map["weather_lift.mean"]).toBe(-1);
    const small = attributionMap(many(1, { matchup_lift: 0.5 }), [], 2);
    expect(small.map["matchup_lift.mean"]).toBeUndefined();
  });

  it("per-call keys stop at MAX_WIRE_CALLS with a caveat; unbacked calls are counted", () => {
    const calls = Array.from({ length: MAX_WIRE_CALLS + 5 }, (_, i) => backed(i));
    const unbacked: CallAttribution = {
      ...backed(99),
      projection_backed: false,
      complete: false,
      error: null,
      layers: null,
    };
    const agg = attributionMap([], [...calls, unbacked], 30);
    expect(agg.map["calls.projection_backed"]).toBe(MAX_WIRE_CALLS + 5);
    expect(agg.map["calls.unbacked"]).toBe(1);
    expect(agg.map[`calls.${String(MAX_WIRE_CALLS - 1)}.error`]).toBeDefined();
    expect(agg.map[`calls.${String(MAX_WIRE_CALLS)}.error`]).toBeUndefined();
    expect(agg.caveats.at(-1)).toMatch(/first 20 of 25 projection-backed calls/);
  });

  it("every key is ≤ 40 chars and every value finite (the E13 schema's record)", () => {
    const rows = [
      ...many(40, { position: "D/ST" }),
      ...many(40, { position: "QB", matchup_lift: 1 }),
    ];
    const calls = Array.from({ length: MAX_WIRE_CALLS }, (_, i) => backed(199 - i));
    const agg = attributionMap(rows, calls, 30);
    for (const [k, v] of Object.entries(agg.map)) {
      expect(k.length).toBeLessThanOrEqual(40);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("round3 never emits −0", () => {
    expect(Object.is(round3(-0.0001), 0)).toBe(true);
    expect(round3(1.23449)).toBe(1.234);
  });
});
