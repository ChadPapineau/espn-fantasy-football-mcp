#!/usr/bin/env node
// scan-secrets.mjs — zero-dependency secret + personal-identifier scanner: plan 04 §4.1 (R11
// `identifiers`), §4.3 (ESPN rules); CLAUDE.md "Security". Ported from sibling @d72e03b, adapted
// (Yahoo rules dropped; ESPN cookie/SWID/GUID/league-id/IPv4/home-path rules and the deny-list added).
//
// It runs locally BEFORE anything is committed (.githooks/pre-commit, .githooks/commit-msg and
// scripts/dev/commit-paths.sh call it) and in CI (docs.yml `identifiers`, secret-scan.yml). gitleaks
// (.gitleaks.toml) is the second, independent layer; GitHub push protection the third. Findings
// print the rule id and file:line only — NEVER the matched value.
//
// Usage:
//   node scripts/dev/scan-secrets.mjs [--staged] [--all] [--index] [--identity] [--message <file>]
//                                     [--ref <name>]... [--] <file>...
//     --staged          scan the STAGED (index) blob of each given file; a path that is not in the
//                       index, or that cannot be read, is an error (exit 2) — never "clean"
//     --all             scan every tracked file (git ls-files), as it is in the working tree, and the
//                       name of every ref (git for-each-ref: branches, tags, remote-tracking refs —
//                       in CI's full-depth checkout every branch and tag the remote publishes)
//     --index           scan every blob the next commit adds or changes (index vs HEAD, any status
//                       but D — type changes included — read by object id, so no name is re-quoted),
//                       and the name of the branch it lands on (HEAD's symbolic ref; none when detached)
//     --identity        refuse an author or committer address that is not a GitHub no-reply address
//                       (<id>+<login>@users.noreply.github.com); the address itself is never printed
//     --message <file>  scan a commit message (it is published with the commit)
//     --ref <name>      scan a ref name that is about to be published (`refs/heads/x`, `refs/tags/v1`,
//                       or a bare branch name); repeatable; the name itself is never printed
//     <file>...         scan each named working-tree file; a name that does not exist is an error
//                       (exit 2; the name is not printed) — never "clean": a caller's list that
//                       names what is not on disk (npm's pack listing masks some names) skips nothing
// Exit: 0 clean · 1 findings — content it cannot read included: an archive, a document container,
// a compressed stream or a database (by its BYTES, whatever its name), an image, audio, video, font,
// wasm or native binary no human has reviewed, or bytes that are neither text nor a recognised
// binary format are refused (S5, S7) · 2 usage/IO error (a file too large to read is an error, never
// skipped). It reads UTF-8, and UTF-16/UTF-32 with a byte-order mark; gzip is decompressed member by
// member, its header's file name, comment and extra field are scanned as text, and bytes after the
// last member are refused; a binary passes only as the exact bytes a person reviewed at that path
// (REVIEWED_BINARIES — empty), and every rule and the deny-list still read its bytes — as
// latin1, as UTF-8 and, when they hold NULs, without them and as UTF-16 (rawDenyViews). Details:
// "what a blob IS" below. Every line is read as written and, when it carries %XX / \uXXXX /
// backslash / HTML-entity encodings, with them undone (lineFindingIds); a match that spans line
// breaks is found as gitleaks finds it, over the whole text (textRuleHits); a JSON body — a whole
// file, a JSON Lines record or a fenced block — is parsed for a league's root id and league-id
// fields whatever its key order (leagueBodyFindings); and a file a text carries as a base64 data:
// URI is read as a committed file is — text scanned, a binary refused (embeddedFindings). Every
// scanned PATH and every scanned REF NAME is published too: the same rules and the deny-list run
// over it (pathFindings, refFindings), and a finding there names the entry's number, not the path
// or the name.
//
// Suppression: a line containing `scan-secrets: allow` skips the GENERIC rules on that line only.
// It never suppresses the ESPN credential rules, a private key, or the deny-list (gitleaks in CI
// does not honour the marker either).
//
// Local deny-list (personal identifiers): if $EFF_SCAN_DENYLIST names a readable file, else if
// ~/.local/share/espn-fantasy-football-mcp-dev/scan-denylist.txt exists, every non-comment line is
// a case-insensitive literal that must not appear in any scanned content, file path or commit
// message — also when a line break or zero-width character splits it, when it is %XX-, \uXXXX-,
// backslash- or HTML-entity-encoded, and (for terms of ≥ 6 letters/digits) when punctuation, emoji
// or symbols separate its words (`gridiron.gang`). List distinctive location/nickname parts and team
// abbreviations as separate lines: a name stored as separate fields never forms the joined term. A match prints ONLY
// "deny-list match in <file>:<line>"; the term and the file's contents are never printed. Absent
// file = no deny-list (CI has none). The file lives outside the repo: it holds the very strings
// that must never enter it.

