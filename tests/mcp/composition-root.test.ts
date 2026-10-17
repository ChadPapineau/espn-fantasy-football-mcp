// composition-root.test.ts — what only the composition roots can wire (Stage C round 1, the
// cross-cutting remediation; plan 01 §1.1: the MCP surface never touches the store, so src/services
// and src/cli/espn-stack hand src/mcp and the provider their ports). Each case runs the REAL root —
// buildServices (the world helper's own wiring) or buildEspnStack — never a hand-built provider or
// injected texts, so a root that drops the line fails here:
// - normalize-bye-week-never-populated: every PlatformPlayer carries its pro team's bye week from the
//   stored pro schedule (the provider's `proSchedule` port; without it every bye_week was null and
//   every weekly-value consumer credited a player in his own bye week);
// - prompts-skill-references-unreachable: the prompts carry the references their Skill bodies link
//   (loadTexts fills ServerTexts.references; without it all 13 prompts named 1–5 of them missing);
// - status-drift-diff-unwrapped-strings: an `additive` drift row names its paths in espn_get_status
//   and espn-ff://status/drift (driftView passes the row's additive list; without it the diff was []).
// No network, no cookie, no keychain: recorded fixtures over the real store in temp directories.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEspnStack } from "../../src/cli/espn-stack.js";
import { backupDir, datasetDir, storePath } from "../../src/config/paths.js";
import { byeWeekOf } from "../../src/domain/league/schedule.js";
import type { PlatformPlayer, ProSchedule } from "../../src/domain/league/types.js";
import { ALL_PROMPTS } from "../../src/mcp/prompts/index.js";
import { PROMPT_SKILLS, loadTexts } from "../../src/services/index.js";
import { storeFactory } from "../../src/store/index.js";
import type { DriftStateRow, Store } from "../../src/store/types.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { makeIo, sandbox, type Sandbox } from "../cli/helpers.js";
import {
  ESPN_FIXTURES,
  ROOT,
  SEASON,
  call,
  connect,
  makeWorld,
  publishEspnDatasets,
  runningClock,
  T0,
  type World,
} from "./helpers/world.js";

const FREE_AGENT_TEAM = 0;
/** The required arguments of the prompts that have any (tests/mcp/prompt-references.test.ts). */
const REQUIRED_ARGS: Readonly<Record<string, Record<string, string>>> = {
  "espn.stream": { position: "K" },
  "espn.apply": { what: "start player 4361050" },
  "espn.trade": { offer: "my WR for their RB" },
  "espn.injury": { player: "my RB1" },
  "espn.check": { claim: "the backup will get more of the work" },
};

function scheduleOf(store: Store): ProSchedule {
  return {
    season: SEASON,
    teams: store.datasets.proSchedule.teams(SEASON).rows,
    games: store.datasets.proSchedule.games(SEASON, null).rows,
  };
}

/** Every player's bye equals the stored schedule's for his pro team (null only for a free agent). */
function expectByes(players: readonly PlatformPlayer[], s: ProSchedule): void {
  expect(players.length).toBeGreaterThan(0);
  expect(s.teams.length).toBeGreaterThan(30);
  for (const p of players) {
    expect(p.bye_week, `${String(p.ref.id)} (team ${String(p.pro_team_id)})`).toBe(
      byeWeekOf(s, p.pro_team_id),
    );
    if (p.pro_team_id !== FREE_AGENT_TEAM) expect(p.bye_week).not.toBeNull();
  }
}

