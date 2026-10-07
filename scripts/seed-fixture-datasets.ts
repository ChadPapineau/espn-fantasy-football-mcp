// seed-fixture-datasets.ts — dev tool: seeds a fixture-mode server's cache with every fixture-backed
// dataset source of `full` (plan 10 §3.2; plan 05 §3: committed fixtures through the REAL runner and
// publisher, no network) — the state an `eff refresh all` leaves — at the fixture league's own clock,
// then rebuilds the crosswalk (tests/integration/helpers/seed.ts). Used by the plugin-eval suite
// (`build-plugin-evals.mjs --seed-datasets`, plan 10 B15) so the P1 Skills' Lane 2 cases see usage,
// depth charts, news and trending; the stdio end-to-end suites seed the same way (tests/e2e).
//
// Usage: tsx scripts/seed-fixture-datasets.ts <cacheDir> [<fixtureDir>]   (default fixtures/espn/fx-10h)
// Refuses a cache directory outside the system temp directory (so it can never write the owner's
// real cache) or inside a git working tree (the server refuses a cache there). Exit 0 seeded,
// 1 a source failed, 2 usage. New here.
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backupDir, datasetDir, storePath } from "../src/config/paths.js";
import { derivedLeagueClock } from "../src/providers/espn/fixture-league.js";
import { storeFactory } from "../src/store/index.js";
import { seedDatasets } from "../tests/integration/helpers/seed.js";
import { runningClock } from "../tests/mcp/helpers/world.js";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Whether `dir` (resolved) sits inside a git working tree. */
function inGitTree(dir: string): boolean {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/** Seeds `cacheDir` from the fixture league at `fixtureDir`; returns the sources published. */
export async function seedFixtureDatasets(
  cacheDir: string,
  fixtureDir: string,
): Promise<readonly string[]> {
  // checked BEFORE anything is created, and again on the real path (no symlink escapes)
  const want = path.resolve(cacheDir);
  const temp = realpathSync(tmpdir());
  const inTemp = (p: string): boolean =>
    [path.resolve(tmpdir()), temp].some((t) => p.startsWith(`${t}${path.sep}`));
  if (!inTemp(want))
    throw new Error("the cache directory must be inside the system temp directory");
  mkdirSync(want, { recursive: true, mode: 0o700 });
  const cache = realpathSync(want);
  if (!cache.startsWith(`${temp}${path.sep}`))
    throw new Error("the cache directory must be inside the system temp directory");
  if (inGitTree(cache))
    throw new Error("the cache directory must not be inside a git working tree");
  const at = derivedLeagueClock(fixtureDir);
  if (at === null) throw new Error("the fixture directory has no derived-league clock");
  const clock = runningClock(at);
  const t = {
    storePath: storePath(cache),
    datasetDir: datasetDir(cache),
    cache,
    clock,
    season: 2026,
  };
  const store = storeFactory.open({
    path: t.storePath,
    datasetDir: t.datasetDir,
    backupDir: backupDir(cache),
    clock,
    migrate: true,
  });
  try {
    const r = await seedDatasets(store, t);
    const failed = r.results.filter((x) => x.status !== "published" && x.status !== "unchanged");
    if (failed.length > 0)
      throw new Error(`not published: ${failed.map((x) => `${x.source} ${x.status}`).join(", ")}`);
    return r.results.map((x) => x.source);
  } finally {
    store.close();
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  const [cacheDir, fixtureDir] = process.argv.slice(2);
  if (cacheDir === undefined || process.argv.length > 4) {
    process.stderr.write("usage: seed-fixture-datasets.ts <cacheDir> [<fixtureDir>]\n");
    process.exit(2);
  }
  try {
    const sources = await seedFixtureDatasets(
      path.resolve(cacheDir),
      path.resolve(fixtureDir ?? path.join(ROOT, "fixtures", "espn", "fx-10h")),
    );
    process.stdout.write(`seed-fixture-datasets: ${String(sources.length)} source(s) published\n`);
  } catch (e) {
    process.stderr.write(`seed-fixture-datasets: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
