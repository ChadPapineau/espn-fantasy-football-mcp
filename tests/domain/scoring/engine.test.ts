// engine.test.ts — src/domain/scoring/engine.ts (plan 08 E1, §3.4 gating and position overrides, §4.1
// exclusive tiers and derived lines, §4.2–4.3 bonuses / per-N / long-TD, §4.6 E4, §4.7 complete,
// §5 E5 samples). Hand-built inputs only (plan 05 §3 fixture law: never golden evidence).
import { describe, expect, it } from "vitest";
import {
  explain,
  MAX_SAMPLES,
  score,
  scoreSamples,
  sumPoints,
} from "../../../src/domain/scoring/engine.js";
import { renormalizeSettings } from "../../../src/domain/scoring/settings.js";
import type { ScoringSettings, StatLine } from "../../../src/domain/scoring/types.js";
import { asPositionId } from "../../../src/domain/scoring/types.js";
import { espnLine, item, line, settingsOf } from "./helpers.js";

const QB = 1;
const RB = 2;
const WR = 3;
const K = 5;
const TQB = 15;
const DST = 16;

describe("score: linear rules, class gating, position overrides (plan 08 §3.4)", () => {
  const s = settingsOf([
    item(24, 0, { "1": 0.1, "2": 0.1, "3": 0.1, "4": 0.1, "15": 0.1 }),
    item(53, 0.5),
    item(89, 0, { "16": 5 }),
    item(114, 0.02, { "16": 0.02 }),
  ]);
  it("uses the override keyed by the player's POSITION id, else the base points", () => {
    const r = score(espnLine({ 24: 57, 53: 3 }, RB), s);
    expect(r.points).toBe(7.2);
    expect(r.contributions).toEqual([
      {
        canonical: "rush_yd",
        platform_id: "24",
        value: 57,
        points_per: 0.1,
        override_used: true,
        points: 5.7,
        kind: "linear",
      },
      {
        canonical: "rec",
        platform_id: "53",
        value: 3,
        points_per: 0.5,
        override_used: false,
        points: 1.5,
        kind: "linear",
      },
    ]);
    expect(explain(espnLine({ 24: 57, 53: 3 }, RB), s)).toEqual(r);
  });
  it("a position without an override takes the base (0 here): the slot never matters", () => {
    expect(score(espnLine({ 24: 57 }, K), s).points).toBe(0);
  });
  it("a D/ST tier never scores an offensive line; return yards score on both (league-a, recorded)", () => {
    const off = score(line({ dst_pa_0: 1, kr_yd: 100 }, WR, "espn"), s);
    expect(off.points).toBe(2);
    expect(off.ignored).toEqual(["dst_pa_0"]);
    expect(score(espnLine({ 89: 1, 120: 0, 114: 100 }, DST), s).points).toBe(7);
  });
  it("denoises each product and the total (0.04 × 312 = 12.48)", () => {
    expect(score(espnLine({ 3: 312 }, QB), settingsOf([item(3, 0.04)])).points).toBe(12.48);
  });
  it("negative totals are kept (no floor — plan 08 §4.6)", () => {
    expect(
      score(espnLine({ 20: 2, 72: 1 }, QB), settingsOf([item(20, -2), item(72, -2)])).points,
    ).toBe(-6);
  });
  it("lists stats absent from S in `ignored` (sorted), never the family scalars it consumes", () => {
    const r = score(
      line({ rec: 1, targets: 4, rush_att: 3, "Bad-Key": 1, dst_pa_raw: 3 }, WR, "espn"),
      s,
    );
    expect(r.ignored).toEqual(["dst_pa_raw", "rush_att", "targets"]);
    const d = score(
      line({ dst_pa_raw: 3, dst_pa_1_6: 1 }, DST, "espn"),
      settingsOf([item(90, 0, { "16": 4 })]),
    );
    expect(d.ignored).toEqual([]);
  });
  it("a hand-built settings object is re-validated and memoised per object", () => {
    const plain = JSON.parse(JSON.stringify(s)) as ScoringSettings;
    expect(score(espnLine({ 53: 2 }, WR), plain).points).toBe(1);
    expect(score(espnLine({ 53: 4 }, WR), plain).points).toBe(2);
    expect(() =>
      score(espnLine({}, WR), { ...plain, rounding: { mode: "x" } } as unknown as ScoringSettings),
    ).toThrow(expect.objectContaining({ code: "invalid_settings" }));
  });
  it("a custom canonical (no registry row) scores linearly", () => {
    const m = JSON.parse(JSON.stringify(settingsOf([]))) as { rules: unknown[] };
    m.rules.push({
      canonical: "custom_stat",
      platform_id: "998",
      abbr: "X",
      points: 2,
      overrides: {},
      is_reverse: false,
      applies_to: ["O"],
      disputed: false,
    });
    const custom = renormalizeSettings(m);
    expect(score(line({ custom_stat: 3 }, QB), custom).contributions[0]).toMatchObject({
      points: 6,
      kind: "linear",
    });
  });
});

