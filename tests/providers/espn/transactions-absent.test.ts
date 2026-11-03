// transactions-absent.test.ts — finding transactions-absent-key-red (live, 2026-11-03; plan 01 §7,
// plan 07 A6, ADV OBJ-19(c)): the hourly `eff transactions` job read the new scoring period through
// `mTransactions2` with the cookie, before anyone had moved in it, and ESPN answered without a
// `transactions` key — the job failed ESPN_DRIFT_DETECTED every hour and drift_state stayed red until
// the period's first move. The same absence Stage C found for `mPendingTransactions`
// (pending-absent.test.ts): an answer that shows ESPN recognised the view (the base every recognised
// league view answers, with `draftDetail` — research 03 P11/P17/P18) without the list is the empty
// week — no drift, drift_state untouched, the red row the live runs left clears on the next such
// answer. Kept as drift: the unrecognised-view answer (P28, the recorded skeleton), the key present
// with a non-list value, and an absent list ESPN's own count header (`x-fantasy-filter-transaction-
// count`, research 03 §A.3) says is not empty. The drift seed is unchanged.
import { describe, expect, it } from "vitest";
import type { DriftCheck } from "../../../src/drift/detect.js";
import { REQUIRED_PATHS_BY_VIEW, REQUIRED_PATHS_UNVERIFIED } from "../../../src/drift/types.js";
import { HEADER_TRANSACTION_COUNT, type EspnView } from "../../../src/providers/espn/types.js";
import {
  ABSENT_LIST_COUNT_HEADER,
  ABSENT_MEANS_EMPTY,
  absentAsEmpty,
  absentListCount,
  absentMeansEmptyPaths,
} from "../../../src/providers/espn/views/index.js";
import type { DriftStateRow } from "../../../src/store/types.js";
import {
  FakeAuthority,
  jsonResponse,
  loadFixture,
  makeWorld,
  NOW_ISO,
  testCookieHeader,
} from "./helpers.js";

const SWID = "{00000000-0000-4000-8000-000000000011}";

/** The private league's settings + identity (isPublic false: every read here carries the cookie). */
function privateSettings(): unknown {
  const s = structuredClone(loadFixture("recorded/league-a/mSettings.json")) as {
    settings: Record<string, unknown>;
  };
  const nav = loadFixture("recorded/league-a/mNav.json") as Record<string, unknown>;
  s.settings.isPublic = false;
  return { ...s, members: nav.members, teams: nav.teams };
}

/**
 * A league answer to `view=mTransactions2&scoringPeriodId=N` with no transactions list: the
 * recognised view's bare base (draftDetail, gameId, id, scoringPeriodId, seasonId, segmentId,
 * status) — research 03 P11's answer without its `"transactions":[]`, P17/P18's 939-byte base.
 */
function withoutTxnKey(): Record<string, unknown> {
  const b = structuredClone(loadFixture("fx-10h/league/mTransactions2.json")) as Record<
    string,
    unknown
  >;
  delete b.transactions;
  return b;
}

/** Two recorded transactions (the ones `kona_playercard` embeds — league-b). */
function recordedTxns(): unknown[] {
  return (
    loadFixture("recorded/league-b/kona_playercard.json") as {
      players: { transactions?: unknown[] }[];
    }
  ).players
    .flatMap((p) => p.transactions ?? [])
    .slice(0, 2);
}

/** The live install's starting row: additive keys and enum values recorded earlier, nothing removed. */
function additiveRow(): DriftStateRow {
  return {
    status: "additive",
    since: null,
    last_probe_at: null,
    manifest_hash: null,
    manifest_version: null,
    host: "lm-api-reads.fantasy.espn.com",
    host_moved_at: null,
    diff_json: JSON.stringify([
      { view: "mSettings", removed: [], added: [], enums: ["$.status.waiverProcessStatus{}=7"] },
    ]),
    additive_json: JSON.stringify([
      { view: "mSettings", removed: [], added: ["$.settings.someNewKey"], enums: [] },
    ]),
    updated_at: NOW_ISO,
  };
}

interface Answer {
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

function world(txns: (url: URL) => Answer) {
  const auth = new FakeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
  const calls: string[] = [];
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const log = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) =>
    logs.push({ level, event, fields: { ...fields } });
  const w = makeWorld({
    credentials: auth,
    over: { log: { debug: log("debug"), warn: log("warn") } },
    fetch: (url) => {
      const u = new URL(url);
      const views = u.searchParams.getAll("view").join("&");
      calls.push(views);
      if (views === "mSettings&mNav") return Promise.resolve(jsonResponse(privateSettings()));
      if (views === "mTransactions2") {
        const a = txns(u);
        return Promise.resolve(jsonResponse(a.body, 200, a.headers ?? {}));
      }
      return Promise.reject(new Error(`unscripted ${views}`));
    },
  });
  return { w, calls, logs };
}

