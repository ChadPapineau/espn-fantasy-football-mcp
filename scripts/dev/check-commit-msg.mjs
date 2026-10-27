#!/usr/bin/env node
// check-commit-msg.mjs — the commit-message rules (plan 04 §3 R4 Conventional Commits; CLAUDE.md
// "Workflow": no AI attribution trailer; plan 04 R5 and §4.1: CI on every push and PR, so a GitHub
// skip-CI instruction is refused). Called by .githooks/commit-msg, scripts/dev/commit-paths.sh and
// CI (ci.yml `lint`, over every pushed commit); scripts/dev/scan-secrets.mjs --message scans the
// same message for secrets and identifiers. Node built-ins only.
//
// The message is checked AS IT WILL BE PUBLISHED: every line counts, a `#` line included. git keeps
// `#` lines verbatim with `commit -m`/`-F` and `commit-tree -F` and drops them only when it cleans an
// edited message, so dropping them here let a `#…` first line or a `# Co-Authored-By: …` trailer
// pass the check and then be published (Stage C finding). commit-paths.sh therefore cleans the
// message the way `git commit` cleans an edited one (`git stripspace --strip-comments`) BEFORE it is
// checked, scanned and committed, so what is checked is exactly what is published; a `git commit`
// whose message still holds comment lines when the hook runs is checked with them — a `#` line
// before the subject is refused, and an attribution trailer is refused whatever prefixes it.
//
// Usage: node scripts/dev/check-commit-msg.mjs <message-file>
// Exit: 0 ok · 1 refused (reason on stderr) · 2 usage/IO error
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TYPES = [
  "feat",
  "fix",
  "docs",
  "test",
  "chore",
  "refactor",
  "perf",
  "ci",
  "build",
  "style",
  "revert",
];
const CONVENTIONAL = new RegExp(`^(?:${TYPES.join("|")})(?:\\([A-Za-z0-9._/-]+\\))?!?: \\S`);
/** Subjects git or a reviewer produces that are not authored conventional subjects. */
const EXEMPT = /^(?:Merge |Revert "|fixup! |squash! |amend! )/;

// --- AI attribution (CLAUDE.md "Workflow": no AI attribution trailer) -----------------------------
//
// Refused in any of its common spellings (Stage C finding ci-ai-trailer-variants-accepted: only
// `Co-authored-by: <Claude|Copilot|…>`, "Generated with [Claude…" and Anthropic's no-reply address
// were refused, so the Linux kernel's `Assisted-by: Claude:<model>`, `Co-developed-by: Claude`,
// `Generated-by: Claude Code`, `AI-assisted-by: …` and Cursor's `Co-authored-by: Cursor Agent
// <…@cursor.com>` were published). The rule is structural, not a list of trailers:
//   * a trailer (`<token>: <value>`, git's token syntax: letters, digits, `-`) whose key names AI —
//     a key part `ai`, `llm`, `gpt`, `genai`, or an assistant's name (`AI-assisted-by`,
//     `AI-Generated`, `LLM-Assisted`, `Claude-Session`) — whatever its value;
//   * a crediting trailer — any `<verb>-by` / `-with` / `-using` / `-via` / `-from` key
//     (Co-authored-by, Co-developed-by, Assisted-by, Generated-using, Signed-off-by, Made-with, …),
//     or an author, credit, assistant, model, agent or generator key — whose value names an AI
//     assistant, its vendor, AI itself (`AI`, `LLM`) or an agent's address at its vendor's domain
//     (an address `@ampcode.com` or `@warp.dev`: agents whose names are words sign so);
//   * the same credit written as prose — "generated, assisted, drafted or coded …", "(co-)authored,
//     (co-)developed, (co-)written or (co-)created …", each "with/by/using/via" (and "with the help
//     of"), or "with help from …", naming an assistant (a vendor word such as "GitHub" may stand
//     between) — and Anthropic's no-reply address anywhere.
// The check reads the message as a reader sees it: NFKC (full-width and mathematical letters),
// invisible characters removed, Unicode dashes and colons as ASCII, the Cyrillic and Greek letters
// that look Latin as those letters, and the leading comment character, quote marker or bullet a
// line may carry (git publishes `# Co-Authored-By: …` with -m, -F and commit-tree). A prose line
// with a colon is no trailer (its "key" holds spaces), and only crediting keys read the value, so
// "Tests: …" or "Note: the server runs under Claude Desktop" is no attribution.

/** An AI coding assistant or its vendor, as attribution names it (normalised: lower case, `-`). */
const AI_NAME =
  /(?<![a-z0-9])(?:claude|anthropic|copilot|chat-?gpt|gpt-?\d|openai|codex|gemini|bard|cursor(?:-?agent)?|windsurf|codeium|tabnine|code-?whisperer|amazon-q(?![a-z])|devin-ai|cognition-ai|aider|sourcegraph|cody-ai|coderabbit(?:ai)?|grok|deepseek|mistral|llama|qwen|perplexity|cline|roo-?code|kilo-?code|kiro|opencode|openhands|amp-?code|factory-?droid|augment-?code|replit(?:-?agent)?|qodo|phind|google-labs-jules|jules\[bot\])(?![a-z])/;
/** A value that is AI itself: `AI`, `LLM`, `an AI model`, `GenAI`. */
const AI_WORD = /(?<![a-z0-9])(?:ai|llms?|genai)(?![a-z0-9])/;
/**
 * An AI agent's address at its vendor's domain — the sign of an agent whose name is a word (Amp,
 * Warp, OpenHands at `@all-hands.dev`); a `.ai` domain is AI_WORD already.
 */
const AI_DOMAIN =
  /@(?:[a-z0-9-]+\.)*(?:anthropic\.com|claude\.(?:ai|com)|openai\.com|cursor\.(?:com|sh)|ampcode\.com|all-hands\.dev|warp\.dev|augmentcode\.com|sweep\.dev|codeium\.com|windsurf\.com|tabnine\.com|replit\.com|lovable\.dev|cline\.bot|roocode\.com|continue\.dev|bolt\.new|v0\.dev|aider\.chat)(?![a-z0-9.-])/;
/** A key part that makes the trailer about AI: `AI-assisted-by`, `LLM-Assisted`, `GenAI-Tool`. */
const AI_KEY_PART = /^(?:ai|llms?|gpt|genai)$/;
/**
 * A crediting key: any `<verb>-by` / `-with` / `-using` / `-via` / `-from`, or an author, credit,
 * thanks, assistant, model, agent or generator key (`Generated-using:`, `Model:`, `Agent:`). Not
 * `Tool:` — here `claude` is also the CLI a body cites (`Tools: claude plugin validate`).
 */
const CREDIT_KEY =
  /^(?:[a-z0-9-]*-)?(?:by|with|using|via|from)$|^(?:co-?)?authors?$|^credits?$|^thanks(?:-to)?$|^assistants?$|^(?:models?|agents?|generators?|generated)$/;
/** An assistant's name as a credit spells it: after "the", a `[` link, a vendor word ("GitHub"). */
const CREDITED = String.raw`(?:the-)?\[?(?:github-|google-|microsoft-|amazon-|jetbrains-)?(?:${AI_NAME.source})`;
/**
 * Prose credit before an assistant's name: "Generated with [GitHub Copilot", "co-authored by …",
 * "Written by Claude", "created using ChatGPT", "drafted with the help of …", "with help from …".
 */
const PROSE_CREDIT = new RegExp(
  String.raw`(?<![a-z0-9])(?:(?:(?:co-?)?(?:authored|developed|written|created)|generated|assisted|drafted|coded)-(?:with|by|using|via)[-:]+(?:the-)?(?:help-of-|assistance-of-)?|with-(?:the-)?help-(?:of|from)[-:]+)` +
    CREDITED,
);

/** Letters from other scripts that are drawn like Latin ones (Cyrillic, Greek), as those letters. */
const LOOKALIKE = new Map(
  Object.entries({
    а: "a",
    в: "b",
    с: "c",
    ԁ: "d",
    е: "e",
    һ: "h",
    і: "i",
    ј: "j",
    к: "k",
    ӏ: "l",
    м: "m",
    н: "h",
    о: "o",
    р: "p",
    ԛ: "q",
    ѕ: "s",
    т: "t",
    у: "y",
    х: "x",
    ԝ: "w",
    ɡ: "g",
    α: "a",
    β: "b",
    ε: "e",
    η: "n",
    ι: "i",
    κ: "k",
    ν: "v",
    ο: "o",
    ρ: "p",
    τ: "t",
    υ: "u",
    χ: "x",
    ω: "w",
    ϲ: "c",
  }),
);

/**
 * The message as a reader sees it, for the attribution checks only: NFKC, invisible characters
 * removed, Unicode dashes and colons as ASCII, look-alike letters as Latin, lower case.
 * @param {string} text
 */
export function attributionView(text) {
  return [
    ...text
      .normalize("NFKC")
      .replace(/[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g, "")
      .replace(/[‐-―−⸺⸻﹘﹣－]/g, "-")
      .replace(/[ː∶꞉︓﹕：]/g, ":")
      .toLowerCase(),
  ]
    .map((ch) => LOOKALIKE.get(ch) ?? ch)
    .join("");
}

/** Spaces and underscores read as `-` ("Co authored by", "Amazon Q Developer"). */
const dashed = (/** @type {string} */ s) => s.trim().replace(/[\s_]+/g, "-");

/**
 * Whether a trailer key names AI. A trailer token is a word to three (`AI-Generated`,
 * `AI-assisted-by`, `Claude-Session`): any word of such a key counts. In a longer key only its
 * first or last words do (`Amazon-Q-Developer-Session-Id`, `Assisted-with-the-help-of-AI`), so an
 * identifier with `-ai-` or an assistant's name inside — a finding id opening a bullet,
 * `ci-ai-trailer-variants-accepted: …` — is no trailer. A leading `X-` is not a word of the key.
 * @param {string} key  lower case, `-`-separated
 */
function keyNamesAi(key) {
  const k = key.replace(/^x-/, "");
  const parts = k.split("-").filter(Boolean);
  const short = parts.length <= 3;
  // an assistant's name, of one word or more (`claude`, `amazon-q`, `cursor-agent`)
  for (const m of k.matchAll(new RegExp(AI_NAME.source, "g")))
    if (short || m.index === 0 || m.index + m[0].length === k.length) return true;
  // AI itself as a word of the key
  return short
    ? parts.some((p) => AI_KEY_PART.test(p))
    : AI_KEY_PART.test(parts[0] ?? "") || AI_KEY_PART.test(parts.at(-1) ?? "");
}

/**
 * Which form of AI attribution the message carries (a fixed phrase — never text of the message,
 * which CI's log would publish), or null.
 * @param {string} text the message as published
 * @returns {string | null}
 */
export function aiAttribution(text) {
  const view = attributionView(text);
  if (view.includes("noreply@anthropic.com")) return "Anthropic's no-reply address";
  for (const raw of view.split(/\r?\n/)) {
    // a comment character, a quote marker, a bullet or an emoji before the trailer
    const line = raw.replace(/^[^a-z0-9]+/, "");
    const trailer = /^([a-z0-9][a-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (trailer) {
      const key = (trailer[1] ?? "").replaceAll("_", "-");
      const value = dashed(trailer[2] ?? "");
      if (keyNamesAi(key)) return "a trailer whose key names AI";
      if (
        CREDIT_KEY.test(key) &&
        (AI_NAME.test(value) || AI_WORD.test(value) || AI_DOMAIN.test(value))
      )
        return "a crediting trailer (…-by, …-with, author, credit, model, agent) that names an AI assistant";
    }
    if (PROSE_CREDIT.test(dashed(line))) return "a footer that credits an AI assistant";
  }
  return null;
}
/**
 * GitHub's instructions to skip CI (docs "Skipping workflow runs"): a push whose commit message
 * carries `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]` or `[actions skip]`, or ends with a
 * `skip-checks: true` trailer, starts NO push/pull_request workflow — and every CI gate (the commit
 * identity, lint, this check, the secret and identifier scans, the tests) exists only as such a run,
 * so nothing re-checks what that push published until a later unmarked one (Stage C finding
 * ci-skip-markers-accepted). Refused anywhere in the message, in any case and with any spacing:
 * over-refusing costs a reworded message, under-refusing a push no gate sees.
 */
export const SKIP_CI_MARKER =
  /\[\s*(?:skip[\s_-]*(?:ci|actions)|(?:ci|actions)[\s_-]*skip|no[\s_-]*ci)\s*\]|skip-checks\s*:\s*true/i;
export const MAX_SUBJECT = 120;

/**
 * @param {string} text the message exactly as it will be published (no line is ignored)
 * @returns {string | null} why it is refused, or null
 */
export function checkMessage(text) {
  const lines = text.split(/\r?\n/);
  const subject = lines.find((l) => l.trim() !== "") ?? "";
  if (!subject) return "the commit message is empty";
  const ai = aiAttribution(text);
  if (ai !== null)
    return `the message carries an AI attribution trailer (${ai}) — remove it (CLAUDE.md)`;
  if (SKIP_CI_MARKER.test(text))
    return "the message carries a GitHub skip-CI instruction ([skip ci], [ci skip], [no ci], [skip actions], [actions skip] or skip-checks: true): the push would start no workflow, so no CI gate would check it — remove it";
  if (/^\s*#/.test(subject))
    return 'the first line starts with "#": git publishes it as the subject with -m, -F and commit-tree (only an edited message loses it) — remove the comment line(s) before the subject';
  if (EXEMPT.test(subject)) return null;
  if (!CONVENTIONAL.test(subject)) {
    return `the subject is not a Conventional Commit: "<type>(<scope>)?: <subject>" with type one of ${TYPES.join(", ")}`;
  }
  if ([...subject].length > MAX_SUBJECT)
    return `the subject is longer than ${String(MAX_SUBJECT)} characters`;
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("usage: check-commit-msg.mjs <message-file>\n");
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    process.stderr.write(
      `check-commit-msg: cannot read the message: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(2);
  }
  const why = checkMessage(text);
  if (why) {
    process.stderr.write(`check-commit-msg: refused — ${why}\n`);
    process.exit(1);
  }
}
