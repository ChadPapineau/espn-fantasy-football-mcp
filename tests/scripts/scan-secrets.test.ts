// scan-secrets.test.ts — scripts/dev/scan-secrets.mjs is the ONLY layer that runs before a value
// reaches the public repo (gitleaks runs in CI, after the push), so every ESPN rule must fire at its
// boundary, the placeholders must pass, the deny-list must match without ever printing its terms,
// and it must fail closed on anything it cannot scan (CLAUDE.md "Security"; plan 04 §4.1 R11, §4.3).
// Adapted from the sibling's tests/lint/scan-secrets.test.ts (@d72e03b). Every well-formed value
// below is ASSEMBLED AT RUN TIME so this file itself stays clean for both scanners.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  brotliCompressSync,
  crc32,
  deflateRawSync,
  deflateSync,
  gunzipSync,
  gzipSync,
} from "node:zlib";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  FAKE_GUID,
  MAX_GZIP_LAYERS,
  NUMERIC_ALNUM_BOUNDARY,
  SKELETON_MIN,
  containerKind,
  decodeLayers,
  decodeText,
  gzipMembers,
  isOpaqueBinary,
  lineFindingIds,
  lineRuleIds,
  numericTermRe,
  pathFindings,
  scanBlob,
  skeleton,
  denylistLines,
  entropy,
  isGithubNoreply,
  isPlaceholderEmail,
  looksLikeBareEspnS2,
  normalise,
  parseDenylist,
  rawDenyViews,
  scanText,
} from "../../scripts/dev/scan-secrets.mjs";
import { fakeEspnS2, fakeGuid } from "../../scripts/ci/secret-fixtures.mjs";
import { ROOT, tempDir } from "../lint/helpers.js";

const SCANNER = path.join(ROOT, "scripts", "dev", "scan-secrets.mjs");
/** A well-formed (fake) GitHub token, split so no literal in this file matches. */
const TOKEN = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
const at = (local: string, domain: string) => `${local}@${domain}`;
const ip = (...o: number[]) => o.join(".");
const homePath = (kind: string, name: string, rest = "x") => ["", kind, name, rest].join("/");
const kv = (key: string, sep: string, value: string) => [key, sep, value].join("");
const FAKE = (nn: string) => ["00000000", "0000", "4000", "8000", `0000000000${nn}`].join("-");

let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

function scan(dir: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCANNER, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, EFF_SCAN_DENYLIST: "/dev/null", HOME: dir, ...env },
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** In-process scan of `lines`; returns the rule ids reported per 1-based line. */
function rulesOn(lines: string[], deny: string[] = []) {
  const findings = scanText("probe.txt", lines.join("\n"), deny);
  const out = new Map<number, string[]>();
  for (const f of findings) {
    const m = /^probe\.txt:(\d+) {2}\[([a-z0-9-]+)\]$/.exec(f);
    if (m) out.set(Number(m[1]), [...(out.get(Number(m[1])) ?? []), m[2] ?? ""]);
  }
  return out;
}
const flags = (line: string, rule: string) => (rulesOn([line]).get(1) ?? []).includes(rule);
const clean = (line: string) => (rulesOn([line]).get(1) ?? []).length === 0;

describe("espn_s2 with its name (espn-s2-cookie)", () => {
  const v = (n: number) => fakeEspnS2("t", 200).slice(0, n);
  it.each([
    ["=", kv("espn_s2", "=", v(40))],
    ["JSON", kv('"espn_s2"', ": ", `"${v(120)}"`)],
    ["upper-case", kv("ESPN_S2", "=", v(80))],
    ["hyphen", kv("espn-s2", ": ", v(90))],
    ["arrow", kv("espn_s2", " => ", `'${v(64)}'`)],
    ["cookie string", `${kv("espn_s2", "=", v(200))}; other=1`],
  ])("flags the %s form", (_f, line) => {
    expect(flags(line, "espn-s2-cookie")).toBe(true);
  });

  it("the floor is 40 characters (plan 04 §4.1): 39 passes, 40 fails", () => {
    expect(flags(kv("espn_s2", "=", v(39)), "espn-s2-cookie")).toBe(false);
    expect(flags(kv("espn_s2", "=", v(40)), "espn-s2-cookie")).toBe(true);
  });

  it.each([
    kv("espn_s2", ": ", "string"),
    kv("espn_s2", "=", "<your espn_s2 value from DevTools>"),
    kv("espn_s2", "=", "${ESPN_S2}"),
    kv("espn_s2", "=", "…; SWID=…"),
    kv("espn_s2", ": ", "credentials.espnS2EncodedValueForTheCookieHeaderOfThisSession"),
    "the stored espn_s2 value in its pasted form",
  ])("stays quiet on %j", (line) => {
    expect(clean(line)).toBe(true);
  });

  it("is never suppressed by the `scan-secrets: allow` marker", () => {
    expect(flags(`${kv("espn_s2", "=", v(100))} # scan-secrets: allow`, "espn-s2-cookie")).toBe(
      true,
    );
  });

  it("property: any cookie-alphabet value of 40–400 chars with a digit is flagged after espn_s2=", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(..."ABCabc0123456789%+/=._-".split("")),
          minLength: 39,
          maxLength: 399,
        }),
        fc.integer({ min: 0, max: 9 }),
        (s, d) => flags(kv("espn_s2", "=", `${String(d)}${s}`), "espn-s2-cookie"),
      ),
      { numRuns: 300 },
    );
  });
});

describe("a bare espn_s2-shaped value (espn-s2-bare)", () => {
  it("flags an AE-prefixed 100+ run and a percent-encoded one, whatever the prefix", () => {
    expect(flags(fakeEspnS2("b", 100), "espn-s2-bare")).toBe(true);
    const encoded = `Zq${fakeEspnS2("c", 160).slice(2)}`;
    expect(flags(encoded, "espn-s2-bare")).toBe(true);
    expect(flags(`value: "${fakeEspnS2("d", 300)}"`, "espn-s2-bare")).toBe(true);
  });

  it("the floor: 39 never; 40–99 only when the run starts AE AND carries ≥ 2 escapes (S3)", () => {
    const v = fakeEspnS2("b", 200);
    expect(flags(v.slice(0, 99), "espn-s2-bare")).toBe(true); // AE + %2F + %2B
    expect(flags(v.slice(0, 68), "espn-s2-bare")).toBe(true);
    expect(flags(v.replace(/%../g, "").slice(0, 99), "espn-s2-bare")).toBe(false); // no escapes
    expect(flags(`Zq${v.slice(2, 99)}`, "espn-s2-bare")).toBe(false); // escapes but no AE
    expect(flags(v.slice(0, 39), "espn-s2-bare")).toBe(false);
  });
  it("a value wrapped across lines or split by concatenation is joined (S3)", () => {
    const v = fakeEspnS2("wrapped", 240);
    const wrapped = [v.slice(0, 80), v.slice(80, 160), v.slice(160)];
    expect(rulesOn(wrapped).get(1)).toContain("espn-s2-bare");
    const concat = [
      `const s = "${v.slice(0, 70)}" +`,
      `  "${v.slice(70, 150)}" +`,
      `  "${v.slice(150)}";`,
    ];
    expect(rulesOn(concat).get(1)).toContain("espn-s2-bare");
    const json = [`"${v.slice(0, 60)}",`, `"${v.slice(60, 120)}",`];
    expect(rulesOn(json).get(1)).toContain("espn-s2-bare");
    // ordinary multi-line prose of single words is not a cookie
    expect(rulesOn(["Description", "Parameters", "Returns", "Examples"]).size).toBe(0);
  });

  it.each([
    ["a low-entropy run", `AE${"A1b".repeat(40)}`],
    ["a lowercase word salad", "ae".concat("abcdefghij".repeat(12))],
    ["a hex digest", "ab12".repeat(32)],
    ["a run with no escapes and no AE prefix", `Zq${"Xy7Pq2Lm9Rt".repeat(10)}`],
    [
      "a sha512 integrity (88 chars)",
      `sha512-${fakeEspnS2("i", 200).replace(/%../g, "").slice(0, 88)}`,
    ],
  ])("stays quiet on %s", (_why, line) => {
    expect(flags(line, "espn-s2-bare")).toBe(false);
  });

  it("looksLikeBareEspnS2 and entropy agree with the rule", () => {
    expect(looksLikeBareEspnS2(fakeEspnS2("x", 120))).toBe(true);
    expect(looksLikeBareEspnS2("AE".padEnd(120, "a"))).toBe(false);
    expect(entropy("")).toBe(0);
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abcd")).toBe(2);
  });

  it("is linear on a 2 MB single-line run (no catastrophic backtracking)", () => {
    const line = "a%2F".repeat(512 * 1024);
    const t0 = performance.now();
    rulesOn([line]);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe("SWID and brace-GUIDs outside the fixture range", () => {
  const g = fakeGuid("t");
  it.each([
    [kv("SWID", "=", `{${g}}`), ["espn-swid", "brace-guid"]],
    [kv("swid", "=", g), ["espn-swid"]],
    [kv('"swid"', ": ", `"{${g.toLowerCase()}}"`), ["espn-swid", "brace-guid"]],
    [kv("SWID", "=", `%7B${g}%7D`), ["espn-swid", "brace-guid"]],
    [`"primaryOwner": "{${g}}"`, ["brace-guid"]],
    [`members: [{"id":"{${g}}"}]`, ["brace-guid"]],
  ])("flags %s", (line, rules) => {
    for (const r of rules) expect(flags(line, r), r).toBe(true);
  });

  it.each(["01", "AB", "ab", "FF", "00"])("allows the fixture pseudonym {…%s}", (nn) => {
    expect(clean(kv("SWID", "=", `{${FAKE(nn)}}`))).toBe(true);
    expect(FAKE_GUID.test(FAKE(nn))).toBe(true);
  });

  it("the fixture range is exact: a near miss is flagged", () => {
    const near = ["00000000", "0000", "4000", "8000", "000000000100"].join("-");
    const version = ["00000000", "0000", "5000", "8000", "000000000001"].join("-");
    expect(flags(`{${near}}`, "brace-guid")).toBe(true);
    expect(flags(`{${version}}`, "brace-guid")).toBe(true);
  });

  it("an X-placeholder GUID is not hex and is not flagged", () => {
    expect(clean("{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}")).toBe(true);
  });

  it("property: every random GUID outside the range is flagged in braces", () => {
    fc.assert(
      fc.property(fc.uuid(), (u) => FAKE_GUID.test(u) || flags(`{${u}}`, "brace-guid")),
      { numRuns: 300 },
    );
  });
});

describe("league ids (espn-league-id)", () => {
  const id = (n: number) => "4815162342"[0]?.concat("815162342".slice(0, n - 1)) ?? "";
  it.each([
    ["URL query", `https://fantasy.espn.com/football/league?${kv("leagueId", "=", id(7))}`],
    ["env", kv("ESPN_LEAGUE_ID", "=", id(8))],
    ["probe env", kv("EFF_PROBE_LEAGUE_ID", "=", id(9))],
    ["JSON", kv('"leagueId"', ": ", id(6))],
    ["snake", kv("league_id", ": ", `"${id(5)}"`)],
    ["upper", kv("LEAGUEID", "=", id(4))],
    ["path", `/seasons/2026/segments/0/${kv("leagues", "/", id(7))}?view=mTeam`],
    ["history", `/${kv("leagueHistory", "/", id(6))}?seasonId=2019`],
    ["ten digits (broader than 4–9)", kv("leagueId", "=", "1234567890")],
  ])("flags the %s form", (_f, line) => {
    expect(flags(line, "espn-league-id")).toBe(true);
  });

  it.each([
    kv("ESPN_LEAGUE_ID", "=", "0000000"),
    kv("leagueId", "=", "0"),
    kv("leagues", "/", "0"),
    kv("leagueId", "=", "123"),
    "/seasons/2026/segments/0",
    kv("leagueId", "=", "${id}"),
    "leagues/{leagueId}",
  ])("stays quiet on %j", (line) => {
    expect(clean(line)).toBe(true);
  });

  it("property: any 4–9 digit id that is not all zeros is flagged after leagueId=", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^\d{4,9}$/),
        (d) => /^0+$/.test(d) || flags(kv("leagueId", "=", d), "espn-league-id"),
      ),
      { numRuns: 300 },
    );
  });
});

