// The server warnings the cheat-sheet (skills/_shared/references/tool-outputs.md) and the Skills
// quote are the server's own: each quoted form matches a line the server writes, from the server's
// own code, never a copy of its template (changelog §R10, R10-11 and the round-3b server refix's
// second E11 line; R10-20's E13 warning; R10-22's lineup trim warnings).
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_PARTIAL_FRAGMENTS,
  RETRO_TRUNCATED_SENTENCE,
  TOOL_OUTPUT_PHRASES,
  TOOL_OUTPUT_SHEET_PHRASES,
  TRIM_WARNING_ABSENT,
} from "../../scripts/skills/check-skills.mjs";
import { fitOptionsOf } from "../../src/mcp/define.js";
import { ANALYTICS_BUDGET_CHARS, fitToBudget } from "../../src/mcp/envelope.js";
import { lineupTrims } from "../../src/mcp/tools/analytics.js";
import {
  SESSION_READ_WARNINGS,
  activityLeagueReadsWarning,
  type ActivityLeagueRead,
} from "../../src/mcp/tools/common.js";
import { analyzeRetrospective } from "../../src/mcp/tools/reclog.js";
import { ROOT } from "./helpers.js";

const sheet = readFileSync(path.join(ROOT, "skills/_shared/references/tool-outputs.md"), "utf8");
const rowOf = (tool: string): string =>
  sheet.split("\n").find((l) => new RegExp(`^\\| (?:\\(P1\\) )?\`${tool}\` \\|`).test(l)) ?? "";

/**
 * A quoted form as an anchored RegExp over a whole warning: "…" elides the words that vary, with the
 * spaces around them (as an ellipsis in prose does).
 */
