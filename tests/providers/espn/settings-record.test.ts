// settings-record.test.ts — Stage C remediation, round 2 (finding league-settings-changed-never-raised;
// plan 08 §9: the settings are re-normalised and persisted by settings_hash, and "if the hash changed
// — … espn_get_status.checks[] row settings_changed" so `onboard` can explain the commissioner's edit;
// plan 03 §5 #22; plan 10 T-08): the provider records every settings answer it reads in
// store.sqlite's league_settings, and the store raises `settings_changed` when the answer changed
// the league-season's newest settings. Before, nothing called the repository: no row was ever
// written, so a commissioner's scoring, waiver or seeding change went unnoticed and doctor #22 stayed
// "ok". Over the derived fx-10h league (the reference format) and its `faab` variant, with the real
// scoring translator and a real store: the first answer is the baseline; a cache hit writes nothing;
// a switch to FAAB and a scoring edit each open the check; a status-only answer (the seeding-edit
// flag) opens none; a failed record never fails the read and the next answer records it. No network,
// no cookie.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LeagueSettingsRow } from "../../../src/domain/league/types.js";
import { fixedClock, type FixedClock } from "../../../src/domain/clock.js";
import { translateScoringInput } from "../../../src/domain/scoring/index.js";
import {
  createDerivedLeagueFetch,
  createEspnProvider,
  type FetchLike,
} from "../../../src/providers/espn/index.js";
import { createStoreFactory } from "../../../src/store/index.js";
import { StoreBusyError, type Store } from "../../../src/store/types.js";
import { tempDir } from "../../lint/helpers.js";
import { FIXTURES } from "./helpers.js";

const FX = path.join(FIXTURES, "fx-10h");
/** fx-10h's frozen league clock (its manifest `clock`). */
const AT = "2026-10-07T01:00:00.000Z";
const DAY = 86_400_000;
const ref = { platform: "espn", league_id: "0", season: 2026 } as const;
const config = {
  leagueId: "0",
  season: 2026,
  teamId: 2,
  espnReadHost: "lm-api-reads.fantasy.espn.com",
  fixtureRecord: false,
  fixtureDir: null,
};

const warnings: { event: string; fields: unknown }[] = [];
let tmp: ReturnType<typeof tempDir>;
let store: Store;
let clock: FixedClock;
beforeEach(() => {
  warnings.length = 0;
  tmp = tempDir("eff-settings-record-");
  clock = fixedClock(AT);
  // a short busy budget: a write a read should not make fails fast instead of waiting 5 s
  store = createStoreFactory({ busyTimeoutMs: 50 }).open({
    path: path.join(tmp.dir, "store.sqlite"),
    datasetDir: path.join(tmp.dir, "datasets"),
    backupDir: path.join(tmp.dir, "backups"),
    clock,
    migrate: true,
  });
});
afterEach(() => {
  store.close();
  tmp.cleanup();
});

/** The derived league's answers, an mSettings answer edited by `edit` (a commissioner's change). */
function leagueFetch(dir: string, edit?: (settings: Record<string, unknown>) => void): FetchLike {
  const inner = createDerivedLeagueFetch({ dir });
  return async (url, init) => {
    const r = await inner(url, init);
    if (edit === undefined || !new URL(url).searchParams.getAll("view").includes("mSettings"))
      return r;
    const b = (await r.json()) as { settings: Record<string, unknown> };
    edit(b.settings);
    return new Response(JSON.stringify(b), { status: r.status, headers: r.headers });
  };
}

function provider(
  fetch: FetchLike,
  recorder: Pick<Store["repos"]["leagueSettings"], "put"> = store.repos.leagueSettings,
) {
  // a test's own `put` stands in for the store's; the open checks the provider reads (the golden's
  // league-wide verdict — settings-invalidation.test.ts) are the real store's
  const leagueSettings: Pick<Store["repos"]["leagueSettings"], "put" | "openChecks"> = {
    put: (row) => {
      recorder.put(row);
    },
    openChecks: () => store.repos.leagueSettings.openChecks(),
  };
  return createEspnProvider({
    config,
    repos: { ...store.repos, leagueSettings },
    credentials: null,
    clock,
    scoring: translateScoringInput,
    fetch,
    log: { debug: () => undefined, warn: (event, fields) => warnings.push({ event, fields }) },
  });
}

const changed = () =>
  store.repos.leagueSettings.openChecks().filter((c) => c.id === "settings_changed");

