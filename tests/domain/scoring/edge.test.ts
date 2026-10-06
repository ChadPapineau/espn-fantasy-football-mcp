// edge.test.ts — plan 08 §8's edge-case catalogue, one named test per row (hand-built engine inputs
// outside the golden's path guard, never golden evidence — plan 05 §3 fixture law). Rows that need
// recorded data (the 103/104 week, the swap) are in tests/golden/.
import { describe, expect, it } from "vitest";
import {
  normalizeSettings,
  renormalizeSettings,
  score,
  settingsWarnings,
  statLineFromEspn,
  statLineFromPlayerWeek,
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

describe("plan 08 §8 edge cases", () => {
  it("empty stat line, final week → 0, complete, no contributions", () => {
    expect(score(espnLine({}, 2), S)).toMatchObject({
      points: 0,
      complete: true,
      contributions: [],
    });
  });
  it("empty stat line, provisional week → 0, complete: false", () => {
    expect(score(espnLine({}, 2, true), S)).toMatchObject({ points: 0, complete: false });
  });
  it("unknown stat id in the line (999) → listed, never in the line, no throw", () => {
    const r = statLineFromEspn({ raw: { "999": 4, "53": 1 } }, 3);
    expect(r.unregistered).toEqual(["999"]);
    expect(score(r.line, S).points).toBe(0.5);
  });
  it("id in S with no registry row → unmapped, scores 0", () => {
    const s = settingsOf([item(53, 1), item(4321, 7)]);
    expect(unmappedIds(s)).toEqual(["4321"]);
    expect(score(espnLine({ 53: 2 }, 3), s)).toMatchObject({ points: 2, unmapped: ["4321"] });
  });
  it("K with a 0-value distance tier (fg_0_39 = 0) → contributes 0, present", () => {
    const r = score(espnLine({ 80: 2 }, 5), settingsOf([item(80, 0), item(77, 4)]));
    expect(r.points).toBe(0);
    expect(r.contributions).toEqual([
      expect.objectContaining({ canonical: "fg_0_39", value: 2, points: 0 }),
    ]);
  });
  it("K kick distance exactly 40 → bin [40, 49] (bounds inclusive)", () => {
    const k = statLineFromPlayerWeek({ position: "K", fg_att: 2, fg_made_list: "40;39" });
    expect(k.values).toMatchObject({ fg_40_49: 1, fg_0_39: 1 });
    expect(score(k, S).points).toBe(7);
  });
  it("K in a league using 74 (legacy 50+) and also 198/201 → normaliser error naming both", () => {
    expect(() => settingsOf([item(74, 5), item(201, 5)])).toThrow(
      expect.objectContaining({ code: "bracket_bounds", detail: ["74", "201"] }),
    );
  });
  it("K with only PATs → pat_made scores; FG families absent; complete per statsOfficial", () => {
    expect(score(espnLine({ 86: 3, 87: 3 }, 5), S)).toMatchObject({ points: 3, complete: true });
    expect(score(espnLine({ 86: 3, 87: 3 }, 5, true), S).complete).toBe(false);
  });
  it("D/ST with 0 points allowed → tier 89 = 1 → 5 pts, never absent", () => {
    expect(score(espnLine({ 120: 0, 89: 1 }, 16), S).points).toBe(5);
  });
  it("D/ST with 46+ allowed → tier 125; the raw 120 carries 46+", () => {
    expect(score(espnLine({ 120: 52, 125: 1 }, 16), S).points).toBe(-7);
    expect(score(line({ dst_pa_raw: 52 }, 16), S).points).toBe(-7);
  });
  it("D/ST whose game has not started, provisional → family absent, complete: false", () => {
    expect(score(espnLine({}, 16, true), S)).toMatchObject({ points: 0, complete: false });
  });
  it("D/ST line with two exclusive tiers set (bad upstream data) → drift naming the family", () => {
    expect(() => score(espnLine({ 120: 10, 91: 1, 92: 1 }, 16), S)).toThrow(
      expect.objectContaining({
        code: "bracket_exclusivity",
        detail: ["dst_points_allowed:dst_pa_raw"],
      }),
    );
  });
  it("offensive player with a return TD → counts under 101/102 only; D/ST ids untouched", () => {
    const r = score(espnLine({ 102: 1, 105: 1 }, 3), S);
    expect(r.points).toBe(6);
    expect(r.contributions.map((c) => c.platform_id)).toEqual(["102"]);
  });
  it("400-yard passing game in a league scoring 17 and 18 → both pay on a derived line (A-2); ESPN lines as sent", () => {
    const s = settingsOf([item(17, 2), item(18, 3)]);
    expect(score(line({ pass_yd: 412 }, 1), s).points).toBe(5);
    expect(score(espnLine({ 3: 412, 18: 1 }, 1), s).points).toBe(3);
  });
  it("multi-target bonus (100+ and 200+ on rush_yd) → both pay when both thresholds are met", () => {
    expect(score(line({ rush_yd: 205 }, 2), settingsOf([item(37, 1), item(38, 2)])).points).toBe(3);
  });
  it("2-pt conversions under 62 and under 19/26/44 → one canonical value each; both → a warning", () => {
    expect(score(espnLine({ 62: 1 }, 2), settingsOf([item(62, 2)])).points).toBe(2);
    expect(score(espnLine({ 26: 1 }, 2), settingsOf([item(26, 2)])).points).toBe(2);
    expect(settingsWarnings(settingsOf([item(62, 2), item(26, 2)]))).toHaveLength(1);
  });
  it("QB fumble lost on a sack → counts (nflverse sack_fumbles_lost is in the sum; ESPN's 72 carries it)", () => {
    const qb = statLineFromPlayerWeek({ position: "QB", sack_fumbles: 1, sack_fumbles_lost: 1 });
    expect(qb.values).toMatchObject({ fum: 1, fum_lost: 1 });
    expect(score(qb, S).points).toBe(-2);
  });
  it("a line whose fumbles are all sack fumbles lost → 72 = n and 68 = n; S decides which scores", () => {
    const qb = statLineFromPlayerWeek({ position: "QB", sack_fumbles: 2, sack_fumbles_lost: 2 });
    expect(score(qb, settingsOf([item(72, -2)])).points).toBe(-4);
    expect(score(qb, settingsOf([item(68, -1)])).points).toBe(-2);
  });
  it("fractional modifiers over three-digit yardage → no float drift at 2 dp", () => {
    const s = settingsOf([item(3, 0.04), item(24, 0.1), item(42, 0.1), item(114, 0.02)]);
    expect(score(espnLine({ 3: 312, 24: 123, 42: 177, 114: 211 }, 1), s).points).toBe(46.7);
  });
  it('a TQB row (defaultPositionId 15) → class O; override key "15" used when present', () => {
    const s = settingsOf([item(4, 4, { "15": 5 })]);
    const r = score(espnLine({ 4: 2 }, 15), s);
    expect(r.points).toBe(10);
    expect(r.contributions[0]?.override_used).toBe(true);
  });
  it("a league whose S lacks item 53 (standard) → receptions contribute 0; ignored carries rec", () => {
    const r = score(espnLine({ 53: 5, 42: 50 }, 3), settingsOf([item(42, 0.1)]));
    expect(r).toMatchObject({ points: 5, ignored: ["rec"] });
  });
  it("a league with overrides on item 4 (TQB 5-pt) → the override applies by position, the base to everyone else", () => {
    const s = settingsOf([item(4, 4, { "15": 5 })]);
    expect(score(espnLine({ 4: 1 }, 1), s).points).toBe(4);
    expect(score(espnLine({ 4: 1 }, 15), s).points).toBe(5);
  });
  it("a provisional week → lines of players in that game incomplete; other lines complete", () => {
    expect(score(espnLine({ 53: 3 }, 3, true), S).complete).toBe(false);
    expect(score(espnLine({ 53: 3 }, 3, false), S).complete).toBe(true);
  });
  it("bye-week player, final week → no line → 0, complete", () => {
    expect(score(espnLine({}, 4), S)).toMatchObject({ points: 0, complete: true });
  });
  it("player in IR with a line → scored like any line (the slot never matters)", () => {
    expect(score(espnLine({ 24: 40, 25: 1 }, 2), S).points).toBe(10);
  });
  it("settings change mid-season (commissioner edit) → a new settings_hash", () => {
    const edited = normalizeSettings({
      ...REFERENCE_SCORING_SETTINGS,
      scoringItems: REFERENCE_SCORING_SETTINGS.scoringItems.map((i) =>
        i.statId === 53 ? { ...i, points: 1 } : i,
      ),
    });
    expect(edited.settings_hash).not.toBe(S.settings_hash);
  });
  it("two rules mapping to one canonical in one class → normaliser error naming both ids", () => {
    const m = JSON.parse(JSON.stringify(settingsOf([item(53, 1), item(41, 1)]))) as {
      rules: { canonical: string }[];
    };
    (m.rules[0] as { canonical: string }).canonical = "rec";
    expect(() => renormalizeSettings(m)).toThrow(
      expect.objectContaining({ code: "duplicate_canonical", detail: ["41", "53"] }),
    );
  });
  it("scoringItems order differs between two reads → irrelevant (rules keyed; hash order-independent)", () => {
    const rev = normalizeSettings({
      ...REFERENCE_SCORING_SETTINGS,
      scoringItems: [...REFERENCE_SCORING_SETTINGS.scoringItems].reverse(),
    });
    expect(rev.settings_hash).toBe(S.settings_hash);
  });
  it.each([
    ["an unknown statSourceId (2)", { source_id: 2, split_type: 1, season: 2026, week: 3 }],
    ["an impossible pair (0, 2)", { source_id: 0, split_type: 2, season: 2026, week: null }],
    ["a season that is not a year", { source_id: 0, split_type: 1, season: 26, week: 3 }],
    ["a weekly split without a week", { source_id: 1, split_type: 1, season: 2026, week: null }],
    ["a week past 22", { source_id: 0, split_type: 1, season: 2026, week: 23 }],
    ["a season split with a week", { source_id: 1, split_type: 0, season: 2026, week: 4 }],
    ["not an object", null],
  ])(
    "%s on an entry → the entry fails as drift; the player's other entries score",
    (_label, split) => {
      expect(() => statLineFromEspn({ raw: { "53": 1 }, split: split as never }, 3)).toThrow(
        expect.objectContaining({ code: "drift" }),
      );
      expect(
        statLineFromEspn(
          { raw: { "53": 1 }, split: { source_id: 1, split_type: 2, season: 2026, week: null } },
          3,
        ).line.split,
      ).toEqual({
        source_id: 1,
        split_type: 2,
        season: 2026,
        week: null,
      });
    },
  );
});
