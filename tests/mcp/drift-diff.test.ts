// drift-diff.test.ts — the drift diff G1 and the status resources show (plan 07 G1, §4.1
// espn-ff://status/drift: "the current manifest diff, the additive-drift list"; plan 10 A6: every
// string in `data` is wrapped, listed, a code or server prose). Stage C finding
// `status-drift-diff-unwrapped-strings`: once drift had a diff, `drift.diff[].removed[]`/`added[]`
// (ESPN's own key names) failed the A6 walk, and an `additive` status showed `diff: []` while the
// paths sat in the store. Now every path is checked against the detector's grammar before it leaves
// (DRIFT_PATH_RE / DRIFT_ENUM_RE — `$`, identifier keys or `<key>`, `[]`, an enum token), anything
// else is dropped and counted in a warning, the output schema enforces the grammar, and the
// additive list is merged into the shown diff whenever the status port hands it over.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriftView } from "../../src/mcp/services.js";
import {
  DRIFT_ENUM_RE,
  DRIFT_PATH_RE,
  droppedDriftWarning,
  shownDriftDiff,
} from "../../src/mcp/tools/ops.js";
import { envelopeViolations } from "./helpers/walk.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

interface Env {
  data: Record<string, unknown>;
  warnings: string[];
  meta: never;
}

let world: World;
beforeAll(async () => {
  world = await makeWorld({ publishEspn: false });
}, 120_000);
afterAll(() => {
  world.cleanup();
});

function putRow(diff: unknown[], additive: unknown[] = [], status = "red"): void {
  world.store.repos.driftState.put({
    status: status as "red",
    since: "2026-10-06T11:00:00.000Z",
    last_probe_at: "2026-10-06T11:00:00.000Z",
    manifest_hash: "sha256:0",
    manifest_version: 1,
    host: "lm-api-reads.fantasy.espn.com",
    host_moved_at: null,
    diff_json: JSON.stringify(diff),
    additive_json: JSON.stringify(additive),
    updated_at: "2026-10-06T11:00:00.000Z",
  });
}

async function readEnv(client: Awaited<ReturnType<typeof connect>>["client"], uri: string) {
  const raw = (await client.readResource({ uri })) as { contents: { text: string }[] };
  return JSON.parse(raw.contents[0]?.text ?? "{}") as Env;
}

describe("a red drift diff passes the A6 walk on every surface", () => {
  it("espn_get_status, espn-ff://status and espn-ff://status/drift show the path, walk-clean", async () => {
    putRow([
      { view: "mPendingTransactions", removed: ["$.pendingTransactions"], added: [], enums: [] },
    ]);
    const c = await connect(world);
    const st = (await call(c.client, "espn_get_status")).body as unknown as Env;
    const status = await readEnv(c.client, "espn-ff://status");
    const drift = await readEnv(c.client, "espn-ff://status/drift");
    await c.close();
    for (const env of [st, status, drift]) expect(envelopeViolations(env)).toEqual([]);
    const d = st.data.drift as { diff: { removed: string[] }[]; affected_tools: string[] };
    expect(d.diff[0]?.removed).toEqual(["$.pendingTransactions"]);
    expect(d.affected_tools).toContain("espn_list_transactions");
    expect((drift.data as { diff: unknown[] }).diff).toEqual(d.diff);
  });

  it("a path outside the grammar is dropped and counted, never shown", async () => {
    // the store's own cleaning (src/drift/state.ts) already drops whitespace and unknown views;
    // these pass it and still fail the detector's grammar the server enforces
    putRow([
      {
        view: "mTeam",
        removed: ["$.teams[].roster", "teams.noRoot"],
        added: ["$.{curly}", "$.teams[].ok"],
        enums: ["$.teams[].x=NEW_VALUE", "$.teams[].x=lowercase"],
      },
      { view: "not a view!", removed: ["$.a"], added: [], enums: [] },
    ]);
    const c = await connect(world);
    const st = (await call(c.client, "espn_get_status")).body as unknown as Env;
    const drift = await readEnv(c.client, "espn-ff://status/drift");
    await c.close();
    const text = JSON.stringify(st) + JSON.stringify(drift);
    expect(text).not.toContain("noRoot");
    expect(text).not.toContain("curly");
    expect(text).not.toContain("lowercase");
    expect(text).not.toContain("not a view");
    expect(st.warnings).toContain(droppedDriftWarning(3));
    expect(drift.warnings).toContain(droppedDriftWarning(3));
    expect(envelopeViolations(st)).toEqual([]);
    expect((st.data.drift as { diff: unknown[] }).diff).toEqual([
      {
        view: "mTeam",
        removed: ["$.teams[].roster"],
        added: ["$.teams[].ok"],
        enums: ["$.teams[].x=NEW_VALUE"],
      },
    ]);
  });
});

describe("an additive status names its paths when the status port hands them over", () => {
  it("G1 and the drift resource merge the additive list into the shown diff", async () => {
    putRow([], [], "additive");
    const real = world.services.status;
    const view: DriftView = {
      ...real.drift(),
      status: "additive",
      additive: [
        { view: "mTeam", removed: [], added: ["$.teams[].newKey"], enums: ["$.teams[].x=NEW"] },
      ],
    };
    const c = await connect(world, {
      services: { status: { ...real, drift: () => view } },
    });
    const st = (await call(c.client, "espn_get_status")).body as unknown as Env;
    const drift = await readEnv(c.client, "espn-ff://status/drift");
    await c.close();
    const shown = st.data.drift as { status: string; diff: unknown[] };
    expect(shown.status).toBe("additive");
    expect(shown.diff).toEqual([
      { view: "mTeam", removed: [], added: ["$.teams[].newKey"], enums: ["$.teams[].x=NEW"] },
    ]);
    expect((drift.data as { diff: unknown[] }).diff).toEqual(shown.diff);
    expect(envelopeViolations(st)).toEqual([]);
    expect(envelopeViolations(drift)).toEqual([]);
  });
});

describe("shownDriftDiff", () => {
  it("merges per view, deduplicates, keeps the grammar, counts the rest", () => {
    const out = shownDriftDiff({
      status: "red",
      since: null,
      last_probe_at: null,
      manifest_hash: null,
      diff: [
        {
          view: "mRoster",
          removed: ["$.teams[].roster", "$.teams[].roster"],
          added: [],
          enums: [],
        },
      ],
      additive: [
        { view: "mRoster", removed: [], added: ["$.teams[].<key>", "x y"], enums: ["$.a=?"] },
      ],
    });
    expect(out.diff).toEqual([
      {
        view: "mRoster",
        removed: ["$.teams[].roster"],
        added: ["$.teams[].<key>"],
        enums: ["$.a=?"],
      },
    ]);
    expect(out.dropped).toBe(1);
  });
  it("the grammar admits what the detector writes and nothing with whitespace", () => {
    for (const p of ["$", "$.pendingTransactions", "$.teams[].roster.entries[]", "$.x.<key>"])
      expect(DRIFT_PATH_RE.test(p), p).toBe(true);
    for (const p of ["", "teams", "$.a b", "$.a\n", "$..a", "$.1a", `$.${"a".repeat(65)}`])
      expect(DRIFT_PATH_RE.test(p), p).toBe(false);
    expect(DRIFT_ENUM_RE.test("$.a[].b=WAIVERS_TRADITIONAL")).toBe(true);
    expect(DRIFT_ENUM_RE.test("$.a=lower")).toBe(false);
  });
});
