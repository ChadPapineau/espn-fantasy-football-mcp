// schema.test.ts — src/config/schema.ts (plan 03 §3: every key with its scope and default; env >
// config.json > defaults except the two recorded credential keys; no secrets in config.json; plan
// 02 S12 read-host override; EFF_ENABLE_WRITES inert; `.env.example` lists exactly the server and
// launcher keys — changelog V2). Adversarial: hostile league ids, write-host overrides, cookies and
// GUIDs smuggled into config.json, disagreeing env values, unreadable xattrs, relative paths.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEspnS2, fakeGuid, fakeLeagueId } from "../../scripts/ci/secret-fixtures.mjs";
import {
  CONFIG_FILE_ISSUES,
  CONFIG_KEYS,
  CONFIG_KEY_SPECS,
  CREDENTIAL_STATES,
  ConfigError,
  DRIFT_STATUSES,
  ESPN_READ_HOST_DEFAULT,
  ESPN_WRITE_HOST,
  EXIT_CODES,
  SETUP_RECORD_KEYS,
  UNKNOWN_FILE_KEYS_WARNING,
  configKeysByScope,
  defaultSeason,
  envExampleKeys,
  envExampleNames,
  identifierValues,
  isAllowedReadHost,
  isIsoInstant,
  isLeagueId,
  isNflTeam,
  isOneOf,
  loadConfig,
  loadConfigFromProcess,
  looksLikeCredentialValue,
  readConfigFile,
  scanConfigFileForCredentials,
  secretValues,
  type Config,
  type ConfigInput,
} from "../../src/config/schema.js";
import { PathSecurityError } from "../../src/config/paths.js";
import { ROOT, brokenXattrs, noXattrs, tempDir, xattrsOn } from "./helpers.js";

let tmp: { dir: string; cleanup: () => void };
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => {
  tmp.cleanup();
});

const NOW = Date.parse("2026-10-05T12:00:00Z");
const LEAGUE = "12345"; // a placeholder shape (fewer digits than any real league id)

function input(over: Partial<ConfigInput> = {}): ConfigInput {
  return {
    env: { ESPN_LEAGUE_ID: LEAGUE },
    file: undefined,
    home: tmp.dir,
    repoRoot: ROOT,
    nowMs: NOW,
    xattr: noXattrs,
    ...over,
  };
}

function issuesOf(fn: () => unknown): { key: string; reason: string }[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return [...e.issues];
    throw e;
  }
  return [];
}

