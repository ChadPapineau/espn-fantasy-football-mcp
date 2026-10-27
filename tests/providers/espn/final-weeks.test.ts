// final-weeks.test.ts — Stage C remediation, round 3 (finding cache-final-weeks-not-immutable; plan 01
// §5.4 "ESPN immutable (draft; final weeks past the correction window)": fresh always, no hard limit;
// §5.2: mMatchup rows immutable 7 days after the week's last game, the player card's final weeks
// "never" expire). Before, a past week's box score was refetched every 10 min (60 s in a game
// window), cost one of the call's three requests and 220–325 KB each time, and turned STALE_ONLY
// after 24 h of outage; espn_matchups_final / espn_player_stats_final were declared and never used.
// Now an answer fetched once every week it covers is final and past its 7-day window (by the wired
// pro schedule; a previous season by the calendar) is cached immutable; one fetched before that keeps
// its own class and is refetched once. Recorded fixtures (league-a; the recorded season schedule:
// weeks 1–3 closed, week 4 still in its window at the fixtures' clock) and the recorded 2025 history.
// No network, no cookie.
import { describe, expect, it } from "vitest";
import { CORRECTIONS_WINDOW_MS } from "../../../src/config/freshness.js";
import type { ProGame, ProSchedule } from "../../../src/domain/league/types.js";
import { finalClassForViews } from "../../../src/providers/espn/cache.js";
import { createFixtureFetch } from "../../../src/providers/espn/fixture.js";
import { normalizeProSchedule } from "../../../src/providers/espn/normalize.js";
import {
  coveredWeeks,
  previousSeasonFinalFrom,
  weeksFinalFrom,
  type ProScheduleDataset,
} from "../../../src/providers/espn/provider.js";
import type { FetchLike } from "../../../src/providers/espn/transport.js";
import type {
  WireProScheduleBody,
  WireSettingsBody,
} from "../../../src/providers/espn/views/index.js";
import { historyFixtureFetch } from "../../fixtures/helpers/history-fixtures.js";
import { FIXTURES, loadFixture, makeWorld, SEASON } from "./helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const schedule = (): ProSchedule =>
  normalizeProSchedule(
    loadFixture("recorded/season/proTeamSchedules_wl.json") as WireProScheduleBody,
    SEASON,
  );
const dataset = (s: ProSchedule): ProScheduleDataset => ({
  teams: (season) => ({ rows: season === s.season ? s.teams : [] }),
  games: (season) => ({ rows: season === s.season ? s.games : [] }),
});

/** league-a's recorded answers behind a switch: `down` → every request fails (an outage). */
function switchable(): { fetch: FetchLike; state: { down: boolean } } {
  const inner = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
  const state = { down: false };
  return {
    state,
    fetch: (url, init) => {
      if (!state.down) return inner(url, init);
      const e = new TypeError("fetch failed");
      (e as { cause?: unknown }).cause = Object.assign(new Error("refused"), {
        code: "ECONNREFUSED",
      });
      return Promise.reject(e);
    },
  };
}

const viewsOf = (sent: readonly { url: string }[]) =>
  sent.map((s) => new URL(s.url).searchParams.getAll("view").join("+"));

