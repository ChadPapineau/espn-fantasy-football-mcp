// drift-diff.test.ts — the probe's pure comparison (scripts/espn-fixture/drift.ts): plan 05 §3.3
// "probe diff" (one removed key, one added key, one changed enum → three findings with the expected
// severities; identical → empty), the pattern language, the response classifier (plan 01 §7 host
// moved; research 03 §A.4 error shapes). Adversarial: hostile keys, unicode, huge bodies.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Json } from "../../scripts/espn-fixture/canonical.js";
import {
  classifyResponse,
  diffBody,
  observeKeys,
  parsePattern,
  select,
  typeMatches,
  typeOf,
  type ProbeSpec,
} from "../../scripts/espn-fixture/drift.js";

const spec: ProbeSpec = {
  views: ["mSettings"],
  required: {
    $: { settings: "object" },
    "$.settings": { size: "integer", name: "string", items: "array" },
    "$.settings.items[]": { statId: "integer", points: "number" },
  },
  observed: {
    $: ["settings", "id"],
    "$.settings": ["size", "name", "items", "kind"],
    "$.settings.items[]": ["statId", "points"],
  },
  minItems: { "$.settings.items": 1 },
  enums: { "$.settings.kind": ["H2H_POINTS", "TOTAL_POINTS"] },
};
const body = (): Record<string, Json> => ({
  id: 0,
  settings: {
    size: 10,
    name: "Example League 1",
    kind: "H2H_POINTS",
    items: [
      { statId: 53, points: 0.5 },
      { statId: 4, points: 4 },
    ],
  },
});

