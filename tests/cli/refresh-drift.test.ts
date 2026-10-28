// refresh-drift.test.ts — `eff refresh espn:drift` (src/cli/refresh-drift.ts; plan 01 §7: drift is
// a fact about the latest answer of a view). The final gate found drift red for 16 days on
// mPendingTransactions — a view the daily probe never reads (its shape probe is keyless and skipped
// on a private league) — while every probe since was green: `eff probe` and `eff doctor --online`
// exited 4, doctor's fix ("run eff probe and read the diff") went in a circle, the probe printed no
// diff, and only a tool call that re-read the view cleared it. Here: the command re-reads each red
// view through the provider (one request per view), clears what ESPN serves again and keeps what is
// still missing; doctor #9 names it for a view the probe never reads; the probe prints the stored
// red diff with it. The recorded league-a stand-in (league id 0, keyless): no cookie is sent.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDrift } from "../../src/cli/doctor.js";
import {
  DRIFT_REFRESH_TARGET,
  PROBE_VIEWS,
  redViewsOutsideProbe,
} from "../../src/cli/drift-recheck.js";
import { main } from "../../src/cli/main.js";
import { targetUsageError } from "../../src/cli/refresh.js";
import { DRIFT_REREADS, type DriftRefreshReport } from "../../src/cli/refresh-drift.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import { parseDiffs } from "../../src/drift/index.js";
import type { DriftStateRow } from "../../src/drift/types.js";
import { LEAGUE_VIEWS } from "../../src/providers/espn/types.js";
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
const rec = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(REC, rel), "utf8")) as Record<string, unknown>;
const jsonRes = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const ENV = {
  ESPN_LEAGUE_ID: "0",
  EFF_CREDENTIAL_STORE: "file",
  ESPN_SEASON: "2026",
  ESPN_TEAM_ID: "1",
};

/**
 * The league-a stand-in: mSettings + mNav for the league read; mPendingTransactions as ESPN answers
 * a recognised view (the base league body, `draftDetail` included) — or, with `pending: "skeleton"`,
 * as it answers a view it no longer recognises (members + teams, no draftDetail: still drift).
 */
function leagueA(pending: "ok" | "skeleton") {
  return fakeFetch((url) => {
    const u = new URL(url);
    if (!u.pathname.includes("/leagues/0")) return new Response(null, { status: 404 });
    const views = u.searchParams.getAll("view");
    if (views.includes("mPendingTransactions")) {
      const nav = rec("league-a/mNav.json");
      return jsonRes(
        pending === "ok"
          ? { ...nav, pendingTransactions: [] }
          : { members: nav.members, teams: nav.teams },
      );
    }
    const body: Record<string, unknown> = {};
    for (const v of views) {
      if (v === "mSettings") Object.assign(body, rec("league-a/mSettings.json"));
      else if (v === "mNav") Object.assign(body, { ...rec("league-a/mNav.json"), ...body });
      else return jsonRes({ messages: ["no fixture"] }, 404);
    }
    return jsonRes(body);
  });
}

/** The red row of the gate: mPendingTransactions' list missing (the F2 event). */
function redRow(diff: readonly { view: string; removed: string[] }[]): DriftStateRow {
  return {
    status: "red",
    since: "2026-10-01T21:51:00.000Z",
    last_probe_at: null,
    manifest_hash: null,
    manifest_version: null,
    host: "lm-api-reads.fantasy.espn.com",
    host_moved_at: null,
    diff_json: JSON.stringify(diff.map((d) => ({ ...d, added: [], enums: [] }))),
    additive_json: "[]",
    updated_at: "2026-10-01T21:51:00.000Z",
  };
}

async function seed(row: DriftStateRow): Promise<void> {
  const io = makeIo(sb, { env: ENV });
  const { config, log } = await loadLenientRuntime(io);
  const store = openStore(config, io.clock, log, { migrate: true });
  try {
    store.repos.driftState.put(row);
  } finally {
    store.close();
  }
}

async function stored(): Promise<DriftStateRow | null> {
  const io = makeIo(sb, { env: ENV });
  const { config, log } = await loadLenientRuntime(io);
  const store = openStore(config, io.clock, log, { migrate: false });
  try {
    return store.repos.driftState.get();
  } finally {
    store.close();
  }
}

async function run(pending: "ok" | "skeleton", extra: readonly string[] = []) {
  const f = leagueA(pending);
  const { exec } = fakeExec();
  const io = makeIo(sb, {
    fetch: f.fetch,
    clock: movingClock("2026-10-06T18:00:00.000Z"),
    platform: "darwin",
    exec,
    packageRoot: fakePackage(sb),
    env: ENV,
  });
  const code = await main(["refresh", DRIFT_REFRESH_TARGET, ...extra], io);
  for (const init of f.inits) expect(new Headers(init.headers).has("cookie")).toBe(false);
  return { code, io, urls: f.urls };
}

