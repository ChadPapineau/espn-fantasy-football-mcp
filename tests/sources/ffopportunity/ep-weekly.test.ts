// ep-weekly.test.ts — the ffopportunity source's own surface (plan 10 §3.2 ffopportunity `ep_weekly`;
// plan 01 §5.2 CC-BY-SA; research 04 §B.3, §E): the release's zone-less timestamp.txt read as UTC
// (and nothing looser), the `latest-data` URLs on the allow-listed host, the CC-BY-SA licence and
// ffverse attribution exposed for `eff status`, and the source end to end on the committed
// excerpt through a fake HttpGet. No network.
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  EP_NO_PLAYER,
  FFOPPORTUNITY_RELEASE_BASE,
  FFOPPORTUNITY_TAG,
  epWeeklyHistorySource,
  epWeeklySource,
  parseFfopportunityTimestamp,
} from "../../../src/sources/ffopportunity/index.js";
import { DATA_SOURCE_HOSTS } from "../../../src/http/allowlist.js";
import { parseNflverseTimestamp } from "../../../src/sources/nflverse/index.js";
import { SqliteWriter, makeCtx, type Ctx } from "../nflverse/helpers/harness.js";
import { p2Rows, phase2FixtureRoutes } from "../nflverse/helpers/phase2-fixtures.js";

const open: Ctx[] = [];
const writers: SqliteWriter[] = [];
afterEach(() => {
  for (const w of writers.splice(0)) w.close();
  for (const c of open.splice(0)) c.cleanup();
});

describe("parseFfopportunityTimestamp", () => {
  it("a zone-less stamp is the build's UTC clock (observed: 12:14:46.83 vs the asset's 12:14:49Z)", () => {
    expect(parseFfopportunityTimestamp("2026-10-06 12:14:46.831507\n")).toBe(
      "2026-10-06T12:14:46.000Z",
    );
    expect(parseFfopportunityTimestamp("2026-10-06T12:14:46")).toBe("2026-10-06T12:14:46.000Z");
    expect(parseFfopportunityTimestamp("  2026-01-01 00:00:00  ")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("a stamp WITH a zone is read as nflverse's (never re-zoned)", () => {
    expect(parseFfopportunityTimestamp("2026-10-06 08:14:46 EDT")).toBe("2026-10-06T12:14:46.000Z");
    expect(parseFfopportunityTimestamp("2026-10-06 12:14:46Z")).toBe("2026-10-06T12:14:46.000Z");
  });

  it("anything else is null: impossible dates, other shapes, oversize, non-strings", () => {
    for (const bad of [
      "2026-02-30 00:00:00",
      "2026-10-06 24:00:00",
      "2026-10-06",
      "06/10/2026 12:14:46",
      "2026-10-06 12:14:46 PST",
      "2026-10-06 12:14:46.1234567890",
      `2026-10-06 12:14:46${" ".repeat(300)}`,
      "",
      null,
      42,
    ])
      expect(parseFfopportunityTimestamp(bad), String(bad)).toBeNull();
  });

  it("never disagrees with nflverse's parser on a zoned stamp; never throws (fast-check)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        const z = parseNflverseTimestamp(s);
        const f = parseFfopportunityTimestamp(s);
        if (z !== null) expect(f).toBe(z);
        if (f !== null) expect(f).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
      }),
    );
  });
});

describe("the release, the licence, the attribution", () => {
  it("reads ffverse/ffopportunity `latest-data` on an allow-listed host", async () => {
    expect(FFOPPORTUNITY_RELEASE_BASE).toBe(
      "https://github.com/ffverse/ffopportunity/releases/download",
    );
    expect(FFOPPORTUNITY_TAG).toBe("latest-data");
    expect(DATA_SOURCE_HOSTS).toContain(new URL(FFOPPORTUNITY_RELEASE_BASE).hostname);
    const c = makeCtx([2026], { routes: phase2FixtureRoutes() });
    open.push(c);
    const v = await epWeeklySource.version(c.ctx);
    expect(v).toEqual({
      version: "20261006T121446Z_2026",
      released_at: "2026-10-06T12:14:46.000Z",
    });
    await epWeeklySource.fetch(v ?? { version: "", released_at: null }, c.ctx);
    expect(c.calls).toEqual([
      `${FFOPPORTUNITY_RELEASE_BASE}/latest-data/timestamp.txt`,
      `${FFOPPORTUNITY_RELEASE_BASE}/latest-data/ep_weekly_2026.parquet`,
    ]);
  });

  it("CC-BY-SA 4.0 with the ffverse attribution, on both the source and its history twin", () => {
    for (const s of [epWeeklySource, epWeeklyHistorySource]) {
      expect(s.license).toBe("CC-BY-SA-4.0");
      expect(s.attribution.source).toBe("ffopportunity (ffverse)");
      expect(s.attribution.license).toBe("CC-BY-SA-4.0");
    }
    expect(epWeeklyHistorySource.id).toBe("ffopportunity:ep_weekly_history");
    expect(epWeeklyHistorySource.current).toBe("ffopportunity:ep_weekly");
  });

  it("an unparseable stamp fails as a format change (schema_mismatch), not an outage", async () => {
    const url = `${FFOPPORTUNITY_RELEASE_BASE}/latest-data/timestamp.txt`;
    const c = makeCtx([2026], {
      routes: new Map([[url, new TextEncoder().encode("Tue Oct 6 12:14:46 2026")]]),
    });
    open.push(c);
    await expect(epWeeklySource.version(c.ctx)).rejects.toMatchObject({
      code: "schema_mismatch",
      message: "ffopportunity latest-data: unparseable timestamp.txt",
    });
  });
});

describe("publish on the committed excerpt", () => {
  it("player-weeks only; the history twin holds the prior games", async () => {
    const c = makeCtx([2026], { routes: phase2FixtureRoutes() });
    open.push(c);
    const files = await epWeeklySource.fetch({ version: "v", released_at: null }, c.ctx);
    const w = new SqliteWriter(c.tempDir);
    writers.push(w);
    const stats = await epWeeklySource.publish(files, w);
    expect(stats.rows).toBe(p2Rows("ffopportunity:ep_weekly@2026").length - 2);
    const sum = w.all(
      "SELECT ROUND(SUM(total_fantasy_points_exp), 6) AS x, ROUND(SUM(rec_touchdown_exp), 6) AS t FROM ds_ep_weekly",
    )[0];
    const raw = p2Rows("ffopportunity:ep_weekly@2026").filter((r) => r.player_id !== null);
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    expect(sum?.x).toBe(
      round(raw.reduce((a, r) => a + Number(r.total_fantasy_points_exp ?? 0), 0)),
    );
    expect(sum?.t).toBe(round(raw.reduce((a, r) => a + Number(r.rec_touchdown_exp ?? 0), 0)));
    expect(EP_NO_PLAYER).toMatch(/team-level/);
  });
});
