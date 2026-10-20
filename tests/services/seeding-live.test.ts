// seeding-live.test.ts — `eff setup --seeding` while a server runs (Stage C finding
// services-seeding-read-once; plan 07 C12: `seeding.confirmed: false` on every result until onboard
// records the answer; plan 03 §2.1 `--seeding`, §3 precedence). The server is the real composition
// root (src/services/index.ts buildServices) in fixture mode on fx-10h under the full toolset, as the
// finding ran it, connected in process with the services object it built (a copy spread from it —
// what `eff serve` hands the server — is tests/services/seeding-serve.test.ts); setup is the real
// CLI (`eff setup --seeding …` through src/cli/main.ts) over the same config and cache dirs.
// The next call — espn_get_league, espn_get_status, espn_analyze_lineup, espn-ff://league — reports
// and uses the recorded reading with no restart. The reading is resolved exactly as a server started
// now would resolve it (src/config/schema.ts loadConfig — a property over config.json documents);
// a config.json start would refuse is never followed (the reading in use stays, one value-free
// warning). No network, no keychain, temp directories only.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeEspnS2, fakeGuid } from "../../scripts/ci/secret-fixtures.mjs";
import { main } from "../../src/cli/main.js";
import { configFilePath } from "../../src/config/paths.js";
import {
  ConfigError,
  SEEDING_MODES,
  loadConfig,
  type Config,
  type SeedingMode,
} from "../../src/config/schema.js";
import { createServer } from "../../src/mcp/server.js";
import { buildServices, type Wiring } from "../../src/services/index.js";
import {
  SEEDING_FIELDS,
  SEEDING_MODE_DEFAULT,
  adoptSeedingReading,
  createSeedingReader,
  seedingFieldsOf,
  seedingRecordOf,
  type SeedingReaderConfig,
  type SeedingReading,
} from "../../src/services/seeding.js";
import { makeIo } from "../cli/helpers.js";
import { ROOT, noXattrs, tempDir } from "../config/helpers.js";
import { ESPN_FIXTURES, body, makeWorld, type World } from "../mcp/helpers/world.js";

type J = Record<string, unknown>;

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const MANIFEST = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
};
/** The instant the CLI's test clock records as `seeding_confirmed_at` (tests/cli/helpers.ts NOW). */
const CONFIRMED_AT = "2026-10-06T18:00:00.000Z";

