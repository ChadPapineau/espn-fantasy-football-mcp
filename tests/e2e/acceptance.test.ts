// acceptance.test.ts — the hard parts of plan 10 A9a, A11a and A13a that the derived league can
// carry, end to end over real stdio on fx-10h and its variants (the Skills' call order: the facts a
// tool needs are read first, so the analytics answer from a warm cache inside their request budget).
// The cold path is checked too: a standalone first call is partial and names the read it lacked
// (plan 01 §5.6), and the next call answers what the Skills' order answers.
//
// A9a (waiver priority): the premium comes from the cold-start table and equals the domain DP at
// the (k, W) the tool reports; the band is populated (low < premium < high); a candidate inside the
// band is `marginal` and never in claim_list; outside it claim ⇔ s ≥ Π; on k10 every positive-surplus
// candidate is claim or fa_add_after_run and the scramble list is non-empty; on ir-open s_with_ir_move
// ≥ s; on post-run no claim targets a FREEAGENT player. (fx-10h's waiver pool has no candidate
// inside the band, so the inside leg here is the general rule claim_list ∩ marginal = ∅; the band
// itself is a property in tests/domain/analytics/waivers.test.ts.) A11a (start/sit): objective auto resolves to
// mean on the base and to points_only where the league is configured points_only; the mode agrees
// with the sign of μ_m − μ_o under reading (a); no swap benches a lineup_locked starter (sunday-live).
// A13a (retrospective): a call logged for the final week 4 is scored by espn_analyze_retrospective
// (followed, realised, regret against the structured alternative offered, projection_vs_espn,
// sample sizes with their caveats; the log text path-listed as untrusted).
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { priorityPremium } from "../../src/domain/analytics/waiverDp.js";
import { bodyOf, FX, makeHome, requireDist, serve, type E2eHome, type Served } from "./helpers.js";

type J = Record<string, unknown>;
const homes: E2eHome[] = [];
const servers: Served[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop().catch(() => undefined);
  for (const h of homes) h.cleanup();
});
async function open(variant: string | null, env: Record<string, string> = {}): Promise<Served> {
  requireDist();
  const h = makeHome({ fixtureDir: variant === null ? FX : path.join(FX, variant), env });
  homes.push(h);
  const s = await serve(h);
  servers.push(s);
  return s;
}
async function ok(s: Served, name: string, args: J = {}): Promise<J> {
  const r = await s.client.callTool({ name, arguments: args });
  const b = bodyOf(r);
  expect(r.isError, `${name}: ${JSON.stringify(b).slice(0, 300)}`).not.toBe(true);
  return b;
}
interface Candidate {
  player_id: number;
  status: string;
  s: number;
  s_with_ir_move: number;
  verdict: string;
}
async function waivers(variant: string | null): Promise<{ data: J; cands: Candidate[] }> {
  const s = await open(variant);
  await ok(s, "espn_get_standings");
  await ok(s, "espn_get_roster", { week: 5 });
  await ok(s, "espn_list_players", {
    status: variant === "post-run" ? "FREEAGENT" : "WAIVERS",
    sort: "percOwned",
    week: 5,
    limit: 25,
  });
  const b = await ok(s, "espn_analyze_waivers", { mode: "priority", detail: "full" });
  const data = b.data as J;
  const marginal = new Set(data.marginal as number[]);
  for (const id of data.claim_list as number[])
    expect(marginal.has(id), `${String(id)} claim and marginal`).toBe(false);
  return { data, cands: data.candidates as Candidate[] };
}

describe("A9a — waiver priority on fx-10h", { timeout: 300_000 }, () => {
  it("base: the cold-start premium at the reported (k, W), its band, and the claim/marginal rules", async () => {
    const { data, cands } = await waivers(null);
    expect(data.premium_basis).toBe("cold_start_table");
    expect(data.k).toBe(2);
    const premium = data.premium as number;
    const band = data.premium_band as { low: number; high: number };
    expect(band.low).toBeLessThan(premium);
    expect(premium).toBeLessThan(band.high);
    expect(
      Math.abs(premium - priorityPremium(data.k as number, data.W as number, 10)),
    ).toBeLessThanOrEqual(0.5);
    const claim = new Set(data.claim_list as number[]);
    const marginal = new Set(data.marginal as number[]);
    const onWaivers = cands.filter((c) => c.status === "WAIVERS");
    expect(onWaivers.length).toBeGreaterThan(0);
    for (const c of onWaivers) {
      if (c.s >= band.low && c.s <= band.high) {
        expect(c.verdict, `${String(c.player_id)} inside the band`).toBe("marginal");
        expect(marginal.has(c.player_id)).toBe(true);
        expect(claim.has(c.player_id)).toBe(false);
      } else
        expect(c.verdict === "claim", `${String(c.player_id)}: claim ⇔ s ≥ Π`).toBe(c.s >= premium);
    }
  });

  it("k10: every positive-surplus candidate is claim or fa_add_after_run; the scramble list is non-empty", async () => {
    const { data, cands } = await waivers("k10");
    expect(data.k).toBe(10);
    const positive = cands.filter((x) => x.s > 0);
    expect(positive.length).toBeGreaterThan(0);
    for (const c of positive) expect(["claim", "fa_add_after_run"]).toContain(c.verdict);
    expect((data.scramble_list as unknown[]).length).toBeGreaterThan(0);
  });

  it("ir-open: both surpluses present and s_with_ir_move ≥ s", async () => {
    const { cands } = await waivers("ir-open");
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(typeof c.s_with_ir_move).toBe("number");
      expect(c.s_with_ir_move).toBeGreaterThanOrEqual(c.s);
    }
  });

  it("post-run: the phase is post_run and no claim targets a FREEAGENT player", async () => {
    const { data, cands } = await waivers("post-run");
    expect(data.phase).toBe("post_run");
    expect(cands.some((c) => c.status === "FREEAGENT")).toBe(true);
    for (const c of cands) if (c.status === "FREEAGENT") expect(c.verdict).not.toBe("claim");
  });
});

