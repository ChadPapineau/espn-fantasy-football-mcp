// fixture-refusals.test.ts — a session refusal is never read as data unavailable, over the fixture
// sessions the eval suite grades (the round-4c product account's E13 defect, swept over every tool;
// changelog §R10, R10-11, R10-12's house form, R10-18, R10-27, R10-28). Every tool of the full
// toolset, on:
//   - private-expiring (R10-28): a seed server validates and reads the league settings, then each
//     tool runs on a NEW server whose label reads `stored`, so its first uncached read takes the
//     scripted 401 mid-call. Oracle: when the label moved to `rejected` during the call, the call
//     said it — its coded ESPN_AUTH_REJECTED, or `partial: true` with a line ending in `eff setup`;
//   - private-league (R10-27, label `rejected`) and private-league-none (`not_configured`): every
//     league read is refused with zero requests — the call's coded refusal, or partial with the line;
//   - auth-rejected (a PUBLIC league under a rejected session): reads are keyless, nothing is refused
//     and no session line is added (unchanged).
// On every world, no warning reads a refused read as "unavailable". Over the production stdio entry
// (in-memory transport), temp directories, the fixture's frozen clock; no network, no value.
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServices } from "../../src/services/index.js";
import {
  ROOT,
  call,
  connect,
  makeWorld,
  withFixtureSeed,
  type World,
} from "../mcp/helpers/world.js";

const FX = path.join(ROOT, "fixtures", "espn", "fx-10h");
const CLOCK_AT = "2026-10-07T01:00:00.000Z";
type Body = Record<string, unknown> & {
  warnings?: string[];
  partial?: boolean;
  error?: { code?: string };
};
type Client = Awaited<ReturnType<typeof connect>>["client"];

const R_END = "in a terminal to replace it";
const N_END = "in a terminal to add one";
const codeOf = (b: Body): unknown => b.error?.code ?? (b as { code?: unknown }).code;

/** Every ESPN-reading tool with arguments that need no earlier step (Team 02, week 5). */
const CALLS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["espn_get_league", {}],
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
  ["espn_get_player_outlook", { players: { team_id: 2 } }],
  ["espn_get_player_usage", { players: { team_id: 2 }, window: 3 }],
  ["espn_get_defense_profile", { nfl_team: "DET" }],
  ["espn_analyze_matchup", { week: 5, mode: "pre", seed: 1 }],
  ["espn_analyze_matchup", { mode: "season", seed: 4 }],
  ["espn_analyze_replacement", {}],
  ["espn_analyze_trade", { find_partners: { need_position: "WR" }, seed: 2 }],
  ["espn_analyze_schedule", {}],
  ["espn_analyze_roster", { seed: 3 }],
  ["espn_analyze_league_activity", {}],
  ["espn_list_recommendations", {}],
];

/** The tools that read only the server's store (no ESPN league read the session gates). */
const STORE_ONLY: ReadonlySet<string> = new Set(["espn_list_recommendations"]);

async function worldOn(variant: string): Promise<World> {
  return makeWorld({
    env: { EFF_FIXTURE_DIR: path.join(FX, variant), EFF_TOOLSET: "full" },
    teamId: 2,
    clock: CLOCK_AT,
    publishEspn: true,
  });
}

/**
 * A new server process over the world's store (its scripted label starts again); `seed`: the eval
 * seed's server (EFF_FIXTURE_SEED, the one path that disarms the scripted 401 — changelog §R10,
 * R10-33).
 */
async function server(
  world: World,
  seed = false,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const w = buildServices({
    config: withFixtureSeed(world.config, seed),
    store: world.store,
    clock: world.clock,
    logger: world.logger,
    packageRoot: ROOT,
    home: path.join(world.root, "home"),
    fetch: () => Promise.reject(new Error("no network in tests")),
    loadKeyring: () => Promise.reject(new Error("no keychain in tests")),
  });
  const c = await connect(
    { services: { ...w.services, newSeed: () => 7 }, options: w.options },
    { modern: true, options: { toolset: "full" } },
  );
  return {
    client: c.client,
    close: async () => {
      await c.close();
      w.close();
    },
  };
}

const stateOf = async (c: Client): Promise<string> => {
  const r = await call(c, "espn_get_status", {});
  return (r.body.data as { credential: { state: string } }).credential.state;
};

/** What a call that met `code` must show; null when it said the refusal. */
function unsaid(
  label: string,
  r: { isError: boolean; body: unknown },
  code: string,
): string | null {
  const body = r.body as Body;
  if (r.isError) return codeOf(body) === code ? null : `${label}: answered ${String(codeOf(body))}`;
  const end = code === "ESPN_AUTH_REJECTED" ? R_END : N_END;
  const w = body.warnings ?? [];
  if (!w.some((x) => x.endsWith(end))) return `${label}: no session line (${w.join(" | ")})`;
  const pending = label.includes('"pending":true');
  if (!pending && body.partial !== true) return `${label}: partial ${String(body.partial)}`;
  return null;
}