describe("defaults and the key table", () => {
  it("resolves the documented defaults", () => {
    const c = loadConfig(input());
    expect(c).toMatchObject({
      leagueId: LEAGUE,
      probeLeagueId: null,
      season: 2026,
      teamId: null,
      credentialStore: "keychain",
      credentialFile: path.join(tmp.dir, ".config", "espn-fantasy-football-mcp", "session.json"),
      configDir: path.join(tmp.dir, ".config", "espn-fantasy-football-mcp"),
      cacheDir: path.join(tmp.dir, ".cache", "espn-fantasy-football-mcp"),
      logLevel: "info",
      toolset: "core",
      seedingMode: "espn_rule",
      seedingConfirmedAt: null,
      weatherSource: "open-meteo",
      setupPort: null,
      espnReadHost: ESPN_READ_HOST_DEFAULT,
      writesRequested: false,
      writesEnabled: false,
      writesAcknowledgement: null,
      keychainSelftest: null,
      fixtureDir: null,
      fixtureRecord: false,
      testStubs: false,
      credentialEnvConflicts: [],
      warnings: [],
    });
    expect(Object.isFrozen(c)).toBe(true);
  });
  it("records an origin for every key", () => {
    const c = loadConfig(input());
    expect(Object.keys(c.origins).sort()).toEqual([...CONFIG_KEYS].sort());
    expect(c.origins.ESPN_LEAGUE_ID).toBe("env");
    expect(c.origins.EFF_TOOLSET).toBe("default");
  });
  it("declares every key exactly once, each with a scope", () => {
    expect(CONFIG_KEY_SPECS.map((s) => s.key).sort()).toEqual([...CONFIG_KEYS].sort());
    for (const s of CONFIG_KEY_SPECS) {
      expect(["server", "launcher", "test"]).toContain(s.scope);
      if (s.secret) expect(s.fileSettable, s.key).toBe(false);
      if (s.scope !== "server") expect(s.fileSettable, s.key).toBe(false);
      expect(s.description).not.toMatch(/[0-9]{6,}/);
    }
    expect(configKeysByScope("launcher").map((s) => s.key)).toEqual(["EFF_NODE"]);
    expect(configKeysByScope("test").map((s) => s.key)).toEqual([
      "EFF_FIXTURE_DIR",
      "EFF_FIXTURE_RECORD",
      "EFF_TEST_STUBS",
    ]);
  });
  it(".env.example lists exactly the server and launcher keys (names only)", () => {
    const text = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    expect([...envExampleNames(text)].sort()).toEqual([...envExampleKeys()].sort());
    for (const s of configKeysByScope("test")) expect(text).not.toContain(s.key);
  });
  it("parses `.env.example` names, commented or not", () => {
    expect(envExampleNames("A=1\n# B=2\n#C=\n  # not a key\nlower=1\nA=3\n")).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
  it("exposes the shared vocabularies and exit codes", () => {
    expect(CREDENTIAL_STATES).toEqual(["not_configured", "stored", "validated", "rejected"]);
    expect(DRIFT_STATUSES).toEqual(["green", "additive", "red", "host_moved"]);
    expect(EXIT_CODES).toEqual({ ok: 0, error: 1, usage: 2, credentials: 3, drift: 4, forced: 5 });
    expect(isOneOf(CREDENTIAL_STATES, "stored")).toBe(true);
    expect(isOneOf(CREDENTIAL_STATES, "Stored")).toBe(false);
    expect(isOneOf(CREDENTIAL_STATES, 1)).toBe(false);
    expect(isNflTeam("WAS")).toBe(true);
    expect(isNflTeam("WSH")).toBe(false);
  });
});

describe("ESPN league identity", () => {
  it("requires ESPN_LEAGUE_ID unless lenient", () => {
    expect(issuesOf(() => loadConfig(input({ env: {} })))).toEqual([
      { key: "ESPN_LEAGUE_ID", reason: "is required (the numeric id from your ESPN league URL)" },
    ]);
    expect(loadConfig(input({ env: {} }), { requireLeagueId: false }).leagueId).toBeNull();
  });
  it.each(["0123", "-5", "12a", "1e5", " ", "1234567890123", "١٢٣", "12 34", "0x1f"])(
    "refuses league id %j without echoing it",
    (bad) => {
      const issues = issuesOf(() => loadConfig(input({ env: { ESPN_LEAGUE_ID: bad } })));
      const expected = bad.trim() === "" ? "is required" : "must be the numeric league id";
      expect(issues[0]?.reason).toContain(expected);
      if (bad.trim() !== "") expect(JSON.stringify(issues)).not.toContain(bad.trim());
    },
  );
  it("accepts 0 (the fixture league) and twelve digits", () => {
    expect(isLeagueId("0")).toBe(true);
    expect(isLeagueId("1".repeat(12))).toBe(true);
    expect(isLeagueId("1".repeat(13))).toBe(false);
  });
  it("validates the probe league id and lists both ids for redaction, deduplicated", () => {
    const probe = fakeLeagueId("probe", 8);
    const c = loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_PROBE_LEAGUE_ID: probe } }));
    expect(identifierValues(c)).toEqual([
      { kind: "league", value: LEAGUE },
      { kind: "league", value: probe },
    ]);
    expect(identifierValues({ leagueId: LEAGUE, probeLeagueId: LEAGUE })).toHaveLength(1);
    expect(identifierValues({ leagueId: null, probeLeagueId: null })).toEqual([]);
    expect(
      issuesOf(() =>
        loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_PROBE_LEAGUE_ID: "x" } })),
      ),
    ).toEqual([
      {
        key: "EFF_PROBE_LEAGUE_ID",
        reason: "must be a numeric league id (digits only, no leading zero)",
      },
    ]);
  });
  it("property: no league-id input crashes the loader or reaches an issue text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        const issues = issuesOf(() => loadConfig(input({ env: { ESPN_LEAGUE_ID: s } })));
        const t = s.trim();
        if (t.length >= 4 && !isLeagueId(t))
          expect(JSON.stringify(issues)).not.toContain(JSON.stringify(t).slice(1, -1));
      }),
      { numRuns: 300 },
    );
  });
});

