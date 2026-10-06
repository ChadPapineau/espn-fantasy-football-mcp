// readers.test.ts — the dataset ports over READER_QUERIES (src/store/datasets/tables.ts mappings;
// plan 01 §5.2/§5.5; plan 07 §2 stamps; plan 01 §4.4 third-party text wrapped): each mapping on
// synthetic rows, two-statement joins in code (defence lines + points allowed; players + pro-team
// abbreviations; weather preference then fallback), the never-loaded outcome, and hostile inputs
// (bounded lists, bad seasons/weeks, ids that never reach SQL, SQL-shaped strings bound as data).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUntrustedText } from "../../src/domain/league/types.js";
import { READER_LIST_MAX } from "../../src/store/datasets/readers.js";
import { nflPlayersReaderOf } from "../../src/store/store.js";
import type { DatasetPublisher, Store } from "../../src/store/types.js";
import {
  GAME_W1,
  GAME_W1B,
  GAME_W2,
  GSIS_K,
  GSIS_QB,
  GSIS_WR,
  injuriesTables,
  nflPlayersTables,
  playersTables,
  proScheduleTables,
  publishTables,
  RELEASE,
  rosterWeeklyTables,
  schedulesTables,
  statsTables,
  weatherTables,
} from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let pub: DatasetPublisher;
let s: Store;
let warnings: string[];

async function publishAll(): Promise<void> {
  await publishTables(pub, "espn:pro_schedule", "ps-1", proScheduleTables());
  await publishTables(pub, "espn:players", "pl-1", playersTables());
  await publishTables(pub, "nflverse:schedules", "sc-1", schedulesTables());
  await publishTables(pub, "nflverse:injuries", "in-1", injuriesTables());
  await publishTables(pub, "nflverse:roster_weekly", "rw-1", rosterWeeklyTables());
  await publishTables(pub, "nflverse:players", "np-1", nflPlayersTables());
  await publishTables(pub, "nflverse:stats_player_week", "st-1", statsTables());
  await publishTables(pub, "weather:open_meteo", "om-1", weatherTables("open_meteo"));
  await publishTables(pub, "weather:nws", "nws-1", weatherTables("nws"));
}

beforeEach(() => {
  t = tempCache();
  pub = openPublisher(t);
  warnings = [];
  s = openStore(t, { onWarning: (c) => warnings.push(c) });
});
afterEach(() => {
  s.close();
  pub.close();
  t.cleanup();
});

describe("never loaded", () => {
  it("every port answers { rows: [], stamp: null } before any publish — never an exception", () => {
    const empty = { rows: [], stamp: null };
    expect(s.datasets.proSchedule.games(2026, null)).toEqual(empty);
    expect(s.datasets.proSchedule.teams(2026)).toEqual(empty);
    expect(s.datasets.nflGames.games(2026, [1])).toEqual(empty);
    expect(s.datasets.nflGames.byEspnGameId([1])).toEqual(empty);
    expect(s.datasets.injuries.reports(2026, 1, null)).toEqual(empty);
    expect(s.datasets.playerWeeks.lines([GSIS_QB], 2026, [1])).toEqual(empty);
    expect(s.datasets.playerWeeks.defenseLines(["BUF"], 2026, [1])).toEqual(empty);
    expect(s.datasets.weather.forGames([GAME_W1])).toEqual(empty);
    expect(s.datasets.depthCharts.chart(2026, ["BUF"])).toEqual(empty);
    expect(s.datasets.epWeekly.rows([GSIS_QB], 2026, [1])).toEqual(empty);
    expect(s.datasets.news.recent("2026-10-01T00:00:00.000Z", 10, null)).toEqual(empty);
    expect(s.datasets.trending.latest()).toEqual(empty);
    expect(s.rosterWeekly.latest(2026)).toEqual(empty);
    expect(s.rosterWeekly.byEspnId(9000001)).toEqual(empty);
    expect(s.rosterWeekly.byEspnId(-1)).toEqual(empty);
    expect(s.playerUniverse.all(2026)).toEqual(empty);
    expect(s.playerUniverse.byIds([9000001])).toEqual(empty);
    expect(nflPlayersReaderOf(s)?.byEspnIds([9000009])).toEqual(empty);
  });
});

