// session-line-texts.test.ts — round 4d's Skills texts against the server's own lines: the any-tool
// session line (src/mcp/refusals.ts sessionReadsWarning; changelog §R10, R10-7, R10-12) as the
// cheat-sheet and orient quote it, E13's box-scores line in its row (retro), E11's history line when
// the feed was not read (changelog §R10, R10-11), and WK-11 — the full briefing on the mid-procedure
// state (changelog §R10, R10-31), graded only on what holds wherever ESPN's 401 lands. Each regex
// grader passes two correct replies (prose and a table, with the 401 landing at different reads)
// and fails the output contract's fixed lines, orient's mandated lines as rendered, the prompt and a
// reply stating the opposite claim.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  contractLines,
  lineRenderings,
  mandatedLineProblems,
  mandatedLines,
  SEEDS,
} from "../../scripts/skills/build-plugin-evals.mjs";
import {
  ACTIVITY_NO_FEED_HISTORY_LINE,
  ACTIVITY_PARTIAL_FRAGMENTS,
  ORIENT_SENTENCES,
  RETRO_SESSION_SENTENCE,
  SESSION_LINE_FRAGMENTS,
  SKILL_RULES,
  TOOL_OUTPUT_PHRASES,
  TOOL_OUTPUT_SHEET_PHRASES,
} from "../../scripts/skills/check-skills.mjs";
import {
  SESSION_READ_OF,
  sessionReadsWarning,
  type SessionRefusal,
} from "../../src/mcp/refusals.js";
import {
  activityLeagueReadsWarning,
  type ActivityLeagueRead,
  SESSION_READ_WARNINGS,
} from "../../src/mcp/tools/common.js";
import { ROOT } from "./helpers.js";

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const sheet = read("skills/_shared/references/tool-outputs.md");
const orient = read("skills/_shared/references/orient.md");
const template = read("skills/_shared/references/output-template.md");