describe("season, team, enums, port", () => {
  it("defaults the season by the July rollover", () => {
    expect(defaultSeason(Date.parse("2026-06-30T23:59:59Z"))).toBe(2025);
    expect(defaultSeason(Date.parse("2026-07-01T00:00:00Z"))).toBe(2026);
    expect(defaultSeason(Date.parse("2027-01-10T00:00:00Z"))).toBe(2026);
    expect(() => defaultSeason(Number.NaN)).toThrow(RangeError);
  });
  it.each([
    ["2018", 2018],
    ["2027", 2027],
  ])("accepts season %s", (raw, n) => {
    expect(loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, ESPN_SEASON: raw } })).season).toBe(n);
  });
  it.each(["2017", "2028", "20261", "abcd", "26", "2026.5"])("refuses season %j", (raw) => {
    expect(
      issuesOf(() => loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, ESPN_SEASON: raw } })))[0]
        ?.key,
    ).toBe("ESPN_SEASON");
  });
  it("bounds ESPN_TEAM_ID 1..20 and EFF_SETUP_PORT 1024..65535", () => {
    expect(loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, ESPN_TEAM_ID: "20" } })).teamId).toBe(
      20,
    );
    for (const bad of ["0", "21", "-1", "x", "1.5", "9999999"])
      expect(
        issuesOf(() => loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, ESPN_TEAM_ID: bad } })))[0]
          ?.key,
      ).toBe("ESPN_TEAM_ID");
    expect(
      loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_SETUP_PORT: "8791" } })).setupPort,
    ).toBe(8791);
    for (const bad of ["80", "65536", "port"])
      expect(
        issuesOf(() =>
          loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_SETUP_PORT: bad } })),
        )[0]?.key,
      ).toBe("EFF_SETUP_PORT");
  });
  it.each([
    ["EFF_LOG_LEVEL", "verbose"],
    ["EFF_TOOLSET", "all"],
    ["EFF_SEEDING_MODE", "both"],
    ["EFF_WEATHER_SOURCE", "off"],
    ["EFF_CREDENTIAL_STORE", "env"],
  ])("refuses %s=%s", (key, value) => {
    expect(
      issuesOf(() => loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, [key]: value } })))[0]?.key,
    ).toBe(key);
  });
  it("accepts every enum value and reports the origin", () => {
    const c = loadConfig(
      input({
        env: {
          ESPN_LEAGUE_ID: LEAGUE,
          EFF_LOG_LEVEL: "debug",
          EFF_TOOLSET: "full",
          EFF_SEEDING_MODE: "points_only",
          EFF_WEATHER_SOURCE: "nws",
        },
      }),
    );
    expect([c.logLevel, c.toolset, c.seedingMode, c.weatherSource]).toEqual([
      "debug",
      "full",
      "points_only",
      "nws",
    ]);
    expect(c.origins.EFF_TOOLSET).toBe("env");
  });
  it("refuses an over-long env value", () => {
    expect(
      issuesOf(() =>
        loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_TOOLSET: "x".repeat(5000) } })),
      ),
    ).toEqual([{ key: "EFF_TOOLSET", reason: "value is too long" }]);
  });
});

describe("the read-host override (plan 02 S12; ADV OBJ-06)", () => {
  it.each([
    "lm-api-reads.fantasy.espn.com",
    "lm-api-reads-v2.fantasy.espn.com",
    "x1.fantasy.espn.com",
  ])("accepts %s and warns", (host) => {
    const c = loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_ESPN_READ_HOST: host } }));
    expect(c.espnReadHost).toBe(host);
    if (host !== ESPN_READ_HOST_DEFAULT)
      expect(c.warnings.join(" ")).toContain("EFF_ESPN_READ_HOST");
  });
  it.each([
    ESPN_WRITE_HOST,
    "lm-api-writes2.fantasy.espn.com",
    "fantasy.espn.com",
    "www.espn.com",
    "a.b.fantasy.espn.com",
    "LM-API-READS.fantasy.espn.com",
    "lm-api-reads.fantasy.espn.com.evil.example",
    "lm-api-reads.fantasy.espn.com.",
    "-bad.fantasy.espn.com",
    "bad-.fantasy.espn.com",
    "evil.com/.fantasy.espn.com",
    "x.fantasy.espn.com:8443",
    "https://lm-api-reads.fantasy.espn.com",
  ])("refuses %s", (host) => {
    expect(isAllowedReadHost(host)).toBe(false);
    expect(
      issuesOf(() =>
        loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_ESPN_READ_HOST: host } })),
      )[0]?.key,
    ).toBe("EFF_ESPN_READ_HOST");
  });
});