describe(
  "A9a on a cold cache — the tool's own path, no Skill warm-up",
  { timeout: 300_000 },
  () => {
    it("a standalone first call is partial and names what it lacks; the next call is the Skills' answer", async () => {
      const s = await open(null);
      const args = { mode: "priority", detail: "full" };
      const cold = await ok(s, "espn_analyze_waivers", args);
      const cd = cold.data as J;
      const coldWarnings = cold.warnings as string[];
      // plan 01 §5.6: settings, rosters and the pool take the 3 requests; standings is the 4th
      expect(cold.partial).toBe(true);
      expect(coldWarnings.some((w) => w.startsWith("partial: espn:mTeam was not requested"))).toBe(
        true,
      );
      expect(coldWarnings).toContain(
        "standings unavailable: waiver rank unknown (cold-start premium at k = N/2)",
      );
      expect(cd.k).toBeNull();
      expect(cd.premium_basis).toBe("cold_start_table");
      expect(
        Math.abs((cd.premium as number) - priorityPremium(Math.ceil(10 / 2), cd.W as number, 10)),
      ).toBeLessThanOrEqual(0.5);
      // the claim ⇔ s ≥ Π rule holds on the partial answer too (it is priced at the cold-start k)
      const band = cd.premium_band as { low: number; high: number };
      for (const c of cd.candidates as Candidate[])
        if (c.status === "WAIVERS" && (c.s < band.low || c.s > band.high))
          expect(c.verdict === "claim").toBe(c.s >= (cd.premium as number));
      // the next call pays for the one read the cold call could not, and answers what a server warmed
      // in the Skills' order answers
      const next = await ok(s, "espn_analyze_waivers", args);
      expect(next.partial).toBe(false);
      expect((next.warnings as string[]).some((w) => w.startsWith("partial:"))).toBe(false);
      const ref = await waivers(null);
      const nd = next.data as J;
      expect(nd.k).toBe(2);
      for (const key of [
        "k",
        "W",
        "premium",
        "premium_band",
        "premium_basis",
        "claim_list",
        "marginal",
        "scramble_list",
      ])
        expect(nd[key], key).toEqual(ref.data[key]);
    });

    it("cold lineup and retrospective calls: partial is true exactly when the budget held a read back", async () => {
      for (const [name, args] of [
        ["espn_analyze_lineup", {}],
        ["espn_analyze_retrospective", { week: 4 }],
      ] as const) {
        const s = await open(null);
        const cold = await ok(s, name, args);
        const hit = (cold.warnings as string[]).filter((w) => w.startsWith("partial: espn:"));
        expect(hit.length, `${name}: the cold call is over budget on fx-10h`).toBeGreaterThan(0);
        expect(cold.partial, name).toBe(true);
        const next = await ok(s, name, args);
        expect(
          (next.warnings as string[]).some((w) => w.startsWith("partial:")),
          name,
        ).toBe(false);
        expect(next.partial, name).toBe(false);
      }
    });
  },
);

