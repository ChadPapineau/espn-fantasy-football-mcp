// round10-gate-fixes.test.ts — the mismatches §R18's fix round left between its streams, fixed at
// its gate (changelog §R18, R18-5, R18-6 and R18-9; the fix round's verifiers' VS-2 and the server
// refix's open question 1):
// - the cheat-sheet's trade row gives `partners[].players[].name` the form the server ships since
//   22ce708, the bare, path-listed `espn.player.name` every player name takes (plan 01 §4.4 after A7a;
//   plan 07 E6), and never calls it "wrapped like the partner's own", the wording of the first build
//   (89977e9), whose name was a wrapper;
// - Lane 1's sequences ("the calls this Skill promises, in order") carry the reads §R18 added to the
//   Skill bodies: weekly's team read for its IR block whenever a bench player is OUT or
//   INJURY_RESERVE (R18-5) — on fx-10h two are, so both pre-run briefings make it — and retro's one
//   box-score read for an unbacked call on a review that names no player (R18-6); skills/README.md's
//   retro row names it.
// Each mutation runs on one temporary copy of the bundle and is undone after it; no network (the
// fixture is read in process, through the real provider in fixture mode).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSkills } from "../../scripts/skills/build-skills.mjs";
import {
  ROUND9_FIXED,
  TOOL_OUTPUT_PHRASES,
  checkSkills,
} from "../../scripts/skills/check-skills.mjs";
import { analyzeTradeTool } from "../../src/mcp/tools/market-p1.js";
import { fxLeague, myRoster } from "../domain/analytics/fx10h-world.js";
import {
  ROOT,
  SKILLS,
  emptyDenylist,
  readSequence,
  tempRepo,
  type SeqStep,
  type TempRepo,
} from "./helpers.js";

let deny: ReturnType<typeof emptyDenylist>;
let repo: TempRepo;
beforeAll(() => {
  deny = emptyDenylist();
  repo = tempRepo();
});
afterAll(() => {
  repo.cleanup();
  deny.cleanup();
});
const errorsOf = (): string =>
  checkSkills({ root: repo.root, scan: false, scanEnv: deny.env }).errors.join("\n");
/** Mutate a shared reference, rebuild every copy, run the check, and put it all back. */
const withSharedEdit = (file: string, from: string, to: string): string => {
  const rel = `skills/_shared/references/${file}`;
  const before = repo.read(rel);
  try {
    repo.edit(rel, from, to);
    buildSkills({ root: repo.root });
    return errorsOf();
  } finally {
    repo.write(rel, before);
    buildSkills({ root: repo.root });
  }
};
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
type Fixed = Record<string, Record<string, Record<string, string>>>;
const pin = (skill: string, k: string): string => {
  const v = (ROUND9_FIXED as Fixed)[skill]?.["SKILL.md"]?.[k];
  if (v === undefined) throw new Error(`ROUND9_FIXED has no ${skill}.${k}`);
  return v;
};
const tradeRow = (sheet: string): string =>
  sheet.split("\n").find((l) => l.startsWith("| (P1) `espn_analyze_trade` |")) ?? "";

// --- R18-9: the name's form, as the server ships it ----------------------------------------------

/** Where every trade answer lists the proposal players' names, and their tag. */
const NAMES_PATH = { path: "data.partners[].players[].name", source: "espn.player.name" };
/** The first build's wording, for a wrapper (89977e9); the refix 22ce708 ships the name bare. */
const WRAPPED = "wrapped like the partner's own";
const phrase = TOOL_OUTPUT_PHRASES.espn_analyze_trade[0] ?? "?";

describe("R18-9: the cheat-sheet's trade row gives players[].name the form the server ships", () => {
  it("the trade tool's schema lists every proposal player's name bare and path-listed; the partner's own name is a wrapper", () => {
    // bareFieldsFromSchema: a bare third-party string at a path meta.untrusted_fields lists
    expect(analyzeTradeTool.bareFields).toContainEqual(NAMES_PATH);
    // the partner's own name is member text, wrapped at the normaliser, so no bare entry lists it
    expect(analyzeTradeTool.bareFields.map((f) => f.path)).not.toContain("data.partners[].name");
  });

  it("the row says the name is that bare, path-listed string, in the shared file and in every copy", () => {
    const sheet = read("skills/_shared/references/tool-outputs.md");
    // failing first: the row read "`name` third-party text, wrapped like the partner's own"
    expect(phrase).toContain(
      "`name` third-party text, the player's bare, path-listed `espn.player.name` as his roster row carries it, not wrapped as the partner's own `name` is",
    );
    expect(phrase).not.toContain(WRAPPED);
    expect(tradeRow(sheet)).toContain(phrase);
    // the sheet's third-party paragraph lists player names among the bare, listed strings
    expect(sheet).toContain("They are player names (`espn.player.name`)");
    for (const skill of SKILLS) {
      const copy = read(`skills/${skill}/references/tool-outputs.md`);
      expect(copy, skill).toBe(sheet);
      expect(copy, skill).not.toContain(WRAPPED);
    }
  });

  it("the first build's wording, restored in its place, fails the check", () => {
    const wrapped =
      "`players[]` (`player_id`, `name` — one entry per id of that proposal's `give` and `get`, in that order; `name` third-party text, wrapped like the partner's own: each proposal player is named from it, never as a bare id — changelog §R18, R18-9)";
    expect(withSharedEdit("tool-outputs.md", phrase, wrapped)).toContain(
      `skills/_shared/references/tool-outputs.md: the \`espn_analyze_trade\` row does not carry "${phrase}"`,
    );
  });
});

