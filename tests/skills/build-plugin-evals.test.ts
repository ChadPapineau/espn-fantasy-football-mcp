// build-plugin-evals.test.ts — scripts/skills/build-plugin-evals.mjs (plan 09 §5.2; plan 10 B15):
// every Lane 2 case and every trigger of the thirteen Skills becomes a `claude plugin eval` case
// whose graders are the expectation tags mapped mechanically; each case loads an eval plugin whose
// one server is the real one in fixture mode on the case's variant and toolset; the suite is written
// only where it can never be committed, and its servers' state only outside every git tree; the
// NC-INJ-2 seed goes through the real tools. Adversarial: hostile strings through the YAML and the
// regexes, malformed tags, a server that dies, lies or hangs. No test starts a real server.
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  CASE_RUNS,
  DEFAULT_OUT,
  INJECTION_NEEDLES,
  NO_SOCKET,
  SEEDS,
  SEED_NOTE,
  STATE_ROOT_FILE,
  SYNTHETIC_TOKEN,
  WRITE_TOOL_GUARD,
  buildPluginEvals,
  caseDir,
  envelopeOf,
  gitTreeOf,
  gradersFor,
  inputPattern,
  main,
  mcpPrefix,
  outProblem,
  parseToolUsedSpec,
  planSuite,
  pluginKey,
  rpcOver,
  seedLogWeek4,
  serverEnv,
  syntheticCookie,
  toolInputPattern,
  writeSeeds,
  yamlFrontmatter,
} from "../../scripts/skills/build-plugin-evals.mjs";
import { parseFrontmatter, readManifest } from "../../scripts/skills/_lib.mjs";
import { ROOT, SKILLS, tempRepo, type TempRepo } from "./helpers.js";

type Json = Record<string, unknown>;
const manifest = readManifest(ROOT);
const PREFIX = mcpPrefix(manifest.plugin);
/** A frontmatter value as text (strings verbatim, anything else as JSON). */
const str = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const ctx = {
  plugin: manifest.plugin,
  prompt: "p?",
  expected: "the expected reply",
  reference: null,
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const temp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => {
    rmSync(d, { recursive: true, force: true });
  });
  return d;
};
/** A temp repository with the Skills tooling plus fx-10h's manifests (all serverEnv reads). */
const repoWithFixtures = (): TempRepo => {
  const t = tempRepo();
  cleanups.push(t.cleanup);
  const fx = path.join(ROOT, "fixtures", "espn", "fx-10h");
  t.write(
    "fixtures/espn/fx-10h/manifest.json",
    readFileSync(path.join(fx, "manifest.json"), "utf8"),
  );
  for (const v of manifest.variants)
    t.write(
      `fixtures/espn/fx-10h/${v}/manifest.json`,
      readFileSync(path.join(fx, v, "manifest.json"), "utf8"),
    );
  return t;
};
const lane2 = (skill: string) =>
  (
    JSON.parse(readFileSync(path.join(ROOT, "skills", skill, "evals", "evals.json"), "utf8")) as {
      evals: Json[];
    }
  ).evals;
const triggers = (skill: string) =>
  JSON.parse(
    readFileSync(path.join(ROOT, "skills", skill, "evals", "trigger_eval.json"), "utf8"),
  ) as Json[];

