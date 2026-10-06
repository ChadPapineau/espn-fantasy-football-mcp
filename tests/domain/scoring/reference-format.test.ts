// reference-format.test.ts — the reference league's format over a HAND-WRITTEN mSettings (plan 05 §2
// domain/scoring "the reference-format assertions … are unit and property tests over
// normalizeSettings"; plan 08 §6 step 6 and its numbered test table, carried verbatim; ADV OBJ-01):
// item 53 at 0.5, item 4 at 5, items 20/72 at −2, the K/D-ST families present in S. The
// reference-format golden against recorded ESPN weeks waits for the live league (Phase 1b).
import { describe, expect, it } from "vitest";
import {
  normalizeSettings,
  score,
  type ScoringRule,
  type ScoringSettings,
  SETTINGS_HASH_RE,
  settingsWarnings,
  unmappedIds,
} from "../../../src/domain/scoring/index.js";
import {
  espnLine,
  item,
  line,
  reference,
  REFERENCE_SCORING_SETTINGS,
  settingsOf,
} from "./helpers.js";

const S = reference();
const rule = (s: ScoringSettings, id: string): ScoringRule => {
  const r = s.rules.find((x) => x.platform_id === id);
  if (r === undefined) throw new Error(`no rule ${id}`);
  return r;
};

describe("normalizeSettings on the hand-written reference mSettings", () => {
  it("maps the format items to canonical names with the reference points", () => {
    expect(rule(S, "53")).toMatchObject({ canonical: "rec", points: 0.5, abbr: "REC" });
    expect(rule(S, "4")).toMatchObject({ canonical: "pass_td", points: 5 });
    expect(rule(S, "20")).toMatchObject({ canonical: "pass_int", points: -2 });
    expect(rule(S, "72")).toMatchObject({ canonical: "fum_lost", points: -2 });
    expect(rule(S, "3")).toMatchObject({ canonical: "pass_yd", points: 0.04 });
    expect(rule(S, "89")).toMatchObject({
      canonical: "dst_pa_0",
      points: 0,
      overrides: { "16": 5 },
    });
    expect(unmappedIds(S)).toEqual([]);
    expect(settingsWarnings(S)).toEqual([]);
    expect(S.settings_hash).toMatch(SETTINGS_HASH_RE);
    expect(S.rounding).toEqual({ mode: "exact", verified: true });
    expect(S.matchup).toEqual({
      tie_rule: "NONE",
      playoff_tie_rule: "NONE",
      home_bonus: 0,
      playoff_home_bonus: 0,
    });
  });

  it("builds the K and D/ST families present in S, with their ranges", () => {
    const fam = (name: string) => S.families.filter((f) => f.family === name);
    const fg = fam("fg_distance");
    expect(fg).toHaveLength(1);
    expect(fg[0]?.members.map((m) => [m.platform_id, m.lower, m.upper])).toEqual([
      ["80", 0, 39],
      ["77", 40, 49],
      ["198", 50, 59],
      ["201", 60, null],
    ]);
    expect(fg[0]).toMatchObject({ position_class: "K", exclusive: false, complete_range: true });
    expect(fam("fg_miss")[0]).toMatchObject({ complete_range: false, exclusive: false });
    const pa = fam("dst_points_allowed")[0];
    expect(pa?.members.map((m) => m.platform_id)).toEqual([
      "89",
      "90",
      "91",
      "92",
      "121",
      "122",
      "123",
      "124",
      "125",
    ]);
    expect(pa).toMatchObject({
      position_class: "DST",
      exclusive: true,
      complete_range: true,
      scalar: "dst_pa_raw",
    });
    expect(fam("dst_yards_allowed")[0]).toMatchObject({ complete_range: false });
  });

  it("is order-independent: shuffled items give the same settings and hash (P8)", () => {
    const items = [...REFERENCE_SCORING_SETTINGS.scoringItems].reverse();
    expect(normalizeSettings({ ...REFERENCE_SCORING_SETTINGS, scoringItems: items })).toEqual(S);
  });
});

