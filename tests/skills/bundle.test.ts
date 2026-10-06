// bundle.test.ts — the thirteen Skills against the contract layer (plan 09 §2, §3, §5.1; plan 07 C3,
// §3; plan 10 A9b, A14a, B10, B11). The scripts are zero-dependency and read the TypeScript by regex; this
// file closes the loop with real imports: the manifest's tool lists and input enums equal
// src/mcp/bounds.ts and src/providers, every record step validates against the real
// espn_record_recommendation input schema, the onboarding entry is accepted, the sentences are the
// exported ones, and the existing structural CI check passes on the bundle.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkills } from "../../scripts/skills/build-skills.mjs";
import {
  ESPN_FREE_TEXT_CLAUSE,
  parseFrontmatter,
  readManifest,
} from "../../scripts/skills/_lib.mjs";
import {
  PLUGIN_NAME,
  checkSkills as checkStructure,
} from "../../scripts/ci/check-skills-structure.mjs";
import {
  BOUNDS,
  N_SIMS_MAX,
  detailSchema,
  leagueIncludeSchema,
  objectiveSchema,
  playerSortSchema,
  playerStatusSchema,
  projectionHorizonSchema,
  recordRecommendationInputSchema,
  reserveSchema,
  seedingModeArgSchema,
  transactionTypesSchema,
  valueSourceSchema,
  waiverModeSchema,
  waiverPhaseSchema,
} from "../../src/mcp/bounds.js";
import { MANDATORY_SENTENCES, UNTRUSTED_TEXT_RULE } from "../../src/mcp/envelope.js";
import { ERROR_CODES } from "../../src/mcp/errors.js";
import { RECOMMENDATION_KINDS } from "../../src/domain/reclog/types.js";
import {
  ESPN_INJURY_STATUSES,
  IR_ELIGIBLE_INJURY_STATUSES,
} from "../../src/domain/league/types.js";
import { PLAYER_SORTS } from "../../src/providers/espn/types.js";
import { INJURY_STATUSES, TOOLSET_STOP } from "../../scripts/skills/check-skills.mjs";
import { REGISTRY } from "../../src/mcp/registry.js";
import {
  BOUNDS as B,
  espnProjectionHorizonSchema,
  matchupModeSchema,
  seasonHorizonSchema,
  statsTypeSchema,
  winProbMethodSchema,
} from "../../src/mcp/bounds.js";
import { P0_SKILLS, P1_SKILLS, ROOT, SKILLS, readSequence, type SeqStep } from "./helpers.js";

type Json = Record<string, unknown>;
const manifest = readManifest(ROOT);
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const bodyOf = (skill: string) => {
  const text = read(`skills/${skill}/SKILL.md`);
  return text.split("\n").slice(parseFrontmatter(text).bodyStart).join("\n");
};
const enumOf = (spec: string | undefined) => {
  expect(spec, "declared").toBeDefined();
  return (spec ?? "").replace(/^enum(\[\])?:/, "").split("|");
};
const rangeOf = (spec: string | undefined) => (spec ?? "").replace(/^(int|number|int\[\]):/, "");

