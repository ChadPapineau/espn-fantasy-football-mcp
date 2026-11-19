// optional-read-lines.test.ts — an optional read's fixed line names its cause (changelog §R12, R12-4
// and R12-5). R12-4: every optional read's warning goes through fallbackWarning — "not read" on a
// session refusal (which the call's session line says, src/mcp/refusals.ts), "unavailable" on an
// outage; no line calls a refusal "unavailable". R12-5: a dataset past its hard limit
// (STALE_ONLY) is an outage for an optional read, so every optional pro-schedule read absorbs it
// with its "unavailable" line, espn_get_roster's included (as `a40f590` did for the injuries' read);
// a bug still answers INTERNAL. The round-5 verifier's F1: the scoreboard's, the box score's, the
// player list's, the injuries' and E13's two schedule reads absorbed it with no line at all, so an
// answer went without the schedule unsaid; F2: E3 live's conditioning line called a refused
// schedule "unavailable". Fixture mode (fx-10h, Team 02, week 5), fake clock; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffError } from "../../src/mcp/errors.js";
import type { McpServices } from "../../src/mcp/services.js";
import { coded, faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
type J = Record<string, unknown>;
type Body = J & { warnings?: string[]; partial?: boolean; error?: { code?: string } };
const END: Readonly<Record<string, string>> = {
  ESPN_AUTH_REJECTED: "in a terminal to replace it",
  ESPN_REQUIRES_COOKIES: "in a terminal to add one",
};

let world: World;
let rb: number;

const codeOf = (b: Body): unknown => b.error?.code ?? (b as { code?: unknown }).code;
const bug = (): Error => new TypeError("injected bug");
const peek = (b: Body): string => JSON.stringify(b).slice(0, 400);

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
  // a rostered RB of mine (espn_analyze_injury_cascade's subject)
  const roster = await run("espn_get_roster", { week: 5 }, world.services);
  expect(roster.isError).toBe(false);
  const players = (roster.body.data as { players: { player_id: number; position: string }[] })
    .players;
  rb = players.find((p) => p.position === "RB")?.player_id ?? 0;
  expect(rb).toBeGreaterThan(0);
}, 120_000);
afterAll(() => {
  world.cleanup();
});

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

/** The pro schedule dataset's read throwing `e` — STALE_ONLY is what a dataset past its hard limit throws. */
const datasetFault = (e: () => Error) => (s: McpServices) =>
  withScheduleGames(s, () => {
    throw e();
  });

/**
 * The pro schedule dataset never loaded, so scheduleOf reads ESPN's keyless proTeamSchedules_wl view
 * (getProSchedule), which answers `e`: an outage, a refusal (through the recording platform, so the
 * call's session line names it), STALE_ONLY (ESPN cannot answer, only an expired entry is cached) or
 * a bug.
 */
const espnFault = (e: () => Error) => (s: McpServices) =>
  faulty(
    withScheduleGames(s, () => ({ stamp: null, rows: [] })),
    { getProSchedule: () => Promise.reject(e()) },
  );

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

/** An optional pro-schedule read with a fixed line: the call that reaches it, and the line's rest. */
interface LineSite {
  readonly site: string;
  readonly tool: string;
  readonly args: J;
  readonly rest: string;
}

