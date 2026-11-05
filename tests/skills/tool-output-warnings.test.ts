// The server warnings the cheat-sheet (skills/_shared/references/tool-outputs.md) and the Skills
// quote are the server's own: each quoted form matches a line the server writes, from the server's
// own code, never a copy of its template (changelog §R10, R10-11 and the round-3b server refix's
// second E11 line; R10-20's E13 warning with R10-25's per-kind counts; R10-22's lineup trim warnings
// and the round-4 F6's last one; R10-24's compare refusals, each reason compareIssues gives named by
// start-sit and the row — the round-4b verifiers' R4BS-1 and R4BS-5).
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACTIVITY_PARTIAL_FRAGMENTS,
  COMPARE_DIRECT_SENTENCE,
  RETRO_TRUNCATED_SENTENCE,
  TOOL_OUTPUT_PHRASES,
  TOOL_OUTPUT_SHEET_PHRASES,
  TRIM_WARNING_ABSENT,
} from "../../scripts/skills/check-skills.mjs";
import { fitOptionsOf } from "../../src/mcp/define.js";
import { ANALYTICS_BUDGET_CHARS, fitToBudget } from "../../src/mcp/envelope.js";
import {
  HEALTH_COVER_DESIGNATIONS,
  analyzeEvidence,
  type EvidenceRequest,
} from "../../src/domain/analytics/evidence.js";
import type { UsageWeek } from "../../src/domain/analytics/usageSignals.js";
import { wrapUntrusted, type InjuryStatus } from "../../src/domain/league/types.js";
import { bare, clockAndRng } from "../domain/analytics/helpers.js";
import { compareWarnings, type LineupPlayer } from "../../src/domain/analytics/lineup.js";
import { DISAGREEMENT_FLAG_PCT } from "../../src/domain/analytics/types.js";
import { RECOMMENDATION_KINDS } from "../../src/domain/reclog/types.js";
import { lineupTrims } from "../../src/mcp/tools/analytics.js";
import {
  SESSION_READ_WARNINGS,
  activityLeagueReadsWarning,
  type ActivityLeagueRead,
} from "../../src/mcp/tools/common.js";
import { analyzeRetrospective } from "../../src/mcp/tools/reclog.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";
import { ROOT } from "./helpers.js";

const sheet = readFileSync(path.join(ROOT, "skills/_shared/references/tool-outputs.md"), "utf8");
const rowOf = (tool: string): string =>
  sheet.split("\n").find((l) => new RegExp(`^\\| (?:\\(P1\\) )?\`${tool}\` \\|`).test(l)) ?? "";

/**
 * A quoted form as an anchored RegExp over a whole warning: "…" elides the words that vary, with the
 * spaces around them (as an ellipsis in prose does).
 */