describe("A11a — start/sit on fx-10h", { timeout: 300_000 }, () => {
  async function lineup(
    variant: string | null,
    env: Record<string, string> = {},
    args: J = {},
  ): Promise<J> {
    const s = await open(variant, env);
    await ok(s, "espn_get_schedule", { weeks: [5] });
    await ok(s, "espn_get_roster", { week: 5 });
    return (await ok(s, "espn_analyze_lineup", { week: 5, objective: "auto", ...args })).data as J;
  }

  it("objective auto: mean on the base; the mode agrees with the sign of μ_m − μ_o (reading (a))", async () => {
    const d = await lineup(null);
    expect(d.objective_used).toBe("mean");
    expect(d.seeding_mode_used).toBe("espn_rule");
    const mb = d.mode_basis as { mu_m: number; mu_o: number };
    const mode = d.mode as string;
    if (mode === "chase") expect(mb.mu_m).toBeLessThan(mb.mu_o);
    if (mode === "protect") expect(mb.mu_m).toBeGreaterThan(mb.mu_o);
  });

  it("objective auto: points_only on points-only-seeding once the league is configured points_only", async () => {
    const d = await lineup("points-only-seeding", { EFF_SEEDING_MODE: "points_only" });
    expect(d.objective_used).toBe("points_only");
    expect(d.seeding_mode_used).toBe("points_only");
  });

  it("sunday-live: no swap benches a lineup_locked starter", async () => {
    const d = await lineup("sunday-live", {}, { only_unlocked: true });
    const lockedNow = new Set<number>();
    const clock = Date.parse("2026-10-11T18:05:00.000Z");
    for (const l of d.lock_schedule as { lock_at: string; player_ids: number[] }[])
      if (Date.parse(l.lock_at) <= clock) for (const id of l.player_ids) lockedNow.add(id);
    expect(lockedNow.size).toBeGreaterThan(0);
    for (const sw of d.swaps as { out: number; in: number }[]) {
      expect(lockedNow.has(sw.out), `swap benches locked ${String(sw.out)}`).toBe(false);
      expect(lockedNow.has(sw.in), `swap starts locked ${String(sw.in)}`).toBe(false);
    }
  });
});

describe("A13a — a logged week-4 call is scored by the retrospective", { timeout: 300_000 }, () => {
  it("record on the final week, then espn_analyze_retrospective(4): followed, realised, regret, sample sizes, untrusted log text", async () => {
    const s = await open(null);
    const league = await ok(s, "espn_get_league");
    await ok(s, "espn_get_schedule", { weeks: [4] });
    const l4 = await ok(s, "espn_analyze_lineup", { week: 4, objective: "auto" });
    const r4 = (l4.data as J).rec as {
      subjects: {
        player_id: number | null;
        gsis_id: string | null;
        role: string;
        slot: string | null;
      }[];
      point_estimate: number;
      distribution: unknown;
    };
    // the alternative offered: one starter swapped for a bench player who scored in week 4 — a
    // structured alternative, so the retrospective can compute regret from the subjects
    const box = await ok(s, "espn_get_box_score", { week: 4 });
    const mineSide = ((box.data as J).matchups as { home: J; away: J | null }[])
      .flatMap((m) => [m.home, m.away])
      .find((x) => x !== null && x.team_id === 2) as {
      players: { player_id: number; slot: string; points_espn: number | null }[];
    };
    const bench = mineSide.players.find(
      (p) => p.slot === "BE" && typeof p.points_espn === "number",
    );
    expect(bench).toBeDefined();
    const starts = r4.subjects.filter((x) => x.role === "start" && x.player_id !== null);
    expect(starts.length).toBeGreaterThan(0);
    const swapped = starts[0];
    const altSubjects = [
      ...r4.subjects.filter((x) => x !== swapped),
      {
        player_id: bench?.player_id ?? 0,
        gsis_id: null,
        role: "start",
        slot: swapped?.slot ?? null,
      },
      { player_id: swapped?.player_id ?? 0, gsis_id: null, role: "sit", slot: null },
    ];
    const rec = await ok(s, "espn_record_recommendation", {
      kind: "lineup",
      week: 4,
      rec: r4,
      alternatives: [
        {
          action: "start the bench player instead",
          subjects: altSubjects,
          point_estimate: r4.point_estimate,
          distribution: r4.distribution,
          decision_metric_value: 0,
        },
      ],
      source_calls: [{ tool: "espn_analyze_lineup", request_id: (l4.meta as J).request_id }],
      settings_hash: ((league.data as J).scoring as J).settings_hash,
      followed_hint: "unknown",
      client_ref: "e2e-retro-w4",
    });
    const logId = (rec.data as J).log_id as string;
    const retro = await ok(s, "espn_analyze_retrospective", { week: 4 });
    const data = retro.data as {
      final: boolean;
      calls: {
        log_id: string;
        followed: boolean | null;
        realised: number | null;
        regret: number | null;
      }[];
      metrics: { projection_vs_espn: J };
      sample_size: J;
      sample_size_caveats: string[];
    };
    expect(data.final).toBe(true);
    const call = data.calls.find((c) => c.log_id === logId);
    expect(call).toBeDefined();
    expect(call?.followed).toBe(true);
    expect(typeof call?.realised).toBe("number");
    expect(typeof call?.regret).toBe("number");
    expect(data.metrics.projection_vs_espn).toHaveProperty("n_player_weeks");
    expect(Object.keys(data.sample_size).length).toBeGreaterThan(5);
    expect(data.sample_size_caveats.length).toBeGreaterThan(0);
    expect((retro.meta as { untrusted_fields: unknown[] }).untrusted_fields).toEqual(
      expect.arrayContaining([
        { path: "data.calls[].recommended", source: "store.recommendation_log" },
      ]),
    );
  });
});
