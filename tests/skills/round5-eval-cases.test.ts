// round5-eval-cases.test.ts — round 4's eval-case fixes and the §R12 rulings on the eval cases
// (docs/evals/stage-c-plugin-eval.md, "Run of 2026-11-18, round 4 (after §R11)", #### eval_case_defect
// and Next steps item 3; changelog §R12, R12-1, R12-2 and R12-6). R12-1: every regex that checks a
// line the Skills give as a fixed line (scripts/skills/check-skills.mjs ROUND4_FIXED and the orient
// sentences) accepts that line as a reply prints it, filled in from the case's fixture, and plan 09
// §3's term for it, never a different meaning; the regexes round 4's replies failed with the line in
// place take the forms they used; WK-1's deadline criterion is graded free; WK-10's line is one judge
// per clause (R12-2); RT-4-E's, NC-7's and ON-6's PASS-if lines say what the fixture gives; SC-6 and
// SC-10 replay the earlier turn's session-check call; news-check's trigger set holds NC-2's, NC-6's
// and NC-7's prompts; plan 09 lists WV-8 and the variants the suite runs. Reads the committed bundle
// and plan; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HISTORY_SKILL_CALLS,
  SKILL_BASE_DIR_LABEL,
  planSuite,
} from "../../scripts/skills/build-plugin-evals.mjs";
import {
  ORIENT_SENTENCES,
  ROUND3_FIXED,
  ROUND4_FIXED,
  WEEKLY_HEADINGS,
} from "../../scripts/skills/check-skills.mjs";
import { ROOT } from "./helpers.js";

type Json = Record<string, unknown>;
interface Case {
  name: string;
  prompt: string;
  expected_output: string;
  expectations: string[];
  history?: { role: string; text: string }[];
}
interface Trigger {
  query: string;
  should_trigger: boolean;
}

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const caseOf = (skill: string, name: string): Case => {
  const c = (JSON.parse(read(`skills/${skill}/evals/evals.json`)) as { evals: Case[] }).evals.find(
    (x) => x.name === name,
  );
  if (c === undefined) throw new Error(`no case ${name} in ${skill}`);
  return c;
};
/** The case's regex (or regex_absent) grader whose sentence starts with `lead`, compiled as the build does (flags i). */
const graderOf = (skill: string, name: string, lead: string, kind = "regex"): RegExp => {
  const x = caseOf(skill, name).expectations.find((e) => e.startsWith(lead));
  const p =
    x === undefined
      ? undefined
      : new RegExp(`\\(${kind}:\\s*\x60([^\x60]+)\x60\\)\\s*$`).exec(x)?.[1];
  if (p === undefined) throw new Error(`${name}: no ${kind} grader "${lead}…"`);
  return new RegExp(p, "i");
};
const absentOf = (skill: string, name: string, lead: string): RegExp =>
  graderOf(skill, name, lead, "regex_absent");
const llmLines = (c: Case): string[] => c.expectations.filter((e) => /\(llm[,)]/.test(e));

/** A fixed line as check-skills holds it, without its quotation marks, its placeholders filled in order. */
const fill = (fixed: string, ...values: (string | number)[]): string => {
  let i = 0;
  return fixed.replace(/^["'`]|["'`]$/g, "").replace(/<[^<>]+>/g, () => String(values[i++] ?? "?"));
};
const F = ROUND4_FIXED as unknown as Record<string, { "SKILL.md": Record<string, string> }>;
const fixed = (skill: string, key: string): string => {
  const v = F[skill]?.["SKILL.md"][key];
  if (v === undefined) throw new Error(`ROUND4_FIXED has no ${skill}.${key}`);
  return v;
};
const unquote = (q: string) => q.replace(/^"|"$/g, "");
/** The quoted label inside a fixed sentence: `under the fixed label "Scramble list"` → Scramble list. */
const quoted = (s: string): string => /"([^"]+)"/.exec(s)?.[1] ?? s;
/** A label inside bold markers: `… a column labelled **Surplus (s)**` → Surplus (s). */
const bold = (s: string): string => /\*\*([^*]+)\*\*/.exec(s)?.[1] ?? s;

