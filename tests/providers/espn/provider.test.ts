// provider.test.ts — EspnProvider through the RECORDED fixtures (plan 05 §2, §3.1 step 5 fixture mode;
// plan 07 §3 what each P0 tool asks of the provider; plan 01 §5.3 cache-first + coalescing, §5.6 the
// ≤ 3 budget): every seam read across the three recorded leagues, stamps, member GUIDs never emitted,
// cache hits make zero requests, force_refresh is gated, concurrent identical reads make one request,
// the budget is honoured, the league id is config-only, and no request ever carries a cookie unless a
// credential is configured (and then only to the read host).
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import {
  createUpstreamBudget,
  isUpstreamBudgetExhausted,
  type PlayerQuery,
} from "../../../src/providers/platform.js";
import { ESPN_PROVIDER_WRITES, EspnProvider } from "../../../src/providers/espn/provider.js";
import {
  FakeAuthority,
  fixturesIgnoringCookies,
  jsonResponse,
  LEAGUES,
  loadFixture,
  makeWorld,
  NOW_ISO,
  SEASON,
  stubScoring,
  testCookieHeader,
  type LeagueSlot,
} from "./helpers.js";

const GUID_RE = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/;
const pool = (over: Partial<PlayerQuery> = {}): PlayerQuery => ({
  status: "AVAILABLE",
  position: null,
  sort: "percOwned",
  week: 4,
  injured: null,
  ...over,
});
const idsOf = (slot: LeagueSlot): { platform: "espn"; id: number }[] => {
  const m = loadFixture("manifest.json") as {
    files: { path: string; request: { filter: { players: { filterIds: { value: number[] } } } } }[];
  };
  const f = m.files.find((x) => x.path === `recorded/${slot}/kona_player_info.ids.json`)!;
  return f.request.filter.players.filterIds.value.map((id) => ({ platform: "espn", id }));
};
const owner = (slot: LeagueSlot, teamIndex = 0): string =>
  (loadFixture(`recorded/${slot}/mNav.json`) as { teams: { owners: string[] }[] }).teams[teamIndex]!
    .owners[0]!;