describe("EFF_ENABLE_WRITES is inert (PHASE W SEAM)", () => {
  it("true is reported, warned and never honoured", () => {
    const c = loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_ENABLE_WRITES: "true" } }));
    expect(c.writesRequested).toBe(true);
    expect(c.writesEnabled).toBe(false);
    expect(c.warnings.join(" ")).toContain("inert");
  });
  it.each(["TRUE", "1", "yes", "on", "True"])("refuses %j (exactly true|false)", (v) => {
    expect(
      issuesOf(() => loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_ENABLE_WRITES: v } }))),
    ).toEqual([{ key: "EFF_ENABLE_WRITES", reason: "must be exactly true or false" }]);
  });
  it("is env-only: a config.json value is ignored with a warning", () => {
    const c = loadConfig(input({ file: { EFF_ENABLE_WRITES: "true" } }));
    expect(c.writesRequested).toBe(false);
    expect(c.warnings).toContain("EFF_ENABLE_WRITES is env-only; its config.json value is ignored");
  });
});

describe("config.json: additive, never a secret (plan 03 §3, §7)", () => {
  it("applies file-settable keys with env winning", () => {
    const c = loadConfig(
      input({
        env: { ESPN_LEAGUE_ID: LEAGUE, EFF_TOOLSET: "full" },
        file: { EFF_TOOLSET: "core", EFF_LOG_LEVEL: "warn", ESPN_TEAM_ID: "4" },
      }),
    );
    expect(c.toolset).toBe("full");
    expect(c.logLevel).toBe("warn");
    expect(c.teamId).toBe(4);
    expect(c.origins.EFF_LOG_LEVEL).toBe("file");
  });
  it("reads ESPN_LEAGUE_ID from config.json for a plugin install", () => {
    expect(
      loadConfig(input({ env: {}, file: { ESPN_LEAGUE_ID: LEAGUE } })).origins.ESPN_LEAGUE_ID,
    ).toBe("file");
  });
  it("warns on unknown keys without echoing them", () => {
    const c = loadConfig(input({ file: { surprise_key: "x", another: "y" } }));
    expect(c.warnings).toEqual([UNKNOWN_FILE_KEYS_WARNING]);
    expect(c.warnings.join(" ")).not.toContain("surprise");
  });
  it.each([[[]], ["text"], [null], [7]])("refuses a non-object config.json (%j)", (file) => {
    expect(issuesOf(() => loadConfig(input({ file })))).toEqual([
      { key: "config.json", reason: CONFIG_FILE_ISSUES.notObject },
    ]);
  });
  it("refuses a non-string or over-long value", () => {
    expect(issuesOf(() => loadConfig(input({ file: { EFF_TOOLSET: 3 } })))).toEqual([
      { key: "EFF_TOOLSET", reason: CONFIG_FILE_ISSUES.notString },
    ]);
    expect(
      issuesOf(() => loadConfig(input({ file: { EFF_TOOLSET: "x".repeat(4097) } })))[0]?.key,
    ).toBe("EFF_TOOLSET");
  });
  it.each([
    "espn_s2",
    "SWID",
    "cookie",
    "my_token",
    "apiKey",
    "ODDS_API_KEY",
    "WEATHER_API_KEY",
    "password",
    "credentials",
  ])("refuses the secret-looking key %s", (key) => {
    const issues = issuesOf(() => loadConfig(input({ file: { [key]: "x" } })));
    // the reason is the fixed text — the key itself is never echoed
    expect(issues).toEqual([{ key: "config.json", reason: CONFIG_FILE_ISSUES.secretKey }]);
  });
  it("refuses credential-shaped values anywhere, incl. nested under unknown keys, never echoing them", () => {
    const s2 = fakeEspnS2("schema-test", 200);
    const guid = `{${fakeGuid("schema-test")}}`;
    for (const file of [
      { EFF_TOOLSET: s2 },
      { note: `espn_s2=${s2.slice(0, 50)}` },
      { deep: { deeper: [guid] } },
      { EFF_PROBE_LEAGUE_ID: `%7B${fakeGuid("enc")}%7D` },
    ]) {
      const issues = issuesOf(() => loadConfig(input({ file })));
      expect(issues).toContainEqual({
        key: "config.json",
        reason: CONFIG_FILE_ISSUES.credentialValue,
      });
      expect(JSON.stringify(issues)).not.toContain(s2.slice(0, 20));
    }
  });
  it("does not flag known keys, paths or hashes as credentials", () => {
    expect(
      scanConfigFileForCredentials({
        EFF_CREDENTIAL_STORE: "file",
        EFF_CREDENTIAL_FILE: "/Users/<you>/.config/espn-fantasy-football-mcp/session.json",
        acknowledged_text_sha256: "a".repeat(64),
        ESPN_LEAGUE_ID: LEAGUE,
      }),
    ).toEqual([]);
    expect(scanConfigFileForCredentials("nope")).toEqual([]);
    expect(scanConfigFileForCredentials(null)).toEqual([]);
  });
});

