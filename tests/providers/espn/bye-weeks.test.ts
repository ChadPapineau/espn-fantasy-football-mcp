// bye-weeks.test.ts — Stage C remediation, round 1 (finding normalize-bye-week-never-populated; plan
// 07 A4/B1/C2 `bye_week`, the E4–E7/E11 weekly-value consumers): every PlatformPlayer the provider
// builds — roster entries, the pool page, the filterIds set, box-score players, the season index —
// carries its pro team's bye week from the wired pro-schedule dataset (the store's
// `datasets.proSchedule`, which a composition root passes as is), by the same rule `espn_get_roster`
// applies (`byeWeekOf`); the weekly-value consumers then give the bye week 0. Without the dataset
// (none wired, a season it does not hold, a throwing read) `bye_week` is null — never an extra ESPN
// request. The dataset is read at most once a minute per season (the stall bound).
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { weeklyValues } from "../../../src/domain/analytics/waivers.js";
import { byeWeekOf } from "../../../src/domain/league/schedule.js";
import type { PlatformPlayer, ProSchedule } from "../../../src/domain/league/types.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { normalizeProSchedule } from "../../../src/providers/espn/normalize.js";
import {
  BYE_WEEKS_MEMO_MS,
  type ProScheduleDataset,
} from "../../../src/providers/espn/provider.js";
import type { PlayerQuery } from "../../../src/providers/platform.js";
import type { WireProScheduleBody } from "../../../src/providers/espn/views/index.js";
import { storeFactory } from "../../../src/store/index.js";
import { tempDir } from "../../lint/helpers.js";
import { publishEspnDatasets } from "../../mcp/helpers/world.js";
import { loadFixture, makeWorld, NOW_ISO, SEASON } from "./helpers.js";

const FREE_AGENT_TEAM = 0;
const schedule = (): ProSchedule =>
  normalizeProSchedule(
    loadFixture("recorded/season/proTeamSchedules_wl.json") as WireProScheduleBody,
    SEASON,
  );
/** An in-memory dataset port over `s` (null: the season is not loaded), counting reads. */
function dataset(
  get: () => ProSchedule | null,
  seasons: number[] = [],
): ProScheduleDataset & { reads: number } {
  const port = {
    reads: 0,
    teams(season: number) {
      port.reads++;
      seasons.push(season);
      const s = get();
      return { rows: s?.season === season ? s.teams : [] };
    },
    games(season: number) {
      const s = get();
      return { rows: s?.season === season ? s.games : [] };
    },
  };
  return port;
}
const pool: PlayerQuery = {
  status: "AVAILABLE",
  position: null,
  sort: "percOwned",
  week: 4,
  injured: null,
};
const idsOf = (): { platform: "espn"; id: number }[] => {
  const m = loadFixture("manifest.json") as {
    files: { path: string; request: { filter: { players: { filterIds: { value: number[] } } } } }[];
  };
  const f = m.files.find((x) => x.path === "recorded/league-a/kona_player_info.ids.json")!;
  return f.request.filter.players.filterIds.value.map((id) => ({ platform: "espn", id }));
};
const rosteredOf = (r: { value: readonly { entries: readonly { player: PlatformPlayer }[] }[] }) =>
  r.value.flatMap((t) => t.entries.map((e) => e.player));

/** Every player's bye equals the schedule's for his pro team (null only for a free agent). */
function expectByes(players: readonly PlatformPlayer[], s: ProSchedule): void {
  expect(players.length).toBeGreaterThan(0);
  for (const p of players) {
    const want = byeWeekOf(s, p.pro_team_id);
    expect(p.bye_week, `${String(p.ref.id)} (team ${String(p.pro_team_id)})`).toBe(want);
    if (p.pro_team_id !== FREE_AGENT_TEAM) expect(p.bye_week).not.toBeNull();
  }
}

let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