describe.each(LEAGUES)("%s: every P0 read through the recorded fixtures", (slot) => {
  it("league, scoring, slots, rules, capabilities — one settings request serves them all", async () => {
    const w = makeWorld({ slot });
    const league = await w.provider.getLeague(w.ref);
    expect(league.value).toMatchObject({
      size: slot === "league-c" ? 12 : 10,
      scoring_type: "H2H_POINTS",
      is_public: true,
    });
    expect(league.value.my_team).toBeNull();
    expect(league.stamp).toMatchObject({
      source: "espn:mSettings",
      freshness: "espn_settings",
      cache: "miss",
      drift: null,
      degraded: null,
    });
    const scoring = await w.provider.getScoringSettings(w.ref);
    expect(scoring.value.rules.length).toBeGreaterThan(10);
    expect(scoring.stamp.cache).toBe("hit");
    await w.provider.getRosterSlots(w.ref);
    await w.provider.getLeagueRules(w.ref);
    const caps = await w.provider.capabilities();
    expect(caps).toMatchObject({
      read: true,
      writes: false,
      waiver_system: slot === "league-c" ? "priority_move_to_last" : "faab",
    });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]?.url).toContain("view=mSettings&view=mNav");
    expect(w.sent.every((s) => s.headers.cookie === undefined)).toBe(true);
    expect(w.sent.every((s) => s.redirect === "manual")).toBe(true);
  });

  it("rosters, matchups, live, box scores, standings — names wrapped, no GUID anywhere", async () => {
    const w = makeWorld({ slot });
    const rosters = await w.provider.getRosters(w.ref, 3);
    expect(rosters.value.length).toBe(slot === "league-c" ? 12 : 10);
    expect(rosters.stamp).toMatchObject({ source: "espn:mRoster", provisional: false });
    const one = await w.provider.getRoster(
      { league: w.ref, team_id: rosters.value[1]!.team.team_id },
      3,
    );
    expect(one.value.team.team_id).toBe(rosters.value[1]!.team.team_id);
    const matchups = await w.provider.getMatchups(w.ref);
    expect(matchups.value.length).toBeGreaterThan(70);
    const live = await w.provider.getLiveMatchups(w.ref, 4);
    expect(live.value.length).toBe(slot === "league-c" ? 6 : 5);
    expect(live.stamp.provisional).toBe(true);
    expect(live.value[0]?.home.win_probability_espn).not.toBeUndefined();
    const box = await w.provider.getBoxScores(w.ref, 3);
    expect(box.value.length).toBeGreaterThanOrEqual(4);
    const entry = box.value[0]!.home.entries.find((e) => e.actual !== null)!;
    expect(entry.actual?.split).toMatchObject({ source_id: 0, split_type: 1, week: 3 });
    expect(entry.game_state).toBe("final");
    const standings = await w.provider.getStandings(w.ref);
    expect(standings.value.waiver_order).toHaveLength(standings.value.teams.length);
    for (const v of [rosters.value, matchups.value, live.value, box.value, standings.value])
      expect(GUID_RE.test(JSON.stringify(v))).toBe(false);
    // settings once (identity), then one request per view
    expect(w.sent.map((s) => new URL(s.url).searchParams.getAll("view").join("&"))).toEqual([
      "mSettings&mNav",
      "mRoster",
      "mMatchup",
      "mMatchupScore",
      "mBoxscore",
      "mTeam&mStandings",
    ]);
  });

  it("the pool page, the filterIds set, the player cards, ESPN projections, outlooks", async () => {
    const w = makeWorld({ slot });
    const page = await w.provider.listPlayers(w.ref, pool(), { limit: 25, offset: 0 });
    expect(page.value).toMatchObject({
      count: 25,
      limit: 25,
      offset: 0,
      has_more: true,
      next_offset: 25,
    });
    expect(page.value.total).toBeGreaterThan(100);
    expect(page.value.items.every((p) => p.status === "WAIVERS" || p.status === "FREEAGENT")).toBe(
      true,
    );
    const ids = idsOf(slot);
    const players = await w.provider.getPlayers(w.ref, ids, 4);
    expect(players.value.map((p) => p.ref.id)).toEqual(ids.map((r) => r.id));
    const proj = await w.provider.getNativeProjections(w.ref, ids, "week", 4);
    expect(proj.stamp.source).toBe("espn:projection");
    expect(proj.value.length).toBeGreaterThan(10);
    expect(proj.value.every((p) => p.horizon === "week" && p.week === 4)).toBe(true);
    const ros = await w.provider.getNativeProjections(w.ref, ids, "ros", 4);
    expect(ros.value.every((p) => p.week === null)).toBe(true);
    const outlooks = await w.provider.getPlayerOutlooks(w.ref, ids, [4]);
    expect(outlooks.value.length).toBe(ids.length);
    for (const o of outlooks.value) for (const k of Object.keys(o.weekly)) expect(k).toBe("4");
    const weekLines = await w.provider.getPlayerStats(w.ref, ids, { type: "week", week: 3 });
    expect(weekLines.value.length).toBeGreaterThan(10);
    expect(weekLines.value.every((l) => l.split.week === 3 && l.split.season === SEASON)).toBe(
      true,
    );
    const seasonLines = await w.provider.getPlayerStats(w.ref, ids, { type: "season" });
    expect(seasonLines.value.every((l) => l.split.week === null)).toBe(true);
    const prior = await w.provider.getPlayerStats(w.ref, ids, { type: "prior_season" });
    expect(prior.value.every((l) => l.split.season === SEASON - 1 && l.split.source_id === 0)).toBe(
      true,
    );
    // the projection read joined the cached filterIds page; the three card reads share one request
    expect(w.sent.map((s) => new URL(s.url).searchParams.getAll("view")[0])).toEqual([
      "kona_player_info",
      "kona_player_info",
      "kona_playercard",
    ]);
  });

  it("the keyless season views", async () => {
    const w = makeWorld({ slot });
    const pro = await w.provider.getProSchedule(SEASON);
    expect(pro.value.games).toHaveLength(272);
    expect(pro.stamp.freshness).toBe("espn_pro_schedule");
    const index = await w.provider.getSeasonPlayers(SEASON);
    expect(index.value.length).toBeGreaterThan(2600);
    expect(w.sent.map((s) => new URL(s.url).pathname)).toEqual([
      "/apis/v3/games/ffl/seasons/2026",
      "/apis/v3/games/ffl/seasons/2026/players",
    ]);
    expect(w.sent[1]?.headers["x-fantasy-filter"]).toBe('{"filterActive":{"value":true}}');
  });
});

