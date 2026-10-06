// claims.test.ts — the `rules_v1` extractor (src/domain/evidence/claims.ts; plan 07 D6/E10; plan 02
// §6.4; research 05 §6): each rule family on typical feed phrasing and on its look-alikes, the
// reading-order convention, negation, the officials guard, folding (homoglyphs, zero-width, bidi,
// HTML), the closed output vocabulary, bounded work, and the properties that make the extractor
// injection-inert — appending any text (the 05 §6 injections included) after a claim never changes
// it, and no part of the input ever reaches the output.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { INJECTIONS } from "../../../scripts/fx10h/variants.js";
import {
  availabilityClass,
  CLAIM_DIRECTIONS,
  CLAIM_TEXT_CAP,
  CLAIM_TYPES,
  claimFold,
  DESIGNATIONS,
  extractClaim,
  extractItemClaim,
  RULE_IDS,
  ruleHits,
  RULES_V1_TABLE,
  toClaimExtract,
  type RulesV1Claim,
} from "../../../src/domain/evidence/index.js";

const c = (t: string): string | null => {
  const x = extractClaim(t);
  return x === null ? null : `${x.type}/${x.direction}`;
};

describe("rules_v1 — availability", () => {
  it.each([
    ["Player A: Ruled out for Sunday", "availability/down", "out"],
    ["Player A: Won't play Thursday", "availability/down", "out"],
    ["Player A: Not expected to play Week 6", "availability/down", "out"],
    ["Player A: Could miss multiple games", "availability/down", "out"],
    ["Player A to miss Bears' rivalry game", "availability/down", "out"],
    ["Player A: Misses practice Wednesday", "availability/down", "practice_dnp"],
    ["Player A: Out for Week 5", "availability/down", "out"],
    ["Player A will be out indefinitely", "availability/down", "out"],
    ["Player A: Inactive for Sunday night", "availability/down", "out"],
    ["Player A sidelined with a knee issue", "availability/down", "out"],
    ["Player A: Doubtful for Sunday", "availability/down", "doubtful"],
    ["Player A: Questionable for Week 5", "availability/down", "questionable"],
    ["Player A listed as questionable", "availability/down", "questionable"],
    ["Player A: Game-time decision", "availability/neutral", "game_time_decision"],
    ["Player A: Status remains uncertain", "availability/neutral", "status_unknown"],
    ["Player A headed to IR", "availability/down", "injured_reserve"],
    ["Team places Player A on injured reserve", "availability/down", "injured_reserve"],
    ["Player A suffers season-ending injury", "availability/down", "injured_reserve"],
    ["Player A out for the season", "availability/down", "injured_reserve"],
    ["Player A to start the year on PUP", "availability/down", "pup_nfi"],
    ["Player A suspended two games", "availability/down", "suspended"],
    ["Player A considered week-to-week", "availability/down", "week_to_week"],
    ["Player A day-to-day with a calf issue", "availability/down", "day_to_day"],
    ["Player A: Did not practice Wednesday", "availability/down", "practice_dnp"],
    ["Player A: Logs DNP", "availability/down", "practice_dnp"],
    ["Player A: Limited at practice", "availability/down", "practice_limited"],
    ["Player A: Exits with knee injury", "availability/down", "exited"],
    ["Player A won't return Sunday", "availability/down", "exited"],
    ["Player A has slim chance to play", "availability/down", "doubtful"],
    ["Player A enters concussion protocol", "availability/down", "out"],
    ["Player A: Cleared to play Sunday", "availability/up", "cleared"],
    ["Player A cleared concussion protocol", "availability/up", "cleared"],
    ["Player A: Will play Sunday", "availability/up", "will_play"],
    ["Player A: Expected to play Week 5", "availability/up", "will_play"],
    ["Player A: Off injury report", "availability/up", "will_play"],
    ["Player A: Good to go", "availability/up", "will_play"],
    ["Player A activated from IR", "availability/up", "returning"],
    ["Player A comes off injured reserve", "availability/up", "returning"],
    ["Player A designated to return", "availability/up", "returning"],
    ["Player A opens practice window", "availability/up", "returning"],
    ["Player A returns to practice", "availability/up", "returning"],
    ["Player A expected to return this week", "availability/up", "returning"],
    ["Player A: Full participant Thursday", "availability/up", "practice_full"],
    ["Player A practiced in full", "availability/up", "practice_full"],
    ["Player A upgraded to full", "availability/up", "practice_full"],
    ["Player A has good chance to play", "availability/up", "will_play"],
    ["Player A's suspension lifted", "availability/up", "returning"],
  ])("%s → %s (%s)", (text, want, designation) => {
    const x = extractClaim(text);
    expect(c(text)).toBe(want);
    expect(x?.designation).toBe(designation);
  });
});