describe("espn:pro_schedule", () => {
  beforeEach(publishAll);

  it("games: ordered by kickoff (TBD/null last), flags as booleans, epoch ms → ISO", () => {
    const res = s.datasets.proSchedule.games(2026, null);
    expect(res.stamp).toMatchObject({
      source: "espn:pro_schedule",
      file_version: "ps-1",
      as_of: RELEASE,
    });
    expect(res.rows).toEqual([
      {
        espn_game_id: 900000001,
        season: 2026,
        week: 1,
        kickoff: "2026-09-13T17:00:00.000Z",
        start_time_tbd: false,
        valid_for_locking: true,
        stats_official: true,
        home_pro_team_id: 15,
        away_pro_team_id: 2,
      },
      expect.objectContaining({ espn_game_id: 900000002, kickoff: "2026-09-14T00:20:00.000Z" }),
      expect.objectContaining({
        espn_game_id: 900000003,
        kickoff: null,
        start_time_tbd: true,
        valid_for_locking: false,
      }),
    ]);
    expect(s.datasets.proSchedule.games(2026, [2]).rows.map((g) => g.espn_game_id)).toEqual([
      900000003,
    ]);
    expect(s.datasets.proSchedule.games(2026, []).rows).toEqual([]);
    expect(s.datasets.proSchedule.games(2025, null).rows).toEqual([]);
  });

  it("teams: id, ESPN abbreviation, bye (FA → null)", () => {
    expect(s.datasets.proSchedule.teams(2026).rows).toEqual([
      { id: 0, abbrev: "FA", bye_week: null },
      { id: 2, abbrev: "BUF", bye_week: 7 },
      { id: 15, abbrev: "MIA", bye_week: 12 },
      { id: 28, abbrev: "WSH", bye_week: 9 },
    ]);
  });
});

describe("nflverse:schedules", () => {
  beforeEach(publishAll);

  it("games: lines, implied points, final score, roof from the venue default, stadium wrapped", () => {
    const res = s.datasets.nflGames.games(2026, [1]);
    const [g1, g2] = res.rows;
    expect(g1).toMatchObject({
      game_id: GAME_W1,
      espn_game_id: 900000001,
      season: 2026,
      week: 1,
      kickoff: "2026-09-13T17:00:00.000Z",
      away: "BUF",
      home: "MIA",
      roof: "outdoors",
      surface: "grass",
      divisional: true,
      rest_days: { away: 7, home: 7 },
      is_final: true,
      score: { away: 27, home: 20 },
    });
    expect(g1?.lines).toEqual({
      spread_line: -3.5,
      total_line: 48.5,
      implied: { away: 26, home: 22.5 },
      moneyline: { away: -170, home: 145 },
      as_of: RELEASE,
    });
    expect(isUntrustedText(g1?.stadium)).toBe(true);
    expect(g1?.stadium?.untrusted_text).toMatchObject({
      value: "Test Field North",
      source: "nflverse.schedules.stadium",
    });
    expect(g2).toMatchObject({
      game_id: GAME_W1B,
      roof: "dome",
      lines: null,
      is_final: false,
      score: null,
      divisional: null,
      stadium: null,
    });
  });

  it("a row with a non-NflTeam abbreviation is skipped and warned", () => {
    const res = s.datasets.nflGames.games(2026, [2]);
    expect(res.rows.map((g) => g.game_id)).toEqual([GAME_W2]);
    expect(warnings).toContain("dataset_row_skipped_team");
  });

  it("byEspnGameId: the ESPN↔nflverse join; non-positive ids never match", () => {
    expect(
      s.datasets.nflGames
        .byEspnGameId([900000002, 900000001])
        .rows.map((g) => g.game_id)
        .sort(),
    ).toEqual([GAME_W1, GAME_W1B]);
    expect(s.datasets.nflGames.byEspnGameId([0, -5, 1.5, Number.NaN]).rows).toEqual([]);
  });
});

