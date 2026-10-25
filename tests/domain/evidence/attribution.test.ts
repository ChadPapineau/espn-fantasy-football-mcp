// attribution.test.ts — which claims of a text that names more than one player are the subject's
// (src/domain/evidence/attribution.ts; plan 07 E10; plan 10 C8). Stage C finding
// evidence-item-claims-misattributed, ruling R7-4 (fail safe instead of smarter parsing): a claim is
// his only when its clause names no other player, opens with his name, and the claim's words follow
// it with only a parenthetical injury, a colon and auxiliary verbs between; every other claim is
// `ambiguous_multi_player`. Every wording the three verification rounds produced is held here
// (placeholder names: the subject Malik Ostrander, the other player Dorian Quist), the subject's own
// claims as controls, and the ruling's property: a claim whose clause names another player is never
// attributed to the subject (with a positive control, so the property can never hold by tying nothing).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  claimFold,
  claimHit,
  clauseClaims,
  extractClaim,
  nameKeysOf,
  namedIn,
  statesOfSubject,
  type NameKeys,
} from "../../../src/domain/evidence/index.js";

const keys = (n: string): NameKeys => {
  const k = nameKeysOf(n);
  if (k === null) throw new Error(n);
  return k;
};
const HIM = keys("Malik Ostrander");
const QUIST = [keys("Dorian Quist")];

/** The clauses tied to him, and the claims (type) of every clause left ambiguous. */
function read(
  text: string,
  subject: NameKeys = HIM,
  others: readonly NameKeys[] = QUIST,
): { his: string[]; ambiguous: string[] } {
  const got = clauseClaims(text, subject, others);
  return {
    his: got.filter((c) => c.attribution === "subject").map((c) => c.clause),
    ambiguous: got.filter((c) => c.attribution === "ambiguous_multi_player").map((c) => c.clause),
  };
}

/** The availability or health claims tied to him (what flags an ACTIVE player or calibrates a source). */
function hisStatusClaims(text: string, subject = HIM, others = QUIST): string[] {
  return read(text, subject, others).his.filter((c) =>
    ["availability", "health"].includes(extractClaim(c)?.type ?? ""),
  );
}

describe("claimHit: the claim and where its words start (the extractor's own)", () => {
  it("is extractClaim's claim, at the earliest hit of its phrase", () => {
    for (const t of [
      "Quist (ankle) was ruled out",
      "Quist suffers season-ending injury",
      "Ostrander to start",
      "nothing here",
    ]) {
      const h = claimHit(t);
      expect(h?.claim ?? null).toEqual(extractClaim(t));
      if (h !== null) expect(h.at).toBeGreaterThanOrEqual(0);
    }
    expect(
      claimFold("Quist (ankle) was ruled out").slice(claimHit("Quist (ankle) was ruled out")?.at),
    ).toBe("ruled out");
    // a rule that wins on table order from inside the first phrase reads the same words
    const s = "Quist suffers season-ending injury";
    expect(extractClaim(s)?.type).toBe("availability");
    expect(claimFold(s).slice(claimHit(s)?.at)).toBe("suffers season-ending injury");
    expect(claimHit("")).toBeNull();
    expect(claimHit(null)).toBeNull();
  });
});