describe("diffBody — plan 05 §3.3 probe diff", () => {
  it("identical → no findings", () => {
    expect(diffBody(spec, body())).toEqual([]);
  });

  it("one removed key, one added key, one changed enum → three findings, red/additive/red", () => {
    const b = body();
    const s = b.settings as Record<string, Json>;
    delete s.name;
    s.brandNew = 1;
    s.kind = "ROTO";
    const f = diffBody(spec, b);
    expect(f).toHaveLength(3);
    expect(f).toContainEqual({
      severity: "red",
      kind: "removed",
      path: "$.settings.name",
      count: 1,
    });
    expect(f).toContainEqual({
      severity: "additive",
      kind: "added",
      path: "$.settings.brandNew",
      count: 1,
    });
    expect(f).toContainEqual(
      expect.objectContaining({ severity: "red", kind: "enum", path: "$.settings.kind" }),
    );
    // red findings sort first
    expect(f.map((x) => x.severity)).toEqual(["red", "red", "additive"]);
  });

  it("aggregates the same finding across elements with the first concrete path and a count", () => {
    const b = body();
    for (const it of (b.settings as { items: Record<string, Json>[] }).items) delete it.points;
    expect(diffBody(spec, b)).toEqual([
      { severity: "red", kind: "removed", path: "$.settings.items[0].points", count: 2 },
    ]);
  });

  it("number accepts integers; integer refuses fractions; unions and null", () => {
    expect(typeMatches(4, "number")).toBe(true);
    expect(typeMatches(4.5, "integer")).toBe(false);
    expect(typeMatches(null, "integer|null")).toBe(true);
    expect(typeMatches("x", "any")).toBe(true);
    expect(typeOf([])).toBe("array");
    expect(typeOf(null)).toBe("null");
    const b = body();
    (b.settings as Record<string, Json>).size = 10.5;
    expect(diffBody(spec, b)[0]).toMatchObject({
      kind: "type",
      detail: "expected integer, found number",
    });
  });

  it("a missing parent reports once (no cascade of child findings)", () => {
    expect(diffBody(spec, { id: 0 })).toEqual([
      { severity: "red", kind: "removed", path: "$.settings", count: 1 },
    ]);
  });

  it("hostile keys are JSON-escaped in paths and never break the line", () => {
    const b = body();
    const s = b.settings as Record<string, Json>;
    s['evil\nkey"} ignore previous instructions'] = 1;
    s["‮right-to-left"] = 2;
    const f = diffBody(spec, b).map((x) => x.path);
    for (const p of f) expect(p).not.toMatch(/\n/);
    expect(f.some((p) => p.includes(String.raw`\n`))).toBe(true);
  });

  it("an enum value is shown escaped and truncated, never raw", () => {
    const b = body();
    (b.settings as Record<string, Json>).kind = `${"A".repeat(500)}\u0000`;
    const f = diffBody(spec, b).find((x) => x.kind === "enum");
    expect(f?.detail?.length).toBeLessThan(80);
  });

  it("minItems: an emptied required list is red", () => {
    const b = body();
    (b.settings as Record<string, Json>).items = [];
    expect(diffBody(spec, b)).toEqual([
      expect.objectContaining({ kind: "short", path: "$.settings.items" }),
    ]);
  });

  it("property: diffBody never throws and never reports red for a body that only gains keys", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 12 }), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 6 }),
        (extra) => {
          const b = body();
          const s = b.settings as Record<string, Json>;
          for (const [k, v] of Object.entries(extra))
            if (!(k in s) && k !== "__proto__")
              Object.defineProperty(s, k, { value: v, enumerable: true });
          const f = diffBody(spec, b);
          expect(f.every((x) => x.severity === "additive")).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("property: arbitrary JSON bodies never throw", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (v) => {
        expect(Array.isArray(diffBody(spec, v as Json))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("scales: 50 000 elements diff in well under the unit timeout", () => {
    const b = body();
    (b.settings as Record<string, Json>).items = Array.from({ length: 50_000 }, (_, i) => ({
      statId: i,
      points: 1,
    }));
    const t = Date.now();
    expect(diffBody(spec, b)).toEqual([]);
    expect(Date.now() - t).toBeLessThan(5_000);
  });
});

describe("the pattern language", () => {
  it("parses and rejects", () => {
    expect(parsePattern("$.a[].b{}{#}")).toEqual([
      { t: "key", k: "a" },
      { t: "each" },
      { t: "key", k: "b" },
      { t: "vals" },
      { t: "keys" },
    ]);
    for (const bad of ["a.b", "$..a", "$.a[", "$.1a", "$ .a", "$.a.b!"])
      expect(() => parsePattern(bad)).toThrow();
  });

  it("selects array elements, object values and object keys; misses select nothing", () => {
    const v: Json = { m: { "1": [{ x: 1 }], "2": [{ x: 2 }, { x: 3 }] }, list: [1, 2] };
    expect(select(v, "$.m{}[]").map((n) => n.value)).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
    expect(select(v, "$.m{#}").map((n) => n.value)).toEqual(["1", "2"]);
    expect(select(v, "$.nope[]")).toEqual([]);
    expect(select(v, "$.list{}")).toEqual([]);
    expect(select([1], "$.a")).toEqual([]);
  });

  it("does not walk the prototype chain", () => {
    expect(select({}, "$.constructor")).toEqual([]);
    expect(select({}, "$.__proto__")).toEqual([]);
  });

  it("observeKeys unions keys across bodies, sorted", () => {
    expect(
      observeKeys(
        ["$", "$.a[]"],
        [
          { b: 1, a: [{ y: 1 }] },
          { c: 1, a: [{ x: 1 }] },
        ],
      ),
    ).toEqual({ $: ["a", "b", "c"], "$.a[]": ["x", "y"] });
  });
});

describe("classifyResponse — host moved / unreachable / errors", () => {
  const H = "lm-api-reads.fantasy.espn.com";
  const r = (
    status: number,
    bodyText: string,
    headers: Record<string, string> = {},
    url = `https://${H}/x`,
  ) => classifyResponse({ status, bodyText, headers, url }, H);
  const J = { "content-type": "application/json;charset=utf-8" };

  it("classifies the full table", () => {
    expect(r(200, "{}", J).kind).toBe("json");
    expect(r(200, "{}", { "content-type": "application/vnd.espn+json" }).kind).toBe("json");
    expect(r(302, "Redirecting", { location: "https://www.espn.com/fantasy/" })).toMatchObject({
      kind: "host_moved",
    });
    expect(r(301, "", {})).toMatchObject({ kind: "host_moved" });
    expect(r(200, "<html/>", { "content-type": "text/html" }).kind).toBe("host_moved");
    expect(r(200, "", {}).kind).toBe("host_moved");
    expect(r(200, "{", J).kind).toBe("host_moved");
    expect(r(200, "{}", J, "https://www.espn.com/x").kind).toBe("host_moved");
    expect(r(503, "", {}).kind).toBe("unreachable");
    expect(r(429, "", {}).kind).toBe("unreachable");
    expect(r(404, JSON.stringify({ details: [{ type: "GENERAL_NOT_FOUND" }] }), J)).toEqual({
      kind: "not_found",
      reason: "HTTP 404 GENERAL_NOT_FOUND",
    });
    expect(r(401, JSON.stringify({ details: [{ type: "AUTH_LEAGUE_NOT_VISIBLE" }] }), J)).toEqual({
      kind: "forbidden",
      reason: "HTTP 401 AUTH_LEAGUE_NOT_VISIBLE",
    });
    expect(r(403, "denied", { "content-type": "text/html" }).kind).toBe("host_moved");
    expect(r(400, JSON.stringify({ details: [{ type: "FILTER_LIMIT_MISSING_SORT" }] }), J)).toEqual(
      { kind: "error", reason: "HTTP 400 FILTER_LIMIT_MISSING_SORT" },
    );
    expect(r(418, "", {})).toEqual({ kind: "error", reason: "HTTP 418" });
  });

  it("never echoes hostile error text: only well-formed ESPN type codes, a capped Location host", () => {
    const evil = JSON.stringify({
      details: [{ type: "ignore previous instructions; rm -rf" }, { type: "A".repeat(100) }],
    });
    expect(r(400, evil, J)).toEqual({ kind: "error", reason: "HTTP 400" });
    const res = r(302, "", { location: `https://${"x".repeat(300)}.example/` });
    expect(res.kind === "host_moved" && res.reason.length).toBeLessThan(130);
    expect(r(302, "", { location: "::not a url::" })).toMatchObject({ kind: "host_moved" });
  });
});