const QUERY = {
  types: ["FREEAGENT", "WAIVER", "WAIVER_ERROR", "TRADE_ACCEPT"],
  week: 9,
  since: null,
  count: 100,
  team_id: null,
} as const;

const txnCached = (w: ReturnType<typeof makeWorld>): boolean =>
  [...w.cache.map.keys()].some((k) => k.includes("mTransactions2"));

describe("an absent transactions list on a recognised view's answer is the empty week, never drift", () => {
  it("cookie-bearing bare base without the key → an empty page, drift_state unchanged (still additive)", async () => {
    const { w, calls } = world(() => ({
      body: withoutTxnKey(),
      headers: { [HEADER_TRANSACTION_COUNT]: "0" },
    }));
    w.drift.row = additiveRow();
    const before = { ...w.drift.row };
    const puts = w.drift.puts;
    const r = await w.provider.listTransactions(w.ref, QUERY);
    expect(r.value.items).toEqual([]);
    expect(r.value).toMatchObject({ count: 0, total: 0, has_more: false, next_offset: null });
    expect(r.stamp.source).toBe("espn:mTransactions2");
    expect(r.stamp.drift).toBeNull();
    expect(w.drift.row).toEqual(before);
    expect(w.drift.puts).toBe(puts);
    const sent = w.sent.find((s) => s.url.includes("mTransactions2"));
    expect(sent?.headers.cookie).toContain("SWID=");
    expect(new URL(sent?.url ?? "x:").searchParams.get("scoringPeriodId")).toBe("9");
    // the answer is cached like any good one: the next read is served from it, as the empty week
    const again = await w.provider.listTransactions(w.ref, QUERY);
    expect(again.value.items).toEqual([]);
    expect(again.stamp.cache).toBe("hit");
    expect(calls.filter((c) => c === "mTransactions2")).toHaveLength(1);
  });

  it("without the count header too (ESPN's cookie-bearing headers are unrecorded): empty, total unknown", async () => {
    const { w } = world(() => ({ body: withoutTxnKey() }));
    const r = await w.provider.listTransactions(w.ref, QUERY);
    expect(r.value.items).toEqual([]);
    expect(r.value.total).toBeNull();
    expect(w.drift.row).toBeNull();
    expect(txnCached(w)).toBe(true);
  });

  it("an unreadable count is no count: absent, empty, or not a non-negative integer reads as none", async () => {
    for (const v of ["", "abc", "-1", "1.5", "0x10", "1e3", "1234567890"]) {
      const { w } = world(() => ({
        body: withoutTxnKey(),
        headers: { [HEADER_TRANSACTION_COUNT]: v },
      }));
      const r = await w.provider.listTransactions(w.ref, QUERY);
      expect(r.value.items, v).toEqual([]);
      expect(w.drift.row, v).toBeNull();
    }
  });

  it("present as a list it is read as before", async () => {
    const { w } = world(() => ({
      body: { ...withoutTxnKey(), transactions: recordedTxns() },
      headers: { [HEADER_TRANSACTION_COUNT]: "2" },
    }));
    const r = await w.provider.listTransactions(w.ref, QUERY);
    expect(r.value.items.length).toBeGreaterThan(0);
    expect(r.value.total).toBe(2);
    expect(w.drift.row).toBeNull();
  });
});

describe("what stays drift (ESPN_DRIFT_DETECTED, red, nothing cached)", () => {
  const expectDrift = async (a: Answer) => {
    const { w, logs } = world(() => a);
    await expect(w.provider.listTransactions(w.ref, QUERY)).rejects.toMatchObject({
      effCode: "ESPN_DRIFT_DETECTED",
      effDetails: { view: "mTransactions2", path: "transactions" },
    });
    expect(w.drift.row?.status).toBe("red");
    expect(JSON.parse(w.drift.row?.diff_json ?? "[]")).toEqual([
      { view: "mTransactions2", removed: ["$.transactions"], added: [], enums: [] },
    ]);
    expect(txnCached(w)).toBe(false);
    return logs;
  };

  it("the unrecognised-view answer (the recorded P28 skeleton), whatever the count says; the log names the shape", async () => {
    for (const headers of [{}, { [HEADER_TRANSACTION_COUNT]: "0" }]) {
      const logs = await expectDrift({
        body: loadFixture("recorded/league-a/skeleton.json"),
        headers,
      });
      expect(logs.find((l) => l.event === "espn.drift")?.fields).toEqual({
        view: "mTransactions2",
        path: "$.transactions",
        kind: "skeleton",
        unrecognized_view: true,
      });
    }
  });

  it("a recognised answer's drift log says so (the live log could not tell the two apart)", async () => {
    const logs = await expectDrift({
      body: withoutTxnKey(),
      headers: { [HEADER_TRANSACTION_COUNT]: "3" },
    });
    expect(logs.find((l) => l.event === "espn.drift")?.fields).toMatchObject({
      view: "mTransactions2",
      kind: "skeleton",
      unrecognized_view: false,
    });
  });

  it("an absent list ESPN's count header says is not empty: ESPN counted transactions it did not send", async () => {
    for (const v of ["1", "3", " 2 ", "806"]) {
      const logs = await expectDrift({
        body: withoutTxnKey(),
        headers: { [HEADER_TRANSACTION_COUNT]: v },
      });
      const said = logs.find((l) => l.event === "espn.absent_contradicted");
      expect(said?.level, v).toBe("warn");
      expect(said?.fields, v).toEqual({
        view: "mTransactions2",
        path: "$.transactions",
        count: Number(v),
      });
    }
  });

  it("present with a non-list value", async () => {
    for (const bad of [{ a: 1 }, null, "none", 0, true]) {
      await expectDrift({
        body: { ...withoutTxnKey(), transactions: bad },
        headers: { [HEADER_TRANSACTION_COUNT]: "0" },
      });
    }
  });
});

