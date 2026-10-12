// espn-season.test.ts — the keyless ESPN season sources (src/sources/espn_season; plan 10 §3.1a
// *Sources*; plan 06 §1.3; tables.ts DS_PRO_SCHEDULE / DS_PRO_TEAMS / DS_PLAYERS): the row mapping
// over the RECORDED season views (272 games collapsed from 544 entries, 33 teams, the player index),
// the row filters and hostile values, the conflicting-duplicate refusal, the time-bucket versions,
// fetch (the read host only, the players_wl filter, a new season's 404 is "not published", any other
// status an HttpError the runner classifies), the schema assertion, and the whole refresh through
// the real runner + publisher + store, read back through the store's own readers; the drift gate
// (plan 01 §5.5 "fails loudly, previous load stays"; plan 10 B1): a drifted body — ISO dates, a
// renamed per-period map, a reshaped or empty player index — fails schema_mismatch naming the field
// and never replaces the published dataset. No network.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupDir, datasetDir, storePath } from "../../../src/config/paths.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { HttpError } from "../../../src/http/errors.js";
import {
  checkPlayers,
  checkProSchedule,
  espnSeasonSources,
  EspnSeasonSourceError,
  MAX_SKIPPED_PLAYER_SHARE,
  playersRows,
  PLAYERS_WL_FILTER,
  proScheduleRows,
} from "../../../src/sources/espn_season/index.js";
import { fsTempArea, runRefresh, seasonState } from "../../../src/sources/runner.js";
import type { HttpGet, SourceContext } from "../../../src/sources/source.js";
import { storeFactory } from "../../../src/store/index.js";
import { SqliteWriter } from "../nflverse/helpers/harness.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const rec = (rel: string): unknown =>
  JSON.parse(
    readFileSync(path.join(ROOT, "fixtures/espn/recorded/season", rel), "utf8"),
  ) as unknown;
const SCHEDULE = rec("proTeamSchedules_wl.json");
const PLAYERS = rec("players_wl.json");
const HOST = "lm-api-reads.fantasy.espn.com";
const bytes = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "eff-espn-season-"));
  dirs.push(d);
  return d;
};

/** A fake GET over the season routes; records url + filter; `answer` overrides by URL. */
function fakeGet(answer: (url: string) => Uint8Array | number | Error = () => 404) {
  const calls: { url: string; filter: string | undefined }[] = [];
  const get: HttpGet = (url, opts) => {
    calls.push({ url, filter: opts.fantasyFilter });
    const a = answer(url);
    if (a instanceof Error) return Promise.reject(a);
    if (typeof a === "number")
      return Promise.resolve({ status: a, body: new Uint8Array(), headers: {}, final_url: url });
    return Promise.resolve({ status: 200, body: a, headers: {}, final_url: url });
  };
  return { get, calls };
}
const routes = (url: string): Uint8Array | number => {
  if (url === `https://${HOST}/apis/v3/games/ffl/seasons/2026?view=proTeamSchedules_wl`)
    return bytes(SCHEDULE);
  if (url === `https://${HOST}/apis/v3/games/ffl/seasons/2026/players?view=players_wl`)
    return bytes(PLAYERS);
  return 404;
};

function ctxOf(get: HttpGet, seasons: number[] = [2026]) {
  const tempDir = temp();
  const unpublished: number[] = [];
  const ctx: SourceContext = {
    http: get,
    download: () => Promise.reject(new Error("no downloads")),
    signal: new AbortController().signal,
    clock: fixedClock("2026-10-06T12:34:56.000Z"),
    seasons,
    week: null,
    datasets: {
      proSchedule: {
        games: () => ({ rows: [], stamp: null }),
        teams: () => ({ rows: [], stamp: null }),
      },
    },
    tempDir,
    notPublished: (s) => unpublished.push(s),
  };
  return { ctx, unpublished };
}

