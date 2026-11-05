// plugin-evals-state.test.ts — the Lane 2 eval servers on the BUILT package (plan 09 §5.2; plan 10
// B15; Stage C finding eval-recorded-state-preconditions-missing): `build-plugin-evals.mjs --seed`
// writes each case's recorded state through the real tools — RT-1/RT-3's week-4 lineup call,
// RT-4-E's six lineup calls, RT-INJ's call with its log note, SC-4's drifted roster view already
// read — and every server, started exactly as its .mcp.json says (the launcher, scripts/skills/
// eval-server.mjs), begins from that state on every start: what one run logs never reaches the next.
// Also WK-10's seed (changelog §R10, R10-28, R10-31): on private-expiring the datasets, then the
// settings read under an accepting probe; the run starts on `stored`, and E11 is its first uncached
// read — partial, with the feed's and the league reads' session lines (the round-4d texts). R10-33:
// the seed runs on its own path (EFF_FIXTURE_SEED=1, the one way to disarm the scripted 401), which
// the run's .mcp.json never carries, so a run that probes first is validated and still meets the 401
// at its first uncached read.
// Fixture mode only, under the no-socket preload: no network, no cookie, no ~/.config or ~/.cache.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RT_INJ_NOTE,
  buildPluginEvals,
  envelopeOf,
  rpcOver,
  writeSeeds,
} from "../../scripts/skills/build-plugin-evals.mjs";
import { SESSION_READ_WARNINGS, activityLeagueReadsWarning } from "../../src/mcp/tools/common.js";
import { ROOT, requireDist } from "./helpers.js";

type Json = Record<string, unknown>;
const KEYS = {
  rt1: "base--core--log-week4-lineup",
  six: "base--core--log-six-lineup",
  inj: "inj-teamname-json--core--log-week4-lineup-note",
  sc4: "drift-mRoster--core--drift-red",
  wk10: "private-expiring--full--private-expiring-weekly",
} as const;

let base: string;
let out: string;
beforeAll(async () => {
  requireDist();
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-pe-e2e-")));
  out = path.join(base, "out");
  const r = buildPluginEvals({ root: ROOT, out, state: path.join(base, "state") });
  expect(r.errors).toEqual([]);
  for (const k of Object.values(KEYS)) expect(r.seedNeeded).toContain(k);
  const done = await writeSeeds({
    root: ROOT,
    out,
    node: process.execPath,
    seedNeeded: Object.values(KEYS),
  });
  // one line per seed; WK-10's datasets are seeded first, in a line of their own
  for (const k of Object.values(KEYS))
    expect(
      done.filter((l: string) => l.startsWith(`${k}: `) && l !== `${k}: datasets seeded`),
      k,
    ).toHaveLength(1);
  expect(done).toContain(`${KEYS.wk10}: datasets seeded`);
}, 300_000);
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** One run: the plugin's server started exactly as its .mcp.json says, initialized. */
async function start(key: string) {
  const mcp = JSON.parse(readFileSync(path.join(out, "plugins", key, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const s = Object.values(mcp.mcpServers)[0]!;
  const child = spawn(s.command, s.args, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...s.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (c) => {
      resolve(c);
    });
  });
  const rpc = rpcOver(child, 60_000);
  await rpc.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "plugin-evals-state-test", version: "1" },
  });
  rpc.notify("notifications/initialized", {});
  return {
    call: async (name: string, args: Json = {}) =>
      envelopeOf(await rpc.request("tools/call", { name, arguments: args }, name), name),
    read: async (uri: string) => {
      const r = (await rpc.request("resources/read", { uri })) as { contents: { text: string }[] };
      return JSON.parse(r.contents[0]!.text) as Json;
    },
    close: async () => {
      child.stdin.end();
      return exited;
    },
  };
}
const calls = (env: Json) => (env.data as { calls: { kind: string; log_id: string }[] }).calls;

