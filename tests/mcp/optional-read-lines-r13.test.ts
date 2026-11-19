// optional-read-lines-r13.test.ts — the optional reads that said nothing, or degraded on the budget
// only (changelog §R13, R13-2). An optional read that degrades on an outage says so with
// fallbackWarning's "unavailable" line; on a session refusal it says "not read" — or nothing, where
// the answer loses nothing beyond what the call's session line already says (E11's standings: its
// own refusal line says them) — beside exactly one session line; a bug still answers INTERNAL.
// R13-2's named sites: leaguePremiumFit's schedule read (E5's league-fitted premium, which absorbed
// an outage with no line), espn_analyze_lineup's matchups read and espn_analyze_waivers' standings
// read (which absorbed the budget only, so an outage or a refusal failed the call). The sweep of
// src/mcp/tools against R13-2 added the reads that absorbed an outage with no line: the lineup's
// standings, the trade's, the cascade's, the roster audit's and the league activity's standings, the
// evidence's rosters, the retrospective's scoring settings, the seeding evidence's last-season
// league, the search's team names and position filter, and espn_get_roster's opponent order.
// Fixture mode (fx-10h, Team 02, week 5), fake clock; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffError } from "../../src/mcp/errors.js";
import type { ToolContext } from "../../src/mcp/define.js";
import type { McpServices } from "../../src/mcp/services.js";
import { PREMIUM_FIT_UNSCHEDULED, leaguePremiumFit } from "../../src/mcp/tools/analytics.js";
import { UpstreamBudgetExhausted } from "../../src/providers/platform.js";
import { coded, faulty, type Fault } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
type J = Record<string, unknown>;
type Body = J & { warnings?: string[]; partial?: boolean; error?: { code?: string } };
const END: Readonly<Record<string, string>> = {
  ESPN_AUTH_REJECTED: "in a terminal to replace it",
  ESPN_REQUIRES_COOKIES: "in a terminal to add one",
};

let world: World;
let rb = 0;
let rivalPlayer = 0;
let myTeam = 0;
let tradeArgs: J = {};

const codeOf = (b: Body): unknown => b.error?.code ?? (b as { code?: unknown }).code;
const bug = (): Error => new TypeError("injected bug");
const peek = (b: Body): string => JSON.stringify(b).slice(0, 400);

/** A bound property of `t` (a method keeps its receiver). */
function bound(t: object, p: PropertyKey): unknown {
  const v: unknown = Reflect.get(t, p, t);
  return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
}

/** The services with the pro schedule dataset's game read replaced by `games`. */
function withScheduleGames(services: McpServices, games: () => unknown): McpServices {
  const ps = services.datasets.proSchedule;
  const proSchedule = new Proxy(ps, {
    get: (t, p) => (p === "games" ? games : bound(t, p)),
  });
  const datasets = new Proxy(services.datasets, {
    get: (t, p) => (p === "proSchedule" ? proSchedule : bound(t, p)),
  });
  return { ...services, datasets };
}

async function run(
  tool: string,
  args: J,
  services: McpServices,
): Promise<{ isError: boolean; body: Body }> {
  const c = await connect(world, { options: { toolset: "full" }, services });
  const r = await call(c.client, tool, args);
  await c.close();
  return { isError: r.isError, body: r.body };
}

/** A fault of one platform read. */
const read =
  (method: string) =>
  (f: Fault) =>
  (s: McpServices): McpServices =>
    faulty(s, { [method]: f });

/**
 * The pro schedule dataset never loaded, so scheduleOf reads ESPN's keyless proTeamSchedules_wl view
 * (getProSchedule), which answers the fault.
 */
const espnSchedule =
  (f: Fault) =>
  (s: McpServices): McpServices =>
    faulty(
      withScheduleGames(s, () => ({ stamp: null, rows: [] })),
      { getProSchedule: f },
    );

/** The league season the services read. */
const seasonOf = (s: McpServices): number => (s.league as { season: number }).season;

