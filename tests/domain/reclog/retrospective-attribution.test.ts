// retrospective-attribution.test.ts — Phase 3 in buildRetrospective (plan 10 §3.3 C9: attribution
// populated for every projection-backed call; parameter changes proposed, never applied, by the
// tool): the v1 shape is unchanged without attribution rows; with them `data.attribution` carries
// the aggregate and one decomposition per projection-backed call (aligned to `calls[]`), a final week
// proposes the re-fit (the wire's ≤ 10, the full set for the store), a provisional week proposes
// nothing, hostile rows are counted, and the whole `data` still passes E13's own output schema.
import { describe, expect, it } from "vitest";
import type { GameFlags } from "../../../src/config/freshness.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { ATTRIBUTION_LAYERS, type AttributionRow } from "../../../src/domain/reclog/attribution.js";
import {
  attributeWindow,
  buildRetrospective,
  withProposals,
  type RetrospectiveInput,
  type ScoringWeek,
} from "../../../src/domain/reclog/retrospective.js";
import { ewm, wireProposals } from "../../../src/domain/reclog/tune.js";
import type { RecommendationRecord } from "../../../src/domain/reclog/types.js";
import { retrospectiveSchema } from "../../../src/mcp/tools/reclog.js";
import { lcg, leagueScoring, row, trace } from "./attribution-helpers.js";
import { QB1, RB1, RB2, WR1, alt, rec, record, subj } from "./helpers.js";

const NOW = "2026-10-06T12:00:00.000Z";
const clock = () => fixedClock(NOW);

const GAMES_FINAL: GameFlags[] = [
  { kickoff_ms: Date.parse("2026-10-04T17:00:00Z"), valid_for_locking: true, stats_official: true },
  { kickoff_ms: Date.parse("2026-10-06T00:15:00Z"), valid_for_locking: true, stats_official: true },
];
const GAMES_LIVE: GameFlags[] = [
  {
    kickoff_ms: Date.parse("2026-10-04T17:00:00Z"),
    valid_for_locking: true,
    stats_official: false,
  },
];

/** Week 4's calls: start RB1 over RB2 (backed), add WR1 (no row → unbacked), an evidence note. */
function calls(): RecommendationRecord[] {
  return [
    record({
      log_id: "rec-01K6D00000000000000000000A",
      week: 4,
      recorded_at: "2026-10-01T12:00:00.000Z",
    }),
    record({
      log_id: "rec-01K6D00000000000000000000B",
      week: 4,
      kind: "waiver",
      recorded_at: "2026-10-01T13:00:00.000Z",
      rec: rec({ action: "Add WR1, drop QB1", subjects: [subj(WR1, "add"), subj(QB1, "drop")] }),
      alternatives: [alt()],
    }),
    record({
      log_id: "rec-01K6D00000000000000000000C",
      week: 4,
      kind: "evidence",
      recorded_at: "2026-10-01T14:00:00.000Z",
      rec: rec({ action: "Outlook conflicts with status", subjects: [] }),
      alternatives: [],
    }),
  ];
}

const week4 = (): ScoringWeek => ({
  week: 4,
  records: calls(),
  facts: [],
  roster: null,
  team_result: null,
});

/** 400 share-traced player-weeks over weeks 1–4 whose realised share follows h = 5 (model used 3). */
function evidence(): AttributionRow[] {
  const r = lcg(7);
  return Array.from({ length: 400 }, (_, i) => {
    const history = Array.from({ length: 6 }, () => 0.1 + 0.5 * r());
    return row({
      week: 1 + (i % 4),
      player_id: 10_000 + i,
      gsis_id: null,
      trace: trace({
        matchup: null,
        shares: [{ name: "target_share", history, half_life: 3, realised: ewm(history, 5) }],
        rates: [],
      }),
    });
  });
}

/** The scored week's two subjects (RB1 as projected, RB2 a quiet week). */
function subjects(): AttributionRow[] {
  return [
    row({ week: 4 }),
    row({
      week: 4,
      player_id: RB2.id,
      gsis_id: RB2.gsis,
      realised_points: 6,
      realised: { rush_att: 8, rush_yd: 30, rec: 1, rec_yd: 5, targets: 2 },
    }),
  ];
}

