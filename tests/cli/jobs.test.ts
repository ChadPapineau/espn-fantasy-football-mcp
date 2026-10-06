// jobs.test.ts — the ESPN-credentialed jobs (plan 06 §1.4; ADV OBJ-04, OBJ-16) and the credential
// probes (plan 02 §2.1): a `rejected` row means ZERO requests for every job except the daily
// credential check; a job never overlaps itself; working runs self-select from epoch-ms instants;
// the credential check flips `rejected → validated` on a 200 and notifies ONCE per rejection; the
// check-auth rate limit; the composition root's probe access. ESPN answers come from an injected
// fetch serving the recorded, anonymised fixtures (league id 0) — no request leaves the process.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import {
  checkAuth,
  credentialCheck,
  hhmm,
  localDay,
  notifyRejectionOnce,
  rejectionText,
  verdictLine,
} from "../../src/cli/credential-check.js";
import {
  dayFirstKickoff,
  inSeasonWindow,
  isWorkingRun,
  startJob,
  endJob,
  weekFirstKickoff,
} from "../../src/cli/espn-jobs.js";
import {
  buildEspnStack,
  driftObservations,
  effCodeOf,
  leagueRefOf,
  withProbeAccess,
} from "../../src/cli/espn-stack.js";
import { readJobState, updateJobState } from "../../src/cli/job-state.js";
import { createNotifier } from "../../src/cli/notify.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import {
  goldenCounts,
  poolWorkingRun,
  preKickoff,
  preKickoffFindings,
  preKickoffText,
  projectionRows,
  rosterDiffText,
  snapshotPool,
  snapshotProjections,
  snapshotRoster,
  transactionsAppend,
} from "../../src/cli/snapshot.js";
import { openStore } from "../../src/cli/store-access.js";
import { composeBodies } from "../../src/providers/espn/index.js";
import type { ProSchedule, Roster, RosterSlots } from "../../src/providers/platform.js";
import { fakeCookies, MemoryStore, RecordingRegistrar, stateRow } from "../auth/helpers.js";
import {
  ROOT,
  fakeExec,
  fakeFetch,
  fakePackage,
  makeIo,
  movingClock,
  noNetwork,
  sandbox,
  type Sandbox,
} from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const REC = path.join(ROOT, "fixtures", "espn", "recorded");
const recorded = (rel: string): unknown => JSON.parse(readFileSync(path.join(REC, rel), "utf8"));
const COOKIES = fakeCookies("cli-jobs");
const jsonRes = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** An ESPN stand-in over the recorded fixtures; `cookieStatus` answers cookie-bearing mSettings. */
function espn(opts: { cookieStatus?: number } = {}) {
  return fakeFetch((url, init) => {
    const cookie = new Headers(init.headers).get("cookie");
    if (url.includes("view=proTeamSchedules_wl"))
      return jsonRes(recorded("season/proTeamSchedules_wl.json"));
    if (url.includes("/leagues/0")) {
      if (cookie === null && !url.includes("view=mNav"))
        return jsonRes({ messages: ["private"] }, 401);
      if (cookie !== null && opts.cookieStatus !== undefined && opts.cookieStatus !== 200)
        return jsonRes({}, opts.cookieStatus);
      return jsonRes(
        composeBodies(recorded("league-a/mSettings.json"), recorded("league-a/mNav.json")),
      );
    }
    return new Response(null, { status: 404 });
  });
}

async function runtime(env: Record<string, string> = {}, over: Parameters<typeof makeIo>[1] = {}) {
  const io = makeIo(sb, {
    clock: movingClock(),
    env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file", ...env },
    packageRoot: fakePackage(sb),
    ...over,
  });
  const { config, log } = await loadRuntime(io);
  return { io, config, log };
}

function plantSession(): void {
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  chmodSync(sb.configDir, 0o700);
  writeFileSync(
    path.join(sb.configDir, "session.json"),
    sessionFileBody(COOKIES, metaFor(COOKIES, "2026-10-01T00:00:00.000Z")),
    { mode: 0o600 },
  );
}

async function putRow(over: Parameters<typeof stateRow>[0]): Promise<void> {
  const { io, config, log } = await runtime();
  const store = openStore(config, io.clock, log, { migrate: true });
  store.repos.credentialState.put(stateRow({ store: "file", ...over }));
  store.close();
}