/** A client over a server built from exactly these services (the object buildServices returned). */
async function connectTo(w: Wiring): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer(w.services, w.options);
  const client = new Client({ name: "eff-test-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function tool(client: Client, name: string, args: J = {}): Promise<J> {
  const r = await client.callTool({ name, arguments: args }, { timeout: 300_000 });
  const b = body(r);
  expect(
    (r as { isError?: boolean }).isError === true,
    `${name}: ${JSON.stringify(b).slice(0, 300)}`,
  ).toBe(false);
  return b;
}

async function resource(client: Client, uri: string): Promise<J> {
  const raw = (await client.readResource({ uri })) as unknown as { contents: { text: string }[] };
  return JSON.parse(raw.contents[0]?.text ?? "{}") as J;
}

/**
 * What every surface says about the reading, after one call each: espn_get_league, espn_get_status
 * and espn-ff://league, and — with `lineup` — espn_analyze_lineup (E2, the costly one, only where
 * the objective is the point).
 */
async function readings(client: Client, opts: { readonly lineup: boolean }): Promise<J> {
  const league = await tool(client, "espn_get_league", { include: ["seeding"] });
  const status = await tool(client, "espn_get_status");
  const identity = await resource(client, "espn-ff://league");
  const out: J = {
    league: (league.data as { seeding: J }).seeding,
    league_warned: (league.warnings as string[]).some((x) =>
      x.startsWith("seeding reading not confirmed"),
    ),
    status: (status.data as { league: J }).league,
    identity: identity.data,
  };
  if (!opts.lineup) return out;
  const ld = (await tool(client, "espn_analyze_lineup", {})).data as J;
  return {
    ...out,
    lineup: {
      seeding: ld.seeding,
      seeding_mode_used: ld.seeding_mode_used,
      objective_used: ld.objective_used,
      objective_reason: ld.objective_reason,
    },
  };
}

/** What `readings` must say for `mode`, confirmed or not. */
function expected(mode: SeedingMode, isConfirmed: boolean, opts: { readonly lineup: boolean }): J {
  const out: J = {
    league: {
      rule: expect.any(String) as unknown,
      mode_configured: mode,
      confirmed: isConfirmed,
      mode_in_use: mode,
      evidence: null,
    },
    league_warned: !isConfirmed,
    status: expect.objectContaining({
      seeding_mode_configured: mode,
      seeding_confirmed: isConfirmed,
    }) as unknown,
    identity: expect.objectContaining({
      seeding_mode_configured: mode,
      seeding_confirmed: isConfirmed,
    }) as unknown,
  };
  if (!opts.lineup) return out;
  return {
    ...out,
    lineup: expect.objectContaining({
      seeding: { mode_used: mode, confirmed: isConfirmed },
      seeding_mode_used: mode,
    }) as unknown,
  };
}

const WITH_E2 = { lineup: true } as const;
const NO_E2 = { lineup: false } as const;
/** A composition-root test's own limit (tool calls under coverage; the unit default detects hangs). */
const ROOT_TEST_MS = 180_000;

describe("`eff setup --seeding` while the server runs (the finding's repro, through the composition root)", () => {
  let world: World;
  let wiring: Wiring;
  let client: Client;
  let close: () => Promise<void>;
  /** `eff setup --seeding <mode>` in another terminal: the real CLI over the server's dirs. */
  const setupSeeding = async (
    mode: SeedingMode,
    env: J = {},
  ): Promise<{ code: number; out: string }> => {
    const io = makeIo(
      {
        dir: world.root,
        home: path.join(world.root, "home"),
        configDir: world.config.configDir,
        cacheDir: world.cache,
        cleanup: () => undefined,
      },
      { env: { ESPN_LEAGUE_ID: "0", ...(env as Record<string, string>) } },
    );
    const code = await main(["setup", "--seeding", mode], io);
    return { code, out: io.out.text };
  };

  beforeAll(async () => {
    world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: MANIFEST.my_team_id,
      clock: MANIFEST.clock,
      publishEspn: false,
    });
    expect(world.config.origins.EFF_SEEDING_MODE).toBe("default");
    wiring = buildServices({
      config: world.config,
      store: world.store,
      clock: world.clock,
      logger: world.logger,
      packageRoot: ROOT,
      home: path.join(world.root, "home"),
    });
    expect(wiring.options.fixtureMode).toBe(true);
    ({ client, close } = await connectTo(wiring));
  }, 120_000);
  afterAll(async () => {
    await close();
    wiring.close();
    world.cleanup();
  });

  it(
    "before: ESPN's rule, unconfirmed, on every surface",
    async () => {
      expect(await readings(client, WITH_E2)).toEqual(expected("espn_rule", false, WITH_E2));
    },
    ROOT_TEST_MS,
  );

  it(
    "`eff setup --seeding points_only`: the next calls report it confirmed and E2 optimises under it",
    async () => {
      const before = world.logLines.length;
      const r = await setupSeeding("points_only");
      expect(r.code).toBe(0);
      expect(r.out).toContain("Seeding reading recorded: points_only (confirmed now)");
      const got = await readings(client, WITH_E2);
      expect(got).toEqual(expected("points_only", true, WITH_E2));
      expect(got.lineup).toMatchObject({
        objective_used: "points_only",
        objective_reason: expect.stringMatching(/^auto: the points_only reading/) as unknown,
      });
      const changed = world.logLines
        .slice(before)
        .filter((l) => l.includes('"event":"seeding.reading_changed"'));
      expect(changed).toHaveLength(1);
      expect(changed[0]).toContain('"mode":"points_only"');
      expect(changed[0]).toContain('"confirmed":true');
    },
    ROOT_TEST_MS,
  );

  it(
    "`eff setup --seeding espn_rule` again: the next call follows it back",
    async () => {
      expect((await setupSeeding("espn_rule")).code).toBe(0);
      const got = await readings(client, WITH_E2);
      expect(got).toEqual(expected("espn_rule", true, WITH_E2));
      expect(got.lineup).toMatchObject({
        objective_reason: expect.stringMatching(/^auto: espn_rule/) as unknown,
      });
    },
    ROOT_TEST_MS,
  );

  it(
    "a config.json start would refuse is never followed: the reading in use stays, one warning per reason",
    async () => {
      expect((await setupSeeding("points_only")).code).toBe(0);
      expect(await readings(client, NO_E2)).toEqual(expected("points_only", true, NO_E2));
      const file = configFilePath(world.config.configDir);
      const good = readFileSync(file, "utf8");
      const before = world.logLines.length;
      try {
        // half-written (not JSON), then a value that is not one of the modes, then a credential-shaped
        // value: each is refused by startup, so each keeps points_only (confirmed)
        writeFileSync(file, '{ "EFF_SEEDING_MODE": "espn_ru', { mode: 0o600 });
        expect(await readings(client, NO_E2)).toEqual(expected("points_only", true, NO_E2));
        const doc = JSON.parse(good) as J;
        writeFileSync(file, JSON.stringify({ ...doc, EFF_SEEDING_MODE: "coin_flip" }), {
          mode: 0o600,
        });
        expect(await readings(client, NO_E2)).toEqual(expected("points_only", true, NO_E2));
        const shaped = fakeEspnS2("seeding-live", 220);
        writeFileSync(
          file,
          JSON.stringify({ ...doc, EFF_SEEDING_MODE: "espn_rule", note: shaped }),
          {
            mode: 0o600,
          },
        );
        expect(await readings(client, NO_E2)).toEqual(expected("points_only", true, NO_E2));
        const lines = world.logLines.slice(before);
        const refused = lines.filter((l) => l.includes('"event":"seeding.record_refused"'));
        expect(refused).toHaveLength(3); // one per run of the same reason, never one per call
        expect(refused[0]).toContain('"reason":"unreadable"');
        expect(refused[1]).toContain('"reason":"mode_invalid"');
        expect(refused[2]).toContain('"reason":"credential_shaped"');
        expect(lines.join("\n")).not.toContain(shaped);
        expect(lines.join("\n")).not.toContain("coin_flip");
      } finally {
        writeFileSync(file, good, { mode: 0o600 });
      }
      // repaired: followed again (no change, so no new line), and a later setup is followed
      expect(await readings(client, NO_E2)).toEqual(expected("points_only", true, NO_E2));
      expect((await setupSeeding("espn_rule")).code).toBe(0);
      expect(await readings(client, NO_E2)).toEqual(expected("espn_rule", true, NO_E2));
    },
    ROOT_TEST_MS,
  );

  it("the services can carry the serve CLI's in-flight accounting (the server may take them as built)", () => {
    const inflight = { enter: vi.fn(), exit: vi.fn() };
    const w = buildServices({
      config: world.config,
      store: world.store,
      clock: world.clock,
      logger: world.logger,
      packageRoot: ROOT,
      home: path.join(world.root, "home"),
      inflight,
    });
    try {
      expect(w.services.inflight).toBe(inflight);
      expect(wiring.services.inflight).toBeUndefined();
    } finally {
      w.close();
    }
  });
});