describe("the manifest equals the tool catalog and the contract layer", () => {
  it("lists the 18 P0 tools of plan 07 C3 under core and the 16 P1 tools — 34 under full", () => {
    expect([...manifest.core].sort()).toEqual(
      [
        "espn_get_league",
        "espn_get_standings",
        "espn_get_scoreboard",
        "espn_get_live_scoreboard",
        "espn_get_box_score",
        "espn_list_transactions",
        "espn_get_roster",
        "espn_search_players",
        "espn_list_players",
        "espn_get_injuries",
        "espn_get_schedule",
        "espn_project_players",
        "espn_analyze_lineup",
        "espn_analyze_waivers",
        "espn_record_recommendation",
        "espn_analyze_retrospective",
        "espn_get_status",
        "espn_check_auth",
      ].sort(),
    );
    expect(new Set([...manifest.core, ...manifest.p1]).size).toBe(34);
    for (const w of manifest.write_tools) expect(w).toMatch(/^espn_(prepare|commit|cancel)_/);
  });

  it("names the plugin the structural CI check names (the config key the eight strings depend on)", () => {
    expect(manifest.plugin).toBe(PLUGIN_NAME);
  });

  it("carries the input enums of src/mcp/bounds.ts exactly", () => {
    const i = manifest.inputs;
    expect(enumOf(i.espn_analyze_lineup?.objective)).toEqual(objectiveSchema.options);
    expect(enumOf(i.espn_analyze_lineup?.seeding_mode)).toEqual(seedingModeArgSchema.options);
    expect(enumOf(i.espn_analyze_waivers?.mode)).toEqual(waiverModeSchema.options);
    expect(enumOf(i.espn_analyze_waivers?.phase)).toEqual(waiverPhaseSchema.options);
    expect(enumOf(i.espn_analyze_waivers?.value_source)).toEqual(valueSourceSchema.options);
    expect(enumOf(i.espn_analyze_waivers?.reserve)).toEqual(reserveSchema.options);
    expect(enumOf(i.espn_project_players?.horizon)).toEqual(projectionHorizonSchema.options);
    expect(enumOf(i.espn_list_players?.status)).toEqual(playerStatusSchema.options);
    expect(enumOf(i.espn_list_players?.sort)).toEqual(playerSortSchema.options);
    expect(enumOf(i.espn_list_players?.sort)).toEqual([...PLAYER_SORTS]);
    expect(enumOf(i.espn_get_league?.include)).toEqual(leagueIncludeSchema.element.options);
    expect(enumOf(i.espn_list_transactions?.types)).toEqual(transactionTypesSchema.element.options);
    expect(enumOf(i.espn_record_recommendation?.kind)).toEqual([...RECOMMENDATION_KINDS]);
    expect(enumOf(i.espn_analyze_retrospective?.kinds)).toEqual([...RECOMMENDATION_KINDS]);
    for (const [tool, spec] of Object.entries(i)) {
      if (spec.detail !== undefined)
        expect(enumOf(spec.detail), tool).toEqual(detailSchema.unwrap().options);
    }
  });

  it("carries the bounds of src/mcp/bounds.ts exactly", () => {
    const i = manifest.inputs;
    const r = (b: { min: number; max: number }) => `${String(b.min)}..${String(b.max)}`;
    for (const tool of [
      "espn_get_scoreboard",
      "espn_get_box_score",
      "espn_get_roster",
      "espn_list_players",
      "espn_project_players",
      "espn_analyze_lineup",
      "espn_analyze_retrospective",
    ]) {
      expect(rangeOf(i[tool]?.week), tool).toBe(r(BOUNDS.week));
    }
    expect(rangeOf(i.espn_record_recommendation?.week)).toBe(`0..${String(BOUNDS.week.max)}`);
    expect(rangeOf(i.espn_get_roster?.team_id)).toBe(r(BOUNDS.teamId));
    expect(rangeOf(i.espn_list_players?.limit)).toBe(r(BOUNDS.limit));
    expect(rangeOf(i.espn_list_players?.offset)).toBe(r(BOUNDS.offset));
    expect(rangeOf(i.espn_search_players?.limit)).toBe(r(BOUNDS.searchLimit));
    expect(rangeOf(i.espn_list_transactions?.count)).toBe(r(BOUNDS.txnCount));
    expect(rangeOf(i.espn_analyze_waivers?.look_ahead)).toBe(r(BOUNDS.lookAhead));
    expect(rangeOf(i.espn_analyze_waivers?.horizon_weeks)).toBe(r(BOUNDS.horizonWeeks));
    expect(rangeOf(i.espn_project_players?.n_sims)).toBe(
      `${String(BOUNDS.nSims.min)}..${String(N_SIMS_MAX)}`,
    );
    expect(rangeOf(i.espn_project_players?.seed)).toBe(r(BOUNDS.seed));
    expect(rangeOf(i.espn_analyze_retrospective?.min_n)).toBe(r(BOUNDS.minN));
    expect(rangeOf(i.espn_get_league?.season)).toBe(r(BOUNDS.season));
    expect(rangeOf(i.espn_analyze_lineup?.blend_weight)).toBe(r(BOUNDS.blendWeight));
    expect(rangeOf(i.espn_analyze_lineup?.pf_weight)).toBe(r(BOUNDS.pfWeight));
  });

  it("carries the P1 input enums and bounds of src/mcp/bounds.ts exactly", () => {
    const i = manifest.inputs;
    const r = (b: { min: number; max: number }) => `${String(b.min)}..${String(b.max)}`;
    expect(enumOf(i.espn_analyze_matchup?.mode)).toEqual(matchupModeSchema.options);
    expect(enumOf(i.espn_analyze_matchup?.method)).toEqual(winProbMethodSchema.options);
    expect(enumOf(i.espn_analyze_matchup?.horizon)).toEqual(seasonHorizonSchema.options);
    expect(enumOf(i.espn_analyze_matchup?.seeding_mode)).toEqual(seedingModeArgSchema.options);
    expect(enumOf(i.espn_get_projections?.horizon)).toEqual(espnProjectionHorizonSchema.options);
    expect(enumOf(i.espn_get_player_stats?.type)).toEqual(statsTypeSchema.options);
    // E6 takes the configured reading or both (plan 07 E6) — a subset of the E2/E3 enum
    for (const v of enumOf(i.espn_analyze_trade?.seeding_mode))
      expect(seedingModeArgSchema.options).toContain(v);
    expect(enumOf(i.espn_list_recommendations?.kind)).toEqual([...RECOMMENDATION_KINDS]);
    expect(rangeOf(i.espn_get_player_usage?.window)).toBe(r(B.usageWindow));
    expect(rangeOf(i.espn_get_news?.since_hours)).toBe(r(B.sinceHours));
    expect(rangeOf(i.espn_get_news?.limit)).toBe(r(B.newsLimit));
    expect(rangeOf(i.espn_analyze_league_activity?.since_days)).toBe(r(B.sinceDays));
    expect(rangeOf(i.espn_get_defense_profile?.window_weeks)).toBe(r(B.defenseWindowWeeks));
    expect(rangeOf(i.espn_analyze_injury_cascade?.assume_weeks_out)).toBe(r(B.assumeWeeksOut));
    expect(rangeOf(i.espn_analyze_matchup?.n_sims)).toBe(
      `${String(B.nSims.min)}..${String(N_SIMS_MAX)}`,
    );
    expect(rangeOf(i.espn_list_recommendations?.limit)).toBe(r(B.limit));
    expect(rangeOf(i.espn_list_recommendations?.offset)).toBe(r(B.offset));
    for (const tool of ["espn_analyze_matchup", "espn_analyze_schedule", "espn_analyze_roster"]) {
      const spec = i[tool];
      if (spec?.team_id !== undefined) expect(rangeOf(spec.team_id), tool).toBe(r(B.teamId));
    }
    // the selector variants: E7/E10/D4 take one player, C4 at most 12 (src/mcp/bounds.ts)
    expect(i.espn_analyze_injury_cascade?.player).toBe("selector:single");
    expect(i.espn_analyze_evidence?.player).toBe("selector:single");
    expect(i.espn_get_depth_chart?.player).toBe("selector:single");
    expect(i.espn_get_player_outlook?.players).toBe("selector:outlook");
    expect(B.outlookIds.max).toBe(12);
    expect(B.playerIds.max).toBe(25);
  });

  it("the $player status filter knows exactly ESPN's injury statuses", () => {
    expect([...INJURY_STATUSES]).toEqual([...ESPN_INJURY_STATUSES]);
  });

  it("allows only constants the domain knows, and the error codes are the exported ones", () => {
    for (const s of ESPN_INJURY_STATUSES) expect(manifest.constants).toContain(s);
    for (const c of manifest.constants) expect(ERROR_CODES as readonly string[]).not.toContain(c);
  });
});