describe("a teammate's claim is never his, whatever the wording (every verifier variant)", () => {
  // round 1: the finding's repro and the attempt-1 verifier (the clause split held for one headline)
  // round 2: the attempt-2 verifier (the teammate as a pronoun in the subject's own clause)
  // round 3: the attempt-3 verifier (the teammate as a noun phrase in the subject's own phrase; a
  //          lower-case surname that is a word)
  it.each([
    // round 1
    ["the finding's title", "Bengals' Dorian Quist (ankle) ruled out; Malik Ostrander to start"],
    ["the finding's tool text", "Teammate Quist (ankle) ruled out for Sunday; Ostrander to start"],
    ["a comma", "Dorian Quist (ankle) ruled out for Sunday, Malik Ostrander to start"],
    ["'and'", "Dorian Quist (ankle) ruled out and Malik Ostrander to start"],
    ["one clause", "With Dorian Quist ruled out Sunday Malik Ostrander gets the start"],
    ["'so'", "Dorian Quist will not play Sunday, so Malik Ostrander draws the start."],
    ["a possessive", "Malik Ostrander starts with Dorian Quist's ankle injury ruling him out"],
    ["'replaces the injured'", "Ostrander replaces the injured Quist"],
    ["his name and the other's first name", "Ostrander replaces Dorian, who is out"],
    ["'in place of'", "Ostrander starts in place of Dorian, who is out"],
    ["a slash", "Quist/Ostrander ruled out"],
    ["both named", "Ostrander and Quist were ruled out"],
    // round 2 (pronouns)
    [
      "A1 'with him sidelined' (blurb)",
      "Quist (ankle) was ruled out for Sunday's game against the opponent. With him sidelined, Malik Ostrander figures to start.",
    ],
    [
      "A2 'with him sidelined' (title)",
      "Quist (ankle) ruled out. With him sidelined, Ostrander starts",
    ],
    [
      "A3 'with him sidelined' after",
      "Quist (ankle) won't play Sunday. Ostrander will start with him sidelined.",
    ],
    [
      "A4 'if he is ruled out'",
      "Quist limited at practice; if he is ruled out, Ostrander would start",
    ],
    ["A4 alone", "If he is ruled out, Ostrander would start"],
    [
      "A5 'because he was placed on IR'",
      "Quist (knee) hurt Sunday. Ostrander will start because he was placed on injured reserve.",
    ],
    [
      "C1 outlook 'with him sidelined'",
      "Quist (ankle) is out for the week. With him sidelined, Ostrander should see more work.",
    ],
    [
      "C2 'now that he is sidelined'",
      "Quist was ruled out. Ostrander steps in now that he is sidelined.",
    ],
    ["C3 outlook, both named", "With Quist sidelined, Ostrander should see more work."],
    ["'once … is ruled out'", "Ostrander starts once Quist is ruled out"],
    ["'unless he is cleared'", "Ostrander starts unless he is cleared"],
    [
      "'with the starter sidelined'",
      "Quist is out. With the starter sidelined, Ostrander figures to start",
    ],
    [
      "the pipeline's pronoun title",
      "Dorian Quist limited at practice; if he is ruled out, Malik Ostrander would start",
    ],
    [
      "the pipeline's pronoun blurb",
      "Quist (ankle) was ruled out for Sunday's game against the opponent. With him sidelined, Malik Ostrander figures to start.",
    ],
    // round 3 (noun phrases; the claim's words come after a verb of his own)
    ["T1 'steps in for the sidelined starter'", "Ostrander steps in for the sidelined starter."],
    [
      "T2 'takes over for the ruled out lead back'",
      "Ostrander takes over for the ruled out lead back.",
    ],
    ["T3 'replaces the back who was ruled out'", "Ostrander replaces the back who was ruled out."],
    [
      "T4 'starts for the starter placed on IR'",
      "Ostrander starts for the starter placed on injured reserve.",
    ],
    ["T5 title only", "Quist (ankle) out; Ostrander replaces sidelined veteran"],
    [
      "U1 outlook 'the sidelined veteran'",
      "Quist (ankle) is out for the week. Ostrander replaces the sidelined veteran.",
    ],
    [
      "U2 outlook 'the ruled out starter'",
      "Quist was ruled out. Ostrander fills in for the ruled out starter.",
    ],
    [
      "G1 sidelined veteran",
      "Quist (ankle) was ruled out Friday. Ostrander replaces the sidelined veteran.",
    ],
    [
      "G2 sidelined starter",
      "Quist (ankle) won't play. Ostrander steps in for the sidelined starter Sunday.",
    ],
    ["G3 injured starter", "Quist will not play. Ostrander fills in for the injured starter."],
    ["G4 a nickname", "Quist (knee) is out. Ostrander starts for a sidelined DQ."],
    [
      "G5 ruled-out lead back",
      "Quist will not play. Ostrander takes over for the ruled out lead back.",
    ],
    ["G6 suspended teammate", "Quist was suspended. Ostrander starts for the suspended back."],
    [
      "G7 starter on IR",
      "Quist hurt Sunday. Ostrander starts for the starter placed on injured reserve.",
    ],
    ["G8 a possessive teammate", "Quist is fine. Ostrander's backfield mate is out this week."],
    ["G9 'the former'", "Quist and Ostrander were limited; the former was ruled out."],
    ["G10 'the latter'", "Quist was limited; Ostrander, the latter, ruled out."],
    ["G11 'its'", "Quist sat. Ostrander gets work as the Bengals' RB1 is sidelined."],
    ["G12 relative 'who'", "Quist was hurt. Ostrander replaces the back who was ruled out."],
    [
      "G13 'whose'",
      "Quist was hurt. Ostrander replaces the back whose ankle sprain sidelined him.",
    ],
    [
      "the pipeline's noun blurb",
      "Quist (ankle) was ruled out for Sunday's game against the opponent. Malik Ostrander steps in for the sidelined starter.",
    ],
    [
      "the pipeline's noun title",
      "Dorian Quist won't play Sunday; Malik Ostrander takes over for the ruled out veteran",
    ],
    ["a parenthetical about another", "Ostrander (in for the sidelined starter) will start"],
    ["a parenthetical about another, 2", "Ostrander (with the starter sidelined) will start"],
    ["his name in lower case beside the other's", "ostrander starts as quist is ruled out"],
  ])("%s", (_label, text) => {
    expect(hisStatusClaims(text), text).toEqual([]);
    // every status claim the text carries is listed, ambiguous — shown, never dropped
    for (const c of clauseClaims(text, HIM, QUIST))
      if (["availability", "health"].includes(extractClaim(c.clause)?.type ?? ""))
        expect(c.attribution, c.clause).toBe("ambiguous_multi_player");
  });

  it.each([
    // round 3: a subject surname that is an English word, written in lower case
    [
      "L1 'hurts'",
      "Barkley ran well. The left tackle being ruled out hurts the offense.",
      "Jalen Hurts",
      "Saquon Barkley",
    ],
    ["L2 'downs'", "Pittman was ruled out on downs.", "Josh Downs", "Michael Pittman"],
    [
      "L3 'fields'",
      "Wilson (calf) is out; the team fields a sidelined line",
      "Justin Fields",
      "Russell Wilson",
    ],
    // his first name shared with the other player names nobody else, but the other's surname does
    ["a shared first name", "Allen replaces Jacobs; Josh is out", "Josh Allen", "Josh Jacobs"],
  ])("%s", (_label, text, subject, other) => {
    expect(hisStatusClaims(text, keys(subject), [keys(other)]), text).toEqual([]);
  });

  it("his own role claim in his own clause stays his; the teammate's claims never ride with it", () => {
    // the role claim is the clause's first claim ('will start'); the pronoun's IR never reaches him
    expect(read("Ostrander will start because he was placed on injured reserve.").his).toEqual([
      "Ostrander will start because he was placed on injured reserve.",
    ]);
    expect(
      extractClaim("Ostrander will start because he was placed on injured reserve.")?.type,
    ).toBe("role");
    // a clause keeps the separator that ends it, as written
    expect(read("Bengals' Dorian Quist (ankle) ruled out; Malik Ostrander to start")).toEqual({
      his: ["Malik Ostrander to start"],
      ambiguous: ["Bengals' Dorian Quist (ankle) ruled out;"],
    });
  });
});

