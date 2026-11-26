// round10-skill-fixes.test.ts — round 9's Skill-text fixes, built in §R18's fix round, are held by
// check-skills (docs/evals/stage-c-plugin-eval.md, "Run of 2026-11-25, round 9 (after §R17)",
// #### skill_text_defect, the hardenings of #### eval_case_defect and #### model_variance and "Next
// steps, in order" item 3; changelog §R18, R18-5 to R18-9): every fixed line fails the check when it is
// cut or reworded, orient's Step-0 close fails in every copy, the cheat-sheet's trade row names R18-9's
// field, the text the fixes withdraw fails when restored, the lines the rulings quote are their text
// character for character, each line sits where its rule prints it and contradicts no rule beside it,
// the free graders that read those places take the lines filled in from their fixtures, and every
// Skill's frontmatter is 8f1c406's byte for byte (R18-1, R17-3: no listing changes).
// Each mutation runs on one temporary copy of the bundle and is undone after it; no network (the
// fixture is read in process, through the real provider in fixture mode).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSkills } from "../../scripts/skills/build-skills.mjs";
import {
  ORIENT_SENTENCES,
  ROUND6_FIXED,
  ROUND7_FIXED,
  ROUND8_FIXED,
  ROUND9_ABSENT,
  ROUND9_FIXED,
  ROUND9_ORIENT,
  TOOLSET_STOP,
  TOOL_OUTPUT_PHRASES,
  checkSkills,
  toolOutputFieldProblems,
} from "../../scripts/skills/check-skills.mjs";
import { CASCADE } from "../../src/domain/analytics/marketConstants.js";
import { waiverActionText } from "../../src/domain/analytics/waivers.js";
import { auditIr, seatsOf } from "../../src/domain/league/roster.js";
import { fxLeague, myRoster } from "../domain/analytics/fx10h-world.js";
import {
  P0_SKILLS,
  P1_SKILLS,
  ROOT,
  SKILLS,
  emptyDenylist,
  tempRepo,
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
/** Mutate one file of the shared copy, run the check, and put the file back. */
const withEdit = (rel: string, from: string | RegExp, to: string): string => {
  const before = repo.read(rel);
  try {
    repo.edit(rel, from, to);
    return errorsOf();
  } finally {
    repo.write(rel, before);
  }
};
/** Mutate a shared reference, rebuild every copy, run the check, and put it all back. */
const withSharedEdit = (file: string, from: string | RegExp, to: string): string => {
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
const body = (skill: string) => read(`skills/${skill}/SKILL.md`);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** Every occurrence of `s`, literally. */
const every = (s: string) => new RegExp(esc(s), "g");
/** A reply line as the Skill gives it, without its quotation marks or backticks. */
const bare = (s: string) => s.replace(/^["`]|["`]$/g, "");
/** The line of `text` that carries `needle` (the bullet, step or paragraph it belongs to). */
const lineWith = (text: string, needle: string): string =>
  text.split("\n").find((l) => l.includes(needle)) ?? "";
/** A one-word rewording: the first word of four letters or more gains a letter. */
const reword = (s: string): string => s.replace(/[A-Za-z]{4,}/, (w) => `${w}s`);
/** Text between two markers of a file (from the first, up to the second). */
const between = (text: string, from: string, to: string): string => {
  const at = text.indexOf(from);
  const end = text.indexOf(to, at + 1);
  if (at < 0 || end < 0) throw new Error(`no ${from} … ${to}`);
  return text.slice(at, end);
};
/** The rulings (changelog §R18), line breaks and their indents read as one space. */
const RULINGS = between(read("docs/plan/changelog.md"), "## §R18", "## Reviews").replace(
  /[ \t]*\n[ \t]*/g,
  " ",
);
/** The round-9 section of the eval report, read the same way (its proposed lines and fixes). */
const REPORT = between(
  read("docs/evals/stage-c-plugin-eval.md"),
  "## Run of 2026-11-25, round 9",
  "## Run of 2026-11-24, round 8",
).replace(/[ \t]*\n[ \t]*/g, " ");

type Fixed = Record<string, Record<string, Record<string, string>>>;
const F = ROUND9_FIXED as Fixed;
const fixedRows = Object.entries(F).flatMap(([skill, files]) =>
  Object.entries(files).flatMap(([file, lines]) =>
    Object.entries(lines).map(([k, s]) => [skill, file, k, s] as const),
  ),
);
const line = (skill: string, k: string): string => {
  const v = F[skill]?.["SKILL.md"]?.[k];
  if (v === undefined) throw new Error(`ROUND9_FIXED has no ${skill}.${k}`);
  return v;
};
const pin = (table: unknown, skill: string, k: string): string => {
  const v = (table as Fixed)[skill]?.["SKILL.md"]?.[k];
  if (v === undefined) throw new Error(`no ${skill}.${k}`);
  return v;
};
const orientRows = Object.entries(ROUND9_ORIENT as Record<string, string>);
const absentRows = Object.entries(
  ROUND9_ABSENT as Record<string, Record<string, string[]>>,
).flatMap(([skill, files]) =>
  Object.entries(files).flatMap(([file, gone]) => gone.map((g) => [skill, file, g] as const)),
);
const tradePhrase = TOOL_OUTPUT_PHRASES.espn_analyze_trade[0] ?? "?";

interface Case {
  name: string;
  expectations: string[];
}
const casesOf = (skill: string): Case[] =>
  (JSON.parse(read(`skills/${skill}/evals/evals.json`)) as { evals: Case[] }).evals;
/** Every free grader of a Skill's cases, compiled as the build compiles it (flags i). */
const freeGraders = (skill: string) =>
  casesOf(skill).flatMap((c) =>
    c.expectations.flatMap((e) => {
      const m = /\((regex|regex_absent):\s*`([^`]+)`\)\s*$/.exec(e);
      return m === null
        ? []
        : [
            {
              name: `${c.name} ${e.slice(0, 50)}`,
              absent: m[1] === "regex_absent",
              re: new RegExp(m[2] ?? "", "i"),
            },
          ];
    }),
  );
/** A case's free grader found by the opening words of its line (never by its position). */
const graderBy = (skill: string, name: string, lead: string): RegExp => {
  const e = casesOf(skill)
    .find((c) => c.name === name)
    ?.expectations.find((x) => x.startsWith(lead));
  if (e === undefined) throw new Error(`${name}: no grader opening "${lead}"`);
  const p = /\((?:regex|regex_absent):\s*`([^`]+)`\)\s*$/.exec(e)?.[1];
  if (p === undefined) throw new Error(`${name} "${lead}": no pattern`);
  return new RegExp(p, "i");
};
/** The forms R15-7's cross-check fills a pinned line into. */
const forms = (s: string): string[] => [s, `**${s}**`, `"${s}"`, `- ${s}`, `| Note | ${s} |`];

/** Each printed line, filled in from its case's fixture (single tool calls on the eval servers). */
const FILLED = {
  weekly: [
    'Also IR-eligible: "Tank Dell" (4366031, INJURY_RESERVE), "Rachaad White" (4697815, OUT) — the `espn-fantasy-football:roster-audit` Skill decides which, if any, to move to IR.',
    'Byes, week 7: "James Cook III" (RB), "Bhayshul Tuten" (RB), "Cam Little" (K) — 2 at RB.',
    "Byes, week 5: none of your starters.",
  ],
  retro: [
    'Decision quality: sound — the lineup call, on ESPN\'s projection before kickoff: "Drake Maye" 20.14 against "Bo Nix" 16.26.',
    'Decision quality: sound — the 15 scored lineup calls, on ESPN\'s projection before kickoff: "Drake Maye" 20.14 against "Bo Nix" 16.26.',
    "Decision quality: not scored — the 17 scored evidence calls: no projection was stored before kickoff, and no alternative was logged to weigh against.",
  ],
  "injury-cascade": [
    "Shares, never 1:1: the 3.651 targets he vacates are split by role affinity, and no line move is known: the team's volume is cut by 3 % without the starter.",
  ],
  onboard: [
    "| Waivers | rolling priority (move-to-last): a successful claim sends the team to the back of the order; 24 h on waivers; runs Mon, Wed, Thu, Fri, Sat, Sun |",
  ],
  "session-check": [
    "Not a session problem: ESPN changed the shape of `mRoster` — still working: standings, settings, the player pool; stopped: roster tools and every lineup analytic.",
  ],
  waivers: [
    'Opposite case: "KC Concepcion" — his expected points ran 11.61 above his points over 3 games (xfp_gap_sum +11.61); a usage number, not a signal.',
  ],
  trade: [bare(line("trade", "coreStopLine"))],
  "news-check": [bare(line("news-check", "coreStopLine"))],
} as const satisfies Record<string, readonly string[]>;
/** A fixed line with its placeholders filled in order. */
const fill = (s: string, ...values: string[]): string => {
  let i = 0;
  return bare(s).replace(/<[^<>]+>/g, () => values[i++] ?? "?");
};

describe("round 9's fixed lines (changelog §R18; R12-1, R15-7)", () => {
  it("the committed bundle carries every one, and the check is clean", () => {
    // weekly 13 (R18-5's read, rule, line, values and one-player rule; R18-8's held call, its
    // output, the byes line and WK-11's command rule), retro 8 (RT-6's lead, R18-6's rule and both
    // lines), roster-audit 1 (R18-7), injury-cascade 4, onboard 1, session-check 4, waivers 4,
    // trade 5 (R18-9's names, TR-INJ's label, TR-core's stop), news-check 3 (NC-core's stop)
    expect(fixedRows).toHaveLength(43);
    for (const [skill, file, , s] of fixedRows)
      expect(read(`skills/${skill}/${file}`), `${skill}: ${s}`).toContain(s);
    expect(errorsOf()).toBe("");
  });

  it.each(fixedRows)("%s/%s: cutting %s fails the check", (skill, file, k, s) => {
    expect(withEdit(`skills/${skill}/${file}`, every(s), "")).toContain(
      `skills/${skill}/${file}: round 9's fixed line "${k}" is missing: "${s}"`,
    );
  });

  it.each(fixedRows)("%s/%s: rewording %s fails the check", (skill, file, k, s) => {
    const changed = reword(s);
    expect(changed).not.toBe(s);
    expect(withEdit(`skills/${skill}/${file}`, every(s), changed)).toContain(
      `skills/${skill}/${file}: round 9's fixed line "${k}" is missing: "${s}"`,
    );
  });
});