describe("R12-1: each regex that checks a fixed line accepts it as filled in from the fixture, and plan 09 §3's term", () => {
  const liveSplit = fill(fixed("start-sit", "liveSplit"), 2, 3, 4);
  const crossCheck = `${fill(fixed("start-sit", "crossCheckHeader"))}\n|---|---|---|---|\n| James Cook III (4379399) | 23.849 | 16.868 | 0.293 |`;
  const unconfirmed = fill(fixed("start-sit", "unconfirmed"), "Ashton Jeanty", "ACTIVE");
  // waivers' label names its values N and low–high, not in angle brackets
  const premium = quoted(fixed("waivers", "premiumLabel"))
    .replace(": N,", ": 27,")
    .replace("[low–high]", "[13.5–40.4]");
  const surplusLabel = bold(
    (ROUND3_FIXED as unknown as Record<string, { "SKILL.md": Record<string, string> }>).waivers?.[
      "SKILL.md"
    ].surplusLabel ?? "",
  );
  const irColumn = bold(fixed("waivers", "irColumn"));
  const priors = fill(fixed("news-check", "priorsLine"), 0);
  const roleHolds = bold(fixed("injury-cascade", "roleHoldsColumn"));
  const selfCheck = fill(fixed("onboard", "selfCheckLine"), 14, 15);
  const followed = bold(fixed("retro", "followedColumn"));
  const nTooSmall = fill(fixed("retro", "nTooSmall")).replace("N of 30", "0 of 30");
  const unscored = fill(fixed("retro", "unscored"))
    .replace("M − N", "9")
    .replace(/^N of/, "15 of")
    .replace("week's M", "week's 24");
  const implied = bold(fixed("stream-kdef", "impliedColumn"));
  const afterRun = fill(fixed("stream-kdef", "afterRun")).replace(
    "`next_run_at`",
    "Wed 3:30 AM ET",
  );
  const delta = fill(fixed("trade", "deltaHeader"));
  const partial = /"(Partial: ESPN rejected the stored session — not read: <[^>]+>\.)"/.exec(
    ORIENT_SENTENCES.partialFirstLine,
  )?.[1];

  it("the fixed lines are the Skills' (sanity: each is filled, nothing left in angle brackets)", () => {
    expect(liveSplit).toBe("Your starters: final 2, live 3, pending 4");
    expect(crossCheck.startsWith("| Starter | ESPN | Ours | pct |")).toBe(true);
    expect(unconfirmed).toBe(
      "Ashton Jeanty's inactive report is unconfirmed: ESPN's status for him is ACTIVE.",
    );
    expect(premium).toBe("Premium Π(k, W): 27, band [13.5–40.4]");
    expect(surplusLabel).toBe("Surplus (s)");
    expect(irColumn).toBe("Surplus with the IR move");
    expect(roleHolds).toBe("P(role holds)");
    expect(selfCheck).toBe("Self-check: 14 match, 15 mismatch");
    expect(followed).toBe("Followed");
    expect(nTooSmall).toBe("n too small (0 of 30)");
    expect(unscored).toBe(
      "15 of the week's 24 calls were scored; nothing is said here about the other 9.",
    );
    expect(implied).toBe("Implied total");
    expect(delta).toBe("| Side | Δ mean | p10 | p90 | basis |");
    expect(partial).toBeDefined();
    for (const s of [liveSplit, unconfirmed, premium, priors, selfCheck, unscored, afterRun])
      expect(s).not.toMatch(/[<>]/);
  });

  const table = (head: string[], row: (string | number)[]) =>
    `| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|\n| ${row.join(" | ")} |`;

  it.each<[string, string, string, () => string[], string[]]>([
    // [skill, case, grader lead, the fixed line(s) as a reply prints them, plan 09 §3's term]
    [
      "start-sit",
      "SS-9",
      "The reply splits the players into final, live and pending",
      () => [liveSplit],
      ["Final: Tuten, Little. Live: Jeanty, Maye, Fannin. Pending: Cook, Smith-Njigba, Shaheed."],
    ],
    [
      "start-sit",
      "SS-11-E",
      "The reply splits the players into final, live and pending",
      () => [liveSplit],
      ["Final: Tuten, Little. Live: Jeanty, Maye, Fannin. Pending: Cook, Smith-Njigba, Shaheed."],
    ],
    [
      "start-sit",
      "SS-6-E",
      "The reply labels ESPN's projection as ESPN's",
      () => [crossCheck],
      ["ESPN's projection for James Cook III is 23.8; ours is 16.9."],
    ],
    [
      "start-sit",
      "SS-6-E",
      "The reply gives Cook's two numbers",
      () => [crossCheck],
      ["ESPN's projection for James Cook III is 23.8; ours is 16.9."],
    ],
    [
      "start-sit",
      "SS-6-E",
      "The reply gives the gap between them",
      () => [crossCheck],
      ["They differ by pct 0.293."],
    ],
    [
      "start-sit",
      "SS-12",
      "The reply calls the report unconfirmed",
      () => [unconfirmed],
      ["The report is unconfirmed."],
    ],
    [
      "start-sit",
      "SS-INJ-2",
      "The reply calls the report unconfirmed",
      () => [unconfirmed],
      ["The report is unconfirmed."],
    ],
    [
      "waivers",
      "WV-1",
      "The reply prints the premium and the surplus",
      () => [
        `${premium}\n\n${table(["Candidate", surplusLabel, "Verdict"], ["Carnell Tate", 9.96, "pass"])}`,
      ],
      ["The premium is 27.0 (band 13.5–40.4); Tate's surplus is 9.96."],
    ],
    [
      "waivers",
      "WV-4-E",
      "The reply gives a scramble list",
      () => [`**${quoted(fixed("waivers", "scrambleLabel"))}:** Jacory Croskey-Merritt (4575131)`],
      ["The brief is mostly a scramble list."],
    ],
    [
      "waivers",
      "WV-6-E",
      "The reply gives a scramble list of free-agent adds",
      () => [`**${quoted(fixed("waivers", "scrambleLabel"))}:** Jacory Croskey-Merritt (4575131)`],
      ["Free-agent adds: Jacory Croskey-Merritt (4575131)."],
    ],
    [
      "waivers",
      "WV-5-E",
      "The reply ties the surplus to the IR move",
      () => [
        table(["Candidate", surplusLabel, irColumn], ["Carnell Tate", 9.957, 9.957]),
        // round 3's fixed line for equal surpluses (ROUND3_FIXED waivers.equalSurplus)
        "The IR move changes no surplus.",
      ],
      ["s 9.957, s_with_ir_move 9.957"],
    ],
    [
      "news-check",
      "NC-1",
      "The reply says the priors are hand-set",
      () => [priors],
      ["The priors are hand-set."],
    ],
    [
      "injury-cascade",
      "IC-1",
      "The reply gives each beneficiary's chance the role holds",
      () => [table(["Beneficiary", "Targets gained", roleHolds], ["Tyler Warren", 1.2, 0.7])],
      ["p_role_holds 0.70"],
    ],
    [
      "onboard",
      "ON-3",
      "The reply reports a mismatch",
      () => [selfCheck],
      ["Stat 53 is a mismatch."],
    ],
    [
      "retro",
      "RT-1",
      "The reply says which calls were followed",
      () => [table(["Call", followed, "Regret"], ["keep the current lineup", "yes", "+10.8"])],
      ["The call was followed."],
    ],
    [
      "retro",
      "RT-4-E",
      "The reply says the sample is too small",
      () => [nTooSmall],
      ["p_win: n too small"],
    ],
    [
      "retro",
      "RT-6",
      "The reply says 15 of the week's 24 calls were scored",
      () => [unscored],
      ["15 of 24 calls were scored."],
    ],
    [
      "stream-kdef",
      "KD-1",
      "The reply cites the opponent's implied total",
      () => [table(["D/ST", "Opponent", implied, "E"], ["Jets D/ST", "CLE", 17.5, 7.9])],
      ["CLE's implied team total is 17.5."],
    ],
    [
      "stream-kdef",
      "KD-4-E",
      "The reply says to add the defense as a free agent",
      () => [afterRun, "Add the Jets D/ST as a free agent once the run clears (Wed 3:30 AM ET)."],
      ["It's a free-agent add after the run."],
    ],
    [
      "trade",
      "TR-1",
      "The reply prints a p10 and a p90",
      () => [`${delta}\n|---|---|---|---|---|\n| You | −12.4 | −60.1 | 31.0 | player simulation |`],
      ["Your side: p10 −60.1, p90 31.0."],
    ],
    [
      "weekly",
      "WK-1",
      "The reply has all six section headings",
      () => [WEEKLY_HEADINGS.map((h) => `## ${h}\n…`).join("\n")],
      [WEEKLY_HEADINGS.map((h) => `**${h}**`).join("\n")],
    ],
    [
      "weekly",
      "WK-11",
      "The reply says what was not read",
      () => [fill(partial ?? "", "the lineup, waivers, K and D/ST")],
      ["The lineup was not read."],
    ],
    [
      "weekly",
      "WK-11",
      "Confidence & freshness says the briefing is partial",
      () => [
        `### Confidence & freshness\n${fill(partial ?? "", "the lineup, waivers, K and D/ST")}`,
      ],
      ["### Confidence & freshness\nThe briefing is partial: ESPN rejected the stored session."],
    ],
    [
      "weekly",
      "WK-10",
      "The reply says ESPN rejected the stored session",
      () => [fill(partial ?? "", "the transaction feed, standings, rosters and free-agent pool")],
      ["ESPN rejected the stored session."],
    ],
  ])("%s %s: %s", (skill, name, lead, lines, terms) => {
    const re = graderOf(skill, name, lead);
    for (const l of lines()) expect(re.test(l), `fixed line: ${l}`).toBe(true);
    for (const t of terms) expect(re.test(t), `plan 09's term: ${t}`).toBe(true);
  });

  it("the stop at Step 0 (orient's fixed lines) passes ON-6's, WK-9's and SS-13's free graders", () => {
    const steps = unquote(fixed("session-check", "handOffSteps").replace(/^step 4 reads /, ""));
    const stop = [
      unquote(ORIENT_SENTENCES.stopSessionRejected),
      fill(ORIENT_SENTENCES.stopNotRead, "the league's settings, roster and scoring"),
      "1. Log in at fantasy.espn.com in your browser.",
      "2. Open DevTools → Application → Cookies → https://fantasy.espn.com.",
      "3. Copy SWID (with the braces) and espn_s2.",
      `4. ${steps}`,
      /"(Hand-off: [^"]+)"/.exec(ORIENT_SENTENCES.handOff)?.[1] ?? "",
    ].join("\n");
    expect(stop).toContain("the command in the last line");
    expect(stop).toContain("Hand-off: the `espn-fantasy-football:session-check` Skill");
    const hands = "The reply hands over to the session-check Skill or gives its one command";
    for (const [skill, name, sections, publicLead] of [
      [
        "onboard",
        "ON-6",
        "The reply gives no heading of the output contract",
        "The reply never says the walkthrough runs on keyless public reads",
      ],
      [
        "weekly",
        "WK-9",
        "The reply gives no section of the briefing",
        "The reply never prints the public-league Session line",
      ],
      [
        "start-sit",
        "SS-13",
        "The reply gives no heading of the output contract",
        "The reply never prints the public-league Session line",
      ],
    ] as const) {
      expect(graderOf(skill, name, hands).test(stop), `${name} hand-off`).toBe(true);
      expect(absentOf(skill, name, sections).test(stop), `${name} sections`).toBe(false);
      expect(absentOf(skill, name, publicLead).test(stop), `${name} public line`).toBe(false);
    }
  });
});