describe("nflverse:injuries", () => {
  beforeEach(publishAll);

  it("reports: status bare-sanitised, injuries wrapped (injection text flagged), one weekly practice row", () => {
    const res = s.datasets.injuries.reports(2026, 3, null);
    expect(res.rows).toHaveLength(2);
    const qb = res.rows.find((r) => r.gsis_id === GSIS_QB);
    expect(qb).toMatchObject({
      season: 2026,
      week: 3,
      nfl_team: "BUF",
      report_status: "Questionable",
      practice: [{ day: "week", status: "Limited Participation in Practice" }],
      as_of: RELEASE,
    });
    expect(qb?.primary_injury?.untrusted_text).toMatchObject({
      value: "Ankle",
      source: "nflverse.injuries.primary_injury",
    });
    expect(qb?.secondary_injury).toBeNull();
    const wr = res.rows.find((r) => r.gsis_id === GSIS_WR);
    expect(wr).toMatchObject({ report_status: null, practice: [] });
    expect(wr?.primary_injury?.untrusted_text.flags).toContain("imperative");
    expect(warnings).toContain("dataset_row_skipped_team");
  });

  it("filters by gsis ids; an SQL-shaped id is bound as data", () => {
    expect(s.datasets.injuries.reports(2026, 3, [GSIS_WR]).rows.map((r) => r.gsis_id)).toEqual([
      GSIS_WR,
    ]);
    expect(s.datasets.injuries.reports(2026, 3, ["' OR 1=1 --", "00-0000000"]).rows).toEqual([]);
    expect(s.datasets.injuries.reports(2026, 3, []).rows).toEqual([]);
  });
});

describe("nflverse:stats_player_week", () => {
  beforeEach(publishAll);

  it("lines: canonical StatLine and usage; adot = air yards / targets", () => {
    const res = s.datasets.playerWeeks.lines([GSIS_QB, GSIS_WR, GSIS_K], 2026, [1]);
    expect(res.stamp?.source).toBe("nflverse:stats_player_week");
    const qb = res.rows.find((r) => r.gsis_id === GSIS_QB);
    expect(qb).toMatchObject({ nfl_team: "BUF", opponent: "MIA", position: "QB", week: 1 });
    expect(qb?.line.values).toMatchObject({
      pass_yd: 301,
      pass_td: 3,
      pass_int: 1,
      pass_att: 35,
      pass_cmp: 25,
      rush_att: 5,
      rush_yd: 22,
      fum: 2,
      fum_lost: 1,
    });
    expect(qb?.line.position_class).toBe("O");
    expect(qb?.line.position).toBe(1);
    const wr = res.rows.find((r) => r.gsis_id === GSIS_WR);
    expect(wr?.usage).toMatchObject({
      targets: 10,
      target_share: 0.3,
      air_yards: 120,
      air_yards_share: 0.4,
      adot: 12,
      wopr: 0.73,
      racr: 0.79,
      snaps: null,
      xfp_ep: null,
    });
    const k = res.rows.find((r) => r.gsis_id === GSIS_K);
    expect(k?.line.position_class).toBe("K");
    expect(k?.line.values).toMatchObject({
      fg_0_39: 2,
      fg_50_59: 1,
      fg_made_total: 3,
      fg_miss_40_49: 1,
      pat_made: 3,
    });
    expect(k?.usage?.adot).toBeNull(); // targets 0
    expect(k?.opponent).toBeNull();
  });

  it("defenseLines: points allowed from the schedules file (second statement), yards allowed derived", () => {
    const res = s.datasets.playerWeeks.defenseLines(["BUF", "MIA"], 2026, [1]);
    const buf = res.rows.find((r) => r.nfl_team === "BUF");
    expect(buf?.line.position_class).toBe("DST");
    expect(buf?.line.position).toBe(16);
    expect(buf?.line.values).toMatchObject({
      dst_sack: 3.5,
      dst_int: 2,
      dst_ff: 1,
      dst_fr: 1,
      dst_int_td: 1,
      dst_fr_td: 0,
      dst_blk: 1,
      dst_pa_raw: 20, // MIA scored 20 against BUF
      dst_ya_raw: 250 - 21 + 80,
    });
    const mia = res.rows.find((r) => r.nfl_team === "MIA");
    expect(mia?.line.values.dst_pa_raw).toBe(27);
    expect(mia?.line.present).not.toContain("dst_ya_raw"); // opponent offence columns null
  });

  it("defenseLines without the schedules file: dst_pa_raw is absent, not zero", async () => {
    const t2 = tempCache();
    const p2 = openPublisher(t2);
    await publishTables(p2, "nflverse:stats_player_week", "st-1", statsTables());
    const s2 = openStore(t2);
    const buf = s2.datasets.playerWeeks.defenseLines(["BUF"], 2026, [1]).rows[0];
    expect(buf?.line.present).not.toContain("dst_pa_raw");
    expect(buf?.line.values.dst_sack).toBe(3.5);
    // a game that is not final has no points allowed either
    s2.close();
    p2.close();
    t2.cleanup();
    const was = s.datasets.playerWeeks.defenseLines(["WAS"], 2026, [2]).rows[0];
    expect(was?.line.present).not.toContain("dst_pa_raw");
  });
});

