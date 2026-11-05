// retro-truncation-counts.test.ts — the counts RT-5 and RT-6 grade are the server's (the round-4e
// verifiers' R4E-SK-1; changelog §R10, R10-20, R10-25, R10-27). E13's fit is a character budget, so
// the "N of M" its truncation warning names moves with the size of every call it returns — a
// warning, a field, the dataset excerpts. This runs the build's own seeds (`seedState`:
// log-week4-mixed, log-week4-many) on the eval suite's own server env (`serverEnv`, the base
// variant, `core`), then the committed dataset excerpts (`seedFixtureDatasets`, what
// `--seed-datasets` runs), in the build's order, and then the case's calls on a server started
// again on that state without the seed's path, as an eval run's is. Each truncation warning must
// be the one the case's expected_output quotes, and the case's N-of-M regex grader must pass the
// tool's own warning line. The servers are `serve` in-process over pipes (fixture mode: the
// recorded fixtures, no network); a fetch reaching the global is a failure.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SEEDS,
  SEED_ONLY_ENV,
  envelopeOf,
  rpcOver,
  seedState,
  serverEnv,
} from "../../scripts/skills/build-plugin-evals.mjs";
import { seedFixtureDatasets } from "../../scripts/seed-fixture-datasets.js";
import { serve } from "../../src/cli/serve.js";
import { ROOT } from "./helpers.js";

interface Case {
  readonly name: string;
  readonly expected_output: string;
  readonly expectations: readonly string[];
}
const cases = (
  JSON.parse(readFileSync(path.join(ROOT, "skills/retro/evals/evals.json"), "utf8")) as {
    evals: Case[];
  }
).evals;
const caseOf = (name: string): Case => {
  const c = cases.find((x) => x.name === name);
  if (c === undefined) throw new Error(`retro has no ${name}`);
  return c;
};
/** The truncation warnings a case's expected_output quotes, in order ('result truncated to …'). */
const quoted = (name: string): string[] =>
  [...caseOf(name).expected_output.matchAll(/'(result truncated to [^']+)'/g)].map((m) => m[1]!);
/** The case's N-of-M regex grader, as the build compiles it (flags i). */
const nOfM = (name: string): RegExp => {
  const x = caseOf(name).expectations.find((e) => /\bas N of M\b/.test(e));
  const p = x === undefined ? undefined : /\(regex:\s*`([^`]+)`\)\s*$/.exec(x)?.[1];
  if (p === undefined) throw new Error(`${name}: no N-of-M regex grader`);
  return new RegExp(p, "i");
};
/** A quoted warning, its elisions ('…') kept as gaps: every piece, in order. */
const quotedRe = (q: string): RegExp =>
  new RegExp(
    `^${q
      .split("…")
      .map((s) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

/** Every in-process server this file started, so each is closed before the next opens its state. */
const running: Promise<number>[] = [];
/** A spawn that runs `serve` in this process over pipes, on the env the build would give the child. */
const inProcess = (_cmd: string, _args: string[], o: { env: Record<string, string> }) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.resume();
  const ev = new EventEmitter();
  const code = serve(
    { argv: [], env: o.env, stdin, stdout, stderr },
    { signals: false, packageRoot: ROOT },
  );
  running.push(code);
  void code.then(
    (c) => ev.emit("exit", c),
    () => ev.emit("exit", 1),
  );
  return {
    stdin,
    stdout,
    stderr,
    on: (e: "exit", fn: (c: number | null) => void) => ev.on(e, fn),
    kill: () => stdin.end(),
  };
};
const settle = async (): Promise<void> => {
  await Promise.allSettled(running.splice(0));
};

const fetches: string[] = [];
let tmp = "";
/** Each case's retrospective envelopes, in the case's call order. */
const answers = new Map<string, Record<string, unknown>[]>();

/** The calls each case's expected_output names, and which quoted warning each must answer. */
const RUNS = {
  "RT-5": [
    [{ week: 4 }, 0],
    [{ week: 4 }, 0],
    [{ week: 4, kinds: ["evidence"] }, 1],
  ],
  "RT-6": [
    [{ week: 4 }, 0],
    [{ week: 4 }, 0],
    [{ week: 4, kinds: ["lineup"] }, 0],
  ],
} as const;

beforeAll(async () => {
  vi.stubGlobal("fetch", (u: unknown) => {
    fetches.push(String(u));
    return Promise.reject(new Error("no network in this test"));
  });
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-retro-counts-")));
  for (const name of Object.keys(RUNS) as (keyof typeof RUNS)[]) {
    const seed = (SEEDS as Record<string, string>)[name]!;
    const state = path.join(tmp, name);
    for (const d of ["home", "config", "cache"])
      mkdirSync(path.join(state, d), { recursive: true, mode: 0o700 });
    const env = serverEnv({ root: ROOT, state, variant: null, toolset: "core" });
    // the build's order: `--seed` (on the seed's own path), then `--seed-datasets`
    await seedState({
      root: ROOT,
      node: "node",
      env: { ...env, ...SEED_ONLY_ENV },
      seed,
      spawnImpl: inProcess,
    });
    await settle();
    await seedFixtureDatasets(env.EFF_CACHE_DIR!, env.EFF_FIXTURE_DIR!);
    const child = inProcess("node", [], { env });
    const rpc = rpcOver(child, 120_000);
    await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "retro-counts", version: "1" },
    });
    rpc.notify("notifications/initialized", {});
    const got: Record<string, unknown>[] = [];
    for (const [args] of RUNS[name]) {
      const r = await rpc.request("tools/call", {
        name: "espn_analyze_retrospective",
        arguments: args,
      });
      got.push(envelopeOf(r, "espn_analyze_retrospective"));
    }
    answers.set(name, got);
    child.kill();
    await settle();
  }
}, 600_000);

