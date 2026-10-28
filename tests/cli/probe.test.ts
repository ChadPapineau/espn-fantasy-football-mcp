// probe.test.ts — `eff probe` (plan 06 J4, §1.2; plan 01 §7; Z4) and the CLI's ESPN requests
// (espn-http.ts): keyless only (no Cookie header ever leaves a probe), the limiter row first, a 302
// is ESPN_HOST_MOVED and is never followed, a non-JSON 200 is host_moved, a skeleton is red, the
// probe_log rows and the drift_state row are written, the drift alarm fires once per state change
// and is never rate-limited, exit 4 on drift. Every response comes from an injected fetch.
import { clockSkewRow } from "../../src/cli/doctor-online.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DriftStateWriter, loadDriftManifest, scoringRefusal } from "../../src/drift/index.js";
import { createHttpClient } from "../../src/http/client.js";
import {
  MAX_LIMITER_WAIT_MS,
  createSetupNetwork,
  espnRequest,
  jsonBody,
  teamsOwnedBy,
} from "../../src/cli/espn-http.js";
import {
  alarmText,
  driftAlarmKey,
  hostProbe,
  probe,
  probeRunExit,
  recordProbe,
  serverTimeMs,
  answerAgeMs,
  shapeProbe,
  worstStatus,
  type ProbeCheck,
} from "../../src/cli/probe.js";
import { readJobState, updateJobState } from "../../src/cli/job-state.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import type { CookieHeader } from "../../src/auth/types.js";
import {
  fakeExec,
  fakeFetch,
  fakePackage,
  json,
  makeIo,
  movingClock,
  ROOT,
  sandbox,
  type Sandbox,
} from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const HOST_BODY = { settings: { proTeams: [{ id: 1, abbrev: "ATL", byeWeek: 5 }] } };
/**
 * The recorded host answer: healthy under the checkout's manifest probe spec too (typed keys, 32+
 * teams, known team ids — Stage C finding probe-manifest-specs-unevaluated), where the minimal
 * HOST_BODY above is red. The tests that run with the checkout's manifest answer with this.
 */
const RECORDED_HOST = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(path.join(ROOT, "fixtures/espn/recorded/season/proTeamSchedules_wl.json"), "utf8"),
  ) as Record<string, unknown>;
/** A drifted host answer: the view's key is gone (a skeleton for the seed, removed for the spec). */
const DRIFTED_HOST = { settings: {} };
const SHAPE_BODY = {
  settings: {
    scoringSettings: {},
    rosterSettings: {},
    acquisitionSettings: {},
    scheduleSettings: {},
  },
  members: [{ id: "x", isLeagueCreator: false }],
  teams: [{ id: 1, record: {}, transactionCounter: {}, waiverRank: 1 }],
};

