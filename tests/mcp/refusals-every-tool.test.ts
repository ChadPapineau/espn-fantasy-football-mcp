// refusals-every-tool.test.ts — a session refusal is never read as data unavailable (the round-4c
// product account's E13 defect, swept over every tool; changelog §R10, R10-11 and R10-12's house
// form, R10-18). For every tool of the full toolset, and for every ESPN league read that tool makes
// on fx-10h, that one read alone refuses — ESPN_AUTH_REJECTED or ESPN_REQUIRES_COOKIES, as the
// cookie gate or ESPN's 401 answers — and the call must say it: either the call's own coded error
// with that code, or a result with `partial: true` and a fixed line ending in the one command
// (`eff setup`), and no "unavailable" line the clean call does not print. espn_list_transactions'
// pending claims keep R10-10's contract (their own line, the feed part not partial).
// espn_get_status and espn_check_auth report the session themselves and make no read on the
// call's budget: their answers are unchanged. Fixture mode, fake clock; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServices } from "../../src/mcp/services.js";
import { sessionReadsWarning } from "../../src/mcp/refusals.js";
import { coded, faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
type J = Record<string, unknown>;
type Body = J & { warnings?: string[]; partial?: boolean; error?: { code?: string } };

/** The reads whose cookie use is `never` (no session gate exists for them): not injected. */
const NEVER_GATED: ReadonlySet<string> = new Set([
  "getProSchedule",
  "probeCredential",
  "transportStatus",
  "capabilities",
  "invalidateSettings",
]);
const R_END = "in a terminal to replace it";
const N_END = "in a terminal to add one";

let world: World;
let client: Client;
let close: () => Promise<void>;
let rb: number;

const codeOf = (b: Body): unknown => b.error?.code ?? (b as { code?: unknown }).code;

/** A services bundle whose platform counts each read method it is asked for. */
function counting(services: McpServices, seen: Set<string>): McpServices {
  const real = services.platform;
  const platform = new Proxy(real, {
    get(target, prop, receiver) {
      const v: unknown = Reflect.get(target, prop, receiver);
      if (typeof v !== "function" || typeof prop !== "string") return v;
      return (...args: unknown[]) => {
        seen.add(prop);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { ...services, platform };
}

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

/** Every tool that reads ESPN, with arguments for fx-10h's Team 02 (week 5). */
const CALLS = (): readonly (readonly [string, J])[] => [
  ["espn_get_league", { include: ["league", "clock", "scoring", "roster", "rules", "seeding"] }],
  ["espn_get_league", { include: ["seeding_evidence"] }],
  ["espn_get_standings", {}],
  ["espn_get_scoreboard", { week: 4 }],
  ["espn_get_live_scoreboard", {}],
  ["espn_get_box_score", { week: 4, team_id: 2 }],
  ["espn_list_transactions", { count: 40 }],
  ["espn_list_transactions", { count: 40, pending: true }],
  ["espn_get_roster", { week: 5 }],
  ["espn_search_players", { query: "Robinson" }],
  ["espn_list_players", { status: "WAIVERS", sort: "percOwned", week: 5, limit: 25 }],
  ["espn_get_injuries", { players: { team_id: 2 } }],
  ["espn_get_schedule", { weeks: [5, 6] }],
  ["espn_project_players", { players: { team_id: 2 }, horizon: "week", week: 5, seed: 1 }],
  ["espn_analyze_lineup", { week: 5, objective: "auto" }],
  ["espn_analyze_waivers", { mode: "auto", phase: "auto" }],
  ["espn_analyze_retrospective", { week: 4 }],
  ["espn_get_player_stats", { players: { team_id: 2 }, type: "week", week: 4 }],
  ["espn_get_projections", { players: { team_id: 2 }, horizon: "ros" }],
  ["espn_get_player_outlook", { players: { team_id: 2 }, include_season_outlook: true }],
  ["espn_get_player_usage", { players: { team_id: 2 }, window: 3 }],
  // espn_get_depth_chart and espn_get_news read nflverse's and the news feeds' datasets only (no
  // ESPN league read the session gates); espn_record_recommendation reads none
  ["espn_get_defense_profile", { nfl_team: "DET" }],
  ["espn_analyze_matchup", { week: 5, mode: "pre", seed: 1 }],
  ["espn_analyze_matchup", { mode: "season", seed: 4 }],
  ["espn_analyze_replacement", {}],
  ["espn_analyze_trade", { find_partners: { need_position: "WR" }, seed: 2 }],
  ["espn_analyze_injury_cascade", { player: { player_ids: [rb] } }],
  ["espn_analyze_schedule", {}],
  ["espn_analyze_roster", { seed: 3 }],
  [
    "espn_analyze_evidence",
    {
      player: { player_ids: [rb] },
      claim: { text: "He is expected to start on Sunday", source: "a friend" },
    },
  ],
  ["espn_analyze_league_activity", {}],
  ["espn_list_recommendations", {}],
];

describe("every tool says a session refusal on any read it makes (never 'unavailable')", () => {
  it("each read of each tool, refused alone, is the call's error or partial with the session line", async () => {
    const failures: string[] = [];
    let n = 0;
    let cases = 0;
    for (const [tool, args] of CALLS()) {
      const seen = new Set<string>();
      const base = counting(world.services, seen);
      const b0 = await connect(world, { options: { toolset: "full" }, services: base });
      const clean = await call(b0.client, tool, args);
      await b0.close();
      const label0 = `${tool} ${JSON.stringify(args)}`;
      if (clean.isError) {
        failures.push(
          `${label0}: the clean call failed ${JSON.stringify(clean.body).slice(0, 200)}`,
        );
        continue;
      }
      const cleanBody = clean.body as Body;
      const cleanWarnings = cleanBody.warnings ?? [];
      for (const method of [...seen].sort()) {
        if (NEVER_GATED.has(method)) continue;
        // both refusals over the sweep: alternate, so each code meets every kind of read
        const code = n++ % 2 === 0 ? "ESPN_AUTH_REJECTED" : "ESPN_REQUIRES_COOKIES";
        const end = code === "ESPN_AUTH_REJECTED" ? R_END : N_END;
        const label = `${label0} ${method} ${code}`;
        cases += 1;
        const faults: Parameters<typeof faulty>[1] = { [method]: coded(code) };
        const s = faulty(world.services, faults);
        const c = await connect(world, { options: { toolset: "full" }, services: s });
        const r = await call(c.client, tool, args);
        await c.close();
        const body = r.body as Body;
        if (r.isError) {
          if (codeOf(body) !== code)
            failures.push(`${label}: answered ${String(codeOf(body))}, not the refusal`);
          continue;
        }
        const warnings = body.warnings ?? [];
        const said = warnings.filter((w) => w.endsWith(end));
        if (said.length === 0) failures.push(`${label}: no session line (${warnings.join(" | ")})`);
        const pendingContract =
          tool === "espn_list_transactions" && method === "listPendingTransactions";
        if (pendingContract) {
          if (body.partial !== cleanBody.partial)
            failures.push(`${label}: R10-10's pending refusal changed partial`);
        } else if (body.partial !== true)
          failures.push(`${label}: partial ${String(body.partial)}`);
        const fresh = warnings.filter(
          (w) => w.includes("unavailable") && !cleanWarnings.includes(w),
        );
        if (fresh.length > 0) failures.push(`${label}: read as unavailable: ${fresh.join(" | ")}`);
      }
    }
    process.stderr.write(`refusal sweep: ${String(cases)} cases\n`);
    expect(failures).toEqual([]);
    // the sweep reached reads in every tool (a refactor that stops counting would pass vacuously)
    expect(cases).toBeGreaterThan(80);
  }, 600_000);

  it("espn_get_status and espn_check_auth are unchanged: their own reads are not the call's", async () => {
    for (const [tool, args] of [
      ["espn_get_status", { include_checks: true }],
      ["espn_check_auth", {}],
    ] as const) {
      const clean = await call(client, tool, args);
      const s = faulty(world.services, {
        getLeague: coded("ESPN_AUTH_REJECTED"),
        getLeagueRules: coded("ESPN_AUTH_REJECTED"),
        getRosters: coded("ESPN_AUTH_REJECTED"),
      });
      const c = await connect(world, { options: { toolset: "full" }, services: s });
      const r = await call(c.client, tool, args);
      await c.close();
      const w = (r.body as Body).warnings ?? [];
      expect(
        w.some((x) => x.endsWith(R_END)),
        tool,
      ).toBe(false);
      expect((r.body as Body).partial, tool).toBe((clean.body as Body).partial);
    }
  }, 120_000);
});

describe("the mid-call shapes: an optional read of another week or season refused", () => {
  it("E13: the scored week's box scores read, the re-fit window's refused — partial and the session line, never 'unavailable' (the round-4c product account)", async () => {
    for (const [code, refusal] of [
      ["ESPN_AUTH_REJECTED", "rejected"],
      ["ESPN_REQUIRES_COOKIES", "no_session"],
    ] as const) {
      const s = faulty(world.services, {
        getBoxScores: (real, ref, week, opts) =>
          week === 4 ? real(ref, week, opts) : Promise.reject(coded(code)),
      });
      const c = await connect(world, { options: { toolset: "full" }, services: s });
      const r = await call(c.client, "espn_analyze_retrospective", { week: 4 });
      await c.close();
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      const body = r.body as Body;
      expect(body.partial, code).toBe(true);
      expect(body.warnings, code).toContain(sessionReadsWarning(refusal, ["box scores"]));
      for (const w of body.warnings ?? []) expect(w, code).not.toMatch(/box scores unavailable/);
    }
    // an outage of one week and a refusal of another: only the outage is "unavailable"
    const s = faulty(world.services, {
      getBoxScores: (real, ref, week, opts) =>
        week === 4
          ? real(ref, week, opts)
          : Promise.reject(coded(week === 3 ? "ESPN_UPSTREAM_UNAVAILABLE" : "ESPN_AUTH_REJECTED")),
    });
    const c = await connect(world, { options: { toolset: "full" }, services: s });
    const r = await call(c.client, "espn_analyze_retrospective", { week: 4 });
    await c.close();
    const body = r.body as Body;
    expect(body.partial).toBe(true);
    expect(body.warnings).toContain(
      "last week's box scores unavailable: the last-week baseline is unknown",
    );
    expect(body.warnings).toContain(sessionReadsWarning("rejected", ["box scores"]));
    const attr = (body.warnings ?? []).filter((w) => w.startsWith("attribution:"));
    expect(attr).toEqual(
      attr.length === 0
        ? []
        : [expect.stringMatching(/^attribution: 1 week\(s\) of box scores unavailable/)],
    );
  }, 120_000);

  it("seeding evidence: last season's reads refused — the session line names that season, never 'last season could not be read'", async () => {
    const season = (world.services.league as { season: number }).season;
    const prev = (ref: unknown): boolean => (ref as { season?: number }).season === season - 1;
    for (const [code, refusal] of [
      ["ESPN_AUTH_REJECTED", "rejected"],
      ["ESPN_REQUIRES_COOKIES", "no_session"],
    ] as const) {
      const refuse = (
        real: (...a: unknown[]) => Promise<unknown>,
        ...args: unknown[]
      ): Promise<unknown> => (prev(args[0]) ? Promise.reject(coded(code)) : real(...args));
      const s = faulty(world.services, {
        getLeagueRules: refuse,
        getStandings: refuse,
        getMatchups: refuse,
        getLeague: refuse,
      });
      const c = await connect(world, { options: { toolset: "full" }, services: s });
      const r = await call(c.client, "espn_get_league", { include: ["seeding_evidence"] });
      await c.close();
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      const body = r.body as Body;
      expect(body.partial, code).toBe(true);
      const line = (body.warnings ?? []).find(
        (w) => w.startsWith("partial:") && w.includes(`${String(season - 1)} `),
      );
      expect(line, JSON.stringify(body.warnings)).toBeDefined();
      expect(line).toBe(
        sessionReadsWarning(refusal, [
          `${String(season - 1)} league settings`,
          `${String(season - 1)} standings`,
        ]),
      );
      for (const w of body.warnings ?? [])
        expect(w, code).not.toMatch(/seeding evidence unavailable: last season could not be read/);
    }
  }, 120_000);
});
