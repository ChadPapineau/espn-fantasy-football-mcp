// path.test.ts — src/providers/espn/path.ts, a 100 %-coverage module (plan 05 §2 `providers/espn/
// path`, §7): for generated valid inputs the builder produces the read host's league URL; views
// outside the whitelist (every do-nothing view, comma-joined views) are refused; seasons < 2018,
// non-integer and leading-zero ids are refused; the write host is unreachable from every builder;
// mRoster is never composed; views come out in whitelist order (one URL per request).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ESPN_READ_HOST_DEFAULT, ESPN_WRITE_HOST } from "../../../src/config/schema.js";
import {
  communicationTarget,
  ESPN_LAST_SEASON,
  EspnRequestError,
  leaguePath,
  leagueTarget,
  primaryView,
  readHost,
  SCORING_PERIOD_MAX,
  seasonPlayersTarget,
  seasonTarget,
} from "../../../src/providers/espn/path.js";
import { LEAGUE_VIEWS, REFUSED_VIEWS, type LeagueView } from "../../../src/providers/espn/types.js";

const H = ESPN_READ_HOST_DEFAULT;
const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EspnRequestError);
    const err = e as EspnRequestError;
    expect(err.effCode).toBe("VALIDATION");
    return err.effDetails.reason;
  }
  throw new Error("expected a refusal");
};

describe("readHost (plan 02 S12)", () => {
  it("accepts the default and any one-label *.fantasy.espn.com host", () => {
    expect(readHost()).toBe(H);
    expect(readHost("lm-api-reads2.fantasy.espn.com")).toBe("lm-api-reads2.fantasy.espn.com");
  });
  it.each([
    ESPN_WRITE_HOST,
    "lm-api-writes2.fantasy.espn.com",
    "evil.com",
    "fantasy.espn.com",
    "a.b.fantasy.espn.com",
    "lm-api-reads.fantasy.espn.com.evil.com",
    "LM-API-READS.FANTASY.ESPN.COM",
    "",
    "lm api.fantasy.espn.com",
  ])("refuses %j", (h) => {
    expect(reason(() => readHost(h))).toBe("read_host_refused");
  });
});

describe("leagueTarget", () => {
  it("builds the recorded mTeam+mStandings request in whitelist order (cache key = URL)", () => {
    const a = leagueTarget({
      host: H,
      season: 2026,
      leagueId: "0",
      views: ["mStandings", "mTeam"],
    });
    const b = leagueTarget({
      host: H,
      season: 2026,
      leagueId: "0",
      views: ["mTeam", "mStandings", "mTeam"],
    });
    expect(a.url).toBe(
      `https://${H}/apis/v3/games/ffl/seasons/2026/segments/0/leagues/0?view=mTeam&view=mStandings`,
    );
    expect(b.url).toBe(a.url);
    expect(a.route).toBe("league");
    expect(a.views).toEqual(["mTeam", "mStandings"]);
    expect(a.scoringPeriodId).toBeNull();
    expect(Object.isFrozen(a)).toBe(true);
    expect(primaryView(a)).toBe("mTeam");
  });
  it("adds scoringPeriodId 0..22 and refuses outside it", () => {
    const t = leagueTarget({
      host: H,
      season: 2026,
      leagueId: "0",
      views: ["mRoster"],
      scoringPeriodId: 3,
    });
    expect(t.query).toBe("view=mRoster&scoringPeriodId=3");
    expect(
      leagueTarget({
        host: H,
        season: 2026,
        leagueId: "0",
        views: ["mBoxscore"],
        scoringPeriodId: 0,
      }).scoringPeriodId,
    ).toBe(0);
    for (const sp of [-1, SCORING_PERIOD_MAX + 1, 1.5, Number.NaN])
      expect(
        reason(() =>
          leagueTarget({
            host: H,
            season: 2026,
            leagueId: "0",
            views: ["mRoster"],
            scoringPeriodId: sp,
          }),
        ),
      ).toBe("scoring_period_out_of_range");
  });
  it("refuses mRoster composed with anything (plan 01 §5.2)", () => {
    expect(
      reason(() =>
        leagueTarget({ host: H, season: 2026, leagueId: "0", views: ["mRoster", "mTeam"] }),
      ),
    ).toBe("solo_view_composed");
  });
  it.each([
    ...REFUSED_VIEWS,
    "mTeam,mRoster",
    "mBogusViewName",
    "",
    " mTeam",
    "kona_league_communication",
    "players_wl",
  ])("refuses the view %j", (v) => {
    expect(
      reason(() =>
        leagueTarget({ host: H, season: 2026, leagueId: "0", views: [v as LeagueView] }),
      ),
    ).toBe("view_not_whitelisted");
  });
  it("refuses an empty or non-array view list", () => {
    expect(reason(() => leagueTarget({ host: H, season: 2026, leagueId: "0", views: [] }))).toBe(
      "no_views",
    );
    expect(
      reason(() =>
        leagueTarget({
          host: H,
          season: 2026,
          leagueId: "0",
          views: "mTeam" as unknown as LeagueView[],
        }),
      ),
    ).toBe("no_views");
    expect(
      reason(() =>
        leagueTarget({
          host: H,
          season: 2026,
          leagueId: "0",
          views: [42 as unknown as LeagueView],
        }),
      ),
    ).toBe("view_not_whitelisted");
  });
  it.each([2017, 1999, ESPN_LAST_SEASON + 1, 2026.5, Number.NaN])("refuses season %d", (s) => {
    expect(reason(() => leaguePath(s, "0"))).toBe("season_out_of_range");
  });
  it.each(["01", "-1", "1.5", "abc", "", "1234567890123", "0x10", "1 2", "1/../2"])(
    "refuses league id %j",
    (id) => {
      expect(reason(() => leaguePath(2026, id))).toBe("invalid_league_id");
    },
  );
  it("refuses a non-string league id", () => {
    expect(reason(() => leaguePath(2026, 7 as unknown as string))).toBe("invalid_league_id");
  });
  it("primaryView refuses a target with no views (a hand-built target)", () => {
    const t = leagueTarget({ host: H, season: 2026, leagueId: "0", views: ["mTeam"] });
    expect(reason(() => primaryView({ ...t, views: [] }))).toBe("no_views");
  });
});