describe("rules_v1 — transactions, health, role, coaching intent", () => {
  it.each([
    ["Joe Mixon: Not joining Seattle after all", "transaction/down"],
    ["Seahawks decide not to sign RB Mixon after physical", "transaction/down"],
    ["Team opted not to sign him", "transaction/down"],
    ["Player A signs with Bills", "transaction/up"],
    ["Player A agrees to terms with Jets", "transaction/up"],
    ["Player A claimed off waivers by Colts", "transaction/up"],
    ["Player A elevated from practice squad", "transaction/up"],
    ["Rams acquire Player A", "transaction/up"],
    ["Player A comes out of retirement", "transaction/up"],
    ["Player A waived by Giants", "transaction/down"],
    ["Player A was released Tuesday", "transaction/down"],
    ["Team releases veteran Player A", "transaction/down"],
    ["Player A, Bears part ways", "transaction/down"],
    ["Player A traded to Chiefs", "transaction/neutral"],
    ["Former first-round pick abruptly retires", "transaction/down"],
    ["Player A has ankle sprain", "health/down"],
    ["Player A dealing with high-ankle sprain", "health/down"],
    ["Player A suffers hamstring strain", "health/down"],
    ["Player A tore his ACL", "health/down"],
    ["Player A to have surgery", "health/down"],
    ["Player A suffered a setback", "health/down"],
    ["Player A avoids long-term injury", "health/up"],
    ["MRI came back clean for Player A", "health/up"],
    ["No structural damage for Player A", "health/up"],
    ["Player A won't need surgery", "health/up"],
    ["Player A: Two rush TDs in return to lead role", "role/up"],
    ["Player A named starter", "role/up"],
    ["Player A will be the starter", "role/up"],
    ["Player A expected to start Sunday", "role/up"],
    ["Player A set for second start", "role/up"],
    ["Player A: In line for more targets", "role/up"],
    ["Player A moves up depth chart", "role/up"],
    ["Player A benched for Week 6", "role/down"],
    ["Player A loses starting job", "role/down"],
    ["Player A in reduced role", "role/down"],
    ["Player A will be the backup", "role/down"],
    ["Backfield committee approach expected", "role/down"],
    ["Player A to see fewer snaps", "role/down"],
    ["Coach wants to get Player A more involved", "coaching_intent/up"],
    ["Coach plans to limit Player A's workload", "coaching_intent/down"],
    ["Player A on a snap count", "coaching_intent/down"],
  ])("%s → %s", (text, want) => {
    expect(c(text)).toBe(want);
  });
});

describe("rules_v1 — more feed phrasings", () => {
  it.each([
    ["Player A: Officially out Sunday", "availability/down"],
    ["Player A: Uncertain for Week 6", "availability/neutral"],
    ["Player A reverts to IR", "availability/down"],
    ["Player A: Not on injury report", "availability/up"],
    ["Player A practices fully Thursday", "availability/up"],
    ["Player A trending toward playing", "availability/up"],
    ["Player A trending toward not playing", "availability/down"],
    ["Player A not signed after workout", "transaction/down"],
    ["Player A inks three-year extension", "transaction/up"],
    ["Player A gets contract extension", "transaction/up"],
    ["Player A claimed by Giants", "transaction/up"],
    ["Player A requests trade", "transaction/neutral"],
    ["Player A tears ACL", "health/down"],
    ["Player A breaks foot", "health/down"],
    ["Player A undergoes MRI", "health/down"],
    ["Player A loses carries to rookie", "role/down"],
    ["Player A out-snapped by rookie", "role/down"],
    ["Player A won't start Sunday", "role/down"],
    ["Player A takes over backfield", "role/up"],
    ["Player A gets first-team reps", "role/up"],
    ["Player A working with the first team", "role/up"],
    ["Player A will be eased back", "coaching_intent/down"],
    ["Player A's workload to be managed", "coaching_intent/down"],
  ])("%s → %s", (text, want) => {
    expect(c(text)).toBe(want);
  });
});

