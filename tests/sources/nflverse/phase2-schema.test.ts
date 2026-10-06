// phase2-schema.test.ts — the Phase-2 schema + codec assertion (plan 01 §5.5 + D9; plan 10 B1 "a
// fixture with one renamed column fails naming the column"): for EVERY Phase-2 parquet source and
// history twin a renamed column fails naming it (and publish refuses the same file — defence in
// depth), a retyped column fails naming expected and found, a foreign codec on any chunk fails as
// `codec`, extra columns are tolerated (the pbp listing capped), a season no layout of the source
// covers fails naming the season (depth charts changed layout in 2025), unreadable files and empty
// file lists never pass, and the per-source size cap reaches the download.
import { afterEach, describe, expect, it } from "vitest";
import { epWeeklyHistorySource, epWeeklySource } from "../../../src/sources/ffopportunity/index.js";
import {
  NFLVERSE_HISTORY_SOURCES,
  NflverseSourceError,
  PBP_MAX_FILE_BYTES,
  depthChartsSource,
  pbpSource,
  snapCountsSource,
  statsTeamWeekSource,
  type HistoryDataSource,
  type NflverseSchemaReport,
} from "../../../src/sources/nflverse/index.js";
import { MAX_EXTRA_NAMED } from "../../../src/sources/nflverse/base.js";
import { MAX_RELEASE_FILE_BYTES } from "../../../src/sources/nflverse/release.js";
import type { DataSource, HttpDownload, TempFile } from "../../../src/sources/source.js";
import { SqliteWriter, makeCtx, type Ctx } from "./helpers/harness.js";
import { p2Parquet } from "./helpers/phase2-fixtures.js";
import { rewritePhase2, type Rewrite } from "./helpers/phase2-rewrite.js";
import { tempFile } from "./helpers/rewrite.js";

const open: Ctx[] = [];
const writers: SqliteWriter[] = [];
afterEach(() => {
  for (const w of writers.splice(0)) w.close();
  for (const c of open.splice(0)) c.cleanup();
});
function dir(): string {
  const c = makeCtx([2026]);
  open.push(c);
  return c.tempDir;
}
type Source = DataSource | HistoryDataSource;
const H = NFLVERSE_HISTORY_SOURCES;

async function check(
  source: Source,
  key: string,
  change: Rewrite,
  season = Number(key.split("@")[1]),
): Promise<{ report: NflverseSchemaReport; f: TempFile }> {
  const f = tempFile(dir(), "x.parquet", rewritePhase2(key, change), season);
  return { report: (await source.assertSchema([f])) as NflverseSchemaReport, f };
}

/** One required column per source/layout (renaming it must fail naming it). */
const CASES: readonly [string, Source, string, string][] = [
  ["stats_team_week", statsTeamWeekSource, "nflverse:stats_team_week@2026", "passing_yards"],
  ["stats_team_week_history", H["nflverse:stats_team_week_history"], "nflverse:stats_team_week@2024", "opponent_team"],
  ["pbp", pbpSource, "nflverse:pbp@2026", "kick_distance"],
  ["pbp_history", H["nflverse:pbp_history"], "nflverse:pbp@2025", "yardline_100"],
  ["snap_counts", snapCountsSource, "nflverse:snap_counts@2026", "offense_pct"],
  ["snap_counts_history", H["nflverse:snap_counts_history"], "nflverse:snap_counts@2024", "pfr_player_id"],
  ["depth_charts (2025+ layout)", depthChartsSource, "nflverse:depth_charts@2026", "pos_abb"],
  ["depth_charts_history (2025 layout)", H["nflverse:depth_charts_history"], "nflverse:depth_charts@2025", "dt"],
  ["depth_charts_history (≤ 2024 layout)", H["nflverse:depth_charts_history"], "nflverse:depth_charts@2024", "depth_team"],
  ["ep_weekly", epWeeklySource, "ffopportunity:ep_weekly@2026", "rec_touchdown_exp"],
  ["ep_weekly_history", epWeeklyHistorySource, "ffopportunity:ep_weekly@2024", "player_id"],
  ["stats_player_week_history", H["nflverse:stats_player_week_history"], "nflverse:stats_player_week@2025", "targets"],
  ["injuries_history", H["nflverse:injuries_history"], "nflverse:injuries@2024", "report_status"],
]; // prettier-ignore

