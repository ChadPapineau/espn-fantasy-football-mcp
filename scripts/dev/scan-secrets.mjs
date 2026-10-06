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
//   node scripts/dev/scan-secrets.mjs [--staged] [--all] [--index] [--identity] [--message <file>] [--] <file>...
//     --staged          scan the STAGED (index) blob of each given file; a path that is not in the
//                       index, or that cannot be read, is an error (exit 2) — never "clean"
//     --all             scan every tracked file (git ls-files), as it is in the working tree
//     --index           scan every blob the next commit adds or changes (index vs HEAD, any status
//                       but D — type changes included — read by object id, so no name is re-quoted)
//     --identity        refuse an author or committer address that is not a GitHub no-reply address
//                       (<id>+<login>@users.noreply.github.com); the address itself is never printed
//     --message <file>  scan a commit message (it is published with the commit)
// Exit: 0 clean · 1 findings · 2 usage/IO error, or content it cannot scan (it fails closed: a file
// too large to read is an error, and a NUL byte only skips a file whose name is a binary format).
//
// Suppression: a line containing `scan-secrets: allow` skips the GENERIC rules on that line only.
// It never suppresses the ESPN credential rules, a private key, or the deny-list (gitleaks in CI
// does not honour the marker either).
//
// Local deny-list (personal identifiers): if $EFF_SCAN_DENYLIST names a readable file, else if
// ~/.local/share/espn-fantasy-football-mcp-dev/scan-denylist.txt exists, every non-comment line is
// a case-insensitive literal that must not appear in any scanned content, file path or commit
// message — also when a line break or zero-width character splits it, when it is %XX-, \uXXXX- or
// HTML-entity-encoded, and (for terms of ≥ 6 letters/digits) when punctuation, emoji or symbols
// separate its words (`gridiron.gang`). List distinctive location/nickname parts and team
// abbreviations as separate lines: a name stored as separate fields never forms the joined term. A match prints ONLY
// "deny-list match in <file>:<line>"; the term and the file's contents are never printed. Absent
// file = no deny-list (CI has none). The file lives outside the repo: it holds the very strings
// that must never enter it.

