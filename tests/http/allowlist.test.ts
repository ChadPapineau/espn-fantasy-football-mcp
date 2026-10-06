// allowlist.test.ts — plan 02 S12 + §7.1: the read host (default or the EFF_ESPN_READ_HOST override
// under ^[a-z0-9-]+\.fantasy\.espn\.com$), the data-source hosts, never the write host (refused by
// importing config's constant — the literal is spelled only in src/config/schema.ts), exact matches
// only, and log URLs without query strings or league ids.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ESPN_READ_HOST_DEFAULT,
  ESPN_WRITE_HOST,
  isAllowedReadHost,
} from "../../src/config/schema.js";
import {
  allowListFor,
  checkUrl,
  DATA_SOURCE_HOSTS,
  espnReadHostFrom,
  isWriteHost,
  MAX_URL_CHARS,
  narrowAllowList,
  redactUrl,
} from "../../src/http/allowlist.js";
import { HttpError } from "../../src/http/errors.js";

const WRITE_LABEL = ESPN_WRITE_HOST.split(".")[0] ?? "";

describe("the read-host override rule (plan 02 S12; ADV OBJ-06)", () => {
  it("undefined → the documented default", () => {
    expect(espnReadHostFrom()).toBe(ESPN_READ_HOST_DEFAULT);
  });

  it.each([
    "lm-api-reads.fantasy.espn.com",
    "fantasy-reads2.fantasy.espn.com",
    "a.fantasy.espn.com",
    "x9-y.fantasy.espn.com",
  ])("accepts %s", (h) => {
    expect(espnReadHostFrom(h)).toBe(h);
  });

  it.each([
    ["the write host", ESPN_WRITE_HOST],
    ["a write-family sibling", `${WRITE_LABEL}2.fantasy.espn.com`],
    ["a bare fantasy.espn.com", "fantasy.espn.com"],
    ["two labels deep", "a.b.fantasy.espn.com"],
    ["another espn host", "www.espn.com"],
    ["a suffix trick", "lm-api-reads.fantasy.espn.com.evil.example"],
    ["a prefix trick", "evilfantasy.espn.com"],
    ["upper case", "LM-API-READS.fantasy.espn.com"],
    ["a trailing dot", "lm-api-reads.fantasy.espn.com."],
    ["a port", "lm-api-reads.fantasy.espn.com:443"],
    ["a scheme", "https://lm-api-reads.fantasy.espn.com"],
    ["a leading hyphen", "-x.fantasy.espn.com"],
    ["an underscore", "a_b.fantasy.espn.com"],
    ["unicode", "lm-api-rеads.fantasy.espn.com"],
    ["empty", ""],
    ["whitespace", " lm-api-reads.fantasy.espn.com"],
    ["a newline", "lm-api-reads.fantasy.espn.com\n"],
  ])("refuses %s", (_what, h) => {
    expect(() => espnReadHostFrom(h)).toThrow(RangeError);
  });

  it("property: whatever is accepted is one label under fantasy.espn.com and agrees with config", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        let accepted = false;
        try {
          espnReadHostFrom(s);
          accepted = true;
        } catch (e) {
          expect(e).toBeInstanceOf(RangeError);
        }
        if (accepted) {
          expect(s).toMatch(/^[a-z0-9-]+\.fantasy\.espn\.com$/);
          expect(isWriteHost(s)).toBe(false);
        }
        expect(accepted).toBe(isAllowedReadHost(s) && !isWriteHost(s));
      }),
      { numRuns: 500 },
    );
  });

  it("property: a random label is accepted iff it is a valid DNS label not in the write family", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9-]{1,20}$/), (label) => {
        const host = `${label}.fantasy.espn.com`;
        const valid =
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) && !label.startsWith(WRITE_LABEL);
        if (valid) expect(espnReadHostFrom(host)).toBe(host);
        else expect(() => espnReadHostFrom(host)).toThrow(RangeError);
      }),
      { numRuns: 500 },
    );
  });
});

describe("allowListFor / isWriteHost", () => {
  it("the full list is the read host plus the data-source hosts — never the write host", () => {
    const list = allowListFor(ESPN_READ_HOST_DEFAULT);
    expect(list).toEqual([ESPN_READ_HOST_DEFAULT, ...DATA_SOURCE_HOSTS]);
    expect(list.some((h) => isWriteHost(h))).toBe(false);
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(DATA_SOURCE_HOSTS)).toBe(true);
    expect(() => allowListFor(ESPN_WRITE_HOST)).toThrow(RangeError);
  });

  it("isWriteHost: the host, its family, any case, a trailing dot", () => {
    expect(isWriteHost(ESPN_WRITE_HOST)).toBe(true);
    expect(isWriteHost(ESPN_WRITE_HOST.toUpperCase())).toBe(true);
    expect(isWriteHost(`${ESPN_WRITE_HOST}.`)).toBe(true);
    expect(isWriteHost(`${WRITE_LABEL}-v2.example`)).toBe(true);
    expect(isWriteHost(ESPN_READ_HOST_DEFAULT)).toBe(false);
    expect(isWriteHost("github.com")).toBe(false);
  });

  it("the write-host literal is never spelled in src/http (config's constant is imported)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../../src/http/", import.meta.url);
    for (const f of readdirSync(dir))
      expect(readFileSync(new URL(f, dir), "utf8"), f).not.toContain(WRITE_LABEL);
  });
});

