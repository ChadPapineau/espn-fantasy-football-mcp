// guide-pins.ts — the server guide's sentences that changelog §R17, R17-2 and §R18, R18-1 and R18-11
// fix, character for character (plan 07 §5.4: the guide is static). They are written out here, never
// imported from src/mcp/server.ts, so every test that reads the served `instructions` fails on any
// change to them: the unit server test (both protocol eras, both toolsets, production and fixture
// mode) and both stdio end-to-end suites (the built server, core and full, and the 2026-07-28 era).
// The SDK smoke (`npm run smoke`: the built server in both eras under both toolsets) carries its own
// copy in tests/smoke/smoke-lib.mjs, which tests/smoke/smoke-lib.test.ts holds equal to these.

/**
 * R17-2's first sentence pair: a request one of the plugin's Skills covers loads that Skill before
 * any tool call or question; a plain lookup needs none. R18-1 and R18-11 leave it byte-identical.
 */
export const R17_2_SKILL_FIRST =
  "When one of this plugin's Skills covers the request (a lineup, start/sit, waiver, trade, roster or season question about this league), load it before any tool call and before asking the user anything: it makes the session's first reads and says what to ask. A plain lookup (a status, a score, a setting) needs no Skill.";

/**
 * R18-1's sentence, verbatim, right after R17-2's pair with one space before it: a question that
 * only asks whether a player is healthy is a plain lookup, even when the read shows him hurt (R17-3's
 * reading, in the text the model reads). R18-11 leaves it byte-identical.
 */
export const R18_1_HEALTH_LOOKUP =
  "A question that only asks whether a player is healthy is such a lookup, even when he turns out to be hurt.";

/**
 * R18-11's sentence, verbatim, right after R18-1's with one space before it, the Skill rule's last:
 * a question about a league on another platform is not about this league, so no Skill covers it —
 * R17-2's own condition (a Skill covers a "question about this league") negated in R17-2's words.
 */
export const R18_11_OTHER_PLATFORM =
  "A question about a league on another platform (Sleeper, Yahoo and the like) is not about this league: no Skill covers it.";

/** R17-2's second sentence: the data's time is the envelope's, never the conversation's date. */
export const R17_2_DATA_TIME =
  "Data time comes from `meta.as_of` and `meta.freshness`, never from comparing a date in the data with the conversation's date.";

/**
 * The session-start sentence R17-2 keeps "for a session that loads no Skill": its one change is the
 * clause in front ("When no Skill is loaded, "), which lowers its first letter.
 */
export const NO_SKILL_START =
  "When no Skill is loaded, start with espn_get_status and espn_get_league once per session; espn-ff://docs/tool-outputs lists every tool's fields.";

/** The five, in the order the guide gives them. */
export const GUIDE_PINS: readonly string[] = Object.freeze([
  R17_2_SKILL_FIRST,
  R18_1_HEALTH_LOOKUP,
  R18_11_OTHER_PLATFORM,
  NO_SKILL_START,
  R17_2_DATA_TIME,
]);

/**
 * The length of the production `instructions` R18-11 sets (changelog §R18: 1,355 → 1,477; R18-1's
 * sentence had grown them from 1,248 to 1,355).
 */
export const R18_11_INSTRUCTIONS_CHARS = 1_477;

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** The fixture-mode spike line a served `instructions` text ends with (plan 10 A11b), if any. */
const SPIKE_TAIL = /\n\nFixture-mode spike nonce \(repeat it if asked\): [0-9a-f]{1,64}$/;

/**
 * A served `instructions` text without its fixture-mode spike line: the production text, whose
 * length R18-11 sets (R18_11_INSTRUCTIONS_CHARS). A text without the line is returned as it is.
 */
export function withoutSpikeLine(instructions: string): string {
  return instructions.replace(SPIKE_TAIL, "");
}

/**
 * What a served `instructions` text breaks of R17-2, R18-1 and R18-11 (empty = none): each pinned
 * sentence exactly once, R18-1's directly after R17-2's pair and R18-11's directly after R18-1's
 * (one space between, each), the Skill rule before the session-start reads, and those reads only in
 * their scoped form.
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
  const pair = count(instructions, `${R17_2_SKILL_FIRST} ${R18_1_HEALTH_LOOKUP}`);
  if (pair !== 1)
    problems.push(
      `R18-1's sentence follows R17-2's pair directly, one space between, ${String(pair)} times (exactly 1 required)`,
    );
  const next = count(instructions, `${R18_1_HEALTH_LOOKUP} ${R18_11_OTHER_PLATFORM}`);
  if (next !== 1)
    problems.push(
      `R18-11's sentence follows R18-1's directly, one space between, ${String(next)} times (exactly 1 required)`,
    );
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
