// drift-manifest-absent.test.ts — Stage C finding pack-drift-manifest-not-shipped (plan 01 §7, D5):
// a package installed from the tarball (`npm pack`, `npm install -g`) ships no fixtures/ — package.json
// `files` and scripts/ci/scan-tarball.mjs ("fixtures never ship") keep them out — so the drift
// observations the server reads (fixtures/drift/manifest.json) are absent there, and the in-call
// detector runs its required-key and skeleton checks only: no unknown-enum, additive-key or
// meaning-changing statSourceId/statSplitTypeId check. That degradation is never silent: the
// composition root logs `drift.manifest_absent` with what is lost (value-free), as `eff probe` prints
// "manifest absent: required keys and skeletons only". A checkout (the manifest present) logs no such
// line. Nothing here touches the network or a keychain.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/cli/log.js";
import { MANIFEST_PATH } from "../../src/drift/types.js";
import {
  DRIFT_DEGRADED_DETECTION,
  buildServices,
  driftObservationsAt,
} from "../../src/services/index.js";
import { ROOT, fixtureFetchPlus, makeWorld, type World } from "./helpers/world.js";

/** A package root laid out as the tarball ships it: no fixtures/ directory at all. */
let pkg: string;
let world: World;
beforeAll(async () => {
  pkg = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-pkg-")));
  world = await makeWorld({ publishEspn: false });
}, 120_000);
afterAll(() => {
  world.cleanup();
  rmSync(pkg, { recursive: true, force: true });
});

/** Every log line a composition over `packageRoot` writes, parsed. */
function wireOn(packageRoot: string) {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = createLogger({
    level: "debug",
    sink: (l) => {
      raw.push(l);
      lines.push(JSON.parse(l) as Record<string, unknown>);
    },
  });
  const wiring = buildServices({
    config: world.config,
    store: world.store,
    clock: world.clock,
    logger,
    packageRoot,
    home: path.join(world.root, "home"),
    fetch: fixtureFetchPlus("league-a", []),
    loadKeyring: () => Promise.reject(new Error("keychain disabled in tests")),
    texts: world.options.texts,
  });
  return { wiring, lines, raw };
}

describe("a package without the drift manifest (the tarball ships no fixtures/)", () => {
  it("driftObservationsAt returns undefined AND warns drift.manifest_absent — never silently", () => {
    const warn = vi.fn();
    const logger = { error: vi.fn(), warn, info: vi.fn(), debug: vi.fn() };
    expect(driftObservationsAt(pkg, logger)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("drift.manifest_absent", {
      manifest: MANIFEST_PATH,
      detection: DRIFT_DEGRADED_DETECTION,
    });
    expect(DRIFT_DEGRADED_DETECTION).toBe("required_keys_and_skeletons_only");
  });

  it("the composition root logs the degraded detection once (value-free); the server still serves", async () => {
    const { wiring, lines, raw } = wireOn(pkg);
    try {
      const absent = lines.filter((l) => l.event === "drift.manifest_absent");
      expect(absent).toHaveLength(1);
      expect(absent[0]).toMatchObject({
        level: "warn",
        manifest: "fixtures/drift/manifest.json",
        detection: "required_keys_and_skeletons_only",
      });
      // the line names the relative manifest path only — never the package root
      expect(raw.join("\n")).not.toContain(pkg);
      // degraded, not broken: the required-key checks still run and the league answers
      const league = await wiring.provider.getLeague(wiring.services.league);
      expect(league.value.size).toBeGreaterThan(0);
    } finally {
      wiring.close();
    }
  });

  it("a checkout (the manifest present) loads its observations and logs no degradation", () => {
    const warn = vi.fn();
    const logger = { error: vi.fn(), warn, info: vi.fn(), debug: vi.fn() };
    const obs = driftObservationsAt(ROOT, logger);
    expect(obs).toBeDefined();
    expect(Object.keys(obs ?? {}).length).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
    const { wiring, lines } = wireOn(ROOT);
    wiring.close();
    expect(lines.some((l) => String(l.event).startsWith("drift.manifest_"))).toBe(false);
  });
});