const SCHEDULE_LINES: readonly LineSite[] = [
  {
    site: "roster.ts espn_get_roster's pro schedule",
    tool: "espn_get_roster",
    args: { week: 5 },
    rest: "kickoffs and lock times unknown",
  },
  {
    site: "league.ts the league clock's pro schedule",
    tool: "espn_get_league",
    args: { include: ["clock"] },
    rest: "current_week_final and corrections_window_open are conservative",
  },
  {
    site: "league.ts the live scoreboard's pro schedule",
    tool: "espn_get_live_scoreboard",
    args: {},
    rest: "game window unknown",
  },
  {
    site: "common.ts rosReadingOf (espn_get_projections, horizon ros)",
    tool: "espn_get_projections",
    args: { players: { team_id: 2 }, horizon: "ros" },
    rest: "ESPN's rest-of-season total read from the first value week",
  },
  {
    site: "analytics-p1.ts scheduleOrEmpty (espn_analyze_matchup pre)",
    tool: "espn_analyze_matchup",
    args: { week: 5, mode: "pre", seed: 1 },
    rest: "lock times and byes unknown",
  },
  {
    site: "analytics.ts espn_analyze_lineup's pro schedule",
    tool: "espn_analyze_lineup",
    args: { week: 5, objective: "auto" },
    rest: "lock times unknown",
  },
  // F2: live mode's schedule read, whose conditioning line is said by cause too
  {
    site: "analytics-p1.ts scheduleOrEmpty (espn_analyze_matchup live)",
    tool: "espn_analyze_matchup",
    args: { week: 5, mode: "live", seed: 1 },
    rest: "lock times and byes unknown",
  },
  // F1: the optional schedule reads that said no line
  {
    site: "league.ts the scoreboard's pro schedule (its period flags)",
    tool: "espn_get_scoreboard",
    args: { week: 4 },
    rest: "provisional and corrections_window_open are conservative",
  },
  {
    site: "league.ts the box score's pro schedule (game states and period flags)",
    tool: "espn_get_box_score",
    args: { week: 4, team_id: 2 },
    rest: "game_state from the box score alone; final, provisional and corrections_window_open are conservative",
  },
  {
    site: "players.ts the player list's pro schedule",
    tool: "espn_list_players",
    args: { status: "WAIVERS", sort: "percOwned", week: 5, limit: 25 },
    rest: "next_opponent and next_kickoff are null",
  },
  {
    site: "datasets.ts the injuries' pro schedule",
    tool: "espn_get_injuries",
    args: { players: { team_id: 2 } },
    rest: "kickoffs unknown and game_day false",
  },
  {
    site: "reclog.ts E13's pro schedule (the scored week's games, the kickoffs)",
    tool: "espn_analyze_retrospective",
    args: { week: 4 },
    rest: "final and corrections_window_open are conservative; no forecast or attribution row is scored",
  },
  {
    site: "reclog.ts E13's default week (lastFinalWeek)",
    tool: "espn_analyze_retrospective",
    args: {},
    rest: "the week scored is the one before the current week",
  },
];

describe("R12-4: an optional pro-schedule read's line says 'not read' on a refusal, 'unavailable' on an outage", () => {
  it.each(SCHEDULE_LINES.map((s) => [s.site, s] as const))(
    "%s",
    async (_label, s) => {
      const unavailable = `pro schedule unavailable: ${s.rest}`;
      const notRead = `pro schedule not read: ${s.rest}`;
      const clean = await run(s.tool, s.args, world.services);
      expect(clean.isError, peek(clean.body)).toBe(false);
      const cleanWarnings = clean.body.warnings ?? [];
      expect(cleanWarnings).not.toContain(unavailable);
      for (const code of ["ESPN_AUTH_REJECTED", "ESPN_REQUIRES_COOKIES"]) {
        const r = await run(s.tool, s.args, espnFault(() => coded(code))(world.services));
        expect(r.isError, `${code} ${peek(r.body)}`).toBe(false);
        const w = r.body.warnings ?? [];
        expect(w, code).toContain(notRead);
        expect(w, code).not.toContain(unavailable);
        // the session line says why and the one command; partial (plan 01 §4.2)
        expect(
          w.filter((x) => x.endsWith(END[code] ?? "")),
          code,
        ).toHaveLength(1);
        expect(r.body.partial, code).toBe(true);
        // and no other line reads the refusal as data unavailable (the refusal sweep's oracle)
        expect(
          w.filter((x) => x.includes("unavailable") && !cleanWarnings.includes(x)),
          code,
        ).toEqual([]);
      }
      const out = await run(
        s.tool,
        s.args,
        espnFault(() => coded("ESPN_UPSTREAM_UNAVAILABLE"))(world.services),
      );
      expect(out.isError, peek(out.body)).toBe(false);
      expect(out.body.warnings).toContain(unavailable);
      expect(out.body.warnings ?? []).not.toContain(notRead);
    },
    120_000,
  );
});