describe("pool query mapping (plan 07 C2)", () => {
  it("name sort re-sorts the one page and refuses offset > 0; unknown position refused", async () => {
    const w = makeWorld();
    const page = await w.provider.listPlayers(w.ref, pool({ sort: "name" }), {
      limit: 25,
      offset: 0,
    });
    const names = page.value.items.map((p) => p.name as string);
    expect(names).toEqual([...names].sort());
    expect(page.value.has_more).toBe(false);
    await expect(
      w.provider.listPlayers(w.ref, pool({ sort: "name" }), { limit: 25, offset: 25 }),
    ).rejects.toMatchObject({
      effCode: "VALIDATION",
      effDetails: { reason: "name_sort_single_page" },
    });
    await expect(
      w.provider.listPlayers(w.ref, pool({ position: "Quarterback" }), { limit: 25, offset: 0 }),
    ).rejects.toMatchObject({
      effDetails: { reason: "unknown_position" },
    });
  });
  it("injured is a post-filter: page.total null; the status/position/sort reach the filter header", async () => {
    const w = makeWorld();
    const page = await w.provider.listPlayers(w.ref, pool({ injured: true }), {
      limit: 25,
      offset: 0,
    });
    expect(page.value.total).toBeNull();
    expect(page.value.items.every((p) => p.injured)).toBe(true);
    const seen: string[] = [];
    const w2 = makeWorld({
      fetch: (_u, init) => {
        seen.push((init.headers as Record<string, string>)["x-fantasy-filter"]!);
        return Promise.resolve(jsonResponse({ players: [] }));
      },
    });
    const empty = await w2.provider.listPlayers(
      w2.ref,
      pool({ status: "ALL", position: "QB", sort: "projection_week" }),
      { limit: 10, offset: 0 },
    );
    expect(empty.value).toMatchObject({
      count: 0,
      total: null,
      has_more: false,
      next_offset: null,
    });
    expect(JSON.parse(seen[0]!)).toEqual({
      players: {
        filterSlotIds: { value: [0] },
        limit: 10,
        offset: 0,
        sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: "1120264" },
        sortDraftRanks: { sortAsc: true, sortPriority: 100, value: "STANDARD" },
      },
    });
    await w2.provider.listPlayers(w2.ref, pool({ status: "ONTEAM" }), { limit: 10, offset: 0 });
    expect(
      (JSON.parse(seen[1]!) as { players: { filterStatus: unknown } }).players.filterStatus,
    ).toEqual({
      value: ["ONTEAM"],
    });
  });
  it("id counts: 1..50 for kona, 1..25 for the card", async () => {
    const w = makeWorld();
    const many = Array.from({ length: 51 }, (_, i) => ({ platform: "espn" as const, id: i + 1 }));
    await expect(w.provider.getPlayers(w.ref, many, 4)).rejects.toMatchObject({
      effCode: "VALIDATION",
    });
    await expect(w.provider.getPlayers(w.ref, [], 4)).rejects.toMatchObject({
      effCode: "VALIDATION",
    });
    await expect(
      w.provider.getPlayerStats(w.ref, many.slice(0, 26), { type: "season" }),
    ).rejects.toMatchObject({
      effDetails: { reason: "player_ids_count" },
    });
    expect(w.sent).toHaveLength(0);
  });
});

