// log.test.ts — src/cli/log.ts (plan 01 §2 stdout discipline, §8 redaction; plan 02 §2.3; plan 05
// §2 `cli/log`, property: for any object containing the stored espn_s2 in its pasted or its decoded
// form (ADV OBJ-15), any brace-GUID, any IPv4, the configured league id, or a `Cookie:` header line,
// the emitted line contains none of them; bodies truncated to 500 after HTML stripping; never
// writes to stdout). A 100 %-coverage module (plan 05 §7). Ported from sibling @d72e03b, adapted.
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEspnS2, fakeGuid, fakeIpv4, fakeLeagueId } from "../../scripts/ci/secret-fixtures.mjs";
import {
  DEFAULT_MAX_STRING,
  HARD_MAX_STRING,
  LOG_FILTER_MAX_CHARS,
  MIN_SECRET_LENGTH,
  PRECUT_SLACK,
  REDACTION_PATTERNS,
  SecretRegistry,
  createLogger,
  guidPseudonym,
  redactAndTruncate,
  redactString,
  redactValue,
  stripHtmlForLog,
  truncate,
  type Logger,
} from "../../src/cli/log.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TS = "2026-10-05T18:00:00.000Z";
const J = (...p: string[]) => p.join("");
// every credential-shaped value is generated at run time (never a literal in the repo)
const S2 = fakeEspnS2("log-test", 260);
const S2_DECODED = decodeURIComponent(S2);
const GUID = fakeGuid("log-test");
const GUID_BRACED = `{${GUID}}`;
const IP = fakeIpv4("log-test");
const LEAGUE = fakeLeagueId("log-test", 9);
const FAKE = {
  jwt: J("eyJ", "a".repeat(16), ".eyJ", "b".repeat(16), ".", "c".repeat(16)),
  github: J("gh", "p_", "A".repeat(36)),
  anthropic: J("sk-", "ant-", "C".repeat(30)),
  openai: J("sk-", "D".repeat(40)),
  aws: J("AK", "IA", "E".repeat(16)),
  slack: J("xo", "xb-", "1".repeat(12)),
  google: J("AI", "za", "F".repeat(35)),
  email: J("someone", "@", "example", ".org"),
};