describe("rules_v1 — look-alikes that are not claims", () => {
  it.each([
    "Kyle Pitts: Uptick in production during big win",
    "Juwan Johnson: Stays busy in Week 4 loss",
    "Updated NFL Power Rankings: Where do the final three undefeated teams stand?",
    "NFL refs union to challenge severity of 2 officials' suspensions",
    "NFL suspends official Jeff Seeman for incident with Cardinals' Trey McBride",
    "NFL suspends referee Adrian Hill for unprofessional conduct",
    "Revisiting the Sauce Gardner trade",
    "Why a Tyreek Hill-Chiefs reunion makes so much sense",
    "'No way this guy's a backup': How Malik Willis prepared",
    "Bills' 3-1 start isn't as impressive as it seems",
    "Can it continue after a hot start?",
    "Saints vs. Falcons odds, predictions, start time",
    "Ranking 10 coaches whose jobs might be in jeopardy",
    "Ravens and Bills both lose, 49ers win thriller",
    "How the sportsbooks adjust after early-season NFL injuries",
    "Team released a statement on Monday",
    "A questionable call by the officials decided it",
    "Player A was out-gained on the ground",
    "Player A missed the game-winning kick",
    "Team set out for revenge",
    "Retired jersey ceremony at halftime",
    "Rams need more play-action",
    "Free agents: Kirk Cousins, Keon Coleman lead top options",
    "Saints suffered a blowout loss",
    "",
  ])("%s → no claim", (text) => {
    expect(extractClaim(text)).toBeNull();
  });
});

