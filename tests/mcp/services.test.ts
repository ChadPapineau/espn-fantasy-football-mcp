// services.test.ts — the serve composition root (src/services): texts read from the package, the
// drift manifest, the test stubs (exit 99 on a network call or keychain access — plan 05 §4.2),
// probe access over the credential store (plan 02 §2.1), the provider's TTL context and provisional
// period from the stored pro schedule, the status/auth ports, fixture mode (no credential, the spike
// nonce), and the PHASE W gate verdict. Nothing here touches the network or a real keychain.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/cli/log.js";
import { loadConfig } from "../../src/config/schema.js";
import type { CredentialStore } from "../../src/auth/types.js";
import {
  PROMPT_SKILLS,
  TEST_STUB_EXIT,
  buildServices,
  driftObservationsAt,
  loadTexts,
  periodProvisionalFrom,
  readPackageText,
  stripFrontmatter,
  stubbedFetch,
  stubbedKeyring,
  ttlContextFrom,
  withProbeAccess,
} from "../../src/services/index.js";
import type { Store } from "../../src/store/types.js";
import { ESPN_FIXTURES, ROOT, call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
beforeAll(async () => {
  world = await makeWorld();
}, 120_000);
afterAll(() => {
  world.cleanup();
});

describe("package texts", () => {
  it("strips frontmatter; reads the eight P0 Skill bodies and the cheat-sheet", () => {
    expect(stripFrontmatter("---\na: 1\n---\nbody\n")).toBe("body\n");
    expect(stripFrontmatter("no frontmatter")).toBe("no frontmatter");
    expect(stripFrontmatter("---\nnever closed")).toBe("---\nnever closed");
    expect(stripFrontmatter("---\na: 1\n---")).toBe("");
    const t = loadTexts(ROOT);
    expect(Object.keys(t.skills)).toEqual([...PROMPT_SKILLS]);
    for (const s of PROMPT_SKILLS) expect(t.skills[s]?.startsWith("---")).toBe(false);
    expect(t.tool_outputs).toContain("espn_get_roster");
    const none = loadTexts(path.join(tmpdir(), "eff-no-such-root"));
    expect(Object.values(none.skills).every((v) => v === null)).toBe(true);
    expect(none.tool_outputs).toBeNull();
    expect(readPackageText(path.join(ROOT, "nope.md"))).toBeNull();
  });

  it("the drift manifest: loaded when shipped, undefined when absent or unreadable", () => {
    const warn = vi.fn();
    const logger = { error: vi.fn(), warn, info: vi.fn(), debug: vi.fn() };
    expect(driftObservationsAt(ROOT, logger)).toBeDefined();
    expect(driftObservationsAt(path.join(tmpdir(), "eff-no-such-root"), logger)).toBeUndefined();
    const dir = mkdtempSync(path.join(tmpdir(), "eff-drift-"));
    try {
      const f = path.join(dir, "fixtures", "drift");
      mkdirSync(f, { recursive: true });
      writeFileSync(path.join(f, "manifest.json"), "{not json");
      expect(driftObservationsAt(dir, logger)).toBeUndefined();
      expect(warn).toHaveBeenCalledWith("drift.manifest_unreadable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("test stubs (EFF_TEST_STUBS — plan 05 §4.2)", () => {
  it("a network call or a keychain access exits 99 with one stderr line", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const lines: string[] = [];
    const stderr = { write: (s: string) => lines.push(s) } as unknown as NodeJS.WritableStream;
    void stubbedFetch(stderr)("https://x", {});
    void stubbedKeyring(stderr)();
    expect(exit).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(TEST_STUB_EXIT);
    exit.mockRestore();
    expect(lines.join("")).toContain("a network call was attempted");
    expect(lines.join("")).toContain("a keychain access was attempted");
  });
});

describe("probe access (plan 02 §2.1: the explicit probe reads the stored value even while rejected)", () => {
  const authority = {
    state: () => "rejected" as const,
    getCookieHeader: () => Promise.resolve({ ok: false as const, reason: "rejected" as const }),
    observe: () => Promise.resolve("rejected" as const),
    dropSecret: vi.fn(),
    holdsSecret: () => false,
  };
  const registrar = { registerSecret: vi.fn() };
  const store = (read: CredentialStore["read"]): CredentialStore =>
    ({
      kind: "file",
      read,
      readMeta: vi.fn(),
      exists: vi.fn(),
      write: vi.fn(),
      delete: vi.fn(),
    }) as unknown as CredentialStore;

  it("nothing stored → not_configured; a stored value → a header, registered for redaction", async () => {
    const none = withProbeAccess(
      authority,
      store(() => Promise.resolve(null)),
      registrar,
    );
    expect(await none.getCookieHeaderForProbe()).toEqual({ ok: false, reason: "not_configured" });
    const cookies = {
      espn_s2: `AE${"a1B2c3D4".repeat(8)}`,
      swid: "{00000000-0000-4000-8000-000000000001}",
    };
    const ok = withProbeAccess(
      authority,
      store(() =>
        Promise.resolve({
          cookies,
          meta: { storedAt: "2026-10-01T00:00:00.000Z", format_version: 1, fingerprint: "abcdef" },
        }),
      ),
      registrar,
    );
    const h = await ok.getCookieHeaderForProbe();
    expect(h.ok).toBe(true);
    expect(registrar.registerSecret).toHaveBeenCalled();
    expect(ok.state()).toBe("rejected");
    expect((await ok.getCookieHeader()).ok).toBe(false);
    expect(
      await ok.observe({
        kind: "accepted",
        at: "x",
        by: "check_auth",
        upstream_status: 200,
        view: null,
      }),
    ).toBe("rejected");
    ok.dropSecret();
    expect(authority.dropSecret).toHaveBeenCalled();
    expect(ok.holdsSecret()).toBe(false);
  });

  it("an unreadable store → unreadable (never a thrown secret)", async () => {
    const bad = withProbeAccess(
      authority,
      store(() => Promise.reject(new Error("boom"))),
      registrar,
    );
    expect(await bad.getCookieHeaderForProbe()).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("the provider's context from the stored pro schedule", () => {
  it("TTL context and the provisional period (a final week is not provisional; an unknown week is null)", () => {
    const ctx = ttlContextFrom(world.store, 2026, world.clock)();
    expect(ctx.inSeason).toBe(true);
    expect(typeof ctx.gameDay).toBe("boolean");
    expect(ctx.inGameWindow).toBe(false);
    const prov = periodProvisionalFrom(world.store);
    expect(prov(2026, 2)).toBe(false);
    expect(prov(2026, 30)).toBeNull();
    const broken = {
      datasets: {
        proSchedule: {
          games: () => {
            throw new Error("x");
          },
        },
      },
    } as unknown as Store;
    expect(ttlContextFrom(broken, 2026, world.clock)()).toEqual({
      inGameWindow: false,
      gameDay: false,
      inSeason: true,
    });
    expect(periodProvisionalFrom(broken)(2026, 1)).toBeNull();
  });
});

describe("buildServices", () => {
  it("non-fixture: a credential authority over the store row, status and auth ports, gates never hold", () => {
    const s = world.services;
    expect(world.options.fixtureMode).toBe(false);
    expect(world.options.spikeNonce).toBeUndefined();
    expect(world.options.writeGates).toEqual({ allHold: false, firstFailing: "env" });
    expect(s.auth.state()).toBe("not_configured");
    expect(s.status.credential()).toMatchObject({
      state: "not_configured",
      present: false,
      store: null,
    });
    expect(s.status.limiter(world.clock.nowMs()).requests_today).toBeGreaterThanOrEqual(0);
    expect(s.status.store().schema_version).toBeGreaterThan(0);
    expect(s.status.jobs()).toEqual([]);
    expect(s.transport().breaker_open).toBe(false);
    expect(() => s.beforeCall?.()).not.toThrow();
  });

  it("a stored credential row shows its observations (never a value) and the stale warning", async () => {
    const w = await makeWorld({ publishEspn: false });
    try {
      w.store.repos.credentialState.put({
        league_id: "0",
        state: "validated",
        store: "file",
        stored_at: "2026-08-01T00:00:00.000Z",
        last_accepted_at: "2026-10-05T00:00:00.000Z",
        last_rejected_at: null,
        rejected_since: null,
        next_probe_at: null,
        rejected_view: null,
        board_probe_discriminates: null,
        updated_at: "2026-10-05T00:00:00.000Z",
        updated_by: "setup",
      });
      const wiring = buildServices({
        config: w.config,
        store: w.store,
        clock: w.clock,
        logger: w.logger,
        packageRoot: ROOT,
        home: path.join(w.root, "home"),
        fetch: () => Promise.reject(new Error("no network in tests")),
        loadKeyring: () => Promise.reject(new Error("no keychain in tests")),
      });
      expect(wiring.services.status.credential()).toMatchObject({
        stored_at: "2026-08-01T00:00:00.000Z",
        last_accepted_at: "2026-10-05T00:00:00.000Z",
      });
      const c = await connect({ services: wiring.services, options: wiring.options });
      const st = await call(c.client, "espn_get_status");
      const cred = (st.body.data as { credential: { age_days: number; stale_warning: boolean } })
        .credential;
      expect(cred.age_days).toBeGreaterThanOrEqual(30);
      expect(cred.stale_warning).toBe(true);
      expect((st.body.warnings as string[]).some((x) => x.startsWith("credential stored"))).toBe(
        true,
      );
      expect(JSON.stringify(st.body)).not.toMatch(/espn_s2|fingerprint/);
      await c.close();
      wiring.close();
    } finally {
      w.cleanup();
    }
  });

  it("fixture mode: no credential authority, the spike nonce, the provider on the recorded fixtures", async () => {
    const home = path.join(world.root, "home");
    const config = loadConfig({
      env: {
        ESPN_LEAGUE_ID: "0",
        ESPN_SEASON: "2026",
        EFF_CONFIG_DIR: path.join(world.root, "config"),
        EFF_CACHE_DIR: world.cache,
        EFF_FIXTURE_DIR: ESPN_FIXTURES,
        EFF_TEST_STUBS: "1",
        EFF_ENABLE_WRITES: "true",
      },
      file: undefined,
      home,
      repoRoot: ROOT,
      nowMs: world.clock.nowMs(),
    });
    const logger = createLogger({ level: "error", sink: () => undefined });
    const wiring = buildServices({
      config,
      store: world.store,
      clock: world.clock,
      logger,
      packageRoot: ROOT,
      home,
    });
    expect(wiring.options.fixtureMode).toBe(true);
    expect(wiring.options.spikeNonce).toMatch(/^[0-9a-f]{12}$/);
    expect(wiring.options.writesRequested).toBe(true);
    expect(wiring.options.writeGates.allHold).toBe(false);
    expect(wiring.services.auth.state()).toBe("not_configured");
    expect(wiring.services.status.credential().store).toBeNull();
    const league = await wiring.provider.getLeague(wiring.services.league);
    expect(league.value.size).toBe(10);
    const probe = await wiring.services.auth.probe(wiring.services.league);
    expect(probe).toMatchObject({ accepted: null, reason: "not_configured" });
    wiring.close();
  });
});
