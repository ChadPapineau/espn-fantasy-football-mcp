// model-evals.test.ts — the model-driven evaluation's answer key, re-derived from the BUILT server
// (plan 05 §6: the answers are recorded by solving each question with the tools; plan 10 A10b; the
// record: docs/evals/model-driven-evals.md). The server is started the way the documented run starts
// it: `node dist/cli.js serve` over real stdio, in fixture mode on fixtures/espn/fx-10h, as league 0,
// with the fixture's own team, on a fresh private HOME / config / cache (no dataset refreshed), with
// EFF_TEST_STUBS=1 and the no-socket preload. Every answer in tests/evals/read-only.xml must be what
// the solvers in tests/evals/solvers.ts read from the tools there. Those solvers use only read-only
// tools that report ESPN facts, and refuse a non-unique answer. Run under both toolsets, so the key
// holds whichever one the run uses. The record's answer-key section is kept equal to the `core` run
// (UPDATE_EVALS=1 rewrites it). No network, no cookie, no model tokens.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FX,
  KEY_SECTION,
  MANIFEST,
  QUESTIONS,
  RECORD_PAGE,
  keySection,
  pair,
  type KeyRow,
} from "../evals/format.js";
import { SOLVERS, reader } from "../evals/solvers.js";
import { evalsSection, writeEvalsSection } from "../golden/evals-doc.js";
import { makeHome, serve, type E2eHome, type Served } from "./helpers.js";

const NUMBERS = Array.from({ length: QUESTIONS }, (_v, i) => i + 1);

describe.each(["core", "full"] as const)(
  "the eval answer key from the built server in fixture mode (EFF_TOOLSET=%s)",
  (toolset) => {
    let home: E2eHome | undefined;
    let served: Served | undefined;
    let readOnly = new Map<string, boolean>();
    const derived: KeyRow[] = [];

    beforeAll(async () => {
      home = makeHome({
        fixtureDir: FX,
        teamId: MANIFEST.my_team_id,
        env: { EFF_TOOLSET: toolset, EFF_LOG_LEVEL: "warn" },
      });
      served = await serve(home);
      const tools = (await served.client.listTools()).tools;
      readOnly = new Map(tools.map((t) => [t.name, t.annotations?.readOnlyHint === true]));
    }, 120_000);

    afterAll(async () => {
      await served?.stop();
      home?.cleanup();
    });

    it("the solver list covers every question of the file", () => {
      expect(SOLVERS).toHaveLength(QUESTIONS);
    });

    it.each(NUMBERS)(
      "question %i: the committed answer is what the tools show",
      async (n) => {
        const solve = SOLVERS[n - 1];
        if (solve === undefined || served === undefined)
          throw new Error(`no solver or no server for question ${String(n)}`);
        const used = new Set<string>();
        const answer = await solve(reader(served.client, used));
        expect(answer, pair(n).question).toBe(pair(n).answer);
        // read-only: every tool the solver needed is annotated read-only
        for (const t of used) expect(readOnly.get(t), t).toBe(true);
        derived.push({ n, answer, tools: [...used].sort() });
      },
      120_000,
    );

    if (toolset === "core")
      it("the record's answer key is this run's (docs/evals/model-driven-evals.md)", () => {
        expect(derived.map((d) => d.n)).toEqual(NUMBERS);
        const section = keySection(derived);
        if (process.env.UPDATE_EVALS === "1") writeEvalsSection(RECORD_PAGE, KEY_SECTION, section);
        expect(evalsSection(RECORD_PAGE, KEY_SECTION)).toBe(section);
      });
  },
);
