// format.test.ts — src/auth/format.ts (plan 05 §2 `auth/format`; plan 02 §2.1; ADV OBJ-15): the
// SWID and espn_s2 rules with adversarial inputs — brace-less GUID refused, lowercase hex accepted,
// espn_s2 with a space / quote / newline refused, a decoded `/` mid-string accepted, 39 chars
// refused, 40 accepted with a warning, 100 accepted without; the fingerprint and the Cookie header.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fakeEspnS2, fakeGuid } from "../../scripts/ci/secret-fixtures.mjs";
import {
  ESPN_S2_SHORT_WARNING,
  buildCookieHeader,
  fingerprintOf,
  formatRefusalText,
  normalizePastedValue,
  validateCookies,
  validateEspnS2,
  validateSwid,
} from "../../src/auth/format.js";
import { FINGERPRINT_RE, type FormatVerdict } from "../../src/auth/types.js";

const guid = fakeGuid("auth-format");
const swid = `{${guid}}`;
const s2 = (len: number, label = "auth-format"): string => fakeEspnS2(label, 200).slice(0, len);

const refusal = (v: FormatVerdict): string => (v.ok ? "ok" : `${v.field}:${v.reason}`);

describe("validateSwid (plan 02 §2.1: a braced GUID, braces kept)", () => {
  it("accepts a braced GUID, upper- or lowercase hex", () => {
    expect(validateSwid(swid)).toEqual({ ok: true, warning: null });
    expect(validateSwid(swid.toLowerCase()).ok).toBe(true);
  });
  it.each([
    ["no braces", guid, "swid:missing_braces"],
    ["open brace only", `{${guid}`, "swid:missing_braces"],
    ["close brace only", `${guid}}`, "swid:missing_braces"],
    ["not a GUID", "{not-a-guid}", "swid:not_a_guid"],
    ["empty", "", "swid:not_a_guid"],
    ["one hex short", `{${guid.slice(0, -1)}}`, "swid:not_a_guid"],
    ["non-hex", `{${guid.slice(0, -1)}G}`, "swid:not_a_guid"],
    ["fullwidth braces", `｛${guid}｝`, "swid:not_a_guid"],
    ["quoted", `"${swid}"`, "swid:whitespace_or_quote"],
    ["inner space", `{${guid.slice(0, 8)} ${guid.slice(9)}}`, "swid:whitespace_or_quote"],
    ["trailing newline (not normalised)", `${swid}\n`, "swid:whitespace_or_quote"],
    ["name pasted", `SWID=${swid}`, "swid:includes_cookie_name"],
    ["name pasted, lower, spaced", ` swid = ${swid}`, "swid:includes_cookie_name"],
    ["huge", `{${"A".repeat(10_000)}}`, "swid:not_a_guid"],
    ["huge with a name", `SWID=${"A".repeat(10_000)}`, "swid:includes_cookie_name"],
  ])("%s → %s", (_n, input, want) => {
    expect(refusal(validateSwid(input))).toBe(want);
  });
});

describe("validateEspnS2 (plan 02 §2.1; ADV OBJ-15 thresholds)", () => {
  it("39 chars refused, 40 accepted with a warning, 99 warned, 100 accepted without", () => {
    expect(refusal(validateEspnS2(s2(39)))).toBe("espn_s2:too_short");
    expect(validateEspnS2(s2(40))).toEqual({ ok: true, warning: "espn_s2_short" });
    expect(validateEspnS2(s2(99))).toEqual({ ok: true, warning: "espn_s2_short" });
    expect(validateEspnS2(s2(100))).toEqual({ ok: true, warning: null });
  });
  it("4096 accepted, 4097 refused (sanity bound), 1 MB refused without a regex walk", () => {
    const long = fakeEspnS2("long", 5000);
    expect(validateEspnS2(long.slice(0, 4096)).ok).toBe(true);
    expect(refusal(validateEspnS2(long.slice(0, 4097)))).toBe("espn_s2:too_long");
    expect(refusal(validateEspnS2("A".repeat(1024 * 1024)))).toBe("espn_s2:too_long");
  });
  it("a decoded `/` (and `+`, `=`) mid-string still matches the class — stored as given", () => {
    const decoded = decodeURIComponent(s2(150));
    expect(decoded).toMatch(/[/+]/);
    expect(validateEspnS2(decoded).ok).toBe(true);
  });
  it.each([
    ["a space", (v: string) => `${v.slice(0, 50)} ${v.slice(50)}`, "espn_s2:whitespace_or_quote"],
    ["a quote", (v: string) => `"${v}"`, "espn_s2:whitespace_or_quote"],
    ["a single quote", (v: string) => `${v}'`, "espn_s2:whitespace_or_quote"],
    [
      "a newline",
      (v: string) => `${v.slice(0, 60)}\n${v.slice(60)}`,
      "espn_s2:whitespace_or_quote",
    ],
    ["a tab", (v: string) => `${v}\t`, "espn_s2:whitespace_or_quote"],
    ["a NBSP", (v: string) => `${v} `, "espn_s2:whitespace_or_quote"],
    ["U+2028", (v: string) => `${v} `, "espn_s2:whitespace_or_quote"],
    ["a smart quote", (v: string) => `“${v}”`, "espn_s2:whitespace_or_quote"],
    ["a semicolon (a second cookie)", (v: string) => `${v};SWID=x`, "espn_s2:bad_characters"],
    ["a comma", (v: string) => `${v},x`, "espn_s2:bad_characters"],
    ["a CR LF header injection", (v: string) => `${v}\r\nX-Evil: 1`, "espn_s2:whitespace_or_quote"],
    ["unicode letters", (v: string) => `${v}é`, "espn_s2:bad_characters"],
    ["an emoji", (v: string) => `${v}\u{1F600}`, "espn_s2:bad_characters"],
    ["a NUL", (v: string) => `${v}\u0000`, "espn_s2:bad_characters"],
    ["the name pasted", (v: string) => `espn_s2=${v}`, "espn_s2:includes_cookie_name"],
    ["the name, other spelling", (v: string) => `ESPN-S2: ${v}`, "espn_s2:includes_cookie_name"],
  ])("refuses %s", (_n, mutate, want) => {
    expect(refusal(validateEspnS2(mutate(s2(160))))).toBe(want);
  });
  it("empty and short-with-bad-characters", () => {
    expect(refusal(validateEspnS2(""))).toBe("espn_s2:too_short");
    expect(refusal(validateEspnS2("a;b"))).toBe("espn_s2:bad_characters");
  });
  it("property: never throws; ok iff in-alphabet, no name prefix, 40–4096 chars", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300, unit: "binary" }), (v) => {
        const verdict = validateEspnS2(v);
        const shaped =
          v.length >= 40 &&
          v.length <= 4096 &&
          /^[A-Za-z0-9%+/=._-]+$/.test(v) &&
          !/^(?:espn[_-]?s2|swid)[=:]/i.test(v);
        return verdict.ok === shaped;
      }),
    );
  });
  it("property: SWID verdicts never throw and accept only the braced GUID shape", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80, unit: "binary" }), (v) => {
        const ok = validateSwid(v).ok;
        return ok === /^\{[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}$/.test(v);
      }),
    );
  });
});

