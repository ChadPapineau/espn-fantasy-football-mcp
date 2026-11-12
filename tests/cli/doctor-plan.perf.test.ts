// doctor-plan.perf.test.ts — row 2's keep rule at the project cap (round-8 verifier F7, ruling D-9
// H4): `duplicateRegistrations` over MAX_CLIENT_PROJECTS recorded projects, each holding several
// local entries of this server beside the plugin, plans in bounded time — it was quadratic in views
// and superlinear in entries (1000 projects × 4 entries: 35.8 s; × 16: 166 s and a 4 MB fix line),
// and past its planning budget it plans nothing (row 2 then says so: registration-identity.test.ts).
// Pure CPU over synthetic entries: no file is read, nothing is executed.
import { describe, expect, it } from "vitest";
import {
  duplicateRegistrations,
  MAX_CLIENT_PROJECTS,
  MAX_PLANNED_REGISTRATIONS,
  type ClientEntry,
  type SessionView,
} from "../../src/cli/client-config.js";

const PLUGIN = { key: "plugin:espn-fantasy-football:espn-fantasy-football", drops: () => false };

const entry = (
  name: string,
  scope: "user" | "local" | "project",
  dir: string | null,
): ClientEntry => ({
  name,
  spec: { command: "/n/bin/node", args: ["/r/dist/cli.js", "serve"] },
  scope,
  file: "/h/.claude.json",
  dir,
  pluginSource: false,
  declined: false,
  declinedBy: [],
  absent: false,
});

/** `n` projects under /p, each with `k` local entries of this server (k0…), the plugin on in all. */
function layout(n: number, k: number): { entries: ClientEntry[]; sessions: SessionView[] } {
  const entries: ClientEntry[] = [];
  const sessions: SessionView[] = [];
  for (let i = 0; i < n; i++) {
    const dir = `/p/${String(i)}`;
    sessions.push({ dir, declined: [], disabled: [] });
    for (let j = 0; j < k; j++) entries.push(entry(`k${String(j)}`, "local", dir));
  }
  return { entries, sessions };
}

/**
 * `u` entries of this server at user scope (or in /p/.mcp.json), read in every one of `n`
 * projects, each of which turns one of them off — every other one the plugin too: every removal is
 * checked against every view.
 */
function wideLayout(
  n: number,
  u: number,
  scope: "user" | "project",
): { entries: ClientEntry[]; sessions: SessionView[] } {
  const entries = Array.from({ length: u }, (_, j) =>
    entry(`u${String(j)}`, scope, scope === "user" ? null : "/p"),
  );
  const sessions: SessionView[] = Array.from({ length: n }, (_, i) => ({
    dir: `/p/${String(i)}`,
    declined: [],
    disabled: i % 2 === 0 ? [PLUGIN.key, `u${String(i % u)}`] : [`u${String((i * 7) % u)}`],
  }));
  return { entries, sessions };
}

describe("row 2's keep rule at the project cap (F7)", () => {
  for (const k of [2, 4, 16])
    it(`${String(MAX_CLIENT_PROJECTS)} projects × ${String(k)} local entries beside the plugin: planned (or refused as too many) within 5 s`, () => {
      const { entries, sessions } = layout(MAX_CLIENT_PROJECTS, k);
      const t0 = performance.now();
      const d = duplicateRegistrations(entries, sessions, PLUGIN, []);
      const ms = performance.now() - t0;
      expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(5000);
      expect(d.withPlugin?.worst.servers).toBe(k + 1);
      // planned up to the budget (every entry but the plugin's removed), nothing past it
      expect(d.planned).toBe(entries.length <= MAX_PLANNED_REGISTRATIONS);
      expect(d.withPlugin?.extra.length).toBe(d.planned ? entries.length : 0);
    }, 120_000);
  for (const [scope, u] of [
    ["user", 64],
    ["user", 256],
    ["project", 64],
    ["project", 256],
  ] as const)
    it(`${String(MAX_CLIENT_PROJECTS)} projects reading ${String(u)} ${scope}-scope entries: planned (or refused as too much work) within 5 s`, () => {
      const { entries, sessions } = wideLayout(MAX_CLIENT_PROJECTS, u, scope);
      for (const p of [PLUGIN, null]) {
        const t0 = performance.now();
        const d = duplicateRegistrations(entries, sessions, p, []);
        const ms = performance.now() - t0;
        expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(5000);
        expect(d.most).toBeGreaterThan(1);
      }
    }, 120_000);
});