describe("plan 08 §6 test cases with numbers (reference S, carried verbatim)", () => {
  it("#1 QB: 300 pass yds, 3 pass TD, 1 INT, 20 rush yds, 1 fumble lost → 25.0", () => {
    expect(score(espnLine({ 3: 300, 4: 3, 20: 1, 24: 20, 72: 1 }, 1), S).points).toBe(25);
    const espnDefault = settingsOf([
      item(3, 0.04),
      item(4, 4),
      item(20, -2),
      item(24, 0.1),
      item(72, -2),
    ]);
    // plan 08 §6 #1 says "ESPN default S gives 24.0": an arithmetic slip — under ESPN's default items
    // (4-pt TD, INT −2, fumble lost −2, exactly recorded league-a's) it is 12 + 12 − 2 + 2 − 2 = 22
    expect(score(espnLine({ 3: 300, 4: 3, 20: 1, 24: 20, 72: 1 }, 1), espnDefault).points).toBe(22);
    const intMinus1 = settingsOf([
      item(3, 0.04),
      item(4, 5),
      item(20, -1),
      item(24, 0.1),
      item(72, -2),
    ]);
    expect(score(espnLine({ 3: 300, 4: 3, 20: 1, 24: 20, 72: 1 }, 1), intMinus1).points).toBe(26);
  });
  it("#2 RB half-PPR: 80 rush yds, 1 rush TD, 4 rec, 30 rec yds → 19.0", () => {
    expect(score(espnLine({ 24: 80, 25: 1, 53: 4, 42: 30 }, 2), S).points).toBe(19);
  });
  it("#3 WR: 7 rec, 110 rec yds, 1 rec TD, 1 2-pt rec → 22.5; with item 56 at +3 → 25.5", () => {
    const wr = espnLine({ 53: 7, 42: 110, 43: 1, 44: 1, 56: 1 }, 3);
    expect(score(wr, S).points).toBe(22.5);
    const with56 = normalizeSettings({
      ...REFERENCE_SCORING_SETTINGS,
      scoringItems: [...REFERENCE_SCORING_SETTINGS.scoringItems, item(56, 3)],
    });
    expect(score(wr, with56).points).toBe(25.5);
  });
  it("#4 K: FG 52 and 38 made, 45 missed, 3 PAT → 10.0 (FG buckets are counts)", () => {
    const k = espnLine({ 198: 1, 80: 1, 79: 1, 86: 3, 83: 2, 85: 1 }, 5);
    expect(score(k, S).points).toBe(10);
  });
  it("#5 D/ST: 17 allowed, 310 yds, 3 sacks, 1 INT, 1 FR → 8.0; with 0 allowed (tier 89) → 12.0", () => {
    expect(
      score(espnLine({ 120: 17, 92: 1, 127: 310, 131: 1, 99: 3, 95: 1, 96: 1 }, 16), S).points,
    ).toBe(8);
    expect(
      score(espnLine({ 120: 0, 89: 1, 127: 310, 131: 1, 99: 3, 95: 1, 96: 1 }, 16), S).points,
    ).toBe(12);
  });
  it("#6 any position, empty line → 0.0, complete per statsOfficial", () => {
    for (const pos of [1, 2, 3, 4, 5, 15, 16]) {
      expect(score(espnLine({}, pos), S)).toMatchObject({ points: 0, complete: true });
      expect(score(espnLine({}, pos, true), S)).toMatchObject({ points: 0, complete: false });
    }
  });
  it("#7 a line with statId 999 = 4 → unchanged total; the id is unregistered, never in the line", () => {
    const base = score(espnLine({ 3: 250 }, 1), S).points;
    expect(score(espnLine({ 3: 250, 999: 4 }, 1), S).points).toBe(base);
    const withUnknown = settingsOf([item(3, 0.04), item(999, 4)]);
    expect(unmappedIds(withUnknown)).toEqual(["999"]);
    expect(score(espnLine({ 3: 250, 999: 4 }, 1), withUnknown)).toMatchObject({
      points: 10,
      unmapped: ["999"],
    });
  });
  it('#8 TQB (defaultPositionId 15) uses an override keyed "15"', () => {
    const tqb = settingsOf([item(4, 4, { "15": 6 })]);
    expect(score(espnLine({ 4: 2 }, 15), tqb).points).toBe(12);
    expect(score(espnLine({ 4: 2 }, 1), tqb).points).toBe(8);
  });
  it("the same reference lines score identically from a derived (nflverse-shaped) line", () => {
    expect(
      score(line({ pass_yd: 300, pass_td: 3, pass_int: 1, rush_yd: 20, fum_lost: 1 }, 1), S).points,
    ).toBe(25);
    expect(
      score(line({ dst_pa_raw: 17, dst_ya_raw: 310, dst_sack: 3, dst_int: 1, dst_fr: 1 }, 16), S)
        .points,
    ).toBe(8);
    expect(
      score(line({ dst_pa_raw: 0, dst_ya_raw: 310, dst_sack: 3, dst_int: 1, dst_fr: 1 }, 16), S)
        .points,
    ).toBe(12);
  });
});