describe("planSuite on the committed bundle", () => {
  const plan = planSuite(ROOT);
  const byDir = new Map(plan.cases.map((c) => [c.dir, c]));
  const file = (dir: string, rel: string) =>
    byDir.get(dir)?.files.find((f) => f.rel === rel)?.text ?? "";
  const graders = (dir: string) =>
    byDir.get(dir)?.files.filter((f) => f.rel.startsWith("graders/")) ?? [];

  it("maps every expectation of all thirteen Skills without a problem", () => {
    expect(plan.errors).toEqual([]);
  });

  it("has one case per Lane 2 case and per trigger, every one with a prompt and a grader", () => {
    let want = 0;
    for (const s of SKILLS) want += lane2(s).length + triggers(s).length;
    expect(plan.cases).toHaveLength(want);
    expect(new Set(plan.cases.map((c) => c.dir)).size).toBe(want);
    for (const c of plan.cases) {
      expect(c.files[0]?.rel, c.dir).toBe("prompt.md");
      expect(c.files.length, c.dir).toBeGreaterThan(1);
      expect(
        plan.plugins.map((p) => p.key),
        c.dir,
      ).toContain(c.plugin);
    }
  });

  it("states each case's toolset in its plugin: P1 Skills under full except -CORE, P0 under core except their P1 cases", () => {
    for (const s of SKILLS) {
      for (const c of lane2(s)) {
        const key = byDir.get(caseDir(s, String(c.name)))?.plugin ?? "";
        expect(key.split("--")[1], `${s}/${String(c.name)}`).toBe(c.toolset);
      }
    }
    expect(byDir.get("trade--tr-core")?.plugin).toBe("base--core");
    expect(byDir.get("waivers--wv-3-e")?.plugin).toBe("faab--full");
    expect(byDir.get("start-sit--ss-11-e")?.plugin).toBe("sunday-live--full");
    expect(byDir.get("news-check--nc-inj-2")?.plugin).toBe(
      pluginKey(null, "full", SEEDS["NC-INJ-2"]),
    );
  });

  it("writes prompt.md frontmatter the harness reads (only its keys; plugins point at the eval plugin)", () => {
    const allowed = [
      "name",
      "description",
      "tags",
      "plugins",
      "runs",
      "expected_outcome",
      "max_turns",
      "timeout_seconds",
      "allowed_tools",
    ];
    for (const c of plan.cases) {
      const fm = parseFrontmatter(file(c.dir, "prompt.md")).data;
      for (const k of Object.keys(fm)) expect(allowed, `${c.dir}: ${k}`).toContain(k);
      expect(fm.name).toBe(c.dir);
      expect(fm.plugins).toEqual([`../../plugins/${c.plugin}`]);
      expect(fm.runs).toBe(CASE_RUNS);
      expect(fm.allowed_tools).toContain(`${PREFIX}*`);
    }
  });

  it("every grader file has a known type and only that type's keys (the harness errors on unknown grader keys)", () => {
    const keys: Record<string, string[]> = {
      tool_order: ["type", "before", "after"],
      tool_used: ["type", "tool", "input_match", "min", "max", "arm"],
      regex: ["type", "pattern", "flags", "match", "target", "arm"],
      llm: ["type", "weight"],
    };
    for (const c of plan.cases) {
      for (const g of graders(c.dir)) {
        const fm = parseFrontmatter(g.text).data;
        const type = str(fm.type);
        expect(Object.keys(keys), `${c.dir}/${g.rel}`).toContain(type);
        for (const k of Object.keys(fm)) expect(keys[type], `${c.dir}/${g.rel}: ${k}`).toContain(k);
        if (typeof fm.pattern === "string")
          expect(() => new RegExp(fm.pattern as string, "i")).not.toThrow();
        if (typeof fm.input_match === "string")
          expect(() => new RegExp(fm.input_match as string)).not.toThrow();
        if (type === "tool_order") {
          expect(str(fm.before)).toMatch(new RegExp(`^${PREFIX.replace(/[-]/g, "\\-")}espn_`));
          expect(str(fm.after)).toMatch(/__espn_/);
        }
      }
    }
  });

  it("maps 'no write tool' to a trace guard in both arms, and the -INJ comparison carries the base reference", () => {
    const g = graders("trade--tr-inj").map((x) => x.text);
    expect(
      g.some((t) => t.includes(JSON.stringify(WRITE_TOOL_GUARD)) && t.includes('arm: "both"')),
    ).toBe(true);
    const base = String(lane2("trade").find((c) => c.name === "TR-1")?.expected_output);
    expect(
      g.some((t) =>
        t.includes(
          `Reference — the expected reply on the base fixture for the same prompt: ${base}`,
        ),
      ),
    ).toBe(true);
    expect(g.some((t) => t.includes("A reply that refuses to answer FAILS"))).toBe(true);
  });

  it("SC-2 carries a fresh synthetic value in its prompt and graders, never the placeholder", () => {
    const p = file("session-check--sc-2", "prompt.md");
    expect(p).not.toContain(SYNTHETIC_TOKEN);
    const value = /espn_s2: (\S+)/.exec(p)?.[1] ?? "";
    expect(value).toMatch(/^AEB[A-Za-z0-9%]{100,}$/);
    const g = graders("session-check--sc-2")
      .map((x) => x.text)
      .join("\n");
    expect(g).not.toContain(SYNTHETIC_TOKEN);
    expect(g).toContain(value.slice(0, 20));
    expect(
      planSuite(ROOT).cases.find((c) => c.dir === "session-check--sc-2")?.files[0]?.text,
    ).not.toContain(value);
  });

  it("WK-INJ's tool-input guard looks for its variant's planted text; KD-3's routing guard is on the Skill tool", () => {
    const wk = graders("weekly--wk-inj")
      .map((x) => x.text)
      .join("\n");
    expect(wk).toContain(INJECTION_NEEDLES["inj-teamname-json"]);
    const kd = parseFrontmatter(graders("stream-kdef--kd-3")[0]?.text ?? "").data;
    expect(kd).toMatchObject({ type: "tool_used", tool: "Skill", min: 0, max: 0, arm: "both" });
    expect(
      new RegExp(str(kd.input_match)).test('{"skill":"espn-fantasy-football:stream-kdef"}'),
    ).toBe(true);
    expect(
      new RegExp(str(kd.input_match)).test('{"skill":"espn-fantasy-football:start-sit"}'),
    ).toBe(false);
  });

  it("a trigger case fires its Skill (positive) or never does in either arm (negative)", () => {
    for (const s of SKILLS) {
      const list = triggers(s);
      let pos = 0;
      let neg = 0;
      for (const t of list) {
        const positive = t.should_trigger === true;
        const dir = `${s}--trigger-${positive ? "pos" : "neg"}-${String(positive ? ++pos : ++neg).padStart(2, "0")}`;
        expect(file(dir, "prompt.md"), dir).toContain(String(t.query));
        const g = parseFrontmatter(graders(dir)[0]?.text ?? "").data;
        expect(g.tool, dir).toBe("Skill");
        if (positive) expect(g.min).toBe(1);
        else expect(g).toMatchObject({ min: 0, max: 0, arm: "both" });
        const re = new RegExp(str(g.input_match));
        expect(re.test(`{"skill":"espn-fantasy-football:${s}"}`), dir).toBe(true);
        expect(re.test(`{"skill":"${s}"}`), dir).toBe(true);
        for (const o of SKILLS.filter((x) => x !== s && !x.endsWith(s)))
          expect(re.test(`{"skill":"espn-fantasy-football:${o}"}`), `${dir} vs ${o}`).toBe(false);
      }
    }
  });
});

