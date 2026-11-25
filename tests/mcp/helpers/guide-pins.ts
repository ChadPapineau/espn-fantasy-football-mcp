// guide-pins.ts — the server guide's sentences that changelog §R17, R17-2 fixes, character for
// character (plan 07 §5.4: the guide is static). They are written out here, never imported from
// src/mcp/server.ts, so every test that reads the served `instructions` fails on any change to them:
// the unit server test (both protocol eras, production and fixture mode) and both stdio end-to-end
// suites (the built server, core and full).

/**
 * R17-2's first sentence pair: a request one of the plugin's Skills covers loads that Skill before
 * any tool call or question; a plain lookup needs none.
 */
export const R17_2_SKILL_FIRST =
  "When one of this plugin's Skills covers the request (a lineup, start/sit, waiver, trade, roster or season question about this league), load it before any tool call and before asking the user anything: it makes the session's first reads and says what to ask. A plain lookup (a status, a score, a setting) needs no Skill.";

/** R17-2's second sentence: the data's time is the envelope's, never the conversation's date. */
export const R17_2_DATA_TIME =
  "Data time comes from `meta.as_of` and `meta.freshness`, never from comparing a date in the data with the conversation's date.";

/**
 * The session-start sentence R17-2 keeps "for a session that loads no Skill": its one change is the
 * clause in front ("When no Skill is loaded, "), which lowers its first letter.
 */
export const NO_SKILL_START =
  "When no Skill is loaded, start with espn_get_status and espn_get_league once per session; espn-ff://docs/tool-outputs lists every tool's fields.";

/** The three, in the order the guide gives them. */
export const GUIDE_PINS: readonly string[] = Object.freeze([
  R17_2_SKILL_FIRST,
  NO_SKILL_START,
  R17_2_DATA_TIME,
]);

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

/**
 * What a served `instructions` text breaks of R17-2 (empty = none): each pinned sentence exactly
 * once, the Skill rule before the session-start reads, and those reads only in their scoped form.
 */
export function guidePinProblems(instructions: string): string[] {
  const problems: string[] = [];
  GUIDE_PINS.forEach((s, i) => {
    const n = count(instructions, s);
    if (n !== 1)
      problems.push(
        `guide sentence ${String(i + 1)} appears ${String(n)} times (exactly 1 required): ${s.slice(0, 60)}…`,
      );
  });
  const reads = count(instructions, "with espn_get_status and espn_get_league once per session");
  if (reads !== 1)
    problems.push(
      `the session-start reads appear ${String(reads)} times; only the scoped sentence may carry them`,
    );
  const rule = instructions.indexOf(R17_2_SKILL_FIRST);
  const start = instructions.indexOf(NO_SKILL_START);
  if (rule >= 0 && start >= 0 && start < rule)
    problems.push("the session-start reads come before the Skill rule");
  return problems;
}