const formRe = (quoted: string): RegExp => {
  const body = quoted.replace(/^"|"$/g, "");
  const parts = body.split(/\s*…\s*/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[\\s\\S]*?")}$`);
};

const READS: readonly ActivityLeagueRead[] = ["standings", "rosters", "free-agent pool"];
/** Every non-empty ordered subset of the league reads E11 can name. */
const readSets = fc
  .subarray([...READS], { minLength: 1 })
  .map((xs) => READS.filter((r) => xs.includes(r)));

describe("E11's partial lines in the cheat-sheet are the server's (changelog §R10, R10-11)", () => {
  const [feed, leagueRejected, leagueNoSession] = ACTIVITY_PARTIAL_FRAGMENTS.map(formRe);

  it("the feed's quoted form matches both of the server's feed lines, and no league-read line", () => {
    expect(feed?.test(SESSION_READ_WARNINGS.feed_no_session)).toBe(true);
    expect(feed?.test(SESSION_READ_WARNINGS.feed_rejected)).toBe(true);
    fc.assert(
      fc.property(
        readSets,
        fc.constantFrom<"rejected" | "no_session">("rejected", "no_session"),
        (reads, refusal) => {
          expect(feed?.test(activityLeagueReadsWarning(refusal, reads))).toBe(false);
        },
      ),
    );
  });

  it("each league-read form matches the server's line for its refusal, whatever reads it names, and only that one", () => {
    fc.assert(
      fc.property(readSets, (reads) => {
        const rejected = activityLeagueReadsWarning("rejected", reads);
        const noSession = activityLeagueReadsWarning("no_session", reads);
        expect(leagueRejected?.test(rejected)).toBe(true);
        expect(leagueNoSession?.test(noSession)).toBe(true);
        expect(leagueRejected?.test(noSession)).toBe(false);
        expect(leagueNoSession?.test(rejected)).toBe(false);
        // the line names the reads it went without, and ends in the one command
        for (const r of reads) expect(rejected).toContain(r);
        expect(rejected).toMatch(/run `eff setup` in a terminal to replace it$/);
        expect(noSession).toMatch(/run `eff setup` in a terminal to add one$/);
      }),
    );
    for (const f of [leagueRejected, leagueNoSession]) {
      expect(f?.test(SESSION_READ_WARNINGS.feed_rejected)).toBe(false);
      expect(f?.test(SESSION_READ_WARNINGS.feed_no_session)).toBe(false);
    }
  });

  it("the row carries every form, and a form the server never writes would fail", () => {
    for (const f of ACTIVITY_PARTIAL_FRAGMENTS)
      expect(rowOf("espn_analyze_league_activity")).toContain(f);
    // a stale form (the reads "were skipped") matches no line the server writes
    const stale = formRe(
      '"partial: … need one on a league not known to be public: they were skipped …"',
    );
    fc.assert(
      fc.property(readSets, (reads) => {
        expect(stale.test(activityLeagueReadsWarning("rejected", reads))).toBe(false);
      }),
    );
  });
});

describe("E13's truncation warning, as the cheat-sheet and retro quote it (changelog §R10, R10-20, R10-25)", () => {
  /** One "<kind> K of T" entry of the per-kind counts (R10-25). */
  const KIND_COUNT = "[a-z]+ \\d+ of \\d+";
  /**
   * The quoted warning of a text, with N and M as counts and the per-kind list ("<kind> K of T, …")
   * as one group of one or more "<kind> K of T" entries.
   */
  const quotedIn = (text: string): RegExp => {
    const m = /"(result truncated to N of M calls[^"]*)"/.exec(text);
    expect(m, "the quoted warning").not.toBeNull();
    const q = m?.[1] ?? "";
    expect(q, "the quoted warning carries the per-kind counts").toMatch(
      /; calls kept by kind: <kind> K of T, …$/,
    );
    const re = q
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace("N of M", "(\\d+) of (\\d+)")
      .replace("<kind> K of T, …", `(${KIND_COUNT}(?:, ${KIND_COUNT})*)`);
    return new RegExp(`^${re}$`);
  };
  /** E13's own fit, under its registered options, of `n` calls of about `size` characters each. */
  const fitted = (n: number, size: number, kinds: readonly string[] = ["lineup"]) => {
    const call = (i: number) => ({
      log_id: `r-${String(i).padStart(4, "0")}`,
      kind: kinds[i % kinds.length] ?? "lineup",
      followed: null,
      regret: null,
      decisive: null,
      recommended: "x".repeat(size),
      best_alternative: null,
      realised: null,
      note: null,
    });
    const env = {
      data: { week: 4, calls: Array.from({ length: n }, (_, i) => call(i)) },
      meta: { untrusted_fields: [] },
      truncated: false,
      partial: false,
      warnings: [] as string[],
    };
    const r = fitToBudget(
      env as unknown as Parameters<typeof fitToBudget>[0],
      ANALYTICS_BUDGET_CHARS,
      "calls",
      fitOptionsOf(analyzeRetrospective, {}),
    );
    if (!r.ok) throw new Error("did not fit");
    return r.envelope;
  };

  /** A week's kinds: one to four of E13's kinds and an unknown one (counted as `other`). */
  const kindLists = fc.uniqueArray(fc.constantFrom(...RECOMMENDATION_KINDS, "not-a-kind"), {
    minLength: 1,
    maxLength: 4,
  });

  it.each([
    ["the cheat-sheet's E13 row", rowOf("espn_analyze_retrospective")],
    ["retro's sentence", RETRO_TRUNCATED_SENTENCE],
  ])("%s quotes the warning E13's own fit writes, with its counts", (_, text) => {
    const re = quotedIn(text);
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 200 }),
        fc.integer({ min: 150, max: 400 }),
        kindLists,
        (n, size, kinds) => {
          const env = fitted(n, size, kinds);
          expect(env.truncated).toBe(true);
          const w = env.warnings.find((x) => x.startsWith("result truncated to"));
          const m = re.exec(w ?? "");
          expect(m, w).not.toBeNull();
          const calls = (env.data as { calls: { kind: string }[] }).calls;
          const kept = calls.length;
          expect(Number(m?.[1])).toBe(kept);
          expect(Number(m?.[2])).toBe(n);
          expect(kept).toBeLessThan(n);
          // the per-kind counts add up to N of M, and name each kind of the week once (R10-25)
          const entries = (m?.[3] ?? "").split(", ").map((e) => {
            const x = /^([a-z]+) (\d+) of (\d+)$/.exec(e);
            return { kind: x?.[1] ?? "", k: Number(x?.[2]), t: Number(x?.[3]) };
          });
          expect(entries.reduce((a, e) => a + e.k, 0)).toBe(kept);
          expect(entries.reduce((a, e) => a + e.t, 0)).toBe(n);
          const named = kinds.map((k) =>
            (RECOMMENDATION_KINDS as readonly string[]).includes(k) ? k : "other",
          );
          expect(entries.map((e) => e.kind).sort()).toEqual([...new Set(named)].sort());
        },
      ),
      { numRuns: 25 },
    );
    // the warning names E13's narrowing input, and the text tells the reader to use it
    expect(text).toContain("narrow the calls with kinds (this tool does not page)");
    expect(text).toMatch(/`kinds/);
    // the stop rule reads the counts: one kind listed means no repeat call (R10-25)
    expect(text).toMatch(/one kind only \(for example "calls kept by kind: lineup 9 of 20"\)/);
    expect(text).toMatch(/make no narrowed call/);
  });

  // the round-4b verifiers' R4BS-6: a kind already scored whole is never asked for again
  it.each([
    ["the cheat-sheet's E13 row", rowOf("espn_analyze_retrospective")],
    ["retro's sentence", RETRO_TRUNCATED_SENTENCE],
  ])("%s narrows to the question's kinds only when their calls were cut", (_, text) => {
    expect(text).toContain("the kinds the question is about whose K is below T first");
    expect(text).toContain("else the kinds whose calls were left out (K below T)");
    expect(text).toContain(
      "when every kind the question is about was scored whole, make no narrowed call",
    );
    // round 4b's priority asked for the question's kinds whatever their counts
    expect(text).not.toContain("the kinds the question is about first");
  });

  it("the quoted form rejects the warning without its per-kind counts (round 4's text)", () => {
    const re = quotedIn(RETRO_TRUNCATED_SENTENCE);
    expect(
      re.test(
        "result truncated to 5 of 100 calls to fit the 10000-character budget; narrow the calls with kinds (this tool does not page)",
      ),
    ).toBe(false);
    // and the example in the stop rule is a warning the fit writes for a week of one kind
    const env = fitted(120, 300, ["lineup"]);
    const w = env.warnings.find((x) => x.startsWith("result truncated to")) ?? "";
    expect(w).toMatch(/; calls kept by kind: lineup \d+ of 120$/);
  });
});

describe("the lineup trim warnings the cheat-sheet quotes are lineupTrims' own (changelog §R10, R10-22)", () => {
  // a lineup where player 1 sits, player 2 starts in his RB slot and player 3 stays at WR: every
  // trim that cuts the unmoved rows fires
  const untrimmed = {
    current_lineup: [
      { player_id: 1, slot: "RB" },
      { player_id: 2, slot: "BE" },
      { player_id: 3, slot: "WR" },
    ],
    recommended_lineup: [
      { player_id: 1, slot: "BE" },
      { player_id: 2, slot: "RB" },
      { player_id: 3, slot: "WR" },
    ],
    rec: {
      subjects: [
        { player_id: 1, role: "sit", slot: "BE" },
        { player_id: 2, role: "start", slot: "RB" },
        { player_id: 3, role: "start", slot: "WR" },
      ],
      drivers: [],
      confidence: { role_games: 0, inputs: [] },
    },
    lock_schedule: [],
    espn_cross_check: { starter_disagreements: [] },
    stack_flags: [],
    conditionals: [],
  };
  const warnings = lineupTrims(untrimmed)
    .map((trim) => trim(untrimmed))
    .filter((r) => r !== null)
    .map((r) => r.warning);

  it("the Rec shape's and the lineup row's quoted warnings are warnings the trims write", () => {
    const quoted = [
      ...(TOOL_OUTPUT_SHEET_PHRASES.join(" ").match(
        /"([a-z_.]+ lists only the players who move \([^"]*\))"/g,
      ) ?? []),
      ...(TOOL_OUTPUT_PHRASES.espn_analyze_lineup
        .join(" ")
        .match(/"([a-z_.]+ lists only the players who move \([^"]*\))"/g) ?? []),
    ].map((q) => q.replace(/^"|"$/g, ""));
    expect(quoted).toEqual([
      "rec.subjects lists only the players who move (the roster's current slots hold the rest)",
      "recommended_lineup lists only the players who move (rec.lineup carries the whole mean-optimal assignment)",
    ]);
    for (const q of quoted) expect(warnings).toContain(q);
    for (const q of quoted) expect(sheet).toContain(q);
  });

  it("the lineup row's other quoted trim warnings are warnings the trims write (the round-4 F6 and server fix)", () => {
    const row = TOOL_OUTPUT_PHRASES.espn_analyze_lineup.join(" ");
    const quoted = [
      ...(row.match(
        /"((?:lock_schedule omitted|recommended_lineup omits|recommended_lineup and rec\.drivers truncated)[^"]*)"/g,
      ) ?? []),
    ].map((q) => q.replace(/^"|"$/g, ""));
    expect(quoted).toEqual([
      "recommended_lineup and rec.drivers truncated to fit the budget (swaps and rec.subjects name every change; rec.lineup is the mean-optimal assignment)",
      "lock_schedule omitted (espn_get_roster carries it)",
      "recommended_lineup omits the bench and IR rows that do not change (espn_get_roster carries them)",
    ]);
    // the same lineup with a lock schedule and an unmoved bench player: their trims fire too
    const withLocks = {
      ...untrimmed,
      current_lineup: [...untrimmed.current_lineup, { player_id: 4, slot: "BE" }],
      recommended_lineup: [...untrimmed.recommended_lineup, { player_id: 4, slot: "BE" }],
      lock_schedule: [{ player_id: 1, lock_at: "x" }],
    };
    const all = lineupTrims(withLocks)
      .map((trim) => trim(withLocks))
      .filter((r) => r !== null)
      .map((r) => r.warning);
    for (const q of quoted) expect(all).toContain(q);
    for (const q of quoted) expect(rowOf("espn_analyze_lineup")).toContain(q);
    // round 3b's last trim ("rec.lineup and swaps name every change") is no longer written
    expect(warnings.join("\n")).not.toContain("(rec.lineup and swaps name every change)");
  });

  it("no trim warning says rec.lineup carries the lineup to set", () => {
    expect(warnings.length).toBeGreaterThan(2);
    for (const w of warnings) expect(TRIM_WARNING_ABSENT.test(w), w).toBe(false);
  });
});

describe("the compare refusal the lineup row quotes is compareWarnings' own (changelog §R10, R10-24)", () => {
  const quoted = /"(compare pair out … \/ in … not evaluated: …)"/.exec(
    TOOL_OUTPUT_PHRASES.espn_analyze_lineup.join(" "),
  )?.[1];
  const form = formRe(`"${quoted ?? ""}"`);

  it("the row and the Skill quote the form, and it matches every refusal the server writes", () => {
    expect(quoted).toBeDefined();
    expect(rowOf("espn_analyze_lineup")).toContain(`"${quoted ?? ""}"`);
    // R4BS-1: start-sit's own sentence quotes it too, in the body the model reads
    expect(COMPARE_DIRECT_SENTENCE).toContain(`"${quoted ?? ""}"`);
    expect(readFileSync(path.join(ROOT, "skills/start-sit/SKILL.md"), "utf8")).toContain(
      COMPARE_DIRECT_SENTENCE,
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9_999_999 }),
        fc.integer({ min: 1, max: 9_999_999 }),
        (a, b) => {
          // no roster: every id is "not on the roster"; one id twice: "the same player"
          for (const w of [
            ...compareWarnings([], [{ out: a, in: b }]),
            ...compareWarnings([], [{ out: a, in: a }]),
          ])
            expect(form.test(w), w).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  /** A roster entry of the lineup engine: only the fields compareIssues reads vary. */
  const player = (id: number, slot: number, eligible: readonly number[], locked = false) =>
    ({
      player_id: id,
      gsis_id: null,
      name: "Team A player",
      position: "RB",
      eligible_slot_ids: eligible,
      injury_status: slot === 21 ? "OUT" : null,
      pro_team_id: null,
      slot_id: slot,
      locked,
      lock_at: null,
      points: {
        mean: 10,
        p10: 4,
        p25: 7,
        p50: 10,
        p75: 13,
        p90: 16,
        p_zero: 0,
        basis: "position_cv",
      },
      p_active: 1,
      espn_projection: 10,
      percent_started: null,
      role_games: 0,
    }) as unknown as LineupPlayer;
  // RB 2, WR 4, FLEX 23, BE 20, IR 21 (src/domain/league/slots.ts)
  const RB_ELIG = [2, 23, 20, 21];
  const roster: LineupPlayer[] = [
    player(1, 2, RB_ELIG), // the starting RB
    player(2, 20, RB_ELIG), // a bench RB: the direct swap
    player(3, 20, [4, 23, 20, 21]), // a bench WR: cannot play RB
    player(4, 21, RB_ELIG), // on IR
    player(5, 20, RB_ELIG, true), // a locked bench RB
    player(6, 4, [4, 23, 20, 21]), // a starting WR
  ];
  // each reason compareIssues gives (src/domain/analytics/lineup.ts), and the words start-sit's
  // sentence and the row name it by (R4BS-5: a locked player and one not on the roster were left out)
  it.each([
    [{ out: 1, in: 5 }, "is locked", "a locked player"],
    [{ out: 1, in: 99 }, "is not on the roster", "one not on the roster"],
    [{ out: 2, in: 3 }, "is not starting", "an `out` not starting"],
    [{ out: 1, in: 6 }, "already starts", "an `in` already starting"],
    [{ out: 1, in: 3 }, "cannot play RB", "one who cannot play that slot"],
    [{ out: 1, in: 4 }, "is on IR", "is on IR"],
  ])(
    "a pair %j is refused (%s), and the Skill and the row name that refusal",
    (pair, reason, named) => {
      const w = compareWarnings(roster, [pair]);
      expect(w).toHaveLength(1);
      expect(w[0]).toContain(reason);
      expect(form.test(w[0] ?? "")).toBe(true);
      expect(COMPARE_DIRECT_SENTENCE).toContain(named);
      expect(TOOL_OUTPUT_PHRASES.espn_analyze_lineup.join(" ")).toContain(named);
    },
  );

  it("the direct swap both texts define is the one pair compareIssues scores, neither player locked", () => {
    expect(compareWarnings(roster, [{ out: 1, in: 2 }])).toEqual([]);
    // the same pair with the starter locked is refused: "neither locked" is part of the definition
    const lockedOut = roster.map((p) => (p.player_id === 1 ? { ...p, locked: true } : p));
    expect(compareWarnings(lockedOut, [{ out: 1, in: 2 }])[0]).toContain("player 1 is locked");
    expect(COMPARE_DIRECT_SENTENCE).toContain(
      "`out` a starter, `in` a bench player who can play `out`'s slot, neither locked.",
    );
    expect(TOOL_OUTPUT_PHRASES.espn_analyze_lineup.join(" ")).toContain(
      "`out` a starter, `in` a player on the bench who can play `out`'s slot, neither locked;",
    );
  });

  it("the form matches no lineup trim warning", () => {
    for (const w of [
      "rec.subjects lists only the players who move (the roster's current slots hold the rest)",
      "lock_schedule omitted (espn_get_roster carries it)",
      "recommended_lineup and rec.drivers truncated to fit the budget (swaps and rec.subjects name every change; rec.lineup is the mean-optimal assignment)",
    ])
      expect(form.test(w)).toBe(false);
  });
});

// The rows round 4c rewrote say what the server does (changelog §R10, R10-29, R10-30; the round-4b
// review's F3): E2's cross-check reads E1's own line under E1's threshold, E10's health cover names
// exactly the designations the server lets explain a usage drop, and E8's dropped-week quote is the
// line the tool writes — read from a fixture-mode server on fx-10h, no network.
describe("the E2, E8 and E10 rows follow the server (changelog §R10, R10-29, R10-30; F3)", () => {
  it("E2's cross-check row: ours is E1's own line, listed over E1's own threshold", () => {
    const row = rowOf("espn_analyze_lineup");
    expect(row).toContain("`ours` is that own line (espn_project_players' inputs.own)");
    expect(row).toContain("never the blended mean");
    expect(row).toContain(`a starter is listed when it is over ${String(DISAGREEMENT_FLAG_PCT)}`);
    expect(row).toContain("a starter with no own line is never listed");
  });

  it("E10's row names exactly the designations under which a health claim explains a drop", () => {
    const row = rowOf("espn_analyze_evidence");
    const named = [
      ...row.matchAll(/`(QUESTIONABLE|DOUBTFUL|OUT|INJURY_RESERVE|DAY_TO_DAY|SUSPENSION)`/g),
    ]
      .map((m) => m[1])
      .filter((d, i, a) => a.indexOf(d) === i);
    expect(new Set(named)).toEqual(new Set(HEALTH_COVER_DESIGNATIONS));
    expect(row).toContain("a rise is never explained so");
    expect(row).toContain("against ESPN's `ACTIVE` an injury claim stays `availability_conflict`");
  });

  // the round-4c review's R4CS-2: a covered drop is not quiet_role_change, and it then reads by
  // the remaining rules — consistent when the claims agree, availability_conflict when one says he
  // plays against ESPN's OUT or INJURY_RESERVE — and both texts say exactly that
  describe("E10's health cover reads by the remaining rules (changelog §R10, R10-30)", () => {
    const NOW = "2026-10-06T20:00:00.000Z";
    const week = (w: number, snap: number, tgt: number): UsageWeek => ({
      week: w,
      snap_pct: snap,
      target_share: tgt,
      rz_share: 0.1,
      xfp: 9,
      points: 8,
    });
    // snaps 0.55 → 0.25, targets 0.15 → 0.05: a usage drop
    const drop: UsageWeek[] = [
      ...[1, 2, 3, 4].map((w) => week(w, 0.55, 0.15)),
      week(5, 0.25, 0.05),
    ];
    const flagOf = (status: InjuryStatus, texts: readonly string[]) =>
      analyzeEvidence({
        player: {
          player_id: 77,
          gsis_id: null,
          name: bare("Player 77"),
          position: "RB",
          injury_status: status,
          roster: "mine",
          slot_id: 2,
          lineup_locked: false,
          waiver_process_date: null,
          last_news_at: null,
        },
        texts: texts.map((t) => ({ text: wrapUntrusted(t, "rss.rotowire.title"), time: NOW })),
        usage: drop,
        week: 6,
        clock: clockAndRng(NOW).clock,
      } satisfies EvidenceRequest).data.flag;
    const sheet = rowOf("espn_analyze_evidence");
    const news = readFileSync(path.join(ROOT, "skills/news-check/SKILL.md"), "utf8");

    it.each([...HEALTH_COVER_DESIGNATIONS])(
      "%s with a health claim that agrees: consistent, never quiet_role_change",
      (status) => {
        expect(flagOf(status, ["has a hamstring injury"])).toBe("consistent");
      },
    );
    it.each([
      ["OUT", ["has a hamstring injury", "He will play Sunday."]],
      ["OUT", ["has a hamstring injury", "Expected to play Sunday against Buffalo."]],
      ["INJURY_RESERVE", ["has a hamstring injury", "He is active and will start Sunday."]],
    ] as const)("%s with a claim that he plays: availability_conflict", (status, texts) => {
      expect(flagOf(status, texts)).toBe("availability_conflict");
    });
    it("the cheat-sheet row and news-check §4 say a covered drop reads by the remaining rules", () => {
      for (const text of [sheet, news]) {
        expect(text).toContain("is not `quiet_role_change`: it reads by the remaining rules");
        expect(text).toContain("`consistent` when the claims agree with the structured fields");
        expect(text).toMatch(
          /`availability_conflict`[^.]*against ESPN's `DOUBTFUL`, `OUT` or `INJURY_RESERVE`|against ESPN's `DOUBTFUL`, `OUT` or `INJURY_RESERVE` still reads `availability_conflict`/,
        );
        expect(text).not.toMatch(/`INJURY_RESERVE` reads `consistent`/);
      }
    });
    it("news-check §4 names exactly the designations under which a health claim explains a drop", () => {
      const sentence =
        /a usage drop that a health claim about him explains while ESPN lists him ([^)]*?) is not/.exec(
          news,
        )?.[1];
      expect(sentence).toBeDefined();
      const named = [...(sentence ?? "").matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]);
      expect(new Set(named)).toEqual(new Set(HEALTH_COVER_DESIGNATIONS));
    });
  });

  // the round-4c review's R4CS-5: the E2 row reads E1's fields; the E1 row lists each of them
  it("every E1 field the E2 row names is in the E1 row", () => {
    const e2 = rowOf("espn_analyze_lineup");
    const e1 = rowOf("espn_project_players");
    const named = [
      ...e2.matchAll(
        /espn_project_players' ([a-z_]+(?:\.[a-z_]+)*)|E1's ([a-z_]+(?:\.[a-z_]+)+)|\((inputs\.[a-z_]+)\)/g,
      ),
    ].map((m) => m[1] ?? m[2] ?? m[3]);
    expect(named).toEqual(
      expect.arrayContaining(["inputs.own", "disagreement.pct", "inputs.espn"]),
    );
    for (const f of named) expect(e1, f).toContain(`\`${String(f)}\``);
  });

  describe("E8 on fx-10h (full)", () => {
    const FX = path.join(ESPN_FIXTURES, "fx-10h");
    let world: World;
    let client: Client;
    let close: () => Promise<void>;
    beforeAll(async () => {
      const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
        clock: string;
        my_team_id: number;
      };
      world = await makeWorld({
        env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
        teamId: m.my_team_id,
        clock: m.clock,
      });
      ({ client, close } = await connect(world, { options: { toolset: "full" } }));
    }, 120_000);
    afterAll(async () => {
      await close();
      world.cleanup();
    });

    // the round-4c review's R4CS-3 (F3's sentence) and R4CS-4 (the fixes' fields)
    it("a week's row is the same whatever `weeks` asks for, as the row says", async () => {
      expect(rowOf("espn_analyze_schedule")).toContain(
        "a week's row is the same whatever `weeks` asks for",
      );
      const rowFor = async (weeks: number[]) => {
        const r = await call(client, "espn_analyze_schedule", { seed: 7, weeks });
        expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
        const data = r.body.data as { weeks: { week: number }[] };
        return data.weeks.find((w) => w.week === 11);
      };
      const alone = await rowFor([11]);
      expect(alone).toBeDefined();
      expect(await rowFor([7, 11])).toEqual(alone);
    }, 60_000);

    it("the row lists exactly the fields of a fix the tool returns, `delta` the points it recovers", async () => {
      const row = rowOf("espn_analyze_schedule");
      const list = /`fixes\[\]` \(([^)]*)\)/.exec(row)?.[1] ?? "";
      const listed = [...list.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
      expect(list).toContain("`delta` — the points the fix recovers");
      const r = await call(client, "espn_analyze_schedule", { seed: 7, include_playoffs: true });
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      const fixes = (r.body.data as { fixes: Record<string, unknown>[] }).fixes;
      expect(fixes.length).toBeGreaterThan(0);
      for (const f of fixes) expect(new Set(Object.keys(f))).toEqual(new Set(listed));
    }, 60_000);

    it("a past week's warning is the row's quoted form, and a window of past weeks is the row's refusal", async () => {
      const row = rowOf("espn_analyze_schedule");
      const quoted = /\("(week\(s\) N dropped: before the current week \(W\))"\)/.exec(row)?.[1];
      expect(quoted).toBeDefined();
      const form = new RegExp(
        `^${(quoted ?? "")
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\bN\b/, "\\d+(?:, \\d+)*")
          .replace(/\bW\b/, "\\d+")}$`,
      );
      const r = await call(client, "espn_analyze_schedule", { seed: 7, weeks: [3, 11] });
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      const dropped = (r.body.warnings as string[]).filter((w) => w.includes("dropped"));
      expect(dropped).toHaveLength(1);
      expect(form.test(dropped[0] ?? "")).toBe(true);
      const only = await call(client, "espn_analyze_schedule", { seed: 7, weeks: [3] });
      expect(only.isError).toBe(true);
      const error = (only.body as { error: Record<string, unknown> }).error;
      expect(error).toMatchObject({ code: "VALIDATION", field: "weeks" });
      expect(row).toContain(
        `(\`${String(error.code)}\`, field \`${String(error.field)}\`, reason ${String(error.reason)})`,
      );
    }, 60_000);
  });
});