afterAll(async () => {
  await settle();
  vi.unstubAllGlobals();
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

const truncationOf = (env: Record<string, unknown>): string[] =>
  (Array.isArray(env.warnings) ? env.warnings : [])
    .map(String)
    .filter((w) => w.startsWith("result truncated to "));

describe("RT-5 and RT-6 grade the counts the dataset-seeded server answers (R4E-SK-1)", () => {
  it("each case's expected_output quotes the warnings its calls are checked against", () => {
    expect(quoted("RT-5")).toHaveLength(2);
    expect(quoted("RT-6")).toHaveLength(1);
    // the first quote is whole: the warning is matched exactly
    for (const name of ["RT-5", "RT-6"]) expect(quoted(name)[0]).not.toContain("…");
  });

  it.each(Object.keys(RUNS) as (keyof typeof RUNS)[])(
    "%s: every call answers the warning the case quotes, and the N-of-M grader passes it",
    (name) => {
      const got = answers.get(name)!;
      expect(got).toHaveLength(RUNS[name].length);
      RUNS[name].forEach(([args, q], i) => {
        const env = got[i]!;
        const want = quoted(name)[q]!;
        const lines = truncationOf(env);
        expect(env.truncated, `${name} call ${String(i + 1)} ${JSON.stringify(args)}`).toBe(true);
        expect(lines, `${name} call ${String(i + 1)}`).toHaveLength(1);
        if (want.includes("…")) expect(lines[0]).toMatch(quotedRe(want));
        else expect(lines[0]).toBe(want);
        expect(nOfM(name).test(lines[0]!), `${name}'s grader on ${lines[0]!}`).toBe(true);
      });
    },
  );

  it("the cold call is partial on the week's box score, and the repeat reads it (same counts)", () => {
    for (const name of Object.keys(RUNS)) {
      const [cold, repeat] = answers.get(name)!;
      expect(cold!.partial, name).toBe(true);
      expect(repeat!.partial, name).toBe(false);
      expect(truncationOf(cold!)).toEqual(truncationOf(repeat!));
    }
  });

  it("no request left the process", () => {
    expect(fetches).toEqual([]);
  });
});
