// settings-changed-status.test.ts — Stage C remediation, round 2 (finding league-settings-changed-
// never-raised, its repro (b), through the server's composition root: src/services/index.ts hands the
// provider `store.repos`, league_settings among them). A commissioner changes one scoring item between
// two league reads; the forced re-read records the new settings, `espn_get_status.checks[]` carries a
// `settings_changed` warn (plan 07 G1; plan 08 §9 — so `onboard` can explain it) and doctor #22 warns
// (plan 03 §5 #22). Before, league_settings stayed empty: no check, doctor #22 a permanent "ok". The
// unchanged league re-read (the cache, then ESPN again) opens nothing. Recorded fixtures, no network.
import { afterEach, describe, expect, it } from "vitest";
import { checkHealthChecks } from "../../src/cli/doctor.js";
import type { FetchLike } from "../../src/providers/espn/index.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

let w: World | undefined;
afterEach(() => {
  w?.cleanup();
  w = undefined;
});

/** The fixture fetch, with receptions worth a full point from the moment `edit.on` is set. */
function commissioner(edit: { on: boolean }) {
  return (inner: FetchLike): FetchLike =>
    async (url, init) => {
      const r = await inner(url, init);
      if (!edit.on || !new URL(url).searchParams.getAll("view").includes("mSettings")) return r;
      const b = (await r.json()) as {
        settings: { scoringSettings: { scoringItems: { statId: number; points: number }[] } };
      };
      for (const i of b.settings.scoringSettings.scoringItems) if (i.statId === 53) i.points = 1;
      return new Response(JSON.stringify(b), { status: r.status, headers: r.headers });
    };
}

const DAY = 86_400_000;

describe("a commissioner's scoring edit reaches espn_get_status and doctor #22", () => {
  it("the forced re-read records the edit: one settings_changed warn, scoring changed; doctor #22 warns", async () => {
    const edit = { on: false };
    w = await makeWorld({ league: "league-b", wrapFetch: commissioner(edit) });
    const { client, close } = await connect(w);
    try {
      const before = await call(client, "espn_get_league");
      expect(before.isError).toBe(false);
      // the unchanged league read again, from the cache and from ESPN: nothing opens
      expect((await call(client, "espn_get_league")).isError).toBe(false);
      w.clock.advance(DAY + 3_600_000);
      expect((await call(client, "espn_get_league", { force_refresh: true })).isError).toBe(false);
      const quiet = await call(client, "espn_get_status", { include_checks: true });
      const quietChecks = (quiet.body.data as { checks: { id: string }[] }).checks;
      expect(quietChecks.filter((c) => c.id === "settings_changed")).toEqual([]);
      expect(checkHealthChecks(w.store).find((r) => r.id === "settings_changed")?.status).toBe(
        "ok",
      );
      // the commissioner's edit
      edit.on = true;
      w.clock.advance(60_000);
      expect((await call(client, "espn_get_league", { force_refresh: true })).isError).toBe(false);
      const status = await call(client, "espn_get_status", { include_checks: true });
      const checks = (
        status.body.data as {
          checks: { id: string; status: string; detail: Record<string, unknown> }[];
        }
      ).checks.filter((c) => c.id === "settings_changed");
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({
        status: "warn",
        detail: {
          season: 2026,
          scoring_changed: true,
          slots_changed: false,
          rules_changed: false,
        },
      });
      const row = checkHealthChecks(w.store).find((r) => r.id === "settings_changed");
      expect(row?.status).toBe("warn");
    } finally {
      await close();
    }
  });
});
