// check-skills-p1.test.ts — the Phase-2 rules of scripts/skills/check-skills.mjs (plan 09 §2 P1
// Step 0, §3.3 live P(win), §3.8 usage branch, §3.9–§3.13, §5.1 items 3–5; plan 10 B10, B11): the
// five P1 Skills and the P0 Skills' P1 branches pass on the committed bundle, and every new rule
// fails on a mutated private copy — the toolset stated per sequence and per case, the Step 0 stop,
// the per-Skill sequence promises, the trade/claim argument shapes, the new templates, and the
// trigger collisions across all thirteen.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CORE_CASE_RE,
  IDS_MAX,
  SKILL_RULES,
  TOOLSET_STOP,
  checkArgType,
  checkSkills,
  claimProblems,
  p1StepTools,
  recKindOf,
  tradeArgProblems,
} from "../../scripts/skills/check-skills.mjs";
import { readManifest } from "../../scripts/skills/_lib.mjs";
import { P1_SKILLS, ROOT, emptyDenylist, tempRepo, type TempRepo } from "./helpers.js";

type Json = Record<string, unknown>;
interface Step {
  id: string;
  tool: string;
  args: Json;
  expect?: string[];
}
interface Seq {
  id: string;
  toolset?: string;
  fixture_variant?: string;
  steps: Step[];
}

let deny: ReturnType<typeof emptyDenylist>;
beforeAll(() => {
  deny = emptyDenylist();
});
afterAll(() => {
  deny.cleanup();
});
let repo: TempRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});
const fresh = (): TempRepo => {
  repo = tempRepo();
  return repo;
};
const errorsOf = (t: TempRepo) =>
  checkSkills({ root: t.root, scan: false, scanEnv: deny.env }).errors.join("\n");
const SEQ = (s: string) => `skills/${s}/evals/tool_sequence.json`;
const EVALS = (s: string) => `skills/${s}/evals/evals.json`;
const TRIG = (s: string) => `skills/${s}/evals/trigger_eval.json`;
const seqs = (j: Json) => j.sequences as Seq[];
const seq = (j: Json, id: string) => seqs(j).find((s) => s.id === id)!;
const step = (j: Json, sid: string, id: string) => seq(j, sid).steps.find((s) => s.id === id)!;
const cases = (j: Json) => j.evals as Json[];
const kase = (j: Json, name: string) => cases(j).find((c) => c.name === name)!;
interface Trigger {
  query: string;
  should_trigger: boolean;
}
/** Append trigger cases to a Skill's trigger_eval.json in the copy (the file is a JSON array). */
const addTriggers = (t: TempRepo, skill: string, add: Trigger[]) => {
  t.write(TRIG(skill), [...(t.readJson(TRIG(skill)) as Trigger[]), ...add]);
};

describe("the committed bundle under the P1 rules", () => {
  it("every P1 Skill has its rule, a P1 prefix and a -CORE case requirement", () => {
    for (const s of P1_SKILLS) {
      const r = SKILL_RULES[s];
      expect(r, s).toBeDefined();
      expect(
        r?.requiredCases.filter((c) => CORE_CASE_RE.test(c)),
        s,
      ).toHaveLength(1);
      expect(
        r?.requiredCases.some((c) => c.endsWith("-INJ")),
        s,
      ).toBe(true);
      expect(r?.records, s).toBe(true);
    }
    expect(TOOLSET_STOP).toContain("`EFF_TOOLSET=full`");
  });

  it("passes with the scanner (thirteen Skills; P0 under core, P1 under full)", () => {
    const r = checkSkills({ root: ROOT, scan: true, scanEnv: deny.env });
    expect(r.errors).toEqual([]);
    expect(r.skills).toHaveLength(13);
  });
});