describe("env > config.json: a server whose environment sets EFF_SEEDING_MODE", () => {
  it(
    "keeps the environment's mode (as a restart would) and takes the recorded confirmation",
    async () => {
      const world = await makeWorld({
        env: { EFF_FIXTURE_DIR: FX, EFF_SEEDING_MODE: "espn_rule" },
        teamId: MANIFEST.my_team_id,
        clock: MANIFEST.clock,
        publishEspn: false,
      });
      const wiring = buildServices({
        config: world.config,
        store: world.store,
        clock: world.clock,
        logger: world.logger,
        packageRoot: ROOT,
        home: path.join(world.root, "home"),
      });
      const c = await connectTo(wiring);
      try {
        expect(world.config.origins.EFF_SEEDING_MODE).toBe("env");
        const io = makeIo(
          {
            dir: world.root,
            home: path.join(world.root, "home"),
            configDir: world.config.configDir,
            cacheDir: world.cache,
            cleanup: () => undefined,
          },
          { env: { ESPN_LEAGUE_ID: "0", EFF_SEEDING_MODE: "espn_rule" } },
        );
        expect(await main(["setup", "--seeding", "points_only"], io)).toBe(0);
        expect(io.out.text).toContain("also set in the environment");
        const st = await tool(c.client, "espn_get_status");
        expect((st.data as { league: J }).league).toMatchObject({
          seeding_mode_configured: "espn_rule",
          seeding_confirmed: true,
        });
        // exactly what a server started now resolves
        const restarted = loadConfig({
          env: {
            ESPN_LEAGUE_ID: "0",
            ESPN_SEASON: "2026",
            EFF_CONFIG_DIR: world.config.configDir,
            EFF_CACHE_DIR: world.cache,
            EFF_SEEDING_MODE: "espn_rule",
          },
          file: JSON.parse(readFileSync(configFilePath(world.config.configDir), "utf8")) as unknown,
          home: path.join(world.root, "home"),
          repoRoot: ROOT,
          nowMs: world.clock.nowMs(),
          xattr: noXattrs,
        });
        expect(restarted.seedingMode).toBe("espn_rule");
        expect(restarted.seedingConfirmedAt).toBe(CONFIRMED_AT);
        expect(wiring.services.seedingConfirmedAt).toBe(CONFIRMED_AT);
      } finally {
        await c.close();
        wiring.close();
        world.cleanup();
      }
    },
    ROOT_TEST_MS,
  );
});