const formRe = (quoted: string): RegExp => {
  const body = quoted.replace(/^"|"$/g, "");
  const parts = body.split(/\s*…\s*/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[\\s\\S]*?")}$`);
};

const READS: readonly ActivityLeagueRead[] = ["standings", "rosters", "free-agent pool"];
/** Every non-empty ordered subset of the league reads E11 can name. */
const readSets = fc
  .subarray([...READS], { minLength: 1 })
  .map((xs) => READS.filter((r) => xs.includes(r)));

describe("E11's partial lines in the cheat-sheet are the server's (changelog §R10, R10-11)", () => {
  const [feed, leagueRejected, leagueNoSession] = ACTIVITY_PARTIAL_FRAGMENTS.map(formRe);

  it("the feed's quoted form matches both of the server's feed lines, and no league-read line", () => {
    expect(feed?.test(SESSION_READ_WARNINGS.feed_no_session)).toBe(true);
    expect(feed?.test(SESSION_READ_WARNINGS.feed_rejected)).toBe(true);
    fc.assert(
      fc.property(
        readSets,
        fc.constantFrom<"rejected" | "no_session">("rejected", "no_session"),
        (reads, refusal) => {
          expect(feed?.test(activityLeagueReadsWarning(refusal, reads))).toBe(false);
        },
      ),
    );
  });

  it("each league-read form matches the server's line for its refusal, whatever reads it names, and only that one", () => {
    fc.assert(
      fc.property(readSets, (reads) => {
        const rejected = activityLeagueReadsWarning("rejected", reads);
        const noSession = activityLeagueReadsWarning("no_session", reads);
        expect(leagueRejected?.test(rejected)).toBe(true);
        expect(leagueNoSession?.test(noSession)).toBe(true);
        expect(leagueRejected?.test(noSession)).toBe(false);
        expect(leagueNoSession?.test(rejected)).toBe(false);
        // the line names the reads it went without, and ends in the one command
        for (const r of reads) expect(rejected).toContain(r);
        expect(rejected).toMatch(/run `eff setup` in a terminal to replace it$/);
        expect(noSession).toMatch(/run `eff setup` in a terminal to add one$/);
      }),
    );
    for (const f of [leagueRejected, leagueNoSession]) {
      expect(f?.test(SESSION_READ_WARNINGS.feed_rejected)).toBe(false);
      expect(f?.test(SESSION_READ_WARNINGS.feed_no_session)).toBe(false);
    }
  });

  it("the row carries every form, and a form the server never writes would fail", () => {
    for (const f of ACTIVITY_PARTIAL_FRAGMENTS)
      expect(rowOf("espn_analyze_league_activity")).toContain(f);
    // a stale form (the reads "were skipped") matches no line the server writes
    const stale = formRe(
      '"partial: … need one on a league not known to be public: they were skipped …"',
    );
    fc.assert(
      fc.property(readSets, (reads) => {
        expect(stale.test(activityLeagueReadsWarning("rejected", reads))).toBe(false);
      }),
    );
  });
});

describe("E13's truncation warning, as the cheat-sheet and retro quote it (changelog §R10, R10-20)", () => {
  /** The quoted warning of a text, with N and M as counts. */
  const quotedIn = (text: string): RegExp => {
    const m = /"(result truncated to N of M calls[^"]*)"/.exec(text);
    expect(m, "the quoted warning").not.toBeNull();
    const re = (m?.[1] ?? "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace("N of M", "(\\d+) of (\\d+)");
    return new RegExp(`^${re}$`);
  };
  /** E13's own fit, under its registered options, of `n` calls of about `size` characters each. */
  const fitted = (n: number, size: number) => {
    const call = (i: number) => ({
      log_id: `r-${String(i).padStart(4, "0")}`,
      kind: "lineup",
      followed: null,
      regret: null,
      decisive: null,
      recommended: "x".repeat(size),
      best_alternative: null,
      realised: null,
      note: null,
    });
    const env = {
      data: { week: 4, calls: Array.from({ length: n }, (_, i) => call(i)) },
      meta: { untrusted_fields: [] },
      truncated: false,
      partial: false,
      warnings: [] as string[],
    };
    const r = fitToBudget(
      env as unknown as Parameters<typeof fitToBudget>[0],
      ANALYTICS_BUDGET_CHARS,
      "calls",
      fitOptionsOf(analyzeRetrospective, {}),
    );
    if (!r.ok) throw new Error("did not fit");
    return r.envelope;
  };

  it.each([
    ["the cheat-sheet's E13 row", rowOf("espn_analyze_retrospective")],
    ["retro's sentence", RETRO_TRUNCATED_SENTENCE],
  ])("%s quotes the warning E13's own fit writes, with its counts", (_, text) => {
    const re = quotedIn(text);
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 200 }),
        fc.integer({ min: 150, max: 400 }),
        (n, size) => {
          const env = fitted(n, size);
          expect(env.truncated).toBe(true);
          const w = env.warnings.find((x) => x.startsWith("result truncated to"));
          const m = re.exec(w ?? "");
          expect(m, w).not.toBeNull();
          const kept = (env.data as { calls: unknown[] }).calls.length;
          expect(Number(m?.[1])).toBe(kept);
          expect(Number(m?.[2])).toBe(n);
          expect(kept).toBeLessThan(n);
        },
      ),
      { numRuns: 25 },
    );
    // the warning names E13's narrowing input, and the text tells the reader to use it
    expect(text).toContain("narrow the calls with kinds (this tool does not page)");
    expect(text).toMatch(/`kinds/);
  });
});

describe("the lineup trim warnings the cheat-sheet quotes are lineupTrims' own (changelog §R10, R10-22)", () => {
  // a lineup where player 1 sits, player 2 starts in his RB slot and player 3 stays at WR: every
  // trim that cuts the unmoved rows fires
  const untrimmed = {
    current_lineup: [
      { player_id: 1, slot: "RB" },
      { player_id: 2, slot: "BE" },
      { player_id: 3, slot: "WR" },
    ],
    recommended_lineup: [
      { player_id: 1, slot: "BE" },
      { player_id: 2, slot: "RB" },
      { player_id: 3, slot: "WR" },
    ],
    rec: {
      subjects: [
        { player_id: 1, role: "sit", slot: "BE" },
        { player_id: 2, role: "start", slot: "RB" },
        { player_id: 3, role: "start", slot: "WR" },
      ],
      drivers: [],
      confidence: { role_games: 0, inputs: [] },
    },
    lock_schedule: [],
    espn_cross_check: { starter_disagreements: [] },
    stack_flags: [],
    conditionals: [],
  };
  const warnings = lineupTrims(untrimmed)
    .map((trim) => trim(untrimmed))
    .filter((r) => r !== null)
    .map((r) => r.warning);

  it("the Rec shape's and the lineup row's quoted warnings are warnings the trims write", () => {
    const quoted = [
      ...(TOOL_OUTPUT_SHEET_PHRASES.join(" ").match(
        /"([a-z_.]+ lists only the players who move \([^"]*\))"/g,
      ) ?? []),
      ...(TOOL_OUTPUT_PHRASES.espn_analyze_lineup
        .join(" ")
        .match(/"([a-z_.]+ lists only the players who move \([^"]*\))"/g) ?? []),
    ].map((q) => q.replace(/^"|"$/g, ""));
    expect(quoted).toEqual([
      "rec.subjects lists only the players who move (the roster's current slots hold the rest)",
      "recommended_lineup lists only the players who move (rec.lineup carries the whole mean-optimal assignment)",
    ]);
    for (const q of quoted) expect(warnings).toContain(q);
    for (const q of quoted) expect(sheet).toContain(q);
  });

  it("no trim warning says rec.lineup carries the lineup to set", () => {
    expect(warnings.length).toBeGreaterThan(2);
    for (const w of warnings) expect(TRIM_WARNING_ABSENT.test(w), w).toBe(false);
  });
});