describe("each seeded case starts from the state its expected output describes", () => {
  it("RT-1 / RT-3: last week (week 4) has the lineup call start-sit logged", async () => {
    const run = await start(KEYS.rt1);
    const retro = await run.call("espn_analyze_retrospective");
    expect((retro.data as Json).week).toBe(4);
    expect(calls(retro).map((c) => c.kind)).toEqual(["lineup"]);
    expect(await run.close()).toBe(0);
  }, 120_000);

  it("RT-4-E: six lineup calls over weeks 1–4", async () => {
    const run = await start(KEYS.six);
    const perWeek: string[][] = [];
    for (const week of [1, 2, 3, 4])
      perWeek.push(
        calls(await run.call("espn_analyze_retrospective", { week })).map((c) => c.kind),
      );
    expect(perWeek.map((k) => k.length)).toEqual([1, 1, 2, 2]);
    expect(perWeek.flat()).toEqual(Array(6).fill("lineup"));
    await run.close();
  }, 120_000);

  it("RT-INJ: the same week-4 call as RT-1, carrying the note, read back as log data", async () => {
    const run = await start(KEYS.inj);
    const c = calls(await run.call("espn_analyze_retrospective"));
    expect(c.map((x) => x.kind)).toEqual(["lineup"]);
    const rec = await run.read(`espn-ff://rec/${c[0]!.log_id}`);
    expect((rec.data as Json).note).toBe(RT_INJ_NOTE);
    expect(
      ((rec.meta as Json).untrusted_fields as { path: string; source: string }[]).some(
        (f) => f.path === "data.note" && f.source === "store.recommendation_log",
      ),
    ).toBe(true);
    await run.close();
  }, 120_000);

  it("SC-4: Step 0's espn_get_status already reports drift red", async () => {
    const run = await start(KEYS.sc4);
    const st = await run.call("espn_get_status", { include_checks: true });
    expect(((st.data as Json).drift as Json).status).toBe("red");
    await run.close();
  }, 120_000);
});

/** A Lane 2 case of a Skill, as committed (skills/<skill>/evals/evals.json). */
const lane2Case = (skill: string, name: string): Json => {
  const evals = (
    JSON.parse(readFileSync(path.join(ROOT, "skills", skill, "evals", "evals.json"), "utf8")) as {
      evals: Json[];
    }
  ).evals;
  const c = evals.find((x) => x.name === name);
  expect(c, `${skill}/${name}`).toBeDefined();
  return c ?? {};
};
interface RosterPlayer {
  player_id: number;
  name: string;
  position: string;
  slot: string;
  lineup_locked: boolean;
  injury_status: string | null;
}
const rosterOf = (env: Json) => (env.data as { players: RosterPlayer[] }).players;
const playerNamed = (players: RosterPlayer[], name: string): RosterPlayer => {
  const p = players.find((x) => x.name === name);
  expect(p, name).toBeDefined();
  return p!;
};

