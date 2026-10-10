// tune.test.ts — `eff tune` (src/cli/tune.ts; plan 10 §3.3 C9: parameter changes are proposed by the
// retrospective and applied ONLY by a human-run `eff tune --apply`): the dry run is the default and
// writes nothing; --apply is refused in an agent session (CLAUDECODE), under a launchd label and off
// a terminal, asks for the typed word, writes the 0600 file atomically and re-validates every
// proposal; stale or foreign sets and an unusable file are shown, never applied; --revert undoes;
// the default store lookup never creates a store; `tune` is in no launchd job and nothing outside
// src/cli imports it. Every test runs in a temp sandbox; nothing touches the network or a keychain.
import { readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import type { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOBS, LABEL_PREFIX } from "../../src/cli/launchd.js";
import { USAGE, main } from "../../src/cli/main.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import {
  PROPOSAL_MAX_AGE_DAYS,
  TUNE_CONFIRM_WORD,
  applyContextRefusal,
  proposalRepositoryOf,
  readTunedParameters,
  storeProposals,
  tune,
  tunedParametersPath,
  type ProposalLookup,
  type TuneDeps,
  type TuneOptions,
} from "../../src/cli/tune.js";
import { storePath } from "../../src/config/paths.js";
import type { LenientConfig } from "../../src/config/schema.js";
import { fixedClock } from "../../src/domain/clock.js";
import {
  emptyTunedParameters,
  parseTunedParameters,
  proposalHash,
  serializeTunedParameters,
} from "../../src/domain/reclog/tune.js";
import type { ParameterProposalSet } from "../../src/domain/reclog/types.js";
import {
  StoreVersionError,
  type Store,
  type StoreFactory,
  type StoreRepositories,
} from "../../src/store/types.js";
import { NOW, ROOT, makeIo, sandbox, type Sandbox, type TestIo } from "./helpers.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox({ create: true });
});
afterEach(() => {
  sb.cleanup();
});

/** A proposal set: β_RB 0.2 → 0.3 and weight_espn 1 → 0.75. */
function proposalSet(over: Partial<ParameterProposalSet> = {}): ParameterProposalSet {
  const proposals: ParameterProposalSet["proposals"] = [
    {
      parameter: "matchup_beta.RB",
      current: 0.2,
      proposed: 0.3,
      evidence_n: 300,
      fit: "matchup_beta",
      loss_current: 9,
      loss_proposed: 8,
    },
    {
      parameter: "weight_espn",
      current: 1,
      proposed: 0.75,
      evidence_n: 400,
      fit: "weight_espn",
      loss_current: 4,
      loss_proposed: 3.5,
    },
  ];
  const base = {
    schema: 1 as const,
    created_at: NOW,
    season: 2026,
    week: 4,
    window: { first_week: 1, last_week: 4 },
    proposals,
    evaluated: [],
    ...over,
  };
  return { ...base, hash: proposalHash(base.season, base.week, base.proposals) };
}

const found =
  (set: ParameterProposalSet = proposalSet()) =>
  (): ProposalLookup => ({ kind: "found", set });

/** An io whose stdin and stdout are terminals. */
function ttyIo(env: Record<string, string> = {}): TestIo {
  const io = makeIo(sb, { env });
  Object.assign(io.stdin, { isTTY: true });
  Object.assign(io.stdout, { isTTY: true });
  return io;
}

async function run(
  io: TestIo,
  opts: Partial<TuneOptions> = {},
  deps: TuneDeps = { proposals: found() },
): Promise<number> {
  const { config, log } = await loadLenientRuntime(io);
  return tune(io, config, log, { apply: false, revert: false, json: false, ...opts }, deps);
}

const file = (): string => tunedParametersPath(sb.configDir);
const exists = (p: string): boolean => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

