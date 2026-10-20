// seeding-serve.test.ts — `eff setup --seeding` while `eff serve` runs, through the stdio CLI as a
// client launches it (Stage C finding services-seeding-read-once, attempt 2; plan 07 C12: results say
// `seeding.confirmed: false` until onboard records the answer; plan 03 §2.1 `--seeding`, L6). The serve
// CLI hands the server a copy spread from the composition root's services (it adds its in-flight
// accounting so — src/cli/serve.ts), and a spread evaluates the root's seeding accessors once: the
// stdio server kept the start reading, unconfirmed, until the client restarted. Here the server is
// the real `serve()` in process (fixture mode on fx-10h, the full toolset, as the finding ran it) and
// setup is the real CLI over the same config and cache dirs ("another terminal"): the very next tool
// calls and resource read report and use the recorded reading, with no restart, and the in-flight
// drain the copy carries still answers a call that stdin's EOF overtakes. Then the composition root
// itself: a copy spread from its services — before or after a change, a copy of a copy — reads the
// recorded reading once `beforeCall` ran on it (a property over interleaved records, copies and
// calls); a copy that cannot take it (frozen, a throwing getter) never breaks the call and is
// reported once, value-free. No network, no keychain, temp directories only.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";
import { serve } from "../../src/cli/serve.js";
import { configFilePath } from "../../src/config/paths.js";
import { SEEDING_MODES, type SeedingMode } from "../../src/config/schema.js";
import type { McpServices } from "../../src/mcp/services.js";
import { seedingRecordOf } from "../../src/services/seeding.js";
import { makeIo } from "../cli/helpers.js";
import { ESPN_FIXTURES, ROOT, makeWorld, runningClock, type World } from "../mcp/helpers/world.js";

type Msg = Record<string, unknown>;

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const MANIFEST = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
};
/** A test's own limit: four calls (one of them E2) per reading, three readings, under coverage. */
const SERVE_TEST_MS = 300_000;
/** One reply's limit (E2 on fx-10h under the full toolset takes seconds under coverage). */
const REPLY_MS = 120_000;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** A private sandbox: HOME, config and cache dirs; the env a client's config block would carry. */
function sandbox(): {
  env: Record<string, string>;
  dir: string;
  home: string;
  configDir: string;
  cacheDir: string;
} {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-seeding-serve-")));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const home = path.join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  const configDir = path.join(dir, "config");
  const cacheDir = path.join(dir, "cache");
  return {
    dir,
    home,
    configDir,
    cacheDir,
    env: {
      HOME: home,
      ESPN_LEAGUE_ID: "0",
      ESPN_SEASON: "2026",
      ESPN_TEAM_ID: String(MANIFEST.my_team_id),
      EFF_CONFIG_DIR: configDir,
      EFF_CACHE_DIR: cacheDir,
      EFF_FIXTURE_DIR: FX,
      EFF_TOOLSET: "full",
      // any keychain access ends the process loudly (fixture mode holds no credential); the CPU
      // deadline is off in fixture mode, so E2 never turns partial on a slow runner
      EFF_TEST_STUBS: "1",
      EFF_LOG_LEVEL: "info",
    },
  };
}