describe("bye_week from the wired pro-schedule dataset", () => {
  it("roster entries, the pool page, the filterIds set, box scores and the season index all carry it", async () => {
    const s = schedule();
    const w = makeWorld({ slot: "league-a", over: { proSchedule: dataset(() => s) } });
    const rostered = rosteredOf(await w.provider.getRosters(w.ref, 3));
    expect(rostered.length).toBeGreaterThan(100);
    expectByes(rostered, s);
    const page = await w.provider.listPlayers(w.ref, pool, { limit: 25, offset: 0 });
    expectByes(page.value.items, s);
    const ids = await w.provider.getPlayers(w.ref, idsOf(), 4);
    expectByes(ids.value, s);
    const box = await w.provider.getBoxScores(w.ref, 3);
    expectByes(
      box.value
        .flatMap((m) => [m.home, ...(m.away === null ? [] : [m.away])])
        .flatMap((side) => side.entries.map((e) => e.player)),
      s,
    );
    const index = await w.provider.getSeasonPlayers(SEASON);
    expectByes(index.value, s);
    // what the finding's consumers do with it: the bye week is worth 0, the ROS total is spread
    // over the playing weeks only (it was a full share of the ROS total in the bye week)
    const p = rostered.find((x) => x.bye_week !== null && x.projection_ros_espn !== null)!;
    const bye = p.bye_week!;
    const weeks = [bye - 1, bye, bye + 1].filter((x) => x >= 4);
    const v = weeklyValues(weeks, null, p.projection_ros_espn, p.bye_week);
    expect(v[weeks.indexOf(bye)]).toBe(0);
    expect(v.reduce((a: number, b) => a + (b ?? 0), 0)).toBeGreaterThan(0);
  });

  it("the REAL store's reader is the port as is (`store.datasets.proSchedule`, the wiring line)", async () => {
    tmp = tempDir("eff-bye-");
    const clock = fixedClock(NOW_ISO);
    const storePath = path.join(tmp.dir, "store.sqlite");
    const datasetDir = path.join(tmp.dir, "datasets");
    const store = storeFactory.open({
      path: storePath,
      datasetDir,
      backupDir: path.join(tmp.dir, "backups"),
      clock,
      migrate: true,
    });
    try {
      await publishEspnDatasets({ storePath, datasetDir, clock });
      store.reopenChangedDatasets();
      const w = makeWorld({ slot: "league-a", over: { proSchedule: store.datasets.proSchedule } });
      const rostered = rosteredOf(await w.provider.getRosters(w.ref, 3));
      const s: ProSchedule = {
        season: SEASON,
        teams: store.datasets.proSchedule.teams(SEASON).rows,
        games: store.datasets.proSchedule.games(SEASON, null).rows,
      };
      expect(s.teams.length).toBeGreaterThan(30);
      expectByes(rostered, s);
      // and the same as the recorded season view's own byes
      expectByes(rostered, schedule());
      // the byes cost no ESPN request: the season view is never asked for
      expect(w.sent.some((x) => x.url.includes("proTeamSchedules"))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("a team without ESPN's byeWeek gets the week its games show it idle (the domain rule)", async () => {
    const s = schedule();
    const target = s.teams.find((t) => t.id !== FREE_AGENT_TEAM && t.bye_week !== null)!;
    const stated = target.bye_week;
    const unstated: ProSchedule = {
      ...s,
      teams: s.teams.map((t) => (t.id === target.id ? { ...t, bye_week: null } : t)),
    };
    const w = makeWorld({ slot: "league-a", over: { proSchedule: dataset(() => unstated) } });
    const index = await w.provider.getSeasonPlayers(SEASON);
    const ofTeam = index.value.filter((p) => p.pro_team_id === target.id);
    expect(ofTeam.length).toBeGreaterThan(0);
    expect(new Set(ofTeam.map((p) => p.bye_week))).toEqual(new Set([stated]));
  });

  it("nothing wired, a season it does not hold, or a throwing read: null, and no extra request", async () => {
    const throwing: ProScheduleDataset = {
      teams: () => {
        throw new Error("dataset unreadable");
      },
      games: () => {
        throw new Error("dataset unreadable");
      },
    };
    const otherSeason = schedule();
    for (const over of [
      {},
      { proSchedule: dataset(() => null) },
      { proSchedule: dataset(() => ({ ...otherSeason, season: SEASON - 1 })) },
      { proSchedule: throwing },
    ]) {
      const w = makeWorld({ slot: "league-a", over });
      const rosters = await w.provider.getRosters(w.ref, 3);
      expect(rosters.value.flatMap((r) => r.entries).every((e) => e.player.bye_week === null)).toBe(
        true,
      );
      expect(w.sent.map((x) => new URL(x.url).searchParams.getAll("view").join("&"))).toEqual([
        "mSettings&mNav",
        "mRoster",
      ]);
    }
  });

  it("the dataset is read at most once per BYE_WEEKS_MEMO_MS per season; a later load is seen", async () => {
    const s = schedule();
    let loaded = false;
    const seasons: number[] = [];
    const port = dataset(() => (loaded ? s : null), seasons);
    const w = makeWorld({ slot: "league-a", over: { proSchedule: port } });
    const first = await w.provider.getSeasonPlayers(SEASON);
    expect(first.value.every((p) => p.bye_week === null)).toBe(true);
    loaded = true;
    await w.provider.getRosters(w.ref, 3);
    await w.provider.listPlayers(w.ref, pool, { limit: 25, offset: 0 });
    expect(port.reads).toBe(1);
    w.clock.advance(BYE_WEEKS_MEMO_MS);
    const later = await w.provider.getRosters(w.ref, 3);
    expect(port.reads).toBe(2);
    expect(new Set(seasons)).toEqual(new Set([SEASON]));
    expectByes(rosteredOf(later), s);
  });
});
