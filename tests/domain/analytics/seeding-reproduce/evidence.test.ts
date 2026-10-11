// evidence.test.ts — Stage C (docs/evals/phase3-summary.md "Open"): A1's `seeding.evidence` from the
// previous season's exact reproduction (src/domain/analytics/seeding-reproduce/evidence.ts), and the
// provider's settings read tolerating a previous season recorded with `mSettings` alone
// (src/providers/espn/provider.ts settingsRead): every finished season of the three probe leagues
// (fixtures/espn/recorded/history — placeholders only, keyless, no network) is now read ENTIRELY
// through the provider — standings, schedule, playoff rules and the bracket-edit flag — and its
// evidence names reading (a) with every team's chain place equal to its seed. Only a previous season
// reads mSettings alone; the current season keeps the identity read.
import { describe, expect, it } from "vitest";
import {
  findingCodes,
  readingMatches,
  reproduceSeason,
  reproductionInputFrom,
  seedingEvidenceFromReproduction,
  type SeasonReproduction,
} from "../../../../src/domain/analytics/seeding-reproduce/index.js";
import { normalizeLeague, normalizeLeagueRules } from "../../../../src/providers/espn/normalize.js";
import { mSettingsSchema } from "../../../../src/providers/espn/views/league.schema.js";
import {
  historyBody,
  historyFixtureFetch,
  servedSeasons,
} from "../../../fixtures/helpers/history-fixtures.js";
import {
  jsonResponse,
  makeWorld,
  SEASON,
  type LeagueSlot,
} from "../../../providers/espn/helpers.js";
import { seasonOf, seeded, standingsOf, type G } from "./helpers.js";

const SLOTS: readonly LeagueSlot[] = ["league-a", "league-b", "league-c"];
const EDITED = new Set(["league-b/2023", "league-b/2025"]);

/** One previous season read through the provider alone (no normaliser called by the test). */
async function readThroughProvider(slot: LeagueSlot, season: number) {
  const w = makeWorld({ fetch: historyFixtureFetch(slot) });
  const ref = { ...w.ref, season };
  const standings = (await w.provider.getStandings(ref)).value;
  const matchups = (await w.provider.getMatchups(ref)).value;
  const rules = (await w.provider.getLeagueRules(ref)).value;
  const league = (await w.provider.getLeague(ref)).value;
  return { w, ref, standings, matchups, rules, league };
}

describe("the provider reads a previous season with mSettings alone (its recorded history holds no more)", () => {
  it("rules and the league come through the provider and equal the normalisers over the recorded body", async () => {
    for (const slot of SLOTS)
      for (const [season] of servedSeasons(slot)) {
        const r = await readThroughProvider(slot, season);
        const body = mSettingsSchema.parse(historyBody(season, slot, "mSettings"));
        expect(r.rules, `${slot}/${String(season)}`).toEqual(normalizeLeagueRules(body));
        // no identity is read of a finished season: no team of mine configured, no commissioner
        expect(r.league).toEqual(normalizeLeague(body, r.ref, null, null, false));
        expect(r.league.playoff_matchup_edited).toBe(EDITED.has(`${slot}/${String(season)}`));
        // one settings request, mSettings alone, shared by every read of that season (cached)
        const settingsUrls = r.w.sent
          .map((x) => new URL(x.url))
          .filter((u) => u.searchParams.getAll("view").includes("mSettings"))
          .map((u) => u.searchParams.getAll("view").sort().join(","));
        expect(settingsUrls).toEqual(["mSettings"]);
      }
  }, 60_000);

  it("the current season still reads mSettings with mNav (the identity: my team, its name)", async () => {
    const w = makeWorld({ slot: "league-a", teamId: 1 });
    const league = (await w.provider.getLeague(w.ref)).value;
    expect(league.my_team?.team_id).toBe(1);
    expect(new URL(w.sent[0]?.url ?? "").searchParams.getAll("view").sort()).toEqual([
      "mNav",
      "mSettings",
    ]);
  });

  it("a previous season's league names my team by ESPN_TEAM_ID (no identity is read of it)", async () => {
    const w = makeWorld({ fetch: historyFixtureFetch("league-b"), teamId: 3 });
    const prev = { ...w.ref, season: SEASON - 1 };
    const league = (await w.provider.getLeague(prev)).value;
    expect(league.my_team?.team_id).toBe(3);
    expect(league.commissioner).toBe(false);
    expect(w.sent).toHaveLength(1);
    expect(new URL(w.sent[0]?.url ?? "").searchParams.getAll("view")).toEqual(["mSettings"]);
  });

  it("a previous season's credential and HTTP answers keep their codes (nothing is masked)", async () => {
    for (const status of [401, 404]) {
      const w = makeWorld({
        fetch: () => Promise.resolve(jsonResponse({ messages: ["x"] }, status)),
        over: { attemptTimeoutMs: 1000 },
      });
      const prev = { ...w.ref, season: SEASON - 1 };
      const e = await w.provider.getLeagueRules(prev).catch((x: unknown) => x);
      expect((e as { effCode?: unknown }).effCode, String(status)).toMatch(/^ESPN_/);
    }
  });
});

