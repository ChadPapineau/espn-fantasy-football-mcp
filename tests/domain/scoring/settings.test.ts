// settings.test.ts — src/domain/scoring/settings.ts (plan 08 §2 ScoringSettings and settings_hash,
// §3.1 unmapped / duplicate / union rules, §3.4 overrides by POSITION id, §4.1, E7, P8). Hostile
// input by default: wrong types, huge arrays, prototype keys, leading zeros.
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  computeSettingsHash,
  createUnmappedLog,
  MAX_OVERRIDES,
  MAX_RULES,
  normalizeSettings,
  renormalizeSettings,
  settingsWarnings,
  unmappedIds,
} from "../../../src/domain/scoring/settings.js";
import { SETTINGS_HASH_RE, type ScoringSettings } from "../../../src/domain/scoring/types.js";
import { item, settingsOf } from "./helpers.js";

const base = (): ScoringSettings =>
  settingsOf([item(53, 0.5), item(4, 5, { "15": 6 }), item(89, 0, { "16": 5 })]);
const mutable = (s: ScoringSettings): Record<string, unknown> =>
  JSON.parse(JSON.stringify(s)) as Record<string, unknown>;

describe("normalizeSettings: ESPN scoringItems → ScoringSettings", () => {
  it("keeps ESPN ids opaque, overrides by position id, display metadata, matchup items", () => {
    const s = settingsOf(
      [item(4, 5, { "15": 6, "1": 5 }), { statId: 53, points: 0.5, isReverseItem: true }],
      {
        matchupTieRule: "SLOT_POINTS",
        playoffMatchupTieRule: "NONE",
        homeTeamBonus: 1.5,
        playoffHomeTeamBonus: -0,
        leagueRanking: 7,
      },
    );
    expect(s.rules).toEqual([
      {
        canonical: "pass_td",
        platform_id: "4",
        abbr: "PTD",
        points: 5,
        overrides: { "1": 5, "15": 6 },
        is_reverse: false,
        applies_to: ["O"],
        disputed: false,
      },
      {
        canonical: "rec",
        platform_id: "53",
        abbr: "REC",
        points: 0.5,
        overrides: {},
        is_reverse: true,
        applies_to: ["O"],
        disputed: false,
      },
    ]);
    expect(s.matchup).toEqual({
      tie_rule: "SLOT_POINTS",
      playoff_tie_rule: "NONE",
      home_bonus: 1.5,
      playoff_home_bonus: 0,
    });
    expect(Object.is(s.matchup.playoff_home_bonus, 0)).toBe(true);
    expect(Object.isFrozen(s) && Object.isFrozen(s.rules[0]?.overrides)).toBe(true);
  });
  it("an id with no registry row stays unmapped (canonical null, scores nothing)", () => {
    const s = settingsOf([item(999, 3), item(53, 1), item(1000, 2)]);
    expect(s.rules.find((r) => r.platform_id === "999")).toMatchObject({
      canonical: null,
      abbr: "#999",
      applies_to: [],
      disputed: false,
    });
    expect(unmappedIds(s)).toEqual(["999", "1000"]);
  });
  it("maps −0 points and overrides to 0, defaults unknown matchup enums to UNKNOWN", () => {
    const s = settingsOf([item(53, -0, { "3": -0 })], {
      matchupTieRule: "slot points",
      playoffMatchupTieRule: 7,
    });
    expect(Object.is(s.rules[0]?.points, 0)).toBe(true);
    expect(Object.is(s.rules[0]?.overrides["3"], 0)).toBe(true);
    expect(s.matchup).toMatchObject({ tie_rule: "UNKNOWN", playoff_tie_rule: "UNKNOWN" });
    expect(settingsOf([]).matchup).toEqual({
      tie_rule: "NONE",
      playoff_tie_rule: "NONE",
      home_bonus: 0,
      playoff_home_bonus: 0,
    });
  });
  it("takes a rounding override", () => {
    expect(
      normalizeSettings(
        { scoringItems: [] },
        { rounding: { mode: "per_total_2dp", verified: false } },
      ).rounding,
    ).toEqual({ mode: "per_total_2dp", verified: false });
  });
  it.each([
    ["not an object", null],
    ["an array", []],
    ["no scoringItems", {}],
    ["scoringItems not an array", { scoringItems: {} }],
    [
      "too many items",
      { scoringItems: Array.from({ length: MAX_RULES + 1 }, (_, i) => item(i, 1)) },
    ],
    ["an item not an object", { scoringItems: [5] }],
    ["statId a string", { scoringItems: [{ statId: "53", points: 1 }] }],
    ["statId fractional", { scoringItems: [{ statId: 5.5, points: 1 }] }],
    ["statId negative", { scoringItems: [{ statId: -1, points: 1 }] }],
    ["statId too big", { scoringItems: [{ statId: 10000, points: 1 }] }],
    ["points NaN", { scoringItems: [{ statId: 53, points: Number.NaN }] }],
    ["points absurd", { scoringItems: [{ statId: 53, points: 2e6 }] }],
    ["points missing", { scoringItems: [{ statId: 53 }] }],
    [
      "isReverseItem not boolean",
      { scoringItems: [{ statId: 53, points: 1, isReverseItem: "yes" }] },
    ],
    ["overrides an array", { scoringItems: [{ statId: 53, points: 1, pointsOverrides: [1] }] }],
    [
      "override key not a position",
      { scoringItems: [{ statId: 53, points: 1, pointsOverrides: { x: 1 } }] },
    ],
    [
      "override key with a leading zero",
      { scoringItems: [{ statId: 53, points: 1, pointsOverrides: { "01": 1 } }] },
    ],
    [
      "override key ≥ 100",
      { scoringItems: [{ statId: 53, points: 1, pointsOverrides: { "100": 1 } }] },
    ],
    [
      "override __proto__",
      {
        scoringItems: [
          { statId: 53, points: 1, pointsOverrides: JSON.parse('{"__proto__": 1}') as unknown },
        ],
      },
    ],
    [
      "override value Infinity",
      {
        scoringItems: [
          { statId: 53, points: 1, pointsOverrides: { "3": Number.POSITIVE_INFINITY } },
        ],
      },
    ],
    [
      "too many overrides",
      {
        scoringItems: [
          {
            statId: 53,
            points: 1,
            pointsOverrides: Object.fromEntries(
              Array.from({ length: MAX_OVERRIDES + 1 }, (_, i) => [String(i), 1]),
            ),
          },
        ],
      },
    ],
    ["homeTeamBonus NaN", { scoringItems: [], homeTeamBonus: Number.NaN }],
    ["playoffHomeTeamBonus a string", { scoringItems: [], playoffHomeTeamBonus: "1" }],
    ["a duplicate statId", { scoringItems: [item(53, 1), item(53, 0.5)] }],
  ])("refuses %s (invalid_settings)", (_label, input) => {
    expect(() => normalizeSettings(input)).toThrow(
      expect.objectContaining({ code: "invalid_settings" }),
    );
  });
  it("refuses a union beside its part: 105 with 101 or 102 (bracket_bounds naming both)", () => {
    expect(() => settingsOf([item(105, 6), item(102, 6)])).toThrow(
      expect.objectContaining({ code: "bracket_bounds", detail: ["105", "102"] }),
    );
    expect(() => settingsOf([item(101, 6), item(105, 6)])).toThrow(
      expect.objectContaining({ detail: ["105", "101"] }),
    );
    expect(() => settingsOf([item(105, 6)])).not.toThrow();
  });
  it("refuses the legacy 50+ FG item beside the 50–59 / 60+ split", () => {
    expect(() => settingsOf([item(74, 5), item(198, 5)])).toThrow(
      expect.objectContaining({ code: "bracket_bounds" }),
    );
  });
});