describe("season, players and communication builders", () => {
  it("season route: keyless, no league id", () => {
    const t = seasonTarget({ host: H, season: 2026 });
    expect(t.url).toBe(`https://${H}/apis/v3/games/ffl/seasons/2026?view=proTeamSchedules_wl`);
    expect(t.route).toBe("season");
    expect(reason(() => seasonTarget({ host: H, season: 2026, views: ["mTeam" as never] }))).toBe(
      "view_not_whitelisted",
    );
    expect(reason(() => seasonTarget({ host: H, season: 2010 }))).toBe("season_out_of_range");
  });
  it("players route", () => {
    const t = seasonPlayersTarget({ host: H, season: 2026 });
    expect(t.url).toBe(`https://${H}/apis/v3/games/ffl/seasons/2026/players?view=players_wl`);
    expect(t.route).toBe("players");
    expect(reason(() => seasonPlayersTarget({ host: H, season: 2017 }))).toBe(
      "season_out_of_range",
    );
  });
  it("communication route: the board view only", () => {
    const t = communicationTarget({ host: H, season: 2026, leagueId: "0" });
    expect(t.url).toBe(
      `https://${H}/apis/v3/games/ffl/seasons/2026/segments/0/leagues/0/communication/?view=kona_league_communication`,
    );
    expect(
      reason(() =>
        communicationTarget({ host: H, season: 2026, leagueId: "0", views: ["mTeam" as never] }),
      ),
    ).toBe("view_not_whitelisted");
  });
});

describe("properties (plan 05 T2)", () => {
  const viewsArb = fc
    .subarray(
      [...LEAGUE_VIEWS].filter((v) => v !== "mRoster"),
      { minLength: 1 },
    )
    .chain((vs) => fc.shuffledSubarray(vs, { minLength: vs.length, maxLength: vs.length }));
  const idArb = fc.oneof(
    fc.constant("0"),
    fc.bigInt({ min: 1n, max: 999_999_999_999n }).map(String),
  );

  it("valid inputs → the read host's league URL; the write host never appears", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2018, max: ESPN_LAST_SEASON }),
        idArb,
        viewsArb,
        fc.option(fc.integer({ min: 0, max: SCORING_PERIOD_MAX }), { nil: null }),
        (season, id, views, sp) => {
          const t = leagueTarget({ host: H, season, leagueId: id, views, scoringPeriodId: sp });
          const u = new URL(t.url);
          expect(u.hostname).toBe(H);
          expect(u.protocol).toBe("https:");
          expect(u.pathname).toBe(
            `/apis/v3/games/ffl/seasons/${String(season)}/segments/0/leagues/${id}`,
          );
          expect(u.searchParams.getAll("view")).toEqual(
            LEAGUE_VIEWS.filter((v) => (views as readonly string[]).includes(v)),
          );
          expect(t.url).not.toContain("lm-api-writes");
          expect(t.url).not.toMatch(/%|\s/);
          if (sp === null) expect(u.searchParams.has("scoringPeriodId")).toBe(false);
          else expect(u.searchParams.get("scoringPeriodId")).toBe(String(sp));
        },
      ),
    );
  });

  it("any non-whitelisted string view is refused", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (v) => {
        fc.pre(!(LEAGUE_VIEWS as readonly string[]).includes(v));
        expect(() =>
          leagueTarget({ host: H, season: 2026, leagueId: "0", views: [v as LeagueView] }),
        ).toThrow(EspnRequestError);
      }),
    );
  });

  it("any host string other than an allowed read host is refused before a URL exists", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (h) => {
        fc.pre(
          !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fantasy\.espn\.com$/.test(h) ||
            h.startsWith("lm-api-writes"),
        );
        expect(() => seasonTarget({ host: h, season: 2026 })).toThrow(EspnRequestError);
      }),
    );
  });
});
