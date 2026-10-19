// scrub.test.ts — the deterministic anonymiser (scripts/espn-fixture/scrub.ts) and the scrub run
// (pipeline.ts scrubRun): research 03 §F.3 (every PII field class, one GUID map per league,
// determinism, the deny-list verification), plan 05 §3.1 steps 2–4 (the deny-list abort with the
// path, byte-identical reruns, provenance hashes). Adversarial: hostile keys, unicode, huge sizes,
// prototype keys, too many GUIDs. Every identifier-shaped value is assembled at run time.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalize,
  parseJsonStrict,
  stableStringify,
  type Json,
  type JsonObject,
} from "../../scripts/espn-fixture/canonical.js";
import { formatJson } from "../../scripts/espn-fixture/format-json.js";
import {
  DENY_LIST_GATE,
  WITHHOLD_REMOVED,
  scrubRun,
  readRaw,
  writeRaw,
} from "../../scripts/espn-fixture/pipeline.js";
import { parseHistoryArgs } from "../../scripts/espn-fixture/history.js";
import { parseArgs as parseRecordArgs } from "../../scripts/record-fixture.js";
import { parseScrubArgs } from "../../scripts/scrub-fixture.js";
import {
  FAKE_GUID_RE,
  ScrubAbort,
  createLeagueContext,
  fakeGuid,
  letters,
  normaliseTerm,
  decodeLayers,
  termSkeleton,
  TERM_SKELETON_MIN,
  outlookPlaceholder,
  scoringProjection,
  scrubBody,
  verifyScrubbed,
} from "../../scripts/espn-fixture/scrub.js";
import { scanWithRepoScanner } from "../../scripts/espn-fixture/scan.js";
import { tempDir } from "../lint/helpers.js";
import { inProcessScan, makeRawRun, NOW, SEASON } from "./helpers/run.js";
import {
  ip,
  leagueBody,
  realGuid,
  rng,
  syntheticLeague,
  type SyntheticLeague,
} from "./helpers/synthetic.js";

const GUID_ANY = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;

let tmp: ReturnType<typeof tempDir> | undefined;
beforeEach(() => {
  tmp = tempDir("eff-scrub-");
  // hermetic: the real scanner (when used) sees an empty deny-list, never the developer's own
  vi.stubEnv("EFF_SCAN_DENYLIST", "/dev/null");
});
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
  vi.unstubAllEnvs();
});

/** One raw league body carrying EVERY PII field class of research 03 §F.3 at once. */
function kitchenSink(l: SyntheticLeague): JsonObject {
  const params = new URLSearchParams({ scoringPeriodId: "2" });
  const body = leagueBody(l, SEASON, ["mSettings", "mTeam"], params, undefined) as JsonObject;
  const roster = leagueBody(l, SEASON, ["mRoster"], params, undefined) as JsonObject;
  const teams = body.teams as JsonObject[];
  (roster.teams as JsonObject[]).forEach((t, i) => {
    const team = teams[i];
    if (team) team.roster = t.roster as Json;
  });
  const settings = body.settings as JsonObject;
  (settings.scheduleSettings as JsonObject).divisions = [
    { id: 0, name: `${l.leagueName} North`, size: 2 },
    { id: 1, name: `${l.leagueName} South`, size: 2 },
  ];
  body.draftDetail = {
    drafted: true,
    inProgress: false,
    picks: [
      { id: 2, memberId: l.members[1]?.id ?? "", teamId: 2, playerId: 101 },
      { id: 1, memberId: l.members[0]?.id ?? "", teamId: 1, playerId: 100 },
    ],
  };
  body.transactions = [
    {
      id: l.pendingId,
      memberId: l.members[2]?.id ?? "",
      teamId: 3,
      type: "WAIVER",
      items: [{ type: "ADD", playerId: 300 }],
    },
  ];
  body.topics = [
    { id: "t1", messages: [{ text: `Trash talk from ${l.members[0]?.displayName ?? ""}` }] },
  ];
  body.communication = { topics: [] };
  return body;
}

