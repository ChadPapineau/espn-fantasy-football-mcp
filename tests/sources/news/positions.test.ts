// positions.test.ts — the closed position vocabulary of the news matcher and where a position word
// is read (src/sources/news/positions.ts; ruling R8-3 clause 4, docs/plan/changelog.md §R8: "a
// position word or abbreviation written next to the name, or describing the subject, is evidence
// like an attached team ... from ESPN's position_id"). The ids are ESPN's position ids
// (src/domain/league/slots.ts POSITION_NAMES, held equal to the provider's table elsewhere).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { POSITION_NAMES } from "../../../src/domain/league/slots.js";
import {
  describingPhrases,
  HEADLINE_TOPICS,
  KNOWN_POSITION_IDS,
  NOT_DESCRIBING,
  POSITION_COMPOUND_HEADS,
  POSITION_MODIFIERS,
  POSITION_WORDS,
  positionPhrasesNextTo,
  positionsNextTo,
  positionWordSpans,
  sentenceBounds,
  sentenceOf,
} from "../../../src/sources/news/index.js";

/** The position-id sets next to `name` in `text`, each sorted. */
const near = (text: string, name: string): number[][] => {
  const start = text.indexOf(name);
  return positionsNextTo(text, start, start + name.length).map((s) => [...s].sort((a, b) => a - b));
};
const described = (text: string) =>
  describingPhrases(text).map((d) => ({
    phrase: text.slice(d.at, d.end),
    rest: text.slice(d.end, d.sentenceEnd),
    ids: [...d.ids].sort((a, b) => a - b),
  }));

describe("the vocabulary is closed and maps to ESPN's position ids", () => {
  it("every word, and the ids it names", () => {
    const families: Record<string, number[]> = {};
    for (const [w, ids] of Object.entries(POSITION_WORDS)) families[w] = [...ids];
    // prettier-ignore
    expect(families).toEqual({
      qb: [1], qb1: [1], qb2: [1], quarterback: [1], "signal-caller": [1], "signal caller": [1],
      rb: [2], rb1: [2], rb2: [2], rb3: [2], hb: [2], fb: [2], "running back": [2], halfback: [2],
      tailback: [2], fullback: [2],
      wr: [3], wr1: [3], wr2: [3], wr3: [3], "wide receiver": [3], receiver: [3], wideout: [3],
      "slot receiver": [3],
      te: [4], te1: [4], te2: [4], "tight end": [4],
      k: [5], pk: [5], kicker: [5], placekicker: [5], "place kicker": [5], p: [7], punter: [7],
      dt: [9, 10], de: [9, 10], dl: [9, 10], nt: [9, 10], "defensive tackle": [9, 10],
      "nose tackle": [9, 10], "defensive end": [9, 10], "defensive lineman": [9, 10],
      "interior lineman": [9, 10],
      olb: [10, 11], lb: [10, 11], ilb: [10, 11], mlb: [10, 11], edge: [10, 11],
      "edge rusher": [10, 11], "outside linebacker": [10, 11],
      linebacker: [10, 11], "inside linebacker": [10, 11], "middle linebacker": [10, 11],
      // R8-3 fix round 2: a pass rusher may be any of the front — ESPN lists the interior rusher
      // Chris Jones as a DT (it was [10, 11], which ruled him out of his own "Chiefs pass rusher")
      "pass rusher": [9, 10, 11], "pass-rusher": [9, 10, 11],
      cb: [12, 13], s: [12, 13], fs: [12, 13], ss: [12, 13], db: [12, 13], cornerback: [12, 13],
      corner: [12, 13],
      nickelback: [12, 13], "nickel back": [12, 13], safety: [12, 13], "free safety": [12, 13],
      "strong safety": [12, 13], "defensive back": [12, 13],
      defender: [9, 10, 11, 12, 13], "defensive player": [9, 10, 11, 12, 13],
      ol: [], ot: [], og: [], "offensive lineman": [], "offensive tackle": [], "offensive guard": [],
      "left tackle": [], "right tackle": [], "left guard": [], "right guard": [],
    });
    expect(NOT_DESCRIBING).toEqual(new Set(["safety", "edge", "kicker", "corner"]));
  });

  it("names only ESPN position ids of persons: QB RB WR TE K P DT DE LB CB S", () => {
    expect([...KNOWN_POSITION_IDS].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13,
    ]);
    expect([...KNOWN_POSITION_IDS].map((id) => POSITION_NAMES[id]).sort()).toEqual([
      "CB",
      "DE",
      "DT",
      "K",
      "LB",
      "P",
      "QB",
      "RB",
      "S",
      "TE",
      "WR",
    ]);
    // each family holds the ESPN label its words name
    for (const [word, label] of [
      ["quarterback", "QB"],
      ["running back", "RB"],
      ["wideout", "WR"],
      ["tight end", "TE"],
      ["kicker", "K"],
      ["punter", "P"],
      ["defensive tackle", "DT"],
      ["defensive end", "DE"],
      ["linebacker", "LB"],
      ["cornerback", "CB"],
      ["safety", "S"],
    ] as const)
      expect(
        (POSITION_WORDS[word] ?? []).map((id) => POSITION_NAMES[id]),
        word,
      ).toContain(label);
  });
});