describe("the P1 Skill body", () => {
  it("fails without the Step 0 toolset stop, verbatim", () => {
    const t = fresh();
    t.edit("skills/trade/SKILL.md", "restart the client.", "reload.");
    expect(errorsOf(t)).toMatch(
      /trade\/SKILL\.md: a P1 Skill's Step 0 must carry the toolset stop/,
    );
  });

  it("news-check fails when the body says posterior (no merged estimate at P1)", () => {
    const t = fresh();
    t.edit(
      "skills/news-check/SKILL.md",
      "## Output additions",
      "Print the posterior.\n\n## Output additions",
    );
    expect(errorsOf(t)).toMatch(/news-check\/SKILL\.md: body must not mention \/posterior\/i/);
  });

  it.each([
    ["trade", /devil's advocate/i, "contrarian"],
    ["injury-cascade", /hypothesis_only/g, "guess_only"],
    ["schedule-plan", /marginal-values table/gi, "values grid"],
    ["roster-audit", /hidden-bench/gi, "spare-slot"],
    ["news-check", /priors are hand-set/g, "priors are fixed"],
  ])("%s fails when it drops a plan 09 §3 body promise", (skill, re, to) => {
    const t = fresh();
    t.edit(`skills/${skill}/SKILL.md`, re, to);
    expect(errorsOf(t)).toMatch(new RegExp(`${skill}/SKILL\\.md: body must mention`));
  });

  it("a P1 Skill may name P1 tools anywhere; a P0 body may not off a P1 line", () => {
    const t = fresh();
    t.edit(
      "skills/retro/SKILL.md",
      "## Output additions",
      "Then `espn_get_news`.\n\n## Output additions",
    );
    const e = errorsOf(t);
    expect(e).toMatch(/retro\/SKILL\.md: espn_get_news is a P1 tool/);
    expect(e).not.toMatch(/trade\/SKILL\.md: espn_analyze_trade is a P1 tool/);
  });
});

describe("toolset per sequence (plan 09 §5.1 item 3)", () => {
  it("a P1 Skill's sequence may not set its own toolset", () => {
    const t = fresh();
    t.editJson(SEQ("trade"), (j) => (seq(j, "offer").toolset = "full"));
    expect(errorsOf(t)).toMatch(/a P1 Skill's sequences all run under the file's toolset "full"/);
  });

  it("a P0 Skill's sequence toolset may only be full, and a full one must call a P1 tool", () => {
    const t = fresh();
    t.editJson(SEQ("retro"), (j) => (seqs(j)[0]!.toolset = "core"));
    t.editJson(SEQ("weekly"), (j) => (seqs(j)[0]!.toolset = "full"));
    const e = errorsOf(t);
    expect(e).toMatch(
      /retro\/evals\/tool_sequence\.json sequences\[0\]: a sequence toolset may only be "full"/,
    );
    expect(e).toMatch(
      /weekly\/evals\/tool_sequence\.json sequences\[0\]: a sequence under toolset "full" in a P0 Skill must call a P1 tool/,
    );
  });

  it("a P1 tool in a P0 Skill's core sequence names the toolset it runs under", () => {
    const t = fresh();
    t.editJson(SEQ("waivers"), (j) => delete seq(j, "usage_pre_run").toolset);
    expect(errorsOf(t)).toMatch(
      /espn_get_player_usage is a P1 tool; this sequence runs under EFF_TOOLSET=core/,
    );
  });

  it("every P1 step a P0 body names is called by one of its full sequences", () => {
    const t = fresh();
    t.editJson(
      SEQ("weekly"),
      (j) => (j.sequences = seqs(j).filter((s) => s.id !== "pre_run_full")),
    );
    t.editJson(SEQ("stream-kdef"), (j) => {
      const s = seq(j, "both_full");
      s.steps = s.steps.filter((x) => x.tool !== "espn_get_defense_profile");
      for (const x of s.steps)
        if (x.tool === "espn_record_recommendation")
          (x.args.source_calls as Json).$source_calls = ["roster", "schedule"];
    });
    const e = errorsOf(t);
    for (const tool of [
      "espn_analyze_league_activity",
      "espn_analyze_schedule",
      "espn_get_player_usage",
    ])
      expect(e).toContain(
        `skills/weekly/evals/tool_sequence.json: the body's P1 step ${tool} is in no sequence under toolset "full"`,
      );
    expect(e).toContain(
      `skills/stream-kdef/evals/tool_sequence.json: the body's P1 step espn_get_defense_profile is in no sequence`,
    );
    expect(e).toMatch(/a sequence under toolset "full" in a P0 Skill must call a P1 tool/);
  });

  it("p1StepTools reads only P1-labelled lines, and only P1 tools on them", () => {
    const body = [
      "Call `espn_get_news` here.",
      "(P1; `espn_get_news` and `espn_get_roster` under full.)",
      "**P1:** `espn_analyze_trade` too.",
      "P1: `espn_get_depth_chart`.",
    ].join("\n");
    expect(p1StepTools(body, readManifest(ROOT))).toEqual([
      "espn_analyze_trade",
      "espn_get_depth_chart",
      "espn_get_news",
    ]);
  });

  it("a P1 Skill's file must run under full", () => {
    const t = fresh();
    t.editJson(SEQ("roster-audit"), (j) => (j.toolset = "core"));
    expect(errorsOf(t)).toMatch(/roster-audit\/evals\/tool_sequence\.json: toolset must be "full"/);
  });
});

describe("toolset per case (plan 10 B10, B11; ADV OBJ-18)", () => {
  type M = [string, string, (j: Json) => void, RegExp];
  const mutations: M[] = [
    [
      "a P1 case under core",
      "trade",
      (j) => (kase(j, "TR-1").toolset = "core"),
      /a P1 Skill's cases run under toolset "full"/,
    ],
    [
      "the -CORE case under full",
      "trade",
      (j) => (kase(j, "TR-CORE").toolset = "full"),
      /the -CORE case checks the Step 0 stop/,
    ],
    [
      "the -CORE case without the EFF_TOOLSET regex",
      "schedule-plan",
      (j) => {
        const c = kase(j, "SP-CORE");
        c.expectations = (c.expectations as string[]).filter((x) => !x.includes("EFF_TOOLSET"));
      },
      /needs a regex expectation that the reply names EFF_TOOLSET=full/,
    ],
    [
      "a P1 Skill without a -CORE case",
      "roster-audit",
      (j) => (j.evals = cases(j).filter((c) => c.name !== "RA-CORE")),
      /a P1 Skill needs a -CORE case/,
    ],
    [
      "a -CORE case in a P0 Skill",
      "retro",
      (j) => (cases(j)[0]!.name = "RT-CORE"),
      /a -CORE case belongs to a P1 Skill/,
    ],
    [
      "a P0 Skill's P1 case under core",
      "waivers",
      (j) => (kase(j, "WV-2").toolset = "core"),
      /WV-2 exercises the Skill's P1 branch/,
    ],
    [
      "a P0 Skill's P0 case under full",
      "start-sit",
      (j) => (kase(j, "SS-1").toolset = "full"),
      /a P0 Skill's cases run under toolset "core" \(its P1 cases: SS-11-E\)/,
    ],
    [
      "a P1 tool in a -CORE expectation",
      "news-check",
      (j) =>
        (kase(j, "NC-CORE").expectations as string[]).push(
          "espn_analyze_evidence was not called (tool_used)",
        ),
      /espn_analyze_evidence is not a registered tool under toolset core/,
    ],
    [
      "a missing required P1 case",
      "injury-cascade",
      (j) => (j.evals = cases(j).filter((c) => c.name !== "IC-2")),
      /missing case IC-2/,
    ],
  ];
  it.each(mutations)("fails on %s", (_l, skill, mutate, re) => {
    const t = fresh();
    t.editJson(EVALS(skill), mutate);
    expect(errorsOf(t)).toMatch(re);
  });
});

describe("the per-Skill sequence promises", () => {
  type M = [string, string, (j: Json) => void, RegExp];
  const mutations: M[] = [
    // trade (plan 09 §3.9)
    [
      "trade with both offer and find_partners",
      "trade",
      (j) => (step(j, "offer", "trade").args.find_partners = { need_position: "RB" }),
      /exactly one of `offer` and `find_partners`/,
    ],
    [
      "trade with neither",
      "trade",
      (j) => delete step(j, "offer", "trade").args.offer,
      /exactly one of `offer` and `find_partners`/,
    ],
    [
      "more than four partners",
      "trade",
      (j) => ((step(j, "partners", "search").args.find_partners as Json).max_partners = 5),
      /max_partners must be 1–4/,
    ],
    [
      "seven players on one side",
      "trade",
      (j) => ((step(j, "offer", "trade").args.offer as Json).give = [1, 2, 3, 4, 5, 6, 7]),
      /offer\.give must list 1–6 player ids/,
    ],
    [
      "an unknown offer key",
      "trade",
      (j) => ((step(j, "offer", "trade").args.offer as Json).note = "x"),
      /offer has unknown keys note/,
    ],
    [
      "a zero partner id",
      "trade",
      (j) => ((step(j, "offer", "trade").args.offer as Json).partner_team_id = 0),
      /partner_team_id must be a team id/,
    ],
    [
      "a week-horizon trade projection",
      "trade",
      (j) => (step(j, "offer", "proj_me").args.horizon = "week"),
      /valued rest-of-season — horizon: "ros"/,
    ],
    [
      "a trade without the replacement level",
      "trade",
      (j) => (seq(j, "offer").steps = seq(j, "offer").steps.filter((s) => s.id !== "replacement")),
      /espn_analyze_replacement comes before espn_analyze_trade/,
    ],
    [
      "no partner search",
      "trade",
      (j) => (j.sequences = seqs(j).filter((s) => s.id !== "partners")),
      /no espn_analyze_trade step runs a partner search/,
    ],
    [
      "a trade rec logged as a roster rec",
      "trade",
      (j) => (step(j, "offer", "record").args.kind = "roster"),
      /record kind "roster" is not one of trade/,
    ],
    // injury-cascade (§3.10)
    [
      "the depth chart after the cascade",
      "injury-cascade",
      (j) => {
        const s = seq(j, "report");
        const d = s.steps.findIndex((x) => x.id === "depth");
        const [moved] = s.steps.splice(d, 1);
        s.steps.splice(s.steps.findIndex((x) => x.id === "cascade") + 1, 0, moved!);
      },
      /espn_get_depth_chart comes before espn_analyze_injury_cascade/,
    ],
    [
      "a four-game usage window",
      "injury-cascade",
      (j) => (step(j, "report", "usage").args.window = 4),
      /window: 6 with include_prior_season: true/,
    ],
    [
      "beneficiaries priced in priority mode",
      "injury-cascade",
      (j) => (step(j, "report", "waivers").args.mode = "priority"),
      /must carry mode: "auto"/,
    ],
    [
      "no beneficiary pricing",
      "injury-cascade",
      (j) => {
        for (const s of seqs(j)) {
          s.steps = s.steps.filter((x) => x.tool !== "espn_analyze_waivers");
          const r = s.steps.find((x) => x.id === "record")!;
          r.args.source_calls = { $source_calls: ["cascade"] };
        }
      },
      /no sequence prices the beneficiaries/,
    ],
    // schedule-plan (§3.11)
    [
      "a pre-game matchup",
      "schedule-plan",
      (j) => (step(j, "season", "race").args.mode = "pre"),
      /espn_analyze_matchup carries mode: "season"/,
    ],
    [
      "no both on seeding-unknown",
      "schedule-plan",
      (j) => (step(j, "both_readings", "race").args.seeding_mode = "config"),
      /passes seeding_mode: "both" explicitly/,
    ],
    [
      "the schedule before the race",
      "schedule-plan",
      (j) => {
        const s = seq(j, "season");
        s.steps = s.steps.filter((x) => x.id !== "race");
        (s.steps.find((x) => x.id === "record")!.args.source_calls as Json).$source_calls = [
          "plan",
        ];
      },
      /espn_analyze_matchup \(mode season\) comes before espn_analyze_schedule/,
    ],
    // roster-audit (§3.12)
    [
      "a second pool page",
      "roster-audit",
      (j) => (step(j, "audit", "pool_rb").args.offset = 15),
      /one page per position \(no offset\)/,
    ],
    [
      "no ir-invalid sequence",
      "roster-audit",
      (j) => (j.sequences = seqs(j).filter((s) => s.id !== "invalid")),
      /no sequence on ir-invalid/,
    ],
    // news-check (§3.13)
    [
      "a claim text copied from a result",
      "news-check",
      (j) =>
        ((step(j, "pasted", "evidence").args.claim as Json).text = {
          $ref: "outlook.data.players",
        }),
      /claim\.text must be the user's own words/,
    ],
    [
      "a claim text over 400 characters",
      "news-check",
      (j) => ((step(j, "pasted", "evidence").args.claim as Json).text = "x".repeat(401)),
      /claim\.text must be the user's own words, 1–400 characters/,
    ],
    [
      "an unknown claim key",
      "news-check",
      (j) => ((step(j, "pasted", "evidence").args.claim as Json).act = "drop"),
      /claim has unknown keys act/,
    ],
    [
      "no log read-back",
      "news-check",
      (j) => (j.sequences = seqs(j).filter((s) => s.id !== "readback")),
      /no sequence reads the log back/,
    ],
    [
      "every check with a claim",
      "news-check",
      (j) => {
        for (const s of seqs(j))
          for (const x of s.steps)
            if (x.tool === "espn_analyze_evidence") x.args.claim = { text: "a claim" };
      },
      /checks ESPN's own outlook \(no claim\)/,
    ],
    // start-sit's live P(win) (§3.3)
    [
      "no game_day_live",
      "start-sit",
      (j) => (j.sequences = seqs(j).filter((s) => s.id !== "game_day_live")),
      /no `game_day_live` sequence/,
    ],
    [
      "a pre-game live matchup",
      "start-sit",
      (j) => (step(j, "game_day_live", "matchup").args.mode = "pre"),
      /game_day_live sequence's espn_analyze_matchup must carry mode: "live"/,
    ],
    [
      "the live matchup not logged",
      "start-sit",
      (j) =>
        (seq(j, "game_day_live").steps = seq(j, "game_day_live").steps.filter(
          (s) => s.id !== "record_matchup",
        )),
      /logs both the matchup rec and the lineup rec/,
    ],
    [
      "the live branch without only_unlocked",
      "start-sit",
      (j) => delete step(j, "game_day_live", "lineup").args.only_unlocked,
      /game_day_live sequence's espn_analyze_lineup must carry only_unlocked: true/,
    ],
    // waivers' usage branch (§3.8)
    [
      "no usage before the decision",
      "waivers",
      (j) =>
        (seq(j, "usage_pre_run").steps = seq(j, "usage_pre_run").steps.filter(
          (s) => s.tool !== "espn_get_player_usage",
        )),
      /espn_get_player_usage before espn_analyze_waivers/,
    ],
    [
      "no FAAB sequence",
      "waivers",
      (j) => (j.sequences = seqs(j).filter((s) => s.id !== "faab")),
      /no sequence on the faab variant/,
    ],
  ];
  it.each(mutations)("fails on %s", (_l, skill, mutate, re) => {
    const t = fresh();
    t.editJson(SEQ(skill), mutate);
    expect(errorsOf(t)).toMatch(re);
  });
});

describe("the new templates", () => {
  it("refuses a malformed $ids, a $ids naming a later step, and an unknown $player status", () => {
    const t = fresh();
    t.editJson(SEQ("injury-cascade"), (j) => {
      step(j, "report", "waivers").args.candidates = {
        $ids: { from: "cascade", key: "player_id" },
      };
      step(j, "ir_move", "waivers").args.candidates = {
        $ids: { from: "record.data.x", key: "player_id" },
      };
      ((step(j, "report", "injuries").args.players as Json).player_ids as Json[])[0] = {
        $player: { step: "roster", slot: "IR", injury_status: "HURT" },
      };
    });
    const e = errorsOf(t);
    expect(e).toMatch(
      /\$ids must be \{ from: "<step id>\.<path>", key: <field>, max\?: 1\.\.25 \}/,
    );
    expect(e).toMatch(/\$ids "record\.data\.x" names no earlier step/);
    expect(e).toMatch(
      /\$player must be \{ step: <earlier espn_get_roster step>, slot, eligible\?, injury_status\? \}/,
    );
  });

  it("refuses a $ids cap outside 1..IDS_MAX", () => {
    const t = fresh();
    t.editJson(SEQ("injury-cascade"), (j) => {
      step(j, "report", "waivers").args.candidates = {
        $ids: { from: "cascade.data.beneficiaries", key: "player_id", max: IDS_MAX + 1 },
      };
    });
    expect(errorsOf(t)).toMatch(/\$ids must be/);
  });
});

describe("argument shapes (unit)", () => {
  it("checkArgType: the selector variants and their id bounds", () => {
    expect(checkArgType({ player_ids: [1] }, "selector:single")).toBeNull();
    expect(checkArgType({ gsis_ids: ["00-0000001"] }, "selector:single")).toBeNull();
    expect(checkArgType({ player_ids: [1, 2] }, "selector:single")).toMatch(/1–1 ids/);
    expect(checkArgType({ team_id: 2 }, "selector:single")).toMatch(
      /single-player selector has no `team_id`/,
    );
    expect(checkArgType({ team_id: 2 }, "selector:outlook")).toBeNull();
    expect(
      checkArgType({ player_ids: Array.from({ length: 13 }, (_, i) => i + 1) }, "selector:outlook"),
    ).toMatch(/1–12 ids/);
    expect(checkArgType({ nfl_team: "KC" }, "selector:outlook")).toMatch(
      /outlook selector has no `nfl_team`/,
    );
    expect(
      checkArgType({ player_ids: Array.from({ length: 26 }, (_, i) => i + 1) }, "selector"),
    ).toMatch(/1–25 ids/);
    expect(
      checkArgType({ player_ids: { $ids: { from: "a.b", key: "player_id" } } }, "selector"),
    ).toBeNull();
    expect(
      checkArgType({ player_ids: [{ $player: { step: "r", slot: "RB" } }] }, "selector:single"),
    ).toBeNull();
    expect(checkArgType(["RB", { $ref: "a.b" }], "string[]")).toBeNull();
    expect(checkArgType(["RB", ""], "string[]")).toMatch(/non-empty string array/);
  });

  it("tradeArgProblems accepts both plan 07 E6 shapes and a partner search's proposal template", () => {
    expect(tradeArgProblems({ offer: { partner_team_id: 10, give: [1], get: [2, 3] } })).toEqual(
      [],
    );
    expect(tradeArgProblems({ find_partners: { need_position: "RB" } })).toEqual([]);
    expect(
      tradeArgProblems({
        offer: {
          partner_team_id: { $ref: "s.data.partners.0.team_id" },
          give: { $ref: "s.x" },
          get: { $ref: "s.y" },
        },
      }),
    ).toEqual([]);
    expect(tradeArgProblems({ offer: "10 for 2" }).join()).toMatch(/offer must be an object/);
    expect(tradeArgProblems({ find_partners: { need_position: "R B!" } }).join()).toMatch(
      /need_position must be a position name/,
    );
    expect(tradeArgProblems({ find_partners: { need_position: "RB", top: 3 } }).join()).toMatch(
      /unknown keys top/,
    );
  });

  it("claimProblems: the user's words only, bounded; a missing claim is fine", () => {
    expect(claimProblems(undefined)).toEqual([]);
    expect(
      claimProblems({ text: "he will start", source: "beat writer", time: "2026-10-06T12:00:00Z" }),
    ).toEqual([]);
    expect(claimProblems("text").join()).toMatch(/must be an object/);
    expect(claimProblems({ text: "  " }).join()).toMatch(/claim\.text/);
    expect(claimProblems({ text: "x", source: "s".repeat(65) }).join()).toMatch(
      /source must be 1–64/,
    );
    expect(claimProblems({ text: "x", time: "yesterday" }).join()).toMatch(/ISO instant/);
  });

  it("claimProblems refuses any non-string text, whatever its shape (property)", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.object(), fc.array(fc.string())),
        (text) => {
          expect(claimProblems({ text }).join()).toMatch(
            /claim\.text must be the user's own words/,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("recKindOf maps each P1 producer to the kind the retrospective files it under", () => {
    const k = (tool: string) => recKindOf({ id: "x", tool, args: {}, expect: ["ok"] });
    expect(k("espn_analyze_matchup")).toBe("matchup");
    expect(k("espn_analyze_trade")).toBe("trade");
    expect(k("espn_analyze_injury_cascade")).toBe("cascade");
    expect(k("espn_analyze_schedule")).toBe("schedule");
    expect(k("espn_analyze_roster")).toBe("roster");
    expect(k("espn_analyze_evidence")).toBe("evidence");
    expect(k("espn_get_news")).toBeUndefined();
  });
});

describe("triggers across thirteen Skills (plan 10 B11: the collision check)", () => {
  it("fails when a P1 Skill takes apply's phrase, and when a P1 positive routes elsewhere", () => {
    const t = fresh();
    t.edit("skills/roster-audit/SKILL.md", "backup QB\n", "backup QB, put him in IR\n");
    addTriggers(t, "schedule-plan", [
      { query: "Should I claim off waivers before the playoffs?", should_trigger: true },
    ]);
    const e = errorsOf(t);
    expect(e).toMatch(/when_to_use phrase "put him ir" is in both apply and roster-audit/);
    expect(e).toMatch(
      /positive "Should I claim off waivers before the playoffs\?" of schedule-plan matches waivers's when_to_use/,
    );
  });

  it("fails when two P1 Skills share a positive, and when a P1 negative matches its own phrases", () => {
    const t = fresh();
    addTriggers(t, "injury-cascade", [
      { query: "Is this trade fair?", should_trigger: true },
      { query: "who benefits now", should_trigger: false },
    ]);
    const e = errorsOf(t);
    expect(e).toMatch(/"Is this trade fair\?" is a positive of both injury-cascade and trade/);
    expect(e).toMatch(
      /negative "who benefits now" of injury-cascade matches injury-cascade's own when_to_use/,
    );
  });
});