describe("row mapping over the recorded season views", () => {
  it("proTeamSchedules_wl: 272 games (each listed under both teams) and 33 pro teams", () => {
    const r = proScheduleRows(SCHEDULE, 2026);
    expect(r.games).toHaveLength(272);
    expect(r.teams).toHaveLength(33);
    expect(r.skipped).toBe(0);
    expect(r.teams.find((t) => t.pro_team_id === 0)).toMatchObject({
      abbrev: "FA",
      bye_week: null,
    });
    expect(r.games.filter((g) => g.start_time_tbd === 1).length).toBeGreaterThan(0);
    for (const g of r.games) {
      expect(g.season).toBe(2026);
      expect([0, 1]).toContain(g.stats_official);
    }
  });

  it("players_wl: one row per player id, team units included, % owned bounded", () => {
    const r = playersRows(PLAYERS, 2026);
    expect(r.rows.length).toBeGreaterThan(2500);
    expect(r.rows.some((p) => (p.espn_id as number) < 0)).toBe(true);
    for (const p of r.rows) {
      if (p.percent_owned !== null) expect(p.percent_owned as number).toBeLessThanOrEqual(100);
      if (p.eligible_slots !== null)
        expect(Array.isArray(JSON.parse(p.eligible_slots as string))).toBe(true);
    }
  });

  it("skips malformed entries and keeps the rest; refuses a non-object body", () => {
    const sched = {
      settings: {
        proTeams: [
          {
            id: 1,
            abbrev: "ATL",
            byeWeek: 99,
            proGamesByScoringPeriod: {
              "1": [
                {
                  id: 5,
                  scoringPeriodId: 1,
                  date: -4,
                  startTimeTBD: false,
                  validForLocking: "yes",
                  statsOfficial: true,
                  homeProTeamId: 1,
                  awayProTeamId: 2,
                },
                "junk",
                {
                  id: 6,
                  scoringPeriodId: 1,
                  date: 1e12,
                  startTimeTBD: true,
                  validForLocking: true,
                  statsOfficial: false,
                  homeProTeamId: 2,
                  awayProTeamId: 1,
                },
              ],
              "2": "not a list",
            },
          },
          { id: "x", abbrev: "BAD" },
          { id: 2, abbrev: "", location: 1 },
          { id: 3, abbrev: "NOG", proGamesByScoringPeriod: null },
        ],
      },
    };
    const r = proScheduleRows(sched, 2026);
    expect(r.games).toEqual([
      {
        season: 2026,
        espn_game_id: 6,
        week: 1,
        date_ms: 1e12,
        start_time_tbd: 1,
        valid_for_locking: 1,
        stats_official: 0,
        home_pro_team_id: 2,
        away_pro_team_id: 1,
      },
    ]);
    expect(r.teams.map((t) => t.abbrev)).toEqual(["ATL", "NOG"]);
    expect(r.teams[0]?.bye_week).toBeNull();
    expect(r.skipped).toBe(4);
    for (const bad of [null, [], { settings: {} }, { settings: { proTeams: {} } }, "x"])
      expect(() => proScheduleRows(bad, 2026)).toThrow(EspnSeasonSourceError);
  });

  it("a game id listed twice with different fields is a schema mismatch", () => {
    const g = {
      id: 9,
      scoringPeriodId: 1,
      date: 1,
      startTimeTBD: false,
      validForLocking: true,
      statsOfficial: true,
      homeProTeamId: 1,
      awayProTeamId: 2,
    };
    const ok = {
      settings: {
        proTeams: [
          { id: 1, abbrev: "A", proGamesByScoringPeriod: { "1": [g] } },
          { id: 2, abbrev: "B", proGamesByScoringPeriod: { "1": [g] } },
        ],
      },
    };
    expect(proScheduleRows(ok, 2026).games).toHaveLength(1);
    const bad = {
      settings: {
        proTeams: [
          { id: 1, abbrev: "A", proGamesByScoringPeriod: { "1": [g] } },
          { id: 2, abbrev: "B", proGamesByScoringPeriod: { "1": [{ ...g, date: 2 }] } },
        ],
      },
    };
    expect(() => proScheduleRows(bad, 2026)).toThrow(/different fields/);
  });

  it("players: the row filter, duplicates, hostile values kept as data", () => {
    const hostile = "Robert'); DROP TABLE ds_players;-- ‮\u0000";
    const r = playersRows(
      [
        {
          id: 1,
          fullName: hostile,
          defaultPositionId: 2,
          proTeamId: 3,
          eligibleSlots: [2, "x"],
          ownership: { percentOwned: 101 },
          droppable: "no",
          lastNewsDate: -1,
        },
        { id: 1, fullName: "Dup", defaultPositionId: 2, proTeamId: 3 },
        { id: 2.5, fullName: "Frac", defaultPositionId: 2, proTeamId: 3 },
        { id: 3, fullName: "", defaultPositionId: 2, proTeamId: 3 },
        { id: 4, fullName: "NoPos", proTeamId: 3 },
        "junk",
        {
          id: 5,
          fullName: "Ok",
          firstName: "O",
          lastName: "K",
          defaultPositionId: 4,
          proTeamId: 0,
          eligibleSlots: [6, 20],
          ownership: { percentOwned: 0.5 },
          droppable: true,
          lastNewsDate: 1791258096000,
        },
      ],
      2026,
    );
    expect(r.rows.map((p) => p.espn_id)).toEqual([1, 5]);
    expect(r.rows[0]).toMatchObject({
      full_name: hostile,
      eligible_slots: null,
      percent_owned: null,
      droppable: null,
      last_news_date_ms: null,
      first_name: null,
    });
    expect(r.rows[1]).toMatchObject({
      eligible_slots: "[6,20]",
      percent_owned: 0.5,
      droppable: 1,
      first_name: "O",
    });
    expect(r.skipped).toBe(5);
    expect(() => playersRows({ players: [] }, 2026)).toThrow(EspnSeasonSourceError);
    expect(() => playersRows(new Array(20_001).fill(null), 2026)).toThrow(/too many/);
  });
});

