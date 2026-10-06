// fx10h-current.test.ts — the committed derived league is current (plan 09 §4 `gen-fixtures.ts
// --check`; plan 05 §3 fixture law): regenerating fixtures/espn/fx-10h from the recorded bodies with
// today's engine reproduces every committed file (parsed JSON equality), and the generator's golden
// gate is green. Runs in the process project (about 30 s of rendering — never under coverage).
import { describe, expect, it } from "vitest";
import { generate } from "../../scripts/fx10h/generate.js";
import { staleFiles } from "../../scripts/gen-fixtures.js";

describe("fixtures/espn/fx-10h is current", { timeout: 300_000 }, () => {
  it("regeneration reproduces the committed tree (run `npm run fixtures:gen` when it does not)", () => {
    const { files, goldenLines } = generate();
    expect(goldenLines).toBeGreaterThan(2000);
    expect(staleFiles(files)).toEqual([]);
  });
});
