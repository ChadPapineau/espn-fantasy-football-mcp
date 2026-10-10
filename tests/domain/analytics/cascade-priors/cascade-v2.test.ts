// cascade-v2.test.ts — E7 with the redistribution prior table (plan 10 §3.3, C6; plan 07 E7; plan 10
// B6's hard parts kept under v2): `priors` switches the prior split to the table and says so in the
// assumptions; without it (or null, or for a QB) E7 is exactly v1; the depth chart orders the
// receiver behind the starters; an OUT teammate takes nothing; and as properties — beneficiaries
// never sum above the vacated share (shares and per-game counts, with team evidence), and
// `hypothesis_only` is true whenever team_games = 0 ∧ usage_confirmed = false ∧ market_move = null —
// over the shipped table and random tables.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  analyzeInjuryCascade,
  redistribute,
  type CascadeRequest,
  type CascadeTeammate,
} from "../../../../src/domain/analytics/cascade.js";
import { CASCADE_PRIORS } from "../../../../src/domain/analytics/cascade-priors/shipped.js";
import type { PriorCell } from "../../../../src/domain/analytics/cascade-priors/types.js";
import { BENEFICIARY_ROLES } from "../../../../src/domain/analytics/cascade-priors/types.js";
import type { InjuryStatus } from "../../../../src/domain/league/types.js";
import { bare, clockAndRng } from "../helpers.js";
import { cell, tableOf } from "./helpers/synth.js";

function mate(
  id: number,
  position: string,
  u: { t: number; c: number; rz: number },
  over: Partial<CascadeTeammate> = {},
): CascadeTeammate {
  return {
    player_id: id,
    gsis_id: null,
    name: bare(`Player ${String(id)}`),
    position,
    injury_status: null,
    usage: { target_share: u.t, carry_share: u.c, rz_share: u.rz, snap_pct: 0.5 },
    percent_change: null,
    availability: { status: "WAIVERS", waiver_process_date: "2026-10-07T07:00:00.000Z" },
    ...over,
  };
}

const MATES: CascadeTeammate[] = [
  mate(201, "RB", { t: 0.03, c: 0.2, rz: 0.1 }),
  mate(202, "RB", { t: 0.09, c: 0.04, rz: 0.03 }),
  mate(203, "WR", { t: 0.24, c: 0.01, rz: 0.15 }),
  mate(204, "WR", { t: 0.16, c: 0, rz: 0.08 }),
  mate(205, "TE", { t: 0.12, c: 0, rz: 0.1 }),
  mate(206, "QB", { t: 0, c: 0.08, rz: 0.06 }),
];

function req(over: Partial<CascadeRequest> = {}): CascadeRequest {
  return {
    injured: {
      player_id: 100,
      gsis_id: null,
      name: bare("Player 100"),
      nfl_team: "T1",
      position: "RB",
      injury_status: "OUT",
      usage: { target_share: 0.12, carry_share: 0.62, rz_share: 0.4 },
    },
    teammates: MATES,
    team_volume: { targets: 34, carries: 26, rz: 8 },
    team_games_without: 0,
    weeks: [5, 6, 7, 8],
    reception_points: 0.5,
    clock: clockAndRng("2026-10-06T20:00:00.000Z").clock,
    ...over,
  };
}
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

