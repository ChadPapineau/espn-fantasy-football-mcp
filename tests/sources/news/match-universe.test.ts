// match-universe.test.ts — the news player matcher over the WHOLE recorded ESPN universe (Stage C
// remediations news-match-universe-homonyms and news-match-player-name-team-word;
// src/sources/news/match.ts, teams.ts). The refresh wiring matches every item against every
// players_wl person (src/cli/refresh.ts newsInputs: universeFromEspnPlayers over the player
// dataset), 0 %-owned free agents and defensive players included, so the fixture-roster tests of
// match.test.ts could not see two failures: a homonym of a star — the free-agent CB Lamar Jackson,
// the Browns LB Justin Jefferson — blocked or took the star's news, and a player's own name read
// as a team ("Dallas Goedert" → DAL, "Malik Washington" → WAS) handed another team's player a
// surname ref. The universe here is built as the wiring builds it, from the recorded
// fixtures/espn/recorded/season/players_wl.json. No network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { playersRows } from "../../../src/sources/espn_season/index.js";
import {
  buildPlayerMatcher,
  MATCH_CONFIDENCE,
  PROMINENCE_RATIO,
  PROMINENT_OWNED,
  teamMentions,
  teamsMentioned,
  universeFromEspnPlayers,
  type NewsUniversePlayer,
} from "../../../src/sources/news/index.js";

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

/** The universe player of `name` on `team` (null = a free agent). */
function idOf(name: string, team: string | null): number {
  const p = universe.filter((x) => x.full_name === name && x.team === team);
  if (p.length !== 1 || p[0] === undefined) throw new Error(`${name} ${String(team)}`);
  return p[0].espn_id;
}
const refs = (text: string) => m.match(text).map((r) => [r.espn_id, r.match_method]);

const QB_LAMAR = idOf("Lamar Jackson", "BAL");
const CB_LAMAR = idOf("Lamar Jackson", null);
const WR_JEFFERSON = idOf("Justin Jefferson", "MIN");
const LB_JEFFERSON = idOf("Justin Jefferson", "CLE");
const RB_CARTER = idOf("Michael Carter", "TEN");
const S_CARTER = idOf("Michael Carter II", "PHI");

describe("the recorded universe holds the homonyms the finding names", () => {
  it("each a star and a 0 %-owned or defensive namesake (or two namesakes on two teams)", () => {
    const owned = (id: number) => universe.find((p) => p.espn_id === id)?.percent_owned;
    expect(owned(QB_LAMAR)).toBeGreaterThan(99);
    expect(owned(CB_LAMAR)).toBeLessThan(1);
    expect(owned(WR_JEFFERSON)).toBeGreaterThan(99);
    expect(owned(LB_JEFFERSON)).toBeLessThan(1);
    expect([RB_CARTER, S_CARTER].every((id) => (owned(id) ?? 1) < 1)).toBe(true);
  });
});

describe("a shared full name (news-match-universe-homonyms)", () => {
  it("a star's news reaches him past a 0 %-owned namesake (both recorded titles had no ref)", () => {
    for (const title of [
      "Lamar Jackson: Could miss multiple games", // fixtures/news/labelled/items.json #2
      "Lamar Jackson: Viewed as 'unlikely' for Week 5", // holdout.json #1
      "Lamar Jackson: Limited ahead of Bengals game | Jackson (ankle) was limited Wednesday.",
    ])
      expect(refs(title)).toEqual([[QB_LAMAR, "full_name"]]);
    expect(refs("Ravens QB Lamar Jackson has ankle sprain")).toEqual([
      [QB_LAMAR, "full_name_team"],
    ]);
  });

  it("a namesake on the team the item names as the opponent never takes the name", () => {
    // it went to the Browns LB at 0.95, above a unique name's 0.80
    const jj =
      "Justin Jefferson: Questionable for Browns matchup | Jefferson (hamstring) was limited Thursday.";
    expect(refs(jj)).toEqual([[WR_JEFFERSON, "full_name"]]);
    // it went to the Eagles S Michael Carter II (the suffix folds) at 0.95
    expect(refs("Michael Carter to see more work against Eagles")).toEqual([
      [RB_CARTER, "full_name"],
    ]);
    expect(m.match("Michael Carter to see more work against Eagles")[0]?.match_confidence).toBe(
      MATCH_CONFIDENCE.full_name,
    );
  });

  it("evidence still decides: a namesake's own team named blocks the star; one facing the star's team is the namesake", () => {
    // only the LB's team is named: his own news or the WR's opponent — no ref, never the wrong one
    expect(refs("Justin Jefferson: Records 10 tackles in Browns win")).toEqual([]);
    // the item's subject faces the Vikings: not the Vikings WR
    expect(refs("Justin Jefferson: Records 10 tackles against Vikings")).toEqual([
      [LB_JEFFERSON, "full_name"],
    ]);
    expect(refs("Lamar Jackson: Intercepts a pass against the Ravens")).toEqual([
      [CB_LAMAR, "full_name"],
    ]);
    // the star's own team named with the namesake's: the star
    expect(refs("Vikings WR Justin Jefferson: Questionable vs. Browns")).toEqual([
      [WR_JEFFERSON, "full_name_team"],
    ]);
  });

  it("namesakes neither prominent nor told apart by a team get no ref", () => {
    expect(refs("Michael Carter: Limited in practice")).toEqual([]);
    // a team that is neither one's: no evidence either way
    expect(refs("Michael Carter: Limited ahead of Bears game")).toEqual([]);
  });
});