describe("looksLikeCredentialValue (plan 03 §5 #3 shapes)", () => {
  it.each([
    ["a named espn_s2 assignment", "espn_s2=abc"],
    ["a named SWID assignment", "SWID: {x}"],
    ["a brace GUID", `{${fakeGuid("lk")}}`],
    ["a URL-encoded brace GUID", `%7B${fakeGuid("lk2")}%7D`],
    ["a long AE cookie", fakeEspnS2("lk", 150)],
    ["an 80-char escaped cookie", fakeEspnS2("lk80", 80)],
  ])("flags %s", (_name, v) => {
    expect(looksLikeCredentialValue(v)).toBe(true);
  });
  it.each([
    ["a path", "/Users/<you>/.config/espn-fantasy-football-mcp/session.json"],
    ["a home path", "~/.config/espn-fantasy-football-mcp/session-with-%2F-%2B.json-and-more-chars"],
    ["a sha256", "0123456789abcdef".repeat(4)],
    ["a host", ESPN_READ_HOST_DEFAULT],
    ["a short token", "AE123"],
    ["low entropy", `AE${"a%2F".repeat(40)}`],
    ["prose", "the quick brown fox jumps over the lazy dog, again and again and again"],
    ["huge", `AE${"Ab1%2F".repeat(2000)}`],
  ])("does not flag %s", (_name, v) => {
    expect(looksLikeCredentialValue(v)).toBe(false);
  });
});

describe("credential store and file: the recorded value wins (plan 03 §3; changelog G18, C1-11)", () => {
  it("env applies when nothing is recorded", () => {
    const c = loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_CREDENTIAL_STORE: "file" } }));
    expect(c.credentialStore).toBe("file");
    expect(c.origins.EFF_CREDENTIAL_STORE).toBe("env");
  });
  it("a disagreeing env value is ignored, listed and warned", () => {
    const recorded = path.join(tmp.dir, "creds", "session.json");
    const c = loadConfig(
      input({
        env: {
          ESPN_LEAGUE_ID: LEAGUE,
          EFF_CREDENTIAL_STORE: "keychain",
          EFF_CREDENTIAL_FILE: "/elsewhere/s.json",
        },
        file: { EFF_CREDENTIAL_STORE: "file", EFF_CREDENTIAL_FILE: recorded },
      }),
    );
    expect(c.credentialStore).toBe("file");
    expect(c.credentialFile).toBe(recorded);
    expect(c.credentialEnvConflicts).toEqual(["EFF_CREDENTIAL_STORE", "EFF_CREDENTIAL_FILE"]);
    expect(c.origins.EFF_CREDENTIAL_FILE).toBe("file");
    expect(c.warnings.filter((w) => w.includes("disagrees"))).toHaveLength(2);
  });
  it("an agreeing env value is no conflict", () => {
    const c = loadConfig(
      input({
        env: { ESPN_LEAGUE_ID: LEAGUE, EFF_CREDENTIAL_STORE: "file" },
        file: { EFF_CREDENTIAL_STORE: "file" },
      }),
    );
    expect(c.credentialEnvConflicts).toEqual([]);
  });
  it("the file store's path is guarded (outside the repo, not synced, no file provider)", () => {
    const inRepo = path.join(ROOT, "session.json");
    expect(
      issuesOf(() =>
        loadConfig(
          input({
            env: {
              ESPN_LEAGUE_ID: LEAGUE,
              EFF_CREDENTIAL_STORE: "file",
              EFF_CREDENTIAL_FILE: inRepo,
            },
          }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        key: "EFF_CREDENTIAL_FILE",
        reason: expect.stringContaining("repository") as unknown,
      }),
    );
    // with the keychain store the file path is not used, so not guarded
    expect(
      loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_CREDENTIAL_FILE: inRepo } }))
        .credentialFile,
    ).toBe(inRepo);
    expect(
      issuesOf(() =>
        loadConfig(
          input({
            env: {
              ESPN_LEAGUE_ID: LEAGUE,
              EFF_CREDENTIAL_STORE: "file",
              EFF_CREDENTIAL_FILE: "rel/s.json",
            },
          }),
        ),
      ),
    ).toEqual([{ key: "EFF_CREDENTIAL_FILE", reason: "path must be absolute (or start with ~/)" }]);
    const synced = path.join(tmp.dir, "Documents", "s.json");
    expect(
      issuesOf(() =>
        loadConfig(
          input({
            env: {
              ESPN_LEAGUE_ID: LEAGUE,
              EFF_CREDENTIAL_STORE: "file",
              EFF_CREDENTIAL_FILE: synced,
            },
          }),
        ),
      )[0]?.key,
    ).toBe("EFF_CREDENTIAL_FILE");
  });
});