describe("next to the name", () => {
  it("right before it, whitespace only between", () => {
    expect(near("LB Justin Jefferson: Records sack", "Justin Jefferson")).toEqual([[10, 11]]);
    expect(near("Browns linebacker Justin Jefferson suspended", "Justin Jefferson")).toEqual([
      [10, 11],
    ]);
    expect(near("Free-agent cornerback Lamar Jackson visits", "Lamar Jackson")).toEqual([[12, 13]]);
    expect(near("Minnesota Vikings wide receiver Justin Jefferson", "Justin Jefferson")).toEqual([
      [3],
    ]);
    expect(near("Rams edge Byron Young: Sack", "Byron Young")).toEqual([[10, 11]]);
    expect(near("Eagles S Michael Carter II", "Michael Carter II")).toEqual([[12, 13]]);
    // several joined by "/" are one player's: any of them
    expect(near("LB/DE Justin Jefferson", "Justin Jefferson")).toEqual([[9, 10, 11]]);
  });

  it("an abbreviation counts only in capitals; a word in any case", () => {
    for (const text of ["lb Justin Jefferson", "Lb Justin Jefferson", "s Justin Jefferson"])
      expect(near(text, "Justin Jefferson"), text).toEqual([]);
    expect(near("Linebacker Justin Jefferson", "Justin Jefferson")).toEqual([[10, 11]]);
    expect(near("EDGE Byron Young", "Byron Young")).toEqual([[10, 11]]);
  });

  it("never across punctuation, inside a word or after a hyphen", () => {
    for (const text of [
      "QB: Lamar Jackson",
      "QB, Lamar Jackson",
      "non-QB Lamar Jackson",
      "QBs Lamar Jackson",
      "the Ravens' pass rush. Lamar Jackson",
    ])
      expect(near(text, "Lamar Jackson"), text).toEqual([]);
  });

  it("after it: a closing appositive, or parentheses", () => {
    expect(near("Justin Jefferson, LB, Cleveland: Out", "Justin Jefferson")).toEqual([[10, 11]]);
    expect(near("Justin Jefferson, WR, Minnesota: Questionable", "Justin Jefferson")).toEqual([
      [3],
    ]);
    expect(near("Lamar Jackson, a free-agent cornerback, visits", "Lamar Jackson")).toEqual([
      [12, 13],
    ]);
    expect(
      near("Justin Jefferson, the Vikings' star receiver, is out", "Justin Jefferson"),
    ).toEqual([[3]]);
    expect(near("Sam Twin, Dolphins S: Out", "Sam Twin")).toEqual([[12, 13]]);
    expect(near("Justin Jefferson (Browns LB) questionable", "Justin Jefferson")).toEqual([
      [10, 11],
    ]);
    expect(near("Justin Jefferson (LB, Browns) questionable", "Justin Jefferson")).toEqual([
      [10, 11],
    ]);
    // before and after both: one set each
    expect(near("LB Justin Jefferson (Browns LB) out", "Justin Jefferson")).toEqual([
      [10, 11],
      [10, 11],
    ]);
  });

  it("an appositive that does not close, or a parenthesis that is no position, is none", () => {
    for (const [text, name] of [
      ["Justin Jefferson, receiver Adam Thielen and the Vikings", "Justin Jefferson"],
      ["Lamar Jackson (ankle) limited", "Lamar Jackson"],
      ["Bijan Robinson, Falcons", "Bijan Robinson"],
      ["Lamar Jackson, quarterbacks coach says", "Lamar Jackson"],
      ["Justin Jefferson, lb, Cleveland", "Justin Jefferson"],
    ] as const)
      expect(near(text, name), text).toEqual([]);
  });
});

