// health-cover-fixture.test.ts — changelog §R10, R10-30 at the TOOL level on base--full with the
// datasets published as the eval servers' `--seed-datasets` publishes them (the usage moves come
// from the trailing rows): a usage move with no claim stays `quiet_role_change` — Team 02's OUT bench
// RB and its IR WR, whose texts claim nothing — and NC-3's player (the WR3 by orient's positional
// rule) still reads `no_claim`; the user's pasted health claim covers the OUT and IR players' usage
// drop (`consistent`, nothing to disagree with), while against ESPN's ACTIVE it is still R4VS-6's
// `availability_conflict`. The production stdio entry in fixture mode; no network, no cookie.
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../../src/config/paths.js";
import { seedDatasets } from "../../integration/helpers/seed.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../../mcp/helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
/** NC-3's player: Team 02's highest-projected bench WR (Devaughn Vele). */
const WR3 = 4569559;
/** Team 02's OUT bench RB and its IR WR (ESPN's designations OUT and INJURY_RESERVE). */
const OUT_RB = 4697815;
const IR_WR = 4360078;
/** A starter ESPN lists ACTIVE whose usage moved (Jaxon Smith-Njigba). */
const ACTIVE_WR = 4430878;
const HEALTH = "He has a hamstring injury.";

describe("R10-30 on base--full (seeded)", () => {
  let world: World;
  let client: Client;
  let close: () => Promise<void>;
  beforeAll(async () => {
    world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: 2,
      clock: "2026-10-07T01:00:00.000Z",
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
    ({ client, close } = await connect(world, { modern: true, options: { toolset: "full" } }));
  }, 300_000);
  afterAll(async () => {
    await close();
    world.cleanup();
  });

  const flagOf = async (id: number, claim?: string): Promise<Record<string, unknown>> => {
    const r = await call(client, "espn_analyze_evidence", {
      player: { player_ids: [id] },
      ...(claim === undefined ? {} : { claim: { text: claim } }),
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    return r.body.data as Record<string, unknown>;
  };

  it("the designations are the fixture's", async () => {
    const roster = await call(client, "espn_get_roster", { week: 5 });
    const by = new Map(
      (
        roster.body.data as { players: { player_id: number; injury_status: string | null }[] }
      ).players.map((p) => [p.player_id, p.injury_status]),
    );
    expect(by.get(OUT_RB)).toBe("OUT");
    expect(by.get(IR_WR)).toBe("INJURY_RESERVE");
    expect(by.get(ACTIVE_WR) ?? "ACTIVE").toBe("ACTIVE");
  }, 60_000);

  it("a usage move with no claim stays quiet_role_change; NC-3's WR3 reads no_claim", async () => {
    for (const id of [OUT_RB, IR_WR, ACTIVE_WR])
      expect((await flagOf(id)).flag, String(id)).toBe("quiet_role_change");
    expect((await flagOf(WR3)).flag).toBe("no_claim");
  }, 120_000);

  it("a pasted health claim covers the hurt players' usage drop; against ACTIVE it conflicts", async () => {
    for (const id of [OUT_RB, IR_WR]) {
      const d = await flagOf(id, HEALTH);
      expect(d.flag, String(id)).toBe("consistent");
      expect(d.structured_disagrees).toBeNull();
    }
    const active = await flagOf(ACTIVE_WR, HEALTH);
    expect(active.flag).toBe("availability_conflict");
    expect(active.structured_disagrees).toEqual({
      field: "injury_status",
      structured_value: "ACTIVE",
      claim_value: "injury_reported",
    });
  }, 120_000);
});