// Stage C finding scan-league-id-url-encoded: an ESPN login redirect and an encoded API URL carry
// the id as leagueId%3D<id> or …%2Fleagues%2F<id>, and both passed clean (CI has no deny-list).
describe("league ids in encoded URLs (the decoded view of a line)", () => {
  const id = ["7", "3", "1", "9", "0", "4", "2"].join("");
  const enc = encodeURIComponent;
  const login = (inner: string) => `https://www.espn.com/login?redirectUrl=${enc(inner)}`;
  const leagueUrl = `https://fantasy.espn.com/football/league?${kv("leagueId", "=", id)}`;
  const apiUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/${kv("leagues", "/", id)}`;
  it.each([
    ["an ESPN login redirect (leagueId%3D)", login(leagueUrl)],
    ["an encoded API URL (%2Fleagues%2F)", enc(apiUrl)],
    ["an encoded history URL (leagueHistory%2F)", enc(`/${kv("leagueHistory", "/", id)}`)],
    ["a double-encoded redirect (leagueId%253D)", login(login(leagueUrl))],
    [
      "a JSON body in a query (%22leagueId%22%3A)",
      `q=${enc(JSON.stringify({ leagueId: Number(id) }))}`,
    ],
    ["a JSON \\u-escaped equals sign", `"url": "${kv("leagueId", "\\u003d", id)}"`],
    ["an HTML-entity equals sign", `<a href="?${kv("leagueId", "&#61;", id)}">`],
    ["a form-encoded space (league+id=)", kv("league+id", "=", id)],
    ["upper-case escapes", kv("LEAGUEID", "%3D", id)],
  ])("flags %s", (_why, line) => {
    expect(flags(line, "espn-league-id"), line).toBe(true);
  });

  it.each([
    login("https://fantasy.espn.com/football/league?leagueId=0"),
    enc("/apis/v3/games/ffl/seasons/2026/segments/0/leagues/0"),
    kv("leagueId", "%3D", "%7BleagueId%7D"),
    enc("/leagues/{leagueId}?view=mTeam"),
    enc("score 100% of 1234 points"),
    "50%25 off, 2026 season",
  ])("stays quiet on %j", (line) => {
    expect(clean(line)).toBe(true);
  });

  it("property: any 4–9 digit non-zero id is flagged behind leagueId%3D and %2Fleagues%2F", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^\d{4,9}$/),
        fc.constantFrom("leagueId%3D", "%2Fleagues%2F", "%2FleagueHistory%2F", "leagueId%253D"),
        (d, prefix) => /^0+$/.test(d) || flags(`${prefix}${d}`, "espn-league-id"),
      ),
      { numRuns: 300 },
    );
  });

  it("every strict rule reads the decoded view; it adds a rule once and never duplicates one", () => {
    const guid = fakeGuid("dec");
    // a double-encoded member GUID and a \u-escaped mailbox: no raw rule sees either
    expect(lineFindingIds(enc(enc(`{${guid}}`)))).toEqual(["brace-guid"]);
    expect(lineFindingIds(`"to": "${["jane.q", "fakemail.net"].join("\\u0040")}"`)).toEqual([
      "email-address",
    ]);
    // the raw rule already fires on %7B…%7D: the decoded reading adds nothing
    expect(lineFindingIds(`${enc("{")}${guid}${enc("}")}`)).toEqual(["brace-guid"]);
    // the generic rules never run on the decoded reading (only the strict ones)
    const assigned = kv("password", " = ", `"${["Zq8vR2mK9", "wL4xN7pQ3"].join("")}"`);
    expect(lineRuleIds(assigned)).toEqual(["assigned-secret"]);
    expect(lineRuleIds(assigned, { strictOnly: true })).toEqual([]);
    expect(lineFindingIds(enc(assigned))).toEqual([]);
  });

  it("the Stage C repro over the CLI: q.md and p.md exit 1 with [espn-league-id]; the id is never printed", () => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "plain.md"), `${leagueUrl}\n`);
    writeFileSync(path.join(tmp.dir, "q.md"), `${login(leagueUrl)}\n`);
    writeFileSync(path.join(tmp.dir, "p.md"), `${enc(apiUrl)}\n`);
    for (const f of ["plain.md", "q.md", "p.md"]) {
      const r = scan(tmp.dir, ["--", f]);
      expect(r.status, `${f}: ${r.out}`).toBe(1);
      expect(r.out).toContain(`${f}:1  [espn-league-id]`);
      expect(r.out).not.toContain(id);
    }
  });
});

describe("cookie headers and clientAddress", () => {
  it("flags a Cookie / Set-Cookie header that carries a value", () => {
    const value = fakeEspnS2("h", 30).slice(0, 30);
    expect(flags(`Cookie: ${kv("espn_s2", "=", value)}`, "cookie-header")).toBe(true);
    expect(flags(`set-cookie: a=1; ${kv("SWID", "=", "abcdefgh12")}`, "cookie-header")).toBe(true);
  });

  it.each([
    "Cookie: espn_s2=<your espn_s2>; SWID=<your SWID>",
    "Cookie: espn_s2=${espnS2}; SWID=${SWID};",
    "Cookie: espn_s2=…; SWID=…",
    "Cookie: espn_s2=[redacted]",
    "the Cookie: header carries espn_s2 and SWID",
    "Cookie: espn_s2=VALUE; SWID=VALUE",
  ])("stays quiet on %j", (line) => {
    expect(clean(line)).toBe(true);
  });

  it("flags a clientAddress value and allows the scrubbed 0.0.0.0", () => {
    const field = (v: string) => `"${["client", "Address"].join("")}": "${v}"`;
    expect(flags(field(ip(203, 0, 113, 9)), "client-address")).toBe(true);
    expect(flags(field("2001:db8::1"), "client-address")).toBe(true);
    expect(clean(field(ip(0, 0, 0, 0)))).toBe(true);
  });
});

describe("IPv4 literals (ipv4-literal)", () => {
  it.each([
    ip(10, 0, 0, 1),
    `server at ${ip(192, 168, 1, 20)}:8080`,
    `ends a sentence ${ip(8, 8, 8, 8)}.`,
    `(${ip(1, 2, 3, 4)})`,
  ])("flags %s", (line) => {
    expect(flags(line, "ipv4-literal")).toBe(true);
  });

  it.each([
    `http://${ip(127, 0, 0, 1)}:8790/`,
    `bind ${ip(0, 0, 0, 0)}`,
    "Node 24.15.0",
    ip(256, 1, 1, 1),
    ip(1, 2, 3, 4, 5),
    "section 1.2.3",
  ])("stays quiet on %s", (line) => {
    expect(clean(line)).toBe(true);
  });
});

describe("absolute home paths (home-path)", () => {
  it.each([
    homePath("Users", "someone"),
    homePath("home", "someone"),
    homePath("users", "someone"),
    ["/Users", "someone"].join("/"),
    `file://${homePath("Users", "someone")}`,
    ["C:", "Users", "someone", "AppData"].join("\\"),
    ["C:", "Users", "someone", "AppData"].join("\\\\"),
    homePath("home", "runner", "work"),
  ])("flags %s", (line) => {
    expect(flags(line, "home-path")).toBe(true);
  });

  it.each([
    homePath("Users", "<you>", ".fnm/node-versions"),
    homePath("home", "<name>"),
    homePath("Users", "$USER"),
    homePath("Users", "${USER}"),
    homePath("Users", "…", "fnm"),
    ["C:", "Users", "<you>", ""].join("\\"),
    "/opt/homebrew/bin/node",
    "~/.config/espn-fantasy-football-mcp",
    "/Users/",
  ])("stays quiet on %s", (line) => {
    expect(clean(line)).toBe(true);
  });
});

