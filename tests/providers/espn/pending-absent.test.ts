// pending-absent.test.ts — Stage C remediation, round 1 (finding drift-pending-transactions-absent-
// key-red; plan 01 §7, plan 07 A6, ADV OBJ-19(c)): a cookie-bearing `mPendingTransactions` answer
// without a `pendingTransactions` key (the owner's private league, live) is ESPN's "nothing pending"
// when the answer shows ESPN recognised the view (the base every recognised league view answers,
// with `draftDetail`): the empty list, no drift, and `drift_state` untouched — one ordinary read
// never turns the whole product red; the red row the live run left clears on the next good answer.
// The unrecognised-view answer (research 03 P28, the recorded skeleton) is still a skeleton — a
// renamed view stays detected — and so is any body that does not show the recognised base
// (`showsRecognizedView`: its own `draftDetail` object; verifier finding F1 on ec68d08). The key
// present with a non-list value is still drift; the in-call check excuses exactly that absent path
// and nothing else; the drift seed is unchanged. An excused answer does not show the key, so it
// never clears a red row's removed key (verifier finding F3); an answer that carries the list does.
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_PATHS_BY_VIEW } from "../../../src/drift/types.js";
import type { DriftCheck } from "../../../src/drift/detect.js";
import type { EspnView } from "../../../src/providers/espn/types.js";
import {
  ABSENT_MEANS_EMPTY,
  absentAsEmpty,
  absentMeansEmptyPaths,
  isUnrecognizedViewAnswer,
  showsRecognizedView,
} from "../../../src/providers/espn/views/index.js";
import type { DriftStateRow } from "../../../src/store/types.js";
import {
  FakeAuthority,
  FIXTURES,
  jsonResponse,
  loadFixture,
  makeWorld,
  NOW_ISO,
  testCookieHeader,
} from "./helpers.js";

const SWID = "{00000000-0000-4000-8000-000000000011}";

/** The private league's settings + identity (isPublic false: cookie-bearing reads discriminate). */
function privateSettings(): unknown {
  const s = structuredClone(loadFixture("recorded/league-a/mSettings.json")) as {
    settings: Record<string, unknown>;
  };
  const nav = loadFixture("recorded/league-a/mNav.json") as Record<string, unknown>;
  s.settings.isPublic = false;
  return { ...s, members: nav.members, teams: nav.teams };
}

/**
 * A league answer to `view=mPendingTransactions` with no pending list: the recognised view's base
 * (draftDetail, gameId, id, scoringPeriodId, seasonId, segmentId, status) — research 03 P10's
 * answer without its `"pendingTransactions":[]`.
 */
function withoutPendingKey(): Record<string, unknown> {
  const b = structuredClone(loadFixture("fx-10h/league/mPendingTransactions.json")) as Record<
    string,
    unknown
  >;
  delete b.pendingTransactions;
  return b;
}

/** The live scenario's starting row: additive drift recorded earlier, nothing removed. */
function additiveRow(): DriftStateRow {
  return {
    status: "additive",
    since: null,
    last_probe_at: null,
    manifest_hash: null,
    manifest_version: null,
    host: "lm-api-reads.fantasy.espn.com",
    host_moved_at: null,
    diff_json: "[]",
    additive_json: JSON.stringify([
      { view: "mSettings", removed: [], added: ["$.settings.someNewKey"], enums: [] },
    ]),
    updated_at: NOW_ISO,
  };
}

function world(pending: () => unknown) {
  const auth = new FakeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
  const calls: string[] = [];
  const w = makeWorld({
    credentials: auth,
    fetch: (url) => {
      const views = new URL(url).searchParams.getAll("view").join("&");
      calls.push(views);
      if (views === "mSettings&mNav") return Promise.resolve(jsonResponse(privateSettings()));
      if (views === "mPendingTransactions") return Promise.resolve(jsonResponse(pending()));
      return Promise.reject(new Error(`unscripted ${views}`));
    },
  });
  return { w, calls };
}