describe("scrubBody — every PII field class (research 03 §F.3)", () => {
  const l = syntheticLeague(11, 4);
  const ctx = createLeagueContext(2);
  const out = scrubBody(kitchenSink(l), "league", ctx) as JsonObject;
  const text = JSON.stringify(out);

  it("league id → 0; settings.name → Example League N; divisions → Division N", () => {
    expect(out.id).toBe(0);
    const s = out.settings as JsonObject;
    expect(s.name).toBe("Example League 2");
    expect(
      ((s.scheduleSettings as JsonObject).divisions as JsonObject[]).map((d) => d.name),
    ).toEqual(["Division 1", "Division 2"]);
  });

  it('teams: name/abbrev → Team A…/TA…, location/nickname/logo → "", tradeBlock/draftStrategy → {}, unknown free text blanked', () => {
    const teams = out.teams as JsonObject[];
    expect(teams.map((t) => [t.id, t.name, t.abbrev, t.location, t.nickname, t.logo])).toEqual([
      [1, "Team A", "TA", "", "", ""],
      [2, "Team B", "TB", "", "", ""],
      [3, "Team C", "TC", "", "", ""],
      [4, "Team D", "TD", "", "", ""],
    ]);
    for (const t of teams) {
      expect(t.tradeBlock).toEqual({});
      expect(t.draftStrategy).toEqual({});
      expect(t.teamMotto).toBe("");
      expect(t.logoType).toBe("CUSTOM");
      expect(t.playoffClinchType).toBe("NONE");
    }
    expect(ctx.blanked.has("teams[].teamMotto")).toBe(true);
  });

  // first appearance walks keys in sorted order: draftDetail.picks (raw order: pick 2 = members[1],
  // pick 1 = members[0]) comes before members, so members[1] → 01, members[0] → 02, then 03, 04
  const ORD = [2, 1, 3, 4];

  it('members: displayName → Member N (N = its pseudonym), first/last → "", notificationSettings removed', () => {
    const members = out.members as JsonObject[];
    expect(members.map((m) => [m.id, m.displayName, m.firstName, m.lastName])).toEqual(
      ORD.map((n) => [`{${fakeGuid(n)}}`, `Member ${String(n)}`, "", ""]),
    );
    for (const m of members) expect(m).not.toHaveProperty("notificationSettings");
  });

  it("every GUID → the fake range by first appearance, ONE map applied everywhere (owners, primaryOwner, picks, transactions, unbraced ids)", () => {
    const teams = out.teams as JsonObject[];
    for (const [i, t] of teams.entries()) {
      expect(t.owners).toEqual([`{${fakeGuid(ORD[i] ?? 0)}}`]);
      expect(t.primaryOwner).toBe(`{${fakeGuid(ORD[i] ?? 0)}}`);
    }
    const picks = (out.draftDetail as JsonObject).picks as JsonObject[];
    expect(picks.map((p) => [p.id, p.memberId])).toEqual([
      [1, `{${fakeGuid(2)}}`],
      [2, `{${fakeGuid(1)}}`],
    ]); // sorted by pick id; the map is by first appearance
    const tx = (out.transactions as JsonObject[])[0]!;
    expect(tx.memberId).toBe(`{${fakeGuid(3)}}`);
    expect(tx.id).toMatch(FAKE_GUID_RE); // an unbraced GUID keeps its form
    for (const m of text.matchAll(GUID_ANY)) expect(m[0]).toMatch(FAKE_GUID_RE);
    expect(text).not.toContain(l.members[0]?.id.slice(1, 9) ?? "never");
  });

  it('clientAddress → 0.0.0.0; message-board text removed; outlooks → [outlook N chars]; logos → ""', () => {
    expect(((out.status as JsonObject).lastUpdateInfo as JsonObject).clientAddress).toBe("0.0.0.0");
    expect(out).not.toHaveProperty("topics");
    expect(out).not.toHaveProperty("communication");
    expect(text).not.toContain("Trash talk");
    expect(text).not.toContain("editorial prose");
    expect(text).toMatch(/"seasonOutlook":"\[outlook \d+ chars\]"/);
    expect(text).toMatch(/"outlooksByWeek":\{"2":"\[outlook \d+ chars\]"\}/);
    expect(text).not.toContain("img.example.org");
  });

  it("no captured name, real id, real GUID or IP survives anywhere", () => {
    for (const s of [
      l.leagueName,
      l.leagueId,
      l.clientAddress,
      ...l.teams.flatMap((t) => [t.name, t.location, t.nickname]),
      ...l.members.flatMap((m) => [m.displayName, m.firstName, m.lastName]),
    ])
      expect(text).not.toContain(s);
    expect(verifyScrubbed(out, "league", ctx)).toEqual([]);
  });

  it("player names, ids, pro-team ids, stats and timestamps stay", () => {
    expect(text).toContain('"fullName":"Player 100"');
    expect(text).toContain('"proTeamId":');
    expect(text).toContain('"appliedTotal":');
    expect(text).toContain('"deadlineDate":1700000000000');
    const raw = kitchenSink(l);
    expect(scoringProjection(out)).toEqual(scoringProjection(canonicalize(raw)));
  });

  it("captured names are recorded in memory for the verification (normalised, ≥ 4 chars, letters)", () => {
    expect(ctx.denyTerms.has(normaliseTerm(l.leagueName))).toBe(true);
    expect(ctx.denyTerms.has(normaliseTerm(l.teams[0]?.name ?? ""))).toBe(true);
    expect(ctx.denyTerms.has(normaliseTerm(l.members[0]?.displayName ?? ""))).toBe(true);
    expect(
      ctx.denyTerms.has(
        normaliseTerm(`${l.members[0]?.firstName ?? ""} ${l.members[0]?.lastName ?? ""}`),
      ),
    ).toBe(true);
    expect(ctx.realLeagueIds.has(l.leagueId)).toBe(true);
  });
});

