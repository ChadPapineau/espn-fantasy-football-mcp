// match.test.ts — the deterministic news player matcher (src/sources/news/match.ts; tables.ts
// ds_news_players; plan 07 D6 `players_matched`) over the shared fixture roster: initials,
// apostrophes, hyphens, suffixes on either side, the same surname on two teams, a shared full name,
// a free agent, possessives, punctuation breaks, homoglyph and zero-width names, the ref ceiling, and
// the matcher's precision on the hand-labelled real titles.
import { describe, expect, it } from "vitest";
import {
  buildPlayerMatcher,
  MATCH_CONFIDENCE,
  MAX_REFS_PER_ITEM,
  teamsMentioned,
  type NewsUniversePlayer,
} from "../../../src/sources/news/index.js";
import { labelledItems, rosterUniverse } from "./helpers.js";

const universe = rosterUniverse();
const m = buildPlayerMatcher(universe);
const ids = (text: string) => m.match(text).map((r) => [r.espn_id, r.match_method]);
const byName = (name: string): NewsUniversePlayer => {
  const p = universe.find((x) => x.full_name === name);
  if (p === undefined) throw new Error(name);
  return p;
};

describe("teamsMentioned", () => {
  it("reads capitalised nicknames and unambiguous homes, never the lower-case English words", () => {
    expect(teamsMentioned("Falcons' jab at Saints; Green Bay and the Bucs")).toEqual([
      "ATL",
      "GB",
      "NO",
      "TB",
    ]);
    expect(teamsMentioned("Falcons-Saints rivalry")).toEqual(["ATL", "NO"]);
    expect(teamsMentioned("saints and giants and jets")).toEqual([]);
    expect(teamsMentioned("Los Angeles and New York")).toEqual([]);
    expect(teamsMentioned("49ers win; Niners roll")).toEqual(["SF"]);
  });
});

describe("full names", () => {
  it("matches the full name, with the team when the item names it", () => {
    expect(ids("Bijan Robinson, Falcons make NFC South statement")).toEqual([
      [4430807, "full_name_team"],
    ]);
    expect(ids("Bijan Robinson makes a statement")).toEqual([[4430807, "full_name"]]);
    expect(m.match("Bijan Robinson, Falcons")[0]?.match_confidence).toBe(
      MATCH_CONFIDENCE.full_name_team,
    );
    expect(m.match("Bijan Robinson")[0]).toEqual({
      espn_id: 4430807,
      gsis_id: "00-0038542",
      match_confidence: 0.8,
      match_method: "full_name",
    });
  });

  it("normalises initials, apostrophes, hyphens, periods and suffixes like the crosswalk", () => {
    expect(ids("CJ Stroud: Limited at practice")).toEqual([[4432577, "full_name"]]);
    expect(ids("C.J. Stroud: Limited at practice")).toEqual([[4432577, "full_name"]]);
    expect(ids("Ja'Marr Chase and Ja’Marr Chase")).toEqual([[4362628, "full_name"]]);
    expect(ids("Amon-Ra St. Brown: Questionable")).toEqual([[4374302, "full_name"]]);
    expect(ids("Jaxon Smith-Njigba: Full participant")).toEqual([[4430878, "full_name"]]);
    expect(ids("Kyle Pitts: Uptick in production")).toEqual([[4360248, "full_name"]]); // ESPN "Kyle Pitts Sr."
    expect(ids("Kyle Pitts Sr. scores twice")).toEqual([[4360248, "full_name"]]);
    expect(ids("James Cook III and James Cook")).toEqual([[4379399, "full_name"]]);
    expect(ids("Ka'imi Fairbairn: Perfect day")).toEqual([[2971573, "full_name"]]);
    expect(ids("Josh Allen's, Bills' 3-1 start")).toEqual([[3918298, "full_name_team"]]);
  });

  it("needs the name capitalised (a lower-case phrase is not a mention)", () => {
    expect(ids("fans of jordan love say")).toEqual([]);
    expect(ids("JORDAN LOVE: Ruled out")).toEqual([[4036378, "full_name"]]);
  });

  it("never lets a name span punctuation, nor the title's end and the blurb's start", () => {
    expect(ids("Notes: Bijan, Robinson Crusoe")).toEqual([]);
    expect(ids("Signed: Bijan | Robinson")).toEqual([]);
    expect(ids("Bijan—Robinson")).toEqual([]);
  });

  it("does not match a homoglyph or an invisible-character spelling as someone else", () => {
    // the sanitiser removes zero-width characters, so this IS the name; a Cyrillic letter is not
    expect(ids("Bij\u200Ban Robinson")).toEqual([[4430807, "full_name"]]);
    expect(ids("Bij\u0430n Robinson")).toEqual([]);
  });

  it("needs the team to decide a full name two universe players share", () => {
    const twin: NewsUniversePlayer = {
      espn_id: 9_000_001,
      full_name: "Bijan Robinson",
      team: "MIA",
      gsis_id: null,
    };
    const mm = buildPlayerMatcher([...universe, twin]);
    expect(mm.match("Bijan Robinson scores")).toEqual([]);
    expect(mm.match("Bijan Robinson, Dolphins")[0]?.espn_id).toBe(9_000_001);
    expect(mm.match("Bijan Robinson, Falcons")[0]?.espn_id).toBe(4430807);
  });

  it("matches a free agent by full name only", () => {
    expect(ids("Joe Mixon: Not joining Seattle after all")).toEqual([[3116385, "full_name"]]);
    expect(ids("Seahawks decide not to sign RB Mixon")).toEqual([]);
  });
});

