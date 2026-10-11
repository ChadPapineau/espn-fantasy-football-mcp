// projection-v2.test.ts — E1's v2 assembly helpers (src/mcp/tools/projection-v2.ts; plan 10 §3.3):
// a stored player-week becomes v2's per-game counts (fumbles read only as a sum, absent counts 0,
// the usage extras and ffopportunity's xTD carried), a schedule row's team side (spread sign,
// implied total, score), the availability rule (ESPN's non-ACTIVE status wins; the official
// designation and last practice otherwise; inside the game-day window ESPN alone), the merge's skip
// assumption and identity on nothing to merge, and the human-applied weight. Synthetic values; the
// tool-level behaviour is held by tests/integration/e1-v2.test.ts and phase3-tools.test.ts.
import { describe, expect, it } from "vitest";
import type { ProjectionOutcome } from "../../src/domain/analytics/index.js";
import type { NflGame, PlayerWeekLine } from "../../src/domain/analytics/types.js";
import type { StatLine } from "../../src/domain/scoring/types.js";
import {
  availabilityOf,
  mergeV2,
  skipAssumption,
  teamSideOf,
  v2GameOf,
  weightEspnOf,
} from "../../src/mcp/tools/projection-v2.js";
import type { ToolContext } from "../../src/mcp/define.js";

const line = (values: Record<string, number>): StatLine =>
  ({
    values,
    present: Object.keys(values),
    position: 3,
    position_class: "O",
    provisional: false,
    source: "nflverse",
  }) as unknown as StatLine;

describe("v2GameOf", () => {
  it("maps the canonical line and the usage extras; fumbles lost as one sum; absent counts 0", () => {
    const l = {
      gsis_id: "00-9000101",
      season: 2026,
      week: 2,
      nfl_team: "MIA",
      opponent: "BUF",
      position: "WR",
      line: line({ targets: 9, rec: 6, rec_yd: 77, rec_td: 1, fum_lost: 1, two_pt_total: 1 }),
      usage: { snap_pct: 0.88, rz_targets: 2, rz_carries: 0, gl_carries: 0 },
    } as unknown as PlayerWeekLine;
    const g = v2GameOf(l, { rec: 0.6, rush: null, pass: null });
    expect(g).toMatchObject({
      season: 2026,
      week: 2,
      team: "MIA",
      opponent: "BUF",
      targets: 9,
      rec: 6,
      rec_yd: 77,
      rec_td: 1,
      pass_att: 0,
      rush_att: 0,
      two_pt: 1,
      snap_pct: 0.88,
      rz_targets: 2,
      x_rec_td: 0.6,
      x_rush_td: null,
      rz_rec_td: null,
    });
    expect(g.sack_fum_lost + g.rush_fum_lost + g.rec_fum_lost).toBe(1);
    const bare = v2GameOf({ ...l, usage: null }, null);
    expect(bare.snap_pct).toBeNull();
    expect(bare.x_rec_td).toBeNull();
  });
});

describe("teamSideOf", () => {
  const g = {
    home: "MIA",
    away: "BUF",
    lines: {
      spread_line: 3,
      total_line: 47,
      implied: { home: 25, away: 22 },
      moneyline: { home: null, away: null },
      as_of: "2026-10-01T00:00:00.000Z",
    },
    score: { home: 24, away: 20 },
  } as unknown as NflGame;
  it("reads the home and away sides (team-side spread > 0 = favoured) and refuses a third team", () => {
    expect(teamSideOf(g, "MIA")).toEqual({
      implied: 25,
      spread: 3,
      total: 47,
      points: 24,
      opponent: "BUF",
    });
    expect(teamSideOf(g, "BUF")).toEqual({
      implied: 22,
      spread: -3,
      total: 47,
      points: 20,
      opponent: "MIA",
    });
    expect(teamSideOf(g, "NYJ")).toBeNull();
    expect(teamSideOf({ ...g, lines: null, score: null }, "MIA")).toEqual({
      implied: null,
      spread: null,
      total: null,
      points: null,
      opponent: "BUF",
    });
  });
});

describe("availabilityOf", () => {
  const off = {
    report_status: "Questionable",
    practice: [{ status: "Limited" }, { status: "Full" }],
  };
  it("ESPN's non-ACTIVE status wins; else the official designation with the last practice", () => {
    expect(availabilityOf("OUT", off, false)).toEqual({ designation: "OUT", practice: "Full" });
    expect(availabilityOf("ACTIVE", off, false)).toEqual({
      designation: "Questionable",
      practice: "Full",
    });
    expect(availabilityOf(null, null, false)).toEqual({ designation: null, practice: null });
  });
  it("inside the game-day window ESPN's status alone decides (plan 07 D2)", () => {
    expect(availabilityOf("ACTIVE", off, true)).toEqual({
      designation: null,
      practice: null,
      game_day: true,
    });
    expect(availabilityOf("DOUBTFUL", off, true)).toEqual({
      designation: "DOUBTFUL",
      practice: null,
      game_day: true,
    });
  });
});

describe("mergeV2", () => {
  const v1 = {
    data: { model_version: "v1-ensemble", projections: [], completed_samples: 10, inputs: [] },
    players: [],
    partial: false,
    warnings: [],
  } as unknown as ProjectionOutcome;
  it("nothing modelled and nothing skipped → the v1 outcome itself", () => {
    expect(mergeV2(v1, { outcome: null, skipped: new Map() }, false)).toBe(v1);
  });
  it("a skipped modelled player carries the fixed-vocabulary assumption; the label stays v1", () => {
    const pp = {
      target: { player_id: 5 },
      projection: { player_id: 5, assumptions: [], weeks: [], drivers: [] },
      weeks: [],
    };
    const out = mergeV2(
      {
        ...v1,
        players: [pp],
        data: { ...v1.data, projections: [pp.projection] },
      } as unknown as ProjectionOutcome,
      { outcome: null, skipped: new Map([[5, "bye"]]) },
      false,
    );
    expect(out.data.model_version).toBe("v1-ensemble");
    expect(out.data.projections[0]?.assumptions).toEqual([skipAssumption("bye")]);
    expect(skipAssumption("no_history").text).toMatch(
      /^v2-opportunity did not model this player \(no_history\)/,
    );
  });
});

describe("weightEspnOf", () => {
  const ctx = (values: Record<string, number> | null): ToolContext =>
    ({
      options: { tuned: values === null ? null : { values, updated_at: null } },
    }) as unknown as ToolContext;
  it("the shipped 1.0 unless a human applied an in-range weight", () => {
    expect(weightEspnOf(ctx(null))).toBe(1);
    expect(weightEspnOf(ctx({ "matchup_beta.RB": 0.3 }))).toBe(1);
    expect(weightEspnOf(ctx({ weight_espn: 0.75 }))).toBe(0.75);
    expect(weightEspnOf(ctx({ weight_espn: 1.5 }))).toBe(1);
  });
});
