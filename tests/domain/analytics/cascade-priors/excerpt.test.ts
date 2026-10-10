// excerpt.test.ts — the committed team-game usage excerpt (data/, nflverse CC-BY 4.0, adapted): every
// file matches the manifest (sha256, rows), three seasons [A-3], nflverse release URLs only, players
// pseudonymised (no NFL id, no name — only p1, p2, …), sane counts (red zone ⊆ total, depth ranks
// positive, each team-week a whole team); the codec round-trips (a property) and refuses malformed
// text instead of guessing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { UsageRow } from "../../../../src/domain/analytics/cascade-priors/types.js";
import {
  DATA_DIR,
  EXCERPT_COLUMNS,
  EXCERPT_SEASONS,
  decodeUsage,
  encodeUsage,
  loadManifest,
  loadUsageExcerpt,
  manifestFileOf,
} from "./helpers/excerpt.js";

describe("the committed excerpt", () => {
  const m = loadManifest();
  const rows = loadUsageExcerpt();
  it("matches its manifest: three seasons, one file each, hashes and counts verified on load", () => {
    expect(m.schema).toBe("cascade-usage-excerpt-v1");
    expect(m.columns).toEqual([...EXCERPT_COLUMNS]);
    expect(m.files.map((f) => f.season)).toEqual([...EXCERPT_SEASONS]);
    expect(rows.length).toBe(m.files.reduce((s, f) => s + f.rows, 0));
    expect(m.licence).toMatch(/^CC-BY-4\.0 \(nflverse/);
  });
  it("names only nflverse release files upstream, each with a sha256", () => {
    expect(m.upstream.length).toBe(10);
    for (const u of m.upstream) {
      expect(u.url.startsWith("https://github.com/nflverse/nflverse-data/releases/download/")).toBe(
        true,
      );
      expect(u.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(u.bytes).toBeGreaterThan(0);
    }
  });
  it("holds no NFL id and no name: players are p1, p2, … per (season, team)", () => {
    for (const f of m.files) {
      const text = readFileSync(join(DATA_DIR, f.path), "utf8");
      expect(text).not.toMatch(/[0-9]{2}-[0-9]{7}/); // a gsis id
      // every data line is numbers, a team code, a pseudonym and a position group — room for no name
      const lines = text.split("\n").filter((l) => l !== "");
      expect(lines[0]).toBe(EXCERPT_COLUMNS.join("\t"));
      for (const l of lines.slice(1))
        expect(l).toMatch(
          /^[0-9]+\t[A-Z]{2,3}\tp[0-9]+\t(QB|RB|WR|TE|OTHER)\t[0-9]*(\t[0-9]+){4}$/,
        );
    }
    expect(rows.every((r) => /^p[0-9]+$/.test(r.player))).toBe(true);
  });
  it("counts are sane: red zone within the total, depth ranks positive, ≥ 30 teams a season", () => {
    for (const r of rows) {
      expect(r.rz_targets).toBeLessThanOrEqual(r.targets);
      expect(r.rz_carries).toBeLessThanOrEqual(r.carries);
      if (r.depth !== null) expect(r.depth).toBeGreaterThanOrEqual(1);
      expect(r.week).toBeGreaterThanOrEqual(1);
      expect(r.week).toBeLessThanOrEqual(18);
    }
    for (const s of EXCERPT_SEASONS) {
      const teams = new Set(rows.filter((r) => r.season === s).map((r) => r.team));
      expect(teams.size).toBe(32);
    }
  });
});

const rowArb = (season: number) =>
  fc.record({
    season: fc.constant(season),
    week: fc.integer({ min: 1, max: 18 }),
    team: fc.constantFrom("BUF", "LA", "NYJ"),
    player: fc.integer({ min: 1, max: 99 }).map((n) => `p${String(n)}`),
    position: fc.constantFrom("QB", "RB", "WR", "TE", "OTHER"),
    depth: fc.option(fc.integer({ min: 1, max: 9 }), { nil: null }),
    targets: fc.nat(30),
    carries: fc.nat(40),
    rz_targets: fc.nat(5),
    rz_carries: fc.nat(5),
  }) as fc.Arbitrary<UsageRow>;

describe("the codec", () => {
  it("round-trips any rows of one season (property)", () => {
    fc.assert(
      fc.property(fc.array(rowArb(2024), { maxLength: 30 }), (rs) => {
        expect(decodeUsage(encodeUsage(rs), 2024)).toEqual(rs);
      }),
    );
  });
  it("refuses mixed seasons, a wrong header and malformed cells", () => {
    const one: UsageRow = {
      season: 2024,
      week: 1,
      team: "BUF",
      player: "p1",
      position: "WR",
      depth: null,
      targets: 1,
      carries: 0,
      rz_targets: 0,
      rz_carries: 0,
    };
    expect(() => encodeUsage([one, { ...one, season: 2023 }])).toThrow(/one season/);
    const good = encodeUsage([one]);
    expect(() => decodeUsage(good.replace("week", "wk"), 2024)).toThrow(/header/);
    const body = (line: string) => `${EXCERPT_COLUMNS.join("\t")}\n${line}\n`;
    for (const line of [
      "1\tBUF\tp1\tWR\t\t1\t0\t0", // a cell short
      "1\tbuf\tp1\tWR\t\t1\t0\t0\t0", // team
      "1\tBUF\t00-0012345\tWR\t\t1\t0\t0\t0", // an NFL id instead of a pseudonym
      "1\tBUF\tp1\tK\t\t1\t0\t0\t0", // position
      "1\tBUF\tp1\tWR\t\t-1\t0\t0\t0", // negative count
      "1\tBUF\tp1\tWR\t\t1.5\t0\t0\t0", // fraction
      "\tBUF\tp1\tWR\t\t1\t0\t0\t0", // empty week
    ])
      expect(() => decodeUsage(body(line), 2024)).toThrow();
    const entry = manifestFileOf("x.tsv", 2024, 1, good);
    expect([entry.path, entry.season, entry.rows]).toEqual(["x.tsv", 2024, 1]);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
