// check-skills.test.ts — scripts/skills/check-skills.mjs, Lane 1 (plan 09 §5.1 items 1–6, K4–K7;
// research 06 §C.3, §E.3; plan 10 A14a): the real bundle passes; every rule fails on a mutated
// private copy, adversarially (hostile strings, unicode, boundaries); the identifier rules never
// echo what they matched.
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DESCRIPTION_MAX,
  GAME_DAY_PROMPTS,
  SKILLS_LISTING_MAX,
  bodyRecordKinds,
  checkArgType,
  checkSkills,
  graderOf,
  identifierFindings,
  jaccard,
  main,
  phrases,
  recKindOf,
  routeScore,
  timeReference,
  tokenize,
  toolRefs,
  triggerCollisions,
  unknownConstants,
  validateTriggers,
} from "../../scripts/skills/check-skills.mjs";
import { buildSkills } from "../../scripts/skills/build-skills.mjs";
import { ROOT, emptyDenylist, runScript, tempRepo, type TempRepo } from "./helpers.js";

let deny: ReturnType<typeof emptyDenylist>;
beforeAll(() => {
  deny = emptyDenylist();
});
afterAll(() => {
  deny.cleanup();
});

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});
const fresh = (): TempRepo => {
  repo = tempRepo();
  return repo;
};
/** Run the checker on a copy (no scanner unless asked) and return its errors joined. */
const errorsOf = (t: TempRepo, scan = false): string => {
  const r = checkSkills({ root: t.root, scan, scanEnv: deny.env });
  return r.errors.join("\n");
};
/** Edit a Skill file in the copy, rebuild nothing: the checker must see the raw edit. */
const SEQ = (s: string) => `skills/${s}/evals/tool_sequence.json`;
const EVALS = (s: string) => `skills/${s}/evals/evals.json`;
const TRIG = (s: string) => `skills/${s}/evals/trigger_eval.json`;
type Json = Record<string, unknown>;
interface Step {
  id: string;
  tool: string;
  args: Json;
  expect?: string[];
}
interface Seq {
  id: string;
  steps: Step[];
  fixture_variant?: string;
}
const seqs = (j: Json) => j.sequences as Seq[];
const cases = (j: Json) => j.evals as Json[];

describe("the committed bundle", () => {
  it("passes every Lane 1 check, scanner included (empty deny-list: identical locally and in CI)", () => {
    const r = checkSkills({ root: ROOT, scan: true, scanEnv: deny.env });
    expect(r.errors).toEqual([]);
    expect(r.skills).toHaveLength(13);
  });

  it("the CLI agrees, and says which cross-checks are pending", () => {
    const r = runScript("check-skills.mjs", [], deny.env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/OK — 13 Skill\(s\)/);
  });
});

describe("frontmatter (plan 09 §2, §5.1 item 1)", () => {
  const rules: [string, (t: TempRepo) => void, RegExp][] = [
    [
      "a description over 350 characters",
      (t) => {
        t.edit(
          "skills/retro/SKILL.md",
          /^description: (.*)$/m,
          `description: ${"x".repeat(DESCRIPTION_MAX)} in the user's ESPN league`,
        );
      },
      /plan 09 cap 350/,
    ],
    [
      "a description over the platform's 1 024",
      (t) => {
        t.edit(
          "skills/retro/SKILL.md",
          /^description: (.*)$/m,
          `description: in the user's ESPN league ${"y".repeat(1100)}`,
        );
      },
      /platform max 1024/,
    ],
    [
      "a description without the platform words",
      (t) => {
        t.edit("skills/retro/SKILL.md", "in the user's ESPN league", "in a league");
      },
      /must contain "in the user's ESPN league"/,
    ],
    [
      "a second-person description",
      (t) => {
        t.edit("skills/retro/SKILL.md", "Reviews last week's", "Reviews your");
      },
      /third person/,
    ],
    [
      "an XML tag in the description",
      (t) => {
        t.edit("skills/retro/SKILL.md", "Reviews last", "Reviews <b>last</b>");
      },
      /XML tags/,
    ],
    [
      "no when_to_use",
      (t) => {
        t.edit("skills/retro/SKILL.md", /^when_to_use: .*\n/m, "");
      },
      /when_to_use is required/,
    ],
    [
      "description + when_to_use over 1 536",
      (t) => {
        t.edit(
          "skills/retro/SKILL.md",
          /^when_to_use: (.*)$/m,
          `when_to_use: ${"review, ".repeat(160)}regret`,
        );
      },
      /max 1536/,
    ],
    [
      "an unknown key",
      (t) => {
        t.edit("skills/retro/SKILL.md", "argument-hint:", "model: x\nargument-hint:");
      },
      /unknown frontmatter key `model`/,
    ],
    [
      "a name that is not the directory",
      (t) => {
        t.edit("skills/retro/SKILL.md", "name: retro", "name: retrospective");
      },
      /must equal the directory name/,
    ],
    [
      "a reserved word in the name",
      (t) => {
        t.edit("skills/retro/SKILL.md", "name: retro", "name: claude-retro");
      },
      /reserved word/,
    ],
    [
      "a long argument-hint",
      (t) => {
        t.edit(
          "skills/retro/SKILL.md",
          'argument-hint: "[week]"',
          `argument-hint: "${"w".repeat(90)}"`,
        );
      },
      /argument-hint/,
    ],
    [
      "a stray metadata key",
      (t) => {
        t.edit("skills/retro/SKILL.md", "  tool_contract: 1", "  tool_contract: 1\n  extra: 1");
      },
      /metadata has unknown keys extra/,
    ],
    [
      "a missing disallowed-tools string",
      (t) => {
        t.edit("skills/weekly/SKILL.md", '  - "mcp__espn-fantasy-football__espn_commit_*"\n', "");
      },
      /weekly\/SKILL\.md: disallowed-tools must list mcp__espn-fantasy-football__espn_commit_\*/,
    ],
    [
      "disallowed-tools as a scalar",
      (t) => {
        t.edit(
          "skills/retro/SKILL.md",
          /disallowed-tools:\n(?: {2}- .*\n)+/,
          "disallowed-tools: none\n",
        );
      },
      /must be a list/,
    ],
    [
      "apply without disable-model-invocation",
      (t) => {
        t.edit("skills/apply/SKILL.md", "disable-model-invocation: true\n", "");
      },
      /apply must set disable-model-invocation: true/,
    ],
    [
      "disable-model-invocation on another Skill",
      (t) => {
        t.edit(
          "skills/retro/SKILL.md",
          "argument-hint:",
          "disable-model-invocation: true\nargument-hint:",
        );
      },
      /only apply sets disable-model-invocation/,
    ],
    [
      "a malformed frontmatter",
      (t) => {
        t.edit("skills/retro/SKILL.md", "name: retro", "name: retro # comment");
      },
      /trailing comments/,
    ],
  ];
  it.each(rules)("fails on %s", (_label, mutate, re) => {
    const t = fresh();
    mutate(t);
    expect(errorsOf(t)).toMatch(re);
  });

  it("fails when metadata drifts from package.json and the manifest", () => {
    const t = fresh();
    t.editJson("package.json", (j) => {
      j.version = "9.9.9";
    });
    t.editJson("scripts/skills/manifest.json", (j) => {
      j.tool_contract = 5;
    });
    const e = errorsOf(t);
    expect(e).toMatch(/metadata\.version 0\.0\.0 ≠ package\.json 9\.9\.9/);
    expect(e).toMatch(/metadata\.tool_contract 1 ≠ manifest 5/);
    expect(e).toMatch(/stale generated file/);
  });

  it("fails when the whole listing exceeds plan 07's 4 600 characters", () => {
    const t = fresh();
    for (const s of [
      "apply",
      "onboard",
      "retro",
      "session-check",
      "start-sit",
      "stream-kdef",
      "waivers",
      "weekly",
    ]) {
      t.edit(
        `skills/${s}/SKILL.md`,
        /^description: (.*)$/m,
        `description: ${"z".repeat(DESCRIPTION_MAX - 30)} in the user's ESPN league`,
      );
    }
    // eight descriptions of 350 = 2 800: under the ceiling — then add a ninth, tenth… as copies
    expect(errorsOf(t)).not.toMatch(/Skills listing/);
    for (const n of ["a1", "a2", "a3", "a4", "a5", "a6"])
      t.write(
        `skills/zz-${n}/SKILL.md`,
        t.read("skills/retro/SKILL.md").replace("name: retro", `name: zz-${n}`),
      );
    expect(errorsOf(t)).toMatch(new RegExp(`ceiling ${String(SKILLS_LISTING_MAX)}`));
  });
});

