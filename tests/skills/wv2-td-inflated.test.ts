// wv2-td-inflated.test.ts — waivers WV-2 on the fx-10h variant td-inflated (plan 09 §3.8 WV-2: a
// touchdown-inflated candidate, a strongly negative `xfp_gap` → flagged, not the top target; changelog
// §R11, R11-3: a PASS-if line is extended to its plan 09 requirement, never loosened; the round-4
// refix's VS-8: on the base pool no candidate carries one, so WV-2 graded the no-signal branch only).
// Through the real composition root in fixture mode under EFF_TOOLSET=full, the datasets seeded as
// the eval servers see them (--seed-datasets): the variant's dropped player is in the waiver pool, the
// usage tool gives him points well ahead of his expected points, his recent points top every
// candidate with usage, and the waivers tool does not make him its top target — so a reply that
// ranks by recent points fails WV-2 and one that follows the tool and flags him passes. RA-1's phase
// (the round-4 refix's VS-6) is read from the tool on the base fixture beside it. No network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { TD_INFLATED } from "../../scripts/fx10h/variants.js";
import { seedDatasets } from "../integration/helpers/seed.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";
import { ROOT } from "./helpers.js";

type J = Record<string, unknown>;
interface Fx {
  world: World;
  client: Client;
  close: () => Promise<void>;
}
interface Usage {
  player_id: number | null;
  name: string;
  trailing: { window_games: number; xfp_gap_sum: number | null };
  games?: { week: number; points_league: number | null; xfp_gap: number | null }[];
}
interface Candidate {
  player_id: number;
  status: string;
  s: number;
  verdict: string;
}
interface Case {
  name: string;
  files: string[];
  expected_output: string;
  expectations: string[];
}

const FX = path.join(ESPN_FIXTURES, "fx-10h");
/** The window waivers' usage branch reads (skills/waivers/SKILL.md step 4.4). */
const WINDOW = 3;
/** E5's `xfp_gap` signal fires at +2 points a game (marketConstants SIGNALS.xfpGapPerGame). */
const STRONG_PER_GAME = 2;

async function fxWorld(variant: string): Promise<Fx> {
  const dir = variant === "" ? FX : path.join(FX, variant);
  const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: dir, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
    publishEspn: false,
  });
  await seedDatasets(world.store, {
    storePath: storePath(world.cache),
    datasetDir: datasetDir(world.cache),
    cache: world.cache,
    clock: world.clock,
    season: 2026,
    fixtureDir: dir,
  });
  world.store.reopenChangedDatasets();
  const c = await connect(world, { options: { toolset: "full" } });
  return { world, client: c.client, close: c.close };
}

async function ok(fx: Fx, name: string, args: J = {}): Promise<{ data: J; warnings: string[] }> {
  const r = await call(fx.client, name, args);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body as { data: J; warnings: string[] };
}

