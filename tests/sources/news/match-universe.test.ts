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
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { playersRows } from "../../../src/sources/espn_season/index.js";
import {
  attachedTeams,
  buildPlayerMatcher,
  MATCH_CONFIDENCE,
  PROMINENCE_RATIO,
  PROMINENT_OWNED,
  teamMentions,
  teamsMentioned,
  universeFromEspnPlayers,
  type NewsUniversePlayer,
} from "../../../src/sources/news/index.js";
import { labelledItems } from "./helpers.js";

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

  it("evidence still decides: a namesake's own team named blocks the star; one facing the star's team gets no ref", () => {
    // only the LB's team is named: his own news or the WR's opponent — no ref, never the wrong one
    expect(refs("Justin Jefferson: Records 10 tackles in Browns win")).toEqual([]);
    // the subject faces the Vikings: not the Vikings WR — but no cue tells this from the WR's own
    // headline ("Bengals vs. Vikings: Justin Jefferson questionable", below): ruling the star out
    // never hands his name to the namesake by elimination (attempt 3: it did)
    expect(refs("Justin Jefferson: Records 10 tackles against Vikings")).toEqual([]);
    // a free agent plays no games: an item naming its subject's opponent is not about him, so the
    // cue contradicts both holders and is no evidence — the star takes his name
    expect(refs("Lamar Jackson: Intercepts a pass against the Ravens")).toEqual([
      [QB_LAMAR, "full_name"],
    ]);
    // the namesake's team attached to the name is his own evidence: it still decides for him
    expect(refs("Browns LB Justin Jefferson: Records 10 tackles against Vikings")).toEqual([
      [LB_JEFFERSON, "full_name_team"],
    ]);
    // the star's own team named with the namesake's: the star
    expect(refs("Vikings WR Justin Jefferson: Questionable vs. Browns")).toEqual([
      [WR_JEFFERSON, "full_name_team"],
    ]);
  });

  it("a cue on the star's own team never hands his news to a namesake by elimination (attempt 3: the verifier's path)", () => {
    // each went to the 0.11 %-owned free-agent CB at 0.80: the cue ruled the QB out, and a free
    // agent could never be ruled out
    for (const title of [
      "Bills vs. Ravens: Lamar Jackson limited Wednesday",
      "Lamar Jackson: Expected to start in Ravens matchup",
      "Steelers facing the Ravens: Lamar Jackson questionable",
    ])
      expect(refs(title), title).toEqual([[QB_LAMAR, "full_name"]]);
    // each went to the Browns LB (the second at 0.95): a team holder left by elimination never takes
    // the name of the star the cue ruled out — no ref, never the wrong one
    for (const title of [
      "Bengals vs. Vikings: Justin Jefferson questionable",
      "Justin Jefferson: Vikings matchup on tap for Browns",
    ])
      expect(refs(title), title).toEqual([]);
    // controls: a cue on another team still rules the namesake out for the star
    expect(refs("Lamar Jackson: Questionable against Bengals")).toEqual([[QB_LAMAR, "full_name"]]);
    expect(refs("Michael Carter to see more work against Eagles")).toEqual([
      [RB_CARTER, "full_name"],
    ]);
  });

  it("property: whatever cue names the star's own team, his namesake never takes the star's name", () => {
    const cues = [
      (t: string) => `against ${t}`,
      (t: string) => `against the ${t}`,
      (t: string) => `vs. ${t}`,
      (t: string) => `vs ${t}`,
      (t: string) => `versus the ${t}`,
      (t: string) => `facing the ${t}`,
      (t: string) => `${t} matchup`,
    ];
    const stars = [
      { name: "Lamar Jackson", team: "Ravens", star: QB_LAMAR, namesake: CB_LAMAR },
      { name: "Justin Jefferson", team: "Vikings", star: WR_JEFFERSON, namesake: LB_JEFFERSON },
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...stars),
        fc.constantFrom(...cues),
        fc.constantFrom("before", "after"),
        fc.constantFrom("limited Wednesday", "questionable", "out for the week", "a full go"),
        (s, cue, where, what) => {
          const title =
            where === "before"
              ? `Bills ${cue(s.team)}: ${s.name} ${what}`
              : `${s.name}: ${what} ${cue(s.team)}`;
          const got = m.match(title).map((r) => r.espn_id);
          expect(got, title).not.toContain(s.namesake);
          expect(got.length, title).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("every labelled real title opening with a >= 1 %-owned player's full name refs him", () => {
    // the finding's measure: of the 71 labelled titles, those opening with such a name (as ESPN
    // spells it) and getting no ref were exactly the Lamar Jackson items (a 0.11 %-owned free-agent
    // namesake blocked them)
    const owned = universe.filter((p) => (p.percent_owned ?? 0) >= PROMINENT_OWNED);
    const opens = (title: string, name: string): boolean =>
      title.toLowerCase().startsWith(name.toLowerCase()) &&
      !/^[\p{L}\p{N}]/u.test(title.slice(name.length));
    let opening = 0;
    for (const it of [
      ...labelledItems(),
      ...labelledItems("fixtures/news/labelled/holdout.json"),
    ]) {
      const subjects = owned.filter((p) => opens(it.title, p.full_name));
      if (subjects.length === 0) continue;
      opening++;
      const got = m.match(it.title).map((r) => r.espn_id);
      expect(
        subjects.some((p) => got.includes(p.espn_id)),
        it.title,
      ).toBe(true);
    }
    expect(opening).toBe(13);
  });

  it("namesakes neither prominent nor told apart by a team get no ref", () => {
    expect(refs("Michael Carter: Limited in practice")).toEqual([]);
    // a team that is neither one's: no evidence either way
    expect(refs("Michael Carter: Limited ahead of Bears game")).toEqual([]);
  });
});

describe("a team named loosely is never evidence for a namesake (news-match-universe-homonyms)", () => {
  // The cue list (against, vs, versus, facing, '<team> matchup') cannot be complete: "win over",
  // "loss to", "at", "matchup with", "host" all name the opponent too. Changing one cue word used to
  // hand the star's news to the namesake on the named team (0.6 through the surname repeated in the
  // blurb, 0.95 through the full name with no prominent holder), and a namesake's own news naming
  // both teams went to the star at 0.95.
  const BYRON_JR = idOf("Byron Murphy Jr.", "MIN");
  const BYRON_II = idOf("Byron Murphy II", "SEA");

  it("the verification's phrasings: the namesake on a team named any way never takes the ref", () => {
    const cases: readonly (readonly [string, readonly (readonly [number, string])[]])[] = [
      [
        "Justin Jefferson: Catches TD | Jefferson caught seven passes for 120 yards in Sunday's 27-20 win over the Browns.",
        [],
      ],
      [
        "Justin Jefferson: Quiet in loss | Jefferson caught two passes in Sunday's loss to the Browns.",
        [],
      ],
      [
        "Justin Jefferson: Questionable for Sunday | Jefferson (hamstring) is questionable for Sunday's game at Cleveland.",
        [],
      ],
      ["Justin Jefferson: Torches Browns' secondary", []],
      [
        "Justin Jefferson: Limited Thursday | Jefferson (hamstring) was limited ahead of the Week 8 matchup with Cleveland.",
        [],
      ],
      // both teams named: the star's news or the namesake's — no ref, never the wrong one
      [
        "Justin Jefferson: Questionable | Jefferson (hamstring) is questionable; the Vikings host the Browns Sunday.",
        [],
      ],
      ["Michael Carter: Gets more work in loss to Eagles", []],
      // a recognised cue still rules the namesake out
      [
        "Justin Jefferson: Questionable vs. Browns | Jefferson (hamstring) was limited Thursday.",
        [[WR_JEFFERSON, "full_name"]],
      ],
      [
        "Justin Jefferson: Questionable | Jefferson (hamstring) is questionable for Sunday's game against the Browns.",
        [[WR_JEFFERSON, "full_name"]],
      ],
      [
        "Lamar Jackson: Limited | Jackson (ankle) was limited; the Ravens visit the Bengals Sunday.",
        [[QB_LAMAR, "full_name_team"]],
      ],
      [
        "Lamar Jackson: Throws three TDs in win over Bengals | Jackson completed 25 of 31 passes.",
        [[QB_LAMAR, "full_name"]],
      ],
    ];
    for (const [text, want] of cases) expect(refs(text), text).toEqual(want);
  });

  it("property: whatever word names the opponent, the namesake on that team gets no ref", () => {
    const cue = fc.oneof(
      fc.constantFrom(
        "against",
        "vs",
        "vs.",
        "versus",
        "facing",
        "over",
        "to",
        "at",
        "with",
        "host",
        "hosts",
        "visit",
        "beat",
        "and",
        "matchup",
      ),
      fc.stringMatching(/^[a-z]{1,12}$/),
    );
    fc.assert(
      fc.property(cue, fc.boolean(), (w, the) => {
        const t = the ? "the " : "";
        const ids = (text: string) => m.match(text).map((r) => r.espn_id);
        // the star's news naming the namesake's team: never the LB (neither via the full name nor
        // via the surname the blurb repeats), and never the Eagles S under the suffix fold
        expect(
          ids(
            `Justin Jefferson: Catches TD | Jefferson caught seven passes in Sunday's ${w} ${t}Browns.`,
          ),
        ).not.toContain(LB_JEFFERSON);
        expect(ids(`Jefferson: Catches TD in ${w} ${t}Browns`)).not.toContain(LB_JEFFERSON);
        expect(ids(`Michael Carter: Gets more work in ${w} ${t}Eagles`)).not.toContain(S_CARTER);
        // the namesake's own news naming the star's team: never the star
        expect(
          ids(
            `Justin Jefferson: Records sack | Jefferson had a sack in the Browns' ${w} ${t}Vikings.`,
          ),
        ).not.toContain(WR_JEFFERSON);
      }),
      { numRuns: 300 },
    );
  });

  it("a namesake's own news naming both teams never goes to the star (it went at 0.95)", () => {
    expect(
      refs(
        "Justin Jefferson: Records sack | Jefferson had a sack in the Browns' loss to the Vikings.",
      ),
    ).toEqual([]);
  });

  it("a bare surname is not the namesake on a loosely named team while a star holds it", () => {
    // it gave the Browns LB the Vikings WR's news at 0.6
    expect(refs("Jefferson torches Browns in win")).toEqual([]);
    // a team attached to the surname still decides
    expect(refs("Browns LB Jefferson: Records sack")).toEqual([[LB_JEFFERSON, "last_name_team"]]);
    expect(refs("Vikings WR Jefferson torches Browns")).toEqual([[WR_JEFFERSON, "last_name_team"]]);
  });

  it("a cue is about the item's subject: it rules no one out for another name it holds", () => {
    // "against Ravens" is Chase's opponent; it ruled the Ravens QB out and gave his name to the
    // free-agent CB
    const got = m.match(
      "Ja'Marr Chase: Catches eight passes against Ravens | Chase outdueled Lamar Jackson.",
    );
    expect(got.map((r) => r.espn_id)).toContain(QB_LAMAR);
    expect(got.map((r) => r.espn_id)).not.toContain(CB_LAMAR);
  });

  it("a team attached to the name decides; a namesake's attached team only blocks a star", () => {
    expect(
      refs("Vikings WR Justin Jefferson: Questionable | the Vikings host the Browns Sunday."),
    ).toEqual([[WR_JEFFERSON, "full_name_team"]]);
    expect(refs("Browns LB Justin Jefferson: Records sack")).toEqual([]);
  });

  it("a written generational suffix is ESPN's spelling of one namesake", () => {
    // Byron Murphy Jr. (MIN) and Byron Murphy II (SEA) fold to one name: neither had a ref
    expect(refs("Byron Murphy II: Records sack")).toEqual([[BYRON_II, "full_name"]]);
    expect(refs("Byron Murphy Jr.: Records sack")).toEqual([[BYRON_JR, "full_name"]]);
    expect(refs("Byron Murphy: Records sack")).toEqual([]);
    expect(
      refs(
        "Michael Carter II: Records interception | Carter II picked off a pass in the Eagles' win.",
      ),
    ).toEqual([[S_CARTER, "full_name_team"]]);
    // a suffix no namesake is spelled with is no evidence
    expect(refs("Lamar Jackson Jr.: Could miss multiple games")).toEqual([[QB_LAMAR, "full_name"]]);
  });
});

describe("attachedTeams: a team written next to a name", () => {
  const att = (text: string, name: string) => {
    const start = text.indexOf(name);
    return [...attachedTeams(text, teamMentions(text), start, start + name.length)].sort();
  };
  it("before it (a possessive, role words) or after it (a closing appositive, parentheses)", () => {
    expect(att("Vikings WR Justin Jefferson out", "Justin Jefferson")).toEqual(["MIN"]);
    expect(att("Vikings' star WR Justin Jefferson out", "Justin Jefferson")).toEqual(["MIN"]);
    expect(att("Minnesota's Justin Jefferson out", "Justin Jefferson")).toEqual(["MIN"]);
    expect(att("Bears tight end Cole Kmet out", "Cole Kmet")).toEqual(["CHI"]);
    expect(att("Sam Twin, Dolphins: Out Sunday", "Sam Twin")).toEqual(["MIA"]);
    expect(att("Bijan Robinson, Falcons", "Bijan Robinson")).toEqual(["ATL"]);
    expect(att("Justin Jefferson (Vikings WR) out", "Justin Jefferson")).toEqual(["MIN"]);
    // a cue word does not make an attached team the opponent
    expect(att("Shadowed against the Vikings' Justin Jefferson", "Justin Jefferson")).toEqual([
      "MIN",
    ]);
  });

  it("never across a verb, a preposition, a clause or another word", () => {
    for (const [text, name] of [
      ["Browns tackle Justin Jefferson", "Justin Jefferson"],
      ["Browns end Justin Jefferson's day", "Justin Jefferson"],
      ["Questionable against Browns. Justin Jefferson", "Justin Jefferson"],
      ["Browns: Justin Jefferson out", "Justin Jefferson"],
      ["Win over Browns | Justin Jefferson", "Justin Jefferson"],
      ["Lamar Jackson, Bengals tied at half", "Lamar Jackson"],
      ["Lamar Jackson torches Bengals", "Lamar Jackson"],
      ["Lamar Jackson (ankle) limited vs. Bengals", "Lamar Jackson"],
    ] as const)
      expect(att(text, name), text).toEqual([]);
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

  it("an attached team decides between equals, past a star only for him; none left, no ref", () => {
    expect(who(40, 40, "Bills WR Sam Twin: Out")).toEqual([9_100_001]);
    expect(who(40, 40, "Sam Twin (Dolphins): Out")).toEqual([9_100_002]);
    expect(who(99, 0, "Bills WR Sam Twin: Out vs. Dolphins")).toEqual([9_100_001]);
    expect(who(99, 0, "Dolphins S Sam Twin: Out")).toEqual([]); // the namesake's, beside a star
    expect(who(40, 40, "Bills WR Sam Twin, Dolphins: Out")).toEqual([]); // two teams attached
    expect(who(40, 40, "Sam Twin: Out vs. Bills, vs. Dolphins")).toEqual([]); // both ruled out
    // a loose mention, whichever holder's, picks no one between equals
    expect(who(40, 40, "Sam Twin: Out in loss to Dolphins")).toEqual([]);
    expect(who(40, 40, "Sam Twin: Out in Bills loss")).toEqual([]);
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