/** A quoted form as an anchored RegExp over a whole line: "…" elides the words that vary. */
const formRe = (quoted: string): RegExp => {
  const body = quoted.replace(/^"|"$/g, "");
  const parts = body.split(/\s*…\s*/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[\\s\\S]*?")}$`);
};

/** The league reads the session line can name, and another season's form of each ("2025 …"). */
const LEAGUE_READS: readonly string[] = [...new Set(Object.values(SESSION_READ_OF))].filter(
  (r) => r !== "pending claims",
);
const readsArb = fc
  .tuple(
    fc.subarray([...LEAGUE_READS, "league data"], { minLength: 1 }),
    fc.boolean(),
    fc.boolean(),
  )
  .map(([xs, season, pending]) => [
    ...(season ? xs.map((r, i) => (i === 0 ? `2025 ${r}` : r)) : xs),
    ...(pending ? ["pending claims"] : []),
  ]);
const refusalArb = fc.constantFrom<SessionRefusal>("rejected", "no_session");
const ACTIVITY_READS: readonly ActivityLeagueRead[] = ["standings", "rosters", "free-agent pool"];

describe("the any-tool session line, as the cheat-sheet quotes it (changelog §R10, R10-7, R10-12)", () => {
  const [rejectedForm, noneForm] = SESSION_LINE_FRAGMENTS.map(formRe);

  it("each form matches the server's line for its refusal, whatever league reads it names, and only that one", () => {
    fc.assert(
      fc.property(readsArb, refusalArb, (reads, refusal) => {
        const line = sessionReadsWarning(refusal, reads);
        expect(rejectedForm?.test(line)).toBe(refusal === "rejected");
        expect(noneForm?.test(line)).toBe(refusal === "no_session");
        // never read as data unavailable
        expect(line).not.toMatch(/unavailable/);
      }),
    );
  });

  it("neither form matches E11's own lines, which the row quotes on their own", () => {
    for (const f of [rejectedForm, noneForm]) {
      expect(f?.test(SESSION_READ_WARNINGS.feed_rejected)).toBe(false);
      expect(f?.test(SESSION_READ_WARNINGS.feed_no_session)).toBe(false);
      for (const n of [1, 2, 3])
        for (const reads of fc.sample(fc.subarray([...ACTIVITY_READS], { minLength: n }), 5)) {
          const ordered = ACTIVITY_READS.filter((r) => reads.includes(r));
          expect(f?.test(activityLeagueReadsWarning("rejected", ordered))).toBe(false);
          expect(f?.test(activityLeagueReadsWarning("no_session", ordered))).toBe(false);
        }
    }
  });

  it("the cheat-sheet's partial rule carries both forms and says the line is never 'unavailable'", () => {
    const rule = sheet.split("\n").find((l) => l.startsWith("**`partial: true`**")) ?? "";
    for (const f of SESSION_LINE_FRAGMENTS) expect(rule).toContain(f);
    expect(rule).toContain('it is never a "… unavailable" line');
    expect(
      TOOL_OUTPUT_SHEET_PHRASES.some((p) => p.includes(SESSION_LINE_FRAGMENTS[0] ?? "-")),
    ).toBe(true);
    // a stale form (the old "N week(s) of box scores unavailable") is no line the server writes
    const stale = formRe('"partial: … unavailable …"');
    fc.assert(
      fc.property(readsArb, refusalArb, (reads, refusal) => {
        expect(stale.test(sessionReadsWarning(refusal, reads))).toBe(false);
      }),
    );
  });

  it("orient sends a session-line partial to the same hand-off as an ESPN_AUTH_REJECTED", () => {
    const s = ORIENT_SENTENCES.sessionLinePartial;
    expect(orient).toContain(s);
    // it sits in the mid-procedure paragraph, after the rejection rule it extends
    const para =
      orient.split("\n").find((l) => l.startsWith("**A rejection mid-procedure.**")) ?? "";
    expect(para).toContain(ORIENT_SENTENCES.midProcedure);
    expect(para).toContain(s);
    expect(s).toMatch(/never fill it in or call the tool again for it/);
    expect(s).toMatch(/end the procedure with the same hand-off/);
    // every installed orient copy carries it
    for (const skill of Object.keys(SKILL_RULES)) {
      const copy = path.join(ROOT, "skills", skill, "references", "orient.md");
      let text: string;
      try {
        text = readFileSync(copy, "utf8");
      } catch {
        continue;
      }
      expect(text, skill).toContain(s);
    }
  });
});

describe("E13's session line in its row (retro; the round-4d product account)", () => {
  it("the row quotes the server's box-scores line word for word, both refusals", () => {
    const quoted =
      /"(partial: the stored ESPN session was rejected, and ESPN's box scores [^"]+)"/.exec(
        TOOL_OUTPUT_PHRASES.espn_analyze_retrospective.join(" "),
      )?.[1];
    expect(quoted).toBe(sessionReadsWarning("rejected", ["box scores"]));
    const row =
      sheet.split("\n").find((l) => l.startsWith("| `espn_analyze_retrospective` |")) ?? "";
    expect(row).toContain(`"${sessionReadsWarning("rejected", ["box scores"])}"`);
    // the none-stored form's quoted ends are the server's
    const none = sessionReadsWarning("no_session", ["box scores"]);
    expect(none).toMatch(/, and none is stored: /);
    expect(none).toMatch(/ to add one$/);
    expect(row).toContain('"… and none is stored: … to add one"');
    expect(row).toContain("never counted as unavailable");
    expect(row).toContain("**A rejection mid-procedure**");
  });
});

describe("retro on E13's session line (changelog §R10, R10-7, R10-12)", () => {
  it("step 3 carries the rule, check-skills requires it, and a body without it fails the rule", () => {
    const retro = read("skills/retro/SKILL.md");
    expect(retro).toContain(RETRO_SESSION_SENTENCE);
    const step3 =
      retro.split("\n").find((l) => l.startsWith("`espn_analyze_retrospective` for that week.")) ??
      "";
    expect(step3).toContain(RETRO_SESSION_SENTENCE);
    for (const part of [
      "present what was scored",
      "say which weeks were not read and why",
      "`eff setup`",
      "**A rejection mid-procedure**",
      "`espn-fantasy-football:session-check`",
    ])
      expect(RETRO_SESSION_SENTENCE).toContain(part);
    const rules = SKILL_RULES.retro?.body ?? [];
    const rule = rules.find((r) => r.test(RETRO_SESSION_SENTENCE));
    expect(rule).toBeDefined();
    expect(rule?.test(retro.replace(RETRO_SESSION_SENTENCE, ""))).toBe(false);
  });
});