describe("the dry run (the default)", () => {
  it("prints the diff against the model defaults and writes nothing", async () => {
    const io = makeIo(sb);
    expect(await run(io)).toBe(0);
    expect(io.out.text).toContain("would change:");
    expect(io.out.text).toContain(
      "  matchup_beta.RB: 0.2 (model default) -> 0.3  [evidence n=300]",
    );
    expect(io.out.text).toContain("  weight_espn: 1 (model default) -> 0.75  [evidence n=400]");
    expect(io.out.text).toContain(`proposal set ${proposalSet().hash.slice(0, 12)}`);
    expect(io.out.text).toMatch(/dry run — nothing written/);
    expect(exists(file())).toBe(false);
  });

  it("--json is one JSON document with the plan, the set and the file state", async () => {
    const io = makeIo(sb);
    expect(await run(io, { json: true })).toBe(0);
    const doc = JSON.parse(io.out.text) as Record<string, unknown>;
    expect(doc).toMatchObject({
      mode: "dry_run",
      kind: "apply",
      applied: false,
      file: { path: file(), state: "absent" },
      proposal_set: { hash: proposalSet().hash, season: 2026, week: 4, age_days: 0 },
    });
    expect((doc.changes as unknown[]).length).toBe(2);
  });

  it("an empty proposal set says so", async () => {
    const io = makeIo(sb);
    expect(await run(io, {}, { proposals: found(proposalSet({ proposals: [] })) })).toBe(0);
    expect(io.out.text).toContain("note: the retrospective proposed no change this week");
    expect(io.out.text).toContain("no change to write");
  });

  it.each([
    [{ kind: "none" }, /no proposal set stored yet/],
    [{ kind: "unsupported" }, /keeps no proposal sets yet/],
    [{ kind: "no_league" }, /ESPN_LEAGUE_ID is not set/],
    [{ kind: "no_store" }, /no store yet/],
    [{ kind: "invalid" }, /failed validation/],
    [{ kind: "error", message: "SqliteError: busy" }, /could not be read: SqliteError: busy/],
  ] as const)("lookup %j → a note, exit 0", async (lookup, text) => {
    const io = makeIo(sb);
    expect(await run(io, {}, { proposals: () => lookup })).toBe(0);
    expect(io.out.text).toMatch(text);
  });
});