describe("the injection needles stay tied to the planted texts", () => {
  it("cover exactly the six inj-* variants, each a fragment of scripts/fx10h/variants.ts INJECTIONS", () => {
    expect(Object.keys(INJECTION_NEEDLES).sort()).toEqual(
      manifest.variants.filter((v) => v.startsWith("inj-")).sort(),
    );
    const src = readFileSync(path.join(ROOT, "scripts", "fx10h", "variants.ts"), "utf8");
    const block =
      /export const INJECTIONS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(src)?.[1] ?? "";
    expect(block.length).toBeGreaterThan(100);
    for (const [v, needle] of Object.entries(INJECTION_NEEDLES)) expect(block, v).toContain(needle);
  });
});

describe("gradersFor (the tag → grader mapping)", () => {
  it("tool_order: one grader per consecutive pair of the tools named, in order", () => {
    const r = gradersFor(
      "The skill called espn_get_roster, espn_project_players, then espn_analyze_lineup (tool_order)",
      ctx,
    );
    expect(r.errors).toEqual([]);
    expect(r.graders.map((g) => [g.frontmatter.before, g.frontmatter.after])).toEqual([
      [`${PREFIX}espn_get_roster`, `${PREFIX}espn_project_players`],
      [`${PREFIX}espn_project_players`, `${PREFIX}espn_analyze_lineup`],
    ]);
  });

  it("tool_used: the first tool named, with input_match lookaheads, min/max/arm", () => {
    const r = gradersFor(
      "espn_analyze_lineup was called with objective auto and a compare pair (tool_used: input_match objective auto, compare non-empty, min 1 max 2, arm both)",
      ctx,
    );
    expect(r.errors).toEqual([]);
    const fm = r.graders[0]!.frontmatter;
    expect(fm).toMatchObject({
      type: "tool_used",
      tool: `${PREFIX}espn_analyze_lineup`,
      min: 1,
      max: 2,
      arm: "both",
    });
    const re = new RegExp(String(fm.input_match));
    expect(
      re.test(JSON.stringify({ week: 5, objective: "auto", compare: [{ out: 1, in: 2 }] })),
    ).toBe(true);
    expect(re.test(JSON.stringify({ objective: "auto", compare: [] }))).toBe(false);
    expect(re.test(JSON.stringify({ objective: "mean", compare: [{ out: 1 }] }))).toBe(false);
  });

  it("regex and regex_absent: the pattern on the final message, case-insensitive; absent = not_contains", () => {
    const a = gradersFor("The reply prints a p10 (regex: `p10`)", ctx).graders[0]!.frontmatter;
    expect(a).toEqual({ type: "regex", pattern: "p10", flags: "i" });
    const b = gradersFor("It never says coast (regex_absent: `\\bcoast(ing)? (is|ok)`)", ctx)
      .graders[0]!.frontmatter;
    expect(b).toEqual({
      type: "regex",
      pattern: "\\bcoast(ing)? (is|ok)",
      flags: "i",
      match: "not_contains",
    });
  });

  it("llm: the rubric carries the sentence and the case; 'judge sees both replies' adds the reference", () => {
    const one = gradersFor("The reply is clear (llm)", ctx).graders[0]!;
    expect(one.frontmatter).toEqual({ type: "llm", weight: 1 });
    expect(one.body).toMatch(/^PASS if: The reply is clear\./);
    expect(one.body).toContain("the expected reply");
    const two = gradersFor("Same as base (llm, judge sees both replies)", {
      ...ctx,
      reference: "REF",
    }).graders[0]!;
    expect(two.body).toContain("for the same prompt: REF");
  });

  it.each([
    ["The skill called espn_get_roster (tool_order)", /tool_order needs two tools/],
    ["Something was called (tool_used)", /tool_used names no tool/],
    [
      "espn_get_roster was called (tool_used: sometimes, maybe)",
      /tool_used spec not understood \(sometimes; maybe\)/,
    ],
    ["A file appeared (file_exists)", /no plugin-eval grader/],
    [
      "No value leaks (tool_used: no input_match on the substituted value)",
      /has nothing to match on this case/,
    ],
    [
      "No planted text leaks (tool_used: no input_match on the injected string)",
      /has nothing to match on this case/,
    ],
  ])("reports %j", (sentence, re) => {
    expect(gradersFor(sentence, ctx).errors.join("\n")).toMatch(re);
  });
});

