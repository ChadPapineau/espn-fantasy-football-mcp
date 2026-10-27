// @ts-check
// secret-fixtures.mjs — GENERATED self-test fixtures for both secret scanners (plan 04 §4.3 rules;
// plan 10 §3.0 Z1: a brace-GUID outside the fake range, a seven-digit leagueId= value and a
// 100-character espn_s2= value must fail `secrets` and `identifiers`). Adapted from the sibling's
// committed scripts/gitleaks-selftest/ (@d72e03b): here every fake value is DERIVED at run time from
// a public phrase, so no flaggable literal is ever committed and neither gitleaks nor
// scan-secrets.mjs needs a path exclusion. Node built-ins only.
//
// Usage:
//   node scripts/ci/secret-fixtures.mjs write <dir>
//       writes <dir>/must-flag.txt and <dir>/must-pass.txt (outside the repo, e.g. $RUNNER_TEMP)
//   node scripts/ci/secret-fixtures.mjs assert-gitleaks <report.json> --expect-all|--expect-none
//       --expect-all: every must-flag line is reported, on its own line (StartLine), by each
//       .gitleaks.toml rule it names — so every id in GITLEAKS_RULE_IDS fires, and a rule that fires
//       on one line can never stand in for a line it misses; --expect-none: no finding.
//       A missing report counts as zero findings. Prints RuleID/File/StartLine/Commit only — never a
//       value. secret-scan.yml also uses it to report the history and tree scans' findings.
//   node scripts/ci/secret-fixtures.mjs assert-scan
//       runs scripts/dev/scan-secrets.mjs on fresh copies (temp dir): every must-flag line must be
//       reported with each of its expected rule ids, and must-pass must be clean.
// Exit: 0 assertion holds · 1 assertion fails · 2 usage/IO error
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT, isMain } from "./_lib.mjs";

const PHRASE = "espn-fantasy-football-mcp secret-scan self-test (every value here is fake)";

/** @param {string} label */
const digest = (label) => createHash("sha512").update(`${PHRASE}: ${label}`).digest();

/**
 * A fake espn_s2-shaped value: `AE` + URL-encoded base64 of hashes, at least `len` characters, with
 * a `%2F` and a `%2B` escape guaranteed (the shape DevTools shows — research 03 §C.1).
 * @param {string} label
 * @param {number} len
 */
export function fakeEspnS2(label, len) {
  let body = "";
  for (let i = 0; body.length < len + 40; i++)
    body += encodeURIComponent(digest(`${label}#${String(i)}`).toString("base64"));
  const clean = body.replace(/%[0-9A-F]{2}/g, "");
  const s = `AE${clean.slice(0, 30)}%2F${clean.slice(30, 60)}%2B${clean.slice(60)}`;
  return s.slice(0, Math.max(len, 66));
}

/**
 * A fake GUID outside the fixture pseudonym range.
 * @param {string} label
 */