describe("orient's Step-0 close, in every copy (R18-8, WK-8)", () => {
  const shared = read("skills/_shared/references/orient.md");
  const stop = shared.split("\n").find((l) => l.startsWith("**A stop at Step 0.**")) ?? "";

  it("the shared orient and every copy carry it, right after the Not-read line, and the stop still names the command once", () => {
    for (const [, s] of orientRows) {
      expect(stop).toContain(`${ORIENT_SENTENCES.stopNotRead} ${s};`);
      for (const skill of SKILLS)
        expect(read(`skills/${skill}/references/orient.md`), skill).toBe(shared);
    }
    expect(stop.match(/eff setup/g)).toHaveLength(1);
    // the close it pins is round 4's own, and the line keeps its one placeholder
    expect(bare(ORIENT_SENTENCES.stopNotRead)).toBe(
      "Not read: <the reads the question needs>; nothing of the question is answered here.",
    );
    expect(orientRows[0]?.[1]).toContain('"nothing of the question is answered here."');
    expect(REPORT).toContain('"nothing of the question is answered here."');
    expect(REPORT).toContain("Nothing of the week-5 briefing is answered here.");
  });

  it.each(orientRows)("cutting %s from the shared orient fails every rebuilt copy", (k, s) => {
    const e = withSharedEdit("orient.md", every(s), "");
    for (const skill of SKILLS)
      expect(e, skill).toContain(
        `skills/${skill}/references/orient.md: round 9's fixed line "${k}" is missing: "${s}"`,
      );
  });

  it.each(orientRows)("rewording %s in the shared orient fails every rebuilt copy", (k, s) => {
    const e = withSharedEdit("orient.md", every(s), reword(s));
    for (const skill of SKILLS)
      expect(e, skill).toContain(
        `skills/${skill}/references/orient.md: round 9's fixed line "${k}"`,
      );
  });

  it("a copy edited by hand, not rebuilt, is stale: the line lives in the shared file only", () => {
    const [, s] = orientRows[0] ?? ["", "?"];
    expect(withEdit("skills/weekly/references/orient.md", every(s), reword(s))).toContain(
      "stale generated file: skills/weekly/references/orient.md",
    );
  });
});