describe("B1: a renamed column fails the job, naming the column", () => {
  it.each(CASES)("%s", async (_name, source, key, column) => {
    const { report, f } = await check(source, key, { rename: { [column]: `${column}_renamed` } });
    expect(report.ok).toBe(false);
    expect(report.error).toBe("schema_mismatch");
    expect(report.missing_columns).toEqual([column]);
    expect(report.warnings).toContain(`${source.id}: missing or renamed column(s): ${column}`);
    expect(report.extra_columns).toContain(`${column}_renamed`);
    // publish never trusts that the runner asserted first
    const w = new SqliteWriter(dir());
    writers.push(w);
    await expect(source.publish([f], w)).rejects.toMatchObject({ code: "schema_mismatch" });
  });

  it("the unmodified fixture of every case passes", async () => {
    for (const [name, source, key] of CASES) {
      const { report } = await check(source, key, {});
      expect(report.ok, `${name}: ${report.warnings.join("; ")}`).toBe(true);
      expect(report.error).toBeNull();
    }
  });
});

describe("types, codecs, extras", () => {
  it("a retyped column fails naming the expected and found kinds", async () => {
    const pbp = await check(pbpSource, "nflverse:pbp@2026", {
      retype: { yardline_100: { type: "BYTE_ARRAY", logical: "STRING" } },
    });
    expect(pbp.report.ok).toBe(false);
    expect(pbp.report.type_mismatches).toEqual([
      { column: "yardline_100", expected: "double", found: "BYTE_ARRAY/STRING" },
    ]);
    expect(pbp.report.warnings).toContain(
      "nflverse:pbp: column yardline_100 expected double, found BYTE_ARRAY/STRING",
    );
    // ffopportunity writes season as TEXT: a numeric season is a format change, not data
    const ep = await check(epWeeklySource, "ffopportunity:ep_weekly@2026", {
      retype: { season: { type: "DOUBLE" } },
    });
    expect(ep.report.type_mismatches).toEqual([
      { column: "season", expected: "string", found: "DOUBLE" },
    ]);
    // an integer where a double is read is a lossless widening (accepted)
    const snaps = await check(snapCountsSource, "nflverse:snap_counts@2026", {
      retype: { offense_snaps: { type: "INT32" } },
    });
    expect(snaps.report.ok).toBe(true);
  });

  it("a foreign codec on ANY chunk fails as `codec` — even a column the contract never reads", async () => {
    const { report } = await check(pbpSource, "nflverse:pbp@2026", { codec: { desc: "ZSTD" } });
    expect(report.ok).toBe(false);
    expect(report.error).toBe("codec");
    expect(report.bad_codecs).toEqual([{ column: "desc", codec: "ZSTD" }]);
  });

  it("extra columns are tolerated; a wide projection's listing is capped", async () => {
    const extra = Array.from({ length: 320 }, (_, i) => ({
      name: `extra_${String(i).padStart(3, "0")}`,
      type: "DOUBLE" as const,
    }));
    const { report, f } = await check(pbpSource, "nflverse:pbp@2026", { extra });
    expect(report.ok).toBe(true);
    expect(report.extra_columns).toHaveLength(326);
    const line = report.warnings.find((x) => x.includes("extra column(s) tolerated"));
    expect(line).toContain(`… and ${String(326 - MAX_EXTRA_NAMED)} more`);
    expect((line?.match(/, /g) ?? []).length).toBe(MAX_EXTRA_NAMED - 1);
    const w = new SqliteWriter(dir());
    writers.push(w);
    const stats = await pbpSource.publish([f], w);
    expect(stats.rows).toBe(516);
  });
});