describe("email addresses — any real mailbox (email-address)", () => {
  it.each([
    at("jane.doe", "gmail.com"),
    at("owner", "mail.example-isp.net"),
    at("first+tag", "sub.company.co.uk"),
  ])("flags %s", (addr) => {
    expect(flags(`contact: ${addr}`, "email-address")).toBe(true);
  });

  it.each([
    at("noreply", "anthropic.com"),
    at("123456+someone", "users.noreply.github.com"),
    at("probe", "example.invalid"),
    at("you", "example.com"),
    at("ci", "runner.localhost"),
  ])("allows the reserved or no-reply address %s", (addr) => {
    expect(clean(`contact: ${addr}`)).toBe(true);
  });

  it("allows the git SSH transport user and URL userinfo; ignores version pins", () => {
    expect(clean(`remote: ${at("git", "github.com")}:owner/repo.git`)).toBe(true);
    expect(clean(`url: https://user:${at("pw", "github.com")}/x`)).toBe(true);
    expect(clean("@modelcontextprotocol/server@2.2.0 and x@1.2.3")).toBe(true);
  });

  it("isPlaceholderEmail / isGithubNoreply", () => {
    expect(isPlaceholderEmail(at("a", "example.org"))).toBe(true);
    expect(isPlaceholderEmail(at("example.person", "acme-corp.io"))).toBe(false);
    expect(isGithubNoreply(at("1234567+probe", "users.noreply.github.com"))).toBe(true);
    expect(isGithubNoreply(at("probe", "users.noreply.github.com"))).toBe(true);
    for (const bad of [
      at("probe", "example.invalid"),
      at("noreply", "anthropic.com"),
      at("dev", "build-host.lan"),
      at("a+b+c", "users.noreply.github.com"),
      `${at("1+x", "users.noreply.github.com")}.evil.io`,
      "",
    ]) {
      expect(isGithubNoreply(bad), bad).toBe(false);
    }
  });
});

describe("generic credentials and the allow marker", () => {
  it("flags a token, and the marker suppresses only generic rules", () => {
    expect(flags(`token = ${TOKEN}`, "github-token")).toBe(true);
    expect(clean(`token = ${TOKEN} # scan-secrets: allow`)).toBe(true);
    expect(flags(`${at("jane", "acme-corp.io")} # scan-secrets: allow`, "email-address")).toBe(
      true,
    );
    expect(flags(`${ip(10, 1, 1, 1)} # scan-secrets: allow`, "ipv4-literal")).toBe(true);
  });
});

describe("the local deny-list — matched, never printed", () => {
  const TERM = ["Gridiron", "Gremlins"].join(" ");
  function withDeny(lines: string[], fileBody: string, name = "probe.txt") {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "deny.txt"), `# a comment\n\n${TERM}\n`);
    writeFileSync(path.join(tmp.dir, name), fileBody || `${lines.join("\n")}\n`);
    return scan(tmp.dir, ["--", name], { EFF_SCAN_DENYLIST: path.join(tmp.dir, "deny.txt") });
  }
  const noLeak = (out: string) => {
    for (const piece of TERM.toLowerCase().split(" "))
      expect(out.toLowerCase()).not.toContain(piece);
  };

  it("reports only `deny-list match in <file>:<line>`", () => {
    const r = withDeny(["clean line", `the ${TERM.toUpperCase()} won`], "");
    expect(r.status).toBe(1);
    expect(r.out).toContain("deny-list match in probe.txt:2");
    noLeak(r.out);
  });

  it.each([
    ["wrapped across a line break", ["intro", "the Gridiron", "Gremlins won"], 2],
    ["a zero-width space inside", [`Gridiron​ Gremlins`], 1],
    ["full-width letters (NFKC)", ["Ｇｒｉｄｉｒｏｎ Ｇｒｅｍｌｉｎｓ"], 1],
    ["URL-encoded", ["?team=Gridiron%20Gremlins"], 1],
    ["slug", ["teams/gridiron-gremlins.json"], 1],
    ["snake", ["gridiron_gremlins"], 1],
    ["squashed", ["GridironGremlins"], 1],
  ])("matches when %s", (_why, lines, line) => {
    const r = withDeny(lines, "");
    expect(r.status).toBe(1);
    expect(r.out).toContain(`deny-list match in probe.txt:${String(line)}`);
    noLeak(r.out);
  });

  it("matches a term in a file NAME without printing the name", () => {
    const r = withDeny([], "nothing here\n", "gridiron-gremlins-notes.txt");
    expect(r.status).toBe(1);
    expect(r.out).toContain("deny-list match in the path of scanned entry #1 (path not printed)");
    noLeak(r.out);
  });

  it("matches inside a binary file it does not regex-scan", () => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "deny.txt"), `${TERM}\n`);
    writeFileSync(
      path.join(tmp.dir, "a.png"),
      Buffer.concat([Buffer.from([0x89, 0, 1]), Buffer.from(TERM)]),
    );
    const r = scan(tmp.dir, ["--", "a.png"], { EFF_SCAN_DENYLIST: path.join(tmp.dir, "deny.txt") });
    expect(r.status).toBe(1);
    expect(r.out).toContain("deny-list match in a.png:1");
    noLeak(r.out);
  });

  it("uses the default location under HOME when EFF_SCAN_DENYLIST is unset or unreadable", () => {
    tmp = tempDir("eff-scan-");
    const def = path.join(tmp.dir, ".local", "share", "espn-fantasy-football-mcp-dev");
    mkdirSync(def, { recursive: true });
    writeFileSync(path.join(def, "scan-denylist.txt"), `${TERM}\n`);
    writeFileSync(path.join(tmp.dir, "probe.txt"), `${TERM}\n`);
    for (const env of [
      { EFF_SCAN_DENYLIST: "" },
      { EFF_SCAN_DENYLIST: path.join(tmp.dir, "absent.txt") },
    ]) {
      const r = scan(tmp.dir, ["--", "probe.txt"], env);
      expect(r.status).toBe(1);
      expect(r.out).toContain("deny-list match in probe.txt:1");
      noLeak(r.out);
    }
  });

  it("an absent deny-list is not an error (CI has none)", () => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "probe.txt"), `${TERM}\n`);
    const r = scan(tmp.dir, ["--", "probe.txt"], {
      EFF_SCAN_DENYLIST: path.join(tmp.dir, "absent.txt"),
    });
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("deny-list active");
  });

  it.skipIf(process.getuid?.() === 0)(
    "a default deny-list that exists but cannot be read fails closed (exit 2), path not printed",
    () => {
      tmp = tempDir("eff-scan-");
      const def = path.join(tmp.dir, ".local", "share", "espn-fantasy-football-mcp-dev");
      mkdirSync(def, { recursive: true });
      const f = path.join(def, "scan-denylist.txt");
      writeFileSync(f, `${TERM}\n`);
      chmodSync(f, 0o000);
      writeFileSync(path.join(tmp.dir, "probe.txt"), "clean\n");
      const r = scan(tmp.dir, ["--", "probe.txt"], { EFF_SCAN_DENYLIST: "" });
      chmodSync(f, 0o600);
      expect(r.status).toBe(2);
      expect(r.out).not.toContain("scan-denylist.txt");
      expect(r.out).not.toContain("clean (");
    },
  );

  it("applies to a commit message (--message)", () => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "deny.txt"), `${TERM}\n`);
    writeFileSync(path.join(tmp.dir, "MSG"), `feat: x\n\nfor the ${TERM}\n`);
    const r = scan(tmp.dir, ["--message", "MSG"], {
      EFF_SCAN_DENYLIST: path.join(tmp.dir, "deny.txt"),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("deny-list match in COMMIT_MESSAGE:3");
    noLeak(r.out);
  });

  it("parseDenylist / normalise / denylistLines units", () => {
    expect(parseDenylist("# c\n\n  Ab  Cd \nxy\n")).toEqual(
      expect.arrayContaining(["ab cd", "ab%20cd", "ab+cd", "ab-cd", "ab_cd", "xy"]),
    );
    expect(parseDenylist("Ab Cd")).not.toContain("abcd"); // squashed form only for >= 8 chars
    expect(normalise("A​B’")).toBe("ab'");
    expect(denylistLines("x\nfoo\nbar", ["foo bar"])).toEqual([2]);
    expect(denylistLines("anything", [])).toEqual([]);
  });
});

describe("S3: league ids in every spelling, envelope and parsed fixtures", () => {
  const id = () => ["1", "2", "3", "4", "5", "6", "7", "8"].join("");
  it.each([
    ["league id: N", () => `league id: ${id()}`],
    ["League-ID = N", () => `League-ID = ${id()}`],
    ['"leagueIds": [N]', () => `"leagueIds": [${id()}, 0]`],
    ["markdown cell", () => `| league id | ${id()} |`],
    ["--league N", () => `run --league ${id()}`],
    ["--league-id=N", () => `--league-id=${id()}`],
  ])("flags %s", (_n, line) => {
    expect(flags(line(), "espn-league-id")).toBe(true);
  });
  it("the league envelope rule flags a non-zero root id; a season body and id 0 pass", () => {
    expect(
      flags(`{"draftDetail":{},"gameId":1,"id":${id()},"members":[]}`, "espn-league-envelope"),
    ).toBe(true);
    expect(flags(`{"gameId": 1, "id": ${id()}, "seasonId": 2026}`, "espn-league-envelope")).toBe(
      true,
    );
    expect(clean('{"draftDetail":{},"gameId":1,"id":0,"members":[]}')).toBe(true);
    expect(clean('{"abbrev":"FFL","gameId":1,"id":2026,"name":"2026"}')).toBe(true);
  });
  it("a pretty-printed fixture under fixtures/ is parsed: root id and leagueId fields", () => {
    const pretty = JSON.stringify(
      { teams: [], gameId: 1, seasonId: 2026, id: Number(id()) },
      null,
      2,
    );
    expect(scanText("fixtures/espn/recorded/league-z/mTeam.json", pretty, [])).toContain(
      "fixtures/espn/recorded/league-z/mTeam.json  [espn-league-root-id]",
    );
    const nested = JSON.stringify({ a: { b: [{ leagueId: Number(id()) }] } }, null, 2);
    expect(scanText("fixtures/x.json", nested, [])).toContain(
      "fixtures/x.json  [espn-league-id-field]",
    );
    expect(scanText("fixtures/x.json", JSON.stringify({ a: { leagueIds: [id()] } }), [])).toContain(
      "fixtures/x.json  [espn-league-id-field]",
    );
    // the scrubbed shape, a season body, non-fixture paths and unparseable text are not this rule's
    expect(
      scanText(
        "fixtures/y.json",
        JSON.stringify({ gameId: 1, seasonId: 2026, id: 0, leagueId: 0 }),
        [],
      ),
    ).toEqual([]);
    expect(
      scanText("fixtures/y.json", JSON.stringify({ gameId: 1, id: 2026, name: "2026" }), []),
    ).toEqual([]);
    expect(scanText("docs/y.json", pretty, [])).toEqual([]);
    expect(scanText("fixtures/y.json", "{not json", [])).toEqual([]);
  });
});