describe("score: line validation (P11)", () => {
  const s = settingsOf([item(53, 1)]);
  const good = line({ rec: 1 }, WR);
  it.each([
    ["null", null],
    ["position fractional", { ...good, position: 1.5 }],
    ["position 100", { ...good, position: 100 }],
    ["position a string", { ...good, position: "3" }],
    ["unknown class", { ...good, position_class: "QB" }],
    ["source not a string", { ...good, source: 7 }],
    ["values null", { ...good, values: null }],
    ["values a string", { ...good, values: "rec" }],
    ["a NaN value", { ...good, values: { rec: Number.NaN } }],
    ["an Infinity value", { ...good, values: { rec: Number.POSITIVE_INFINITY } }],
    ["an absurd value", { ...good, values: { rec: 2e9 } }],
    ["a string value", { ...good, values: { rec: "1" } }],
  ])("refuses %s (invalid_line)", (_label, bad) => {
    expect(() => score(bad as unknown as StatLine, s)).toThrow(
      expect.objectContaining({ code: "invalid_line" }),
    );
  });
});

describe("score: exclusive tiers (plan 08 §4.1)", () => {
  const s = settingsOf([
    item(89, 0, { "16": 5 }),
    item(90, 0, { "16": 4 }),
    item(91, 0, { "16": 3 }),
  ]);
  it("two tiers set in one game is drift, never a score", () => {
    expect(() => score(espnLine({ 89: 1, 90: 1 }, DST), s)).toThrow(
      expect.objectContaining({ code: "bracket_exclusivity" }),
    );
  });
  it("a tier outside [0, 1] is drift — even one S does not score", () => {
    expect(() => score(espnLine({ 90: 2 }, DST), s)).toThrow(/not in \[0, 1\]/);
    expect(() => score(espnLine({ 121: 3 }, DST), s)).toThrow(
      expect.objectContaining({ code: "bracket_exclusivity" }),
    );
    expect(() => score(line({ dst_pa_0: -1 }, DST, "espn"), s)).toThrow(
      expect.objectContaining({ code: "bracket_exclusivity" }),
    );
  });
  it("ESPN's projected tier probabilities (Σ = 1) score as expectations", () => {
    const r = score(espnLine({ 89: 0.2, 90: 0.3, 91: 0.5 }, DST), s);
    expect(r.points).toBe(3.7);
  });
  it("an ESPN line is never bracketized: raw 120 with no tier scores 0 (game not played)", () => {
    expect(score(espnLine({ 120: 0 }, DST), s)).toMatchObject({ points: 0, complete: true });
    expect(score(espnLine({ 120: 0 }, DST, true), s)).toMatchObject({ points: 0, complete: false });
  });
  it("count families (FG buckets) are not exclusive: two buckets in one game both pay", () => {
    expect(
      score(
        espnLine({ 80: 2, 77: 1, 198: 1 }, K),
        settingsOf([item(80, 3), item(77, 4), item(198, 5)]),
      ).points,
    ).toBe(15);
  });
});