// --- the reading a server started now would resolve (pure) ---------------------------------------

const AT = "2026-10-06T18:00:00.000Z";

describe("seedingRecordOf: loadConfig's rules for the two keys", () => {
  it("absent config.json: the environment's mode or the default, unconfirmed", () => {
    expect(seedingRecordOf(undefined, null)).toEqual({
      ok: true,
      reading: { mode: SEEDING_MODE_DEFAULT, confirmedAt: null },
    });
    expect(seedingRecordOf(undefined, "points_only")).toEqual({
      ok: true,
      reading: { mode: "points_only", confirmedAt: null },
    });
  });

  it("the setup record; trimmed values; blank values are absent", () => {
    expect(
      seedingRecordOf({ EFF_SEEDING_MODE: "points_only", seeding_confirmed_at: AT }, null),
    ).toEqual({
      ok: true,
      reading: { mode: "points_only", confirmedAt: AT },
    });
    expect(
      seedingRecordOf(
        { EFF_SEEDING_MODE: " points_only\n", seeding_confirmed_at: ` ${AT} ` },
        null,
      ),
    ).toEqual({
      ok: true,
      reading: { mode: "points_only", confirmedAt: AT },
    });
    expect(seedingRecordOf({ EFF_SEEDING_MODE: "  ", seeding_confirmed_at: "" }, null)).toEqual({
      ok: true,
      reading: { mode: SEEDING_MODE_DEFAULT, confirmedAt: null },
    });
  });

  it("refusals: not an object, the credential rule, malformed values (even under an env mode)", () => {
    for (const f of [null, [], "x", 3, true])
      expect(seedingRecordOf(f, null)).toEqual({ ok: false, reason: "not_object" });
    expect(seedingRecordOf({ note: fakeEspnS2("seeding-unit", 220) }, null)).toEqual({
      ok: false,
      reason: "credential_shaped",
    });
    expect(seedingRecordOf({ owner: `{${fakeGuid("seeding-unit")}}` }, null)).toEqual({
      ok: false,
      reason: "credential_shaped",
    });
    expect(seedingRecordOf({ espn_s2: "x" }, null)).toEqual({
      ok: false,
      reason: "credential_shaped",
    });
    for (const v of [3, null, false, { a: 1 }, "x".repeat(4097)]) {
      expect(seedingRecordOf({ EFF_SEEDING_MODE: v }, null)).toEqual({
        ok: false,
        reason: "mode_invalid",
      });
      expect(seedingRecordOf({ EFF_SEEDING_MODE: v }, "espn_rule")).toEqual({
        ok: false,
        reason: "mode_invalid",
      });
      expect(seedingRecordOf({ seeding_confirmed_at: v }, null)).toEqual({
        ok: false,
        reason: "confirmed_at_invalid",
      });
    }
    expect(seedingRecordOf({ EFF_SEEDING_MODE: "coin_flip" }, null)).toEqual({
      ok: false,
      reason: "mode_invalid",
    });
    expect(seedingRecordOf({ seeding_confirmed_at: "2026-02-30T00:00:00Z" }, null)).toEqual({
      ok: false,
      reason: "confirmed_at_invalid",
    });
  });

  it("an env mode wins over a well-formed file mode, even one that is not a mode (start ignores it)", () => {
    expect(
      seedingRecordOf({ EFF_SEEDING_MODE: "coin_flip", seeding_confirmed_at: AT }, "espn_rule"),
    ).toEqual({
      ok: true,
      reading: { mode: "espn_rule", confirmedAt: AT },
    });
  });
});