describe("the prominence rule's bounds (synthetic namesakes)", () => {
  const twins = (a: number | null, b: number | null): NewsUniversePlayer[] => [
    { espn_id: 9_100_001, full_name: "Sam Twin", team: "BUF", gsis_id: null, percent_owned: a },
    { espn_id: 9_100_002, full_name: "Sam Twin", team: "MIA", gsis_id: null, percent_owned: b },
  ];
  const who = (a: number | null, b: number | null, text = "Sam Twin: Out Sunday") =>
    buildPlayerMatcher(twins(a, b))
      .match(text)
      .map((r) => r.espn_id);

  it("owned in at least PROMINENT_OWNED % of leagues and PROMINENCE_RATIO × the other's share", () => {
    expect([PROMINENT_OWNED, PROMINENCE_RATIO]).toEqual([1, 10]);
    expect(who(1, 0.1)).toEqual([9_100_001]);
    expect(who(0.99, 0)).toEqual([]); // under the floor
    expect(who(5, 0.5)).toEqual([9_100_001]);
    expect(who(5, 0.51)).toEqual([]); // under the ratio
    expect(who(0.5, 50)).toEqual([9_100_002]);
    expect(who(40, 40)).toEqual([]); // a tie
    expect(who(null, 0)).toEqual([]); // an unknown share is no evidence of prominence
    expect(who(50, null)).toEqual([9_100_001]); // an unknown share counts as 0
  });

  it("team evidence decides between namesakes as before", () => {
    expect(who(40, 40, "Sam Twin, Dolphins: Out Sunday")).toEqual([9_100_002]);
    expect(who(40, 40, "Sam Twin: Out Sunday against Dolphins")).toEqual([9_100_001]);
    expect(who(40, 40, "Sam Twin: Bills and Dolphins")).toEqual([]);
    expect(who(99, 0, "Sam Twin, Dolphins: Out Sunday")).toEqual([]); // only the namesake's team
  });
});

describe("a player's own name is not a team mention (news-match-player-name-team-word)", () => {
  it("the finding's items: no other team's player gets a surname ref", () => {
    // they gave Rachaad White (WAS) and Jake Ferguson (DAL) last_name_team 0.6
    expect(refs("Malik Washington (illness) won't play; White to start")).toEqual([
      [idOf("Malik Washington", "MIA"), "full_name"],
    ]);
    expect(refs("Dallas Goedert (knee) ruled out; Ferguson to see more targets")).toEqual([
      [idOf("Dallas Goedert", "PHI"), "full_name"],
    ]);
  });

  it("nor does the name's surname standing alone in the blurb, nor a name's first word", () => {
    expect(
      refs("Parker Washington: Two TDs | Washington caught both; Daniels threw for 300 yards"),
    ).toEqual([[idOf("Parker Washington", "JAX"), "full_name"]]);
    expect(
      refs("Mike Washington Jr.: Starts Sunday | Washington (ankle) is fine; White sits"),
    ).toEqual([[idOf("Mike Washington Jr.", "LV"), "full_name"]]);
    expect(refs("Dennis Houston: Promoted | Houston joins Stroud's receivers")).toEqual([
      [idOf("Dennis Houston", "TB"), "full_name"],
    ]);
    expect(refs("DeeJay Dallas: Released; Ferguson unaffected")).toEqual([
      [idOf("DeeJay Dallas", "MIN"), "full_name"],
    ]);
  });

  it("controls: a team named by its home still counts where no name holds the word", () => {
    expect(refs("Commanders RB Croskey-Merritt to start; Washington thin at RB")).toEqual([
      [idOf("Jacory Croskey-Merritt", "WAS"), "last_name_team"],
    ]);
    expect(refs("Washington RB Croskey-Merritt to start")).toEqual([
      [idOf("Jacory Croskey-Merritt", "WAS"), "last_name_team"],
    ]);
    expect(refs("Dallas TE Ferguson to see more targets")).toEqual([
      [idOf("Jake Ferguson", "DAL"), "last_name_team"],
    ]);
  });
});

describe("teamMentions: where a team is named, and whether as the opponent", () => {
  const opp = (text: string) => teamMentions(text).map((t) => [t.team, t.opponent]);
  it("opponent cues: against, vs, vs., versus, facing (an optional 'the'), and '<team> matchup'", () => {
    expect(opp("Out against the Eagles")).toEqual([["PHI", true]]);
    expect(opp("Saints vs. Falcons odds")).toEqual([
      ["NO", false],
      ["ATL", true],
    ]);
    expect(opp("Bills vs Dolphins; Bears versus Packers; facing Detroit")).toEqual([
      ["BUF", false],
      ["MIA", true],
      ["CHI", false],
      ["GB", true],
      ["DET", true],
    ]);
    expect(opp("Questionable for Browns matchup")).toEqual([["CLE", true]]);
    // a possessive is the team's own; a word merely ending in a cue is not one
    expect(opp("Browns' matchup with Steelers")).toEqual([
      ["CLE", false],
      ["PIT", false],
    ]);
    expect(opp("Leaves Browns game early; Limited at Bengals practice")).toEqual([
      ["CLE", false],
      ["CIN", false],
    ]);
  });

  it("offsets are the words' own; teamsMentioned still lists every team named", () => {
    const text = "Green Bay vs. Bucs";
    const [a, b] = teamMentions(text);
    expect(text.slice(a?.start, a?.end)).toBe("Green Bay");
    expect(text.slice(b?.start, b?.end)).toBe("Bucs");
    expect(a?.words).toBe("Green Bay");
    expect(teamsMentioned(text)).toEqual(["GB", "TB"]);
  });
});