describe("round 4's eval-case regexes take the forms its replies used with the line in place", () => {
  // [skill, case, lead, round 4's wordings (quoted from its kept replies), what must still fail]
  it.each<[string, string, string, string[], string[]]>([
    [
      "start-sit",
      "SS-9",
      "The reply splits the players into final, live and pending",
      [
        "| | You | Them |\n|---|---|---|\n| Starters done / playing / still to play | 2 / 3 / 4 | 1 / 5 / 3 |",
        "| | You | Them |\n|---|---|---|\n| Starters: done / playing / not started | 2 / 3 / 4 | 1 / 5 / 3 |",
        "- **Split:** your 9 starters are 2 final, 3 live and 4 pending. Team 10's are 1 final, 5 live and 3 pending.",
      ],
      [
        "Nothing is final yet — ESPN's live win probability is 75 %; ours is pending in this version.",
        "Final score so far: 64.2 to 51.0.",
        "Final: none yet. Live: Maye. Pending: Cook.",
        "Team 10 has 1 final, 5 live and 3 still to play.",
        "You're playing Team 10, and Jeanty is playing through a knock; Cook's game is done for the week.",
      ],
    ],
    [
      "start-sit",
      "SS-11-E",
      "The reply splits the players into final, live and pending",
      [
        "| Your starters | 2 final · 3 live · 4 pending | 1 final · 5 live · 3 pending | |",
        "You trail 55.2 to 73.2. You have 2 starters final, 3 live and 4 pending.",
        "You trail 55.16 to 73.24 with 2 of your starters final, 3 live and 4 still to play.",
        "**Your starters so far:**\n- **Final:** Tuten 16.0, Little 4.0\n- **Live:** Fannin 20.6, Jeanty 10.8, Maye 3.76\n- **Still to play:** the 4 starters above",
      ],
      [
        "Nothing is final yet — ESPN's live win probability is 75 %; ours is pending in this version.",
        "Team 10 has 5 players live and 3 still to play, which probably inflates our number for them.",
      ],
    ],
    [
      "waivers",
      "WV-5-E",
      "The reply ties the surplus to the IR move",
      [
        "The IR move changes none of these surpluses.",
        "The IR move changes no surplus for any of them.",
        "The IR move doesn't change anyone's surplus.",
        "| Candidate | s | s with IR move |\n|---|---|---|\n| Carnell Tate | 9.957 | 9.957 |",
      ],
      [
        "The IR move changes the surplus for Tate.",
        "Move Tank Dell to IR before the run.",
        "The IR move changes nothing about the claim order.",
      ],
    ],
    [
      "stream-kdef",
      "KD-4-E",
      "The reply says to add the defense as a free agent",
      ["Add one as a free agent once the run clears (after 3:30 AM ET Wed)."],
      ["Claim the Jets D/ST before the run.", "Put in a claim; it processes when the run clears."],
    ],
    [
      "roster-audit",
      "RA-2",
      "The reply names the move to IR",
      [
        'Move "Rachaad White" (`player_id` 4697815) from `BE` to the open `IR` slot.',
        "Move him from **BE** to **IR**.",
        "`BE` → `IR`",
      ],
      ["Don't move White to `IR` yet.", "Your `IR` slot is open.", "What do I do with my IR spot?"],
    ],
    [
      "start-sit",
      "SS-6-E",
      "The reply labels ESPN's projection as ESPN's",
      [
        '| Starter | ESPN | Ours |\n|---|---|---|\n| "James Cook III" (4379399) | 23.8 | 16.9 |',
        "| Player | **ESPN** | Ours (trailing stats) |\n|---|---|---|\n| Drake Maye | 20.1 | 7.0 |",
      ],
      [
        "ESPN's projection disagrees with ours.",
        "| Source |\n|---|\n| League data and ESPN projections from ESPN Fantasy (unofficial API); nflverse CC-BY-4.0 |",
        "| Starter | Ours |\n|---|---|\n| Cook | 16.9 |",
      ],
    ],
    [
      "injury-cascade",
      "IC-1",
      "The reply gives each beneficiary's chance the role holds",
      [
        "| Player | Extra targets/game | Chance the bigger role lasts | Evidence |\n|---|---|---|---|\n| Tyler Warren | 1.2 | 0.70 | B |",
      ],
      [
        "There is no chance that role holds once Pierce is back.",
        "His bigger role lasts while Pierce is out.",
        "There is no chance the bigger role lasts.",
      ],
    ],
    [
      "onboard",
      "ON-3",
      "The reply reports a mismatch",
      [
        "The tool's scoring doesn't match ESPN's.",
        "| Scoring | 0.5 per catch (**doesn't match ESPN**), 5 per passing TD |",
        "Self-check: 14 match, 15 mismatch",
        "Two mismatches on stat 53.",
      ],
      [
        "Every sampled player matches ESPN exactly.",
        "Does that match how your league seeds, ESPN's rule or points only?",
        // the round-5 verifier's V5S-7: onboard's own fixed line with no mismatch, and a condition
        "Self-check: 14 match, 0 mismatch",
        "Our numbers do not match ESPN only if a setting changed",
        "If our numbers do not match ESPN, rerun the setup.",
        "There is no mismatch on any stat.",
      ],
    ],
  ])("%s %s: %s", (skill, name, lead, passes, fails) => {
    const re = graderOf(skill, name, lead);
    for (const r of passes) expect(re.test(r), `passes: ${r}`).toBe(true);
    for (const r of fails) expect(re.test(r), `fails: ${r}`).toBe(false);
    expect(re.test(caseOf(skill, name).prompt), "the prompt alone").toBe(false);
  });
});

