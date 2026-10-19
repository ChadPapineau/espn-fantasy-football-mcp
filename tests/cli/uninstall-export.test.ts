// uninstall-export.test.ts — `eff uninstall` must never lose what it cannot rebuild (plan 03 §8 step 3:
// `--export-log` writes the recommendation log AND the snapshots as JSON before deletion; plan 03 L8:
// uninstall removes what the product made and says what it will not touch). Stage C findings
// uninstall-export-empty-then-deletes-log, uninstall-export-omits-snapshots,
// uninstall-malformed-config-blocks, uninstall-leftover-logs-recordings-tmp and (round 2)
// uninstall-export-skips-backups: the export holds every league's rows whatever the environment's
// league id (none here) — and the rows only a backup copy holds — a store that needs a migration or
// was written by a newer binary still exports, an export that cannot be written stops the uninstall
// with NOTHING changed, a malformed config.json does not block the credential/launchd/cache steps,
// and the jobs' logs, the raw recordings and interrupted-write temp files go too. Sandboxed HOME,
// config and cache dirs; an in-memory keyring; no network.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { logDir } from "../../src/cli/launchd.js";
import { main } from "../../src/cli/main.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import { EXPORT_TABLES, uninstall } from "../../src/cli/uninstall.js";
import type { RecordRecommendationInput } from "../../src/domain/reclog/types.js";
import { fakeCookies } from "../auth/helpers.js";
import { FakeKeyring, fakeExec, makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const COOKIES = fakeCookies("cli-uninstall-export");

const rec = (week: number, ref: string): RecordRecommendationInput => ({
  league_id: "0",
  season: 2026,
  kind: "lineup",
  week,
  rec: {
    action: "Start the higher projection",
    subjects: [],
    lineup: null,
    point_estimate: 1.5,
    distribution: {
      mean: 1,
      p10: 0,
      p25: 0,
      p50: 1,
      p75: 2,
      p90: 3,
      p_zero: 0.1,
      basis: "position_cv",
    },
    delta_vs_next: null as never,
    decision_metric: "expected_points",
    drivers: [],
    assumptions: [],
    confidence: "medium" as never,
    as_of: "2026-10-06T12:00:00.000Z",
    latest_execution_time: null,
    no_move: false,
    log_id: null,
  },
  alternatives: [],
  source_calls: [{ tool: "espn_analyze_lineup", request_id: `req-${ref}` }],
  settings_hash: "a".repeat(64),
  seeding_mode_used: null,
  followed_hint: "unknown",
  client_ref: ref,
  note: null,
});

/** A store recorded under league id 0 (as `ESPN_LEAGUE_ID=0` would), plus both credential stores. */
async function installed(): Promise<{ keyring: FakeKeyring }> {
  const keyring = new FakeKeyring();
  for (const a of ["espn_s2", "SWID", "meta"]) keyring.plant("espn-fantasy-football-mcp", a, "x");
  const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" }, keyring });
  const { config, log } = await loadLenientRuntime(io);
  const store = openStore(config, io.clock, log, { migrate: true });
  try {
    for (const [w, r] of [
      [4, "r-1"],
      [5, "r-2"],
      [5, "r-3"],
    ] as const)
      store.repos.recommendationLog.record(rec(w, r), "2026-10-06T12:00:00.000Z");
    store.repos.rosterSnapshots.put({
      team_id: 3,
      week: 5,
      taken_at: "2026-10-06T06:00:00.000Z",
      roster: { n: 1 } as never,
    });
    store.repos.poolSnapshots.put({ taken_at: "2026-10-06T07:00:00.000Z", week: 5, players: [] });
    store.repos.scoreboardSnapshots.put({
      week: 5,
      taken_at: "2026-10-04T16:00:00.000Z",
      matchups: [],
      playoff_pct_espn: { "1": 0.4 },
    });
    store.repos.espnProjections.putMany([
      {
        player_id: 7,
        season: 2026,
        week: 5,
        split: "weekly",
        applied_total: 11.5,
        stats_raw: {},
        snapshot_at: "2026-10-06T06:00:00.000Z",
      },
      {
        player_id: 7,
        season: 2026,
        week: null,
        split: "ros",
        applied_total: 140,
        stats_raw: {},
        snapshot_at: "2026-10-06T06:00:00.000Z",
      },
    ]);
  } finally {
    store.close();
  }
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(sb.configDir, "session.json"),
    sessionFileBody(COOKIES, metaFor(COOKIES, "2026-10-01T00:00:00.000Z")),
    { mode: 0o600 },
  );
  return { keyring };
}