function capture(level: "error" | "warn" | "info" | "debug" = "debug"): {
  log: Logger;
  lines: () => Record<string, unknown>[];
  raw: string[];
} {
  const raw: string[] = [];
  const log = createLogger({ level, sink: (l) => raw.push(l), now: () => TS });
  return { log, raw, lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("line format and levels", () => {
  it("writes one JSON object per line with ts, level, event, then the plan 01 §8 fields", () => {
    const { log, raw, lines } = capture();
    log.info("tool.done", {
      request_id: "r-0123456789ab",
      tool: "espn_get_roster",
      ms: 12,
      cache: "hit",
      view: "mRoster",
      upstream_status: 200,
      msg: "line1\nline2",
    });
    expect(raw).toHaveLength(1);
    expect(raw[0]).not.toContain("\n");
    expect(lines()[0]).toEqual({
      ts: TS,
      level: "info",
      event: "tool.done",
      request_id: "r-0123456789ab",
      tool: "espn_get_roster",
      ms: 12,
      cache: "hit",
      view: "mRoster",
      upstream_status: 200,
      msg: "line1\nline2",
    });
  });
  it.each([
    ["error", ["error"]],
    ["warn", ["error", "warn"]],
    ["info", ["error", "warn", "info"]],
    ["debug", ["error", "warn", "info", "debug"]],
  ] as const)("level %s emits %j", (level, expected) => {
    const { log, lines } = capture(level);
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(lines().map((l) => l.level)).toEqual(expected);
    expect(log.level).toBe(level);
  });
  it("fields cannot overwrite ts/level/event; a bad event name is replaced", () => {
    const { log, lines } = capture();
    log.info("Bad Event!\u202e", { ts: "forged", level: "error", event: "forged", ok: 1 });
    expect(lines()[0]).toEqual({ ts: TS, level: "info", event: "invalid_event", ok: 1 });
  });
  it("defaults the timestamp to the wall clock and the string cap to 500", () => {
    const raw: string[] = [];
    createLogger({ level: "info", sink: (l) => raw.push(l) }).info("x", { v: "y".repeat(600) });
    const line = JSON.parse(raw[0] ?? "{}") as { ts: string; v: string };
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(line.v).toBe(`${"y".repeat(500)}…[truncated 100 chars]`);
    const small: string[] = [];
    createLogger({
      level: "info",
      sink: (l) => small.push(l),
      maxStringChars: LOG_FILTER_MAX_CHARS,
    }).info("f", {
      filter: "z".repeat(300),
    });
    expect((JSON.parse(small[0] ?? "{}") as { filter: string }).filter).toBe(
      `${"z".repeat(200)}…[truncated 100 chars]`,
    );
  });
  it("child loggers bind fields and share both registries both ways", () => {
    const { log, lines } = capture();
    const child = log.child({ request_id: "r-aaaaaaaaaaaa", tool: "espn_get_status" });
    child.registerSecret("espn_s2", S2);
    log.registerIdentifier("league", LEAGUE);
    log.info("parent", { v: S2, url: `leagueId ${LEAGUE}` });
    child.info("child", { v: `x ${LEAGUE} y` });
    const [p, c] = lines();
    expect(JSON.stringify(p)).not.toContain(S2.slice(0, 30));
    expect(p?.url).toBe("leagueId [league]");
    expect(c).toMatchObject({
      request_id: "r-aaaaaaaaaaaa",
      tool: "espn_get_status",
      v: "x [league] y",
    });
  });
});

describe("registered secrets: the stored espn_s2 in its pasted, encoded and decoded forms (ADV OBJ-15)", () => {
  it("redacts every form, inside strings, keys, arrays and errors", () => {
    const r = new SecretRegistry();
    r.add("espn_s2", S2);
    expect(S2_DECODED).not.toBe(S2);
    for (const form of [S2, S2_DECODED, encodeURIComponent(S2)]) {
      const out = JSON.stringify(
        redactValue({ a: `x${form}y`, [form]: 1, arr: [form], err: new Error(form) }, r),
      );
      expect(out).not.toContain(form.slice(0, 30));
      expect(out).toContain("[redacted:espn_s2]");
    }
  });
  it("survives a value whose percent escapes do not decode", () => {
    const r = new SecretRegistry();
    r.add("espn_s2", "abc%E0%A4%Azzz");
    expect(r.apply("token abc%E0%A4%Azzz end")).toBe("token [redacted:espn_s2] end");
  });
  it("redacts the longer of two overlapping secrets fully", () => {
    const r = new SecretRegistry();
    r.add("a", "secret-value");
    r.add("b", "secret-value-longer");
    expect(r.apply("x secret-value-longer y")).toBe("x [redacted:b] y");
    expect(r.longest).toBe("secret-value-longer".length);
  });
  it("ignores < 4-char values, de-duplicates, and sanitises the kind", () => {
    const r = new SecretRegistry();
    r.add("k", "abc");
    expect(r.size).toBe(0);
    expect(r.longest).toBe(0);
    r.add("Bad Kind!", "abcd");
    r.add("again", "abcd");
    expect(r.size).toBe(1);
    expect(r.apply("abcd")).toBe("[redacted:secret]");
    expect(MIN_SECRET_LENGTH).toBe(4);
  });
  it("property: a registered espn_s2 embedded anywhere never appears, in any form", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }),
        fc.string({ maxLength: 30 }),
        fc.constantFrom(S2, S2_DECODED),
        fc.constantFrom("msg", "header", "body", "nested"),
        (pre, post, form, key) => {
          const { log, raw } = capture();
          log.registerSecret("espn_s2", S2);
          const value = `${pre}${form}${post}`;
          log.info("x", key === "nested" ? { deep: { list: [value] } } : { [key]: value });
          return !raw.join("").includes(form.slice(0, 40));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("ESPN pattern redaction (plan 01 §8; plan 02 §2.3)", () => {
  const r = () => new SecretRegistry();
  it("Cookie and Set-Cookie headers wholesale, in header and JSON-ish form", () => {
    for (const line of [
      `Cookie: espn_s2=${S2}; SWID=${GUID_BRACED}`,
      `set-cookie: espn_s2=${S2}; Path=/; HttpOnly`,
      `"Cookie": "espn_s2=${S2}"`,
      `cookie=espn_s2%3D${S2}`,
    ]) {
      const out = redactString(line, r());
      expect(out).toContain("[redacted:cookie]");
      expect(out).not.toContain(S2.slice(0, 30));
      expect(out).not.toContain(GUID);
    }
  });
  it("espn_s2= and SWID= assignments without registration", () => {
    expect(redactString(`espn_s2=${S2}&x=1`, r())).toBe("espn_s2=[redacted:espn_s2]&x=1");
    expect(redactString(`ESPN-S2: ${S2}`, r())).toBe("ESPN-S2: [redacted:espn_s2]");
    expect(redactString(`swid=%7B${GUID}%7D; next`, r())).toBe("swid=[redacted:swid]; next");
  });
  it("every brace-GUID becomes a stable {guid:<6 hex>} pseudonym, raw or URL-encoded", () => {
    const out = redactString(
      `owner ${GUID_BRACED} and ${GUID_BRACED.toLowerCase()} and %7B${GUID}%7D`,
      r(),
    );
    expect(out).not.toContain(GUID);
    const ps = out.match(/\{guid:[0-9a-f]{6}\}/g) ?? [];
    expect(ps).toHaveLength(3);
    expect(new Set(ps).size).toBe(1);
    expect(guidPseudonym(GUID_BRACED)).toBe(ps[0]);
    expect(guidPseudonym(`{${fakeGuid("other")}}`)).not.toBe(ps[0]);
    expect(redactString("{00000000-0000-4000-8000-000000000001}", r())).toMatch(
      /^\{guid:[0-9a-f]{6}\}$/,
    );
  });
  it("IPv4 and IPv6 literals become [ip]; versions and clock times do not", () => {
    expect(redactString(`clientAddress ${IP} done`, r())).toBe("clientAddress [ip] done");
    expect(redactString(`from ${fakeIpv4("log-test-2")} and 0.0.0.0`, r())).toBe(
      "from [ip] and [ip]",
    );
    expect(redactString("node 24.21.0 at 2026-10-05T12:34:56.789Z", r())).toBe(
      "node 24.21.0 at 2026-10-05T12:34:56.789Z",
    );
    expect(redactString("bad 256.1.1.1 octet", r())).toBe("bad 256.1.1.1 octet");
    for (const v6 of [
      "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      "fe80::1",
      "::1",
      "2001:db8::8a2e:370:7334",
    ])
      expect(redactString(`addr ${v6} x`, r()), v6).toBe("addr [ip] x");
    expect(redactString("time 12:34:56 and std::vector", r())).toBe(
      "time 12:34:56 and std::vector",
    );
  });
  it("league ids: registered ones as whole digit runs; ESPN league paths and leagueId= always", () => {
    const reg = r();
    reg.addIdentifier("league", LEAGUE);
    expect(reg.apply(`league ${LEAGUE}.`)).toBe("league [league].");
    expect(reg.apply(`1${LEAGUE}`)).toBe(`1${LEAGUE}`);
    expect(reg.apply(`${LEAGUE}9`)).toBe(`${LEAGUE}9`);
    expect(
      redactString(
        `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/${fakeLeagueId("p", 7)}?view=mRoster`,
        r(),
      ),
    ).toBe(
      "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/[league]",
    );
    expect(redactString(`leagueId=${fakeLeagueId("q", 6)}`, r())).toBe("leagueId=[league]");
    expect(redactString(`"league_id": "${fakeLeagueId("q2", 8)}"`, r())).toBe(
      '"league_id": "[league]"',
    );
    expect(redactString(`leagueHistory/${fakeLeagueId("q3", 8)}`, r())).toBe(
      "leagueHistory/[league]",
    );
  });
  it("other identifiers (team names) are replaced whole; a bad kind reads identifier", () => {
    const reg = r();
    reg.addIdentifier("team_name", "Team A Placeholder");
    reg.addIdentifier("Bad Kind", "Team B Placeholder");
    expect(reg.apply("for Team A Placeholder and Team B Placeholder")).toBe(
      "for [redacted:team_name] and [redacted:identifier]",
    );
  });
  it("URLs keep scheme, host and path; lose userinfo, query and fragment (the odds key rides in a query)", () => {
    expect(
      redactString("GET https://user:pw@api.the-odds-api.com/v4/sports?apiKey=abc123#frag x", r()),
    ).toBe("GET https://api.the-odds-api.com/v4/sports x");
  });
  it("generic token shapes, authorization headers, params and JSON secret fields", () => {
    for (const v of Object.values(FAKE)) {
      expect(redactString(`x ${v} y`, r()), v).not.toContain(v);
    }
    expect(redactString("Authorization: Bearer abcdefghijklmnop", r())).toBe(
      "Authorization: [redacted:authorization]",
    );
    expect(redactString("token Bearer abcdefghijkl1234", r())).toBe(
      "token Bearer [redacted:token]",
    );
    expect(redactString("password=hunter22&ok=1", r())).toBe("password=[redacted]&ok=1");
    expect(redactString('{"espn_s2":"abc","swid":"def","ok":"x"}', r())).toBe(
      '{"espn_s2":"[redacted]","swid":"[redacted]","ok":"x"}',
    );
    expect(
      redactString(
        J("-----BEGIN", " RSA PRIVATE KEY-----\nMIIx\n-----END RSA PRIVATE KEY-----"),
        r(),
      ),
    ).toBe("[redacted:private_key]");
  });
  it("leaves ordinary text alone, and every pattern is global", () => {
    expect(redactString("Team A beat Team B 112.4 to 98.1 in week 4", r())).toBe(
      "Team A beat Team B 112.4 to 98.1 in week 4",
    );
    for (const rule of REDACTION_PATTERNS) expect(rule.re.flags, rule.id).toContain("g");
  });
  it("property: GUIDs, IPv4s, league paths and Cookie lines never survive", () => {
    const hex = fc.stringMatching(/^[0-9A-F]{32}$/);
    fc.assert(
      fc.property(
        hex,
        fc.nat(255),
        fc.nat(255),
        fc.integer({ min: 1000, max: 999_999_999 }),
        fc.string({ maxLength: 20 }),
        (h, a, b, id, noise) => {
          const guid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
          const ip = [10, a, b, 7].join(".");
          const s = `${noise} {${guid}} ${ip} /leagues/${String(id)} \nCookie: SWID={${guid}}`;
          const out = redactString(s, r());
          return (
            !out.includes(guid) && !out.includes(ip) && !out.includes(`/leagues/${String(id)}`)
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("object-key redaction and value shaping", () => {
  const reg = new SecretRegistry();
  it("redacts whole values under secret-named keys (a component match, not a substring)", () => {
    expect(
      redactValue(
        {
          headers: { Cookie: "c", "Set-Cookie": "s", Authorization: "a", "X-Api-Key": "k" },
          espn_s2: "x",
          SWID: "y",
          password: "p",
          refresh_token: { nested: "t" },
          email: "e",
          private_key: "pk",
          token: null,
          api_key: undefined,
          credential_state: "rejected",
          tokens_used: 3,
          ok: "fine",
        },
        reg,
      ),
    ).toEqual({
      headers: {
        Cookie: "[redacted]",
        "Set-Cookie": "[redacted]",
        Authorization: "[redacted]",
        "X-Api-Key": "[redacted]",
      },
      espn_s2: "[redacted]",
      SWID: "[redacted]",
      password: "[redacted]",
      refresh_token: "[redacted]",
      email: "[redacted]",
      private_key: "[redacted]",
      token: null,
      api_key: null,
      credential_state: "rejected",
      tokens_used: 3,
      ok: "fine",
    });
  });
  it("truncates to 500 with the dropped count, never splitting a surrogate pair", () => {
    expect(redactValue("x".repeat(600), reg)).toBe(`${"x".repeat(500)}…[truncated 100 chars]`);
    expect(truncate("short", 10)).toBe("short");
    expect(truncate(`${"a".repeat(499)}\u{1F600}tail`, 500)).toBe(
      `${"a".repeat(499)}…[truncated 6 chars]`,
    );
    expect(DEFAULT_MAX_STRING).toBe(500);
  });
  it("drops a string beyond the hard maximum without scanning it", () => {
    const huge = "q".repeat(HARD_MAX_STRING + 1);
    expect(redactValue(huge, reg)).toBe(`[dropped ${String(huge.length)} chars]`);
  });
  it("makes every JSON-hostile value inert", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(
      redactValue(
        {
          n: Number.NaN,
          inf: -Infinity,
          big: 12n,
          und: undefined,
          fn: () => 1,
          sym: Symbol("s"),
          date: new Date("2026-10-05T00:00:00Z"),
          bad: new Date("nope"),
          buf: Buffer.from("secret bytes"),
          ab: new ArrayBuffer(8),
          map: new Map([["k", "v"]]),
          set: new Set([1, 2]),
          bool: true,
          nul: null,
          circular,
        },
        reg,
      ),
    ).toEqual({
      n: "NaN",
      inf: "-Infinity",
      big: "12",
      und: null,
      fn: "[function]",
      sym: "[symbol]",
      date: "2026-10-05T00:00:00.000Z",
      bad: "[invalid date]",
      buf: "[binary 12 bytes]",
      ab: "[binary 8 bytes]",
      map: "[Map of 1]",
      set: "[Set of 2]",
      bool: true,
      nul: null,
      circular: { a: 1, self: "[circular]" },
    });
  });
  it("reduces Errors to name/message/code (no stack)", () => {
    expect(redactValue(Object.assign(new Error("boom"), { code: "ENOENT" }), reg)).toEqual({
      name: "Error",
      message: "boom",
      code: "ENOENT",
    });
    expect(redactValue(Object.assign(new Error("x"), { code: 7 }), reg)).toEqual({
      name: "Error",
      message: "x",
      code: 7,
    });
    expect(redactValue(Object.assign(new Error("x"), { code: { o: 1 } }), reg)).toEqual({
      name: "Error",
      message: "x",
    });
  });
  it("bounds depth, array length and key count; caps key length", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 12; i++) deep = { d: deep };
    expect(JSON.stringify(redactValue(deep, reg))).toContain("[depth limit]");
    const arr = redactValue(
      Array.from({ length: 60 }, (_, i) => i),
      reg,
    ) as unknown[];
    expect(arr).toHaveLength(51);
    expect(arr.at(-1)).toBe("[+10 more]");
    const w = redactValue(
      Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`k${String(i)}`, i])),
      reg,
    ) as Record<string, unknown>;
    expect(Object.keys(w)).toHaveLength(51);
    expect(w["[more_keys]"]).toBe(5);
    const out = redactValue({ ["k".repeat(100)]: 1 }, reg) as Record<string, unknown>;
    expect(Object.keys(out)[0]?.startsWith("k".repeat(64))).toBe(true);
  });
  it("stripHtmlForLog removes markup before the body is truncated", () => {
    expect(
      stripHtmlForLog(
        "<html><head><style>p{}</style></head><body><h1>Denied</h1>\n<p>reason</p></body></html>",
      ),
    ).toBe("Denied reason");
    const { log, lines } = capture();
    log.warn("upstream.body", { body: stripHtmlForLog(`<p>${"x".repeat(900)}</p>`) });
    expect(String(lines()[0]?.body)).toMatch(/^x{500}…\[truncated 400 chars\]$/);
  });
});

describe("never breaks a caller", () => {
  it("a throwing sink drops the line silently", () => {
    const log = createLogger({
      level: "info",
      sink: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => {
      log.info("x", { a: 1 });
    }).not.toThrow();
  });
  it("a hostile getter in the fields drops the line silently", () => {
    const { log, raw } = capture();
    const hostile = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter");
      },
    });
    expect(() => {
      log.info("x", hostile);
    }).not.toThrow();
    expect(raw).toEqual([]);
  });
});

describe("stdout is the MCP transport: never written", () => {
  it("the default sink writes to stderr only, guarded against EPIPE once", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write");
    const log = createLogger({ level: "debug" });
    log.error("a");
    log.debug("b", { v: 1 });
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
    const first = String(err.mock.calls[0]?.[0]);
    expect(first.endsWith("\n")).toBe(true);
    expect(JSON.parse(first)).toMatchObject({ level: "error", event: "a" });
    expect(process.stderr.listenerCount("error")).toBeGreaterThan(0);
    expect(() =>
      process.stderr.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    ).not.toThrow();
  });
  it("in a real process: stdout stays empty, and a closed stderr pipe does not crash it", async () => {
    const mod = pathToFileURL(path.join(ROOT, "src", "cli", "log.ts")).href;
    const script = `
      const { createLogger } = await import(${JSON.stringify(mod)});
      const log = createLogger({ level: "debug" });
      log.registerSecret("espn_s2", ${JSON.stringify(S2)});
      for (let i = 0; i < 1000; i++) log.info("tick", { i, cookie: "x", v: ${JSON.stringify(S2)} });
      await new Promise((r) => setTimeout(r, 50));
      for (let i = 0; i < 1000; i++) log.info("tock", { i });
    `;
    const run = (closeStderr: boolean) =>
      new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
        if (closeStderr) child.stderr.destroy();
        else child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("close", (code, signal) => {
          resolve({ code, signal, stdout, stderr });
        });
      });
    const open = await run(false);
    expect(open.code).toBe(0);
    expect(open.stdout).toBe("");
    expect(open.stderr.split("\n").filter((l) => l.startsWith("{"))).toHaveLength(2000);
    expect(open.stderr).not.toContain(S2.slice(0, 30));
    const closed = await run(true);
    expect(closed.signal).toBeNull();
    expect(closed.code).toBe(0);
    expect(closed.stdout).toBe("");
  }, 30_000);
});

describe("linear-time redaction (every quantifier bounded)", () => {
  const time = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  it("1 MB hostile fields log fast", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", sink: (l) => lines.push(l), now: () => TS });
    const inputs = [
      "a".repeat(1_000_000),
      `a@${"b.".repeat(300_000)}`,
      "1.".repeat(500_000),
      ":".repeat(500_000),
      "f:".repeat(400_000),
      "{".repeat(500_000),
      "cookie:".repeat(100_000),
      "espn_s2=".repeat(100_000),
      "leagues/".repeat(100_000),
      "https://".repeat(100_000),
    ];
    for (const v of inputs)
      expect(
        time(() => {
          log.info("big", { v });
        }),
      ).toBeLessThan(250);
    expect(lines).toHaveLength(inputs.length);
  });
  it("pre-cut cannot let a registered secret survive in the kept prefix", () => {
    const r = new SecretRegistry();
    const secret = J("SEC", "q".repeat(40), "RET");
    r.add("espn_s2", secret);
    const max = 100;
    for (let at = max - secret.length - 2; at <= max + 2; at++) {
      const s = `${"a".repeat(Math.max(0, at))}${secret}${"z".repeat(PRECUT_SLACK * 3)}`;
      const out = redactAndTruncate(s, r, max);
      expect(out).not.toContain(secret.slice(0, 12));
      expect(out).toMatch(/…\[truncated \d+ chars\]$/);
    }
  });
  it("a long value is cut with the ORIGINAL length reported, surrogates never split", () => {
    const r = new SecretRegistry();
    const s = `${"x".repeat(DEFAULT_MAX_STRING - 1)}\u{1F600}${"y".repeat(20_000)}`;
    const out = redactAndTruncate(s, r, DEFAULT_MAX_STRING);
    expect(out.startsWith("x".repeat(DEFAULT_MAX_STRING - 1))).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(Number(/truncated (\d+) chars/.exec(out)?.[1])).toBe(
      s.length - (DEFAULT_MAX_STRING - 1),
    );
    expect(redactAndTruncate("hello", r, DEFAULT_MAX_STRING)).toBe("hello");
  });
  it("a redaction that shrinks the pre-cut prefix below the cap still reports truncation", () => {
    const out = redactAndTruncate(
      `Bearer ${"t".repeat(PRECUT_SLACK * 2)}`,
      new SecretRegistry(),
      DEFAULT_MAX_STRING,
    );
    expect(out).toContain("[redacted:token]");
    expect(out).toMatch(/truncated \d+ chars\]$/);
  });
});