import { existsSync, lstatSync, readFileSync, readlinkSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    // league ids are identifiers (HANDOFF): leagueId=, league_id:, league id: N, "leagueIds": [N],
    // a markdown cell `| league id | N |`, ESPN_LEAGUE_ID=, EFF_PROBE_LEAGUE_ID=, --league N,
    // --league-id=N, …/leagues/<id>, …/leagueHistory/<id> — 4+ digits, all-zero allowed
    id: "espn-league-id",
    re: /(?:league[ _-]?ids?["'\x60]?\s*[:=|]?\s*\[?\s*["'\x60]?|--league(?:-id)?[ =]["'\x60]?|\bleagues\/|\bleagueHistory\/)(\d{4,})/gi,
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
    // /Users/<name>, /home/<name>, C:\Users\<name> (JSON-escaped too); placeholders are exempt
    id: "home-path",
    re: /(?:(?:\/|\\\/|%2F)(?:Users|home)(?:\/|\\\/|%2F)|\b[A-Za-z]:(?:\\{1,2}|\/|%5C|%2F)Users(?:\\{1,2}|\/|%5C|%2F))(<[^<>\s]{0,64}>|\$\{[A-Za-z_]\w{0,64}\}|[^/\\\s"'\x60<>()[\]{},;:|*?%]{1,256})/gi,
    group: 1,
    strict: true,
    allow: (m) => isPlaceholderName(m[1] ?? ""),
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
      /[a-z][a-z0-9+.-]*:\/\/[^/\s@:]*:$/i.test(m.input.slice(0, m.index)),
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
    id: "env-secret",
    re: /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY)[A-Z0-9_]*\s*=\s*([^\s#'"]{12,})/gm,
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

/** A NUL byte skips a file only when its name is one of these binary formats. */
const BINARY_EXT =
  /\.(?:png|jpe?g|gif|webp|ico|icns|bmp|tiff?|avif|heic|pdf|jar|woff2?|ttf|otf|eot|wasm|mp3|mp4|m4a|mov|wav|ogg|webm|docx|xlsx|pptx|node|dylib|so|o|a|class|bin)$/i;
/**
 * Archives and databases that no rule can read (S5: a compressed raw capture or a store dump
 * would skip every identifier rule): refused outright — fail closed — unless the path is on the
 * reviewed allow-list below (empty today). gzip (`.gz`, `.tgz`) is decompressed and scanned instead.
 */
export const REFUSED_EXT =
  /\.(?:zip|7z|xz|zst|zstd|bz2|lz4|lzma|rar|tar|sqlite|sqlite3|db|db3|parquet|arrow|feather|ipc|duckdb)$/i;
export const GZIP_EXT = /\.(?:gz|tgz)$/i;
/** Reviewed binary paths that may be committed despite REFUSED_EXT (none). */
export const REVIEWED_BINARY_ALLOWLIST = Object.freeze(new Set([]));

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
 * Undoes the encodings a name takes in captured text (S4), a bounded number of layers: %XX
 * (UTF-8 runs), \uXXXX (JSON's default for non-ASCII), and HTML entities (`&#39;`, `&#x27;`,
 * `&amp;`). Anything that does not decode is left as it is.
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
      .replace(/\\u([0-9A-Fa-f]{4})/g, (_m, h) => String.fromCharCode(Number.parseInt(h, 16)))
      .replace(/&#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}));/g, (m, hex, dec) => {
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
  const skels = [...new Set(deny.map((d) => skeleton(d)).filter((k) => k.length >= SKELETON_MIN))];
  const has = (/** @type {string} */ s) => {
    const t = s.replace(/\s+/g, " ");
    if (deny.some((d) => t.includes(d))) return true;
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

function isSymlink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Every blob the next commit adds or changes: `git diff --cached --raw -z --no-renames` (index vs
 * HEAD, or vs the empty tree before the first commit). NUL-separated, so no name is quoted; every
 * status except D is kept; blobs are read by object id.
 * @returns {{file: string, sha: string}[]}
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
    if (status.startsWith("D") || newMode === "000000" || newMode === "160000") continue;
    if (!newSha || /^0+$/.test(newSha))
      throw new ScanError(`${file}: no staged blob id (status ${status})`);
    entries.push({ file, sha: newSha });
  }
  return entries;
}

/** The address in a `git var GIT_*_IDENT` line ("Name <addr> 1700000000 +0000"). */
function identEmail(which) {
  const ident = git(["var", which]).toString("utf8");
  const m = /<([^<>]*)>\s+\d+\s+[+-]\d{4}\s*$/.exec(ident.trim());
  return m?.[1] ?? "";
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// --- the scan -------------------------------------------------------------------------------------

/**
 * Scan one text. Returns finding labels (`<label>:<line>  [<rule>]`, or the deny-list form) —
 * never a matched value.
 * @param {string} label  file path or pseudo-name (COMMIT_MESSAGE)
 * @param {string} text
 * @param {string[]} deny
 * @returns {string[]}
 */
export function scanText(label, text, deny) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const allowMarker = line.includes("scan-secrets: allow");
    for (const rule of RULES) {
      if (allowMarker && !rule.strict) continue;
      try {
        if (rule.find) {
          rule.find(line).forEach(() => findings.push(`${label}:${idx + 1}  [${rule.id}]`));
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
          const value = rule.group ? (m[rule.group] ?? "") : m[0];
          if (rule.allow && rule.allow(m)) continue;
          if (
            !rule.strict &&
            ["assigned-secret", "env-secret", "bearer-token"].includes(rule.id) &&
            PLACEHOLDER.test(value)
          )
            continue;
          // a filesystem path or URL named *_TOKEN_STORE / *_SECRET_FILE is a location, not a secret
          if (
            (rule.id === "assigned-secret" || rule.id === "env-secret") &&
            /^(?:~\/|\/|\.\.?\/|\$\{?[A-Z_]|https?:\/\/)/.test(value)
          )
            continue;
          findings.push(`${label}:${idx + 1}  [${rule.id}]`);
        }
      } catch {
        // a rule that cannot evaluate a line is a finding, never "clean" (fail closed)
        findings.push(`${label}:${idx + 1}  [scan-error:${rule.id}]`);
      }
    }
  });
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
  findings.push(...fixtureLeagueIdFindings(label, text));
  for (const n of denylistLines(text, deny)) findings.push(`deny-list match in ${label}:${n}`);
  return findings;
}

/**
 * A recorded ESPN body under fixtures/ parsed as JSON (S3): a non-zero root `id` of a league body
 * (`gameId` 1 with a `seasonId` — a season body has none) or a non-zero numeric `leagueId` anywhere
 * is the real league id — whatever the key
 * order or whitespace. Unparseable JSON is not this rule's concern (the line rules still ran).
 * @param {string} label
 * @param {string} text
 * @returns {string[]}
 */
export function fixtureLeagueIdFindings(label, text) {
  if (!/(?:^|\/)fixtures\/.+\.json$/.test(label)) return [];
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  if (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    body.gameId === 1 &&
    "seasonId" in body &&
    typeof body.id === "number" &&
    body.id !== 0
  )
    out.push(`${label}  [espn-league-root-id]`);
  let flagged = false;
  const walk = (/** @type {unknown} */ v, depth = 0) => {
    if (flagged || depth > 64 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (/^league[_-]?ids?$/i.test(k)) {
        const vals = Array.isArray(x) ? x : [x];
        if (
          vals.some(
            (n) =>
              (typeof n === "number" && n !== 0) ||
              (typeof n === "string" && /^[1-9]\d{3,}$/.test(n)),
          )
        ) {
          out.push(`${label}  [espn-league-id-field]`);
          flagged = true;
          return;
        }
      }
      walk(x, depth + 1);
    }
  };
  walk(body);
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
    } else if (a === "--") {
      files.push(...args.slice(i + 1));
      break;
    } else if (a.startsWith("--")) return fail(new Error(`unknown option ${a}`));
    else files.push(a);
  }

  /** @type {{file: string, read: () => Buffer | null}[]} */
  const targets = [];
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
    }
    if (index)
      for (const { file, sha } of indexEntries())
        targets.push({ file, read: () => readBlob(sha, file) });
    for (const f of files)
      targets.push({ file: f, read: () => (staged ? readStaged(f) : readWorktree(f)) });
    if (message !== null) {
      const msgPath = message;
      targets.push({ file: "COMMIT_MESSAGE", read: () => readFileSync(msgPath) });
    }
  } catch (e) {
    return fail(e);
  }
  if (!targets.length && !index && !identity) {
    process.stderr.write(
      "scan-secrets: no files given (use --all, --index, --message or pass paths)\n",
    );
    process.exit(2);
  }

  const findings = [];
  let scanned = 0;
  let binary = 0;
  targets.forEach(({ file, read }, n) => {
    // a path is published too: it must not carry a personal identifier (reported without the path)
    if (file !== "COMMIT_MESSAGE" && denylistLines(file, deny).length) {
      findings.push(
        `deny-list match in the path of scanned entry #${String(n + 1)} (path not printed)`,
      );
    }
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
    if (REFUSED_EXT.test(file) && !REVIEWED_BINARY_ALLOWLIST.has(file)) {
      findings.push(
        `${file}  [unscannable-archive-or-database] (an archive or database cannot be scanned, so it cannot be committed)`,
      );
      return;
    }
    if (GZIP_EXT.test(file)) {
      try {
        buf = gunzipSync(buf, { maxOutputLength: MAX_SCAN_BYTES });
      } catch {
        findings.push(
          `${file}  [unscannable-archive-or-database] (gzip could not be decompressed within the scan limit)`,
        );
        return;
      }
    }
    if (isBinary(buf) && BINARY_EXT.test(file)) {
      binary++;
      // a binary file is not regex-scanned, but the deny-list still applies to its bytes as latin1
      for (const l of denylistLines(buf.toString("latin1"), deny))
        findings.push(`deny-list match in ${file}:${String(l)}`);
      return;
    }
    scanned++;
    findings.push(...scanText(file, buf.toString("utf8"), deny));
  });

  if (findings.length) {
    process.stderr.write(
      `scan-secrets: ${String(findings.length)} finding(s) — NOTHING may be committed until each is removed:\n`,
    );
    for (const f of findings) process.stderr.write(`  ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `scan-secrets: clean (${String(scanned)} text file(s) scanned${binary ? `, ${String(binary)} binary file(s) skipped` : ""}${identity ? ", commit identity ok" : ""}${deny.length ? ", local deny-list active" : ""})\n`,
  );
}

/** @param {unknown} e */
function fail(e) {
  process.stderr.write(`scan-secrets: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