describe("an absent pending list on a recognised view's answer is the empty list, never drift", () => {
  it("cookie-bearing answer without the key → [] and drift_state unchanged (still additive, not red)", async () => {
    const { w, calls } = world(withoutPendingKey);
    w.drift.row = additiveRow();
    const before = w.drift.puts;
    const r = await w.provider.listPendingTransactions(w.ref);
    expect(r.value).toEqual([]);
    expect(r.stamp.source).toBe("espn:mPendingTransactions");
    expect(r.stamp.drift).toBeNull();
    expect(w.drift.row.status).toBe("additive");
    expect(w.drift.row.diff_json).toBe("[]");
    expect(w.drift.puts).toBe(before);
    expect(w.sent.find((s) => s.url.includes("mPendingTransactions"))?.headers.cookie).toContain(
      "SWID=",
    );
    // the answer is cached like any good one: the next read is served from it, as the empty list
    const again = await w.provider.listPendingTransactions(w.ref);
    expect(again.value).toEqual([]);
    expect(again.stamp.cache).toBe("hit");
    expect(calls.filter((c) => c === "mPendingTransactions")).toHaveLength(1);
  });

  it("an answer that does not show the recognised base (no draftDetail) is drift, not none (F1)", async () => {
    for (const body of [
      { gameId: 1, id: 0, seasonId: 2026, segmentId: 0 },
      { id: 0 },
      {},
      { messages: ["x"], details: [{ type: "GENERAL_ERROR" }] },
      { ...withoutPendingKey(), draftDetail: null },
    ]) {
      const { w } = world(() => body);
      await expect(w.provider.listPendingTransactions(w.ref)).rejects.toMatchObject({
        effCode: "ESPN_DRIFT_DETECTED",
        effDetails: { view: "mPendingTransactions", path: "pendingTransactions" },
      });
      expect(w.drift.row?.status).toBe("red");
      expect([...w.cache.map.keys()].some((k) => k.includes("mPendingTransactions"))).toBe(false);
    }
  });

  it("the unrecognised-view answer (the recorded P28 skeleton) is still a skeleton: drift, red, nothing cached", async () => {
    const { w } = world(() => loadFixture("recorded/league-a/skeleton.json"));
    await expect(w.provider.listPendingTransactions(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_DRIFT_DETECTED",
      effDetails: { view: "mPendingTransactions", path: "pendingTransactions" },
    });
    expect(w.drift.row?.status).toBe("red");
    expect(JSON.parse(w.drift.row?.diff_json ?? "[]")).toEqual([
      { view: "mPendingTransactions", removed: ["$.pendingTransactions"], added: [], enums: [] },
    ]);
    expect([...w.cache.map.keys()].some((k) => k.includes("mPendingTransactions"))).toBe(false);
  });

  it("present with a non-list value it is still drift (ESPN_DRIFT_DETECTED, red, nothing cached)", async () => {
    for (const bad of [{ a: 1 }, null, "none", 0]) {
      const { w } = world(() => ({ ...withoutPendingKey(), pendingTransactions: bad }));
      await expect(w.provider.listPendingTransactions(w.ref)).rejects.toMatchObject({
        effCode: "ESPN_DRIFT_DETECTED",
        effDetails: { view: "mPendingTransactions", path: "pendingTransactions" },
      });
      expect(w.drift.row?.status).toBe("red");
      expect([...w.cache.map.keys()].some((k) => k.includes("mPendingTransactions"))).toBe(false);
    }
  });

  it("present as a list it is read as before", async () => {
    const txn = (
      loadFixture("recorded/league-b/kona_playercard.json") as {
        players: { transactions?: unknown[] }[];
      }
    ).players.flatMap((p) => p.transactions ?? []);
    const { w } = world(() => ({ ...withoutPendingKey(), pendingTransactions: txn.slice(0, 2) }));
    const r = await w.provider.listPendingTransactions(w.ref);
    expect(r.value).toHaveLength(2);
    expect(w.drift.row).toBeNull();
  });
});

/** A red row as the live run left it: `$.pendingTransactions` removed (plus another view's key). */
function liveRedRow(extra: { view: string; path: string } | null): DriftStateRow {
  const diffs = [
    { view: "mPendingTransactions", removed: ["$.pendingTransactions"], added: [], enums: [] },
  ];
  if (extra !== null) diffs.push({ view: extra.view, removed: [extra.path], added: [], enums: [] });
  return {
    ...additiveRow(),
    status: "red",
    since: NOW_ISO,
    diff_json: JSON.stringify(diffs),
  };
}