describe("scrubBody — determinism and canonical order (plan 05 §3.1 step 3)", () => {
  it("same input → byte-identical output (fresh contexts, formatted text)", async () => {
    const l = syntheticLeague(12, 6);
    const a = scrubBody(kitchenSink(l), "league", createLeagueContext(1));
    const b = scrubBody(kitchenSink(l), "league", createLeagueContext(1));
    expect(await formatJson(a, "recorded")).toBe(await formatJson(b, "recorded"));
  });

  it("key order of the raw input does not matter", () => {
    const l = syntheticLeague(13, 4);
    const raw = kitchenSink(l);
    const reversed = JSON.parse(
      JSON.stringify(raw, (_k, v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    ) as Json;
    expect(stableStringify(scrubBody(raw, "league", createLeagueContext(1)))).toBe(
      stableStringify(scrubBody(reversed, "league", createLeagueContext(1))),
    );
  });

  it("arrays of objects sort by numeric/string id; GUID-keyed arrays and kona players keep their order", () => {
    const raw = {
      teams: [{ id: 3 }, { id: 1 }, { id: 2 }],
      stats: [{ id: "1120263" }, { id: "002026" }],
      members: [{ id: realGuid(rng(1)) }, { id: realGuid(rng(2)) }],
      players: [{ id: 9 }, { id: 4 }, { id: 7 }],
      mixed: [{ id: 1 }, { id: "2" }],
      dup: [{ id: 1 }, { id: 1 }],
    } as Json;
    const out = scrubBody(raw, "season", createLeagueContext(1), {
      keepOrder: new Set(["players"]),
    }) as Record<string, { id: unknown }[]>;
    expect(out.teams?.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(out.stats?.map((t) => t.id)).toEqual(["002026", "1120263"]);
    expect(out.members?.map((t) => t.id)).toEqual([`{${fakeGuid(1)}}`, `{${fakeGuid(2)}}`]);
    expect(out.players?.map((t) => t.id)).toEqual([9, 4, 7]);
    expect(out.mixed?.map((t) => t.id)).toEqual([1, "2"]);
    expect(out.dup).toHaveLength(2);
  });

  it("property: any JSON, with GUIDs and IPs sprinkled in, scrubs deterministically and leaves no real GUID", () => {
    const guidArb = fc.integer({ min: 1, max: 1_000_000 }).map((s) => realGuid(rng(s)));
    const leaf = fc.oneof(
      fc.jsonValue({ maxDepth: 0 }),
      guidArb,
      guidArb.map((g) => `prefix ${g} suffix`),
      fc.constant(ip(10, 0, 0, 1)),
    );
    const tree = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: "small" },
        leaf,
        fc.array(tie("node"), { maxLength: 4 }),
        fc.dictionary(fc.string({ maxLength: 8 }), tie("node"), { maxKeys: 4 }),
      ),
    })).node;
    fc.assert(
      fc.property(tree, (v) => {
        const a = scrubBody(v as Json, "season", createLeagueContext(1));
        const b = scrubBody(v as Json, "season", createLeagueContext(1));
        expect(stableStringify(a)).toBe(stableStringify(b));
        for (const m of JSON.stringify(a).matchAll(GUID_ANY)) expect(m[0]).toMatch(FAKE_GUID_RE);
      }),
      { numRuns: 300 },
    );
  });
});