describe("the cheat-sheet's trade row names R18-9's field", () => {
  const sheet = read("skills/_shared/references/tool-outputs.md");
  const row = sheet.split("\n").find((l) => l.startsWith("| (P1) `espn_analyze_trade` |")) ?? "";

  it("the row carries it inside partners[], with the partner's other fields, in every copy", () => {
    expect(row).toContain(
      `— or \`partners[]\` (\`team_id\`, \`name\`, \`weakest_slot\`, \`proposal\` (\`give\`, \`get\` — \`player_id\`s), \`delta_me\`, \`delta_partner\`, ${tradePhrase}) |`,
    );
    expect(toolOutputFieldProblems(sheet)).toEqual([]);
    for (const skill of SKILLS)
      expect(read(`skills/${skill}/references/tool-outputs.md`), skill).toBe(sheet);
    // the ruling's field, its two keys and its order
    expect(RULINGS).toContain(
      "each partner gains `players[]: { player_id, name: UT }` for its `give` and `get` ids",
    );
    expect(tradePhrase).toContain(
      "`players[]` (`player_id`, `name` — one entry per id of that proposal's `give` and `get`, in that order",
    );
  });

  it.each(["cut", "reword"] as const)(
    "the phrase %s: the check fails on the shared file",
    (how) => {
      const to = how === "cut" ? "" : reword(tradePhrase);
      expect(withSharedEdit("tool-outputs.md", every(tradePhrase), to)).toContain(
        `skills/_shared/references/tool-outputs.md: the \`espn_analyze_trade\` row does not carry "${tradePhrase}"`,
      );
    },
  );
});