describe("the sources", () => {
  const { proSchedule, players } = espnSeasonSources();

  it("registry facts: ids, jobs, tables, keyless spacing, always-on, time-bucket versions", async () => {
    expect([proSchedule.id, proSchedule.job]).toEqual(["espn:pro_schedule", "espn:schedule"]);
    expect([players.id, players.job]).toEqual(["espn:players", "espn:players"]);
    expect(proSchedule.tables.map((t) => t.name)).toEqual(["ds_pro_schedule", "ds_pro_teams"]);
    expect(players.tables.map((t) => t.name)).toEqual(["ds_players"]);
    expect(proSchedule.seasonGate).toBe("always");
    expect(proSchedule.versioning).toBe("time_bucket");
    const { ctx } = ctxOf(fakeGet().get, [2025, 2026]);
    expect((await proSchedule.version(ctx))?.version).toBe("2026100612_2025-2026");
    expect((await players.version(ctx))?.version).toBe("20261006_2025-2026");
    expect(() => espnSeasonSources("bad host/")).toThrow(RangeError);
  });

  it("fetch: the read host, the players_wl filter; a new season's 404 is not published; other statuses throw", async () => {
    const f = fakeGet(routes);
    const { ctx, unpublished } = ctxOf(f.get, [2026, 2027]);
    const files = await players.fetch({ version: "v", released_at: null }, ctx);
    expect(files).toHaveLength(1);
    expect(files[0]?.season).toBe(2026);
    expect(unpublished).toEqual([2027]);
    expect(
      f.calls.every((c) => c.url.startsWith(`https://${HOST}/`) && c.filter === PLAYERS_WL_FILTER),
    ).toBe(true);
    const s = fakeGet(routes);
    await proSchedule.fetch({ version: "v", released_at: null }, ctxOf(s.get).ctx);
    expect(s.calls[0]?.filter).toBeUndefined();
    for (const status of [429, 500, 403]) {
      const e = await proSchedule
        .fetch({ version: "v", released_at: null }, ctxOf(fakeGet(() => status).get).ctx)
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(status);
      expect((e as HttpError).espn).toBe(true);
    }
    const thrown404 = new HttpError({ kind: "http_4xx", status: 404, host: HOST, espn: true });
    const t = ctxOf(fakeGet(() => thrown404).get);
    expect(await proSchedule.fetch({ version: "v", released_at: null }, t.ctx)).toEqual([]);
    expect(t.unpublished).toEqual([2026]);
    const net = new HttpError({ kind: "dns", host: HOST, espn: true });
    await expect(
      proSchedule.fetch({ version: "v", released_at: null }, ctxOf(fakeGet(() => net).get).ctx),
    ).rejects.toBe(net);
  });

  it("assertSchema: ok on the recorded bodies, fails on non-JSON, a wrong shape or no file", async () => {
    const { ctx } = ctxOf(fakeGet(routes).get);
    const files = await proSchedule.fetch({ version: "v", released_at: null }, ctx);
    expect(await proSchedule.assertSchema(files)).toMatchObject({
      ok: true,
      rows: 272,
      missing_columns: [],
    });
    expect((await proSchedule.assertSchema([])).ok).toBe(false);
    const junk = ctxOf(fakeGet(() => new TextEncoder().encode("<html>")).get);
    const bad = await proSchedule.fetch({ version: "v", released_at: null }, junk.ctx);
    const r = await proSchedule.assertSchema(bad);
    expect(r.ok).toBe(false);
    expect(r.missing_columns[0]).toMatch(/not JSON/);
    const shape = ctxOf(fakeGet(() => bytes({ players: [] })).get);
    const rp = await players.assertSchema(
      await players.fetch({ version: "v", released_at: null }, shape.ctx),
    );
    expect(rp.missing_columns[0]).toMatch(/not a root array/);
  });

  it("publish writes the contract tables into a fresh dataset file", async () => {
    const { ctx } = ctxOf(fakeGet(routes).get);
    const files = await proSchedule.fetch({ version: "v", released_at: null }, ctx);
    const w = new SqliteWriter(temp());
    const stats = await proSchedule.publish(files, w);
    expect(stats.tables).toEqual([
      { name: "ds_pro_schedule", rows: 272 },
      { name: "ds_pro_teams", rows: 33 },
    ]);
    expect(stats.seasons).toEqual([2026]);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM ds_pro_schedule").get()).toEqual({ n: 272 });
  });
});