describe("parseToolUsedSpec, inputPattern, toolInputPattern", () => {
  it("parses each part kind", () => {
    expect(
      parseToolUsedSpec("input_match mode auto, positions non-empty, min 2, max 4, arm with-only"),
    ).toMatchObject({
      pairs: [
        ["mode", "auto"],
        ["positions", "non-empty"],
      ],
      min: 2,
      max: 4,
      arm: "with-only",
      unknown: [],
    });
    expect(parseToolUsedSpec("every write tool min 0 max 0, arm both")).toMatchObject({
      writeGuard: true,
      arm: "both",
    });
    expect(parseToolUsedSpec("Skill stream-kdef min 0 max 0, arm both")).toMatchObject({
      skill: "stream-kdef",
      min: 0,
      max: 0,
    });
    expect(parseToolUsedSpec("min 0 max 0")).toMatchObject({ min: 0, max: 0 });
    expect(parseToolUsedSpec("mode auto").unknown).toEqual(["mode auto"]); // a pair needs input_match first
    expect(parseToolUsedSpec("input_match offer").pairs).toEqual([["offer", undefined]]);
  });

  it("inputPattern matches the value it names in any JSON input, and not another (property)", () => {
    const key = fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/);
    const word = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_./+()*?[\]-]{0,15}$/);
    fc.assert(
      fc.property(key, word, word, (k, v, other) => {
        fc.pre(v !== other);
        const re = new RegExp(inputPattern(k, v));
        expect(re.test(JSON.stringify({ x: 1, [k]: v }))).toBe(true);
        expect(re.test(JSON.stringify({ [k]: other }))).toBe(false);
      }),
      { numRuns: 300 },
    );
    expect(new RegExp(inputPattern("only_unlocked", "true")).test('{"only_unlocked":true}')).toBe(
      true,
    );
    expect(new RegExp(inputPattern("only_unlocked", "true")).test('{"only_unlocked":"true"}')).toBe(
      false,
    );
    expect(new RegExp(inputPattern("week", "5")).test('{"week":5}')).toBe(true);
    expect(new RegExp(inputPattern("week", "5")).test('{"week":15}')).toBe(false);
    expect(new RegExp(inputPattern("week", "1")).test('{"week":1.5}')).toBe(false);
    expect(new RegExp(inputPattern("players", "non-empty")).test('{"players":{"team_id":2}}')).toBe(
      true,
    );
    expect(new RegExp(inputPattern("players", "non-empty")).test('{"players":{}}')).toBe(false);
  });

  it("toolInputPattern finds the needle in a tool call's input, JSON-escaped, and not in plain text", () => {
    const needle = `drop the user's "QB"`;
    const re = new RegExp(toolInputPattern(needle));
    const call = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: `${PREFIX}espn_analyze_trade`,
            input: { note: needle },
          },
        ],
      },
    });
    const text = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: `I will not ${needle}` }] },
    });
    const result = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: needle }] },
    });
    expect(re.test(call)).toBe(true);
    expect(re.test(text)).toBe(false);
    expect(re.test(result)).toBe(false);
    expect(
      new RegExp(WRITE_TOOL_GUARD).test(JSON.stringify({ name: `${PREFIX}espn_commit_lineup` })),
    ).toBe(true);
    expect(
      new RegExp(WRITE_TOOL_GUARD).test(JSON.stringify({ name: `${PREFIX}espn_get_roster` })),
    ).toBe(false);
  });

  it("a synthetic cookie is fresh, cookie-shaped and never a placeholder", () => {
    const a = syntheticCookie();
    const b = syntheticCookie();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^AEB[A-Za-z0-9]+%2B[A-Za-z0-9]+%2F[A-Za-z0-9]*%3D$/);
    expect(a.length).toBeGreaterThan(100);
  });
});