describe("espn-http", () => {
  it("records a limiter row, sends no Cookie on a keyless request, and maps statuses", async () => {
    sb = sandbox();
    const f = fakeFetch(() =>
      json(HOST_BODY, { headers: { "x-fantasy-server-time": "1791561600000" } }),
    );
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock() });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      const http = createHttpClient({ fetch: f.fetch });
      const r = await espnRequest(
        { http, limiter: store.repos.limiter, clock: io.clock, origin: "job" },
        {
          url: "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026?view=proTeamSchedules_wl",
          cookie: null,
        },
      );
      expect("status" in r && r.status).toBe(200);
      const headers = new Headers(f.inits[0]?.headers);
      expect(headers.has("cookie")).toBe(false);
      expect(jsonBody(r as never)).toEqual(HOST_BODY);
      expect(store.repos.limiter.countToday("2026-10-06T00:00:00.000Z").job.keyless).toBe(1);
      expect(
        await espnRequest(
          { http, limiter: null, clock: io.clock, origin: "job" },
          { url: "https://x", cookie: null },
        ),
      ).toEqual({ error: "no_limiter" });
    } finally {
      store.close();
    }
  });
  it("a 302 to www.espn.com is host_moved and never followed; 5xx is an answered status; limiter refusals", async () => {
    sb = sandbox();
    const f = fakeFetch((url) =>
      url.includes("moved")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://www.espn.com/fantasy/" },
          })
        : new Response("down", { status: 503 }),
    );
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock() });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      const http = createHttpClient({ fetch: f.fetch });
      const deps = {
        http,
        limiter: store.repos.limiter,
        clock: io.clock,
        origin: "server" as const,
      };
      const base = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026";
      expect(await espnRequest(deps, { url: `${base}?moved=1`, cookie: null })).toEqual({
        error: "host_moved",
      });
      expect(f.urls.every((u) => !u.includes("www.espn.com"))).toBe(true);
      const r = await espnRequest(deps, { url: base, cookie: null });
      expect("status" in r && r.status).toBe(503);
      const refused = {
        ...store.repos.limiter,
        tryRecord: () => ({ ok: false as const, reason: "daily_cap" as const, retry_after_ms: 1 }),
      };
      expect(await espnRequest({ ...deps, limiter: refused }, { url: base, cookie: null })).toEqual(
        { error: "daily_cap" },
      );
      let slept = 0;
      const window = {
        ...store.repos.limiter,
        tryRecord: () => ({ ok: false as const, reason: "window" as const, retry_after_ms: 10 }),
      };
      expect(
        await espnRequest(
          {
            ...deps,
            limiter: window,
            sleep: (ms) => {
              slept += ms;
              return Promise.resolve();
            },
          },
          { url: base, cookie: null },
        ),
      ).toEqual({ error: "rate_limited" });
      // a window that stays full is waited for until the total budget is spent, then refused
      expect(slept).toBe(MAX_LIMITER_WAIT_MS);
      const long = {
        ...store.repos.limiter,
        tryRecord: () => ({
          ok: false as const,
          reason: "window" as const,
          retry_after_ms: MAX_LIMITER_WAIT_MS + 1,
        }),
      };
      expect(await espnRequest({ ...deps, limiter: long }, { url: base, cookie: null })).toEqual({
        error: "rate_limited",
      });
      const broken = {
        ...store.repos.limiter,
        tryRecord: () => {
          throw new Error("busy");
        },
      };
      expect(await espnRequest({ ...deps, limiter: broken }, { url: base, cookie: null })).toEqual({
        error: "limiter_unavailable",
      });
    } finally {
      store.close();
    }
  });
  it("teamsOwnedBy matches the SWID case-insensitively and never returns a name", () => {
    sb = sandbox();
    const swid = "{00000000-0000-4000-8000-0000000000AA}";
    const body = {
      teams: [
        { id: 3, owners: [swid.toLowerCase()], name: "x" },
        { id: 4, owners: ["{other}"] },
        { id: -1, owners: [swid] },
        null,
        { id: 3, owners: [swid] },
      ],
    };
    expect(teamsOwnedBy(body, swid)).toEqual([3]);
    expect(teamsOwnedBy({ teams: "x" }, swid)).toEqual([]);
    expect(teamsOwnedBy(null, swid)).toEqual([]);
  });
  it("createSetupNetwork: the four probes and the team resolution over one limiter", async () => {
    sb = sandbox();
    const swid = "{00000000-0000-4000-8000-0000000000AB}";
    const f = fakeFetch((url, init) => {
      const cookie = new Headers(init.headers).get("cookie");
      if (url.includes("/communication/"))
        return new Response(null, { status: cookie === null ? 401 : 404 });
      if (url.includes("view=mTeam")) return json({ teams: [{ id: 7, owners: [swid] }] });
      return new Response(null, { status: cookie === null ? 401 : 200 });
    });
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock() });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      const net = createSetupNetwork(
        {
          http: createHttpClient({ fetch: f.fetch }),
          limiter: store.repos.limiter,
          clock: io.clock,
          origin: "server",
        },
        { host: "lm-api-reads.fantasy.espn.com", season: 2026, leagueId: "0" },
      );
      const header = `espn_s2=x; SWID=${swid}` as CookieHeader;
      expect(await net.anonymousSettings()).toEqual({ status: 401 });
      expect(await net.anonymousBoard()).toEqual({ status: 401 });
      expect(await net.settingsWithCookies(header)).toEqual({ status: 200 });
      expect(await net.boardWithCookies(header)).toEqual({ status: 404 });
      expect(await net.resolveTeam(header, swid)).toEqual({ kind: "one", teamId: 7 });
      const boardInit = f.inits[1];
      expect(new Headers(boardInit?.headers).get("x-fantasy-filter")).toContain('"limit":1');
    } finally {
      store.close();
    }
  });
});

