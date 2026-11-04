// transactions-known-private-none.test.ts — changelog §R10, R10-23, the `eff` half: the commands
// that read keyless follow the cookie gate's one rule, because they read through the same provider
// (src/cli/espn-stack.ts buildEspnStack → the request pipeline's CookieGate). `eff transactions
// --force` on an install with nothing stored: while the league's publicity is unknown, its settings
// read is the one keyless learning read (its 401 teaches `false`, kept for the next process); once
// the league is known private — learned by an earlier run, or kept by another process within its 7
// days — the run sends nothing (ESPN_REQUIRES_COOKIES with zero requests); past the 7 days one read
// re-learns it. `eff status` reads no ESPN view at all (src/cli/status.ts reports from the store
// alone), so it has no request the rule could apply to: the test holds that it sends none either way.
// Placeholder league (id 0), no credential stored, no request leaves the process.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLenientRuntime, loadRuntime } from "../../src/cli/runtime.js";
import { transactionsAppend } from "../../src/cli/snapshot.js";
import { status } from "../../src/cli/status.js";
import { openStore } from "../../src/cli/store-access.js";
import { cachedPublicity, PUBLICITY_MAX_AGE_MS } from "../../src/providers/espn/cache.js";
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
const rec = (rel: string): unknown => JSON.parse(readFileSync(path.join(REC, rel), "utf8"));
const ENV = {
  ESPN_LEAGUE_ID: "0",
  EFF_CREDENTIAL_STORE: "file",
  ESPN_SEASON: "2026",
  ESPN_TEAM_ID: "1",
};
const AT = Date.parse("2026-11-03T12:00:00.000Z");
const DAY_MS = 24 * 3600 * 1000;

/** A PRIVATE league: every league request is ESPN's anonymous 401 (none may carry a cookie). */
function privateLeague() {
  return fakeFetch((url, init) => {
    expect(new Headers(init.headers).has("cookie")).toBe(false);
    if (url.includes("view=proTeamSchedules_wl"))
      return new Response(JSON.stringify(rec("season/proTeamSchedules_wl.json")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return new Response(JSON.stringify({ messages: ["not authorized"] }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  });
}

const leagueUrls = (f: ReturnType<typeof fakeFetch>): string[] =>
  f.urls.filter((u) => u.includes("/leagues/0"));

async function runtime(atMs: number, f: ReturnType<typeof fakeFetch>) {
  const { exec } = fakeExec();
  const io = makeIo(sb, {
    fetch: f.fetch,
    clock: movingClock(new Date(atMs).toISOString()),
    platform: "darwin",
    exec,
    packageRoot: fakePackage(sb),
    env: ENV,
  });
  const { config, log } = await loadRuntime(io);
  return { io, config, log };
}

/** `eff transactions --force` at `atMs`; its league requests. */
async function forcedRun(atMs: number): Promise<string[]> {
  const f = privateLeague();
  const r = await runtime(atMs, f);
  await transactionsAppend(r.io, r.config, r.log, { notify: false, force: true });
  return leagueUrls(f);
}

describe("R10-23: `eff transactions --force` with nothing stored", () => {
  it("unknown publicity: one keyless learning read; the next run, known private, sends nothing", async () => {
    sb = sandbox();
    const first = await forcedRun(AT);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("view=mSettings");
    // a new process: the kept `false` refuses before any request
    expect(await forcedRun(AT + 60_000)).toEqual([]);
    expect(await forcedRun(AT + 6 * DAY_MS)).toEqual([]);
  });

  it("a league kept private by another process: no request; past its 7 days one read re-learns it", async () => {
    sb = sandbox();
    const seed = await runtime(AT, privateLeague());
    const store = openStore(seed.config, seed.io.clock, seed.log, { migrate: true });
    try {
      cachedPublicity(store.repos.espnCache, "0", seed.io.clock).save(false);
    } finally {
      store.close();
    }
    expect(await forcedRun(AT + 1_000)).toEqual([]);
    expect(await forcedRun(AT + PUBLICITY_MAX_AGE_MS + 60_000)).toHaveLength(1);
    expect(await forcedRun(AT + PUBLICITY_MAX_AGE_MS + 120_000)).toEqual([]);
  });

  it("`eff status` reads no ESPN view, known private or not", async () => {
    sb = sandbox();
    await forcedRun(AT);
    const f = privateLeague();
    const { exec } = fakeExec();
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock(new Date(AT + 60_000).toISOString()),
      platform: "darwin",
      exec,
      packageRoot: fakePackage(sb),
      env: ENV,
    });
    const { config, log } = await loadLenientRuntime(io);
    await status(io, config, log, { json: true });
    expect(f.urls).toEqual([]);
  });
});