describe("settingsWarnings (plan 08 §3.1)", () => {
  it("warns on 62 beside 19/26/44 and on 94 beside 103/104; silent otherwise", () => {
    expect(settingsWarnings(settingsOf([item(62, 2), item(19, 2), item(44, 2)]))).toEqual([
      "stat 62 is scored beside 19/44: ESPN scores both",
    ]);
    expect(settingsWarnings(settingsOf([item(94, 6), item(104, 6)]))).toEqual([
      "stat 94 is scored beside 104: ESPN scores both",
    ]);
    expect(settingsWarnings(settingsOf([item(62, 2)]))).toEqual([]);
    expect(settingsWarnings(settingsOf([item(19, 2)]))).toEqual([]);
  });
});

describe("settings_hash (plan 08 §2; P8)", () => {
  it("is 64 lowercase hex, order-independent over items and override keys", () => {
    const a = settingsOf([item(53, 0.5), item(4, 5, { "15": 6, "1": 4 })]);
    const b = settingsOf([item(4, 5, { "1": 4, "15": 6 }), item(53, 0.5)]);
    expect(a.settings_hash).toMatch(SETTINGS_HASH_RE);
    expect(a.settings_hash).toBe(b.settings_hash);
    expect(a).toEqual(b);
  });
  it("changes with any points, any override, or the rounding mode — never with `verified` or matchup", () => {
    const h = base().settings_hash;
    expect(
      settingsOf([item(53, 0.6), item(4, 5, { "15": 6 }), item(89, 0, { "16": 5 })]).settings_hash,
    ).not.toBe(h);
    expect(
      settingsOf([item(53, 0.5), item(4, 5, { "15": 7 }), item(89, 0, { "16": 5 })]).settings_hash,
    ).not.toBe(h);
    const items = [item(53, 0.5), item(4, 5, { "15": 6 }), item(89, 0, { "16": 5 })];
    expect(
      normalizeSettings({ scoringItems: items }, { rounding: { mode: "exact", verified: false } })
        .settings_hash,
    ).toBe(h);
    expect(
      normalizeSettings(
        { scoringItems: items },
        { rounding: { mode: "per_total_2dp", verified: true } },
      ).settings_hash,
    ).not.toBe(h);
    expect(
      normalizeSettings({ scoringItems: items, matchupTieRule: "SLOT_POINTS" }).settings_hash,
    ).toBe(h);
  });
  it("computeSettingsHash and canonicalJson are deterministic over key order", () => {
    expect(canonicalJson({ b: [1, { d: null, c: "x" }], a: true })).toBe(
      '{"a":true,"b":[1,{"c":"x","d":null}]}',
    );
    const s = base();
    expect(computeSettingsHash(s)).toBe(s.settings_hash);
  });
});