describe("the serve root (buildServices)", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld();
  }, 120_000);
  afterAll(() => {
    world.cleanup();
  });

  it("every PlatformPlayer carries its pro team's bye week from the stored pro schedule", async () => {
    const s = scheduleOf(world.store);
    const ref = world.services.league;
    const rosters = await world.wiring.provider.getRosters(ref, 3);
    expectByes(
      rosters.value.flatMap((r) => r.entries.map((e) => e.player)),
      s,
    );
    const page = await world.wiring.provider.listPlayers(
      ref,
      { status: "AVAILABLE", position: null, sort: "percOwned", week: 4, injured: null },
      { limit: 25, offset: 0 },
    );
    expectByes(page.value.items, s);
    // the tools that pass the provider's field through (espn_get_roster fills it on its own)
    const { client, close } = await connect(world);
    try {
      const r = await call(client, "espn_list_players", {
        status: "FREEAGENT",
        sort: "percOwned",
        week: 4,
        limit: 25,
      });
      expect(r.isError).toBe(false);
      const players = (r.body.data as { players: { pro_team: unknown; bye_week: unknown }[] })
        .players;
      expect(players.length).toBeGreaterThan(0);
      expect(players.filter((p) => p.bye_week !== null).length).toBeGreaterThan(0);
      expect(players.every((p) => p.bye_week === null || Number.isInteger(p.bye_week))).toBe(true);
    } finally {
      await close();
    }
  });

  it("the prompts carry every reference their Skill bodies link (no 'not installed' block)", async () => {
    const texts = loadTexts(ROOT);
    for (const skill of PROMPT_SKILLS) {
      const refs = texts.references?.[skill];
      expect(refs, skill).toBeDefined();
      expect(Object.keys(refs ?? {}).length, skill).toBeGreaterThan(0);
      for (const [file, text] of Object.entries(refs ?? {}))
        expect(text, `${skill}/references/${file}`).not.toBeNull();
    }
    const { client, close } = await connect(world, { options: { toolset: "full" } });
    try {
      for (const p of ALL_PROMPTS) {
        const r = await client.getPrompt({ name: p.name, arguments: REQUIRED_ARGS[p.name] ?? {} });
        const text = r.messages
          .map((m) => (m.content.type === "text" ? m.content.text : ""))
          .join("\n");
        expect(text, p.name).not.toContain("(not installed with this server");
      }
      // orient's Step 0 routing reaches a prompt-only client; onboard's exact log entry too
      const weekly = await client.getPrompt({ name: "espn.weekly", arguments: {} });
      const wt = weekly.messages
        .map((m) => (m.content.type === "text" ? m.content.text : ""))
        .join("\n");
      expect(wt).toContain("### references/orient.md");
      for (const key of ["allow_stale", "host_moved", "ir_invalid"]) expect(wt).toContain(key);
      const onboard = await client.getPrompt({ name: "espn.onboard", arguments: {} });
      const ot = onboard.messages
        .map((m) => (m.content.type === "text" ? m.content.text : ""))
        .join("\n");
      expect(ot).toContain("### references/onboard-log-entry.md");
      expect(ot).toContain("golden_mismatch_share");
    } finally {
      await close();
    }
  });

  it("an additive drift row names its paths in espn_get_status and espn-ff://status/drift", async () => {
    const at = world.clock.nowIso();
    const row: DriftStateRow = {
      status: "additive",
      since: null,
      last_probe_at: at,
      manifest_hash: null,
      manifest_version: null,
      host: "lm-api-reads.fantasy.espn.com",
      host_moved_at: null,
      diff_json: "[]",
      additive_json: JSON.stringify([
        { view: "mSettings", removed: [], added: ["$.settings.newKey"], enums: [] },
      ]),
      updated_at: at,
    };
    const before = world.store.repos.driftState.get();
    world.store.repos.driftState.put(row);
    const { client, close } = await connect(world);
    try {
      const r = await call(client, "espn_get_status", {});
      expect(r.isError).toBe(false);
      const drift = (r.body.data as { drift: { status: string; diff: unknown[] } }).drift;
      expect(drift.status).toBe("additive");
      expect(JSON.stringify(drift.diff)).toContain("$.settings.newKey");
      const res = await client.readResource({ uri: "espn-ff://status/drift" });
      const first = res.contents[0];
      const body = first !== undefined && "text" in first ? first.text : "";
      expect(body).toContain("$.settings.newKey");
    } finally {
      await close();
      if (before !== null) world.store.repos.driftState.put(before);
    }
  });
});

describe("the CLI root (buildEspnStack)", () => {
  let sb: Sandbox | null = null;
  afterAll(() => {
    sb?.cleanup();
  });

  it("the jobs' provider carries the same bye weeks from the stored pro schedule", async () => {
    sb = sandbox({ create: true });
    const clock = runningClock(T0);
    const io = makeIo(sb, {
      clock,
      env: {
        ESPN_LEAGUE_ID: "0",
        ESPN_SEASON: String(SEASON),
        EFF_FIXTURE_DIR: ESPN_FIXTURES,
        EFF_CREDENTIAL_STORE: "file",
      },
    });
    const { config, log } = await loadRuntime(io);
    const t = {
      storePath: storePath(config.cacheDir),
      datasetDir: datasetDir(config.cacheDir),
      clock,
    };
    const store = storeFactory.open({
      path: t.storePath,
      datasetDir: t.datasetDir,
      backupDir: backupDir(config.cacheDir),
      clock,
      migrate: true,
    });
    try {
      await publishEspnDatasets(t);
      store.reopenChangedDatasets();
      const stack = buildEspnStack(io, config, store, log, {
        origin: "server",
        observer: "server",
      });
      try {
        const rosters = await stack.provider.getRosters(stack.ref, 3);
        expectByes(
          rosters.value.flatMap((r) => r.entries.map((e) => e.player)),
          scheduleOf(store),
        );
      } finally {
        stack.close();
      }
    } finally {
      store.close();
    }
  }, 60_000);
});