/** A valid Rec for the record-step stand-ins (src/mcp/envelope.ts recSchema). */
const SAMPLE_REC = {
  action: "Start the FLEX receiver",
  subjects: [],
  lineup: null,
  point_estimate: 11.2,
  distribution: {
    mean: 11.2,
    p10: 4,
    p25: 7.5,
    p50: 11,
    p75: 14.5,
    p90: 18.9,
    p_zero: 0.03,
    basis: "position_cv",
  },
  delta_vs_next: { value: 0.8, p10: -3.1, p90: 4.4 },
  decision_metric: "expected_points",
  drivers: [],
  assumptions: [],
  confidence: { role_games: 4, inputs: [] },
  as_of: "2026-10-06T21:00:00-04:00",
  latest_execution_time: null,
  no_move: false,
  log_id: null,
};
const SAMPLE_HASH = "a".repeat(64);

/** Replace each template with a value of the shape it resolves to at run time. */
function standIns(args: Json, steps: SeqStep[]): Json {
  const walk = (v: unknown, key: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v === null || typeof v !== "object") return v;
    const o = v as Json;
    if ("$source_calls" in o) {
      return (o.$source_calls as string[]).map((id) => ({
        tool: steps.find((s) => s.id === id)?.tool,
        request_id: "r-0123456789ab",
      }));
    }
    if ("$ref" in o) {
      const stand: Json = {
        rec: SAMPLE_REC,
        settings_hash: SAMPLE_HASH,
        seeding_mode_used: "espn_rule",
        week: 5,
        as_of: "2026-10-06T21:00:00-04:00",
      };
      if (!(key in stand)) throw new Error(`no stand-in for a $ref at ${key}`);
      return stand[key];
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x, k)]));
  };
  return walk(args, "") as Json;
}

