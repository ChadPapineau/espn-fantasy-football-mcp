// zod-error-param.test.ts — the schemas name their custom reasons through zod 4's `error` param, not
// its deprecated `message` alias, which typescript-eslint 8.74.0's `no-deprecated` reports
// (docs/plan/changelog.md "Reviews", 2026-11-25: Dependabot PR 7). The rename moves no issue: zod's
// `normalizeParams` turns `{ message: s }` into `{ error: s }` before it builds the check, so both
// raise the same issues. Held here over arbitrary reasons and inputs for the two constructs the
// schemas use (`.regex(re, params)`, and `.refine(fn, params)` with and without `path`), and on the
// real schemas for each reason no other test names.
import fc from "fast-check";
import { z } from "zod/v4";
import { describe, expect, it } from "vitest";
import {
  gsisIdSchema,
  gsisIdsSchema,
  logIdSchema,
  playerIdsSchema,
  positionsSchema,
  recommendationKindsSchema,
  requestIdSchema,
  searchQuerySchema,
  singlePlayerSelectorSchema,
} from "../../src/mcp/bounds.js";
import { INVALID_ID_MESSAGE, playerIdSchema } from "../../src/mcp/envelope.js";

/** The issues a parse raised (none on success). */
function issues(r: z.ZodSafeParseResult<unknown>): readonly z.core.$ZodIssue[] {
  return r.success ? [] : r.error.issues;
}

/** Every message a parse raised, a union's per-option issues included. */
function messages(r: z.ZodSafeParseResult<unknown>): string[] {
  const out: string[] = [];
  const walk = (list: readonly z.core.$ZodIssue[]) => {
    for (const i of list) {
      out.push(i.message);
      if (i.code === "invalid_union") for (const option of i.errors) walk(option);
    }
  };
  walk(issues(r));
  return out;
}

describe("zod's `error` param raises what its deprecated `message` alias raised", () => {
  it("regex: the same issues for any reason and input, the reason as the message", () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ maxLength: 6 }), (reason, input) => {
        const viaError = z.string().regex(/^[a-z]*$/, { error: reason });
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- the alias, compared on purpose
        const viaMessage = z.string().regex(/^[a-z]*$/, { message: reason });
        expect(issues(viaError.safeParse(input))).toEqual(issues(viaMessage.safeParse(input)));
        expect(messages(viaError.safeParse(`${input}A`))).toEqual([reason]);
      }),
    );
  });

  it("refine, with and without a path: the same issues for any reason and input", () => {
    const distinct = (v: { a: number[] }) => new Set(v.a).size === v.a.length;
    const base = z.strictObject({ a: z.array(z.number()) });
    fc.assert(
      fc.property(
        fc.string(),
        fc.boolean(),
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 4 }),
        (reason, withPath, a) => {
          const path = withPath ? { path: ["a"] } : {};
          const viaError = base.refine(distinct, { error: reason, ...path });
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- the alias, compared on purpose
          const viaMessage = base.refine(distinct, { message: reason, ...path });
          expect(issues(viaError.safeParse({ a }))).toEqual(issues(viaMessage.safeParse({ a })));
          expect(messages(viaError.safeParse({ a: [1, 1] }))).toEqual([reason]);
        },
      ),
    );
  });
});

describe("the schemas' reasons that no other test names", () => {
  const GSIS_A = "00-0012345";
  const GSIS_B = "00-0054321";
  const cases: readonly [string, z.ZodType, unknown, string][] = [
    ["player ids", playerIdsSchema, [1001, 1001], "duplicate_ids"],
    ["gsis ids", gsisIdsSchema, [GSIS_A, GSIS_A], "duplicate_ids"],
    [
      "one player by gsis id",
      singlePlayerSelectorSchema,
      { gsis_ids: [GSIS_A, GSIS_B] },
      "too_big",
    ],
    ["positions", positionsSchema, ["QB", "QB"], "duplicate_positions"],
    ["recommendation kinds", recommendationKindsSchema, ["lineup", "lineup"], "duplicate_kinds"],
    ["a search", searchQuerySchema, "a\u0007b", "unprintable_characters"],
    ["a gsis id", gsisIdSchema, "00-12", INVALID_ID_MESSAGE],
    ["a log id", logIdSchema, "rec-x", INVALID_ID_MESSAGE],
    ["a request id", requestIdSchema, "r-x", INVALID_ID_MESSAGE],
    ["a player id", playerIdSchema, 0, INVALID_ID_MESSAGE],
  ];

  it.each(cases)("%s: refused with its reason", (_what, schema, input, reason) => {
    const r = schema.safeParse(input);
    expect(r.success).toBe(false);
    expect(messages(r)).toContain(reason);
  });

  it("the same schemas accept a valid value (the reason is the refusal's, not every parse's)", () => {
    expect(playerIdsSchema.safeParse([1001, 1002]).success).toBe(true);
    expect(gsisIdsSchema.safeParse([GSIS_A, GSIS_B]).success).toBe(true);
    expect(singlePlayerSelectorSchema.safeParse({ gsis_ids: [GSIS_A] }).success).toBe(true);
    expect(positionsSchema.safeParse(["QB", "RB"]).success).toBe(true);
    expect(recommendationKindsSchema.safeParse(["lineup", "waiver"]).success).toBe(true);
    expect(searchQuerySchema.safeParse("ab").success).toBe(true);
    expect(gsisIdSchema.safeParse(GSIS_A).success).toBe(true);
    expect(playerIdSchema.safeParse(1001).success).toBe(true);
  });
});