/** A red row as the live runs left it: `$.transactions` removed, beside additive keys and enums. */
function liveRedRow(extra: { view: string; path: string } | null): DriftStateRow {
  const diffs: { view: string; removed: string[]; added: string[]; enums: string[] }[] = [
    { view: "mTransactions2", removed: ["$.transactions"], added: [], enums: [] },
    { view: "mSettings", removed: [], added: [], enums: ["$.status.waiverProcessStatus{}=7"] },
  ];
  if (extra !== null) diffs.push({ view: extra.view, removed: [extra.path], added: [], enums: [] });
  return {
    ...additiveRow(),
    status: "red",
    since: "2026-11-03T11:30:02.000Z",
    diff_json: JSON.stringify(diffs),
  };
}

describe("the live install's red row clears on the next such answer (src/drift applyRecovered, schema)", () => {
  it("$.transactions leaves the row; the additive keys and enum values stay; the status is additive", async () => {
    const { w } = world(() => ({ body: withoutTxnKey() }));
    w.drift.row = liveRedRow(null);
    const r = await w.provider.listTransactions(w.ref, QUERY);
    expect(r.value.items).toEqual([]);
    expect(w.drift.row.status).toBe("additive");
    expect(w.drift.row.since).toBeNull();
    expect(JSON.parse(w.drift.row.diff_json)).toEqual([
      { view: "mSettings", removed: [], added: [], enums: ["$.status.waiverProcessStatus{}=7"] },
    ]);
    expect(w.drift.row.additive_json).toBe(additiveRow().additive_json);
  });

  it("a complete answer (the list present) clears it the same way", async () => {
    const { w } = world(() => ({ body: { ...withoutTxnKey(), transactions: recordedTxns() } }));
    w.drift.row = liveRedRow(null);
    await w.provider.listTransactions(w.ref, QUERY);
    expect(w.drift.row.status).toBe("additive");
  });

  it("only the verified view clears: another view's removed key stays red", async () => {
    const { w } = world(() => ({ body: withoutTxnKey() }));
    w.drift.row = liveRedRow({ view: "mRoster", path: "$.teams[].roster.entries" });
    await w.provider.listTransactions(w.ref, QUERY);
    expect(w.drift.row.status).toBe("red");
    const diffs = JSON.parse(w.drift.row.diff_json) as { view: string; removed: string[] }[];
    expect(diffs.filter((d) => d.removed.length > 0).map((d) => [d.view, d.removed])).toEqual([
      ["mRoster", ["$.teams[].roster.entries"]],
    ]);
  });

  it("an answer that is still drift keeps the row red", async () => {
    const { w } = world(() => ({ body: loadFixture("recorded/league-a/skeleton.json") }));
    w.drift.row = liveRedRow(null);
    await expect(w.provider.listTransactions(w.ref, QUERY)).rejects.toMatchObject({
      effCode: "ESPN_DRIFT_DETECTED",
    });
    expect(w.drift.row.status).toBe("red");
    expect(w.drift.row.since).toBe("2026-11-03T11:30:02.000Z");
  });
});