describe("directories: outside the repo, not synced, no file-provider xattr", () => {
  it("refuses a config dir inside the repo and a cache dir in a synced folder", () => {
    const issues = issuesOf(() =>
      loadConfig(
        input({
          env: {
            ESPN_LEAGUE_ID: LEAGUE,
            EFF_CONFIG_DIR: path.join(ROOT, "conf"),
            EFF_CACHE_DIR: path.join(tmp.dir, "Desktop", "cache"),
          },
        }),
      ),
    );
    expect(issues.map((i) => i.key)).toEqual(["EFF_CONFIG_DIR", "EFF_CACHE_DIR"]);
  });
  it("refuses a file-provider-managed config dir, and fails closed when xattrs are unreadable", () => {
    const managed = path.join(tmp.dir, "managed");
    mkdirSync(managed);
    expect(
      issuesOf(() =>
        loadConfig(
          input({
            env: { ESPN_LEAGUE_ID: LEAGUE, EFF_CONFIG_DIR: path.join(managed, "c") },
            xattr: xattrsOn(managed, ["com.apple.icloud.x"]),
          }),
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        key: "EFF_CONFIG_DIR",
        reason: expect.stringContaining("file provider") as unknown,
      }),
    ]);
    expect(issuesOf(() => loadConfig(input({ xattr: brokenXattrs }))).map((i) => i.key)).toEqual([
      "EFF_CONFIG_DIR",
      "EFF_CACHE_DIR",
    ]);
  });
  it("a relative override is an issue, reported with every other issue", () => {
    const issues = issuesOf(() =>
      loadConfig(
        input({ env: { EFF_CONFIG_DIR: "conf", EFF_CACHE_DIR: "cache", EFF_TOOLSET: "x" } }),
      ),
    );
    expect(issues.map((i) => i.key).sort()).toEqual([
      "EFF_CACHE_DIR",
      "EFF_CONFIG_DIR",
      "EFF_TOOLSET",
      "ESPN_LEAGUE_ID",
    ]);
  });
  it("directory overrides are env-only", () => {
    const c = loadConfig(input({ file: { EFF_CACHE_DIR: "/somewhere" } }));
    expect(c.cacheDir).toBe(path.join(tmp.dir, ".cache", "espn-fantasy-football-mcp"));
    expect(c.warnings).toContain("EFF_CACHE_DIR is env-only; its config.json value is ignored");
  });
});

describe("setup records in config.json", () => {
  it("parses the seeding confirmation, the acknowledgement and the keychain self-test", () => {
    const c = loadConfig(
      input({
        file: {
          seeding_confirmed_at: "2026-09-01T10:00:00Z",
          writes_acknowledged_at: "2026-09-02T10:00:00.123+02:00",
          acknowledged_text_sha256: "b".repeat(64),
          keychain_selftest_outcome: "timeout",
          keychain_selftest_at: "2026-09-02T10:00:00Z",
        },
      }),
    );
    expect(c.seedingConfirmedAt).toBe("2026-09-01T10:00:00Z");
    expect(c.writesAcknowledgement).toEqual({
      at: "2026-09-02T10:00:00.123+02:00",
      textSha256: "b".repeat(64),
    });
    expect(c.keychainSelftest).toEqual({ outcome: "timeout", at: "2026-09-02T10:00:00Z" });
    expect(
      loadConfig(input({ file: { keychain_selftest_outcome: "ok" } })).keychainSelftest,
    ).toEqual({
      outcome: "ok",
      at: null,
    });
    expect(SETUP_RECORD_KEYS).toHaveLength(5);
  });
  it.each([
    [{ seeding_confirmed_at: "yesterday" }, "seeding_confirmed_at"],
    [{ seeding_confirmed_at: "2026-02-30T00:00:00Z" }, "seeding_confirmed_at"],
    [{ writes_acknowledged_at: "2026-09-02T10:00:00Z" }, "writes_acknowledged_at"],
    [{ acknowledged_text_sha256: "c".repeat(64) }, "writes_acknowledged_at"],
    [
      { writes_acknowledged_at: "2026-09-02T10:00:00Z", acknowledged_text_sha256: "XYZ" },
      "writes_acknowledged_at",
    ],
    [{ keychain_selftest_outcome: "maybe" }, "keychain_selftest_outcome"],
    [
      { keychain_selftest_outcome: "ok", keychain_selftest_at: "soon" },
      "keychain_selftest_outcome",
    ],
  ])("refuses a malformed record %j", (file, key) => {
    expect(issuesOf(() => loadConfig(input({ file })))[0]?.key).toBe(key);
  });
});