describe("layouts by season (depth charts changed in 2025)", () => {
  it("the current depth source refuses a ≤ 2024 file, naming the season; publish too", async () => {
    const f = tempFile(dir(), "d.parquet", p2Parquet("nflverse:depth_charts@2024"), 2024);
    const report = (await depthChartsSource.assertSchema([f])) as NflverseSchemaReport;
    expect(report.ok).toBe(false);
    expect(report.error).toBe("schema_mismatch");
    expect(report.warnings).toContain(
      "nflverse:depth_charts season 2024: no layout of this source covers the season",
    );
    const w = new SqliteWriter(dir());
    writers.push(w);
    await expect(depthChartsSource.publish([f], w)).rejects.toThrow(/no layout/);
  });

  it("a 2025-layout file labelled 2024 fails on the legacy columns it lacks", async () => {
    const f = tempFile(dir(), "d.parquet", p2Parquet("nflverse:depth_charts@2025"), 2024);
    const report = (await H["nflverse:depth_charts_history"].assertSchema([
      f,
    ])) as NflverseSchemaReport;
    expect(report.ok).toBe(false);
    expect(report.missing_columns).toEqual(
      expect.arrayContaining(["club_code", "depth_position", "depth_team", "formation", "week"]),
    );
  });

  it("a season-less file never passes a per-season source", async () => {
    const f = tempFile(dir(), "x.parquet", p2Parquet("nflverse:pbp@2026"), null);
    const report = (await pbpSource.assertSchema([f])) as NflverseSchemaReport;
    expect(report.ok).toBe(false);
    expect(report.warnings.join("\n")).toMatch(/file: no layout/);
  });
});

describe("unreadable input and empty runs", () => {
  it("not parquet, truncated, no files: never ok, the right code", async () => {
    const d = dir();
    const junk = tempFile(d, "j.parquet", new TextEncoder().encode("PAR1 not really PAR1"), 2026);
    const good = p2Parquet("nflverse:snap_counts@2026");
    const cut = tempFile(d, "t.parquet", good.slice(0, good.length - 100), 2026);
    for (const f of [junk, cut]) {
      const r = (await snapCountsSource.assertSchema([f])) as NflverseSchemaReport;
      expect(r.ok).toBe(false);
      expect(r.error).toBe("schema_mismatch");
    }
    const none = (await snapCountsSource.assertSchema([])) as NflverseSchemaReport;
    expect(none).toMatchObject({ ok: false, error: "not_published" });
  });

  it("an empty file (0 rows) is not a publishable release", async () => {
    const f = tempFile(
      dir(),
      "e.parquet",
      rewritePhase2("nflverse:stats_team_week@2026", { rows: () => [] }),
      2026,
    );
    const r = (await statsTeamWeekSource.assertSchema([f])) as NflverseSchemaReport;
    expect(r.ok).toBe(false);
    expect(r.warnings).toContain("nflverse:stats_team_week season 2026: file has no rows");
  });
});

describe("size caps reach the download (pbp ~21 MB a season)", () => {
  it("pbp asks for PBP_MAX_FILE_BYTES; the others for the default cap", async () => {
    const seen = new Map<string, number>();
    const download: HttpDownload = (url, opts) => {
      seen.set(url, opts.maxBytes);
      return Promise.reject(new NflverseSourceError("download", "stop", 500));
    };
    for (const s of [pbpSource, snapCountsSource, epWeeklySource]) {
      const c = makeCtx([2026], { overrides: { download } });
      open.push(c);
      await expect(s.fetch({ version: "v", released_at: null }, c.ctx)).rejects.toThrow();
    }
    const caps = [...seen.entries()].map(([u, m]) => [u.split("/").pop(), m]);
    expect(caps).toEqual([
      ["play_by_play_2026.parquet", PBP_MAX_FILE_BYTES],
      ["snap_counts_2026.parquet", MAX_RELEASE_FILE_BYTES],
      ["ep_weekly_2026.parquet", MAX_RELEASE_FILE_BYTES],
    ]);
    expect(PBP_MAX_FILE_BYTES).toBeGreaterThan(3 * 20_597_560);
  });

  it("a body past the cap is refused (the partial file removed)", async () => {
    const download: HttpDownload = (_url, opts) =>
      Promise.resolve({
        status: 200,
        bytes: opts.maxBytes + 1,
        headers: {},
        final_url: "https://release-assets.githubusercontent.com/x",
        path: opts.dest,
      });
    const c = makeCtx([2026], { overrides: { download } });
    open.push(c);
    await expect(pbpSource.fetch({ version: "v", released_at: null }, c.ctx)).rejects.toThrow(
      /size cap/,
    );
  });
});