const waiversCase = (name: string): Case => {
  const evals = (
    JSON.parse(
      readFileSync(path.join(ROOT, "skills", "waivers", "evals", "evals.json"), "utf8"),
    ) as { evals: Case[] }
  ).evals;
  const c = evals.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no case ${name}`);
  return c;
};

describe("WV-2 on td-inflated: a touchdown-inflated candidate the tool does not make its top target", () => {
  let fx: Fx;
  let waivers: J;
  const usage = new Map<number, Usage>();
  beforeAll(async () => {
    fx = await fxWorld("td-inflated");
    await ok(fx, "espn_get_league");
    waivers = (
      await ok(fx, "espn_analyze_waivers", {
        mode: "auto",
        phase: "auto",
        value_source: "auto",
      })
    ).data;
    const named = [
      ...(waivers.candidates as Candidate[]).map((c) => c.player_id),
      ...(waivers.scramble_list as number[]),
      ...(waivers.claim_list as number[]),
      ...(waivers.marginal as number[]),
      TD_INFLATED.playerId,
    ];
    const ids = [...new Set(named)];
    for (let i = 0; i < ids.length; i += 10) {
      const u = await ok(fx, "espn_get_player_usage", {
        players: { player_ids: ids.slice(i, i + 10) },
        window: WINDOW,
        detail: "full",
      });
      for (const p of u.data.players as Usage[])
        if (p.player_id !== null) usage.set(p.player_id, p);
    }
  }, 300_000);
  afterAll(async () => {
    await fx.close();
    fx.world.cleanup();
  });

  it("the player is in the week-5 waiver pool, off his team's roster", async () => {
    const roster = (await ok(fx, "espn_get_roster", { team_id: TD_INFLATED.teamId, week: 5 })).data
      .players as { player_id: number }[];
    expect(roster.some((p) => p.player_id === TD_INFLATED.playerId)).toBe(false);
    const pool = (await ok(fx, "espn_list_players", { status: "WAIVERS", position: "WR" })).data
      .players as { player_id: number }[];
    expect(pool.some((p) => p.player_id === TD_INFLATED.playerId)).toBe(true);
  });

  it("his points ran well ahead of his expected points: a strongly negative xfp_gap every game", () => {
    const u = usage.get(TD_INFLATED.playerId);
    expect(u?.trailing.window_games).toBe(WINDOW);
    expect(u?.trailing.xfp_gap_sum ?? 0).toBeLessThanOrEqual(-STRONG_PER_GAME * WINDOW);
    for (const g of u?.games ?? []) expect(g.xfp_gap ?? 0).toBeLessThan(0);
  });

  it("his recent points top every candidate with usage, so a reply ranking by them picks him", () => {
    const pts = (id: number): number =>
      (usage.get(id)?.games ?? []).reduce((a, g) => a + (g.points_league ?? 0), 0);
    const others = [...usage.keys()].filter(
      (id) => id !== TD_INFLATED.playerId && (usage.get(id)?.trailing.window_games ?? 0) > 0,
    );
    expect(others.length).toBeGreaterThan(3);
    for (const id of others) expect(pts(TD_INFLATED.playerId), String(id)).toBeGreaterThan(pts(id));
  });

  it("the waivers tool values him and still does not make him its top target", () => {
    const cands = waivers.candidates as Candidate[];
    const listed = [
      ...cands.map((c) => c.player_id),
      ...(waivers.scramble_list as number[]),
      ...(waivers.claim_list as number[]),
      ...(waivers.marginal as number[]),
    ];
    expect(listed).toContain(TD_INFLATED.playerId);
    // the detailed candidates are the best by surplus: he is not first among them
    expect(cands[0]?.player_id).not.toBe(TD_INFLATED.playerId);
    const claims = waivers.claim_list as number[];
    if (claims.length > 0) expect(claims[0]).not.toBe(TD_INFLATED.playerId);
  });

  it("WV-2 runs on td-inflated and its PASS-if line is plan 09's: flagged, not the top target", () => {
    const c = waiversCase("WV-2");
    expect(c.files).toEqual(["evals/fixtures/fx-10h/td-inflated"]);
    const line = c.expectations.find((x) => x.endsWith("(llm)") && x.includes("flag")) ?? "";
    expect(line).toMatch(/Jakobi Meyers/);
    expect(line).toMatch(/xfp_gap/);
    // changelog §R13, R13-1: one judge per condition — flagged, not the top target, a cited signal
    // with its number, none invented
    expect(c.expectations).toEqual(
      expect.arrayContaining([
        "The reply does not make Jakobi Meyers the top target on his recent points (llm)",
        "Any usage signal the reply cites carries its number (llm)",
        "The reply invents no usage signal (llm)",
      ]),
    );
    expect(c.expected_output).toMatch(/td-inflated/);
  });

  it("the no-signal branch is its own case on the base pool", () => {
    const c = waiversCase("WV-8");
    expect(c.files).toEqual(["evals/fixtures/fx-10h"]);
    expect(c.expectations.join("\n")).toMatch(/usage branch found none/);
  });
});

describe("RA-1's fixture: the phase the roster tool gives (the round-4 refix's VS-6)", () => {
  let fx: Fx;
  beforeAll(async () => {
    fx = await fxWorld("");
    await ok(fx, "espn_get_league");
  }, 300_000);
  afterAll(async () => {
    await fx.close();
    fx.world.cleanup();
  });

  it("espn_analyze_roster gives phase mid, competing yes — the values RA-1's PASS-if line names", async () => {
    const d = (await ok(fx, "espn_analyze_roster")).data;
    expect(d.phase).toBe("mid");
    expect(d.competing).toBe("yes");
    const ra1 = (
      JSON.parse(
        readFileSync(path.join(ROOT, "skills", "roster-audit", "evals", "evals.json"), "utf8"),
      ) as { evals: Case[] }
    ).evals.find((x) => x.name === "RA-1");
    expect(ra1?.expectations.join("\n")).toContain(
      `\`phase: ${String(d.phase)}\` on this fixture; the team is competing`,
    );
  });
});
