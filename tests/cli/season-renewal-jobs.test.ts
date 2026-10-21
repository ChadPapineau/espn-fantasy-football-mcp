// season-renewal-jobs.test.ts — Stage C finding league-rollover-not-found-misdiagnosed, the daily
// jobs' half. From July 1 an unset ESPN_SEASON is the new season, which ESPN serves for a league only
// once its manager renews it (research 03 §A.4: until then every read 404s GENERAL_NOT_FOUND). The
// 09:00 credential check sent notifier.failure('credential-check', 'ESPN_LEAGUE_NOT_FOUND') and the
// 05:00 probe notifier.failure('probe', 'config') on that 404 every day until the renewal. Now, while
// config's seasonMayAwaitRenewal holds, both say the state (SEASON_RENEWAL_TEXT), notify nothing and
// exit 0 — unset or pinned to the new season alike; the same 404 after October 1, or on a pinned
// PAST season (the league did not exist then), still fails as before.
// Every ESPN answer comes from an injected fetch (no request leaves the process, no real cookie).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { checkAuth, credentialCheck } from "../../src/cli/credential-check.js";
import { readJobState } from "../../src/cli/job-state.js";
import { probe, renewalSkipped, type ProbeCheck } from "../../src/cli/probe.js";
import { loadLenientRuntime, loadRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import { SEASON_RENEWAL_TEXT, loadConfig } from "../../src/config/schema.js";
import { fakeCookies, stateRow } from "../auth/helpers.js";
import {
  ROOT,
  fakeExec,
  fakeFetch,
  fakePackage,
  json,
  makeIo,
  movingClock,
  sandbox,
  type Sandbox,
} from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const JULY = "2027-07-15T09:00:00.000Z";
const OCTOBER = "2027-10-02T09:00:00.000Z";
const NOT_FOUND = {
  details: [
    {
      message: "Not Found",
      metaData: null,
      resolution: null,
      shortMessage: "Not Found",
      type: "GENERAL_NOT_FOUND",
    },
  ],
  messages: ["Not Found"],
};
const HOST_BODY = { settings: { proTeams: [{ id: 1, abbrev: "ATL", byeWeek: 5 }] } };

/** ESPN with no 2027 season of any league yet: every league URL 404s; the season route answers. */
function unrenewed() {
  return fakeFetch((url) =>
    url.includes("/leagues/") ? json(NOT_FOUND, { status: 404 }) : json(HOST_BODY),
  );
}

function plantSession(): void {
  const cookies = fakeCookies("season-renewal-jobs");
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  chmodSync(sb.configDir, 0o700);
  writeFileSync(
    path.join(sb.configDir, "session.json"),
    sessionFileBody(cookies, metaFor(cookies, "2026-10-01T00:00:00.000Z")),
    { mode: 0o600 },
  );
}

/** A stored credential row for league 0 and a credential-check runtime at `at`. */
async function credentialWorld(at: string, env: Record<string, string> = {}) {
  sb = sandbox();
  plantSession();
  const f = unrenewed();
  const { exec, calls } = fakeExec();
  const io = makeIo(sb, {
    clock: movingClock(at),
    env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file", ...env },
    packageRoot: fakePackage(sb),
    fetch: f.fetch,
    platform: "darwin",
    exec,
  });
  const { config, log } = await loadRuntime(io);
  const store = openStore(config, io.clock, log, { migrate: true });
  store.repos.credentialState.put(stateRow({ store: "file" }));
  store.close();
  return { io, config, log, calls, urls: f.urls };
}

describe("the daily credential check in the renewal window", () => {
  it.each([
    ["ESPN_SEASON unset", {}],
    ["ESPN_SEASON=2027 pinned", { ESPN_SEASON: "2027" }],
  ])(
    "July, %s, the league not renewed: says so, notifies nothing, exit 0, idle",
    async (_l, env) => {
      const w = await credentialWorld(JULY, env);
      expect(w.config.season).toBe(2027);
      expect(await credentialCheck(w.io, w.config, w.log, { notify: true })).toBe(0);
      expect(w.urls.some((u) => u.includes("/seasons/2027/"))).toBe(true);
      expect(w.calls).toHaveLength(0);
      expect(w.io.out.text).toContain(SEASON_RENEWAL_TEXT.line(2027));
      expect(w.io.out.text).not.toContain("could not complete");
      const job = JSON.stringify(readJobState(w.config.cacheDir));
      expect(job).not.toContain("ESPN_LEAGUE_NOT_FOUND");
      // the state is unchanged: a 404 is no credential observation
      const store = openStore(w.config, w.io.clock, w.log, { migrate: false });
      expect(store.repos.credentialState.get()?.state).toBe("stored");
      store.close();
    },
  );

  it("eff check-auth in the window names the state too", async () => {
    const w = await credentialWorld(JULY);
    await checkAuth(w.io, w.config, w.log, { json: false });
    expect(w.io.out.text).toContain(`check-auth: ${SEASON_RENEWAL_TEXT.line(2027)}`);
  });

  it.each([
    ["October, ESPN_SEASON unset", OCTOBER, {}],
    ["July, a pinned past season", JULY, { ESPN_SEASON: "2026" }],
  ])("%s: the 404 is still a failure (exit 2, one notification)", async (_l, at, env) => {
    const w = await credentialWorld(at, env);
    expect(await credentialCheck(w.io, w.config, w.log, { notify: true })).toBe(2);
    expect(w.calls).toHaveLength(1);
    expect(w.io.out.text).toContain("could not complete (ESPN_LEAGUE_NOT_FOUND)");
  });
});

describe("the daily drift probe in the renewal window", () => {
  async function probeWorld(at: string, env: Record<string, string> = {}) {
    sb = sandbox();
    const f = unrenewed();
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock(at),
      platform: "darwin",
      exec,
      packageRoot: fakePackage(sb),
      env: { ESPN_LEAGUE_ID: "0", EFF_PROBE_LEAGUE_ID: "1", ...env },
    });
    const { config, log } = await loadLenientRuntime(io);
    return { io, config, log, calls };
  }

  it.each([
    ["ESPN_SEASON unset", {}],
    ["ESPN_SEASON=2027 pinned", { ESPN_SEASON: "2027" }],
  ])(
    "July, %s, the probe league not renewed: the shape check is skipped, exit 0, no notification",
    async (_l, env) => {
      const w = await probeWorld(JULY, env);
      expect(
        await probe(w.io, w.config, w.log, { hostOnly: false, notify: true, json: true }),
      ).toBe(0);
      const doc = JSON.parse(w.io.out.text) as {
        status: string;
        checks: { name: string; status: string; reason: string | null }[];
      };
      expect(doc.status).toBe("green");
      expect(doc.checks[1]).toMatchObject({
        name: "shape",
        status: "skipped",
        reason: SEASON_RENEWAL_TEXT.reason,
      });
      expect(w.calls).toHaveLength(0);
    },
  );

  it.each([
    ["October, ESPN_SEASON unset", OCTOBER, {}],
    ["July, a pinned past season", JULY, { ESPN_SEASON: "2026" }],
  ])("%s: the 404 is still config (exit 2, one failure notification)", async (_l, at, env) => {
    const w = await probeWorld(at, env);
    expect(await probe(w.io, w.config, w.log, { hostOnly: false, notify: true, json: false })).toBe(
      2,
    );
    expect(w.calls).toHaveLength(1);
  });

  it("renewalSkipped leaves every other check alone", () => {
    sb = sandbox();
    const july = Date.parse(JULY);
    const config = loadConfig({
      env: { ESPN_LEAGUE_ID: "0", EFF_CONFIG_DIR: sb.configDir, EFF_CACHE_DIR: sb.cacheDir },
      file: undefined,
      home: sb.home,
      repoRoot: ROOT,
      nowMs: july,
    });
    const base: ProbeCheck = {
      name: "shape",
      views: ["mSettings", "mNav", "mTeam"],
      status: "config",
      upstream_status: 404,
      reason: "http_404",
      signals: [],
      server_time_ms: null,
    };
    expect(renewalSkipped(base, config, july).status).toBe("skipped");
    for (const c of [
      { ...base, name: "host" as const },
      { ...base, upstream_status: 400, reason: "http_400" },
      { ...base, status: "unreachable" as const },
      { ...base, status: "skipped" as const, reason: "private_league" },
    ])
      expect(renewalSkipped(c, config, july)).toBe(c);
    expect(renewalSkipped(base, config, Date.parse(OCTOBER))).toBe(base);
  });
});
