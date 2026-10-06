// overrides.test.ts — src/domain/crosswalk/overrides.ts and data/crosswalk/overrides.json (research 04
// §C step 3; plan 02 T5 "schema-validated"): the checked-in file parses and equals the compiled copy;
// every hostile shape is refused with a code and a location, never with file content.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHECKED_IN_OVERRIDES,
  CrosswalkOverridesError,
  MAX_NOTE_CHARS,
  MAX_OVERRIDES,
  MAX_OVERRIDES_BYTES,
  assertNoForbiddenKeys,
  parseCrosswalkOverrides,
  type OverridesErrorCode,
} from "../../../src/domain/crosswalk/overrides.js";

const FILE = new URL("../../../data/crosswalk/overrides.json", import.meta.url);

function doc(overrides: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, overrides, ...extra });
}

function codeOf(text: string): OverridesErrorCode | "ok" {
  try {
    parseCrosswalkOverrides(text);
    return "ok";
  } catch (err) {
    if (err instanceof CrosswalkOverridesError) return err.code;
    throw err;
  }
}

const ROW = { espn_id: 9000001, gsis_id: "00-0099001", note: "fictional test row" };

describe("the checked-in overrides file", () => {
  it("parses, and the compiled copy lists exactly its rows", () => {
    const parsed = parseCrosswalkOverrides(readFileSync(FILE, "utf8"));
    expect(parsed).toEqual(CHECKED_IN_OVERRIDES);
    expect(Object.isFrozen(CHECKED_IN_OVERRIDES)).toBe(true);
  });

  it("carries no fantasy-league identifier (only the documented keys)", () => {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["$comment", "overrides", "version"]);
  });
});

