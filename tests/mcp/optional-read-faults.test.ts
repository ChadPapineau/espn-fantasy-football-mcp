// optional-read-faults.test.ts — every optional read absorbs only what an optional read may lose
// (changelog §R11, R11-4; E13's house pattern, `8f41601`; the Stage C backlog's "Optional reads that
// still absorb every error, or only an outage"): an outage (isDegradable) and a session refusal,
// which the call's session line says (src/mcp/refusals.ts). A bug — a thrown TypeError here — is
// rethrown and the call answers INTERNAL, never "unavailable". Per site: a bug at a read that
// absorbed every error now answers INTERNAL; a refusal at a read that absorbed only an outage is
// now said by the session line (partial, the one command), where it failed the call; the outage
// path is unchanged. Fixture mode (fx-10h, Team 02, week 5), fake clock; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffError } from "../../src/mcp/errors.js";
import type { McpServices } from "../../src/mcp/services.js";
import {
  fallbackWarning,
  optionalDatasetOrThrow,
  optionalOrThrow,
} from "../../src/mcp/tools/common.js";
import { coded, faulty, type Fault } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
type J = Record<string, unknown>;
type Body = J & { warnings?: string[]; partial?: boolean; error?: { code?: string } };
const R_END = "in a terminal to replace it";

let world: World;
let client: Client;
let close: () => Promise<void>;
let rb: number;
let season: number;

const codeOf = (b: Body): unknown => b.error?.code ?? (b as { code?: unknown }).code;
const bug = (): Error => new TypeError("injected bug");

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
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  season = (world.services.league as { season: number }).season;
  const roster = await call(client, "espn_get_roster", { week: 5 });
  expect(roster.isError).toBe(false);
  const players = (roster.body.data as { players: { player_id: number; position: string }[] })
    .players;
  rb = players.find((p) => p.position === "RB")?.player_id ?? 0;
  expect(rb).toBeGreaterThan(0);
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

/** The services with the pro schedule dataset's game read throwing `e` (no ESPN read involved). */
function scheduleFault(services: McpServices, e: () => Error): McpServices {
  const bind = (t: object, p: PropertyKey): unknown => {
    const v: unknown = Reflect.get(t, p, t);
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  };
  const ps = services.datasets.proSchedule;
  const proSchedule = new Proxy(ps, {
    get: (t, p) =>
      p === "games"
        ? () => {
            throw e();
          }
        : bind(t, p),
  });
  const datasets = new Proxy(services.datasets, {
    get: (t, p) => (p === "proSchedule" ? proSchedule : bind(t, p)),
  });
  return { ...services, datasets };
}

/** A fault on last season's reads only (the seeding evidence's), this season's served. */
const prevOnly =
  (e: () => Error): Fault =>
  (real, ...args) =>
    (args[0] as { season?: number }).season === season - 1 ? Promise.reject(e()) : real(...args);

/**
 * Last season's read answered with this season's (fx-10h stores no previous season's settings or
 * schedule, so the seeding evidence stops at its standings): the reads after it are reached.
 */
const prevAsThis: Fault = (real, ...args) => {
  const ref = args[0] as { season?: number };
  return ref.season === season - 1 ? real({ ...ref, season }, ...args.slice(1)) : real(...args);
};

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

/** A site: the tool call that reaches it, and how its read is made to fail with `e`. */
interface Site {
  readonly site: string;
  readonly tool: string;
  readonly args: () => J;
  readonly fail: (s: McpServices, e: () => Error) => McpServices;
}
const read =
  (method: string) =>
  (s: McpServices, e: () => Error): McpServices =>
    faulty(s, { [method]: ((_real: unknown) => Promise.reject(e())) as Fault });
const readPrev =
  (method: string) =>
  (s: McpServices, e: () => Error): McpServices =>
    faulty(s, { [method]: prevOnly(e) });