export function fakeGuid(label) {
  const x = digest(label).toString("hex").toUpperCase();
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-A${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

/**
 * A fake league id of exactly `n` digits (first digit non-zero).
 * @param {string} label
 * @param {number} n
 */
export function fakeLeagueId(label, n) {
  const digits = BigInt(`0x${digest(label).toString("hex")}`)
    .toString()
    .replace(/^0+/, "");
  return `${String((Number(digits[0]) % 9) + 1)}${digits.slice(1, n)}`;
}

/**
 * A fake IPv4 address, never 0.0.0.0 or 127.0.0.1.
 * @param {string} label
 */
export function fakeIpv4(label) {
  const b = digest(label);
  return [11 + ((b[0] ?? 0) % 200), b[1] ?? 1, b[2] ?? 2, 1 + ((b[3] ?? 0) % 254)].join(".");
}

/**
 * @typedef {{ line: string, gitleaks: string[], scan: string[] }} FlagCase
 * gitleaks: ids of .gitleaks.toml rules that must fire on the line (empty: a scan-secrets-only rule)
 * scan: ids of scan-secrets.mjs rules that must report the line
 */

/** @returns {FlagCase[]} */
export function mustFlag() {
  const at = (/** @type {string} */ l, /** @type {string} */ d) => `${l}@${d}`;
  const join = (/** @type {string[]} */ ...p) => p.join("");
  return [
    {
      line: join("espn_s2=", fakeEspnS2("cookie-100", 120)),
      gitleaks: ["espn-s2-cookie", "espn-s2-value-bare", "espn-s2-percent-encoded"],
      scan: ["espn-s2-cookie"],
    },
    {
      line: fakeEspnS2("bare", 150),
      gitleaks: ["espn-s2-value-bare", "espn-s2-percent-encoded"],
      scan: ["espn-s2-bare"],
    },
    {
      line: join('{"espn_s2": "', fakeEspnS2("truncated-paste", 80), '"}'),
      gitleaks: ["espn-s2-cookie"],
      scan: ["espn-s2-cookie"],
    },
    {
      line: join("SWID={", fakeGuid("swid"), "}"),
      gitleaks: ["espn-swid", "brace-guid"],
      scan: ["espn-swid", "brace-guid"],
    },
    {
      line: join('"primaryOwner": "{', fakeGuid("member"), '}"'),
      gitleaks: ["brace-guid"],
      scan: ["brace-guid"],
    },
    {
      line: join("swid=%7B", fakeGuid("encoded"), "%7D"),
      gitleaks: ["espn-swid", "brace-guid"],
      scan: ["espn-swid", "brace-guid"],
    },
    {
      line: join(
        "https://fantasy.espn.com/football/league?",
        "leagueId=",
        fakeLeagueId("seven", 7),
      ),
      gitleaks: ["espn-league-id"],
      scan: ["espn-league-id"],
    },
    {
      line: join("ESPN_LEAGUE_ID=", fakeLeagueId("env", 8)),
      gitleaks: ["espn-league-id"],
      scan: ["espn-league-id"],
    },
    {
      line: join(
        "/apis/v3/games/ffl/seasons/2026/segments/0/",
        "leagues/",
        fakeLeagueId("path", 6),
        "?view=mSettings",
      ),
      gitleaks: ["espn-league-id"],
      scan: ["espn-league-id"],
    },
    {
      line: join("EFF_PROBE_LEAGUE_ID=", fakeLeagueId("probe", 9)),
      gitleaks: ["espn-league-id"],
      scan: ["espn-league-id"],
    },
    {
      line: join(
        "/apis/v3/games/ffl/",
        "leagueHistory/",
        fakeLeagueId("history", 7),
        "?seasonId=2019",
      ),
      gitleaks: ["espn-league-id"],
      scan: ["espn-league-id"],
    },
    // league ids in encoded URLs and escaped bodies (Stage C finding scan-league-id-url-encoded):
    // scan-secrets reads them through its decoded view, gitleaks through espn-league-id's encoded
    // twin. The twin does not lean on gitleaks' own decoder (--max-decode-depth, a CLI default): the
    // redirect that also carries a non-ASCII escape (the decoder drops that whole segment), the HTML
    // entities and the backslash escapes are lines it never decodes — each is checked on its own line
    ...encodedLeagueIdCases(join),
    {
      line: join("Cookie: espn_s2=", fakeEspnS2("header", 24), "; SWID={", fakeGuid("header"), "}"),
      gitleaks: ["cookie-header", "espn-swid", "brace-guid"],
      scan: ["cookie-header", "espn-swid", "brace-guid"],
    },
    {
      line: join('"', "client", 'Address": "', fakeIpv4("client"), '"'),
      gitleaks: ["client-address"],
      scan: ["client-address", "ipv4-literal"],
    },
    {
      line: join("ODDS_API_KEY=", digest("odds").toString("hex").slice(0, 32)),
      gitleaks: ["odds-api-key"],
      scan: ["odds-api-key"],
    },
    { line: join("server at ", fakeIpv4("server"), ":8080"), gitleaks: [], scan: ["ipv4-literal"] },
    {
      line: join("/Users/", "probe-user", "/src/espn-fantasy-football-mcp/dist/cli.js"),
      gitleaks: [],
      scan: ["home-path"],
    },
    { line: join("/home/", "probe-user", "/.config"), gitleaks: [], scan: ["home-path"] },
    { line: join("C:\\Users\\", "probe-user", "\\AppData"), gitleaks: [], scan: ["home-path"] },
    {
      line: join("contact: ", at("jane.doe", "acme-corp.io")),
      gitleaks: [],
      scan: ["email-address"],
    },
    // --- S3: the leak shapes a critic built that both scanners used to miss -----------------
    {
      line: join(
        '{"draftDetail":{},"gameId":1,"id":',
        fakeLeagueId("envelope", 8),
        ',"members":[]}',
      ),
      gitleaks: ["espn-league-envelope"],
      scan: ["espn-league-envelope"],
    },
    {
      line: join("league id: ", fakeLeagueId("spaced", 8)),
      gitleaks: ["espn-league-id"],
      scan: ["espn-league-id"],
    },
    {
      line: join('"leagueIds": [', fakeLeagueId("array", 7), "]"),
      gitleaks: ["espn-league-id"],
      scan: ["espn-league-id"],
    },
    {
      line: join("| league id | ", fakeLeagueId("table", 9), " |"),
      gitleaks: ["espn-league-id"],
      scan: ["espn-league-id"],
    },
    {
      line: join("npx tsx scripts/probe.ts --league ", fakeLeagueId("argv", 6)),
      gitleaks: ["espn-league-id"],
      scan: ["espn-league-id"],
    },
    {
      line: join("--league-id=", fakeLeagueId("argv2", 8)),
      gitleaks: ["espn-league-id"],
      scan: ["espn-league-id"],
    },
    {
      // a value split by string concatenation: neither half alone is 100 chars
      line: join(
        'const s = "',
        fakeEspnS2("concat", 140).slice(0, 70),
        '" + "',
        fakeEspnS2("concat", 140).slice(70),
        '";',
      ),
      gitleaks: [],
      scan: ["espn-s2-bare"],
    },
    {
      // a decoded value written JSON-escaped (`\/`): the backslashes split the run
      line: join(
        '{"v":"',
        decodeURIComponent(fakeEspnS2("json-escaped", 160)).replace(/\//g, "\\/"),
        '"}',
      ),
      gitleaks: [],
      scan: ["espn-s2-bare"],
    },
    { line: join("pasted: ", fakeEspnS2("short-paste", 70)), gitleaks: [], scan: ["espn-s2-bare"] },
    {
      line: join("contact: jane.doe", "%40", "acme-corp.io"),
      gitleaks: [],
      scan: ["email-address-encoded"],
    },
    { line: join("see //", at("jane.doe", "acme-corp.io")), gitleaks: [], scan: ["email-address"] },
    {
      line: join('"cwd": "\\/Users\\/', "probe-user", '\\/src"'),
      gitleaks: [],
      scan: ["home-path"],
    },
    { line: join("path=%2FUsers%2F", "probe-user", "%2Fsrc"), gitleaks: [], scan: ["home-path"] },
    { line: join("peer ", fakeIpv6("peer")), gitleaks: [], scan: ["ipv6-literal"] },
    // a home path as Claude Code spells it in a scratchpad or a transcript directory (Stage C
    // finding scan-home-path-dash-encoded): every character but a letter or a digit is a "-"
    ...dashedHomePathCases(join),
    // the cases a line pass cannot see — LAST, so every case above keeps its line: a match that
    // spans line breaks, which gitleaks reads whole-file (Stage C finding
    // scan-league-envelope-per-line). Each starts on its first line, where both scanners report it
    ...crossLineCases(join),
  ];
}

/**
 * Home paths in Claude Code's dash spelling (scan-secrets only: gitleaks has no home-path rule): a
 * scratchpad, a transcript directory, a Linux home, a Windows drive, an encoded path inside an
 * encoded path, and a transcript directory with its leading dash dropped.
 * @param {(...p: string[]) => string} join
 * @returns {FlagCase[]}
 */
export function dashedHomePathCases(join) {
  /** @param {string} line @returns {FlagCase} */
  const home = (line) => ({ line, gitleaks: [], scan: ["home-path"] });
  return [
    home(
      join(
        "/private/tmp/claude-501/",
        "-Users",
        "-probeuser-Developer-espn-fantasy-football-mcp/0f0e/scratchpad/live.json",
      ),
    ),
    home(
      join(
        "~/.claude/projects/",
        "-Users",
        "-probeuser-Developer-espn-fantasy-football-mcp/a.jsonl",
      ),
    ),
    home(join("cwd ", "-home", "-runner-work-espn-fantasy-football-mcp")),
    home(join("C-", "-Users", "-probeuser-AppData-Roaming")),
    home(join("-private-tmp-claude-501-", "-Users", "-probeuser-Developer-x")),
    // the same with its leading dash dropped, after a slash
    home(join("~/.claude/projects/", "Users", "-probeuser-Developer-espn-fantasy-football-mcp")),
  ];
}

/**
 * The shapes both scanners must flag when a line break sits where the rule allows whitespace: a
 * league body written one key per line, a league-id array, and the espn_s2, SWID, Cookie-header,
 * clientAddress and odds-key assignments with the value on the next line. Each case starts on its
 * own first line — where gitleaks reports a match (the full match's first line) and scan-secrets
 * too (its first non-blank character).
 * @param {(...p: string[]) => string} join
 * @returns {FlagCase[]}
 */
export function crossLineCases(join) {
  return [
    {
      line: join(
        '  "gameId": 1,\n  "id": ',
        fakeLeagueId("pretty-envelope", 8),
        ',\n  "members": [],',
      ),
      gitleaks: ["espn-league-envelope"],
      scan: ["espn-league-envelope"],
    },
    {
      line: join('  "leagueIds": [\n    ', fakeLeagueId("pretty-array", 7), "\n  ],"),
      gitleaks: ["espn-league-id"],
      scan: ["espn-league-id"],
    },
    {
      line: join("espn_s2 =\n  ", fakeEspnS2("wrapped-assignment", 120)),
      gitleaks: ["espn-s2-cookie"],
      scan: ["espn-s2-cookie"],
    },
    {
      line: join('  "swid":\n    "', fakeGuid("wrapped-swid"), '",'),
      gitleaks: ["espn-swid"],
      scan: ["espn-swid"],
    },
    {
      line: join("Cookie: SWID=\n  {", fakeGuid("wrapped-header"), "}"),
      gitleaks: ["cookie-header", "espn-swid"],
      scan: ["cookie-header", "espn-swid"],
    },
    {
      line: join('  "client', 'Address":\n    "', fakeIpv4("wrapped-client"), '",'),
      gitleaks: ["client-address"],
      scan: ["client-address"],
    },
    {
      line: join("ODDS_API_KEY =\n  ", digest("wrapped-odds").toString("hex").slice(0, 32)),
      gitleaks: ["odds-api-key"],
      scan: ["odds-api-key"],
    },
  ];
}

/**
 * The 1-based line of must-flag.txt each case starts on (a case may hold line breaks).
 * @returns {number[]}
 */
export function mustFlagStartLines() {
  let next = 1;
  return mustFlag().map((c) => {
    const at = next;
    next += c.line.split("\n").length;
    return at;
  });
}

/**
 * The encoded and escaped spellings of a league id the two scanners must both flag, each a line of
 * its own (Stage C finding scan-league-id-url-encoded): percent-encoding once, twice and inside a
 * JSON query value, a redirect whose query also carries a non-ASCII escape, Gson's \uXXXX-escaped
 * `=`, HTML entities, a JSON-escaped API URL, escaped JSON inside JSON, and the form-encoded
 * `league+id=`.
 * @param {(...p: string[]) => string} join
 * @returns {FlagCase[]}
 */
export function encodedLeagueIdCases(join) {
  /** @param {string} line @returns {FlagCase} */
  const both = (line) => ({ line, gitleaks: ["espn-league-id"], scan: ["espn-league-id"] });
  const login = "https://www.espn.com/login?redirectUrl=";
  return [
    both(
      join(
        login,
        "https%3A%2F%2Ffantasy.espn.com%2Ffootball%2Fleague%3F",
        "leagueId%3D",
        fakeLeagueId("encoded-query", 7),
      ),
    ),
    both(
      join(
        "https%3A%2F%2Flm-api-reads.fantasy.espn.com%2Fapis%2Fv3%2Fgames%2Fffl%2Fseasons%2F2026%2Fsegments%2F0",
        "%2Fleagues%2F",
        fakeLeagueId("encoded-path", 8),
      ),
    ),
    both(
      join(
        "%2Fapis%2Fv3%2Fgames%2Fffl",
        "%2FleagueHistory%2F",
        fakeLeagueId("encoded-history", 7),
        "%3FseasonId%3D2019",
      ),
    ),
    both(
      join(
        login,
        "https%253A%252F%252Ffantasy.espn.com%252Ffootball%252Fleague%253F",
        "leagueId%253D",
        fakeLeagueId("double-encoded", 7),
      ),
    ),
    // %E2%80%A6 (an ellipsis) is not printable ASCII: gitleaks' percent decoder drops the line's
    // whole %XX segment, so only the rule itself can see the id
    both(
      join(
        login,
        "https%3A%2F%2Ffantasy.espn.com%2Ffootball%2Fleague%3F",
        "leagueId%3D",
        fakeLeagueId("non-ascii-escape", 7),
        "%26note%3D%E2%80%A6",
      ),
    ),
    both(join("filter=%7B%22", "leagueIds%22%3A%5B", fakeLeagueId("json-in-query", 9), "%5D%7D")),
    both(
      join(
        '"url": "https://fantasy.espn.com/football/league?',
        "leagueId\\u003d",
        fakeLeagueId("gson", 7),
        '"',
      ),
    ),
    both(join('<a href="/football/league?', "leagueId&#61;", fakeLeagueId("entity", 7), '">')),
    both(
      join('<div data-props="{', "&quot;leagueId&quot;:", fakeLeagueId("entity-json", 8), '}">'),
    ),
    both(
      join(
        '"url": "https:\\/\\/lm-api-reads.fantasy.espn.com\\/apis\\/v3\\/games\\/ffl\\/seasons\\/2026\\/segments\\/0',
        "\\/leagues\\/",
        fakeLeagueId("json-slash", 8),
        '"',
      ),
    ),
    both(
      join(
        '"text": "{',
        '\\"leagueId\\":',
        fakeLeagueId("escaped-json", 7),
        ',\\"seasonId\\":2026}"',
      ),
    ),
    both(join("league+id=", fakeLeagueId("form", 7))),
  ];
}

/**
 * A fake global-unicast IPv6 address (never the documentation or link-local ranges).
 * @param {string} label
 */
export function fakeIpv6(label) {
  const h = digest(label).toString("hex");
  return `2a0${h[0] ?? "1"}:${h.slice(1, 5)}:${h.slice(5, 9)}::${h.slice(9, 13)}`;
}

/** Lines that LOOK like the shapes above but are the placeholders the docs use: both scanners stay quiet. */
export function mustPass() {
  return [
    "ESPN_LEAGUE_ID=0000000",
    "# EFF_PROBE_LEAGUE_ID=0000000",
    "leagueId=0 and league_id: 0",
    "redirectUrl=https%3A%2F%2Ffantasy.espn.com%2Ffootball%2Fleague%3FleagueId%3D0",
    '"leagueId": 0',
    "/apis/v3/games/ffl/seasons/2026/segments/0/leagues/0?view=mTeam",
    "{00000000-0000-4000-8000-000000000001}",
    "SWID={00000000-0000-4000-8000-0000000000AB}",
    '"primaryOwner": "{00000000-0000-4000-8000-00000000000c}"',
    "{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}",
    "Cookie: espn_s2=<your espn_s2>; SWID=<your SWID>",
    "Cookie: espn_s2=${espnS2}; SWID=${SWID};",
    "header string (espn_s2=…; SWID=…)",
    "the Cookie: header carries espn_s2 and SWID",
    '"clientAddress": "0.0.0.0"',
    "http://127.0.0.1:8790/setup",
    "/Users/<you>/src/espn-fantasy-football-mcp/dist/cli.js",
    "/home/<name>/ and C:\\Users\\<you>\\",
    "Co-authored commits use noreply@anthropic.com or 1234567+probe@users.noreply.github.com",
    "# ODDS_API_KEY=",
    "validate ^[A-Za-z0-9%+/=._-]{100,}$",
    "Node 24.15.0 and SDK 2.2.0",
    "espn_s2: string",
    // S3 additions: placeholders and near misses of the new rules
    '{"draftDetail":{},"gameId":1,"id":0,"members":[]}',
    '{"abbrev":"FFL","gameId":1,"id":2026,"name":"2026"}',
    "league ids are 4+ digits; pass --league-id <id> from the environment",
    "| league id | 0 |",
    "documentation 2001:db8::1 and link-local fe80::1",
    "at 12:34:56 the C++ std::vector was ok",
    "write to name%40example.com or a&#64;example.org",
    "https://user:pw@internal.example/path",
    // the encoded and escaped league-id spellings with the placeholder id, a template or too few
    // digits (Stage C finding scan-league-id-url-encoded)
    "redirectUrl=https%253A%252F%252Ffantasy.espn.com%252Ffootball%252Fleague%253FleagueId%253D0",
    "%2Fapis%2Fv3%2Fgames%2Fffl%2FleagueHistory%2F0%3FseasonId%3D2019",
    "leagueId%3D%7BleagueId%7D and %2Fleagues%2F%7Bid%7D?view=mTeam",
    '"url": "https://fantasy.espn.com/football/league?leagueId\\u003d0"',
    '<a href="/football/league?leagueId&#61;0">',
    '<div data-props="{&quot;leagueId&quot;:0}">',
    '"url": "https:\\/\\/lm-api-reads.fantasy.espn.com\\/apis\\/v3\\/games\\/ffl\\/seasons\\/2026\\/segments\\/0\\/leagues\\/0"',
    '"text": "{\\"leagueId\\":0,\\"seasonId\\":2026}"',
    "league+id=0 and league+id=123",
    // the dash-spelled home path with a placeholder, and dashes that are not a home path (Stage C
    // finding scan-home-path-dash-encoded)
    "~/.claude/projects/-Users-<you>-Developer-espn-fantasy-football-mcp/ and -home-${USER}-x",
    "git --home-dir, a --users-file flag, the Power-Users-guide, eff-home-abc",
    "docs/users-facing-notes-v2.md, https://github.com/home-assistant/core, the Users-guide",
    // the scrubbed shapes across line breaks (Stage C finding scan-league-envelope-per-line)
    '  "gameId": 1,\n  "id": 0,\n  "members": [],',
    '  "leagueIds": [\n    0\n  ],',
  ];
}

/** The .gitleaks.toml rule ids the gitleaks self-test requires (every custom rule). */
export const GITLEAKS_RULE_IDS = Object.freeze([...new Set(mustFlag().flatMap((c) => c.gitleaks))]);

/** @param {string} dir */
export function writeFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "must-flag.txt"),
    `${mustFlag()
      .map((c) => c.line)
      .join("\n")}\n`,
  );
  writeFileSync(path.join(dir, "must-pass.txt"), `${mustPass().join("\n")}\n`);
}