describe("A1's seeding evidence from the previous season's reproduction", () => {
  const evidenceOf = async (slot: LeagueSlot, season: number) => {
    const r = await readThroughProvider(slot, season);
    const s = reproduceSeason(
      reproductionInputFrom({
        season,
        standings: r.standings.teams,
        matchups: r.matchups,
        rules: r.rules,
        league: r.league,
      }),
    );
    return {
      s,
      ev: seedingEvidenceFromReproduction(
        s,
        r.league.playoff_matchup_edited,
        new Map(r.standings.teams.map((t) => [t.team_id, t.playoff_seed])),
      ),
    };
  };

  it("on all nine recorded seasons it names reading (a): every team's chain place is its seed", async () => {
    let n = 0;
    for (const slot of SLOTS)
      for (const [season] of servedSeasons(slot)) {
        const { ev } = await evidenceOf(slot, season);
        const k = `${slot}/${String(season)}`;
        n += 1;
        expect(ev.method, k).toBe("reproduction");
        expect(ev.season).toBe(season);
        expect(ev.suggests, k).toBe("espn_rule");
        expect(ev.seed_order_matches_record, k).toBe(true);
        expect(ev.seed_order_matches_pf, k).toBe(false);
        expect(ev.playoff_edited, k).toBe(EDITED.has(k));
        expect(ev.findings, k).toEqual(EDITED.has(k) ? ["playoff_edited"] : []);
        for (const row of ev.table) expect(row.record_rank, k).toBe(row.seed);
        // seed order, then team id; pf_rank a permutation of 1..n
        const seeds = ev.table.map((t) => t.seed ?? Infinity);
        expect(seeds).toEqual([...seeds].sort((a, b) => a - b));
        expect(ev.table.map((t) => t.pf_rank).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
          ev.table.map((_, i) => i + 1),
        );
      }
    expect(n).toBe(9);
  }, 60_000);

  // a 4-team league, 3 games each — records 1: 3–0 (300 PF), 3: 2–1 (350), 2: 1–2 (255), 4: 0–3
  // (245): reading (a) seeds 1, 3, 2, 4; points for alone seeds 3, 1, 2, 4
  const ids = [1, 2, 3, 4];
  const games: G[] = [
    [1, 2, 100, 90],
    [3, 4, 120, 80],
    [1, 3, 110, 100],
    [2, 4, 95, 85],
    [1, 4, 90, 80],
    [2, 3, 70, 130],
  ];
  const repro = (gs: readonly G[], order: readonly number[]): SeasonReproduction =>
    reproduceSeason(
      seasonOf({ teams: seeded(standingsOf(ids, gs), order), games: gs, team_count: 2 }),
    );
  const seedsOf = (order: readonly number[]) =>
    new Map(ids.map((id) => [id, order.indexOf(id) + 1]));

  it("suggests the one reading that reproduces the seeds, and unknown when neither or both do", () => {
    const a = repro(games, [1, 3, 2, 4]);
    const evA = seedingEvidenceFromReproduction(a, false, seedsOf([1, 3, 2, 4]));
    expect(evA).toMatchObject({
      suggests: "espn_rule",
      seed_order_matches_record: true,
      seed_order_matches_pf: false,
      method: "reproduction",
      findings: [],
    });
    expect(evA.table.map((t) => [t.team_id, t.record_rank, t.pf_rank])).toEqual([
      [1, 1, 2],
      [3, 2, 1],
      [2, 3, 3],
      [4, 4, 4],
    ]);
    const b = repro(games, [3, 1, 2, 4]);
    expect(seedingEvidenceFromReproduction(b, false, seedsOf([3, 1, 2, 4]))).toMatchObject({
      suggests: "points_only",
      seed_order_matches_record: false,
      seed_order_matches_pf: true,
    });
    // a seeding neither chain produces: unknown, with the reproduction's own findings
    const none = repro(games, [4, 2, 1, 3]);
    const evN = seedingEvidenceFromReproduction(none, null, seedsOf([4, 2, 1, 3]));
    expect(evN.suggests).toBe("unknown");
    expect(evN.seed_order_matches_record).toBe(false);
    expect(evN.seed_order_matches_pf).toBe(false);
    expect(evN.findings).toEqual(findingCodes(none));
    expect(evN.findings).toContain("seed_mismatch");
    expect(evN.playoff_edited).toBeNull();
    // record order = points order (3 now edges 2 on points): both readings reproduce — unknown
    const same: G[] = [
      [1, 2, 100, 90],
      [3, 4, 95, 80],
      [1, 3, 110, 100],
      [2, 4, 95, 85],
      [1, 4, 120, 80],
      [3, 2, 101, 99],
    ];
    const both = repro(same, [1, 3, 2, 4]);
    expect(both.reproduced_by).toBe("both");
    expect(seedingEvidenceFromReproduction(both, false, seedsOf([1, 3, 2, 4])).suggests).toBe(
      "unknown",
    );
    expect(readingMatches(both.espn_rule)).toBe(true);
  });

  it("the evidence is frozen and carries only ids, numbers and fixed codes", () => {
    const s = repro(games, [1, 3, 2, 4]);
    const ev = seedingEvidenceFromReproduction(s, true, seedsOf([1, 3, 2, 4]));
    expect(Object.isFrozen(ev)).toBe(true);
    expect(Object.isFrozen(ev.table)).toBe(true);
    for (const row of ev.table)
      for (const v of Object.values(row)) expect(v === null || typeof v === "number").toBe(true);
    for (const f of ev.findings) expect(f).toMatch(/^[a-z_]{1,40}$/);
  });
});
