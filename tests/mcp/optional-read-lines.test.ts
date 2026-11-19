// optional-read-lines.test.ts — an optional read's fixed line names its cause (changelog §R12, R12-4
// and R12-5). R12-4: every optional read's warning goes through fallbackWarning — "not read" on a
// session refusal (which the call's session line says, src/mcp/refusals.ts), "unavailable" on an
// outage; no line calls a refusal "unavailable". R12-5: a dataset past its hard limit
// (STALE_ONLY) is an outage for an optional read, so every optional pro-schedule read absorbs it
// with its "unavailable" line, espn_get_roster's included (as `a40f590` did for the injuries' read);
// a bug still answers INTERNAL. Fixture mode (fx-10h, Team 02, week 5), fake clock; no network.
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

/** An optional pro-schedule read, and its line's rest when it says one (null: the answer needs none). */
interface StaleSite {
  readonly site: string;
  readonly tool: string;
  readonly args: () => J;
  readonly rest: string | null;
}

// every optional pro-schedule read not already held by optional-read-faults.test.ts's absorb-all
// sites (the league clock, the scoreboard, the live scoreboard, the box score, the player list and
// the injuries)
const STALE_SITES: readonly StaleSite[] = [
  ...SCHEDULE_LINES.filter(
    (s) => s.tool !== "espn_get_league" && s.tool !== "espn_get_live_scoreboard",
  ).map((s) => ({ ...s, args: () => s.args })),
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
        if (s.rest !== null) {
          expect(stale.body.warnings, how).toContain(`pro schedule unavailable: ${s.rest}`);
          expect(stale.body.warnings ?? [], how).not.toContain(`pro schedule not read: ${s.rest}`);
        }
        const b = await run(s.tool, s.args(), fault(bug)(world.services));
        expect(b.isError, `${how} ${peek(b.body)}`).toBe(true);
        expect(codeOf(b.body), how).toBe("INTERNAL");
        expect(JSON.stringify(b.body)).not.toContain("injected bug");
      }
    },
    240_000,
  );
});
