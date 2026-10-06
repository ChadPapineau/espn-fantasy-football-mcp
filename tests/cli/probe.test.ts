// probe.test.ts — `eff probe` (plan 06 J4, §1.2; plan 01 §7; Z4) and the CLI's ESPN requests
// (espn-http.ts): keyless only (no Cookie header ever leaves a probe), the limiter row first, a 302
// is ESPN_HOST_MOVED and is never followed, a non-JSON 200 is host_moved, a skeleton is red, the
// probe_log rows and the drift_state row are written, the drift alarm fires once per state change
// and is never rate-limited, exit 4 on drift. Every response comes from an injected fetch.
import { afterEach, describe, expect, it } from "vitest";
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
  hostProbe,
  probe,
  probeRunExit,
  recordProbe,
  serverTimeMs,
  shapeProbe,
  worstStatus,
  type ProbeCheck,
} from "../../src/cli/probe.js";
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
      expect(slept).toBe(10);
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
    const body = {
      settings: { proTeams: [{ id: 1, abbrev: "ATL", byeWeek: 5, brandNewKey: 1 }] },
      brandNewTop: true,
    };
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