describe("the whole refresh through the runner, the publisher and the store", () => {
  it("publishes both datasets; the store's readers see the schedule and the player universe; a rerun in the bucket is unchanged", async () => {
    const root = temp();
    const cache = path.join(root, "cache");
    mkdirSync(cache, { mode: 0o700 });
    const clock = fixedClock("2026-10-06T12:00:00.000Z");
    const sp = storePath(cache);
    const dd = datasetDir(cache);
    const store = storeFactory.open({
      path: sp,
      datasetDir: dd,
      backupDir: backupDir(cache),
      clock,
      migrate: true,
    });
    const publisher = storeFactory.openPublisher({ storePath: sp, datasetDir: dd, clock });
    const { proSchedule, players } = espnSeasonSources();
    const f = fakeGet(routes);
    try {
      const deps = {
        http: f.get,
        download: () => Promise.reject(new Error("no downloads")),
        clock,
        rng: seededRng(1),
        publisher,
        refreshLog: store.repos.refreshLog,
        proSchedule: store.datasets.proSchedule,
        temp: fsTempArea(path.join(cache, "tmp")),
        sleep: () => Promise.resolve(),
      };
      for (const source of [proSchedule, players]) {
        const r = await runRefresh({ source, seasons: [2026], week: null }, deps);
        expect(r.status, source.id).toBe("published");
      }
      store.reopenChangedDatasets();
      expect(store.datasets.proSchedule.games(2026, [1]).rows.length).toBe(16);
      expect(store.datasets.proSchedule.teams(2026).rows.length).toBe(33);
      expect(store.playerUniverse.all(2026).rows.length).toBeGreaterThan(2500);
      const again = await runRefresh({ source: proSchedule, seasons: [2026], week: null }, deps);
      expect(again.status).toBe("unchanged");
      expect(f.calls.length).toBe(2);
    } finally {
      publisher.close();
      store.close();
    }
  });
});

// --- the drift gate (Stage C remediation: sources-espn-season-drift-publishes) ----------------------

type Json = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const teamsOf = (body: unknown): Json[] =>
  (body as { settings: { proTeams: Json[] } }).settings.proTeams;

/** Every game's epoch `date` rewritten as an ISO string (a realistic ESPN type change). */
function isoDates(body: unknown): unknown {
  const out = clone(body);
  for (const t of teamsOf(out))
    for (const list of Object.values(t.proGamesByScoringPeriod as Record<string, Json[]>))
      for (const g of list) g.date = new Date(g.date as number).toISOString();
  return out;
}
/** The per-period map renamed on every team (ESPN renames a key). */
function renamedMap(body: unknown): unknown {
  const out = clone(body);
  for (const t of teamsOf(out)) {
    t.proGamesByPeriod = t.proGamesByScoringPeriod;
    delete t.proGamesByScoringPeriod;
  }
  return out;
}
/** One team's per-period map emptied (a partial body). */
function oneTeamEmpty(body: unknown): unknown {
  const out = clone(body);
  const victim = teamsOf(out).find((t) => t.id === 1)!;
  const victimId = victim.id as number;
  victim.proGamesByScoringPeriod = {};
  for (const t of teamsOf(out)) {
    const map = t.proGamesByScoringPeriod as Record<string, Json[]>;
    for (const k of Object.keys(map))
      map[k] = (map[k] ?? []).filter(
        (g) => g.homeProTeamId !== victimId && g.awayProTeamId !== victimId,
      );
  }
  return out;
}
/** Every player's `fullName` renamed (all entries skipped). */
function renamedPlayers(body: unknown): unknown {
  return (clone(body) as Json[]).map(({ fullName, ...rest }) => ({ ...rest, name: fullName }));
}

