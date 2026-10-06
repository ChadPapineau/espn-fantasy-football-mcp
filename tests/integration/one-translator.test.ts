// one-translator.test.ts — one nflverse → StatLine translator for scoring (plan 08 §3.2, E8; the
// store's decision "so there is one translator"): every src module that turns nflverse rows into
// StatLines imports src/domain/scoring's statLineFromPlayerWeek / statLineFromTeamDefense, and no
// src module outside src/sources/nflverse imports the source's own (older) translators from
// columns.ts — whose names and conventions differ from the measured ones.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const ALL = files(SRC).map((f) => ({
  rel: path.relative(SRC, f).split(path.sep).join("/"),
  text: readFileSync(f, "utf8"),
}));
const OLD = ["toStatLine", "toDefenseStatLine", "translatePlayerWeek", "NFLVERSE_STAT_MAP"];

describe("one nflverse translator for scoring", () => {
  it("no src module outside src/sources/nflverse imports the source's translators", () => {
    const offenders = ALL.filter((f) => !f.rel.startsWith("sources/nflverse/"))
      .filter((f) => /from\s+"[^"]*sources\/nflverse[^"]*"/.test(f.text))
      .filter((f) => OLD.some((name) => new RegExp(`\\b${name}\\b`).test(f.text)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the store's player and defence lines come from src/domain/scoring's translator", () => {
    const readers = ALL.find((f) => f.rel === "store/datasets/readers.ts");
    expect(readers?.text).toMatch(/statLineFromPlayerWeek/);
    expect(readers?.text).toMatch(/statLineFromTeamDefense/);
    expect(readers?.text).toMatch(/domain\/scoring/);
  });
});