describe("checkUrl", () => {
  const allow = allowListFor(ESPN_READ_HOST_DEFAULT);
  it.each([
    ["http://github.com/x", "scheme_refused"],
    ["https://github.com:8443/x", "scheme_refused"],
    ["ftp://github.com/x", "scheme_refused"],
    ["https://user:pw@github.com/x", "credentials_refused"],
    ["https://u:@github.com/x", "credentials_refused"],
    ["https://api.weather.gov@evil.example/x", "credentials_refused"],
    ["https://evil.example/x", "host_not_allowed"],
    ["https://github.com.evil.example/x", "host_not_allowed"],
    ["https://evilgithub.com/x", "host_not_allowed"],
    ["https://github.com./x", "host_not_allowed"],
    ["https://127.0.0.1/x", "host_not_allowed"],
    ["https://[::1]/x", "host_not_allowed"],
    ["https://localhost/x", "host_not_allowed"],
    ["https://gіthub.com/x", "host_not_allowed"],
    ["https://www.espn.com/fantasy/", "host_not_allowed"],
    ["https://fantasy.espn.com/x", "host_not_allowed"],
    [`https://${ESPN_WRITE_HOST}/apis/v3/games/ffl`, "host_not_allowed"],
    ["https://api.sleeper.app/v1/state/nfl", "host_not_allowed"],
    ["not a url", "invalid_url"],
    ["", "invalid_url"],
    [`https://github.com/${"a".repeat(MAX_URL_CHARS)}`, "invalid_url"],
  ])("%s → %s", (url, kind) => {
    try {
      checkUrl(url, allow);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).kind).toBe(kind);
    }
  });

  it("the write host is refused even when a caller puts it on the list", () => {
    expect(() => checkUrl(`https://${ESPN_WRITE_HOST}/x`, [ESPN_WRITE_HOST])).toThrow(HttpError);
  });

  it("accepts an exact host in any case and on :443; marks the scope", () => {
    expect(checkUrl("https://GITHUB.COM:443/a?b=1", allow).hostname).toBe("github.com");
    try {
      checkUrl("https://evil.example/", allow, true);
    } catch (e) {
      expect((e as HttpError).espn).toBe(true);
    }
  });

  it("property: a random host not on the list is always refused", () => {
    fc.assert(
      fc.property(fc.domain(), (host) => {
        fc.pre(!allow.includes(host.toLowerCase()));
        expect(() => checkUrl(`https://${host}/x`, allow)).toThrow(HttpError);
      }),
      { numRuns: 300 },
    );
  });
});

describe("narrowAllowList", () => {
  it("narrows, lower-cases, de-duplicates; never widens", () => {
    const full = allowListFor(ESPN_READ_HOST_DEFAULT);
    expect(narrowAllowList(["API.WEATHER.GOV", "api.weather.gov"], full)).toEqual([
      "api.weather.gov",
    ]);
    expect(() => narrowAllowList(["evil.example"], full)).toThrow(RangeError);
    expect(() => narrowAllowList([ESPN_WRITE_HOST], full)).toThrow(RangeError);
    expect(() => narrowAllowList([42 as unknown as string], full)).toThrow(RangeError);
  });
});

describe("redactUrl (plan 01 §8; plan 02 §2.3)", () => {
  it("origin + path only, league ids masked", () => {
    expect(redactUrl(new URL("https://github.com/a/b?token=SECRET#frag"))).toBe(
      "https://github.com/a/b",
    );
    expect(
      redactUrl(
        new URL(
          `https://${ESPN_READ_HOST_DEFAULT}/apis/v3/games/ffl/seasons/2026/segments/0/leagues/${"9".repeat(7)}?view=mRoster`,
        ),
      ),
    ).toBe(
      `https://${ESPN_READ_HOST_DEFAULT}/apis/v3/games/ffl/seasons/2026/segments/0/leagues/[league]`,
    );
    expect(redactUrl(new URL("https://x.example/leagues/123/communication/"))).toBe(
      "https://x.example/leagues/[league]/communication/",
    );
  });
});