/**
 * @param {unknown} findings parsed gitleaks JSON report
 * @param {"--expect-all" | "--expect-none"} mode
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function assertGitleaks(findings, mode) {
  if (!Array.isArray(findings)) return { ok: false, lines: ["report is not a JSON array"] };
  /** @type {string[]} */
  const lines = [];
  const fired = new Set();
  /** `<rule>@<StartLine>` of every finding */
  const at = new Set();
  for (const f of findings) {
    const rule = typeof f?.RuleID === "string" ? f.RuleID : "?";
    fired.add(rule);
    at.add(`${rule}@${String(f?.StartLine)}`);
    const commit =
      typeof f?.Commit === "string" && f.Commit ? ` commit=${f.Commit.slice(0, 12)}` : "";
    lines.push(
      `finding: rule=${rule} file=${String(f?.File)} line=${String(f?.StartLine)}${commit}`,
    );
  }
  if (mode === "--expect-none") {
    lines.push(
      findings.length
        ? `expected no findings, got ${String(findings.length)}`
        : "0 findings, as required",
    );
    return { ok: findings.length === 0, lines };
  }
  const missing = GITLEAKS_RULE_IDS.filter((id) => !fired.has(id));
  lines.push(
    `expected ${String(GITLEAKS_RULE_IDS.length)} rule ids, fired ${String(GITLEAKS_RULE_IDS.length - missing.length)}`,
  );
  if (missing.length) lines.push(`these rules did NOT fire: ${missing.join(", ")}`);
  // per line (StartLine is 1-based, the must-flag case's own line): a rule that fires on one line
  // never stands in for a line it misses (Stage C finding scan-league-id-url-encoded — the encoded
  // league-id lines were unchecked while espn-league-id fired elsewhere)
  /** @type {string[]} */
  const unmet = [];
  let expected = 0;
  const starts = mustFlagStartLines();
  mustFlag().forEach((c, i) => {
    const line = starts[i] ?? 0;
    for (const id of c.gitleaks) {
      expected++;
      if (!at.has(`${id}@${String(line)}`)) unmet.push(`line ${String(line)} [${id}]`);
    }
  });
  lines.push(
    `per line: ${String(expected - unmet.length)} of ${String(expected)} expected findings on their own must-flag line`,
  );
  if (unmet.length) lines.push(`these must-flag lines were NOT reported: ${unmet.join(", ")}`);
  return { ok: missing.length === 0 && unmet.length === 0, lines };
}