describe("a good answer clears the drift its views recorded (src/drift applyRecovered, schema)", () => {
  it("an answer without the list (read as none) does not show the key: the red row stays (F3)", async () => {
    const { w } = world(withoutPendingKey);
    w.drift.row = liveRedRow(null);
    const r = await w.provider.listPendingTransactions(w.ref);
    expect(r.value).toEqual([]);
    expect(w.drift.row.status).toBe("red");
    expect(JSON.parse(w.drift.row.diff_json)).toEqual([
      { view: "mPendingTransactions", removed: ["$.pendingTransactions"], added: [], enums: [] },
    ]);
  });
  it("the red row clears on the next answer that carries the list, an empty one included", async () => {
    const { w } = world(() => ({ ...withoutPendingKey(), pendingTransactions: [] }));
    w.drift.row = liveRedRow(null);
    const r = await w.provider.listPendingTransactions(w.ref);
    expect(r.value).toEqual([]);
    expect(w.drift.row.status).toBe("additive");
    expect(w.drift.row.since).toBeNull();
    expect(w.drift.row.diff_json).toBe("[]");
  });
  it("only the verified views clear: another view's removed key stays red", async () => {
    const { w } = world(() => ({ ...withoutPendingKey(), pendingTransactions: [] }));
    w.drift.row = liveRedRow({ view: "mRoster", path: "$.teams[].roster.entries" });
    await w.provider.listPendingTransactions(w.ref);
    expect(w.drift.row.status).toBe("red");
    const diffs = JSON.parse(w.drift.row.diff_json) as { view: string; removed: string[] }[];
    expect(diffs.map((d) => [d.view, d.removed])).toEqual([
      ["mRoster", ["$.teams[].roster.entries"]],
    ]);
  });
});

describe("the in-call check excuses exactly the listed absent paths on a recognised view's answer", () => {
  const checkBody = (w: ReturnType<typeof makeWorld>, views: EspnView[], body: unknown) =>
    (
      w.provider as unknown as {
        req: { checkBody(v: readonly EspnView[], b: unknown): DriftCheck };
      }
    ).req.checkBody(views, body);

  it("alone: excused; beside a really drifted view: that view's signals stand, the excused one is dropped", () => {
    const { w } = world(withoutPendingKey);
    const alone = checkBody(w, ["mPendingTransactions"], withoutPendingKey());
    expect(alone.drifted).toBe(false);
    expect(alone.signals).toEqual([]);
    // mRoster's seed is not listed (mTransactions2's is, since finding transactions-absent-key-red)
    const both = checkBody(w, ["mPendingTransactions", "mRoster"], withoutPendingKey());
    expect(both).toMatchObject({ drifted: true, skeleton: true });
    expect(both.signals.map((s) => [s.kind, s.view, s.path])).toEqual([
      ["skeleton", "mRoster", "$.teams[].roster.entries"],
    ]);
    expect(both.first).toMatchObject({ view: "mRoster", path: "$.teams[].roster.entries" });
    // a view whose seed is not listed keeps its skeleton verdict
    const other = checkBody(w, ["mRoster"], withoutPendingKey());
    expect(other.drifted).toBe(true);
    // the pending key present: nothing to excuse, nothing changed
    const present = checkBody(w, ["mPendingTransactions"], {
      ...withoutPendingKey(),
      pendingTransactions: [],
    });
    expect(present.drifted).toBe(false);
    // the unrecognised-view answer: nothing is excused
    const p28 = checkBody(
      w,
      ["mPendingTransactions"],
      loadFixture("recorded/league-a/skeleton.json"),
    );
    expect(p28).toMatchObject({ drifted: true, skeleton: true });
    expect(p28.first).toMatchObject({
      view: "mPendingTransactions",
      path: "$.pendingTransactions",
    });
  });
});

