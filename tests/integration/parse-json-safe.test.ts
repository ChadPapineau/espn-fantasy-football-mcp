// parse-json-safe.test.ts — the provider's JSON parse after the end-to-end stall fix (plan 02 §5
// A-3; plan 10 A16a): the native fast path may run only when the text cannot spell `__proto__`, so
// every spelling — literal, fully or partly \u-escaped, nested, in arrays — still comes back without
// the key and without touching a prototype; and on arbitrary JSON the result equals the reviver
// path's (property).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseJsonSafe } from "../../src/providers/espn/request.js";

const reviver = (text: string): unknown =>
  JSON.parse(text, (k: string, v: unknown) => (k === "__proto__" ? undefined : v));

describe("parseJsonSafe", () => {
  it.each([
    ['{"__proto__":{"polluted":1},"a":1}', { a: 1 }],
    ['{"\\u005f_proto__":{"polluted":1},"a":1}', { a: 1 }],
    ['{"\\u005f\\u005f\\u0070roto\\u005f\\u005f":{"polluted":1}}', {}],
    ['{"x":[{"__\\u0070roto__":{"polluted":1},"b":2}]}', { x: [{ b: 2 }] }],
    ['[{"__proto__":1},{"y":{"__proto__":{"z":1}}}]', [{}, { y: {} }]],
  ])("drops every spelling of the key: %s", (text, want) => {
    const v = parseJsonSafe(text);
    expect(v).toEqual(want);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (typeof x === "object" && x !== null) {
        expect(Object.hasOwn(x, "__proto__")).toBe(false);
        expect(Object.getPrototypeOf(x)).toBe(Object.prototype);
        Object.values(x).forEach(walk);
      }
    };
    walk(v);
  });

  it("keeps a value that merely mentions the word, and other escapes", () => {
    expect(parseJsonSafe('{"note":"__proto__ is a word","e":"caf\\u00e9"}')).toEqual({
      note: "__proto__ is a word",
      e: "café",
    });
  });

  it("still throws on malformed JSON, on both paths", () => {
    expect(() => parseJsonSafe("{not json")).toThrow(SyntaxError);
    expect(() => parseJsonSafe('{"\\u0041":')).toThrow(SyntaxError);
  });

  it("equals the reviver path on arbitrary JSON (property)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const text = JSON.stringify(v);
        expect(parseJsonSafe(text)).toEqual(reviver(text));
      }),
      { numRuns: 500 },
    );
  });

  it("parses a 1 MB body natively (no per-value callback)", () => {
    const big = JSON.stringify({
      rows: Array.from({ length: 20_000 }, (_, i) => ({
        id: i,
        name: `Player ${String(i)}`,
        stats: { "53": i % 9 },
      })),
    });
    expect(big.length).toBeGreaterThan(1_000_000);
    expect((parseJsonSafe(big) as { rows: unknown[] }).rows.length).toBe(20_000);
  });
});