describe("isIsoInstant (a real calendar instant)", () => {
  it.each([
    "2024-02-29T00:00:00Z",
    "2026-10-05T23:59:59.999999999+14:00",
    "2026-01-01T00:00:00-12:00",
  ])("accepts %s", (s) => {
    expect(isIsoInstant(s)).toBe(true);
  });
  it.each([
    "2026-02-29T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-10-05T24:00:00Z",
    "2026-10-05T12:60:00Z",
    "2026-10-05T12:00:60Z",
    "2026-10-05T12:00:00+25:00",
    "2026-10-05T12:00:00+05:61",
    "2026-10-05 12:00:00Z",
    "2026-10-05T12:00:00",
    "",
  ])("refuses %j", (s) => {
    expect(isIsoInstant(s)).toBe(false);
  });
});

describe("test scope and secrets", () => {
  it("parses the test keys", () => {
    const c = loadConfig(
      input({
        env: {
          ESPN_LEAGUE_ID: LEAGUE,
          EFF_FIXTURE_DIR: path.join(ROOT, "fixtures", "espn"),
          EFF_FIXTURE_RECORD: "1",
          EFF_TEST_STUBS: "true",
        },
      }),
    );
    expect(c.fixtureDir).toBe(path.join(ROOT, "fixtures", "espn"));
    expect(c.fixtureRecord).toBe(true);
    expect(c.testStubs).toBe(true);
    expect(
      issuesOf(() =>
        loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_FIXTURE_DIR: "fx" } })),
      )[0]?.key,
    ).toBe("EFF_FIXTURE_DIR");
    expect(
      issuesOf(() =>
        loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, EFF_TEST_STUBS: "maybe" } })),
      )[0]?.key,
    ).toBe("EFF_TEST_STUBS");
  });
  it("keeps secrets non-enumerable and out of every serialisation", () => {
    const key = "0123456789abcdef0123456789abcdef";
    const c: Config = loadConfig(
      input({ env: { ESPN_LEAGUE_ID: LEAGUE, ODDS_API_KEY: key, WEATHER_API_KEY: "wx-key-1234" } }),
    );
    expect(Object.keys(c)).not.toContain("secrets");
    expect(JSON.stringify(c)).not.toContain(key);
    expect(c.secrets.oddsApiKey).toBe(key);
    expect(secretValues(c)).toEqual([
      { kind: "api_key", value: key },
      { kind: "api_key", value: "wx-key-1234" },
    ]);
    expect(secretValues(loadConfig(input()))).toEqual([]);
    expect(
      issuesOf(() =>
        loadConfig(input({ env: { ESPN_LEAGUE_ID: LEAGUE, ODDS_API_KEY: "k".repeat(5000) } })),
      ),
    ).toEqual([{ key: "ODDS_API_KEY", reason: "value is too long" }]);
  });
  it("warns on unknown EFF_/ESPN_ variables (truncated), never on the scanner's EFF_SCAN_*", () => {
    const c = loadConfig(
      input({
        env: {
          ESPN_LEAGUE_ID: LEAGUE,
          EFF_TOOLSETT: "x",
          ESPN_S2: "never-a-setting",
          EFF_SCAN_DENYLIST: "/x",
          [`EFF_${"Z".repeat(80)}`]: "1",
        },
      }),
    );
    expect(c.warnings).toContain("unknown environment variable EFF_TOOLSETT (typo?) is ignored");
    expect(c.warnings).toContain("unknown environment variable ESPN_S2 (typo?) is ignored");
    expect(c.warnings.join(" ")).not.toContain("never-a-setting");
    expect(c.warnings.join(" ")).not.toContain("EFF_SCAN");
    expect(c.warnings.some((w) => w.includes("Z".repeat(60)) && !w.includes("Z".repeat(64)))).toBe(
      true,
    );
  });
  it("ConfigError carries the usage exit code and INTERNAL, and never a value", () => {
    try {
      loadConfig(input({ env: { ESPN_LEAGUE_ID: "secret-ish-value" } }));
      expect.unreachable();
    } catch (e) {
      const err = e as ConfigError;
      expect(err.exitCode).toBe(2);
      expect(err.effCode).toBe("INTERNAL");
      expect(err.message).not.toContain("secret-ish-value");
    }
  });
});