/**
 * Run scan-secrets.mjs on generated copies and check every expectation.
 * @param {string} [scanner]
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function assertScan(scanner = path.join(REPO_ROOT, "scripts", "dev", "scan-secrets.mjs")) {
  const dir = mkdtempSync(path.join(tmpdir(), "eff-selftest-"));
  /** @type {string[]} */
  const lines = [];
  let ok = true;
  try {
    writeFixtures(dir);
    const env = { ...process.env, EFF_SCAN_DENYLIST: "/dev/null", HOME: dir };
    const flag = spawnSync(process.execPath, [scanner, "--", "must-flag.txt"], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    const out = `${flag.stdout}${flag.stderr}`;
    if (flag.status !== 1) {
      ok = false;
      lines.push(`must-flag: scan-secrets exit ${String(flag.status)} (1 required)`);
    }
    const starts = mustFlagStartLines();
    mustFlag().forEach((c, i) => {
      const line = starts[i] ?? 0;
      for (const rule of c.scan) {
        if (!out.includes(`must-flag.txt:${String(line)}  [${rule}]`)) {
          ok = false;
          lines.push(`must-flag line ${String(line)}: rule ${rule} did not fire`);
        }
      }
    });
    const pass = spawnSync(process.execPath, [scanner, "--", "must-pass.txt"], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    if (pass.status !== 0) {
      ok = false;
      const reported = [
        ...`${pass.stdout}${pass.stderr}`.matchAll(/must-pass\.txt:(\d+) {2}\[([a-z0-9-]+)\]/g),
      ].map((m) => `line ${m[1] ?? "?"} [${m[2] ?? "?"}]`);
      lines.push(
        `must-pass: scan-secrets exit ${String(pass.status)} (0 required): ${reported.join(", ")}`,
      );
    }
    if (ok)
      lines.push(
        `scan-secrets self-test: ${String(mustFlag().length)} must-flag lines reported with every expected rule; ${String(mustPass().length)} must-pass lines clean`,
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { ok, lines };
}

if (isMain(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  /** @param {{ ok: boolean, lines: string[] }} r */
  const finish = (r) => {
    for (const l of r.lines) process.stdout.write(`${l}\n`);
    process.exitCode = r.ok ? 0 : 1;
  };
  try {
    if (cmd === "write" && a) writeFixtures(path.resolve(a));
    else if (cmd === "assert-gitleaks" && a && (b === "--expect-all" || b === "--expect-none")) {
      let findings = [];
      try {
        const raw = readFileSync(a, "utf8").trim();
        findings = raw === "" ? [] : JSON.parse(raw);
      } catch (e) {
        if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
      }
      finish(assertGitleaks(findings, b));
    } else if (cmd === "assert-scan") finish(assertScan());
    else {
      process.stderr.write(
        "usage: secret-fixtures.mjs write <dir> | assert-gitleaks <report.json> --expect-all|--expect-none | assert-scan\n",
      );
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`secret-fixtures: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