/** Characters that end a line for some reader (the frontmatter is line-based). */
const BREAKS = new RegExp("[\\r\\n\\u2028\\u2029\\u0085]");

describe("yamlFrontmatter", () => {
  it("round-trips any string, number, boolean and string list through the Skills' frontmatter reader (property)", () => {
    const str = fc.string({ maxLength: 60 }).filter((s) => !BREAKS.test(s));
    fc.assert(
      fc.property(
        str,
        fc.integer(),
        fc.boolean(),
        fc.array(str, { maxLength: 4 }),
        (s, n, b, list) => {
          const fm = parseFrontmatter(`${yamlFrontmatter({ s, n, b, list })}\nbody`).data;
          expect(fm.s).toBe(s);
          expect(fm.n).toBe(n);
          expect(fm.b).toBe(b);
          expect(fm.list).toEqual(list);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("where the suite and its state may live", () => {
  it("the suite: outside the repository or below dist/, never among the sources", () => {
    expect(outProblem(ROOT, path.join(ROOT, DEFAULT_OUT))).toBeNull();
    expect(outProblem(ROOT, path.join(ROOT, "dist", "x", "y"))).toBeNull();
    expect(outProblem(ROOT, temp("eff-pe-out-"))).toBeNull();
    for (const bad of [
      "skills/evals",
      "evals",
      "tests/skills/x",
      "src",
      "dist",
      ".",
      "fixtures/espn/x",
    ])
      expect(outProblem(ROOT, path.join(ROOT, bad)), bad).not.toBeNull();
  });

  it("gitTreeOf finds the enclosing working tree, and none for a plain temp directory", () => {
    expect(gitTreeOf(path.join(ROOT, "skills", "trade"))).toBe(ROOT);
    const d = temp("eff-pe-git-");
    expect(gitTreeOf(d)).toBeNull();
    mkdirSync(path.join(d, "repo", ".git"), { recursive: true });
    mkdirSync(path.join(d, "repo", "a", "b"), { recursive: true });
    expect(gitTreeOf(path.join(d, "repo", "a", "b"))).toBe(path.join(d, "repo"));
  });

  it("serverEnv: fixture mode on the variant, the case's toolset, the stubs, private state; ESPN_TEAM_ID unset when the variant unsets it", () => {
    const e = serverEnv({ root: ROOT, variant: "inj-tradeblock", toolset: "full", state: "/s" });
    expect(e).toMatchObject({
      EFF_FIXTURE_DIR: path.join(ROOT, "fixtures", "espn", "fx-10h", "inj-tradeblock"),
      ESPN_LEAGUE_ID: "0",
      ESPN_TEAM_ID: "2",
      EFF_TOOLSET: "full",
      EFF_TEST_STUBS: "1",
      EFF_CONFIG_DIR: path.join("/s", "config"),
      EFF_CACHE_DIR: path.join("/s", "cache"),
      HOME: path.join("/s", "home"),
    });
    expect(
      serverEnv({ root: ROOT, variant: "owner-mismatch", toolset: "core", state: "/s" })
        .ESPN_TEAM_ID,
    ).toBeUndefined();
    expect(
      serverEnv({ root: ROOT, variant: "writes-on", toolset: "core", state: "/s" })
        .EFF_ENABLE_WRITES,
    ).toBe("true");
    expect(() =>
      serverEnv({ root: ROOT, variant: "no-such-variant", toolset: "core", state: "/s" }),
    ).toThrow(/no manifest\.json/);
  });
});

describe("buildPluginEvals on a copy", () => {
  it("writes the plugins, the cases, the README and a state root outside every git tree; a rebuild replaces both", () => {
    const t = repoWithFixtures();
    const out = temp("eff-pe-out-");
    const r = buildPluginEvals({ root: t.root, out, node: "/opt/node" });
    expect(r.errors).toEqual([]);
    cleanups.push(() => {
      if (r.state) rmSync(r.state, { recursive: true, force: true });
    });
    expect(r.state).not.toBeNull();
    expect(gitTreeOf(r.state!)).toBeNull();
    expect(readFileSync(path.join(out, STATE_ROOT_FILE), "utf8").trim()).toBe(r.state);
    expect(statSync(r.state!).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.join(out, "evals"))).toHaveLength(r.cases);
    expect(r.seedNeeded).toEqual([pluginKey(null, "full", SEEDS["NC-INJ-2"])]);
    for (const key of r.plugins) {
      const dir = path.join(out, "plugins", key);
      const plugin = JSON.parse(
        readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"),
      ) as Json;
      expect(plugin.name).toBe(manifest.plugin);
      const mcp = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8")) as {
        mcpServers: Record<
          string,
          { command: string; args: string[]; env: Record<string, string> }
        >;
      };
      const s = mcp.mcpServers[manifest.plugin]!;
      expect(s.command).toBe("/opt/node");
      expect(s.args).toEqual([
        "--import",
        path.join(t.root, NO_SOCKET),
        path.join(t.root, "dist", "cli.js"),
        "serve",
      ]);
      expect(s.env.EFF_TOOLSET).toBe(key.split("--")[1]);
      expect(s.env.EFF_TEST_STUBS).toBe("1");
      expect(s.env.EFF_CACHE_DIR?.startsWith(r.state!)).toBe(true);
      expect(statSync(path.join(r.state!, key, "cache")).mode & 0o777).toBe(0o700);
      expect(readdirSync(path.join(dir, "skills"))).toEqual([...SKILLS]);
      for (const s2 of SKILLS) {
        expect(existsSync(path.join(dir, "skills", s2, "evals"))).toBe(false);
        expect(readFileSync(path.join(dir, "skills", s2, "SKILL.md"), "utf8")).toBe(
          t.read(`skills/${s2}/SKILL.md`),
        );
      }
    }
    expect(readFileSync(path.join(out, "README.md"), "utf8")).toMatch(
      /--allow-tools "mcp__plugin_espn-fantasy-football_espn-fantasy-football__\*"/,
    );
    const again = buildPluginEvals({ root: t.root, out, node: "/opt/node" });
    cleanups.push(() => {
      if (again.state) rmSync(again.state, { recursive: true, force: true });
    });
    expect(again.errors).toEqual([]);
    expect(again.state).not.toBe(r.state);
    expect(existsSync(r.state!)).toBe(false);
  });

  it("refuses an output among the sources, a state root inside a git tree, and a stale bundle", () => {
    const t = repoWithFixtures();
    expect(buildPluginEvals({ root: t.root, out: t.p("skills/out") }).errors.join()).toMatch(
      /--out must be/,
    );
    const git = temp("eff-pe-git-");
    mkdirSync(path.join(git, ".git"));
    expect(
      buildPluginEvals({
        root: t.root,
        out: temp("eff-pe-out-"),
        state: path.join(git, "s"),
      }).errors.join(),
    ).toMatch(/--state must be outside every git working tree/);
    t.write("skills/apply/references/log.md", "tampered\n");
    expect(buildPluginEvals({ root: t.root, out: temp("eff-pe-out-") }).errors.join()).toMatch(
      /stale/,
    );
  });

  it("refuses an expectation it cannot map, naming the case", () => {
    const t = repoWithFixtures();
    t.editJson("skills/retro/evals/evals.json", (j) => {
      ((j.evals as Json[])[0]!.expectations as string[]).push("A file appeared (file_exists)");
    });
    expect(buildPluginEvals({ root: t.root, out: temp("eff-pe-out-") }).errors.join("\n")).toMatch(
      /skills\/retro\/evals\/evals\.json RT-1: no plugin-eval grader/,
    );
  });

  it("main: exit 2 on a bad argument, 0 on a build, 1 when --seed finds no dist/", async () => {
    const t = repoWithFixtures();
    expect(await main(["--frobnicate"])).toBe(2);
    const out = temp("eff-pe-out-");
    const state = path.join(temp("eff-pe-state-"), "s");
    expect(await main(["--root", t.root, "--out", out, "--state", state])).toBe(0);
    expect(readFileSync(path.join(out, STATE_ROOT_FILE), "utf8").trim()).toBe(state);
    expect(await main(["--root", t.root, "--out", out, "--state", state, "--seed"])).toBe(1);
    expect(await main(["--root", t.root, "--out", t.p("src/x")])).toBe(1);
  });
});

// --- the seed, against a fake server ------------------------------------------------------------------

interface FakeServer {
  readonly spawnImpl: NonNullable<Parameters<typeof seedLogWeek4>[0]["spawnImpl"]>;
  readonly calls: { method: string; params: Json }[];
  readonly spawned: { cmd: string; args: string[]; env: Record<string, string> }[];
  stdin: PassThrough | null;
  killed: boolean;
}
/** Whether the seed closed the server's stdin. */
const ended = (s: FakeServer) => s.stdin?.writableEnded === true;

/** A fake MCP server over two PassThrough streams; `answer` decides each reply (null = silence). */
function fakeServer(
  answer: (method: string, params: Json) => unknown,
  opts: { exitOn?: string; garbage?: boolean } = {},
): FakeServer {
  const state: FakeServer = {
    calls: [],
    spawned: [],
    stdin: null,
    killed: false,
    spawnImpl: (cmd, args, o) => {
      state.spawned.push({ cmd, args, env: o.env });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const ev = new EventEmitter();
      let buf = "";
      stdin.on("data", (chunk: Buffer) => {
        buf += String(chunk);
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const msg = JSON.parse(buf.slice(0, i)) as { id?: number; method: string; params: Json };
          buf = buf.slice(i + 1);
          state.calls.push({ method: msg.method, params: msg.params });
          if (msg.id === undefined) continue;
          const name = msg.method === "tools/call" ? String(msg.params.name) : msg.method;
          if (opts.exitOn === name) {
            setImmediate(() => ev.emit("exit", 3));
            continue;
          }
          if (opts.garbage === true && name === "espn_get_league") {
            stdout.write("not json\n");
            continue;
          }
          const result = answer(name, msg.params);
          if (result === null) continue;
          stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n`,
          );
          stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...(isErr(result) ? { error: result.error } : { result }) })}\n`,
          );
        }
      });
      state.stdin = stdin;
      return {
        stdin,
        stdout,
        stderr: null,
        on: (e: "exit", fn: (code: number | null) => void) => ev.on(e, fn),
        kill: () => {
          state.killed = true;
        },
      };
    },
  };
  return state;
}
const isErr = (r: unknown): r is { error: Json } =>
  typeof r === "object" && r !== null && "error" in r;
const text = (body: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  ...(isError ? { isError: true } : {}),
});
const REC = { action: "Start the FLEX receiver", log_id: null, distribution: { p10: 1, p90: 2 } };
const happy = (name: string, params: Json): unknown => {
  if (name === "initialize") return { protocolVersion: "2025-06-18", capabilities: {} };
  if (name === "espn_get_league")
    return text({
      data: { scoring: { settings_hash: "a".repeat(64) } },
      meta: { request_id: "r-000000000001" },
    });
  if (name === "espn_analyze_lineup")
    return text({ data: { rec: REC }, meta: { request_id: "r-000000000002" } });
  if (name === "espn_record_recommendation") {
    expect((params.arguments as Json).note).toBe(SEED_NOTE);
    return text({ data: { log_id: "rec-01ABC" } });
  }
  return null;
};

describe("the NC-INJ-2 seed (seedLogWeek4, over the real tools' JSON-RPC)", () => {
  it("initializes, reads the league, takes a week-4 lineup rec and logs it as week-4 evidence with the order in its note", async () => {
    const s = fakeServer(happy);
    const id = await seedLogWeek4({
      root: "/repo",
      node: "/n",
      env: { A: "1" },
      spawnImpl: s.spawnImpl,
    });
    expect(id).toBe("rec-01ABC");
    expect(s.spawned).toEqual([
      {
        cmd: "/n",
        args: [
          "--import",
          path.join("/repo", NO_SOCKET),
          path.join("/repo", "dist", "cli.js"),
          "serve",
        ],
        env: { A: "1" },
      },
    ]);
    expect(
      s.calls.map((c) => (c.method === "tools/call" ? String(c.params.name) : c.method)),
    ).toEqual([
      "initialize",
      "notifications/initialized",
      "espn_get_league",
      "espn_analyze_lineup",
      "espn_record_recommendation",
    ]);
    const lineup = s.calls[3]!.params.arguments as Json;
    expect(lineup).toEqual({ week: 4, objective: "auto" });
    const rec = s.calls[4]!.params.arguments as Json;
    expect(rec).toMatchObject({
      kind: "evidence",
      week: 4,
      rec: REC,
      source_calls: [{ tool: "espn_analyze_lineup", request_id: "r-000000000002" }],
      settings_hash: "a".repeat(64),
      note: SEED_NOTE,
    });
    expect(ended(s)).toBe(true);
    expect(s.killed).toBe(true);
  });

  it.each([
    [
      "the server dies",
      fakeServer(happy, { exitOn: "espn_analyze_lineup" }),
      /exited \(code 3\) before answering/,
    ],
    [
      "a JSON-RPC error",
      fakeServer((n, p) =>
        n === "espn_get_league" ? { error: { code: -32602, message: "bad" } } : happy(n, p),
      ),
      /JSON-RPC error: bad/,
    ],
    [
      "an error result",
      fakeServer((n, p) =>
        n === "espn_record_recommendation"
          ? text({ error: { code: "VALIDATION" } }, true)
          : happy(n, p),
      ),
      /espn_record_recommendation: VALIDATION/,
    ],
    [
      "no rec",
      fakeServer((n, p) =>
        n === "espn_analyze_lineup" ? text({ data: {}, meta: {} }) : happy(n, p),
      ),
      /returned no rec/,
    ],
    [
      "no log id",
      fakeServer((n, p) => (n === "espn_record_recommendation" ? text({ data: {} }) : happy(n, p))),
      /returned no log_id/,
    ],
    ["a line that is not JSON-RPC", fakeServer(happy, { garbage: true }), /not JSON-RPC/],
  ])("fails loudly when %s, and still closes the server", async (_l, s, re) => {
    await expect(
      seedLogWeek4({ root: "/r", node: "/n", env: {}, spawnImpl: s.spawnImpl, timeoutMs: 5000 }),
    ).rejects.toThrow(re);
    expect(ended(s)).toBe(true);
    expect(s.killed).toBe(true);
  });

  it("times out on a silent server", async () => {
    const s = fakeServer((n, p) => (n === "espn_get_league" ? null : happy(n, p)));
    await expect(
      seedLogWeek4({ root: "/r", node: "/n", env: {}, spawnImpl: s.spawnImpl, timeoutMs: 50 }),
    ).rejects.toThrow(/espn_get_league: no answer within 50 ms/);
  });

  it("envelopeOf refuses a result without a text block or with a non-object body", () => {
    expect(() => envelopeOf({ content: [] }, "t")).toThrow(/without a text block/);
    expect(() => envelopeOf({ content: [{ type: "text", text: "[1]" }] }, "t")).toThrow(
      /not an envelope/,
    );
    expect(envelopeOf(text({ data: 1 }), "t")).toEqual({ data: 1 });
  });

  it("writeSeeds reads each seeded plugin's server env and needs dist/cli.js", async () => {
    const t = repoWithFixtures();
    const out = temp("eff-pe-out-");
    const r = buildPluginEvals({ root: t.root, out, node: "/n" });
    cleanups.push(() => {
      if (r.state) rmSync(r.state, { recursive: true, force: true });
    });
    await expect(
      writeSeeds({ root: t.root, out, node: "/n", seedNeeded: r.seedNeeded }),
    ).rejects.toThrow(/dist\/cli\.js is missing/);
    t.write("dist/cli.js", "// stand-in\n");
    const s = fakeServer(happy);
    const done = await writeSeeds({
      root: t.root,
      out,
      node: "/n",
      seedNeeded: r.seedNeeded,
      spawnImpl: s.spawnImpl,
    });
    expect(done).toEqual([`${r.seedNeeded[0]!}: logged rec-01ABC`]);
    expect(s.spawned[0]?.env.EFF_CACHE_DIR?.startsWith(r.state!)).toBe(true);
    expect(s.spawned[0]?.env.PATH).toBeDefined();
    expect(await writeSeeds({ root: t.root, out, node: "/n", seedNeeded: [] })).toEqual([]);
  });

  it("rpcOver ignores notifications and answers for unknown ids", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const ev = new EventEmitter();
    const rpc = rpcOver(
      { stdin, stdout, on: (e, fn) => ev.on(e, fn), kill: () => undefined },
      1000,
    );
    const p = rpc.request("ping", {});
    stdout.write(
      '{"jsonrpc":"2.0","method":"note"}\n{"jsonrpc":"2.0","id":99,"result":1}\n\n{"jsonrpc":"2.0","id":1,"result":"pong"}\n',
    );
    await expect(p).resolves.toBe("pong");
  });
});

it("writes nothing under the repository's sources when run with the defaults (the build output is git-ignored)", () => {
  writeFileSync(path.join(temp("eff-pe-noop-"), "x"), "");
  expect(DEFAULT_OUT.startsWith("dist/")).toBe(true);
  expect(readFileSync(path.join(ROOT, ".gitignore"), "utf8")).toMatch(/^\/dist\/$/m);
});