const STORE = (): string => path.join(sb.cacheDir, "store.sqlite");

describe("--export-log keeps everything it cannot rebuild", () => {
  it("every league's recommendations AND the snapshots, with no ESPN_LEAGUE_ID in this shell", async () => {
    sb = sandbox();
    const { keyring } = await installed();
    // a new terminal: `eff setup` never records the league id, so none resolves here
    const io = makeIo(sb, { keyring, platform: "darwin", exec: fakeExec().exec });
    const { config, log } = await loadLenientRuntime(io);
    expect(config.leagueId).toBeNull();
    const dest = path.join(sb.dir, "export.json");
    const opts = { yes: true, dryRun: false, keepConfig: false, exportLog: dest };
    expect(await uninstall(io, config, log, opts)).toBe(0);
    const doc = JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown[]>;
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(doc.recommendation_log).toHaveLength(3);
    expect(doc.recommendation_log?.[0]).toMatchObject({ league_id: "0", season: 2026 });
    expect(doc.roster_snapshot).toHaveLength(1);
    expect(doc.pool_snapshot).toHaveLength(1);
    expect(doc.scoreboard_snapshot).toHaveLength(1);
    expect(doc.espn_projection).toHaveLength(2);
    for (const t of EXPORT_TABLES) expect(Object.keys(doc)).toContain(t);
    // JSON columns are exported as JSON, not as strings
    expect(doc.scoreboard_snapshot?.[0]).toMatchObject({ playoff_pct: { "1": 0.4 } });
    expect(io.out.text).toContain("exported 3 recommendation(s)");
    // and only then the cache went
    expect(existsSync(STORE())).toBe(false);
  });

  it("a store written by a newer binary (or with a migration pending) still exports before the purge", async () => {
    sb = sandbox();
    const { keyring } = await installed();
    const db = new DatabaseSync(STORE());
    db.exec(
      "INSERT INTO schema_version (version, applied_at) VALUES (99, '2026-10-06T00:00:00.000Z')",
    );
    db.close();
    const io = makeIo(sb, { keyring });
    const { config, log } = await loadLenientRuntime(io);
    const dest = path.join(sb.dir, "newer.json");
    expect(
      await uninstall(io, config, log, {
        yes: true,
        dryRun: false,
        keepConfig: false,
        exportLog: dest,
      }),
    ).toBe(0);
    const doc = JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown>;
    expect(doc.schema_version).toBe(99);
    expect(doc.recommendation_log).toHaveLength(3);
    expect(io.out.text).not.toContain("no store to export from");
  });

  it("a store that cannot be read stops the uninstall: NOTHING is changed", async () => {
    sb = sandbox();
    const { keyring } = await installed();
    writeFileSync(STORE(), "this is not a sqlite database at all, just bytes".repeat(200));
    const io = makeIo(sb, { keyring });
    const { config, log } = await loadLenientRuntime(io);
    const dest = path.join(sb.dir, "x.json");
    expect(
      await uninstall(io, config, log, {
        yes: true,
        dryRun: false,
        keepConfig: false,
        exportLog: dest,
      }),
    ).toBe(1);
    expect(io.err.text).toContain("the export failed");
    expect(io.err.text).toContain("nothing was changed");
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(STORE())).toBe(true);
    expect(existsSync(path.join(sb.configDir, "session.json"))).toBe(true);
    expect(keyring.items.size).toBe(3);
  });
});

