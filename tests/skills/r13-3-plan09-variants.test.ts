// r13-3-plan09-variants.test.ts — changelog §R13, R13-3 (R12-6's purpose): plan 09 §5.2's variant
// list names every variant the build's manifest lists (the seven `inj-*` by count, inj-player-name
// by name), outlook-more-work, private-league, private-league-none and private-expiring among
// them, and §3.6's AP-INJ names inj-player-name (R11-1). The manifest stays the source of truth:
// every variant a case runs is one it lists. Reads the committed plan, manifest and bundle.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers.js";

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const plan9 = read("docs/plan/09-skills-bundle.md");
const variants = (
  JSON.parse(read("scripts/skills/manifest.json")) as { fixture: { variants: string[] } }
).fixture.variants;
const list = /\*\*Fixture league and variants\.\*\*([^\n]*)/.exec(plan9)?.[1] ?? "";
/** The names §5.2's list gives, each a bare word or in backticks, before the derivation clause. */
const named = (v: string): boolean =>
  new RegExp(`(?:^|[\\s(,\`])${v.replace(/[-]/g, "\\-")}(?=[\`,\\s)\\[]|$)`).test(
    list.split(/\) — derived by/)[0] ?? "",
  );

describe("R13-3: plan 09 names every variant the suite runs", () => {
  it("every variant a case runs is one the build's manifest lists", () => {
    const run = new Set<string>();
    for (const s of readdirSync(path.join(ROOT, "skills")).filter(
      (d) => !d.startsWith("_") && d !== "README.md",
    )) {
      const j = JSON.parse(read(`skills/${s}/evals/evals.json`)) as {
        evals: { files?: string[] }[];
      };
      for (const c of j.evals)
        for (const f of c.files ?? []) {
          const m = /^evals\/fixtures\/fx-10h\/([a-z0-9-]+)$/.exec(f);
          if (m?.[1] !== undefined) run.add(m[1]);
        }
    }
    expect([...run].filter((v) => !variants.includes(v))).toEqual([]);
    for (const v of [
      "outlook-more-work",
      "private-league",
      "private-league-none",
      "private-expiring",
    ])
      expect(run.has(v), v).toBe(true);
  });

  it("§5.2's list names each manifest variant that is not an inj-* one, the four R13-3 adds among them", () => {
    expect(list).not.toBe("");
    const missing = variants.filter((v) => !v.startsWith("inj-") && !named(v));
    expect(missing).toEqual([]);
    for (const v of [
      "outlook-more-work",
      "private-league",
      "private-league-none",
      "private-expiring",
    ])
      expect(named(v), v).toBe(true);
    // the inj-* variants are counted, inj-player-name named (R12-6)
    const inj = variants.filter((v) => v.startsWith("inj-"));
    expect(inj).toHaveLength(7);
    expect(list).toContain("the seven `inj-*` variants");
    expect(list).toMatch(/`inj-player-name`/);
  });

  it("§3.6's AP-INJ runs on inj-player-name, the player name apply quotes (R11-1), never inj-tradeblock", () => {
    const ap = /### 3\.6 [\s\S]*?\n- \*\*Evals\.\*\*([^\n]*)/.exec(plan9)?.[1] ?? "";
    expect(ap).toMatch(/\*\*`AP-INJ`\*\* \(`inj-player-name`/);
    expect(ap).not.toMatch(/`AP-INJ`\*\* \(`inj-tradeblock`/);
    // the case runs on the variant the plan names
    const c = (
      JSON.parse(read("skills/apply/evals/evals.json")) as {
        evals: { name: string; files: string[] }[];
      }
    ).evals.find((x) => x.name === "AP-INJ");
    expect(c?.files).toEqual(["evals/fixtures/fx-10h/inj-player-name"]);
  });
});
