// skills-dry-run.test.ts — Skills Lane 1 item 7 (plan 09 §5.1; plan 10 A14a, A13a; B11 under full):
// every P0 Skill's evals/tool_sequence.json replayed against the BUILT server in fixture mode over
// real stdio under EFF_TOOLSET=core, and every `full` sequence (the five P1 Skills and the P1
// branches of start-sit, waivers, weekly and stream-kdef) under EFF_TOOLSET=full on a SEEDED cache
// (tests/e2e/helpers.ts seedHome — the Phase-2 datasets an `eff refresh all` leaves),
// on fx-10h or the sequence's variant (one server per variant — the manifest's own clock and env).
// `$ref` / `$source_calls` / `$opponent` / `$player` resolve from the earlier steps' envelopes
// (scripts/skills/tool-sequences.mjs); every resolved argument set passes the tool's own zod input
// schema; every outcome is one the step's `expect` allows; every Rec carries an interval (p10 ≤
// p90). A13a: the logged calls of week 5 are scored by espn_analyze_retrospective once week 5 is the
// scored week is P1's chain — here the retro Skill's own sequence answers on the base league.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../../src/mcp/registry.js";
import {
  loadToolSequences,
  outcomeAllowed,
  resolveArgs,
} from "../../scripts/skills/tool-sequences.mjs";
import {
  bodyOf,
  FX,
  makeHome,
  requireDist,
  ROOT,
  seedHome,
  serve,
  type Served,
} from "./helpers.js";

interface Step {
  readonly id: string;
  readonly tool: string;
  readonly args: unknown;
  readonly expect: readonly string[];
}
interface Seq {
  readonly skill: string;
  readonly id: string;
  readonly variant: string | null;
  readonly teamId: number;
  readonly steps: readonly Step[];
}

const SEQUENCES: Seq[] = loadToolSequences().flatMap((s) =>
  s.sequences.map((q) => ({
    skill: s.skill,
    id: q.id,
    variant: q.fixture_variant,
    teamId: typeof s.fixture.team_id === "number" ? s.fixture.team_id : 2,
    steps: q.steps,
  })),
);
const VARIANTS = [...new Set(SEQUENCES.map((s) => s.variant))];

const inputOf = (tool: string) => {
  const def = REGISTRY.find((e) => e.name === tool)?.tool;
  if (def === undefined || def === null) throw new Error(`${tool} is not built`);
  return def.input;
};

/** The variant manifest's harness env: ESPN_TEAM_ID null → unset; anything else verbatim. */
function variantEnv(variant: string | null): { teamUnset: boolean; env: Record<string, string> } {
  const dir = variant === null ? FX : path.join(FX, variant);
  const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    env: Record<string, string | null>;
  };
  const env: Record<string, string> = {};
  let teamUnset = false;
  for (const [k, v] of Object.entries(m.env)) {
    if (v === null) {
      if (k === "ESPN_TEAM_ID") teamUnset = true;
      continue;
    }
    env[k] = v;
  }
  return { teamUnset, env };
}

/** Every Rec in a result carries an interval (plan 09 §5.1 #7). */
function checkRecs(label: string, body: unknown): void {
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    const o = v as Record<string, unknown>;
    const rec = o.rec as
      | {
          distribution?: { p10: number; p90: number };
          delta_vs_next?: { p10: number; p90: number };
        }
      | null
      | undefined;
    if (rec !== undefined && rec !== null) {
      expect(rec.distribution, `${label}: a Rec without a distribution`).toBeDefined();
      expect(rec.distribution!.p10, label).toBeLessThanOrEqual(rec.distribution!.p90);
      expect(rec.delta_vs_next!.p10, label).toBeLessThanOrEqual(rec.delta_vs_next!.p90);
    }
    for (const x of Object.values(o)) if (typeof x === "object") visit(x);
  };
  visit(body);
}