describe("S3: encoded emails, protocol-relative userinfo, escaped home paths, IPv6", () => {
  it("flags name%40domain and HTML-entity @; reserved domains pass", () => {
    expect(flags(["mail jane.doe", "%40", "acme-corp.io"].join(""), "email-address-encoded")).toBe(
      true,
    );
    expect(flags(["x&", "#64;acme-corp.io"].join(""), "email-address-encoded")).toBe(true);
    expect(clean(["name", "%40", "example.com"].join(""))).toBe(true);
  });
  it("a protocol-relative //name@host is a mailbox; only scheme://user:pw@ userinfo is exempt", () => {
    expect(flags(`see //${at("jane.doe", "acme-corp.io")}`, "email-address")).toBe(true);
    expect(flags(`https://${at("jane.doe", "acme-corp.io")}/x`, "email-address")).toBe(true);
    expect(clean(`https://user:${at("pw", "acme-corp.io")}/x`)).toBe(true);
  });
  it("JSON-escaped and URL-encoded home paths are flagged", () => {
    const user = ["probe", "user"].join("-");
    const esc = (...p: string[]) => p.join(String.raw`\/`);
    const enc = (...p: string[]) => p.join("%2F");
    expect(flags(`"cwd": "${esc("", "Users", user, "src")}"`, "home-path")).toBe(true);
    expect(flags(`path=${enc("", "Users", user, "src")}`, "home-path")).toBe(true);
    expect(flags(`path=${enc("", "home", user).toLowerCase()}`, "home-path")).toBe(true);
    expect(clean(String.raw`"cwd": "\/Users\/<you>\/src"`)).toBe(true);
  });
  it("IPv6 anywhere; documentation, link-local and non-addresses pass", () => {
    const g = ["2a01", "4f8", "c17", "", "1"].join(":");
    expect(flags(`peer ${g} up`, "ipv6-literal")).toBe(true);
    expect(flags(["2a01", "4f8", "c17", "b21", "0", "0", "0", "2"].join(":"), "ipv6-literal")).toBe(
      true,
    );
    for (const ok of ["2001:db8::1", "fe80::1", "12:34:56", "std::vector", "Vec::new", "a::b"])
      expect(clean(ok), ok).toBe(true);
  });
});

describe("numeric deny-list terms (league ids) match as whole tokens", () => {
  const short = ["3", "1", "4", "1"].join("");
  const long = ["1", "2", "3", "4", "5", "6", "7", "8"].join("");
  const deny = parseDenylist(`${short}\n${long}\n`);
  it.each([
    [`leagues/${short}?view=mTeam`, true],
    [`id: ${short},`, true],
    [`"${short}"`, true],
    [`sha ab${short}cd`, false],
    [`n=9${short}`, false],
    [`${short}5 points`, false],
    [`ratio 0.${short}`, false],
    [`${short}.5 yards`, false],
    [`league${long}`, true],
    [`x${long}y`, true],
    [`9${long}`, false],
    [`${long}0`, false],
  ])("%s → %s", (line, hit) => {
    expect(denylistLines(line, deny).length > 0).toBe(hit);
  });
  it("numericTermRe picks the boundary by length", () => {
    expect(NUMERIC_ALNUM_BOUNDARY).toBe(7);
    expect(numericTermRe(short).test(`a${short}`)).toBe(false);
    expect(numericTermRe(long).test(`a${long}`)).toBe(true);
  });
});

describe("S4: deny-list terms in every encoding a capture can carry", () => {
  const TERM2 = "O'Brien Bombers";
  const TERM3 = "Gridiron Gang";
  const deny = parseDenylist(`${TERM2}\n${TERM3}\nñandú fc\n`);
  it.each([
    ["URL-encoded apostrophe and spaces", "o%27brien%20bombers"],
    ["JSON \\u escapes", String.raw`O\u0027Brien Bombers`],
    ["HTML entity", "O&#39;Brien Bombers"],
    ["hex HTML entity", "O&#x27;Brien Bombers"],
    ["named entity", "O&apos;Brien Bombers"],
    ["dot separators", "gridiron.gang"],
    ["emoji between words", "Gridiron 🏈 Gang"],
    ["underscore+camel", "GRIDIRON__gang"],
    ["JSON non-ASCII escape", String.raw`\u00f1and\u00fa FC`],
    ["double-encoded", "o%2527brien%2520bombers"],
  ])("matches %s", (_n, text) => {
    expect(denylistLines(`x\n${text}\ny`, deny)).toEqual([2]);
  });
  it("short terms are not skeleton-matched (no shredding); unrelated text passes", () => {
    const d = parseDenylist("ab cd\n");
    expect(denylistLines("a.b.c.d", d)).toEqual([]);
    expect(denylistLines("the gridiron is a field and gangs are bad", deny)).toEqual([]);
    expect(decodeLayers("%E2%9C%93 &amp; \\u0041")).toBe("✓ & A");
    expect(decodeLayers("%ZZ &bogus; &#0; &#xD800;")).toBe("%ZZ &bogus; &#0; &#xD800;");
    expect(skeleton("Grid-iron 🏈 Gang!")).toBe("GridironGang");
    expect(SKELETON_MIN).toBe(6);
  });
});