// --- the reads that absorbed every error: a bug now answers INTERNAL ------------------------------
const ABSORBED_EVERY_ERROR: readonly Site[] = [
  {
    site: "league.ts evidenceOf: last season's settings",
    tool: "espn_get_league",
    args: () => ({ include: ["seeding_evidence"] }),
    fail: readPrev("getLeagueRules"),
  },
  {
    site: "league.ts evidenceOf: last season's standings",
    tool: "espn_get_league",
    args: () => ({ include: ["seeding_evidence"] }),
    fail: readPrev("getStandings"),
  },
  {
    site: "league.ts evidenceOf: last season's schedule",
    tool: "espn_get_league",
    args: () => ({ include: ["seeding_evidence"] }),
    fail: (s, e) => faulty(s, { getLeagueRules: prevAsThis, getMatchups: prevOnly(e) }),
  },
  {
    site: "league.ts evidenceOf: last season's league (the bracket-edit flag)",
    tool: "espn_get_league",
    args: () => ({ include: ["seeding_evidence"] }),
    fail: (s, e) =>
      faulty(s, { getLeagueRules: prevAsThis, getMatchups: prevAsThis, getLeague: prevOnly(e) }),
  },
  {
    site: "league.ts the clock's pro schedule",
    tool: "espn_get_league",
    args: () => ({ include: ["clock"] }),
    fail: scheduleFault,
  },
  {
    site: "league.ts the scoreboard's pro schedule (periodFlags)",
    tool: "espn_get_scoreboard",
    args: () => ({ week: 4 }),
    fail: scheduleFault,
  },
  {
    site: "league.ts the live scoreboard's pro schedule",
    tool: "espn_get_live_scoreboard",
    args: () => ({}),
    fail: scheduleFault,
  },
  {
    site: "league.ts the box score's pro schedule",
    tool: "espn_get_box_score",
    args: () => ({ week: 4, team_id: 2 }),
    fail: scheduleFault,
  },
  {
    site: "players.ts teamNames (the standings' team names)",
    tool: "espn_list_players",
    args: () => ({ status: "ALL", sort: "percOwned", week: 5, limit: 25 }),
    fail: read("getStandings"),
  },
  {
    site: "players.ts the player list's pro schedule",
    tool: "espn_list_players",
    args: () => ({ status: "WAIVERS", sort: "percOwned", week: 5, limit: 25 }),
    fail: scheduleFault,
  },
  {
    site: "analytics.ts E2's standings",
    tool: "espn_analyze_lineup",
    args: () => ({ week: 5, objective: "auto" }),
    fail: read("getStandings"),
  },
  {
    site: "datasets.ts the injuries' pro schedule",
    tool: "espn_get_injuries",
    args: () => ({ players: { team_id: 2 } }),
    fail: scheduleFault,
  },
];