describe("weather (EFF_WEATHER_SOURCE first, then the other for missing games)", () => {
  beforeEach(publishAll);

  it("open-meteo first by default; NWS fills the gap; the stamp is the first contributor's", () => {
    const res = s.datasets.weather.forGames([GAME_W2, GAME_W1, "2026_09_NOPE_NONE"]);
    expect(res.rows.map((r) => [r.game_id, r.source, r.temp_f])).toEqual([
      [GAME_W1, "weather:open_meteo", 60],
      [GAME_W2, "weather:nws", 55],
    ]);
    expect(res.stamp?.source).toBe("weather:open_meteo");
    expect(res.rows[0]).toMatchObject({ wind_mph: 12.5, gust_mph: null, precip_prob: 0.2 });
  });

  it("nws first when configured", () => {
    const s2 = openStore(t, { weatherSource: "nws" });
    const res = s2.datasets.weather.forGames([GAME_W1]);
    expect(res.rows).toEqual([
      expect.objectContaining({ game_id: GAME_W1, source: "weather:nws", temp_f: 61 }),
    ]);
    expect(res.stamp?.source).toBe("weather:nws");
    s2.close();
  });

  it("no matching game: rows empty, stamp of the first loaded source (loaded ≠ never loaded)", () => {
    const res = s.datasets.weather.forGames(["2026_09_NOPE_NONE"]);
    expect(res.rows).toEqual([]);
    expect(res.stamp?.source).toBe("weather:open_meteo");
  });
});