const PENDING_RED = [{ view: "mPendingTransactions", removed: ["$.pendingTransactions"] }];

describe("eff refresh espn:drift re-judges the views drift_state marks red (Stage C final gate)", () => {
  it("a red view the probe never reads: one re-read, cleared when ESPN serves it again (exit 0)", async () => {
    sb = sandbox();
    await seed(redRow(PENDING_RED));
    const r = await run("ok", ["--json"]);
    expect(r.code).toBe(0);
    expect(r.urls.filter((u) => u.includes("view=mPendingTransactions"))).toHaveLength(1);
    const report = JSON.parse(r.io.out.text.trim()) as DriftRefreshReport;
    expect(report).toMatchObject({ target: "espn:drift", before: "red" });
    expect(report.after).not.toBe("red");
    expect(report.views).toEqual([
      { view: "mPendingTransactions", outcome: "cleared", removed: [], reason: null },
    ]);
    const row = await stored();
    expect(row?.status).not.toBe("red");
    expect(parseDiffs(row?.diff_json ?? "[]").every((d) => d.removed.length === 0)).toBe(true);
  });

  it("a key still missing stays red: said, exit 4", async () => {
    sb = sandbox();
    await seed(redRow(PENDING_RED));
    const r = await run("skeleton");
    expect(r.code).toBe(4);
    expect(r.io.out.text).toContain("mPendingTransactions: still red");
    expect(r.io.out.text).toContain("drift_state: red → red");
    expect((await stored())?.status).toBe("red");
  });

  it("a view no read of this build requests is named, never guessed at; nothing red is a no-op", async () => {
    sb = sandbox();
    await seed(redRow([{ view: "mScoreboard", removed: ["$.schedule[].home.totalPoints"] }]));
    const r = await run("ok", ["--json"]);
    expect(r.code).toBe(4);
    const report = JSON.parse(r.io.out.text.trim()) as DriftRefreshReport;
    expect(report.views).toEqual([
      {
        view: "mScoreboard",
        outcome: "not_read",
        removed: ["$.schedule[].home.totalPoints"],
        reason: "no_read",
      },
    ]);
    expect(r.urls.some((u) => u.includes("mScoreboard"))).toBe(false);
    sb.cleanup();
    sb = sandbox();
    const none = await run("ok");
    expect(none.code).toBe(0);
    expect(none.io.out.text).toContain("espn:drift: no view is red");
    expect(none.urls).toEqual([]);
  });

  it("a read ESPN fails (a copy served from the cache, or an error) is named not re-read, for each view it serves", async () => {
    sb = sandbox();
    await seed(
      redRow([
        { view: "mSettings", removed: ["$.settings.scoringSettings"] },
        { view: "mNav", removed: ["$.members[].isLeagueCreator"] },
        ...PENDING_RED,
      ]),
    );
    // ESPN answers nothing: every read fails, the week's league read among them
    const f = fakeFetch(
      () => new Response("down", { status: 503, headers: { "content-type": "text/plain" } }),
    );
    const { exec } = fakeExec();
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-06T18:00:00.000Z"),
      platform: "darwin",
      exec,
      packageRoot: fakePackage(sb),
      env: ENV,
    });
    const code = await main(["refresh", DRIFT_REFRESH_TARGET, "--json"], io);
    expect(code, `${io.out.text} | ${io.err.text} | ${f.urls.join(" ; ")}`).toBe(4);
    const report = JSON.parse(io.out.text.trim().split("\n").pop() ?? "{}") as DriftRefreshReport;
    expect(report.views.map((v) => [v.view, v.outcome])).toEqual([
      ["mSettings", "not_read"],
      ["mNav", "not_read"],
      ["mPendingTransactions", "not_read"],
    ]);
    for (const v of report.views) expect(v.reason, v.view).toMatch(/^[A-Z_]+$/);
    expect((await stored())?.status).toBe("red");
  });

  it("a copy the cache served because ESPN failed is never taken as re-judged", async () => {
    sb = sandbox();
    await seed(redRow(PENDING_RED));
    expect((await run("ok")).code).toBe(0); // the views are cached now
    await seed(redRow(PENDING_RED)); // red again; ESPN then fails every request
    const f = fakeFetch(
      () => new Response("down", { status: 503, headers: { "content-type": "text/plain" } }),
    );
    const { exec } = fakeExec();
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-06T18:10:00.000Z"),
      platform: "darwin",
      exec,
      packageRoot: fakePackage(sb),
      env: ENV,
    });
    expect(await main(["refresh", DRIFT_REFRESH_TARGET, "--json"], io)).toBe(4);
    const report = JSON.parse(io.out.text.trim().split("\n").pop() ?? "{}") as DriftRefreshReport;
    expect(report.views.map((v) => [v.view, v.outcome, v.removed])).toEqual([
      ["mPendingTransactions", "not_read", ["$.pendingTransactions"]],
    ]);
    expect(report.views[0]?.reason).toMatch(/^[A-Z_]+$/);
  });

  it("mSettings still missing a key: the league read itself is the judgement — red, exit 4, never a crash", async () => {
    sb = sandbox();
    await seed(redRow([{ view: "mSettings", removed: ["$.settings.scheduleSettings"] }]));
    const f = fakeFetch((url) => {
      const u = new URL(url);
      if (!u.pathname.includes("/leagues/0")) return new Response(null, { status: 404 });
      const s = rec("league-a/mSettings.json") as { settings: Record<string, unknown> };
      const { scheduleSettings: _gone, ...settings } = s.settings;
      return jsonRes({ ...rec("league-a/mNav.json"), ...s, settings });
    });
    const { exec } = fakeExec();
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-06T18:00:00.000Z"),
      platform: "darwin",
      exec,
      packageRoot: fakePackage(sb),
      env: ENV,
    });
    expect(await main(["refresh", DRIFT_REFRESH_TARGET], io)).toBe(4);
    expect(io.out.text).toContain("mSettings: still red — removed $.settings.scheduleSettings");
  });

  it("is a listed target; --seasons, --force and --game-day-cadence are refused", async () => {
    sb = sandbox();
    expect(targetUsageError("nope").message).toContain(DRIFT_REFRESH_TARGET);
    for (const extra of [["--seasons", "2025"], ["--force"], ["--game-day-cadence"]]) {
      const r = await run("ok", extra);
      expect(r.code, extra.join(" ")).toBe(2);
      expect(r.urls).toEqual([]);
    }
  });

  it("every league view a tool or job reads has a re-read; the rest are named", () => {
    const without = LEAGUE_VIEWS.filter((v) => DRIFT_REREADS[v] === undefined);
    expect(without).toEqual(["mScoreboard", "mDraftDetail"]);
    for (const v of PROBE_VIEWS) expect(DRIFT_REREADS[v], v).toBeDefined();
  });
});