describe("a week past its correction window is cached immutable", () => {
  it("week 1's box score: espn_matchups_final; two days later a hit, a month of outage later still a hit", async () => {
    const sw = switchable();
    const w = makeWorld({ fetch: sw.fetch, over: { proSchedule: dataset(schedule()) } });
    const first = await w.provider.getBoxScores(w.ref, 1);
    expect(first.stamp.freshness).toBe("espn_matchups_final");
    expect(viewsOf(w.sent)).toEqual(["mSettings+mNav", "mBoxscore"]);
    w.clock.advance(2 * DAY);
    const later = await w.provider.getBoxScores(w.ref, 1);
    expect(later.stamp.cache).toBe("hit");
    expect(later.stamp.degraded).toBeNull();
    // the settings were refetched after their TTL; the box score never
    expect(viewsOf(w.sent).filter((v) => v === "mBoxscore")).toHaveLength(1);
    sw.state.down = true;
    w.clock.advance(30 * DAY);
    const outage = await w.provider.getBoxScores(w.ref, 1);
    expect(outage.stamp.cache).toBe("hit");
    expect(outage.value).toEqual(first.value);
    expect(viewsOf(w.sent).filter((v) => v === "mBoxscore")).toHaveLength(1);
  });

  it("the live scores of a closed week too; a week still in its window keeps espn_live and is refetched", async () => {
    const w = makeWorld({ slot: "league-a", over: { proSchedule: dataset(schedule()) } });
    const closed = await w.provider.getLiveMatchups(w.ref, 3);
    const open = await w.provider.getLiveMatchups(w.ref, 4);
    expect(closed.stamp.freshness).toBe("espn_matchups_final");
    expect(open.stamp.freshness).toBe("espn_live");
    w.clock.advance(11 * MIN);
    await w.provider.getLiveMatchups(w.ref, 3);
    await w.provider.getLiveMatchups(w.ref, 4);
    expect(viewsOf(w.sent).filter((v) => v === "mMatchupScore")).toHaveLength(3);
  });

  it("inside a game window (the live TTL is 60 s) a closed week is still a hit; an open one is refetched", async () => {
    const w = makeWorld({
      slot: "league-a",
      over: {
        proSchedule: dataset(schedule()),
        ttlContext: () => ({ inGameWindow: true, gameDay: true, inSeason: true }),
      },
    });
    await w.provider.getBoxScores(w.ref, 1);
    await w.provider.getLiveMatchups(w.ref, 4);
    w.clock.advance(65_000);
    const closed = await w.provider.getBoxScores(w.ref, 1);
    const open = await w.provider.getLiveMatchups(w.ref, 4);
    expect(closed.stamp.cache).toBe("hit");
    expect(open.stamp.cache).toBe("miss");
    expect(viewsOf(w.sent).filter((v) => v === "mBoxscore")).toHaveLength(1);
    expect(viewsOf(w.sent).filter((v) => v === "mMatchupScore")).toHaveLength(2);
  });

  it("an answer fetched BEFORE the window closed keeps its own class: refetched once, then immutable", async () => {
    const w = makeWorld({ slot: "league-a", over: { proSchedule: dataset(schedule()) } });
    // week 3's window closes 7 days after its Monday game (2026-09-29T00:15Z)
    const closes = Date.parse("2026-09-29T00:15:00.000Z") + CORRECTIONS_WINDOW_MS;
    w.clock.advance(closes - w.clock.nowMs() - HOUR); // an hour before it closes
    const early = await w.provider.getBoxScores(w.ref, 3);
    expect(early.stamp.freshness).toBe("espn_live");
    w.clock.advance(2 * HOUR); // past the close and past the live TTL
    const refetched = await w.provider.getBoxScores(w.ref, 3);
    expect(refetched.stamp.cache).toBe("miss");
    expect(refetched.stamp.freshness).toBe("espn_matchups_final");
    w.clock.advance(3 * DAY);
    expect((await w.provider.getBoxScores(w.ref, 3)).stamp.cache).toBe("hit");
    expect(viewsOf(w.sent).filter((v) => v === "mBoxscore")).toHaveLength(2);
  });

  it("no pro schedule known (no dataset, no cached season view): never immutable, refetched by its class", async () => {
    const w = makeWorld({ slot: "league-a" });
    const r = await w.provider.getBoxScores(w.ref, 1);
    expect(r.stamp.freshness).toBe("espn_live");
    w.clock.advance(11 * MIN);
    await w.provider.getBoxScores(w.ref, 1);
    expect(viewsOf(w.sent).filter((v) => v === "mBoxscore")).toHaveLength(2);
  });

  it("no dataset loaded: the season view the tools fell back to, cached, proves the week closed — whatever its age", async () => {
    const w = makeWorld({ slot: "league-a" });
    // what src/mcp's scheduleOf reads when ds_pro_schedule was never loaded: the keyless view
    await w.provider.getProSchedule(SEASON);
    const first = await w.provider.getBoxScores(w.ref, 1);
    expect(first.stamp.freshness).toBe("espn_matchups_final");
    // past the season view's own 7-day hard limit: its official, past games still prove it
    w.clock.advance(8 * DAY);
    const later = await w.provider.getBoxScores(w.ref, 1);
    expect(later.stamp.cache).toBe("hit");
    expect(viewsOf(w.sent).filter((v) => v === "mBoxscore")).toHaveLength(1);
    expect(viewsOf(w.sent).filter((v) => v === "proTeamSchedules_wl")).toHaveLength(1);
  });

  it("a box score cached before the schedule was known turns immutable once it is (the class is judged at read)", async () => {
    const w = makeWorld({ slot: "league-a" });
    expect((await w.provider.getBoxScores(w.ref, 1)).stamp.freshness).toBe("espn_live");
    await w.provider.getProSchedule(SEASON);
    w.clock.advance(2 * DAY);
    const r = await w.provider.getBoxScores(w.ref, 1);
    expect(r.stamp.cache).toBe("hit");
    expect(r.stamp.freshness).toBe("espn_matchups_final");
    expect(viewsOf(w.sent).filter((v) => v === "mBoxscore")).toHaveLength(1);
  });

  it("the season's schedule (mMatchup) and the player card stay mutable while the season runs", async () => {
    const w = makeWorld({ slot: "league-a", over: { proSchedule: dataset(schedule()) } });
    const m = await w.provider.getMatchups(w.ref);
    expect(m.stamp.freshness).toBe("espn_matchups");
  });

  it("a previous season with no schedule loaded is final by the calendar: its schedule is a hit a month later", async () => {
    const w = makeWorld({ fetch: historyFixtureFetch("league-a") });
    const ref = { ...w.ref, season: 2025 };
    const m = await w.provider.getMatchups(ref);
    expect(m.stamp.freshness).toBe("espn_matchups_final");
    w.clock.advance(30 * DAY);
    expect((await w.provider.getMatchups(ref)).stamp.cache).toBe("hit");
    expect(viewsOf(w.sent).filter((v) => v === "mMatchup")).toHaveLength(1);
  });
});