describe("his own claim, stated of him, is his (controls)", () => {
  it.each([
    ["Quist is fine. Ostrander (knee) was ruled out.", "Ostrander (knee) was ruled out.", "out"],
    [
      "Quist is out. Ostrander (knee) was ruled out, and he will miss Sunday.",
      "Ostrander (knee) was ruled out, and he will miss Sunday.",
      "out",
    ],
    [
      "Dorian Quist to start; Malik Ostrander (ankle) ruled out for Sunday",
      "Malik Ostrander (ankle) ruled out for Sunday",
      "out",
    ],
    ["Malik Ostrander: Ruled out for Week 5", "Malik Ostrander: Ruled out for Week 5", "out"],
    ["Malik Ostrander: Won't play Sunday", "Malik Ostrander: Won't play Sunday", "out"],
    ["Malik Ostrander: Placed on IR", "Malik Ostrander: Placed on IR", "injured_reserve"],
    ["Malik Ostrander : Ruled out for Week 5", "Malik Ostrander : Ruled out for Week 5", "out"],
    ["Ostrander has been ruled out for Sunday", "Ostrander has been ruled out for Sunday", "out"],
    [
      "Ostrander was officially placed on injured reserve",
      "Ostrander was officially placed on injured reserve",
      "injured_reserve",
    ],
    [
      "Malik Ostrander (high ankle sprain) is listed as questionable",
      "Malik Ostrander (high ankle sprain) is listed as questionable",
      null,
    ],
    [
      "Malik Ostrander Jr. (ankle) was ruled out",
      "Malik Ostrander Jr. (ankle) was ruled out",
      "out",
    ],
    ["MALIK OSTRANDER (ANKLE) RULED OUT", "MALIK OSTRANDER (ANKLE) RULED OUT", "out"],
    [
      "Quist limited at practice; Ostrander (ankle) is doubtful for Sunday",
      "Ostrander (ankle) is doubtful for Sunday",
      "doubtful",
    ],
  ])("%s", (text, clause, designation) => {
    expect(read(text).his).toContain(clause);
    expect(extractClaim(clause)?.designation ?? null).toBe(designation);
  });

  it("the same claim about another player in the same form is his, never the subject's", () => {
    const quist = keys("Dorian Quist");
    const text = "Malik Ostrander to start; Dorian Quist (ankle) ruled out for Sunday";
    expect(read(text, quist, [HIM]).his).toEqual(["Dorian Quist (ankle) ruled out for Sunday"]);
    expect(read(text).his).toEqual(["Malik Ostrander to start;"]);
  });

  it("a shared first name names nobody else; a period after an initial or a suffix ends no clause", () => {
    const josh = keys("Josh Allen");
    expect(read("Josh Allen (ankle) ruled out", josh, [keys("Josh Jacobs")]).his).toEqual([
      "Josh Allen (ankle) ruled out",
    ]);
    const pitts = keys("Kyle Pitts Sr.");
    expect(read("Kyle Pitts Sr. (ankle) ruled out, Ostrander to start", pitts, [HIM]).his).toEqual(
      [],
    );
    expect(
      read("Kyle Pitts Sr. (ankle) was ruled out. Ostrander to start.", pitts, [HIM]).his,
    ).toEqual(["Kyle Pitts Sr. (ankle) was ruled out."]);
    expect(read("D.J. Quist ruled out. Ostrander to start.").his).toEqual(["Ostrander to start."]);
  });
});