/** One config.json value a document may hold for a seeding key. */
const seedingValue = (kind: "mode" | "at"): fc.Arbitrary<unknown> =>
  fc.oneof(
    kind === "mode"
      ? fc.constantFrom<unknown>(
          ...SEEDING_MODES,
          " points_only ",
          "espn_rule\n",
          "coin_flip",
          "ESPN_RULE",
        )
      : fc.constantFrom<unknown>(
          AT,
          " 2026-01-01T00:00:00+02:00 ",
          "2026-13-01T00:00:00Z",
          "yesterday",
        ),
    fc.constantFrom<unknown>(
      "",
      "   ",
      0,
      null,
      false,
      ["espn_rule"],
      { mode: "espn_rule" },
      "y".repeat(4097),
    ),
  );

/** A config.json document: the two seeding keys (or not), other valid keys, sometimes a credential. */
const configDoc: fc.Arbitrary<unknown> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc
      .record(
        {
          EFF_SEEDING_MODE: seedingValue("mode"),
          seeding_confirmed_at: seedingValue("at"),
          EFF_TOOLSET: fc.constantFrom("core", "full"),
          notes_v2: fc.string({ maxLength: 12 }),
          leaked: fc.constantFrom(fakeEspnS2("seeding-prop", 220), `{${fakeGuid("seeding-prop")}}`),
        },
        { requiredKeys: [] },
      )
      .map((d) => d as unknown),
  },
  { weight: 1, arbitrary: fc.constantFrom<unknown>(undefined, null, [], "{}", 7) },
);