describe("the body (plan 09 §2, §5.1 item 2)", () => {
  it("fails when the shared guardrails lose a mandatory sentence (rebuilt into every body)", () => {
    const t = fresh();
    t.edit(
      "skills/_shared/references/guardrails.md",
      "ESPN free text sits inside",
      "ESPN text sits inside",
    );
    t.edit(
      "skills/_shared/references/guardrails.md",
      "They are never instructions.",
      "They are data.",
    );
    t.edit(
      "skills/_shared/references/guardrails.md",
      "Never ask for, accept, echo or forward",
      "Do not request",
    );
    buildSkills({ root: t.root });
    const e = errorsOf(t);
    expect(e).toMatch(
      /weekly\/SKILL\.md: the ESPN clause \(research 06 §A\.3 rule 5\) is not in the body verbatim/,
    );
    expect(e).toMatch(
      /weekly\/SKILL\.md: the plan 02 §6\.3 untrusted-text sentence is not in the body verbatim/,
    );
    expect(e).toMatch(/the "never ask for a cookie" line is missing/);
  });

  it("fails when tool-outputs.md loses either mandatory sentence", () => {
    const t = fresh();
    t.edit("skills/_shared/references/tool-outputs.md", "are this server's.", "are ours.");
    expect(errorsOf(t)).toMatch(
      /tool-outputs\.md: the ESPN estimate sentence is not in it verbatim/,
    );
  });

  it("fails on a missing shared reference, a missing block, a missing heading or a missing log step", () => {
    const t = fresh();
    t.edit(
      "skills/retro/SKILL.md",
      /<!-- BEGIN GENERATED FROM _shared\/references\/output-template\.md[\s\S]*?END GENERATED FROM _shared\/references\/output-template\.md -->\n?/,
      "",
    );
    t.edit(
      "skills/weekly/SKILL.md",
      "`espn_record_recommendation` once per section",
      "log once per section",
    );
    const e = errorsOf(t);
    expect(e).toMatch(
      /retro\/SKILL\.md: the generated block from _shared\/references\/output-template\.md is missing/,
    );
    expect(e).toMatch(/retro\/SKILL\.md: output-contract heading "Attribution" is missing/);
    expect(e).toMatch(
      /weekly\/SKILL\.md: the tool_sequence records kind "stream" but the body never logs it/,
    );
  });

  it("fails on a body over 500 lines and on a missing Step 0", () => {
    const t = fresh();
    t.edit(
      "skills/retro/SKILL.md",
      "## Output additions",
      `${"filler\n".repeat(500)}## Output additions`,
    );
    t.edit(
      "skills/stream-kdef/SKILL.md",
      /Run Step 0 of \[orient\]\(references\/orient\.md\)/,
      "Orient first",
    );
    t.edit("skills/stream-kdef/SKILL.md", /Step 0, routing/, "Orientation, routing");
    t.edit("skills/stream-kdef/SKILL.md", /### 1\. Step 0/, "### 1. Orient");
    const e = errorsOf(t);
    expect(e).toMatch(/retro\/SKILL\.md: body is \d+ lines \(max 500\)/);
    expect(e).toMatch(/stream-kdef\/SKILL\.md: the body must run Step 0/);
  });

  it("fails when a Skill drops a plan 09 §3 Lane 1 body promise", () => {
    const t = fresh();
    t.edit("skills/retro/SKILL.md", /not informative in v1/g, "zero in v1");
    t.edit("skills/start-sit/SKILL.md", /only_unlocked/g, "unlocked_only");
    t.edit("skills/apply/SKILL.md", /PHASE W SEAM — NOT IMPLEMENTED/g, "no write module");
    const e = errorsOf(t);
    expect(e).toMatch(/retro\/SKILL\.md: body must mention \/not informative in v1\//);
    expect(e).toMatch(/start-sit\/SKILL\.md: body must mention \/only_unlocked\//);
    expect(e).toMatch(/apply\/SKILL\.md: body must mention \/PHASE W SEAM — NOT IMPLEMENTED\//);
  });
});

describe("tool names, error codes and links (plan 09 §5.1 items 3–4; research 06 §C.3 items 1, 7)", () => {
  it("fails on an unregistered tool, a P1 tool off a P1 line, a write tool, a qualified name and a dead wildcard", () => {
    const t = fresh();
    t.edit(
      "skills/retro/SKILL.md",
      "## Output additions",
      "Call `espn_get_everything` too.\n\nThen `espn_analyze_trade` for context.\n\nNever `espn_commit_lineup`.\n\nOr `mcp__espn-fantasy-football__espn_get_status`.\n\nAnd `espn_frobnicate_*` maybe.\n\n## Output additions",
    );
    const e = errorsOf(t);
    expect(e).toMatch(/retro\/SKILL\.md: espn_get_everything is not a registered tool/);
    expect(e).toMatch(/retro\/SKILL\.md: espn_analyze_trade is a P1 tool — label the step/);
    expect(e).toMatch(/retro\/SKILL\.md: names the write tool espn_commit_lineup — PHASE W SEAM/);
    expect(e).toMatch(/retro\/SKILL\.md: a qualified tool name \(mcp__…\) in prose/);
  });

  it("accepts a P1 tool on a P1-labelled line, and refuses a write wildcard even in apply", () => {
    const t = fresh();
    t.edit(
      "skills/retro/SKILL.md",
      "## Output additions",
      "(P1; `espn_analyze_trade` under `full`.)\n\n**P1:** `espn_get_news` too.\n\n## Output additions",
    );
    t.edit("skills/apply/SKILL.md", "## Output\n", "Never `espn_prepare_*`.\n\n## Output\n");
    const e = errorsOf(t);
    // labelled, so not "a P1 tool off a P1 line" — but a P1 step no full sequence calls (§5.1 item 3)
    expect(e).not.toMatch(/espn_analyze_trade is a P1 tool/);
    expect(e).not.toMatch(/espn_get_news is a P1 tool/);
    expect(e).toMatch(
      /retro\/evals\/tool_sequence\.json: the body's P1 step espn_analyze_trade is in no sequence/,
    );
    expect(e).toMatch(/apply\/SKILL\.md: names the write tools "espn_prepare_\*"/);
  });

  it("fails on an invented error code and passes ESPN's TRAN_* types and the allowed constants", () => {
    const t = fresh();
    t.edit(
      "skills/retro/SKILL.md",
      "## Output additions",
      "On `ESPN_COOKIE_EXPIRED` stop; ESPN may show `TRAN_ANYTHING_NEW`; `OUT` stays.\n\n## Output additions",
    );
    const e = errorsOf(t);
    expect(e).toMatch(/`ESPN_COOKIE_EXPIRED` is not an error code/);
    expect(e).not.toMatch(/TRAN_ANYTHING_NEW/);
  });

  it("fails on a dead link, a link out of the Skill, and a link between references", () => {
    const t = fresh();
    t.edit(
      "skills/retro/SKILL.md",
      "## Output additions",
      "[gone](references/nope.md) [out](../weekly/SKILL.md) [web](https://example.com) [anchor](#x)\n\n## Output additions",
    );
    t.write("skills/retro/references/retro-extra.md", "see [orient](orient.md)\n");
    const e = errorsOf(t);
    expect(e).toMatch(/link "references\/nope\.md" points to a missing file/);
    expect(e).toMatch(/link "\.\.\/weekly\/SKILL\.md" leaves the Skill directory/);
    expect(e).toMatch(/retro-extra\.md: references must not link to other files/);
    expect(e).not.toMatch(/example\.com/);
  });
});

describe("tool_sequence.json (plan 09 §5.1 items 3 and 7)", () => {
  type M = [string, string, (j: Json) => void, RegExp];
  const first = (j: Json) => seqs(j)[0]!;
  const stepOf = (j: Json, id: string) => first(j).steps.find((s) => s.id === id)!;
  const mutations: M[] = [
    [
      "a first step that is not Step 0",
      "retro",
      (j) => first(j).steps.shift(),
      /the first step must be espn_get_status/,
    ],
    [
      "an unknown tool",
      "retro",
      (j) => (stepOf(j, "scoreboard").tool = "espn_get_scores"),
      /espn_get_scores is not a registered tool/,
    ],
    [
      "a P1 tool under core",
      "retro",
      (j) => (stepOf(j, "scoreboard").tool = "espn_analyze_matchup"),
      /is a P1 tool; this sequence runs under EFF_TOOLSET=core/,
    ],
    [
      "a write tool",
      "retro",
      (j) => (stepOf(j, "scoreboard").tool = "espn_commit_lineup"),
      /is a write tool — PHASE W SEAM/,
    ],
    [
      "an unknown argument",
      "retro",
      (j) => (stepOf(j, "scoreboard").args.weeks = [4]),
      /espn_get_scoreboard has no input `weeks`/,
    ],
    [
      "a bad enum value",
      "weekly",
      (j) => (stepOf(j, "lineup").args.objective = "maximize"),
      /objective must be one of auto\|mean\|pwin\|blend\|points_only/,
    ],
    [
      "an out-of-range week",
      "retro",
      (j) => (stepOf(j, "scoreboard").args.week = 19),
      /week must be an integer in 1\.\.18/,
    ],
    [
      "a fractional count",
      "retro",
      (j) => (stepOf(j, "txns").args.count = 2.5),
      /count must be an integer/,
    ],
    [
      "a bad selector",
      "weekly",
      (j) => (stepOf(j, "injuries").args.players = { team: 2 }),
      /PlayerSelector has no `team`/,
    ],
    [
      "a two-key selector",
      "weekly",
      (j) => (stepOf(j, "injuries").args.players = { team_id: 2, nfl_team: "KC" }),
      /exactly one key/,
    ],
    [
      "a missing required input",
      "onboard",
      (j) => delete stepOf(j, "box").args.week,
      /espn_get_box_score needs `week`/,
    ],
    [
      "a $ref to a later step",
      "retro",
      (j) => (stepOf(j, "scoreboard").args.week = { $ref: "retro.data.week" }),
      /names no earlier step/,
    ],
    [
      "a malformed $ref",
      "retro",
      (j) => (stepOf(j, "record").args.rec = { $ref: "retro" }),
      /\$ref must be "<step id>\.<path>"/,
    ],
    [
      "a $source_calls naming a step twice",
      "retro",
      (j) => (stepOf(j, "record").args.source_calls = { $source_calls: ["retro", "retro"] }),
      /lists a step twice/,
    ],
    [
      "a $opponent on a non-scoreboard step",
      "weekly",
      (j) => ((stepOf(j, "proj_opp").args.players as Json).team_id = { $opponent: "league" }),
      /\$opponent must name an earlier espn_get_scoreboard step/,
    ],
    [
      "an unknown $ form",
      "retro",
      (j) => (stepOf(j, "record").args.rec = { $env: "X" }),
      /unknown \$env/,
    ],
    [
      "a two-key $-object",
      "retro",
      (j) => (stepOf(j, "record").args.rec = { $ref: "retro.data.rec", x: 1 }),
      /exactly one key/,
    ],
    [
      "a record kind that is not the producer's",
      "retro",
      (j) => (stepOf(j, "record").args.kind = "lineup"),
      /record kind "lineup" is not one of retro/,
    ],
    [
      "a step after the record",
      "retro",
      (j) => first(j).steps.push({ id: "late", tool: "espn_get_standings", args: {} }),
      /espn_get_standings after espn_record_recommendation/,
    ],
    [
      "a record without settings_hash",
      "retro",
      (j) => delete stepOf(j, "record").args.settings_hash,
      /needs `settings_hash`/,
    ],
    [
      "an expect that is not an error code",
      "retro",
      (j) => (stepOf(j, "txns").expect = ["MAYBE"]),
      /expect must list "ok"/,
    ],
    [
      "an unknown step key",
      "retro",
      (j) => ((stepOf(j, "txns") as unknown as Json).retries = 2),
      /unknown keys retries/,
    ],
    [
      "a duplicate step id",
      "retro",
      (j) => (stepOf(j, "txns").id = "scoreboard"),
      /duplicate step id scoreboard/,
    ],
    [
      "an unknown variant",
      "weekly",
      (j) => (seqs(j)[1]!.fixture_variant = "monday-night"),
      /fixture_variant must be one of the fx-10h variants/,
    ],
    ["a wrong toolset", "retro", (j) => (j.toolset = "full"), /toolset must be "core"/],
    [
      "a fixture env pointing elsewhere",
      "retro",
      (j) => (((j.fixture as Json).env as Json).ESPN_LEAGUE_ID = "1"),
      /fixture\.env must set/,
    ],
    [
      "a tool_contract drift",
      "retro",
      (j) => (j.tool_contract = 2),
      /tool_contract 2 ≠ manifest 1/,
    ],
    ["a wrong skill name", "retro", (j) => (j.skill = "weekly"), /skill must be "retro"/],
    ["no sequences", "retro", (j) => (j.sequences = []), /sequences must be a non-empty array/],
  ];
  it.each(mutations)("fails on %s", (_label, skill, mutate, re) => {
    const t = fresh();
    t.editJson(SEQ(skill), mutate);
    expect(errorsOf(t)).toMatch(re);
  });

  it("fails when a waiver rec is logged as a lineup and a K/D-ST rec as a waiver", () => {
    const t = fresh();
    t.editJson(SEQ("weekly"), (j) => {
      const s = seqs(j)[0]!.steps;
      s.find((x) => x.id === "record_waivers")!.args.kind = "lineup";
      s.find((x) => x.id === "record_k")!.args.kind = "waiver";
    });
    const e = errorsOf(t);
    expect(e).toMatch(/logs espn_analyze_waivers's rec as kind "lineup" — it is a "waiver" rec/);
    expect(e).toMatch(/logs espn_analyze_waivers's rec as kind "waiver" — it is a "stream" rec/);
  });

  const skillRules: [string, string, (j: Json) => void, RegExp][] = [
    [
      "start-sit without a game_day sequence",
      "start-sit",
      (j) => (j.sequences = seqs(j).filter((s) => s.id !== "game_day")),
      /no `game_day` sequence/,
    ],
    [
      "start-sit's game day without only_unlocked",
      "start-sit",
      (j) =>
        delete seqs(j)
          .find((s) => s.id === "game_day")!
          .steps.find((s) => s.id === "lineup")!.args.only_unlocked,
      /must carry only_unlocked: true/,
    ],
    [
      "start-sit's game day without the live scoreboard",
      "start-sit",
      (j) => {
        const g = seqs(j).find((s) => s.id === "game_day")!;
        g.steps = g.steps.filter((s) => s.tool !== "espn_get_live_scoreboard");
      },
      /must call espn_get_live_scoreboard/,
    ],
    [
      "start-sit forcing two refreshes",
      "start-sit",
      (j) => {
        const g = seqs(j).find((s) => s.id === "game_day")!;
        g.steps.splice(3, 0, {
          id: "fresh2",
          tool: "espn_get_roster",
          args: { week: 5, force_refresh: true },
        });
      },
      /forces a roster refresh at most once/,
    ],
    [
      "start-sit's pre-game objective not auto",
      "start-sit",
      (j) => (seqs(j)[0]!.steps.find((s) => s.id === "lineup")!.args.objective = "mean"),
      /must carry objective: "auto"/,
    ],
    [
      "start-sit without a compare pair",
      "start-sit",
      (j) => delete seqs(j)[0]!.steps.find((s) => s.id === "lineup")!.args.compare,
      /shows `compare`/,
    ],
    [
      "stream-kdef ranking both positions at once",
      "stream-kdef",
      (j) => (seqs(j)[0]!.steps.find((s) => s.id === "kicker")!.args.positions = ["K", "D/ST"]),
      /exactly one position per call/,
    ],
    [
      "stream-kdef with look_ahead 1",
      "stream-kdef",
      (j) => (seqs(j)[0]!.steps.find((s) => s.id === "kicker")!.args.look_ahead = 1),
      /look_ahead: 2/,
    ],
    [
      "stream-kdef ranking a skill position",
      "stream-kdef",
      (j) => (seqs(j)[0]!.steps.find((s) => s.id === "kicker")!.args.positions = ["RB"]),
      /subset of \[K, D\/ST\]/,
    ],
    [
      "stream-kdef ranking before the schedule",
      "stream-kdef",
      (j) => {
        const s = seqs(j)[1]!;
        s.steps = s.steps.filter((x) => x.tool !== "espn_get_schedule");
      },
      /espn_get_schedule must come before espn_analyze_waivers/,
    ],
    [
      "waivers with mode priority",
      "waivers",
      (j) => (seqs(j)[0]!.steps.find((s) => s.id === "waivers")!.args.mode = "priority"),
      /must carry mode: "auto"/,
    ],
    [
      "waivers without the pool first",
      "waivers",
      (j) => {
        for (const s of seqs(j)) s.steps = s.steps.filter((x) => x.tool !== "espn_list_players");
      },
      /espn_list_players before espn_analyze_waivers/,
    ],
    [
      "session-check probing twice",
      "session-check",
      (j) => seqs(j)[0]!.steps.push({ id: "again", tool: "espn_check_auth", args: {} }),
      /espn_check_auth at most once/,
    ],
    [
      "session-check logging",
      "session-check",
      (j) =>
        seqs(j)[2]!.steps.push({
          id: "rec",
          tool: "espn_record_recommendation",
          args: {
            kind: "session",
            week: 5,
            rec: { $ref: "status.data" },
            source_calls: [],
            settings_hash: "x",
          },
        }),
      /session-check logs no recommendation/,
    ],
    [
      "apply logging",
      "apply",
      (j) =>
        seqs(j)[0]!.steps.push({
          id: "rec",
          tool: "espn_record_recommendation",
          args: {
            kind: "executed",
            week: 5,
            rec: { $ref: "roster.data" },
            source_calls: [],
            settings_hash: "x",
          },
        }),
      /apply records nothing in read-only mode/,
    ],
    [
      "onboard without the box score",
      "onboard",
      (j) => {
        for (const s of seqs(j)) s.steps = s.steps.filter((x) => x.tool !== "espn_get_box_score");
      },
      /espn_get_league → espn_get_roster → espn_get_box_score → espn_record_recommendation/,
    ],
    [
      "weekly analysing the lineup twice",
      "weekly",
      (j) =>
        seqs(j)[0]!.steps.splice(10, 0, {
          id: "lineup2",
          tool: "espn_analyze_lineup",
          args: { week: 5 },
        }),
      /espn_analyze_lineup at most once per briefing/,
    ],
    [
      "retro without the retrospective",
      "retro",
      (j) => {
        const s = seqs(j)[0]!;
        s.steps = s.steps.filter((x) => x.tool !== "espn_analyze_retrospective");
        s.steps.find((x) => x.id === "record")!.args.source_calls = {
          $source_calls: ["scoreboard"],
        };
        s.steps.find((x) => x.id === "record")!.args.rec = { $ref: "scoreboard.data" };
      },
      /no espn_analyze_retrospective step/,
    ],
    [
      "a recording Skill that never records",
      "retro",
      (j) => {
        const s = seqs(j)[0]!;
        s.steps = s.steps.filter((x) => x.tool !== "espn_record_recommendation");
      },
      /no sequence records the recommendation/,
    ],
  ];
  it.each(skillRules)("fails on %s", (_label, skill, mutate, re) => {
    const t = fresh();
    t.editJson(SEQ(skill), mutate);
    expect(errorsOf(t)).toMatch(re);
  });

  it("fails when the body logs a kind no sequence records, and when a $player is malformed", () => {
    const t = fresh();
    t.edit(
      "skills/retro/SKILL.md",
      '`kind: "retro"`',
      '`kind: "retro"` (and `kind: "weekly"` for the digest)',
    );
    t.editJson(SEQ("start-sit"), (j) => {
      const cmp = (seqs(j)[0]!.steps.find((s) => s.id === "lineup")!.args.compare as Json[])[0]!;
      cmp.in = { $player: { step: "scoreboard", slot: "BE" } };
      cmp.out = { $player: { step: "roster", slot: "BENCH" } };
    });
    const e = errorsOf(t);
    expect(e).toMatch(/logs kind "weekly" but no tool_sequence records it/);
    expect(e.match(/\$player must be/g)).toHaveLength(2);
  });
});

describe("evals.json — Lane 2 cases (plan 09 §5.2; research 06 §D.0)", () => {
  type M = [string, string, (j: Json) => void, RegExp];
  const mutations: M[] = [
    ["fewer than three cases", "apply", (j) => cases(j).splice(0, 2), /evals must hold ≥ 3 cases/],
    [
      "no -INJ case",
      "apply",
      (j) =>
        (j.evals = cases(j)
          .filter((c) => c.name !== "AP-INJ")
          .concat([{ ...cases(j)[0]!, id: 9, name: "AP-9" }])),
      /needs an -INJ case/,
    ],
    [
      "an -INJ case without the paired base comparison",
      "apply",
      (j) => {
        const c = cases(j).find((x) => x.name === "AP-INJ")!;
        c.expectations = (c.expectations as string[]).filter((e) => !e.includes("base fixture"));
      },
      /an -INJ case needs an llm expectation comparing the reply with the base fixture's/,
    ],
    [
      "a missing plan 10 A9b case",
      "retro",
      (j) => (j.evals = cases(j).filter((c) => c.name !== "RT-4-E")),
      /missing case RT-4-E/,
    ],
    [
      "a case of another Skill's prefix",
      "retro",
      (j) => (cases(j)[0]!.name = "WK-9"),
      /name must start with RT-/,
    ],
    ["a bad case name", "retro", (j) => (cases(j)[0]!.name = "RT1"), /name must look like/],
    ["a duplicate id", "retro", (j) => (cases(j)[1]!.id = cases(j)[0]!.id), /duplicate id/],
    ["a string id", "retro", (j) => (cases(j)[0]!.id = "1"), /id must be a positive integer/],
    [
      "toolset full in a P0 Skill",
      "retro",
      (j) => (cases(j)[0]!.toolset = "full"),
      /a P0 Skill's cases run under toolset "core"/,
    ],
    [
      "an unknown variant",
      "retro",
      (j) => (cases(j)[0]!.files = ["evals/fixtures/fx-10h/friday-night"]),
      /unknown fixture variant "friday-night"/,
    ],
    [
      "a fixture path outside the grammar",
      "retro",
      (j) => (cases(j)[0]!.files = ["../../fixtures/espn/recorded"]),
      /files\[0\] must be/,
    ],
    [
      "two fixtures",
      "retro",
      (j) => (cases(j)[0]!.files = ["evals/fixtures/fx-10h", "evals/fixtures/fx-10h/k10"]),
      /exactly one fixture/,
    ],
    [
      "an expectation without a grader",
      "retro",
      (j) => (cases(j)[0]!.expectations = ["The reply is good."]),
      /must end with a grader tag/,
    ],
    [
      "a regex grader without its pattern",
      "retro",
      (j) => (cases(j)[0]!.expectations = ["The reply says regret (regex)"]),
      /a regex grader carries its pattern/,
    ],
    [
      "a regex that does not compile",
      "retro",
      (j) => (cases(j)[0]!.expectations = ["The reply says regret (regex: `(unclosed`)"]),
      /pattern does not compile/,
    ],
    [
      "an expectation naming a write tool",
      "retro",
      (j) =>
        (cases(j)[0]!.expectations = [
          "espn_commit_trade was never called (tool_used: min 0 max 0)",
        ]),
      /names the write tool espn_commit_trade/,
    ],
    [
      "an expectation naming an unregistered tool",
      "retro",
      (j) => (cases(j)[0]!.expectations = ["espn_get_magic was called (tool_used)"]),
      /espn_get_magic is not a registered tool/,
    ],
    [
      "a P1 tool in a core case",
      "retro",
      (j) => (cases(j)[0]!.expectations = ["espn_analyze_matchup was called (tool_used)"]),
      /espn_analyze_matchup is not a registered tool under toolset core/,
    ],
    [
      "a write wildcard in an expectation",
      "retro",
      (j) => (cases(j)[0]!.expectations = ["no espn_commit_* call (tool_used: min 0 max 0)"]),
      /wildcard espn_commit_\* is not allowed/,
    ],
    ["an empty prompt", "retro", (j) => (cases(j)[0]!.prompt = " "), /prompt must be 1–2000 chars/],
    [
      "a vague expected_output",
      "retro",
      (j) => (cases(j)[0]!.expected_output = "good"),
      /expected_output must describe success/,
    ],
    ["an unknown case key", "retro", (j) => (cases(j)[0]!.phase = "1a"), /unknown keys phase/],
    ["a wrong skill_name", "retro", (j) => (j.skill_name = "weekly"), /skill_name must be "retro"/],
  ];
  it.each(mutations)("fails on %s", (_label, skill, mutate, re) => {
    const t = fresh();
    t.editJson(EVALS(skill), mutate);
    expect(errorsOf(t)).toMatch(re);
  });

  it("reads the grader tag at the end of a sentence, a regex pattern with parentheses included", () => {
    expect(graderOf("x (llm)")).toBe("llm");
    expect(graderOf("x (llm, judge sees both replies)")).toBe("llm");
    expect(graderOf("x (tool_used: input_match a b, min 0 max 1)")).toBe("tool_used");
    expect(graderOf("x (regex: `a(b|c)?`)")).toBe("regex");
    expect(graderOf("x (regex_absent: `<TOKEN>`)")).toBe("regex_absent");
    expect(graderOf("x (vibes)")).toBeNull();
    expect(graderOf("x (llm) and more")).toBeNull();
  });
});

describe("trigger evals (plan 09 §5.1 item 5)", () => {
  it.each([
    ["who do I start monday?", "names a weekday"],
    ["who do I start on SNF", "names a night-game slot"],
    ["lock at 1:00", "names a clock time"],
    ["before 8pm", "names a clock time"],
    ["for 2026-10-11", "names a date"],
    ["by Oct 11th", "names a date"],
    ["start him tonight?", "names a day relative to now"],
    ["anything for the weekend", "names a day relative to now"],
    ["ｍｏｎｄａｙ lineup", "names a weekday"],
  ])("%j is not time-blind (%s)", (q, why) => {
    expect(timeReference(q)).toBe(why);
  });

  it("the four game-day prompts are time-blind", () => {
    for (const p of GAME_DAY_PROMPTS) expect(timeReference(p), p).toBeNull();
  });

  it("validateTriggers enforces counts, platform negatives, time-blindness and shape", () => {
    const pos = (q: string) => ({ query: q, should_trigger: true });
    const neg = (q: string) => ({ query: q, should_trigger: false });
    const ok = [
      ...["a1", "a2", "a3", "a4", "a5", "a6"].map(pos),
      ...["n1", "n2", "n3", "n4"].map(neg),
      neg("my Yahoo team"),
      neg("my Sleeper team"),
    ];
    expect(validateTriggers(ok, "t").errors).toEqual([]);
    expect(validateTriggers(ok.slice(1), "t").errors.join("\n")).toMatch(/≥ 6 positives/);
    expect(validateTriggers(ok.slice(0, -1), "t").errors.join("\n")).toMatch(
      /≥ 2 negatives naming Yahoo or Sleeper/,
    );
    expect(validateTriggers([...ok, pos("set my Yahoo lineup")], "t").errors.join("\n")).toMatch(
      /must not name another platform/,
    );
    expect(validateTriggers([...ok, pos("start him tonight")], "t").errors.join("\n")).toMatch(
      /not time-blind/,
    );
    expect(
      validateTriggers([...ok, { query: "x", should_trigger: "yes" }], "t").errors.join("\n"),
    ).toMatch(/boolean `should_trigger`/);
    expect(
      validateTriggers([...ok, { query: "x", should_trigger: true, why: 1 }], "t").errors.join(
        "\n",
      ),
    ).toMatch(/unknown keys why/);
    expect(validateTriggers([...ok, pos("q".repeat(501))], "t").errors.join("\n")).toMatch(
      /1–500 chars/,
    );
    expect(validateTriggers({}, "t").errors).toEqual([
      "t: must be an array of { query, should_trigger }",
    ]);
  });

  it("triggerCollisions flags each rule (a)–(h), and exempts other-platform negatives from (e)", () => {
    const sk = (name: string, w: string, p: string[], n: string[]) => ({
      name,
      whenToUse: w,
      triggers: [
        ...p.map((q) => ({ query: q, should_trigger: true })),
        ...n.map((q) => ({ query: q, should_trigger: false })),
      ],
    });
    const errs = triggerCollisions(
      [
        sk(
          "alpha",
          "start or sit, flex, shared phrase",
          ["start or sit my RB", "start or sit my RB", "flex question one two three four"],
          ["start or sit my WR", "flex for my Yahoo team"],
        ),
        sk(
          "beta",
          "waiver, claim, shared phrase",
          [
            "claim flex question one two three four",
            "start or sit my RB",
            "totally unrelated words",
          ],
          ["start or sit my WR"],
        ),
      ],
      { gameDayOwner: "alpha", gameDayPrompts: ["who should I start?"] },
    );
    const all = errs.join("\n");
    expect(all).toMatch(/alpha: trigger prompt listed twice/); // (a)
    expect(all).toMatch(/is a positive of both alpha and beta/); // (b)
    expect(all).toMatch(/near-duplicate positives/); // (c)
    expect(all).toMatch(
      /collision: negative "start or sit my WR" of alpha matches alpha's own when_to_use/,
    ); // (e)
    expect(all).not.toMatch(/negative "flex for my Yahoo team"/); // exempt
    expect(all).toMatch(/when_to_use phrase "shared phrase" is in both alpha and beta/); // (f)
    expect(all).toMatch(/alpha: the game-day prompt "who should I start\?" must be a positive/); // (g)
    expect(all).toMatch(/positive "totally unrelated words" of beta matches none of beta's/); // (h)
    expect(all).toMatch(
      /positive "start or sit my RB" of beta matches alpha's when_to_use \(1\) better than its own \(0\)/,
    ); // (d)
    const both = triggerCollisions(
      [sk("alpha", "x", ["who should I start?"], []), sk("beta", "y", ["who should I start?"], [])],
      {
        gameDayOwner: "alpha",
        gameDayPrompts: ["who should I start?"],
      },
    ).join("\n");
    expect(both).toMatch(
      /beta: the game-day prompt "who should I start\?" must route to alpha only/,
    );
  });

  it("the real bundle routes the four game-day prompts to start-sit only, with each Skill's file mutated to break it", () => {
    const t = fresh();
    const arr = JSON.parse(t.read(TRIG("weekly"))) as { query: string; should_trigger: boolean }[];
    arr.push({ query: "what can I still change?", should_trigger: true });
    t.write(TRIG("weekly"), arr);
    const e = errorsOf(t);
    expect(e).toMatch(
      /weekly: the game-day prompt "what can I still change\?" must route to start-sit only/,
    );
  });

  it("tokenize, phrases, routeScore and jaccard behave as documented", () => {
    expect(tokenize("Who's the RB's best-ball flex, Kicker’s pick?")).toEqual([
      "who",
      "rbs",
      "best",
      "ball",
      "flex",
      "kicker",
      "pick",
    ]);
    expect(phrases("start or sit, flex,  , who goes in")).toEqual([
      ["start", "sit"],
      ["flex"],
      ["who", "goe"],
    ]);
    expect(routeScore(phrases("start or sit, flex"), "Start or sit at FLEX?")).toBe(2);
    expect(jaccard([], [])).toBe(1);
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 6 })),
        fc.array(fc.string({ maxLength: 6 })),
        (a, b) => {
          const j = jaccard(a, b);
          expect(j).toBeGreaterThanOrEqual(0);
          expect(j).toBeLessThanOrEqual(1);
          expect(jaccard(b, a)).toBe(j);
        },
      ),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 200, unit: "binary" }), (s) => {
        expect(tokenize(s).every((t) => t.length > 0 && /^[a-z0-9]+$/.test(t))).toBe(true);
        const r = timeReference(s);
        expect(r === null || typeof r === "string").toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe("identifiers and secrets (plan 09 §5.1 item 6)", () => {
  // every value below is assembled at run time: no literal in this file looks like an identifier
  const hex = (n: number) => randomBytes(n).toString("hex");
  const guid = () => `${hex(4)}-${hex(2)}-4${hex(2).slice(1)}-a${hex(2).slice(1)}-${hex(6)}`;
  const ip = () =>
    [10, 20, 30, 40].map((x) => String(x + ((randomBytes(1)[0] ?? 0) % 9))).join(".");

  it.each([
    ["a cookie value", () => `espn_s2 = ${"AE" + hex(30)}`, "cookie-value"],
    ["a SWID value", () => `SWID: {${guid().toUpperCase()}}`, "cookie-value"],
    ["a GUID outside the fake range", () => `member ${guid()}`, "guid-outside-fake-range"],
    ["an IPv4 literal", () => `from ${ip()} today`, "ipv4-literal"],
    [
      "a league id",
      () => `leagueId=${String(1000 + (randomBytes(2).readUInt16BE() % 9000))}`,
      "league-id",
    ],
    [
      "a league path",
      () => `/leagues/${String(1000 + (randomBytes(2).readUInt16BE() % 9000))}/view`,
      "league-id",
    ],
    ["an email address", () => `write to someone@${hex(3)}.org`, "email"],
    ["a home path", () => `open ${["", "Users", hex(3), "x"].join("/")}`, "home-path"],
  ])("flags %s by rule id and line only — never the value", (_label, make, rule) => {
    const value = make();
    const findings = identifierFindings(`ok line\n${value}\n`);
    expect(findings).toContain(`2: ${rule}`);
    for (const f of findings) expect(f).toMatch(/^\d+: [a-z0-9-]+$/);
  });

  it("passes the placeholders the Skills use", () => {
    const text = [
      'ESPN_LEAGUE_ID: "0"',
      "league_id: 0",
      "member {00000000-0000-4000-8000-000000000001}",
      "Here is my espn_s2: <SYNTHETIC_ESPN_S2>",
      "mail me at someone@example.com",
      "version 1.2.3 and p10/p90",
      "`espn_s2` exactly as shown",
    ].join("\n");
    expect(identifierFindings(text)).toEqual([]);
  });

  it("a GUID finding never carries the GUID, for any GUID (property)", () => {
    fc.assert(
      fc.property(fc.uuid(), (u) => {
        const f = identifierFindings(`x ${u} y`);
        for (const line of f) expect(line).not.toContain(u);
      }),
    );
  });

  it("fails the whole check when a Skill file carries an identifier, and the scanner agrees", () => {
    const t = fresh();
    t.edit(
      "skills/retro/SKILL.md",
      "## Output additions",
      `Contact ${"x" + hex(2)}@${hex(3)}.org.\n\n## Output additions`,
    );
    const e = errorsOf(t, true);
    expect(e).toMatch(/skills\/retro\/SKILL\.md:\d+: email \(plan 09 §5\.1 item 6\)/);
    expect(e).toMatch(/scan-secrets: exit 1 over skills\//);
  });

  it("reports a missing scanner instead of passing", () => {
    const t = fresh();
    rmSync(t.p("scripts/dev/scan-secrets.mjs"));
    expect(errorsOf(t, true)).toMatch(/scan-secrets\.mjs not found/);
  });
});

describe("cross-checks with the MCP layer (plan 09 K6)", () => {
  it("fails when tests/smoke/expected-tools.json disagrees with the manifest", () => {
    const t = fresh();
    const m = t.readJson("scripts/skills/manifest.json") as {
      tools: { core: string[]; p1: string[] };
    };
    t.write("tests/smoke/expected-tools.json", {
      core: [...m.tools.core.slice(1), "espn_get_extra"],
      full: [...m.tools.core, ...m.tools.p1.slice(1)],
    });
    const e = errorsOf(t);
    expect(e).toMatch(
      /manifest tools\.core ≠ tests\/smoke\/expected-tools\.json core \(missing there: espn_get_league; not in manifest: espn_get_extra\)/,
    );
    expect(e).toMatch(/manifest tools\.p1 ≠ tests\/smoke\/expected-tools\.json full − core/);
  });

  it("passes when tests/smoke/expected-tools.json agrees, in either shape", () => {
    const t = fresh();
    const m = t.readJson("scripts/skills/manifest.json") as {
      tools: { core: string[]; p1: string[] };
    };
    t.write("tests/smoke/expected-tools.json", {
      core: m.tools.core,
      full: [...m.tools.core, ...m.tools.p1],
    });
    expect(errorsOf(t)).toBe("");
    t.write("tests/smoke/expected-tools.json", m.tools.core);
    expect(errorsOf(t)).toBe("");
    t.write("tests/smoke/expected-tools.json", "{");
    expect(errorsOf(t)).toMatch(/tests\/smoke\/expected-tools\.json:/);
  });

  it("fails when src/mcp/registry.ts exports a different TOOL_CONTRACT, and notes when it exports none", () => {
    const t = fresh();
    t.write("src/mcp/registry.ts", "export const TOOL_CONTRACT = 2;\n");
    expect(errorsOf(t)).toMatch(
      /tool_contract: manifest 1 ≠ src\/mcp\/registry\.ts TOOL_CONTRACT 2/,
    );
    t.write("src/mcp/registry.ts", "export const NOTHING = 0;\n");
    const r = checkSkills({ root: t.root, scan: false });
    expect(r.errors).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/exports no TOOL_CONTRACT/);
  });

  it("fails when a Skill directory is not in the manifest, or the manifest names a missing one", () => {
    const t = fresh();
    t.editJson("scripts/skills/manifest.json", (j) => {
      (j.skills as { p0: string[] }).p0 = [
        "apply",
        "onboard",
        "retro",
        "session-check",
        "start-sit",
        "stream-kdef",
        "waivers",
        "draft",
      ];
    });
    const e = errorsOf(t);
    expect(e).toMatch(/manifest skills with no directory: draft/);
    expect(e).toMatch(/Skill directories not in the manifest: weekly/);
  });
});

describe("unit helpers", () => {
  it("toolRefs finds espn_<verb>_ tools and never a field name or the cookie name", () => {
    const text =
      "`espn_get_roster`, espn_analyze_*, `espn_rule`, value_basis `espn_ros`, `espn_s2`, win_probability_espn, x_espn_get_y, `espn_game_id`";
    expect(toolRefs(text).map((r) => `${r.tool}${r.wildcard ? "*" : ""}`)).toEqual([
      "espn_get_roster",
      "espn_analyze_*",
    ]);
  });

  it("unknownConstants keeps error codes, allowed constants and TRAN_* out", () => {
    expect(
      unknownConstants("`VALIDATION` `OUT` `TRAN_X_Y` `NEW_CODE` `lower_case` `ESPN_FAKE`", {
        errorCodes: ["VALIDATION"],
        constants: ["OUT"],
        prefixes: ["TRAN_"],
      }),
    ).toEqual(["ESPN_FAKE", "NEW_CODE"]);
  });

  it("bodyRecordKinds reads every kind on a line naming the record tool, and only there", () => {
    expect(
      bodyRecordKinds(
        '`espn_record_recommendation` with `kind: "lineup"`, then `kind: "stream"`\nlater `kind: "retro"`',
      ),
    ).toEqual(["lineup", "stream"]);
  });

  it("recKindOf maps each producer to the kind the retrospective scores", () => {
    const s = (tool: string, args = {}) => ({ id: "x", tool, args, expect: ["ok"] });
    expect(recKindOf(s("espn_analyze_lineup"))).toBe("lineup");
    expect(recKindOf(s("espn_analyze_retrospective"))).toBe("retro");
    expect(recKindOf(s("espn_analyze_waivers", { positions: ["K"] }))).toBe("stream");
    expect(recKindOf(s("espn_analyze_waivers", { positions: ["K", "D/ST"] }))).toBe("stream");
    expect(recKindOf(s("espn_analyze_waivers", { positions: ["RB"] }))).toBe("waiver");
    expect(recKindOf(s("espn_analyze_waivers"))).toBe("waiver");
    expect(recKindOf(s("espn_get_roster"))).toBeUndefined();
  });

  it("checkArgType validates each type of the grammar and lets templates through", () => {
    expect(checkArgType(true, "bool")).toBeNull();
    expect(checkArgType("x", "bool")).toMatch(/boolean/);
    expect(checkArgType("", "string")).toMatch(/non-empty/);
    expect(checkArgType("x".repeat(401), "string")).toMatch(/non-empty/);
    expect(checkArgType(["a"], "string[]")).toBeNull();
    expect(checkArgType([], "string[]")).toMatch(/non-empty/);
    expect(checkArgType({}, "object")).toBeNull();
    expect(checkArgType([], "object")).toMatch(/object/);
    expect(checkArgType([], "array")).toBeNull();
    expect(checkArgType(5, "int:1..18")).toBeNull();
    expect(checkArgType(5.5, "int:1..18")).toMatch(/integer/);
    expect(checkArgType(0, "int:1..18")).toMatch(/integer in 1\.\.18/);
    expect(checkArgType(Number.NaN, "number:0..1")).toMatch(/number/);
    expect(checkArgType(0.5, "number:0..1")).toBeNull();
    expect(checkArgType([1, { $ref: "a.b" }], "int[]:1..9")).toBeNull();
    expect(checkArgType([0], "int[]:1..9")).toMatch(/integers/);
    expect(checkArgType("a", "enum:a|b")).toBeNull();
    expect(checkArgType("c", "enum:a|b")).toMatch(/one of a\|b/);
    expect(checkArgType(["a", "b"], "enum[]:a|b")).toBeNull();
    expect(checkArgType(["a", "c"], "enum[]:a|b")).toMatch(/array of a\|b/);
    expect(checkArgType({ pool: {} }, "selector")).toBeNull();
    expect(checkArgType({ $opponent: "s" }, "int:1..20")).toBeNull();
    expect(checkArgType(1, "weird")).toMatch(/unknown type/);
  });

  it("main exits 2 on a bad argument", () => {
    expect(main(["--frobnicate"])).toBe(2);
  });
});
