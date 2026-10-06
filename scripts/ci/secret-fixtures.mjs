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
//       --expect-all: every id in GITLEAKS_RULE_IDS fired at least once; --expect-none: no finding.
//       A missing report counts as zero findings. Prints RuleID/File/StartLine only — never a value.
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
  ];
}

/** Lines that LOOK like the shapes above but are the placeholders the docs use: both scanners stay quiet. */
export function mustPass() {
  return [
    "ESPN_LEAGUE_ID=0000000",
    "# EFF_PROBE_LEAGUE_ID=0000000",
    "leagueId=0 and league_id: 0",
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
  for (const f of findings) {
    const rule = typeof f?.RuleID === "string" ? f.RuleID : "?";
    fired.add(rule);
    lines.push(`finding: rule=${rule} file=${String(f?.File)} line=${String(f?.StartLine)}`);
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
  return { ok: missing.length === 0, lines };
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
    mustFlag().forEach((c, i) => {
      for (const rule of c.scan) {
        if (!out.includes(`must-flag.txt:${String(i + 1)}  [${rule}]`)) {
          ok = false;
          lines.push(`must-flag line ${String(i + 1)}: rule ${rule} did not fire`);
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