describe("the drift gate over one body", () => {
  it("the recorded views pass with no field named", () => {
    expect(checkProSchedule(SCHEDULE, 2026)).toEqual({ rows: 272, fields: [], problems: [] });
    const p = checkPlayers(PLAYERS, 2026);
    expect(p.fields).toEqual([]);
    expect(p.problems).toEqual([]);
    expect(p.rows).toBeGreaterThan(2500);
  });

  it("an ISO `date` fails naming `date` (it used to publish 272 games without a kickoff)", () => {
    const c = checkProSchedule(isoDates(SCHEDULE), 2026);
    expect(c.fields).toEqual(["date"]);
    expect(c.problems.join(" ")).toMatch(/544 team or game entries miss or mistype/);
  });

  it("a renamed per-period map fails naming it (it used to publish 0 games)", () => {
    const c = checkProSchedule(renamedMap(SCHEDULE), 2026);
    expect(c.rows).toBe(0);
    expect(c.fields).toEqual(["proGamesByScoringPeriod"]);
    expect(c.problems).toContain("no games");
  });

  it("a team that plays no game fails; the free-agent pseudo-team's empty map is expected", () => {
    const c = checkProSchedule(oneTeamEmpty(SCHEDULE), 2026);
    expect(c.fields).toEqual(["proGamesByScoringPeriod"]);
    expect(c.problems).toEqual(["1 pro team(s) play in no game"]);
  });

  it("any mistyped required field of a team or game fails, naming each field", () => {
    const out = clone(SCHEDULE);
    const [a, b] = teamsOf(out);
    a!.byeWeek = "5";
    const g = Object.values(b!.proGamesByScoringPeriod as Record<string, Json[]>)[0]?.[0];
    g!.statsOfficial = "false";
    const c = checkProSchedule(out, 2026);
    expect(c.fields).toEqual(["byeWeek", "statsOfficial"]);
    expect(proScheduleRows(out, 2026).invalid).toBe(2);
  });

  it("a non-list period entry is drift too", () => {
    const out = clone(SCHEDULE);
    (teamsOf(out)[1]!.proGamesByScoringPeriod as Json)["99"] = "x";
    expect(checkProSchedule(out, 2026).fields).toEqual(["proGamesByScoringPeriod"]);
  });

  it("players: a renamed field, an empty index or junk fails; a skip under the share is tolerated", () => {
    expect(checkPlayers(renamedPlayers(PLAYERS), 2026)).toMatchObject({
      rows: 0,
      fields: ["fullName"],
    });
    expect(checkPlayers([], 2026)).toMatchObject({ rows: 0, fields: ["players_wl"] });
    expect(checkPlayers(["junk"], 2026)).toMatchObject({ rows: 0, fields: ["players_wl"] });
    const list = clone(PLAYERS) as Json[];
    const tolerated = Math.floor(list.length * MAX_SKIPPED_PLAYER_SHARE);
    for (let i = 0; i < tolerated; i++) delete list[i]!.proTeamId;
    expect(checkPlayers(list, 2026)).toMatchObject({ fields: [], problems: [] });
    delete list[tolerated]!.proTeamId;
    const over = checkPlayers(list, 2026);
    expect(over.fields).toEqual(["proTeamId"]);
    expect(over.problems[0]).toMatch(/entries skipped \(proTeamId\)/);
    // a duplicate id counts against the share and names `id`
    const dup = clone(PLAYERS) as Json[];
    for (let i = 1; i <= tolerated + 1; i++) dup[i]!.id = dup[0]!.id;
    expect(checkPlayers(dup, 2026).fields).toEqual(["id"]);
  });
});