// Stage C finding uninstall-export-skips-backups: the purge deletes the backups too, and rows can live
// only there (a store moved aside, or started anew, as doctor's old advice said)
describe("--export-log also exports what only the backups hold", () => {
  const BACKUP = (): string => path.join(sb.cacheDir, "backups", "store-2026-10-06.sqlite");
  /** The installed store, plus one weekly backup of it. */
  async function withBackup(): Promise<{ keyring: FakeKeyring }> {
    const r = await installed();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      await store.backup(BACKUP());
    } finally {
      store.close();
    }
    return r;
  }
  const run = async (keyring: FakeKeyring, dest: string) => {
    const io = makeIo(sb, { keyring });
    const { config, log } = await loadLenientRuntime(io);
    const code = await uninstall(io, config, log, {
      yes: true,
      dryRun: false,
      keepConfig: false,
      exportLog: dest,
    });
    return { code, io };
  };
  type Doc = Record<string, unknown> & {
    recommendation_log: unknown[];
    backups: (Record<string, unknown[]> & { file: string; rows: Record<string, number | null> })[];
  };
  it("store.sqlite moved aside: the backup's log is exported before the backup is deleted", async () => {
    sb = sandbox();
    const { keyring } = await withBackup();
    renameSync(STORE(), `${STORE()}.moved-aside`);
    const dest = path.join(sb.dir, "export.json");
    const { code, io } = await run(keyring, dest);
    expect(code).toBe(0);
    const doc = JSON.parse(readFileSync(dest, "utf8")) as Doc;
    expect(doc.recommendation_log).toEqual([]);
    expect(doc.backups).toHaveLength(1);
    expect(doc.backups[0]?.file).toBe("store-2026-10-06.sqlite");
    expect(doc.backups[0]?.recommendation_log).toHaveLength(3);
    expect(doc.backups[0]?.rows.recommendation_log).toBe(3);
    expect(doc.backups[0]?.pool_snapshot).toHaveLength(1);
    expect(io.out.text).toContain("no store.sqlite — exporting what only the backups hold");
    expect(io.out.text).toContain("exported 3 recommendation(s)");
    expect(existsSync(BACKUP())).toBe(false);
    // what uninstall does not own stays (and keeps the cache dir)
    expect(existsSync(`${STORE()}.moved-aside`)).toBe(true);
  });
  it("a store started anew: its rows at the top, the backup-only rows under backups", async () => {
    sb = sandbox();
    const { keyring } = await withBackup();
    rmSync(STORE(), { force: true });
    const io0 = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    const { config, log } = await loadLenientRuntime(io0);
    const fresh = openStore(config, io0.clock, log, { migrate: true });
    try {
      fresh.repos.recommendationLog.record(rec(6, "r-new"), "2026-10-13T12:00:00.000Z");
    } finally {
      fresh.close();
    }
    const dest = path.join(sb.dir, "export.json");
    const { code, io } = await run(keyring, dest);
    expect(code).toBe(0);
    const doc = JSON.parse(readFileSync(dest, "utf8")) as Doc;
    expect(doc.recommendation_log).toHaveLength(1);
    expect(doc.backups[0]?.recommendation_log).toHaveLength(3);
    expect(io.out.text).toContain("exported 1 recommendation(s)");
    expect(io.out.text).toContain("plus, found only in 3 recommendation(s)");
  });
  it("--dry-run names the backup copies it would export; with neither a store nor a backup there is nothing to export", async () => {
    sb = sandbox();
    const { keyring } = await withBackup();
    const io = makeIo(sb, { keyring });
    const { config, log } = await loadLenientRuntime(io);
    const dest = path.join(sb.dir, "dry.json");
    const dry = { yes: false, dryRun: true, keepConfig: false, exportLog: dest };
    expect(await uninstall(io, config, log, dry)).toBe(0);
    expect(io.out.text).toContain(
      `would export the recommendation log and snapshots (store.sqlite and 1 backup copy) to ${dest}`,
    );
    expect(existsSync(dest)).toBe(false);
    rmSync(STORE(), { force: true });
    rmSync(BACKUP(), { force: true });
    const none = makeIo(sb, { keyring });
    const r = await loadLenientRuntime(none);
    expect(await uninstall(none, r.config, r.log, { ...dry, dryRun: false, yes: true })).toBe(0);
    expect(none.out.text).toContain("no store.sqlite and no backup — nothing recorded to export");
    expect(existsSync(dest)).toBe(false);
  });
  it("rows the live store still holds are not exported twice; an unreadable backup stops the uninstall", async () => {
    sb = sandbox();
    const { keyring } = await withBackup();
    const dest = path.join(sb.dir, "export.json");
    const { code } = await run(keyring, dest);
    expect(code).toBe(0);
    const doc = JSON.parse(readFileSync(dest, "utf8")) as Doc;
    expect(doc.recommendation_log).toHaveLength(3);
    expect(doc.backups[0]?.rows).toEqual(Object.fromEntries(EXPORT_TABLES.map((t) => [t, 0])));
    // a backup that cannot be read: nothing is changed (its rows could not be kept)
    sb.cleanup();
    sb = sandbox();
    const second = await withBackup();
    writeFileSync(BACKUP(), "not a database".repeat(400));
    const bad = path.join(sb.dir, "bad.json");
    const r = await run(second.keyring, bad);
    expect(r.code).toBe(1);
    expect(r.io.err.text).toContain(
      "the export failed: backup store-2026-10-06.sqlite cannot be read (ERR_SQLITE_ERROR 26) — nothing was changed",
    );
    expect(existsSync(bad)).toBe(false);
    expect(existsSync(BACKUP())).toBe(true);
    expect(existsSync(STORE())).toBe(true);
    expect(second.keyring.items.size).toBe(3);
  });
});