describe("surnames", () => {
  it("matches a capitalised surname only with the team named, and only when unique on that team", () => {
    expect(ids("Ravens RB Henry leaves early")).toEqual([[3043078, "last_name_team"]]);
    expect(ids("Patriots TE Henry questionable")).toEqual([[3046439, "last_name_team"]]);
    expect(ids("Henry questionable")).toEqual([]);
    expect(ids("Packers QB Love throws three TDs")).toEqual([[4036378, "last_name_team"]]);
    expect(ids("Packers fans love the defense")).toEqual([]); // lower case
    const twoOnTeam = buildPlayerMatcher([
      ...universe,
      { espn_id: 9_000_002, full_name: "Tom Henry", team: "BAL", gsis_id: null },
    ]);
    expect(twoOnTeam.match("Ravens RB Henry leaves early")).toEqual([]);
  });

  it("never reads a surname that is part of another person's full name", () => {
    expect(ids("Ravens coach Patrick Henry speaks")).toEqual([]);
    expect(ids("Josh Allen and the Colts")).toEqual([[3918298, "full_name"]]); // not Keenan Allen (IND)
    expect(ids("NFL suspends referee Adrian Hill for conduct toward Vikings' Eric Wilson")).toEqual(
      [],
    );
  });

  it("a full name outranks a surname for the same player; refs are capped and ordered", () => {
    const r = m.match("Bijan Robinson, Falcons: Robinson again");
    expect(r).toEqual([
      {
        espn_id: 4430807,
        gsis_id: "00-0038542",
        match_confidence: 0.95,
        match_method: "full_name_team",
      },
    ]);
    const names = universe.map((p) => p.full_name).join(", ");
    const all = m.match(names);
    expect(all).toHaveLength(MAX_REFS_PER_ITEM);
    expect(all.map((x) => x.espn_id)).toEqual(
      universe.slice(0, MAX_REFS_PER_ITEM).map((p) => p.espn_id),
    );
  });
});

describe("the universe", () => {
  it("skips rows without a positive id or a two-token name, and invalid gsis ids", () => {
    const mm = buildPlayerMatcher([
      { espn_id: -16001, full_name: "Falcons D/ST", team: "ATL", gsis_id: null },
      { espn_id: 0, full_name: "Zero Player", team: null, gsis_id: null },
      { espn_id: 1.5, full_name: "Half Player", team: null, gsis_id: null },
      { espn_id: 5, full_name: "Madonna", team: null, gsis_id: null },
      {
        espn_id: 6,
        full_name: "\u041f\u0451\u0442\u0440\u0020\u0418\u0432\u0430\u043d\u043e\u0432",
        team: null,
        gsis_id: null,
      },
      { espn_id: 7, full_name: "Real Name", team: "BUF", gsis_id: "not-a-gsis" },
      { espn_id: 7, full_name: "Real Name", team: "BUF", gsis_id: "not-a-gsis" },
    ]);
    expect(mm.size).toBe(2);
    expect(mm.match("Real Name: Ruled out")).toEqual([
      { espn_id: 7, gsis_id: null, match_confidence: 0.8, match_method: "full_name" },
    ]);
    expect(mm.match("Madonna; Zero Player; Falcons D/ST")).toEqual([]);
    expect(buildPlayerMatcher([]).match("Bijan Robinson")).toEqual([]);
    expect(byName("Bijan Robinson").team).toBe("ATL");
  });
});

describe("precision on the labelled real titles (fixtures/news/labelled/items.json)", () => {
  it("every ref names a fixture-roster player the title names (precision 1.0 here)", () => {
    let emitted = 0;
    let correct = 0;
    let labelled = 0;
    let found = 0;
    for (const it of labelledItems()) {
      const got = m.match(it.title).map((r) => r.espn_id);
      emitted += got.length;
      correct += got.filter((g) => it.players.includes(g)).length;
      labelled += it.players.length;
      found += it.players.filter((p) => got.includes(p)).length;
    }
    expect(emitted).toBeGreaterThan(0);
    expect(correct / emitted).toBeGreaterThanOrEqual(0.8);
    // recorded in fixtures/news/labelled/README.md: two misses are by design (a free agent's bare
    // surname; a surname whose team the title does not name)
    expect({ emitted, correct, labelled, found }).toEqual({
      emitted: 7,
      correct: 7,
      labelled: 9,
      found: 7,
    });
  });
});