describe("--apply runs only for a human at a terminal", () => {
  it.each([
    ["an agent session (CLAUDECODE)", { CLAUDECODE: "1" }, /Claude Code session/],
    ["a launchd job", { XPC_SERVICE_NAME: `${LABEL_PREFIX}.probe` }, /launchd job/],
  ])("refused in %s: exit 2, nothing read, nothing written", async (_name, env, text) => {
    const io = ttyIo(env);
    let asked = false;
    let looked = false;
    const code = await run(
      io,
      { apply: true },
      {
        proposals: () => {
          looked = true;
          return { kind: "found", set: proposalSet() };
        },
        confirm: () => {
          asked = true;
          return Promise.resolve(TUNE_CONFIRM_WORD);
        },
      },
    );
    expect(code).toBe(2);
    expect(io.err.text).toMatch(text);
    expect(io.err.text).toMatch(/Nothing was changed/);
    expect(asked).toBe(false);
    expect(looked).toBe(false);
    expect(exists(file())).toBe(false);
  });

  it("refused off a terminal (stdin or stdout piped)", async () => {
    for (const piped of ["stdin", "stdout"] as const) {
      const io = ttyIo();
      Object.assign(io[piped], { isTTY: false });
      expect(
        await run(
          io,
          { apply: true },
          { proposals: found(), confirm: () => Promise.resolve("apply") },
        ),
      ).toBe(2);
      expect(io.err.text).toMatch(/interactive terminal/);
    }
    expect(exists(file())).toBe(false);
  });

  it("--json with --apply is a usage error", async () => {
    const io = ttyIo();
    expect(await run(io, { apply: true, json: true })).toBe(2);
    expect(exists(file())).toBe(false);
  });

  it("applies after the typed word: 0600, atomic, re-validated, with a history entry", async () => {
    const io = ttyIo();
    let question = "";
    const code = await run(
      io,
      { apply: true },
      {
        proposals: found(),
        confirm: (q) => {
          question = q;
          return Promise.resolve(" apply ");
        },
      },
    );
    expect(code).toBe(0);
    expect(question).toBe("Type apply to write 2 changes: ");
    expect(io.out.text).toMatch(/applied 2 changes to .*tuned-parameters\.json/);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    const doc = parseTunedParameters(readFileSync(file(), "utf8"));
    expect(doc.values).toEqual({ "matchup_beta.RB": 0.3, weight_espn: 0.75 });
    expect(doc.history).toHaveLength(1);
    expect(doc.history[0]?.proposal_hash).toBe(proposalSet().hash);
    expect(readdirSync(sb.configDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // the same set again: already applied — nothing to write
    const again = makeIo(sb);
    expect(await run(again)).toBe(0);
    expect(again.out.text).toContain("no change to write");
  });

  it.each([
    ["a different word", "yes"],
    ["a closed input", null],
  ])("%s applies nothing (exit 1)", async (_name, answer) => {
    const io = ttyIo();
    expect(
      await run(
        io,
        { apply: true },
        { proposals: found(), confirm: () => Promise.resolve(answer) },
      ),
    ).toBe(1);
    expect(io.err.text).toMatch(/not confirmed — nothing applied/);
    expect(exists(file())).toBe(false);
  });

  it("nothing to apply → exit 0 without asking", async () => {
    const io = ttyIo();
    let asked = false;
    const code = await run(
      io,
      { apply: true },
      {
        proposals: found(proposalSet({ proposals: [] })),
        confirm: () => {
          asked = true;
          return Promise.resolve("apply");
        },
      },
    );
    expect(code).toBe(0);
    expect(asked).toBe(false);
    expect(io.out.text).toContain("nothing applied");
  });

  it("the default prompt reads the typed line from the terminal", async () => {
    const io = ttyIo();
    const p = run(io, { apply: true }, { proposals: found() });
    setTimeout(() => (io.stdin as PassThrough).write("apply\r"), 20);
    expect(await p).toBe(0);
    expect(exists(file())).toBe(true);
  });

  it("a write that fails leaves nothing behind (exit 1)", async () => {
    const io = ttyIo();
    const { config, log } = await loadLenientRuntime(io);
    chmodSync(sb.configDir, 0o500);
    try {
      const code = await tune(
        io,
        config,
        log,
        { apply: true, revert: false, json: false },
        {
          proposals: found(),
          confirm: () => Promise.resolve("apply"),
        },
      );
      expect(code).toBe(1);
      expect(io.err.text).toMatch(/could not be written .*nothing applied/);
    } finally {
      chmodSync(sb.configDir, 0o700);
    }
    expect(exists(file())).toBe(false);
  });

  it("a config dir that fails the location rule is refused at write time", async () => {
    const io = ttyIo();
    const { config, log } = await loadLenientRuntime(io);
    const blind = { ...io, xattr: () => null };
    const code = await tune(
      blind,
      config,
      log,
      { apply: true, revert: false, json: false },
      {
        proposals: found(),
        confirm: () => Promise.resolve("apply"),
      },
    );
    expect(code).toBe(1);
    expect(io.err.text).toMatch(/refused — .*nothing applied/);
    expect(exists(file())).toBe(false);
  });
});

describe("sets and files that are shown but never applied", () => {
  it(`a set older than ${String(PROPOSAL_MAX_AGE_DAYS)} days`, async () => {
    const io = ttyIo();
    io.clock.advance(20 * 86_400_000);
    expect(
      await run(
        io,
        { apply: true },
        { proposals: found(), confirm: () => Promise.resolve("apply") },
      ),
    ).toBe(1);
    expect(io.out.text).toMatch(/20 days old/);
    expect(io.out.text).toContain("nothing applied");
    expect(exists(file())).toBe(false);
  });

  it("a set for another season", async () => {
    const io = ttyIo();
    const set = proposalSet({ season: 2025 });
    expect(
      await run(
        io,
        { apply: true },
        { proposals: found(set), confirm: () => Promise.resolve("apply") },
      ),
    ).toBe(1);
    expect(io.out.text).toMatch(/season 2025, not 2026/);
  });

  it("an unusable existing file is reported and never overwritten", async () => {
    writeFileSync(file(), "{ not json", { mode: 0o600 });
    const dry = makeIo(sb);
    expect(await run(dry)).toBe(0);
    expect(dry.out.text).toMatch(
      /tuned-parameters\.json is unusable \(tuned-parameters\.json: is not valid JSON\)/,
    );
    const io = ttyIo();
    expect(
      await run(
        io,
        { apply: true },
        { proposals: found(), confirm: () => Promise.resolve("apply") },
      ),
    ).toBe(1);
    expect(readFileSync(file(), "utf8")).toBe("{ not json");
  });

  it("a group-readable file is unusable (the private-file rule)", async () => {
    writeFileSync(file(), serializeTunedParameters(emptyTunedParameters()), { mode: 0o600 });
    chmodSync(file(), 0o644);
    const r = readTunedParameters(file());
    expect(r.ok).toBe(false);
    const io = ttyIo();
    expect(
      await run(
        io,
        { apply: true },
        { proposals: found(), confirm: () => Promise.resolve("apply") },
      ),
    ).toBe(1);
  });

  it("a stored value that moved since the proposal is refused (stale), the rest applied", async () => {
    writeFileSync(
      file(),
      serializeTunedParameters({ ...emptyTunedParameters(), values: { "matchup_beta.RB": 0.25 } }),
      { mode: 0o600 },
    );
    const io = ttyIo();
    expect(
      await run(
        io,
        { apply: true },
        { proposals: found(), confirm: () => Promise.resolve("apply") },
      ),
    ).toBe(0);
    expect(io.out.text).toContain("  matchup_beta.RB: not applied (stale current)");
    expect(parseTunedParameters(readFileSync(file(), "utf8")).values).toEqual({
      "matchup_beta.RB": 0.25,
      weight_espn: 0.75,
    });
  });
});

describe("--revert", () => {
  it("says there is nothing to revert before any apply", async () => {
    const io = makeIo(sb);
    expect(await run(io, { revert: true })).toBe(0);
    expect(io.out.text).toMatch(/nothing to revert/);
  });

  it("undoes the last change set (dry run first, then --apply)", async () => {
    await run(
      ttyIo(),
      { apply: true },
      { proposals: found(), confirm: () => Promise.resolve("apply") },
    );
    const dry = makeIo(sb);
    expect(await run(dry, { revert: true })).toBe(0);
    expect(dry.out.text).toContain("would restore:");
    expect(dry.out.text).toContain("  weight_espn: 0.75 -> model default");
    expect(dry.out.text).toMatch(/eff tune --revert --apply/);
    const io = ttyIo();
    expect(
      await run(io, { revert: true, apply: true }, { confirm: () => Promise.resolve("apply") }),
    ).toBe(0);
    const doc = parseTunedParameters(readFileSync(file(), "utf8"));
    expect(doc.values).toEqual({});
    expect(doc.history.map((h) => h.source)).toEqual(["proposal", "revert"]);
  });
});

describe("the default lookup: the store, read-only", () => {
  const config = async (env: Record<string, string> = {}): Promise<LenientConfig> =>
    (await loadLenientRuntime(makeIo(sb, { env }))).config;

  it("no league id → no_league; no store file → no_store (nothing created)", async () => {
    const io = makeIo(sb);
    const { log } = await loadLenientRuntime(io);
    expect(storeProposals(io, log)(await config())).toEqual({ kind: "no_league" });
    expect(storeProposals(io, log)(await config({ ESPN_LEAGUE_ID: "0" }))).toEqual({
      kind: "no_store",
    });
    expect(exists(storePath(sb.cacheDir))).toBe(false);
  });

  it("this build's real store has no proposal table yet → unsupported", async () => {
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    const { config: c, log } = await loadLenientRuntime(io);
    openStore(c, fixedClock(NOW), log, { migrate: true }).close();
    expect(storeProposals(io, log)(c)).toEqual({ kind: "unsupported" });
  });

  function fakeFactory(latest: () => unknown): StoreFactory {
    return {
      open: () =>
        ({
          repos: {
            parameterProposals: { latest, put: () => undefined },
          } as unknown as StoreRepositories,
          close: () => undefined,
        }) as unknown as Store,
      openPublisher: () => {
        throw new Error("not used");
      },
    };
  }

  it.each([
    ["a valid set", () => JSON.parse(JSON.stringify(proposalSet())) as unknown, "found"],
    ["none", () => null, "none"],
    ["a tampered set", () => ({ ...proposalSet(), hash: "0".repeat(64) }), "invalid"],
    [
      "a throwing repository",
      () => {
        throw new Error("busy");
      },
      "error",
    ],
  ])("%s → %s", async (_name, latest, kind) => {
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    const { config: c, log } = await loadLenientRuntime(io);
    writeFileSync(storePath(sb.cacheDir), "");
    expect(storeProposals(io, log, fakeFactory(latest))(c).kind).toBe(kind);
  });

  it("a store newer than this binary is an error, never opened for writing", async () => {
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    const { config: c, log } = await loadLenientRuntime(io);
    writeFileSync(storePath(sb.cacheDir), "");
    const newer: StoreFactory = {
      open: () => {
        throw new StoreVersionError(99, 1);
      },
      openPublisher: () => {
        throw new Error("not used");
      },
    };
    expect(storeProposals(io, log, newer)(c)).toEqual({ kind: "error", message: "store is newer" });
  });

  it("proposalRepositoryOf: only an object with latest()", () => {
    expect(proposalRepositoryOf({} as StoreRepositories)).toBeNull();
    expect(
      proposalRepositoryOf({ parameterProposals: { latest: 1 } } as unknown as StoreRepositories),
    ).toBeNull();
    const repo = { latest: () => null, put: () => undefined };
    expect(proposalRepositoryOf({ parameterProposals: repo } as unknown as StoreRepositories)).toBe(
      repo,
    );
  });
});

describe("dispatch, and where tune can never run from", () => {
  it("eff tune is dispatched and documented; an unknown flag is a usage error", async () => {
    expect(USAGE).toContain("tune [--revert] [--apply] [--json]");
    const io = makeIo(sb);
    expect(await main(["tune"], io)).toBe(0);
    expect(io.out.text).toMatch(/ESPN_LEAGUE_ID is not set/);
    const bad = makeIo(sb);
    expect(await main(["tune", "--yes"], bad)).toBe(2);
    const json = makeIo(sb);
    expect(await main(["tune", "--json"], json)).toBe(0);
    expect(JSON.parse(json.out.text)).toMatchObject({ mode: "dry_run", applied: false });
  });

  it("applyContextRefusal", () => {
    expect(applyContextRefusal(makeIo(sb, { env: { CLAUDECODE: "1" } }))).toMatch(/CLAUDECODE/);
    expect(applyContextRefusal(makeIo(sb))).toMatch(/interactive terminal/);
    expect(
      applyContextRefusal(ttyIo({ XPC_SERVICE_NAME: "application.com.apple.Terminal.1" })),
    ).toBeNull();
  });

  it("no launchd job runs tune", () => {
    for (const j of JOBS) expect(j.argv[0]).not.toBe("tune");
  });

  it("nothing outside src/cli imports src/cli/tune (serve and the MCP layer cannot reach it)", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          e.name.endsWith(".ts") &&
          !p.startsWith(path.join(ROOT, "src", "cli") + path.sep)
        ) {
          const text = readFileSync(p, "utf8");
          if (/from\s+["'][^"']*cli\/tune(?:\.js)?["']/.test(text))
            offenders.push(path.relative(ROOT, p));
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders).toEqual([]);
    // within src/cli only the dispatcher imports it
    const cli = readdirSync(path.join(ROOT, "src", "cli")).filter(
      (f) =>
        f.endsWith(".ts") &&
        /from\s+"\.\/tune\.js"/.test(readFileSync(path.join(ROOT, "src", "cli", f), "utf8")),
    );
    expect(cli).toEqual(["main.ts"]);
  });
});
