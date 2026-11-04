// seed-variant-schedule.test.ts — the dataset seed publishes the served fixture league's OWN pro
// schedule (round 3's open item; tests/mcp/helpers/world.ts publishEspnDatasets `fixtureDir`,
// tests/integration/helpers/seed.ts SeedTarget.fixtureDir, scripts/seed-fixture-datasets.ts). The
// provider reads the `espn:pro_schedule` dataset before the season view (scheduleOf, finalityGames),
// and the seed published the recorded season file whatever fixture directory it was given, so on a
// dataset-seeded eval server sunday-live's 09:30 ET London game (JAX: Bhayshul Tuten, Cam Little)
// read `in` instead of final, and all-locked's Monday game likewise. Held here: the seed publishes
// the variant's manifest view plus its patch, as the real source would at the variant's clock; on a
// dataset-seeded sunday-live server Tuten and Little read final and every other player's game state
// is what the fixture transport's own schedule gives (the unseeded server); the base fixture's
// schedule is unchanged. Fixture mode, committed files only, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { storeFactory } from "../../src/store/index.js";
import { seedDatasets } from "../integration/helpers/seed.js";
import {
  ESPN_FIXTURES,
  call,
  connect,
  makeWorld,
  proScheduleBody,
  runningClock,
  type World,
} from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const TUTEN = 4882093;
const LITTLE = 4686361;
const JAX = 30;

interface Manifest {
  clock: string;
  my_team_id: number;
}
const manifestOf = (dir: string): Manifest =>
  JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;

const open: { world: World; close: () => Promise<void> }[] = [];
afterAll(async () => {
  for (const o of open) {
    await o.close();
    o.world.cleanup();
  }
});

/** A fixture-mode server on `variant`, its datasets seeded (`seeded`) or not. */
async function server(variant: string, seeded: boolean): Promise<Client> {
  const dir = variant === "" ? FX : path.join(FX, variant);
  const m = manifestOf(dir);
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: dir, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
    publishEspn: seeded,
  });
  const c = await connect(world, { options: { toolset: "full" } });
  open.push({ world, close: c.close });
  return c.client;
}

/** Every rostered player's week-5 game state, by id. */
async function states(c: Client): Promise<Map<number, string>> {
  const r = await call(c, "espn_get_roster", { week: 5 });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  const players = (r.body.data as { players: { player_id: number; game_state: string }[] }).players;
  return new Map(players.map((p) => [p.player_id, p.game_state]));
}

describe("the seed publishes the served variant's pro schedule", () => {
  it("sunday-live, dataset-seeded: Tuten and Little read final; every live and pending player is unchanged", async () => {
    const seeded = await states(await server("sunday-live", true));
    expect(seeded.get(TUTEN)).toBe("final");
    expect(seeded.get(LITTLE)).toBe("final");
    // the fixture transport's own schedule (no dataset): the same state for every player
    const served = await states(await server("sunday-live", false));
    expect(served.get(TUTEN)).toBe("final");
    expect(seeded).toEqual(served);
    // the variant still has its 13:00 ET games under way and its late games pending
    const counts = [...seeded.values()].reduce<Record<string, number>>(
      (a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }),
      {},
    );
    expect(counts.in ?? 0).toBeGreaterThan(0);
    expect(counts.pre ?? 0).toBeGreaterThan(0);
  });

  it("all-locked, dataset-seeded: every player's state is the variant's own", async () => {
    const seeded = await states(await server("all-locked", true));
    const served = await states(await server("all-locked", false));
    expect(seeded).toEqual(served);
  });

  it("the base fixture's schedule is unchanged: the derived body is the recorded one, row for row", async () => {
    const recorded = await proScheduleBody();
    expect(await proScheduleBody(FX)).toEqual(recorded);
    // and a variant's differs exactly where its patch says (the London game final)
    const live = (await proScheduleBody(path.join(FX, "sunday-live"))) as {
      settings: {
        proTeams: {
          id: number;
          proGamesByScoringPeriod: Record<string, { statsOfficial: boolean }[]>;
        }[];
      };
    };
    const base = recorded as typeof live;
    const jax = (b: typeof live) =>
      b.settings.proTeams.find((t) => t.id === JAX)?.proGamesByScoringPeriod["5"]?.[0]
        ?.statsOfficial;
    expect(jax(base)).toBe(false);
    expect(jax(live)).toBe(true);
  });

  it("seedDatasets (the eval seed's path) publishes the target's variant schedule", async () => {
    const world = await makeWorld({ publishEspn: false });
    open.push({ world, close: () => Promise.resolve() });
    const dir = path.join(FX, "sunday-live");
    const clock = runningClock(manifestOf(dir).clock);
    const t = {
      storePath: storePath(world.cache),
      datasetDir: datasetDir(world.cache),
      cache: world.cache,
      clock,
      season: 2026,
      fixtureDir: dir,
    };
    const store = storeFactory.open({
      path: t.storePath,
      datasetDir: t.datasetDir,
      backupDir: path.join(world.cache, "backup-seed"),
      clock,
      migrate: true,
    });
    try {
      await seedDatasets(store, t);
      store.reopenChangedDatasets();
      const games = store.datasets.proSchedule.games(2026, [5]).rows;
      const london = games.find((g) => g.home_pro_team_id === JAX || g.away_pro_team_id === JAX);
      expect(london?.stats_official).toBe(true);
    } finally {
      store.close();
    }
  }, 180_000);
});