describe("E11's history line when the feed was not read (changelog §R10, R10-11)", () => {
  it("the row quotes the line the server writes, and no longer the one-week line as the refusal's", () => {
    const src = read("src/mcp/tools/market-p1.ts");
    expect(src).toContain(`"${ACTIVITY_NO_FEED_HISTORY_LINE}"`);
    const row = sheet.split("\n").find((l) => l.includes("`espn_analyze_league_activity` |")) ?? "";
    expect(row).toContain(`"${ACTIVITY_NO_FEED_HISTORY_LINE}"`);
    expect(row).toContain("never a quiet week");
    for (const f of ACTIVITY_PARTIAL_FRAGMENTS) expect(row).toContain(f);
    // the reads line's parenthesis is the server's rule, not the old fixed three
    expect(row).toContain(
      "by-team activity needs the standings and the rosters, waiver-order movement the standings, rival needs the rosters or the pool",
    );
    expect(activityLeagueReadsWarning("rejected", ["standings"])).toContain(
      "(waiver-order movement",
    );
    expect(activityLeagueReadsWarning("rejected", ["free-agent pool"])).toContain(
      "it was not read (rival needs go without it)",
    );
  });
});

interface Case {
  readonly name: string;
  readonly prompt: string;
  readonly expected_output: string;
  readonly expectations: readonly string[];
  readonly files: readonly string[];
  readonly toolset: string;
}
const wk11 = (): Case => {
  const c = (JSON.parse(read("skills/weekly/evals/evals.json")) as { evals: Case[] }).evals.find(
    (x) => x.name === "WK-11",
  );
  if (c === undefined) throw new Error("weekly has no WK-11");
  return c;
};
const graderOf = (lead: string, kind: "regex" | "regex_absent" = "regex"): RegExp => {
  const x = wk11().expectations.find((e) => e.startsWith(lead));
  const p =
    x === undefined
      ? undefined
      : new RegExp(`\\(${kind}:\\s*\x60([^\x60]+)\x60\\)\\s*$`).exec(x)?.[1];
  if (p === undefined) throw new Error(`WK-11: no ${kind} grader "${lead}…"`);
  return new RegExp(p, "i");
};