describe("readConfigFile / loadConfigFromProcess", () => {
  const dirs = () => {
    const configDir = path.join(tmp.dir, "conf");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    return configDir;
  };
  it("missing → undefined; valid JSON → object; malformed → ConfigError without content", () => {
    const d = dirs();
    expect(readConfigFile(d)).toBeUndefined();
    writeFileSync(path.join(d, "config.json"), '{"EFF_TOOLSET":"full"}');
    expect(readConfigFile(d)).toEqual({ EFF_TOOLSET: "full" });
    writeFileSync(path.join(d, "config.json"), "{ not json espn_s2=x");
    expect(() => readConfigFile(d)).toThrow(ConfigError);
    try {
      readConfigFile(d);
    } catch (e) {
      expect((e as Error).message).not.toContain("espn_s2");
    }
  });
  it("refuses a symlinked config.json", () => {
    const d = dirs();
    writeFileSync(path.join(tmp.dir, "elsewhere.json"), "{}");
    symlinkSync(path.join(tmp.dir, "elsewhere.json"), path.join(d, "config.json"));
    expect(() => readConfigFile(d)).toThrow(PathSecurityError);
    expect(
      issuesOf(() =>
        loadConfigFromProcess({
          env: { EFF_CONFIG_DIR: d },
          home: tmp.dir,
          repoRoot: ROOT,
          nowMs: NOW,
          xattr: noXattrs,
        }),
      ),
    ).toEqual([{ key: "config.json", reason: "refusing to follow a symbolic link" }]);
  });
  it("loads env + config.json end to end, strict and lenient", () => {
    const d = dirs();
    writeFileSync(
      path.join(d, "config.json"),
      JSON.stringify({ ESPN_LEAGUE_ID: LEAGUE, EFF_TOOLSET: "full" }),
    );
    const c = loadConfigFromProcess({
      env: { EFF_CONFIG_DIR: d },
      home: tmp.dir,
      repoRoot: ROOT,
      nowMs: NOW,
      xattr: noXattrs,
    });
    expect(c.toolset).toBe("full");
    expect(c.leagueId).toBe(LEAGUE);
    writeFileSync(path.join(d, "config.json"), "{}");
    const lenient = loadConfigFromProcess(
      { env: { EFF_CONFIG_DIR: d }, home: tmp.dir, repoRoot: ROOT, nowMs: NOW, xattr: noXattrs },
      { requireLeagueId: false },
    );
    expect(lenient.leagueId).toBeNull();
  });
  it("an unusable config dir is reported by the loader, not as a config.json problem", () => {
    expect(
      issuesOf(() =>
        loadConfigFromProcess({
          env: { EFF_CONFIG_DIR: "rel" },
          home: tmp.dir,
          repoRoot: ROOT,
          nowMs: NOW,
          xattr: noXattrs,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        { key: "EFF_CONFIG_DIR", reason: "path must be absolute (or start with ~/)" },
      ]),
    );
  });
  it("a config.json that cannot be read for another reason is a ConfigError", () => {
    const d = dirs();
    mkdirSync(path.join(d, "config.json"));
    expect(
      issuesOf(() =>
        loadConfigFromProcess({
          env: { EFF_CONFIG_DIR: d },
          home: tmp.dir,
          repoRoot: ROOT,
          nowMs: NOW,
          xattr: noXattrs,
        }),
      ),
    ).toEqual([{ key: "config.json", reason: "exists but is not a regular file" }]);
    const f = path.join(tmp.dir, "plainfile");
    writeFileSync(f, "x");
    expect(
      issuesOf(() =>
        loadConfigFromProcess({
          env: { EFF_CONFIG_DIR: path.join(f, "sub") },
          home: tmp.dir,
          repoRoot: ROOT,
          nowMs: NOW,
          xattr: noXattrs,
        }),
      ),
    ).toEqual([{ key: "config.json", reason: "path could not be checked" }]);
  });
});
