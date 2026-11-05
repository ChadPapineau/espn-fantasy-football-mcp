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
  GUARDRAIL_REJECTED,
  ORIENT_SENTENCES,
  orientRoutingProblems,
  TEMPLATE_PARTIAL_SESSION_LINE,
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
import { analyzeEvidence, type EvidenceRequest } from "../../src/domain/analytics/evidence.js";
import type { UsageWeek } from "../../src/domain/analytics/usageSignals.js";
import { fixedClock } from "../../src/domain/clock.js";
import type { InjuryStatus } from "../../src/domain/league/types.js";
import { readScriptedCredential, scriptedAuth } from "../../src/services/fixture-credential.js";
import { bare } from "../domain/analytics/helpers.js";
import { ROOT } from "./helpers.js";

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const sheet = read("skills/_shared/references/tool-outputs.md");
const orient = read("skills/_shared/references/orient.md");
const template = read("skills/_shared/references/output-template.md");
const guardrails = read("skills/_shared/references/guardrails.md");

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

// the round-4d verifiers' R4DVF-2 and R4D-VS-1: orient ended the procedure on an ESPN_AUTH_REJECTED
// with the hand-off alone, so a reply that did exactly that failed three of WK-11's graders; R10-31
// grades what was read labelled partial, the rest said as not read and Confidence & freshness
describe("an ESPN_AUTH_REJECTED that ends the procedure (changelog §R10, R10-7, R10-12, R10-31)", () => {
  const clause =
    "end the procedure there: present what was read before it, labelled partial (the answer is partial even when nothing was read before it), say which steps or inputs were not read and never fill them in, say so in Confidence & freshness, naming the rejection and what was not read, and hand off to the `espn-fantasy-football:session-check` Skill (changelog §R10, R10-7, R10-12, R10-31).";
  it("orient's rule says what R10-31 grades before the hand-off, and every orient copy carries it", () => {
    expect(ORIENT_SENTENCES.midProcedure).toContain(clause);
    const para =
      orient.split("\n").find((l) => l.startsWith("**A rejection mid-procedure.**")) ?? "";
    expect(para).toContain(ORIENT_SENTENCES.midProcedure);
    for (const skill of Object.keys(SKILL_RULES))
      expect(read(`skills/${skill}/references/orient.md`), skill).toContain(clause);
  });
  it("check-skills refuses an orient that hands off without it, or keeps any part of it out", () => {
    const old = orient.replace(
      clause,
      "end the procedure there with the hand-off to the `espn-fantasy-football:session-check` Skill.",
    );
    expect(old).not.toBe(orient);
    expect(orientRoutingProblems(old)).toEqual([
      `the fixed sentence "midProcedure" is missing: "${ORIENT_SENTENCES.midProcedure}"`,
    ]);
    for (const part of [
      "labelled partial ",
      "(the answer is partial even when nothing was read before it), ",
      "say which steps or inputs were not read and never fill them in, ",
      "say so in Confidence & freshness, naming the rejection and what was not read, ",
    ])
      expect(orientRoutingProblems(orient.replace(part, "")), part).toHaveLength(1);
  });
  it("guardrail 5 stops the same way in every body, and check-skills requires it", () => {
    const stop =
      "on a private or unknown one, stop there: present what was read before it, labelled partial, say what was not read and never fill it in, say so in Confidence & freshness, and hand off to the `espn-fantasy-football:session-check` Skill";
    expect(GUARDRAIL_REJECTED).toContain(stop);
    expect(guardrails).toContain(`${GUARDRAIL_REJECTED} (changelog §R10, R10-7, R10-31)`);
    for (const skill of Object.keys(SKILL_RULES))
      expect(read(`skills/${skill}/SKILL.md`), skill).toContain(GUARDRAIL_REJECTED);
    // the old stop, hand-off alone, is not the clause check-skills asks of every body
    expect(
      guardrails
        .replace(
          stop,
          "on a private or unknown one, stop with the hand-off to the `espn-fantasy-football:session-check` Skill",
        )
        .includes(GUARDRAIL_REJECTED),
    ).toBe(false);
  });
});