describe("validateCookies, normalisation", () => {
  it("SWID first, then espn_s2", () => {
    expect(refusal(validateCookies({ swid: guid, espn_s2: "x" }))).toBe("swid:missing_braces");
    expect(refusal(validateCookies({ swid, espn_s2: "x" }))).toBe("espn_s2:too_short");
    expect(validateCookies({ swid, espn_s2: s2(120) }).ok).toBe(true);
  });
  it("normalizePastedValue strips only surrounding whitespace (never inner characters)", () => {
    const v = s2(120);
    expect(normalizePastedValue(`  ${v}\r\n`)).toBe(v);
    expect(normalizePastedValue(`\t${swid} `)).toBe(swid);
    expect(normalizePastedValue(`${v.slice(0, 5)} ${v.slice(5)}`)).toContain(" ");
  });
});

describe("fingerprint and Cookie header (plan 02 §2.3; research 03 §C.1)", () => {
  it("fingerprint: 6 lowercase hex, deterministic, differs per value, never the value", () => {
    const a = s2(150, "a");
    const b = s2(150, "b");
    expect(fingerprintOf(a)).toMatch(FINGERPRINT_RE);
    expect(fingerprintOf(a)).toBe(fingerprintOf(a));
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b));
    expect(a).not.toContain(fingerprintOf(a));
  });
  it("header: verbatim `espn_s2=…; SWID=…` (no decoding)", () => {
    const v = s2(150);
    expect(buildCookieHeader({ espn_s2: v, swid })).toBe(`espn_s2=${v}; SWID=${swid}`);
  });
  it("header: refuses values that fail the rules (no `;`/CRLF smuggling); the error has no value", () => {
    const bad = `${s2(80)};admin=1`;
    expect(() => buildCookieHeader({ espn_s2: bad, swid })).toThrow(TypeError);
    try {
      buildCookieHeader({ espn_s2: bad, swid });
    } catch (e) {
      expect(String(e)).not.toContain(bad.slice(0, 20));
    }
    expect(() => buildCookieHeader({ espn_s2: s2(80), swid: `${swid}\r\nX: y` })).toThrow();
  });
});

describe("refusal texts name the field, never the value", () => {
  const cases: Extract<FormatVerdict, { ok: false }>[] = [
    { ok: false, field: "swid", reason: "missing_braces" },
    { ok: false, field: "swid", reason: "not_a_guid" },
    { ok: false, field: "espn_s2", reason: "too_short" },
    { ok: false, field: "espn_s2", reason: "too_long" },
    { ok: false, field: "espn_s2", reason: "whitespace_or_quote" },
    { ok: false, field: "swid", reason: "whitespace_or_quote" },
    { ok: false, field: "espn_s2", reason: "bad_characters" },
    { ok: false, field: "espn_s2", reason: "includes_cookie_name" },
    { ok: false, field: "swid", reason: "includes_cookie_name" },
  ];
  it.each(cases)("%j", (v) => {
    const t = formatRefusalText(v);
    expect(t.length).toBeGreaterThan(10);
    expect(t).toMatch(v.field === "swid" ? /SWID/ : /espn_s2/);
  });
  it("the short-value warning is the plan's sentence", () => {
    expect(ESPN_S2_SHORT_WARNING).toContain("the ESPN check will decide");
  });
});