describe("the drift gate through the runner, the publisher and the store", () => {
  /** A store + publisher with the recorded views published at 12:00; `drifted` serves the next hour. */
  async function publishedThenDrifted(
    source: "proSchedule" | "players",
    drifted: unknown,
  ): Promise<{
    first: Awaited<ReturnType<typeof runRefresh>>;
    second: Awaited<ReturnType<typeof runRefresh>>;
    store: ReturnType<typeof storeFactory.open>;
    close: () => void;
  }> {
    const root = temp();
    const cache = path.join(root, "cache");
    mkdirSync(cache, { mode: 0o700 });
    const clock = fixedClock("2026-10-06T12:00:00.000Z");
    const sp = storePath(cache);
    const dd = datasetDir(cache);
    const store = storeFactory.open({
      path: sp,
      datasetDir: dd,
      backupDir: backupDir(cache),
      clock,
      migrate: true,
    });
    const publisher = storeFactory.openPublisher({ storePath: sp, datasetDir: dd, clock });
    let served: unknown = null;
    const f = fakeGet((url) => (served === null ? routes(url) : bytes(served)));
    const deps = {
      http: f.get,
      download: () => Promise.reject(new Error("no downloads")),
      clock,
      rng: seededRng(1),
      publisher,
      refreshLog: store.repos.refreshLog,
      proSchedule: store.datasets.proSchedule,
      temp: fsTempArea(path.join(cache, "tmp")),
      sleep: () => Promise.resolve(),
    };
    const src = espnSeasonSources()[source];
    const first = await runRefresh({ source: src, seasons: [2026], week: null }, deps);
    store.reopenChangedDatasets();
    served = drifted;
    clock.advance(source === "players" ? 86_400_000 : 3_600_000); // the next bucket
    const second = await runRefresh({ source: src, seasons: [2026], week: null }, deps);
    store.reopenChangedDatasets();
    return {
      first,
      second,
      store,
      close: () => {
        publisher.close();
        store.close();
      },
    };
  }

  it.each([
    ["ISO dates", isoDates(SCHEDULE), "date"],
    ["a renamed per-period map", renamedMap(SCHEDULE), "proGamesByScoringPeriod"],
  ])(
    "schedule with %s: failed schema_mismatch naming the field; the good schedule stays served and the season stays in_season",
    async (_label, drifted, field) => {
      const h = await publishedThenDrifted("proSchedule", drifted);
      try {
        expect(h.first.status).toBe("published");
        expect(h.second).toMatchObject({
          status: "failed",
          error: "schema",
          source_error: "schema_mismatch",
        });
        expect(h.second.status === "failed" && h.second.message).toContain(field);
        const games = h.store.datasets.proSchedule.games(2026, null).rows;
        expect(games).toHaveLength(272);
        expect(games.every((g) => g.kickoff !== null)).toBe(true);
        expect(
          seasonState(h.store.datasets.proSchedule, 2026, Date.parse("2026-10-06T13:00:00.000Z")),
        ).toBe("in_season");
        const latest = h.store.repos.refreshLog.latest("espn:pro_schedule");
        expect(latest).toMatchObject({ ok: false, error: "schema_mismatch" });
      } finally {
        h.close();
      }
    },
  );

  it("a tolerated skip publishes and its count reaches the result's warnings (sources-publish-warnings-discarded)", async () => {
    const list = clone(PLAYERS) as Json[];
    for (let i = 0; i < 3; i++) delete list[i]!.proTeamId;
    const h = await publishedThenDrifted("players", list);
    try {
      expect(h.second.status).toBe("published");
      expect(h.second.status === "published" && h.second.warnings).toContain(
        "espn:players: 3 entries skipped (no id, name, position or team)",
      );
    } finally {
      h.close();
    }
  });

  it.each([
    ["a renamed field", renamedPlayers(PLAYERS)],
    ["an empty index", []],
  ])(
    "players with %s: failed schema_mismatch; the published universe stays",
    async (_label, drifted) => {
      const h = await publishedThenDrifted("players", drifted);
      try {
        expect(h.first.status).toBe("published");
        expect(h.second).toMatchObject({ status: "failed", source_error: "schema_mismatch" });
        expect(h.store.playerUniverse.all(2026).rows.length).toBeGreaterThan(2500);
      } finally {
        h.close();
      }
    },
  );
});