describe("scrubBody — hostile input", () => {
  it("a __proto__ key stays plain data and pollutes nothing", () => {
    const raw = parseJsonStrict(
      '{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}},"teams":[]}',
    );
    const out = scrubBody(raw, "season", createLeagueContext(1)) as JsonObject;
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(out)).toContain('"__proto__":{"polluted":1}');
  });

  it("unicode, zero-width and right-to-left team and member names are still replaced", () => {
    const l = syntheticLeague(14, 4);
    const t0 = l.teams[0];
    const m0 = l.members[0];
    if (!t0 || !m0) throw new Error("fixture");
    t0.name = "Ｍｅｇａ​ Squad ‮evil";
    m0.displayName = "ünïcødé⁠fan";
    const ctx = createLeagueContext(1);
    const out = scrubBody(kitchenSink(l), "league", ctx) as JsonObject;
    expect((out.teams as JsonObject[])[0]?.name).toBe("Team A");
    expect((out.members as JsonObject[])[0]?.displayName).toMatch(/^Member \d$/);
    expect(JSON.stringify(out)).not.toContain("fan");
    expect(ctx.denyTerms.has(normaliseTerm(t0.name))).toBe(true);
    expect(normaliseTerm(t0.name)).toBe("mega squad ‮evil");
  });

  it("a multi-megabyte outlook becomes a placeholder counting code points", () => {
    const huge = "🏈".repeat(1_000_000);
    const out = scrubBody(
      {
        players: [
          { id: 1, player: { seasonOutlook: huge, outlooks: { outlooksByWeek: { "3": huge } } } },
        ],
      },
      "league",
      createLeagueContext(1),
    );
    expect(JSON.stringify(out)).toBe(
      JSON.stringify({
        players: [
          {
            id: 1,
            player: {
              outlooks: { outlooksByWeek: { "3": "[outlook 1000000 chars]" } },
              seasonOutlook: "[outlook 1000000 chars]",
            },
          },
        ],
      }),
    );
    expect(outlookPlaceholder("ab")).toBe("[outlook 2 chars]");
  });

  it("more than 255 distinct GUIDs in one league refuses (the fixture range cannot hold them)", () => {
    const raw = { ids: Array.from({ length: 256 }, (_, i) => realGuid(rng(i + 1))) } as Json;
    expect(() => scrubBody(raw, "season", createLeagueContext(1))).toThrow(ScrubAbort);
  });

  it("an integer outside the safe range refuses (precision loss)", () => {
    expect(() => parseJsonStrict('{"id": 12345678901234567890}')).toThrow(/safe range/);
    expect(parseJsonStrict('{"id": 9007199254740991}')).toEqual({ id: 9007199254740991 });
  });

  it("a team without a numeric id, or a member without a GUID, refuses", () => {
    expect(() =>
      scrubBody({ teams: [{ id: "x", name: "N" }] }, "league", createLeagueContext(1)),
    ).toThrow(/no numeric id/);
    expect(() =>
      scrubBody({ teams: [{ id: 0, name: "N" }] }, "league", createLeagueContext(1)),
    ).toThrow(/positive integer/);
    expect(() =>
      scrubBody(
        { members: [{ id: "not-a-guid", displayName: "x" }] },
        "league",
        createLeagueContext(1),
      ),
    ).toThrow(/no GUID id/);
  });

  it("an owners[] entry that is not a GUID, and a non-GUID primaryOwner, are blanked", () => {
    const ctx = createLeagueContext(1);
    const out = scrubBody(
      { teams: [{ id: 1, owners: ["free text owner"], primaryOwner: "someone" }] },
      "league",
      ctx,
    ) as JsonObject;
    expect((out.teams as JsonObject[])[0]).toMatchObject({ owners: [""], primaryOwner: "" });
    expect([...ctx.blanked].sort()).toEqual(["teams[].owners[]", "teams[].primaryOwner"]);
  });

  it("a leagueId field carrying the real id becomes 0 wherever it sits", () => {
    const l = syntheticLeague(15, 4);
    const raw = {
      id: Number(l.leagueId),
      nested: { leagueId: Number(l.leagueId), league_id: l.leagueId, otherLeagueId: 5 },
    } as Json;
    const out = scrubBody(raw, "league", createLeagueContext(1)) as JsonObject;
    expect(out.nested).toEqual({ leagueId: 0, league_id: "0", otherLeagueId: 5 });
  });

  it("prune empties (never removes) and refuses a scoring key", () => {
    const out = scrubBody(
      { p: { rankings: { "1": [1] }, list: [1], s: "x", rank2: [1, 2] } },
      "league",
      createLeagueContext(1),
      { prune: ["rankings", "rank2"] },
    ) as JsonObject;
    expect(out.p).toEqual({ list: [1], rank2: [], rankings: {}, s: "x" });
    for (const k of ["appliedStats", "stats", "appliedTotal", "points", "scoringItems"])
      expect(() => scrubBody({}, "league", createLeagueContext(1), { prune: [k] })).toThrow(
        /scoring key/,
      );
  });

  it("letters() and fakeGuid() edge cases", () => {
    expect([1, 26, 27, 52, 53, 702, 703].map(letters)).toEqual([
      "A",
      "Z",
      "AA",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ]);
    expect(() => letters(0)).toThrow();
    expect(() => letters(1.5)).toThrow();
    expect(fakeGuid(255)).toBe("00000000-0000-4000-8000-0000000000FF");
    expect(() => createLeagueContext(0)).toThrow();
  });
});