/** A warning that reads an ESPN read as unavailable (the house never says a refusal so). */
const UNAVAILABLE_ESPN =
  /^(?:partial: )?espn:\w+ unavailable|box scores unavailable|seeding evidence unavailable: last season could not be read|^(?:standings|rosters|my roster) unavailable/;

describe("private-expiring (R10-28): the 401 lands mid-call in every tool, and every tool says it", () => {
  let world: World;
  beforeAll(async () => {
    world = await worldOn("private-expiring");
    // the seed (its own path, R10-33): an accepting probe validates, and the league settings are
    // read (left fresh)
    const seed = await server(world, true);
    expect((await call(seed.client, "espn_check_auth", {})).isError).toBe(false);
    expect((await call(seed.client, "espn_get_league", {})).isError).toBe(false);
    await seed.close();
  }, 120_000);
  afterAll(() => {
    world.cleanup();
  });

  it("each tool on a fresh `stored` server: the refusal is its error or partial with the line", async () => {
    const failures: string[] = [];
    let landed = 0;
    for (const [tool, args] of CALLS) {
      const label = `${tool} ${JSON.stringify(args)}`;
      const s = await server(world);
      expect(await stateOf(s.client), label).toBe("stored");
      const r = await call(s.client, tool, args);
      const after = await stateOf(s.client);
      await s.close();
      for (const w of (r.body as Body).warnings ?? [])
        if (UNAVAILABLE_ESPN.test(w)) failures.push(`${label}: read as unavailable: ${w}`);
      if (after !== "rejected") {
        // nothing uncached was read: nothing was refused, nothing to say
        const w = (r.body as Body).warnings ?? [];
        if (w.some((x) => x.endsWith(R_END)) && !label.includes('"pending":true'))
          failures.push(`${label}: a session line with no refusal`);
        continue;
      }
      landed += 1;
      const f = unsaid(label, r, "ESPN_AUTH_REJECTED");
      if (f !== null) failures.push(f);
    }
    expect(failures).toEqual([]);
    // the 401 landed inside almost every tool (only the settings were fresh)
    expect(landed).toBeGreaterThan(CALLS.length - 6);
  }, 600_000);
});

describe.each([
  ["private-league", "ESPN_AUTH_REJECTED"],
  ["private-league-none", "ESPN_REQUIRES_COOKIES"],
] as const)(
  "%s (R10-27): every league read is refused, and every tool says it",
  (variant, code) => {
    let world: World;
    let s: Awaited<ReturnType<typeof server>>;
    beforeAll(async () => {
      world = await worldOn(variant);
      s = await server(world);
    }, 120_000);
    afterAll(async () => {
      await s.close();
      world.cleanup();
    });

    it("the refusal is the call's coded error, or partial with the session line — never unavailable", async () => {
      const failures: string[] = [];
      for (const [tool, args] of CALLS) {
        const label = `${tool} ${JSON.stringify(args)}`;
        const r = await call(s.client, tool, args);
        for (const w of (r.body as Body).warnings ?? [])
          if (UNAVAILABLE_ESPN.test(w)) failures.push(`${label}: read as unavailable: ${w}`);
        if (STORE_ONLY.has(tool)) {
          // it reads the server's own log, no ESPN league read: nothing refused, nothing to say
          if (r.isError) failures.push(`${label}: failed with no league read`);
          continue;
        }
        const f = unsaid(label, r, code);
        if (f !== null) failures.push(f);
      }
      expect(failures).toEqual([]);
    }, 600_000);
  },
);

describe("auth-rejected (a PUBLIC league under a rejected session): keyless, unchanged", () => {
  let world: World;
  let s: Awaited<ReturnType<typeof server>>;
  beforeAll(async () => {
    world = await worldOn("auth-rejected");
    s = await server(world);
  }, 120_000);
  afterAll(async () => {
    await s.close();
    world.cleanup();
  });

  it("no tool is refused and none gets a session line (pending claims keep R10-10's own line)", async () => {
    const failures: string[] = [];
    for (const [tool, args] of CALLS) {
      const label = `${tool} ${JSON.stringify(args)}`;
      const r = await call(s.client, tool, args);
      const body = r.body as Body;
      if (r.isError && /ESPN_AUTH_REJECTED|ESPN_REQUIRES_COOKIES/.test(String(codeOf(body))))
        failures.push(`${label}: refused on a public league`);
      const lines = (body.warnings ?? []).filter((w) => w.endsWith(R_END) || w.endsWith(N_END));
      const own = label.includes('"pending":true')
        ? lines.filter((w) => !w.startsWith("pending: null"))
        : lines;
      if (own.length > 0) failures.push(`${label}: ${own.join(" | ")}`);
    }
    expect(failures).toEqual([]);
    expect(await stateOf(s.client)).toBe("rejected");
  }, 600_000);
});