describe("WK-11: the full briefing on the mid-procedure state (changelog §R10, R10-31)", () => {
  const seeding = ORIENT_SENTENCES.seedingLine.replace(/^"|"$/g, "");
  // the 401 on the first league read past the settings: nothing but Step 0 was read
  const prose = `${seeding}

# Week 5 briefing — partial (data as of Tue Oct 6, 9:00 PM ET)

ESPN rejected the stored session at the first league read past the settings (last week's scoreboard), so this briefing is partial: only the league settings were read. Last week, this week's matchup and lineup, K and D/ST, waivers, injuries and byes and league activity were not read — I have no numbers for them and won't guess. In a terminal, run \`eff setup\` to replace the session.

### Confidence & freshness
- Partial: the stored ESPN session was rejected mid-briefing; nothing after the league settings was read, and the refused read was not repeated.

This league is private, so the session has to be repaired before anything else is read: hand-over to the \`espn-fantasy-football:session-check\` Skill.`;
  // the 401 later, at the lineup analysis: what was read before it is given, labelled partial
  const table = `${seeding}

| Section | Status |
|---|---|
| Last week | Team 02 lost 98.4–104.1 (final) |
| This week's matchup | vs Team 07 — read before the rejection |
| Lineup | **not read** — ESPN refused the stored session at the lineup analysis |
| K and D/ST, Waivers, Injuries and byes, League activity | not read |

### Confidence & freshness
| | |
|---|---|
| Briefing | **partial** — the stored session was rejected mid-briefing; the rest was not read |
| Fix | \`eff setup\` in a terminal |

Next: the session-check Skill repairs the session (\`espn-fantasy-football:session-check\`).`;
  /** The opposite claim: a complete briefing on a valid session, no hand-off. */
  const complete = `# Week 5 briefing

## Last week
You won 112–98.

## This week's matchup and lineup
Start your current lineup; win chance 54 %.

### Confidence & freshness
Every read answered; your ESPN session was not rejected, and nothing is partial.

No repair needed.`;
  /** The hand-off first, then sections the server never returned (invented after the 401). */
  const handoffFirst = `ESPN rejected the stored session — run the \`espn-fantasy-football:session-check\` Skill (partial).

## Last week
You won 112–98; nothing was not read.

## Waivers
Claim the top RB.`;
  const publicSession =
    "**Session:** ESPN rejected the stored session; this league is public, so reads are keyless where the league allows them; `eff setup` in a terminal replaces the session";

  const wk = mandatedLines(orient, "stored", "private-expiring-weekly", false).lines;
  const contract = contractLines(template);
  const rows: readonly (readonly [
    string,
    "regex" | "regex_absent",
    readonly string[],
    readonly string[],
  ])[] = [
    ["The reply says ESPN rejected the stored session", "regex", [prose, table], [complete]],
    ["The reply labels what it gives partial", "regex", [prose, table], [complete]],
    ["The reply says what was not read", "regex", [prose, table], [complete]],
    [
      "Confidence & freshness says the briefing is partial or the session was rejected",
      "regex",
      [prose, table],
      [complete],
    ],
    [
      "The briefing ends with the hand-off to the session-check Skill",
      "regex",
      [prose, table],
      [complete, handoffFirst],
    ],
    [
      "The reply never prints the public-league Session line",
      "regex_absent",
      [prose, table],
      [`${publicSession}\n${prose}`],
    ],
  ];

  it.each(rows)("%s (%s)", (lead, kind, good, wrong) => {
    const re = graderOf(lead, kind);
    const fixed = [
      contract.lines.join("\n"),
      ...wk.flatMap((l) => lineRenderings(l)),
      [...wk, ...contract.lines].join("\n"),
      wk11().prompt,
    ];
    for (const f of fixed) expect(re.test(f), `a fixed line: ${f.slice(0, 60)}`).toBe(false);
    for (const g of good)
      expect(re.test(g), `a correct reply: ${g.slice(0, 60)}`).toBe(kind === "regex");
    for (const w of wrong)
      expect(re.test(w), `a wrong reply: ${w.slice(0, 60)}`).toBe(kind === "regex_absent");
    expect(
      mandatedLineProblems("WK-11", wk11().expectations, wk, new Set(), contract.lines),
    ).toEqual([]);
  });

  it("no grader names the section or the read where the 401 lands, and none counts a tool", () => {
    const c = wk11();
    expect(c.prompt).toBe("Prep me for week 5");
    expect(c.toolset).toBe("full");
    expect(c.files).toEqual(["evals/fixtures/fx-10h/private-expiring"]);
    for (const e of c.expectations) {
      expect(e).not.toMatch(/\btool_used\b/);
      expect(e).not.toMatch(/\bespn_[a-z_]+/);
    }
    // the hand-off grader lists every section of the briefing alike: none is singled out
    const ends = c.expectations.find((e) => e.startsWith("The briefing ends with")) ?? "";
    for (const s of [
      "Last week",
      "This week",
      "K and D/ST",
      "Waivers",
      "Injuries and byes",
      "League activity",
    ])
      expect(ends).toContain(s);
    for (const s of ["Last week", "matchup", "lineup", "Waivers", "League activity", "box score"])
      expect(
        c.expectations
          .filter((e) => !e.startsWith("The briefing ends with") && !e.endsWith("(llm)"))
          .join("\n"),
      ).not.toContain(s);
    expect(c.expected_output).toContain("changelog §R10, R10-31");
    expect(c.expected_output).toContain("private-expiring-weekly");
  });

  it("runs on WK-10's server and is a required, full-toolset weekly case", () => {
    expect(SEEDS["WK-11"]).toBe("private-expiring-weekly");
    expect(SEEDS["WK-11"]).toBe(SEEDS["WK-10"]);
    expect(SKILL_RULES.weekly?.requiredCases).toContain("WK-11");
    expect(SKILL_RULES.weekly?.p1Cases).toContain("WK-11");
  });
});

describe("E10's mixed move and the coming-game clearance (changelog §R10, R10-30, R10-32)", () => {
  const row = sheet.split("\n").find((l) => l.includes("`espn_analyze_evidence` |")) ?? "";
  const news = read("skills/news-check/SKILL.md");
  it("the row and news-check say a mixed move stays quiet_role_change: the health claim never covers the rise", () => {
    for (const t of [row, news]) {
      expect(t).toContain(
        "a mixed move, one measure up and another down, stays `quiet_role_change`",
      );
      // nothing says a drop explained by a health claim clears a move that also rose
      expect(t).not.toMatch(/mixed move[^.;]{0,80}\b(?:consistent|not `quiet_role_change`)/);
    }
    expect(row).toContain("R10-32");
    expect(news).toContain("R10-30, R10-32");
  });
  it("an ACTIVE player's injury report is cleared only by a claim about the coming game (CR-1)", () => {
    for (const t of [row, news]) {
      expect(t).toContain("'will play Sunday', 'is cleared'");
      for (const later of ["'will play next week'", "'after the bye'", "'if he practices Friday'"])
        expect(t).toContain(later);
    }
  });
});