describe("score: derived and projection lines (plan 08 §4.1–§4.3)", () => {
  const s = settingsOf([
    item(89, 0, { "16": 5 }),
    item(92, 0, { "16": 1 }),
    item(17, 2),
    item(18, 3),
    item(8, 1),
    item(15, 1),
    item(16, 1),
    item(4, 4),
  ]);
  const returns = settingsOf([item(101, 6, { "16": 6 })]);
  it("bracketizes the raw scalar into the league's tier", () => {
    expect(score(line({ dst_pa_raw: 0 }, DST), s).points).toBe(5);
    expect(score(line({ dst_pa_raw: 15 }, DST), s).points).toBe(1);
    expect(score(line({ dst_pa_raw: 30 }, DST), s).points).toBe(0);
  });
  it("derives cumulative yardage bonuses and per-N items from the yardage", () => {
    const r = score(line({ pass_yd: 412, pass_td: 0 }, QB), s);
    expect(r.contributions.map((c) => [c.canonical, c.value, c.kind])).toEqual([
      ["pass_td", 0, "linear"],
      ["per_n_pass_yd_25", 16, "linear"],
      ["pass_td_40", 0, "bonus"],
      ["pass_td_50", 0, "bonus"],
      ["pass_yd_300", 1, "bonus"],
      ["pass_yd_400", 1, "bonus"],
    ]);
    expect(r).toMatchObject({ points: 21, complete: true, underivable: [] });
  });
  it("long-TD bonuses are underivable from a weekly TD count > 0 (complete: false)", () => {
    const r = score(line({ pass_yd: 250, pass_td: 2 }, QB), s);
    expect(r).toMatchObject({
      points: 18,
      complete: false,
      underivable: ["pass_td_40", "pass_td_50"],
    });
  });
  it("a projection sample is complete by construction: absent stats score 0, nothing underivable", () => {
    const r = score(line({ pass_yd: 250, pass_td: 2 }, QB, "projection:v1-ensemble"), s);
    expect(r).toMatchObject({ points: 18, complete: true, underivable: [] });
    expect(score(line({ dst_pa_raw: 0 }, DST, "projection:v1-ensemble"), s).points).toBe(5);
  });
  it("kick/punt-return TDs derive as 0 when total return TDs are 0, else underivable", () => {
    expect(score(line({ ret_td_total: 0 }, WR), returns)).toMatchObject({
      points: 0,
      complete: true,
    });
    expect(score(line({ ret_td_total: 0 }, WR), returns).contributions[0]).toMatchObject({
      canonical: "kr_td",
      value: 0,
    });
    expect(score(line({ ret_td_total: 1 }, WR), returns)).toMatchObject({
      complete: false,
      underivable: ["kr_td"],
    });
    expect(score(line({}, WR), returns)).toMatchObject({ complete: false, underivable: ["kr_td"] });
    expect(score(espnLine({}, WR), returns)).toMatchObject({ complete: true, underivable: [] });
  });
  it("an ESPN line carrying a member is scored as sent (no derivation)", () => {
    expect(score(espnLine({ 3: 412, 17: 1 }, QB), s).points).toBe(2);
  });
});

describe("score: complete (plan 08 §4.7, P10)", () => {
  const s = settingsOf([item(53, 1), item(25, 0, { "16": 0, "2": 6 })]);
  it("false only when provisional AND a scored stat is absent", () => {
    expect(score(espnLine({ 53: 2 }, RB, true), s).complete).toBe(false);
    expect(score(espnLine({ 53: 2, 25: 0 }, RB, true), s).complete).toBe(true);
    expect(score(espnLine({ 53: 2 }, RB, false), s).complete).toBe(true);
  });
  it("a rule scoring 0 for this position never leaves a provisional line open", () => {
    expect(score(espnLine({}, DST, true), settingsOf([item(25, 0, { "2": 6 })])).complete).toBe(
      true,
    );
  });
  it("reports unmapped ids from S on every result", () => {
    expect(score(espnLine({}, RB), settingsOf([item(999, 1)])).unmapped).toEqual(["999"]);
  });
});

describe("sumPoints (the matchup layer's starters' sum)", () => {
  it("sums with compensation and denoises; refuses non-finite points", () => {
    expect(sumPoints([0.1, 0.2, 0.3])).toBe(0.6);
    expect(sumPoints([])).toBe(0);
    expect(() => sumPoints([1, Number.NaN])).toThrow(
      expect.objectContaining({ code: "invalid_line" }),
    );
  });
});