describe("cache-first, coalescing, force_refresh, budget (plan 01 §5.3, §5.6)", () => {
  it("a fresh entry makes zero requests; past the TTL it refetches", async () => {
    const w = makeWorld();
    await w.provider.getStandings(w.ref);
    const n = w.sent.length;
    const again = await w.provider.getStandings(w.ref);
    expect(w.sent.length).toBe(n);
    expect(again.stamp.cache).toBe("hit");
    w.clock.advance(16 * 60 * 1000);
    const later = await w.provider.getStandings(w.ref);
    expect(later.stamp.cache).toBe("miss");
    expect(w.sent.length).toBe(n + 1);
  });
  it("force_refresh is honoured once per 60 s per key", async () => {
    const w = makeWorld();
    await w.provider.getProSchedule(SEASON);
    await w.provider.getProSchedule(SEASON, { force_refresh: true });
    await w.provider.getProSchedule(SEASON, { force_refresh: true });
    expect(w.sent).toHaveLength(2);
    w.clock.advance(60_000);
    await w.provider.getProSchedule(SEASON, { force_refresh: true });
    expect(w.sent).toHaveLength(3);
  });
  it("concurrent identical reads make one upstream request (coalesced)", async () => {
    const w = makeWorld();
    await w.provider.getLeague(w.ref);
    const results = await Promise.all([1, 2, 3, 4].map(() => w.provider.getRosters(w.ref, 2)));
    expect(w.sent.filter((s) => s.url.includes("mRoster"))).toHaveLength(1);
    expect(results.map((r) => r.stamp.cache).sort()).toEqual([
      "coalesced",
      "coalesced",
      "coalesced",
      "miss",
    ]);
  });
  it("a cold roster read costs ≤ 3 (settings + roster); a 1-request budget cannot pay for it", async () => {
    const w = makeWorld();
    const budget = createUpstreamBudget("r-0123456789ab", w.clock.nowMs());
    await w.provider.getRosters(w.ref, 1, { budget });
    expect(budget.used()).toBe(2);
    const w2 = makeWorld();
    const tight = createUpstreamBudget("r-0123456789ab", w2.clock.nowMs(), 1);
    const e = await w2.provider.getRosters(w2.ref, 1, { budget: tight }).catch((x: unknown) => x);
    expect(isUpstreamBudgetExhausted(e)).toBe(true);
    expect((e as { missing: unknown }).missing).toEqual({ view: "mRoster", reason: "budget" });
    const passed = createUpstreamBudget("r-0123456789ab", w2.clock.nowMs() - 30_000);
    const late = await w2.provider
      .getProSchedule(SEASON, { budget: passed })
      .catch((x: unknown) => x);
    expect((late as { missing: unknown }).missing).toEqual({
      view: "proTeamSchedules_wl",
      reason: "deadline",
    });
  });
  it("the raw body is stored only in fixture-recording mode (plan 05 §2)", async () => {
    const w = makeWorld();
    await w.provider.getProSchedule(SEASON);
    expect([...w.cache.map.values()].every((e) => e.raw_body === null)).toBe(true);
    const r = makeWorld({ over: {} });
    const recording = new EspnProvider({
      config: {
        leagueId: "0",
        season: SEASON,
        teamId: null,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: true,
      },
      fetch: () =>
        Promise.resolve(jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json"))),
      credentials: null,
      repos: { limiter: r.limiter, cache: r.cache, driftState: r.drift },
      clock: fixedClock(NOW_ISO),
      scoring: stubScoring,
    });
    await recording.getProSchedule(SEASON);
    expect([...r.cache.map.values()][0]?.raw_body).toContain("proTeams");
  });
  it("the cached body never holds a member name", async () => {
    const w = makeWorld();
    await w.provider.getLeague(w.ref);
    const stored = [...w.cache.map.values()].map((e) => e.parsed_json).join("");
    expect(stored).not.toMatch(/"displayName"|"firstName"|"lastName"|Member \d/);
    expect(stored).toContain("owners");
  });
});

describe("refs and teams (plan 02 §5)", () => {
  it("a LeagueRef that is not the configured league is a programming error (INTERNAL), zero requests", async () => {
    const w = makeWorld();
    await expect(w.provider.getLeague({ ...w.ref, league_id: "123" })).rejects.toMatchObject({
      effCode: "INTERNAL",
    });
    await expect(w.provider.getRosters({ ...w.ref, season: 2026.5 }, 1)).rejects.toMatchObject({
      effCode: "INTERNAL",
    });
    expect(w.sent).toHaveLength(0);
  });
  it("a team that is not in the league → NOT_FOUND", async () => {
    const w = makeWorld();
    await expect(w.provider.getRoster({ league: w.ref, team_id: 999 }, 1)).rejects.toMatchObject({
      effCode: "NOT_FOUND",
    });
  });
  it("the write seam is declared, not implemented", () => {
    expect(ESPN_PROVIDER_WRITES).toContain("PHASE W SEAM — NOT IMPLEMENTED");
    const w = makeWorld();
    for (const m of ["setLineup", "submitTransaction", "submitTrade"])
      expect(m in w.provider).toBe(false);
  });
});

describe("own team, commissioner, credentials on a public league", () => {
  it("my_team from the SWID in the cookie header; cookies not sent once the league is known public", async () => {
    const swid = owner("league-a", 2);
    const auth = new FakeAuthority("validated", { ok: true, header: testCookieHeader(swid) });
    const w = makeWorld({ fetch: fixturesIgnoringCookies("league-a"), credentials: auth });
    const league = await w.provider.getLeague(w.ref);
    const nav = loadFixture("recorded/league-a/mNav.json") as { teams: { id: number }[] };
    expect(league.value.my_team?.team_id).toBe(nav.teams[2]!.id);
    expect(JSON.stringify(league.value)).not.toContain(swid);
    const own = await w.provider.resolveOwnTeam(w.ref);
    expect(own.value).toEqual({ team_id: nav.teams[2]!.id, reason: "resolved" });
    const rosters = await w.provider.getRosters(w.ref, 3);
    expect(rosters.value.filter((r) => r.is_mine).map((r) => r.team.team_id)).toEqual([
      nav.teams[2]!.id,
    ]);
    const standings = await w.provider.getStandings(w.ref);
    expect(standings.value.teams.filter((t) => t.is_mine)).toHaveLength(1);
    // the first settings read carried the cookie (publicity unknown); later reads are keyless
    expect(w.sent[0]?.headers.cookie).toContain("SWID=");
    expect(w.sent.slice(1).every((s) => s.headers.cookie === undefined)).toBe(true);
    // a public league's 200 is not a discriminating acceptance (plan 02 §2.1, R-5)
    expect(auth.observations).toEqual([]);
  });
  it("resolveOwnTeam: no credential / no match / configured team id", async () => {
    const w = makeWorld();
    expect((await w.provider.resolveOwnTeam(w.ref)).value).toEqual({
      team_id: null,
      reason: "no_credential",
    });
    const stranger = new FakeAuthority("validated", {
      ok: true,
      header: testCookieHeader("{00000000-0000-4000-8000-0000000000FF}"),
    });
    const w2 = makeWorld({ fetch: fixturesIgnoringCookies("league-a"), credentials: stranger });
    expect((await w2.provider.resolveOwnTeam(w2.ref)).value).toEqual({
      team_id: null,
      reason: "no_match",
    });
    const nav = loadFixture("recorded/league-b/mNav.json") as { teams: { id: number }[] };
    const w3 = makeWorld({ slot: "league-b", teamId: nav.teams[4]!.id });
    expect((await w3.provider.getLeague(w3.ref)).value.my_team?.team_id).toBe(nav.teams[4]!.id);
  });
  it("transportStatus starts closed with no 304s", () => {
    const w = makeWorld();
    expect(w.provider.transportStatus()).toEqual({
      breaker_open: false,
      breaker_open_until: null,
      consecutive_failures: 0,
      etag_304_count: 0,
    });
    expect(w.provider.scoringRefusal()).toBeNull();
  });
});