describe("WK-1: the deadline criterion is graded free, on weekly's fixed lines (R12-1; round 3's other option)", () => {
  const c = caseOf("weekly", "WK-1");
  // read inside each test, so a case without the grader fails that test, never the collection
  const columns = {
    test: (s: string) => graderOf("weekly", "WK-1", "Each action section").test(s),
  };
  const blank = {
    test: (s: string) =>
      absentOf("weekly", "WK-1", "No move row leaves its Deadline cell blank").test(s),
  };
  const briefing = (over: Partial<Record<string, string>> = {}) =>
    [
      "# Week 5 plan",
      "## Last week",
      "| Result | Score |\n|---|---|\n| Win | 100.96 – 96.44 |",
      "## This week's matchup and lineup",
      over.lineup ??
        "| Slot | Player | E | p10 | p90 | Deadline (ET) |\n|---|---|---|---|---|---|\n| QB | Drake Maye | 20.1 | 10.6 | 30.7 | Sun 1:00 PM |",
      "## Waivers",
      over.waivers ??
        "| Candidate | Verdict | Deadline |\n|---|---|---|\n| Carnell Tate | pass | — |",
      "## K and D/ST",
      over.kdst ??
        "| Pos | Call | Deadline |\n|---|---|---|\n| D/ST | Add Jets D/ST after the run | Wed 3:30 AM – Sun 1:00 PM ET |",
      "## Injuries and byes",
      over.injuries ??
        "| Player | Move | Deadline |\n|---|---|---|\n| Tank Dell | Move to the open IR slot | before Wed 3:30 AM ET |\n| Rachaad White | Hold on the bench | — |",
      "| Week | Teams on bye |\n|---|---|\n| 7 | BUF, LAC |",
      "## League activity",
      "| Item | Detail |\n|---|---|\n| Waiver order | 9, 2, 8 |",
      "### Deadlines",
      "- Wed 3:30 AM ET: the run",
    ].join("\n");

  it("round 4's judge 07 is gone; one judge grades only the moves outside a Deadline column (the round-5 verifier's V5S-4)", () => {
    expect(c.expectations.join("\n")).not.toMatch(/Every action the reply recommends names/);
    const deadlineJudges = llmLines(c).filter((l) => /deadline/i.test(l));
    expect(deadlineJudges).toHaveLength(1);
    expect(deadlineJudges[0]).toMatch(
      /^Every move the reply recommends outside a table's Deadline column — in a sentence, a list line, the Deadlines block or a table without that column — names when it is due/,
    );
    // one condition (changelog §R12, R12-2): its second sentence only says what is no move
    expect(deadlineJudges[0]).toMatch(
      /\. A pass, a hold or a row the tool holds is no move and needs none \(llm\)$/,
    );
  });

  it("the briefing weekly's fixed lines describe passes both graders", () => {
    expect(columns.test(briefing())).toBe(true);
    expect(blank.test(briefing())).toBe(false);
  });

  it.each([
    [
      "lineup",
      "| Slot | Player | E | Locks (ET) |\n|---|---|---|---|\n| QB | Drake Maye | 20.1 | Sun 1:00 PM |",
    ],
    ["waivers", "| Candidate | Verdict |\n|---|---|\n| Carnell Tate | pass |"],
    ["kdst", "- **D/ST:** add the Jets D/ST after the run, before Sun 1:00 PM ET."],
    ["injuries", "- **Tank Dell:** move him to the open IR slot before Wed 3:30 AM ET."],
  ])("a %s section with no Deadline column fails the columns grader", (section, text) => {
    expect(columns.test(briefing({ [section]: text }))).toBe(false);
  });

  it("a heading renamed from weekly's fixed six fails it too", () => {
    expect(
      columns.test(
        briefing().replace("## This week's matchup and lineup", "## This week: vs Team 10"),
      ),
    ).toBe(false);
  });

  it.each([
    "| Tank Dell | Move to the open IR slot | — |",
    "| Tank Dell | **Move to IR** | this week |",
    "| D/ST | Add Jets D/ST after the run |  |",
    "| FLEX | Start Vele over Shaheed | n/a |",
  ])("a move row without its time trips the blank-deadline grader: %s", (row) => {
    const b = briefing({
      injuries: `| Player | Move | Deadline |\n|---|---|---|\n${row}`,
    });
    expect(blank.test(b)).toBe(true);
  });

  it.each([
    "| Rachaad White | Hold on the bench | — |",
    "| K | **Hold Little.** Tyler Loop: pass | — |",
    "| Carnell Tate | pass | — |",
    "| D/ST | Keep the Rams; the Jets would be free-agent adds after the run | — |",
  ])("a held row (no move) passes it: %s", (row) => {
    const b = briefing({ injuries: `| Player | Move | Deadline |\n|---|---|---|\n${row}` });
    expect(blank.test(b)).toBe(false);
  });

  // the round-5 verifier's V5S-3: every cell is read, the first included; the Deadline cell is found
  // under its header wherever the column sits; Start and Bench are a move only as a swap
  it.each([
    [
      "a kept starter's role cell with a dash",
      "lineup",
      '| Slot | Player | Role | E | p10 | p90 | Deadline |\n|---|---|---|---|---|---|---|\n| QB | "Drake Maye" | start | 20.1 | 10.6 | 30.7 | — |',
      false,
    ],
    [
      "a Bench slot in the first cell",
      "lineup",
      "| Slot | Player | E | Deadline |\n|---|---|---|---|\n| Bench | Rachaad White | 0 | — |",
      false,
    ],
    [
      "a move in the first cell",
      "injuries",
      "| Move | Deadline |\n|---|---|\n| Move White to IR | — |",
      true,
    ],
    [
      "a Deadline column that is not last",
      "waivers",
      "| Player | Verdict | Deadline | Surplus |\n|---|---|---|---|\n| Tate | Claim | — | 10.0 |",
      true,
    ],
    [
      "a Deadline column that is not last, filled in",
      "waivers",
      "| Player | Verdict | Deadline | Surplus |\n|---|---|---|---|\n| Tate | Claim | Wed 3:30 AM ET | 10.0 |",
      false,
    ],
    [
      "rivals' moves in a table with no Deadline column",
      "activity",
      "| Team | Move | When |\n|---|---|---|\n| Team 03 | Add Tate | — |",
      false,
    ],
  ])("the blank-deadline grader on %s", (_label, section, text, trips) => {
    const b =
      section === "activity"
        ? briefing().replace("| Waiver order | 9, 2, 8 |", `| Waiver order | 9, 2, 8 |\n\n${text}`)
        : briefing({ [section]: text });
    expect(blank.test(b)).toBe(trips);
  });

  // the round-5 verifier's V5S-4: plan 09 §3.2's term — a move whose line gives its Deadline with a
  // time — is accepted in a section, and a move line with no time is not
  it.each([
    [
      "round 4's Sonnet base run 1's IR move",
      "- **Rachaad White** is OUT and **Tank Dell** carries an `INJURY_RESERVE` tag while sitting on your bench. Moving one of them to IR frees a bench spot. Deadline: before Wed 3:30 AM ET.",
      true,
    ],
    [
      "round 4's Sonnet Lane 2 run 1's IR move",
      "- **Rachaad White RB:** OUT, IR-eligible, on your bench. Move one to IR before the run (deadline Wed 3:30 AM ET).",
      true,
    ],
    [
      "a bold Deadline label and the run",
      "- Move Dell to the open IR slot. **Deadline:** the waiver run.",
      true,
    ],
    ["a move line with no time", "- **Tank Dell:** move him to the open IR slot.", false],
    ["a Deadline line that gives none", "- Move Dell to IR. Deadline: none.", false],
  ])("the columns grader on a prose move: %s", (_label, injuries, passes) => {
    expect(columns.test(briefing({ injuries }))).toBe(passes);
  });

  it("the expected output names the Deadline column on every action table and a time on every move row", () => {
    expect(c.expected_output).toMatch(/with a time on every move row/);
    expect(c.expected_output).toMatch(/'—' only on a row with no move/);
  });
});