describe("parseCrosswalkOverrides", () => {
  it("accepts rows, a null or absent note, a $comment and one leading BOM", () => {
    const rows = parseCrosswalkOverrides(
      `﻿${doc(
        [
          ROW,
          { espn_id: 9000002, gsis_id: "00-0099002", note: null },
          { espn_id: 9000003, gsis_id: "00-0099003" },
        ],
        { $comment: "why" },
      )}`,
    );
    expect(rows).toEqual([
      ROW,
      { espn_id: 9000002, gsis_id: "00-0099002", note: null },
      { espn_id: 9000003, gsis_id: "00-0099003", note: null },
    ]);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
  });

  it("allows one gsis id under two ESPN ids (an ESPN duplicate record; the run reports it)", () => {
    expect(
      parseCrosswalkOverrides(doc([ROW, { ...ROW, espn_id: 9000009 }])).map((r) => r.gsis_id),
    ).toEqual(["00-0099001", "00-0099001"]);
  });

  it.each([
    ["not JSON", "{ version: 1 }", "json"],
    ["truncated", '{"version":1,"overrides":[', "json"],
    ["two BOMs", `﻿﻿${doc([])}`, "json"],
    ["root array", "[]", "schema"],
    ["root null", "null", "schema"],
    ["root string", '"x"', "schema"],
    ["no version", JSON.stringify({ overrides: [] }), "schema"],
    ["version 2", JSON.stringify({ version: 2, overrides: [] }), "schema"],
    ["version as text", JSON.stringify({ version: "1", overrides: [] }), "schema"],
    ["no overrides", JSON.stringify({ version: 1 }), "schema"],
    ["overrides object", JSON.stringify({ version: 1, overrides: {} }), "schema"],
    ["unknown top key", doc([], { league_id: 0 }), "schema"],
    ["comment not text", doc([], { $comment: ["a"] }), "schema"],
    ["comment with bidi", doc([], { $comment: "a‮b" }), "schema"],
    ["comment too long", doc([], { $comment: "a".repeat(5000) }), "schema"],
    ["row not object", doc([1]), "schema"],
    ["row null", doc([null]), "schema"],
    ["row array", doc([[]]), "schema"],
    ["unknown row key", doc([{ ...ROW, team: "KC" }]), "schema"],
    ["espn id missing", doc([{ gsis_id: ROW.gsis_id }]), "schema"],
    ["espn id text", doc([{ ...ROW, espn_id: "9000001" }]), "schema"],
    ["espn id zero", doc([{ ...ROW, espn_id: 0 }]), "schema"],
    ["espn id D/ST unit", doc([{ ...ROW, espn_id: -16021 }]), "schema"],
    ["espn id fractional", doc([{ ...ROW, espn_id: 1.5 }]), "schema"],
    ["espn id too big", doc([{ ...ROW, espn_id: 100_000_000 }]), "schema"],
    ["gsis missing", doc([{ espn_id: 9000001 }]), "schema"],
    ["gsis padded", doc([{ ...ROW, gsis_id: " 00-0099001" }]), "schema"],
    ["gsis legacy id", doc([{ ...ROW, gsis_id: "ABC123456" }]), "schema"],
    ["gsis number", doc([{ ...ROW, gsis_id: 99001 }]), "schema"],
    ["note number", doc([{ ...ROW, note: 5 }]), "schema"],
    ["note too long", doc([{ ...ROW, note: "a".repeat(MAX_NOTE_CHARS + 1) }]), "schema"],
    ["note control", doc([{ ...ROW, note: "a\u0007b" }]), "schema"],
    ["note zero-width", doc([{ ...ROW, note: "a​b" }]), "schema"],
    ["note newline", doc([{ ...ROW, note: "a\nb" }]), "schema"],
    ["duplicate espn id", doc([ROW, { ...ROW, gsis_id: "00-0099002" }]), "duplicate"],
    ["__proto__ at root", '{"version":1,"overrides":[],"__proto__":{"x":1}}', "forbidden_key"],
    [
      "__proto__ in a row",
      `{"version":1,"overrides":[{"__proto__":{},"espn_id":9000001,"gsis_id":"00-0099001"}]}`,
      "forbidden_key",
    ],
    ["constructor key", doc([{ ...ROW, constructor: 1 }]), "forbidden_key"],
    ["prototype key", doc([], { prototype: {} }), "forbidden_key"],
  ] as const)("refuses %s (%s)", (_label, text, code) => {
    expect(codeOf(text)).toBe(code);
  });

  it("a note at exactly the limit and unicode letters are fine", () => {
    expect(codeOf(doc([{ ...ROW, note: "é".repeat(MAX_NOTE_CHARS) }]))).toBe("ok");
  });

  it("refuses an oversized text before parsing it", () => {
    expect(codeOf(" ".repeat(MAX_OVERRIDES_BYTES + 1))).toBe("too_large");
    // multi-byte characters count as bytes, not code units
    expect(codeOf("é".repeat(MAX_OVERRIDES_BYTES / 2 + 1))).toBe("too_large");
  });

  it("refuses more than MAX_OVERRIDES rows", () => {
    const rows = Array.from({ length: MAX_OVERRIDES + 1 }, (_, i) => ({
      espn_id: 9_000_000 + i,
      gsis_id: "00-0099001",
    }));
    expect(codeOf(doc(rows))).toBe("schema");
    expect(parseCrosswalkOverrides(doc(rows.slice(0, MAX_OVERRIDES)))).toHaveLength(MAX_OVERRIDES);
  });

  it("refuses deep nesting without blowing the stack", () => {
    const deep = `${"[".repeat(5000)}${"]".repeat(5000)}`;
    expect(codeOf(`{"version":1,"overrides":${deep}}`)).toBe("schema");
  });

  it("refuses a non-string argument", () => {
    expect(() => parseCrosswalkOverrides(42 as unknown as string)).toThrow(CrosswalkOverridesError);
  });

  it("never echoes file content in the message", () => {
    const secretish = "espn_s2_lookalike_value";
    for (const text of [
      `{"version":1,"overrides":[{"espn_id":"${secretish}"}]}`,
      `{ ${secretish}`,
      doc([{ ...ROW, note: `${secretish}\u0000` }]),
    ]) {
      try {
        parseCrosswalkOverrides(text);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(CrosswalkOverridesError);
        expect((err as Error).message).not.toContain(secretish);
        expect((err as Error).message).toMatch(/^crosswalk overrides: [a-z_]+/);
      }
    }
  });

  it("names the failing location", () => {
    expect(() =>
      parseCrosswalkOverrides(doc([ROW, { ...ROW, espn_id: 9000002, gsis_id: "x" }])),
    ).toThrow("crosswalk overrides: schema (overrides[1].gsis_id)");
  });
});

describe("assertNoForbiddenKeys", () => {
  it("walks arrays and objects; primitives pass", () => {
    expect(() => {
      assertNoForbiddenKeys({ a: [1, { b: null }], c: "x" });
    }).not.toThrow();
    expect(() => {
      assertNoForbiddenKeys(JSON.parse('{"a":[{"__proto__":1}]}'));
    }).toThrow("forbidden_key (root.a[0])");
    expect(() => {
      assertNoForbiddenKeys(7);
    }).not.toThrow();
  });
});