describe("renormalizeSettings (the cached-JSON path; P8 idempotence)", () => {
  it("is idempotent and rebuilds families from the rules (a supplied families list is never trusted)", () => {
    const s = base();
    expect(renormalizeSettings(s)).toEqual(s);
    expect(renormalizeSettings(renormalizeSettings(s))).toEqual(s);
    const forged = { ...mutable(s), families: [{ family: "margin", members: [] }] };
    expect(renormalizeSettings(forged)).toEqual(s);
  });
  it("accepts a custom canonical (no registry row: no family, scored linearly by the engine)", () => {
    const m = mutable(base());
    (m.rules as Record<string, unknown>[]).push({
      canonical: "custom_stat",
      platform_id: "998",
      abbr: "X",
      points: 1,
      overrides: {},
      is_reverse: false,
      applies_to: ["O"],
      disputed: false,
    });
    expect(renormalizeSettings(m).rules.map((r) => r.platform_id)).toEqual([
      "4",
      "53",
      "89",
      "998",
    ]);
  });
  const withRule = (patch: Record<string, unknown>) => {
    const m = mutable(base());
    (m.rules as Record<string, unknown>[])[0] = {
      ...(m.rules as Record<string, unknown>[])[0],
      ...patch,
    };
    return m;
  };
  it.each([
    ["not an object", null],
    ["platform not espn", { ...mutable(base()), platform: "yahoo" }],
    ["rules not an array", { ...mutable(base()), rules: {} }],
    [
      "too many rules",
      { ...mutable(base()), rules: Array.from({ length: MAX_RULES + 1 }, () => ({})) },
    ],
    ["a rule not an object", { ...mutable(base()), rules: [7] }],
    ["platform_id not a statId", withRule({ platform_id: "x4" })],
    ["platform_id a number", withRule({ platform_id: 4 })],
    ["canonical malformed", withRule({ canonical: "Pass TD" })],
    ["canonical a number", withRule({ canonical: 4 })],
    ["abbr too long", withRule({ abbr: "x".repeat(17) })],
    ["abbr missing", withRule({ abbr: undefined })],
    ["points NaN", withRule({ points: Number.NaN })],
    ["is_reverse not boolean", withRule({ is_reverse: 1 })],
    ["disputed not boolean", withRule({ disputed: "no" })],
    ["applies_to not an array", withRule({ applies_to: "O" })],
    ["applies_to an unknown class", withRule({ applies_to: ["QB"] })],
    ["overrides malformed", withRule({ overrides: { "1x": 2 } })],
    ["matchup missing", { ...mutable(base()), matchup: null }],
    ["rounding mode unknown", { ...mutable(base()), rounding: { mode: "banker", verified: true } }],
    [
      "rounding verified not boolean",
      { ...mutable(base()), rounding: { mode: "exact", verified: "yes" } },
    ],
    ["rounding missing", { ...mutable(base()), rounding: undefined }],
    ["a duplicate platform_id", withRule({ platform_id: "53", canonical: "pass_td" })],
  ])("refuses %s (invalid_settings)", (_label, input) => {
    expect(() => renormalizeSettings(input)).toThrow(
      expect.objectContaining({ code: "invalid_settings" }),
    );
  });
  it("refuses two rules on one canonical in one class (duplicate_canonical naming both ids)", () => {
    const m = withRule({ canonical: "rec" });
    expect(() => renormalizeSettings(m)).toThrow(
      expect.objectContaining({ code: "duplicate_canonical", detail: ["4", "53"] }),
    );
    const otherClass = withRule({ canonical: "rec", applies_to: ["K"] });
    expect(() => renormalizeSettings(otherClass)).not.toThrow();
  });
});

describe("unmapped ids, logged once per settings_hash (plan 08 §3.1)", () => {
  it("reports the ids the first time a hash is seen, never again; null without unmapped ids", () => {
    const log = createUnmappedLog();
    const s = settingsOf([item(999, 1), item(53, 1)]);
    expect(log.firstReport(s)).toEqual(["999"]);
    expect(log.firstReport(s)).toBeNull();
    expect(log.firstReport(base())).toBeNull();
  });
  it("forgets the oldest hash past its capacity", () => {
    const log = createUnmappedLog(1);
    const a = settingsOf([item(999, 1)]);
    const b = settingsOf([item(998, 1)]);
    expect(log.firstReport(a)).toEqual(["999"]);
    expect(log.firstReport(b)).toEqual(["998"]);
    expect(log.firstReport(a)).toEqual(["999"]);
  });
  it.each([0, -1, 1.5, Number.NaN])("refuses capacity %s", (c) => {
    expect(() => createUnmappedLog(c)).toThrow(RangeError);
  });
});