import { existsSync, lstatSync, readFileSync, readlinkSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The marker that skips the generic rules on its line (never a strict rule, never the deny-list). */
const ALLOW_MARKER = "scan-secrets: allow";

/** Placeholder words that mark a GENERIC-rule value as documentation, not a secret. */
const PLACEHOLDER =
  /example|placeholder|your[-_]|[-_]here\b|xxxx|dummy|fake|redacted|changeme|change[-_]me|<[^>]*>|\$\{|\bnot[-_]?a[-_]?real|sample|fixture|test[-_]?(?:token|secret|key|value)|lorem|abcdef0123|0123456789abcdef/i;

/** The fixture pseudonym range for ESPN member GUIDs (CLAUDE.md; research 03 §F.3). */
export const FAKE_GUID = /^0{8}-0{4}-4000-8000-0{10}[0-9a-f]{2}$/i;
const GUID = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";
/** The two IPv4 literals documentation may show (plan 04 R11). */
const ALLOWED_IPV4 = new Set(["127.0.0.1", "0.0.0.0"]);

/** A home-directory name that is a placeholder: `<you>`, `<name>`, `$USER`, `${USER}`, `…`, `...`. */
function isPlaceholderName(name) {
  return (
    /^<[^<>]*>$/.test(name) || /^\$\{?[A-Za-z_]\w*\}?$/.test(name) || /^(?:…|\.\.\.)$/.test(name)
  );
}

/** A cookie-header value that is plainly a placeholder (`<your value>`, `${SWID}`, `…`, `[redacted]`). */
function isPlaceholderCookie(v) {
  return (
    v.length < 8 ||
    /^(?:<|\$|\[|…|\.\.\.|\{X)/i.test(v) ||
    /redacted|example|placeholder|your[-_]/i.test(v)
  );
}

/** Shannon entropy in bits per character. */
export function entropy(s) {
  if (!s.length) return 0;
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * A bare run that looks like an espn_s2 value: ≥ 100 chars of the cookie alphabet, starting `AE`
 * (two published examples, plan 04 A-2) or carrying ≥ 2 percent-escapes (DevTools shows the value
 * URL-encoded — research 03 §C.1) — or ≥ 40 chars (what `eff setup` accepts with a warning, ADV
 * OBJ-15) when it starts `AE` AND carries ≥ 2 escapes — mixed-case with digits, and high-entropy.
 */
export function looksLikeBareEspnS2(run) {
  if (run.length < BARE_MIN) return false;
  const escapes = (run.match(/%[0-9A-Fa-f]{2}/g) ?? []).length;
  const ae = run.startsWith("AE");
  if (!(run.length >= 100 ? ae || escapes >= 2 : ae && escapes >= 2)) return false;
  if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/\d/.test(run)) return false;
  return entropy(run) >= (run.length >= 100 ? 4.0 : 3.5);
}

/** The shortest run the bare-espn_s2 heuristics consider (S3: a 40–99-char paste). */
export const BARE_MIN = 40;

/** The espn_s2 cookie alphabet as a lookup table (ASCII only). */
const COOKIE_CHAR = (() => {
  const t = new Uint8Array(128);
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%+/=")
    t[c.charCodeAt(0)] = 1;
  return t;
})();

/**
 * Every maximal run of ≥ BARE_MIN cookie-alphabet characters in `line`, in one linear pass. A
 * JSON-escaped slash (`\/`) and a string concatenation (`" + "`, `' + '`) inside a value are
 * removed first, so a value split that way is one run again (S3).
 * @param {string} line
 * @returns {string[]}
 */
export function bareRuns(line) {
  const joined = line.replace(/\\\//g, "/").replace(/["'\x60]\s*\+\s*["'\x60]/g, "");
  const out = [];
  let start = -1;
  for (let i = 0; i <= joined.length; i++) {
    const code = i < joined.length ? joined.charCodeAt(i) : 0;
    if (code < 128 && COOKIE_CHAR[code] === 1) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= BARE_MIN) out.push(joined.slice(start, i));
      start = -1;
    }
  }
  return out;
}

/** Characters that may wrap a value fragment on its own line: whitespace, quotes, `+`, `,`, `;`, `\`. */
const WRAPPER_CHARS = new Set([" ", "\t", '"', "'", "\x60", "+", ",", ";", "\\"]);
/** Longer lines are never a wrapped fragment (a wrap is ≤ a few hundred columns). */
const MAX_FRAGMENT_LINE = 4096;

/**
 * The cookie-alphabet core of a line that is ONLY a value fragment (wrapper characters trimmed
 * from both ends, ≥ 8 cookie characters between), or null. A manual linear scan — never a regex:
 * a greedy class over a multi-megabyte line overflows V8's backtrack stack.
 * @param {string} line
 * @returns {string | null}
 */
export function fragmentCore(line) {
  if (line.length > MAX_FRAGMENT_LINE) return null;
  const t = line.replace(/\\\//g, "/");
  let a = 0;
  let b = t.length;
  while (a < b && WRAPPER_CHARS.has(t[a] ?? "")) a++;
  while (b > a && WRAPPER_CHARS.has(t[b - 1] ?? "")) b--;
  if (b - a < 8) return null;
  for (let i = a; i < b; i++) {
    const code = t.charCodeAt(i);
    if (!(code < 128 && COOKIE_CHAR[code] === 1)) return null;
  }
  return t.slice(a, b);
}

/**
 * Values wrapped across lines (80-column wrapping, `"AE…" +⏎ "…"` concatenation): consecutive
 * fragment lines are joined and their runs returned with the group's first line (1-based). Linear.
 * @param {string[]} lines
 * @returns {{ line: number, run: string }[]}
 */
export function wrappedRuns(lines) {
  const out = [];
  let group = "";
  let first = -1;
  let count = 0;
  const flush = () => {
    if (count >= 2) for (const run of bareRuns(group)) out.push({ line: first + 1, run });
    group = "";
    first = -1;
    count = 0;
  };
  lines.forEach((raw, i) => {
    const core = fragmentCore(raw);
    if (core !== null) {
      if (first < 0) first = i;
      group += core;
      count++;
    } else flush();
  });
  flush();
  return out;
}

/**
 * The text of a match's own line before it, at most 1 KiB: a rule runs over a whole text, so
 * `m.input` is the file — reading all of it before every match would be quadratic.
 * @param {RegExpExecArray} m
 */
function lineBefore(m) {
  const w = m.input.slice(Math.max(0, m.index - 1024), m.index);
  return w.slice(w.lastIndexOf("\n") + 1);
}

/** True when every octet is 0–255 and the address is not one of the two allowed literals. */
function isReportableIpv4(addr) {
  const parts = addr.split(".");
  if (parts.length !== 4 || !parts.every((p) => Number(p) <= 255)) return false;
  return !ALLOWED_IPV4.has(parts.map(Number).join("."));
}

/**
 * @typedef {{ id: string, re?: RegExp, find?: (line: string) => string[], group?: number,
 *             strict?: boolean, allow?: (m: RegExpExecArray) => boolean }} Rule
 * find: a linear matcher used instead of `re` (returns the offending substrings).
 * strict: never suppressed by `scan-secrets: allow` and never by the generic placeholder words.
 * @type {Rule[]}
 */
export const RULES = [
  // --- ESPN credentials (plan 04 §4.3) — strict -----------------------------------------------
  {
    // the bearer cookie with its name: 40 (plan 04 §4.1 identifiers row; gitleaks uses 80) chars
    id: "espn-s2-cookie",
    re: new RegExp(
      String.raw`espn[_-]?s2["'\x60]?\s*(?:[:=]|=>)\s*["'\x60]?([A-Za-z0-9%+/=._-]{40,8192})`,
      "gi",
    ),
    group: 1,
    strict: true,
    // not a cookie: a value with no digit (a real one always has one), or a dotted code path
    // (`credentials.espnS2Value…` — base64 and URL-encoding never produce a ".")
    allow: (m) =>
      !/\d/.test(m[1] ?? "") || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(m[1] ?? ""),
  },
  {
    // a value pasted without its name — found by a linear scan (bareRuns), never a regex: a greedy
    // class with look-arounds overflows V8's backtrack stack on a multi-megabyte line
    id: "espn-s2-bare",
    find: (line) => bareRuns(line).filter(looksLikeBareEspnS2),
    strict: true,
  },
  {
    id: "espn-swid",
    re: new RegExp(String.raw`\bswid["'\x60]?\s*[:=]\s*["'\x60]?(?:\{|%7B)?(${GUID})`, "gi"),
    group: 1,
    strict: true,
    allow: (m) => FAKE_GUID.test(m[1] ?? ""),
  },
  {
    // every member id in an ESPN payload is a brace-GUID (research 03 §B.3); URL-encoded braces too
    id: "brace-guid",
    re: new RegExp(String.raw`(?:\{|%7B)(${GUID})(?:\}|%7D)`, "gi"),
    group: 1,
    strict: true,
    allow: (m) => FAKE_GUID.test(m[1] ?? ""),
  },
  {
    // a captured Cookie / Set-Cookie header carrying a value for espn_s2 or SWID
    id: "cookie-header",
    re: /\b(?:set-)?cookie["'\x60]?\s*:[^\n]*?\b(?:espn_s2|swid)\s*=\s*([^\s;"'\x60]+)/gi,
    group: 1,
    strict: true,
    allow: (m) => isPlaceholderCookie(m[1] ?? ""),
  },
  {
    // league ids are identifiers (HANDOFF): leagueId=, league_id:, league+id= (form-encoded),
    // league id: N, "leagueIds": [N], a markdown cell `| league id | N |`, ESPN_LEAGUE_ID=,
    // EFF_PROBE_LEAGUE_ID=, --league N, --league-id=N, …/leagues/<id>, …/leagueHistory/<id> — 4+
    // digits, all-zero allowed. Their %XX / \uXXXX / backslash / HTML-entity encoded forms
    // (leagueId%3D<id>, %2Fleagues%2F<id>, {\"leagueId\":<id>}, \/leagues\/<id>, …) are read
    // through lineFindingIds' decoded view; .gitleaks.toml carries the same literal forms plus an
    // explicit twin for each encoding (gitleaks decodes no entity and no escaped quote or slash).
    // Each run of whitespace follows the token before it — `\s*(?:[:=|]\s*)?(?:\[\s*)?`, the very
    // strings `\s*[:=|]?\s*\[?\s*` reads — so a long run with no id after it backtracks once, not
    // in every split of the run among three `\s*`: that was cubic (2,000 blanks after "league id"
    // took 19 s), and the whole-text pass makes a run of blank lines such a run.
    id: "espn-league-id",
    re: /(?:league[ _+-]?ids?["'\x60]?\s*(?:[:=|]\s*)?(?:\[\s*)?["'\x60]?|--league(?:-id)?[ =]["'\x60]?|\bleagues\/|\bleagueHistory\/)(\d{4,})/gi,
    group: 1,
    strict: true,
    allow: (m) => /^0+$/.test(m[1] ?? ""),
  },
  {
    // the root of any ESPN league body: `"gameId": 1, "id": <league id>, "<a league key>"` in the
    // canonical (sorted) key order — the most likely unscrubbed-fixture leak, and CI has no
    // deny-list (S3). A season body (`/seasons/{s}`: `"id": <year>, "name"`) is not a league body.
    id: "espn-league-envelope",
    re: /"gameId"\s*:\s*1\s*,\s*"id"\s*:\s*(\d+)\s*,\s*"(?:members|schedule|scoringPeriodId|seasonId|segmentId|settings|status|teams)"/g,
    group: 1,
    strict: true,
    allow: (m) => /^0+$/.test(m[1] ?? ""),
  },
  {
    // the IP field of mStatus (research 03 §A.2)
    id: "client-address",
    re: /"clientAddress"\s*:\s*"([^"]*)"/g,
    group: 1,
    strict: true,
    allow: (m) => /^(?:|0\.0\.0\.0|<[^<>]*>)$/.test(m[1] ?? ""),
  },
  // --- personal identifiers (plan 04 R11) — strict ----------------------------------------------
  {
    id: "ipv4-literal",
    re: /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?!\.?\d)/g,
    group: 1,
    strict: true,
    allow: (m) => !isReportableIpv4(m[1] ?? ""),
  },
  {
    // /Users/<name>, /home/<name>, C:\Users\<name> (JSON-escaped too); and the same paths as Claude
    // Code spells them in a scratchpad or a transcript directory — every character but a letter or
    // a digit turned into "-": /private/tmp/claude-<uid>/-Users-<name>-…, ~/.claude/projects/
    // -Users-<name>-…, -home-<name>-…, C--Users-<name>-…, and an encoded path inside another one
    // (…-claude-501--Users-<name>-…). The dash form starts a path segment (after a slash, a
    // backslash, a quote, a space, a bracket or the line's start) or follows "<letter or digit>-"
    // (that "-" is an encoded slash or colon), so `--home-dir` and `Power-Users-guide` are not
    // home paths (Stage C finding scan-home-path-dash-encoded: HANDOFF item 13's leak was this
    // form). The same spelling with its leading dash dropped — `…/Users-<name>-…`, or a line that
    // starts `Users-<name>-` — is one too, as macOS names the folder ("Users", capital U, and a
    // further "-" segment): `users-guide-…` and `/home-assistant-…` are prose and URLs, not paths.
    // Placeholders are exempt in every form.
    id: "home-path",
    re: /(?:(?:\/|\\\/|%2F)(?:Users|home)(?:\/|\\\/|%2F)|\b[A-Za-z]:(?:\\{1,2}|\/|%5C|%2F)Users(?:\\{1,2}|\/|%5C|%2F))(<[^<>\s]{0,64}>|\$\{[A-Za-z_]\w{0,64}\}|[^/\\\s"'\x60<>()[\]{},;:|*?%]{1,256})|(?:(?<=^|[\s/\\"'\x60(\[{=:,;|<>])|(?<=[A-Za-z0-9]-))-(?:Users|home)-(<[^<>\s]{0,64}>|\$\{[A-Za-z_]\w{0,64}\}|\$[A-Za-z_]\w{0,64}|…|\.\.\.|[A-Za-z0-9_.]{1,256})|(?<=^|[\n/])Users-(<[^<>\s]{0,64}>|\$\{[A-Za-z_]\w{0,64}\}|\$[A-Za-z_]\w{0,64}|…|\.\.\.|[A-Za-z0-9_.]{1,256})-/gi,
    group: 1,
    strict: true,
    allow: (m) =>
      isPlaceholderName(m[1] ?? m[2] ?? m[3] ?? "") ||
      (m[3] !== undefined && !m[0].startsWith("Users-")),
  },
  {
    // ANY mailbox (CLAUDE.md); only no-reply and reserved placeholder addresses pass. The
    // lookbehind starts a match only at the beginning of a local-part run (linear on long lines).
    id: "email-address",
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    strict: true,
    // not a mailbox: a no-reply/reserved address; the `git` SSH transport user (git@github.com:…);
    // or the PASSWORD half of URL userinfo (scheme://user:pw@host — `pw@host` is what matched).
    // A bare `//name@host` (protocol-relative URL, `//comment`) is NOT exempt (S3).
    allow: (m) =>
      isPlaceholderEmail(m[0]) ||
      /^git@/i.test(m[0]) ||
      /[a-z][a-z0-9+.-]*:\/\/[^/\s@:]*:$/i.test(lineBefore(m)),
  },
  {
    // the same mailbox URL- or HTML-encoded (`name%40<domain>`, `name&#64;<domain>`)
    id: "email-address-encoded",
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._+-]+(?:%40|&#0*64;|&#x0*40;)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gi,
    strict: true,
    allow: (m) => isPlaceholderEmail(m[0].replace(/%40|&#0*64;|&#x0*40;/i, "@")),
  },
  {
    // an IPv6 literal anywhere (not only clientAddress): the full 8-group form, or a compressed
    // form with a group on both sides of `::` — never a clock time; link-local fe80::/10 and the
    // RFC 3849 documentation prefix 2001:db8::/32 are allowed (S3)
    id: "ipv6-literal",
    re: /(?<![0-9A-Za-z:.])((?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4})(?![0-9A-Za-z:])/g,
    group: 1,
    strict: true,
    allow: (m) =>
      /^(?:2001:0?db8:|fe[89ab][0-9a-f]:)/i.test(m[1] ?? "") || !/[0-9]/.test(m[1] ?? ""),
  },
  {
    id: "private-key",
    strict: true,
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  // --- generic credentials ----------------------------------------------------------------------
  {
    id: "odds-api-key",
    re: /odds[_-]?api[_-]?key["']?\s*[:=]\s*["']?([0-9a-f]{32})\b/gi,
    group: 1,
  },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "github-fine-grained-token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: "bearer-token", re: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{24,}=*)/g, group: 1 },
  {
    id: "assigned-secret",
    re: /(?:secret|token|passw(?:or)?d|api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token)["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi,
    group: 1,
  },
  {
    // a line-start assignment: the indentation before it is the line's own (`[^\S\n]`, whitespace
    // but a line break — what `\s` was when every rule read one line), so over a whole text `^`
    // never starts a match in a run of blank lines above it, where each start re-read the run
    // (quadratic: 20,000 blank lines took 2.3 s); every line start is still a start of its own
    id: "env-secret",
    re: /^[^\S\n]*(?:export[^\S\n]+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY)[A-Z0-9_]*\s*=\s*([^\s#'"]{12,})/gm,
    group: 1,
  },
];

/** RFC 2606 / RFC 6761 reserved names: never a real mailbox. */
const RESERVED_DOMAIN = /(?:^|\.)(?:example|invalid|test|localhost)$|^example\.(?:com|net|org)$/;

/**
 * True for an address that can never identify a person: a no-reply mailbox (GitHub's
 * users.noreply.github.com, noreply@…, no-reply@…) or one on a reserved domain.
 * @param {string} addr
 */
export function isPlaceholderEmail(addr) {
  const at = addr.lastIndexOf("@");
  if (at <= 0) return false;
  const local = addr.slice(0, at).toLowerCase();
  const domain = addr.slice(at + 1).toLowerCase();
  if (domain === "users.noreply.github.com") return true;
  if (/^no-?reply$/.test(local)) return true;
  return RESERVED_DOMAIN.test(domain);
}

/**
 * The commit identity rule (CLAUDE.md): author and committer must be a GitHub no-reply address,
 * `<id>+<login>@users.noreply.github.com` or the older `<login>@users.noreply.github.com`.
 * @param {string} addr
 */
export function isGithubNoreply(addr) {
  return /^(?:\d+\+)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})@users\.noreply\.github\.com$/i.test(addr);
}

// --- what a blob IS (its bytes decide, never only its name) ---------------------------------------
//
// The scanner reads UTF-8 text, and UTF-16 / UTF-32 text that starts with a byte-order mark; it
// decompresses gzip (every member; the header's text fields scanned; nothing may follow the last
// member; the deny-list over the outer bytes too). Everything else is REFUSED (fail closed): an
// archive, a document container (.docx/.xlsx/.pptx/.odt/.numbers/.epub/.jar are zip files, a .pdf
// carries Flate streams), a compressed stream or a database — detected by content (magic number, or
// a zip record anywhere: a zip appended to another file still opens) and by extension —; an opaque
// binary (an image, audio, video, font, wasm or native object: OPAQUE_FORMATS) no person has
// reviewed; and any other content that is neither text nor a recognised binary (a raw deflate or
// brotli stream, legacy-encoded text, UTF-16 without a byte-order mark that is not plain ASCII). A
// rule cannot see into compressed bytes, and an image's pixels and most of its metadata ARE
// compressed bytes (PNG's IDAT, zTXt and compressed iTXt are deflate streams; a screenshot carries
// its text as pixels), so "clean" would be a lie. A refused or reviewed blob is still read by the
// deny-list in every reading rawDenyViews gives, and a reviewed one by every rule too. The same
// holds for a file a text embeds as a base64 data: URI (embeddedFindings, below): its bytes are
// judged as these are, and a binary among them is refused.

/**
 * Archives, document containers, compressed streams and databases refused by NAME (S5: a compressed
 * raw capture or a store dump would skip every identifier rule) — fail closed — unless the blob is
 * a reviewed binary (REVIEWED_BINARIES, empty today). gzip (`.gz`, `.tgz`, `.svgz`) is decompressed
 * and scanned instead. Content sniffing (containerKind) refuses the same formats under any other
 * name.
 */
export const REFUSED_EXT =
  /\.(?:zip|jar|war|ear|aar|apk|aab|ipa|xpi|crx|whl|egg|nupkg|vsix|docx|docm|dotx|dotm|xlsx|xlsm|xlsb|xltx|xltm|pptx|pptm|potx|potm|ppsx|odt|ods|odp|odg|odf|ott|ots|otp|numbers|pages|key|epub|kmz|3mf|xps|oxps|usdz|sketch|pdf|doc|xls|ppt|msg|msi|cab|woff2?|7z|xz|zst|zstd|bz2|lz4|lzma|lz|lzo|br|z|rar|tar|iso|dmg|pkg|deb|rpm|sqlite|sqlite3|db|db3|parquet|arrow|feather|ipc|duckdb)$/i;
export const GZIP_EXT = /\.(?:gz|tgz|svgz)$/i;
/**
 * The binaries a person has reviewed — looked at what each one shows and carries (its pixels, its
 * metadata) — each as its committed path and the sha256 of its exact bytes. Nothing else that is
 * not text is ever committed (Stage C finding scan-opaque-binaries-unscanned: a cookie, a SWID, a
 * league id or a mailbox in a PNG's or a JPEG's metadata passed the hooks, commit-paths.sh and CI,
 * where no rule read an image, and a PNG's compressed text chunks hid even a deny-listed name). The
 * pair IS the review: a changed byte or a moved file is unreviewed again. Every rule and the
 * deny-list still read a reviewed blob's bytes. Empty: the repository tracks no binary.
 * @type {readonly { readonly path: string, readonly sha256: string }[]}
 */
export const REVIEWED_BINARIES = Object.freeze([]);

/**
 * True when `label` (the published path) and the sha256 of `buf` are a reviewed pair in `reviewed`.
 * @param {string} label
 * @param {Buffer} buf
 * @param {readonly { path: string, sha256: string }[]} [reviewed]
 */
export function isReviewedBinary(label, buf, reviewed = REVIEWED_BINARIES) {
  const entries = reviewed.filter((r) => r.path === label);
  if (!entries.length) return false;
  const digest = createHash("sha256").update(buf).digest("hex");
  return entries.some((r) => r.sha256.toLowerCase() === digest);
}
/** gzip layers it peels before refusing (a gzip inside a gzip inside a gzip is refused). */
export const MAX_GZIP_LAYERS = 3;

/**
 * Every member of a gzip stream (RFC 1952 §2.3) with the bytes its header publishes beside the
 * compressed data — FEXTRA's payload, FNAME (the source file's name, which gzip writes by default)
 * and FCOMMENT — and its decompressed bytes, plus the count of bytes after the last member. zlib's
 * gunzip reads neither: it drops the header fields, and it stops at a NUL after a member, silently
 * discarding whatever follows, so those bytes passed every rule and the deny-list (Stage C finding
 * scan-gzip-header-trailer-unscanned). Each member's CRC-32 and length are checked. Throws on
 * anything that is not well-formed gzip, or past `maxOut` decompressed bytes in all.
 * @param {Buffer} buf
 * @param {number} maxOut
 * @returns {{ members: { fields: { kind: string, bytes: Buffer }[], data: Buffer }[], trailing: number }}
 */
export function gzipMembers(buf, maxOut) {
  /** @type {{ fields: { kind: string, bytes: Buffer }[], data: Buffer }[]} */
  const members = [];
  let off = 0;
  let total = 0;
  while (off < buf.length && bytesAt(buf, off, [0x1f, 0x8b])) {
    if (buf[off + 2] !== 8) throw new Error("gzip: not a deflate member");
    const flg = buf[off + 3] ?? 0;
    if (flg & 0xe0) throw new Error("gzip: reserved flag bits set");
    let p = off + 10;
    /** @param {number} n */
    const need = (n) => {
      if (p + n > buf.length) throw new Error("gzip: truncated member");
    };
    need(0);
    /** @type {{ kind: string, bytes: Buffer }[]} */
    const fields = [];
    if (flg & 0x04) {
      need(2);
      const xlen = buf.readUInt16LE(p);
      need(2 + xlen);
      fields.push({ kind: "extra field", bytes: buf.subarray(p + 2, p + 2 + xlen) });
      p += 2 + xlen;
    }
    for (const [bit, kind] of /** @type {const} */ ([
      [0x08, "file name"],
      [0x10, "comment"],
    ])) {
      if (!(flg & bit)) continue;
      const end = buf.indexOf(0, p);
      if (end < 0) throw new Error("gzip: unterminated header field");
      fields.push({ kind, bytes: buf.subarray(p, end) });
      p = end + 1;
    }
    if (flg & 0x02) p += 2; // FHCRC
    need(0);
    // the raw deflate stream: zlib reports how many input bytes it consumed up to its final block
    const { buffer: data, engine } = inflateRawSync(buf.subarray(p), {
      info: true,
      maxOutputLength: Math.max(1, maxOut - total),
    });
    p += engine.bytesWritten;
    need(8);
    if (buf.readUInt32LE(p) !== crc32(data) || buf.readUInt32LE(p + 4) !== data.length % 2 ** 32)
      throw new Error("gzip: CRC-32 or length mismatch");
    total += data.length;
    members.push({ fields, data });
    off = p + 8;
  }
  if (!members.length) throw new Error("gzip: no member");
  return { members, trailing: buf.length - off };
}

/**
 * The readings of a gzip header field: latin1 (RFC 1952's charset; one character per byte) and,
 * when the bytes are valid UTF-8 that reads differently, UTF-8 (what gzip writes for a non-ASCII
 * file name on a UTF-8 system).
 * @param {Buffer} bytes
 * @returns {string[]}
 */
function headerReadings(bytes) {
  const latin1 = bytes.toString("latin1");
  const utf8 = decodeText(bytes);
  return utf8 !== null && utf8.text !== latin1 ? [latin1, utf8.text] : [latin1];
}

/** @param {Buffer} b @param {number} off @param {readonly number[]} bytes */
const bytesAt = (b, off, bytes) =>
  b.length >= off + bytes.length && bytes.every((x, i) => b[off + i] === x);
/** @param {Buffer} b @param {number} off @param {string} s  (latin1: one char per byte) */
const asciiAt = (b, off, s) =>
  b.length >= off + s.length && b.toString("latin1", off, off + s.length) === s;

const ZIP_RECORDS = ["PK\x03\x04", "PK\x01\x02", "PK\x05\x06", "PK\x07\x08"].map((s) =>
  Buffer.from(s, "latin1"),
);

/**
 * Container, compressed and database formats by their bytes, whatever the file is called.
 * @type {readonly { kind: string, label: string, test: (b: Buffer) => boolean }[]}
 */
export const CONTAINER_FORMATS = Object.freeze([
  { kind: "gzip", label: "gzip stream", test: (b) => bytesAt(b, 0, [0x1f, 0x8b]) },
  {
    // a zip record at any offset: a zip reader starts from the end record, so a zip appended to an
    // image or a text file is still a zip (four bytes with two control characters: never text)
    kind: "zip",
    label: "zip container (.zip/.docx/.xlsx/.pptx/.odt/.numbers/.epub/.jar …)",
    test: (b) => ZIP_RECORDS.some((r) => b.includes(r)),
  },
  {
    // readers accept the header anywhere in the first KiB
    kind: "pdf",
    label: "PDF (its streams are compressed)",
    test: (b) => b.subarray(0, 1024).includes("%PDF-", 0, "latin1"),
  },
  {
    kind: "bzip2",
    label: "bzip2 stream",
    test: (b) =>
      asciiAt(b, 0, "BZh") &&
      b[3] !== undefined &&
      b[3] >= 0x31 &&
      b[3] <= 0x39 &&
      (bytesAt(b, 4, [0x31, 0x41, 0x59, 0x26, 0x53, 0x59]) ||
        bytesAt(b, 4, [0x17, 0x72, 0x45, 0x38, 0x50, 0x90])),
  },
  { kind: "xz", label: "xz stream", test: (b) => bytesAt(b, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]) },
  { kind: "zstd", label: "zstd stream", test: (b) => bytesAt(b, 0, [0x28, 0xb5, 0x2f, 0xfd]) },
  { kind: "lz4", label: "lz4 stream", test: (b) => bytesAt(b, 0, [0x04, 0x22, 0x4d, 0x18]) },
  { kind: "lzip", label: "lzip stream", test: (b) => bytesAt(b, 0, [0x4c, 0x5a, 0x49, 0x50, 1]) },
  {
    kind: "compress",
    label: "compress/LZH stream",
    test: (b) => bytesAt(b, 0, [0x1f, 0x9d]) || bytesAt(b, 0, [0x1f, 0xa0]),
  },
  {
    kind: "7z",
    label: "7z archive",
    test: (b) => bytesAt(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  },
  {
    kind: "rar",
    label: "RAR archive",
    test: (b) => bytesAt(b, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]),
  },
  {
    kind: "cab",
    label: "cabinet archive",
    test: (b) => bytesAt(b, 0, [0x4d, 0x53, 0x43, 0x46, 0, 0, 0, 0]),
  },
  {
    kind: "cfb",
    label: "OLE compound document (.doc/.xls/.ppt/.msg/.msi)",
    test: (b) => bytesAt(b, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  },
  { kind: "ar", label: "ar archive (.a/.deb)", test: (b) => asciiAt(b, 0, "!<arch>\n") },
  {
    kind: "xar",
    label: "xar archive (.pkg/.xip)",
    test: (b) => bytesAt(b, 0, [0x78, 0x61, 0x72, 0x21, 0]),
  },
  { kind: "rpm", label: "RPM package", test: (b) => bytesAt(b, 0, [0xed, 0xab, 0xee, 0xdb]) },
  {
    kind: "tar",
    label: "tar archive",
    test: (b) => asciiAt(b, 257, "ustar\0") || asciiAt(b, 257, "ustar  \0"),
  },
  { kind: "iso", label: "ISO 9660 image", test: (b) => asciiAt(b, 0x8001, "CD001") },
  {
    kind: "dmg",
    label: "disk image",
    test: (b) => b.length >= 512 && asciiAt(b, b.length - 512, "koly"),
  },
  {
    kind: "woff",
    label: "compressed web font (WOFF/WOFF2)",
    test: (b) =>
      (asciiAt(b, 0, "wOFF") || asciiAt(b, 0, "wOF2")) &&
      (bytesAt(b, 4, [0, 1, 0, 0]) || asciiAt(b, 4, "OTTO") || asciiAt(b, 4, "true")),
  },
  { kind: "sqlite", label: "SQLite database", test: (b) => asciiAt(b, 0, "SQLite format 3\0") },
  {
    kind: "parquet",
    label: "Parquet file",
    test: (b) => b.length >= 8 && asciiAt(b, 0, "PAR1") && asciiAt(b, b.length - 4, "PAR1"),
  },
  { kind: "arrow", label: "Arrow IPC file", test: (b) => asciiAt(b, 0, "ARROW1\0\0") },
  {
    kind: "feather",
    label: "Feather file",
    test: (b) => b.length >= 8 && asciiAt(b, 0, "FEA1") && asciiAt(b, b.length - 4, "FEA1"),
  },
]);

/**
 * The container / compressed / database format a blob's bytes carry, or null.
 * @param {Buffer} buf
 * @returns {{ kind: string, label: string } | null}
 */
export function containerKind(buf) {
  for (const f of CONTAINER_FORMATS) if (f.test(buf)) return { kind: f.kind, label: f.label };
  return null;
}

const MACHO = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
];
/**
 * Opaque binary formats, each by extension AND magic number: no rule can read one (its bytes are
 * not text — an image's pixels and compressed chunks, a font's or an object's tables), so one is
 * refused unless it is a reviewed binary (REVIEWED_BINARIES); the label names the format in the
 * refusal. A file with one of these extensions whose bytes do not carry the magic is not that
 * format: it is read as text, or refused as unrecognised.
 * @type {readonly { ext: RegExp, label: string, test: (b: Buffer) => boolean }[]}
 */
export const OPAQUE_FORMATS = Object.freeze([
  { ext: /\.png$/i, label: "PNG image", test: (b) => bytesAt(b, 0, [0x89, 0x50, 0x4e, 0x47]) },
  { ext: /\.jpe?g$/i, label: "JPEG image", test: (b) => bytesAt(b, 0, [0xff, 0xd8, 0xff]) },
  {
    ext: /\.gif$/i,
    label: "GIF image",
    test: (b) => asciiAt(b, 0, "GIF87a") || asciiAt(b, 0, "GIF89a"),
  },
  {
    ext: /\.webp$/i,
    label: "WebP image",
    test: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WEBP"),
  },
  {
    ext: /\.(?:ico|cur)$/i,
    label: "icon",
    test: (b) => bytesAt(b, 0, [0, 0, 1, 0]) || bytesAt(b, 0, [0, 0, 2, 0]),
  },
  { ext: /\.icns$/i, label: "Apple icon", test: (b) => asciiAt(b, 0, "icns") },
  { ext: /\.bmp$/i, label: "BMP image", test: (b) => asciiAt(b, 0, "BM") },
  {
    ext: /\.tiff?$/i,
    label: "TIFF image",
    test: (b) => bytesAt(b, 0, [0x49, 0x49, 0x2a, 0]) || bytesAt(b, 0, [0x4d, 0x4d, 0, 0x2a]),
  },
  {
    ext: /\.(?:avif|heic|heif|mp4|m4a|mov)$/i,
    label: "HEIF/AVIF image or MP4/MOV media",
    test: (b) => asciiAt(b, 4, "ftyp"),
  },
  {
    ext: /\.mp3$/i,
    label: "MP3 audio",
    test: (b) => asciiAt(b, 0, "ID3") || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  },
  {
    ext: /\.wav$/i,
    label: "WAV audio",
    test: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WAVE"),
  },
  { ext: /\.ogg$/i, label: "Ogg media", test: (b) => asciiAt(b, 0, "OggS") },
  { ext: /\.webm$/i, label: "WebM media", test: (b) => bytesAt(b, 0, [0x1a, 0x45, 0xdf, 0xa3]) },
  {
    ext: /\.(?:ttf|otf)$/i,
    label: "TrueType/OpenType font",
    test: (b) => bytesAt(b, 0, [0, 1, 0, 0]) || asciiAt(b, 0, "OTTO") || asciiAt(b, 0, "true"),
  },
  {
    ext: /\.wasm$/i,
    label: "WebAssembly module",
    test: (b) => bytesAt(b, 0, [0, 0x61, 0x73, 0x6d]),
  },
  {
    ext: /\.(?:node|so|dylib|o|bin)$/i,
    label: "native object (ELF, Mach-O or PE)",
    test: (b) =>
      bytesAt(b, 0, [0x7f, 0x45, 0x4c, 0x46]) ||
      MACHO.some((m) => bytesAt(b, 0, m)) ||
      asciiAt(b, 0, "MZ"),
  },
  {
    ext: /\.class$/i,
    label: "Java class file",
    test: (b) => bytesAt(b, 0, [0xca, 0xfe, 0xba, 0xbe]),
  },
]);

/**
 * The opaque binary format `name` names and `buf` carries the magic number of, or null.
 * @param {string} name
 * @param {Buffer} buf
 * @returns {string | null}
 */
export function opaqueKind(name, buf) {
  return OPAQUE_FORMATS.find((f) => f.ext.test(name) && f.test(buf))?.label ?? null;
}

/**
 * True when `name` is an opaque binary format and `buf` carries that format's magic number.
 * @param {string} name
 * @param {Buffer} buf
 */
export function isOpaqueBinary(name, buf) {
  return opaqueKind(name, buf) !== null;
}

/**
 * The texts the deny-list (and, for a reviewed binary or a short embedded payload, every rule)
 * reads in bytes no rule decodes — a reviewed binary, content it refuses:
 * the bytes one per character (latin1); as UTF-8, where a non-ASCII term is stored as UTF-8 (an image's
 * XMP or iTXt metadata); and, when the bytes hold NULs, without them and as UTF-16 in both byte orders
 * and alignments, where a term is stored as UTF-16 (EXIF XP* tags, ID3 frames, Windows resources).
 * Read as latin1 only, those terms were never seen (Stage C finding scan-utf16-fails-open, its binary
 * half). Each view is another reading of the same bytes, never a decompression; they are produced
 * one at a time, so a large blob never holds them all at once.
 * @param {Buffer} buf
 * @returns {Generator<string>}
 */
export function* rawDenyViews(buf) {
  yield buf.toString("latin1");
  yield buf.toString("utf8");
  if (!buf.includes(0)) return;
  yield buf.toString("latin1").replaceAll("\u0000", "");
  for (const off of [0, 1]) {
    const b = buf.subarray(off, off + ((buf.length - off) & ~1));
    yield b.toString("utf16le");
    yield Buffer.from(b).swap16().toString("utf16le");
  }
}

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const UTF16LE_STRICT = new TextDecoder("utf-16le", { fatal: true });
const UTF16BE_STRICT = new TextDecoder("utf-16be", { fatal: true });

/** @param {Buffer} b @param {boolean} le @returns {string | null} */
function decodeUtf32(b, le) {
  if (b.length % 4 !== 0) return null;
  const parts = [];
  for (let i = 0; i < b.length; i += 4) {
    const cp = le ? b.readUInt32LE(i) : b.readUInt32BE(i);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    parts.push(String.fromCodePoint(cp));
  }
  return parts.join("");
}

/**
 * The text a blob holds, or null when it is not text the scanner can read: UTF-8 (a byte-order mark
 * is dropped), or UTF-16 / UTF-32 in either byte order when a byte-order mark says so (S7: a UTF-16
 * file read as UTF-8 has a NUL between every pair of characters, so no rule could ever match it).
 * Malformed text is not text (fail closed).
 * @param {Buffer} buf
 * @returns {{ encoding: string, text: string } | null}
 */
export function decodeText(buf) {
  try {
    if (bytesAt(buf, 0, [0xff, 0xfe, 0, 0])) {
      const text = decodeUtf32(buf.subarray(4), true);
      return text === null ? null : { encoding: "utf-32le", text };
    }
    if (bytesAt(buf, 0, [0, 0, 0xfe, 0xff])) {
      const text = decodeUtf32(buf.subarray(4), false);
      return text === null ? null : { encoding: "utf-32be", text };
    }
    if (bytesAt(buf, 0, [0xff, 0xfe]))
      return { encoding: "utf-16le", text: UTF16LE_STRICT.decode(buf.subarray(2)) };
    if (bytesAt(buf, 0, [0xfe, 0xff]))
      return { encoding: "utf-16be", text: UTF16BE_STRICT.decode(buf.subarray(2)) };
    // the decoder drops a UTF-8 byte-order mark itself
    return { encoding: "utf-8", text: UTF8_STRICT.decode(buf) };
  } catch {
    return null;
  }
}

/** The largest file it reads; anything larger is an error, never skipped. */
const MAX_SCAN_BYTES = (() => {
  const n = Number(process.env.EFF_SCAN_MAX_BYTES);
  return Number.isSafeInteger(n) && n > 0 ? n : 64 * 1024 * 1024;
})();

class ScanError extends Error {}

// --- deny-list ------------------------------------------------------------------------------------

/** Zero-width and invisible characters an identifier could hide behind. */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/** The HTML named entities a name is likely to be written with. */
const NAMED_ENTITIES = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
};

/**
 * Undoes the encodings a name or an identifier takes in captured text (S4), a bounded number of
 * layers: %XX (UTF-8 runs); backslash escapes, read left to right as a JSON or JS parser reads them
 * — \uXXXX (JSON's default for non-ASCII; Gson writes `=` that way too) and an escaped `\`, `/`,
 * quote or backtick (JSON inside JSON: `{\"leagueId\":…}`; PHP's `https:\/\/…`), so a
 * double-escaped \\uXXXX is two layers; and HTML entities (`&#39;`, `&#x27;` / `&#X27;`, `&amp;`).
 * Anything that does not decode is left as it is (`\n`, `\d` and the like stay).
 * @param {string} s
 */
export function decodeLayers(s) {
  let cur = s;
  for (let i = 0; i < 4; i++) {
    const next = cur
      .replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
        try {
          return decodeURIComponent(run);
        } catch {
          return run;
        }
      })
      .replace(/\\(?:u([0-9A-Fa-f]{4})|([\\/"'\x60]))/g, (_m, h, c) =>
        h !== undefined ? String.fromCharCode(Number.parseInt(h, 16)) : c,
      )
      .replace(/&#(?:[xX]([0-9A-Fa-f]{1,6})|([0-9]{1,7}));/g, (m, hex, dec) => {
        const cp = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
        return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
          ? String.fromCodePoint(cp)
          : m;
      })
      .replace(/&([a-z]{2,6});/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** NFKC, case-folded, curly quotes straightened, invisible characters removed — after decoding. */
export function normalise(s) {
  return decodeLayers(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(INVISIBLE, "");
}

/**
 * How an all-digit deny-list term (a league id) matches: as a whole digit run — never inside a
 * longer number — and, below NUMERIC_ALNUM_BOUNDARY digits, never touching a letter either (a
 * short id would otherwise hit every hex digest and stat value that happens to contain it). A
 * long id may touch letters (`league12345678`).
 * @param {string} digits
 */
export function numericTermRe(digits) {
  return digits.length >= NUMERIC_ALNUM_BOUNDARY
    ? new RegExp(`(?<![0-9])${digits}(?![0-9])`)
    : new RegExp(`(?<![0-9A-Za-z.])${digits}(?![0-9A-Za-z.])`);
}
/** Numeric terms this long may touch letters; shorter ones must stand alone. */
export const NUMERIC_ALNUM_BOUNDARY = 7;

/** Letters and digits only (any script): `gridiron.gang`, `Gridiron 🏈 Gang` → `gridirongang`. */
export function skeleton(s) {
  return s.replace(/[^\p{L}\p{N}]/gu, "");
}

/** A term's skeleton is compared too when it has at least this many letters/digits. */
export const SKELETON_MIN = 6;

/**
 * The deny-list file in force, or null: $EFF_SCAN_DENYLIST when it names a readable file, else the
 * default location when it exists. A default that exists but cannot be read is an error (fail
 * closed) — never "no deny-list".
 * @returns {string | null}
 */
function denylistPath() {
  const env = process.env.EFF_SCAN_DENYLIST;
  if (env) {
    try {
      accessSync(env, constants.R_OK);
      return env;
    } catch {
      /* fall through to the default */
    }
  }
  const def = join(
    homedir(),
    ".local",
    "share",
    "espn-fantasy-football-mcp-dev",
    "scan-denylist.txt",
  );
  return existsSync(def) ? def : null;
}

/**
 * The search forms of each deny-list term: the normalised literal, plus (for multi-word terms) the
 * URL-encoded and slug forms a team or member name takes in a URL or a file name.
 * @returns {string[]}
 */
export function parseDenylist(text) {
  const forms = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const t = normalise(line).replace(/\s+/g, " ");
    if (!t) continue;
    forms.add(t);
    if (t.includes(" ")) {
      for (const sep of ["%20", "+", "-", "_"]) forms.add(t.split(" ").join(sep));
      const joined = t.split(" ").join("");
      if (joined.length >= 8) forms.add(joined);
    }
  }
  return [...forms];
}

function loadDenylist() {
  const p = denylistPath();
  if (p === null) return [];
  try {
    return parseDenylist(readFileSync(p, "utf8"));
  } catch {
    throw new ScanError(
      "the local deny-list exists but cannot be read — refusing to scan without it (path and contents not printed)",
    );
  }
}

/**
 * Line numbers (1-based) where any deny-list form occurs: within a line, or split across up to two
 * line breaks (a wrapped name — each window of 2 and 3 consecutive lines is joined with whitespace
 * collapsed; a window hit is reported at its first line). Memory stays proportional to the text.
 * @param {string} text
 * @param {string[]} deny
 * @returns {number[]}
 */
export function denylistLines(text, deny) {
  if (!deny.length) return [];
  const norm = text.split(/\r?\n/).map((l) => normalise(l).replace(/\s+/g, " ").trim());
  const numericRes = deny.filter((d) => /^[0-9]+$/.test(d)).map(numericTermRe);
  const textual = deny.filter((d) => !/^[0-9]+$/.test(d));
  const skels = [
    ...new Set(textual.map((d) => skeleton(d)).filter((k) => k.length >= SKELETON_MIN)),
  ];
  const has = (/** @type {string} */ s) => {
    const t = s.replace(/\s+/g, " ");
    if (textual.some((d) => t.includes(d))) return true;
    if (numericRes.some((re) => re.test(t))) return true;
    if (!skels.length) return false;
    const k = skeleton(t);
    return skels.some((d) => k.includes(d));
  };
  const hits = new Set();
  for (let i = 0; i < norm.length; i++) {
    const a = norm[i] ?? "";
    if (has(a)) {
      hits.add(i + 1);
      continue;
    }
    const b = norm[i + 1];
    if (b === undefined) continue;
    if (has(`${a} ${b}`) && !has(b)) {
      hits.add(i + 1);
      continue;
    }
    const c = norm[i + 2];
    if (c !== undefined && has(`${a} ${b} ${c}`) && !has(`${b} ${c}`)) hits.add(i + 1);
  }
  return [...hits].sort((x, y) => x - y);
}

// --- git plumbing ---------------------------------------------------------------------------------

/** @param {string[]} args */
function git(args, maxBuffer = 16 * 1024 * 1024) {
  return execFileSync("git", args, { maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
}

/** Reads one blob by object id, refusing (ScanError) one larger than MAX_SCAN_BYTES. */
function readBlob(sha, file) {
  const size = Number(git(["cat-file", "-s", sha]).toString("utf8").trim());
  if (!(size >= 0)) throw new ScanError(`cannot size the staged blob of ${file}`);
  if (size > MAX_SCAN_BYTES)
    throw new ScanError(
      `${file} is ${String(size)} bytes, over the ${String(MAX_SCAN_BYTES)}-byte scan limit — it cannot be scanned, so it cannot be committed`,
    );
  return git(["cat-file", "blob", sha], MAX_SCAN_BYTES + 1024);
}

/** The index blob of `file` (--staged). A path missing from the index is an error, never "deleted". */
function readStaged(file) {
  const out = git(["--literal-pathspecs", "ls-files", "-s", "-z", "--", file]).toString("utf8");
  const entries = out.split("\0").filter(Boolean);
  const exact = entries.filter((e) => e.slice(e.indexOf("\t") + 1) === file);
  if (exact.length !== 1) throw new ScanError(`${file} is not (uniquely) in the index`);
  const [mode, sha] = (exact[0] ?? "").split(/[ \t]/);
  if (mode === "160000") return null; // a submodule commit, not a blob
  return readBlob(sha ?? "", file);
}

/** A working-tree file; a symlink is scanned as its target string (what git commits), never followed. */
function readWorktree(file) {
  if (!existsSync(file) && !isSymlink(file)) return null;
  const st = lstatSync(file);
  if (st.isSymbolicLink()) return Buffer.from(readlinkSync(file), "utf8");
  if (!st.isFile()) return null;
  if (st.size > MAX_SCAN_BYTES)
    throw new ScanError(
      `${file} is ${String(st.size)} bytes, over the ${String(MAX_SCAN_BYTES)}-byte scan limit — it cannot be scanned`,
    );
  return readFileSync(file);
}

/**
 * A working-tree file named on the command line: as readWorktree, but a name that does not exist is
 * an error, never a silent skip — scan-tarball.mjs passes npm's pack listing, which masks some
 * names (a GUID-shaped one reads `{***}`), and a skipped name would ship unscanned (fail closed).
 * The name is not printed: it may carry the very identifier the path rules look for.
 * @param {string} file
 * @param {number} n  the entry's 1-based number in this run
 */
function readNamed(file, n) {
  if (!existsSync(file) && !isSymlink(file))
    throw new ScanError(
      `scanned entry #${String(n)} does not exist (path not printed) — a name that cannot be read is never "clean"`,
    );
  return readWorktree(file);
}

function isSymlink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Every path the next commit adds or changes: `git diff --cached --raw -z --no-renames` (index vs
 * HEAD, or vs the empty tree before the first commit). NUL-separated, so no name is quoted; every
 * status except D is kept; blobs are read by object id. A submodule entry (mode 160000) has no
 * blob — `sha` null — but its path is published like any other, so it is returned for the path
 * rules (Stage C finding scan-paths-identifier-rules-skipped).
 * @returns {{file: string, sha: string | null}[]}
 */
function indexEntries() {
  const raw = git(
    [
      "diff",
      "--cached",
      "--raw",
      "-z",
      "--no-renames",
      "--no-abbrev",
      "--no-ext-diff",
      "--ignore-submodules=none",
    ],
    256 * 1024 * 1024,
  )
    .toString("utf8")
    .split("\0");
  const entries = [];
  for (let i = 0; i < raw.length; i++) {
    const meta = raw[i];
    if (!meta) continue;
    if (!meta.startsWith(":"))
      throw new ScanError(`unexpected git diff --raw record: ${meta.slice(0, 40)}`);
    const [, newMode, , newSha, status = ""] = meta.slice(1).split(" ");
    const paths = /^[RC]/.test(status) ? 2 : 1;
    const file = raw[i + paths] ?? "";
    i += paths;
    if (status.startsWith("D") || newMode === "000000") continue;
    if (newMode === "160000") {
      entries.push({ file, sha: null });
      continue;
    }
    if (!newSha || /^0+$/.test(newSha))
      throw new ScanError(`${file}: no staged blob id (status ${status})`);
    entries.push({ file, sha: newSha });
  }
  return entries;
}

/**
 * A ref name as git wrote it: UTF-8 when it is valid UTF-8, else one character per byte (git allows
 * any byte from 0x80 up in a ref name; a replacement character would hide a term).
 * @param {Buffer} b
 */
function refNameText(b) {
  return decodeText(b)?.text ?? b.toString("latin1");
}

/** The branch HEAD names (`refs/heads/…`, unborn too), or null when HEAD is detached. */
function headRef() {
  try {
    const name = refNameText(git(["symbolic-ref", "-q", "HEAD"])).trim();
    return name || null;
  } catch (e) {
    // exit 1: HEAD is not a symbolic ref (detached) — no branch is published by this commit
    if (e !== null && typeof e === "object" && "status" in e && e.status === 1) return null;
    throw e;
  }
}

/**
 * Every ref name in the repository (`git for-each-ref`: branches, tags, remote-tracking refs, notes,
 * the stash) and the branch HEAD names, unborn or not. Ref names hold no line break.
 * @returns {string[]}
 */
function allRefNames() {
  const out = git(["for-each-ref", "--format=%(refname)"], 64 * 1024 * 1024);
  const names = [];
  let at = 0;
  for (let i = out.indexOf(0x0a); i !== -1; i = out.indexOf(0x0a, at)) {
    if (i > at) names.push(refNameText(out.subarray(at, i)));
    at = i + 1;
  }
  if (at < out.length) names.push(refNameText(out.subarray(at)));
  const head = headRef();
  if (head !== null) names.push(head);
  return names;
}

/** The address in a `git var GIT_*_IDENT` line ("Name <addr> 1700000000 +0000"). */
function identEmail(which) {
  const ident = git(["var", which]).toString("utf8");
  const m = /<([^<>]*)>\s+\d+\s+[+-]\d{4}\s*$/.exec(ident.trim());
  return m?.[1] ?? "";
}

// --- the scan -------------------------------------------------------------------------------------

/**
 * Every rule over every reading of a blob's raw bytes (rawDenyViews: latin1, UTF-8 and, when they
 * hold NULs, without them and as UTF-16) — what a reviewed binary still may not carry: a cookie, a
 * SWID, a league id or a mailbox in its metadata, which a person looking at the picture can miss.
 * Reported as `<label> (its bytes):<line>  [<rule>]`, once whichever readings see it.
 * @param {string} label
 * @param {Buffer} buf
 * @returns {string[]}
 */
export function rawRuleFindings(label, buf) {
  const seen = new Set();
  for (const view of rawDenyViews(buf))
    for (const f of scanText(`${label} (its bytes)`, view, [])) seen.add(f);
  return [...seen];
}

/**
 * Scan one blob by what its bytes are (see "what a blob IS" above): text is scanned (a text holding
 * NUL characters — interleaved UTF-16 without a byte-order mark, a stray NUL — is scanned a second
 * time with them removed, so a value spread across NULs is still one value); gzip is peeled and its
 * content scanned the same way; a reviewed binary (its path and the sha256 of these bytes in
 * `reviewed`) passes with every rule and the deny-list over its raw bytes; anything else is refused
 * — an unreviewed opaque binary as `[unreviewed-binary]`, the rest as
 * `[unscannable-archive-or-database]` (fail closed — the deny-list still reads its raw bytes).
 * Findings carry `label`, never a matched value.
 * @param {string} label  the path reported (the published name)
 * @param {Buffer} buf
 * @param {string[]} deny
 * @param {{ name?: string, layers?: number,
 *           reviewed?: readonly { path: string, sha256: string }[] }} [o]  name: the name whose
 *   extension applies (a peeled gzip's inner name); layers: gzip layers already peeled; reviewed:
 *   the reviewed binaries (REVIEWED_BINARIES)
 * @returns {{ findings: string[], scanned: number, reviewed: number }}
 */
export function scanBlob(label, buf, deny, o = {}) {
  const name = o.name ?? label;
  const layers = o.layers ?? 0;
  const reviewedList = o.reviewed ?? REVIEWED_BINARIES;
  /** @type {{ findings: string[], scanned: number, reviewed: number }} */
  const out = { findings: [], scanned: 0, reviewed: 0 };
  const rawDeny = () => {
    if (!deny.length) return;
    // every reading of the raw bytes (rawDenyViews); one finding per line, whichever view saw it
    const lines = new Set();
    for (const view of rawDenyViews(buf)) for (const l of denylistLines(view, deny)) lines.add(l);
    for (const l of [...lines].sort((x, y) => x - y))
      out.findings.push(`deny-list match in ${label}:${String(l)}`);
  };
  /** @param {string} why @param {string} [rule] */
  const refuse = (why, rule = "unscannable-archive-or-database") => {
    out.findings.push(`${label}  [${rule}] (${why})`);
    rawDeny();
    return out;
  };
  const reviewed = isReviewedBinary(label, buf, reviewedList);
  const container = containerKind(buf);
  if (container?.kind === "gzip" || (container === null && GZIP_EXT.test(name))) {
    if (layers >= MAX_GZIP_LAYERS)
      return refuse(`gzip nested ${String(layers + 1)} deep — refused, not peeled`);
    let gz;
    try {
      gz = gzipMembers(buf, MAX_SCAN_BYTES);
    } catch {
      return refuse("gzip could not be decompressed within the scan limit");
    }
    // every byte the blob commits is read: bytes after the last member (gunzip stops at a NUL and
    // drops the rest unread) are refused, never skipped (fail closed)
    if (gz.trailing > 0)
      return refuse(
        `${String(gz.trailing)} byte(s) follow the last gzip member — gunzip never reads them, so they cannot be scanned`,
      );
    // the header's file name, comment and extra field are published in the blob: scanned as text
    gz.members.forEach((m, i) => {
      for (const f of m.fields) {
        const where = `${label} (gzip ${f.kind}${gz.members.length > 1 ? ` of member ${String(i + 1)}` : ""})`;
        const seen = new Set();
        for (const text of headerReadings(f.bytes))
          for (const finding of scanText(where, text, deny))
            if (!seen.has(finding)) {
              seen.add(finding);
              out.findings.push(finding);
            }
      }
    });
    // the deny-list reads the outer bytes too, as it reads any blob no rule decodes
    rawDeny();
    const innerName = name
      .replace(/\.tgz$/i, ".tar")
      .replace(/\.svgz$/i, ".svg")
      .replace(/\.gz$/i, "");
    const inner = scanBlob(label, Buffer.concat(gz.members.map((m) => m.data)), deny, {
      name: innerName,
      layers: layers + 1,
      reviewed: reviewedList,
    });
    out.findings.push(...inner.findings);
    out.scanned += inner.scanned;
    out.reviewed += inner.reviewed;
    return out;
  }
  if (!reviewed) {
    if (container !== null)
      return refuse(
        `its bytes are a ${container.label}, which no rule can read, so it cannot be committed`,
      );
    if (REFUSED_EXT.test(name))
      return refuse("an archive or database cannot be scanned, so it cannot be committed");
  }
  const decoded = decodeText(buf);
  if (decoded !== null) {
    out.scanned++;
    const primary = scanText(label, decoded.text, deny);
    out.findings.push(...primary);
    if (decoded.text.includes("\u0000")) {
      // the same text with its NULs removed: interleaved UTF-16 (no byte-order mark) or UTF-32
      // read as UTF-8, or a value split by NUL bytes — reported only where it adds a finding
      const viewLabel = `${label} (NUL bytes removed)`;
      const seen = new Set(primary.map((f) => f.replace(label, "\u0000")));
      for (const f of scanText(viewLabel, decoded.text.replaceAll("\u0000", ""), deny))
        if (!seen.has(f.replace(viewLabel, "\u0000"))) out.findings.push(f);
    }
    return out;
  }
  if (reviewed) {
    out.reviewed++;
    // a person reviewed exactly these bytes at this path: every rule and the deny-list still read
    // them in every byte reading (metadata a look at the picture can miss)
    out.findings.push(...rawRuleFindings(label, buf));
    rawDeny();
    return out;
  }
  const kind = opaqueKind(name, buf);
  if (kind !== null)
    return refuse(
      `its bytes are a ${kind}: no rule reads its pixels, its compressed chunks or its tables, so a cookie, a league id or a name in it would pass unseen — it is committed only as bytes a person has reviewed (REVIEWED_BINARIES: its path and sha256)`,
      "unreviewed-binary",
    );
  return refuse(
    "its bytes are neither UTF-8 text (nor UTF-16/UTF-32 with a byte-order mark) nor a recognised binary format with its extension — re-save it as UTF-8",
  );
}

/**
 * Whether one match of `rule` is a finding: its own allow-list, and for the generic assignments the
 * placeholder words and the location exemption, may say it is not.
 * @param {Rule} rule
 * @param {RegExpExecArray} m
 */
function matchIsFinding(rule, m) {
  const value = rule.group ? (m[rule.group] ?? "") : m[0];
  if (rule.allow && rule.allow(m)) return false;
  if (
    !rule.strict &&
    ["assigned-secret", "env-secret", "bearer-token"].includes(rule.id) &&
    PLACEHOLDER.test(value)
  )
    return false;
  // a filesystem path or URL named *_TOKEN_STORE / *_SECRET_FILE is a location, not a secret
  if (
    (rule.id === "assigned-secret" || rule.id === "env-secret") &&
    /^(?:~\/|\/|\.\.?\/|\$\{?[A-Z_]|https?:\/\/)/.test(value)
  )
    return false;
  return true;
}

/**
 * The rule ids that fire on one line, once per match (`scan-error:<id>` when a rule cannot evaluate
 * it — fail closed). `strictOnly`: only the strict rules (never suppressed by the allow marker).
 * @param {string} line
 * @param {{ strictOnly?: boolean }} [o]
 * @returns {string[]}
 */
export function lineRuleIds(line, o = {}) {
  const ids = [];
  const allowMarker = line.includes(ALLOW_MARKER);
  for (const rule of RULES) {
    if (!rule.strict && (o.strictOnly || allowMarker)) continue;
    try {
      if (rule.find) {
        rule.find(line).forEach(() => ids.push(rule.id));
        continue;
      }
      const re = /** @type {RegExp} */ (rule.re);
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (m[0] === "") {
          re.lastIndex++;
          continue;
        }
        if (matchIsFinding(rule, m)) ids.push(rule.id);
      }
    } catch {
      ids.push(`scan-error:${rule.id}`);
    }
  }
  return ids;
}

/** Escapes that can match a line break, or that this reader does not resolve (conservative). */
const NEWLINE_ESCAPES = new Set([..."sWDpPnxuc0123456789"]);

/**
 * Whether a pattern can consume a line break, read from its source: an escape that can match one
 * (`\s`, `\W`, `\D`, `\n`, `\p{…}`, a `\x`/`\u`/`\c`/numeric escape — not resolved, so counted), a
 * literal line break, a `.` under the `s` flag, a positive class holding one of those, or a negated
 * class that excludes neither `\s` nor `\n` (`[^"]`, `[^]`). Conservative by construction: what it
 * counts wrongly costs one more pass over the text, never a missed match.
 * @param {RegExp} re
 */
export function canCrossLines(re) {
  const src = re.source;
  const dotAll = re.flags.includes("s");
  let inClass = false;
  let negated = false;
  let excludesNewline = false;
  let mayMatchNewline = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? "";
    if (c === "\\") {
      const e = src[++i] ?? "";
      if (!inClass) {
        if (NEWLINE_ESCAPES.has(e)) return true;
      } else {
        if (e === "s" || e === "n") excludesNewline = true;
        if (NEWLINE_ESCAPES.has(e)) mayMatchNewline = true;
      }
      continue;
    }
    if (inClass) {
      if (c === "]") {
        if (negated ? !excludesNewline : mayMatchNewline) return true;
        inClass = false;
      } else if (c === "\n") {
        excludesNewline = true;
        mayMatchNewline = true;
      }
      continue;
    }
    if (c === "[") {
      inClass = true;
      negated = src[i + 1] === "^";
      if (negated) i++;
      excludesNewline = false;
      mayMatchNewline = false;
    } else if (c === "\n" || (c === "." && dotAll)) return true;
  }
  return inClass;
}

/** The regex rules whose matches can span a line break (canCrossLines), fixed at load. */
const CROSS_LINE_RULES = new Set(
  RULES.filter((r) => !r.find && r.re !== undefined && canCrossLines(r.re)),
);

/** The ids of the rules whose matches can span a line break (for tests and the docs). */
export const CROSS_LINE_RULE_IDS = Object.freeze([...CROSS_LINE_RULES].map((r) => r.id));

/**
 * Every rule over a text, as gitleaks runs its rules over a whole file: each regex rule once over
 * the lines joined with "\n" — so a match that spans line breaks (`\s` and a class like `[^"]`
 * cross them) is found like one inside a line — and each linear finder (`find`) line by line
 * (wrappedRuns joins a value wrapped across lines). A hit is the line of the match's first
 * non-blank character (1-based); one per match, in line order and, on a line, in rule order. A
 * generic rule's hit is dropped when that line carries `scan-secrets: allow`. `strictOnly`: the
 * strict rules only; `crossOnly`: only the matches that span a line break (from the rules that can,
 * canCrossLines). Stage C finding scan-league-envelope-per-line: the rules ran one line at a time,
 * so a league body written one key per line (`JSON.stringify(v, null, 2)`, prettier) —
 * `"gameId": 1,⏎ "id": <id>,⏎ "members"` — or a `"leagueIds": [⏎ <id>` array passed, where
 * gitleaks flagged it after the push.
 * @param {string[]} lines
 * @param {{ strictOnly?: boolean, crossOnly?: boolean }} [o]
 * @returns {{ line: number, id: string }[]}
 */
export function textRuleHits(lines, o = {}) {
  const text = lines.join("\n");
  /** the offset of each line's first character */
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  /** @param {number} off */
  const lineOf = (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  /** @type {{ line: number, id: string, rank: number }[]} */
  const hits = [];
  RULES.forEach((rule, rank) => {
    if (!rule.strict && o.strictOnly) return;
    if (o.crossOnly && !CROSS_LINE_RULES.has(rule)) return;
    try {
      if (rule.find) {
        const find = rule.find;
        lines.forEach((l, i) => {
          if (!rule.strict && l.includes(ALLOW_MARKER)) return;
          for (let k = find(l).length; k > 0; k--) hits.push({ line: i + 1, id: rule.id, rank });
        });
        return;
      }
      const re = /** @type {RegExp} */ (rule.re);
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[0] === "") {
          re.lastIndex++;
          continue;
        }
        const body = m[0].trimStart();
        if (o.crossOnly && !body.includes("\n")) continue;
        const line = lineOf(m.index + (m[0].length - body.length));
        if (!rule.strict && (lines[line - 1] ?? "").includes(ALLOW_MARKER)) continue;
        if (matchIsFinding(rule, m)) hits.push({ line, id: rule.id, rank });
      }
    } catch {
      hits.push({ line: 1, id: `scan-error:${rule.id}`, rank });
    }
  });
  hits.sort((a, b) => a.line - b.line || a.rank - b.rank);
  return hits.map(({ line, id }) => ({ line, id }));
}

/**
 * A line that may carry an encoded identifier: a %XX escape, a \uXXXX escape, a backslash-escaped
 * `\`, `/`, quote or backtick, or an HTML entity.
 */
const ENCODED_HINT =
  /%[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4}|\\[\\/"'\x60]|&(?:#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z]{2,6});/;

/**
 * The rule ids of one line in both of its readings: as written, and — when it carries %XX,
 * \uXXXX, backslash or HTML-entity encodings — with them undone (decodeLayers, the deny-list's
 * decoder), where the strict rules run again and add each rule that fires there only. An
 * identifier in an encoded URL or an escaped body (`…%3FleagueId%3D<id>`, `…%2Fleagues%2F<id>`,
 * double-encoded `%253D`, `{\"leagueId\":<id>}`, `https:\/\/…\/leagues\/<id>`) IS that identifier:
 * one decoder gives every strict rule every encoding (Stage C finding scan-league-id-url-encoded).
 * gitleaks' own decoder is a CLI setting and reads no HTML entity and no escaped quote or slash,
 * so .gitleaks.toml's espn-league-id carries each encoding as an explicit twin, kept within what
 * this decoder undoes.
 * @param {string} line
 * @returns {string[]}
 */
export function lineFindingIds(line) {
  return idsOfReadings(line, decodedLine(line));
}

/**
 * A line's decoded reading (decodeLayers) when it carries an encoding hint, else the line itself.
 * @param {string} line
 */
function decodedLine(line) {
  return ENCODED_HINT.test(line) ? decodeLayers(line) : line;
}

/**
 * The rule ids of a line given its decoded reading: every rule on the line, then each strict rule
 * that fires only on the decoded reading (lineFindingIds).
 * @param {string} line
 * @param {string} decoded
 */
function idsOfReadings(line, decoded) {
  const ids = lineRuleIds(line);
  if (decoded === line) return ids;
  const seen = new Set(ids);
  for (const id of new Set(lineRuleIds(decoded, { strictOnly: true })))
    if (!seen.has(id)) ids.push(id);
  return ids;
}

/**
 * Scan one text. Returns finding labels (`<label>:<line>  [<rule>]`, or the deny-list form) —
 * never a matched value.
 * @param {string} label  file path or pseudo-name (COMMIT_MESSAGE)
 * @param {string} text
 * @param {string[]} deny
 * @returns {string[]}
 */
export function scanText(label, text, deny) {
  const lines = text.split(/\r?\n/);
  /** each line's rule ids, in order: as written, then what only its decoded reading adds */
  /** @type {Map<number, string[]>} */
  const byLine = new Map();
  /** @param {number} line @param {string} id */
  const add = (line, id) => {
    const ids = byLine.get(line);
    if (ids) ids.push(id);
    else byLine.set(line, [id]);
  };
  // every rule over the whole text — matches inside a line and across line breaks alike, as
  // gitleaks finds them (never narrower than it)
  for (const { line, id } of textRuleHits(lines)) add(line, id);
  // each line's decoded reading (lineFindingIds): every strict rule that fires there only
  let decodedAny = false;
  const view = lines.map((l, i) => {
    const d = decodedLine(l);
    if (d === l) return l;
    decodedAny = true;
    const seen = new Set(byLine.get(i + 1));
    for (const id of new Set(lineRuleIds(d, { strictOnly: true })))
      if (!seen.has(id)) add(i + 1, id);
    // an encoded line break is read as a space, so every line keeps its number
    return d.replaceAll("\n", " ");
  });
  // and across line breaks in the decoded reading (`leagueId%3D⏎<id>`: gitleaks' encoded twin)
  if (decodedAny)
    for (const { line, id } of textRuleHits(view, { strictOnly: true, crossOnly: true }))
      if (!byLine.get(line)?.includes(id)) add(line, id);
  const findings = [];
  for (const line of [...byLine.keys()].sort((a, b) => a - b))
    for (const id of byLine.get(line) ?? []) findings.push(`${label}:${String(line)}  [${id}]`);
  // values wrapped across lines or split by concatenation (S3)
  const lineSet = new Set(findings);
  for (const { line, run } of wrappedRuns(lines))
    if (looksLikeBareEspnS2(run)) {
      const f = `${label}:${String(line)}  [espn-s2-bare]`;
      if (!lineSet.has(f)) {
        lineSet.add(f);
        findings.push(f);
      }
    }
  findings.push(...leagueBodyFindings(label, text));
  // a file inside the text: a base64 data: URI's bytes, read as a committed file's would be
  findings.push(...embeddedFindings(label, lines, deny));
  for (const n of denylistLines(text, deny)) findings.push(`deny-list match in ${label}:${n}`);
  return findings;
}

/**
 * The findings of a scanned entry's PATH: a file or directory name is published with its content,
 * so every rule runs over the path in both readings (lineFindingIds: as written and with %XX /
 * \uXXXX / entity encodings undone) and the deny-list checks it. A finding names the entry by its
 * number, never the path (Stage C finding scan-paths-identifier-rules-skipped: a league id, a member
 * GUID or a mailbox in a committed path passed the hooks, commit-paths.sh and CI, where only the
 * deny-list — absent in CI — looked at paths).
 * @param {string} file  the path as published (git's name in --all / --index / --staged)
 * @param {number} n  the entry's 1-based number in this run
 * @param {string[]} deny
 * @returns {string[]}
 */
export function pathFindings(file, n, deny) {
  const where = `the path of scanned entry #${String(n)} (path not printed)`;
  const out = [...new Set(lineFindingIds(file))].map((id) => `${where}  [${id}]`);
  if (denylistLines(file, deny).length) out.push(`deny-list match in ${where}`);
  return out;
}

/**
 * The spellings a ref name is published in: the full name (`refs/heads/x`), the name a branch list,
 * a pull request's head, a run's name and `github.ref_name` show (`x`), and for a remote-tracking
 * ref the remote's own branch name. A name without `refs/` is a branch name, as `git push origin
 * <name>` reads it.
 * @param {string} name
 * @returns {string[]}
 */
export function refSpellings(name) {
  const out = new Set([name]);
  if (!name.startsWith("refs/")) out.add(`refs/heads/${name}`);
  else {
    const rest = name.slice("refs/".length);
    out.add(rest);
    const short = /^(?:heads|tags)\/(.+)$/.exec(rest) ?? /^remotes\/[^/]+\/(.+)$/.exec(rest);
    if (short?.[1]) out.add(short[1]);
  }
  return [...out];
}

/**
 * The findings of a ref NAME: a push publishes it — the branch list, a pull request's head, every
 * Actions run and `github.ref_name` — so every rule runs over each of its spellings (refSpellings)
 * in both readings (lineFindingIds) and the deny-list checks them. A finding names the ref by its
 * number, never the name (Stage C finding scan-ref-names-unscanned: commit-paths.sh pushed a branch
 * named with a league-id shape and a deny-list term, and no guard or CI step read a ref name).
 * @param {string} name  the ref name (`refs/heads/x`, `refs/tags/v1`, or a bare branch name)
 * @param {number} n  the ref's 1-based number in this run
 * @param {string[]} deny
 * @returns {string[]}
 */
export function refFindings(name, n, deny) {
  const where = `the name of ref #${String(n)} (name not printed)`;
  const ids = new Set();
  let denied = false;
  for (const s of refSpellings(name)) {
    for (const id of lineFindingIds(s)) ids.add(id);
    if (denylistLines(s, deny).length) denied = true;
  }
  const out = [...ids].map((id) => `${where}  [${id}]`);
  if (denied) out.push(`deny-list match in ${where}`);
  return out;
}

/**
 * `text` parsed as one JSON object or array (its first non-blank character `{` or `[`), or
 * undefined.
 * @param {string} text
 * @returns {unknown}
 */
function parseJsonValue(text) {
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * The league-body rules over one parsed JSON value: an object at any depth with `gameId` 1, a
 * `seasonId` and a non-zero numeric `id` is a league body (`/seasons/{s}` has no `seasonId`;
 * `leagueHistory` is an array of league bodies), its `id` the league id; a non-zero numeric (or
 * 4+-digit string) `leagueId` / `leagueIds` / `league_id` anywhere is one too.
 * @param {unknown} body
 * @returns {string[]}  rule ids, each once
 */
function leagueBodyIds(body) {
  const ids = new Set();
  const walk = (/** @type {unknown} */ v, depth = 0) => {
    if (ids.size === 2 || depth > 64 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = /** @type {Record<string, unknown>} */ (v);
    if (o.gameId === 1 && "seasonId" in o && typeof o.id === "number" && o.id !== 0)
      ids.add("espn-league-root-id");
    for (const [k, x] of Object.entries(o)) {
      if (/^league[_-]?ids?$/i.test(k)) {
        const vals = Array.isArray(x) ? x : [x];
        if (
          vals.some(
            (n) =>
              (typeof n === "number" && n !== 0) ||
              (typeof n === "string" && /^[1-9]\d{3,}$/.test(n)),
          )
        )
          ids.add("espn-league-id-field");
      }
      walk(x, depth + 1);
    }
  };
  walk(body);
  return [...ids];
}

/**
 * The fenced code blocks of a Markdown text (``` or ~~~, three or more, indented at most three
 * spaces; an unclosed fence runs to the end), each with its first content line (1-based).
 * @param {string[]} lines
 * @returns {{ line: number, body: string }[]}
 */
function fencedBlocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i] ?? "");
    if (!open) continue;
    const fence = open[1] ?? "";
    const close = new RegExp(
      `^ {0,3}${fence[0] === "`" ? "`" : "~"}{${String(fence.length)},}\\s*$`,
    );
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j] ?? "")) j++;
    out.push({ line: i + 2, body: lines.slice(i + 1, j).join("\n") });
    i = j;
  }
  return out;
}

/**
 * A league body wherever a JSON value is written, whatever the writer's key order, indentation and
 * line breaks (S3; Stage C finding scan-league-envelope-per-line — the walk read only
 * fixtures/**\/*.json, so a pretty-printed body under tests/ or docs/ passed): the whole text when
 * it is one JSON value (a .json file or a capture under any name, reported without a line), else
 * every JSON Lines record and every fenced code block that holds one (reported at its line).
 * Unparseable text is not this rule's concern: the line and cross-line rules still ran.
 * @param {string} label
 * @param {string} text
 * @returns {string[]}
 */
export function leagueBodyFindings(label, text) {
  const whole = parseJsonValue(text);
  if (whole !== undefined) return leagueBodyIds(whole).map((id) => `${label}  [${id}]`);
  const out = new Set();
  const lines = text.split(/\r?\n/);
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!/^(?:\{.*\}|\[.*\])$/.test(t)) return;
    const v = parseJsonValue(t);
    if (v !== undefined)
      for (const id of leagueBodyIds(v)) out.add(`${label}:${String(i + 1)}  [${id}]`);
  });
  if (text.includes("```") || text.includes("~~~"))
    for (const { line, body } of fencedBlocks(lines)) {
      const v = parseJsonValue(body);
      if (v !== undefined)
        for (const id of leagueBodyIds(v)) out.add(`${label}:${String(line)}  [${id}]`);
    }
  return [...out];
}

// --- files inside a text: base64 data: URIs ------------------------------------------------------
//
// A text can carry a file the rules cannot read: a base64 `data:` URI (RFC 2397) — a Markdown or
// HTML image, an SVG's `<image href="data:image/png;base64,…">`, a CSS `url(data:font/woff2;…)`.
// Its bytes are judged as a committed file's are (Stage C finding scan-opaque-binaries-unscanned:
// an image's metadata no rule reads must never pass as "clean", committed as a file or embedded):
// text (and gzip) is scanned — every rule, the deny-list, and the data: URIs inside it, a bounded
// number of levels deep; anything else is refused as `[embedded-binary]`, and the deny-list still
// reads its bytes. A payload too short to hold a value any rule names is not refused, but the
// rules and the deny-list read its bytes all the same.

/** A base64 data: URI's head: `data:[<type>/<subtype>][;<parameter>]*;base64,` (any case). */
const DATA_URI_HEAD =
  /\bdata:((?:[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127})?)((?:;[^;,\s"'\x60<>()\\]{0,256}){0,16}?);base64,/gi;
/**
 * A payload run: the base64 alphabet and its URL-safe twin, `%2B` `%2F` `%3D` (a URI inside a URL)
 * and `\/` (a URI inside a JSON string).
 */
const PAYLOAD_RUN = /(?:[A-Za-z0-9+/=_-]|%2[BbFf]|%3[Dd]|\\\/)+/y;
/** What closes the quote or bracket a data: URI is written in (an attribute, a link, `url(…)`). */
const DATA_URI_CLOSER = new Map([
  ['"', '"'],
  ["'", "'"],
  ["\x60", "\x60"],
  ["(", ")"],
]);
/**
 * The fewest bytes of a non-text payload that are refused: fewer hold no value a rule names, even
 * deflated (a GUID is 36 characters, an espn_s2 value 40, a league id needs `leagueId=` before its
 * digits) — so a hostile-input test's `data:image/png;base64,iVBORw0KGgo=` (a bare PNG signature)
 * can be committed, while the smallest real image (67 bytes) cannot.
 */
export const EMBED_MIN_BYTES = 16;
/** data: URIs decoded inside decoded data: URIs (an SVG in a data: URI holding a PNG is 2). */
export const MAX_EMBED_DEPTH = 3;
/** How deep the scan of a data: URI's bytes is now (scanText → scanBlob → scanText …). */
let embedDepth = 0;

/** A payload run's bytes. @param {string} run */
function payloadBytes(run) {
  // Node's base64 decoder reads the URL-safe alphabet too, and skips nothing else in a run
  return Buffer.from(
    run.replace(/%2B/gi, "+").replace(/%2F/gi, "/").replace(/%3D/gi, "=").replaceAll("\\/", "/"),
    "base64",
  );
}

/**
 * Every base64 data: URI in `lines`: the line it starts on (1-based), its media type (lower case,
 * "" when none) and its payload's bytes. A payload runs to the first character outside the base64
 * alphabet. One written inside a quote or a bracket that its line leaves open — an SVG or HTML
 * attribute an editor wraps at 64–76 columns, a CSS `url(` — goes on through the lines below that
 * hold only payload, and the line that closes the quote or bracket; padding (`=`) ends it. A bare
 * URI is one line: the prose after it is never read as its payload.
 * @param {string[]} lines
 * @returns {{ line: number, type: string, bytes: Buffer }[]}
 */
export function dataUriPayloads(lines) {
  /** @type {{ line: number, type: string, bytes: Buffer }[]} */
  const out = [];
  const head = new RegExp(DATA_URI_HEAD.source, DATA_URI_HEAD.flags);
  const run = new RegExp(PAYLOAD_RUN.source, PAYLOAD_RUN.flags);
  /** @param {string} s @param {number} at */
  const runAt = (s, at) => {
    run.lastIndex = at;
    return run.exec(s)?.[0] ?? "";
  };
  lines.forEach((line, i) => {
    if (!/data:/i.test(line)) return;
    head.lastIndex = 0;
    for (let m = head.exec(line); m !== null; m = head.exec(line)) {
      const at = m.index + m[0].length;
      const first = runAt(line, at);
      const parts = [first];
      const closer = DATA_URI_CLOSER.get(line[m.index - 1] ?? "");
      let chunk = first;
      let rest = line.slice(at + first.length);
      if (closer !== undefined)
        for (let j = i + 1; j < lines.length; j++) {
          if (chunk.endsWith("=") || !/^\s*$/.test(rest)) break;
          const next = lines[j] ?? "";
          const lead = next.length - next.trimStart().length;
          chunk = runAt(next, lead);
          rest = next.slice(lead + chunk.length);
          if (!chunk || !(/^\s*$/.test(rest) || rest.startsWith(closer))) break;
          parts.push(chunk);
        }
      out.push({
        line: i + 1,
        type: (m[1] ?? "").toLowerCase(),
        bytes: payloadBytes(parts.join("")),
      });
      head.lastIndex = Math.max(head.lastIndex, at + first.length);
    }
  });
  return out;
}

/**
 * The findings of the files a text carries in base64 data: URIs (see above). A finding names the
 * text and the line the URI starts on — `<label>:<line> (data: URI)` — never a byte of it.
 * @param {string} label
 * @param {string[]} lines
 * @param {string[]} deny
 * @returns {string[]}
 */
export function embeddedFindings(label, lines, deny) {
  const payloads = dataUriPayloads(lines).filter((p) => p.bytes.length > 0);
  if (!payloads.length) return [];
  if (embedDepth >= MAX_EMBED_DEPTH)
    return [
      `${label}  [embedded-binary] (data: URIs nested more than ${String(MAX_EMBED_DEPTH)} deep inside one another — refused, not decoded)`,
    ];
  /** @type {string[]} */
  const out = [];
  for (const p of payloads) {
    const where = `${label}:${String(p.line)} (data: URI)`;
    const gzip = containerKind(p.bytes)?.kind === "gzip";
    if (gzip || decodeText(p.bytes) !== null) {
      // text, or gzip to peel: scanned as a committed file of that kind is
      embedDepth++;
      try {
        const name = gzip ? "embedded.gz" : "embedded.txt";
        out.push(...scanBlob(where, p.bytes, deny, { name, reviewed: [] }).findings);
      } finally {
        embedDepth--;
      }
      continue;
    }
    if (p.bytes.length >= EMBED_MIN_BYTES) {
      const kind =
        containerKind(p.bytes)?.label ??
        OPAQUE_FORMATS.find((f) => f.test(p.bytes))?.label ??
        "binary blob no reader recognises";
      out.push(
        `${where}  [embedded-binary] (its bytes are a ${kind}: no rule reads them, so a cookie, a league id or a name in them would pass unseen — a text carries no binary; one committed as a file of its own passes only as bytes a person has reviewed, REVIEWED_BINARIES)`,
      );
    } else {
      // too short to refuse: every rule still reads its bytes, in every reading
      embedDepth++;
      try {
        out.push(...rawRuleFindings(where, p.bytes));
      } finally {
        embedDepth--;
      }
    }
    // the deny-list reads the bytes in every reading, as it reads any blob no rule decodes
    if (deny.length) {
      const seen = new Set();
      for (const view of rawDenyViews(p.bytes))
        for (const l of denylistLines(view, deny)) seen.add(l);
      for (const l of [...seen].sort((a, b) => a - b))
        out.push(`deny-list match in ${where}:${String(l)}`);
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  let staged = false;
  let all = false;
  let index = false;
  let identity = false;
  /** @type {string | null} */
  let message = null;
  const files = [];
  /** @type {string[]} */
  const refArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--staged") staged = true;
    else if (a === "--all") all = true;
    else if (a === "--index") index = true;
    else if (a === "--identity") identity = true;
    else if (a === "--message") {
      const v = args[++i];
      if (v === undefined) return fail(new Error("--message needs a file"));
      message = v;
    } else if (a === "--ref") {
      const v = args[++i];
      if (v === undefined || v === "") return fail(new Error("--ref needs a ref name"));
      refArgs.push(v);
    } else if (a === "--") {
      files.push(...args.slice(i + 1));
      break;
    } else if (a.startsWith("--")) return fail(new Error(`unknown option ${a}`));
    else files.push(a);
  }

  /** @type {{file: string, read: () => Buffer | null, message?: true}[]} */
  const targets = [];
  /** the ref names a push publishes: scanned like paths, never printed */
  /** @type {string[]} */
  const refs = [];
  /** @param {string} r */
  const addRef = (r) => {
    if (!refs.includes(r)) refs.push(r);
  };
  let deny;
  try {
    deny = loadDenylist();
    if (identity) {
      for (const which of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
        if (!isGithubNoreply(identEmail(which))) {
          process.stderr.write(
            `scan-secrets: commit identity refused — the ${which === "GIT_AUTHOR_IDENT" ? "author" : "committer"} address is not a GitHub no-reply address (address not printed).\n` +
              "  Set one for this clone:  git config user.email '<id>+<login>@users.noreply.github.com'\n",
          );
          process.exit(1);
        }
      }
    }
    if (all) {
      for (const f of git(["ls-files", "-z"], 64 * 1024 * 1024)
        .toString("utf8")
        .split("\0")
        .filter(Boolean)) {
        targets.push({ file: f, read: () => readWorktree(f) });
      }
      // every ref a push publishes or has published: in CI's full-depth checkout, every branch and
      // tag of the remote (Stage C finding scan-ref-names-unscanned)
      for (const r of allRefNames()) addRef(r);
    }
    if (index) {
      for (const { file, sha } of indexEntries())
        targets.push({ file, read: () => (sha === null ? null : readBlob(sha, file)) });
      // the commit is published under the branch it lands on
      const head = headRef();
      if (head !== null) addRef(head);
    }
    for (const f of files) {
      const n = targets.length + 1;
      targets.push({ file: f, read: () => (staged ? readStaged(f) : readNamed(f, n)) });
    }
    for (const r of refArgs) addRef(r);
    if (message !== null) {
      const msgPath = message;
      targets.push({ file: "COMMIT_MESSAGE", read: () => readFileSync(msgPath), message: true });
    }
  } catch (e) {
    return fail(e);
  }
  if (!targets.length && !refs.length && !index && !identity) {
    process.stderr.write(
      "scan-secrets: no files given (use --all, --index, --message, --ref or pass paths)\n",
    );
    process.exit(2);
  }

  const findings = [];
  refs.forEach((r, i) => findings.push(...refFindings(r, i + 1, deny)));
  let scanned = 0;
  let reviewed = 0;
  targets.forEach(({ file, read, message: isMessage }, n) => {
    // a path is published too: every rule and the deny-list run over it (reported without the path)
    if (!isMessage) findings.push(...pathFindings(file, n + 1, deny));
    let buf;
    try {
      buf = read();
    } catch (e) {
      fail(
        e instanceof ScanError
          ? e
          : new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    if (!buf) return;
    const r = scanBlob(file, buf, deny);
    findings.push(...r.findings);
    scanned += r.scanned;
    reviewed += r.reviewed;
  });

  if (findings.length) {
    process.stderr.write(
      `scan-secrets: ${String(findings.length)} finding(s) — NOTHING may be committed until each is removed:\n`,
    );
    for (const f of findings) process.stderr.write(`  ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `scan-secrets: clean (${String(scanned)} text file(s) scanned${reviewed ? `, ${String(reviewed)} reviewed binary file(s)` : ""}${refs.length ? `, ${String(refs.length)} ref name(s)` : ""}${identity ? ", commit identity ok" : ""}${deny.length ? ", local deny-list active" : ""})\n`,
  );
}

/** @param {unknown} e */
function fail(e) {
  process.stderr.write(`scan-secrets: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