describe("every settings answer is recorded; a changed one opens settings_changed", () => {
  it("the first answer is the league-season's baseline, under the translator's hash; a cache hit writes nothing and takes no lock", async () => {
    const puts: LeagueSettingsRow[] = [];
    const p = provider(leagueFetch(FX), {
      put: (row) => {
        puts.push(row);
        store.repos.leagueSettings.put(row);
      },
    });
    const scoring = await p.getScoringSettings(ref);
    expect(puts).toHaveLength(1);
    const row = store.repos.leagueSettings.latest("0", 2026);
    expect(row?.settings_hash).toBe(scoring.value.settings_hash);
    expect(row?.scoring).toEqual(scoring.value);
    expect(row?.fetched_at).toBe(scoring.stamp.fetched_at);
    // another process holds the writer lock: every cache hit still answers at once, unlogged — the
    // first hit's parse of the cached body is re-recorded once, the store's no-lock skip absorbs it
    const holder = new DatabaseSync(path.join(tmp.dir, "store.sqlite"));
    try {
      holder.exec("BEGIN IMMEDIATE");
      const rules = await p.getLeagueRules(ref);
      const slots = await p.getRosterSlots(ref);
      await p.getLeague(ref);
      await p.getScoringSettings(ref);
      expect(rules.stamp.cache).toBe("hit");
      expect(row?.rules).toEqual(rules.value);
      expect(row?.slots).toEqual(slots.value);
      holder.exec("ROLLBACK");
    } finally {
      holder.close();
    }
    expect(warnings).toEqual([]);
    expect(puts.length).toBeLessThanOrEqual(2);
    expect(new Set(puts.map((r) => `${r.settings_hash} ${r.fetched_at}`)).size).toBe(1);
    expect(store.repos.leagueSettings.latest("0", 2026)).toEqual(row);
    expect(changed()).toEqual([]);
  });

  it("a switch to FAAB (the fx-10h faab variant) opens the check: rules changed, scoring the same", async () => {
    const base = await provider(leagueFetch(FX)).getLeagueRules(ref);
    clock.advance(DAY + 3_600_000); // past the settings TTL: the next read asks ESPN again
    const faab = await provider(leagueFetch(path.join(FX, "faab"))).getLeagueRules(ref);
    expect(base.value.waiver_system).toBe("priority_move_to_last");
    expect(faab.value.waiver_system).toBe("faab");
    const [c, ...rest] = changed();
    expect(rest).toEqual([]);
    expect(c?.detail).toEqual({
      season: 2026,
      scoring_changed: false,
      slots_changed: false,
      rules_changed: true,
      previous_settings_hash: store.repos.leagueSettings.latest("0", 2026)?.settings_hash,
      previous_fetched_at: base.stamp.fetched_at,
    });
    expect(c?.raised_at).toBe(faab.stamp.fetched_at);
  });

  it("a scoring edit (receptions 0.5 → 1) opens the check under the new hash; the old hash stays recoverable", async () => {
    const before = await provider(leagueFetch(FX)).getScoringSettings(ref);
    clock.advance(DAY + 3_600_000);
    const ppr = (s: Record<string, unknown>) => {
      const items = (s.scoringSettings as { scoringItems: { statId: number; points: number }[] })
        .scoringItems;
      for (const i of items) if (i.statId === 53) i.points = 1;
    };
    const after = await provider(leagueFetch(FX, ppr)).getScoringSettings(ref);
    expect(after.value.settings_hash).not.toBe(before.value.settings_hash);
    expect(changed().map((c) => [c.settings_hash, c.detail.scoring_changed])).toEqual([
      [after.value.settings_hash, true],
    ]);
    expect(changed()[0]?.detail.previous_settings_hash).toBe(before.value.settings_hash);
    expect(store.repos.leagueSettings.byHash(before.value.settings_hash)?.scoring).toEqual(
      before.value,
    );
  });

  it("a status-only change (last season's seeding edit flag) opens nothing", async () => {
    await provider(leagueFetch(FX)).getLeague(ref);
    clock.advance(DAY + 3_600_000);
    await provider(leagueFetch(path.join(FX, "points-only-seeding"))).getLeague(ref);
    expect(changed()).toEqual([]);
  });

  it("a failed record never fails the read: logged by its class, and the next answer records it", async () => {
    let busy = true;
    const p = provider(leagueFetch(FX), {
      put: (row) => {
        if (busy) throw new StoreBusyError("league_settings");
        store.repos.leagueSettings.put(row);
      },
    });
    const league = await p.getLeague(ref);
    expect(league.value.size).toBe(10);
    expect(store.repos.leagueSettings.latest("0", 2026)).toBeNull();
    expect(warnings).toEqual([
      { event: "espn.settings.record_failed", fields: { error: "StoreBusyError" } },
    ]);
    busy = false;
    clock.advance(DAY + 3_600_000);
    await p.getLeague(ref);
    expect(store.repos.leagueSettings.latest("0", 2026)?.fetched_at).toBe(clock.nowIso());
  });
});