// --- the reads that absorbed an outage only: a refusal is now said by the session line -----------
const OUTAGE_ONLY: readonly Site[] = [
  {
    site: "league.ts the live scoreboard's live view (falls back to season results)",
    tool: "espn_get_live_scoreboard",
    args: () => ({}),
    fail: read("getLiveMatchups"),
  },
  {
    site: "league.ts the transaction feed (falls back to the stored history)",
    tool: "espn_list_transactions",
    args: () => ({ count: 40 }),
    fail: read("listTransactions"),
  },
  {
    site: "players.ts search's player cards (falls back to identity only)",
    tool: "espn_search_players",
    args: () => ({ query: "Robinson" }),
    fail: read("getPlayers"),
  },
  {
    site: "analytics-p1.ts E3's standings (standingsOrNull)",
    tool: "espn_analyze_matchup",
    args: () => ({ mode: "season", seed: 4 }),
    fail: read("getStandings"),
  },
  {
    site: "analytics-p1.ts E3's rosters (the season's E1-fitted team weeks)",
    tool: "espn_analyze_matchup",
    args: () => ({ mode: "season", seed: 4 }),
    fail: read("getRosters"),
  },
  {
    site: "analytics-p1.ts E3's box scores (live mode)",
    tool: "espn_analyze_matchup",
    args: () => ({ week: 5, mode: "live", seed: 1 }),
    fail: read("getBoxScores"),
  },
  {
    site: "p1-common.ts playoffAliveOf's matchups (E5's playoff weeks)",
    tool: "espn_analyze_waivers",
    args: () => ({ mode: "auto", phase: "auto" }),
    fail: read("getMatchups"),
  },
  {
    site: "market-p1.ts E7's rosters (my roster)",
    tool: "espn_analyze_injury_cascade",
    args: () => ({ player: { player_ids: [rb] } }),
    fail: read("getRosters"),
  },
  {
    site: "market-p1.ts E10's rosters (the subject's slot)",
    tool: "espn_analyze_evidence",
    args: () => ({
      player: { player_ids: [rb] },
      claim: { text: "He is expected to start on Sunday", source: "a friend" },
    }),
    fail: read("getRosters"),
  },
  {
    site: "analytics-p1.ts E3's live view",
    tool: "espn_analyze_matchup",
    args: () => ({ week: 5, mode: "pre", seed: 1 }),
    fail: read("getLiveMatchups"),
  },
  {
    site: "analytics-p1.ts E5's free-agent pool (poolOf)",
    tool: "espn_analyze_replacement",
    args: () => ({}),
    fail: read("listPlayers"),
  },
  {
    site: "analytics-p1.ts E8's matchups (the playoff multipliers)",
    tool: "espn_analyze_schedule",
    args: () => ({}),
    fail: read("getMatchups"),
  },
  {
    site: "analytics-p1.ts E9's matchups (the handcuff cases)",
    tool: "espn_analyze_roster",
    args: () => ({ seed: 3 }),
    fail: read("getMatchups"),
  },
  {
    site: "market-p1.ts E6's standings and matchups",
    tool: "espn_analyze_trade",
    args: () => ({ find_partners: { need_position: "WR" }, seed: 2 }),
    fail: read("getStandings"),
  },
  {
    site: "market-p1.ts E6's free-agent pool (poolOf)",
    tool: "espn_analyze_trade",
    args: () => ({ find_partners: { need_position: "WR" }, seed: 2 }),
    fail: read("listPlayers"),
  },
  {
    site: "market-p1.ts E6's matchups (ΔU's season readings)",
    tool: "espn_analyze_trade",
    args: () => ({ find_partners: { need_position: "WR" }, seed: 2 }),
    fail: read("getMatchups"),
  },
  {
    site: "market-p1.ts E7's standings (the injury cascade)",
    tool: "espn_analyze_injury_cascade",
    args: () => ({ player: { player_ids: [rb] } }),
    fail: read("getStandings"),
  },
  {
    site: "market-p1.ts E10's outlooks (the evidence)",
    tool: "espn_analyze_evidence",
    args: () => ({
      player: { player_ids: [rb] },
      claim: { text: "He is expected to start on Sunday", source: "a friend" },
    }),
    fail: read("getPlayerOutlooks"),
  },
  {
    site: "datasets-p1.ts the usage's scoring settings",
    tool: "espn_get_player_usage",
    args: () => ({ players: { team_id: 2 }, window: 3 }),
    fail: read("getScoringSettings"),
  },
  {
    site: "espn-p1.ts ESPN's projections (falls back to the snapshots)",
    tool: "espn_get_projections",
    args: () => ({ players: { team_id: 2 }, horizon: "ros" }),
    fail: read("getNativeProjections"),
  },
  {
    site: "espn-p1.ts ESPN's outlook paragraphs",
    tool: "espn_get_player_outlook",
    args: () => ({ players: { team_id: 2 }, include_season_outlook: true }),
    fail: read("getPlayerOutlooks"),
  },
];

