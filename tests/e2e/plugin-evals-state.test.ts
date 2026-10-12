// plugin-evals-state.test.ts — the Lane 2 eval servers on the BUILT package (plan 09 §5.2; plan 10
// B15; Stage C finding eval-recorded-state-preconditions-missing): `build-plugin-evals.mjs --seed`
// writes each case's recorded state through the real tools — RT-1/RT-3's week-4 lineup call,
// RT-4-E's six lineup calls, RT-INJ's call with its log note, SC-4's drifted roster view already
// read — and every server, started exactly as its .mcp.json says (the launcher, scripts/skills/
// eval-server.mjs), begins from that state on every start: what one run logs never reaches the next.
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
import { ROOT, requireDist } from "./helpers.js";

type Json = Record<string, unknown>;
const KEYS = {
  rt1: "base--core--log-week4-lineup",
  six: "base--core--log-six-lineup",
  inj: "inj-teamname-json--core--log-week4-lineup-note",
  sc4: "drift-mRoster--core--drift-red",
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
  expect(done).toHaveLength(4);
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
