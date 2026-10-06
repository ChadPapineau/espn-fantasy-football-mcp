// redact.test.ts — src/auth/redact.ts against the REAL logger (src/cli/log.ts) (plan 02 §2.3; plan
// 01 §8; ADV OBJ-15; the Stage A carried item): once the authority registers the loaded espn_s2, a
// log line carrying it in its pasted (URL-encoded) form, its decodeURIComponent form, a lower- or
// upper-case copy of either, an escape-case variant, or a ≥ 24-char fragment never shows the value;
// SWID stays pseudonymised by pattern (`{guid:<6 hex>}`), never registered as a secret.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/cli/log.js";
import {
  ESPN_S2_SECRET_KIND,
  espnS2Spellings,
  registerCredentialRedaction,
} from "../../src/auth/redact.js";
import { createCredentialAuthority } from "../../src/auth/state.js";
import {
  MemoryStateRepo,
  MemoryStore,
  containsFragment,
  fakeCookies,
  stateRow,
} from "./helpers.js";

function logger() {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", sink: (l) => lines.push(l), now: () => "t" });
  return { log, lines };
}

describe("registerCredentialRedaction (plan 02 §2.3)", () => {
  it("registers pasted, decoded and a lower/upper-case copy of each — and nothing for SWID", () => {
    const c = fakeCookies("redact");
    const got: { kind: string; value: string }[] = [];
    registerCredentialRedaction({ registerSecret: (kind, value) => got.push({ kind, value }) }, c);
    const values = got.map((g) => g.value);
    expect(got.every((g) => g.kind === ESPN_S2_SECRET_KIND)).toBe(true);
    expect(values).toContain(c.espn_s2);
    expect(values).toContain(decodeURIComponent(c.espn_s2));
    expect(values).toContain(c.espn_s2.toLowerCase());
    expect(values).toContain(c.espn_s2.toUpperCase());
    expect(values).toContain(decodeURIComponent(c.espn_s2).toLowerCase());
    expect(values).toContain(decodeURIComponent(c.espn_s2).toUpperCase());
    expect(values.some((v) => v.includes(c.swid.slice(1, 9)))).toBe(false);
    expect(new Set(values).size).toBe(values.length);
  });
  it("a value that is not valid percent-encoding is registered as is (no throw)", () => {
    expect(espnS2Spellings("AB%E0%A4%A")).toContain("AB%E0%A4%A");
  });
});

describe("the real logger redacts every spelling once registered", () => {
  const c = fakeCookies("redact-logger");
  const decoded = decodeURIComponent(c.espn_s2);
  const spellings: [string, string][] = [
    ["pasted (URL-encoded)", c.espn_s2],
    ["decodeURIComponent form", decoded],
    ["lower-case copy", c.espn_s2.toLowerCase()],
    ["upper-case copy", c.espn_s2.toUpperCase()],
    ["lower-case decoded copy", decoded.toLowerCase()],
    ["upper-case decoded copy", decoded.toUpperCase()],
    ["escape-case variant", c.espn_s2.replace(/%2F/g, "%2f")],
    ["a 40-char fragment", c.espn_s2.slice(70, 110)],
    ["a 40-char lower-case fragment", c.espn_s2.toLowerCase().slice(70, 110)],
  ];
  it.each(spellings)("%s", (_n, spelled) => {
    const { log, lines } = logger();
    registerCredentialRedaction(log, c);
    log.error("upstream_error", { msg: `prefix ${spelled} suffix`, nested: { body: [spelled] } });
    const out = lines.join("\n");
    expect(out).toContain("[redacted:espn_s2]");
    for (const form of [c.espn_s2, decoded, c.espn_s2.toLowerCase(), c.espn_s2.toUpperCase()])
      expect(containsFragment(out, form, 24)).toBe(false);
  });
  it("SWID is pseudonymised by pattern, the same for any case", () => {
    const { log, lines } = logger();
    registerCredentialRedaction(log, c);
    log.info("x", { a: c.swid, b: c.swid.toLowerCase() });
    const out = lines.join("\n");
    expect(out).not.toContain(c.swid.slice(1, 37));
    expect(out).not.toContain(c.swid.slice(1, 37).toLowerCase());
    expect(out.match(/\{guid:[0-9a-f]{6}\}/g)?.length).toBe(2);
  });
  it("the authority registers on load: a header logged afterwards is redacted", async () => {
    const { log, lines } = logger();
    const store = new MemoryStore();
    store.set(c, "2026-10-01T00:00:00.000Z");
    const repo = new MemoryStateRepo();
    repo.row = stateRow();
    const auth = createCredentialAuthority({ store, repo, leagueId: "0", registrar: log });
    const r = await auth.getCookieHeader();
    expect(r.ok).toBe(true);
    if (r.ok)
      log.debug("request", { note: `sent ${String(r.header)}`, raw: decoded.toUpperCase() });
    const out = lines.join("\n");
    expect(containsFragment(out, c.espn_s2, 24)).toBe(false);
    expect(containsFragment(out, decoded.toUpperCase(), 24)).toBe(false);
  });
  it("property: any registered value never survives in a log line, whatever surrounds it", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }),
        fc.string({ maxLength: 60 }),
        fc.integer({ min: 0, max: 5 }),
        (pre, post, which) => {
          const { log, lines } = logger();
          registerCredentialRedaction(log, c);
          const forms = [
            c.espn_s2,
            decoded,
            c.espn_s2.toLowerCase(),
            c.espn_s2.toUpperCase(),
            decoded.toLowerCase(),
            decoded.toUpperCase(),
          ];
          const form = forms[which] ?? c.espn_s2;
          log.warn("e", { msg: `${pre}${form}${post}` });
          return !containsFragment(lines.join("\n"), form, 24);
        },
      ),
      { numRuns: 200 },
    );
  });
});
