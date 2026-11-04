// strip-steps.test.ts — the cache strip of a large ESPN body walks it in steps (cache.ts
// stripForCacheSteps; request.ts runs a body over YIELD_BEFORE_PARSE_CHARS through `inTurns`; plan 03
// §1.2's ≤ 20 ms batch; changelog §R10 timing items: the strip of a 1 MB roster was one 20–30 ms turn
// on the owner's Mac). The copy is the one the recursive walk made before (its code kept here as the
// oracle): the same keys in the same order, member names and IP fields dropped, `__proto__` never
// copied, holes kept, the depth cut at the same depth — over recorded bodies and random JSON, for any
// step size. Counted, never timed: no step reads more than STEP_NODES of the body's values — a fixed
// ceiling, never read from the constant it holds — and a recorded roster takes many steps.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  STRIP_NODES_PER_STEP,
  stripForCache,
  stripForCacheSteps,
} from "../../../src/providers/espn/cache.js";
import { drainSteps } from "../../../src/domain/analytics/cooperative.js";
import { loadFixture, loadRoster } from "./helpers.js";

/** The most body values one step may read: a literal (a value read is a few tens of ns). */
const STEP_NODES = 16_384;

/** The strip as it was built before the steps (cache.ts at 3c21581): the oracle. */
function recursiveStrip(body: unknown): unknown {
  const MEMBER = new Set(["displayName", "firstName", "lastName", "notificationSettings"]);
  const ANYWHERE = new Set(["clientAddress", "lastUpdateInfo", "notificationSettings"]);
  const walk = (v: unknown, depth: number, inMembers: boolean): unknown => {
    if (depth > 40) return null;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, inMembers));
    if (typeof v !== "object" || v === null) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "__proto__" || ANYWHERE.has(k)) continue;
      if (inMembers && MEMBER.has(k)) continue;
      Object.defineProperty(out, k, {
        value: walk(x, depth + 1, k === "members"),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  return walk(body, 0, false);
}

/**
 * Structural identity: the same own keys in the same order, the same holes, the same prototypes and
 * the same leaves (toStrictEqual reads an own `constructor` key as a class and cannot compare it).
 */
function same(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null)
    return Object.is(a, b);
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (i in a !== i in b || !same(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.join("\u0000") !== kb.join("\u0000")) return false;
  return ka.every((k) =>
    same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Random JSON-like bodies with the keys the strip drops, members, nesting and an odd hole. */
const keyArb = fc.constantFrom(
  "id",
  "members",
  "displayName",
  "firstName",
  "notificationSettings",
  "clientAddress",
  "lastUpdateInfo",
  "teams",
  "name",
  "__proto__",
  "constructor",
);
const { tree } = fc.letrec<{ tree: unknown }>((tie) => ({
  tree: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.oneof(fc.integer(), fc.string({ maxLength: 4 }), fc.boolean(), fc.constant(null)),
    fc.array(tie("tree"), { maxLength: 4 }),
    fc
      .array(fc.tuple(keyArb, tie("tree")), { maxLength: 5 })
      .map(
        (kv) =>
          JSON.parse(
            `{${kv.map(([k, v]) => `${JSON.stringify(k)}:${String(JSON.stringify(v) as string | undefined)}`).join(",")}}`,
          ) as unknown,
      ),
  ),
}));

describe("stripForCacheSteps: the recursive walk's copy, in steps", () => {
  it("recorded rosters and league bodies: the same copy as the recursive walk, byte for byte", () => {
    const bodies = [
      loadRoster("league-a", 1),
      loadRoster("league-b", 2),
      loadRoster("league-c", 3),
      loadFixture("recorded/league-a/mNav.json"),
      loadFixture("recorded/league-a/mSettings.json"),
    ];
    for (const b of bodies) {
      const want = JSON.stringify(recursiveStrip(b));
      expect(JSON.stringify(stripForCache(b))).toBe(want);
      expect(JSON.stringify(drainSteps(stripForCacheSteps(b, 7)))).toBe(want);
    }
  });

  it("property: random bodies, any step size — the same copy (keys in order, holes, depth cut)", () => {
    fc.assert(
      fc.property(tree, fc.integer({ min: 1, max: 50 }), (b, per) => {
        const want = recursiveStrip(b);
        const got = drainSteps(stripForCacheSteps(b, per));
        expect(same(got, want)).toBe(true);
        expect(JSON.stringify(got)).toBe(JSON.stringify(want));
      }),
      { numRuns: 300 },
    );
  });

  it("holes, the depth cut, hostile keys and scalars read as the recursive walk read them", () => {
    // a hole is what is held here (index 1 is never set)
    const holes: unknown[] = [1];
    holes[2] = { members: [{ displayName: "x", id: 1 }] };
    const copy = drainSteps(stripForCacheSteps(holes, 1)) as unknown[];
    expect(same(copy, recursiveStrip(holes))).toBe(true);
    expect(1 in copy).toBe(false);
    let deep: unknown = 1;
    for (let i = 0; i < 60; i++) deep = i % 2 === 0 ? { d: deep } : [deep];
    expect(JSON.stringify(stripForCache(deep))).toBe(JSON.stringify(recursiveStrip(deep)));
    const hostile = JSON.parse('{"a":{"__proto__":{"polluted":true},"b":1}}') as unknown;
    const out = drainSteps(stripForCacheSteps(hostile, 1)) as { a: Record<string, unknown> };
    expect(Object.getPrototypeOf(out.a)).toBe(Object.prototype);
    expect(out.a).toEqual({ b: 1 });
    for (const s of ["x", 3, null, true]) expect(stripForCache(s)).toBe(s);
  });

  it("counted: no step reads more than STEP_NODES of the body's values; a roster takes many steps", () => {
    // every value the walk reads is a property read of the body: a proxy around every object and
    // array counts them, and the count is taken between two steps of the work
    let reads = 0;
    const counted = (v: unknown): unknown => {
      if (typeof v !== "object" || v === null) return v;
      const inner = Array.isArray(v)
        ? v.map(counted)
        : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, counted(x)]));
      return new Proxy(inner, {
        get(t, p, r) {
          if (p !== "length") reads += 1;
          return Reflect.get(t, p, r) as unknown;
        },
      });
    };
    const body = counted(loadRoster("league-c", 3));
    const work = stripForCacheSteps(body);
    const perStep: number[] = [];
    for (;;) {
      reads = 0;
      const r = work.next();
      perStep.push(reads);
      if (r.done === true) break;
    }
    expect(STRIP_NODES_PER_STEP).toBeLessThanOrEqual(STEP_NODES);
    expect(Math.max(...perStep)).toBeLessThanOrEqual(STEP_NODES);
    // the split is not vacuous: the whole body is many ceilings' worth of values
    const total = perStep.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(4 * STEP_NODES);
    expect(perStep.length).toBeGreaterThan(4);
  });
});
