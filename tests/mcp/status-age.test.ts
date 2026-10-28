// status-age.test.ts — espn_get_status (G1, plan 07 G1) answers on an install whose datasets were
// not refreshed for weeks (Stage C final gate). A source row's `age_s` and a freshness class's
// `age_s` were typed `count` (an integer ≤ 1 000 000), so once any dataset source was older than
// 1 000 000 s (11.6 days) the output schema refused the whole answer: tool.output_invalid at
// data.sources[].age_s, INTERNAL on every call. Live on the owner's install (8 sources ≈ 1.404 M s
// old) and on every install through the off-season, when the jobs do not refresh — and every Skill's
// Step 0 calls espn_get_status first. espn-ff://status, which validates no schema, still answered.
// Fixture mode, no network.
import { describe, expect, it } from "vitest";
import { AGE_S_MAX, ageSeconds, count } from "../../src/mcp/tools/schemas.js";
import { call, connect, makeWorld } from "./helpers/world.js";

const DAY_MS = 24 * 3600 * 1000;

interface SourceRow {
  readonly id: string;
  readonly age_s: number | null;
  readonly freshness: string;
}

describe("espn_get_status on an install idle for weeks", () => {
  it("answers at every age: fresh, 11 days, 13 days (past 1 000 000 s) and 400 days", async () => {
    const world = await makeWorld({ publishNflverse: true });
    try {
      const c = await connect(world);
      const ages: number[] = [];
      for (const [label, advance] of [
        ["fresh", 0],
        ["+11 d", 11 * DAY_MS],
        ["+13 d", 2 * DAY_MS],
        ["+400 d", 387 * DAY_MS],
      ] as const) {
        world.clock.advance(advance);
        const r = await call(c.client, "espn_get_status", {});
        expect(r.isError, `${label}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
        const sources = (r.body.data as { sources: SourceRow[] }).sources;
        const known = sources.map((s) => s.age_s).filter((a): a is number => a !== null);
        expect(known.length, label).toBeGreaterThan(0);
        ages.push(Math.max(...known));
        // the resource twin carries the same rows (read a moment later: the clock runs)
        const raw = (await c.client.readResource({ uri: "espn-ff://status/freshness" })) as {
          contents: { text: string }[];
        };
        const res = JSON.parse(raw.contents[0]?.text ?? "{}") as {
          data: { sources: SourceRow[]; classes: { age_s: number | null }[] };
        };
        expect(res.data.sources.map((s) => s.id)).toEqual(sources.map((s) => s.id));
        res.data.sources.forEach((s, i) => {
          const tool = sources[i]?.age_s ?? null;
          if (tool === null) expect(s.age_s).toBeNull();
          else expect(Math.abs((s.age_s ?? -1) - tool), label).toBeLessThanOrEqual(5);
        });
      }
      // the ages really crossed the old ceiling: the +13 d and +400 d answers were INTERNAL before
      expect(ages[1]).toBeLessThan(1_000_000);
      expect(ages[2]).toBeGreaterThan(1_000_000);
      expect(ages[3]).toBeGreaterThan(400 * 86_400 - 86_400);
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 120_000);
});

describe("ageSeconds: an age, never a count", () => {
  it("takes every age measured from an instant since the epoch up to 2100; refuses the rest", () => {
    expect(count.safeParse(1_404_153).success).toBe(false); // the live value `count` refused
    for (const ok of [0, 1, 1_000_001, 1_404_153, Math.floor(Date.now() / 1000), AGE_S_MAX])
      expect(ageSeconds.safeParse(ok).success, String(ok)).toBe(true);
    for (const bad of [-1, 1.5, AGE_S_MAX + 1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(ageSeconds.safeParse(bad).success, String(bad)).toBe(false);
    expect(AGE_S_MAX).toBe(Date.parse("2100-01-01T00:00:00Z") / 1000);
  });
});
