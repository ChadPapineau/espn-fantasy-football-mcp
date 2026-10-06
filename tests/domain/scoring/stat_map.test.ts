// stat_map.test.ts — src/domain/scoring/{stat_map,registry}.ts (plan 08 E2/E3, §3.1 the id table and
// canonical registry, §3.3 the ESPN line's id step, research 03 §B.2 the position-id trap).
import { describe, expect, it } from "vitest";
import { ESPN_POSITIONS } from "../../../src/providers/espn/types.js";
import {
  CANONICAL_DEFS,
  CANONICAL_REGISTRY,
  canonicalDef,
  FAMILY_KIND,
  registryIsWellFormed,
  SCALAR_FLOOR,
} from "../../../src/domain/scoring/registry.js";
import {
  E9_EVIDENCE,
  ESPN_POSITION_CLASS,
  ESPN_STAT_MAP,
  espnIdOf,
  espnStat,
  espnStatIdRows,
  MAX_RAW_STATS,
  positionClassOf,
  statLineFromEspn,
} from "../../../src/domain/scoring/stat_map.js";
import { BRACKET_FAMILY_NAMES, CANONICAL_NAME_RE } from "../../../src/domain/scoring/types.js";

describe("the canonical registry (plan 08 E2, §3.1)", () => {
  it("is well formed: unique lowercase names, every row has a class", () => {
    expect(registryIsWellFormed()).toBe(true);
    expect(CANONICAL_REGISTRY.size).toBe(CANONICAL_DEFS.length);
    for (const d of CANONICAL_DEFS)
      expect(CANONICAL_NAME_RE.test(d.canonical), d.canonical).toBe(true);
  });
  it("every family is a plan 08 BracketFamily with a kind; members carry one class", () => {
    expect(Object.keys(FAMILY_KIND).sort()).toEqual([...BRACKET_FAMILY_NAMES].sort());
    for (const d of CANONICAL_DEFS) {
      if (d.family === null) continue;
      expect(d.classes, d.canonical).toHaveLength(1);
      if (d.family.upper !== null) expect(d.family.upper).toBeGreaterThanOrEqual(d.family.lower);
    }
    expect(canonicalDef("dst_ya_lt100")?.family?.lower).toBe(SCALAR_FLOOR);
  });
  it("unknown names are undefined, never Object.prototype members", () => {
    for (const n of ["nope", "constructor", "__proto__", "toString"])
      expect(canonicalDef(n)).toBeUndefined();
  });
  it("classes are fixture-evidenced where they cross plan 08's table (decisions)", () => {
    expect(canonicalDef("kr_yd")?.classes).toEqual(["O", "DST"]);
    expect(canonicalDef("dst_int_td")?.classes).toEqual(["O", "DST", "IDP"]);
    expect(canonicalDef("dst_tk")?.classes).toEqual(["O", "K", "DST", "IDP"]);
    expect(canonicalDef("hc_win")?.classes).toEqual(["O", "K", "DST", "HC", "IDP"]);
    expect(canonicalDef("margin_win_25p")?.classes).toEqual(["HC"]);
    expect(canonicalDef("kr_td")?.zero_with).toBe("ret_td_total");
  });
});

describe("the ESPN id table (plan 08 E3, research 03 §B.2)", () => {
  it("is one-to-one, and every canonical has a registry row", () => {
    const canonicals = [...ESPN_STAT_MAP.values()].map((d) => d.canonical);
    expect(new Set(canonicals).size).toBe(canonicals.length);
    for (const d of ESPN_STAT_MAP.values()) {
      expect(canonicalDef(d.canonical), d.id).toBeDefined();
      expect(espnIdOf(d.canonical)).toBe(d.id);
      expect(d.disputed).toBe(false);
    }
    expect(CANONICAL_DEFS.every((d) => espnIdOf(d.canonical) !== undefined)).toBe(true);
  });
  it("pins the ids the format depends on", () => {
    const pin: Record<string, string> = {
      "53": "rec",
      "41": "rec_stat",
      "4": "pass_td",
      "20": "pass_int",
      "72": "fum_lost",
      "68": "fum",
      "74": "fg_50p",
      "198": "fg_50_59",
      "201": "fg_60p",
      "215": "fg_yd_miss",
      "120": "dst_pa_raw",
      "89": "dst_pa_0",
      "125": "dst_pa_46p",
      "127": "dst_ya_raw",
      "136": "dst_ya_550p",
      "103": "dst_int_td",
      "104": "dst_fr_td",
      "114": "kr_yd",
      "2": "pass_inc",
      "8": "per_n_pass_yd_25",
      "228": "per_n_fg_yd_miss_100",
    };
    for (const [id, c] of Object.entries(pin)) expect(espnStat(id)?.canonical, id).toBe(c);
    expect(espnStat("999")).toBeUndefined();
    expect(espnStat("__proto__")).toBeUndefined();
    expect(espnIdOf("nope")).toBeUndefined();
    expect(E9_EVIDENCE).toMatchObject({ int_return_td: "103", fumble_return_td: "104" });
  });
  it("the stat-id resource rows carry meaning and family, in id order", () => {
    const rows = espnStatIdRows();
    expect(rows).toHaveLength(ESPN_STAT_MAP.size);
    expect(rows.map((r) => Number(r.stat_id))).toEqual(
      [...rows.map((r) => Number(r.stat_id))].sort((a, b) => a - b),
    );
    expect(rows.find((r) => r.stat_id === "91")).toMatchObject({
      family: "dst_points_allowed",
      meaning: "7–13 points allowed",
    });
    expect(rows.find((r) => r.stat_id === "53")).toMatchObject({ family: null, canonical: "rec" });
    const bare = espnStatIdRows(() => undefined);
    expect(bare.find((r) => r.stat_id === "53")).toMatchObject({ meaning: "rec", family: null });
  });
});