describe("doctor #9 and the probe name the re-check for a view the probe never reads", () => {
  it("doctor: `eff refresh espn:drift` for mPendingTransactions; `eff probe` for the probe's views", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: ENV });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      store.repos.driftState.put(redRow(PENDING_RED));
      const outside = checkDrift(store, io.clock.nowMs());
      expect(outside.status).toBe("drift");
      expect(outside.fix).toContain("eff refresh espn:drift");
      expect(outside.fix).toContain("mPendingTransactions");
      expect(outside.details.join(" ")).toContain(
        "mPendingTransactions: removed $.pendingTransactions",
      );
      store.repos.driftState.put(redRow([{ view: "mSettings", removed: ["$.settings.x"] }]));
      expect(checkDrift(store, io.clock.nowMs()).fix).toBe(
        "run `eff probe` and read the diff (plan 01 §7)",
      );
    } finally {
      store.close();
    }
    expect(redViewsOutsideProbe(redRow(PENDING_RED).diff_json)).toEqual(["mPendingTransactions"]);
  });

  it("the probe prints the stored red diff and the command, and exits 4 (it cannot clear it)", async () => {
    sb = sandbox();
    await seed(redRow(PENDING_RED));
    const f = fakeFetch((url) => {
      const u = new URL(url);
      if (u.pathname.includes("/leagues/")) return new Response(null, { status: 401 });
      return jsonRes(rec("season/proTeamSchedules_wl.json"));
    });
    const { exec } = fakeExec();
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-06T18:00:00.000Z"),
      platform: "darwin",
      exec,
      packageRoot: fakePackage(sb),
      env: ENV,
    });
    const code = await main(["probe"], io);
    expect(code).toBe(4);
    expect(io.out.text).toContain(
      "red (stored): mPendingTransactions: removed $.pendingTransactions",
    );
    expect(io.out.text).toContain("`eff refresh espn:drift` re-reads them");
    const jsonIo = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-06T19:00:00.000Z"),
      platform: "darwin",
      exec,
      packageRoot: fakePackage(sb),
      env: ENV,
    });
    expect(await main(["probe", "--json"], jsonIo)).toBe(4);
    const out = JSON.parse(jsonIo.out.text.trim()) as {
      stored_red: { view: string; removed: string[] }[];
      recheck: string | null;
    };
    expect(out.stored_red).toEqual([
      { view: "mPendingTransactions", removed: ["$.pendingTransactions"] },
    ]);
    expect(out.recheck).toBe("eff refresh espn:drift");
  });
});
