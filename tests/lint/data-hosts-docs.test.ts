// data-hosts-docs.test.ts — the root documents say exactly what leaves the machine, and promise no
// data source this build does not ship (Stage C finding docs-odds-api-key-unbuilt; plan 02 S12; plan
// 10 D13; README "Is my league data sent anywhere?"). No keyed odds API is built — the betting lines
// come from nflverse `schedules` (owner decision D13; `odds` is not a built refresh job, its
// freshness row is phase `later`, and the HTTP allow-list has no odds host) — yet the README listed
// `api.the-odds-api.com` among the hosts that receive data, described ODDS_API_KEY as enabling
// secondary lines, and credited The Odds API as a provider; the schema's documentation row (the
// source of the README's configuration table and of `.env.example`) said the key was read.
import { describe, expect, it } from "vitest";
import { REFRESH_JOBS_BUILT } from "../../src/cli/refresh.js";
import { FRESHNESS_TABLE } from "../../src/config/freshness.js";
import { CONFIG_KEY_SPECS, ESPN_READ_HOST_DEFAULT } from "../../src/config/schema.js";
import { allowListFor } from "../../src/http/allowlist.js";
import { readDoc, section, tableRows } from "./docs-helpers.js";

const README = readDoc("README.md");
const ENV_EXAMPLE = readDoc(".env.example");
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
/** The backticked host names in a table cell. */
const hostsIn = (cell: string): string[] =>
  [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "").filter((h) => HOST.test(h));

describe("the README's host table is the HTTP allow-list", () => {
  const rows = tableRows(section(README, "### Is my league data sent anywhere?")).slice(1);

  it("lists exactly the hosts the client allows (ESPN's read host and every data-source host)", () => {
    const documented = rows.flatMap((r) => hostsIn(r[0] ?? ""));
    expect([...new Set(documented)].sort()).toEqual(
      [...allowListFor(ESPN_READ_HOST_DEFAULT)].sort(),
    );
    expect(documented).not.toContain("api.the-odds-api.com");
  });

  it("the write host's row sends nothing", () => {
    const write = rows.filter((r) => /\bwrite\b/i.test(r[0] ?? ""));
    expect(write).toHaveLength(1);
    expect(write[0]?.[1]).toMatch(/^Nothing\b/);
  });
});

describe("a provider key whose source is not built is reserved, and every doc says so", () => {
  it("the odds source is not built, so ODDS_API_KEY is reserved in its documentation row", () => {
    expect(REFRESH_JOBS_BUILT).not.toContain("odds");
    expect(FRESHNESS_TABLE.odds.phase).toBe("later");
    expect(allowListFor(ESPN_READ_HOST_DEFAULT).some((h) => h.includes("odds"))).toBe(false);
    const odds = CONFIG_KEY_SPECS.find((s) => s.key === "ODDS_API_KEY");
    expect(odds?.status).toBe("reserved");
    expect(odds?.description).toMatch(/^Reserved\b/);
  });

  const documented = CONFIG_KEY_SPECS.filter((s) => s.scope !== "test");
  const configRows = tableRows(section(README, "### `.env.example`, line by line"));
  /** The README row of `key` (`KEY=…` or `# KEY=`), its meaning cell. */
  const meaningOf = (key: string): string | undefined =>
    configRows.find((r) => new RegExp(`^\`(?:# )?${key}=`).test(r[0] ?? ""))?.[2];
  /** The `.env.example` block that holds `key`: from its `# ---` header down to the key's line. */
  const envBlockOf = (key: string): string => {
    const lines = ENV_EXAMPLE.split("\n");
    const at = lines.findIndex((l) => new RegExp(`^#?\\s*${key}=`).test(l.trim()));
    let start = at;
    while (start > 0 && !(lines[start] ?? "").startsWith("# ---")) start--;
    return at < 0 ? "" : lines.slice(start, at + 1).join("\n");
  };

  it.each(documented.map((s) => [s.key, s.status] as const))(
    "%s (%s): the README row and .env.example call it reserved exactly when the schema does",
    (key, status) => {
      const meaning = meaningOf(key);
      expect(meaning, `README row for ${key}`).toBeDefined();
      expect(/\breserved\b/i.test(meaning ?? ""), meaning).toBe(status === "reserved");
      const block = envBlockOf(key);
      expect(block, `.env.example block for ${key}`).not.toBe("");
      expect(/\breserved\b/i.test(block), block).toBe(status === "reserved");
    },
  );
});

describe("no root document promises the odds source", () => {
  it.each(["README.md", "SECURITY.md", ".env.example"])("%s", (doc) => {
    const text = readDoc(doc);
    expect(text).not.toMatch(/the-odds-api\.com/i);
    for (const line of text.split("\n").filter((l) => /odds api/i.test(l)))
      expect(line).toMatch(/no keyed odds API/i);
  });
});