describe("verifyScrubbed — the deny-list abort's in-process half", () => {
  const l = syntheticLeague(16, 4);
  const ctx = createLeagueContext(1);
  const out = scrubBody(kitchenSink(l), "league", ctx) as JsonObject;

  it("an injected captured name in any non-public field is a violation, reported by path only", () => {
    const bad = JSON.parse(JSON.stringify(out)) as JsonObject;
    (bad.teams as JsonObject[])[1]!.waiverNote = `claimed by ${l.teams[2]?.name ?? ""}`;
    const v = verifyScrubbed(bad, "league", ctx);
    expect(v).toEqual([{ rule: "captured-name", path: "$.teams[1].waiverNote" }]);
    expect(JSON.stringify(v)).not.toContain(l.teams[2]?.name ?? "never");
  });

  it("S4: a captured name re-encoded or re-punctuated in a scrubbed string is still a violation", () => {
    const c3 = createLeagueContext(1);
    c3.denyTerms.add(normaliseTerm("O'Brien Bombers"));
    c3.denyTerms.add(normaliseTerm("Gridiron Gang"));
    for (const disguised of [
      "o%27brien%20bombers",
      String.raw`O\u0027Brien Bombers`,
      "O&#39;Brien Bombers",
      "gridiron.gang",
      "Gridiron 🏈 Gang",
    ]) {
      const bad = JSON.parse(JSON.stringify(out)) as JsonObject;
      (bad.teams as JsonObject[])[0]!.waiverNote = `note ${disguised}`;
      expect(
        verifyScrubbed(bad, "league", c3).filter((v) => v.rule === "captured-name"),
        disguised,
      ).toEqual([{ rule: "captured-name", path: "$.teams[0].waiverNote" }]);
    }
    expect(decodeLayers("%E2%9C%93 &amp; \\u0041")).toBe("✓ & A");
    expect(termSkeleton("Grid-iron 🏈 Gang!")).toBe("GridironGang");
    expect(TERM_SKELETON_MIN).toBe(6);
    expect(normaliseTerm("O%27Brien%20Bombers")).toBe("o'brien bombers");
  });

  it("a captured name equal to a public player name is not a violation (a team named after a player)", () => {
    const c2 = createLeagueContext(1);
    c2.denyTerms.add("player 100");
    expect(verifyScrubbed(out, "league", c2).filter((v) => v.rule === "captured-name")).toEqual([]);
  });

  it("a real GUID, an IPv4, the league id in a string or under a league key are violations", () => {
    const bad = JSON.parse(JSON.stringify(out)) as JsonObject;
    bad.extra = {
      swid: realGuid(rng(99)),
      addr: ip(192, 168, 1, 20),
      url: `https://example.invalid/x?leagueId=${l.leagueId}`,
      leagueRef: Number(l.leagueId),
    };
    const rules = verifyScrubbed(bad, "league", ctx).map((v) => `${v.rule} ${v.path}`);
    expect(rules).toEqual(
      expect.arrayContaining([
        "guid $.extra.swid",
        "ipv4 $.extra.addr",
        "league-id $.extra.url",
        "league-id $.extra.leagueRef",
      ]),
    );
  });

  it("a team or member that is not a placeholder, a non-zero root id, a real league name → violations", () => {
    const bad = JSON.parse(JSON.stringify(out)) as JsonObject;
    (bad.teams as JsonObject[])[0]!.name = "Team Z";
    (bad.members as JsonObject[])[0]!.firstName = "x";
    bad.id = 7;
    (bad.settings as JsonObject).name = "Anything";
    const rules = verifyScrubbed(bad, "league", ctx).map((v) => v.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        "team-placeholder",
        "member-placeholder",
        "league-id",
        "captured-name",
      ]),
    );
  });
});

