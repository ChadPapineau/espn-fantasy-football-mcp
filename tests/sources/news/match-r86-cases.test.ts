// match-r86-cases.test.ts — every case the earlier rounds of the news matcher's shared-name work
// wrote down, held at its ruling R8-6 outcome (docs/plan/changelog.md §R8, §B9 "R8-6 — the matcher
// fails closed" and "R8-6 fix round 2"; src/sources/news/match.ts, labels.ts). Five sets: the final
// gate's own batteries (gk-homonyms*.mts of its fourth run, at f41e810, kept outside the repo), each
// title with its label; the 16 violations the last attack on R8-3 left open (at dbe9686); every
// misattribution the independent attacks on R8-3's three fix rounds found (their batteries, kept with
// the orchestrator: 443 texts, each with the label of whose item it is); every text of the R8-3 test
// files R8-6 replaces (match-r83*.test.ts); and the attack on R8-6's first build (at 6ba7bb1): its 23
// violations with their variants, and its batteries' titles. An outcome is the item's refs
// ("Name/TEAM/POS:method") and how many shared names no one took ("u1", R8-6 (d)). No network. Only
// exports f41e810 already had are read at the top level.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeName } from "../../../src/domain/crosswalk/normalize.js";
import { playersRows } from "../../../src/sources/espn_season/index.js";
import * as news from "../../../src/sources/news/index.js";
import {
  buildPlayerMatcher,
  UNIVERSE_SQL,
  universeFromEspnPlayers,
  type NewsPlayerRef,
  type PlayerMatcher,
} from "../../../src/sources/news/index.js";
import { NEWS_NOW_MS, rss } from "./helpers.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const universe = universeFromEspnPlayers(
  playersRows(
    JSON.parse(
      readFileSync(path.join(ROOT, "fixtures/espn/recorded/season/players_wl.json"), "utf8"),
    ) as unknown,
    2026,
  ).rows,
  () => null,
);
const m = buildPlayerMatcher(universe);
const byId = new Map(universe.map((p) => [p.espn_id, p]));
// prettier-ignore
const POS: Readonly<Record<number, string>> = {
  1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 7: "P", 9: "DT", 10: "DE", 11: "LB", 12: "CB", 13: "S",
};
const tagOf = (id: number): string => {
  const p = byId.get(id);
  return p === undefined
    ? String(id)
    : `${p.full_name}/${p.team ?? "FA"}/${POS[p.position_id ?? -1] ?? "?"}`;
};
const byTag = new Map(universe.map((p) => [tagOf(p.espn_id), p]));
const show = (refs: readonly NewsPlayerRef[]): string =>
  refs.map((r) => `${tagOf(r.espn_id)}:${r.match_method}`).join(", ") || "∅";
const outcome = (text: string): string => {
  // the refs through `match` (f41e810 had it), so old code fails on its refs where they differ
  const counted = (m as Partial<PlayerMatcher>).matchItem?.(text).unresolved;
  return `${show(m.match(text))} u${counted === undefined ? "?" : String(counted)}`;
};
const keyOf = (id: number): string => mergeName(byId.get(id)?.full_name ?? "") ?? "";
/** The other holders of a player's full name, and the other sharers of his surname. */
function othersOf(id: number): { readonly key: Set<number>; readonly surname: Set<number> } {
  const k = keyOf(id);
  const s = k.split(" ").at(-1) ?? "";
  const key = new Set<number>();
  const surname = new Set<number>();
  for (const p of universe) {
    if (p.espn_id === id) continue;
    const pk = mergeName(p.full_name) ?? "";
    if (pk === k) key.add(p.espn_id);
    if (pk.split(" ").at(-1) === s) surname.add(p.espn_id);
  }
  return { key, surname };
}
/**
 * Holds a row: its exact R8-6 outcome, and — when the row says whose item it is — no ref to another
 * holder of his full name, nor a surname ref to another sharer of his surname (the misattribution).
 */
function holds(text: string, whose: string, want: string): void {
  expect(outcome(text), text).toBe(want);
  if (whose === "") return;
  const refs = m.match(text);
  if (whose === "either") {
    const k = refs.map((r) => keyOf(r.espn_id));
    expect(new Set(k).size, text).toBe(k.length);
    return;
  }
  const p = byTag.get(whose);
  expect(p, whose).toBeDefined();
  const { key, surname } = othersOf(p?.espn_id ?? 0);
  for (const r of refs) {
    expect(key.has(r.espn_id), `${text} → ${tagOf(r.espn_id)}`).toBe(false);
    if (r.match_method === "last_name_team")
      expect(surname.has(r.espn_id), `${text} → ${tagOf(r.espn_id)}`).toBe(false);
  }
}

/** The universe player of `name` on `team` (null = a free agent). */
function idOf(name: string, team: string | null): number {
  const p = universe.filter((x) => x.full_name === name && x.team === team);
  if (p.length !== 1 || p[0] === undefined) throw new Error(`${name} ${String(team)}`);
  return p[0].espn_id;
}
const QB_LAMAR = idOf("Lamar Jackson", "BAL"); // 99.87 % owned
const CB_LAMAR = idOf("Lamar Jackson", null); // a free agent, 0.11 %
const WR_JEFFERSON = idOf("Justin Jefferson", "MIN"); // 99.86 %
const LB_JEFFERSON = idOf("Justin Jefferson", "CLE"); // 0.35 %
const DE_YOUNG = idOf("Byron Young", "LA"); // 20.13 %
const DT_YOUNG = idOf("Byron Young", "PHI"); // 0.08 %
const CB_HARRIS = idOf("Marcus Harris", "TEN"); // 2.08 %
const DT_HARRIS = idOf("Marcus Harris", "KC"); // 0.02 %
const refs = (text: string) => m.match(text).map((r) => [r.espn_id, r.match_method]);

describe("the universe carries ESPN's position_id (R8-3 clause 4; R8-6: a label's position is position_id)", () => {
  it("universeFromEspnPlayers keeps position_id; UNIVERSE_SQL selects it", () => {
    const pos = (id: number) => universe.find((p) => p.espn_id === id)?.position_id;
    expect([pos(QB_LAMAR), pos(CB_LAMAR), pos(WR_JEFFERSON), pos(LB_JEFFERSON)]).toEqual([
      1, 12, 3, 11,
    ]);
    expect([pos(DE_YOUNG), pos(DT_YOUNG), pos(CB_HARRIS), pos(DT_HARRIS)]).toEqual([10, 9, 12, 9]);
    expect(universe.every((p) => typeof p.position_id === "number")).toBe(true);
    expect(UNIVERSE_SQL).toMatch(/\bposition_id\b/);
  });
});

describe("evidence that leaves no single holder gives no ref, and the item is counted (R8-6 (d))", () => {
  it("a position several holders fit tells none of them apart (went to the Rams DE at 0.80)", () => {
    expect(refs("DL Byron Young: Records sack")).toEqual([]);
    expect(m.matchItem("DL Byron Young: Records sack")).toEqual({ refs: [], unresolved: 1 });
    expect(m.matchItem("Michael Carter: Limited in practice")).toEqual({ refs: [], unresolved: 1 });
    // a decided name is not counted; a unique one never is
    expect(m.matchItem("LB Justin Jefferson: Records sack").unresolved).toBe(0);
    expect(m.matchItem("Bijan Robinson: Questionable").unresolved).toBe(0);
    // a shared surname left to no one is counted: with a label that picks none, and (R8-7 (4)
    // supersedes the uncounted unlabelled one, 0 at 66bb2a2) with no label at all
    expect(m.matchItem("Ravens' Jackson: Limited").unresolved).toBe(1);
    expect(m.matchItem("Jackson: Limited").unresolved).toBe(1);
  });

  it("the news build counts the items without a ref and those a shared name was left out of", () => {
    const xml = rss([
      { title: "DL Byron Young: Records sack", guid: "a" },
      { title: "Justin Jefferson: Sacks Vikings QB twice", guid: "b" },
      { title: "LB Justin Jefferson: Records sack", guid: "c" },
      { title: "Bengals sign veteran kicker", guid: "d" },
      { title: "Michael Carter: Limited | Ja'Marr Chase caught 10 passes.", guid: "e" },
    ]);
    const b = news.buildNewsRows({
      format: news.NEWS_FILE_FORMAT,
      source: "rotowire",
      fetched_ms: NEWS_NOW_MS,
      xml,
      universe,
      previous: [],
      warnings: [],
    });
    // every item is kept: none is dropped because a name was left to no one
    expect(b.news).toHaveLength(5);
    expect(b.counts).toMatchObject({ unmatched: 3, unresolved: 3 });
    expect(b.warnings).toContain(
      "3 item(s) carry no player ref (kept; espn_get_news shows them with players_matched empty)",
    );
    expect(b.warnings).toContain(
      "3 item(s) name a player several universe players share, and the evidence picks none of them: no ref for that name",
    );
    // the item that matched Chase still names the unresolved Michael Carter: counted, not unmatched
    expect(b.refs.map((r) => r.espn_id)).toContain(idOf("Ja'Marr Chase", "CIN"));
  });
});

// ---------------------------------------------------------------------------------------------------
// The final gate's batteries (fourth run, at f41e810). Labels: "star" / "namesake" — whose item it is
// (never the other holder's ref); "residual" — the namesake's by its words, but naming no team and no
// position, so R8-6 (b) gives the prominent holder at full_name, as accepted. R8-6 changed the
// outcomes commented "r86": a label that is no R8-6 form, a cue, a game, a describing sentence, a
// topic's clause or a roster move no longer picks a holder (none moves to the other holder).

type Who = "star" | "namesake";
type Label = Who | "residual";
const HOLDERS = {
  LJ: { star: QB_LAMAR, namesake: CB_LAMAR },
  JJ: { star: WR_JEFFERSON, namesake: LB_JEFFERSON },
  BY: { star: DE_YOUNG, namesake: DT_YOUNG },
  MH: { star: CB_HARRIS, namesake: DT_HARRIS },
} as const;
type Case = readonly [
  keyof typeof HOLDERS,
  Label,
  string,
  readonly (readonly [Who, "full_name_team" | "full_name" | "last_name_team"])[],
];

/** Checks each case's exact outcome and that no labelled item reaches the other holder. */
function battery(cases: readonly Case[]): { misattributed: number; refd: number } {
  let misattributed = 0;
  let refd = 0;
  for (const [k, label, title, want] of cases) {
    const h = HOLDERS[k];
    expect(refs(title), `${label}: ${title}`).toEqual(
      want.map(([who, method]) => [h[who], method]),
    );
    const got = m.match(title).map((r) => r.espn_id);
    if (got.length > 0) refd++;
    if (label === "star" && got.includes(h.namesake)) misattributed++;
    if (label === "namesake" && got.includes(h.star)) misattributed++;
    if (label === "residual") expect(want, title).toEqual([["star", "full_name"]]);
  }
  return { misattributed, refd };
}