describe("the players the review-fixed cases name are where their prompts put them (changelog §R9, review)", () => {
  it("SS-1 / SS-INJ: Bhayshul Tuten (an RB) starts at FLEX and Devaughn Vele (a WR) is on the bench, on both fixtures", async () => {
    const prompt = String(lane2Case("start-sit", "SS-1").prompt);
    expect(prompt).toContain("Bhayshul Tuten");
    expect(prompt).toContain("Devaughn Vele");
    for (const key of ["base--core", "inj-teamname-json--core"]) {
      const run = await start(key);
      const players = rosterOf(await run.call("espn_get_roster"));
      expect(playerNamed(players, "Bhayshul Tuten"), key).toMatchObject({
        slot: "FLEX",
        position: "RB",
      });
      expect(playerNamed(players, "Devaughn Vele"), key).toMatchObject({
        slot: "BE",
        position: "WR",
      });
      expect(await run.close()).toBe(0);
    }
  }, 180_000);

  it("SS-7 names a starter whose slot is still open; SS-12 and SS-INJ-2 one whose slot is locked — both ACTIVE on sunday-live", async () => {
    expect(String(lane2Case("start-sit", "SS-7").prompt)).toContain("James Cook III");
    for (const n of ["SS-12", "SS-INJ-2"])
      expect(String(lane2Case("start-sit", n).prompt), n).toContain("Ashton Jeanty");
    const run = await start("sunday-live--core");
    const players = rosterOf(await run.call("espn_get_roster"));
    expect(playerNamed(players, "James Cook III")).toMatchObject({
      slot: "RB",
      lineup_locked: false,
      injury_status: "ACTIVE",
    });
    expect(playerNamed(players, "Ashton Jeanty")).toMatchObject({
      slot: "RB",
      lineup_locked: true,
      injury_status: "ACTIVE",
    });
    // the bench players SS-7's expected output says are never offered: already in their games
    for (const n of ["Rachaad White", "Devaughn Vele"])
      expect(playerNamed(players, n).lineup_locked, n).toBe(true);
    expect(await run.close()).toBe(0);
  }, 120_000);

  it("RT-3: the logged week-4 call started Drake Maye at QB with Bo Nix on the bench; Maye scored under four points and Nix more", async () => {
    expect(String(lane2Case("retro", "RT-3").prompt)).toMatch(/Drake Maye.*Bo Nix/);
    const run = await start(KEYS.rt1);
    const players = rosterOf(await run.call("espn_get_roster", { week: 4 }));
    const maye = playerNamed(players, "Drake Maye");
    const nix = playerNamed(players, "Bo Nix");
    const [logged] = calls(await run.call("espn_analyze_retrospective"));
    const rec = await run.read(`espn-ff://rec/${String(logged?.log_id)}`);
    const subjects = ((rec.data as Json).rec as { subjects: { player_id: number; slot: string }[] })
      .subjects;
    expect(subjects).toContainEqual(
      expect.objectContaining({ player_id: maye.player_id, slot: "QB" }),
    );
    expect(subjects.some((x) => x.player_id === nix.player_id)).toBe(false);
    const box = (await run.call("espn_get_box_score", { week: 4 })).data as {
      matchups: { home: Json; away: Json }[];
    };
    const mine = box.matchups.flatMap((m) => [m.home, m.away]).find((t) => t.team_id === 2) as {
      players: { player_id: number; points_espn: number }[];
    };
    const pts = (id: number) => mine.players.find((x) => x.player_id === id)?.points_espn ?? NaN;
    expect(pts(maye.player_id)).toBeLessThan(4);
    expect(pts(nix.player_id)).toBeGreaterThan(pts(maye.player_id));
    expect(await run.close()).toBe(0);
  }, 120_000);

  it("RT-4-E: on the six-call log, p_win's Brier has n = 0 in every week — the n its expected output states", async () => {
    expect(String(lane2Case("retro", "RT-4-E").expected_output)).toContain("n = 0");
    const run = await start(KEYS.six);
    for (const week of [1, 2, 3, 4]) {
      const metrics = ((await run.call("espn_analyze_retrospective", { week })).data as Json)
        .metrics as { brier: { p_win: { n: number; ours: unknown } } };
      expect(metrics.brier.p_win, `week ${String(week)}`).toMatchObject({
        n: 0,
        ours: "n too small (0 of 30)",
      });
    }
    expect(await run.close()).toBe(0);
  }, 120_000);
});

