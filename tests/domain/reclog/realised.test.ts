// realised.test.ts — the realised side of a stored v2 trace (src/domain/reclog/realised.ts; plan 10
// C9: the re-fit compares each share's EWM and each shrunk rate with the final week): a stored trace
// is read back defensively (any malformed or unbounded part → none), the shares fill from the team's
// volume, the rates from the realised line with their opportunities, the TD rate per the position,
// an inactive week realises nothing, and a filled trace feeds the proposals (a share window and a
// rate with realised values reach tune.ts's fits). Synthetic values only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_BOUNDS,
  type ProjectionTrace,
} from "../../../src/domain/reclog/attribution.js";
import { readTrace, traceWithRealised } from "../../../src/domain/reclog/realised.js";

const stored = {
  matchup: { z: 0.05, beta: 0.2 },
  weather_mult: null,
  shares: [
    { name: "target_share", history: [0.2, 0.22, 0.25], half_life: 8, realised: null },
    { name: "carry_share", history: [0.01], half_life: 8, realised: null },
  ],
  rates: [
    {
      name: "catch_rate",
      n_obs: 24,
      observed: 0.66,
      prior: 0.62,
      k: 10,
      realised: null,
      realised_n: 0,
    },
    {
      name: "yards_per_reception",
      n_obs: 16,
      observed: 12,
      prior: 11,
      k: 10,
      realised: null,
      realised_n: 0,
    },
    {
      name: "td_rate",
      n_obs: 24,
      observed: 0.05,
      prior: 0.04,
      k: 50,
      realised: null,
      realised_n: 0,
    },
    {
      name: "yards_per_target",
      n_obs: 24,
      observed: 8,
      prior: 7.5,
      k: 10,
      realised: null,
      realised_n: 0,
    },
  ],
};

describe("readTrace", () => {
  it("reads a well-formed stored trace (realised reset to unknown)", () => {
    const t = readTrace(stored);
    expect(t?.matchup).toEqual({ z: 0.05, beta: 0.2 });
    expect(t?.shares.map((s) => s.name)).toEqual(["target_share", "carry_share"]);
    expect(t?.rates).toHaveLength(4);
    expect(t?.rates.every((r) => r.realised === null && r.realised_n === 0)).toBe(true);
  });

  it.each([
    ["not an object", 7],
    ["an array", []],
    ["no shares", { ...stored, shares: undefined }],
    ["a foreign share name", { ...stored, shares: [{ ...stored.shares[0], name: "__proto__" }] }],
    ["a share above 1", { ...stored, shares: [{ ...stored.shares[0], history: [1.5] }] }],
    ["a non-finite rate", { ...stored, rates: [{ ...stored.rates[0], observed: Number.NaN }] }],
    ["a foreign rate name", { ...stored, rates: [{ ...stored.rates[0], name: "ignore_this" }] }],
    ["a malformed matchup", { ...stored, matchup: { z: "x", beta: 0.2 } }],
    ["a non-number weather", { ...stored, weather_mult: "windy" }],
    [
      "too many shares",
      {
        ...stored,
        shares: Array.from({ length: ATTRIBUTION_BOUNDS.shares + 1 }, () => stored.shares[0]),
      },
    ],
    [
      "too long a history",
      {
        ...stored,
        shares: [
          {
            ...stored.shares[0],
            history: Array.from({ length: ATTRIBUTION_BOUNDS.shareHistory + 1 }, () => 0.1),
          },
        ],
      },
    ],
  ])("reads %s as none", (_label, v) => {
    expect(readTrace(v)).toBeNull();
  });
});

describe("traceWithRealised", () => {
  const t0 = readTrace(stored);
  if (t0 === null) throw new Error("the stored fixture trace must read");
  const t: ProjectionTrace = t0;
  const line = { targets: 10, rec: 7, rec_yd: 84, rec_td: 1, rush_att: 1, rush_yd: 4 };

  it("fills shares from the team volume and rates from the line, with their opportunities", () => {
    const r = traceWithRealised(t, "WR", true, line, { dropbacks: 40, rushes: 25 });
    expect(r.shares.find((s) => s.name === "target_share")?.realised).toBe(0.25);
    expect(r.shares.find((s) => s.name === "carry_share")?.realised).toBe(0.04);
    const by = new Map(r.rates.map((x) => [x.name, x]));
    expect(by.get("catch_rate")).toMatchObject({ realised: 0.7, realised_n: 10 });
    expect(by.get("yards_per_reception")).toMatchObject({ realised: 12, realised_n: 7 });
    expect(by.get("td_rate")).toMatchObject({ realised: 0.1, realised_n: 10 });
    // v2 traces no yards per target: left unrealised (the registry ignores it for v2)
    expect(by.get("yards_per_target")?.realised).toBeNull();
  });

  it("the TD rate's opportunity follows the position", () => {
    const qbLine = { pass_att: 30, pass_cmp: 20, pass_td: 3, pass_int: 1 };
    const qb = traceWithRealised(t, "QB", true, qbLine, null);
    expect(qb.rates.find((x) => x.name === "td_rate")).toMatchObject({
      realised: 0.1,
      realised_n: 30,
    });
    const rb = traceWithRealised(t, "RB", true, { rush_att: 20, rush_td: 2 }, null);
    expect(rb.rates.find((x) => x.name === "td_rate")).toMatchObject({
      realised: 0.1,
      realised_n: 20,
    });
  });

  it("an inactive week, an unknown team or a zero opportunity realises nothing", () => {
    expect(traceWithRealised(t, "WR", false, line, { dropbacks: 40, rushes: 25 })).toBe(t);
    const noTeam = traceWithRealised(t, "WR", true, line, null);
    expect(noTeam.shares.every((s) => s.realised === null)).toBe(true);
    const zero = traceWithRealised(
      t,
      "WR",
      true,
      { targets: 0, rec: 0 },
      { dropbacks: 0, rushes: 0 },
    );
    expect(zero.shares.every((s) => s.realised === null)).toBe(true);
    expect(zero.rates.find((x) => x.name === "catch_rate")?.realised).toBeNull();
  });

  it("property: realised shares stay in [0, 1]", () => {
    fc.assert(
      fc.property(fc.nat(200), fc.integer({ min: 1, max: 80 }), (tg, db) => {
        const r = traceWithRealised(t, "WR", true, { targets: tg }, { dropbacks: db, rushes: db });
        const s = r.shares.find((x) => x.name === "target_share")?.realised ?? 0;
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }),
      { numRuns: 80 },
    );
  });
});
