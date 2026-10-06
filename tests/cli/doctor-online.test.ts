// doctor-online.test.ts — `eff doctor --online` rows #14–#19 (plan 03 §5; L5) over an injected fetch:
// the shared keyless host request (clock skew + shape), the credential probe recorded as `doctor`
// in store.sqlite (never the credential store), the anonymous league read (200 public / 401 private /
// 404 wrong id), the own team, and nflverse reachability. No request leaves the process.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { onlineRows } from "../../src/cli/doctor-online.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import { composeBodies } from "../../src/providers/espn/index.js";
import { fakeCookies, stateRow } from "../auth/helpers.js";
import {
  ROOT,
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
const recorded = (rel: string): unknown => JSON.parse(readFileSync(path.join(REC, rel), "utf8"));
const jsonRes = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const COOKIES = fakeCookies("cli-doctor-online");

function espn(opts: { anon: number; cookie: number; nflverse: number }) {
  return fakeFetch((url, init) => {
    const cookie = new Headers(init.headers).get("cookie");
    if (url.includes("github.com"))
      return new Response("2026-10-06 10:00:00 EDT", { status: opts.nflverse });
    if (url.includes("view=proTeamSchedules_wl"))
      return jsonRes(recorded("season/proTeamSchedules_wl.json"), 200, {
        "x-fantasy-server-time": String(Date.parse("2026-10-06T18:00:30Z")),
      });
    if (url.includes("/leagues/0")) {
      const status = cookie === null ? opts.anon : opts.cookie;
      if (status !== 200) return jsonRes({ messages: ["x"] }, status);
      return jsonRes(
        composeBodies(
          composeBodies(recorded("league-a/mSettings.json"), recorded("league-a/mNav.json")),
          recorded("league-a/mTeam.json"),
        ),
      );
    }
    return new Response(null, { status: 404 });
  });
}

describe("doctor --online", () => {
  it("without a store the ESPN rows are skipped and only nflverse is asked", async () => {
    sb = sandbox();
    const f = espn({ anon: 200, cookie: 200, nflverse: 200 });
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock() });
    const { config, log } = await loadLenientRuntime(io);
    const rows = await onlineRows(io, config, null, log);
    expect(rows.filter((r) => r.status === "skip").map((r) => r.n)).toEqual([14, 15, 16, 17, 18]);
    expect(rows.find((r) => r.n === 19)?.status).toBe("ok");
    expect(f.urls.every((u) => u.includes("github.com"))).toBe(true);
  });
  it("no league id: #17 is a config finding; nflverse down: #19 fails", async () => {
    sb = sandbox();
    const f = espn({ anon: 200, cookie: 200, nflverse: 503 });
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock(), packageRoot: fakePackage(sb) });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      const rows = await onlineRows(io, config, store, log);
      expect(rows.find((r) => r.n === 17)?.status).toBe("config");
      expect(rows.find((r) => r.n === 19)?.status).toBe("fail");
      expect(rows.find((r) => r.n === 14)?.status).toBe("ok");
      expect(rows.find((r) => r.n === 15)?.status).toBe("ok");
    } finally {
      store.close();
    }
  });
  it("a private league with stored cookies: #16 accepted (recorded as doctor), #17 private, #18 resolved or warned", async () => {
    sb = sandbox();
    mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(sb.configDir, "session.json"),
      sessionFileBody(COOKIES, metaFor(COOKIES, "2026-10-01T00:00:00.000Z")),
      { mode: 0o600 },
    );
    const f = espn({ anon: 401, cookie: 200, nflverse: 200 });
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock(),
      packageRoot: fakePackage(sb),
      env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" },
    });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    store.repos.credentialState.put(
      stateRow({ store: "file", state: "rejected", rejected_since: "2026-10-06T09:00:00.000Z" }),
    );
    try {
      const rows = await onlineRows(io, config, store, log);
      expect(rows.find((r) => r.n === 16)?.status).toBe("ok");
      expect(rows.find((r) => r.n === 17)?.message).toContain("private league");
      expect(["ok", "warn"]).toContain(rows.find((r) => r.n === 18)?.status);
      const row = store.repos.credentialState.get();
      expect(row?.state).toBe("validated");
      expect(row?.updated_by).toBe("doctor");
      expect(JSON.stringify(rows)).not.toContain(COOKIES.espn_s2.slice(0, 16));
    } finally {
      store.close();
    }
  });
  it("a cookie 401 is #16 'credentials' (exit 3) and the run's exit code reflects it; a wrong league id is #17 config", async () => {
    sb = sandbox();
    mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(sb.configDir, "session.json"),
      sessionFileBody(COOKIES, metaFor(COOKIES, "2026-10-01T00:00:00.000Z")),
      { mode: 0o600 },
    );
    const env = { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" };
    const f = espn({ anon: 401, cookie: 401, nflverse: 200 });
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock(),
      packageRoot: fakePackage(sb),
      env,
    });
    const { config, log } = await loadLenientRuntime(io);
    openStore(config, io.clock, log, { migrate: true }).close();
    const r = await runDoctor(io, { json: false, online: true, fix: false, yes: false });
    expect(r.rows.find((x) => x.n === 16)?.status).toBe("credentials");
    expect(r.exit_code).toBeGreaterThanOrEqual(3);
    const nf = espn({ anon: 404, cookie: 404, nflverse: 200 });
    const io2 = makeIo(sb, {
      fetch: nf.fetch,
      clock: movingClock(),
      packageRoot: fakePackage(sb),
      env,
    });
    const store = openStore(config, io2.clock, log, { migrate: true });
    try {
      const rows = await onlineRows(io2, config, store, log);
      expect(rows.find((x) => x.n === 17)?.status).toBe("config");
      expect(rows.find((x) => x.n === 16)?.status).toBe("config");
    } finally {
      store.close();
    }
  });
});