describe("R12-4: espn_analyze_trade's offer without the season simulation", () => {
  const unavailable = "season simulation unavailable: ΔU from the cold-start PF-per-win rate";
  const notRead = "season simulation not read: ΔU from the cold-start PF-per-win rate";
  let args: J = {};
  beforeAll(async () => {
    const roster = async (team: number): Promise<{ player_id: number; slot: string }[]> => {
      const r = await run("espn_get_roster", { week: 5, team_id: team }, world.services);
      expect(r.isError, peek(r.body)).toBe(false);
      return (r.body.data as { players: { player_id: number; slot: string }[] }).players;
    };
    const mine = await roster(2);
    const rival = await roster(3);
    args = {
      offer: {
        partner_team_id: 3,
        give: [mine.find((p) => p.slot !== "IR")?.player_id ?? 0],
        get: [rival.find((p) => p.slot !== "IR")?.player_id ?? 0],
      },
      seed: 1,
    };
  }, 120_000);
  it("a refused matchups read says 'not read'; an outage still says 'unavailable'", async () => {
    const clean = await run("espn_analyze_trade", args, world.services);
    expect(clean.isError, peek(clean.body)).toBe(false);
    expect(clean.body.warnings ?? []).not.toContain(unavailable);
    for (const code of ["ESPN_AUTH_REJECTED", "ESPN_REQUIRES_COOKIES"]) {
      const r = await run(
        "espn_analyze_trade",
        args,
        faulty(world.services, { getMatchups: coded(code) }),
      );
      expect(r.isError, `${code} ${peek(r.body)}`).toBe(false);
      const w = r.body.warnings ?? [];
      expect(w, code).toContain(notRead);
      expect(w, code).not.toContain(unavailable);
      expect(
        w.filter((x) => x.endsWith(END[code] ?? "")),
        code,
      ).toHaveLength(1);
      expect(r.body.partial, code).toBe(true);
    }
    const out = await run(
      "espn_analyze_trade",
      args,
      faulty(world.services, { getMatchups: coded("ESPN_UPSTREAM_UNAVAILABLE") }),
    );
    expect(out.isError, peek(out.body)).toBe(false);
    expect(out.body.warnings).toContain(unavailable);
    expect(out.body.warnings ?? []).not.toContain(notRead);
  }, 120_000);
});

/** An optional pro-schedule read, and its line's rest (every one says what its answer goes without). */
interface StaleSite {
  readonly site: string;
  readonly tool: string;
  readonly args: () => J;
  readonly rest: string;
}

// every optional pro-schedule read, each with its line (the round-5 verifier's F1: the scoreboard,
// the box score, the player list, the injuries and E13 absorbed STALE_ONLY and said nothing)
const STALE_SITES: readonly StaleSite[] = [
  ...SCHEDULE_LINES.map((s) => ({ ...s, args: () => s.args })),
  {
    site: "analytics-p1.ts scheduleOrEmpty (espn_analyze_matchup season)",
    tool: "espn_analyze_matchup",
    args: () => ({ mode: "season", seed: 4 }),
    rest: "lock times and byes unknown",
  },
  {
    site: "analytics-p1.ts scheduleOrEmpty (espn_analyze_schedule)",
    tool: "espn_analyze_schedule",
    args: () => ({}),
    rest: "lock times and byes unknown",
  },
  {
    site: "analytics-p1.ts scheduleOrEmpty (espn_analyze_roster)",
    tool: "espn_analyze_roster",
    args: () => ({ seed: 3 }),
    rest: "lock times and byes unknown",
  },
  {
    site: "common.ts rosReadingOf (espn_analyze_replacement)",
    tool: "espn_analyze_replacement",
    args: () => ({}),
    rest: "ESPN's rest-of-season total read from the first value week",
  },
  {
    site: "common.ts rosReadingOf (espn_analyze_waivers)",
    tool: "espn_analyze_waivers",
    args: () => ({ mode: "auto", phase: "auto" }),
    rest: "ESPN's rest-of-season total read from the first value week",
  },
  {
    site: "common.ts rosReadingOf (espn_analyze_trade)",
    tool: "espn_analyze_trade",
    args: () => ({ find_partners: { need_position: "WR" }, seed: 2 }),
    rest: "ESPN's rest-of-season total read from the first value week",
  },
  {
    site: "common.ts rosReadingOf (espn_analyze_injury_cascade)",
    tool: "espn_analyze_injury_cascade",
    args: () => ({ player: { player_ids: [rb] } }),
    rest: "ESPN's rest-of-season total read from the first value week",
  },
  {
    site: "common.ts rosReadingOf (espn_analyze_league_activity)",
    tool: "espn_analyze_league_activity",
    args: () => ({}),
    rest: "ESPN's rest-of-season total read from the first value week",
  },
];