describe("probe pieces", () => {
  it("serverTimeMs prefers x-fantasy-server-time, then Date; worstStatus, probeRunExit, alarmText", () => {
    sb = sandbox();
    expect(serverTimeMs({ "x-fantasy-server-time": "1791561600000" })).toBe(1791561600000);
    expect(serverTimeMs({ date: "Tue, 06 Oct 2026 18:00:00 GMT" })).toBe(
      Date.parse("2026-10-06T18:00:00Z"),
    );
    expect(serverTimeMs({ date: "nope" })).toBeNull();
    expect(serverTimeMs({})).toBeNull();
    // a cached answer: the origin's instant plus the Age the cache reports (Stage C final gate:
    // doctor #14 read a CDN copy's minutes-old Date as 262–278 s of skew on a correct clock)
    expect(serverTimeMs({ date: "Tue, 06 Oct 2026 18:00:00 GMT", age: "270" })).toBe(
      Date.parse("2026-10-06T18:04:30Z"),
    );
    expect(serverTimeMs({ "x-fantasy-server-time": "1791561600000", age: "12" })).toBe(
      1791561612000,
    );
    // an Age that is not delta-seconds is no age; a huge one is capped as RFC 9111 says
    for (const age of ["-5", "1.5", "soon", ""])
      expect(serverTimeMs({ "x-fantasy-server-time": "1791561600000", age }), age).toBe(
        1791561600000,
      );
    expect(answerAgeMs({ age: "9999999999" })).toBe(2_147_483_648_000);
    expect(answerAgeMs({})).toBe(0);
    // doctor #14 on such a copy: a correct clock is within the bound; the same headers read without
    // the Age warned (the gate's 278 s) and would fail past 300 s
    const now = Date.parse("2026-10-06T18:05:00Z");
    const cached = { date: new Date(now - 278_000).toUTCString(), age: "278" };
    const skewCheck = (server_time_ms: number | null): ProbeCheck => ({
      name: "host",
      views: ["proTeamSchedules_wl"],
      status: "green",
      upstream_status: 200,
      reason: null,
      signals: [],
      server_time_ms,
    });
    expect(clockSkewRow(skewCheck(serverTimeMs(cached)), now).status).toBe("ok");
    expect(clockSkewRow(skewCheck(serverTimeMs({ date: cached.date })), now).status).toBe("warn");
    const c = (status: ProbeCheck["status"], extra: Partial<ProbeCheck> = {}): ProbeCheck => ({
      name: "host",
      views: ["proTeamSchedules_wl"],
      status,
      upstream_status: 200,
      reason: null,
      signals: [],
      server_time_ms: null,
      ...extra,
    });
    expect(worstStatus([c("skipped")])).toBe("green");
    expect(worstStatus([c("additive"), c("red"), c("unreachable")])).toBe("red");
    expect(probeRunExit("red")).toBe(4);
    expect(probeRunExit("host_moved")).toBe(4);
    expect(probeRunExit("unreachable")).toBe(1);
    expect(probeRunExit("config")).toBe(2);
    expect(probeRunExit("green")).toBe(0);
    expect(probeRunExit("skipped")).toBe(0);
    expect(alarmText([c("green")])).toBeNull();
    expect(alarmText([c("host_moved")])).toContain("ESPN host moved");
    expect(
      alarmText([
        c("red", {
          signals: [
            { kind: "missing_required_key", view: "mSettings", path: "$.settings.x", value: null },
          ],
        }),
      ]),
    ).toBe("ESPN drift: mSettings: removed $.settings.x");
    expect(alarmText([c("red")])).toContain("changed");
  });
  it("hostProbe and shapeProbe judge green, skeleton (red), non-JSON (host_moved), 401 on a private league (skipped), 404 (config)", async () => {
    sb = sandbox();
    let answer: () => Response = () => json(HOST_BODY);
    const f = fakeFetch(() => answer());
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock() });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      const deps = {
        http: createHttpClient({ fetch: f.fetch }),
        limiter: store.repos.limiter,
        clock: io.clock,
        host: "lm-api-reads.fantasy.espn.com",
        observations: undefined,
      };
      expect((await hostProbe(deps, 2026)).status).toBe("green");
      answer = () => json({ settings: { name: "x" }, teams: [] });
      const red = await hostProbe(deps, 2026);
      expect(red.status).toBe("red");
      expect(red.signals[0]?.kind).toBe("skeleton");
      answer = () =>
        new Response("<html>Access Denied</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      expect((await hostProbe(deps, 2026)).status).toBe("host_moved");
      answer = () => new Response(null, { status: 403 });
      expect((await hostProbe(deps, 2026)).status).toBe("host_moved");
      answer = () => new Response(null, { status: 404 });
      expect((await hostProbe(deps, 2026)).status).toBe("config");
      answer = () => new Response(null, { status: 503 });
      expect((await hostProbe(deps, 2026)).status).toBe("unreachable");
      answer = () => new Response(null, { status: 418 });
      expect((await hostProbe(deps, 2026)).status).toBe("config");
      answer = () => json(SHAPE_BODY);
      expect((await shapeProbe(deps, 2026, "0", true)).status).toBe("green");
      answer = () => new Response(null, { status: 401 });
      expect((await shapeProbe(deps, 2026, "0", false)).status).toBe("skipped");
      expect((await shapeProbe(deps, 2026, "0", true)).reason).toBe("probe_league_not_public");
      answer = () =>
        new Response(null, { status: 302, headers: { location: "https://www.espn.com/" } });
      expect((await shapeProbe(deps, 2026, "0", true)).status).toBe("host_moved");
      expect((await hostProbe(deps, 2026)).status).toBe("host_moved");
      for (const init of f.inits) expect(new Headers(init.headers).has("cookie")).toBe(false);
      // probe_log + drift_state: the host move is recorded and a later green clears it
      recordProbe(store, io.clock, deps.host, [await hostProbe(deps, 2026)]);
      expect(store.repos.driftState.get()?.status).toBe("host_moved");
      answer = () => json(HOST_BODY);
      recordProbe(store, io.clock, deps.host, [await hostProbe(deps, 2026)]);
      expect(store.repos.driftState.get()?.status).toBe("green");
      expect(store.repos.probeLog.lastSuccess("host")).not.toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("eff probe", () => {
  it("green: exit 0, probe_log written, drift_state green, no notification; --json shape", async () => {
    sb = sandbox();
    const f = fakeFetch((url) => (url.includes("/leagues/") ? json(SHAPE_BODY) : json(HOST_BODY)));
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock(),
      platform: "darwin",
      exec,
      packageRoot: fakePackage(sb),
      env: { ESPN_LEAGUE_ID: "0", EFF_PROBE_LEAGUE_ID: "1" },
    });
    const { config, log } = await loadLenientRuntime(io);
    expect(await probe(io, config, log, { hostOnly: false, notify: true, json: true })).toBe(0);
    const doc = JSON.parse(io.out.text) as {
      status: string;
      drift_state: string;
      checks: { name: string; status: string }[];
    };
    expect(doc.status).toBe("green");
    expect(doc.checks.map((c) => c.status)).toEqual(["green", "green"]);
    expect(calls).toHaveLength(0);
    expect(f.urls[1]).toContain("/leagues/1?");
    expect(io.out.text).not.toContain('"1?');
  });
  it("with the checkout's drift manifest, observed keys are compared (an unseen key is additive, exit 0)", async () => {
    sb = sandbox();
    const body = RECORDED_HOST();
    const teams = (body.settings as { proTeams: Record<string, unknown>[] }).proTeams;
    teams[1]!.brandNewKey = 1;
    body.brandNewTop = true;
    const f = fakeFetch(() => json(body));
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock(), packageRoot: ROOT });
    const { config, log } = await loadLenientRuntime(io);
    expect(await probe(io, config, log, { hostOnly: true, notify: false, json: true })).toBe(0);
    const doc = JSON.parse(io.out.text) as { manifest: string; checks: { status: string }[] };
    expect(doc.manifest).toBe("present");
    expect(doc.checks[0]?.status).toBe("additive");
  });
  it("red: exit 4 and ONE alarm; the next red run alarms no more; host-only and no-league skip the shape probe", async () => {
    sb = sandbox();
    const f = fakeFetch(() => json({ settings: { name: "renamed" }, teams: [] }));
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock(), platform: "darwin", exec });
    const { config, log } = await loadLenientRuntime(io);
    expect(await probe(io, config, log, { hostOnly: false, notify: true, json: false })).toBe(4);
    expect(io.out.text).toContain("drift_state: red");
    expect(io.err.text).toContain("ESPN drift: proTeamSchedules_wl");
    expect(calls).toHaveLength(1);
    const again = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-07T18:00:00.000Z"),
      platform: "darwin",
      exec,
    });
    expect(await probe(again, config, log, { hostOnly: true, notify: true, json: false })).toBe(4);
    expect(calls).toHaveLength(1);
    expect(again.out.text).toContain("shape  skipped");
  });
  // Stage C finding probe-drift-alarm-stamp-sticks: the stamp outlived its episode
  it("a new red episode after an in-call recovery alarms again (the stamp names the episode)", async () => {
    sb = sandbox();
    let body: unknown = DRIFTED_HOST;
    const f = fakeFetch(() => json(body));
    const { exec, calls } = fakeExec();
    const at = (iso: string) =>
      makeIo(sb, { fetch: f.fetch, clock: movingClock(iso), platform: "darwin", exec });
    const day1 = at("2026-10-06T09:00:00.000Z");
    const { config, log } = await loadLenientRuntime(day1);
    const probeAt = (io: ReturnType<typeof at>, notify = true) =>
      probe(io, config, log, { hostOnly: true, notify, json: false });
    // day 1: the launchd probe finds red and alarms once
    expect(await probeAt(day1)).toBe(4);
    expect(calls).toHaveLength(1);
    expect(readJobState(config.cacheDir)["alarm.drift"]).toBeDefined();
    // later that day an in-call answer verifies the view: drift_state recovers between probes
    const noon = at("2026-10-06T15:00:00.000Z");
    let store = openStore(config, noon.clock, log, { migrate: true });
    try {
      new DriftStateWriter(store.repos.driftState, noon.clock, config.espnReadHost).recovered([
        "proTeamSchedules_wl",
      ]);
      expect(store.repos.driftState.get()?.status).toBe("green");
    } finally {
      store.close();
    }
    // day 2: green, so the episode's stamp is gone
    body = RECORDED_HOST();
    expect(await probeAt(at("2026-10-07T09:00:00.000Z"))).toBe(0);
    expect(readJobState(config.cacheDir)["alarm.drift"]).toBeUndefined();
    // day 9: a NEW drift episode alarms again
    body = DRIFTED_HOST;
    expect(await probeAt(at("2026-10-14T09:00:00.000Z"))).toBe(4);
    expect(calls).toHaveLength(2);
    // a recovery AND a new in-call red between two probes, no green probe in between: still a new
    // episode (a new `since`), so it alarms
    const later = at("2026-10-15T15:00:00.000Z");
    store = openStore(config, later.clock, log, { migrate: true });
    try {
      const w = new DriftStateWriter(store.repos.driftState, later.clock, config.espnReadHost);
      w.recovered(["proTeamSchedules_wl"]);
      w.record([
        { kind: "skeleton", view: "proTeamSchedules_wl", path: "$.settings.proTeams", value: null },
      ]);
    } finally {
      store.close();
    }
    expect(await probeAt(at("2026-10-16T09:00:00.000Z"))).toBe(4);
    expect(calls).toHaveLength(3);
    // the same episode the next day: no repeat
    expect(await probeAt(at("2026-10-17T09:00:00.000Z"))).toBe(4);
    expect(calls).toHaveLength(3);
  });
  it("a red the probe cannot clear (a schema-level key an in-call answer found) still alarms, with the fallback text", async () => {
    sb = sandbox();
    const f = fakeFetch(() => json(RECORDED_HOST()));
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock(), platform: "darwin", exec });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      // neither a required-path key nor one the manifest's probe spec requires: no probe answer
      // can verify it, so the row stays red
      new DriftStateWriter(store.repos.driftState, io.clock, config.espnReadHost).record([
        {
          kind: "missing_required_key",
          view: "proTeamSchedules_wl",
          path: "$.settings.proTeams[].teamPlayersByPosition",
          value: null,
        },
      ]);
    } finally {
      store.close();
    }
    expect(await probe(io, config, log, { hostOnly: true, notify: true, json: false })).toBe(4);
    expect(io.out.text).toContain("drift_state: red");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toContain("ESPN drift: red — run `eff status`");
  });
  it("a probe without --notify never stamps the alarm: the launchd probe still notifies that episode", async () => {
    sb = sandbox();
    const f = fakeFetch(() => json({ settings: { name: "renamed" }, teams: [] }));
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock(), platform: "darwin", exec });
    const { config, log } = await loadLenientRuntime(io);
    // the owner at a terminal sees red (the alarm line on stderr), no notification, no stamp
    expect(await probe(io, config, log, { hostOnly: true, notify: false, json: false })).toBe(4);
    expect(io.err.text).toContain("ESPN drift: proTeamSchedules_wl");
    expect(calls).toHaveLength(0);
    expect(readJobState(config.cacheDir)["alarm.drift"]).toBeUndefined();
    // the scheduled run notifies the episode once
    const job = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-07T18:00:00.000Z"),
      platform: "darwin",
      exec,
    });
    expect(await probe(job, config, log, { hostOnly: true, notify: true, json: false })).toBe(4);
    expect(calls).toHaveLength(1);
    // a notification osascript could not show is not stamped: the next run tries again
    const failing = fakeExec(() => ({ code: 1 }));
    const retry = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-08T18:00:00.000Z"),
      platform: "darwin",
      exec: failing.exec,
    });
    updateJobState(config.cacheDir, { "alarm.drift": null });
    expect(await probe(retry, config, log, { hostOnly: true, notify: true, json: false })).toBe(4);
    expect(failing.calls).toHaveLength(1);
    expect(readJobState(config.cacheDir)["alarm.drift"]).toBeUndefined();
    expect(driftAlarmKey("red", null)).toBe("red");
    expect(driftAlarmKey("host_moved", "2026-10-06T09:00:00.000Z")).toBe(
      "host_moved:2026-10-06T09:00:00.000Z",
    );
  });
  it("a green run ends an in-call red row and records the manifest; a newer manifest re-baselines and says so (drift-red-never-clears)", async () => {
    sb = sandbox();
    const host = JSON.parse(
      readFileSync(
        path.join(ROOT, "fixtures/espn/recorded/season/proTeamSchedules_wl.json"),
        "utf8",
      ),
    ) as unknown;
    const shape = JSON.parse(
      readFileSync(path.join(ROOT, "fixtures/espn/recorded/league-a/probe-shape.json"), "utf8"),
    ) as unknown;
    const f = fakeFetch((url) => (url.includes("/leagues/") ? json(shape) : json(host)));
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock(),
      packageRoot: ROOT,
      env: { ESPN_LEAGUE_ID: "0", EFF_PROBE_LEAGUE_ID: "1" },
    });
    const { config, log } = await loadLenientRuntime(io);
    // an in-call answer left the row red (a removed mSettings key: scoring refused)
    let store = openStore(config, io.clock, log, { migrate: true });
    try {
      new DriftStateWriter(store.repos.driftState, io.clock, config.espnReadHost).record([
        {
          kind: "missing_required_key",
          view: "mSettings",
          path: "$.settings.acquisitionSettings",
          value: null,
        },
      ]);
      expect(scoringRefusal(store.repos.driftState.get())).toBe("settings_drift");
    } finally {
      store.close();
    }
    expect(await probe(io, config, log, { hostOnly: false, notify: false, json: true })).toBe(0);
    const doc = JSON.parse(io.out.text) as {
      status: string;
      drift_state: string;
      rebaselined: boolean;
    };
    expect([doc.status, doc.drift_state, doc.rebaselined]).toEqual(["green", "green", false]);
    const shipped = loadDriftManifest(path.join(ROOT, "fixtures/drift/manifest.json")).identity;
    store = openStore(config, io.clock, log, { migrate: false });
    try {
      const row = store.repos.driftState.get();
      expect(row).toMatchObject({
        status: "green",
        diff_json: "[]",
        manifest_hash: shipped.hash,
        manifest_version: shipped.version,
      });
      expect(scoringRefusal(row)).toBeNull();
    } finally {
      store.close();
    }
    // a checkout whose manifest was regenerated (another hash): the first probe re-baselines and
    // says so
    const pkg = fakePackage(sb);
    mkdirSync(path.join(pkg, "fixtures", "drift"), { recursive: true });
    const m = JSON.parse(
      readFileSync(path.join(ROOT, "fixtures/drift/manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    writeFileSync(
      path.join(pkg, "fixtures", "drift", "manifest.json"),
      JSON.stringify({ ...m, $comment: "regenerated after a re-recording" }),
    );
    const regenerated = loadDriftManifest(path.join(pkg, "fixtures", "drift", "manifest.json"));
    expect(regenerated.identity.hash).not.toBe(shipped.hash);
    const next = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-07T18:00:00.000Z"),
      packageRoot: pkg,
      env: { ESPN_LEAGUE_ID: "0", EFF_PROBE_LEAGUE_ID: "1" },
    });
    expect(await probe(next, config, log, { hostOnly: false, notify: false, json: false })).toBe(0);
    expect(next.out.text).toContain("re-baselined on a newer drift manifest");
    store = openStore(config, next.clock, log, { migrate: false });
    try {
      expect(store.repos.driftState.get()?.manifest_hash).toBe(regenerated.identity.hash);
    } finally {
      store.close();
    }
  });
  it("unreachable: exit 1 with a rate-limited failure notification; fixture mode refused", async () => {
    sb = sandbox();
    const f = fakeFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock(), platform: "darwin", exec });
    const { config, log } = await loadLenientRuntime(io);
    expect(await probe(io, config, log, { hostOnly: true, notify: true, json: false })).toBe(1);
    expect(calls).toHaveLength(1);
    const fx = makeIo(sb, { env: { EFF_FIXTURE_DIR: sb.dir } });
    const r = await loadLenientRuntime(fx);
    expect(await probe(fx, r.config, r.log, { hostOnly: true, notify: false, json: false })).toBe(
      2,
    );
  });
});