describe("every promised call is a valid call", () => {
  it("every record step, its templates stood in, passes the real espn_record_recommendation input schema", () => {
    let n = 0;
    for (const s of SKILLS) {
      for (const q of readSequence(s).sequences) {
        for (const st of q.steps.filter((x) => x.tool === "espn_record_recommendation")) {
          const parsed = recordRecommendationInputSchema.safeParse(standIns(st.args, q.steps));
          expect(
            parsed.success,
            `${s}/${q.id}/${st.id}: ${JSON.stringify(parsed.error?.issues ?? [])}`,
          ).toBe(true);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThanOrEqual(12);
  });

  it("P0 Skills run under core with P0 tools; their P1 branches are sequences of their own under full (ADV OBJ-18)", () => {
    let branches = 0;
    for (const s of P0_SKILLS) {
      const f = readSequence(s);
      expect(f.toolset, s).toBe("core");
      for (const q of f.sequences) {
        const tools = q.steps.map((st) => st.tool);
        if ((q as { toolset?: string }).toolset === "full") {
          branches++;
          expect(
            tools.some((t) => manifest.p1.includes(t)),
            `${s}/${q.id}`,
          ).toBe(true);
          for (const t of tools) expect([...manifest.core, ...manifest.p1]).toContain(t);
        } else {
          for (const t of tools) expect(manifest.core, `${s}/${q.id}`).toContain(t);
        }
      }
    }
    // waivers' usage branch and FAAB curve, start-sit's live P(win) (plan 10 §3.2 Skills), and
    // the P1 steps weekly and stream-kdef already name (plan 09 §5.1 item 3)
    expect(branches).toBe(5);
  });

  it("P1 Skills run under full, and every P1 tool the bundle promises is a P1 row of the registry", () => {
    const p1Rows = REGISTRY.filter((r) => r.priority === "P1").map((r) => r.name);
    expect(manifest.p1).toEqual(p1Rows);
    expect(manifest.core).toEqual(REGISTRY.filter((r) => r.priority === "P0").map((r) => r.name));
    const used = new Set<string>();
    for (const s of P1_SKILLS) {
      const f = readSequence(s);
      expect(f.toolset, s).toBe("full");
      for (const q of f.sequences) {
        expect((q as { toolset?: string }).toolset, `${s}/${q.id}`).toBeUndefined();
        for (const st of q.steps) {
          expect([...manifest.core, ...manifest.p1], `${s}/${q.id}/${st.id}`).toContain(st.tool);
          if (manifest.p1.includes(st.tool)) used.add(st.tool);
        }
      }
    }
    // the five P1 Skills between them call every P1 analytics engine plan 09 §3 gives them
    for (const t of [
      "espn_analyze_trade",
      "espn_analyze_injury_cascade",
      "espn_analyze_schedule",
      "espn_analyze_roster",
      "espn_analyze_evidence",
      "espn_analyze_matchup",
      "espn_analyze_replacement",
      "espn_get_player_usage",
      "espn_get_depth_chart",
      "espn_get_player_outlook",
      "espn_get_news",
      "espn_list_recommendations",
    ])
      expect(used, t).toContain(t);
  });

  it("every P1 Skill's Step 0 carries the toolset stop, and orient.md says it the same way (plan 10 B10)", () => {
    for (const s of P1_SKILLS) expect(bodyOf(s), s).toContain(TOOLSET_STOP);
    expect(read("skills/_shared/references/orient.md")).toContain(TOOLSET_STOP);
    for (const s of P0_SKILLS) expect(bodyOf(s), s).not.toContain(TOOLSET_STOP);
  });
});

describe("the onboarding log entry (plan 09 §3.1; log discipline)", () => {
  const guide = read("skills/onboard/references/onboard-log-entry.md");
  const blocks = [...guide.matchAll(/^```json\n([\s\S]*?)^```/gm)].map((m) => m[1] ?? "");
  const isPlaceholder = (v: unknown): v is string => typeof v === "string" && /^<[^>]+>$/.test(v);

  it("is one JSON block, and the Skill's log step points at it", () => {
    expect(blocks).toHaveLength(1);
    expect(bodyOf("onboard")).toMatch(
      /`espn_record_recommendation` with `kind: "onboarding"`[^\n]*\(references\/onboard-log-entry\.md\)/,
    );
  });

  it("equals the Lane 1 sequence's entry (one source), placeholders aside", () => {
    const t = JSON.parse(blocks[0] ?? "{}") as Json;
    const step = readSequence("onboard")
      .sequences.find((q) => q.id === "setup")
      ?.steps.find((x) => x.tool === "espn_record_recommendation");
    expect(step).toBeDefined();
    const rec = t.rec as Json;
    const seqRec = step?.args.rec as Json;
    expect(isPlaceholder(rec.as_of)).toBe(true);
    expect({ ...rec, as_of: null }).toEqual({ ...seqRec, as_of: null });
    for (const k of ["kind", "alternatives", "followed_hint", "client_ref"])
      expect(t[k], k).toEqual(step?.args[k]);
  });

  it("filled with values the procedure has, is accepted by the real input schema", () => {
    const t = JSON.parse(blocks[0] ?? "{}") as Json;
    const fill = (v: unknown, key: string): unknown => {
      if (Array.isArray(v)) return v.map((x) => fill(x, key));
      if (v !== null && typeof v === "object")
        return Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, fill(x, k)]));
      if (!isPlaceholder(v)) return v;
      const values: Json = {
        week: 5,
        as_of: "2026-10-06T21:00:00-04:00",
        settings_hash: SAMPLE_HASH,
        request_id: "r-0123456789ab",
      };
      if (!(key in values)) throw new Error(`unfillable placeholder at ${key}`);
      return values[key];
    };
    const parsed = recordRecommendationInputSchema.safeParse(fill(t, ""));
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });
});