/**
 * Last season's reads served from this season's (fx-10h records no league settings or schedule for
 * last season), so the seeding evidence reaches its last-season league read; `f` faults that read.
 */
function lastSeason(f: Fault | null) {
  return (s: McpServices): McpServices => {
    const season = seasonOf(s);
    const prev = (ref: unknown): boolean => (ref as { season?: number }).season === season - 1;
    const thisSeasons = (
      real: (...a: unknown[]) => Promise<unknown>,
      ...args: unknown[]
    ): Promise<unknown> =>
      prev(args[0]) ? real({ ...(args[0] as object), season }, ...args.slice(1)) : real(...args);
    const reason = (): Error =>
      f === "budget"
        ? new UpstreamBudgetExhausted("mTeam", "budget")
        : f instanceof Error
          ? f
          : new Error("unsupported fault");
    const league =
      f === null
        ? thisSeasons
        : (real: (...a: unknown[]) => Promise<unknown>, ...args: unknown[]): Promise<unknown> =>
            prev(args[0]) ? Promise.reject(reason()) : real(...args);
    return faulty(s, {
      getLeagueRules: thisSeasons,
      getMatchups: thisSeasons,
      getLeague: league,
    });
  };
}

/** The league rules with an acquisition limit (fx-10h has none), so adds_remaining is counted. */
function acquisitionLimit(n: number) {
  return (s: McpServices): McpServices =>
    faulty(s, {
      getLeagueRules: async (real, ...args) => {
        const got = (await real(...args)) as { value: { waiver: object } };
        return {
          ...got,
          value: { ...got.value, waiver: { ...got.value.waiver, acquisition_limit: n } },
        };
      },
    });
}

/** One optional read: the call that reaches it, its fault, and its line by cause. */
interface Site {
  readonly site: string;
  readonly tool: string;
  readonly args: () => J;
  readonly fault: (f: Fault) => (s: McpServices) => McpServices;
  /** The "unavailable" line (an outage, the budget). */
  readonly unavailable: string;
  /** The "not read" line (a refusal); null: the session line (or the tool's own) says it all. */
  readonly notRead: string | null;
  /** The services every call of the site reads (null: the world's). */
  readonly base?: (s: McpServices) => McpServices;
  /** Whether the budget is injected too (the reads that absorbed it before). */
  readonly budget?: boolean;
}

const line = (view: string, rest: string) => ({
  unavailable: `${view} unavailable: ${rest}`,
  notRead: `${view} not read: ${rest}`,
});