function input(over: Partial<RetrospectiveInput> = {}): RetrospectiveInput {
  return {
    week: 4,
    games: GAMES_FINAL,
    kinds: null,
    weeks: [week4()],
    player_forecasts: [],
    probabilities: { p_active: [], p_win: [], p_playoffs: [], p_role_holds: [], p_k_win: [] },
    weight_espn: 1,
    min_n: 30,
    inputs: [],
    attribution: {
      rows: [...subjects(), ...evidence()],
      scoring: leagueScoring(),
      tuned: null,
      season: 2026,
    },
    ...over,
  };
}

describe("without attribution rows: the v1 shape", () => {
  it.each([undefined, null])("attribution %s → null, no proposals, no per-call rows", (a) => {
    const base = input();
    const { attribution: _drop, ...rest } = base;
    const r = buildRetrospective(a === undefined ? rest : { ...rest, attribution: a }, clock());
    expect(r.data.attribution).toBeNull();
    expect(r.data.parameter_changes_proposed).toEqual([]);
    expect(r.call_attribution).toEqual([]);
    expect(r.proposal_set).toBeNull();
    expect(r.data.sample_size.attribution).toBeUndefined();
    expect(r.data.rec.action).toMatch(/do not tune it/);
  });
});

describe("with attribution rows on a final week", () => {
  const r = buildRetrospective(input(), clock());

  it("every projection-backed call carries its decomposition, aligned to calls[]", () => {
    expect(r.call_attribution.map((c) => c.log_id)).toEqual(r.data.calls.map((c) => c.log_id));
    const [lineup, waiver, evidenceCall] = r.call_attribution;
    expect(lineup).toMatchObject({ index: 0, projection_backed: true, complete: true });
    expect(waiver).toMatchObject({ index: 1, projection_backed: false });
    expect(evidenceCall).toMatchObject({
      index: 2,
      subjects_weighted: 0,
      projection_backed: false,
    });
    const a = r.data.attribution ?? {};
    expect(a["calls.projection_backed"]).toBe(1);
    expect(a["calls.complete"]).toBe(1);
    expect(a["calls.unbacked"]).toBe(1);
    expect(a["calls.0.error"]).toBeCloseTo(18 - 14 - (6 - 14), 3);
    for (const l of ATTRIBUTION_LAYERS) expect(a[`calls.0.${l}`]).toBeTypeOf("number");
    expect(a["calls.1.error"]).toBeUndefined();
  });

  it("the aggregate is pooled season-to-date and gated on min_n", () => {
    const a = r.data.attribution ?? {};
    expect(a.n_player_weeks).toBe(402);
    expect(a["error.mae"]).toBeTypeOf("number");
    expect(a["RB.n"]).toBe(402);
    expect(r.data.sample_size.attribution).toEqual({
      n: 402,
      n_needed: 30,
      weeks_to_n30_estimate: 0,
    });
  });

  it("proposes the re-fit: the wire's first ten, the full set for the store, never applied", () => {
    const set = r.proposal_set!;
    expect(set.season).toBe(2026);
    expect(set.week).toBe(4);
    expect(set.created_at).toBe(NOW);
    expect(set.proposals.find((p) => p.parameter === "ewm_half_life_games")).toMatchObject({
      current: 3,
      proposed: 4,
    });
    expect(r.data.parameter_changes_proposed).toEqual(wireProposals(set));
    expect(r.data.rec.no_move).toBe(true);
    expect(r.data.rec.action).toMatch(/eff tune --apply in your own terminal/);
  });

  it("data still passes E13's own output schema (the wire contract is unchanged)", () => {
    expect(retrospectiveSchema.safeParse(r.data).success).toBe(true);
  });
});

describe("a provisional week", () => {
  it("attributes but proposes nothing, and says why", () => {
    const r = buildRetrospective(input({ games: GAMES_LIVE }), clock());
    expect(r.data.attribution?.n_player_weeks).toBe(402);
    expect(r.proposal_set).toBeNull();
    expect(r.data.parameter_changes_proposed).toEqual([]);
    expect(r.data.sample_size_caveats).toContain(
      "parameter proposals: made on final weeks only (this week is provisional)",
    );
    expect(retrospectiveSchema.safeParse(r.data).success).toBe(true);
  });
});