describe("pure helpers", () => {
  const game = (week: number, kickoff: string | null, tbd = false) => ({
    espn_game_id: week * 10,
    season: 2026,
    week,
    kickoff,
    start_time_tbd: tbd,
    valid_for_locking: true,
    stats_official: false,
    home_pro_team_id: 1,
    away_pro_team_id: 2,
  });
  const sched = (games: ReturnType<typeof game>[]): ProSchedule => ({
    season: 2026,
    teams: [
      { id: 1, abbrev: "ATL", bye_week: 6 },
      { id: 2, abbrev: "BUF", bye_week: 5 },
    ],
    games,
  });
  it("kickoff windows: the week's first, the day's first, the working run, season awareness", () => {
    sb = sandbox();
    const s = sched([
      game(5, "2026-10-08T00:15:00Z"),
      game(5, "2026-10-11T17:00:00Z"),
      game(6, "2026-10-15T00:15:00Z"),
      game(6, null, true),
      game(4, "2026-10-01T00:15:00Z"),
    ]);
    const now = Date.parse("2026-10-06T18:00:00Z");
    expect(weekFirstKickoff(s, now)).toEqual({ week: 5, at: Date.parse("2026-10-08T00:15:00Z") });
    expect(weekFirstKickoff(sched([]), now)).toBeNull();
    expect(inSeasonWindow(s, now)).toBe(true);
    expect(inSeasonWindow(sched([game(1, "2026-01-01T00:00:00Z")]), now)).toBe(false);
    const sunday = new Date(2026, 9, 11, 12, 0).getTime();
    const local = sched([
      game(5, new Date(2026, 9, 11, 13, 0).toISOString()),
      game(5, new Date(2026, 9, 11, 16, 25).toISOString()),
    ]);
    expect(dayFirstKickoff(local, sunday)).toBe(new Date(2026, 9, 11, 13, 0).getTime());
    expect(dayFirstKickoff(local, now)).toBeNull();
    expect(isWorkingRun(1000, 1000)).toBe(true);
    expect(isWorkingRun(1001, 1000)).toBe(false);
    expect(isWorkingRun(1000 - 3_600_000, 1000)).toBe(false);
    expect(isWorkingRun(1000 - 3_599_999, 1000)).toBe(true);
  });
  it("poolWorkingRun: 1 h after the anchor (once per anchor), or Tuesday 06:xx once a day", () => {
    sb = sandbox();
    const anchor = Date.parse("2026-10-07T15:00:00Z");
    expect(poolWorkingRun(anchor + 3_600_000, { "pool.anchor": anchor })).toBe("waivers");
    expect(
      poolWorkingRun(anchor + 3_600_000, { "pool.anchor": anchor, "pool.worked": anchor }),
    ).toBeNull();
    expect(poolWorkingRun(anchor + 1000, { "pool.anchor": anchor })).toBeNull();
    const tue6 = new Date(2026, 9, 6, 6, 0).getTime();
    expect(poolWorkingRun(tue6, {})).toBe("tuesday");
    expect(poolWorkingRun(tue6, { "pool.tuesday": localDay(tue6) })).toBeNull();
  });
  it("texts carry counts and slot names only; projection rows; the golden counts", () => {
    sb = sandbox();
    expect(
      rosterDiffText({ added: [], dropped: [], slot_changes: [], injury_changes: [] }),
    ).toBeNull();
    expect(
      rosterDiffText({
        added: [{ player_id: 1, slot: "BE" }],
        dropped: [],
        slot_changes: [],
        injury_changes: [],
      }),
    ).toMatch(/\+1 −0/);
    expect(
      preKickoffText(
        { empty_slots: [], out_starters: 0, doubtful_starters: 0, bye_starters: 0 },
        [],
      ),
    ).toBeNull();
    expect(
      preKickoffText(
        { empty_slots: ["FLEX", "FLEX"], out_starters: 1, doubtful_starters: 2, bye_starters: 1 },
        ["injuries"],
      ),
    ).toBe(
      "Before kickoff: 2 empty starting slot(s) (FLEX); 1 starter(s) OUT/IR; 1 starter(s) on bye; 2 DOUBTFUL starter(s); stale: injuries",
    );
    const p = (id: number, w: number | null, r: number | null) =>
      ({ ref: { platform: "espn", id }, projection_week_espn: w, projection_ros_espn: r }) as never;
    const rows = projectionRows(
      [p(1, 12.5, 150), p(1, 1, 1), p(2, null, Number.NaN)],
      2026,
      5,
      "t",
    );
    expect(rows.map((r) => [r.player_id, r.split, r.week])).toEqual([
      [1, "weekly", 5],
      [1, "ros", null],
    ]);
    expect(goldenCounts([], { settings_hash: "x" } as never)).toEqual({
      checked: 0,
      mismatched: 0,
    });
    const roster = {
      entries: [
        {
          slot_class: "starter",
          slot_id: 2,
          player: {
            ref: { id: 1 },
            eligible_slot_ids: [2],
            injury_status: "OUT",
            position: "RB",
            pro_team_id: 2,
          },
        },
        {
          slot_class: "starter",
          slot_id: 4,
          player: {
            ref: { id: 2 },
            eligible_slot_ids: [4],
            injury_status: "DOUBTFUL",
            position: "WR",
            pro_team_id: 1,
          },
        },
      ],
    } as unknown as Roster;
    const slots = {
      slots: [
        { slot_id: 2, name: "RB", class: "starter", count: 2, eligible_positions: [] },
        { slot_id: 4, name: "WR", class: "starter", count: 1, eligible_positions: [] },
      ],
    } as unknown as RosterSlots;
    const f = preKickoffFindings(
      roster,
      slots,
      sched([{ ...game(5, "2026-10-08T00:15:00Z"), away_pro_team_id: 3 }]),
      5,
    );
    expect(f).toEqual({
      empty_slots: ["RB"],
      out_starters: 1,
      doubtful_starters: 1,
      bye_starters: 1,
    });
    expect(preKickoffFindings(roster, slots, null, 5).bye_starters).toBe(0);
  });
  it("credential texts and verdict lines", () => {
    sb = sandbox();
    expect(hhmm(null)).toBe("the next scheduled check");
    expect(hhmm("garbage")).toBe("the next scheduled check");
    expect(hhmm(new Date(2026, 9, 6, 9, 5).toISOString())).toBe("09:05");
    expect(rejectionText(new Date(2026, 9, 6, 9, 5).toISOString(), null)).toBe(
      "ESPN rejected the stored cookies at 09:05; I will re-check at the next scheduled check — if that fails too, run `eff setup`",
    );
    expect(localDay(new Date(2026, 0, 2, 3).getTime())).toBe("2026-01-02");
    expect(
      verdictLine({
        accepted: false,
        probe: "settings",
        upstream_status: 401,
        reason: null,
        checked_at: "t",
      }),
    ).toBe("ESPN cookies: rejected; probe: settings, HTTP 401");
    expect(
      verdictLine({
        accepted: null,
        probe: "board",
        upstream_status: null,
        reason: "board_not_discriminating",
        checked_at: "t",
      }),
    ).toContain("unknown (board_not_discriminating)");
    expect(effCodeOf({ effCode: "ESPN_AUTH_REJECTED" })).toBe("ESPN_AUTH_REJECTED");
    expect(effCodeOf({ effCode: "lower" })).toBe("INTERNAL");
    expect(effCodeOf(null)).toBe("INTERNAL");
  });
});

