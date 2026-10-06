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
// message — also when a line break or zero-width character splits it. A match prints ONLY
// "deny-list match in <file>:<line>"; the term and the file's contents are never printed. Absent
// file = no deny-list (CI has none). The file lives outside the repo: it holds the very strings
// that must never enter it.

import { existsSync, lstatSync, readFileSync, readlinkSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
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
 * URL-encoded — research 03 §C.1), mixed-case with digits, and high-entropy.
 */
export function looksLikeBareEspnS2(run) {
  if (run.length < 100) return false;
  const escapes = (run.match(/%[0-9A-Fa-f]{2}/g) ?? []).length;
  if (!(run.startsWith("AE") || escapes >= 2)) return false;
  if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/\d/.test(run)) return false;
  return entropy(run) >= 4.0;
}

/** The espn_s2 cookie alphabet as a lookup table (ASCII only). */
const COOKIE_CHAR = (() => {
  const t = new Uint8Array(128);
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%+/=")
    t[c.charCodeAt(0)] = 1;
  return t;
})();

/**
 * Every maximal run of ≥ 100 cookie-alphabet characters in `line`, in one linear pass.
 * @param {string} line
 * @returns {string[]}
 */
export function bareRuns(line) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= line.length; i++) {
    const code = i < line.length ? line.charCodeAt(i) : 0;
    if (code < 128 && COOKIE_CHAR[code] === 1) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= 100) out.push(line.slice(start, i));
      start = -1;
    }
  }
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
    // league ids are identifiers (HANDOFF): leagueId=, league_id:, ESPN_LEAGUE_ID=,
    // EFF_PROBE_LEAGUE_ID=, …/leagues/<id>, …/leagueHistory/<id> — 4+ digits, all-zero allowed
    id: "espn-league-id",
    re: /(?:league[_-]?id["'\x60]?\s*[:=]\s*["'\x60]?|\bleagues\/|\bleagueHistory\/)(\d{4,})/gi,
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
    re: /(?:\/(?:Users|home)\/|\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))(<[^<>\s]{0,64}>|\$\{[A-Za-z_]\w{0,64}\}|[^/\\\s"'\x60<>()[\]{},;:|*?]{1,256})/gi,
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
    // or URL userinfo (https://user:pw@host — the authority of a scheme:// URL)
    allow: (m) =>
      isPlaceholderEmail(m[0]) ||
      /^git@/i.test(m[0]) ||
      /\/\/[^/\s@]*$/.test(m.input.slice(0, m.index)),
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
  /\.(?:png|jpe?g|gif|webp|ico|icns|bmp|tiff?|avif|heic|pdf|parquet|arrow|feather|sqlite3?|db|gz|tgz|zip|bz2|xz|zst|7z|jar|woff2?|ttf|otf|eot|wasm|mp3|mp4|m4a|mov|wav|ogg|webm|docx|xlsx|pptx|node|dylib|so|o|a|class|bin)$/i;

/** The largest file it reads; anything larger is an error, never skipped. */
const MAX_SCAN_BYTES = (() => {
  const n = Number(process.env.EFF_SCAN_MAX_BYTES);
  return Number.isSafeInteger(n) && n > 0 ? n : 64 * 1024 * 1024;
})();

class ScanError extends Error {}

// --- deny-list ------------------------------------------------------------------------------------

/** Zero-width and invisible characters an identifier could hide behind. */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/** NFKC, case-folded, curly quotes straightened, invisible characters removed. */
export function normalise(s) {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(INVISIBLE, "");
}

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
  const has = (/** @type {string} */ s) => {
    const t = s.replace(/\s+/g, " ");
    return deny.some((d) => t.includes(d));
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
  for (const n of denylistLines(text, deny)) findings.push(`deny-list match in ${label}:${n}`);
  return findings;
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
