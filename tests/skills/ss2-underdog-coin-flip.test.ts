// ss2-underdog-coin-flip.test.ts — start-sit SS-2 on fx-10h's underdog-9 (changelog §R13, R13-1;
// §R11, R11-3: a PASS-if line made exact for its fixture, never loosened). R13-1's split gave SS-2 a
// judge of its own for "reports a coin flip plainly when coin_flip is true"; on underdog-9 the lineup
// tool flags no coin flip, so that antecedent never holds and the judge measured nothing (the R13
// refix verifier's F4). The judge now reads it exactly: the reply calls nothing a coin flip, since the
// tool flags none on this fixture. This file holds the fixture fact the judge rests on, through the
// real composition root in fixture mode under the case's core toolset, the datasets seeded as the eval
// servers see them (--seed-datasets): espn_analyze_lineup answers no swap by default, and no swap any
// RB-eligible compare pair can ask for — a bench player for an RB or FLEX starter, or two starters
// exchanged — carries coin_flip true. No network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { seedDatasets } from "../integration/helpers/seed.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";
import { ROOT } from "./helpers.js";

interface Row {
  player_id: number;
  position: string;
  slot: string;
  slot_class: string;
  eligible_slots: string[];
}
interface Swap {
  out: number | null;
  in: number;
  coin_flip: boolean;
}
interface Lineup {
  mode: string;
  swaps: Swap[];
  no_move?: boolean;
}
interface Case {
  name: string;
  files: string[];
  expected_output: string;
  expectations: string[];
}

const DIR = path.join(ESPN_FIXTURES, "fx-10h", "underdog-9");
const m = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
};
const ss2 = (
  JSON.parse(readFileSync(path.join(ROOT, "skills/start-sit/evals/evals.json"), "utf8")) as {
    evals: Case[];
  }
).evals.find((c) => c.name === "SS-2");

let world: World;
let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: DIR, EFF_TOOLSET: "core" },
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
    fixtureDir: DIR,
  });
  world.store.reopenChangedDatasets();
  ({ client, close } = await connect(world, { options: { toolset: "core" } }));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

async function lineup(args: Record<string, unknown>): Promise<Lineup> {
  const r = await call(client, "espn_analyze_lineup", { week: 5, ...args });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  return r.body.data as Lineup;
}

describe("SS-2 on underdog-9: the tool flags no coin flip, so the reply calls nothing one", () => {
  it("runs on underdog-9 under core, and its coin-flip judge is exact for the fixture", () => {
    expect(ss2?.files).toEqual(["evals/fixtures/fx-10h/underdog-9"]);
    const llm = (ss2?.expectations ?? []).filter((x) => x.endsWith("(llm)"));
    expect(llm).toContain(
      "The reply calls nothing a coin flip: the tool flags none on this fixture (llm)",
    );
    // the conditional form the verifier found always passing on this fixture is gone
    expect(llm.join("\n")).not.toMatch(/when coin_flip is true/);
    expect(ss2?.expected_output).toMatch(/calls nothing a coin flip that the tool does not flag/);
  });

  it("the default call answers chase and no swap", async () => {
    for (const args of [{}, { objective: "auto" }]) {
      const d = await lineup(args);
      expect(d.mode).toBe("chase");
      expect(d.swaps).toEqual([]);
    }
  });

  it("no RB-eligible compare pair the question can ask for is a coin flip", async () => {
    const r = await call(client, "espn_get_roster", { week: 5 });
    expect(r.isError).toBe(false);
    const rows = (r.body.data as { players: Row[] }).players;
    const starters = rows.filter(
      (x) => (x.slot === "RB" || x.slot === "FLEX") && x.slot_class !== "bench",
    );
    const bench = rows.filter((x) => x.slot === "BE" && x.eligible_slots.includes("RB"));
    expect(starters.length).toBeGreaterThanOrEqual(2);
    expect(bench.length).toBeGreaterThanOrEqual(1);
    const pairs = [
      ...starters.flatMap((s) => bench.map((b) => ({ out: s.player_id, in: b.player_id }))),
      ...starters.flatMap((s) =>
        starters
          .filter((t) => t.player_id !== s.player_id)
          .map((t) => ({ out: s.player_id, in: t.player_id })),
      ),
    ];
    let scored = 0;
    for (const pair of pairs) {
      const d = await lineup({ objective: "auto", compare: [pair] });
      for (const s of d.swaps) {
        scored++;
        expect(s.coin_flip, JSON.stringify({ pair, s })).toBe(false);
      }
    }
    // the bench RB-eligible players are scored for each starter's seat (a pair the tool cannot
    // evaluate is warned and never scored, R10-24)
    expect(scored).toBeGreaterThan(0);
  });
});