describe("position ids, never slot ids (research 03 §B.2)", () => {
  it("mirrors the provider's ESPN_POSITIONS classes exactly", () => {
    const provider = Object.fromEntries(Object.values(ESPN_POSITIONS).map((p) => [p.id, p.class]));
    expect({ ...ESPN_POSITION_CLASS }).toEqual(provider);
  });
  it("classes TQB (15) as offence and D/ST (16) as DST", () => {
    expect(positionClassOf(15)).toBe("O");
    expect(positionClassOf(16)).toBe("DST");
    expect(positionClassOf(14)).toBe("HC");
    expect(positionClassOf(11)).toBe("IDP");
  });
  it.each([0, 6, 8, 17, 23, 99])("an id outside the table (%s) is drift", (id) => {
    expect(() => positionClassOf(id)).toThrow(/unknown ESPN position id/);
  });
  it.each([-1, 100, 1.5, Number.NaN])("a non-id (%s) is a RangeError", (id) => {
    expect(() => positionClassOf(id)).toThrow(RangeError);
  });
});

describe("statLineFromEspn (plan 08 §3.3)", () => {
  it("maps ids to canonical names, freezes, sorts present, carries split and provisional", () => {
    const split = { source_id: 0, split_type: 1, season: 2026, week: 3 } as const;
    const { line, unregistered } = statLineFromEspn(
      { raw: { "53": 4, "42": 30, "999": 1 }, provisional: true, split },
      2,
    );
    expect(line.values).toEqual({ rec: 4, rec_yd: 30 });
    expect(line.present).toEqual(["rec", "rec_yd"]);
    expect(line).toMatchObject({
      position: 2,
      position_class: "O",
      provisional: true,
      source: "espn",
      split,
    });
    expect(unregistered).toEqual(["999"]);
    expect(
      Object.isFrozen(line) && Object.isFrozen(line.values) && Object.isFrozen(line.split),
    ).toBe(true);
    expect(statLineFromEspn({ raw: {} }, 1).line).not.toHaveProperty("split");
    expect(statLineFromEspn({ raw: {} }, 1).line.provisional).toBe(false);
  });
  it("lists non-id keys and unknown ids in unregistered (numeric ids first), maps −0 to 0", () => {
    const { line, unregistered } = statLineFromEspn(
      { raw: { b: 1, a: 1, "01": 1, "300": 1, "5000": 2, "3": -0 } },
      1,
    );
    expect(unregistered).toEqual(["300", "5000", "01", "a", "b"]);
    expect(Object.is(line.values.pass_yd, 0)).toBe(true);
  });
  it.each([
    ["a string", { "3": "300" }],
    ["null", { "3": null }],
    ["NaN", { "3": Number.NaN }],
    ["Infinity", { "3": Number.POSITIVE_INFINITY }],
    ["absurd", { "3": 1e10 }],
    ["a nested object", { "3": { v: 1 } }],
  ])("a non-number value (%s) fails the entry as drift", (_label, raw) => {
    expect(() => statLineFromEspn({ raw: raw }, 1)).toThrow(/drift|finite/);
  });
  it.each([null, [], "x", 5])("a non-object stats map (%j) is drift", (raw) => {
    expect(() => statLineFromEspn({ raw: raw as unknown as Record<string, unknown> }, 1)).toThrow(
      /must be an object/,
    );
  });
  it("a missing input is drift; too many stats is drift", () => {
    expect(() => statLineFromEspn(null as unknown as { raw: Record<string, unknown> }, 1)).toThrow(
      /must be an object/,
    );
    const huge = Object.fromEntries(
      Array.from({ length: MAX_RAW_STATS + 1 }, (_, i) => [String(i), 1]),
    );
    expect(() => statLineFromEspn({ raw: huge }, 1)).toThrow(/too many/);
  });
  it("a JSON-parsed __proto__ key stays data, never a prototype", () => {
    const raw = JSON.parse('{"__proto__": 5, "53": 2}') as Record<string, unknown>;
    const { line, unregistered } = statLineFromEspn({ raw }, 3);
    expect(line.values).toEqual({ rec: 2 });
    expect(unregistered).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(line.values)).toBe(Object.prototype);
  });
});
