// availability-tool.test.ts — Stage C finding evidence-availability-claims-missed at the TOOL level,
// as its repro ran it: `espn_analyze_evidence` on fx-10h under EFF_TOOLSET=full, through the real
// composition root in fixture mode (no network, no cookie), for a rostered player ESPN lists OUT and
// the user's pasted claim from a beat writer — once on a cold cache (no usage: the claims read as
// no_claim / consistent) and once on a cache seeded the way `eff refresh all` fills it (usage
// present: they read as quiet_role_change / a stats-field disagreement). Every wording that says he
// plays now names ESPN's OUT (`structured_disagrees.field: injury_status`). The domain's own cases are
// in claims.test.ts, structured.test.ts and availability-claims.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../../src/config/paths.js";
import { seedDatasets } from "../../integration/helpers/seed.js";
import { envelopeViolations } from "../../mcp/helpers/walk.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../../mcp/helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const manifest = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
};

interface Fx {
  world: World;
  client: Client;
  close: () => Promise<void>;
}

async function fxWorld(seeded: boolean): Promise<Fx> {
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: manifest.my_team_id,
    clock: manifest.clock,
    publishEspn: !seeded,
  });
  if (seeded) {
    await seedDatasets(world.store, {
      storePath: storePath(world.cache),
      datasetDir: datasetDir(world.cache),
      cache: world.cache,
      clock: world.clock,
      season: 2026,
    });
    world.store.reopenChangedDatasets();
  }
  const c = await connect(world, { options: { toolset: "full" } });
  return { world, client: c.client, close: c.close };
}

interface Row {
  player_id: number;
  name: string;
  injury_status: string | null;
}

/** The first rostered player (by id) ESPN lists with `status`. */
async function rostered(fx: Fx, status: string): Promise<Row> {
  await call(fx.client, "espn_get_league");
  const r = await call(fx.client, "espn_list_players", { status: "ONTEAM", limit: 100 });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  const rows = (r.body.data as { players: Row[] }).players
    .filter((p) => p.player_id > 0 && p.injury_status === status)
    .sort((a, b) => a.player_id - b.player_id);
  const pick = rows[0];
  if (pick === undefined) throw new Error(`fx-10h: no rostered ${status} player`);
  return pick;
}

interface Evidence {
  flag: string;
  structured_disagrees: { field: string; structured_value: unknown; claim_value: unknown } | null;
}

async function evidence(fx: Fx, player: Row, text: string): Promise<Evidence> {
  const r = await call(fx.client, "espn_analyze_evidence", {
    player: { player_ids: [player.player_id] },
    claim: { text, source: "beat writer" },
  });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  // every third-party string of the answer is wrapped or listed (the A6 walk), the claim's too
  expect(envelopeViolations(r.body as never)).toEqual([]);
  return r.body.data as Evidence;
}

/** The finding's wordings (its repro sent them about the player by surname). */
const PLAYS = [
  "is active.",
  "is active for Sunday.",
  "will start Sunday.",
  "is playing Sunday.",
  "is in the lineup Sunday.",
];

describe.each([
  ["a cold cache", false],
  ["a seeded cache", true],
])("espn_analyze_evidence on fx-10h (full), %s", (_label, seeded) => {
  let fx: Fx;
  let out: Row;
  let surname: string;
  beforeAll(async () => {
    fx = await fxWorld(seeded);
    out = await rostered(fx, "OUT");
    surname = out.name.split(" ").at(-1) ?? out.name;
  }, 300_000);
  afterAll(async () => {
    await fx.close();
    fx.world.cleanup();
  });

  it.each(PLAYS)(
    "an OUT player who '%s' → availability_conflict naming ESPN's OUT",
    async (says) => {
      const d = await evidence(fx, out, `${surname} ${says}`);
      expect(d.flag).toBe("availability_conflict");
      expect(d.structured_disagrees).toEqual({
        field: "injury_status",
        structured_value: "OUT",
        claim_value: "will_play",
      });
    },
    120_000,
  );

  it("controls: the finding's own control still names OUT; a start that is not this game's names nothing", async () => {
    const control = await evidence(fx, out, `${surname} will be available Sunday.`);
    expect(control.flag).toBe("availability_conflict");
    expect(control.structured_disagrees?.field).toBe("injury_status");
    const practice = await evidence(fx, out, `${surname} will start practicing Wednesday.`);
    expect(practice.structured_disagrees?.field ?? null).not.toBe("injury_status");
  }, 120_000);
});