describe("R12-5: every optional pro-schedule read absorbs STALE_ONLY with its 'unavailable' line; a bug is INTERNAL", () => {
  it.each(STALE_SITES.map((s) => [s.site, s] as const))(
    "%s",
    async (_label, s) => {
      const clean = await run(s.tool, s.args(), world.services);
      expect(clean.isError, peek(clean.body)).toBe(false);
      for (const [how, fault] of [
        ["dataset past its hard limit", datasetFault],
        ["ESPN's view with only an expired entry cached", espnFault],
      ] as const) {
        const stale = await run(
          s.tool,
          s.args(),
          fault(() => new EffError("STALE_ONLY"))(world.services),
        );
        expect(stale.isError, `${how} ${peek(stale.body)}`).toBe(false);
        expect(stale.body.warnings, how).toContain(`pro schedule unavailable: ${s.rest}`);
        expect(stale.body.warnings ?? [], how).not.toContain(`pro schedule not read: ${s.rest}`);
        const b = await run(s.tool, s.args(), fault(bug)(world.services));
        expect(b.isError, `${how} ${peek(b.body)}`).toBe(true);
        expect(codeOf(b.body), how).toBe("INTERNAL");
        expect(JSON.stringify(b.body)).not.toContain("injected bug");
      }
    },
    240_000,
  );
});

// the round-5 verifier's F2 at its root: E3 live's `live_unread` decided both whether the live facts
// condition P(win) and the line that says they were not read, so a refused read either was called
// "unavailable" (the pro schedule) or, left out of the list, let P(win) condition on facts never read
// (the box score: a finished starter scored 0 points). A refused fact still conditions nothing
// (plan 01 §5.6–§5.7; `2bec608`), and its line is the session line, never "unavailable"
/** The part of E3's data the F2 check reads. */
interface Live {
  readonly data?: { readonly live?: unknown; readonly rec?: { readonly action?: string } };
}

describe("F2: E3 live conditions nothing on a refused live fact, and never calls the refusal unavailable", () => {
  const args = { week: 5, mode: "live", seed: 1 } as const;
  const OUTAGE_LINE = /^live conditioning unavailable: (.+) not read; p_win is the pre-game number/;
  const FAULTS: readonly (readonly [
    string,
    string,
    (code: string) => (s: McpServices) => McpServices,
  ])[] = [
    [
      "the pro schedule's game states",
      "the pro schedule's week-5 game states",
      (code) => espnFault(() => coded(code)),
    ],
    [
      "the box score's points so far",
      "the box score's points so far (espn:mBoxscore)",
      (code) => (s) => faulty(s, { getBoxScores: coded(code) }),
    ],
  ];
  it.each(FAULTS.map(([label, fact, fault]) => [label, fact, fault] as const))(
    "%s",
    async (_label, fact, fault) => {
      const clean = await run("espn_analyze_matchup", args, world.services);
      expect(clean.isError, peek(clean.body)).toBe(false);
      const cleanWarnings = clean.body.warnings ?? [];
      // the clean call conditions on both facts
      expect((clean.body as Live).data?.live, peek(clean.body)).not.toBeNull();
      expect(cleanWarnings.some((w) => OUTAGE_LINE.test(w))).toBe(false);
      for (const code of ["ESPN_AUTH_REJECTED", "ESPN_REQUIRES_COOKIES"]) {
        const r = await run("espn_analyze_matchup", args, fault(code)(world.services));
        expect(r.isError, `${code} ${peek(r.body)}`).toBe(false);
        const w = r.body.warnings ?? [];
        // nothing conditioned: live null, the rec says the live facts were not read, partial
        expect((r.body as Live).data?.live, code).toBeNull();
        expect((r.body as Live).data?.rec?.action, code).toBe(
          "no lineup action: pre-game win probability of the lineups as set (live facts not read)",
        );
        expect(r.body.partial, code).toBe(true);
        expect(
          w.some((x) => x.includes("finished players without an ESPN actual")),
          code,
        ).toBe(false);
        // said once, by the session line; no line calls the refusal unavailable
        expect(
          w.filter((x) => x.endsWith(END[code] ?? "")),
          code,
        ).toHaveLength(1);
        expect(
          w.filter((x) => x.includes("unavailable") && !cleanWarnings.includes(x)),
          code,
        ).toEqual([]);
      }
      // an outage of the same read still says the conditioning line, naming the fact
      const out = await run(
        "espn_analyze_matchup",
        args,
        fault("ESPN_UPSTREAM_UNAVAILABLE")(world.services),
      );
      expect(out.isError, peek(out.body)).toBe(false);
      expect((out.body as Live).data?.live).toBeNull();
      const line = (out.body.warnings ?? []).find((x) => OUTAGE_LINE.test(x));
      expect(line, peek(out.body)).toBe(
        `live conditioning unavailable: ${fact} not read; p_win is the pre-game number for the lineups as set (live: null) — call again for the live one`,
      );
    },
    120_000,
  );
});