describe("isUnrecognizedViewAnswer over the recorded corpus", () => {
  const leagueBodies = (): { file: string; body: unknown }[] => {
    const out: { file: string; body: unknown }[] = [];
    const root = path.join(FIXTURES, "recorded");
    for (const slot of readdirSync(root).filter((d) => /^league-[a-z]$/.test(d)))
      for (const f of readdirSync(path.join(root, slot)).filter((x) => x.endsWith(".json"))) {
        const rel = `recorded/${slot}/${f}`;
        const body = loadFixture(rel);
        // league-route view answers only (the player and card views answer a different object)
        if (typeof body === "object" && body !== null && "seasonId" in body)
          out.push({ file: rel, body });
      }
    return out;
  };

  it("every recorded skeleton is one; every other recorded league answer is not", () => {
    const bodies = leagueBodies();
    const skeletons = bodies.filter((b) => b.file.endsWith("/skeleton.json"));
    expect(skeletons.length).toBeGreaterThan(0);
    expect(bodies.length).toBeGreaterThan(skeletons.length + 20);
    for (const b of bodies)
      expect(isUnrecognizedViewAnswer(b.body), b.file).toBe(b.file.endsWith("/skeleton.json"));
    // the derived fixture league's pending answer (the recognised base) is not one either
    expect(isUnrecognizedViewAnswer(withoutPendingKey())).toBe(false);
  });

  it("needs the summary's lists and no draftDetail; anything but a plain object is not one", () => {
    const p28 = loadFixture("recorded/league-a/skeleton.json") as Record<string, unknown>;
    expect(isUnrecognizedViewAnswer(p28)).toBe(true);
    expect(isUnrecognizedViewAnswer({ ...p28, draftDetail: {} })).toBe(false);
    const { members: _m, ...noMembers } = p28;
    expect(isUnrecognizedViewAnswer(noMembers)).toBe(false);
    const { teams: _t, ...noTeams } = p28;
    expect(isUnrecognizedViewAnswer(noTeams)).toBe(false);
    expect(isUnrecognizedViewAnswer({ ...p28, members: {} })).toBe(false);
    for (const odd of [null, undefined, 5, "s", [p28]])
      expect(isUnrecognizedViewAnswer(odd)).toBe(false);
    // not being P28 is not recognition: none of these shows the recognised base (F1)
    for (const body of [noMembers, noTeams, { ...p28, members: {} }])
      expect(showsRecognizedView(body)).toBe(false);
  });

  it("showsRecognizedView: every recorded recognised league answer; nothing without its own draftDetail object (F1)", () => {
    const bodies = leagueBodies();
    for (const b of bodies)
      expect(showsRecognizedView(b.body), b.file).toBe(!b.file.endsWith("/skeleton.json"));
    expect(showsRecognizedView(withoutPendingKey())).toBe(true);
    expect(showsRecognizedView(loadFixture("fx-10h/league/mTransactions2.json"))).toBe(true);
    const base = withoutPendingKey();
    const { draftDetail: _d, ...noDraft } = base;
    for (const odd of [
      {},
      { id: 0 },
      { messages: ["x"], details: [{ type: "GENERAL_ERROR" }] },
      noDraft,
      { ...base, draftDetail: null },
      { ...base, draftDetail: [] },
      { ...base, draftDetail: "x" },
      { ...base, draftDetail: 1 },
      Object.assign(Object.create({ draftDetail: {} }) as object, noDraft),
      null,
      undefined,
      5,
      "s",
      [base],
    ])
      expect(showsRecognizedView(odd), JSON.stringify(odd)).toBe(false);
    // P28 with a draftDetail grafted on is no longer the unrecognised-view answer: recognised
    const p28 = loadFixture("recorded/league-a/skeleton.json") as Record<string, unknown>;
    expect(showsRecognizedView({ ...p28, draftDetail: {} })).toBe(true);
  });
});

describe("ABSENT_MEANS_EMPTY / absentMeansEmptyPaths / absentAsEmpty", () => {
  it("every listed path is a root key of its view's drift seed (the detector still names it)", () => {
    for (const [view, paths] of Object.entries(ABSENT_MEANS_EMPTY) as [EspnView, string[]][])
      for (const p of paths) {
        expect(p).toMatch(/^\$\.[A-Za-z_][A-Za-z0-9_]*$/);
        expect(REQUIRED_PATHS_BY_VIEW[view]).toContain(p);
      }
  });
  it("names an absent key only on a recognised view's answer", () => {
    expect(absentMeansEmptyPaths("mPendingTransactions", withoutPendingKey())).toEqual([
      "$.pendingTransactions",
    ]);
    expect(
      absentMeansEmptyPaths("mPendingTransactions", {
        ...withoutPendingKey(),
        pendingTransactions: 1,
      }),
    ).toEqual([]);
    expect(
      absentMeansEmptyPaths("mPendingTransactions", loadFixture("recorded/league-a/skeleton.json")),
    ).toEqual([]);
    expect(absentMeansEmptyPaths("mRoster", withoutPendingKey())).toEqual([]);
    for (const odd of [null, 5, "s", [1]])
      expect(absentMeansEmptyPaths("mPendingTransactions", odd)).toEqual([]);
  });
  it("fills only an absent key, on a copy; anything else is left for the schema", () => {
    const body = withoutPendingKey();
    const copy = structuredClone(body);
    const out = absentAsEmpty("mPendingTransactions", body);
    expect(out).toEqual({ ...copy, pendingTransactions: [] });
    expect(body).toEqual(copy);
    // a body without the recognised base is left for the schema (F1: it was once filled)
    const bare = { id: 0 };
    expect(absentAsEmpty("mPendingTransactions", bare)).toBe(bare);
    const present = { pendingTransactions: "x" };
    expect(absentAsEmpty("mPendingTransactions", present)).toBe(present);
    const p28 = loadFixture("recorded/league-a/skeleton.json");
    expect(absentAsEmpty("mPendingTransactions", p28)).toBe(p28);
    for (const odd of [null, 5, "s", [1]])
      expect(absentAsEmpty("mPendingTransactions", odd)).toBe(odd);
    const roster = { teams: [] };
    expect(absentAsEmpty("mRoster", roster)).toBe(roster);
  });
});