describe("a malformed config.json does not block uninstall", () => {
  it("credentials, jobs and data are still removed; what cannot be known is said", async () => {
    sb = sandbox();
    const { keyring } = await installed();
    writeFileSync(path.join(sb.configDir, "config.json"), JSON.stringify({ ESPN_SEASON: 2026 }), {
      mode: 0o600,
    });
    const io = makeIo(sb, { keyring });
    expect(await main(["uninstall", "--yes"], io)).toBe(0);
    expect(io.out.text).toContain("config.json could not be read");
    expect(io.out.text).toContain("ESPN_SEASON");
    expect(keyring.items.size).toBe(0);
    expect(existsSync(path.join(sb.configDir, "session.json"))).toBe(false);
    expect(existsSync(STORE())).toBe(false);
    expect(existsSync(path.join(sb.configDir, "config.json"))).toBe(false);
    // truncated JSON too
    sb.cleanup();
    sb = sandbox();
    const second = await installed();
    writeFileSync(path.join(sb.configDir, "config.json"), '{"ESPN_SEA', { mode: 0o600 });
    const io2 = makeIo(sb, { keyring: second.keyring });
    expect(await main(["uninstall", "--yes"], io2)).toBe(0);
    expect(second.keyring.items.size).toBe(0);
  });
});

describe("leftovers: job logs, raw recordings, interrupted-write temp files", () => {
  it("are removed with their step (and listed by --dry-run)", async () => {
    sb = sandbox();
    const { keyring } = await installed();
    const logs = logDir(sb.home);
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(logs, "snapshot-roster.log"), "a job line\n");
    writeFileSync(path.join(logs, "probe.log"), "a job line\n");
    const rec = path.join(sb.cacheDir, "recordings", "2026-10-05");
    mkdirSync(rec, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(rec, "mTeam.json"), "{}");
    const hist = path.join(sb.cacheDir, "recordings", "history-2026-10-05");
    mkdirSync(hist, { recursive: true, mode: 0o700 });
    const cfgTmp = path.join(sb.configDir, "config.json.4242.0123456789ab.tmp");
    writeFileSync(cfgTmp, "{}", { mode: 0o600 });
    const stateTmp = path.join(sb.cacheDir, "job-state.json.4242.0123456789ab.tmp");
    writeFileSync(stateTmp, "{}", { mode: 0o600 });
    const dry = makeIo(sb, { keyring, platform: "darwin", exec: fakeExec().exec });
    const d = await loadLenientRuntime(dry);
    expect(
      await uninstall(dry, d.config, d.log, {
        yes: false,
        dryRun: true,
        keepConfig: false,
        exportLog: undefined,
      }),
    ).toBe(0);
    expect(dry.out.text).toContain(`would delete ${path.join(logs, "snapshot-roster.log")}`);
    expect(dry.out.text).toContain(path.join(sb.cacheDir, "recordings"));
    expect(dry.out.text).toContain(cfgTmp);
    const io = makeIo(sb, { keyring, platform: "darwin", exec: fakeExec().exec });
    const { config, log } = await loadLenientRuntime(io);
    expect(
      await uninstall(io, config, log, {
        yes: true,
        dryRun: false,
        keepConfig: false,
        exportLog: undefined,
      }),
    ).toBe(0);
    expect(existsSync(logs)).toBe(false);
    expect(existsSync(path.join(sb.cacheDir, "recordings"))).toBe(false);
    expect(existsSync(cfgTmp)).toBe(false);
    expect(existsSync(stateTmp)).toBe(false);
    expect(existsSync(sb.cacheDir)).toBe(false);
    expect(existsSync(sb.configDir)).toBe(false);
  });
});