const SITES: readonly Site[] = [
  // R13-2's named sites
  {
    site: "analytics.ts espn_analyze_lineup's matchups (budget only before)",
    tool: "espn_analyze_lineup",
    args: () => ({ week: 5, objective: "auto" }),
    fault: read("getMatchups"),
    ...line("schedule", "no opponent, objective mean, mode neutral"),
    budget: true,
  },
  {
    site: "analytics.ts espn_analyze_waivers' standings (budget only before)",
    tool: "espn_analyze_waivers",
    args: () => ({ mode: "auto", phase: "auto" }),
    fault: read("getStandings"),
    ...line("standings", "waiver rank unknown (cold-start premium at k = N/2)"),
    budget: true,
  },
  {
    site: "analytics.ts leaguePremiumFit's pro schedule (E5's fitted premium; no line before)",
    tool: "espn_analyze_waivers",
    args: () => ({ mode: "priority" }),
    fault: espnSchedule,
    ...line(
      "pro schedule",
      "the fitted premium's logged waiver runs grouped by Tuesday-to-Tuesday week",
    ),
    budget: true,
  },
  // the sweep: optional reads that absorbed an outage with no line
  {
    site: "analytics.ts espn_analyze_lineup's standings",
    tool: "espn_analyze_lineup",
    args: () => ({ week: 5, objective: "auto" }),
    fault: read("getStandings"),
    ...line("standings", "the season read from the results"),
  },
  {
    site: "market-p1.ts espn_analyze_trade's standings (the offer's season simulation)",
    tool: "espn_analyze_trade",
    args: () => tradeArgs,
    fault: read("getStandings"),
    ...line("standings", "the season read from the results"),
  },
  {
    site: "market-p1.ts espn_analyze_injury_cascade's standings (its waiver verdicts)",
    tool: "espn_analyze_injury_cascade",
    args: () => ({ player: { player_ids: [rb] } }),
    fault: read("getStandings"),
    ...line("standings", "waiver rank unknown (cold-start premium at k = N/2)"),
  },
  {
    site: "analytics-p1.ts espn_analyze_roster's standings (fx-10h: no acquisition limit)",
    tool: "espn_analyze_roster",
    args: () => ({ seed: 3 }),
    fault: read("getStandings"),
    ...line("standings", "the season read from the results"),
  },
  {
    site: "analytics-p1.ts espn_analyze_roster's standings (an acquisition limit of 30)",
    tool: "espn_analyze_roster",
    args: () => ({ seed: 3 }),
    fault: read("getStandings"),
    base: acquisitionLimit(30),
    ...line(
      "standings",
      "adds_remaining counts no acquisition as used; the season read from the results",
    ),
  },
  {
    site: "market-p1.ts espn_analyze_league_activity's standings (its refusal line is its own)",
    tool: "espn_analyze_league_activity",
    args: () => ({}),
    fault: read("getStandings"),
    unavailable: "standings unavailable: waiver-order movement goes without them",
    notRead: null,
  },
  {
    site: "market-p1.ts espn_analyze_evidence's rosters (a rival's player: his slot and lock)",
    tool: "espn_analyze_evidence",
    args: () => ({ player: { player_ids: [rivalPlayer] } }),
    fault: read("getRosters"),
    ...line("rosters", "the lineup_slot and lineup_locked checks are not made"),
  },
  {
    site: "reclog.ts espn_analyze_retrospective's scoring settings",
    tool: "espn_analyze_retrospective",
    args: () => ({ week: 4 }),
    fault: read("getScoringSettings"),
    ...line("scoring settings", "no forecast or attribution row is scored"),
  },
  {
    site: "league.ts the seeding evidence's last-season league (its bracket-edit flag)",
    tool: "espn_get_league",
    args: () => ({ include: ["seeding_evidence"] }),
    fault: (f) => lastSeason(f),
    base: lastSeason(null),
    ...line("last season's league", "playoff_edited is null"),
  },
  {
    site: "players.ts espn_search_players' team names",
    tool: "espn_search_players",
    args: () => ({ query: "Robinson" }),
    fault: read("getStandings"),
    ...line("standings", "on_team_name is null"),
  },
  {
    site: "players.ts espn_search_players' position filter",
    tool: "espn_search_players",
    args: () => ({ query: "Robinson", position: "RB" }),
    fault: read("getRosterSlots"),
    ...line("league settings", "the position filter reads ESPN's slot catalogue"),
    budget: true,
  },
  {
    site: "roster.ts espn_get_roster all's opponent order",
    tool: "espn_get_roster",
    args: () => ({ week: 5, all: true }),
    fault: read("getMatchups"),
    ...line("matchups", "my opponent's roster is not placed second"),
  },
];

beforeAll(async () => {
  const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
    publishEspn: true,
    publishNflverse: true,
  });
  const roster = async (
    team: number,
  ): Promise<{ player_id: number; slot: string; position: string }[]> => {
    const r = await run("espn_get_roster", { week: 5, team_id: team }, world.services);
    expect(r.isError, peek(r.body)).toBe(false);
    return (r.body.data as { players: { player_id: number; slot: string; position: string }[] })
      .players;
  };
  myTeam = m.my_team_id;
  const mine = await roster(m.my_team_id);
  rb = mine.find((p) => p.position === "RB")?.player_id ?? 0;
  expect(rb).toBeGreaterThan(0);
  const rival = await roster(3);
  rivalPlayer = rival.find((p) => p.slot !== "IR" && p.position === "WR")?.player_id ?? 0;
  expect(rivalPlayer).toBeGreaterThan(0);
  tradeArgs = {
    offer: {
      partner_team_id: 3,
      give: [mine.find((p) => p.slot !== "IR")?.player_id ?? 0],
      get: [rival.find((p) => p.slot !== "IR")?.player_id ?? 0],
    },
    seed: 1,
  };
  // a priced claim run logged (a pre-run priority call of my team), so E5's fitted premium reads
  // the pro schedule to place it
  const w = await run("espn_analyze_waivers", { mode: "priority" }, world.services);
  expect(w.isError, peek(w.body)).toBe(false);
  expect(world.store.repos.waiverRuns.list("0", seasonOf(world.services)).length).toBeGreaterThan(
    0,
  );
}, 240_000);
afterAll(() => {
  world.cleanup();
});