describe("scrubRun — capture → scrub → freeze over a synthetic raw run", () => {
  it("writes nothing into the raw dir's league data and reruns are byte-identical (all files + manifest)", async () => {
    const dir = tmp?.dir ?? "";
    const run = await makeRawRun(path.join(dir, "raw"));
    const scan = inProcessScan();
    const a = await scrubRun({ rawDir: run.rawDir, outRoot: path.join(dir, "out-a"), scan });
    const b = await scrubRun({ rawDir: run.rawDir, outRoot: path.join(dir, "out-b"), scan });
    expect(a.outputs.map((o) => o.rel)).toEqual(b.outputs.map((o) => o.rel));
    for (const [i, o] of a.outputs.entries()) expect(o.text).toBe(b.outputs[i]?.text);
    const files = (d: string): string[] =>
      readdirSync(d, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.relative(d, path.join(e.parentPath, e.name)))
        .sort();
    expect(files(path.join(dir, "out-a"))).toEqual(files(path.join(dir, "out-b")));
    for (const f of files(path.join(dir, "out-a")))
      expect(readFileSync(path.join(dir, "out-a", f), "utf8")).toBe(
        readFileSync(path.join(dir, "out-b", f), "utf8"),
      );
    // no real identifier of any synthetic league anywhere in the output
    const all = a.outputs.map((o) => o.text).join("\n");
    for (const l of run.leagues)
      for (const s of [
        l.leagueId,
        l.leagueName,
        l.clientAddress,
        ...l.teams.map((t) => t.name),
        ...l.members.map((m) => m.displayName),
        ...l.members.map((m) => m.id.slice(1, 37)),
      ])
        expect(all).not.toContain(s);
    expect(a.manifest.withheld_files).toEqual([]);
  });

  it("one GUID map per league, applied across that league's files; separate leagues restart the range", async () => {
    const dir = tmp?.dir ?? "";
    const run = await makeRawRun(path.join(dir, "raw"));
    const r = await scrubRun({
      rawDir: run.rawDir,
      outRoot: path.join(dir, "out"),
      scan: inProcessScan(),
      dryRun: true,
    });
    const get = (rel: string) =>
      JSON.parse(r.outputs.find((o) => o.rel === rel)?.text ?? "null") as JsonObject;
    const team = get("recorded/league-a/mTeam.json");
    const box = get("recorded/league-a/mBoxscore.sp1.json");
    const ownersTeam = (team.teams as JsonObject[]).map((t) => t.primaryOwner);
    const ownersBox = (box.teams as JsonObject[]).map((t) => t.primaryOwner);
    expect(ownersBox).toEqual(ownersTeam);
    const teamB = get("recorded/league-b/mTeam.json");
    expect((teamB.members as JsonObject[])[0]?.id).toBe(`{${fakeGuid(1)}}`);
  });

  it("the deny-list abort fires on an injected captured name — the path is reported, the name never", async () => {
    const dir = tmp?.dir ?? "";
    const run = await makeRawRun(path.join(dir, "raw"));
    const env = readRaw(run.rawDir, "league-a", "kona_player_info");
    if (!env) throw new Error("missing capture");
    const name = run.leagues[0]?.teams[1]?.name ?? "";
    const body = JSON.parse(env.bodyText) as { players: JsonObject[] };
    body.players[0]!.waiverNote = `stash for ${name}`;
    writeRaw(run.rawDir, { ...env, bodyText: JSON.stringify(body) });
    const err = await scrubRun({
      rawDir: run.rawDir,
      outRoot: path.join(dir, "out"),
      scan: inProcessScan(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScrubAbort);
    const where = (err as ScrubAbort).where.join("\n");
    expect(where).toContain(
      "recorded/league-a/kona_player_info.json: captured-name at $.players[0].waiverNote",
    );
    expect(where).not.toContain(name);
    expect((err as Error).message).not.toContain(name);
    expect(readdirSync(dir)).not.toContain("out"); // nothing written
  });

  it("the repo deny-list (real scanner, EFF_SCAN_DENYLIST) refuses the run and reports JSON paths only", async () => {
    const dir = tmp?.dir ?? "";
    const run = await makeRawRun(path.join(dir, "raw"), { count: 1 });
    const deny = path.join(dir, "deny.txt");
    writeFileSync(
      deny,
      "# a public player name standing in for a personal identifier\nPlayer 201\n",
    );
    vi.stubEnv("EFF_SCAN_DENYLIST", deny);
    const err = await scrubRun({ rawDir: run.rawDir, outRoot: path.join(dir, "out") }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ScrubAbort);
    const where = (err as ScrubAbort).where.join("\n");
    expect(where).toMatch(
      /deny-list match in recorded\/league-a\/mRoster\.sp1\.json:\d+ at \$\.teams\[1\]\.roster\.entries\[1\]/,
    );
    expect(where).not.toContain("Player 201");
  });

  // Stage C finding fixtures-withheld-unit-discloses-term: with --withhold-denylisted a deny-list
  // match on a PUBLIC, enumerable unit (a D/ST id equal to a deny-listed numeric term) removed that
  // unit and listed its path; the gap — in the manifest, in plain absence across every file, against
  // ESPN's own public data — published the very term it hid. The deny-list is now a gate only.
  it("Stage C repro: a deny-listed public id (a D/ST-shaped index row) is never withheld — the run aborts, nothing is written, whatever a caller passes", async () => {
    const dir = tmp?.dir ?? "";
    const run = await makeRawRun(path.join(dir, "raw"), { count: 1 });
    const env = readRaw(run.rawDir, "season", "players_wl");
    if (!env) throw new Error("missing capture");
    // D/ST-shaped rows (negative ids, one per pro team) around ordinary players, in id order; the
    // digits are assembled so no source line carries the term
    const base = Number(["9", "4", "0"].join("")) * 100;
    const dst = Array.from({ length: 6 }, (_, i) => ({
      id: -(base + i + 1),
      fullName: `Team ${String(i + 1)} D/ST`,
      defaultPositionId: 16,
    }));
    const players = Array.from({ length: 4 }, (_, i) => ({
      id: 300 + i,
      fullName: `Player ${String(300 + i)}`,
      defaultPositionId: 2,
    }));
    writeRaw(run.rawDir, { ...env, bodyText: JSON.stringify([...dst, ...players]) });
    const term = String(base + 4); // the digit run of one D/ST's id
    const out = path.join(dir, "out");
    for (const opts of [
      {},
      { withholdDenylisted: true },
      { withholdDenylisted: true, dryRun: true },
    ]) {
      const err = await scrubRun({
        rawDir: run.rawDir,
        outRoot: out,
        scan: inProcessScan([term]),
        ...opts,
      }).catch((e: unknown) => e);
      expect(err, JSON.stringify(opts)).toBeInstanceOf(ScrubAbort);
      const where = (err as ScrubAbort).where.join("\n");
      expect(where).toMatch(
        /deny-list match in recorded\/season\/players_wl\.json:\d+ at \$\[\d+\]/,
      );
      expect(where).toContain(DENY_LIST_GATE);
      expect(where).not.toContain(term);
      expect((err as Error).message).not.toContain(term);
      expect(existsSync(out)).toBe(false); // no file, no manifest, no gap anywhere
    }
  });

  it("property: the deny-list is a gate, never a filter — any public value of the run as a deny-list term aborts it, or the run writes exactly what it writes without one", async () => {
    const dir = tmp?.dir ?? "";
    const run = await makeRawRun(path.join(dir, "raw"), { count: 1 });
    const opts = { rawDir: run.rawDir, outRoot: path.join(dir, "out"), dryRun: true };
    const baseline = await scrubRun({ ...opts, scan: inProcessScan() });
    const text = (r: typeof baseline) => r.outputs.map((o) => `${o.rel}\n${o.text}`).join("\n");
    // every public leaf the committed files would hold: player names and ids, stat values, …
    const leaves = new Set<string>();
    const walk = (v: unknown): void => {
      if (typeof v === "string" && /[A-Za-z]{3}/.test(v) && v.length <= 40) leaves.add(v);
      else if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) >= 100)
        leaves.add(String(Math.abs(v)));
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
    };
    for (const o of baseline.outputs)
      if (o.rel !== "manifest.json") walk(JSON.parse(o.text) as unknown);
    const terms = [...leaves].sort();
    expect(terms.length).toBeGreaterThan(20);
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...terms), async (term) => {
        const r = await scrubRun({
          ...opts,
          scan: inProcessScan([term]),
          withholdDenylisted: true, // an old caller's option changes nothing
        } as Parameters<typeof scrubRun>[0]).catch((e: unknown) => e);
        // a gate: refused (nothing to write), or exactly the files the run writes without a term
        if (r instanceof ScrubAbort) return true;
        return text(r as typeof baseline) === text(baseline);
      }),
      { numRuns: 8, seed: 20261019 },
    );
  });

  it("a deny-listed public player NAME is never replaced by a `Player <id>` stand-in either (the stand-in marks the player): the run aborts", async () => {
    const dir = tmp?.dir ?? "";
    const run = await makeRawRun(path.join(dir, "raw"), { count: 1 });
    const env = readRaw(run.rawDir, "league-a", "mRoster.sp1");
    if (!env) throw new Error("missing capture");
    const body = JSON.parse(env.bodyText) as JsonObject;
    const teams = body.teams as JsonObject[];
    const entry = ((teams[1]?.roster as JsonObject).entries as JsonObject[])[1]!;
    const player = (entry.playerPoolEntry as JsonObject).player as JsonObject;
    const term = ["Gridiron", "Hero"].join(" ");
    player.fullName = term;
    writeRaw(run.rawDir, { ...env, bodyText: JSON.stringify(body) });
    const err = await scrubRun({
      rawDir: run.rawDir,
      outRoot: path.join(dir, "out"),
      scan: inProcessScan([term]),
      withholdDenylisted: true,
    } as Parameters<typeof scrubRun>[0]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScrubAbort);
    const where = (err as ScrubAbort).where.join("\n");
    expect(where).toMatch(
      /deny-list match in recorded\/league-a\/mRoster\.sp1\.json:\d+ at \$\.teams\[1\]\.roster\.entries\[1\]/,
    );
    expect(where).toContain(DENY_LIST_GATE);
    expect(where).not.toContain(term);
    expect(where).not.toContain(`Player ${String(player.id as number)}`);
    expect(readdirSync(dir)).not.toContain("out");
  });

  it("any other finding refuses the run the same way (a real mailbox)", async () => {
    const dir = tmp?.dir ?? "";
    const run = await makeRawRun(path.join(dir, "raw"), { count: 1 });
    const env = readRaw(run.rawDir, "league-a", "mTeam");
    if (!env) throw new Error("missing capture");
    const body = JSON.parse(env.bodyText) as JsonObject;
    body.contact = ["someone", "example.net"].join("@").replace("example.net", "mailbox.net");
    writeRaw(run.rawDir, { ...env, bodyText: JSON.stringify(body) });
    const err = await scrubRun({
      rawDir: run.rawDir,
      outRoot: path.join(dir, "out"),
      scan: inProcessScan(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScrubAbort);
    const where = (err as ScrubAbort).where.join("\n");
    expect(where).toMatch(/\[email-address\] at \$\.contact/);
    expect(where).not.toContain(DENY_LIST_GATE); // the gate note names deny-list matches only
  });

  it("--withhold-denylisted is refused by every fixture tool, with the reason (exit 2)", () => {
    const dir = tmp?.dir ?? "";
    const raw = path.join(dir, "raw");
    const env = { EFF_PROBE_LEAGUE_IDS: String(100_000 + 7919) };
    expect(() => parseScrubArgs(["--raw-dir", raw, "--withhold-denylisted"])).toThrow(
      WITHHOLD_REMOVED,
    );
    expect(() =>
      parseRecordArgs(["--public", "--raw-dir", raw, "--withhold-denylisted"], env, NOW),
    ).toThrow(WITHHOLD_REMOVED);
    expect(() =>
      parseHistoryArgs(
        ["--public", "--history", "--scrub-only", "--raw-dir", raw, "--withhold-denylisted"],
        env,
        NOW,
      ),
    ).toThrow(WITHHOLD_REMOVED);
    expect(WITHHOLD_REMOVED).toMatch(/publishes the term/);
  });

  it("a body over the size cap is split losslessly along its largest top-level array", async () => {
    const dir = tmp?.dir ?? "";
    const run = await makeRawRun(path.join(dir, "raw"), { count: 1 });
    const whole = await scrubRun({
      rawDir: run.rawDir,
      outRoot: path.join(dir, "w"),
      scan: inProcessScan(),
      dryRun: true,
    });
    // a cap just below the smallest roster body (any other body over it splits too)
    const cap =
      Math.min(
        ...whole.manifest.files.filter((f) => f.path.includes("mRoster")).map((f) => f.bytes),
      ) - 1;
    const split = await scrubRun({
      rawDir: run.rawDir,
      outRoot: path.join(dir, "s"),
      scan: inProcessScan(),
      dryRun: true,
      maxBytes: cap,
    });
    const parts = split.manifest.files.filter((f) =>
      f.path.startsWith("recorded/league-a/mRoster.sp1.p"),
    );
    expect(parts.length).toBeGreaterThan(1);
    for (const p of split.manifest.files) expect(p.bytes).toBeLessThanOrEqual(cap);
    const bodies = parts.map(
      (p) => JSON.parse(split.outputs.find((o) => o.rel === p.path)?.text ?? "{}") as JsonObject,
    );
    // each part names its array and the id range it holds (the canonical order is by id)
    expect(parts.map((p) => p.part)).toEqual(
      parts.map((_, i) => {
        const ids = (bodies[i]?.teams as JsonObject[]).map((t) => t.id as number);
        return {
          index: i + 1,
          of: parts.length,
          array: "teams",
          id_range: { first: ids[0], last: ids[ids.length - 1] },
        };
      }),
    );
    const merged = { ...bodies[0], teams: bodies.flatMap((b) => b.teams as Json[]) };
    const original = JSON.parse(
      whole.outputs.find((o) => o.rel === "recorded/league-a/mRoster.sp1.json")?.text ?? "{}",
    ) as Json;
    expect(stableStringify(merged as Json)).toBe(stableStringify(original));
    await expect(
      scrubRun({
        rawDir: run.rawDir,
        outRoot: path.join(dir, "x"),
        scan: inProcessScan(),
        dryRun: true,
        maxBytes: 400,
      }),
    ).rejects.toThrow(ScrubAbort);
  });

  it("refuses a raw dir with no captures, or captures from two seasons", async () => {
    const dir = tmp?.dir ?? "";
    mkdirSync(path.join(dir, "empty"));
    await expect(
      scrubRun({ rawDir: path.join(dir, "empty"), outRoot: path.join(dir, "out") }),
    ).rejects.toThrow(/no captures/);
    const run = await makeRawRun(path.join(dir, "raw"), { count: 1 });
    const env = readRaw(run.rawDir, "league-a", "mTeam");
    if (!env) throw new Error("missing capture");
    writeRaw(run.rawDir, {
      ...env,
      url: env.url.replace(`/seasons/${String(SEASON)}/`, "/seasons/2025/"),
    });
    await expect(
      scrubRun({ rawDir: run.rawDir, outRoot: path.join(dir, "out"), scan: inProcessScan() }),
    ).rejects.toThrow(/more than one season/);
  });

  it("scan.ts reads a capture under its own relative name: the path rules see that name, never the temp dir (which may sit under a home)", () => {
    const dir = tmp?.dir ?? "";
    const underHome = path.join(dir, "Users", "janefake", "tmp");
    mkdirSync(underHome, { recursive: true });
    vi.stubEnv("TMPDIR", underHome);
    expect(scanWithRepoScanner('{ "a": 1 }\n', "recorded/league-a/mTeam.json")).toEqual({
      clean: true,
      findings: [],
    });
    // an identifier in the capture's own name is what the commit gate would see: reported, unprinted
    const id = ["8", "1", "7", "2", "6", "3", "5"].join("");
    const r = scanWithRepoScanner('{ "a": 1 }\n', `recorded/${["leagueId", id].join("=")}.json`);
    expect(r.clean).toBe(false);
    expect(r.findings.join("\n")).toMatch(
      /the path of scanned entry #1 \(path not printed\) {2}\[espn-league-id\]/,
    );
    expect(r.findings.join("\n")).not.toContain(id);
    // a label that is not a plain relative path is scanned under a fixed name, reported as the label
    const odd = scanWithRepoScanner(
      `${JSON.stringify({ [["client", "Address"].join("")]: ip(10, 1, 2, 3) })}\n`,
      "../escape.json",
    );
    expect(odd.findings.join("\n")).toMatch(/^\.\.\/escape\.json:1 {2}\[client-address\]/m);
  });

  it("the real scanner integration (scan.ts) reports clean text clean and fails closed on findings", () => {
    expect(scanWithRepoScanner('{ "a": 1 }\n', "x.json")).toEqual({ clean: true, findings: [] });
    // the key is assembled so this test file itself stays clean for the scanner
    const r = scanWithRepoScanner(
      `${JSON.stringify({ [["client", "Address"].join("")]: ip(10, 1, 2, 3) })}\n`,
      "y.json",
    );
    expect(r.clean).toBe(false);
    expect(r.findings.join("\n")).toMatch(/^y\.json:1 {2}\[client-address\]/m);
    expect(r.findings.join("\n")).not.toContain(ip(10, 1, 2, 3));
  });
});