// --- R18-5 and R18-6: the reads Lane 1 promises ---------------------------------------------------

const stepsOf = (skill: string, id: string): SeqStep[] => {
  const q = readSequence(skill).sequences.find((s) => s.id === id);
  if (q === undefined) throw new Error(`${skill} has no sequence ${id}`);
  return q.steps;
};
const indexOf = (steps: SeqStep[], id: string): number => steps.findIndex((s) => s.id === id);
const sourceCalls = (step: SeqStep | undefined): unknown =>
  (step?.args.source_calls as { $source_calls?: unknown } | undefined)?.$source_calls;

describe("Lane 1 carries the reads §R18 added to the Skill bodies (the verifiers' VS-2)", () => {
  it("fx-10h: two bench players are OUT or INJURY_RESERVE, so weekly's team read (R18-5) is due on the base league", async () => {
    const fx = await fxLeague("");
    const due = myRoster(fx)
      .entries.filter(
        (e) =>
          e.slot === "BE" &&
          (e.player.injury_status === "OUT" || e.player.injury_status === "INJURY_RESERVE"),
      )
      .map((e) => e.player.ref.id)
      .sort((a, b) => a - b);
    expect(due).toEqual([4366031, 4697815]);
    expect(pin("weekly", "irRead")).toContain(
      "so call it once whenever a bench player is `OUT` or `INJURY_RESERVE`",
    );
    expect(read("skills/weekly/SKILL.md")).toContain(pin("weekly", "irRead"));
  });

  it.each(["pre_run", "pre_run_full"])(
    "weekly %s: the user's team, read right after the all-teams roster, as ir_invalid reads it",
    (id) => {
      const steps = stepsOf("weekly", id);
      const at = indexOf(steps, "roster");
      expect(steps[at]?.tool).toBe("espn_get_roster");
      expect(steps[at]?.args).toEqual({ all: true, week: 5 });
      // failing first: the next step was espn_get_injuries
      const mine = steps[at + 1];
      expect(mine?.id).toBe("roster_mine");
      expect(mine?.tool).toBe("espn_get_roster");
      // the same arguments as the ir_invalid sequence's own team read (no `all`)
      const invalid = stepsOf("weekly", "ir_invalid").find((s) => s.id === "roster_mine");
      expect(mine?.args).toEqual(invalid?.args);
      expect(mine?.note).toContain("whenever a bench player is OUT or INJURY_RESERVE");
      expect(mine?.note).toContain("changelog §R18, R18-5");
      expect(steps.filter((s) => s.id === "roster_mine")).toHaveLength(1);
    },
  );

  it("retro review (no player named): the week's box score once, after the retrospective, as named_player reads it (R18-6)", () => {
    const rule = pin("retro", "unbackedRule");
    expect(rule).toContain("whether or not the question names a player");
    expect(rule).toContain(
      "call `espn_get_box_score` for that week with the user's `team_id` once",
    );
    expect(read("skills/retro/SKILL.md")).toContain(rule);
    const steps = stepsOf("retro", "review");
    const box = steps[indexOf(steps, "box")];
    // failing first: review had no box step
    expect(box?.tool).toBe("espn_get_box_score");
    expect(box?.args).toEqual(stepsOf("retro", "named_player").find((s) => s.id === "box")?.args);
    expect(box?.note).toContain("unbacked");
    expect(box?.note).toContain("changelog §R18, R18-6");
    expect(indexOf(steps, "retro")).toBeLessThan(indexOf(steps, "box"));
    expect(indexOf(steps, "box")).toBeLessThan(indexOf(steps, "txns"));
    expect(steps.filter((s) => s.tool === "espn_get_box_score")).toHaveLength(1);
    // the log lists every call the answer used (references/log.md), as named_player's does
    const record = steps.find((s) => s.id === "record");
    expect(sourceCalls(record)).toEqual(["scoreboard", "retro", "box", "txns"]);
  });

  it("skills/README.md's retro row names the box score for an unbacked call", () => {
    const row = read("skills/README.md")
      .split("\n")
      .find((l) => l.startsWith("| [retro](retro/SKILL.md) |"));
    expect(row).toContain(
      "retrospective → (box score for a named player or an unbacked call) → (transactions) → record",
    );
  });
});
