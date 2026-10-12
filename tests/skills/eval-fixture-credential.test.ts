// eval-fixture-credential.test.ts — holds scripts/skills/build-plugin-evals.mjs FIXTURE_CREDENTIAL_STATES
// to the real composition root (Stage C finding eval-credential-state-variants-missing): an eval
// server is `dist/cli.js serve` in fixture mode, and fixture mode builds no CredentialAuthority
// (src/services/index.ts), so `credential.state` is `not_configured` on every fx-10h variant — even
// with a `rejected` or `stored` credential row for the league in its store, and whatever the
// variant's `harness.credential_state` says. The builder writes a case only when its variant's
// harness state is one of FIXTURE_CREDENTIAL_STATES; the day fixture mode reproduces another state,
// the first test here fails until that state is added (and its cases come back by themselves).
// Nothing here touches the network, a keychain, ~/.config or ~/.cache.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/cli/log.js";
import { backupDir, datasetDir, storePath } from "../../src/config/paths.js";
import { loadConfig } from "../../src/config/schema.js";
import { fixedClock } from "../../src/domain/clock.js";
import { buildServices } from "../../src/services/index.js";
import { storeFactory } from "../../src/store/index.js";
import type { Store } from "../../src/store/types.js";
import {
  FIXTURE_CREDENTIAL_STATES,
  FIXTURE_SEASON,
  notTestableReason,
  variantHarness,
} from "../../scripts/skills/build-plugin-evals.mjs";
import { readManifest } from "../../scripts/skills/_lib.mjs";
import { ROOT } from "./helpers.js";

const FX = path.join(ROOT, "fixtures", "espn", "fx-10h");
const variants: (string | null)[] = [null, ...readManifest(ROOT).variants];
const clock = fixedClock("2026-10-07T01:00:00.000Z");

let root: string;
let store: Store;
beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-evalcred-")));
  for (const d of ["home", "config", "cache"]) mkdirSync(path.join(root, d), { mode: 0o700 });
  const cache = path.join(root, "cache");
  store = storeFactory.open({
    path: storePath(cache),
    datasetDir: datasetDir(cache),
    backupDir: backupDir(cache),
    clock,
    migrate: true,
  });
});
afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** The status and probe of a fixture-mode server on one fx-10h variant (the eval server's env). */
async function serverOn(variant: string | null) {
  const fixtureDir = variant === null ? FX : path.join(FX, variant);
  const menv = (
    JSON.parse(readFileSync(path.join(fixtureDir, "manifest.json"), "utf8")) as {
      env?: Record<string, string | null>;
    }
  ).env;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(menv ?? {})) if (typeof v === "string") env[k] = v;
  const home = path.join(root, "home");
  const config = loadConfig({
    env: {
      ...env,
      ESPN_LEAGUE_ID: "0",
      ESPN_SEASON: FIXTURE_SEASON,
      EFF_CONFIG_DIR: path.join(root, "config"),
      EFF_CACHE_DIR: path.join(root, "cache"),
      EFF_FIXTURE_DIR: fixtureDir,
      EFF_TEST_STUBS: "1",
    },
    file: undefined,
    home,
    repoRoot: ROOT,
    nowMs: clock.nowMs(),
  });
  const wiring = buildServices({
    config,
    store,
    clock,
    logger: createLogger({ level: "error", sink: () => undefined }),
    packageRoot: ROOT,
    home,
    fetch: () => Promise.reject(new Error("no network in tests")),
    loadKeyring: () => Promise.reject(new Error("no keychain in tests")),
  });
  try {
    return {
      fixtureMode: wiring.options.fixtureMode,
      state: wiring.services.status.credential().state,
      probe: await wiring.services.auth.probe(wiring.services.league),
    };
  } finally {
    wiring.close();
  }
}

describe("FIXTURE_CREDENTIAL_STATES is what a fixture-mode server reports", () => {
  it("on every fx-10h variant, even with a rejected or stored credential row for the league", async () => {
    const seen = new Set<string>();
    for (const row of [null, "rejected", "stored"] as const) {
      if (row === null) store.repos.credentialState.clear();
      else
        store.repos.credentialState.put({
          league_id: "0",
          state: row,
          store: "file",
          stored_at: "2026-08-01T00:00:00.000Z",
          last_accepted_at: null,
          last_rejected_at: row === "rejected" ? "2026-10-06T00:00:00.000Z" : null,
          rejected_since: row === "rejected" ? "2026-10-06T00:00:00.000Z" : null,
          next_probe_at: null,
          rejected_view: null,
          board_probe_discriminates: null,
          updated_at: "2026-10-06T00:00:00.000Z",
          updated_by: "setup",
        });
      for (const v of variants) {
        const s = await serverOn(v);
        expect(s.fixtureMode, String(v)).toBe(true);
        seen.add(s.state);
        // the one probe answers "cannot tell" — never a validity claim — whatever the variant
        expect(s.probe, String(v)).toMatchObject({ accepted: null, reason: "not_configured" });
      }
    }
    expect([...seen].sort()).toEqual([...FIXTURE_CREDENTIAL_STATES].sort());
  });

  it("so exactly the variants whose harness state is another one are not testable", () => {
    const blocked = variants.filter((v) => notTestableReason(variantHarness(ROOT, v), v) !== null);
    expect(blocked.sort()).toEqual(["auth-rejected", "public-league"]);
    for (const v of variants) {
      const want = variantHarness(ROOT, v).credential_state;
      expect(
        notTestableReason(variantHarness(ROOT, v), v) === null,
        `${String(v)}: harness ${JSON.stringify(want)}`,
      ).toBe(
        want === undefined ||
          (typeof want === "string" && FIXTURE_CREDENTIAL_STATES.includes(want)),
      );
    }
  });
});
