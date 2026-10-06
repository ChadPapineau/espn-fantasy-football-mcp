#!/usr/bin/env node
// check-commit-msg.mjs — the commit-message rules (plan 04 §3 R4 Conventional Commits; CLAUDE.md
// "Workflow": no AI attribution trailer). Called by .githooks/commit-msg and scripts/dev/commit-paths.sh;
// scripts/dev/scan-secrets.mjs --message scans the same message for secrets and identifiers.
// Node built-ins only.
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
/** An AI attribution trailer or footer, in any of its common spellings. */
const AI_ATTRIBUTION =
  /^\s*co-authored-by:.*(?:claude|anthropic|copilot|chatgpt|openai|gemini)|generated (?:with|by) \[?(?:claude|chatgpt|copilot|gemini)|noreply@anthropic\.com/im;
export const MAX_SUBJECT = 120;

/**
 * @param {string} text the raw message (git comment lines are ignored)
 * @returns {string | null} why it is refused, or null
 */
export function checkMessage(text) {
  const body = text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("#"))
    .join("\n");
  const subject = body.split("\n").find((l) => l.trim() !== "") ?? "";
  if (!subject) return "the commit message is empty";
  if (AI_ATTRIBUTION.test(body))
    return "the message carries an AI attribution trailer — remove it (CLAUDE.md)";
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