async function until<T>(f: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** `eff serve` in process over PassThrough stdio: JSON-RPC frames from stdout, log lines from stderr. */
function startServe(env: Record<string, string>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const frames: Msg[] = [];
  const logs: string[] = [];
  let outBuf = "";
  let errBuf = "";
  stdout.on("data", (c: Buffer) => {
    outBuf += c.toString("utf8");
    for (let i = outBuf.indexOf("\n"); i >= 0; i = outBuf.indexOf("\n")) {
      frames.push(JSON.parse(outBuf.slice(0, i)) as Msg);
      outBuf = outBuf.slice(i + 1);
    }
  });
  stderr.on("data", (c: Buffer) => {
    errBuf += c.toString("utf8");
    for (let i = errBuf.indexOf("\n"); i >= 0; i = errBuf.indexOf("\n")) {
      logs.push(errBuf.slice(0, i));
      errBuf = errBuf.slice(i + 1);
    }
  });
  const code = serve(
    { argv: [], env, stdin, stdout, stderr },
    { clock: runningClock(MANIFEST.clock), signals: false, packageRoot: ROOT },
  );
  let next = 10;
  const send = (id: number, method: string, params: Msg): void => {
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  };
  const request = async (method: string, params: Msg): Promise<Msg> => {
    const id = next++;
    send(id, method, params);
    return until(() => frames.find((f) => f.id === id), REPLY_MS, `reply ${String(id)}`);
  };
  return { code, stdin, frames, logs, send, request };
}

/** The envelope inside a tools/call or resources/read reply (never an error). */
function envelope(reply: Msg): Msg {
  expect(reply.error, JSON.stringify(reply.error)).toBeUndefined();
  const r = reply.result as {
    content?: { text: string }[];
    contents?: { text: string }[];
    isError?: boolean;
  };
  const text = r.content?.[0]?.text ?? r.contents?.[0]?.text ?? "{}";
  expect(r.isError ?? false, text.slice(0, 400)).toBe(false);
  return JSON.parse(text) as Msg;
}

type Serve = ReturnType<typeof startServe>;

/** What every surface says about the reading, one call each (E2 included: the objective is the point). */
async function readings(s: Serve): Promise<Msg> {
  const call = async (name: string, args: Msg = {}): Promise<Msg> =>
    envelope(await s.request("tools/call", { name, arguments: args }));
  const league = await call("espn_get_league", { include: ["seeding"] });
  const status = await call("espn_get_status");
  const lineup = (await call("espn_analyze_lineup")).data as Msg;
  const identity = envelope(await s.request("resources/read", { uri: "espn-ff://league" }));
  return {
    league: (league.data as { seeding: Msg }).seeding,
    league_warned: (league.warnings as string[]).some((w) =>
      w.startsWith("seeding reading not confirmed"),
    ),
    status: (status.data as { league: Msg }).league,
    lineup: {
      seeding: lineup.seeding,
      seeding_mode_used: lineup.seeding_mode_used,
      objective_used: lineup.objective_used,
      objective_reason: lineup.objective_reason,
    },
    identity: identity.data,
  };
}

/** What `readings` must say for `mode`, confirmed or not. */
function expected(mode: SeedingMode, confirmed: boolean): Msg {
  return {
    league: expect.objectContaining({
      mode_configured: mode,
      confirmed,
      mode_in_use: mode,
    }) as unknown,
    league_warned: !confirmed,
    status: expect.objectContaining({
      seeding_mode_configured: mode,
      seeding_confirmed: confirmed,
    }) as unknown,
    lineup: expect.objectContaining({
      seeding: { mode_used: mode, confirmed },
      seeding_mode_used: mode,
      objective_reason: expect.stringMatching(
        mode === "points_only" ? /^auto: the points_only reading/ : /^auto: espn_rule/,
      ) as unknown,
    }) as unknown,
    identity: expect.objectContaining({
      seeding_mode_configured: mode,
      seeding_confirmed: confirmed,
    }) as unknown,
  };
}

describe("`eff setup --seeding` while `eff serve` runs (the stdio CLI, no restart)", () => {
  it(
    "the next tool calls and resource read report and use the recorded reading; the drain still counts",
    async () => {
      const sb = sandbox();
      const s = startServe(sb.env);
      const init = await s.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "seeding-serve-test", version: "0" },
      });
      expect(init.result, JSON.stringify(init.error)).toBeDefined();
      s.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      expect(await readings(s)).toEqual(expected("espn_rule", false));

      /** `eff setup --seeding <mode>` in another terminal: the real CLI over the server's dirs. */
      const setupSeeding = async (mode: SeedingMode): Promise<void> => {
        const io = makeIo(
          {
            dir: sb.dir,
            home: sb.home,
            configDir: sb.configDir,
            cacheDir: sb.cacheDir,
            cleanup: () => undefined,
          },
          { env: { ESPN_LEAGUE_ID: "0" } },
        );
        expect(await main(["setup", "--seeding", mode], io)).toBe(0);
        expect(io.out.text).toContain(`Seeding reading recorded: ${mode} (confirmed now)`);
      };

      await setupSeeding("points_only");
      const after = await readings(s);
      expect(after).toEqual(expected("points_only", true));
      expect(after.lineup).toMatchObject({ objective_used: "points_only" });

      await setupSeeding("espn_rule");
      expect(await readings(s)).toEqual(expected("espn_rule", true));

      // one value-free line per change, never one per call; config.json's path is never logged
      const changed = s.logs.filter((l) => l.includes('"event":"seeding.reading_changed"'));
      expect(changed).toHaveLength(2);
      expect(changed[0]).toContain('"mode":"points_only"');
      expect(changed[1]).toContain('"mode":"espn_rule"');
      for (const l of changed) expect(l).toContain('"confirmed":true');
      expect(s.logs.join("\n")).not.toContain(sb.configDir);

      // the copy's in-flight accounting still holds the drain: a call stdin's EOF overtakes is answered
      const id = 99;
      s.send(id, "tools/call", { name: "espn_get_status", arguments: {} });
      s.stdin.end();
      expect(await s.code).toBe(0);
      const last = s.frames.find((f) => f.id === id);
      expect(last?.result).toBeDefined();
      expect((envelope(last!).data as { league: Msg }).league).toMatchObject({
        seeding_mode_configured: "espn_rule",
        seeding_confirmed: true,
      });
    },
    SERVE_TEST_MS,
  );
});

