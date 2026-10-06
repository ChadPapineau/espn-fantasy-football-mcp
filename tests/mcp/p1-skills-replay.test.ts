// p1-skills-replay.test.ts — the Skills' `full` tool sequences replayed IN PROCESS against the P1 tools
// (plan 10 B11 Lane 1 under `full`; plan 09 §5.1 items 3 and 7): every sequence `loadToolSequences(…,
// { toolset: "full" })` returns — the five P1 Skills and the P1 branches of start-sit, waivers, weekly
// and stream-kdef — runs step by step on its fx-10h variant in fixture mode under EFF_TOOLSET=full;
// each resolved argument set parses under the built tool's schema, each outcome is one the step's
// `expect` allows, and every `rec` carries an ordered interval. The Phase-2 dataset ports the store
// does not serve yet (depth charts, ep_weekly, news, trending) are injected LOADED and empty — the
// state a refreshed install is in on a quiet day — so the replay tests the tools, not a missing
// reader. The stdio twin of this replay belongs to tests/e2e (the built server); this one runs under
// coverage on every push.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadToolSequences,
  outcomeAllowed,
  resolveArgs,
} from "../../scripts/skills/tool-sequences.mjs";
import type { DatasetReaders, DatasetStamp } from "../../src/domain/analytics/types.js";
import type { DatasetSourceId, FreshnessClassId } from "../../src/config/freshness.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { ESPN_FIXTURES, ROOT, connect, makeWorld } from "./helpers/world.js";

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

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const SEQUENCES: Seq[] = loadToolSequences(ROOT, { toolset: "full" }).flatMap((s) =>
  s.sequences.map((q) => ({
    skill: s.skill,
    id: q.id,
    variant: q.fixture_variant,
    teamId: typeof s.fixture.team_id === "number" ? s.fixture.team_id : 2,
    steps: q.steps,
  })),
);
const VARIANTS = [...new Set(SEQUENCES.map((s) => s.variant))];

/** A loaded-and-empty dataset result at the variant's clock. */
function loaded(source: DatasetSourceId, cls: FreshnessClassId, at: string) {
  const stamp: DatasetStamp = {
    source,
    as_of: at,
    fetched_at: at,
    checked_at: at,
    freshness_class: cls,
    file_version: "fixture",
  };
  return { rows: [] as never[], stamp };
}

/** The Phase-2 ports, loaded and empty. */
function phase2Readers(at: string): Partial<DatasetReaders> {
  return {
    depthCharts: { chart: () => loaded("nflverse:depth_charts", "nflverse_depth_charts", at) },
    epWeekly: { rows: () => loaded("ffopportunity:ep_weekly", "ffopportunity_ep_weekly", at) },
    news: { recent: () => loaded("news:rotowire", "news", at) },
    trending: { latest: () => loaded("sleeper:trending", "sleeper_trending", at) },
  };
}

const inputOf = (tool: string) => {
  const def = REGISTRY.find((e) => e.name === tool)?.tool;
  if (def === undefined || def === null) throw new Error(`${tool} is not built`);
  return def.input;
};

/** Every Rec carries an ordered interval (plan 09 §5.1 #7). */
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
      expect(rec.distribution?.p10 ?? 0, label).toBeLessThanOrEqual(rec.distribution?.p90 ?? 0);
      expect(rec.delta_vs_next?.p10 ?? 0, label).toBeLessThanOrEqual(rec.delta_vs_next?.p90 ?? 0);
    }
    for (const x of Object.values(o)) if (typeof x === "object") visit(x);
  };
  visit(body);
}

describe("the Skills' full sequences against the P1 tools (in process, fixture mode)", () => {
  it("covers the five P1 Skills and the four P0 Skills' P1 branches", () => {
    expect([...new Set(SEQUENCES.map((s) => s.skill))].sort()).toEqual([
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

  it.each(VARIANTS.map((v) => [v ?? "base"] as const))(
    "fx-10h %s",
    async (name) => {
      const variant = name === "base" ? null : name;
      const dir = variant === null ? FX : path.join(FX, variant);
      const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
        clock: string;
        env?: Record<string, string | null>;
      };
      const seqs = SEQUENCES.filter((s) => s.variant === variant);
      const teamUnset = m.env?.ESPN_TEAM_ID === null;
      const world = await makeWorld({
        env: { EFF_FIXTURE_DIR: dir, EFF_TOOLSET: "full" },
        teamId: teamUnset ? null : (seqs[0]?.teamId ?? 2),
        clock: m.clock,
        publishEspn: false,
      });
      const skipped: string[] = [];
      const { client, close } = await connect(world, {
        options: { toolset: "full" },
        services: { datasets: { ...world.services.datasets, ...phase2Readers(m.clock) } },
      });
      try {
        for (const seq of seqs) {
          const results = new Map<string, { tool: string; result: unknown }>();
          const skippedIds = new Set<string>();
          for (const step of seq.steps) {
            const label = `${seq.skill}/${seq.id}/${step.id} (${step.tool})`;
            let args: Record<string, unknown>;
            try {
              args = resolveArgs(step.args, results) as Record<string, unknown>;
            } catch (e) {
              // a step fed by an earlier list that is empty on fixture data (the cascade's
              // beneficiaries need nflverse usage the fixture league does not carry) is skipped
              const msg = String(e);
              const fed = [...skippedIds].some((id) => msg.includes(`step ${id} has no result`));
              if (/\$ids .*no player_id/.test(msg) || fed) {
                skipped.push(label);
                skippedIds.add(step.id);
                continue;
              }
              throw e;
            }
            expect(inputOf(step.tool).safeParse(args).success, `${label}: arguments`).toBe(true);
            const r = (await client.callTool({ name: step.tool, arguments: args })) as {
              isError?: boolean;
              content: { text: string }[];
            };
            const b = JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>;
            const outcome = r.isError === true ? (b.error as { code: string }).code : "ok";
            expect(
              outcomeAllowed(step, outcome),
              `${label} → ${outcome}: ${JSON.stringify(b).slice(0, 300)}`,
            ).toBe(true);
            if (outcome === "ok") {
              checkRecs(label, b.data);
              results.set(step.id, { tool: step.tool, result: b });
            }
          }
        }
        // only the cascade-fed waiver step may be skipped, never anything else
        for (const l of skipped)
          expect(l, "skipped step").toMatch(/^injury-cascade\/.*\/(?:waivers|log\w*|record\w*) /);
      } finally {
        await close();
        world.cleanup();
      }
    },
    240_000,
  );
});