describe("property: the reading equals what a server started now would resolve", () => {
  it("seedingRecordOf ⇔ loadConfig on the same env and config.json (accepted → the same reading; refused → refused)", () => {
    const t = tempDir("eff-seeding-prop-");
    try {
      const home = path.join(t.dir, "home");
      fc.assert(
        fc.property(
          configDoc,
          fc.constantFrom<SeedingMode | null>(null, ...SEEDING_MODES),
          (file, envMode) => {
            let started: Config | null = null;
            try {
              started = loadConfig({
                env: {
                  ESPN_LEAGUE_ID: "0",
                  EFF_CONFIG_DIR: path.join(t.dir, "config"),
                  EFF_CACHE_DIR: path.join(t.dir, "cache"),
                  ...(envMode === null ? {} : { EFF_SEEDING_MODE: envMode }),
                },
                file,
                home,
                repoRoot: ROOT,
                nowMs: Date.parse(AT),
                xattr: noXattrs,
              });
            } catch (e) {
              if (!(e instanceof ConfigError)) throw e;
            }
            const rec = seedingRecordOf(file, envMode);
            if (started === null) expect(rec.ok).toBe(false);
            else
              expect(rec).toEqual({
                ok: true,
                reading: { mode: started.seedingMode, confirmedAt: started.seedingConfirmedAt },
              });
          },
        ),
        { numRuns: 400 },
      );
    } finally {
      t.cleanup();
    }
  });
});

describe("createSeedingReader", () => {
  const base: SeedingReaderConfig = {
    configDir: "/nonexistent-config-dir",
    seedingMode: "espn_rule",
    seedingConfirmedAt: null,
    origins: { EFF_SEEDING_MODE: "default" } as SeedingReaderConfig["origins"],
  };
  const logger = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() });

  it("starts on the start reading, adopts a changed record once, follows a removed config.json", () => {
    let file: unknown = undefined;
    const log = logger();
    const r = createSeedingReader(base, log, () => file);
    expect(r.current()).toEqual({ mode: "espn_rule", confirmedAt: null });
    r.refresh();
    expect(log.info).not.toHaveBeenCalled();
    file = { EFF_SEEDING_MODE: "points_only", seeding_confirmed_at: AT };
    r.refresh();
    r.refresh();
    expect(r.current()).toEqual({ mode: "points_only", confirmedAt: AT });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("seeding.reading_changed", {
      mode: "points_only",
      confirmed: true,
    });
    file = undefined; // config.json removed: a server started now runs on the default, unconfirmed
    r.refresh();
    expect(r.current()).toEqual({ mode: "espn_rule", confirmedAt: null });
  });

  it("a read that throws or a refused record keeps the reading; one warning per run of a reason", () => {
    let next: () => unknown = () => ({ EFF_SEEDING_MODE: "points_only", seeding_confirmed_at: AT });
    const log = logger();
    const r = createSeedingReader(base, log, () => next());
    r.refresh();
    next = () => {
      throw new Error("EACCES /secret/path/config.json");
    };
    r.refresh();
    r.refresh();
    next = () => ({ EFF_SEEDING_MODE: 1 });
    r.refresh();
    expect(r.current()).toEqual({ mode: "points_only", confirmedAt: AT });
    expect(log.warn.mock.calls).toEqual([
      ["seeding.record_refused", { reason: "unreadable", mode_kept: "points_only" }],
      ["seeding.record_refused", { reason: "mode_invalid", mode_kept: "points_only" }],
    ]);
    next = () => ({ EFF_SEEDING_MODE: "points_only", seeding_confirmed_at: AT });
    r.refresh();
    next = () => {
      throw new Error("again");
    };
    r.refresh();
    expect(log.warn).toHaveBeenCalledTimes(3); // a good read ends the run: the next refusal warns
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("/secret/path");
  });

  it("the environment's mode stays; no config dir never reads; a throwing sink never escapes", () => {
    const read = vi.fn((): unknown => ({
      EFF_SEEDING_MODE: "points_only",
      seeding_confirmed_at: AT,
    }));
    const env = createSeedingReader(
      {
        ...base,
        seedingMode: "espn_rule",
        origins: { EFF_SEEDING_MODE: "env" } as SeedingReaderConfig["origins"],
      },
      logger(),
      read,
    );
    env.refresh();
    expect(env.current()).toEqual({ mode: "espn_rule", confirmedAt: AT });
    const none = createSeedingReader({ ...base, configDir: "" }, logger(), read);
    read.mockClear();
    none.refresh();
    expect(read).not.toHaveBeenCalled();
    const throwing = {
      ...logger(),
      info: vi.fn(() => {
        throw new Error("sink");
      }),
    };
    const r = createSeedingReader(base, throwing, read);
    expect(() => {
      r.refresh();
    }).not.toThrow();
    expect(r.current()).toEqual({ mode: "points_only", confirmedAt: AT });
  });
});