describe("the sentences and the vocabulary are the exported ones", () => {
  it("every body carries UNTRUSTED_TEXT_RULE and the ESPN clause; tool-outputs.md carries both mandatory sentences", () => {
    for (const s of SKILLS) {
      expect(bodyOf(s), s).toContain(UNTRUSTED_TEXT_RULE);
      expect(bodyOf(s), s).toContain(ESPN_FREE_TEXT_CLAUSE);
    }
    const sheet = read("skills/_shared/references/tool-outputs.md");
    for (const m of MANDATORY_SENTENCES) expect(sheet).toContain(m);
  });

  it("the guardrails name exactly the IR-eligible statuses, and the vocabulary every ESPN status", () => {
    const g = read("skills/_shared/references/guardrails.md");
    expect(g).toContain(
      `IR-eligible means \`${IR_ELIGIBLE_INJURY_STATUSES[0] ?? ""}\` or \`${IR_ELIGIBLE_INJURY_STATUSES[1] ?? ""}\` — nothing else`,
    );
    const v = read("skills/_shared/references/espn-vocabulary.md");
    for (const s of ESPN_INJURY_STATUSES) expect(v).toContain(`\`${s}\``);
  });

  it("every SKILL.md lists the manifest's eight disallowed-tools strings exactly, apply included (this build)", () => {
    for (const s of SKILLS) {
      expect(parseFrontmatter(read(`skills/${s}/SKILL.md`)).data["disallowed-tools"], s).toEqual(
        manifest.disallowed_tools,
      );
    }
  });
});

describe("read-only by construction (PHASE W SEAM — NOT IMPLEMENTED)", () => {
  const allFiles = (dir: string): string[] => {
    return readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? allFiles(p) : [p];
    });
  };

  it("no file under skills/ names a prepare or commit tool outside a qualified deny string", () => {
    for (const f of allFiles(path.join(ROOT, "skills"))) {
      expect(
        /(?<![A-Za-z0-9_])espn_(?:prepare|commit)_/.test(readFileSync(f, "utf8")),
        path.relative(ROOT, f),
      ).toBe(false);
    }
  });

  it("apply declares the seam and is user-invoked only", () => {
    expect(bodyOf("apply")).toContain("## PHASE W SEAM — NOT IMPLEMENTED");
    expect(parseFrontmatter(read("skills/apply/SKILL.md")).data["disable-model-invocation"]).toBe(
      true,
    );
  });

  it("the existing structural CI check passes on the bundle (thirteen Skills)", () => {
    expect(checkStructure(ROOT)).toEqual({ count: 13, errors: [] });
  });

  it("the committed bundle is built (stamped blocks and copies current)", () => {
    expect(buildSkills({ root: ROOT, check: true })).toMatchObject({ errors: [], changed: [] });
  });
});

