// errors.test.ts — src/auth/errors.ts and src/auth/upgrade.ts (plan 02 §2.3: an error is never built
// from a value; plan 03 §7: the metadata's format_version, migrated in memory, a newer one refused).
import fc from "fast-check";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CredentialStoreError,
  cookieUnavailableFor,
  safeCode,
  type CredentialStoreErrorReason,
} from "../../src/auth/errors.js";
import { CREDENTIAL_FORMAT_VERSION } from "../../src/auth/types.js";
import {
  isStoredAt,
  metaFor,
  metaJson,
  metaMatches,
  parseMeta,
  parseMetaJson,
} from "../../src/auth/upgrade.js";
import { containsFragment, fakeCookies } from "./helpers.js";

const REASONS: CredentialStoreErrorReason[] = [
  "unavailable",
  "read_failed",
  "timeout",
  "corrupt",
  "newer_format",
  "invalid_format",
  "insecure_location",
  "write_failed",
  "delete_failed",
  "invalid_service",
];

describe("CredentialStoreError", () => {
  it.each(REASONS)("%s: fixed text, INTERNAL, no value, no path", (reason) => {
    const e = new CredentialStoreError(
      "file",
      reason,
      reason === "insecure_location" ? "symlink" : null,
    );
    expect(e.name).toBe("CredentialStoreError");
    expect(e.effCode).toBe("INTERNAL");
    expect(e.message.startsWith("file store: ")).toBe(true);
    expect(e.message).not.toMatch(/\/|espn_s2=|SWID=/);
    expect(e.refusal).toBe(reason === "insecure_location" ? "symlink" : null);
  });
  it("the only fields are fixed vocabulary — nothing a value could ride in on", () => {
    const e = new CredentialStoreError("keychain", "corrupt");
    expect(Object.keys(e).sort()).toEqual(["effCode", "name", "reason", "refusal", "store"]);
    expect("cause" in e).toBe(false);
  });
  it("cookieUnavailableFor maps invalid_format → invalid_format, everything else → unreadable", () => {
    expect(cookieUnavailableFor(new CredentialStoreError("keychain", "invalid_format"))).toBe(
      "invalid_format",
    );
    expect(cookieUnavailableFor(new CredentialStoreError("keychain", "timeout"))).toBe(
      "unreadable",
    );
    expect(cookieUnavailableFor(new Error("x"))).toBe("unreadable");
    expect(cookieUnavailableFor("thrown string")).toBe("unreadable");
  });
  it("safeCode echoes only a short fixed-alphabet code", () => {
    expect(safeCode("timeout")).toBe("timeout");
    expect(safeCode("http_503")).toBe("http_503");
    expect(safeCode("a b")).toBe("error");
    expect(safeCode("\u001b[2J")).toBe("error");
    expect(safeCode("x".repeat(41))).toBe("error");
    expect(safeCode(42)).toBe("error");
    expect(safeCode(undefined)).toBe("error");
  });
  it("property: no rendering of any store error ever contains a cookie fragment", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REASONS),
        fc.constantFrom<"keychain" | "file">("keychain", "file"),
        fc.string(),
        (reason, store, label) => {
          const c = fakeCookies(`errors-${label}`);
          const e = new CredentialStoreError(store, reason);
          const all = [String(e), e.message, JSON.stringify(e), inspect(e, { depth: 5 })].join(
            "\n",
          );
          return !containsFragment(all, c.espn_s2, 12) && !all.includes(c.swid);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("metadata parsing (plan 03 §7)", () => {
  const c = fakeCookies("meta");
  const AT = "2026-10-06T12:00:00.000Z";
  it("round trip; metaFor carries the fingerprint of espn_s2; metaJson holds no secret", () => {
    const meta = metaFor(c, AT);
    expect(meta).toEqual({
      storedAt: AT,
      format_version: CREDENTIAL_FORMAT_VERSION,
      fingerprint: expect.stringMatching(/^[0-9a-f]{6}$/) as string,
    });
    expect(parseMetaJson(metaJson(meta))).toEqual({ ok: true, meta, upgraded: false });
    expect(metaMatches(meta, c)).toBe(true);
    expect(metaMatches(meta, fakeCookies("other"))).toBe(false);
    expect(containsFragment(metaJson(meta), c.espn_s2, 6)).toBe(false);
  });
  it.each([
    ["not an object", "x", "corrupt"],
    ["an array", [], "corrupt"],
    ["null", null, "corrupt"],
    ["format_version missing", { storedAt: AT, fingerprint: "abcdef" }, "corrupt"],
    ["format_version 0", { storedAt: AT, format_version: 0, fingerprint: "abcdef" }, "corrupt"],
    ["format_version 1.5", { storedAt: AT, format_version: 1.5, fingerprint: "abcdef" }, "corrupt"],
    [
      "format_version newer",
      { storedAt: AT, format_version: 2, fingerprint: "abcdef" },
      "newer_format",
    ],
    [
      "storedAt not ISO",
      { storedAt: "2026-10-06", format_version: 1, fingerprint: "abcdef" },
      "corrupt",
    ],
    [
      "storedAt impossible date",
      { storedAt: "2026-02-30T00:00:00.000Z", format_version: 1, fingerprint: "abcdef" },
      "corrupt",
    ],
    [
      "fingerprint upper-case",
      { storedAt: AT, format_version: 1, fingerprint: "ABCDEF" },
      "corrupt",
    ],
    ["fingerprint missing", { storedAt: AT, format_version: 1 }, "corrupt"],
    [
      "inherited fields only",
      Object.create({ storedAt: AT, format_version: 1, fingerprint: "abcdef" }) as object,
      "corrupt",
    ],
  ])("%s → %s", (_n, raw, reason) => {
    expect(parseMeta(raw)).toEqual({ ok: false, reason });
  });
  it("parseMetaJson: bad JSON → corrupt", () => {
    expect(parseMetaJson("{")).toEqual({ ok: false, reason: "corrupt" });
  });
  it("isStoredAt: the recorded grammar only", () => {
    expect(isStoredAt(AT)).toBe(true);
    expect(isStoredAt("2026-10-06T12:00:00Z")).toBe(true);
    expect(isStoredAt("2026-10-06T12:00:00+02:00")).toBe(false);
    expect(isStoredAt(5)).toBe(false);
  });
});