async function replay(s: Served, seq: Seq, skipped: string[] = []): Promise<string[]> {
  const results = new Map<string, { tool: string; result: unknown }>();
  const outcomes: string[] = [];
  const skippedIds = new Set<string>();
  for (const step of seq.steps) {
    const label = `${seq.skill}/${seq.id}/${step.id} (${step.tool})`;
    let args: Record<string, unknown>;
    try {
      args = resolveArgs(step.args, results) as Record<string, unknown>;
    } catch (e) {
      // a step fed by an earlier list that is EMPTY on the fixture data (the cascade's beneficiaries
      // when the injured player's usage has no teammate in the excerpt) is skipped and reported;
      // the caller holds which steps may be skipped
      const msg = String(e);
      const fed = [...skippedIds].some((id) => msg.includes(`step ${id} has no result`));
      if (/\$ids .*no player_id/.test(msg) || fed) {
        skipped.push(label);
        skippedIds.add(step.id);
        outcomes.push(`${step.id}:skipped`);
        continue;
      }
      throw e;
    }
    const parsed = inputOf(step.tool).safeParse(args);
    expect(parsed.success, `${label}: the resolved arguments fail the tool's input schema`).toBe(
      true,
    );
    const r = await s.client.callTool({ name: step.tool, arguments: args });
    const b = bodyOf(r);
    const outcome = r.isError === true ? (b.error as { code: string }).code : "ok";
    expect(
      outcomeAllowed(step, outcome),
      `${label} → ${outcome}: ${JSON.stringify(b).slice(0, 300)}`,
    ).toBe(true);
    outcomes.push(`${step.id}:${outcome}`);
    if (outcome === "ok") {
      checkRecs(label, b.data);
      results.set(step.id, { tool: step.tool, result: b });
    }
  }
  return outcomes;
}

describe(
  "Skills Lane 1 dry run: every P0 tool sequence against the built server (fixture mode)",
  { timeout: 600_000 },
  () => {
    it("covers the eight P0 Skills", () => {
      expect([...new Set(SEQUENCES.map((s) => s.skill))].sort()).toEqual([
        "apply",
        "onboard",
        "retro",
        "session-check",
        "start-sit",
        "stream-kdef",
        "waivers",
        "weekly",
      ]);
      expect(SEQUENCES.length).toBeGreaterThanOrEqual(18);
    });

    it.each(VARIANTS.map((v) => [v ?? "base"] as const))("fx-10h %s", async (name) => {
      requireDist();
      const variant = name === "base" ? null : name;
      const seqs = SEQUENCES.filter((s) => s.variant === variant);
      const { teamUnset, env } = variantEnv(variant);
      const team = seqs[0]?.teamId ?? 2;
      const home = makeHome({
        fixtureDir: variant === null ? FX : path.join(FX, variant),
        teamId: teamUnset ? null : team,
        env,
      });
      try {
        const s = await serve(home);
        for (const seq of seqs) {
          const outcomes = await replay(s, seq);
          expect(outcomes.length).toBe(seq.steps.length);
        }
        const { exit } = await s.stop();
        expect(exit.code).toBe(0);
      } finally {
        home.cleanup();
      }
    });
  },
);

// --- B11: the `full` sequences over real stdio on a seeded cache ------------------------------------

const FULL_SEQUENCES: Seq[] = loadToolSequences(ROOT, { toolset: "full" }).flatMap((s) =>
  s.sequences.map((q) => ({
    skill: s.skill,
    id: q.id,
    variant: q.fixture_variant,
    teamId: typeof s.fixture.team_id === "number" ? s.fixture.team_id : 2,
    steps: q.steps,
  })),
);
const FULL_VARIANTS = [...new Set(FULL_SEQUENCES.map((s) => s.variant))];

describe(
  "Skills Lane 1 dry run under full: every full sequence against the built server on a seeded cache (plan 10 B11)",
  { timeout: 900_000 },
  () => {
    it("covers the five P1 Skills and the P1 branches of four P0 Skills", () => {
      expect([...new Set(FULL_SEQUENCES.map((s) => s.skill))].sort()).toEqual([
        "injury-cascade",
        "news-check",
        "roster-audit",
        "schedule-plan",
        "start-sit",
        "stream-kdef",
        "trade",
        "waivers",
        "weekly",
      ]);
    });

    it.each(FULL_VARIANTS.map((v) => [v ?? "base"] as const))("fx-10h %s (full)", async (name) => {
      requireDist();
      const variant = name === "base" ? null : name;
      const dir = variant === null ? FX : path.join(FX, variant);
      const seqs = FULL_SEQUENCES.filter((s) => s.variant === variant);
      const { teamUnset, env } = variantEnv(variant);
      const team = seqs[0]?.teamId ?? 2;
      const home = makeHome({
        fixtureDir: dir,
        teamId: teamUnset ? null : team,
        env: { ...env, EFF_TOOLSET: "full" },
      });
      const skipped: string[] = [];
      try {
        await seedHome(home, dir);
        const s = await serve(home);
        for (const seq of seqs) {
          const outcomes = await replay(s, seq, skipped);
          expect(outcomes.length).toBe(seq.steps.length);
        }
        const { exit } = await s.stop();
        expect(exit.code).toBe(0);
      } finally {
        home.cleanup();
      }
      // only a cascade-fed step may be skipped, never anything else
      for (const l of skipped)
        expect(l, "skipped step").toMatch(/^injury-cascade\/.*\/(?:waivers|log\w*|record\w*) /);
    });
  },
);