describe("scoreSamples (plan 08 §5, E5)", () => {
  const s = settingsOf([
    item(24, 0.1),
    item(37, 5),
    item(38, 10),
    item(89, 0, { "16": 5 }),
    item(92, 0, { "16": 1 }),
  ]);
  const rb = (yd: number): StatLine => line({ rush_yd: yd }, RB, "projection:v1-ensemble");
  it("scores samples, never the mean line: a bonus contributes P(stat ≥ target) × points", () => {
    const samples = [rb(50), rb(150), rb(90), rb(110)];
    const r = scoreSamples(samples, s, "player_sim");
    expect(r.dist.mean).toBe(12.5);
    expect(r.mean_of_exact).toBe(12.5);
    expect(r.bonus_probability).toEqual({ rush_yd_100: 0.5, rush_yd_200: 0 });
    expect(r.bracket_probability["yardage_bonus:rush_yd"]).toEqual([0.5, 0]);
    expect(r.dist).toMatchObject({
      p10: 6.2,
      p25: 8,
      p50: 12.5,
      p75: 17,
      p90: 18.8,
      p_zero: 0,
      basis: "player_sim",
    });
    // the scaled mean line (100 yds) would wrongly pay the full bonus
    expect(scoreSamples([rb(100)], s, "player_sim").dist.mean).toBe(15);
  });
  it("counts zeros, mixes classes, and averages tiers over every sample", () => {
    const dst = (pa: number) => line({ dst_pa_raw: pa }, DST, "projection:v1-ensemble");
    const r = scoreSamples(
      [dst(0), dst(14), dst(30), line({}, RB, "projection:v1-ensemble")],
      s,
      "position_cv",
    );
    expect(r.dist.p_zero).toBe(0.5);
    expect(r.bracket_probability["dst_points_allowed:dst_pa_raw"]).toEqual([0.25, 0.25]);
    expect(r.dist.basis).toBe("position_cv");
  });
  it("orders its probability maps by key whatever the insertion order", () => {
    const mixed = settingsOf([item(35, 1), item(45, 1), item(89, 0, { "16": 5 }), item(37, 1)]);
    const r = scoreSamples(
      [rb(120), line({ dst_pa_raw: 0 }, DST, "projection:v1-ensemble")],
      mixed,
      "player_sim",
    );
    expect(Object.keys(r.bonus_probability)).toEqual(["rec_td_40", "rush_td_40", "rush_yd_100"]);
    expect(Object.keys(r.bracket_probability)).toEqual([
      "dst_points_allowed:dst_pa_raw",
      "long_td_bonus:rec_td",
      "long_td_bonus:rush_td",
      "yardage_bonus:rush_yd",
    ]);
  });
  it("uses ESPN's fractional bonus probabilities, capped at 1 per sample", () => {
    const r = scoreSamples(
      [line({ rush_yd: 75, rush_yd_100: 0.251, rush_yd_200: 2 }, RB, "espn")],
      s,
      "player_sim",
    );
    expect(r.bonus_probability).toEqual({ rush_yd_100: 0.251, rush_yd_200: 1 });
  });
  it.each([
    ["an unknown basis", [rb(1)], "mean"],
    ["no samples", [], "player_sim"],
    ["not an array", { length: 1 }, "player_sim"],
    ["too many samples", Array.from({ length: MAX_SAMPLES + 1 }, () => rb(1)), "player_sim"],
  ])("refuses %s", (_label, lines, basis) => {
    expect(() => scoreSamples(lines as StatLine[], s, basis as "player_sim")).toThrow(
      expect.objectContaining({ code: "invalid_line" }),
    );
  });
  it("is deterministic (P12): byte-identical results", () => {
    const a = JSON.stringify(scoreSamples([rb(50), rb(150)], s, "player_sim"));
    expect(JSON.stringify(scoreSamples([rb(50), rb(150)], s, "player_sim"))).toBe(a);
  });
});

describe("TQB and position ids", () => {
  it('TQB (15) scores as offence and takes override "15"', () => {
    const s = settingsOf([item(4, 4, { "15": 6 })]);
    expect(score(line({ pass_td: 1 }, TQB, "espn"), s).points).toBe(6);
    expect(
      score({ ...line({ pass_td: 1 }, QB, "espn"), position: asPositionId(15) }, s).points,
    ).toBe(6);
  });
});