describe("the text round 9's triage withdrew", () => {
  it.each(absentRows)("%s/%s: restoring %s fails the check", (skill, file, gone) => {
    const rel = `skills/${skill}/${file}`;
    expect(withEdit(rel, /\n$/, `\n${gone}\n`)).toContain(
      `${rel}: text round 9's triage withdrew is still there: "${gone}"`,
    );
  });

  it("each was replaced in place (failing first: the round-9 bundle carried it there)", () => {
    // waivers' drop rule: the forecast became the opposite case's name for him
    expect(lineWith(body("waivers"), "- The drop never names a handcuff")).toMatch(
      new RegExp(`${esc(line("waivers", "dropOpposite"))}$`),
    );
    // weekly §3: the held-call rule stands where the free "Hold or stream" lead stood, the stream
    // text it led kept after it
    const s3 = lineWith(body("weekly"), '`espn_analyze_waivers` with `positions: ["K"]`');
    expect(s3).toContain(
      `one position per call (each result carries one \`hold_vs_stream\` and one \`rec\`). ${line("weekly", "heldCallRule")} ${line("weekly", "streamOnly")} ([priority waivers](references/priority-waivers.md)): in a priority league a stream is a free-agent add, not a claim`,
    );
  });
});

describe("the lines the rulings quote are their text, character for character", () => {
  it("R18-5: weekly prints injury-cascade's line, the ruling's words, with injury-cascade's values", () => {
    const ic = pin(ROUND7_FIXED, "injury-cascade", "otherIrLine");
    expect(line("weekly", "irLine")).toBe(ic);
    expect(RULINGS).toContain(bare(ic));
    expect(RULINGS).toContain("verbatim with its values filled in, naming them all");
    expect(
      line("weekly", "irValues").startsWith(pin(ROUND7_FIXED, "injury-cascade", "otherIrValues")),
    ).toBe(true);
    expect(RULINGS).toContain(
      "With one eligible player for an open seat, weekly's IR move does not change",
    );
    expect(line("weekly", "irOne")).toContain("weekly's IR move is unchanged");
  });

  it("R18-6: the not-scored line opens as the ruling gives it, and the verdict line is labelled as ESPN's", () => {
    expect(RULINGS).toContain('("Decision quality: not scored — …")');
    expect(bare(line("retro", "notScoredLine")).startsWith("Decision quality: not scored — ")).toBe(
      true,
    );
    expect(RULINGS).toContain("rests on their `projected_espn`, labelled as ESPN's");
    expect(bare(line("retro", "dqLine"))).toContain("on ESPN's projection before kickoff");
    expect(RULINGS).toContain(
      "retro reads the week's box score (`espn_get_box_score`, the user's `team_id`) once",
    );
    expect(line("retro", "unbackedRule")).toContain(
      "call `espn_get_box_score` for that week with the user's `team_id` once",
    );
    expect(line("retro", "notScoredRule")).toContain("and no verdict");
  });

  it("R18-8, weekly: the held call is the rec's own words, which the waivers tool writes", () => {
    // E5's action text for a rec that holds (no claim, no add): what weekly's call cell prints
    expect(waiverActionText(0, 0, 0, 2, "pre_run")).toBe(
      "no clear move: 2 on the scramble list after the run",
    );
    expect(waiverActionText(0, 0, 0, 0, "pre_run")).toBe("no claim clears the premium");
    expect(line("weekly", "heldCallRule")).toContain(
      '("no clear move: …", "no claim clears the premium")',
    );
    expect(RULINGS).toContain(
      "the rec's own words (\"No clear move: …\"), never a hold or stream of the run's own",
    );
    expect(REPORT).toContain('"Stream after the run"');
    expect(REPORT).toContain('"Optional stream"');
  });

  it("R18-8, injury-cascade: the share line's volume assumption is the cascade's own text", () => {
    const src = read("src/domain/analytics/cascade.ts");
    expect(src).toContain("`no line move is known: the team's volume is cut by ${");
    expect(src).toContain("} % without the starter`");
    const pct = String(Math.round((1 - CASCADE.volumeFactorNoLine) * 1000) / 10);
    expect(pct).toBe("3");
    expect(line("injury-cascade", "shareValues")).toContain(
      `"no line move is known: the team's volume is cut by ${pct} % without the starter"`,
    );
    expect(REPORT).toContain(
      "the rec's assumption \"the team's volume is cut by 3 % without the starter\"",
    );
  });

  it("the lines worded here keep the report's proposed words (fixed-lines.md of the §R18 fix round)", () => {
    // SC-4: the report's line, its last placeholder trimmed to the Stops cell's own words
    expect(REPORT).toContain(
      "Not a session problem: ESPN changed the shape of <view> — still working: <the table's Still works>; stopped: <the table's Stops>.",
    );
    expect(bare(line("session-check", "driftLine"))).toBe(
      "Not a session problem: ESPN changed the shape of `<view>` — still working: <still works>; stopped: <stops>.",
    );
    // WV-2: the report's line verbatim
    const opposite =
      "Opposite case: <name> — his expected points ran <x> above his points over <n> games (xfp_gap_sum +<x>); a usage number, not a signal.";
    expect(REPORT).toContain(opposite);
    expect(bare(line("waivers", "oppositeLine"))).toBe(opposite);
    // ON-INJ: the report's example of the days
    expect(REPORT).toContain('("runs Mon, Wed, Thu, Fri, Sat, Sun")');
    expect(line("onboard", "daysRule")).toContain(
      '("runs Mon, Wed, Thu, Fri, Sat, Sun" when Tuesday is not listed)',
    );
    // RT-6 and R18-7: the report's and the ruling's words
    expect(REPORT).toContain('every later one says "scored" ("Every scored call …")');
    expect(line("retro", "truncLead")).toContain(
      'every later sentence about the calls says "scored"',
    );
    expect(RULINGS).toContain(
      "roster-audit's Recommendation is the rec's action and subjects only; the stash verdicts and droppables are listed in Numbers",
    );
    expect(line("roster-audit", "recOnly")).toContain("they are listed in **Numbers**");
  });
});