describe("WK-10 (changelog §R10, R10-28, R10-31): the session is rejected inside E11, and E11 says so", () => {
  it("Step 0 reads stored and the private league from the fresh settings; E11 answers partial with its session lines; the status reads rejected after", async () => {
    const run = await start(KEYS.wk10);
    const status = await run.call("espn_get_status");
    expect(((status.data as Json).credential as Json).state).toBe("stored");
    const league = await run.call("espn_get_league");
    expect(league.partial).toBe(false);
    expect(((league.data as Json).league as Json).is_public).toBe(false);
    // still stored: the settings were served from the seeded cache, no read was refused
    expect((((await run.call("espn_get_status")).data as Json).credential as Json).state).toBe(
      "stored",
    );
    const e11 = await run.call("espn_analyze_league_activity");
    expect(e11.partial).toBe(true);
    const w = e11.warnings as string[];
    // the feed's line, the league reads' line (one line, "and"), the history line that is true —
    // and no "teams" line repeating the reads line, no generic session line (E11 said them all)
    expect(w).toContain(SESSION_READ_WARNINGS.feed_rejected);
    expect(w).toContain(
      activityLeagueReadsWarning("rejected", ["standings", "rosters", "free-agent pool"]),
    );
    expect(w).toContain(
      "partial: the stored ESPN session was rejected, and ESPN's standings, rosters and free-agent pool need one on a league not known to be public: they were not read (by-team activity, waiver-order movement and rival needs go without them); run `eff setup` in a terminal to replace it",
    );
    expect(w).toContain(
      "no persisted transaction history yet, and ESPN's feed was not read: the window holds no transactions",
    );
    expect(w.some((x) => x.includes("the league's teams were not read"))).toBe(false);
    expect(w.some((x) => x.includes("this week's feed only"))).toBe(false);
    expect(w.filter((x) => x.endsWith("in a terminal to replace it"))).toHaveLength(2);
    expect((((await run.call("espn_get_status")).data as Json).credential as Json).state).toBe(
      "rejected",
    );
    expect(await run.close()).toBe(0);
  }, 180_000);

  // changelog §R10, R10-33: an accepting probe on the run's server validates and leaves the 401
  // armed; only the seed's path disarms it, and the run's .mcp.json never carries that path
  it("the run's .mcp.json carries no seed path; a run that probes first is validated, its cached settings are served, and its first uncached read is the 401", async () => {
    const mcp = JSON.parse(
      readFileSync(path.join(out, "plugins", KEYS.wk10, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> };
    for (const s of Object.values(mcp.mcpServers)) {
      expect(Object.keys(s.env)).not.toContain("EFF_FIXTURE_SEED");
      expect(s.args.join(" ")).not.toContain("EFF_FIXTURE_SEED");
    }
    const run = await start(KEYS.wk10);
    const auth = await run.call("espn_check_auth");
    expect(auth.data).toMatchObject({ accepted: true, upstream_status: null });
    expect((((await run.call("espn_get_status")).data as Json).credential as Json).state).toBe(
      "validated",
    );
    const league = await run.call("espn_get_league");
    expect(league.partial).toBe(false);
    expect((((await run.call("espn_get_status")).data as Json).credential as Json).state).toBe(
      "validated",
    );
    const e11 = await run.call("espn_analyze_league_activity");
    expect(e11.partial).toBe(true);
    expect(e11.warnings as string[]).toContain(SESSION_READ_WARNINGS.feed_rejected);
    expect((((await run.call("espn_get_status")).data as Json).credential as Json).state).toBe(
      "rejected",
    );
    expect(await run.close()).toBe(0);
  }, 180_000);
});

describe("runs are independent: every start copies the pristine state", () => {
  it("what one run logs is gone in the next run, and the seeded call is still there", async () => {
    const one = await start(KEYS.rt1);
    const league = await one.call("espn_get_league");
    const retro = await one.call("espn_analyze_retrospective");
    const seeded = calls(retro).map((c) => c.log_id);
    expect(seeded).toHaveLength(1);
    const logged = await one.call("espn_record_recommendation", {
      kind: "retro",
      week: 4,
      rec: (retro.data as Json).rec,
      alternatives: [],
      source_calls: [
        { tool: "espn_analyze_retrospective", request_id: (retro.meta as Json).request_id },
      ],
      settings_hash: ((league.data as Json).scoring as Json).settings_hash,
      followed_hint: "unknown",
      client_ref: "plugin-evals-state-test-retro",
    });
    const id = String((logged.data as Json).log_id);
    expect(((await one.read(`espn-ff://rec/${id}`)).data as Json).kind).toBe("retro");
    await one.close();
    const two = await start(KEYS.rt1);
    await expect(two.read(`espn-ff://rec/${id}`)).rejects.toThrow(/not found/);
    const again = calls(await two.call("espn_analyze_retrospective")).map((c) => c.log_id);
    expect(again).toContain(seeded[0]);
    expect(again).not.toContain(id);
    await two.close();
  }, 180_000);
});