describe("describing the subject: a sentence opening 'The [<team>] <position>' that goes on", () => {
  it("after a sentence's end or a bar, or a headline's colon (The optional there)", () => {
    expect(
      described("Justin Jefferson: Records sack | The Browns linebacker led the team. More."),
    ).toEqual([{ phrase: "The Browns linebacker", rest: " led the team", ids: [10, 11] }]);
    expect(described("X was limited. The defender has started every game.")).toEqual([
      { phrase: "The defender", rest: " has started every game", ids: [9, 10, 11, 12, 13] },
    ]);
    expect(described("Lamar Jackson injury update: Ravens QB dealing with ankle sprain")).toEqual([
      { phrase: ": Ravens QB", rest: " dealing with ankle sprain", ids: [1] },
    ]);
    expect(described("The Vikings' star receiver, who sat out, returns.")).toEqual([
      { phrase: "The Vikings' star receiver", rest: ", who sat out, returns", ids: [3] },
    ]);
  });

  it("not when a name follows, a plural, a common noun, or no sentence opens there", () => {
    for (const text of [
      "The Browns linebacker Justin Jefferson led the team.",
      "X: Out | The linebackers were thin.",
      "X: Out | The safety of the play was reviewed.",
      "Lamar Jackson: Safety concerns linger",
      "X: Out | The edge goes to the Vikings.",
      "X: Out | The kicker: he played through it.",
      "X: Out | he said the linebacker was fine.",
      "X: Out | The lb was fine.",
    ])
      expect(described(text), text).toEqual([]);
  });

  it("property: positionsNextTo and describingPhrases never throw and stay inside the text", () => {
    const words = [...Object.keys(POSITION_WORDS), "The", "Browns", "Justin", "Jefferson"];
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constantFrom(...words),
            fc.constantFrom(" ", ", ", ": ", ". ", " | ", "(", ")", "/"),
          ),
          {
            maxLength: 30,
          },
        ),
        fc.nat(),
        (parts, at) => {
          const text = parts.join("");
          const start = text.length === 0 ? 0 : at % text.length;
          for (const s of positionsNextTo(text, start, start))
            for (const id of s) expect(KNOWN_POSITION_IDS.has(id)).toBe(true);
          for (const d of describingPhrases(text)) {
            expect(0 <= d.start && d.start < d.end && d.end <= d.sentenceEnd).toBe(true);
            expect(d.sentenceEnd).toBeLessThanOrEqual(text.length);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("next to the name, as fix round 2 reads it (R8-3 clause 4: at every mention, every label form)", () => {
  const spans = (text: string, name: string) => {
    const start = text.indexOf(name);
    return positionPhrasesNextTo(text, start, start + name.length).map((p) => ({
      word: text.slice(p.start, p.end),
      ids: [...p.ids].sort((a, b) => a - b),
      team: p.team,
    }));
  };

  it("right after the name, before its clause ends, an abbreviation in capitals", () => {
    expect(near("Justin Jefferson LB: Records sack", "Justin Jefferson")).toEqual([[10, 11]]);
    expect(near("Justin Jefferson LB - Records sack", "Justin Jefferson")).toEqual([[10, 11]]);
    for (const text of ["Justin Jefferson lb: Records", "Justin Jefferson LB rating"])
      expect(near(text, "Justin Jefferson"), text).toEqual([]);
  });

  it("a tag in parentheses: teams (abbreviations too), positions and modifiers, in any order", () => {
    expect(near("Justin Jefferson (CLE - LB): Records 10 tackles", "Justin Jefferson")).toEqual([
      [10, 11],
    ]);
    expect(near("Justin Jefferson (WR, Vikings) questionable", "Justin Jefferson")).toEqual([[3]]);
    expect(near("Byron Young (Eagles DT) questionable", "Byron Young")).toEqual([[9, 10]]);
    for (const text of ["Lamar Jackson (ankle) limited", "Lamar Jackson (CLE) limited"])
      expect(near(text, "Lamar Jackson"), text).toEqual([]);
  });

  it("an appositive: modifiers before and after a team, an age, the newest", () => {
    expect(
      spans("Lamar Jackson, the Ravens' newest cornerback, impresses", "Lamar Jackson"),
    ).toEqual([{ word: "cornerback", ids: [12, 13], team: "BAL" }]);
    expect(
      near("Jefferson, a second-year linebacker, will miss at least four games", "Jefferson"),
    ).toEqual([[10, 11]]);
    expect(near("Jefferson, the 24-year-old linebacker, will miss", "Jefferson")).toEqual([
      [10, 11],
    ]);
    expect(near("Free-agent corner Lamar Jackson visits", "Lamar Jackson")).toEqual([[12, 13]]);
  });

  it("the clause a headline's topic colon opens right after the name (closed topics)", () => {
    expect(
      spans("Lamar Jackson injury update: Ravens QB dealing with ankle sprain", "Lamar Jackson"),
    ).toEqual([{ word: "QB", ids: [1], team: "BAL" }]);
    expect(
      near("Saquon Barkley status: The Eagles running back is questionable", "Saquon Barkley"),
    ).toEqual([[2]]);
    expect(HEADLINE_TOPICS).toContain("injury update");
    // no topic, a verb before the colon, a pronoun or a noun the position modifies: none
    for (const text of [
      "Lamar Jackson: Ravens QB dealing with ankle sprain",
      "Lamar Jackson throws pick-six: Bengals cornerback returns it 80 yards",
      "Lamar Jackson outlook: Cornerback injuries leave Bengals thin",
      "Lamar Jackson update: The cornerback covering him slipped",
    ])
      expect(near(text, "Lamar Jackson"), text).toEqual([]);
  });
});

describe("describing phrases, as fix round 2 reads them: never another's position given to him", () => {
  it("modifiers around the team; a team's home first ('The New England linebacker')", () => {
    expect(described("X: Out | The former Ravens cornerback is seeking a roster spot.")).toEqual([
      { phrase: "The former Ravens cornerback", rest: " is seeking a roster spot", ids: [12, 13] },
    ]);
    expect(described("X: Out | The New England linebacker tore his ACL.")[0]?.ids).toEqual([
      10, 11,
    ]);
    expect(described("X: Out | The 24-year-old linebacker will miss four games.")[0]?.ids).toEqual([
      10, 11,
    ]);
    expect(POSITION_MODIFIERS).toContain("All-Pro");
  });

  it("a pronoun makes it plainly another player's: 'him' within three words, 'he' right after", () => {
    const other = (text: string) => describingPhrases(text).map((d) => d.other);
    for (const text of [
      "X: Catches TD | The linebacker covering him slipped.",
      "X: Goes over 100 yards | The defender assigned to him left.",
      "X: Catches TD | The quarterback found him twice.",
      "X: Two sacks | The quarterback he sacked left the game.",
      "X: Two sacks | The receiver that he covered was held to one catch.",
    ])
      expect(other(text), text).toEqual([true]);
    for (const text of [
      "X: Out | The linebacker tore his ACL.",
      "X: Out | The quarterback threw it right to him.",
      "X: Out | The linebacker did not practice Wednesday.",
    ])
      expect(other(text), text).toEqual([false]);
  });

  it("a position word that modifies a noun describes no one (a closed list of heads)", () => {
    for (const text of [
      "X outlook: Cornerback injuries leave Bengals thin",
      "X outlook: Linebacker coverage could open up a big day",
      "X: Out | The receiver room is thin.",
    ])
      expect(described(text), text).toEqual([]);
    expect(POSITION_COMPOUND_HEADS).toEqual(
      expect.arrayContaining(["injuries", "coverage", "room"]),
    );
  });
});

describe("positionWordSpans: every position word an item writes (R8-3 clause 6's test)", () => {
  const words = (text: string) => positionWordSpans(text).map((p) => text.slice(p.start, p.end));

  it("words in any case, abbreviations in capitals, plurals and possessives too", () => {
    expect(
      words("The linebacker's knee gave out; Linebackers coach Jim said LB depth is thin"),
    ).toEqual(["linebacker", "Linebacker", "LB"]);
    expect(words("The QBs and the lb and the s")).toEqual(["QB"]);
  });

  it("not the common nouns: safety, edge, kicker, corner", () => {
    expect(words("Safety concerns; an edge; the kicker; turned the corner")).toEqual([]);
  });
});

describe("sentenceBounds: where a sentence ends (an initial or an abbreviation does not end one)", () => {
  it("bars, semicolons, and a period before a space unless it closes an initial or an abbreviation", () => {
    const text = "C.J. Stroud vs. Browns. St. Brown, No. 1 | Jr. scored; done! ok? end.";
    const at = sentenceBounds(text).map((b) => text[b]);
    expect(at).toEqual([".", "|", ";", "!", "?", "."]);
    const bounds = sentenceBounds(text);
    expect(sentenceOf(bounds, 0, text.length)).toEqual([0, text.indexOf("Browns.") + 6]);
  });
});