describe("the crosswalk ports", () => {
  beforeEach(publishAll);

  it("rosterWeekly.latest: the newest week per gsis id; non-NflTeam rows skipped", () => {
    const rows = s.rosterWeekly.latest(2026).rows;
    expect(rows.map((r) => [r.gsis_id, r.week, r.team])).toEqual([
      [GSIS_QB, 2, "BUF"],
      [GSIS_WR, 2, "WAS"],
    ]);
    expect(rows[0]).toMatchObject({
      espn_id: 9000001,
      jersey_number: 17,
      status: "ACT",
      full_name: "Test Quarterback",
    });
  });

  it("rosterWeekly.byEspnId: the newest row; ids that are not positive integers never reach SQL", () => {
    expect(s.rosterWeekly.byEspnId(9000002).rows).toEqual([
      expect.objectContaining({ gsis_id: GSIS_WR, week: 2 }),
    ]);
    for (const bad of [0, -16002, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      const r = s.rosterWeekly.byEspnId(bad);
      expect(r.rows).toEqual([]);
      expect(r.stamp?.source).toBe("nflverse:roster_weekly");
    }
  });

  it("playerUniverse.all: pro-team abbreviation from the pro-schedule file; FA → null; jersey null", () => {
    const rows = s.playerUniverse.all(2026).rows;
    expect(rows.map((r) => [r.espn_id, r.pro_team])).toEqual([
      [-16002, "BUF"],
      [9000001, "BUF"],
      [9000002, "WSH"],
      [9000003, null],
    ]);
    expect(rows.find((r) => r.espn_id === 9000002)).toEqual({
      espn_id: 9000002,
      full_name: "Test Receiver",
      position_id: 3,
      pro_team_id: 28,
      pro_team: "WSH",
      percent_owned: 54.25,
      jersey: null,
    });
  });

  it("playerUniverse.byIds: the newest season per id; abbreviations by that season", async () => {
    await publishTables(pub, "espn:players", "pl-2", mergePlayers(), { seasons: [2025, 2026] });
    const res = s.playerUniverse.byIds([9000001, 9000002, 424242, 9000001, 0.5]);
    expect(res.stamp?.file_version).toBe("pl-2");
    expect(res.rows.map((r) => [r.espn_id, r.pro_team])).toEqual([
      [9000001, "BUF"],
      [9000002, "WSH"],
    ]);
  });

  it("nflPlayers.byEspnIds: the id fallback; latest_team kept only when an NflTeam", () => {
    const rows = nflPlayersReaderOf(s)?.byEspnIds([9000010, 9000009, -1]).rows ?? [];
    expect(rows).toEqual([
      {
        gsis_id: "00-9000009",
        espn_id: 9000009,
        display_name: "Test Retired",
        position: "RB",
        latest_team: "BUF",
        jersey_number: 22,
        status: "RET",
        last_season: 2024,
      },
      expect.objectContaining({ gsis_id: "00-9000010", latest_team: null }),
    ]);
  });
});

function mergePlayers(): ReturnType<typeof playersTables> {
  const a = playersTables(2025)[0]!;
  const b = playersTables(2026)[0]!;
  return [{ spec: a.spec, rows: [...a.rows, ...b.rows] }];
}

describe("hostile inputs", () => {
  beforeEach(publishAll);

  it("seasons and weeks out of range are refused", () => {
    for (const season of [1989, 2101, 2026.5, Number.NaN])
      expect(() => s.datasets.proSchedule.teams(season)).toThrow(RangeError);
    for (const w of [0, 23, 1.5, -1]) {
      expect(() => s.datasets.injuries.reports(2026, w, null)).toThrow(RangeError);
      expect(() => s.datasets.nflGames.games(2026, [w])).toThrow(RangeError);
    }
  });

  it("lists are bounded and typed", () => {
    const huge = Array.from({ length: READER_LIST_MAX + 1 }, () => "00-0000000");
    expect(() => s.datasets.playerWeeks.lines(huge, 2026, [1])).toThrow(RangeError);
    expect(() => s.datasets.playerWeeks.lines([1 as never], 2026, [1])).toThrow(RangeError);
    expect(() => s.datasets.playerWeeks.lines("00-9000001" as never, 2026, [1])).toThrow(
      RangeError,
    );
    // a long list inside the bound is fine (one statement, json_each)
    const many = Array.from({ length: 20_000 }, (_, i) => `00-${String(i).padStart(7, "0")}`);
    expect(s.datasets.playerWeeks.lines([...many, GSIS_QB], 2026, [1]).rows).toHaveLength(1);
  });

  it("unicode and SQL-shaped team strings are data", () => {
    expect(
      s.datasets.playerWeeks.defenseLines(
        ["BUF'); DROP TABLE ds_team_defense_week; --", "БUF"] as never[],
        2026,
        [1],
      ).rows,
    ).toEqual([]);
    expect(s.datasets.playerWeeks.defenseLines(["BUF"], 2026, [1]).rows).toHaveLength(1);
  });
});
