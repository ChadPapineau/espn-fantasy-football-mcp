// seed.ts — the fixture-mode dataset seed (plan 05 §3: committed fixtures + injected transports; no
// test ever touches the network): every dataset source of `full` that has a committed fixture is
// published through the REAL runner and publisher into a store — the ESPN pro schedule and player
// universe from the recorded season views, the nflverse Phase-1 and Phase-2 excerpts and their
// history twins, ffopportunity's expected points, Sleeper's trending lists and the three captured
// RSS feeds — exactly as `eff refresh all` would wire them (src/cli/refresh.ts DEFAULT_REGISTRY,
// defaultSeasons, newsInputs), then the crosswalk is rebuilt. The four usage files (weekly rosters,
// player stats, snap counts, expected points) carry fixtures/fx10h-usage's rows too, so every
// rostered QB/RB/WR/TE/K of the fixture league has the usage a live refresh would load (plan 10 B2). The weather job is left out (its
// venues need the coming week's outdoor games; Phase 1's own suites cover it). Used by the in-process
// integration suite, the stdio end-to-end suite (a seeded cache the built server then serves) and
// the plugin-eval seed.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  defaultSeasons,
  DEFAULT_REGISTRY,
  newsInputs,
  REFRESH_JOBS_BUILT,
} from "../../../src/cli/refresh.js";
import type { RefreshJob } from "../../../src/config/freshness.js";
import { seededRng, type FixedClock } from "../../../src/domain/clock.js";
import { CHECKED_IN_OVERRIDES } from "../../../src/domain/crosswalk/overrides.js";
import { rebuildCrosswalk } from "../../../src/domain/crosswalk/rebuild.js";
import { NEWS_FEEDS } from "../../../src/sources/news/feeds.js";
import { fsTempArea, runRefresh, type RefreshResult } from "../../../src/sources/runner.js";
import { sleeperTrendingUrl } from "../../../src/sources/sleeper/index.js";
import type { DataSource } from "../../../src/sources/source.js";
import { storeFactory } from "../../../src/store/index.js";
import type { Store } from "../../../src/store/types.js";
import { publishEspnDatasets } from "../../mcp/helpers/world.js";
import { fakeHttp, type Route } from "../../sources/nflverse/helpers/harness.js";
import { withFx10hUsage } from "../../sources/nflverse/helpers/fx10h-usage.js";
import { allFixtureRoutes } from "../../sources/nflverse/helpers/phase2-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const bytes = (rel: string): Uint8Array => new Uint8Array(readFileSync(path.join(ROOT, rel)));

/** The jobs the seed runs (every built job but the two ESPN season views and weather). */
export const SEED_JOBS: readonly RefreshJob[] = REFRESH_JOBS_BUILT.filter(
  (j) => j !== "espn:schedule" && j !== "espn:players" && j !== "weather",
);

/** Every committed fixture at the URL it stands in for (release files, Sleeper, the RSS feeds). */
export function seedRoutes(): Map<string, Route> {
  const routes = new Map<string, Route>(withFx10hUsage(allFixtureRoutes()));
  routes.set(sleeperTrendingUrl("add"), bytes("fixtures/sleeper/trending-add.json"));
  routes.set(sleeperTrendingUrl("drop"), bytes("fixtures/sleeper/trending-drop.json"));
  for (const f of Object.values(NEWS_FEEDS))
    routes.set(f.url, bytes(`fixtures/news/captured/${f.key}.xml`));
  return routes;
}

/** Where a seed publishes. */
export interface SeedTarget {
  readonly storePath: string;
  readonly datasetDir: string;
  readonly cache: string;
  readonly clock: FixedClock;
  /** The current season (the fixtures' 2026). */
  readonly season: number;
}

/** What one seed did. */
export interface SeedReport {
  readonly results: readonly RefreshResult[];
  readonly crosswalk: "done" | "skipped";
  /** Every URL the runner asked the fake transports for. */
  readonly calls: readonly string[];
}

/** Publishes every fixture-backed source into `store` (see the header). */
export async function seedDatasets(store: Store, t: SeedTarget): Promise<SeedReport> {
  await publishEspnDatasets(t);
  store.reopenChangedDatasets();
  const { http, download, calls } = fakeHttp(seedRoutes());
  const publisher = storeFactory.openPublisher({
    storePath: t.storePath,
    datasetDir: t.datasetDir,
    clock: t.clock,
  });
  const results: RefreshResult[] = [];
  const config = {
    weatherSource: "open-meteo" as const,
    news: (feed: "rotowire" | "espn" | "cbs") => newsInputs(() => store, t.cache, feed),
  };
  const run = async (source: DataSource): Promise<void> => {
    store.reopenChangedDatasets();
    results.push(
      await runRefresh(
        { source, seasons: defaultSeasons(source, t.season), week: null },
        {
          http,
          download,
          clock: t.clock,
          rng: seededRng(1),
          publisher,
          refreshLog: store.repos.refreshLog,
          proSchedule: store.datasets.proSchedule,
          nflGames: store.datasets.nflGames,
          temp: fsTempArea(path.join(t.cache, "tmp")),
          sleep: () => Promise.resolve(),
        },
      ),
    );
  };
  let crosswalk: "done" | "skipped" = "skipped";
  const rebuild = (): void => {
    store.reopenChangedDatasets();
    const r = rebuildCrosswalk({
      season: t.season,
      roster: store.rosterWeekly,
      universe: store.playerUniverse,
      nflPlayers: store.nflPlayers,
      repository: store.repos.crosswalk,
      overrides: CHECKED_IN_OVERRIDES,
      now: t.clock.nowIso(),
    });
    crosswalk = r.status === "done" ? "done" : "skipped";
  };
  try {
    for (const job of SEED_JOBS) {
      for (const source of DEFAULT_REGISTRY.byJob(job, config) ?? []) await run(source);
      // the daily job chains the crosswalk rebuild (as `eff refresh` does); the news matcher reads it
      if (job === "nflverse:daily") rebuild();
    }
  } finally {
    publisher.close();
  }
  store.reopenChangedDatasets();
  return { results, crosswalk, calls };
}