describe("fails closed on content it cannot scan", () => {
  it("scans a text file over 8 MB instead of skipping it", () => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "big.txt"), `token = ${TOKEN}\n${"a".repeat(9_000_000)}\n`);
    const r = scan(tmp.dir, ["--", "big.txt"]);
    expect(r.out).toContain("big.txt:1  [github-token]");
    expect(r.status).toBe(1);
  });

  it("exits 2 (never 0) on a file larger than it will read", () => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "huge.txt"), "a".repeat(4096));
    const r = scan(tmp.dir, ["--", "huge.txt"], { EFF_SCAN_MAX_BYTES: "1024" });
    expect(r.status).toBe(2);
    expect(r.out).not.toContain("clean");
  });

  it.each([
    [
      "a leading NUL",
      "nul.txt",
      Buffer.concat([Buffer.from([0, 10]), Buffer.from(`token = ${TOKEN}\n`)]),
    ],
    ["a NUL mid-file", "notes.md", Buffer.from(`intro\n\u0000\u0000\ntoken = ${TOKEN}\n`)],
    [
      "no extension",
      "LICENSE-x",
      Buffer.concat([Buffer.from([0]), Buffer.from(`\ntoken = ${TOKEN}\n`)]),
    ],
  ])("scans a text file with %s", (_why, name, body) => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, name), body);
    const r = scan(tmp.dir, ["--", name]);
    expect(r.out).toContain(`${name}:`);
    expect(r.status).toBe(1);
  });

  it("still skips a genuine binary image format, and says so; a .png without NUL is scanned", () => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    const r = scan(tmp.dir, ["--", "a.png"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/1 binary file\(s\) skipped/);
    writeFileSync(path.join(tmp.dir, "shot.png"), `token = ${TOKEN}\n`);
    expect(scan(tmp.dir, ["--", "shot.png"]).status).toBe(1);
  });
  it.each([
    "a.parquet",
    "store.sqlite3",
    "dump.db",
    "raw.zip",
    "cap.json.xz",
    "x.zst",
    "y.bz2",
    "z.arrow",
    "w.feather",
    "v.7z",
  ])("S5: refuses %s outright — an archive or database cannot be scanned (fail closed)", (name) => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, name), Buffer.from([0x50, 0x41, 0x52, 0x31, 0, 0, 1, 2]));
    const r = scan(tmp.dir, ["--", name]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${name}  [unscannable-archive-or-database]`);
  });
  it("S5: decompresses gzip and scans the text — a GUID and a league envelope inside are found", async () => {
    const { gzipSync } = await import("node:zlib");
    tmp = tempDir("eff-scan-");
    const rootId = ["1234", "5678"].join("");
    const body = `{"draftDetail":{},"gameId":1,"id":${rootId},"members":[{"id":"{${fakeGuid("gz")}}"}]}`;
    writeFileSync(path.join(tmp.dir, "leak.json.gz"), gzipSync(body));
    const r = scan(tmp.dir, ["--", "leak.json.gz"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("leak.json.gz:1  [brace-guid]");
    expect(r.out).toContain("leak.json.gz:1  [espn-league-envelope]");
    writeFileSync(path.join(tmp.dir, "bad.gz"), Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3]));
    const bad = scan(tmp.dir, ["--", "bad.gz"]);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain("bad.gz  [unscannable-archive-or-database]");
    writeFileSync(path.join(tmp.dir, "ok.txt.gz"), gzipSync("nothing to see\n"));
    expect(scan(tmp.dir, ["--", "ok.txt.gz"]).status).toBe(0);
  });

  it("scans a symlink as its target string and never follows it", () => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "secret.txt"), `token = ${TOKEN}\n`);
    symlinkSync(path.join(tmp.dir, "secret.txt"), path.join(tmp.dir, "link-to-secret"));
    symlinkSync(homePath("Users", "someone", "notes.txt"), path.join(tmp.dir, "link-home"));
    const r = scan(tmp.dir, ["--", "link-to-secret", "link-home"]);
    expect(r.out).not.toContain("[github-token]");
    expect(r.out).toContain("link-home:1  [home-path]");
  });

  it("usage errors exit 2", () => {
    tmp = tempDir("eff-scan-");
    expect(scan(tmp.dir, []).status).toBe(2);
    expect(scan(tmp.dir, ["--bogus"]).status).toBe(2);
    expect(scan(tmp.dir, ["--message"]).status).toBe(2);
  });

  it("the scanner is clean on the whole tracked tree, itself included (no self-exclusion)", () => {
    const r = spawnSync(process.execPath, [SCANNER, "--all"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, EFF_SCAN_DENYLIST: "/dev/null", HOME: ROOT },
    });
    expect(`${r.stdout}${r.stderr}`).toMatch(/scan-secrets: clean/);
    expect(r.status).toBe(0);
  });
});

// --- S7: a blob is read by what its BYTES are, never only by its name -----------------------------
// (Stage C findings: a zip/Flate document container passed as "clean" under .xlsx/.docx/.pptx/.jar/
// .pdf (a binary extension) or .numbers/.odt (decoded as UTF-8 garbage) while the same bytes as .zip
// were refused; a UTF-16 file was read as UTF-8 with a NUL between every pair of characters, so no
// rule and no numeric deny-list term could ever match.) Every value below is fake and assembled.

/** A minimal one-entry zip archive — what .docx/.xlsx/.pptx/.odt/.numbers/.epub/.jar files are. */
function zipOf(entry: string, data: Buffer, method: 0 | 8 = 8): Buffer {
  const body = method === 8 ? deflateRawSync(data) : data;
  const name = Buffer.from(entry);
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(method, 8);
  lfh.writeUInt32LE(crc32(data), 14);
  lfh.writeUInt32LE(body.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(name.length, 26);
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(method, 10);
  cdh.writeUInt32LE(crc32(data), 16);
  cdh.writeUInt32LE(body.length, 20);
  cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(name.length, 28);
  const local = Buffer.concat([lfh, name, body]);
  const central = Buffer.concat([cdh, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

const LEAK_ID = ["5555", "1234", "567"].join("");
const LEAK_TEAM = ["Zorblax", "Wanderers"].join(" ");
/** One line per identifier rule the finding names: a league id, a mailbox, a SWID, a home path. */
const LEAK_LINES = () => [
  `ESPN_LEAGUE_ID=${LEAK_ID}`,
  `contact: ${at("jane.q.fakeperson", "gmail.com")}`,
  kv("SWID", "=", `{${fakeGuid("s7")}}`),
  `home ${homePath("Users", "janefake")}`,
];
const LEAK_RULES = ["espn-league-id", "email-address", "espn-swid", "brace-guid", "home-path"];
const leakText = () => `${LEAK_LINES().join("\n")}\n`;
const leakXml = () => Buffer.from(`<t>${LEAK_LINES().join(" ")} ${LEAK_TEAM}</t>`);
const DENY = () => parseDenylist(`${LEAK_ID}\n${LEAK_TEAM}\n`);
const ruleIds = (findings: string[]) =>
  [...new Set(findings.map((f) => /\[([a-z0-9-]+)\]$/.exec(f)?.[1] ?? ""))].filter(Boolean).sort();
const noLeakS7 = (out: string) => {
  expect(out).not.toContain(LEAK_ID);
  for (const w of LEAK_TEAM.toLowerCase().split(" ")) expect(out.toLowerCase()).not.toContain(w);
};

describe("S7: document containers and compressed streams are refused by their bytes, whatever the name", () => {
  function scanFiles(files: Record<string, Buffer>, args?: string[]) {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "deny.txt"), `${LEAK_ID}\n${LEAK_TEAM}\n`);
    for (const [n, b] of Object.entries(files)) writeFileSync(path.join(tmp.dir, n), b);
    return scan(tmp.dir, args ?? ["--", ...Object.keys(files)], {
      EFF_SCAN_DENYLIST: path.join(tmp.dir, "deny.txt"),
    });
  }

  it.each([
    "report.xlsx",
    "report.docx",
    "deck.pptx",
    "lib.jar",
    "sheet.numbers",
    "doc.odt",
    "book.epub",
    "report.zip",
    "notes.md",
    "shot.png",
    "blob.bin",
    "README",
  ])("refuses a deflated zip container named %s (the repro: exit 1, never clean)", (name) => {
    const r = scanFiles({ [name]: zipOf("xl/worksheets/sheet1.xml", leakXml()) });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`${name}  [unscannable-archive-or-database]`);
    expect(r.out).toMatch(/zip container/);
    expect(r.out).not.toContain("scan-secrets: clean");
    noLeakS7(r.out);
  });

  it("refuses a stored (uncompressed) zip too, and a zip appended to a genuine PNG (a polyglot)", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const r = scanFiles({
      "stored.docx": zipOf("word/document.xml", leakXml(), 0),
      "poly.png": Buffer.concat([png, Buffer.alloc(64, 7), zipOf("a.xml", leakXml())]),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("stored.docx  [unscannable-archive-or-database]");
    expect(r.out).toContain("poly.png  [unscannable-archive-or-database]");
    noLeakS7(r.out);
  });

  it("refuses a PDF whose stream is FlateDecode-compressed, as .pdf and under a text name; an ASCII-armoured PDF too", () => {
    const stream = deflateSync(leakXml());
    const pdf = Buffer.concat([
      Buffer.from(
        `%PDF-1.4\n1 0 obj\n<< /Length ${String(stream.length)} /Filter /FlateDecode >>\nstream\n`,
      ),
      stream,
      Buffer.from("\nendstream\nendobj\n%%EOF\n"),
    ]);
    const hex = `%PDF-1.4\n1 0 obj\n<< /Filter [/ASCIIHexDecode /FlateDecode] >>\nstream\n${stream.toString("hex")}>\nendstream\nendobj\n%%EOF\n`;
    const r = scanFiles({
      "report.pdf": pdf,
      "report.txt": pdf,
      "armoured.md": Buffer.from(hex),
    });
    expect(r.status).toBe(1);
    for (const n of ["report.pdf", "report.txt", "armoured.md"])
      expect(r.out).toContain(`${n}  [unscannable-archive-or-database]`);
    expect(r.out).toMatch(/PDF/);
    noLeakS7(r.out);
  });

  it.each([
    ["xz", Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]), leakXml()])],
    ["zstd", Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), leakXml()])],
    [
      "bzip2",
      Buffer.concat([Buffer.from("BZh9"), Buffer.from([0x31, 0x41, 0x59, 0x26, 0x53, 0x59])]),
    ],
    ["7z", Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), leakXml()])],
    ["SQLite", Buffer.concat([Buffer.from("SQLite format 3\0"), leakXml()])],
    [
      "OLE compound document",
      Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), leakXml()]),
    ],
    [
      "tar",
      (() => {
        const b = Buffer.alloc(1024);
        b.write("data.xml", 0);
        b.write("ustar\0", 257, "latin1");
        leakXml().copy(b, 512);
        return b;
      })(),
    ],
    [
      "WOFF2",
      Buffer.concat([
        Buffer.from("wOF2"),
        Buffer.from([0, 1, 0, 0]),
        brotliCompressSync(leakXml()),
      ]),
    ],
  ])("refuses a %s by its bytes under an innocent name", (_kind, bytes) => {
    const r = scanFiles({ "data.md": bytes });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("data.md  [unscannable-archive-or-database]");
    noLeakS7(r.out);
  });

  it.each([
    ["a raw deflate stream", () => deflateRawSync(leakXml())],
    ["a brotli stream", () => brotliCompressSync(leakXml())],
    ["legacy (latin-1) text", () => Buffer.from(`café ${LEAK_LINES().join(" ")}`, "latin1")],
    [
      "random bytes",
      () => Buffer.from(Array.from({ length: 256 }, (_v, i) => (i * 37 + 129) & 0xff)),
    ],
  ])(
    "refuses %s — neither text nor a recognised binary — and the deny-list still reads it",
    (_why, make) => {
      for (const name of ["x.dat", "notes.md", "pic.png", "lib.so"]) {
        const r = scanBlob(name, make(), DENY());
        expect(r.scanned, name).toBe(0);
        expect(r.binary, name).toBe(0);
        expect(
          r.findings.some((f) => f.startsWith(`${name}  [unscannable-archive-or-database]`)),
        ).toBe(true);
      }
      const raw = Buffer.concat([Buffer.from([0x89, 0, 0xff]), Buffer.from(LEAK_TEAM)]);
      expect(scanBlob("pic.png", raw, DENY()).findings).toContain("deny-list match in pic.png:1");
    },
  );

  it("peels gzip by its bytes under any name and scans what is inside; a gzip of a zip is refused; nesting is bounded", () => {
    const text = Buffer.from(leakText());
    expect(ruleIds(scanBlob("notes.md", gzipSync(text), []).findings)).toEqual(
      [...LEAK_RULES].sort(),
    );
    const nest = (b: Buffer, n: number): Buffer => (n === 0 ? b : nest(gzipSync(b), n - 1));
    expect(ruleIds(scanBlob("x.txt", nest(text, MAX_GZIP_LAYERS), []).findings)).toEqual(
      [...LEAK_RULES].sort(),
    );
    const deep = scanBlob("x.txt", nest(text, MAX_GZIP_LAYERS + 1), []).findings;
    expect(deep.some((f) => f.includes("[unscannable-archive-or-database] (gzip nested"))).toBe(
      true,
    );
    const gzZip = scanBlob("cap.json.gz", gzipSync(zipOf("a.xml", leakXml())), []).findings;
    expect(gzZip.some((f) => f.startsWith("cap.json.gz  [unscannable-archive-or-database]"))).toBe(
      true,
    );
    // a .tgz is a gzip'd tar: refused once peeled
    const tar = Buffer.alloc(1024);
    tar.write("ustar\0", 257, "latin1");
    expect(scanBlob("a.tgz", gzipSync(tar), []).findings.join()).toMatch(/tar archive/);
  });

  it("still skips a genuine opaque binary (magic + extension) with the deny-list on its bytes; a lookalike name alone skips nothing", () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      Buffer.from(LEAK_TEAM),
    ]);
    const r = scanBlob("a.png", png, DENY());
    expect(r.binary).toBe(1);
    // the PNG signature carries "\r\n" and "\n": the term sits on the third latin1 "line"
    expect(r.findings).toEqual(["deny-list match in a.png:3"]);
    expect(isOpaqueBinary("a.png", png)).toBe(true);
    expect(isOpaqueBinary("a.jpg", png)).toBe(false); // the magic of another format
    expect(isOpaqueBinary("a.txt", png)).toBe(false); // not an opaque extension
    // valid UTF-8 named .png is text: every rule runs
    expect(ruleIds(scanBlob("shot.png", Buffer.from(leakText()), []).findings)).toEqual(
      [...LEAK_RULES].sort(),
    );
    expect(containerKind(png)).toBeNull();
    expect(containerKind(zipOf("a", Buffer.from("x")))?.kind).toBe("zip");
  });

  it("the commit gates refuse the same bytes: --index (pre-commit, commit-paths.sh) and --all (CI)", () => {
    tmp = tempDir("eff-scan-");
    const env = {
      EFF_SCAN_DENYLIST: path.join(tmp.dir, "deny.txt"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    writeFileSync(env.EFF_SCAN_DENYLIST, `${LEAK_ID}\n${LEAK_TEAM}\n`);
    writeFileSync(path.join(tmp.dir, "report.xlsx"), zipOf("xl/sheet1.xml", leakXml()));
    writeFileSync(
      path.join(tmp.dir, "u16.md"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(leakText(), "utf16le")]),
    );
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: tmp?.dir, env: { ...process.env, ...env }, encoding: "utf8" });
    expect(git(["init", "-q"]).status).toBe(0);
    expect(git(["add", "report.xlsx", "u16.md"]).status).toBe(0);
    for (const args of [["--index"], ["--all"]]) {
      const r = scan(tmp.dir, args, env);
      expect(r.status, `${args.join(" ")}: ${r.out}`).toBe(1);
      expect(r.out).toContain("report.xlsx  [unscannable-archive-or-database]");
      expect(r.out).toContain("u16.md:1  [espn-league-id]");
      expect(r.out).toContain("deny-list match in u16.md:1");
      noLeakS7(r.out);
    }
  });
});

describe("S7: UTF-16 and UTF-32 text is decoded, never read as NUL-interleaved UTF-8", () => {
  /** The text's code points (the leak lines are ASCII). */
  const codePoints = (t: string): number[] => {
    const out: number[] = [];
    for (const c of t) out.push(c.codePointAt(0) ?? 0);
    return out;
  };
  const BOM: Record<string, (t: string) => Buffer> = {
    "UTF-16LE with a byte-order mark": (t) =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, "utf16le")]),
    "UTF-16BE with a byte-order mark": (t) =>
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(t, "utf16le").swap16()]),
    "UTF-32LE with a byte-order mark": (t) => {
      const cps = codePoints(t);
      const b = Buffer.alloc(4 + cps.length * 4);
      b.writeUInt32LE(0xfeff, 0);
      cps.forEach((cp, i) => b.writeUInt32LE(cp, 4 + i * 4));
      return b;
    },
    "UTF-32BE with a byte-order mark": (t) => {
      const cps = codePoints(t);
      const b = Buffer.alloc(4 + cps.length * 4);
      b.writeUInt32BE(0xfeff, 0);
      cps.forEach((cp, i) => b.writeUInt32BE(cp, 4 + i * 4));
      return b;
    },
    "UTF-8 with a byte-order mark": (t) =>
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t)]),
  };

  it.each(Object.keys(BOM))(
    "%s: the same findings as UTF-8, line for line, deny-list included",
    (enc) => {
      const want = scanBlob("u.md", Buffer.from(leakText()), DENY()).findings;
      expect(ruleIds(want)).toEqual([...LEAK_RULES].sort());
      expect(want).toContain("deny-list match in u.md:1");
      const got = scanBlob(
        "u.md",
        (BOM[enc] ?? ((t: string) => Buffer.from(t)))(leakText()),
        DENY(),
      );
      expect(got.scanned).toBe(1);
      expect(got.findings).toEqual(want);
    },
  );

  it("the repro over the CLI: u16.md is flagged exactly like u8.md (exit 1, six findings)", () => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "deny.txt"), `${LEAK_ID}\n`);
    writeFileSync(path.join(tmp.dir, "u8.md"), leakText());
    writeFileSync(
      path.join(tmp.dir, "u16.md"),
      (BOM["UTF-16LE with a byte-order mark"] ?? Buffer.from)(leakText()),
    );
    const env = { EFF_SCAN_DENYLIST: path.join(tmp.dir, "deny.txt") };
    const u8 = scan(tmp.dir, ["--", "u8.md"], env);
    const u16 = scan(tmp.dir, ["--", "u16.md"], env);
    expect(u8.status).toBe(1);
    expect(u16.status, u16.out).toBe(1);
    expect(u16.out.replaceAll("u16.md", "F")).toBe(u8.out.replaceAll("u8.md", "F"));
    noLeakS7(u16.out);
  });

  it.each([
    ["UTF-16LE without a byte-order mark", (t: string) => Buffer.from(t, "utf16le")],
    ["UTF-16BE without a byte-order mark", (t: string) => Buffer.from(t, "utf16le").swap16()],
    [
      "UTF-16LE at an odd offset",
      (t: string) => Buffer.concat([Buffer.from("x"), Buffer.from(t, "utf16le")]),
    ],
    [
      "UTF-32LE without a byte-order mark",
      (t: string) =>
        Buffer.concat(
          codePoints(t).map((cp) => {
            const b = Buffer.alloc(4);
            b.writeUInt32LE(cp);
            return b;
          }),
        ),
    ],
    ["values split by stray NUL bytes", (t: string) => Buffer.from(t.split("").join("\0"))],
  ])(
    "%s (ASCII): every rule and the numeric deny-list term still match (NULs removed)",
    (_why, enc) => {
      const r = scanBlob("n.md", enc(leakText()), DENY());
      expect(r.scanned).toBe(1);
      expect(ruleIds(r.findings)).toEqual([...LEAK_RULES].sort());
      expect(r.findings.some((f) => f.startsWith("deny-list match in n.md"))).toBe(true);
      expect(r.findings.every((f) => !f.includes(LEAK_ID))).toBe(true);
    },
  );

  it("a stray NUL in UTF-8 text adds no duplicate finding; a value only visible without NULs is reported on the view", () => {
    const one = scanBlob("a.md", Buffer.from(`intro\n\0\ntoken = ${TOKEN}\n`), []).findings;
    expect(one).toEqual(["a.md:3  [github-token]"]);
    const split = scanBlob(
      "b.md",
      Buffer.from(`token = ${TOKEN.split("").join("\0")}\n`),
      [],
    ).findings;
    expect(split).toEqual(["b.md (NUL bytes removed):1  [github-token]"]);
  });

  it.each([
    ["UTF-16 with a byte-order mark but an odd length", Buffer.from([0xff, 0xfe, 0x41, 0, 0x42])],
    ["UTF-16 with a lone surrogate", Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00])],
    ["UTF-32 with a code point past U+10FFFF", Buffer.from([0xff, 0xfe, 0, 0, 0, 0, 0x11, 0])],
    [
      "UTF-16 without a byte-order mark holding a non-ASCII letter",
      Buffer.from(`café ${LEAK_ID}`, "utf16le"),
    ],
  ])("refuses %s (malformed or undeclared text is not text — fail closed)", (_why, b) => {
    const r = scanBlob("m.md", b, DENY());
    expect(r.scanned).toBe(0);
    expect(r.findings.some((f) => f.startsWith("m.md  [unscannable-archive-or-database]"))).toBe(
      true,
    );
  });

  it("decodeText: the encodings it reads, and null for what it cannot", () => {
    expect(decodeText(Buffer.from("plain"))).toEqual({ encoding: "utf-8", text: "plain" });
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toEqual({
      encoding: "utf-8",
      text: "a",
    });
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x61, 0]))).toEqual({
      encoding: "utf-16le",
      text: "a",
    });
    expect(decodeText(Buffer.from([0xfe, 0xff, 0, 0x61]))).toEqual({
      encoding: "utf-16be",
      text: "a",
    });
    expect(decodeText(Buffer.from([0, 0, 0xfe, 0xff, 0, 0, 0, 0x61]))).toEqual({
      encoding: "utf-32be",
      text: "a",
    });
    expect(decodeText(Buffer.from([0xc3]))).toBeNull();
  });

  it("property: an identifier line is flagged in every encoding a text editor or a shell redirect writes", () => {
    const encoders = [
      (t: string) => Buffer.from(t),
      ...Object.values(BOM),
      (t: string) => Buffer.from(t, "utf16le"),
      (t: string) => Buffer.from(t, "utf16le").swap16(),
    ];
    const word = fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,20}$/);
    fc.assert(
      fc.property(word, word, fc.integer({ min: 0, max: encoders.length - 1 }), (a, b, k) => {
        const line = `${a} ${at("jane.q.fakeperson", "gmail.com")} ${b}\n`;
        const enc = encoders[k] ?? ((t: string) => Buffer.from(t));
        const r = scanBlob("p.md", enc(line), []);
        expect(ruleIds(r.findings)).toContain("email-address");
      }),
      { numRuns: 200 },
    );
  });
});

// Stage C finding scan-utf16-fails-open, its binary half: the deny-list read a skipped binary (and
// refused content) as latin1 only, so a term stored as UTF-16 (EXIF XP* tags, ID3 frames, Windows
// resources) or a non-ASCII term stored as UTF-8 (XMP, PNG iTXt) was never seen. A numeric term
// (the league id) has no skeleton fallback, so in UTF-16 it was missed outright.
describe("the deny-list reads a skipped or refused blob in every byte reading", () => {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  /** A deny-list term with letters outside ASCII (synthetic). */
  const ACCENTED = ["Ñandú", "Rovers"].join(" ");
  const deny = () => parseDenylist(`${LEAK_ID}\n${LEAK_TEAM}\n${ACCENTED}\n`);
  const png = (...parts: Buffer[]) =>
    Buffer.concat([PNG_MAGIC, Buffer.from([0, 0, 0, 13]), ...parts]);
  const utf16be = (s: string) => Buffer.from(s, "utf16le").swap16();

  it.each([
    ["the league id as UTF-16LE", () => Buffer.from(`id ${LEAK_ID} `, "utf16le")],
    ["the league id as UTF-16BE", () => utf16be(`id ${LEAK_ID} `)],
    [
      "the league id as UTF-16LE at an odd offset",
      () => Buffer.concat([Buffer.from([7]), Buffer.from(`id ${LEAK_ID} `, "utf16le")]),
    ],
    ["a non-ASCII team name as UTF-8", () => Buffer.from(`artist=${ACCENTED};`, "utf8")],
    ["a non-ASCII team name as UTF-16LE", () => Buffer.from(`artist=${ACCENTED};`, "utf16le")],
    [
      "a non-ASCII team name as UTF-16BE at an odd offset",
      () => Buffer.concat([Buffer.from([7]), utf16be(`artist=${ACCENTED};`)]),
    ],
  ])(
    "a genuine PNG carrying %s is still skipped, and the deny-list matches it",
    (_label, field) => {
      const r = scanBlob("shot.png", png(field()), deny());
      expect(r.binary).toBe(1);
      expect(r.findings.length).toBeGreaterThanOrEqual(1);
      expect(r.findings.every((f) => /^deny-list match in shot\.png:\d+$/.test(f))).toBe(true);
      noLeakS7(r.findings.join("\n"));
    },
  );

  it("content it refuses is read the same way (a raw deflate stream beside a UTF-16 league id)", () => {
    const blob = Buffer.concat([
      deflateRawSync(Buffer.from("x".repeat(64))),
      Buffer.from(` ${LEAK_ID} `, "utf16le"),
    ]);
    const r = scanBlob("blob.dat", blob, deny());
    expect(r.findings.some((f) => f.includes("[unscannable-archive-or-database]"))).toBe(true);
    expect(r.findings.some((f) => f.startsWith("deny-list match in blob.dat:"))).toBe(true);
  });

  it("one finding per line, whichever readings see it; nothing without a term; nothing printed", () => {
    // ASCII: the latin1, UTF-8 and NUL-free readings all see it — reported once
    const once = scanBlob("shot.png", png(Buffer.from(LEAK_TEAM)), deny());
    expect(once.findings).toEqual(["deny-list match in shot.png:3"]);
    expect(
      scanBlob("shot.png", png(Buffer.from("nothing here", "utf16le")), deny()).findings,
    ).toEqual([]);
    expect(scanBlob("shot.png", png(Buffer.from(LEAK_TEAM)), []).findings).toEqual([]);
  });

  it("rawDenyViews: latin1 and UTF-8 always; without NULs and as UTF-16 (both orders, both alignments) when NULs are there", () => {
    const ascii = Buffer.from("abc");
    expect([...rawDenyViews(ascii)]).toEqual(["abc", "abc"]);
    const le = Buffer.from("Té", "utf16le");
    const views = [...rawDenyViews(le)];
    expect(views).toHaveLength(7);
    expect(views).toContain("Té");
    expect([...rawDenyViews(Buffer.concat([Buffer.from([1]), utf16be("Té")]))]).toContain("Té");
  });
});

// --- gzip: every byte the blob commits is read ----------------------------------------------------
// (Stage C finding scan-gzip-header-trailer-unscanned: the scanner scanned only the decompressed
// member — the header's FNAME/FCOMMENT/FEXTRA and anything after a NUL past the member passed every
// rule and the deny-list, through the hook, commit-paths.sh and --all.) Every value is assembled.

/** A gzip member with the optional header fields RFC 1952 defines (Node's gzipSync writes none). */
function gzipWith(
  data: Buffer,
  o: { name?: string; comment?: string; extra?: Buffer; hcrc?: boolean } = {},
): Buffer {
  let flg = 0;
  const fields: Buffer[] = [];
  if (o.extra !== undefined) {
    flg |= 0x04;
    const xlen = Buffer.alloc(2);
    xlen.writeUInt16LE(o.extra.length);
    fields.push(xlen, o.extra);
  }
  if (o.name !== undefined) {
    flg |= 0x08;
    fields.push(Buffer.from(o.name), Buffer.from([0]));
  }
  if (o.comment !== undefined) {
    flg |= 0x10;
    fields.push(Buffer.from(o.comment), Buffer.from([0]));
  }
  if (o.hcrc) flg |= 0x02;
  const pre = Buffer.concat([Buffer.from([0x1f, 0x8b, 8, flg, 0, 0, 0, 0, 0, 3]), ...fields]);
  const hcrc = Buffer.alloc(o.hcrc ? 2 : 0);
  if (o.hcrc) hcrc.writeUInt16LE(crc32(pre) & 0xffff);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(data), 0);
  trailer.writeUInt32LE(data.length, 4);
  return Buffer.concat([pre, hcrc, deflateRawSync(data), trailer]);
}

describe("gzip: the header's text fields and the bytes after the last member are read", () => {
  const CSV = Buffer.from("week,points\n1,10\n");
  const plainLeak = () =>
    [
      `contact: ${at("jane.q.fakeperson", "gmail.com")}`,
      `https://fantasy.espn.com/football/league?${kv("leagueId", "=", LEAK_ID)}`,
      kv("espn_s2", "=", fakeEspnS2("gz-trailer", 120)),
    ].join("\n");

  it("the test's gzip members are genuine: Node's gunzip reads them, and drops what follows a NUL", () => {
    const named = gzipWith(CSV, {
      name: "x.csv",
      comment: "c",
      extra: Buffer.from("ab"),
      hcrc: true,
    });
    expect(gunzipSync(named).equals(CSV)).toBe(true);
    const padded = Buffer.concat([gzipSync(CSV), Buffer.from([0]), Buffer.from(plainLeak())]);
    expect(gunzipSync(padded).equals(CSV)).toBe(true); // the plaintext is silently discarded
  });

  it.each([
    [
      "a league id in FNAME (gzip's default: the source file's name)",
      () => gzipWith(CSV, { name: `${kv("leagueId", "=", LEAK_ID)}-raw.csv` }),
      "file name",
      "espn-league-id",
    ],
    [
      "a mailbox in FCOMMENT",
      () => gzipWith(CSV, { comment: `from ${at("jane.q.fakeperson", "gmail.com")}` }),
      "comment",
      "email-address",
    ],
    [
      "a member GUID in FEXTRA",
      () => gzipWith(CSV, { extra: Buffer.from(`id={${fakeGuid("fextra")}}`) }),
      "extra field",
      "brace-guid",
    ],
    [
      "a home path in a UTF-8 FNAME with a header CRC",
      () => gzipWith(CSV, { name: `${homePath("Users", "jané")}.csv`, hcrc: true }),
      "file name",
      "home-path",
    ],
  ])("flags %s, labelled by the field; the value is never printed", (_why, make, kind, rule) => {
    const r = scanBlob("excerpt.csv.gz", make(), []);
    expect(r.findings).toContain(`excerpt.csv.gz (gzip ${kind}):1  [${rule}]`);
    expect(r.scanned).toBe(1); // the member's own text is still scanned
    noLeakS7(r.findings.join("\n"));
  });

  it("the same bytes as text are flagged too (the control)", () => {
    const name = `${kv("leagueId", "=", LEAK_ID)}-raw.csv`;
    expect(ruleIds(scanText("ctrl.txt", name, []))).toEqual(["espn-league-id"]);
    expect(scanBlob("excerpt.csv.gz", gzipWith(CSV, { name: "excerpt.csv" }), []).findings).toEqual(
      [],
    );
  });

  it("refuses bytes after the last member — a NUL then plaintext, or plain junk — whatever the name", () => {
    for (const tail of [
      Buffer.concat([Buffer.from([0]), Buffer.from(plainLeak())]),
      Buffer.from(plainLeak()),
      Buffer.alloc(16), // even zero padding: no byte is left unread
    ])
      for (const name of ["notes.csv", "excerpt.csv.gz", "README"]) {
        const r = scanBlob(name, Buffer.concat([gzipSync(CSV), tail]), []);
        expect(
          r.findings.some((f) =>
            f.startsWith(
              `${name}  [unscannable-archive-or-database] (${String(tail.length)} byte(s) follow the last gzip member`,
            ),
          ),
          `${name}: ${r.findings.join(" | ")}`,
        ).toBe(true);
        noLeakS7(r.findings.join("\n"));
      }
  });

  it("reads every member: a second member's header and data are scanned too", () => {
    const two = Buffer.concat([
      gzipWith(CSV, { name: "a.csv" }),
      gzipWith(Buffer.from(`owner={${fakeGuid("member2")}}\n`), {
        name: `${kv("leagueId", "=", LEAK_ID)}.csv`,
      }),
    ]);
    const r = scanBlob("two.csv.gz", two, []);
    expect(r.findings).toContain("two.csv.gz (gzip file name of member 2):1  [espn-league-id]");
    expect(r.findings).toContain("two.csv.gz:3  [brace-guid]"); // member 2's data follows member 1's
    const parsed = gzipMembers(two, 1 << 20);
    expect(parsed.trailing).toBe(0);
    expect(parsed.members.map((m) => m.fields.map((f) => f.kind))).toEqual([
      ["file name"],
      ["file name"],
    ]);
    expect(Buffer.concat(parsed.members.map((m) => m.data)).equals(gunzipSync(two))).toBe(true);
  });

  it("refuses a malformed member (a CRC mismatch, an unterminated name, a truncated stream, a non-deflate method)", () => {
    const good = gzipWith(CSV, { name: "a.csv" });
    const badCrc = Buffer.from(good);
    badCrc.writeUInt32LE((badCrc.readUInt32LE(badCrc.length - 8) ^ 1) >>> 0, badCrc.length - 8);
    const unterminated = Buffer.concat([
      Buffer.from([0x1f, 0x8b, 8, 0x08, 0, 0, 0, 0, 0, 3]),
      Buffer.from("name"),
    ]);
    const truncated = good.subarray(0, good.length - 12);
    const method = Buffer.from(good);
    method[2] = 7;
    for (const [why, b] of [
      ["crc", badCrc],
      ["unterminated", unterminated],
      ["truncated", truncated],
      ["method", method],
    ] as const) {
      expect(() => gzipMembers(b, 1 << 20), why).toThrow();
      expect(
        scanBlob("x.gz", b, []).findings.some((f) =>
          f.startsWith("x.gz  [unscannable-archive-or-database]"),
        ),
        why,
      ).toBe(true);
    }
  });

  it("the deny-list reads the header fields and the outer bytes; the term is never printed", () => {
    const r = scanBlob("roster.csv.gz", gzipWith(CSV, { name: `${LEAK_TEAM} roster.csv` }), DENY());
    expect(r.findings).toContain("deny-list match in roster.csv.gz (gzip file name):1");
    expect(r.findings.some((f) => /^deny-list match in roster\.csv\.gz:\d+$/.test(f))).toBe(true);
    noLeakS7(r.findings.join("\n"));
  });

  it("the Stage C repro over the CLI: notes.csv (gzip + NUL + plaintext) is refused like ctrl.csv is flagged; a named member too", () => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "deny.txt"), `${LEAK_TEAM}\n`);
    writeFileSync(
      path.join(tmp.dir, "notes.csv"),
      Buffer.concat([gzipSync(CSV), Buffer.from([0]), Buffer.from(plainLeak())]),
    );
    writeFileSync(path.join(tmp.dir, "ctrl.csv"), plainLeak());
    writeFileSync(
      path.join(tmp.dir, "excerpt.csv.gz"),
      gzipWith(CSV, { name: `${kv("leagueId", "=", LEAK_ID)}-raw.csv` }),
    );
    writeFileSync(
      path.join(tmp.dir, "fname.csv.gz"),
      gzipWith(CSV, { name: `${LEAK_TEAM} roster.csv` }),
    );
    const r = scan(tmp.dir, ["--", "notes.csv", "ctrl.csv", "excerpt.csv.gz", "fname.csv.gz"], {
      EFF_SCAN_DENYLIST: path.join(tmp.dir, "deny.txt"),
    });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("notes.csv  [unscannable-archive-or-database]");
    expect(r.out).toContain("ctrl.csv:1  [email-address]");
    expect(r.out).toContain("ctrl.csv:2  [espn-league-id]");
    expect(r.out).toContain("ctrl.csv:3  [espn-s2-cookie]");
    expect(r.out).toContain("excerpt.csv.gz (gzip file name):1  [espn-league-id]");
    expect(r.out).toContain("deny-list match in fname.csv.gz (gzip file name):1");
    expect(r.out).not.toContain("scan-secrets: clean");
    noLeakS7(r.out);
  });

  it("the commit gates refuse the same bytes: --index (pre-commit, commit-paths.sh) and --all (CI)", () => {
    tmp = tempDir("eff-scan-");
    const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    writeFileSync(
      path.join(tmp.dir, "notes.csv"),
      Buffer.concat([gzipSync(CSV), Buffer.from([0]), Buffer.from(plainLeak())]),
    );
    writeFileSync(
      path.join(tmp.dir, "excerpt.csv.gz"),
      gzipWith(CSV, { name: `${kv("leagueId", "=", LEAK_ID)}-raw.csv` }),
    );
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: tmp?.dir, env: { ...process.env, ...env }, encoding: "utf8" });
    expect(git(["init", "-q"]).status).toBe(0);
    expect(git(["add", "notes.csv", "excerpt.csv.gz"]).status).toBe(0);
    for (const args of [["--index"], ["--all"]]) {
      const r = scan(tmp.dir, args, env);
      expect(r.status, `${args.join(" ")}: ${r.out}`).toBe(1);
      expect(r.out).toContain("notes.csv  [unscannable-archive-or-database]");
      expect(r.out).toContain("excerpt.csv.gz (gzip file name):1  [espn-league-id]");
      noLeakS7(r.out);
    }
  });
});

