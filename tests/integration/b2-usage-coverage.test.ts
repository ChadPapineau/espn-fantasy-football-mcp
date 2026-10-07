// b2-usage-coverage.test.ts — plan 10 B2 on the fixture league: `espn_get_player_usage` returns
// trailing summaries for the rostered players of fx-10h (seeded exactly as the stdio suites, the
// plugin evals and `eff`'s fixture mode see it — tests/integration/helpers/seed.ts, the shared
// nflverse/ffopportunity excerpts plus fixtures/fx10h-usage), `routes_proxy` is present and labelled,
// and `xfp_gap` is non-null wherever ffopportunity has the player's week. Every team, every rostered
// player, through the real composition root in fixture mode under EFF_TOOLSET=full.
//
// The denominator: a rostered D/ST has no player row in any usage source (nflverse player stats,
// snap counts, ffopportunity are per player; D1 says "no usage model for D/ST"), so 11 of fx-10h's
// 145 rostered entries can never carry a usage window — the share over ALL rostered entries is
// capped at 134/145 (92.4 %) by construction. The hard bound is asserted over the rostered players
// D1 models (QB/RB/WR/TE/K); the all-rostered share is reported beside it for the orchestrator's
// ruling on B2's wording (docs/evals/phase2-acceptance.md).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { envelopeViolations, identifierLeaks } from "../mcp/helpers/walk.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";
import { seedDatasets } from "./helpers/seed.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const manifest = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
  current_week: number;
};
/** Plan 10 B2's bound. */
const B2_SHARE = 0.95;

interface UsagePlayer {
  player_id: number | null;
  position: string;
  trailing: { window_games: number };
  data_gaps: string[];
  games?: {
    snaps: number | null;
    routes_proxy: number | null;
    xfp_ep: number | null;
    points_league: number | null;
    xfp_gap: number | null;
  }[];
}

let world: World;
let client: Client;
let close: () => Promise<void>;
const byTeam = new Map<number, { roster: { player_id: number; position: string }[] }>();
const usage = new Map<number, UsagePlayer>();
const full: UsagePlayer[] = [];
let notes: string[] = [];

async function ok(name: string, args: Record<string, unknown>) {
  const r = await call(client, name, args);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.body).slice(0, 300)}`);
  expect(envelopeViolations(r.body as never), name).toEqual([]);
  expect(identifierLeaks(JSON.stringify(r.body)), name).toEqual([]);
  return r.body as { data: Record<string, unknown>; warnings: string[] };
}

beforeAll(async () => {
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: manifest.my_team_id,
    clock: manifest.clock,
    publishEspn: false,
  });
  await seedDatasets(world.store, {
    storePath: storePath(world.cache),
    datasetDir: datasetDir(world.cache),
    cache: world.cache,
    clock: world.clock,
    season: 2026,
  });
  world.store.reopenChangedDatasets();
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  const teams = (await ok("espn_get_standings", {})).data.teams as { team_id: number }[];
  for (const { team_id } of teams) {
    const roster = (await ok("espn_get_roster", { team_id, week: manifest.current_week })).data
      .players as { player_id: number; position: string }[];
    byTeam.set(team_id, { roster });
    // compact (trailing only) fits a whole roster in one answer; `full` adds the per-game rows and
    // the list budget may trim its players (said in `truncated`) — those rows check the columns
    const u = await ok("espn_get_player_usage", { players: { team_id }, window: 4 });
    notes = u.data.notes as string[];
    for (const p of u.data.players as UsagePlayer[])
      if (p.player_id !== null) usage.set(p.player_id, p);
    const f = await ok("espn_get_player_usage", {
      players: { team_id },
      window: 4,
      detail: "full",
    });
    for (const p of f.data.players as UsagePlayer[]) if (p.player_id !== null) full.push(p);
  }
}, 240_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

const rostered = () => [...byTeam.values()].flatMap((t) => t.roster);
const covered = (id: number) => (usage.get(id)?.trailing.window_games ?? 0) > 0;

describe("plan 10 B2 on the fixture league (fx-10h, every team, seeded)", () => {
  it("every rostered player is answered; D/ST carries no usage model, said so", () => {
    const all = rostered();
    expect(byTeam.size).toBe(10);
    expect(all.length).toBeGreaterThanOrEqual(140);
    for (const p of all) expect(usage.has(p.player_id), String(p.player_id)).toBe(true);
    const dst = all.filter((p) => p.position === "D/ST");
    expect(dst.length).toBeGreaterThan(0);
    for (const p of dst) {
      expect(covered(p.player_id)).toBe(false);
      expect(usage.get(p.player_id)?.data_gaps).toContain("no usage model for D/ST");
    }
  });

  it(`≥ ${String(B2_SHARE * 100)} % of the rostered players D1 models (QB/RB/WR/TE/K) have trailing summaries`, () => {
    const modelled = rostered().filter((p) => p.position !== "D/ST");
    const share = modelled.filter((p) => covered(p.player_id)).length / modelled.length;
    const all = rostered();
    const allShare = all.filter((p) => covered(p.player_id)).length / all.length;
    process.stdout.write(
      `B2 (fx-10h, seeded): modelled ${String(modelled.filter((p) => covered(p.player_id)).length)}/${String(modelled.length)} = ${(100 * share).toFixed(1)} %; all rostered ${String(all.filter((p) => covered(p.player_id)).length)}/${String(all.length)} = ${(100 * allShare).toFixed(1)} % (D/ST has no usage source)\n`,
    );
    expect(share).toBeGreaterThanOrEqual(B2_SHARE);
    // the skill positions alone hold the bound too (K is not what carries it)
    const skill = modelled.filter((p) => p.position !== "K");
    expect(skill.filter((p) => covered(p.player_id)).length / skill.length).toBeGreaterThanOrEqual(
      B2_SHARE,
    );
  });

  it("routes_proxy is present and labelled; xfp_gap is non-null wherever ffopportunity has the week", () => {
    expect(notes).toContain("routes are a snap-share proxy (04 #3)");
    expect(full.length).toBeGreaterThan(50);
    let withEp = 0;
    let withRoutes = 0;
    for (const p of full)
      for (const g of p.games ?? []) {
        // the field is on every game row; it has a value where the team's dropbacks are known (a
        // week the pbp excerpt covers) and the player's snap share is
        expect("routes_proxy" in g).toBe(true);
        if (g.routes_proxy !== null) {
          withRoutes++;
          expect(g.snaps).not.toBeNull();
        }
        if (g.xfp_ep === null || g.points_league === null) continue;
        withEp++;
        expect(g.xfp_gap, String(p.player_id)).not.toBeNull();
      }
    expect(withRoutes).toBeGreaterThan(0);
    expect(withEp).toBeGreaterThan(100);
  });
});
