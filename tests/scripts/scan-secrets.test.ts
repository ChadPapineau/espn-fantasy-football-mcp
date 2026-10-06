// scan-secrets.test.ts — scripts/dev/scan-secrets.mjs is the ONLY layer that runs before a value
// reaches the public repo (gitleaks runs in CI, after the push), so every ESPN rule must fire at its
// boundary, the placeholders must pass, the deny-list must match without ever printing its terms,
// and it must fail closed on anything it cannot scan (CLAUDE.md "Security"; plan 04 §4.1 R11, §4.3).
// Adapted from the sibling's tests/lint/scan-secrets.test.ts (@d72e03b). Every well-formed value
// below is ASSEMBLED AT RUN TIME so this file itself stays clean for both scanners.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  FAKE_GUID,
  SKELETON_MIN,
  decodeLayers,
  skeleton,
  denylistLines,
  entropy,
  isGithubNoreply,
  isPlaceholderEmail,
  looksLikeBareEspnS2,
  normalise,
  parseDenylist,
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