describe("each line where its rule prints it", () => {
  it("weekly: the read in step 2, the IR rule in step 5, the held call in step 3, the byes line and the command rule in the output", () => {
    const b = body("weekly");
    const step2 = lineWith(b, "2. `espn_get_roster` with `all: true`");
    expect(step2.endsWith(` ${line("weekly", "irRead")}`)).toBe(true);
    const step5 = lineWith(b, "From the injuries already read:");
    expect(step5).toContain(
      `on the bench is a free roster spot. ${line("weekly", "irRule")} ${line("weekly", "irLine")} — ${line("weekly", "irValues")} ${line("weekly", "irOne")} Byes for this week and the next two`,
    );
    const kd = b.split("\n### K and D/ST\n")[1]?.split("\n")[0];
    expect(kd).toBe(line("weekly", "kdstOutput"));
    const ib = b.split("\n### Injuries and byes\n")[1]?.split("\n")[0] ?? "";
    expect(ib).toContain(
      `never only a prose line; ${line("weekly", "byesRule")} ${line("weekly", "byesLine")} — ${line("weekly", "byesValues")} ${line("weekly", "byesNoPlan")}`,
    );
    const guard =
      (b.split("## Guardrails specific to weekly\n")[1] ?? "").split("\n\n")[0]?.split("\n") ?? [];
    expect(guard.at(-1)).toBe(line("weekly", "setupOnce"));
  });

  it("retro: R18-6's paragraph closes §4, and the lead rule follows the truncated-result line", () => {
    const b = body("retro");
    const s4 =
      (b.split("### 4. The players the question names — the box score\n")[1] ?? "").split(
        "\n### ",
      )[0] ?? "";
    expect(s4).toContain(
      `the outcome is reported apart from it (changelog §R10, R10-3).\n\n${line("retro", "unbackedRule")} ${line("retro", "dqLine")} — ${line("retro", "dqValues")} ${line("retro", "notScoredRule")} ${line("retro", "notScoredLine")} — ${line("retro", "notScoredValues")} ${line("retro", "dqApart")}`,
    );
    const calls = lineWith(b, "- `calls[]`:");
    expect(
      calls.endsWith(
        `${pin(ROUND8_FIXED, "retro", "scoredWholeLine")} ${line("retro", "truncLead")}`,
      ),
    ).toBe(true);
  });

  it("roster-audit: the Recommendation rule right after the IR section; injury-cascade: the split under the beneficiaries, the claim rule after the no-move bullet", () => {
    const ra = (body("roster-audit").split("## Output additions\n")[1] ?? "").split("\n");
    expect(ra[0]?.startsWith("- **The IR section first when `ir.invalid`**")).toBe(true);
    expect(ra[1]).toBe(`- ${line("roster-audit", "recOnly")}`);
    const ic = (body("injury-cascade").split("## Output additions\n")[1] ?? "").split("\n");
    const ben = ic.findIndex((l) => l.startsWith("- The beneficiaries:"));
    expect(ic[ben + 1]).toBe(
      `- ${line("injury-cascade", "shareRule")} ${line("injury-cascade", "shareLine")} — ${line("injury-cascade", "shareValues")}`,
    );
    const noMove = ic.findIndex((l) =>
      l.includes(pin(ROUND8_FIXED, "injury-cascade", "allRosteredWhole")),
    );
    // round 8's bullet stays whole (round9-skill-fixes.test.ts); the claim rule is the next bullet
    expect(ic[noMove]?.endsWith(pin(ROUND8_FIXED, "injury-cascade", "allRosteredWhole"))).toBe(
      true,
    );
    expect(ic[noMove + 1]).toBe(`- ${line("injury-cascade", "claimOnly")}`);
  });

  it("onboard: the days rule right after round 6's FAAB row; session-check: the drift answer after the table and last in the contract", () => {
    const on = lineWith(body("onboard"), "- The settings digest as one table");
    expect(on).toContain(
      `${pin(ROUND6_FIXED, "onboard", "waiversRowFaab")} ${line("onboard", "daysRule")}; and \`| Bench and IR | <bench> bench, <ir> IR |\`.`,
    );
    const sc = body("session-check");
    expect(sc).toContain(
      `before a game-day failure. |\n\n${line("session-check", "driftRule")} ${line("session-check", "driftLine")} — ${line("session-check", "driftValues")}\n\n**A league not known to be public.**`,
    );
    const contract =
      (sc.split("## Output contract\n")[1] ?? "").split("\n\n")[0]?.split("\n") ?? [];
    expect(contract.at(-1)).toBe(line("session-check", "driftContract"));
  });

  it("waivers: the opposite case in the touchdown-luck bullet; trade: the stop, the label and the names; news-check: the stop", () => {
    const wv = lineWith(body("waivers"), '"Touchdown luck: <name>');
    expect(wv).toContain(
      `never the top target on points alone."; ${line("waivers", "oppositeRule")} ${line("waivers", "oppositeLine")} — ${line("waivers", "oppositeValues")} The flag applies to every candidate the reply names`,
    );
    const tr = body("trade");
    expect(lineWith(tr, "- **Toolset.**")).toBe(
      `- **Toolset.** If \`server.toolset\` is \`core\`, stop and say: ${TOOLSET_STOP}. Nothing else runs under \`core\`. ${line("trade", "coreStopRule")} ${line("trade", "coreStopLine")} ${line("trade", "coreStopNothing")}`,
    );
    expect(
      lineWith(tr, "1. `espn_get_standings`").endsWith(
        `Its flag line is the output contract's injection-flag line, in Confidence & freshness only. ${line("trade", "flagLabel")}`,
      ),
    ).toBe(true);
    expect(
      lineWith(tr, "- `find_partners:").endsWith(
        `evaluate another as an offer only when the user picks it. ${line("trade", "namesRule")}`,
      ),
    ).toBe(true);
    expect(
      lineWith(body("news-check"), "Run Step 0 of [orient]").endsWith(
        `Nothing else runs under \`core\`. ${line("news-check", "coreStopRule")} ${line("news-check", "coreStopLine")} ${line("news-check", "coreStopNothing")}`,
      ),
    ).toBe(true);
  });
});