describe("rules_v1 — conventions", () => {
  it("takes the FIRST claim in reading order (ties → table order)", () => {
    expect(c("Ravens QB Jackson has ankle sprain, slim chance to play Week 5")).toBe("health/down");
    expect(c("Slim chance to play for Jackson, who has an ankle sprain")).toBe("availability/down");
    expect(c("Mariota has MCL sprain, Daniels set to practice in full")).toBe("health/down");
  });

  it("drops an up-rule a negator stands before, and a down-rule that is negated", () => {
    expect(c("Player A is not expected to play")).toBe("availability/down");
    expect(c("Player A is no longer questionable")).toBeNull();
    expect(c("Player A not activated this week")).toBeNull();
    expect(c("Player A not traded after all")).toBeNull();
  });

  it("never reads an official's suspension as a player's", () => {
    expect(c("Player A suspended for Week 6")).toBe("availability/down");
    expect(c("League suspends line judge after Player A incident")).toBeNull();
  });

  it("reads the title before the blurb, and the blurb only when the title has no claim", () => {
    expect(
      extractItemClaim({ title: "Player A: Ruled out", blurb: "He signed with the Jets" }),
    ).toMatchObject({
      type: "availability",
      field: "title",
    });
    expect(
      extractItemClaim({ title: "Week 5 notes", blurb: "Player A signed with the Jets" }),
    ).toMatchObject({
      type: "transaction",
      field: "blurb",
    });
    expect(extractItemClaim({ title: null, blurb: null })).toBeNull();
    expect(extractItemClaim({})).toBeNull();
  });

  it("folds homoglyphs, fullwidth forms, zero-width and bidi characters and HTML before matching", () => {
    expect(c("Player A: Ruled оut")).toBe("availability/down"); // Cyrillic о
    expect(c("Player A: ＲＵＬＥＤ ＯＵＴ")).toBe("availability/down"); // fullwidth
    expect(c("Player A: Ru​led o‍ut")).toBe("availability/down"); // zero-width
    expect(c("Player A: ‮ruled out‬")).toBe("availability/down"); // bidi override
    expect(c("Player A: <b>ruled</b> <i>out</i>")).toBe("availability/down");
    expect(c("Player A: ruled&nbsp;out")).toBe("availability/down");
    expect(c("Player A won’t play Sunday")).toBe("availability/down"); // typographic apostrophe
    expect(c("Player A day–to–day")).toBe("availability/down"); // en dash
    expect(claimFold("A​  B‮")).toBe("a b");
  });

  it("reads only the first CLAIM_TEXT_CAP code points (bounded work on hostile input)", () => {
    const pad = "filler ".repeat(CLAIM_TEXT_CAP);
    expect(extractClaim(`${pad} ruled out`)).toBeNull();
    const t0 = performance.now();
    extractClaim("a".repeat(1_000_000) + " ruled out");
    extractClaim("(".repeat(200_000) + "will " + "x ".repeat(100_000));
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("exposes a closed vocabulary", () => {
    expect(CLAIM_TYPES).toEqual([
      "availability",
      "role",
      "health",
      "coaching_intent",
      "transaction",
      "other",
    ]);
    expect(CLAIM_DIRECTIONS).toEqual(["up", "down", "neutral"]);
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
    for (const r of RULES_V1_TABLE) {
      expect(r.id.startsWith(`${r.type}.`)).toBe(true);
      expect(CLAIM_DIRECTIONS).toContain(r.direction);
      expect(r.designation === null || DESIGNATIONS.includes(r.designation)).toBe(true);
      expect(r.type === "availability").toBe(r.designation !== null);
    }
    for (const d of DESIGNATIONS)
      expect(["plays", "uncertain", "out"]).toContain(availabilityClass(d));
  });

  it("ruleHits lists every surviving rule, earliest first; toClaimExtract keeps the three D6 fields", () => {
    const hits = ruleHits("Player A has ankle sprain, slim chance to play");
    expect(hits.map((h) => h.rule)).toEqual(["health.injury", "availability.chance_down"]);
    expect(hits[0]?.index).toBeLessThan(hits[1]?.index ?? 0);
    const x = extractClaim("Player A: Ruled out");
    expect(toClaimExtract(x)).toEqual({
      type: "availability",
      direction: "down",
      extractor: "rules_v1",
    });
    expect(toClaimExtract(null)).toBeNull();
    expect(x).toEqual({
      type: "availability",
      direction: "down",
      extractor: "rules_v1",
      rule: "availability.ruled_out",
      designation: "out",
      field: "text",
    });
    expect(Object.isFrozen(x)).toBe(true);
  });
});

const CLAIM_TITLES = [
  "Joe Mixon: Not joining Seattle after all",
  "Lamar Jackson: Could miss multiple games",
  "Alvin Kamara: Two rush TDs in return to lead role",
  "Sources: Eagles RB Bigsby headed to IR with Barkley week-to-week",
  "Player A: Cleared to play Sunday",
  "Player A signs with Bills",
];
const VOCAB = new Set<string>([
  ...CLAIM_TYPES,
  ...CLAIM_DIRECTIONS,
  ...RULE_IDS,
  ...DESIGNATIONS,
  "rules_v1",
  "title",
  "blurb",
  "text",
]);
const inVocab = (x: RulesV1Claim | null): boolean =>
  x === null ||
  Object.values(x).every((v) => v === null || (typeof v === "string" && VOCAB.has(v)));

describe("rules_v1 — injection inertness (research 05 §6 rule 5; plan 10 B8)", () => {
  it("the 05 §6 injection texts yield at most a closed-vocabulary claim, never their words", () => {
    for (const text of Object.values(INJECTIONS)) {
      const x = extractItemClaim({ title: text, blurb: text });
      expect(inVocab(x)).toBe(true);
      const out = JSON.stringify(x);
      for (const word of [
        "ignore",
        "system",
        "pre-approved",
        "trust",
        "commissioner",
        "voided",
        "espn_prepare",
      ])
        expect(out.toLowerCase()).not.toContain(word);
    }
    // case 3's text is an availability claim the comparator can line up against OUT (structured.test)
    expect(extractClaim(INJECTIONS.irCleared)).toMatchObject({
      type: "availability",
      direction: "up",
      designation: "cleared",
    });
    // "dropping their RB1" is not a transaction: the extractor never reads an instruction as a move
    expect(extractClaim(INJECTIONS.outlookSystem)?.type).not.toBe("transaction");
    expect(extractClaim(INJECTIONS.tradeBlock)).toBeNull();
  });

  it("appending any text (an injection included) after a claim never changes it (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CLAIM_TITLES),
        fc.oneof(fc.string({ maxLength: 300 }), fc.constantFrom(...Object.values(INJECTIONS))),
        (title, suffix) => {
          expect(extractClaim(`${title}. ${suffix}`)).toEqual(extractClaim(title));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("any input yields null or a closed-vocabulary claim (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400, unit: "binary" }), (s) => {
        expect(inVocab(extractClaim(s))).toBe(true);
      }),
      { numRuns: 400 },
    );
  });
});