describe("composition root", () => {
  it("probe access reads the store even when the authority is rejected; nothing stored → not_configured", async () => {
    sb = sandbox();
    const store = new MemoryStore("file");
    store.set(COOKIES, "2026-10-01T00:00:00.000Z");
    const reg = new RecordingRegistrar();
    const authority = {
      state: () => "rejected" as const,
      getCookieHeader: () => Promise.resolve({ ok: false as const, reason: "rejected" as const }),
      observe: () => Promise.resolve("rejected" as const),
      dropSecret: () => undefined,
      holdsSecret: () => false,
    };
    const p = withProbeAccess(authority, store, reg);
    const r = await p.getCookieHeaderForProbe();
    expect(r.ok).toBe(true);
    expect(reg.registered.some((x) => x.value === COOKIES.espn_s2)).toBe(true);
    expect((await p.getCookieHeader()).ok).toBe(false);
    expect(p.state()).toBe("rejected");
    expect(p.holdsSecret()).toBe(false);
    p.dropSecret();
    await p.observe({ kind: "accepted", at: "t", by: "doctor", upstream_status: 200, view: null });
    store.stored = null;
    expect(await p.getCookieHeaderForProbe()).toEqual({ ok: false, reason: "not_configured" });
    store.failRead = new Error("x");
    expect(await p.getCookieHeaderForProbe()).toEqual({ ok: false, reason: "unreadable" });
  });
  it("fixture mode composes no authority; the drift manifest loads from a checkout only", async () => {
    sb = sandbox();
    const { io, config, log } = await runtime(
      { EFF_FIXTURE_DIR: path.join(ROOT, "fixtures", "espn") },
      { packageRoot: ROOT },
    );
    const store = openStore(config, io.clock, log, { migrate: true });
    const stack = buildEspnStack(io, config, store, log, { origin: "server", observer: "server" });
    expect(stack.authority).toBeNull();
    expect(stack.ref).toEqual(leagueRefOf(config));
    stack.close();
    store.close();
    expect(driftObservations(io, log)).toBeDefined();
    const bad = fakePackage(sb);
    mkdirSync(path.join(bad, "fixtures", "drift"), { recursive: true });
    writeFileSync(path.join(bad, "fixtures", "drift", "manifest.json"), "{not json");
    expect(driftObservations(makeIo(sb, { packageRoot: bad }), log)).toBeUndefined();
  });
});