describe("E7 v2 — the table's split", () => {
  it("an RB's absence: the early-down back (most carries) leads; the assumption names the table", async () => {
    const { data } = await analyzeInjuryCascade(req({ priors: CASCADE_PRIORS }));
    expect(data.beneficiaries[0]?.player_id).toBe(201);
    const texts = data.rec.assumptions.map((a) => a.text);
    expect(
      texts.some((t) =>
        t.startsWith(
          `the prior split is the redistribution table from pbp history (${String(CASCADE_PRIORS.absences)} starter absences, 2023–2025;`,
        ),
      ),
    ).toBe(true);
    expect(texts).toContain(
      "no team evidence without the starter: the split is the league-wide prior table, not this team's history",
    );
    expect(data.hypothesis_only).toBe(true); // the prior is still only a prior
  });
  it("without priors, with null, or for a QB the output is exactly v1's", async () => {
    const v1 = await analyzeInjuryCascade(req());
    expect(await analyzeInjuryCascade(req({ priors: null }))).toEqual(v1);
    const qb = {
      ...req().injured,
      position: "QB",
      usage: { target_share: 0, carry_share: 0.1, rz_share: 0.1 },
      weekly: [20, 20, 20, 20],
    };
    const mates = MATES.map((m) => (m.player_id === 206 ? { ...m, weekly: [6, 6, 6, 6] } : m));
    expect(
      await analyzeInjuryCascade(req({ injured: qb, teammates: mates, priors: CASCADE_PRIORS })),
    ).toEqual(await analyzeInjuryCascade(req({ injured: qb, teammates: mates })));
    expect(
      redistribute(qb, mates, 0, 0.5, { priors: CASCADE_PRIORS, team_volume: req().team_volume })
        .basis,
    ).toEqual({
      kind: "affinity",
    });
  });
  it("a context with no cell reads the pooled row, and says so", async () => {
    const t = tableOf(cell({ WR1: 0.3, WR2: 0.2, TE1: 0.1 }));
    const inj = {
      ...req().injured,
      position: "WR",
      usage: { target_share: 0.25, carry_share: 0, rz_share: 0.2 },
    };
    const { data } = await analyzeInjuryCascade(req({ injured: inj, priors: t }));
    expect(data.rec.assumptions.some((a) => a.text.includes("the WR pooled row"))).toBe(true);
    const r = redistribute(inj, MATES, 0, 0.5, { priors: t, team_volume: req().team_volume });
    expect(r.basis.kind).toBe("table");
    if (r.basis.kind === "table") expect(r.basis.pooled).toBe(true);
  });
  it("a context cell is named in the assumption", async () => {
    const t = tableOf(cell({ WR1: 0.3 }), {
      RB: {},
      WR: { "pass|lead": cell({ WR1: 0.5 }) },
      TE: {},
    });
    const inj = {
      ...req().injured,
      position: "WR",
      usage: { target_share: 0.25, carry_share: 0, rz_share: 0.2 },
    };
    const { data } = await analyzeInjuryCascade(req({ injured: inj, priors: t }));
    expect(
      data.rec.assumptions.some((a) =>
        a.text.includes("WR absences on a pass-leaning team with a lead role"),
      ),
    ).toBe(true);
  });
  it("the depth chart orders the receiver behind the two remaining starters; OUT takes nothing", () => {
    const t = tableOf(cell({ WR1: 0.1, WR2: 0.1, WR3: 0.4, WR4: 0.05 }));
    const inj = { position: "WR", usage: { target_share: 0.25, carry_share: 0, rz_share: 0 } };
    const mates = [
      mate(1, "WR", { t: 0.22, c: 0, rz: 0 }),
      mate(2, "WR", { t: 0.15, c: 0, rz: 0 }),
      mate(3, "WR", { t: 0.02, c: 0, rz: 0 }, { depth_rank: 4 }),
      mate(4, "WR", { t: 0, c: 0, rz: 0 }, { depth_rank: 2 }),
      mate(5, "WR", { t: 0, c: 0, rz: 0 }, { depth_rank: 3, injury_status: "OUT" as InjuryStatus }),
    ];
    const r = redistribute(inj, mates, 0, 0.5, {
      priors: t,
      team_volume: { targets: 34, carries: 26, rz: 8 },
    });
    const d = r.allocs.map((a) => a.delta.targets);
    expect(r.basis.kind === "table" ? r.basis.roles : null).toEqual([
      "WR1",
      "WR2",
      "WR4",
      "WR3",
      "WR4",
    ]);
    expect(d[3]).toBeCloseTo(0.25 * 0.4, 12); // the promoted backup
    expect(d[3]).toBeGreaterThan(d[2] ?? Infinity);
    expect(d[4]).toBe(0); // OUT: P(active) 0
    // without a depth chart the tie goes to usage: the backup with targets is WR3
    const flat = mates.map((m) => ({ ...m, depth_rank: null }));
    const r2 = redistribute(inj, flat, 0, 0.5, {
      priors: t,
      team_volume: { targets: 34, carries: 26, rz: 8 },
    });
    expect(r2.basis.kind === "table" ? r2.basis.roles[2] : null).toBe("WR3");
  });
});

const factor = fc.oneof(
  fc.double({ min: -2, max: 3, noNaN: true }),
  fc.constantFrom(Number.NaN, 1e6),
);
const randomCell = fc
  .dictionary(fc.constantFrom(...BENEFICIARY_ROLES), factor)
  .map((d): PriorCell => {
    const row = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { f: v, sd: 0, n: 1 }]));
    return { targets: row, carries: row, rz: row };
  });