describe("R13-2: an optional read says 'unavailable' on an outage, 'not read' on a refusal, and a bug is INTERNAL", () => {
  it.each(SITES.map((s) => [s.site, s] as const))(
    "%s",
    async (_label, s) => {
      const base = s.base ?? ((x: McpServices) => x);
      const svc = (f: Fault) => s.fault(f)(base(world.services));
      const clean = await run(s.tool, s.args(), base(world.services));
      expect(clean.isError, peek(clean.body)).toBe(false);
      const cleanWarnings = clean.body.warnings ?? [];
      expect(cleanWarnings).not.toContain(s.unavailable);
      if (s.notRead !== null) expect(cleanWarnings).not.toContain(s.notRead);
      // an outage: the answer without the read, said "unavailable"
      for (const code of ["ESPN_UPSTREAM_UNAVAILABLE", "RATE_LIMITED", "ESPN_DRIFT_DETECTED"]) {
        const out = await run(s.tool, s.args(), svc(coded(code)));
        expect(out.isError, `${code} ${peek(out.body)}`).toBe(false);
        expect(out.body.warnings, `${code} ${JSON.stringify(out.body.warnings)}`).toContain(
          s.unavailable,
        );
        if (s.notRead !== null) expect(out.body.warnings ?? [], code).not.toContain(s.notRead);
      }
      // a refusal: "not read" (or nothing), one session line, partial; never "unavailable"
      for (const code of ["ESPN_AUTH_REJECTED", "ESPN_REQUIRES_COOKIES"]) {
        const r = await run(s.tool, s.args(), svc(coded(code)));
        expect(r.isError, `${code} ${peek(r.body)}`).toBe(false);
        const w = r.body.warnings ?? [];
        if (s.notRead !== null) expect(w, code).toContain(s.notRead);
        expect(w, code).not.toContain(s.unavailable);
        expect(
          w.filter((x) => x.endsWith(END[code] ?? "")),
          code,
        ).toHaveLength(1);
        expect(r.body.partial, code).toBe(true);
        expect(
          w.filter((x) => x.includes("unavailable") && !cleanWarnings.includes(x)),
          code,
        ).toEqual([]);
      }
      // the budget: partial, its line, and the read's "unavailable" line
      if (s.budget === true) {
        const b = await run(s.tool, s.args(), svc("budget"));
        expect(b.isError, `budget ${peek(b.body)}`).toBe(false);
        expect(b.body.partial).toBe(true);
        expect(b.body.warnings).toContain(s.unavailable);
      }
      // a bug: INTERNAL, never absorbed, its text never leaked
      const x = await run(s.tool, s.args(), svc(bug()));
      expect(x.isError, peek(x.body)).toBe(true);
      expect(codeOf(x.body)).toBe("INTERNAL");
      expect(JSON.stringify(x.body)).not.toContain("injected bug");
    },
    240_000,
  );
});

describe("R13-2: leaguePremiumFit's pro schedule past its hard limit is an outage (R12-5)", () => {
  it("a dataset past its hard limit: the fitted premium's 'unavailable' line", async () => {
    const stale = await run(
      "espn_analyze_waivers",
      { mode: "priority" },
      withScheduleGames(world.services, () => {
        throw new EffError("STALE_ONLY");
      }),
    );
    expect(stale.isError, peek(stale.body)).toBe(false);
    expect(stale.body.warnings).toContain(
      "pro schedule unavailable: the fitted premium's logged waiver runs grouped by Tuesday-to-Tuesday week",
    );
  }, 120_000);
});

