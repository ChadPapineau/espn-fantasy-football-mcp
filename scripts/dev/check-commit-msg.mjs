#!/usr/bin/env node
// check-commit-msg.mjs — the commit-message rules (plan 04 §3 R4 Conventional Commits; CLAUDE.md
// "Workflow": no AI attribution trailer). Called by .githooks/commit-msg, scripts/dev/commit-paths.sh
// and CI (ci.yml `lint`, over every pushed commit); scripts/dev/scan-secrets.mjs --message scans the
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
/**
 * An AI attribution trailer or footer, in any of its common spellings — a trailer behind a comment
 * character, a quote marker or a bullet (`# Co-Authored-By: …`, `> co-authored-by: …`) included: it
 * is published wherever git keeps the line.
 */
const AI_ATTRIBUTION =
  /^[^A-Za-z0-9\n]*co-authored-by:.*(?:claude|anthropic|copilot|chatgpt|openai|gemini)|generated (?:with|by) \[?(?:claude|chatgpt|copilot|gemini)|noreply@anthropic\.com/im;
export const MAX_SUBJECT = 120;

/**
 * @param {string} text the message exactly as it will be published (no line is ignored)
 * @returns {string | null} why it is refused, or null
 */
export function checkMessage(text) {
  const lines = text.split(/\r?\n/);
  const subject = lines.find((l) => l.trim() !== "") ?? "";
  if (!subject) return "the commit message is empty";
  if (AI_ATTRIBUTION.test(text))
    return "the message carries an AI attribution trailer — remove it (CLAUDE.md)";
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