describe("no new line contradicts a rule beside it", () => {
  it("the core stops: the toolset stop stays once in each P1 body, the new lines carry it capitalised, no P0 body carries it", () => {
    for (const skill of ["trade", "news-check"]) {
      expect(body(skill).split(TOOLSET_STOP).length - 1, skill).toBe(1);
      expect(bare(line(skill, "coreStopLine"))).toContain(`. ${TOOLSET_STOP.replace(/^t/, "T")}.`);
    }
    for (const skill of P1_SKILLS) expect(body(skill), skill).toContain(TOOLSET_STOP);
    for (const skill of P0_SKILLS) expect(body(skill), skill).not.toContain(TOOLSET_STOP);
    // schedule-plan's stop already says nothing else is said; the two hardenings say the same
    expect(body("schedule-plan")).toContain(
      "Nothing else runs under `core`, and nothing else is said",
    );
  });

  it("weekly: the held call is named as the rec names it, as guardrail 9 and the output's sub-decision rule say", () => {
    const b = body("weekly");
    expect(b).toContain("a sub-decision the rec holds is one line, named as the rec names it");
    expect(b).toContain(
      'a change the rec holds is **"no move"**, said plainly and named as the rec names it',
    );
    // the IR rule moves no one and the line picks no one, as injury-cascade's own rule
    expect(body("injury-cascade")).toContain("Only the injured player moves to IR in this answer.");
    expect(line("weekly", "irRule")).toContain("weekly moves no one to IR");
    expect(body("roster-audit")).toContain(
      "Each bench player the answer moves to an open IR slot gets this fixed line",
    );
    // the byes line is no move, so the deadline rule's "a move named outside a table" never reaches it
    expect(line("weekly", "byesNoPlan")).toContain("no move, add, stream or pickup");
    // the partial briefing's one command is orient's rule for every partial answer
    expect(read("skills/weekly/references/orient.md")).toContain(ORIENT_SENTENCES.partialKeeps);
  });

  it('retro: R10-3\'s named-player rule and the truncation lines stand; the decision-quality lines say "scored" under truncation', () => {
    const b = body("retro");
    expect(b).toContain(
      "Decision quality comes from what was known before kickoff; the outcome is reported apart from it (changelog §R10, R10-3).",
    );
    expect(b).toContain("- Never score a call by its outcome alone.");
    expect(b).toContain(pin(ROUND6_FIXED, "retro", "singleKindLine"));
    expect(line("retro", "dqValues")).toContain(
      'under truncation "the scored lineup call", "the <N> scored lineup calls"',
    );
    expect(line("retro", "unbackedRule")).toContain("never a second");
  });

  it("session-check: the command line SC-INJ's graders read is unchanged; waivers: the words WV-2 07's instance names are kept", () => {
    expect(body("session-check")).toContain(
      "- **The one command:** `eff setup`, in a terminal — exactly that, nothing pasted into it.",
    );
    expect(body("session-check")).toContain(
      "- The reminder: re-running `eff setup` about every 30 days avoids game-day failures.",
    );
    expect(body("waivers")).toContain(
      "one whose expected points run ahead of his scoring is the opposite case",
    );
    expect(body("waivers")).not.toContain("his points are coming");
  });
});