describe("fail safe: what certainty costs (the subject's own claims the rule cannot tie)", () => {
  it.each([
    // he is the object, or a qualifier leads his name, or a verb of his own stands between
    ["The Bengals ruled out Ostrander (ankle) for Sunday"],
    ["Bengals' Malik Ostrander (ankle) ruled out"],
    ["Ostrander says he will miss Sunday"],
    ["Quist is out. He was limited at practice."],
    ["Ostrander's status: questionable for Sunday"],
  ])("%s → ambiguous, never guessed", (text) => {
    expect(read(text).his).toEqual([]);
    expect(read(text).ambiguous.length).toBeGreaterThan(0);
  });

  it("nothing is his when his name does not fold or another player cannot be named", () => {
    const text = "Malik Ostrander (ankle) was ruled out";
    expect(clauseClaims(text, null, QUIST).map((c) => c.attribution)).toEqual([
      "ambiguous_multi_player",
    ]);
    expect(clauseClaims(text, HIM, null).map((c) => c.attribution)).toEqual([
      "ambiguous_multi_player",
    ]);
    // a clause with no claim is not listed at all
    expect(clauseClaims("Quist is fine. Ostrander had a good week.", HIM, QUIST)).toEqual([]);
  });
});

describe("the name keys and names written as names", () => {
  it("names are read as the matcher folds them: possessive, hyphen, spacing, suffix, case", () => {
    expect(nameKeysOf("James Cook III")).toEqual({
      surname: "cook",
      whole: "jamescook",
      given: "james",
      tokens: ["james", "cook"],
    });
    expect(nameKeysOf("Will Quist")?.given).toBeNull();
    expect(nameKeysOf("X")).toBeNull();
    expect(nameKeysOf("Игорь Петров")).toBeNull();
    const jsn = keys("Jaxon Smith-Njigba");
    expect(read("SMITH NJIGBA OUT, Ostrander to start", HIM, [jsn]).his).toEqual([]);
    expect(read("Smith-Njigba's ankle; Ostrander to start", HIM, [jsn]).his).toEqual([
      "Ostrander to start",
    ]);
  });

  it("a player around him (no matcher ref) counts only where written as a name: capitalised", () => {
    const lock = [keys("Drew Lock")];
    expect(namedIn("Cleared to play: move him out of IR before Thursday's lock", lock)).toEqual([]);
    expect(namedIn("With Lock (knee) out, he starts", lock)).toEqual(lock);
    expect(namedIn("LOCK OUT; he starts", lock)).toEqual(lock);
    expect(namedIn("Lock's knee", lock)).toEqual(lock);
    expect(namedIn("anything", [])).toEqual([]);
  });

  it("statesOfSubject reads the clause it is given, at the claim's own start", () => {
    const c = "Ostrander (ankle) was ruled out";
    const at = claimHit(c)?.at ?? -1;
    expect(statesOfSubject(c, at, HIM, QUIST)).toBe(true);
    expect(statesOfSubject(c, 0, HIM, QUIST)).toBe(false);
    expect(statesOfSubject(`${c} with Quist`, at, HIM, QUIST)).toBe(false);
  });
});

