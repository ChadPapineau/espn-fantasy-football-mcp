// job-runs.test.ts — every run of a credentialed job is recorded and visible (plan 06 J2: "one row
// per run … plus `eff status`", failure must be visible without reading logs; §1.4 a failed run is
// `ok = 0`; §3 `eff status` goes red on a failing job, a stale probe or missing snapshots; plan 03
// §5 #11 doctor shows each job's last run). Stage C finding jobs-no-refresh-log-rows: the jobs wrote
// nothing, so a job failing every night showed as "[ok] … loaded". ESPN answers come from an
// injected fetch (league views 404 → a fast failure); launchctl is a fake executor.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLaunchd } from "../../src/cli/doctor.js";
import { jobRunRecords, readJobState, recordJobRun } from "../../src/cli/job-state.js";
import { launchAgentsDir, plistPath } from "../../src/cli/launchd.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { snapshotRoster } from "../../src/cli/snapshot.js";
import {
  PROBE_STALE_MS,
  RECORDED_JOBS,
  collectStatus,
  renderStatus,
  statusAlerts,
} from "../../src/cli/status.js";
import { openStore } from "../../src/cli/store-access.js";
import {
  ROOT,
  fakeExec,
  fakeFetch,
  fakePackage,
  makeIo,
  movingClock,
  sandbox,
  type Sandbox,
} from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const REC = path.join(ROOT, "fixtures", "espn", "recorded");
const schedule = (): Response =>
  new Response(readFileSync(path.join(REC, "season", "proTeamSchedules_wl.json"), "utf8"), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** ESPN where the league is gone (404 — never retried): every working run fails at once. */
const broken = () =>
  fakeFetch((url) =>
    url.includes("proTeamSchedules_wl")
      ? schedule()
      : new Response(JSON.stringify({ messages: ["not found"] }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
  );

async function nightly(at: string): Promise<{ code: number; text: string }> {
  const f = broken();
  const io = makeIo(sb, {
    fetch: f.fetch,
    clock: movingClock(at),
    platform: "darwin",
    exec: fakeExec().exec,
    packageRoot: fakePackage(sb),
    env: {
      ESPN_LEAGUE_ID: "0",
      EFF_CREDENTIAL_STORE: "file",
      ESPN_SEASON: "2026",
      ESPN_TEAM_ID: "1",
    },
  });
  const { config, log } = await loadRuntime(io);
  const code = await snapshotRoster(io, config, log, { notify: true, preKickoff: false });
  return { code, text: io.err.text + io.out.text };
}

describe("credentialed job runs are recorded", () => {
  it("three failing nights: each run recorded; status and doctor #11 name the job and its error", async () => {
    sb = sandbox();
    for (const at of [
      "2026-10-06T06:00:00.000Z",
      "2026-10-07T06:00:00.000Z",
      "2026-10-08T06:00:00.000Z",
    ]) {
      const r = await nightly(at);
      expect(r.code).toBe(1);
    }
    const rec = jobRunRecords(readJobState(sb.cacheDir), ["snapshot-roster"])[0];
    const code = rec?.error ?? "";
    expect(code).toMatch(/^ESPN_[A-Z_]+$/);
    expect(rec).toMatchObject({
      job: "snapshot-roster",
      ok: false,
      consecutive_failures: 3,
      last_run_at: expect.stringMatching(/^2026-10-08T06:00/) as unknown,
    });

    // eff status: the job, its last error, and an alert
    const io = makeIo(sb, {
      clock: movingClock("2026-10-08T07:00:00.000Z"),
      env: { ESPN_LEAGUE_ID: "0", ESPN_TEAM_ID: "1" },
    });
    const { config, log } = await loadRuntime(io);
    const report = collectStatus(io, config, log);
    expect(report.jobs.find((j) => j.job === "snapshot-roster")).toMatchObject({
      ok: false,
      error: code,
      consecutive_failures: 3,
    });
    expect(report.alerts).toContain("job_failing:snapshot-roster");
    expect(report.jobs.map((j) => j.job)).toEqual(RECORDED_JOBS);
    const text = renderStatus(report).join("\n");
    expect(text).toContain(`FAILED (${code})`);
    expect(text).toContain("ALERT: snapshot-roster failed on its last run");

    // doctor #11: the job is loaded but its last run failed → warn, with the error named
    mkdirSync(launchAgentsDir(sb.home), { recursive: true });
    writeFileSync(plistPath(sb.home, "snapshot-roster"), "<plist/>");
    const mac = makeIo(sb, {
      platform: "darwin",
      exec: fakeExec().exec,
      clock: movingClock("2026-10-08T07:00:00.000Z"),
      env: { ESPN_LEAGUE_ID: "0" },
    });
    const store = openStore(config, mac.clock, log, { migrate: false });
    try {
      const row = await checkLaunchd(mac, config, store);
      expect(row.status).toBe("warn");
      expect(row.message).toContain("1 job(s) failed on their last run");
      expect(row.details.join("\n")).toContain(
        `snapshot-roster: loaded; last run FAILED (${code})`,
      );
    } finally {
      store.close();
    }
  });

  it("a worked run resets the failure count; an idle wake keeps the last run and stamps the wake", () => {
    sb = sandbox({ create: true });
    recordJobRun(sb.cacheDir, "transactions", 1000, {
      ok: false,
      error: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    recordJobRun(sb.cacheDir, "transactions", 2000, {
      ok: false,
      error: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    expect(
      jobRunRecords(readJobState(sb.cacheDir), ["transactions"])[0]?.consecutive_failures,
    ).toBe(2);
    recordJobRun(sb.cacheDir, "transactions", 3000, { ok: true });
    expect(jobRunRecords(readJobState(sb.cacheDir), ["transactions"])[0]).toMatchObject({
      ok: true,
      error: null,
      consecutive_failures: 0,
    });
    // a free-text error never lands in the state file (fixed vocabulary only)
    recordJobRun(sb.cacheDir, "transactions", 4000, { ok: false, error: "has spaces and <tags>" });
    expect(jobRunRecords(readJobState(sb.cacheDir), ["transactions"])[0]?.error).toBe("error");
  });

  it("status alerts: a stale probe, snapshots missing in season, a failing job (plan 06 §3)", () => {
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    const fresh = new Date(now - 3_600_000).toISOString();
    const base = {
      nowMs: now,
      lastProbeSuccessAt: fresh,
      inSeason: true,
      leagueConfigured: true,
      teamKnown: true,
      snapshots: { roster_last_at: fresh, pool_last_at: fresh, projections_last_at: fresh },
      jobs: [],
    };
    expect(statusAlerts(base)).toEqual([]);
    expect(
      statusAlerts({
        ...base,
        lastProbeSuccessAt: new Date(now - PROBE_STALE_MS - 1).toISOString(),
      }),
    ).toEqual(["probe_stale"]);
    expect(statusAlerts({ ...base, lastProbeSuccessAt: null })).toEqual(["probe_stale"]);
    expect(
      statusAlerts({ ...base, snapshots: { ...base.snapshots, roster_last_at: null } }),
    ).toEqual(["snapshots_missing"]);
    // off-season nothing is missing
    expect(
      statusAlerts({
        ...base,
        inSeason: false,
        snapshots: { ...base.snapshots, roster_last_at: null },
      }),
    ).toEqual([]);
  });
});

describe("concurrent jobs never lose each other's state (the job-state lock)", () => {
  const run = (dir: string, tag: string, n: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(ROOT, "tests", "cli", "procs", "job-state-child.ts"),
          dir,
          tag,
          String(n),
        ],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      p.on("error", reject);
      p.on("close", () => {
        resolve(Number(out.trim()));
      });
    });
  it("two processes updating at once: every key of both survives", async () => {
    sb = sandbox({ create: true });
    const [a, b] = await Promise.all([run(sb.cacheDir, "a", 40), run(sb.cacheDir, "b", 40)]);
    expect([a, b]).toEqual([40, 40]);
    const keys = Object.keys(readJobState(sb.cacheDir));
    expect(keys.filter((k) => k.startsWith("w.a.")).length).toBe(40);
    expect(keys.filter((k) => k.startsWith("w.b.")).length).toBe(40);
  }, 60_000);
});