describe("the finality rule (pure)", () => {
  const game = (week: number, kickoff: string | null, official: boolean, tbd = false): ProGame => ({
    ...schedule().games[0]!,
    week,
    kickoff,
    start_time_tbd: tbd,
    stats_official: official,
  });

  it("weeksFinalFrom: the latest close of the covered weeks; null while any is unknown, open or TBD", () => {
    const games = [
      game(1, "2026-09-11T00:20:00.000Z", true),
      game(1, "2026-09-15T00:15:00.000Z", true),
      game(2, "2026-09-22T00:15:00.000Z", true),
      game(3, "2026-09-29T00:15:00.000Z", false),
      game(4, null, true, true),
    ];
    const close = (iso: string) => Date.parse(iso) + CORRECTIONS_WINDOW_MS;
    expect(weeksFinalFrom(games, [1])).toBe(close("2026-09-15T00:15:00.000Z"));
    expect(weeksFinalFrom(games, [1, 2])).toBe(close("2026-09-22T00:15:00.000Z"));
    expect(weeksFinalFrom(games, [2, 3])).toBeNull(); // a game without official stats
    expect(weeksFinalFrom(games, [4])).toBeNull(); // a TBD kickoff
    expect(weeksFinalFrom(games, [9])).toBeNull(); // no game known
    expect(weeksFinalFrom(games, [])).toBeNull();
    expect(weeksFinalFrom(games, null)).toBeNull(); // the whole season: weeks 3 and 4 are not final
    expect(weeksFinalFrom(games.slice(0, 3), null)).toBe(close("2026-09-22T00:15:00.000Z"));
  });

  it("coveredWeeks: every week of the matchup period(s) holding the week (a two-week playoff round)", () => {
    const s = structuredClone(loadFixture("recorded/league-a/mSettings.json")) as WireSettingsBody;
    s.settings.scheduleSettings.matchupPeriods = { "14": [14], "15": [15, 16] };
    expect(coveredWeeks(s, 15)).toEqual([15, 16]);
    expect(coveredWeeks(s, 16)).toEqual([15, 16]);
    expect(coveredWeeks(s, 14)).toEqual([14]);
    expect(coveredWeeks(s, 17)).toEqual([17]); // named by no period
    expect(coveredWeeks(null, 3)).toBeNull();
  });

  it("previousSeasonFinalFrom: March 1 of the next year; the immutable classes per view", () => {
    expect(new Date(previousSeasonFinalFrom(2025)).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(finalClassForViews(["mBoxscore"])?.id).toBe("espn_matchups_final");
    expect(finalClassForViews(["mMatchupScore"])?.id).toBe("espn_matchups_final");
    expect(finalClassForViews(["kona_playercard"])?.id).toBe("espn_player_stats_final");
    expect(finalClassForViews(["mRoster"])).toBeNull();
    expect(finalClassForViews(["mMatchup", "mRoster"])).toBeNull();
    expect(finalClassForViews(["mMatchup", "kona_playercard"])).toBeNull();
    expect(finalClassForViews([])).toBeNull();
  });
});