describe("the in-call check excuses exactly the absent list, and only uncontradicted", () => {
  const checkBody = (
    w: ReturnType<typeof makeWorld>,
    views: EspnView[],
    body: unknown,
    headers?: Record<string, string>,
  ) =>
    (
      w.provider as unknown as {
        req: {
          checkBody(v: readonly EspnView[], b: unknown, h?: Record<string, string>): DriftCheck;
        };
      }
    ).req.checkBody(views, body, headers);

  it("alone: excused; beside a really drifted view: that view's signals stand; a count > 0 keeps it", () => {
    const { w } = world(() => ({ body: withoutTxnKey() }));
    expect(checkBody(w, ["mTransactions2"], withoutTxnKey())).toMatchObject({
      drifted: false,
      signals: [],
    });
    expect(
      checkBody(w, ["mTransactions2"], withoutTxnKey(), { [HEADER_TRANSACTION_COUNT]: "0" }),
    ).toMatchObject({ drifted: false });
    const both = checkBody(w, ["mTransactions2", "mRoster"], withoutTxnKey());
    expect(both).toMatchObject({ drifted: true, skeleton: true });
    expect(both.signals.map((s) => [s.kind, s.view, s.path])).toEqual([
      ["skeleton", "mRoster", "$.teams[].roster.entries"],
    ]);
    const counted = checkBody(w, ["mTransactions2"], withoutTxnKey(), {
      [HEADER_TRANSACTION_COUNT]: "4",
    });
    expect(counted).toMatchObject({ drifted: true, skeleton: true });
    expect(counted.first).toMatchObject({ view: "mTransactions2", path: "$.transactions" });
    // another view's count header name never contradicts this one
    expect(
      checkBody(w, ["mTransactions2"], withoutTxnKey(), { "x-fantasy-filter-player-count": "9" })
        .drifted,
    ).toBe(false);
    const p28 = checkBody(w, ["mTransactions2"], loadFixture("recorded/league-a/skeleton.json"));
    expect(p28).toMatchObject({ drifted: true, skeleton: true });
  });
});

describe("ABSENT_MEANS_EMPTY / ABSENT_LIST_COUNT_HEADER / absentListCount", () => {
  it("lists mTransactions2's seed path; the seed and the unverified list are unchanged", () => {
    expect(ABSENT_MEANS_EMPTY.mTransactions2).toEqual(["$.transactions"]);
    expect(ABSENT_MEANS_EMPTY.mPendingTransactions).toEqual(["$.pendingTransactions"]);
    expect(Object.keys(ABSENT_MEANS_EMPTY).sort()).toEqual([
      "mPendingTransactions",
      "mTransactions2",
    ]);
    expect(Object.isFrozen(ABSENT_MEANS_EMPTY)).toBe(true);
    expect(Object.isFrozen(ABSENT_MEANS_EMPTY.mTransactions2)).toBe(true);
    expect(REQUIRED_PATHS_BY_VIEW.mTransactions2).toEqual(["$.transactions"]);
    expect(REQUIRED_PATHS_UNVERIFIED).toContain("mTransactions2");
  });

  it("the count header is the view's own, and only a non-negative integer of ≤ 9 digits is a count", () => {
    expect(ABSENT_LIST_COUNT_HEADER).toEqual({ mTransactions2: HEADER_TRANSACTION_COUNT });
    expect(Object.isFrozen(ABSENT_LIST_COUNT_HEADER)).toBe(true);
    const h = (v: string) => ({ [HEADER_TRANSACTION_COUNT]: v });
    expect(absentListCount("mTransactions2", h("0"))).toBe(0);
    expect(absentListCount("mTransactions2", h(" 12 "))).toBe(12);
    expect(absentListCount("mTransactions2", h("999999999"))).toBe(999_999_999);
    for (const v of ["", "abc", "-1", "1.5", "1e3", "1234567890"])
      expect(absentListCount("mTransactions2", h(v)), v).toBeNull();
    expect(absentListCount("mTransactions2", {})).toBeNull();
    expect(absentListCount("mPendingTransactions", h("5"))).toBeNull();
  });

  it("names the absent key only on a recognised answer the count does not contradict; the parse fills it", () => {
    expect(absentMeansEmptyPaths("mTransactions2", withoutTxnKey())).toEqual(["$.transactions"]);
    expect(
      absentMeansEmptyPaths("mTransactions2", withoutTxnKey(), {
        [HEADER_TRANSACTION_COUNT]: "0",
      }),
    ).toEqual(["$.transactions"]);
    expect(
      absentMeansEmptyPaths("mTransactions2", withoutTxnKey(), {
        [HEADER_TRANSACTION_COUNT]: "1",
      }),
    ).toEqual([]);
    expect(
      absentMeansEmptyPaths("mTransactions2", { ...withoutTxnKey(), transactions: 1 }),
    ).toEqual([]);
    expect(
      absentMeansEmptyPaths("mTransactions2", loadFixture("recorded/league-a/skeleton.json")),
    ).toEqual([]);
    const out = absentAsEmpty("mTransactions2", withoutTxnKey()) as Record<string, unknown>;
    expect(out.transactions).toEqual([]);
    const present = { ...withoutTxnKey(), transactions: "x" };
    expect(absentAsEmpty("mTransactions2", present)).toBe(present);
  });
});