describe("the free graders that read these places take the lines, filled in from their fixtures", () => {
  it("each filled line is its pin with its fixture's values (fixed-lines.md's fills)", () => {
    expect(
      fill(
        line("weekly", "irLine"),
        '"Tank Dell" (4366031, INJURY_RESERVE), "Rachaad White" (4697815, OUT)',
      ),
    ).toBe(FILLED.weekly[0]);
    expect(
      fill(
        line("weekly", "byesLine"),
        "7",
        '"James Cook III" (RB), "Bhayshul Tuten" (RB), "Cam Little" (K) — 2 at RB',
      ),
    ).toBe(FILLED.weekly[1]);
    expect(fill(line("weekly", "byesLine"), "5", "none of your starters")).toBe(FILLED.weekly[2]);
    const dq = (calls: string) =>
      fill(line("retro", "dqLine"), "sound", calls, "Drake Maye", "20.14", "Bo Nix", "16.26");
    expect(dq("the lineup call")).toBe(FILLED.retro[0]);
    expect(dq("the 15 scored lineup calls")).toBe(FILLED.retro[1]);
    expect(
      fill(
        line("retro", "notScoredLine"),
        "the 17 scored evidence calls",
        "no alternative was logged to weigh against",
      ),
    ).toBe(FILLED.retro[2]);
    expect(
      fill(
        line("injury-cascade", "shareLine"),
        "3.651 targets",
        "no line move is known: the team's volume is cut by 3 % without the starter",
      ),
    ).toBe(FILLED["injury-cascade"][0]);
    expect(
      fill(pin(ROUND6_FIXED, "onboard", "waiversRowRolling"), "24", "Mon, Wed, Thu, Fri, Sat, Sun"),
    ).toBe(FILLED.onboard[0]);
    expect(
      fill(
        line("session-check", "driftLine"),
        "mRoster",
        "standings, settings, the player pool",
        "roster tools and every lineup analytic",
      ),
    ).toBe(FILLED["session-check"][0]);
    // the drift line's two cells are orient's drift-table row for the view, word for word
    const row = lineWith(read("skills/session-check/references/orient.md"), "| `mRoster` |");
    expect(row).toContain(
      "| standings, settings, the player pool | roster tools and every lineup analytic — ",
    );
    expect(fill(line("waivers", "oppositeLine"), '"KC Concepcion"', "11.61", "3", "11.61")).toBe(
      FILLED.waivers[0],
    );
  });

  it("no regex_absent grader of the line's Skill trips on it, in any of R15-7's forms", () => {
    for (const [skill, lines] of Object.entries(FILLED))
      for (const l of lines)
        for (const g of freeGraders(skill).filter((x) => x.absent))
          for (const f of forms(l)) expect(g.re.test(f), `${g.name} on ${f}`).toBe(false);
  });

  it("TR-CORE's and NC-CORE's regexes take the core stop lines", () => {
    for (const [skill, name] of [
      ["trade", "TR-CORE"],
      ["news-check", "NC-CORE"],
    ] as const) {
      const l = bare(line(skill, "coreStopLine"));
      expect(graderBy(skill, name, "The reply names the full toolset setting").test(l)).toBe(true);
      expect(graderBy(skill, name, "The reply says to restart the client").test(l)).toBe(true);
    }
  });

  it("WK-1 08 and 09 take a briefing with the IR line, the held calls in the rec's words and the byes lines", () => {
    const deadlineCol = graderBy("weekly", "WK-1", "Each action section");
    const blankCell = graderBy("weekly", "WK-1", "No move row leaves its Deadline cell blank");
    const table = (head: string, rows: string[]) =>
      `${head}\n|${head
        .split("|")
        .slice(1, -1)
        .map(() => "---")
        .join("|")}|\n${rows.join("\n")}`;
    const reply = [
      "### Last week",
      "| Result | Score |\n|---|---|\n| Won | 100.96–96.44 |",
      "### This week's matchup and lineup",
      table(bare(pin(ROUND8_FIXED, "weekly", "lineupHeader")), [
        '| QB | "Drake Maye" (4431452) | 18.2 | 9.1 | 27.3 | — |',
      ]),
      "### Waivers",
      table("| Candidate | Verdict | Deadline (ET) |", ['| "Carnell Tate" (5000001) | pass | — |']),
      "### K and D/ST",
      table("| Position | Call | Top option | Deadline (ET) |", [
        '| K | no claim clears the premium | "Tyler Loop" (4697745): pass | — |',
        '| D/ST | no clear move: 2 on the scramble list after the run | "Jets D/ST" (-16020): `fa_add_after_run` | — |',
      ]),
      "### Injuries and byes",
      table("| Player | Tag | Move | Deadline (ET) |", [
        '| "Tank Dell" (4366031) | INJURY_RESERVE | — | — |',
        '| "Rachaad White" (4697815) | OUT | — | — |',
      ]),
      FILLED.weekly[0],
      FILLED.weekly[2],
      "Byes, week 6: none of your starters.",
      FILLED.weekly[1],
      "### League activity",
      "| Team | Move |\n|---|---|\n| Team 03 | added a WR |",
    ].join("\n\n");
    expect(deadlineCol.test(reply)).toBe(true);
    expect(blankCell.test(reply)).toBe(false);
    // failing first: the IR move round 9's runs gave one of the two (a Move cell, its time cut) trips 09
    const picked = reply.replace(
      '| "Rachaad White" (4697815) | OUT | — | — |',
      '| "Rachaad White" (4697815) | OUT | Move to IR | — |',
    );
    expect(blankCell.test(picked)).toBe(true);
  });
});

