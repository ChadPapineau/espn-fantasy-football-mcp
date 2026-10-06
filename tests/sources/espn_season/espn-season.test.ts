// espn-season.test.ts — the keyless ESPN season sources (src/sources/espn_season; plan 10 §3.1a
// *Sources*; plan 06 §1.3; tables.ts DS_PRO_SCHEDULE / DS_PRO_TEAMS / DS_PLAYERS): the row mapping
// over the RECORDED season views (272 games collapsed from 544 entries, 33 teams, the player index),
// the row filters and hostile values, the conflicting-duplicate refusal, the time-bucket versions,
// fetch (the read host only, the players_wl filter, a new season's 404 is "not published", any other
// status an HttpError the runner classifies), the schema assertion, and the whole refresh through
// the real runner + publisher + store, read back through the store's own readers. No network.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupDir, datasetDir, storePath } from "../../../src/config/paths.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { HttpError } from "../../../src/http/errors.js";
import {
  espnSeasonSources,
  EspnSeasonSourceError,
  playersRows,
  PLAYERS_WL_FILTER,
  proScheduleRows,
} from "../../../src/sources/espn_season/index.js";
import { fsTempArea, runRefresh } from "../../../src/sources/runner.js";
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