describe("WK-10: one judge per clause (changelog §R12, R12-2), the empty history said", () => {
  const c = caseOf("weekly", "WK-10");
  const llm = llmLines(c);

  it("the six-part line is gone, and seven judges each grade one clause", () => {
    expect(c.expectations.join("\n")).not.toMatch(
      /labelled partial, says what the session-refusal lines leave out .* and gives eff setup once/,
    );
    // the round-5 verifier's V5S-5: the history clause and the hand-off clause were split too
    expect(llm).toHaveLength(7);
    // a fixed line a judge quotes, in its parentheses, is no clause of its own (changelog §R16, R16-5:
    // WK-10 08 quotes weekly's Partial line, which holds a ";")
    for (const l of llm)
      expect(l.replace(/\((?:[^()]|\([^()]*\))*\)/g, " ").split(/;/)).toHaveLength(1);
  });

  it("the history clause says the persisted history is empty on this seed", () => {
    // round 5's report (WK-10 08): the section reports the history, which is empty on this seed
    expect(llm.find((l) => l.includes("persisted history"))).toMatch(
      /reports the server's persisted history — 0 adds, drops, claims and trades in the 7-day window, empty on this seed/,
    );
  });

  it("the no-other-section clause is weekly's League-activity-only answer, Deadlines and Not actionable included", () => {
    const l = llm.find((x) => x.startsWith("No other section of the briefing")) ?? "";
    expect(l).toMatch(/League-activity-only answer/);
    expect(l).toMatch(/no Deadlines block and no Not actionable here list/);
    // weekly's narrowed-ask rule says the same (changelog §R12, R12-2: the PASS-if line never forbids
    // what the contract prints for the ask)
    expect(read("skills/weekly/SKILL.md")).toContain(fixed("weekly", "activityOnly"));
  });

  it("the other clauses: what the refusal lines leave out, Confidence & freshness, eff setup once in the hand-off line", () => {
    expect(
      llm.some((l) => l.includes("by-team activity, waiver-order movement and rival needs")),
    ).toBe(true);
    expect(
      llm.some((l) =>
        l.startsWith("Confidence & freshness says the section is partial because ESPN rejected"),
      ),
    ).toBe(true);
    expect(llm.some((l) => l.includes("gives eff setup once (the hand-off line)"))).toBe(true);
  });

  it("the expected output names the narrowed answer and orient's Partial line", () => {
    expect(c.expected_output).toMatch(/weekly's League-activity-only answer/);
    expect(c.expected_output).toMatch(/Partial: ESPN rejected the stored session — not read: …/);
  });
});

describe("the PASS-if lines round 4's judges failed on replies that met them, made exact (R11-3, R12-2)", () => {
  it("RT-4-E: the metrics that fill up first, and why each is empty on this log", () => {
    const c = caseOf("retro", "RT-4-E");
    const l = llmLines(c).find((x) => x.includes("swap regret")) ?? "";
    // one judge per clause (the round-5 verifier's V5S-5): the metrics, then why each is empty
    expect(l).toBe(
      "The reply names swap regret and projection CRPS as the metrics that fill up first (llm)",
    );
    expect(llmLines(c)).toContain(
      "The reply says why each of those two metrics is empty on this log (llm)",
    );
    expect(l).not.toMatch(/what to read instead/);
    // retro's own words: the two reach n 30 within weeks, so it leads with them
    expect(read("skills/retro/SKILL.md")).toContain(
      "swap regret and projection CRPS reach 30 within weeks, so lead with those",
    );
  });

  it("NC-7: the recommendation rests on this week's check, and the note is said not to be acted on — one judge each", () => {
    const llm = llmLines(caseOf("news-check", "NC-7"));
    expect(llm.join("\n")).not.toMatch(/follows this week's check, not the note/);
    // made exact in round 7's fix round (the round-6 section's NC-7 07 line; round7-eval-cases.test.ts)
    expect(llm).toContain(
      "The recommendation is `espn_analyze_evidence`'s rec for Ashton Jeanty (on this fixture 'no move: structured fields win over text') — the reply's judgement of the note against that check does not count against it (llm)",
    );
    expect(llm).toContain("The reply says the logged note is not acted on (llm)");
    expect(caseOf("news-check", "NC-7").expected_output).toMatch(
      /graded on the check it rests on, never on whether it differs from the note/,
    );
  });

  it("ON-6: the hand-off and the absent walkthrough, one judge each; the stop's own lines are no walkthrough", () => {
    const c = caseOf("onboard", "ON-6");
    const llm = llmLines(c);
    // the round-5 verifier's V5S-5: the rejection and the hand-off are one judge each
    expect(llm).toHaveLength(3);
    expect(llm[0]).toBe(
      "The reply says ESPN rejected the stored session on a league not known to be public (llm)",
    );
    expect(llm[1]).toBe("The reply hands over to the session-check Skill (llm)");
    expect(llm[2]).toMatch(/^The reply gives no onboarding walkthrough/);
    for (const extra of [
      "Session-check's own steps",
      "a line on what was not read",
      "a note that ESPN offers no API key",
      "a sentence on what onboarding does once the session works",
    ])
      expect(llm[2]).toContain(extra);
    expect(c.expected_output).toMatch(
      /a 'Not read: …' line, session-check's steps and the hand-off line/,
    );
  });
});

describe("SC-6 and SC-10 replay the earlier turn's session-check Skill call (round 4's SC-6)", () => {
  const plan = planSuite(ROOT);

  it("are listed beside SC-7-E, each on its first assistant turn", () => {
    const t = HISTORY_SKILL_CALLS as unknown as Record<string, { turn: number; skill: string }>;
    for (const n of ["SC-6", "SC-7-E", "SC-10"])
      expect(t[n]).toEqual({ turn: 1, skill: "session-check" });
  });

  it.each(["sc-6", "sc-10"])(
    "%s: the history holds the Skill call, its result and the Skill's text before the earlier answer",
    (dir) => {
      expect(plan.errors).toEqual([]);
      const c = plan.cases.find((x) => x.dir === `session-check--${dir}`);
      const lines = (c?.files.find((f) => f.rel === "history.jsonl")?.text ?? "")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as Json);
      expect(lines).toHaveLength(5);
      for (let i = 1; i < lines.length; i++) expect(lines[i]!.parentUuid).toBe(lines[i - 1]!.uuid);
      const msg = (l: Json) => l.message as { role: string; content: unknown };
      const use = (msg(lines[1]!).content as Json[])[0]!;
      expect(use).toMatchObject({
        type: "tool_use",
        name: "Skill",
        input: { skill: "espn-fantasy-football:session-check" },
      });
      expect((msg(lines[2]!).content as Json[])[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: use.id,
      });
      expect(lines[3]).toMatchObject({ type: "user", isMeta: true });
      const text = (msg(lines[3]!).content as { text: string }[])[0]?.text ?? "";
      expect(text.startsWith(`${SKILL_BASE_DIR_LABEL} `)).toBe(true);
      expect(text).toMatch(/\/plugins\/[^/\n]+\/skills\/session-check\n\n# session-check/);
      expect(JSON.stringify(msg(lines[4]!).content)).toContain(
        "Tell me when you have run eff setup",
      );
    },
  );
});

describe("news-check's trigger set holds NC-2's, NC-6's and NC-7's Lane 2 prompts (round 4: a load regression shows in the trigger lane)", () => {
  const t = JSON.parse(read("skills/news-check/evals/trigger_eval.json")) as Trigger[];
  const pos = t.filter((x) => x.should_trigger).map((x) => x.query);
  const neg = t.filter((x) => !x.should_trigger).map((x) => x.query);

  it("each prompt is a positive, verbatim", () => {
    for (const n of ["NC-2", "NC-6", "NC-7"]) expect(pos).toContain(caseOf("news-check", n).prompt);
  });

  it("three negatives keep the balance: a trade, a lineup and a scoring-rule ask, none a news check", () => {
    expect(pos.length).toBe(neg.length);
    expect(neg).toEqual(
      expect.arrayContaining([
        "Should I trade my tight end for their RB2?",
        "Is my lineup right for this week?",
        "How many points does a reception score in my league?",
      ]),
    );
  });
});

describe("R12-6: plan 09 names every case and variant the suite runs", () => {
  const plan9 = read("docs/plan/09-skills-bundle.md");
  it("§3.8 lists WV-8", () => {
    const wv = /### 3\.8 [\s\S]*?\n- \*\*Evals\.\*\*([^\n]*)/.exec(plan9)?.[1] ?? "";
    expect(wv).toMatch(/`WV-8`/);
  });
  it("§5.2's variant list names td-inflated and inj-player-name", () => {
    const v = /\*\*Fixture league and variants\.\*\*([^\n]*)/.exec(plan9)?.[1] ?? "";
    expect(v).toMatch(/`?td-inflated`?/);
    expect(v).toMatch(/`inj-player-name`/);
    expect(v).not.toMatch(/the six `inj-\*` variants/);
    // every variant the build's manifest lists is one §5.2 names or counts
    const manifest = JSON.parse(read("scripts/skills/manifest.json")) as {
      fixture: { variants: string[] };
    };
    const inj = manifest.fixture.variants.filter((x) => x.startsWith("inj-"));
    const count = ["six", "seven", "eight"][inj.length - 6] ?? String(inj.length);
    expect(v).toContain(`the ${count} \`inj-*\` variants`);
  });
});

// The round-5 verifier's V5S-5 (changelog §R12, R12-2: a PASS-if line that joins several conditions
// is split into one judge per condition): the six lines it named, each clause its own judge, every
// clause kept.
describe("R12-2's split on the lines the round-5 verifier named", () => {
  it.each([
    [
      "onboard",
      "ON-6",
      [
        "The reply says ESPN rejected the stored session on a league not known to be public (llm)",
        "The reply hands over to the session-check Skill (llm)",
      ],
    ],
    [
      "retro",
      "RT-4-E",
      [
        "The reply names swap regret and projection CRPS as the metrics that fill up first (llm)",
        "The reply says why each of those two metrics is empty on this log (llm)",
      ],
    ],
    [
      "roster-audit",
      "RA-1",
      [
        // RA-1 04, the phase, is a free grader on its fixed line since round 7's fix round
        // (changelog §R15, R15-3 as amended; round7-eval-cases.test.ts)
        "The reply states the bench template as derived from this league's curves, not as a rule (llm)",
        "The reply gives the bench template's reason (llm)",
      ],
    ],
    [
      "weekly",
      "WK-10",
      [
        // changelog §R16, R16-5: 08 quotes weekly's fixed Partial line (round8-eval-cases.test.ts)
        `The League activity section reports the server's persisted history — 0 adds, drops, claims and trades in the 7-day window, empty on this seed (weekly's fixed line 'Partial — the server's persisted history only: <a> adds, <d> drops, <c> claims, <t> trades in the 7-day window; not read: <the refused reads> (by-team activity, waiver-order movement and rival needs go without them).' reports it, with 0 for each) (llm)`,
        "The League activity section gives no transaction, standing or waiver-order figure the tools did not return (llm)",
        "The answer ends with the hand-off line to session-check (llm)",
        "The answer gives eff setup once (the hand-off line) — never again in the section or in Confidence & freshness (llm)",
      ],
    ],
    [
      "weekly",
      "WK-11",
      [
        // changelog §R13, R13-1 (the R13 refix verifier's F2): what was read and its label, one each
        "Wherever ESPN's 401 landed, the reply presents only what was read before it (llm)",
        "Wherever ESPN's 401 landed, the reply labels what it presents partial (llm)",
        "The reply says every later section or input was not read (llm)",
        "The reply invents none of what was not read: no score, lineup, projection, waiver or activity figure the tools did not return (llm)",
        "Confidence & freshness says the briefing is partial because ESPN rejected the stored session (llm)",
        "No tool call that ESPN refused is made again (llm)",
        "The briefing ends with the hand-off to session-check (llm)",
        "The briefing gives eff setup once (the hand-off line) (llm)",
      ],
    ],
  ])("%s %s: one judge per clause", (skill, name, judges) => {
    const llm = llmLines(caseOf(skill, name));
    for (const j of judges) expect(llm).toContain(j);
    // no judge of the case joins two of the named clauses again
    for (const l of llm) {
      expect(l, l).not.toMatch(
        / and (?:hands over|says why|states the bench|gives no transaction|gives eff setup)\b/,
      );
      expect(l.replace(/\([^)]*\)/g, "").split(";"), l).toHaveLength(1);
    }
  });
});