describe("Lane 2 coverage (plan 10 A9b)", () => {
  it("every Skill has ≥ 3 cases and an -INJ case, and the -INJ cases run on an injection variant or a paste", () => {
    for (const s of SKILLS) {
      const e = JSON.parse(read(`skills/${s}/evals/evals.json`)) as {
        evals: { name: string; files: string[]; prompt: string }[];
      };
      expect(e.evals.length, s).toBeGreaterThanOrEqual(3);
      const inj = e.evals.filter((c) => c.name.includes("-INJ"));
      expect(inj.length, s).toBeGreaterThanOrEqual(1);
      for (const c of inj) {
        const variant = c.files[0]?.split("/")[3] ?? "";
        const pasted = /says|texted|sent|paste|league chat|NOW/i.test(c.prompt);
        const readBack = /logged/i.test(c.prompt); // NC-INJ-2: the log read back in a later session
        expect(variant.startsWith("inj-") || pasted || readBack, `${s}/${c.name}`).toBe(true);
      }
    }
  });
});

describe("the manifest's input contracts bind to the registered tools (plan 09 §5.1 item 3)", () => {
  /** The top-level keys of a tool's zod input (an object schema), or null when it is not one. */
  const shapeOf = (input: unknown): Record<string, unknown> | null => {
    const s = (input as { shape?: unknown }).shape;
    return typeof s === "object" && s !== null ? (s as Record<string, unknown>) : null;
  };
  const optional = (field: unknown): boolean =>
    (field as { safeParse: (v: unknown) => { success: boolean } }).safeParse(undefined).success;
  const built = REGISTRY.filter((r) => r.tool !== null);

  it("every P0 tool is built, and every built tool's input keys are the manifest's, required ones included", () => {
    for (const r of REGISTRY.filter((x) => x.priority === "P0"))
      expect(r.tool, `${r.name} is a P0 tool and must be built`).not.toBeNull();
    let p1Built = 0;
    for (const r of built) {
      if (r.priority === "P1") p1Built++;
      const shape = shapeOf(r.tool?.input);
      expect(shape, `${r.name}: the input is an object schema`).not.toBeNull();
      const real = Object.keys(shape ?? {}).sort();
      const promised = Object.keys(manifest.inputs[r.name] ?? {}).sort();
      // a Skill may only promise inputs the tool takes; the tool may take more (debug flags)
      for (const k of promised) expect(real, `${r.name} has no input \`${k}\``).toContain(k);
      const required = real.filter((k) => !optional(shape?.[k]));
      expect([...(manifest.required_inputs[r.name] ?? [])].sort(), `${r.name} required`).toEqual(
        required,
      );
    }
    // the P1 rows bind as they are registered (Stage B2); the count is logged, never assumed
    console.log(`[bundle] built P1 tools checked against the manifest: ${String(p1Built)} of 16`);
  });

  it("every literal argument the sequences promise parses under the built tool's own schema, templates stood in", () => {
    let nextId = 4_000_000; // distinct stand-in ids: a selector refuses duplicates
    const stand = (v: unknown, key: string): unknown => {
      if (Array.isArray(v)) return v.map((x) => stand(x, key));
      if (v === null || typeof v !== "object") return v;
      const o = v as Json;
      if ("$player" in o) return nextId++;
      if ("$opponent" in o) return 10;
      if ("$ids" in o) return [4379399];
      if ("$source_calls" in o) return [{ tool: "espn_get_roster", request_id: "r-0123456789ab" }];
      if ("$ref" in o) return undefined; // resolved at run time: checked by the dry run, not here
      return Object.fromEntries(
        Object.entries(o)
          .map(([k, x]) => [k, stand(x, k)] as const)
          .filter(([, x]) => x !== undefined),
      );
    };
    let checked = 0;
    for (const s of SKILLS) {
      for (const q of readSequence(s).sequences) {
        for (const st of q.steps) {
          const def = REGISTRY.find((r) => r.name === st.tool)?.tool;
          if (def === null || def === undefined || st.tool === "espn_record_recommendation")
            continue;
          const args = stand(st.args, "") as Json;
          // a step whose required input is a $ref is resolved by the dry run only
          if ((manifest.required_inputs[st.tool] ?? []).some((k) => !(k in args))) continue;
          const parsed = def.input.safeParse(args);
          expect(
            parsed.success,
            `${s}/${q.id}/${st.id}: ${JSON.stringify(parsed.error?.issues ?? [])}`,
          ).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(100);
  });
});