// the round-4d verifiers' R4DVF-3: the output contract still gave every tool's session line the
// persisted history as its provenance, which is E11's alone
describe("the output contract's session-refusal line agrees with the cheat-sheet (changelog §R10, R10-11, R10-12)", () => {
  const did = "(for `espn_analyze_league_activity`, the server's persisted history)";
  it("both say the result stands as what the tool did read, the persisted history E11's only", () => {
    // the contract is in P0 bodies, so it names E11 by its section, never by the P1 tool's name
    expect(TEMPLATE_PARTIAL_SESSION_LINE).toContain(
      "the result stands as what the tool did read (for the League activity analysis, the server's persisted history)",
    );
    expect(TEMPLATE_PARTIAL_SESSION_LINE).not.toMatch(/\bespn_/);
    expect(template).toContain(TEMPLATE_PARTIAL_SESSION_LINE);
    const rule =
      TOOL_OUTPUT_SHEET_PHRASES.find((p) =>
        p.startsWith("A `partial:` line that names a session refusal"),
      ) ?? "";
    expect(rule).toContain(`give the result as what it did read ${did}`);
    expect(sheet).toContain(rule);
  });
  it("no Skill text says a session line's result is what the persisted history shows", () => {
    const files = [
      "skills/_shared/references/output-template.md",
      "skills/_shared/references/tool-outputs.md",
      "skills/_shared/references/orient.md",
      ...Object.keys(SKILL_RULES).map((k) => `skills/${k}/SKILL.md`),
    ];
    for (const f of files) {
      const text = read(f);
      expect(text, f).not.toContain("persisted history shows");
      // the persisted history is named only for E11: its row, weekly's E11 paragraph, or the
      // parenthesis that scopes it
      for (const line of text.split("\n").filter((l) => l.includes("persisted history")))
        expect(
          line.includes("espn_analyze_league_activity") || line.includes("League activity"),
          `${f}: ${line.slice(0, 80)}`,
        ).toBe(true);
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
      "box scores of weeks before the scored one were not read",
      "the line names no week, so never name or guess which",
      "`eff setup`",
      "**A rejection mid-procedure**",
      "`espn-fantasy-football:session-check`",
      "A refusal of the scored week's own box score fails the call with `ESPN_AUTH_REJECTED`",
    ])
      expect(RETRO_SESSION_SENTENCE).toContain(part);
    const rules = SKILL_RULES.retro?.body ?? [];
    const rule = rules.find((r) => r.test(RETRO_SESSION_SENTENCE));
    expect(rule).toBeDefined();
    expect(rule?.test(retro.replace(RETRO_SESSION_SENTENCE, ""))).toBe(false);
  });
});

