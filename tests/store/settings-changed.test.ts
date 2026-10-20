// settings-changed.test.ts — a league settings snapshot that changes the league-season's newest
// settings raises `settings_changed` in the same transaction (plan 08 §9: "if the hash changed — …
// espn_get_status.checks[] row settings_changed", so `onboard` can explain the commissioner's edit;
// plan 03 §5 #22 reads it; plan 06 §1.4 / plan 10 T-08). Stage C, league-settings-changed-never-raised:
// nothing compared a new snapshot with the last one, so the check could never open, doctor #22 was a
// permanent "ok" and a commissioner's scoring or seeding change went unnoticed. A change is a
// different scoring (its hash among it), roster slots or league rules — the fx-10h `faab` variant
// changes the acquisition settings and keeps the scoring hash, and must open the check too — and
// never a status field (the waiver clock that moves every week, this build's `unverified` lists, the
// engine's rounding flag). The first snapshot of a league-season is the baseline; a late (older)
// snapshot changes nothing; two processes recording one change raise it once.
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LeagueSettingsRow } from "../../src/domain/league/types.js";
import { canonicalJson } from "../../src/store/repos/common.js";
import { StoreBusyError, type Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let s: Store;
beforeEach(() => {
  t = tempCache();
  s = openStore(t);
});
afterEach(() => {
  s.close();
  t.cleanup();
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

/** The reference format's settings, normalised (anonymous: league 0; only the shapes matter). */
const scoring = (hash: string, over: Record<string, unknown> = {}) => ({
  platform: "espn",
  rules: [
    {
      canonical: "rec",
      platform_id: "53",
      abbr: "REC",
      points: 0.5,
      overrides: {},
      is_reverse: false,
      applies_to: ["O"],
      disputed: false,
    },
    {
      canonical: "pass_td",
      platform_id: "4",
      abbr: "PTD",
      points: 5,
      overrides: {},
      is_reverse: false,
      applies_to: ["O"],
      disputed: false,
    },
  ],
  families: [],
  matchup: { tie_rule: "NONE", playoff_tie_rule: "NONE", home_bonus: 0, playoff_home_bonus: 0 },
  rounding: { mode: "exact", verified: false },
  settings_hash: hash,
  ...over,
});

const slots = (over: Record<string, unknown> = {}) => ({
  slots: [
    { slot_id: 0, name: "QB", class: "starter", count: 1, eligible_positions: ["QB"] },
    { slot_id: 2, name: "RB", class: "starter", count: 2, eligible_positions: ["RB"] },
    { slot_id: 20, name: "BE", class: "bench", count: 5, eligible_positions: [] },
    { slot_id: 21, name: "IR", class: "ir", count: 2, eligible_positions: [] },
  ],
  starters: 9,
  bench: 5,
  ir: 2,
  total: 16,
  lineup_lock_type: "PROGRESSIVE",
  undroppable_list: true,
  position_limits: { QB: null },
  move_limit: null,
  ...over,
});

const waiver = (over: Record<string, unknown> = {}) => ({
  type: "WAIVERS_TRADITIONAL",
  uses_budget: false,
  budget: null,
  min_bid: null,
  waiver_hours: 24,
  process_days: [],
  process_hour: null,
  order_reset: false,
  next_execution: "2026-10-07T07:00:00.000Z",
  last_execution: "2026-09-30T07:00:00.000Z",
  acquisition_limit: null,
  matchup_acquisition_limit: null,
  matchup_limit_per_period: null,
  unverified: ["waiver.type", "waiver.order_reset"],
  ...over,
});

const rules = (over: Record<string, unknown> = {}, waiverOver: Record<string, unknown> = {}) => ({
  waiver: waiver(waiverOver),
  trade: {
    deadline: "2026-12-02T17:00:00.000Z",
    revision_hours: 24,
    veto_votes_required: 4,
    max: null,
  },
  playoffs: {
    team_count: 6,
    seeding_rule: "TOTAL_POINTS_SCORED",
    seeding_rule_by: 0,
    reseed: false,
    matchup_period_length: 1,
    variable_length: false,
    consolation: true,
    regular_season_matchups: 14,
    matchup_periods: { "1": [1], "15": [15] },
    playoff_weeks: [15, 16, 17],
    bye_seeds: 2,
  },
  ties: { matchup_tie_rule: "NONE", playoff_tie_rule: "NONE" },
  fees: null,
  waiver_system: "priority_move_to_last",
  predicates: { has_faab: false, is_move_to_last: true },
  unverified_fields: ["waiver.type", "waiver.order_reset"],
  ...over,
});

const snap = (
  hash: string,
  fetched: string,
  over: { scoring?: unknown; slots?: unknown; rules?: unknown; season?: number } = {},
): LeagueSettingsRow =>
  ({
    league_id: "0",
    season: over.season ?? 2026,
    settings_hash: hash,
    scoring: over.scoring ?? scoring(hash),
    slots: over.slots ?? slots(),
    rules: over.rules ?? rules(),
    fetched_at: fetched,
  }) as never;

const changed = () =>
  s.repos.leagueSettings.openChecks().filter((c) => c.id === "settings_changed");

describe("settings_changed is raised by the snapshot that changes the settings", () => {
  it("the league-season's first snapshot is the baseline; a repeat of it raises nothing", () => {
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-01T00:00:00.000Z"));
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-02T00:00:00.000Z"));
    expect(changed()).toEqual([]);
    expect(s.repos.leagueSettings.latest("0", 2026)?.fetched_at).toBe("2026-10-02T00:00:00.000Z");
  });

  it("a new scoring hash opens one warn check against the new hash, naming the one it replaced", () => {
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-01T00:00:00.000Z"));
    s.repos.leagueSettings.put(snap(HASH_B, "2026-10-03T00:00:00.000Z"));
    expect(changed()).toEqual([
      {
        id: "settings_changed",
        status: "warn",
        detail: {
          season: 2026,
          scoring_changed: true,
          slots_changed: false,
          rules_changed: false,
          previous_settings_hash: HASH_A,
          previous_fetched_at: "2026-10-01T00:00:00.000Z",
        },
        raised_at: "2026-10-03T00:00:00.000Z",
        settings_hash: HASH_B,
        acknowledged: false,
        acknowledged_at: null,
        acknowledged_by: null,
      },
    ]);
    // the snapshot itself is stored: the log's referent, recoverable by its hash
    expect(s.repos.leagueSettings.byHash(HASH_B)?.scoring).toEqual(scoring(HASH_B));
    expect(s.repos.leagueSettings.byHash(HASH_A)?.scoring).toEqual(scoring(HASH_A));
    expect(s.repos.leagueSettings.latest("0", 2026)?.settings_hash).toBe(HASH_B);
  });

  it("a switch to FAAB keeps the scoring hash and still opens the check (the fx-10h faab variant)", () => {
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-01T00:00:00.000Z"));
    const faab = rules(
      { waiver_system: "faab", predicates: { has_faab: true, is_move_to_last: false } },
      { uses_budget: true, budget: 100, min_bid: 1 },
    );
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-02T00:00:00.000Z", { rules: faab }));
    expect(changed().map((c) => [c.raised_at, c.settings_hash, c.detail])).toEqual([
      [
        "2026-10-02T00:00:00.000Z",
        HASH_A,
        {
          season: 2026,
          scoring_changed: false,
          slots_changed: false,
          rules_changed: true,
          previous_settings_hash: HASH_A,
          previous_fetched_at: "2026-10-01T00:00:00.000Z",
        },
      ],
    ]);
    // one row per hash: it now holds the newer fetch's rules (never an older fetch's)
    expect(s.repos.leagueSettings.byHash(HASH_A)?.rules).toEqual(faab);
    s.repos.leagueSettings.put(snap(HASH_A, "2026-09-01T00:00:00.000Z")); // a late answer
    expect(s.repos.leagueSettings.byHash(HASH_A)?.rules).toEqual(faab);
    expect(changed()).toHaveLength(1);
  });

  it.each([
    [
      "the playoff seeding rule",
      { rules: rules({ playoffs: { ...rules().playoffs, seeding_rule: "H2H_RECORD" } }) },
      "rules_changed",
    ],
    [
      "the trade deadline",
      { rules: rules({ trade: { ...rules().trade, deadline: "2026-11-25T17:00:00.000Z" } }) },
      "rules_changed",
    ],
    ["a roster slot count", { slots: slots({ bench: 6, total: 17 }) }, "slots_changed"],
    [
      "the matchup items (outside the hash)",
      {
        scoring: scoring(HASH_A, {
          matchup: {
            tie_rule: "NONE",
            playoff_tie_rule: "NONE",
            home_bonus: 2,
            playoff_home_bonus: 0,
          },
        }),
      },
      "scoring_changed",
    ],
  ] as const)("a change of %s opens the check", (_what, over, flag) => {
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-01T00:00:00.000Z"));
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-02T00:00:00.000Z", over));
    const [c, ...rest] = changed();
    expect(rest).toEqual([]);
    expect(c?.detail[flag]).toBe(true);
    for (const f of ["scoring_changed", "slots_changed", "rules_changed"] as const)
      if (f !== flag) expect(c?.detail[f]).toBe(false);
  });

  it("status fields never count: the weekly waiver clock, this build's unverified lists, the rounding flag, key order", () => {
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-01T00:00:00.000Z"));
    // a week later only ESPN's waiver clock moved
    s.repos.leagueSettings.put(
      snap(HASH_A, "2026-10-08T00:00:00.000Z", {
        rules: rules(
          { unverified_fields: ["waiver.type"] },
          {
            next_execution: "2026-10-14T07:00:00.000Z",
            last_execution: "2026-10-07T07:00:00.000Z",
            unverified: [],
          },
        ),
        scoring: scoring(HASH_A, { rounding: { mode: "exact", verified: true } }),
      }),
    );
    expect(changed()).toEqual([]);
    // …and stored as fetched: the row holds the newest fetch, clock included
    const clock = (): unknown =>
      (
        s.repos.leagueSettings.latest("0", 2026)?.rules as unknown as {
          waiver: { next_execution: string };
        }
      ).waiver.next_execution;
    expect(clock()).toBe("2026-10-14T07:00:00.000Z");
    // the same settings written with their keys in another order
    s.repos.leagueSettings.put(
      snap(HASH_A, "2026-10-09T00:00:00.000Z", {
        rules: Object.fromEntries(Object.entries(rules()).reverse()),
        slots: Object.fromEntries(Object.entries(slots()).reverse()),
      }),
    );
    expect(changed()).toEqual([]);
    expect(clock()).toBe("2026-10-07T07:00:00.000Z");
  });

  it("a late (older) snapshot of other settings raises nothing and leaves the newest as it was", () => {
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-01T00:00:00.000Z"));
    s.repos.leagueSettings.put(snap(HASH_B, "2026-10-05T00:00:00.000Z"));
    expect(changed()).toHaveLength(1);
    s.repos.leagueSettings.put(snap(HASH_C, "2026-10-03T00:00:00.000Z"));
    expect(changed()).toHaveLength(1);
    expect(s.repos.leagueSettings.latest("0", 2026)?.settings_hash).toBe(HASH_B);
    expect(s.repos.leagueSettings.byHash(HASH_C)?.fetched_at).toBe("2026-10-03T00:00:00.000Z");
  });

  it("a revert is a change too; `eff setup --seeding` and `eff doctor --ack` close what they saw", () => {
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-01T00:00:00.000Z"));
    s.repos.leagueSettings.put(snap(HASH_B, "2026-10-03T00:00:00.000Z"));
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-05T00:00:00.000Z"));
    expect(
      changed().map((c) => [c.raised_at, c.settings_hash, c.detail.previous_settings_hash]),
    ).toEqual([
      ["2026-10-03T00:00:00.000Z", HASH_B, HASH_A],
      ["2026-10-05T00:00:00.000Z", HASH_A, HASH_B],
    ]);
    // setup acknowledges up to the instant it recorded the reading; a later change stays open
    expect(
      s.repos.leagueSettings.acknowledgeChecks(
        "settings_changed",
        "2026-10-04T00:00:00.000Z",
        "setup",
        "2026-10-04T00:00:00.000Z",
      ),
    ).toBe(1);
    expect(changed().map((c) => c.raised_at)).toEqual(["2026-10-05T00:00:00.000Z"]);
    expect(
      s.repos.leagueSettings.acknowledgeChecks(
        "settings_changed",
        "2026-10-06T00:00:00.000Z",
        "doctor",
        "2026-10-06T00:00:00.000Z",
      ),
    ).toBe(1);
    expect(changed()).toEqual([]);
    // a repeat of the newest settings after the acknowledgement re-opens nothing
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-07T00:00:00.000Z"));
    expect(changed()).toEqual([]);
  });

  it("each league-season has its own baseline: a new season's first snapshot raises nothing", () => {
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-01T00:00:00.000Z"));
    s.repos.leagueSettings.put(snap(HASH_B, "2026-10-02T00:00:00.000Z", { season: 2025 }));
    s.repos.leagueSettings.put(snap(HASH_C, "2026-10-03T00:00:00.000Z", { season: 2027 }));
    expect(changed()).toEqual([]);
    s.repos.leagueSettings.put(snap(HASH_C, "2026-10-04T00:00:00.000Z", { season: 2025 }));
    expect(changed().map((c) => [c.detail.season, c.settings_hash])).toEqual([[2025, HASH_C]]);
  });

  it("two processes recording one change raise it once (the second reads the first's row as the newest)", () => {
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-01T00:00:00.000Z"));
    const other = openStore(t);
    try {
      other.repos.leagueSettings.put(snap(HASH_B, "2026-10-03T00:00:00.000Z"));
      s.repos.leagueSettings.put(snap(HASH_B, "2026-10-03T00:00:10.000Z"));
      other.repos.leagueSettings.put(snap(HASH_B, "2026-10-03T00:00:20.000Z"));
    } finally {
      other.close();
    }
    expect(changed().map((c) => c.raised_at)).toEqual(["2026-10-03T00:00:00.000Z"]);
  });

  it("the snapshot and its check are one write: a busy store writes neither (StoreBusyError)", () => {
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-01T00:00:00.000Z"));
    const busy = openStore(t, {}, { busyTimeoutMs: 50 });
    const holder = new DatabaseSync(t.storePath);
    try {
      holder.exec("BEGIN IMMEDIATE");
      expect(() => {
        busy.repos.leagueSettings.put(snap(HASH_B, "2026-10-03T00:00:00.000Z"));
      }).toThrow(StoreBusyError);
      holder.exec("ROLLBACK");
    } finally {
      holder.close();
      busy.close();
    }
    expect(s.repos.leagueSettings.byHash(HASH_B)).toBeNull();
    expect(changed()).toEqual([]);
  });

  it("property: in arrival order, one check per change of the newest settings — never for status noise", () => {
    const variant = fc.record({
      hash: fc.constantFrom(HASH_A, HASH_B),
      seeding: fc.constantFrom("TOTAL_POINTS_SCORED", "H2H_RECORD"),
      faab: fc.boolean(),
      bench: fc.constantFrom(5, 6),
      // status noise: never a change
      clockWeek: fc.integer({ min: 0, max: 20 }),
      verified: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(variant, { minLength: 1, maxLength: 12 }), (vs) => {
        const db = new DatabaseSync(t.storePath);
        db.exec("DELETE FROM checks; DELETE FROM league_settings");
        db.close();
        let expected = 0;
        vs.forEach((v, i) => {
          const prev = vs[i - 1];
          if (
            prev !== undefined &&
            (prev.hash !== v.hash ||
              prev.seeding !== v.seeding ||
              prev.faab !== v.faab ||
              prev.bench !== v.bench)
          )
            expected += 1;
          const next = new Date(
            Date.parse("2026-10-07T07:00:00.000Z") + v.clockWeek * 7 * 86_400_000,
          );
          s.repos.leagueSettings.put(
            snap(
              v.hash,
              new Date(Date.parse("2026-10-01T00:00:00.000Z") + i * 3_600_000).toISOString(),
              {
                scoring: scoring(v.hash, { rounding: { mode: "exact", verified: v.verified } }),
                slots: slots({ bench: v.bench }),
                rules: rules(
                  { playoffs: { ...rules().playoffs, seeding_rule: v.seeding } },
                  { uses_budget: v.faab, next_execution: next.toISOString() },
                ),
              },
            ),
          );
        });
        return changed().length === expected;
      }),
      { numRuns: 40 },
    );
  });
});

describe("what a change is judged on", () => {
  it("a stored row this repository did not write (corrupt JSON, a malformed hash) never fails the put", () => {
    // a row as a damaged store might hold it: rules that are not JSON, a hash outside the encoding
    const db = new DatabaseSync(t.storePath);
    try {
      db.prepare(
        `INSERT INTO league_settings (league_id, season, settings_hash, scoring_json, slots_json, rules_json, fetched_at, fetched_ms)
         VALUES ('0', 2026, ?, ?, ?, 'not json', '2026-10-01T00:00:00.000Z', ?)`,
      ).run(
        "A".repeat(64),
        JSON.stringify(scoring(HASH_A)),
        JSON.stringify(slots()),
        Date.parse("2026-10-01T00:00:00.000Z"),
      );
    } finally {
      db.close();
    }
    s.repos.leagueSettings.put(snap(HASH_A, "2026-10-02T00:00:00.000Z"));
    expect(changed().map((c) => c.detail)).toEqual([
      {
        season: 2026,
        scoring_changed: true, // another hash
        slots_changed: false,
        rules_changed: true, // text that is not JSON never equals settings
        previous_settings_hash: null, // never echoed outside the encoding
        previous_fetched_at: "2026-10-01T00:00:00.000Z",
      },
    ]);
    expect(s.repos.leagueSettings.latest("0", 2026)?.rules).toEqual(rules());
  });

  it("canonicalJson: key order never counts, array order does, nested at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 }),
    );
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ a: "x" })).toBe('{"a":"x"}');
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson([undefined])).toBe("[null]");
    // a parsed "__proto__" key is data, and stays one
    expect(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":1}'))).toBe(
      '{"__proto__":{"x":1},"a":1}',
    );
  });
});
