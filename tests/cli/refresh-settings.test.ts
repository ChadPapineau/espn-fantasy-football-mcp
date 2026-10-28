// refresh-settings.test.ts — `eff refresh espn:settings` (plan 08 §9 "Invalidation triggers … `eff
// refresh espn:settings`"; src/cli/refresh-settings.ts). Stage C finding
// cache-settings-invalidation-triggers-missing: the documented target answered "unknown target", so a
// commissioner's scoring edit stayed unseen for up to the settings' 24 h TTL. Here a first run records
// the settings; two hours later — inside the TTL, where every read serves the cached copy — the
// commissioner makes passing TDs worth 6, and the command re-reads them at once: one mSettings request,
// the new settings recorded, `settings_changed` raised with the scoring changed. The recorded league-a
// stand-in (league id 0, keyless): no request leaves the process; no cookie is sent.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";
import { SETTINGS_REFRESH_TARGET, targetUsageError } from "../../src/cli/refresh.js";
import type { SettingsRefreshReport } from "../../src/cli/refresh-settings.js";
import { loadRuntime } from "../../src/cli/runtime.js";
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
const rec = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(REC, rel), "utf8")) as Record<string, unknown>;
const jsonRes = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** league-a's mSettings; with `passTd` the commissioner's edit to statId 4 (passing TD points). */
function settings(passTd: number | null): Record<string, unknown> {
  const s = rec("league-a/mSettings.json") as {
    settings: { scoringSettings: { scoringItems: { statId: number; points: number }[] } };
  };
  if (passTd !== null)
    for (const item of s.settings.scoringSettings.scoringItems)
      if (item.statId === 4) item.points = passTd;
  return s;
}

/** The league-a stand-in for a settings read (mSettings + mNav), keyless. */
function leagueA(passTd: number | null) {
  return fakeFetch((url) => {
    const u = new URL(url);
    if (!u.pathname.includes("/leagues/0")) return new Response(null, { status: 404 });
    const views = u.searchParams.getAll("view");
    const body: Record<string, unknown> = {};
    for (const v of views) {
      if (v === "mSettings") Object.assign(body, settings(passTd));
      else if (v === "mNav") Object.assign(body, { ...rec("league-a/mNav.json"), ...body });
      else return jsonRes({ messages: ["no fixture"] }, 404);
    }
    return jsonRes(body);
  });
}

/** One `eff refresh espn:settings` run, as its own process (its own clock, provider and store). */
async function run(at: string, passTd: number | null, extra: readonly string[] = []) {
  const f = leagueA(passTd);
  const { exec } = fakeExec();
  const io = makeIo(sb, {
    fetch: f.fetch,
    clock: movingClock(at),
    platform: "darwin",
    exec,
    packageRoot: fakePackage(sb),
    env: {
      ESPN_LEAGUE_ID: "0",
      EFF_CREDENTIAL_STORE: "file",
      ESPN_SEASON: "2026",
      ESPN_TEAM_ID: "1",
    },
  });
  const code = await main(["refresh", SETTINGS_REFRESH_TARGET, ...extra], io);
  for (const init of f.inits) expect(new Headers(init.headers).has("cookie")).toBe(false);
  return { code, io, urls: f.urls };
}

describe("eff refresh espn:settings re-reads the settings now (Stage C cache-settings-invalidation-triggers-missing)", () => {
  it("inside the 24 h TTL a commissioner's scoring edit is read at once and raises settings_changed", async () => {
    sb = sandbox();
    const first = await run("2026-10-06T18:00:00.000Z", null);
    expect(first.code).toBe(0);
    expect(first.io.out.text).toContain("espn:settings re-read: unchanged");
    // two hours later — the cached settings are fresh by their TTL — passing TDs become 6 points
    const second = await run("2026-10-06T20:00:00.000Z", 6, ["--json"]);
    expect(second.code).toBe(0);
    expect(second.urls.filter((u) => u.includes("view=mSettings"))).toHaveLength(1);
    const report = JSON.parse(second.io.out.text.trim()) as SettingsRefreshReport;
    expect(report.target).toBe("espn:settings");
    expect(report.changed).toBe(true);
    expect(report.before_hash).not.toBe(report.settings_hash);
    const { config, log } = await loadRuntime(second.io);
    const store = openStore(config, second.io.clock, log, { migrate: false });
    try {
      expect(store.repos.leagueSettings.latest("0", 2026)?.settings_hash).toBe(
        report.settings_hash,
      );
      const open = store.repos.leagueSettings
        .openChecks()
        .filter((c) => c.id === "settings_changed");
      expect(open).toHaveLength(1);
      expect(open[0]?.detail).toMatchObject({ season: 2026, scoring_changed: true });
    } finally {
      store.close();
    }
  });

  it("an unchanged league re-reads (one request) and opens nothing; the run is recorded", async () => {
    sb = sandbox();
    expect((await run("2026-10-06T18:00:00.000Z", null)).code).toBe(0);
    const again = await run("2026-10-06T18:30:00.000Z", null);
    expect(again.code).toBe(0);
    expect(again.urls.filter((u) => u.includes("view=mSettings"))).toHaveLength(1);
    expect(again.io.out.text).toContain("espn:settings re-read: unchanged");
    const { config, log } = await loadRuntime(again.io);
    const store = openStore(config, again.io.clock, log, { migrate: false });
    try {
      expect(
        store.repos.leagueSettings.openChecks().filter((c) => c.id === "settings_changed"),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("is a listed target; --seasons and --game-day-cadence are refused (it reads the configured season)", async () => {
    sb = sandbox();
    expect(targetUsageError("nope").message).toContain(SETTINGS_REFRESH_TARGET);
    for (const extra of [["--seasons", "2025"], ["--game-day-cadence"]]) {
      const r = await run("2026-10-06T18:00:00.000Z", null, extra);
      expect(r.code).toBe(2);
      expect(r.urls).toEqual([]);
    }
  });
});