describe("the credential gate and the job lock", () => {
  it("a rejected row: every snapshot job exits 0 WITHOUT a request", async () => {
    sb = sandbox();
    await putRow({ state: "rejected", rejected_since: "2026-10-06T09:00:00.000Z" });
    for (const run of [
      (io: never, c: never, l: never) =>
        snapshotRoster(io, c, l, { notify: false, preKickoff: false }),
      (io: never, c: never, l: never) => snapshotPool(io, c, l, { notify: false }),
      (io: never, c: never, l: never) => snapshotProjections(io, c, l, { notify: false }),
      (io: never, c: never, l: never) =>
        transactionsAppend(io, c, l, { notify: false, force: true }),
      (io: never, c: never, l: never) => preKickoff(io, c, l, { notify: false }),
    ]) {
      const { io, config, log } = await runtime({}, { fetch: noNetwork });
      expect(await run(io as never, config as never, log as never)).toBe(0);
      expect(io.out.text).toContain("rejected — waiting for the daily credential check");
    }
  });
  it("a held job lock: the run does nothing (exit 0)", async () => {
    sb = sandbox();
    const { io, config, log } = await runtime({}, { fetch: noNetwork });
    const store = openStore(config, io.clock, log, { migrate: true });
    expect(
      store.repos.jobLock.acquire("job:snapshot-pool", process.pid, io.clock.nowIso(), 60_000),
    ).toBe(true);
    store.close();
    expect(await snapshotPool(io, config, log, { notify: false })).toBe(0);
    expect(io.out.text).toContain("another run holds the job lock");
    const run = await startJob(io, config, log, "free-job", { notify: false });
    expect(typeof run).toBe("object");
    if (typeof run === "object") endJob(io, run);
  });
  it("snapshot roster --pre-kickoff on a Tuesday: only the keyless schedule is read, nothing else", async () => {
    sb = sandbox();
    const f = espn();
    const { io, config, log } = await runtime({}, { fetch: f.fetch });
    expect(await snapshotRoster(io, config, log, { notify: false, preKickoff: true })).toBe(0);
    expect(io.out.text).toContain("not the run before the week's first kickoff");
    expect(f.urls.every((u) => u.includes("proTeamSchedules_wl"))).toBe(true);
    for (const init of f.inits) expect(new Headers(init.headers).has("cookie")).toBe(false);
    const pk = await runtime({}, { fetch: f.fetch });
    expect(await preKickoff(pk.io, pk.config, pk.log, { notify: false })).toBe(0);
    expect(pk.io.out.text).toContain("not the run before today's first kickoff");
  });
  it("snapshot pool off its working run refreshes the waiver anchor from the league (one read) and stops", async () => {
    sb = sandbox();
    plantSession();
    const f = espn();
    const { io, config, log } = await runtime({}, { fetch: f.fetch });
    expect(await snapshotPool(io, config, log, { notify: false })).toBe(0);
    expect(io.out.text).toContain("not a working run");
    const state = readJobState(config.cacheDir);
    expect(typeof state["pool.anchor"] === "number" || state["pool.anchor"] === undefined).toBe(
      true,
    );
    const t = await runtime({}, { fetch: noNetwork });
    expect(await transactionsAppend(t.io, t.config, t.log, { notify: false, force: false })).toBe(
      0,
    );
    expect(t.io.out.text).toContain("not 30 min after a pool run");
  });
});