describe("hostile rows are counted, never fatal", () => {
  it("look-ahead, duplicates, invalid and unscorable rows", () => {
    const warns: string[] = [];
    const out = attributeWindow(
      [
        row({ week: 4 }),
        row({ week: 4 }), // duplicate (week, player_id)
        row({ week: 5 }), // after the scored week
        row({ week: 0 }), // not a week
        row({ week: 3, reported_mean: Number.NaN }),
        row({ week: 3, position_id: 99 }),
        null as unknown as AttributionRow,
        row({ week: 3, player_id: null }),
        row({ week: 3, player_id: null }), // no id → never deduplicated
      ],
      leagueScoring(),
      4,
      (n, what) => {
        if (n > 0) warns.push(`${String(n)} ${what}`);
      },
    );
    expect(out).toHaveLength(3);
    expect(warns).toEqual([
      "3 attribution rows excluded (invalid row)",
      "1 attribution rows excluded (a line the engine cannot score)",
      "1 attribution rows after the scored week skipped",
      "1 duplicate attribution player-weeks skipped",
    ]);
  });

  it("buildRetrospective forwards the counts as warnings", () => {
    const r = buildRetrospective(
      input({
        attribution: {
          rows: [...subjects(), row({ week: 9 }), row({ week: 2, expected: { "bad key": 1 } })],
          scoring: leagueScoring(),
          tuned: null,
          season: 2026,
        },
      }),
      clock(),
    );
    expect(r.warnings).toContain("retrospective: 1 attribution rows after the scored week skipped");
    expect(r.warnings).toContain("retrospective: 1 attribution rows excluded (invalid row)");
    expect(r.data.attribution?.n_player_weeks).toBe(2);
    expect(r.data.attribution?.["error.mae"]).toBeUndefined();
    expect(r.data.sample_size_caveats).toContain("attribution: n too small (2 of 30)");
  });
});

describe("filters and the rec", () => {
  it("a kinds filter keeps call_attribution aligned to the filtered calls", () => {
    const r = buildRetrospective(input({ kinds: ["waiver"] }), clock());
    expect(r.data.calls.map((c) => c.kind)).toEqual(["waiver"]);
    expect(r.call_attribution).toHaveLength(1);
    expect(r.call_attribution[0]).toMatchObject({ index: 0, projection_backed: false });
  });

  it("withProposals leaves the rec alone without proposals", () => {
    const r = buildRetrospective(input(), clock());
    const base = { ...r.data.rec };
    expect(withProposals(base, null)).toBe(base);
    expect(withProposals(base, { ...r.proposal_set!, proposals: [] })).toBe(base);
    const one = withProposals(base, {
      ...r.proposal_set!,
      proposals: r.proposal_set!.proposals.slice(0, 1),
    });
    expect(one.action).toMatch(/^1 parameter change proposed/);
    expect(one.assumptions.length).toBe(base.assumptions.length + 1);
  });

  it("two id-less rows on the same gsis id are ambiguous: the subject is not attributed", () => {
    const r = buildRetrospective(
      input({
        attribution: {
          rows: [
            row({ week: 4, player_id: null, gsis_id: RB1.gsis }),
            row({ week: 4, player_id: null, gsis_id: RB1.gsis, realised_points: 3 }),
          ],
          scoring: leagueScoring(),
          tuned: null,
          season: 2026,
        },
      }),
      clock(),
    );
    expect(r.data.attribution?.n_player_weeks).toBe(2);
    expect(r.call_attribution[0]).toMatchObject({
      projection_backed: false,
      subjects_attributed: 0,
    });
  });

  it("an RB1 subject joins by gsis id when the row has no ESPN id", () => {
    const r = buildRetrospective(
      input({
        attribution: {
          rows: [row({ week: 4, player_id: null, gsis_id: RB1.gsis })],
          scoring: leagueScoring(),
          tuned: null,
          season: 2026,
        },
      }),
      clock(),
    );
    expect(r.call_attribution[0]).toMatchObject({
      projection_backed: true,
      complete: false,
      subjects_attributed: 1,
    });
  });
});