describe("adoptSeedingReading: the services a call reads take the reading in use", () => {
  const R: SeedingReading = { mode: "points_only", confirmedAt: AT };
  const stale = (): { seedingMode: string; seedingConfirmedAt: string | null; other: number } => ({
    seedingMode: "espn_rule",
    seedingConfirmedAt: null,
    other: 1,
  });

  it("a copy's plain fields are set, nothing else is touched", () => {
    const t = stale();
    expect(adoptSeedingReading(t, R)).toBe(true);
    expect(t).toEqual({ seedingMode: "points_only", seedingConfirmedAt: AT, other: 1 });
    expect(seedingFieldsOf(R)).toEqual({ seedingMode: "points_only", seedingConfirmedAt: AT });
    expect(SEEDING_FIELDS).toEqual(["seedingMode", "seedingConfirmedAt"]);
    expect(Object.isFrozen(SEEDING_FIELDS)).toBe(true);
  });

  it("fields that already read it are never written: the built object's accessors, read-through objects", () => {
    const writes: string[] = [];
    const live = new Proxy(
      { seedingMode: "points_only", seedingConfirmedAt: AT },
      {
        set: (o, k, v) => {
          writes.push(String(k));
          return Reflect.set(o, k, v);
        },
      },
    );
    expect(adoptSeedingReading(live, R)).toBe(true);
    expect(writes).toEqual([]);
    // the composition root's shape: getters over the reader, no setter
    let reading: SeedingReading = R;
    const built = {
      get seedingMode(): string {
        return reading.mode;
      },
      get seedingConfirmedAt(): string | null {
        return reading.confirmedAt;
      },
    };
    expect(adoptSeedingReading(built, R)).toBe(true);
    const over = Object.create(built) as object;
    reading = { mode: "espn_rule", confirmedAt: null };
    expect(adoptSeedingReading(over, reading)).toBe(true);
    expect(Object.hasOwn(over, "seedingMode")).toBe(false);
    expect(Object.hasOwn(over, "seedingConfirmedAt")).toBe(false);
  });

  it("a target that cannot take them is left as it is: false, never a throw", () => {
    const frozen = Object.freeze(stale());
    expect(adoptSeedingReading(frozen, R)).toBe(false);
    expect(frozen).toEqual(stale());
    // a getter of its own that reads something else: the field it can take, it takes
    const own = {
      get seedingMode(): string {
        return "espn_rule";
      },
      seedingConfirmedAt: null as string | null,
    };
    expect(adoptSeedingReading(own, R)).toBe(false);
    expect(own.seedingMode).toBe("espn_rule");
    expect(own.seedingConfirmedAt).toBe(AT);
    const part = stale();
    Object.defineProperty(part, "seedingConfirmedAt", { value: null, writable: false });
    expect(adoptSeedingReading(part, R)).toBe(false);
    expect(part.seedingMode).toBe("points_only");
    expect(part.seedingConfirmedAt).toBeNull();
    expect(adoptSeedingReading(Object.preventExtensions({}), R)).toBe(false);
  });

  it("only a throwing getter, setter or trap of the target's own throws (the composition root catches it)", () => {
    const t = {
      get seedingMode(): string {
        throw new Error("getter");
      },
    };
    expect(() => adoptSeedingReading(t, R)).toThrow("getter");
  });
});