describe("credential-check and check-auth", () => {
  it("no row: nothing to probe (exit 0, no request); fixture mode: nothing to check", async () => {
    sb = sandbox();
    const { io, config, log } = await runtime({}, { fetch: noNetwork });
    expect(await credentialCheck(io, config, log, { notify: false })).toBe(0);
    expect(io.out.text).toContain("nothing to probe");
    const fx = await runtime({ EFF_FIXTURE_DIR: path.join(ROOT, "fixtures", "espn") });
    expect(await credentialCheck(fx.io, fx.config, fx.log, { notify: false })).toBe(0);
    expect(await checkAuth(fx.io, fx.config, fx.log, { json: false })).toBe(0);
  });
  it("rejected → a 200 flips it to validated and says so once; the off-season cap stops a second probe", async () => {
    sb = sandbox();
    plantSession();
    await putRow({
      state: "rejected",
      rejected_since: "2026-10-06T09:00:00.000Z",
      last_rejected_at: "2026-10-06T09:00:00.000Z",
    });
    updateJobState(sb.cacheDir, { "alarm.credential": "2026-10-06T09:00:00.000Z" });
    const f = espn({ cookieStatus: 200 });
    const { exec, calls } = fakeExec();
    const { io, config, log } = await runtime({}, { fetch: f.fetch, platform: "darwin", exec });
    expect(await credentialCheck(io, config, log, { notify: true })).toBe(0);
    expect(io.out.text).toContain("ESPN cookies: accepted");
    expect(calls.map((c) => c.args[1] ?? "").join(" ")).toContain("accepted again");
    const store = openStore(config, io.clock, log, { migrate: false });
    expect(store.repos.credentialState.get()?.state).toBe("validated");
    store.close();
    const again = await runtime({}, { fetch: noNetwork });
    expect(await credentialCheck(again.io, again.config, again.log, { notify: false })).toBe(0);
    expect(again.io.out.text).toContain("probe cap is reached (1 off-season)");
  });
  it("a cookie 401: rejected, exit 3, ONE rejection notification naming the next probe; check-auth ≤ 1/min", async () => {
    sb = sandbox();
    plantSession();
    await putRow({ state: "stored" });
    const f = espn({ cookieStatus: 401 });
    const { exec, calls } = fakeExec();
    const { io, config, log } = await runtime({}, { fetch: f.fetch, platform: "darwin", exec });
    expect(await credentialCheck(io, config, log, { notify: true })).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toContain("ESPN rejected the stored cookies");
    const store = openStore(config, io.clock, log, { migrate: false });
    const notifier = createNotifier({
      platform: "darwin",
      exec,
      clock: io.clock,
      cacheDir: config.cacheDir,
    });
    expect(await notifyRejectionOnce(store, config.cacheDir, notifier)).toBe(false);
    store.close();
    expect(calls).toHaveLength(1);
    const ca = await runtime({}, { fetch: f.fetch });
    expect(await checkAuth(ca.io, ca.config, ca.log, { json: true })).toBe(3);
    expect(JSON.parse(ca.io.out.text)).toMatchObject({ accepted: false, probe: "settings" });
    const soon = await runtime({}, { fetch: f.fetch, clock: ca.io.clock });
    expect(await checkAuth(soon.io, soon.config, soon.log, { json: false })).toBe(1);
    expect(soon.io.err.text).toContain("at most one probe per minute");
  });
});
