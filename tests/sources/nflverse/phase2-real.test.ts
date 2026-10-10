// phase2-real.test.ts — the Phase-2 sources over the REAL release files (plan 10 §3.2 / B1; the
// grounding of docs/evals/phase2-datasets.md): OPT-IN and offline. Set PHASE2_RELEASE_DIR to a
// directory (outside the repo) holding the downloaded files named `<tag>_<file>` (e.g.
// `pbp_play_by_play_2024.parquet`, `ffopportunity_ep_weekly_2026.parquet`, `pbp_timestamp.txt`,
// `ffopportunity_timestamp.txt`); every file must hash to tests/store/datasets/observed-phase2.ts,
// so the counts below are the grounding's exactly. The files are served through the fake HttpGet —
// no test touches the network — and published into a real STRICT SQLite writer. Skipped in CI.
// Phase 3 (plan 10 §3.3, D9): a history twin now always holds the three backtest seasons, so the
// history files are grounded over the real 2023–2025 files in phase3-real.test.ts (whose totals are
// 2023 plus the two-season counts this file recorded: 1,140 team-weeks, 85,713 / 12,550 pbp rows,
// 53,228 snap rows, 18,254 runs + 36,877 legacy depth rows, 11,217 / 842 ep rows).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  FFOPPORTUNITY_RELEASE_BASE,
  epWeeklySource,
} from "../../../src/sources/ffopportunity/index.js";
import {
  NFLVERSE_PHASE_2_SOURCES,
  type NflversePublishStats,
} from "../../../src/sources/nflverse/index.js";
import type { DataSource } from "../../../src/sources/source.js";
import { OBSERVED_PHASE2 } from "../../store/datasets/observed-phase2.js";
import { REL } from "./helpers/fixtures.js";
import { SqliteWriter, makeCtx, type Ctx, type Route } from "./helpers/harness.js";

const DIR = process.env.PHASE2_RELEASE_DIR ?? "";
const enabled = DIR !== "" && existsSync(DIR);

interface Upstream {
  readonly key: string;
  readonly url: string;
  readonly local: string;
}

/** `<tag>/<file>` of every observed file, keyed like OBSERVED_PHASE2 (`<source>@<season>`). */
function upstreams(): Upstream[] {
  return Object.entries(OBSERVED_PHASE2).map(([key, o]) => {
    const ffo = o.url.startsWith(FFOPPORTUNITY_RELEASE_BASE);
    const rest = o.url.slice((ffo ? FFOPPORTUNITY_RELEASE_BASE : REL).length + 1);
    const [tag, file] = rest.split("/") as [string, string];
    return { key, url: o.url, local: join(DIR, `${ffo ? "ffopportunity" : tag}_${file}`) };
  });
}

function routes(): Map<string, Route> {
  const out = new Map<string, Route>();
  for (const u of upstreams()) {
    const bytes = readFileSync(u.local);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== OBSERVED_PHASE2[u.key]?.sha256)
      throw new Error(`${u.local}: not the observed file`);
    out.set(u.url, new Uint8Array(bytes));
  }
  for (const tag of ["stats_team", "pbp", "snap_counts", "depth_charts"]) {
    out.set(`${REL}/${tag}/timestamp.txt`, readFileSync(join(DIR, `${tag}_timestamp.txt`)));
  }
  out.set(
    `${FFOPPORTUNITY_RELEASE_BASE}/latest-data/timestamp.txt`,
    readFileSync(join(DIR, "ffopportunity_timestamp.txt")),
  );
  return out;
}

const open: Ctx[] = [];
const writers: SqliteWriter[] = [];
afterAll(() => {
  for (const w of writers.splice(0)) w.close();
  for (const c of open.splice(0)) c.cleanup();
});

async function run(
  source: DataSource,
  seasons: number[],
  r: Map<string, Route>,
): Promise<{ stats: NflversePublishStats; ms: number; w: SqliteWriter }> {
  const c = makeCtx(seasons, { routes: r });
  open.push(c);
  const t0 = performance.now();
  const v = await source.version(c.ctx);
  if (v === null) throw new Error("no version");
  const files = await source.fetch(v, c.ctx);
  const report = await source.assertSchema(files);
  expect(report.ok, report.warnings.join("\n")).toBe(true);
  const w = new SqliteWriter(c.tempDir);
  writers.push(w);
  const stats = (await source.publish(files, w)) as NflversePublishStats;
  return { stats, ms: performance.now() - t0, w };
}

const rowsOf = (s: NflversePublishStats): Record<string, number> =>
  Object.fromEntries(s.tables.map((t) => [t.name, t.rows]));

describe.skipIf(!enabled)("the Phase-2 sources over the real 2024–2026 release files", () => {
  const r = enabled ? routes() : new Map<string, Route>();
  const P = NFLVERSE_PHASE_2_SOURCES;

  it("stats_team_week: 128 rows (2026)", async () => {
    expect(rowsOf((await run(P["nflverse:stats_team_week"], [2026], r)).stats)).toEqual({
      ds_stats_team_week: 128,
    });
  });

  it("pbp: 9,640 kept / 1,515 dropped (2026)", async () => {
    const cur = await run(P["nflverse:pbp"], [2026], r);
    expect(rowsOf(cur.stats)).toEqual({ ds_pbp: 9640 });
    expect(cur.stats.warnings.join("\n")).toContain("dropped 1515 row(s)");
  });

  it("snap_counts: 5,970 (2026)", async () => {
    expect(rowsOf((await run(P["nflverse:snap_counts"], [2026], r)).stats)).toEqual({
      ds_snap_counts: 5970,
    });
  });

  it("depth_charts: 12,046 runs (2026)", async () => {
    const cur = await run(P["nflverse:depth_charts"], [2026], r);
    expect(rowsOf(cur.stats)).toEqual({ ds_depth_charts: 12046 });
    expect(cur.stats.warnings).toEqual([]);
    const current = cur.w.all(
      "SELECT COUNT(*) AS n FROM ds_depth_charts WHERE valid_to_ms IS NULL",
    )[0] as { n: number };
    expect(current.n).toBe(2288);
  });

  it("ep_weekly: 1,265 kept / 97 team-level (2026)", async () => {
    const cur = await run(epWeeklySource, [2026], r);
    expect(rowsOf(cur.stats)).toEqual({ ds_ep_weekly: 1265 });
    expect(cur.stats.warnings.join("\n")).toContain("dropped 97 row(s)");
  });
});