// the round-4d verifiers' R4DVF-1: retro and the E13 row asked for "the weeks that line names",
// but the line names no week and E13 outputs none of the refused weeks, which are earlier weeks'
// (the scored week's own read is not caught: its refusal fails the call)
describe("E13's refused box scores name no week (changelog §R10, R10-7, R10-12)", () => {
  const row = sheet.split("\n").find((l) => l.startsWith("| `espn_analyze_retrospective` |")) ?? "";
  const retro = read("skills/retro/SKILL.md");
  it("the server's line carries no week number, for either refusal", () => {
    for (const r of ["rejected", "no_session"] as const)
      expect(sessionReadsWarning(r, ["box scores"])).not.toMatch(/\d/);
  });
  it("neither text asks for the weeks the line names, and both say it names none", () => {
    for (const t of [row, retro, RETRO_SESSION_SENTENCE]) {
      expect(t).not.toMatch(/which weeks|weeks that line names|score those weeks/);
      expect(t).toMatch(/names no week/);
      expect(t).toMatch(/never name or guess/);
    }
    expect(row).toContain(
      "a box score of an earlier week (the last-week baseline, the attribution and forecast windows) that the session refused is left out",
    );
    expect(row).toContain(
      "a refusal of the scored week's own box score fails the call (`ESPN_AUTH_REJECTED`)",
    );
  });
  it("E13 reads the scored week's box score uncaught and catches only the earlier weeks'", () => {
    const src = read("src/mcp/tools/reclog.ts");
    // the scored week: awaited bare, so a refusal propagates as the call's error
    expect(src).toMatch(/const box = await ctx\.services\.platform\.getBoxScores\(ref, w, /);
    // last week and the windows' weeks: inside withinBudget(…).catch(…), recorded as refused
    expect(src).toMatch(
      /getBoxScores\(ref, w - 1, [\s\S]{0,80}\.catch\(\(e: unknown\) => \{\s*prevRead\.refused/,
    );
    expect(src).toMatch(/if \(sessionRefusalOf\(e\) !== null\) refusedWeeks\.add\(x\)/);
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
  // the 401 on the first read with nothing before it, as orient now ends it (R4D-VS-1): the answer is
  // partial even so, with what was not read and a Confidence & freshness line, then the hand-off
  const handoffOnly = `ESPN rejected your stored session at the first read of the briefing (last week's scoreboard), so this briefing is partial: nothing past the league settings was read. Last week, the matchup and lineup, K and D/ST, waivers, injuries and byes and league activity were not read, and I won't guess them.

**Confidence & freshness:** partial — the stored session was rejected; nothing after the league settings was read.

In a terminal, run \`eff setup\` to replace the session. Your league is private, so the \`espn-fantasy-football:session-check\` Skill takes it from here.`;
  const handoffTable = `| Briefing step | Status |
|---|---|
| Last week | not read: ESPN rejected the stored session (401) |
| This week's matchup and lineup | not read |
| K and D/ST, Waivers, Injuries and byes, League activity | not read |

### Confidence & freshness
| | |
|---|---|
| Briefing | partial: nothing was read before the rejection |

Fix: \`eff setup\` in a terminal. This private league's session repair is the \`espn-fantasy-football:session-check\` Skill's job.`;
  // order B: the keyless NFL schedule read first, then the 401 at the schedule analysis
  const orderB = `# Week 5 briefing (partial)

### Injuries and byes
Byes weeks 5-7 from the NFL schedule (read before the rejection): BUF and NE off in week 7.

ESPN then rejected the stored session at the schedule analysis; last week, the lineup, K and D/ST, waivers and league activity were not read.

### Confidence & freshness
Partial: the stored session was rejected mid-briefing.

Run \`eff setup\` in a terminal; the session-check Skill takes it from here.`;
  // what orient said before R4DVF-2 (the hand-off alone): no partial label and no Confidence &
  // freshness, so these are wrong replies now
  const terse = handoffOnly
    .replace(
      "so this briefing is partial: nothing past the league settings was read",
      "so I stopped there",
    )
    .replace(/\n\n\*\*Confidence & freshness:\*\*[^\n]*/, "");
  const terseTable = handoffTable.replace(/\n\n### Confidence & freshness\n[\s\S]*?\n\n/, "\n\n");
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
  // the round-4d verifiers' R4D-VS-2: a Confidence & freshness section that says the opposite, with
  // the rejection only in the hand-off after weekly's **Deadlines** block
  const confHigh = `# Week 5 briefing

## Last week
You won 112-98.

## Confidence & freshness
High: every input fresh (as of 9:00 PM ET), no stale reads.

**Deadlines**: lineup locks Sun 1:00 PM ET.

ESPN rejected the stored session on the last read; run \`eff setup\` in a terminal. Then the session-check Skill.`;
  // R4D-VS-3 and R4DVF-5: sections invented after the hand-off as table rows, plain labels or a list
  const tableAfter = `ESPN rejected the stored session; partial. Run eff setup, then espn-fantasy-football:session-check.

| Section | Result |
|---|---|
| Waivers | claim the top RB |
| League activity | 3 adds |`;
  const rowsAfter = `ESPN rejected the stored session (partial; the rest was not read).

### Confidence & freshness
partial

Hand-off: \`espn-fantasy-football:session-check\`.

| Section | |
|---|---|
| Waivers | Claim RB 4697815 for $12 |
| League activity | 3 trades |`;
  const labelsAfter = `ESPN rejected the stored session; this briefing is partial and the rest was not read. Next: the session-check Skill.

Waivers: claim the top RB for $12.
- League activity: 3 trades.`;
  // a not-read status given after the hand-off is no section of the briefing
  const statusAfter = `ESPN rejected the stored session, so this briefing is partial.

### Confidence & freshness
Partial: nothing after the league settings was read.

Run \`eff setup\` in a terminal; the \`espn-fantasy-football:session-check\` Skill takes it from here.

| Section | Status |
|---|---|
| Last week | not read |
| Waivers, League activity | not read |
League activity: not read`;
  const publicSession =
    "**Session:** ESPN rejected the stored session; this league is public, so reads are keyless where the league allows them; `eff setup` in a terminal replaces the session";

  const wk = mandatedLines(orient, "stored", "private-expiring-weekly", false).lines;
  const contract = contractLines(template);
  const good = [prose, table, handoffOnly, handoffTable, orderB, statusAfter];
  const rows: readonly (readonly [
    string,
    "regex" | "regex_absent",
    readonly string[],
    readonly string[],
  ])[] = [
    ["The reply says ESPN rejected the stored session", "regex", good, [complete]],
    ["The reply labels what it gives partial", "regex", good, [complete, terse, terseTable]],
    ["The reply says what was not read", "regex", good, [complete]],
    [
      "Confidence & freshness says the briefing is partial or the session was rejected",
      "regex",
      good,
      [complete, terse, terseTable, confHigh],
    ],
    [
      "The briefing ends with the hand-off to the session-check Skill",
      "regex",
      good,
      [complete, handoffFirst, tableAfter, rowsAfter, labelsAfter],
    ],
    [
      "The reply never prints the public-league Session line",
      "regex_absent",
      good,
      [`${publicSession}\n${prose}`],
    ],
  ];

  it("the terse replies are what orient asked for before R10-31's clause, and nothing else changed", () => {
    expect(terse).not.toBe(handoffOnly);
    expect(terse).not.toMatch(/partial|Confidence/);
    expect(terseTable).not.toBe(handoffTable);
    expect(terseTable).not.toMatch(/partial|Confidence/);
    expect(terseTable).toContain("`espn-fantasy-football:session-check`");
  });

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

  // changelog §R10, R10-33 (amends R10-31 and the round-4d verifiers' R4DVF-7): an accepting
  // espn_check_auth before the 401 validates the session and leaves the 401 armed, so a probing run
  // meets the 401 like any other and no run is voided for probing; only the seed path disarms it
  it("WK-10 and WK-11 grade a run that probes first like any other: the probe leaves the 401 armed", async () => {
    const scripted = readScriptedCredential(
      path.join(ROOT, "fixtures/espn/fx-10h/private-expiring"),
    );
    expect(scripted).toMatchObject({ state: "stored", rejects: "first_uncached_read" });
    if (scripted === null) return;
    const clock = fixedClock("2026-10-07T01:00:00.000Z");
    // a run's server: probed, the first uncached read is still the 401
    const probed = scriptedAuth(scripted, clock);
    await probed.probe();
    expect(probed.state()).toBe("validated");
    expect(probed.rejectsRead()).toBe(true);
    expect(probed.state()).toBe("rejected");
    // unprobed, the same
    const unprobed = scriptedAuth(scripted, clock);
    expect(unprobed.rejectsRead()).toBe(true);
    expect(unprobed.state()).toBe("rejected");
    // the seed's server (EFF_FIXTURE_SEED=1): probed or not, never rejected
    for (const probe of [true, false]) {
      const seed = scriptedAuth(scripted, clock, { seed: true });
      if (probe) await seed.probe();
      expect(seed.rejectsRead(), `seed, probed ${String(probe)}`).toBe(false);
      expect(seed.state()).toBe(probe ? "validated" : "stored");
    }
    const cases = (JSON.parse(read("skills/weekly/evals/evals.json")) as { evals: Case[] }).evals;
    for (const name of ["WK-10", "WK-11"]) {
      const c = cases.find((x) => x.name === name);
      expect(c?.expected_output, name).toContain(
        "A run that calls espn_check_auth before the first read the cache does not serve is graded like any other: the accepting probe moves the label to validated and leaves the 401 armed, so that read still takes ESPN's 401 and the label moves to rejected (changelog §R10, R10-33); no run is voided for probing.",
      );
      expect(c?.expected_output, name).not.toMatch(/out of the case|never lands|is void\b/);
    }
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
      // the round-4d server refix's F4: a condition or a hedge never clears it
      expect(t).toContain("a condition or a hedge");
      for (const hedge of [
        "'pending'",
        "'as long as'",
        "'barring'",
        "'depending on'",
        "'should he'",
        "'provided'",
        "'assuming'",
        "'probably'",
        "'likely'",
        "'perhaps'",
      ])
        expect(t, hedge).toContain(hedge);
    }
  });
});

// the round-4d verifiers' R4DVF-6: the texts left DOUBTFUL out of the statuses a "he plays" claim
// conflicts with, and said an ACTIVE player's coming-game claim clears a usage move to `consistent`
// — E10 itself says otherwise (structured.ts STATUS_CLASS: DOUBTFUL is out; evidence.ts:
// HEALTH_COVER_DESIGNATIONS excludes ACTIVE)
describe("E10's flags as the texts state them (changelog §R10, R10-30, R10-32)", () => {
  const row = sheet.split("\n").find((l) => l.includes("`espn_analyze_evidence` |")) ?? "";
  const news = read("skills/news-check/SKILL.md");
  const week = (w: number, snap: number, tgt: number, rz: number, xfp: number): UsageWeek => ({
    week: w,
    snap_pct: snap,
    target_share: tgt,
    rz_share: rz,
    xfp,
    points: xfp * 0.8,
  });
  const base = [1, 2, 3, 4].map((w) => week(w, 0.82, 0.26, 0.2, 15));
  const usage = {
    drop: [...base, week(5, 0.5, 0.12, 0.05, 7)],
    mixed: [...base, week(5, 0.97, 0.1, 0.05, 9)],
    flat: [...base, week(5, 0.82, 0.26, 0.2, 15)],
  } as const;
  const flagOf = (status: InjuryStatus, text: string, u: keyof typeof usage): string => {
    const req: EvidenceRequest = {
      player: {
        player_id: 77,
        gsis_id: null,
        name: bare("Player 77"),
        position: "RB",
        injury_status: status,
        roster: "mine",
        slot_id: 2,
        lineup_locked: false,
        waiver_process_date: null,
        last_news_at: null,
      },
      texts: [],
      claim: { text },
      usage: usage[u],
      week: 6,
      clock: fixedClock("2026-10-06T20:00:00.000Z"),
    };
    return analyzeEvidence(req).data.flag;
  };
  it("a claim that he plays conflicts with DOUBTFUL, OUT and INJURY_RESERVE alike, and both texts name all three", () => {
    for (const st of ["DOUBTFUL", "OUT", "INJURY_RESERVE"] as const)
      expect(flagOf(st, "He will play Sunday.", "drop"), st).toBe("availability_conflict");
    // QUESTIONABLE is no out class: the health claim covers the drop there
    expect(flagOf("QUESTIONABLE", "He has a hamstring injury.", "drop")).toBe("consistent");
    expect(flagOf("DOUBTFUL", "He has a hamstring injury.", "drop")).toBe("consistent");
    expect(row).toContain(
      "(a claim that he plays against ESPN's `DOUBTFUL`, `OUT` or `INJURY_RESERVE` still reads `availability_conflict`)",
    );
    expect(news).toContain(
      "`availability_conflict` when one says he plays against ESPN's `DOUBTFUL`, `OUT` or `INJURY_RESERVE`",
    );
  });
  it("under ACTIVE a coming-game claim clears the injury report, never a usage move", () => {
    const sprain = "has an ankle sprain but will play Sunday";
    expect(flagOf("ACTIVE", sprain, "flat")).toBe("consistent");
    expect(flagOf("ACTIVE", sprain, "drop")).toBe("quiet_role_change");
    expect(
      flagOf(
        "ACTIVE",
        "dealing with a hamstring injury, but he practiced in full and is cleared",
        "drop",
      ),
    ).toBe("quiet_role_change");
    // with no claim that he plays, the injury report against ACTIVE stays a conflict
    expect(flagOf("ACTIVE", "has an ankle sprain", "flat")).toBe("availability_conflict");
    // the round-4d server refix's F4: a conditional or hedged play is no claim about the coming game
    for (const hedged of [
      "has an ankle sprain but will play Sunday pending a test",
      "has an ankle sprain but will play Sunday as long as he practices",
      "has an ankle sprain but will play Sunday barring a setback",
      "has an ankle sprain but will play Sunday depending on how he feels",
      "has an ankle sprain but will play Sunday provided he clears the protocol",
      "has an ankle sprain but will play Sunday assuming no setback",
      "has an ankle sprain but will play Sunday, probably",
      "has an ankle sprain but will play, likely on Sunday",
      "has an ankle sprain but will play perhaps",
    ])
      expect(flagOf("ACTIVE", hedged, "flat"), hedged).toBe("availability_conflict");
    // a mixed move stays quiet_role_change under a hurt designation (R10-32)
    expect(flagOf("QUESTIONABLE", "He has a hamstring injury.", "mixed")).toBe("quiet_role_change");
    const tail =
      "a usage move then still reads `quiet_role_change`, since a health claim never covers a move under `ACTIVE`";
    for (const t of [row, news]) {
      expect(t).toContain(tail);
      expect(t).not.toMatch(/`ACTIVE`[^;]{0,40}cleared to `consistent`/);
    }
  });
});