describe("the catch helpers (R11-4)", () => {
  it("optionalOrThrow: null for an outage, a refusal or fixture_missing; anything else rethrown", () => {
    for (const code of [
      "ESPN_UPSTREAM_UNAVAILABLE",
      "ESPN_DRIFT_DETECTED",
      "ESPN_HOST_MOVED",
      "RATE_LIMITED",
      "ESPN_AUTH_REJECTED",
      "ESPN_REQUIRES_COOKIES",
    ])
      expect(optionalOrThrow(coded(code)), code).toBeNull();
    const missing = Object.assign(new Error("fixture"), {
      name: "FixtureError",
      effDetails: { reason: "fixture_missing" },
    });
    expect(optionalOrThrow(missing)).toBeNull();
    const b = bug();
    expect(() => optionalOrThrow(b)).toThrow(b);
    expect(() => optionalOrThrow(coded("INTERNAL"))).toThrow(/INTERNAL/);
    expect(() => optionalOrThrow(new EffError("STALE_ONLY"))).toThrow();
    expect(() => optionalOrThrow("boom")).toThrow();
  });
  it("optionalDatasetOrThrow: the same, and a dataset past its hard limit (STALE_ONLY) as null", () => {
    expect(optionalDatasetOrThrow(new EffError("STALE_ONLY"))).toBeNull();
    expect(optionalDatasetOrThrow(coded("ESPN_UPSTREAM_UNAVAILABLE"))).toBeNull();
    expect(optionalDatasetOrThrow(coded("ESPN_REQUIRES_COOKIES"))).toBeNull();
    const b = bug();
    expect(() => optionalDatasetOrThrow(b)).toThrow(b);
    expect(() => optionalDatasetOrThrow(coded("VALIDATION"))).toThrow(/VALIDATION/);
  });
  it("fallbackWarning: 'unavailable' on an outage, 'not read' on a refusal (the session line says why)", () => {
    expect(fallbackWarning(coded("ESPN_UPSTREAM_UNAVAILABLE"), "espn:v", "served from x")).toBe(
      "espn:v unavailable: served from x",
    );
    expect(fallbackWarning(coded("ESPN_AUTH_REJECTED"), "espn:v", "served from x")).toBe(
      "espn:v not read: served from x",
    );
    expect(fallbackWarning(coded("ESPN_REQUIRES_COOKIES"), "espn:v", "served from x")).toBe(
      "espn:v not read: served from x",
    );
  });
});

describe("a bug in a read that absorbed every error answers INTERNAL (R11-4)", () => {
  it.each(ABSORBED_EVERY_ERROR.map((s) => [s.site, s] as const))(
    "%s",
    async (_label, s) => {
      const clean = await run(s.tool, s.args(), world.services);
      expect(clean.isError, JSON.stringify(clean.body).slice(0, 300)).toBe(false);
      const r = await run(s.tool, s.args(), s.fail(world.services, bug));
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(true);
      expect(codeOf(r.body)).toBe("INTERNAL");
      expect(JSON.stringify(r.body)).not.toContain("injected bug");
      // the outage path is unchanged: the call still answers
      const out = await run(
        s.tool,
        s.args(),
        s.fail(world.services, () => coded("ESPN_UPSTREAM_UNAVAILABLE")),
      );
      expect(out.isError, JSON.stringify(out.body).slice(0, 300)).toBe(false);
    },
    120_000,
  );
});

describe("a refusal at a read that absorbed an outage only is said by the session line (R11-4)", () => {
  it.each(OUTAGE_ONLY.map((s) => [s.site, s] as const))(
    "%s",
    async (_label, s) => {
      const clean = await run(s.tool, s.args(), world.services);
      expect(clean.isError, JSON.stringify(clean.body).slice(0, 300)).toBe(false);
      const cleanWarnings = clean.body.warnings ?? [];
      const r = await run(
        s.tool,
        s.args(),
        s.fail(world.services, () => coded("ESPN_AUTH_REJECTED")),
      );
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      expect(r.body.partial).toBe(true);
      const warnings = r.body.warnings ?? [];
      expect(
        warnings.filter((w) => w.endsWith(R_END)),
        JSON.stringify(warnings),
      ).toHaveLength(1);
      const fresh = warnings.filter((w) => w.includes("unavailable") && !cleanWarnings.includes(w));
      expect(fresh).toEqual([]);
      // a bug there answers INTERNAL (as before), and the outage path is unchanged
      const b = await run(s.tool, s.args(), s.fail(world.services, bug));
      expect(b.isError).toBe(true);
      expect(codeOf(b.body)).toBe("INTERNAL");
      const out = await run(
        s.tool,
        s.args(),
        s.fail(world.services, () => coded("ESPN_UPSTREAM_UNAVAILABLE")),
      );
      expect(out.isError, JSON.stringify(out.body).slice(0, 300)).toBe(false);
    },
    120_000,
  );
});