// the fit's own guard absorbs a failure of the fit (its store reads, its solve) — never a bug of its
// pro schedule read (R11-4). Through espn_analyze_waivers the call's rosReadingOf makes the memoised
// read first and answers INTERNAL there, so the guard is held here, on a call whose first schedule
// read is the fit's
describe("R13-2: leaguePremiumFit's own schedule read, made first", () => {
  /** A context whose store holds one logged run and whose pro schedule dataset read does `games`. */
  const ctxOf = (games: () => unknown): ToolContext =>
    ({
      memo: new Map(),
      services: {
        league: { league_id: "0", season: 2026 },
        transactionsSeen: { listRange: () => [], oldestSeen: () => null },
        waiverRuns: {
          list: () => [{ season: 2026, run_at: "2026-10-07T07:30:00.000Z", W: 12, surplus: [2.5] }],
        },
        datasets: { proSchedule: { games } },
        logger: { warn: () => undefined },
      },
    }) as unknown as ToolContext;
  const league = { ref: { season: 2026 }, size: 10 } as never;
  const rules = { playoffs: { regular_season_matchups: 14, matchup_periods: {} } } as never;

  it("a bug is thrown (INTERNAL), never absorbed by the fit's guard", async () => {
    await expect(
      leaguePremiumFit(
        ctxOf(() => {
          throw bug();
        }),
        league,
        rules,
        5,
        null,
        [],
      ),
    ).rejects.toThrow("injected bug");
  });

  it("a dataset past its hard limit answers the fit, with the 'unavailable' line once", async () => {
    const warnings: string[] = [];
    const fit = await leaguePremiumFit(
      ctxOf(() => {
        throw new EffError("STALE_ONLY");
      }),
      league,
      rules,
      5,
      null,
      warnings,
    );
    expect(fit).not.toBeNull();
    expect(warnings.filter((w) => w.startsWith("pro schedule "))).toEqual([
      `pro schedule unavailable: ${PREMIUM_FIT_UNSCHEDULED}`,
    ]);
  });
});

// my roster's snapshot stands in for a failed rosters read only where it holds the subject: my own
// player (said by rostersOf's snapshot line), never a rival's, whose slot and lock it does not carry
describe("R13-2: espn_analyze_evidence's rosters beside my roster's snapshot", () => {
  const unavailable = "rosters unavailable: the lineup_slot and lineup_locked checks are not made";
  beforeAll(async () => {
    const week = 5;
    const got = await world.services.platform.getRoster(
      { league: world.services.league, team_id: myTeam },
      week,
    );
    world.store.repos.rosterSnapshots.put({
      team_id: myTeam,
      week,
      taken_at: new Date(world.clock.nowMs() - 5 * 3_600_000).toISOString(),
      roster: got.value,
    });
  }, 120_000);
  it("a rival's player: the line, never my snapshot; my own player: the snapshot, no line", async () => {
    const out = (id: number) =>
      run(
        "espn_analyze_evidence",
        { player: { player_ids: [id] } },
        faulty(world.services, { getRosters: coded("ESPN_UPSTREAM_UNAVAILABLE") }),
      );
    const rival = await out(rivalPlayer);
    expect(rival.isError, peek(rival.body)).toBe(false);
    expect(rival.body.warnings).toContain(unavailable);
    expect((rival.body.warnings ?? []).some((w) => w.includes("roster snapshot"))).toBe(false);
    const own = await out(rb);
    expect(own.isError, peek(own.body)).toBe(false);
    expect(own.body.warnings ?? []).not.toContain(unavailable);
    expect(
      (own.body.warnings ?? []).some((w) =>
        w.startsWith("espn:mRoster unavailable: served from the week 5 roster snapshot"),
      ),
      JSON.stringify(own.body.warnings),
    ).toBe(true);
  }, 120_000);
});