describe("the final gate's batteries, every labelled title (fourth run, at f41e810)", () => {
  it("battery 1 (gk-homonyms.mts, the gate's labels): 10 misattributions there, none now", () => {
    // prettier-ignore
    const cases: readonly Case[] = [
      // the star's news, phrased in ways the tests did not use
      ["JJ", "star", "Justin Jefferson: Practices fully Wednesday | The Vikings wideout faces Cleveland on Sunday.", []],
      ["JJ", "star", "Justin Jefferson catches two touchdowns as Minnesota beats Cleveland", []],
      ["JJ", "star", "Browns' secondary must slow Justin Jefferson", []],
      ["JJ", "star", "Cleveland defense prepares for Justin Jefferson", []],
      // r86: a cue is no label (R8-6 (c)); the item names a team (the WR at 0.80 at dbe9686)
      ["JJ", "star", "Justin Jefferson (hamstring) questionable for Sunday vs. CLE", []],
      ["JJ", "star", "Justin Jefferson, WR, Minnesota: Questionable", [["star", "full_name_team"]]],
      // r86: "star" stands next to the name: no label (R8-6 (a); the WR at 0.95 at dbe9686)
      ["JJ", "star", "Minnesota Vikings star Justin Jefferson ruled out", []],
      // r86: a play word is no label (R8-6 (c); the WR at 0.80 at dbe9686)
      ["JJ", "star", "Justin Jefferson: Torches Browns for 150 yards", []],
      ["JJ", "star", "Justin Jefferson: Leads Vikings to win | Jefferson caught nine passes.", []],
      ["JJ", "star", "Kevin O'Connell: Justin Jefferson will play Sunday", [["star", "full_name"]]],
      ["JJ", "star", "Justin Jefferson: Questionable, Browns next | Jefferson (hamstring) did not practice.", []],
      ["JJ", "star", "Justin Jefferson and the Vikings visit the Browns in Week 9", []],
      ["JJ", "star", "Justin Jefferson: Traded to Browns", []],
      ["JJ", "star", "Vikings trade Justin Jefferson to Browns", []],
      // the namesake's news
      // r86: a describing sentence never picks (R8-6 (c); the LB at 0.80 at dbe9686)
      ["JJ", "namesake", "Justin Jefferson: Records 12 tackles in loss to Vikings | The Browns linebacker led the team.", []],
      ["JJ", "namesake", "Browns linebacker Justin Jefferson suspended", [["namesake", "full_name_team"]]],
      ["JJ", "namesake", "Justin Jefferson, LB, Cleveland: Out with knee injury", [["namesake", "full_name_team"]]],
      ["JJ", "namesake", "Cleveland's Justin Jefferson: Placed on IR", []],
      ["JJ", "namesake", "Justin Jefferson: Released by Browns", []],
      // r86: "LB" directly before the name is his label (R8-6 (a); no ref at dbe9686)
      ["JJ", "namesake", "Vikings sign LB Justin Jefferson off Browns practice squad", [["namesake", "full_name"]]],
      ["JJ", "namesake", "Justin Jefferson: Sacks Vikings QB twice", []],
      ["JJ", "namesake", "Justin Jefferson: Forces fumble vs. Vikings", []],
      ["JJ", "namesake", "Justin Jefferson: Tackles Vikings' running back for a loss", []],
      ["LJ", "namesake", "Ravens sign CB Lamar Jackson to practice squad", [["namesake", "full_name"]]],
      // r86: a roster move is no label (R8-6 (c)): the item R8-3 left open gets no ref (the QB at
      // 0.95 at dbe9686), the gate's own label again
      ["LJ", "namesake", "Lamar Jackson: Signs with Ravens practice squad", []],
      ["LJ", "namesake", "Cornerback Lamar Jackson: Works out for Ravens", [["namesake", "full_name"]]],
      ["LJ", "namesake", "Lamar Jackson: Claimed off waivers by Ravens | The cornerback joins Baltimore's secondary.", []],
      ["LJ", "namesake", "Free-agent cornerback Lamar Jackson visits Bengals", [["namesake", "full_name"]]],
      ["LJ", "namesake", "Lamar Jackson: Intercepts Ravens QB", []],
      // the star's own (Ravens QB)
      // r86: a cue is no label (R8-6 (c); the QB at 0.80 at dbe9686)
      ["LJ", "star", "Lamar Jackson: Throws three TDs vs. Bengals", []],
      ["LJ", "star", "Baltimore QB Lamar Jackson questionable", [["star", "full_name_team"]]],
      ["LJ", "star", "Lamar Jackson: Signs extension with Ravens", []],
      ["LJ", "star", "Lamar Jackson (ankle) limited | The Ravens quarterback was limited.", []],
      ["LJ", "star", "Ravens' John Harbaugh: Lamar Jackson day-to-day", []],
      // r86: a passive play word is no label (R8-6 (c); the QB at 0.80 at dbe9686)
      ["LJ", "star", "Lamar Jackson: Sacked five times by Steelers", []],
      // Byron Young / Marcus Harris
      // r86: a cue and a describing sentence pick no one (R8-6 (c); each its holder at 0.80 at dbe9686)
      ["BY", "star", "Byron Young: Records two sacks against Eagles | The Rams edge rusher was dominant.", []],
      ["BY", "namesake", "Byron Young: Records two sacks against Rams | The Eagles defensive tackle was dominant.", []],
      ["BY", "star", "Rams' Byron Young: Two sacks", [["star", "full_name_team"]]],
      ["BY", "namesake", "Philadelphia's Byron Young: Two sacks", []],
      ["MH", "star", "Marcus Harris: Breaks up two passes vs. Chiefs | The Titans cornerback had a strong game.", []],
      ["MH", "namesake", "Marcus Harris: Records sack vs. Titans | The Chiefs defensive tackle got home.", []],
      ["MH", "namesake", "Kansas City DT Marcus Harris: Records sack", [["namesake", "full_name_team"]]],
      // a namesake's team with the star's in a game, plus position words
      ["JJ", "namesake", "Browns LB Justin Jefferson: Records sack vs. Vikings", [["namesake", "full_name_team"]]],
      ["JJ", "star", "Vikings WR Justin Jefferson: Questionable vs. Browns", [["star", "full_name_team"]]],
      ["JJ", "namesake", "LB Justin Jefferson: Records sack", [["namesake", "full_name"]]],
      ["JJ", "star", "WR Justin Jefferson: Records 100 yards", [["star", "full_name"]]],
      ["LJ", "namesake", "CB Lamar Jackson: Signs with Bengals", [["namesake", "full_name"]]],
      // surname-only paths
      ["JJ", "namesake", "Browns LB Jefferson: Records sack", [["namesake", "last_name_team"]]],
      ["JJ", "star", "Vikings WR Jefferson: Catches TD", [["star", "last_name_team"]]],
      ["JJ", "star", "Jefferson: Questionable for Vikings", []],
      ["LJ", "star", "Ravens QB Jackson: Limited in practice", [["star", "last_name_team"]]],
      ["LJ", "namesake", "Bengals CB Jackson: Signed to practice squad", []],
    ];
    expect(cases).toHaveLength(52);
    // 19 refs, all right (the gate counted 20 right and 10 misattributions; dbe9686 28 and the open one)
    expect(battery(cases)).toEqual({ misattributed: 0, refd: 19 });
  });

  it("battery 2 (gk-homonyms2.mts, 'more realistic namesake items')", () => {
    // prettier-ignore
    const cases: readonly Case[] = [
      ["LJ", "namesake", "Lamar Jackson: Intercepts Ravens QB", []],
      ["LJ", "namesake", "Lamar Jackson: Picks off Ravens pass | Jackson returned the interception 30 yards.", []],
      ["LJ", "namesake", "Lamar Jackson: Works out for Bengals", []],
      ["LJ", "namesake", "Lamar Jackson: Visits Bears", []],
      ["LJ", "residual", "Lamar Jackson: Inks reserve/future contract", [["star", "full_name"]]],
      ["LJ", "residual", "Lamar Jackson: Waived with injury designation | Jackson (hamstring) reverts to injured reserve.", [["star", "full_name"]]],
      ["JJ", "namesake", "Justin Jefferson: Sacks Vikings QB twice", []],
      ["JJ", "namesake", "Justin Jefferson: Notches 11 tackles in Vikings loss | The linebacker led all defenders.", []],
      ["JJ", "residual", "Justin Jefferson: Placed on IR | Jefferson (knee) will miss at least four games.", [["star", "full_name"]]],
      ["JJ", "namesake", "Justin Jefferson: Dealing with knee injury | The linebacker did not practice Wednesday.", []],
      ["JJ", "namesake", "Justin Jefferson: Questionable for Sunday | Jefferson (ankle) was limited. The defender has started every game.", []],
      ["BY", "namesake", "Byron Young: Sacks Rams QB", []],
      ["MH", "namesake", "Marcus Harris: Sacks Titans QB", []],
      ["MH", "residual", "Marcus Harris: Placed on IR | Harris (knee) will miss the rest of the season.", [["star", "full_name"]]],
      ["BY", "residual", "Byron Young: Placed on IR | Young (knee) will miss the rest of the season.", [["star", "full_name"]]],
    ];
    expect(battery(cases)).toEqual({ misattributed: 0, refd: 5 });
  });

  it("battery 3 (gk-homonyms3.mts, RotoWire IDP blurbs naming only the opponent, and two controls)", () => {
    // prettier-ignore
    const cases: readonly Case[] = [
      ["JJ", "namesake", "Justin Jefferson: Leads team in tackles | Jefferson recorded 11 tackles (seven solo) in Sunday's 24-20 loss to the Vikings.", []],
      ["JJ", "namesake", "Justin Jefferson: Leads team in tackles | Jefferson recorded 11 tackles (seven solo) in Sunday's 24-20 win over the Vikings.", []],
      ["JJ", "namesake", "Justin Jefferson: Records first career sack | Jefferson brought down the Vikings' quarterback in the third quarter Sunday.", []],
      ["LJ", "namesake", "Lamar Jackson: Snags interception | Jackson picked off the Ravens' quarterback in the fourth quarter of Sunday's loss.", []],
      ["BY", "namesake", "Byron Young: Two sacks in win | Young sacked the Rams' quarterback twice in Sunday's 27-17 win.", []],
      // r86: the controls name a team, and a cue is no label: no ref, counted — the accepted recall
      // loss (R8-6: ESPN's own status still behind the star; the star at 0.80 at dbe9686)
      ["JJ", "star", "Justin Jefferson: Catches two touchdowns | Jefferson caught seven passes for 110 yards in Sunday's win over the Browns.", []],
      ["LJ", "star", "Lamar Jackson: Accounts for three scores | Jackson threw two touchdowns and ran for another in Sunday's win over the Bengals.", []],
    ];
    expect(battery(cases)).toEqual({ misattributed: 0, refd: 0 });
  });

  it("battery 4 (gk-homonyms4.mts, the finding's injury items)", () => {
    // prettier-ignore
    const cases: readonly Case[] = [
      ["JJ", "namesake", "Justin Jefferson: Exits with knee injury | Jefferson left Sunday's loss to the Vikings in the third quarter and did not return.", []],
      ["JJ", "namesake", "Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win over the Vikings, the team announced Monday.", []],
      ["LJ", "namesake", "Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's loss to the Ravens.", []],
    ];
    expect(battery(cases)).toEqual({ misattributed: 0, refd: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------
// The 16 violations the independent attack on R8-3's fix round 3 left open (at dbe9686), each with
// every variant it named, at its R8-6 outcome. None reaches the other holder now.

describe("the 16 violations left open at dbe9686, at their R8-6 outcome", () => {
  it("V1–V6: a team named any way (a cue, an idiom, a handle, a dispute, a camp battle, an abbreviation): no ref, counted", () => {
    // prettier-ignore
    const rows: readonly (readonly [string, string, string])[] = [
      // V1: "Hurts" is Jalen Hurts, whose team anchored a game (the WR at 0.80 at dbe9686)
      ["Justin Jefferson: Hurts knee in loss to Vikings | Jefferson (knee) exited in the third quarter and did not return.", "Justin Jefferson/CLE/LB", "∅ u1"],
      ["Justin Jefferson: Injures knee in loss to Vikings", "Justin Jefferson/CLE/LB", "∅ u1"],
      // V2: a handle is a team (R8-6 (b))
      ["Justin Jefferson: Out for season, per @Browns | Jefferson tore his ACL in practice.", "Justin Jefferson/CLE/LB", "∅ u1"],
      ["@Browns: Justin Jefferson placed on injured reserve", "Justin Jefferson/CLE/LB", "∅ u1"],
      ["Lamar Jackson: Waived, per @Bengals", "Lamar Jackson/FA/CB", "∅ u1"],
      ["Chris Jones: Re-signs with practice squad, per @Bills", "", "∅ u1"],
      // V3: an idiom of a team's own loss
      ["Justin Jefferson: Appears lost to Browns with knee injury", "Justin Jefferson/CLE/LB", "∅ u1"],
      ["Justin Jefferson: Injury big loss to Browns", "Justin Jefferson/CLE/LB", "∅ u1"],
      ["Justin Jefferson: Torn ACL means big loss to Browns", "Justin Jefferson/CLE/LB", "∅ u1"],
      // V4: a dispute
      ["Justin Jefferson: Files grievance with NFLPA against Browns | Jefferson says he was hurt when the team released him.", "Justin Jefferson/CLE/LB", "∅ u1"],
      // V5: a camp battle or a workout
      ["Justin Jefferson: Beats Browns starter for job | Jefferson will open the season as the starting weakside linebacker.", "Justin Jefferson/CLE/LB", "∅ u1"],
      ["Byron Young: Beats Eagles starter in camp battle", "Byron Young/PHI/DT", "∅ u1"],
      ["Marcus Harris: Beats Chiefs starter for roster spot", "Marcus Harris/KC/DT", "∅ u1"],
      ["Lamar Jackson: Holds own against Bengals receivers in workout", "Lamar Jackson/FA/CB", "∅ u1"],
      // V6: a whole-word abbreviation anywhere is a team (R8-6 (b))
      ["Justin Jefferson: Placed on IR by CLE | Jefferson (knee) will miss at least four games.", "Justin Jefferson/CLE/LB", "∅ u1"],
      ["CLE waives Justin Jefferson", "Justin Jefferson/CLE/LB", "∅ u1"],
      ["Lamar Jackson: Signs with CIN", "Lamar Jackson/FA/CB", "∅ u1"],
      ["PHI waives Byron Young", "Byron Young/PHI/DT", "∅ u1"],
      ["KC places Marcus Harris on IR", "Marcus Harris/KC/DT", "∅ u1"],
    ];
    for (const [t, whose, want] of rows) holds(t, whose, want);
  });

  it("V7–V9: a position in every form, and a topic's clause (no label): no ref, counted", () => {
    // prettier-ignore
    const rows: readonly (readonly [string, string, string])[] = [
      // V7: "corner" counts (R8-6 (b): an ambiguous token counts as found)
      ["Lamar Jackson: Waived | The corner was released after two weeks on the practice squad.", "Lamar Jackson/FA/CB", "∅ u1"],
      ["Chris Jones: Waived | The corner was released Tuesday.", "Chris Jones/FA/CB", "∅ u1"],
      // V8: abbreviated and hyphenated forms
      ["Byron Young: Waived | The IDL was let go Tuesday.", "Byron Young/PHI/DT", "∅ u1"],
      ["Byron Young: Waived | The edge-rusher will miss the rest of the season.", "", "∅ u1"],
      // V9: a topic's clause is no label (R8-6 (c)); the item names positions (the LB at dbe9686)
      ["Justin Jefferson injury update: Linebacker hit caused concussion | The receiver is in the protocol and will miss Sunday's game.", "Justin Jefferson/MIN/WR", "∅ u1"],
      ["Justin Jefferson injury update: Linebacker fined for late hit", "Justin Jefferson/MIN/WR", "∅ u1"],
    ];
    for (const [t, whose, want] of rows) holds(t, whose, want);
  });

  it("V10: a tryout is no move, and a move is no label: no ref (0.95 at dbe9686)", () => {
    holds("Lamar Jackson: Joins Ravens on tryout basis", "Lamar Jackson/FA/CB", "∅ u1");
    holds("Chris Jones: Joins Chiefs on tryout basis", "", "∅ u1");
  });

  it("V11, V12: recall the ruling accepts — a team named and no label: no ref for the shared name, counted", () => {
    // the star's own items; R8-6: "a shared name's item that names a team or position but has no
    // label next to the name getting no ref (counted)" is accepted
    holds(
      "Lamar Jackson: Throws TD to Zay Flowers | Jackson found Flowers in the win over the Bengals.",
      "Lamar Jackson/BAL/QB",
      "Zay Flowers/BAL/WR:full_name u1",
    );
    holds(
      "Justin Jefferson: Burns Denzel Ward | Jefferson beat Ward for a 60-yard TD in the win over the Browns.",
      "Justin Jefferson/MIN/WR",
      "Denzel Ward/CLE/CB:full_name_team u1",
    );
    holds(
      "Justin Jefferson (ankle) limited | The Vikings will visit the Bears on Sunday.",
      "Justin Jefferson/MIN/WR",
      "∅ u1",
    );
    holds(
      "Lamar Jackson (ankle) limited | The Ravens will host the Bengals on Sunday.",
      "Lamar Jackson/BAL/QB",
      "∅ u1",
    );
  });

  it("V13: a position in the surname's name tag is its label, and an unlabelled one is counted", () => {
    // no ref and uncounted at dbe9686
    holds(
      "Jefferson MLB: Records sack",
      "Justin Jefferson/CLE/LB",
      "Justin Jefferson/CLE/LB:last_name_team u0",
    );
    holds(
      "Jackson QB2: Limited in practice",
      "Lamar Jackson/BAL/QB",
      "Lamar Jackson/BAL/QB:last_name_team u0",
    );
    holds(
      "Ja'Marr Chase: Catches TD | Chase beat Jefferson MLB in coverage.",
      "",
      "Ja'Marr Chase/CIN/WR:full_name u1",
    );
  });

  it("V14: 'OT' counts as found (R8-6 (b) names it): no ref, counted — the ruling's own recall cost", () => {
    for (const t of [
      "Justin Jefferson: Scores winning TD in OT",
      "Lamar Jackson: Leads OT drive for win",
      "Lamar Jackson: Throws for 300 yards in OT win",
      "Byron Young: Records strip-sack in OT",
    ])
      holds(t, "", "∅ u1");
  });

  it("V15: the attack's 4,000-character item is read once, and gives no shared name to anyone", () => {
    // (its time: match.perf.test.ts)
    const TEAM_WORDS = news.TEAM_WORDS;
    const surnames = [
      ...new Set(
        universe
          .map((p) => p.full_name.split(/\s+/u).at(-1) ?? "")
          .filter((w) => /^[A-Z][a-z]{2,}$/u.test(w) && !TEAM_WORDS.has(w.toLowerCase())),
      ),
    ];
    // prettier-ignore
    const FULL = ["Lamar Jackson", "Justin Jefferson", "Byron Young", "Marcus Harris", "Chris Jones", "Josh Johnson", "Jordan Phillips", "Tony Brown", "David Long", "Brandon Johnson", "DJ Turner", "Byron Murphy", "Jaylon Jones", "Michael Carter", "Brandon Smith", "Chris Smith"];
    const blurb =
      `${FULL.join(", ")}, ${surnames.slice(0, 260).join(", ")} and Smith ${"@MIN, ".repeat(400)}`.slice(
        0,
        4_000,
      );
    const r = m.matchItem(`Lamar Jackson: Notes | ${blurb}`);
    const holders = new Map<string, number>();
    for (const p of universe) {
      const k = mergeName(p.full_name) ?? "";
      holders.set(k, (holders.get(k) ?? 0) + 1);
    }
    const shared = new Set(
      universe
        .filter((p) => (holders.get(mergeName(p.full_name) ?? "") ?? 0) > 1)
        .map((p) => p.espn_id),
    );
    expect(r.refs.filter((x) => shared.has(x.espn_id))).toEqual([]);
    expect(r.unresolved).toBeGreaterThanOrEqual(16);
  });

  it("V16: the entries no test held are gone with their lists, or held now (match-r86.test.ts)", () => {
    // "repeatedly", the "office" guard and "taxi squad" were the cue and move lists' (removed);
    // "Bolts", "WSH" are held entry by entry; each item names a team: no ref, counted
    for (const t of [
      "Lamar Jackson: Sacked repeatedly by Steelers",
      "Justin Jefferson: Big day vs. Bolts",
      "Justin Jefferson: Questionable vs. WSH",
      "Justin Jefferson: Torches Browns front office on social media",
      "Lamar Jackson: Signs with Ravens taxi squad",
    ])
      holds(t, "", "∅ u1");
  });
});

// ---------------------------------------------------------------------------------------------------
// Every misattribution the independent attacks on R8-3's three fix rounds found (443 texts from the
// batteries of the misattribution, code-audit, recall-regression and triage lenses, rounds 1–3, and
// the gate's), with whose item it is ("Name/TEAM/POS"; "either" where the battery called it so), at
// its R8-6 outcome. At dbe9686, 232 of them went to the other holder; at f41e810, 305.

// prettier-ignore
const MISATTRIBUTIONS: readonly (readonly [string, string, string])[] = [
  ["Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win over the Vikings. Minnesota fell to 3-5.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Exits with knee injury | Jefferson left Sunday's loss to the Vikings in the third quarter. Minnesota won 24-20.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Sacks Vikings QB twice | The Vikings managed just 10 points.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records first career sack | Jefferson brought down the Vikings' quarterback in the third quarter. The Vikings held on to win.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Leads team in tackles | Jefferson recorded 11 tackles in Sunday's 24-20 loss to the Vikings. Minnesota has won four straight.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's loss to the Ravens. Baltimore led throughout.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Picks off Ravens pass | Jackson returned it 30 yards. The Ravens still won.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Picks off Ravens pass | Jackson beat the Ravens' tight end on the play.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Snags interception | Jackson picked off the Ravens' quarterback in the fourth quarter. The Ravens won anyway.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Byron Young: Placed on IR | Young (knee) got hurt in Sunday's win over the Rams. The Rams rallied late but fell short.", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Placed on IR | Harris (knee) was hurt in Sunday's loss to the Titans. Tennessee won 21-14.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Chris Jones: Picks off Chiefs pass | Kansas City still won.", "either", "∅ u1"],
  ["Justin Jefferson: Lost for season | Jefferson is lost to the Browns for the season with a torn ACL.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Lands on IR | The knee injury is a significant loss to the Browns.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Placed on IR | Jefferson's injury is a loss to the Browns, who lack depth.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Placed on IR | The knee injury shreds the Browns' linebacker depth.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Out for season | Injuries have gashed the Browns' linebacker corps.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Rookie profile | Jefferson fell to the Browns in the fifth round of the draft.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Marcus Harris: Lost for season | Harris is lost to the Chiefs for the year.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Byron Young: Out for year | The pectoral tear is a big loss to the Eagles.", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Records two sacks | The defensive tackle did not practice Wednesday. The injury is a big loss to the Eagles.", "Byron Young/PHI/DT", "∅ u1"],
  ["Justin Jefferson: Forces fumble | Jefferson punched the ball loose in the Browns' win. The receiver was carted off.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Fined for hit | Jefferson was fined for a hit in the Browns' loss. The receiver suffered a concussion.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records interception | Jefferson picked off a deep ball in the Browns' win. The wideout he was covering was benched.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Catches TD | The linebacker covering him slipped.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Torches secondary | The linebacker assigned to him was benched.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Linebacker spy planned | Cleveland will use a spy on Jefferson Sunday.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Lamar Jackson: Throws three TDs | Jackson torched the secondary. The cornerback was benched.", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Lamar Jackson: Throws three touchdowns | The cornerback covering him slipped.", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Marcus Harris: Breaks up two passes | The defensive tackle covering him slipped.", "Marcus Harris/TEN/CB", "∅ u1"],
  ["Lamar Jackson: Signs with Ravens practice squad", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's loss to the Steelers.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's win over the Steelers.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Picks off Steelers pass | Jackson returned the interception 30 yards.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Intercepts Steelers QB", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Exits with hamstring injury | Jackson left Sunday's loss to the Bengals after covering a kickoff.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Beaten by Bengals receiver for touchdown", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Breaks up two passes in loss to Steelers", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Snags interception | Jackson picked off the Steelers' quarterback in the fourth quarter of Sunday's loss.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Tackles Bengals returner on kickoff coverage", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Chris Jones: Punts six times in loss to Broncos | Jones averaged 47 yards per punt.", "either", "∅ u1"],
  ["Chris Jones: Shanks punt in win over Raiders", "either", "∅ u1"],
  ["NFL rules against Browns in Justin Jefferson appeal", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Arbitrator sides against Browns in Justin Jefferson grievance", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Judge decides against Browns on Justin Jefferson suspension", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["League rules against Chiefs in Marcus Harris appeal", "Marcus Harris/KC/DT", "∅ u1"],
  ["Arbitrator rules against Eagles in Byron Young grievance", "Byron Young/PHI/DT", "∅ u1"],
  ["Justin Jefferson: Cut after camp | Jefferson struggled against the Browns starters in practice before being cut.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Injured in practice | Jefferson was hurt against the Browns' offense during team drills.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Byron Young: Hurt in practice | Young was injured going against the Eagles offensive line Wednesday.", "Byron Young/PHI/DT", "∅ u1"],
  ["Ravens claim Lamar Jackson off waivers", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Promoted to Ravens active roster", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Vikings sign Justin Jefferson off Browns practice squad", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Signs with Vikings after release by Browns", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Loss to Vikings: Justin Jefferson records 12 tackles", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["JUSTIN JEFFERSON: SACKS VIKINGS QB TWICE", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson (CLE) records sack vs. MIN", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Sacks Kirk Cousins twice in Sunday's win over the Minnesota Vikings", "Justin Jefferson/CLE/LB", "Kirk Cousins/LV/QB:full_name u1"],
  ["Lamar Jackson: Picks off Ravens QB in Bengals' win", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Records interception | Jackson picked off a Ravens pass Sunday.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson, CB: Intercepts pass vs. Steelers", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Lamar Jackson: Throws pick to CB Lamar Jackson", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Lamar Jackson: Joins Ravens on tryout basis", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Joins Ravens as tryout player", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Joins Ravens on a tryout basis for rookie minicamp", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Joins Ravens in rookie minicamp as tryout", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Joins Ravens for workout", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Lands on Ravens after tryout", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Chris Jones: Joins Chiefs on tryout basis", "either", "∅ u1"],
  ["Chris Jones: Joins Chiefs as tryout punter", "either", "∅ u1"],
  ["Ravens sign Lamar Jackson to practice squad", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson injury update: Linebacker fined for late hit", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson injury update: Linebacker ejected after hit", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson injury news: Linebacker apologizes for hit", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Lamar Jackson injury update: Cornerback fined for late hit", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Chris Jones injury update: Punter fined for hit", "Chris Jones/KC/DT", "∅ u1"],
  ["Justin Jefferson: Moves past Browns starter on depth chart", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Climbs past Browns starter Jordan Hicks on depth chart", "Justin Jefferson/CLE/LB", "Jordan Hicks/CLE/LB:full_name_team u1"],
  ["Byron Young: Moves past Eagles starter on depth chart", "Byron Young/PHI/DT", "∅ u1"],
  ["Justin Jefferson: Catches TD | Jefferson beat Browns LB Jefferson, his namesake, deep.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson status: Defender flagged for unnecessary roughness", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson injury update: The linebacker was fined $25,000 for the hit", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Lamar Jackson injury update: Defender flagged for roughing the passer", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Lamar Jackson injury news: Cornerback apologizes for hit", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Marcus Harris injury update: Defensive tackle fined for hit", "Marcus Harris/TEN/CB", "∅ u1"],
  ["Justin Jefferson: Beats Browns starter for job", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Beaten by Browns starter for job", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Byron Young: Beats Eagles starter in camp battle", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Beats Chiefs starter for roster spot", "Marcus Harris/KC/DT", "∅ u1"],
  ["Justin Jefferson: Records sack in upset of Vikings", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Notches 10 tackles in Week 7 loss at Minnesota", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Strong showing in loss | Jefferson recorded eight tackles and a pass defensed in Week 9's 24-17 loss at Minnesota.", "Justin Jefferson/CLE/LB", "∅ u2"],
  ["Justin Jefferson: Forces fumble | Jefferson forced a Vikings fumble in the fourth quarter of Sunday's win.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Blocks Vikings punt", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Strips Vikings QB in fourth quarter", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Recovers Vikings fumble in win", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Pressures Vikings QB into interception", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Stuffs Vikings on fourth down", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Edged by Vikings | Jefferson recorded nine tackles (six solo) in the 20-17 defeat.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Routed by Vikings | Jefferson had seven tackles in the blowout.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Outlasted by Vikings in overtime | Jefferson finished with 14 tackles.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Held off by Vikings | Jefferson had a sack in the 23-20 defeat.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Two sacks in win at Minnesota", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Leads team in stops | Jefferson recorded 11 tackles (seven solo) in Sunday's 24-20 loss in Minnesota.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records 10 tackles in loss to visiting Vikings", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson had a sack and six tackles as his team fell 24-20 to the Vikings.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Leads defense | Jefferson posted 10 tackles in Sunday's 24-20 defeat to Minnesota.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Busy in loss | Jefferson recorded 12 tackles in Sunday's loss to Minnesota's high-powered offense.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Works out for Vikings", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Picks off pass in loss at Baltimore", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Forces Ravens fumble on special teams", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Blocks Ravens punt", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for Ravens", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Tries out for Ravens", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Back with Ravens on futures deal", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson (Ravens practice squad) elevated for Sunday", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Byron Young: Strips Rams QB", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Two sacks in upset of Rams", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Forces Rams fumble in win", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Two sacks in loss | Young recorded two sacks among his four tackles in Sunday's 28-24 loss at the Rams.", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Blocks Titans field goal", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Records sack in win at Tennessee", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Strips Titans QB", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Sacks Cam Ward | Harris got to Cam Ward for his first sack of the season in Sunday's 24-17 win at Tennessee.", "Marcus Harris/KC/DT", "Cam Ward/TEN/QB:full_name_team u1"],
  ["Chris Jones: Works out for Chiefs", "either", "∅ u1"],
  ["Chris Jones: Pins Chiefs deep three times | Jones averaged 47 yards per punt.", "Chris Jones/FA/P", "∅ u1"],
  ["Justin Jefferson (CLE) records two sacks", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson, CLE: Placed on IR", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Sacks MIN QB twice", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson (CLE - LB): Records 10 tackles", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Justin Jefferson: Records 12 tackles @ MIN", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records 8 tackles vs. MIN", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Picks off pass vs. BAL", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Byron Young (PHI) placed on IR", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Records sack vs. LAR", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris (KC) placed on IR", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Sack vs. TEN", "Marcus Harris/KC/DT", "∅ u1"],
  ["Corner Lamar Jackson visits Bengals", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Free-agent corner Lamar Jackson works out for Bengals", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Justin Jefferson: Placed on IR | Jefferson, a second-year linebacker, will miss at least four games.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Placed on IR | The 24-year-old linebacker will miss at least four games.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Placed on IR | Jefferson (knee) is the team's starting middle linebacker.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Questionable | Jefferson, who starts at linebacker, did not practice Thursday.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson LB: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Lamar Jackson: Waived with injury designation | The 27-year-old cornerback reverts to injured reserve.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Waived with injury designation | Jackson, a cornerback, reverts to injured reserve.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson, the Ravens' newest cornerback, impresses in first practice", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for Bengals | The former Ravens cornerback is seeking a roster spot.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Byron Young: Placed on IR | The 26-year-old defensive tackle tore his ACL.", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Out for season | The 25-year-old defensive tackle suffered a torn pectoral.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Chris Jones: Released | The 31-year-old punter was let go after Week 6.", "Chris Jones/FA/P", "∅ u1"],
  ["Chris Jones: Works out for Jets | The journeyman cornerback is looking for a roster spot.", "Chris Jones/FA/CB", "∅ u1"],
  ["Justin Jefferson: Catches two touchdowns | The linebacker covering him was benched.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Goes over 100 yards | The defender assigned to him left with a hamstring injury.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Shadowed all game | The Browns linebacker held him to two catches.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson outlook: Linebacker coverage could open up a big day", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Makes 12 tackles | The wideout he covered finished with two catches.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Burned for touchdown | The receiver beat him deep in the fourth quarter.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Records pick-six | The quarterback threw it right to him.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Throws for 300 yards | The cornerback he picked on most was benched at halftime.", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Lamar Jackson: Runs for 80 yards | The defender who missed the tackle was benched.", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Lamar Jackson outlook: Cornerback injuries leave Bengals thin", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Chris Jones: Strip-sack in win | The cornerback scooped up the fumble.", "Chris Jones/KC/DT", "∅ u1"],
  ["Marcus Harris: Records sack | The cornerback blitz freed him up.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Michael Carter: Rushes for 100 yards | The cornerback chasing him pulled up lame.", "Michael Carter/TEN/RB", "∅ u1"],
  ["Byron Murphy: Records two sacks | The cornerback across from him was flagged twice.", "Byron Murphy II/SEA/DT", "∅ u1"],
  ["Lamar Jackson: Claimed off waivers by Ravens", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Ravens elevate Lamar Jackson from practice squad", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Promoted to Ravens' active roster", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Vikings claim Justin Jefferson off waivers", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Signs with Vikings practice squad", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Rams claim Byron Young off waivers", "Byron Young/PHI/DT", "∅ u1"],
  ["Chiefs sign Chris Jones to practice squad", "either", "∅ u1"],
  ["Vikings sign Jefferson to practice squad", "either", "∅ u1"],
  ["Rams claim Young off waivers", "either", "∅ u1"],
  ["Vikings claim Jefferson off waivers", "either", "∅ u1"],
  ["Aaron Jones: Held to 31 yards | Justin Jefferson led a defense that bottled up the Vikings running game.", "Justin Jefferson/CLE/LB", "Aaron Jones Sr./MIN/RB:full_name_team u1"],
  ["Carson Wentz: Sacked four times | Justin Jefferson got to the Vikings quarterback twice.", "Justin Jefferson/CLE/LB", "Carson Wentz/MIN/QB:full_name_team u1"],
  ["Matthew Stafford: Sacked three times | Byron Young got to the Rams quarterback twice.", "Byron Young/PHI/DT", "Matthew Stafford/LA/QB:full_name_team u1"],
  ["Cam Ward: Sacked four times | Marcus Harris dropped the Titans quarterback twice.", "Marcus Harris/KC/DT", "Cam Ward/TEN/QB:full_name_team u1"],
  ["Justin Jefferson: Facing Browns-imposed suspension", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Beats Browns teammate for starting job", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Lost to Browns for season | Jefferson tore his ACL in practice.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Byron Young: Facing Eagles discipline after ejection", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Beats Chiefs teammate for roster spot", "Marcus Harris/KC/DT", "∅ u1"],
  ["Justin Jefferson: Records sack in loss to Vikings | Jefferson got to the quarterback as the Vikings rallied late.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Leads team in tackles | Jefferson recorded 11 tackles (seven solo) in Sunday's 24-20 loss to the Vikings. Minnesota converted 8 of 13 third downs.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack in loss to the Minnesota Vikings", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Intercepts pass against the Baltimore Ravens", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Picks off pass in loss to Ravens | Baltimore scored 31 points.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Byron Young: Two sacks against the Los Angeles Rams", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Sacks Rams QB | The Rams struggled to protect all game.", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Sack in win over the Tennessee Titans", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Sacks Titans QB twice | Tennessee allowed five sacks.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Chris Jones: Punts against the Kansas City Chiefs", "either", "∅ u1"],
  ["Lamar Jackson: Intercepts pass | Jackson picked off a pass in the Bengals' loss to the Ravens.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win at Minnesota, the team announced Monday.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's upset of the Vikings, the team announced Monday.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win over the Minnesota Vikings, the team announced Monday.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Exits with knee injury | Jefferson left Sunday's 24-20 loss at Minnesota in the third quarter and did not return.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's loss at Baltimore.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's loss to the Baltimore Ravens.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Byron Young: Out for season | Young tore his ACL in Sunday's loss at the Rams.", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Out for season | Harris tore his ACL in Sunday's win at Tennessee.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Denzel Ward: Picks off pass | Justin Jefferson added a sack in the win over the Vikings.", "Justin Jefferson/CLE/LB", "Denzel Ward/CLE/CB:full_name u1"],
  ["Lamar Jackson: Picks off pass | The Ravens QB threw it into double coverage.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Records sack against Lions", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Intercepts pass against Steelers", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Lands on Vikings' radar", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Byron Murphy: Picks off pass | The defensive tackle tipped it at the line.", "Byron Murphy Jr./MIN/CB", "∅ u1"],
  ["Marcus Harris: Picks off pass | The defensive tackle tipped it at the line.", "Marcus Harris/TEN/CB", "∅ u1"],
  ["Chris Jones: Two sacks in win | The punter pinned Buffalo deep four times.", "Chris Jones/KC/DT", "∅ u1"],
  ["Lamar Jackson: Picks off Bengals pass | Jackson returned the interception 30 yards.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Forces Steelers fumble on kickoff | Jackson punched the ball loose in the win.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Exits with ankle injury | Jackson was hurt on a kickoff in Week 9's loss at Pittsburgh.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Blocks Browns punt | Jackson got a hand on the fourth-quarter punt in the win.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for Steelers | Jackson had an interception against the Packers last season.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Remains unsigned | Jackson, who intercepted two passes against the Steelers last season, is still a free agent.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for New York", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for Cincy", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for Vegas", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Visit with Los Angeles set for Tuesday", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for Chargers | Jackson worked out a day after Los Angeles' 24-20 win over the Steelers.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for Cincy, which beat the Steelers on Sunday", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for Chargers | Jackson met with Jim Harbaugh, whose team beat the Steelers on Sunday.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Ravens claim Lamar Jackson off waivers from Bears", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Joins Ravens practice squad", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Waived by Ravens | Jackson was let go from Baltimore's practice squad Tuesday.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson injury update: Ravens' top cornerback also ruled out for Week 9", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Lamar Jackson injury update: Steelers cornerback fined for hit on Ravens QB", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Justin Jefferson: A big loss to Browns | Jefferson (knee) is out for the season.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Season-ending injury a big loss to Browns", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson out for year - a big loss to Cleveland", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Big loss to Browns as LB lands on IR", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Lost to Browns until December | Jefferson (knee) underwent surgery Tuesday.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Pressured by Browns to take pay cut", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Holds out against Browns | Jefferson wants a new contract.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Arbitrator rules against Browns | Jefferson will receive his injury guarantee.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Shines in camp | Jefferson sacked the Browns' quarterback twice during Tuesday's practice.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Vikings claim Justin Jefferson off waivers from Browns", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Lands on Vikings practice squad", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Elevated by Vikings | Minnesota elevated Jefferson from the practice squad Saturday.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Mistaken for Vikings' Justin Jefferson | The Browns linebacker took it in stride.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Vikings sign Jefferson off Browns practice squad", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson injury update: Browns linebacker fined for hit on Vikings star", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson injury update: Linebacker suspended for hit on Vikings receiver", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Byron Young: Sacks Matthew Stafford twice in win over Los Angeles", "Byron Young/PHI/DT", "Matthew Stafford/LA/QB:full_name u1"],
  ["Byron Young: Injury a big loss to Eagles | Young (knee) will miss the rest of the season.", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Lands on Rams practice squad", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Injury a big loss to Chiefs | Harris (knee) is out for the season.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Pressured by Chiefs to accept pay cut", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris injury update: Chiefs defensive tackle fined for hit on Titans corner", "Marcus Harris/TEN/CB", "∅ u1"],
  ["Chris Jones: Averages 48 yards per punt in loss to Raiders | Jones punted six times.", "Chris Jones/FA/P", "∅ u1"],
  ["Chris Jones: Works out for Bills | Jones averaged 45 yards per punt against the Dolphins last season.", "Chris Jones/FA/P", "∅ u1"],
  ["Chris Jones: Shanks punt vs. Broncos", "Chris Jones/FA/P", "∅ u1"],
  ["Chris Jones: Signs with Chiefs practice squad", "either", "∅ u1"],
  ["Chris Jones injury update: Broncos cornerback fined for low hit on Chiefs DT", "Chris Jones/KC/DT", "∅ u1"],
  ["Byron Murphy: Injury a big loss to Vikings secondary | Murphy (hamstring) will miss four weeks.", "Byron Murphy Jr./MIN/CB", "∅ u1"],
  ["Byron Murphy: Injury a big loss to Seattle | Murphy (ankle) is out for the season.", "Byron Murphy II/SEA/DT", "∅ u1"],
  ["Byron Murphy: Holds out against Vikings | Murphy wants a new contract.", "Byron Murphy Jr./MIN/CB", "∅ u1"],
  ["DJ Turner: Signs with Bengals", "DJ Turner/FA/WR", "∅ u1"],
  ["Josh Johnson: Rushes 12 times for 60 yards in win over Browns | Johnson added two catches out of the backfield.", "Josh Johnson/FA/RB", "∅ u1"],
  ["Josh Johnson: Works out for Jets | Johnson ran for 80 yards against the Bills last season.", "Josh Johnson/FA/RB", "∅ u1"],
  ["Jordan Phillips: Works out for Bills | Phillips recorded 3.5 sacks against the Jets last season.", "Jordan Phillips/FA/DT", "∅ u1"],
  ["Jordan Phillips: Signs with Dolphins", "Jordan Phillips/FA/DT", "∅ u1"],
  ["David Long Jr.: Works out for Titans | Long recorded 12 tackles against the Colts last season.", "David Long Jr./FA/LB", "∅ u1"],
  ["David Long Jr.: Signs with Saints", "David Long Jr./FA/LB", "∅ u1"],
  ["Michael Carter: Injury a big loss to Titans | Carter (ankle) will miss four weeks.", "Michael Carter/TEN/RB", "∅ u1"],
  ["Michael Carter: Injury a big loss to Eagles secondary", "Michael Carter II/PHI/S", "∅ u1"],
  ["Justin Jefferson Injury Is A Big Loss To Browns", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["JUSTIN JEFFERSON: KNEE INJURY IS A BIG LOSS TO BROWNS", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson Is Lost To Browns With Torn ACL", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson's Injury Is A Huge Loss To Cleveland", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Byron Young Injury Is A Big Loss To Eagles", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris Is Lost To Chiefs With Torn ACL", "Marcus Harris/KC/DT", "∅ u1"],
  ["Justin Jefferson: Carted off | A hit by the Vikings injured Justin Jefferson in the third quarter.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Chris Jones: Expected to punt in Broncos matchup", "Chris Jones/FA/P", "∅ u1"],
  ["Chiefs vs. Broncos: Chris Jones to handle punting duties", "Chris Jones/FA/P", "∅ u1"],
  ["Ravens vs. Steelers: Lamar Jackson to make debut on special teams", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Exits in rout of Steelers | Jackson (hamstring) was hurt covering a kickoff.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Hurt on kickoff as Cincy rolls past Steelers | Jackson (knee) did not return.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["DJ Turner: Catches TD in preseason win over Giants | Turner is trying to make the roster as a wideout.", "DJ Turner/FA/WR", "∅ u1"],
  ["Justin Jefferson status: Linebacker ejected for hit on Vikings star", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Lamar Jackson news: Cornerback fined for hit on Ravens QB", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Justin Jefferson: Released by Vikings | Minnesota cut Jefferson from its practice squad Monday.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Vikings waive Justin Jefferson from practice squad", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Signed to Vikings practice squad", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Byron Young: Promoted to Rams active roster", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Signs with Titans practice squad", "Marcus Harris/KC/DT", "∅ u1"],
  ["Chris Jones: Cut by Chiefs | The Chiefs released Jones from their practice squad.", "either", "∅ u1"],
  ["Justin Jefferson: Appears lost to Browns with knee injury", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Feared lost to Browns after Achilles tear", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Probably lost to Browns through Week 12 | Jefferson (knee) is expected to miss at least a month.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Injury big loss to Browns | Jefferson (Achilles) will miss the rest of the season.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Torn ACL means big loss to Browns", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Out for season, per @Browns | Jefferson tore his ACL in practice.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Placed on injured reserve (via @Browns)", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Files grievance with NFLPA against Browns | Jefferson says he was hurt when the team released him.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Speaks out against Browns over release", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Rails against Browns after being cut", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Facing Browns in arbitration over injury settlement", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Beats Browns in arbitration case", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Scores legal victory over Browns", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Loses to Browns in grievance hearing", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Upset by Browns over lack of snaps", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Burned by Browns again | The team waived Jefferson for the second time this season.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Beats Browns starter for job | Jefferson will open the season as the starting weakside linebacker.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Sacks Browns QB in practice | Jefferson has impressed coaches since joining the practice squad.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Picks off Browns QB in camp", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Wins over Browns with strong camp", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Defeats Browns in contract dispute", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Beaten by Browns in arbitration", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Wins injury settlement against Browns", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Waived by CLE", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Placed on IR by CLE | Jefferson (knee) will miss at least four games.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["CLE places Justin Jefferson on injured reserve", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Released by CLE", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Signs with CLE practice squad", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["CLE waives Justin Jefferson", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson stripped J.J. McCarthy in the 24-20 win over the Vikings.", "Justin Jefferson/CLE/LB", "J.J. McCarthy/NYG/QB:full_name u1"],
  ["Justin Jefferson: Elevated by Vikings from practice squad", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson injury update: Linebacker hit caused concussion", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Lamar Jackson: Works out for Steelers | Jackson last played in a 2024 loss to the Browns.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Signs with CIN", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Lands on practice squad | The corner was signed Tuesday.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Signs reserve/future deal | The veteran corner spent 2024 on injured reserve.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Covers WR Ja'Marr Chase in workout", "Lamar Jackson/FA/CB", "Ja'Marr Chase/CIN/WR:full_name u1"],
  ["Lamar Jackson: Waived by CIN", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Upset by Bengals over failed physical", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Speaks out against Bengals after release", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Files grievance with NFLPA against Bengals", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Holds own against Bengals receivers in workout", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for Ravens | Jackson's workout came two days before the Ravens host the Steelers.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Allows TD to WR Zay Flowers in tryout", "Lamar Jackson/FA/CB", "Zay Flowers/BAL/WR:full_name u1"],
  ["Lamar Jackson injury update: Cornerback blitz led to ankle sprain", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Lamar Jackson injury update: Cornerback hit ruled clean", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Byron Young: Out for season, per @Eagles", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Placed on IR by PHI", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Beats Eagles starter for job", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Placed on IR | The D-lineman will miss the rest of the season.", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Waived | The IDL was let go Tuesday.", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Upset by Eagles over snap count", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Out for season, per @Chiefs", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Waived by KC", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Placed on IR | The interior D-lineman will miss the season.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Beats Chiefs starter for job", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris injury update: Defensive tackle collision caused concussion", "Marcus Harris/TEN/CB", "∅ u1"],
  ["Chris Jones: Works out for Chiefs | Jones last punted in a 2024 win over the Giants.", "Chris Jones/FA/P", "∅ u1"],
  ["Chris Jones: Signs reserve/future deal | The corner spent last season on a practice squad.", "Chris Jones/FA/CB", "∅ u1"],
  ["Chris Jones: Booms 60-yard punt against Broncos", "Chris Jones/FA/P", "∅ u1"],
  ["Chris Jones: Waived | The corner was released Tuesday.", "Chris Jones/FA/CB", "∅ u1"],
  ["Michael Carter: Out for season, per @Eagles", "Michael Carter II/PHI/S", "∅ u1"],
  ["Michael Carter: Upset by Titans over workload", "Michael Carter/TEN/RB", "∅ u1"],
  ["Michael Carter: Beats Titans starter for RB1 job", "Michael Carter/TEN/RB", "∅ u1"],
  ["Byron Murphy: Out for season, per @Vikings", "Byron Murphy Jr./MIN/CB", "∅ u1"],
  ["Byron Murphy: Beats Seahawks starter for job", "Byron Murphy II/SEA/DT", "∅ u1"],
  ["DJ Turner: Catches TD in win over Steelers", "DJ Turner/FA/WR", "∅ u1"],
  ["Justin Jefferson: Hurts knee in loss to Vikings | Jefferson (knee) exited in the third quarter and did not return.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Likely out after loss to Vikings | Jefferson (ankle) was spotted in a walking boot.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Still sidelined after loss to Minnesota", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Hand injury suffered in loss to Vikings", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Still questionable vs. Vikings | Jefferson (hamstring) was limited again Thursday.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Hurts ankle against Minnesota", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Likely done for season after 24-20 loss to Vikings", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson Hurts Knee In Loss To Vikings", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Little impact in loss to Vikings | Jefferson recorded two tackles.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Sharp in loss to Vikings | Jefferson posted 11 tackles.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Still out after Week 9 loss at Minnesota", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Byron Young: Still limited after loss to Rams", "Byron Young/PHI/DT", "∅ u1"],
  ["Byron Young: Likely out after win over Rams", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Hurts knee in win over Titans", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Still sidelined after loss to Titans", "Marcus Harris/KC/DT", "∅ u1"],
  ["Michael Carter: Still limited after win over Titans", "Michael Carter II/PHI/S", "∅ u1"],
  ["Michael Carter: Still limited after win over Eagles", "Michael Carter/TEN/RB", "∅ u1"],
  ["Byron Murphy: Still sidelined after loss to Vikings", "Byron Murphy II/SEA/DT", "∅ u1"],
  ["Byron Murphy: Hurts knee in loss to Seahawks", "Byron Murphy Jr./MIN/CB", "∅ u1"],
  ["Justin Jefferson: Hurts shoulder in Week 9 loss to the Minnesota Vikings | Jefferson (shoulder) is considered day-to-day.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson injury update: Linebacker hit caused concussion; WR in protocol", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson injury update: Linebacker hit caused concussion | The receiver is in the protocol and will miss Sunday's game.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Lamar Jackson injury update: Cornerback blitz led to ankle sprain | The quarterback is day-to-day.", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Lamar Jackson injury news: Cornerback hit on slide draws fine | Jackson (ankle) is expected to play.", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Marcus Harris injury update: Defensive tackle collision caused concussion | The Titans cornerback will sit Sunday.", "Marcus Harris/TEN/CB", "∅ u1"],
  ["Chris Jones injury update: Cornerback cut block injured knee | The Chiefs defensive tackle is out Sunday.", "Chris Jones/KC/DT", "∅ u1"],
  ["Chris Jones status: Punter collision on fake injured ankle | The Chiefs defensive tackle is questionable.", "Chris Jones/KC/DT", "∅ u1"],
  ["Justin Jefferson practice update: Linebacker drill collision tweaked hamstring | Jefferson was limited.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Lamar Jackson: Signs futures deal, per @Bengals | The corner spent 2024 on a practice squad.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Waived, per @Bengals", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Byron Young: Waived with injury designation, per @Eagles", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Placed on IR (via @Chiefs)", "Marcus Harris/KC/DT", "∅ u1"],
  ["Chris Jones: Re-signs with practice squad, per @Bills", "Chris Jones/FA/P", "∅ u1"],
  ["Justin Jefferson: Activated from IR, per @Browns", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["@Browns: Justin Jefferson placed on injured reserve", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Signs reserve/future contract | The safety-turned-corner will compete for a roster spot.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Waived | The corner was released after two weeks on the practice squad.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Chris Jones: Works out | The corner impressed in a tryout.", "Chris Jones/FA/CB", "∅ u1"],
  ["Lamar Jackson: Re-signs to practice squad | The nickel corner was cut Tuesday.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Inks futures deal | The kick returner and corner spent 2024 on IR.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["PHI waives Byron Young", "Byron Young/PHI/DT", "∅ u1"],
  ["KC places Marcus Harris on IR", "Marcus Harris/KC/DT", "∅ u1"],
  ["Lamar Jackson: Claimed off waivers by CIN", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Cut by CLE | Jefferson (knee) reverts to IR.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Byron Young: Placed on IR | The 3-technique will miss the season.", "Byron Young/PHI/DT", "∅ u1"],
  ["Lamar Jackson: Signs futures deal | The RCB spent 2024 on IR.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Placed on IR | The 'backer (knee) will miss the season.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Placed on IR | The off-ball backer will miss four games.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Marcus Harris: Waived | The D-tackle was let go.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Justin Jefferson: Sacks QB Sam Darnold twice", "Justin Jefferson/CLE/LB", "Sam Darnold/SEA/QB:full_name u1"],
  ["Justin Jefferson: Strips RB Aaron Jones Sr.", "Justin Jefferson/CLE/LB", "Aaron Jones Sr./MIN/RB:full_name u1"],
  ["Lamar Jackson: Breaks up pass to WR Ja'Marr Chase", "Lamar Jackson/FA/CB", "Ja'Marr Chase/CIN/WR:full_name u1"],
  ["Byron Young: Sacks QB Jalen Hurts in practice", "Byron Young/PHI/DT", "Jalen Hurts/PHI/QB:full_name u1"],
  ["Lamar Jackson: Visits Bengals | Jackson last appeared in a 2024 win over the Lions.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Chris Jones: Tryout with Giants | Jones averaged 45 yards per punt in a 2024 loss to the Eagles.", "Chris Jones/FA/P", "∅ u1"],
  ["Justin Jefferson: Joins Vikings practice squad", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Catches two TDs | The defender covering him was flagged for interference.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Catches two TDs | The Browns linebacker covering him was benched.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Lamar Jackson: Throws three TDs | The cornerback who intercepted him was benched.", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Lamar Jackson: Picked off twice | The cornerback returned one for a touchdown.", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["LB Justin Jefferson: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Linebacker Justin Jefferson records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Justin Jefferson (LB) records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Justin Jefferson (CLE - LB) records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Justin Jefferson (LB, CLE) records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Justin Jefferson MLB: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["LB Justin Jefferson: Sacks Vikings QB twice", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Cornerback Lamar Jackson: Works out for Ravens", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Lamar Jackson (CB) signs with Bengals", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Free-agent CB Lamar Jackson visits Bengals", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Lamar Jackson, a cornerback, signs with Bengals", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Former Nebraska cornerback Lamar Jackson visits Bengals", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Lamar Jackson DB: Signs with Bengals", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Lamar Jackson (DB) signs with Bengals", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["DT Marcus Harris: Records sack", "Marcus Harris/KC/DT", "Marcus Harris/KC/DT:full_name u0"],
  ["Defensive tackle Marcus Harris records sack", "Marcus Harris/KC/DT", "Marcus Harris/KC/DT:full_name u0"],
  ["Marcus Harris (KC - DT) records sack", "Marcus Harris/KC/DT", "Marcus Harris/KC/DT:full_name_team u0"],
  ["Marcus Harris NT: Records sack", "Marcus Harris/KC/DT", "Marcus Harris/KC/DT:full_name u0"],
  ["Punter Chris Jones works out for Bears", "Chris Jones/FA/P", "Chris Jones/FA/P:full_name u0"],
  ["Vikings sign LB Justin Jefferson off Browns practice squad", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Justin Jefferson: Sacks Vikings QB twice", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Tackles Vikings' running back for a loss", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Ravens sign CB Lamar Jackson to practice squad", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Lamar Jackson: Claimed off waivers by Ravens | The cornerback joins Baltimore's secondary.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Free-agent cornerback Lamar Jackson visits Bengals", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Lamar Jackson: Intercepts Ravens QB", "Lamar Jackson/FA/CB", "∅ u1"],
];

// Every text of the R8-3 test files R8-6 replaces (match-r83.test.ts, -round2, -round3 and
// positions.test.ts), at its R8-6 outcome — the attack texts of R8-3's rounds 1–3 among them.

// prettier-ignore
const R83_TEXTS: readonly (readonly [string, string, string])[] = [
  ["TE Justin Jefferson: Catches TD", "", "∅ u1"],
  ["Lamar Jackson, K, free agent: Works out", "", "∅ u1"],
  ["Lamar Jackson: Intercepts a pass against the Ravens", "", "∅ u1"],
  ["Lamar Jackson: Bengals beat Steelers | Jackson was limited.", "", "∅ u1"],
  ["Justin Jefferson: Vikings fall to Lions | Jefferson caught five passes.", "", "∅ u1"],
  ["Bills vs. Ravens: Lamar Jackson limited Wednesday", "", "∅ u1"],
  ["Lamar Jackson: Signs with Ravens", "", "∅ u1"],
  ["Justin Jefferson: Expected to play in Vikings matchup", "", "∅ u1"],
  ["Justin Jefferson: Records 10 tackles in Browns win", "", "∅ u1"],
  ["Justin Jefferson: Lands on injured reserve | The Browns placed Jefferson on IR with a knee injury.", "", "∅ u1"],
  ["Justin Jefferson: Leads Vikings to win | Jefferson caught nine passes.", "", "∅ u1"],
  ["Justin Jefferson: Notches 100 yards as Vikings roll", "", "∅ u1"],
  ["Lamar Jackson: Signs extension with Ravens", "", "∅ u1"],
  ["Ravens' John Harbaugh: Lamar Jackson day-to-day", "", "∅ u1"],
  ["Lamar Jackson: Ravens vs. Steelers moved to Monday", "", "∅ u1"],
  ["Ravens QB Lamar Jackson has ankle sprain", "", "Lamar Jackson/BAL/QB:full_name_team u0"],
  ["Ravens activate QB Lamar Jackson", "", "Lamar Jackson/BAL/QB:full_name u0"],
  ["Browns LB Justin Jefferson: Records sack vs. Vikings", "", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Browns vs. Bengals: Justin Jefferson records two sacks", "", "∅ u1"],
  ["Justin Jefferson: Records sack | The Browns rallied late.", "", "∅ u1"],
  ["Jefferson: Questionable for Vikings", "", "∅ u1"],
  ["Jefferson: Records sack in Vikings loss", "", "∅ u1"],
  ["Vikings WR Jefferson: Catches TD", "", "Justin Jefferson/MIN/WR:last_name_team u0"],
  ["Browns waive LB Jefferson", "", "Justin Jefferson/CLE/LB:last_name_team u0"],
  ["Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win over the Vikings, the team announced Monday.", "", "∅ u1"],
  ["Justin Jefferson: Leads team in tackles | Jefferson recorded 11 tackles (seven solo) in Sunday's 24-20 loss to the Vikings.", "", "∅ u1"],
  ["Justin Jefferson: Records first career sack | Jefferson brought down the Vikings' quarterback in the third quarter Sunday.", "", "∅ u1"],
  ["Lamar Jackson: Picks off Ravens pass | Jackson returned the interception 30 yards.", "", "∅ u1"],
  ["Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's loss to the Ravens.", "", "∅ u1"],
  ["Byron Young: Sacks Rams QB", "", "∅ u1"],
  ["Marcus Harris: Sacks Titans QB", "", "∅ u1"],
  ["Justin Jefferson: Catches two touchdowns | Jefferson caught seven passes for 110 yards in Sunday's win over the Browns.", "", "∅ u1"],
  ["Justin Jefferson: Torches Browns for 150 yards", "", "∅ u1"],
  ["Byron Young: Sacks Eagles QB twice", "", "∅ u1"],
  ["Marcus Harris: Picks off Chiefs pass", "", "∅ u1"],
  ["Justin Jefferson: Beats Browns' franchise sack record", "", "∅ u1"],
  ["Justin Jefferson: Fell to Browns' third string", "", "∅ u1"],
  ["Justin Jefferson: Burns Browns' secondary for two scores", "", "∅ u2"],
  ["Justin Jefferson: Questionable for Sunday's game at Cleveland", "", "∅ u1"],
  ["Justin Jefferson: Tops Browns' depth chart at linebacker", "", "∅ u1"],
  ["Justin Jefferson: Faces Browns' fine for the hit", "", "∅ u1"],
  ["Justin Jefferson (LB) questionable", "", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Lamar Jackson, CB, free agent: Works out for Bears", "", "∅ u1"],
  ["Lamar Jackson injury update: Bengals CB dealing with ankle sprain", "", "∅ u1"],
  ["Justin Jefferson: Dealing with knee injury | The linebacker did not practice Wednesday.", "", "∅ u1"],
  ["Justin Jefferson: Questionable for Sunday | Jefferson (ankle) was limited. The defender has started every game.", "", "∅ u1"],
  ["Justin Jefferson: Practices fully | The Vikings wideout faces Cleveland on Sunday.", "", "∅ u1"],
  ["Justin Jefferson: Records 12 tackles in loss to Vikings | The Browns linebacker led the team.", "", "∅ u1"],
  ["Justin Jefferson: Catches TD | Denzel Ward covered him. The linebacker was beaten twice.", "", "Denzel Ward/CLE/CB:full_name u1"],
  ["Justin Jefferson: Catches TD | The linebacker who covered Jefferson was benched.", "", "∅ u1"],
  ["Lamar Jackson: Safety concerns linger after hit", "", "∅ u1"],
  ["Browns LB Justin Jefferson: Records sack", "", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Kansas City DT Marcus Harris: Records sack", "", "Marcus Harris/KC/DT:full_name_team u0"],
  ["Browns WR Justin Jefferson: Catches TD", "", "∅ u1"],
  ["Browns WR Jefferson: Catches TD", "", "∅ u1"],
  ["LB Justin Jefferson: Records sack | The linebacker led the team in tackles.", "", "Justin Jefferson/CLE/LB:full_name u0"],
  ["WR Justin Jefferson: Questionable | The linebacker did not practice Wednesday.", "", "Justin Jefferson/MIN/WR:full_name u0"],
  ["WR Justin Jefferson (LB): Questionable", "", "∅ u1"],
  ["LB Justin Jefferson: Records sack | Justin Jefferson added two tackles.", "", "Justin Jefferson/CLE/LB:full_name u0"],
  // R8-7 (5): a spelling makes no holder the residual's taker (Michael Carter II/PHI/S:full_name u0 at 66bb2a2)
  ["Michael Carter II: Records interception | Michael Carter also forced a fumble.", "", "∅ u1"],
  // R8-7 (5): a spelling makes no holder the residual's taker (Michael Carter II/PHI/S:full_name u0 at 66bb2a2)
  ["Michael Carter II", "", "∅ u1"],
  ["Browns LB Jefferson: Records sack", "", "Justin Jefferson/CLE/LB:last_name_team u0"],
  ["Ravens QB Jackson: Limited in practice", "", "Lamar Jackson/BAL/QB:last_name_team u0"],
  ["Sources: Ravens QB Jackson has ankle sprain, slim chance to play Week 5", "", "Lamar Jackson/BAL/QB:last_name_team u0"],
  ["Cleveland's Jefferson: Placed on IR", "", "∅ u1"],
  ["Cleveland's Jefferson: Placed on IR | The linebacker will miss four games.", "", "∅ u1"],
  ["Cleveland's Jefferson: Placed on IR | Ward was beaten. The linebacker will miss time.", "", "∅ u2"],
  ["Cleveland LB Jefferson: Placed on IR", "", "Justin Jefferson/CLE/LB:last_name_team u0"],
  ["DL Byron Young: Records sack", "", "∅ u1"],
  ["Michael Carter: Limited in practice", "", "∅ u1"],
  ["Ravens' Jackson: Limited", "", "∅ u1"],
  // R8-7 (4): an unlabelled shared surname is counted (∅ u0 at 66bb2a2)
  ["Jackson: Limited", "", "∅ u1"],
  ["Michael Carter: Limited | Ja'Marr Chase caught 10 passes.", "", "Ja'Marr Chase/CIN/WR:full_name u1"],
  ["Justin Jefferson: Placed on IR | Jefferson (knee) will miss at least four games.", "", "Justin Jefferson/MIN/WR:full_name u0"],
  ["Byron Young: Placed on IR | Young (knee) will miss the rest of the season.", "", "Byron Young/LA/DE:full_name u0"],
  ["Marcus Harris: Placed on IR | Harris (knee) will miss the rest of the season.", "", "Marcus Harris/TEN/CB:full_name u0"],
  ["Lamar Jackson: Inks reserve/future contract", "", "Lamar Jackson/BAL/QB:full_name u0"],
  ["Justin Jefferson: Catches TD as Vikings rally late", "", "∅ u1"],
  ["Justin Jefferson: Practices fully Wednesday | The Vikings wideout faces Cleveland on Sunday.", "", "∅ u1"],
  ["Justin Jefferson catches two touchdowns as Minnesota beats Cleveland", "", "∅ u1"],
  ["Browns' secondary must slow Justin Jefferson", "", "∅ u1"],
  ["Cleveland defense prepares for Justin Jefferson", "", "∅ u1"],
  ["Justin Jefferson (hamstring) questionable for Sunday vs. CLE", "", "∅ u1"],
  ["Justin Jefferson, WR, Minnesota: Questionable", "", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Minnesota Vikings star Justin Jefferson ruled out", "", "∅ u1"],
  // R8-8 (1), violation 10: a capitalised word before a shared surname no longer silences it, a first
  // name's neither ("O'Connell", "Walker", "Smith", "St. Brown", "Former Brown" counted; u0 at 08524ff)
  ["Kevin O'Connell: Justin Jefferson will play Sunday", "", "Justin Jefferson/MIN/WR:full_name u1"],
  ["Justin Jefferson: Questionable, Browns next | Jefferson (hamstring) did not practice.", "", "∅ u1"],
  ["Justin Jefferson and the Vikings visit the Browns in Week 9", "", "∅ u1"],
  ["Justin Jefferson: Traded to Browns", "", "∅ u1"],
  ["Vikings trade Justin Jefferson to Browns", "", "∅ u1"],
  ["Browns linebacker Justin Jefferson suspended", "", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Justin Jefferson, LB, Cleveland: Out with knee injury", "", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Cleveland's Justin Jefferson: Placed on IR", "", "∅ u1"],
  ["Justin Jefferson: Released by Browns", "", "∅ u1"],
  ["Justin Jefferson: Forces fumble vs. Vikings", "", "∅ u1"],
  ["Lamar Jackson: Throws three TDs vs. Bengals", "", "∅ u1"],
  ["Baltimore QB Lamar Jackson questionable", "", "Lamar Jackson/BAL/QB:full_name_team u0"],
  ["Lamar Jackson (ankle) limited | The Ravens quarterback was limited.", "", "∅ u1"],
  ["Lamar Jackson: Sacked five times by Steelers", "", "∅ u1"],
  ["Byron Young: Records two sacks against Eagles | The Rams edge rusher was dominant.", "", "∅ u1"],
  ["Byron Young: Records two sacks against Rams | The Eagles defensive tackle was dominant.", "", "∅ u1"],
  ["Rams' Byron Young: Two sacks", "", "Byron Young/LA/DE:full_name_team u0"],
  ["Philadelphia's Byron Young: Two sacks", "", "∅ u1"],
  ["Marcus Harris: Breaks up two passes vs. Chiefs | The Titans cornerback had a strong game.", "", "∅ u1"],
  ["Marcus Harris: Records sack vs. Titans | The Chiefs defensive tackle got home.", "", "∅ u1"],
  ["Vikings WR Justin Jefferson: Questionable vs. Browns", "", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["WR Justin Jefferson: Records 100 yards", "", "Justin Jefferson/MIN/WR:full_name u0"],
  ["CB Lamar Jackson: Signs with Bengals", "", "Lamar Jackson/FA/CB:full_name u0"],
  ["Bengals CB Jackson: Signed to practice squad", "", "∅ u1"],
  ["Lamar Jackson: Works out for Bengals", "", "∅ u1"],
  ["Lamar Jackson: Visits Bears", "", "∅ u1"],
  ["Lamar Jackson: Waived with injury designation | Jackson (hamstring) reverts to injured reserve.", "", "Lamar Jackson/BAL/QB:full_name u0"],
  ["Justin Jefferson: Notches 11 tackles in Vikings loss | The linebacker led all defenders.", "", "∅ u1"],
  ["Justin Jefferson: Leads team in tackles | Jefferson recorded 11 tackles (seven solo) in Sunday's 24-20 win over the Vikings.", "", "∅ u1"],
  ["Lamar Jackson: Snags interception | Jackson picked off the Ravens' quarterback in the fourth quarter of Sunday's loss.", "", "∅ u1"],
  ["Byron Young: Two sacks in win | Young sacked the Rams' quarterback twice in Sunday's 27-17 win.", "", "∅ u1"],
  ["Lamar Jackson: Accounts for three scores | Jackson threw two touchdowns and ran for another in Sunday's win over the Bengals.", "", "∅ u1"],
  ["Justin Jefferson: Exits with knee injury | Jefferson left Sunday's loss to the Vikings in the third quarter and did not return.", "", "∅ u1"],
  ["Lamar Jackson: Intercepts a pass against the Baltimore Ravens", "", "∅ u1"],
  ["Justin Jefferson: Catches TD | Jefferson caught seven passes in a win over the Browns. The Browns fell to 2-6.", "", "∅ u1"],
  ["Justin Jefferson: Catches TD in win over the Cleveland Browns", "", "∅ u1"],
  ["Lamar Jackson: Throws pick-six | The cornerback jumped the route.", "", "∅ u1"],
  ["Lamar Jackson throws pick-six: Bengals cornerback returns it 80 yards", "", "∅ u1"],
  // R8-7 (5): a spelling makes no holder the residual's taker (Byron Murphy II/SEA/DT:full_name u0 at 66bb2a2)
  ["Byron Murphy II", "", "∅ u1"],
  ["Justin Jefferson: Catches two TDs | Jefferson caught seven passes. The quarterback found him twice in the red zone.", "", "∅ u1"],
  ["Ravens' Lamar Jackson: Picked off twice | The cornerback returned one for a touchdown.", "", "Lamar Jackson/BAL/QB:full_name_team u0"],
  ["Lamar Jackson (Ravens) picked off twice | The cornerback returned one for a touchdown.", "", "Lamar Jackson/BAL/QB:full_name_team u0"],
  ["Vikings WR Justin Jefferson: Catches TD | The Browns linebacker covering him was flagged.", "", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Vikings' Justin Jefferson: Catches TD | The cornerback covering him was benched.", "", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Ravens QB Lamar Jackson: Picked off twice | The cornerback returned one for a touchdown.", "", "Lamar Jackson/BAL/QB:full_name_team u0"],
  ["Ravens QB Lamar Jackson: Sacked twice | The linebacker got home twice.", "", "Lamar Jackson/BAL/QB:full_name_team u0"],
  ["Rams' Byron Young: Two sacks | The quarterback he sacked twice left the game.", "", "Byron Young/LA/DE:full_name_team u0"],
  ["Rams OLB Byron Young: Two sacks | The quarterback went down twice.", "", "Byron Young/LA/DE:full_name_team u0"],
  ["Titans' Marcus Harris: Picks off pass | The receiver he covered was held to one catch.", "", "Marcus Harris/TEN/CB:full_name_team u0"],
  ["Chiefs' Chris Jones: Two sacks | The quarterback he sacked left the game.", "", "Chris Jones/KC/DT:full_name_team u0"],
  ["Vikings WR Justin Jefferson: Catches two TDs | Jefferson caught seven passes. The quarterback found him twice in the red zone.", "", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Justin Jefferson: Catches two TDs vs. Browns | The quarterback found him twice in the red zone.", "", "∅ u1"],
  ["Vikings WR Jefferson: Catches TD | The quarterback found him twice.", "", "Justin Jefferson/MIN/WR:last_name_team u0"],
  ["Lamar Jackson: Limited ahead of Bengals game", "", "∅ u1"],
  ["Justin Jefferson: Catches TD | Jefferson caught seven passes in a win at Cleveland.", "", "∅ u1"],
  ["Justin Jefferson: Questionable for Browns game | Jefferson, the Vikings' top receiver, was limited Wednesday.", "", "∅ u1"],
  ["Rams edge rusher Byron Young: Two sacks", "", "Byron Young/LA/DE:full_name_team u0"],
  ["Rams outside linebacker Byron Young: Two sacks", "", "Byron Young/LA/DE:full_name_team u0"],
  ["Chiefs defensive lineman Chris Jones: Two sacks", "", "Chris Jones/KC/DT:full_name_team u0"],
  ["Vikings slot receiver Justin Jefferson: Questionable", "", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Ravens signal-caller Lamar Jackson: Questionable", "", "Lamar Jackson/BAL/QB:full_name_team u0"],
  ["Justin Jefferson (WR, Vikings) questionable", "", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Justin Jefferson, the Vikings' star receiver, is questionable", "", "∅ u1"],
  ["Cleveland's Jefferson: Sacks Vikings QB twice", "", "∅ u1"],
  ["Cleveland's Justin Jefferson: Sacks Vikings QB twice", "", "∅ u1"],
  ["Browns' Jefferson: Records sack vs. Vikings", "", "∅ u1"],
  ["Browns' Justin Jefferson: Records sack vs. Vikings", "", "∅ u1"],
  ["Browns' Jefferson: Records sack in loss to Vikings", "", "∅ u1"],
  ["Browns' Justin Jefferson: Records sack in loss to Vikings", "", "∅ u1"],
  ["Browns' Jefferson: Records sack in win over Vikings", "", "∅ u1"],
  ["Browns' Justin Jefferson: Records sack in win over Vikings", "", "∅ u1"],
  ["Jefferson, Browns: Records sack vs. Vikings", "", "∅ u1"],
  ["Justin Jefferson, Browns: Records sack vs. Vikings", "", "∅ u1"],
  ["Jefferson (Browns) records sack vs. Vikings", "", "∅ u1"],
  ["Justin Jefferson (Browns) records sack vs. Vikings", "", "∅ u1"],
  ["Eagles' Young: Sacks Rams QB", "", "∅ u1"],
  ["Eagles' Byron Young: Sacks Rams QB", "", "∅ u1"],
  ["Cleveland's Jefferson: Records sack", "", "∅ u1"],
  ["Cleveland's Justin Jefferson: Records sack", "", "∅ u1"],
  ["Byron Young: Two sacks against the Rams", "", "∅ u1"],
  ["Byron Young: Two sacks against the Philadelphia Eagles", "", "∅ u1"],
  ["Chiefs pass rusher Chris Jones: Two sacks", "", "Chris Jones/KC/DT:full_name_team u0"],
  ["Pass rusher Chris Jones: Questionable", "", "Chris Jones/KC/DT:full_name u0"],
  ["Chiefs pass rusher Jones: Two sacks", "", "Chris Jones/KC/DT:last_name_team u0"],
  ["Chiefs DT Chris Jones: Two sacks", "", "Chris Jones/KC/DT:full_name_team u0"],
  ["Jefferson: Questionable for Vikings | Jordan Addison was limited too.", "", "Jordan Addison/MIN/WR:full_name_team u1"],
  ["Blake Cashman: Records 12 tackles in Vikings win | Jefferson caught two touchdowns.", "", "Blake Cashman/MIN/LB:full_name_team u1"],
  ["Kyler Murray: Throws three TDs to Jefferson | The Vikings beat the Bears.", "", "Kyler Murray/MIN/QB:full_name_team u1"],
  ["Jordan Addison: Steps up | Addison and Jefferson combined for 200 yards for the Vikings.", "", "Jordan Addison/MIN/WR:full_name_team u1"],
  // R8-7 (4): an unlabelled shared surname is counted (Kyler Murray/MIN/QB:full_name u0 at 66bb2a2)
  ["Kyler Murray: Throws three TDs to Jefferson", "", "Kyler Murray/MIN/QB:full_name u1"],
  ["Lamar Jackson: Lands on Bengals practice squad", "", "∅ u1"],
  ["Byron Young (LAR) questionable", "", "Byron Young/LA/DE:full_name_team u0"],
  ["Justin Jefferson: Out for season | Jefferson tore his ACL in practice, a big loss to the Browns.", "", "∅ u1"],
  ["Justin Jefferson: Out | Jefferson, lost to the Browns in free agency, tore his ACL.", "", "∅ u1"],
  ["Justin Jefferson: Out for season | Jefferson was lost to the Browns.", "", "∅ u1"],
  ["Justin Jefferson: Out for season | Jefferson lost to the Browns for the season with a torn ACL.", "", "∅ u1"],
  ["Justin Jefferson: Rookie profile | Jefferson fell to the Browns.", "", "∅ u1"],
  ["Justin Jefferson: Rookie profile | Jefferson slid past the Browns to the fifth round of the draft.", "", "∅ u1"],
  ["Justin Jefferson: Rookie profile | Jefferson fell to the Browns at No. 150 overall.", "", "∅ u1"],
  ["Justin Jefferson: Fined | Jefferson torched the Browns on social media after his release.", "", "∅ u1"],
  ["Justin Jefferson: Files grievance against Browns", "", "∅ u1"],
  ["Justin Jefferson: Files grievance against the Browns' front office", "", "∅ u1"],
  ["Justin Jefferson: Out for season | Jefferson tore his ACL, and injuries have gashed the Browns' secondary.", "", "∅ u1"],
  ["Justin Jefferson: Busy day | Jefferson made 12 tackles as Minnesota's offense torched the Browns' secondary.", "", "∅ u1"],
  ["Justin Jefferson: Out for season | Jefferson's injury shreds the Browns' secondary.", "", "∅ u1"],
  ["Justin Jefferson: Out | Losing Jefferson is a big loss to the Browns.", "", "∅ u1"],
  ["Justin Jefferson: Lands on IR | It is a significant loss to the Browns.", "", "∅ u1"],
  ["Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win over the Vikes.", "", "∅ u1"],
  ["Justin Jefferson: Out | The linebacker's knee gave out on him Sunday.", "", "∅ u1"],
  ["Justin Jefferson: Out for season | Linebackers coach Jim Leonhard said the injury is serious.", "", "∅ u1"],
  ["Byron Young: Out for season | Young tore his pectoral, a blow to the Eagles.", "", "∅ u1"],
  ["Justin Jefferson: Out for season | Jefferson tore his ACL as Minnesota's offense rolled to a win over the Browns.", "", "∅ u1"],
  ["Justin Jefferson: Catches two TDs | Jefferson caught seven passes for 110 yards, including two touchdowns, in a 27-20 win over the Browns.", "", "∅ u1"],
  ["Justin Jefferson: Catches TD | Jefferson torched the Browns' secondary for 150 yards.", "", "∅ u1"],
  ["Justin Jefferson: Out for season | Jefferson tore his ACL in practice against the Browns' starters. The linebacker will miss the season.", "", "∅ u1"],
  ["Justin Jefferson: Catches TD | Jefferson caught two passes against the Browns' starters.", "", "∅ u1"],
  ["Sam Twin: Out vs. Bills, vs. Dolphins", "", "∅ u0"],
  ["Sam Twin, Dolphins: Out vs. Bills", "", "∅ u0"],
  // R8-7 (5): a spelling makes no holder the residual's taker (Byron Murphy Jr./MIN/CB:full_name u0 at 66bb2a2)
  ["Byron Murphy Jr.", "", "∅ u1"],
  ["Lamar Jackson injury update: Cornerback limited after a late hit on him", "", "∅ u1"],
  ["Lamar Jackson injury update: Ravens QB dealing with ankle sprain; Week 5 status still unknown, per report", "", "∅ u1"],
  ["Lamar Jackson injury update: Cornerback limited in practice Wednesday", "", "∅ u1"],
  ["Lamar Jackson status: Ravens QB questionable, per John Harbaugh", "", "∅ u1"],
  ["Chris Jones injury update: Chiefs DT dealing with knee soreness", "", "∅ u1"],
  ["Chris Jones injury update: Chiefs DT fined for hit on Broncos QB", "", "∅ u1"],
  ["Lamar Jackson injury update: Ravens QB dealing with ankle sprain", "", "∅ u1"],
  ["Lamar Jackson injury update: Ravens' top cornerback also ruled out", "", "∅ u1"],
  ["Lamar Jackson injury update: Cornerback fined for hit on BAL QB", "", "∅ u1"],
  ["Lamar Jackson injury update: CORNERBACK FINED FOR HIT ON RAVENS STAR", "", "∅ u1"],
  ["Justin Jefferson injury is a big loss to Browns", "", "∅ u1"],
  ["Justin Jefferson is lost to Browns with torn ACL", "", "∅ u1"],
  ["Justin Jefferson: Catches TD | Jefferson caught two passes in a big loss to the Browns.", "", "∅ u1"],
  ["Justin Jefferson: Catches TD | Jefferson caught two passes, a 24-20 loss to the Browns.", "", "∅ u1"],
  ["Justin Jefferson: Catches TD | Jefferson caught two passes in Sunday's loss to the Browns.", "", "∅ u1"],
  ["Justin Jefferson Catches Two TDs In Loss To Browns", "", "∅ u1"],
  ["Vikings injured Justin Jefferson's teammate", "", "∅ u1"],
  ["Vikings injured WR Justin Jefferson: Out", "", "Justin Jefferson/MIN/WR:full_name u0"],
  ["Minnesota's injured Justin Jefferson: Out", "", "∅ u1"],
  ["Justin Jefferson: Activated by Vikings", "", "∅ u1"],
  ["Lamar Jackson: Activated by Ravens", "", "∅ u1"],
  ["Byron Young: Activated by Rams", "", "∅ u1"],
  ["Marcus Harris: Activated by Titans", "", "∅ u1"],
  ["Justin Jefferson: Activated off IR by Vikings", "", "∅ u1"],
  ["Justin Jefferson: Placed on IR by Vikings", "", "∅ u1"],
  ["Lamar Jackson: Placed on injured reserve by Ravens", "", "∅ u1"],
  ["Vikings place Justin Jefferson on injured reserve", "", "∅ u1"],
  ["Ravens place Lamar Jackson on IR", "", "∅ u1"],
  ["Justin Jefferson: Reinstated by Vikings", "", "∅ u1"],
  ["Vikings reinstate Justin Jefferson", "", "∅ u1"],
  ["Justin Jefferson: Placed on IR by Browns", "", "∅ u1"],
  ["Browns place Justin Jefferson on IR", "", "∅ u1"],
  ["Justin Jefferson: Activated by Browns", "", "∅ u1"],
  ["Vikings place Justin Jefferson among top receivers", "", "∅ u1"],
  ["Justin Jefferson of the Vikings: Questionable", "", "∅ u1"],
  ["Justin Jefferson of the Minnesota Vikings is questionable for Sunday", "", "∅ u1"],
  ["Lamar Jackson of the Ravens: Questionable", "", "∅ u1"],
  ["Vikings superstar Justin Jefferson: Questionable", "", "∅ u1"],
  ["Vikings playmaker Justin Jefferson: Questionable", "", "∅ u1"],
  // R8-7 (3): the scan's form is a label form (∅ u1 at 66bb2a2)
  ["Vikings pass-catcher Justin Jefferson: Questionable", "", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Ravens superstar Lamar Jackson: Questionable", "", "∅ u1"],
  ["Ravens MVP Lamar Jackson: Questionable", "", "∅ u1"],
  ["Vikings' No. 1 receiver Justin Jefferson: Questionable", "", "Justin Jefferson/MIN/WR:full_name u0"],
  ["Vikings' top receiver Justin Jefferson: Questionable", "", "Justin Jefferson/MIN/WR:full_name u0"],
  ["Vikings WRs Jordan Addison and Justin Jefferson limited", "", "Jordan Addison/MIN/WR:full_name_team u1"],
  // R8-7 (3): the scan's form is a label form (Jordan Addison/MIN/WR:full_name_team u1 at 66bb2a2)
  ["Vikings receivers Justin Jefferson and Jordan Addison limited", "", "Justin Jefferson/MIN/WR:full_name_team, Jordan Addison/MIN/WR:full_name_team u0"],
  ["Justin Jefferson, out of the Vikings' lineup, is day-to-day", "", "∅ u1"],
  ["Vikings top Justin Jefferson: Questionable", "", "∅ u1"],
  ["Browns LB Jordan Hicks and Justin Jefferson limited", "", "Jordan Hicks/CLE/LB:full_name_team u1"],
  ["Browns linebackers Jordan Hicks and Justin Jefferson limited", "", "Jordan Hicks/CLE/LB:full_name_team u1"],
  ["Vikings at Bears: Justin Jefferson questionable", "", "∅ u1"],
  ["Bears at Vikings: Justin Jefferson questionable", "", "∅ u1"],
  ["Ravens at Steelers: Lamar Jackson questionable", "", "∅ u1"],
  ["Bears at Lions: Justin Jefferson questionable", "", "∅ u1"],
  ["Vikings at Browns: Justin Jefferson questionable", "", "∅ u1"],
  ["Lamar Jackson: Questionable for Sunday's game at Pittsburgh", "", "∅ u1"],
  ["Lamar Jackson: Three TDs | Jackson found Zay Flowers twice in the win over the Bengals.", "", "Zay Flowers/BAL/WR:full_name u1"],
  ["Lamar Jackson: Three TDs | Jackson and Derrick Henry ran wild in the win over the Bengals.", "", "Derrick Henry/BAL/RB:full_name u1"],
  ["Justin Jefferson: Catches TD | Jefferson and Jordan Addison combined for 200 yards in the win over the Browns.", "", "Jordan Addison/MIN/WR:full_name u1"],
  ["Justin Jefferson: Struggles | Bijan Robinson ran past Justin Jefferson in the win over the Browns.", "", "Bijan Robinson/ATL/RB:full_name u1"],
  ["Justin Jefferson: Released | Jefferson's former teammate Kirk Cousins threw two TDs in the win over the Browns.", "", "Kirk Cousins/LV/QB:full_name u1"],
  ["Justin Jefferson: Big day | Jefferson's two touchdowns led the win over the Browns.", "", "∅ u1"],
  ["Justin Jefferson: Struggles | Justin Jefferson was no match for Bijan Robinson in the win over the Browns.", "", "Bijan Robinson/ATL/RB:full_name u1"],
  ["Justin Jefferson: Struggles | Unlike Justin Jefferson, Bijan Robinson starred in the win over the Browns.", "", "Bijan Robinson/ATL/RB:full_name u1"],
  ["Lamar Jackson: Big day | Jackson outdueled Joe Burrow in the win over the Bengals.", "", "Joe Burrow/CIN/QB:full_name_team u1"],
  ["Lamar Jackson: Big day | Jackson, Derrick Henry and Zay Flowers ran wild in the win over the Bengals.", "", "Derrick Henry/BAL/RB:full_name, Zay Flowers/BAL/WR:full_name u1"],
  ["Lamar Jackson: Big day | Jackson found Van Jefferson twice in the win over the Bengals.", "", "Van Jefferson/FA/WR:full_name u1"],
  ["Van Jefferson", "", "Van Jefferson/FA/WR:full_name u0"],
  ["Vikings WRs Jordan Addison, Justin Jefferson limited", "", "Jordan Addison/MIN/WR:full_name_team u1"],
  ["Lamar Jackson: Limited | Jackson (ankle) was limited; the Ravens visit the Bengals Sunday.", "", "∅ u1"],
  ["Lamar Jackson: Limited | Jackson (ankle) was limited, and the Ravens visit the Bengals Sunday.", "", "∅ u1"],
  ["Justin Jefferson: Questionable | Jefferson (hamstring) did not practice. Vikings vs. Bengals kicks off at noon.", "", "∅ u1"],
  ["Justin Jefferson: Questionable | Jefferson (hamstring) is questionable; the Vikings host the Bengals Sunday.", "", "∅ u1"],
  ["Justin Jefferson: Out for season | Jefferson tore his ACL. Minnesota's offense struggled in the loss to the Browns.", "", "∅ u1"],
  ["Lamar Jackson: Torches Bengals for three touchdowns", "", "∅ u1"],
  ["Justin Jefferson: Torches Browns for two touchdowns", "", "∅ u1"],
  ["Justin Jefferson: Burns Browns cornerback for 60-yard TD", "", "∅ u2"],
  ["Justin Jefferson: Torches Browns CB for two touchdowns", "", "∅ u1"],
  ["Justin Jefferson: Beats Browns safety for long touchdown", "", "∅ u1"],
  ["Marcus Harris: Burned by Chiefs receiver for touchdown", "", "∅ u1"],
  ["Justin Jefferson: Torches Browns for a lack of support", "", "∅ u1"],
  ["Justin Jefferson: Torches Browns' linebacker depth", "", "∅ u1"],
  ["Lamar Jackson: Questionable for Sunday's 1 P.M. kickoff | Jackson (ankle) was limited.", "", "Lamar Jackson/BAL/QB:full_name u0"],
  ["Lamar Jackson: Throws three touchdowns | Jackson found P.J. Walker twice.", "", "Lamar Jackson/BAL/QB:full_name u1"],
  ["Lamar Jackson: Ruled out | Jackson (knee) will not play, coach John Harbaugh said at a 2 P.M. news conference.", "", "Lamar Jackson/BAL/QB:full_name u0"],
  ["Lamar Jackson: Throws TD to S. Smith", "", "∅ u2"],
  ["Justin Jefferson: Placed on IR | Jefferson (knee) will miss at least four games, per P.J. Smith.", "", "Justin Jefferson/MIN/WR:full_name u1"],
  ["Lamar Jackson: Throws two TDs | Jackson hit K.J. Osborn and Isaiah Likely for scores.", "", "Lamar Jackson/BAL/QB:full_name, K.J. Osborn/FA/WR:full_name, Isaiah Likely/NYG/TE:full_name u0"],
  ["Sunday's 1 P.M. kickoff, per P.J. Smith and S. Smith", "", "∅ u1"],
  ["Lamar Jackson: Questionable for Sunday's 1 P.M. kickoff | The Ravens are thin at receiver.", "", "∅ u1"],
  ["Lamar Jackson: Questionable for Sunday's 1 P.M. kickoff | Baltimore travels to Pittsburgh.", "", "∅ u1"],
  ["Vikings S Smith: Out for Sunday", "", "Harrison Smith/MIN/S:last_name_team u0"],
  ["Vikings' Smith: Out for Sunday", "", "Harrison Smith/MIN/S:last_name_team u0"],
  ["Harrison Smith", "", "Harrison Smith/MIN/S:full_name u0"],
  ["Vikings safety Smith: Out for Sunday", "", "Harrison Smith/MIN/S:last_name_team u0"],
  ["Giants TE Johnson: Out for Sunday", "", "Theo Johnson/NYG/TE:last_name_team u0"],
  ["Giants' Johnson: Out for Sunday", "", "Theo Johnson/NYG/TE:last_name_team u0"],
  ["Theo Johnson", "", "Theo Johnson/NYG/TE:full_name u0"],
  ["Eagles' Young: Two sacks", "", "∅ u1"],
  ["Eagles' Byron Young: Two sacks", "", "∅ u1"],
  ["Philadelphia's Young: Placed on IR", "", "∅ u1"],
  ["Philadelphia's Byron Young: Placed on IR", "", "∅ u1"],
  ["Eagles DT Young: Records sack", "", "Byron Young/PHI/DT:last_name_team u0"],
  ["Eagles DT Byron Young: Records sack", "", "Byron Young/PHI/DT:full_name_team u0"],
  ["Eagles DE Young: Two sacks", "", "∅ u1"],
  ["Eagles DE Byron Young: Two sacks", "", "∅ u1"],
  ["Chiefs' Harris: Records sack", "", "∅ u1"],
  ["Chiefs' Marcus Harris: Records sack", "", "∅ u1"],
  ["Kansas City's Harris: Placed on IR", "", "∅ u1"],
  ["Kansas City's Marcus Harris: Placed on IR", "", "∅ u1"],
  ["LB Jefferson: Records sack", "", "Justin Jefferson/CLE/LB:last_name_team u0"],
  ["Linebacker Jefferson: Placed on IR", "", "Justin Jefferson/CLE/LB:last_name_team u0"],
  ["QB Jackson: Limited in practice", "", "Lamar Jackson/BAL/QB:last_name_team u0"],
  ["QB Lamar Jackson: Limited in practice", "", "Lamar Jackson/BAL/QB:full_name u0"],
  ["DT Harris: Records sack", "", "∅ u1"],
  ["Edge Young: Two sacks", "", "∅ u1"],
  ["Ja'Marr Chase: Catches two TDs | WR Jefferson added 100 yards.", "", "Ja'Marr Chase/CIN/WR:full_name u1"],
  ["Ja'Marr Chase: Catches two TDs | DT Harris added a sack.", "", "Ja'Marr Chase/CIN/WR:full_name u1"],
  ["Myles Garrett: Two sacks | LB Jefferson added one.", "", "Myles Garrett/LA/DE:full_name, Justin Jefferson/CLE/LB:last_name_team u0"],
  ["Kirk Cousins: Sacked by LB Jefferson", "", "Kirk Cousins/LV/QB:full_name, Justin Jefferson/CLE/LB:last_name_team u0"],
  ["Limited, per P.J. Smith", "", "∅ u1"],
  ["Free-agent cornerback Lamar Jackson visits", "", "Lamar Jackson/FA/CB:full_name u0"],
  ["Minnesota Vikings wide receiver Justin Jefferson", "", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Rams edge Byron Young: Sack", "", "∅ u1"],
  ["Eagles S Michael Carter II", "", "Michael Carter II/PHI/S:full_name_team u0"],
  ["LB/DE Justin Jefferson", "", "∅ u1"],
  // R8-7 (2), (3): "lb" is no ordinary word, so it counts in any case and labels (Justin Jefferson/MIN/WR:full_name u0 at 66bb2a2)
  ["lb Justin Jefferson", "", "Justin Jefferson/CLE/LB:full_name u0"],
  // R8-7 (2), (3): "lb" is no ordinary word, so it counts in any case and labels (Justin Jefferson/MIN/WR:full_name u0 at 66bb2a2)
  ["Lb Justin Jefferson", "", "Justin Jefferson/CLE/LB:full_name u0"],
  ["s Justin Jefferson", "", "Justin Jefferson/MIN/WR:full_name u0"],
  ["Linebacker Justin Jefferson", "", "Justin Jefferson/CLE/LB:full_name u0"],
  ["EDGE Byron Young", "", "Byron Young/LA/DE:full_name u0"],
  ["QB: Lamar Jackson", "", "∅ u1"],
  ["QB, Lamar Jackson", "", "∅ u1"],
  ["non-QB Lamar Jackson", "", "∅ u1"],
  // R8-7 (3): the scan's form is a label form (∅ u1 at 66bb2a2)
  ["QBs Lamar Jackson", "", "Lamar Jackson/BAL/QB:full_name u0"],
  ["the Ravens' pass rush. Lamar Jackson", "", "∅ u1"],
  ["Justin Jefferson, LB, Cleveland: Out", "", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Lamar Jackson, a free-agent cornerback, visits", "", "∅ u1"],
  ["Justin Jefferson, the Vikings' star receiver, is out", "", "∅ u1"],
  ["Sam Twin, Dolphins S: Out", "", "∅ u0"],
  ["Justin Jefferson (Browns LB) questionable", "", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Justin Jefferson (LB, Browns) questionable", "", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["LB Justin Jefferson (Browns LB) out", "", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Justin Jefferson, receiver Adam Thielen and the Vikings", "", "Adam Thielen/PIT/WR:full_name u1"],
  ["Lamar Jackson (ankle) limited", "", "Lamar Jackson/BAL/QB:full_name u0"],
  ["Lamar Jackson, quarterbacks coach says", "", "∅ u1"],
  ["Justin Jefferson, lb, Cleveland", "", "∅ u1"],
  ["Justin Jefferson: Records sack | The Browns linebacker led the team. More.", "", "∅ u1"],
  ["The Browns linebacker Justin Jefferson led the team.", "", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Lamar Jackson: Safety concerns linger", "", "∅ u1"],
  ["Justin Jefferson LB - Records sack", "", "∅ u1"],
  // R8-7 (2), (3): "lb" is no ordinary word, so it counts in any case and labels (Justin Jefferson/MIN/WR:full_name u0 at 66bb2a2)
  ["Justin Jefferson lb: Records", "", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Justin Jefferson LB rating", "", "∅ u1"],
  ["Byron Young (Eagles DT) questionable", "", "Byron Young/PHI/DT:full_name_team u0"],
  ["Lamar Jackson (CLE) limited", "", "∅ u1"],
  ["Lamar Jackson, the Ravens' newest cornerback, impresses", "", "∅ u1"],
  ["Jefferson, a second-year linebacker, will miss at least four games", "", "∅ u1"],
  ["Jefferson, the 24-year-old linebacker, will miss", "", "∅ u1"],
  ["Free-agent corner Lamar Jackson visits", "", "Lamar Jackson/FA/CB:full_name u0"],
  ["Lamar Jackson: Ravens QB dealing with ankle sprain", "", "∅ u1"],
  ["Lamar Jackson update: The cornerback covering him slipped", "", "∅ u1"],
  ["C.J. Stroud vs. Browns. St. Brown, No. 1 | Jr. scored; done! ok? end.", "", "C.J. Stroud/HOU/QB:full_name u1"],
];

describe("every case of R8-3's rounds, at its R8-6 outcome", () => {
  it("the batteries' 443 misattributions: none reaches the other holder", () => {
    expect(MISATTRIBUTIONS).toHaveLength(443);
    for (const [t, whose, want] of MISATTRIBUTIONS) holds(t, whose, want);
  });

  it("the R8-3 test files' texts", () => {
    expect(R83_TEXTS.length).toBeGreaterThan(300);
    for (const [t, whose, want] of R83_TEXTS) holds(t, whose, want);
  });
});

// ---------------------------------------------------------------------------------------------------
// The attack on R8-6's first build (at 6ba7bb1): the 23 violations its judge listed, every variant they
// named and the texts of the triage that confirmed them (VIOLATIONS_R86_1), and every other title of
// that round's batteries (the misattribution lens's 267, the code-audit lens's 90; BATTERIES_R86_1),
// each with whose item it is, at its outcome now. None reaches another holder of that player's name,
// except the readings commented below (no player named).

// prettier-ignore
const VIOLATIONS_R86_1: readonly (readonly [string, string, string])[] = [
  ["Justin Jefferson: Placed on IR | Jefferson (knee) was placed on injured reserve Tuesday, per ClevelandBrowns.com.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Placed on IR | Jefferson (knee) was placed on injured reserve Tuesday, per @ClevelandBrowns.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Placed on IR | Jefferson (knee) was placed on injured reserve Tuesday, per Vikings.com.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Byron Young: Out for season | Young (knee) will miss the rest of the year, per PhiladelphiaEagles.com.", "Byron Young/PHI/DT", "∅ u1"],
  ["LB1 Justin Jefferson: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Lamar Jackson: Promoted to CB2 | Jackson will start Sunday.", "", "∅ u1"],
  ["Lamar Jackson: Promoted to QB2 | Jackson will start Sunday.", "", "∅ u1"],
  ["Byron Young: Listed as DT2 | Young will rotate in Sunday.", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Joins defensive line rotation | Harris played 22 snaps Sunday.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Joins d-line rotation | Harris played 22 snaps Sunday.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Lamar Jackson: Bolsters secondary | Jackson signed Tuesday.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Plays dime in debut | Jackson saw 14 snaps.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Byron Young: Lines up at 1-tech | Young played 30 snaps Sunday.", "Byron Young/PHI/DT", "∅ u1"],
  ["Marcus Harris: Plays 3-tech in debut", "Marcus Harris/KC/DT", "∅ u1"],
  ["Justin Jefferson: Starting at WILL | Jefferson will call the defense.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Marcus Harris: Starting at LDT", "Marcus Harris/KC/DT", "∅ u1"],
  ["Justin Jefferson: Starting at WLB | Jefferson will call the defense.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Signs as return man | Jackson will handle kick returns.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Signs as returner | Jackson will handle kick returns.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Lines up at split end", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Moves to flanker in new offense", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Marcus Harris: Named starting iDL", "Marcus Harris/KC/DT", "∅ u1"],
  ["JUSTIN JEFFERSON: TOPS ALL LBS IN SNAPS", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Tops all LBs in snaps", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["JUSTIN JEFFERSON: AMONG LBS RELEASED", "", "∅ u1"],
  ["Justin Jefferson: Records sack in Minneapolis | Jefferson got home once in Sunday's loss.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Waived after workout in Tampa | Jefferson was let go Tuesday.", "", "∅ u1"],
  ["Lamar Jackson: Works out in Tampa Bay | Jackson auditioned Tuesday.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Signs in Arlington", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Marcus Harris: Works out in Paradise | Harris auditioned Tuesday.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Justin Jefferson: Ex-Brown finds new home | Jefferson signed a one-year deal Tuesday.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Ex-Raven signs reserve/future deal", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Former Bear released | Jefferson was let go Tuesday.", "", "∅ u1"],
  ["Chris Jones: Works out | Jones punted for OAK in 2018.", "Chris Jones/FA/P", "∅ u1"],
  ["Justin Jefferson: Waived by LVR | Jefferson cleared waivers.", "", "∅ u1"],
  ["Lamar Jackson: Signs with KAN | Jackson inked a one-year deal.", "", "∅ u1"],
  ["Lamar Jackson: Works out | Jackson spent 2019 with the Redskins.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Records sack #CLEvsMIN", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Waived | #RaiderNation", "", "∅ u1"],
  ["Lamar Jackson: Waived | Raider", "", "∅ u1"],
  ["Justin Jefferson: Records sack #Browns", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Byron Young: Strip-sack seals win for Birds", "Byron Young/PHI/DT", "∅ u1"],
  ["Lamar Jackson: Works out for 'Boys", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once for the Brօwns.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once for the Brоwns.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Waived | The cb was released Tuesday.", "", "∅ u1"],
  ["Lamar Jackson: Waived | The CB was released Tuesday.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Cut | The olb was waived Tuesday.", "", "∅ u1"],
  ["Justin Jefferson: Elite wide-out | Jefferson had 150 yards.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Lamar Jackson: Pitches to full-back for TD", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Chris Jones: Doubles as holder | Jones will hold on field goals.", "", "∅ u1"],
  ["Byron Young: Lines up at nose | Young played 40 snaps.", "", "∅ u1"],
  ["Justin Jefferson: Special teams ace re-signs", "", "∅ u1"],
  ["Against the Vikings Justin Jefferson recorded 12 tackles", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Against the Vikings, Justin Jefferson recorded 12 tackles", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Browns' defense holds firm | Against Minnesota Justin Jefferson posted 12 tackles and a sack.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Against the Rams Byron Young recorded two sacks.", "Byron Young/PHI/DT", "∅ u1"],
  ["After safety Lamar Jackson leads Ravens on winning drive", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Browns' defense holds firm | Against the Vikings Jefferson had 12 tackles and a sack.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Browns IDP notes | <p>Week 9 vs. the Vikings</p><p>Justin Jefferson led the team with 12 tackles.</p>", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Browns IDP notes | Week 9 at Vikings\nJustin Jefferson led the team with 12 tackles.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Browns IDP notes | <p>Week 9 vs. the Vikings.</p><p>Justin Jefferson led the team with 12 tackles.</p>", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Rams' Byron Young's namesake lands on IR with Eagles", "", "Byron Young/LA/DE:full_name_team u0"],
  ["Ravens QB Lamar Jackson's namesake signs with Bengals", "", "Lamar Jackson/BAL/QB:full_name_team u0"],
  ["Vikings WR Justin Jefferson has a namesake, and Justin Jefferson the linebacker just made the Browns' roster", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["'Beat the Vikings' Justin Jefferson tells Browns teammates", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["‘Beat the Vikings’ Justin Jefferson tells Browns teammates", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["'Beat the Vikings,' Justin Jefferson tells Browns teammates", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["'I want to play in Baltimore' Lamar Jackson says after tryout", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Vikings' Justin Jefferson: Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Vikings CB Smith: Waived | The cornerback was let go Tuesday.", "", "∅ u1"],
  ["Chiefs DE Jones: Waived | The defensive end was let go Tuesday.", "", "∅ u1"],
  ["Ravens CB Jackson: Signed to practice squad", "", "∅ u1"],
  ["Titans S Harris: Waived | The safety was let go Tuesday.", "", "∅ u1"],
  ["Bears CB Bryant: Waived | The cornerback was let go Tuesday.", "", "∅ u1"],
  ["Justin Jefferson (Vikings wide receiver): Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Justin Jefferson (Vikings WR): Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Vikings wide receiver Justin Jefferson: Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Chris Jones (Chiefs defensive lineman): Questionable", "Chris Jones/KC/DT", "Chris Jones/KC/DT:full_name_team u0"],
  ["Michael Carter (Eagles free safety): Questionable", "Michael Carter II/PHI/S", "Michael Carter II/PHI/S:full_name_team u0"],
  ["Michael Carter (Eagles S): Questionable", "Michael Carter II/PHI/S", "Michael Carter II/PHI/S:full_name_team u0"],
  ["Justin Jefferson (Browns inside linebacker): Questionable", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Justin Jefferson, wide receiver, Vikings: Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Rams EDGE Byron Young: Two sacks", "Byron Young/LA/DE", "Byron Young/LA/DE:full_name_team u0"],
  ["Byron Young (LA - EDGE): Two sacks", "Byron Young/LA/DE", "Byron Young/LA/DE:full_name_team u0"],
  ["Byron Young (LA - DE): Two sacks", "Byron Young/LA/DE", "Byron Young/LA/DE:full_name_team u0"],
  ["EDGE Byron Young: Two sacks", "Byron Young/LA/DE", "Byron Young/LA/DE:full_name u0"],
  ["Vikings‘ Justin Jefferson: Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Vikings` Justin Jefferson: Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Vikings＇ Justin Jefferson: Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Justin Jefferson (CLE): Placed on IR", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Browns' Justin Jefferson: Placed on IR", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson, CLE: Placed on IR", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson (CLE - LB): Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Browns LB Justin Jefferson: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Seahawks LB Knight: Records sack", "Tyrice Knight/SEA/LB", "∅ u1"],
  ["Vikings WR Bell: Catches TD", "Dillon Bell/MIN/WR", "∅ u1"],
  ["Eagles DT Byron Young: Placed on IR", "Byron Young/PHI/DT", "Byron Young/PHI/DT:full_name_team u0"],
  ["Byron Young (PHI - DT): Records sack", "Byron Young/PHI/DT", "Byron Young/PHI/DT:full_name_team u0"],
  ["DE Byron Young: Records sack", "Byron Young/LA/DE", "Byron Young/LA/DE:full_name u0"],
  ["Byron Young (DE): Records sack", "Byron Young/LA/DE", "Byron Young/LA/DE:full_name u0"],
  ["Raiders CB Johnson: Waived", "Taron Johnson/LV/CB", "Taron Johnson/LV/CB:last_name_team u0"],
  ["Patriots DT Jones: Waived", "DaQuan Jones/NE/DT", "DaQuan Jones/NE/DT:last_name_team u0"],
  ["Lamar Jackson: Limited | Ravens QB Lamar Jackson (ankle) was limited Wednesday.", "Lamar Jackson/BAL/QB", "Lamar Jackson/BAL/QB:full_name_team u0"],
  ["Justin Jefferson: Questionable | Vikings WR Justin Jefferson (hamstring) did not practice.", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Justin Jefferson: Out for season | Browns LB Justin Jefferson tore his ACL.", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Michael Carter II: Questionable | Eagles S Michael Carter II (ankle) was limited.", "Michael Carter II/PHI/S", "Michael Carter II/PHI/S:full_name_team u0"],
  // R8-7 (5): a spelling makes no holder the residual's taker (Michael Carter II/PHI/S:full_name u0 at 66bb2a2)
  ["Michael Carter II: Questionable | Michael Carter II (ankle) was limited.", "Michael Carter II/PHI/S", "∅ u1"],
  ["Lamar Jackson: Throws pick to CB Lamar Jackson", "either", "∅ u1"],
  ["Michael Carter II: Waived by Titans | The running back was released.", "", "∅ u1"],
  ["Byron Murphy II: Vikings CB ruled out", "", "∅ u1"],
  ["Michael Carter II: Waived by Eagles", "Michael Carter II/PHI/S", "∅ u1"],
  ["Byron Murphy Jr.: Vikings CB ruled out", "Byron Murphy Jr./MIN/CB", "∅ u1"],
  ["Justin Jefferson (wide receiver, Vikings): Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Chris Jones, defensive lineman, Chiefs: Out", "Chris Jones/KC/DT", "Chris Jones/KC/DT:full_name_team u0"],
  ["Michael Carter (Eagles free safety): Pick", "Michael Carter II/PHI/S", "Michael Carter II/PHI/S:full_name_team u0"],
  ["Eagles strong safety Michael Carter II: Pick", "Michael Carter II/PHI/S", "Michael Carter II/PHI/S:full_name_team u0"],
  ["Justin Jefferson (Browns inside linebacker): Out", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Justin Jefferson, Browns outside linebacker: Out", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Byron Young, EDGE, Rams: Two sacks", "Byron Young/LA/DE", "Byron Young/LA/DE:full_name_team u0"],
  ["Minnesota‘s Justin Jefferson: Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Vikings´ Justin Jefferson: Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Chiefs' Marcus Harris: Placed on IR", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris (KC): Placed on IR", "Marcus Harris/KC/DT", "∅ u1"],
  ["Seahawks LB Knight: Placed on IR", "Tyrice Knight/SEA/LB", "∅ u1"],
  ["Vikings WR Bell: Placed on IR", "Dillon Bell/MIN/WR", "∅ u1"],
  ["Byron Young (PHI - DT): Placed on IR", "Byron Young/PHI/DT", "Byron Young/PHI/DT:full_name_team u0"],
  ["Byron Young, DT, Eagles: Placed on IR", "Byron Young/PHI/DT", "Byron Young/PHI/DT:full_name_team u0"],
  ["Philadelphia defensive tackle Byron Young: Placed on IR", "Byron Young/PHI/DT", "Byron Young/PHI/DT:full_name_team u0"],
  ["Raiders CB Johnson: Placed on IR", "Taron Johnson/LV/CB", "Taron Johnson/LV/CB:last_name_team u0"],
  ["Patriots DT Jones: Placed on IR", "DaQuan Jones/NE/DT", "DaQuan Jones/NE/DT:last_name_team u0"],
  ["Justin Jefferson: Questionable | Vikings WR Justin Jefferson (hamstring) was limited.", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Justin Jefferson: Waived | The d‑line reserve was cut.", "", "∅ u1"],
  ["Edge‐rusher Justin Jefferson: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["LAMAR JACKSON: TEAM’S DECISION LOOMS", "Lamar Jackson/BAL/QB", "Lamar Jackson/BAL/QB:full_name u0"],
  ["BROWNS EDGE JUSTIN JEFFERSON, VIKINGS IN OT", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Browns IDP notes | Opponent: Vikings\nJustin Jefferson led the team with 12 tackles.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Free-agent corner Lamar Jackson visits", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Veteran corner Lamar Jackson signs with Bengals", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["After the Eagles safety Michael Carter II left, the defense struggled", "Michael Carter II/PHI/S", "Michael Carter II/PHI/S:full_name_team u0"],
  ["Lamar Jackson: Limited | Baltimore Ravens quarterback Lamar Jackson (ankle) was limited ahead of Sunday's game against the Bengals.", "Lamar Jackson/BAL/QB", "Lamar Jackson/BAL/QB:full_name_team u0"],
  ["Justin Jefferson injury update: Vikings WR questionable | Minnesota Vikings wide receiver Justin Jefferson (hamstring) did not practice.", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
];

// prettier-ignore
const BATTERIES_R86_1: readonly (readonly [string, string, string])[] = [
  ["Justin Jefferson: Signs extension | Jefferson agreed to a two-year extension Wednesday, per clevelandbrowns.com.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Signs reserve/future deal | Jackson signed a reserve/future contract Monday, per BaltimoreRavens.com.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Marcus Harris: Released | Harris was released Tuesday, per the team's website, KCChiefs.com.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Chris Jones: Signs futures deal | Jones inked a reserve/future contract Monday, per DallasCowboys.com.", "Chris Jones/FA/P", "∅ u1"],
  ["Marcus Harris: Out for season | Harris (knee) will miss the rest of the year, per TitansOnline.com.", "Marcus Harris/TEN/CB", "∅ u1"],
  ["Byron Young: Out for season | Young (knee) will miss the rest of the year, per TheRams.com.", "Byron Young/LA/DE", "∅ u1"],
  ["Justin Jefferson: Limited Wednesday | Jefferson (hamstring) was limited, a Minneapolis Star Tribune beat writer reports.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Placed on IR | Jefferson (knee) was placed on injured reserve Tuesday, per the Browns' official site.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Listed as CB1 on depth chart | Jackson signed last week.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Named LB1 | Jefferson will start in the opener.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["CB1 Lamar Jackson: Signs one-year deal", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Marcus Harris: Promoted to DL1 | Harris will start Sunday.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Chris Jones: Slides to CB2 | Jones will start Sunday.", "Chris Jones/FA/CB", "∅ u1"],
  ["Lamar Jackson: Moves up to S2 on depth chart", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Bumped to LB3 | Jefferson lost snaps Sunday.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Remains WR4 in new offense? No | Jefferson is the clear top option.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Named starting LB | Jefferson will start in the opener.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Remains WR1 | Jefferson is the clear top option.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Joins linebacking corps | Jefferson was promoted from the practice squad.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Chris Jones: Shifts from defensive line? No | Jones remains in the secondary after signing Tuesday.", "Chris Jones/FA/CB", "∅ u1"],
  ["Chris Jones: Anchors defensive line in win", "Chris Jones/KC/DT", "∅ u1"],
  ["Justin Jefferson: Joins linebacker corps | Jefferson was promoted from the practice squad.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Marcus Harris: Plays 5-tech in debut", "Marcus Harris/KC/DT", "∅ u1"],
  ["Chris Jones: Moves to 1-tech", "Chris Jones/KC/DT", "∅ u1"],
  ["Marcus Harris: Kicks out to 9-technique", "Marcus Harris/KC/DT", "∅ u1"],
  ["Lamar Jackson: Plays nickel in debut | Jackson saw 14 snaps.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Marcus Harris: Plays 5-technique in debut", "Marcus Harris/KC/DT", "∅ u1"],
  ["Justin Jefferson: Moves to MIKE", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Starting at LOLB", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Listed at RILB on depth chart", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Marcus Harris: Listed at RDT", "Marcus Harris/KC/DT", "∅ u1"],
  ["Byron Young: Listed at LDE", "either", "∅ u1"],
  ["Justin Jefferson: Starting at SAM", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Starting at RCB", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Hands off to half-back on option", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Justin Jefferson: Elite wideout | Jefferson had 150 yards.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Elite tight-end blocker? No | Jefferson had 150 yards.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Lines up at H-back", "either", "∅ u1"],
  ["Lamar Jackson: Covers the slot in debut", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Marcus Harris: Rotates in at DI | Harris played 18 snaps.", "Marcus Harris/KC/DT", "∅ u1"],
  ["Marcus Harris: Named starting IDL", "Marcus Harris/KC/DT", "∅ u1"],
  ["MARCUS HARRIS: LEADS DTS IN PRESSURES", "Marcus Harris/KC/DT", "∅ u1"],
  ["LAMAR JACKSON: AMONG TOP CBS IN COVERAGE", "Lamar Jackson/FA/CB", "∅ u1"],
  ["JUSTIN JEFFERSON: TOPS ALL LINEBACKERS IN SNAPS", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Works out in Tampa | Jackson auditioned Tuesday.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Chris Jones: Punts five times in Tampa", "Chris Jones/FA/P", "∅ u1"],
  ["Byron Young: Strip-sack in Arlington | Young forced a fumble in Sunday's win.", "either", "∅ u1"],
  ["Lamar Jackson: Visits Phoenix for workout", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Records sack in Minnesota | Jefferson got home once in Sunday's loss.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Works out in Nashville | Jackson auditioned Tuesday.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Ex-Jet signs reserve/future deal", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Former Colt lands on practice squad", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Chris Jones: Ex-Lion auditions | Jones worked out Tuesday.", "Chris Jones/FA/P", "∅ u1"],
  ["Marcus Harris: Ex-Chief signs futures deal", "Marcus Harris/KC/DT", "∅ u1"],
  ["Justin Jefferson: Former Bear lands with new team", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Ex-Saint gets workout", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Former Ram signs", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Former Giant works out", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Former Pat works out", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Ex-Bill signs", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Former Jag signs", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Ex-Bolt joins practice squad", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Ex-Buc gets workout", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Ex-Jets corner signs", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Chris Jones: Signs futures deal | Jones last punted in a regular-season game for SD.", "Chris Jones/FA/P", "∅ u1"],
  ["Chris Jones: Works out | Jones punted for STL in 2015.", "Chris Jones/FA/P", "∅ u1"],
  ["Lamar Jackson: Works out Tuesday | Jackson spent 2021 on the WFT practice squad.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out | Jackson spent 2021 with the Football Team.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Signs | Jefferson's father played for the Oilers.", "either", "∅ u1"],
  ["Chris Jones: Works out | Jones punted in Oakland in 2018.", "Chris Jones/FA/P", "∅ u1"],
  ["Chris Jones: Works out | Jones punted in St. Louis in 2015.", "Chris Jones/FA/P", "∅ u1"],
  ["Chris Jones: Works out | Jones punted in San Diego in 2016.", "Chris Jones/FA/P", "∅ u1"],
  ["Lamar Jackson: Waived by LVR", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Claimed by SFO", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Waived by GNB", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Signs with NWE", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Signs with TAM", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Signs with KAN", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Signs with NOR", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Waived by LV", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Waived by JAC", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Signs with WSH", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Records sack #MINvsCLE", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Signs practice-squad deal #RaiderNation", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Marcus Harris: Signs practice-squad deal #TitanUp", "either", "∅ u1"],
  ["Lamar Jackson: Signs #BoltUp", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Claimed off waivers #BearDown", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Signs practice-squad deal #Raiders", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for Gmen", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for G-Men", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Byron Young: Strip-sack seals win for Eagles", "Byron Young/PHI/DT", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once for the Broԝns.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once against the Vikinɡs.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["In loss to Vikings Justin Jefferson notches 12 tackles", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Facing Baltimore Lamar Jackson recorded an interception in the preseason finale.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["After workout with Ravens Lamar Jackson signs with Bengals", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Against Tennessee Marcus Harris had two sacks", "Marcus Harris/KC/DT", "∅ u1"],
  ["Against Kansas City Chris Jones averaged 48 yards per punt.", "Chris Jones/FA/P", "∅ u1"],
  ["Versus Minnesota Justin Jefferson led all tacklers.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["After safety, Lamar Jackson leads Ravens on winning drive", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Browns IDP notes | Week 9 at Vikings<br>Justin Jefferson led the team with 12 tackles.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Waiver wire, Week 9 | Released: Ravens\nLamar Jackson, cornerback, signed by the Bengals.", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Vikings' Justin Jefferson's namesake makes Browns' roster", "", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Titans CB Marcus Harris's namesake waived by Chiefs", "", "Marcus Harris/TEN/CB:full_name_team u0"],
  ["Chiefs DT Chris Jones's namesake, a punter, signs with Bills", "", "Chris Jones/KC/DT:full_name_team u0"],
  ["Lamar Jackson's namesake signs with Bengals", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Vikings CB Jackson: Waived | The cornerback was let go Tuesday.", "", "∅ u1"],
  ["Ravens S Jackson: Waived", "Keondre Jackson/BAL/S", "Keondre Jackson/BAL/S:last_name_team u0"],
  ["Bengals CB Jackson: Signed to practice squad", "", "∅ u1"],
  ["Justin Jefferson: Placed on IR | Jefferson (knee) will miss at least four games.", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name u0"],
  ["Bears CB Jaylon Johnson shadows Justin Jefferson | Browns LB Justin Jefferson had 12 tackles.", "Justin Jefferson/CLE/LB", "Jaylon Johnson/CHI/CB:full_name_team, Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Bears CB Jaylon Johnson shadows Justin Jefferson", "Justin Jefferson/MIN/WR", "Jaylon Johnson/CHI/CB:full_name_team u1"],
  ["Vikings WR Jordan Addison and Justin Jefferson combine for 200 yards", "Justin Jefferson/MIN/WR", "Jordan Addison/MIN/WR:full_name_team u1"],
  ["Vikings WRs Jordan Addison, Justin Jefferson combine for 200 yards", "Justin Jefferson/MIN/WR", "Jordan Addison/MIN/WR:full_name_team u1"],
  ["Browns' secondary must slow the Vikings' Justin Jefferson", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Justin Jefferson beat the Browns' Justin Jefferson for a TD", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Vikings' Justin Jefferson beat the Browns' Justin Jefferson for a TD", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Browns' Justin Jefferson problem: Cleveland must slow the Vikings star", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Browns\u00A0LB\u00A0Justin Jefferson: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Browns’ Justin Jefferson: Placed on IR", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Vikings‘ Justin Jefferson: Placed on IR", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Vikings` Justin Jefferson: Placed on IR", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Vikings′ Justin Jefferson: Placed on IR", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Vikings\u200B WR Justin Jefferson: Questionable", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Justin Jefferson (CLE practice squad): Signed", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson (knee): Out", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name u0"],
  ["Justin Jefferson (vs. CLE): Questionable", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson (@CLE): Questionable", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson (MIN) vs. Justin Jefferson (CLE)", "either", "∅ u1"],
  ["Justin Jefferson, Browns LB: Out for season", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Justin Jefferson, Browns linebacker, Week 9: Out", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson | MIN: Out", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson; MIN: Out", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["VIKINGS WR JUSTIN JEFFERSON: QUESTIONABLE", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["BROWNS LB JUSTIN JEFFERSON: RECORDS SACK", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["NO JUSTIN JEFFERSON, NO PROBLEM FOR VIKINGS?", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Lamar Jackson (S) signs with Bengals", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson (DB) signs with Bengals", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Chris Jones (S): Signs with Bills", "Chris Jones/FA/CB", "∅ u1"],
  ["Chris Jones (DE): Sacks Broncos QB", "Chris Jones/KC/DT", "∅ u1"],
  ["Chris Jones (P): Signs with Bills", "Chris Jones/FA/P", "Chris Jones/FA/P:full_name u0"],
  ["Bills P Chris Jones: Signs", "Chris Jones/FA/P", "∅ u1"],
  ["Byron Young (OLB): Two sacks", "Byron Young/LA/DE", "Byron Young/LA/DE:full_name u0"],
  ["Eagles DT Byron Young: Two sacks", "Byron Young/PHI/DT", "Byron Young/PHI/DT:full_name_team u0"],
  ["Chiefs DT Marcus Harris: Sack", "Marcus Harris/KC/DT", "Marcus Harris/KC/DT:full_name_team u0"],
  ["Marcus Harris (DT): Two sacks", "Marcus Harris/KC/DT", "Marcus Harris/KC/DT:full_name u0"],
  ["Ravens sign CB Lamar Jackson to practice squad", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
  ["Lamar Jackson: Signs with Ravens practice squad", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson, not the Ravens QB Lamar Jackson, signs with Bengals", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Ravens QB Lamar Jackson's namesake, CB Lamar Jackson, signs with Bengals", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Ex-Browns LB Justin Jefferson signs with Vikings practice squad", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Former Vikings WR Justin Jefferson? Not yet | Jefferson remains in Minnesota.", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:full_name_team u0"],
  ["Linebacker Jefferson: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:last_name_team u0"],
  ["Jefferson MLB: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:last_name_team u0"],
  ["Jackson QB2: Limited in practice", "Lamar Jackson/BAL/QB", "Lamar Jackson/BAL/QB:last_name_team u0"],
  ["Ravens QB Jackson: Limited in practice", "Lamar Jackson/BAL/QB", "Lamar Jackson/BAL/QB:last_name_team u0"],
  ["Vikings WR Jefferson: Catches TD", "Justin Jefferson/MIN/WR", "Justin Jefferson/MIN/WR:last_name_team u0"],
  ["Browns' Jefferson: Placed on IR", "Justin Jefferson/CLE/LB", "∅ u1"],
  // R8-7 (4): an unlabelled shared surname is counted (∅ u0 at 66bb2a2)
  ["Jefferson: Placed on IR", "either", "∅ u1"],
  ["Lamar Jackson: Inks reserve/future contract", "", "Lamar Jackson/BAL/QB:full_name u0"],
  ["Vikings vs. Browns: Justin Jefferson questionable", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Browns at Vikings Justin Jefferson props", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Browns LB records sack", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson injury update: Ravens QB dealing with ankle sprain", "Lamar Jackson/BAL/QB", "∅ u1"],
  ["Justin Jefferson: Elevated | Jefferson will play special teams.", "Justin Jefferson/MIN/WR", "∅ u1"],
  ["Justin Jefferson: Moves to Mike linebacker", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Lamar Jackson: Signs with Las Vegas", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Lamar Jackson: Works out for Big Blue", "Lamar Jackson/FA/CB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once for the Browns' D-line.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once for the CLE defense.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once for the Cle defense.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once against MIN.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once against the Vikes.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once vs.MIN.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once in the Browns-Vikings game.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once for the Ｂｒｏｗｎｓ.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once for the Bro\u200Bwns.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson, an ex-Viking, got home once.", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson: Records sack | Jefferson got home once (via @Browns).", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Bengals sign corner | After a tryout with the Ravens Jackson signed a futures deal.", "Lamar Jackson/FA/CB", "∅ u1"],
  // R8-7 (5): a spelling makes no holder the residual's taker (Byron Murphy Jr./MIN/CB:full_name u0 at 66bb2a2)
  ["Byron Murphy Jr.: Questionable | Murphy (hamstring) was limited.", "Byron Murphy Jr./MIN/CB", "∅ u1"],
  // R8-7 (5): a spelling makes no holder the residual's taker (Byron Murphy II/SEA/DT:full_name u0 at 66bb2a2)
  ["Byron Murphy II: Records sack", "Byron Murphy II/SEA/DT", "∅ u1"],
  ["Vikings CB Byron Murphy: Questionable", "Byron Murphy Jr./MIN/CB", "Byron Murphy Jr./MIN/CB:full_name_team u0"],
  ["Seahawks DT Byron Murphy: Records sack", "Byron Murphy II/SEA/DT", "Byron Murphy II/SEA/DT:full_name_team u0"],
  ["Byron Murphy: Placed on IR | Murphy (knee) will miss at least four games.", "either", "∅ u1"],
  ["Byron Murphy Jr. (DT): Records sack", "either", "∅ u1"],
  // R8-7 (5): a spelling makes no holder the residual's taker (Michael Carter II/PHI/S:full_name u0 at 66bb2a2)
  ["Michael Carter II: Picks off pass", "Michael Carter II/PHI/S", "∅ u1"],
  ["Titans RB Michael Carter: Waived", "Michael Carter/TEN/RB", "Michael Carter/TEN/RB:full_name_team u0"],
  ["Titans RB Michael Carter II: Waived", "either", "∅ u1"],
  // R8-7 (5): a spelling makes no holder the residual's taker (DJ Turner II/CIN/CB:full_name u0 at 66bb2a2)
  ["DJ Turner II: Breaks up two passes", "DJ Turner II/CIN/CB", "∅ u1"],
  ["DJ Turner: Waived", "either", "∅ u1"],
  ["WR DJ Turner: Signs futures deal", "DJ Turner/FA/WR", "DJ Turner/FA/WR:full_name u0"],
  ["Saints CB David Long Jr.: Questionable", "David Long Jr./NO/CB", "David Long Jr./NO/CB:full_name_team u0"],
  ["LB David Long Jr.: Works out", "David Long Jr./FA/LB", "David Long Jr./FA/LB:full_name u0"],
  ["Bengals QB Josh Johnson: Elevated", "Josh Johnson/CIN/QB", "Josh Johnson/CIN/QB:full_name_team u0"],
  ["RB Josh Johnson: Works out for Bengals", "Josh Johnson/FA/RB", "Josh Johnson/FA/RB:full_name u0"],
  ["Josh Johnson: Elevated", "either", "∅ u1"],
  ["Dolphins DT Jordan Phillips: Records sack", "Jordan Phillips/MIA/DT", "Jordan Phillips/MIA/DT:full_name_team u0"],
  ["DT Jordan Phillips: Records sack", "either", "∅ u1"],
  ["Brandon Johnson (S): Signs", "Brandon Johnson/FA/S", "Brandon Johnson/FA/S:full_name u0"],
  ["WR Brandon Johnson: Signs", "Brandon Johnson/FA/WR", "Brandon Johnson/FA/WR:full_name u0"],
  ["Brandon Smith, LB: Signs", "Brandon Smith/FA/LB", "Brandon Smith/FA/LB:full_name u0"],
  // R8-7 (5): a spelling makes no holder the residual's taker (Chris Smith II/FA/S:full_name u0 at 66bb2a2)
  ["Chris Smith II: Signs", "Chris Smith II/FA/S", "∅ u1"],
  ["DT Chris Smith: Signs", "Chris Smith/FA/DT", "Chris Smith/FA/DT:full_name u0"],
  // R8-7 (5): a spelling makes no holder the residual's taker (Tony Brown II/FA/CB:full_name u0 at 66bb2a2)
  ["Tony Brown II: Signs", "Tony Brown II/FA/CB", "∅ u1"],
  ["WR Tony Brown: Signs", "Tony Brown/FA/WR", "Tony Brown/FA/WR:full_name u0"],
  ["Titans CB Jaylon Jones: Waived", "either", "∅ u1"],
  ["Jaylon Jones: Waived", "either", "∅ u1"],
  ["Lamar Jackson: Could miss multiple games", "Lamar Jackson/BAL/QB", "Lamar Jackson/BAL/QB:full_name u0"],
  ["Chris Jones: Questionable for Sunday", "Chris Jones/KC/DT", "Chris Jones/KC/DT:full_name u0"],
  ["Byron Young: Questionable for Sunday", "Byron Young/LA/DE", "Byron Young/LA/DE:full_name u0"],
  ["Marcus Harris: Questionable for Sunday", "Marcus Harris/TEN/CB", "Marcus Harris/TEN/CB:full_name u0"],
  ["Lamar Jackson: Waived | The cornerback was released Tuesday.", "", "∅ u1"],
  ["Justin Jefferson: Former Viking signs elsewhere", "", "∅ u1"],
  ["Lamar Jackson: Works out in Nashville", "", "∅ u1"],
  ["Lamar Jackson: Waived | The returner was released Tuesday.", "", "∅ u1"],
  ["Lamar Jackson: Moves up to CB1", "", "∅ u1"],
  ["Justin Jefferson: Listed as LB2 | Jefferson will rotate in Sunday.", "", "∅ u1"],
  ["Marcus Harris: Elevated to DT1 | Harris will start Sunday.", "", "∅ u1"],
  ["Byron Young: Named DT2 for opener", "", "∅ u1"],
  ["Chris Jones: Slides to CB3 | Jones lost his starting job.", "", "∅ u1"],
  ["Justin Jefferson: Now the WR4 | Jefferson played 12 snaps.", "", "∅ u1"],
  ["Lamar Jackson: Takes over as S1 | Jackson started Sunday.", "", "∅ u1"],
  ["Lamar Jackson: Waived | Jackson was the team's CB4.", "", "∅ u1"],
  ["Justin Jefferson: Promoted to OLB2", "", "∅ u1"],
  ["Justin Jefferson: Now the LB1 | Jefferson played every snap.", "", "∅ u1"],
  ["Byron Young: Promoted to DE2", "", "∅ u1"],
  ["Chris Jones: Wins P1 job | Jones beat out the incumbent.", "", "∅ u1"],
  ["Justin Jefferson: Works out in Minneapolis | Jefferson auditioned Tuesday.", "", "∅ u1"],
  ["Lamar Jackson: Lands in Tampa | Jackson inked a deal Tuesday.", "", "∅ u1"],
  ["Lamar Jackson: Works out in Arlington", "", "∅ u1"],
  ["Lamar Jackson: Works out in Phoenix", "", "∅ u1"],
  ["Marcus Harris: Visits Minneapolis | Harris met with team officials.", "", "∅ u1"],
  ["Justin Jefferson: Back at practice in Berea", "", "∅ u1"],
  ["Lamar Jackson: Works out in Owings Mills", "", "∅ u1"],
  ["Justin Jefferson: Joins NWE practice squad", "", "∅ u1"],
  ["Lamar Jackson: Released by NOR", "", "∅ u1"],
  ["Chris Jones: Claimed by GNB", "", "∅ u1"],
  ["Byron Young: Traded to TAM | Young was dealt Tuesday.", "", "∅ u1"],
  ["Justin Jefferson: Ex-Lion signs elsewhere", "", "∅ u1"],
  ["Justin Jefferson: Ex-Giant waived", "", "∅ u1"],
  ["Justin Jefferson: Former Bill signs elsewhere", "", "∅ u1"],
  ["Justin Jefferson: Ex-Jag signs elsewhere", "", "∅ u1"],
  ["Lamar Jackson: Ex-Ram waived | Jackson was let go Tuesday.", "", "∅ u1"],
  ["Lamar Jackson: Former Colt cut", "", "∅ u1"],
  ["Lamar Jackson: Former Chief cut loose", "", "∅ u1"],
  ["Lamar Jackson: Ex-Saint waived", "", "∅ u1"],
  ["Lamar Jackson: Ex-Buc waived", "", "∅ u1"],
  ["Lamar Jackson: Former Brown cut", "", "∅ u2"],
  ["Chris Jones: Former Jet retires | The ex-Jet announced his retirement Tuesday.", "", "∅ u1"],
  ["Justin Jefferson: Waived | #NinerEmpire", "", "∅ u1"],
  ["Chris Jones: Released | #TitanUp", "", "∅ u1"],
  ["Byron Young: Waived | The idl was let go Tuesday.", "", "∅ u1"],
  ["LAMAR JACKSON: ONE OF THREE CBS WAIVED", "", "∅ u1"],
  ["Lamar Jackson: Ex-Bucs DB waived", "", "∅ u1"],
  ["Lamar Jackson: Waived | #Raiders", "", "∅ u1"],
  ["Lamar Jackson: Works out in Tampa Bay", "", "∅ u1"],
  ["Lamar Jackson: Waived | The return man was released Tuesday.", "", "∅ u1"],
  ["Lamar Jackson: Waived | Jackson played dime in camp.", "", "∅ u1"],
  ["Chris Jones: Waived | The specialist was released Tuesday.", "", "∅ u1"],
  ["Marcus Harris: Plays nose in base package | Harris logged 30 snaps.", "", "∅ u1"],
  ["Byron Young: Top DI in PFF grades", "", "∅ u1"],
  ["Browns' Justin Jefferson: Records sack", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson (CLE): Records sack", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["Justin Jefferson, CLE: Records sack", "Justin Jefferson/CLE/LB", "∅ u1"],
  ["LB Justin Jefferson: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Justin Jefferson (LB, Browns): Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Justin Jefferson LB: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name u0"],
  ["Eagles DT Byron Young: Records sack", "Byron Young/PHI/DT", "Byron Young/PHI/DT:full_name_team u0"],
  ["Philadelphia defensive tackle Byron Young: Records sack", "Byron Young/PHI/DT", "Byron Young/PHI/DT:full_name_team u0"],
  ["Byron Young, DT, Eagles: Records sack", "Byron Young/PHI/DT", "Byron Young/PHI/DT:full_name_team u0"],
  ["Eagles nose tackle Byron Young: Records sack", "Byron Young/PHI/DT", "Byron Young/PHI/DT:full_name_team u0"],
  ["Cleveland linebacker Justin Jefferson: Records sack", "Justin Jefferson/CLE/LB", "Justin Jefferson/CLE/LB:full_name_team u0"],
  ["Lamar Jackson: Signs | Free-agent CB Lamar Jackson inked a deal.", "Lamar Jackson/FA/CB", "Lamar Jackson/FA/CB:full_name u0"],
];

describe("the attack on R8-6's first build (6ba7bb1): its violations and batteries, at their outcome now", () => {
  it("the 23 violations, their variants and the triage's texts", () => {
    expect(VIOLATIONS_R86_1.length).toBeGreaterThan(130);
    for (const [t, whose, want] of VIOLATIONS_R86_1) holds(t, whose, want);
  });

  it("the round's batteries: the misattribution and code-audit lenses' titles", () => {
    expect(BATTERIES_R86_1.length).toBeGreaterThan(250);
    for (const [t, whose, want] of BATTERIES_R86_1) holds(t, whose, want);
  });

  it("the readings held as the ruling writes them: the accepted residual, and a label next to the name", () => {
    // R8-3 clause 6, accepted: the namesake's item naming no team and no position goes to the star
    holds("Lamar Jackson: Inks reserve/future contract", "", "Lamar Jackson/BAL/QB:full_name u0");
    // R8-6 (a): the label written next to the name is the star's, although the item is his
    // namesake's ("<the star's label> <name>'s namesake …"; the round-1 battery's B3 rows, as at
    // 6ba7bb1, dbe9686 and f41e810)
    holds(
      "Ravens QB Lamar Jackson's namesake signs with Bengals",
      "",
      "Lamar Jackson/BAL/QB:full_name_team u0",
    );
    holds(
      "Rams' Byron Young's namesake lands on IR with Eagles",
      "",
      "Byron Young/LA/DE:full_name_team u0",
    );
    // R8-6 (a): a label written next to a name in the blurb picks, the title writing it alone; a
    // contrast across the two segments is not read (within one segment it picks no one)
    holds(
      "Justin Jefferson: Released by Browns | Not to be confused with Vikings' Justin Jefferson",
      "",
      "Justin Jefferson/MIN/WR:full_name_team u0",
    );
    holds(
      "Justin Jefferson: Released by Browns, not to be confused with Vikings' Justin Jefferson",
      "",
      "∅ u1",
    );
  });

  it("the scan-sweep: every team form of the round's sweep takes the star's residual away", () => {
    // prettier-ignore
    const forms = [
      "Cardinal", "Glendale", "AZCardinals.com", "Phoenix", "Big Red", "#BirdGang", "ARZ",
      "Falcon", "Atlanta", "AtlantaFalcons.com", "#RiseUp", "Dirty Birds",
      "Raven", "Baltimore", "BaltimoreRavens.com", "#RavensFlock", "BLT", "Owings Mills",
      "Bill", "Orchard Park", "BuffaloBills.com", "#BillsMafia", "Panther", "Charlotte",
      "Panthers.com", "#KeepPounding", "Bear", "Chicago", "ChicagoBears.com", "#BearDown",
      "Da Bears", "Bengal", "Cincinnati", "Bengals.com", "#RuleTheJungle", "Who Dey", "Brown",
      "Cleveland", "ClevelandBrowns.com", "#DawgPound", "Berea", "CLV", "Cowboy", "Arlington",
      "DallasCowboys.com", "'Boys", "Frisco", "Bronco", "Denver", "DenverBroncos.com", "Mile High",
      "#BroncosCountry", "Lion", "Detroit", "DetroitLions.com", "#OnePride", "Motor City",
      "Allen Park", "Packer", "Green Bay", "Packers.com", "Titletown", "Lambeau", "GNB", "GBP",
      "Texan", "Houston", "HoustonTexans.com", "H-Town", "HST", "Colt", "Indianapolis",
      "Colts.com", "#ForTheShoe", "Jaguar", "Jacksonville", "Jaguars.com", "Jag", "Duval",
      "#DUUUVAL", "Chief", "Kansas City", "Chiefs.com", "KCChiefs.com", "Arrowhead", "KAN", "KCC",
      "Ram", "Inglewood", "TheRams.com", "St. Louis", "STL", "SoFi", "Charger", "Chargers.com",
      "Bolt", "#BoltUp", "San Diego", "SD", "SDG", "Raider", "Paradise", "Raiders.com",
      "#RaiderNation", "Oakland", "OAK", "LVR", "Sin City", "Dolphin", "Miami Gardens",
      "MiamiDolphins.com", "Fin", "#FinsUp", "Viking", "Minneapolis", "Vikings.com", "#Skol",
      "Eagan", "Twin Cities", "Patriot", "Foxborough", "Patriots.com", "Pat", "NWE", "NEP",
      "Saint", "New Orleans", "NewOrleansSaints.com", "NOLA", "#WhoDat", "Big Easy", "NOR", "NOS",
      "Metairie", "Giant", "East Rutherford", "Giants.com", "Gmen", "#TogetherBlue", "Jet",
      "NewYorkJets.com", "#TakeFlight", "Florham Park", "Eagle", "Philadelphia",
      "PhiladelphiaEagles.com", "Birds", "#FlyEaglesFly", "Iggles", "Steeler", "Pittsburgh",
      "Steelers.com", "Steel City", "#HereWeGo", "Seahawk", "Seattle", "Seahawks.com", "12s",
      "#GoHawks", "Renton", "Niner", "Santa Clara", "49ers.com", "Bay Area", "#FTTB", "SFO",
      "Buccaneer", "Tampa", "Buccaneers.com", "Buc", "#GoBucs", "TAM", "TBB", "Titan", "Nashville",
      "TennesseeTitans.com", "TitansOnline.com", "#TitanUp", "Music City", "Oilers", "Commander",
      "Landover", "Commanders.com", "Redskins", "Football Team", "WFT", "D.C.", "Ashburn", "#HTTC",
    ];
    for (const f of forms) {
      const written =
        f.startsWith("#") || f.includes(".") || f.startsWith("'") ? [f] : [f, `ex-${f}`];
      for (const g of written) {
        // no Justin Jefferson takes it, and it is counted (a form's word may be a shared surname too)
        const r = m.matchItem(`Justin Jefferson: Records sack | Jefferson got home once (${g}).`);
        expect(
          r.refs.filter((x) => x.espn_id === WR_JEFFERSON || x.espn_id === LB_JEFFERSON),
          g,
        ).toEqual([]);
        expect(r.unresolved, g).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