// --- the composition root: a copy of its services follows the reading ----------------------------

const AT = "2026-10-06T18:00:00.000Z";

/** The reading `obj` reads now. */
function fieldsOf(obj: McpServices): { mode: SeedingMode; at: string | null } {
  return { mode: obj.seedingMode, at: obj.seedingConfirmedAt };
}

describe("a copy spread from the composition root's services follows the reading", () => {
  let world: World;
  let file: string;
  /** config.json as `eff setup --seeding` leaves it (the reader's own rules are seeding-live's). */
  const record = (doc: Record<string, unknown> | null): void => {
    if (doc === null) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
  };
  /** The per-call hook as src/mcp runs it: a method of the services the call is about to read. */
  const beforeCall = (obj: McpServices): void => {
    obj.beforeCall?.();
  };
  const staleLines = (from: number): string[] =>
    world.logLines.slice(from).filter((l) => l.includes('"event":"services.seeding_copy_stale"'));

  beforeAll(async () => {
    world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: MANIFEST.my_team_id,
      clock: MANIFEST.clock,
      publishEspn: false,
    });
    expect(world.config.origins.EFF_SEEDING_MODE).toBe("default");
    file = configFilePath(world.config.configDir);
  }, 120_000);
  afterAll(() => {
    world.cleanup();
  });
  afterEach(() => {
    record(null);
    beforeCall(world.wiring.services);
  });

  it("serve's copy, the test world's copy and a copy of a copy read the record after their next call", () => {
    const from = world.logLines.length;
    const built = world.wiring.services;
    // what src/cli/serve.ts hands the server: a spread with its own in-flight accounting
    const serveCopy: McpServices = { ...built, inflight: { enter: () => 0, exit: () => 0 } };
    expect(fieldsOf(serveCopy)).toEqual({ mode: "espn_rule", at: null });

    record({ EFF_SEEDING_MODE: "points_only", seeding_confirmed_at: AT });
    // until its call the copy holds what its spread read (the defect: nothing ever set it)
    expect(fieldsOf(serveCopy)).toEqual({ mode: "espn_rule", at: null });
    beforeCall(serveCopy);
    expect(fieldsOf(serveCopy)).toEqual({ mode: "points_only", at: AT });
    // the built object reads the reader, whichever services' call refreshed it
    expect(fieldsOf(built)).toEqual({ mode: "points_only", at: AT });
    // tests/mcp/helpers/world.ts hands every tool test a copy too ({ ...services, newSeed })
    beforeCall(world.services);
    expect(fieldsOf(world.services)).toEqual({ mode: "points_only", at: AT });

    const second: McpServices = { ...serveCopy };
    record({ EFF_SEEDING_MODE: "espn_rule", seeding_confirmed_at: AT });
    beforeCall(second);
    expect(fieldsOf(second)).toEqual({ mode: "espn_rule", at: AT });
    // a copy is brought up to date by its own call, not another's
    expect(fieldsOf(serveCopy)).toEqual({ mode: "points_only", at: AT });
    beforeCall(serveCopy);
    expect(fieldsOf(serveCopy)).toEqual({ mode: "espn_rule", at: AT });
    // config.json removed: what a server started now runs on — the default, unconfirmed
    record(null);
    beforeCall(serveCopy);
    expect(fieldsOf(serveCopy)).toEqual({ mode: "espn_rule", at: null });
    expect(staleLines(from)).toEqual([]);
  });

  it("a copy that cannot take the reading never breaks the call: one value-free warning per copy", () => {
    const from = world.logLines.length;
    const built = world.wiring.services;
    const frozen = Object.freeze({ ...built });
    const secret = `no-such-dir ${world.config.configDir}`;
    const throwing: McpServices = {
      ...built,
      get seedingMode(): SeedingMode {
        throw new Error(secret);
      },
    };
    record({ EFF_SEEDING_MODE: "points_only", seeding_confirmed_at: AT });
    for (let i = 0; i < 3; i++) {
      expect(() => {
        beforeCall(frozen);
      }).not.toThrow();
      expect(() => {
        beforeCall(throwing);
      }).not.toThrow();
    }
    expect(fieldsOf(frozen)).toEqual({ mode: "espn_rule", at: null }); // its spread's reading
    const lines = staleLines(from);
    expect(lines).toHaveLength(2); // one per copy, never one per call
    for (const l of lines) {
      expect(l).toContain('"level":"warn"');
      expect(l).toContain('"mode":"points_only"');
      expect(l).toContain('"confirmed":true');
      expect(l).toContain("restart the client");
      expect(l).not.toContain(world.config.configDir);
      expect(l).not.toContain(secret);
    }
    // the reader itself followed the record: the built object and a fresh copy read it
    expect(fieldsOf(built)).toEqual({ mode: "points_only", at: AT });
    expect(fieldsOf({ ...built })).toEqual({ mode: "points_only", at: AT });
  });

  it("no receiver follows the built object; an object over it reads it through, never shadowed", () => {
    const from = world.logLines.length;
    const built = world.wiring.services;
    record({ EFF_SEEDING_MODE: "points_only", seeding_confirmed_at: AT });
    expect(() => built.beforeCall?.call(undefined)).not.toThrow();
    expect(fieldsOf(built)).toEqual({ mode: "points_only", at: AT });
    const over = Object.create(built) as McpServices;
    record({ EFF_SEEDING_MODE: "espn_rule", seeding_confirmed_at: AT });
    beforeCall(over);
    expect(fieldsOf(over)).toEqual({ mode: "espn_rule", at: AT });
    expect(Object.hasOwn(over, "seedingMode")).toBe(false);
    expect(Object.hasOwn(over, "seedingConfirmedAt")).toBe(false);
    expect(staleLines(from)).toEqual([]);
  });

  it("the operator's record wins over a value a copy set itself (a test sets it through config)", () => {
    const overriding: McpServices = {
      ...world.wiring.services,
      seedingMode: "points_only",
      seedingConfirmedAt: AT,
    };
    beforeCall(overriding); // config.json absent: the default, unconfirmed
    expect(fieldsOf(overriding)).toEqual({ mode: "espn_rule", at: null });
    record({ EFF_SEEDING_MODE: "points_only" });
    beforeCall(overriding);
    expect(fieldsOf(overriding)).toEqual({ mode: "points_only", at: null });
  });

  it("property: after its call, any copy — of any object, made at any point — reads the record", () => {
    type Act =
      | { readonly k: "record"; readonly mode: SeedingMode; readonly confirmed: boolean }
      | { readonly k: "remove" }
      | { readonly k: "copy"; readonly of: number }
      | { readonly k: "call"; readonly on: number };
    const act: fc.Arbitrary<Act> = fc.oneof(
      fc.record({
        k: fc.constant("record" as const),
        mode: fc.constantFrom(...SEEDING_MODES),
        confirmed: fc.boolean(),
      }),
      fc.constant({ k: "remove" as const }),
      fc.record({ k: fc.constant("copy" as const), of: fc.nat() }),
      fc.record({ k: fc.constant("call" as const), on: fc.nat() }),
    );
    const from = world.logLines.length;
    fc.assert(
      fc.property(fc.array(act, { maxLength: 24 }), (acts) => {
        record(null);
        const objs: McpServices[] = [world.wiring.services];
        let doc: Record<string, unknown> | undefined;
        for (const a of acts) {
          if (a.k === "record") {
            doc = {
              EFF_SEEDING_MODE: a.mode,
              ...(a.confirmed ? { seeding_confirmed_at: AT } : {}),
            };
            record(doc);
          } else if (a.k === "remove") {
            doc = undefined;
            record(null);
          } else if (a.k === "copy") {
            objs.push({ ...objs[a.of % objs.length]! });
          } else {
            const obj = objs[a.on % objs.length]!;
            beforeCall(obj);
            const want = seedingRecordOf(doc, null);
            expect(want.ok).toBe(true);
            if (!want.ok) return;
            expect(fieldsOf(obj)).toEqual({
              mode: want.reading.mode,
              at: want.reading.confirmedAt,
            });
            expect(fieldsOf(world.wiring.services)).toEqual(fieldsOf(obj));
          }
        }
      }),
      { numRuns: 60 },
    );
    expect(staleLines(from)).toEqual([]);
  }, 120_000);
});
