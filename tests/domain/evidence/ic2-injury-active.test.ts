// ic2-injury-active.test.ts — the round-4 R4VS-6 at the TOOL level, as round 4's verifier ran it on
// base--full: `espn_analyze_evidence` for Team 02's highest-projected starting RB (Ashton Jeanty,
// ESPN ACTIVE — "my RB1" by orient's positional rule, plan 09 IC-2) with the user's pasted claim "A
// headline says my RB1 tore his ACL in practice." Before, it answered `quiet_role_change` with no
// structured disagreement and role confirmations; it now answers `availability_conflict` with
// `structured_disagrees { field: "injury_status", structured_value: "ACTIVE", claim_value:
// "injury_reported" }` and confirmations naming ESPN's status and the official report — on a cold
// cache (no crosswalk pair joins his official report, so the tool names the pair instead) and on one
// seeded as `eff refresh all` fills it (the eval servers' `--seed-datasets`, where his usage moved). The production stdio entry (serveStdio over an in-memory transport), the real
// composition root in fixture mode on fx-10h under EFF_TOOLSET=full; no network, no cookie.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../../src/config/paths.js";
import { NO_PAIR_CONFIRM_ESPN, NO_PAIR_CONFIRM_PAIR } from "../../../src/mcp/tools/market-p1.js";
import { seedDatasets } from "../../integration/helpers/seed.js";
import { envelopeViolations } from "../../mcp/helpers/walk.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../../mcp/helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const manifest = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
};
/** IC-2's player: Team 02's highest-projected starting RB on the base fixture (R9-2's note). */
const RB1 = 4890973;
const IC2_CLAIM = "A headline says my RB1 tore his ACL in practice.";

describe.each([
  ["a cold cache", false],
  ["a seeded cache", true],
])("IC-2 on fx-10h (full), %s", (_label, seeded) => {
  let world: World;
  let client: Client;
  let close: () => Promise<void>;
  beforeAll(async () => {
    world = await makeWorld({
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
    ({ client, close } = await connect(world, { modern: true, options: { toolset: "full" } }));
  }, 300_000);
  afterAll(async () => {
    await close();
    world.cleanup();
  });

  it("the headline is an injury against ESPN's ACTIVE: availability_conflict, never quiet_role_change", async () => {
    const roster = await call(client, "espn_get_roster", { week: 5 });
    expect(roster.isError, JSON.stringify(roster.body).slice(0, 300)).toBe(false);
    const me = (
      roster.body.data as {
        players: { player_id: number; slot: string; injury_status: string | null }[];
      }
    ).players.find((p) => p.player_id === RB1);
    expect(me?.slot).toBe("RB");
    expect(me?.injury_status ?? "ACTIVE").toBe("ACTIVE");
    const r = await call(client, "espn_analyze_evidence", {
      player: { player_ids: [RB1] },
      claim: { text: IC2_CLAIM },
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    expect(envelopeViolations(r.body as never)).toEqual([]);
    const d = r.body.data as {
      flag: string;
      structured_disagrees: unknown;
      what_would_confirm: string[];
      evidence: { type: string; direction: string; source: string }[];
      rec: { action: string; no_move: boolean };
    };
    expect(d.flag).toBe("availability_conflict");
    expect(d.structured_disagrees).toEqual({
      field: "injury_status",
      structured_value: "ACTIVE",
      claim_value: "injury_reported",
    });
    // ESPN's status and the official report — on a cold cache, where no crosswalk pair joins his
    // official report, the tool names the pair that would make it readable instead
    // (market-p1.ts confirmWithoutPair), never a role confirmation
    expect(d.what_would_confirm).toEqual(
      seeded
        ? [
            "ESPN's injuryStatus for him changes from ACTIVE (an injury designation)",
            "the next official injury report lists the injury",
            "the inactives list about 90 minutes before kickoff",
          ]
        : [
            NO_PAIR_CONFIRM_ESPN,
            "ESPN's injuryStatus for him changes from ACTIVE (an injury designation)",
            "the inactives list about 90 minutes before kickoff",
            NO_PAIR_CONFIRM_PAIR,
          ],
    );
    for (const c of d.what_would_confirm) expect(c).not.toMatch(/depth chart|role holding/);
    expect(d.evidence.find((e) => e.source === "user.claim.text")).toMatchObject({
      type: "health",
      direction: "down",
    });
    // structured fields win: no move on the headline alone
    expect(d.rec.no_move).toBe(true);
    expect(d.rec.action).toBe("no move: structured fields win over text");
  }, 120_000);
});