const shareArb = fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null });
const statuses: (InjuryStatus | null)[] = [null, "ACTIVE", "QUESTIONABLE", "DOUBTFUL", "OUT"];
const matesArb = fc.array(
  fc.record({
    position: fc.constantFrom("QB", "RB", "WR", "TE"),
    t: shareArb,
    c: shareArb,
    rz: shareArb,
    wt: shareArb,
    wc: shareArb,
    wrz: shareArb,
    depth: fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }),
    status: fc.constantFrom(...statuses),
  }),
  { maxLength: 12 },
);

describe("plan 10 B6 hard parts under v2 (properties)", () => {
  it("beneficiaries never sum above the vacated share — shares and counts, with team evidence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(null), randomCell),
        fc.constantFrom("RB", "WR", "TE"),
        shareArb,
        shareArb,
        shareArb,
        fc.integer({ min: 0, max: 6 }),
        matesArb,
        async (rc, pos, t, c, rz, games, ms) => {
          const priors = rc === null ? CASCADE_PRIORS : tableOf(rc);
          const teammates = ms.map((m, i) =>
            mate(
              300 + i,
              m.position,
              { t: m.t ?? 0, c: m.c ?? 0, rz: m.rz ?? 0 },
              {
                injury_status: m.status,
                depth_rank: m.depth,
                without_starter:
                  m.wt === null && m.wc === null
                    ? null
                    : { target_share: m.wt, carry_share: m.wc, rz_share: m.wrz },
              },
            ),
          );
          const usage = { target_share: t, carry_share: c, rz_share: rz };
          const { vacated, allocs } = redistribute(
            { position: pos, usage },
            teammates,
            games,
            0.5,
            {
              priors,
              team_volume: { targets: 34, carries: 26, rz: 8 },
            },
          );
          for (const k of ["targets", "carries", "rz"] as const) {
            expect(sum(allocs.map((a) => a.delta[k]))).toBeLessThanOrEqual(vacated[k] + 1e-9);
            for (const a of allocs) expect(a.delta[k]).toBeGreaterThanOrEqual(0);
          }
          const { data } = await analyzeInjuryCascade(
            req({
              injured: { ...req().injured, position: pos, usage },
              teammates,
              team_games_without: games,
              priors,
            }),
          );
          for (const k of ["targets", "carries", "rz"] as const)
            expect(sum(data.beneficiaries.map((b) => b.delta_opportunity[k]))).toBeLessThanOrEqual(
              data.vacated[k] + 1e-3 * (data.beneficiaries.length + 1),
            );
        },
      ),
      { numRuns: 120 },
    );
  });
  it("hypothesis_only whenever no team games, no usage confirmation and no market move", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("RB", "WR", "TE"), matesArb, async (pos, ms) => {
        const teammates = ms.map((m, i) =>
          mate(
            300 + i,
            m.position,
            { t: m.t ?? 0, c: m.c ?? 0, rz: m.rz ?? 0 },
            { depth_rank: m.depth },
          ),
        );
        const { data } = await analyzeInjuryCascade(
          req({
            injured: { ...req().injured, position: pos },
            teammates,
            team_games_without: 0,
            priors: CASCADE_PRIORS,
          }),
        );
        // no `recent` usage and no percent_change on any teammate → no confirmation, no move
        expect(data.hypothesis_only).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
  it("the IR consequence is unchanged by v2: eligible only for OUT / INJURY_RESERVE", async () => {
    for (const status of ["OUT", "INJURY_RESERVE", "QUESTIONABLE", "DOUBTFUL"] as InjuryStatus[]) {
      const injured = {
        ...req().injured,
        injury_status: status,
        mine: { slot_id: 2, eligible_slot_ids: [2, 20, 21] },
      };
      const v1 = await analyzeInjuryCascade(req({ injured }));
      const v2 = await analyzeInjuryCascade(req({ injured, priors: CASCADE_PRIORS }));
      expect(v2.data.ir_consequence).toEqual(v1.data.ir_consequence);
      expect(v2.data.ir_consequence?.ir_eligible).toBe(
        status === "OUT" || status === "INJURY_RESERVE",
      );
    }
  });
});