describe("the fixture facts the lines rest on (in process, no network)", () => {
  it("fx-10h and inj-teamname-json: one IR seat open and two eligible bench players, so R18-5's branch is the line", async () => {
    for (const variant of ["", "inj-teamname-json"]) {
      const fx = await fxLeague(variant);
      const ir = auditIr(seatsOf(myRoster(fx)), fx.slots);
      expect(ir.eligible_now, variant).toEqual([4366031, 4697815]);
      expect(ir.open_slots, variant).toBe(1);
      expect(ir.invalid, variant).toBe(false);
    }
  });
});

describe("every Skill's frontmatter is 8f1c406's, byte for byte (R18-1, R17-3: no description or when_to_use changes)", () => {
  // sha256 of each SKILL.md's frontmatter block (from the opening "---" through the closing one) at
  // 8f1c406, the head round 9 ran on (git show 8f1c406:skills/<skill>/SKILL.md)
  const AT_8F1C406: Readonly<Record<string, string>> = {
    apply: "6ab4cc5d66d0fec522c20ede9683df7245d6a40cebba1c4aa560ce57800271c3",
    "injury-cascade": "fcbbc668eaeea5c45effc6e5abfbacd7a912fc632cecae36e84862b587567cbb",
    "news-check": "95a5d030d2bb521db431d1c1425b4fa9eea2306277fb0f3138d98f35fe547389",
    onboard: "f90a70b75ff088094b0aade5a8b9a388e231a9d171fad5b1c301c0ccea6522a9",
    retro: "13fdd3332c71066c387f747ad14a8986a95f16aeae9960bbd6b83cab8cc03bda",
    "roster-audit": "b3c9e3629752f61df08bb88e0887a36349b6fb4d86b827e903207ccff658d507",
    "schedule-plan": "d4289e7141456681c30d4cfa1073ac0cffee7dd8566fc8610c1417541b7f6e3a",
    "session-check": "fd4cd028a657f7c61c9a649f36adfa79ab723d4a417760e03694102ebbdf9984",
    "start-sit": "f410458ab451628093167cb662e8719566b905337598f37998fd2f0279177535",
    "stream-kdef": "872c0277a5e93a341561df579720419ef0bd453b69f040613a3770bc26ff2bf8",
    trade: "b98081161af3ff8f17a784f6d2bd159fdcbc91d7d384e7359040ea5757f7c800",
    waivers: "982616f7ab06507b8a4350edd1ee1915f6b2e6c65e0b566659ccb08d9c616e1c",
    weekly: "33d0a7d36c9c0d6dc9585ebb512f26dbb5e56e280e43d07e08225454597ef7d0",
  };
  it.each(SKILLS)("%s", (skill) => {
    const fm = /^---\n[\s\S]*?\n---\n/.exec(body(skill))?.[0] ?? "";
    expect(fm.length).toBeGreaterThan(0);
    expect(createHash("sha256").update(fm).digest("hex")).toBe(AT_8F1C406[skill]);
  });
});