// The ruling's property. Clauses are built from the words the variants above use — his name in every
// form, the other player's in every form, claim phrases, verbs, nouns, pronouns, joiners and
// punctuation that never ends a clause — and joined into texts with every clause separator.
const SEPARATORS = ["; ", ". ", " - ", " — ", "\n", "! ", "? "];
const HIS_FORMS = [
  "Malik Ostrander",
  "Ostrander",
  "MALIK OSTRANDER",
  "ostrander",
  "Ostrander's",
  "Malik Ostrander Jr.",
];
const OTHER_FORMS = [
  "Dorian Quist",
  "Quist",
  "QUIST",
  "quist",
  "Quist's",
  "Dorian",
  "(Quist)",
  "Quist,",
  "Dorian Quist's",
];
const CLAIMS = [
  "ruled out",
  "was ruled out",
  "has been ruled out",
  "will miss Sunday",
  "is out for the week",
  "sidelined",
  "placed on injured reserve",
  "is questionable for Sunday",
  "is doubtful for Sunday",
  "did not practice",
  "limited at practice",
  "suffered a setback",
  "(ankle sprain)",
  "to start",
  "will start",
  "won't play",
  "was suspended",
];
const FILLER = [
  "the",
  "starter",
  "veteran",
  "lead back",
  "backup",
  "with",
  "after",
  "for",
  "Sunday",
  "him",
  "he",
  "his",
  "and",
  "so",
  "as",
  "while",
  "replaces",
  "steps in",
  "takes over",
  ",",
  ":",
  "(ankle)",
  "was",
  "has been",
  "officially",
  "if",
  "who",
  "the Bengals",
  "now that",
];

const clauseWords = fc.array(fc.constantFrom(...HIS_FORMS, ...CLAIMS, ...FILLER), {
  minLength: 1,
  maxLength: 8,
});
/** A clause with the other player's name put in at any word. */
const clauseNamingOther = fc
  .tuple(clauseWords, fc.constantFrom(...OTHER_FORMS), fc.nat())
  .map(([words, other, at]) => {
    const w = [...words];
    w.splice(at % (w.length + 1), 0, other);
    return w.join(" ");
  });

describe("property (ruling R7-4): a claim whose clause names another player is never his", () => {
  it("no clause of a text whose every clause names the other player is ever tied to the subject", () => {
    fc.assert(
      fc.property(
        fc.array(clauseNamingOther, { minLength: 1, maxLength: 4 }),
        fc.array(fc.constantFrom(...SEPARATORS), { minLength: 3, maxLength: 3 }),
        (clauses, seps) => {
          const text = clauses.reduce(
            (acc, c, i) => (i === 0 ? c : `${acc}${seps[i % 3] ?? "; "}${c}`),
            "",
          );
          expect(read(text).his, text).toEqual([]);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("control: the plain form of his own claim is his — and naming the other anywhere in it is not", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Malik Ostrander", "Ostrander", "MALIK OSTRANDER", "Malik Ostrander Jr."),
        fc.constantFrom("", " (ankle)", ":", " was", " has been", " (knee) was officially", " is"),
        fc.constantFrom(
          "ruled out",
          "placed on injured reserve",
          "will miss Sunday",
          "doubtful for Sunday",
          "limited at practice",
          "to start",
        ),
        fc.constantFrom("", " for Sunday", " against the opponent", " after Friday's practice"),
        fc.constantFrom(...OTHER_FORMS),
        fc.nat(),
        (name, gap, claim, tail, other, at) => {
          const clause = `${name}${gap} ${claim}${tail}`;
          // his claim, stated of him: tied to him
          expect(read(clause).his, clause).toEqual([clause]);
          // the other player named at any word of it: never his
          const w = clause.split(" ");
          w.splice(at % (w.length + 1), 0, other);
          const mixed = w.join(" ");
          expect(read(mixed).his, mixed).toEqual([]);
        },
      ),
      { numRuns: 1500 },
    );
  });

  it("any text: clauses are trimmed pieces of it, labelled one of the two ways, and never his when no subject or no others", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        for (const c of clauseClaims(text, HIM, QUIST)) {
          expect(text).toContain(c.clause);
          expect(c.clause).toBe(c.clause.trim());
          expect(["subject", "ambiguous_multi_player"]).toContain(c.attribution);
        }
        expect(clauseClaims(text, null, QUIST).every((c) => c.attribution !== "subject")).toBe(
          true,
        );
        expect(clauseClaims(text, HIM, null).every((c) => c.attribution !== "subject")).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