// --- paths are published too ------------------------------------------------------------------
// (Stage C finding scan-paths-identifier-rules-skipped: a league-id directory, a member-GUID file
// name and a mailbox in a name committed through the hook; --all was clean; only the deny-list —
// absent in CI — ever looked at a path.) Every value is assembled at run time.
describe("every rule runs over every scanned path; the path is never printed", () => {
  const guid = () => fakeGuid("path-guid");
  const mailbox = () => at("jane.q.fakeperson", "gmail.com");
  const leakPaths = () => [
    `fixtures/espn/${kv("leagues", "/", LEAK_ID)}/{${guid()}}.json`,
    `notes-for-${mailbox()}.md`,
    `exports/${kv("leagueId", "%3D", LEAK_ID)}.json`,
    `backup/${homePath("Users", "janefake", "notes.md").slice(1)}`,
  ];
  const noPathLeak = (out: string) => {
    expect(out).not.toContain(LEAK_ID);
    expect(out).not.toContain(guid());
    expect(out).not.toContain(mailbox());
    expect(out).not.toContain("janefake");
  };

  it("pathFindings: one finding per rule, by entry number; a clean path has none", () => {
    const [a, b, c, d] = leakPaths() as [string, string, string, string];
    expect(pathFindings(a, 1, [])).toEqual([
      "the path of scanned entry #1 (path not printed)  [brace-guid]",
      "the path of scanned entry #1 (path not printed)  [espn-league-id]",
    ]);
    expect(pathFindings(b, 2, [])).toEqual([
      "the path of scanned entry #2 (path not printed)  [email-address]",
    ]);
    expect(pathFindings(c, 3, [])).toEqual([
      "the path of scanned entry #3 (path not printed)  [espn-league-id]",
    ]);
    expect(pathFindings(d, 4, [])).toEqual([
      "the path of scanned entry #4 (path not printed)  [home-path]",
    ]);
    expect(pathFindings("fixtures/espn/recorded/league-a/mBoxscore.sp1.json", 5, [])).toEqual([]);
    expect(pathFindings("docs/notes-é.md", 6, DENY())).toEqual([]);
    expect(pathFindings(`docs/${LEAK_TEAM.replace(" ", "-")}.md`, 7, DENY())).toEqual([
      "deny-list match in the path of scanned entry #7 (path not printed)",
    ]);
  });

  it("refuses those paths in --index, --all and positional mode (the content is clean); nothing printed", () => {
    tmp = tempDir("eff-scan-");
    const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    for (const p of leakPaths()) {
      mkdirSync(path.dirname(path.join(tmp.dir, p)), { recursive: true });
      writeFileSync(path.join(tmp.dir, p), "{}\n");
    }
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: tmp?.dir, env: { ...process.env, ...env }, encoding: "utf8" });
    expect(git(["init", "-q"]).status).toBe(0);
    expect(git(["add", "-A"]).status).toBe(0);
    for (const args of [
      ["--index"],
      ["--all"],
      ["--", ...leakPaths()],
      ["--staged", "--", ...leakPaths()],
    ]) {
      const r = scan(tmp.dir, args, env);
      expect(r.status, `${args.join(" ")}: ${r.out}`).toBe(1);
      for (const rule of ["espn-league-id", "brace-guid", "email-address", "home-path"])
        expect(r.out, `${args[0] ?? ""} ${rule}`).toMatch(
          new RegExp(`the path of scanned entry #\\d+ \\(path not printed\\)  \\[${rule}\\]`),
        );
      noPathLeak(r.out);
    }
    // the same strings as file content are flagged by the same rules (the control)
    writeFileSync(path.join(tmp.dir, "content.md"), `${leakPaths().join("\n")}\n`);
    const c = scan(tmp.dir, ["--", "content.md"], env);
    for (const rule of ["espn-league-id", "brace-guid", "email-address", "home-path"])
      expect(c.out).toContain(`[${rule}]`);
  });

  it("a submodule entry has no blob, but its staged PATH is checked too (--index)", () => {
    tmp = tempDir("eff-scan-");
    const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: tmp?.dir, env: { ...process.env, ...env }, encoding: "utf8" });
    expect(git(["init", "-q"]).status).toBe(0);
    const commit = "a".repeat(40); // a gitlink's commit id: never read, no blob exists
    const gitlink = `vendor/${kv("leagueId", "=", LEAK_ID)}`;
    expect(
      git(["update-index", "--add", "--cacheinfo", `160000,${commit},${gitlink}`]).status,
    ).toBe(0);
    const r = scan(tmp.dir, ["--index"], env);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("the path of scanned entry #1 (path not printed)  [espn-league-id]");
    noPathLeak(r.out);
    // a clean gitlink path passes: nothing is read for it
    const c = tempDir("eff-scan-");
    try {
      const g2 = (args: string[]) =>
        spawnSync("git", args, { cwd: c.dir, env: { ...process.env, ...env }, encoding: "utf8" });
      expect(g2(["init", "-q"]).status).toBe(0);
      expect(
        g2(["update-index", "--add", "--cacheinfo", `160000,${commit},vendor/lib`]).status,
      ).toBe(0);
      expect(scan(c.dir, ["--index"], env).status).toBe(0);
    } finally {
      c.cleanup();
    }
  });

  it("a commit message is not a path: COMMIT_MESSAGE is never path-checked", () => {
    tmp = tempDir("eff-scan-");
    writeFileSync(path.join(tmp.dir, "MSG"), "feat: x\n");
    const r = scan(tmp.dir, ["--message", "MSG"]);
    expect(r.status, r.out).toBe(0);
  });
});
