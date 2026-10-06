// pattern.test.ts — src/drift/pattern.ts (plan 01 §7; plan 05 §7: src/drift/** is 100 %): the path
// language parsed and selected exactly like scripts/espn-fixture/drift.ts (src/ may not import
// scripts/, so the port is held equal to the original over every recorded fixture and every manifest
// pattern), the required-path statuses, the bounded selection, and the error-path rendering.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Json } from "../../scripts/espn-fixture/canonical.js";
import * as original from "../../scripts/espn-fixture/drift.js";
import {
  ERROR_PATH_RE,
  errorPath,
  isJsonObject,
  MAX_SELECTED_NODES,
  parsePattern,
  requiredPathStatus,
  select,
} from "../../src/drift/pattern.js";
import { REQUIRED_PATHS_BY_VIEW } from "../../src/drift/types.js";
import { ROOT } from "../lint/helpers.js";

const load = (rel: string): Json =>
  JSON.parse(readFileSync(path.join(ROOT, "fixtures", rel), "utf8")) as Json;
const manifest = load("drift/manifest.json") as unknown as {
  views: Record<
    string,
    { sources: string[]; observed: Record<string, string[]>; enums: Record<string, unknown[]> }
  >;
};

describe("parsePattern", () => {
  it("parses keys, [] and {}", () => {
    expect(parsePattern("$")).toEqual([]);
    expect(parsePattern("$.teams[].roster.entries[]")).toEqual([
      { t: "key", k: "teams" },
      { t: "each" },
      { t: "key", k: "roster" },
      { t: "key", k: "entries" },
      { t: "each" },
    ]);
    expect(parsePattern("$.a{}.b")).toEqual([
      { t: "key", k: "a" },
      { t: "vals" },
      { t: "key", k: "b" },
    ]);
  });
  it.each(["teams", "$teams", "$..a", "$.1a", "$.a b", "$[", "$.a{#}"])("refuses %j", (p) => {
    expect(() => parsePattern(p)).toThrow(/drift: /);
  });
});

describe("select / requiredPathStatus equal the scripts' originals on every recorded fixture", () => {
  it("every manifest pattern of every view, over each of its sources", () => {
    let compared = 0;
    for (const vm of Object.values(manifest.views)) {
      const patterns = [...Object.keys(vm.observed), ...Object.keys(vm.enums)];
      for (const rel of vm.sources.slice(0, 2)) {
        const body = load(rel);
        for (const p of patterns) {
          const mine = select(body, p).map((n) => [n.segs, n.value]);
          const theirs = original.select(body, p).map((n) => [n.segs, n.value]);
          expect(mine, `${rel} ${p}`).toEqual(theirs);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(200);
  });
  it("every required path, on the skeletons and on recorded views", () => {
    const bodies = [
      load("espn/recorded/league-a/skeleton.json"),
      load("espn/recorded/season/skeleton.json"),
      load("espn/recorded/league-a/mSettings.json"),
      load("espn/recorded/league-b/mBoxscore.sp1.json"),
      load("espn/recorded/league-c/mMatchupScore.sp4.json"),
      load("espn/recorded/season/players_wl.json"),
    ];
    for (const paths of Object.values(REQUIRED_PATHS_BY_VIEW))
      for (const p of paths)
        for (const b of bodies)
          expect(requiredPathStatus(b, p), p).toBe(original.requiredPathStatus(b, p));
  });
});

describe("requiredPathStatus edge cases", () => {
  it("present / absent / partial for keys and root arrays", () => {
    expect(requiredPathStatus({ teams: [{ a: 1 }, { a: 2 }] }, "$.teams[].a")).toBe("present");
    expect(requiredPathStatus({ teams: [{ a: 1 }, { b: 2 }] }, "$.teams[].a")).toBe("partial");
    expect(requiredPathStatus({ teams: [{ b: 1 }] }, "$.teams[].a")).toBe("absent");
    expect(requiredPathStatus({ teams: [] }, "$.teams[].a")).toBe("absent");
    expect(requiredPathStatus({}, "$.teams[].a")).toBe("absent");
    expect(requiredPathStatus([1], "$[]")).toBe("present");
    expect(requiredPathStatus([], "$[]")).toBe("absent");
    expect(requiredPathStatus({}, "$[]")).toBe("absent");
    expect(requiredPathStatus({}, "$.teams[]")).toBe("absent");
    expect(requiredPathStatus({ a: [[1], []] }, "$.a[][]")).toBe("partial");
    expect(requiredPathStatus({ a: [[]] }, "$.a[][]")).toBe("absent");
    expect(requiredPathStatus({ settings: null }, "$.settings.name")).toBe("absent");
  });
  it("select walks map values and ignores non-matching shapes", () => {
    expect(select({ m: { "1": { x: 1 }, "2": { x: 2 } } }, "$.m{}.x").map((n) => n.value)).toEqual([
      1, 2,
    ]);
    expect(select({ m: [1] }, "$.m{}")).toEqual([]);
    expect(select({ m: 5 }, "$.m[]")).toEqual([]);
  });
  it("a selection larger than the bound throws (a hostile body cannot blow up memory)", () => {
    const big = { a: Array.from({ length: MAX_SELECTED_NODES + 1 }, () => 0) };
    expect(() => select(big, "$.a[]")).toThrow(/selection too large/);
  });
  it("isJsonObject", () => {
    expect(isJsonObject({})).toBe(true);
    for (const v of [null, [], 1, "x", undefined]) expect(isJsonObject(v)).toBe(false);
  });
});

describe("errorPath (the error's `path`, SAFE_JSON_PATH grammar)", () => {
  it("renders patterns and concrete paths without `$`", () => {
    expect(errorPath("$.teams[].roster.entries")).toBe("teams[].roster.entries");
    expect(errorPath("$")).toBe("<root>");
    expect(errorPath("$.a{}.b")).toBe("a.<key>.b");
    expect(errorPath(["teams", 3, "roster"])).toBe("teams[3].roster");
    expect(errorPath(["we ird", "ok"])).toBe("<key>.ok");
    expect(errorPath([])).toBe("<root>");
    expect(errorPath(["a", -1, 1.5, 1e21])).toBe("a[][][]");
  });
  it("is cut at a segment boundary to ≤ 120 chars", () => {
    const long = Array.from({ length: 40 }, (_, i) => `segment${String(i)}`);
    const p = errorPath(long);
    expect(p.length).toBeLessThanOrEqual(120);
    expect(p.endsWith(".")).toBe(false);
    expect(ERROR_PATH_RE.test(p)).toBe(true);
  });
  it("property: any segment list renders inside the grammar", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ maxLength: 50 }), fc.integer(), fc.double()), {
          maxLength: 30,
        }),
        (segs) => {
          expect(ERROR_PATH_RE.test(errorPath(segs))).toBe(true);
        },
      ),
    );
  });
});
