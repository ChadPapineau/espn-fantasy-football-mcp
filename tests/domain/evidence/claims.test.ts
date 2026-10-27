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
  claimAvailability,
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
    ["Player A: Viewed as 'unlikely' for Week 5", "availability/down"],
    ["Player A \u201Cnot expected\u201D for Sunday", "availability/down"],
    ["Player A: 'Questionable' for Week 6", "availability/down"],
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
    expect(c("Player A: Ruled \u043Eut")).toBe("availability/down"); // Cyrillic \u043E
    expect(c("Player A: ＲＵＬＥＤ ＯＵＴ")).toBe("availability/down"); // fullwidth
    expect(c("Player A: Ru\u200Bled o\u200Dut")).toBe("availability/down"); // zero-width
    expect(c("Player A: \u202Eruled out\u202C")).toBe("availability/down"); // bidi override
    expect(c("Player A: <b>ruled</b> <i>out</i>")).toBe("availability/down");
    expect(c("Player A: ruled&nbsp;out")).toBe("availability/down");
    expect(c("Player A won’t play Sunday")).toBe("availability/down"); // typographic apostrophe
    expect(c("Player A day–to–day")).toBe("availability/down"); // en dash
    expect(claimFold("A\u200B  B\u202E")).toBe("a b");
    expect(claimFold("Viewed as 'unlikely' \u2014 won't play, \"out\"")).toBe(
      "viewed as unlikely - won't play, out",
    );
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

// Stage C finding evidence-availability-claims-missed: the everyday wordings of "he plays" read as no
// claim ("is active", "is playing Sunday", "in the lineup") and "will start Sunday" only as a role
// claim, so an OUT player's pasted "is active for Sunday" or "will start Sunday" never met ESPN's
// OUT. Each wording below read null (or, for the starts, a role claim implying nothing) before.
describe("rules_v1 — everyday availability wordings (finding evidence-availability-claims-missed)", () => {
  it.each([
    "Player A is active.",
    "Player A is active for Sunday.",
    "Player A is active",
    "Player A will be active Sunday",
    "Player A is expected to be active",
    "Player A is officially active",
    "Player A remains active for Week 7",
    "Player A: Active for Week 7",
    "Player A (ankle) is active, per the team",
    "Player A active vs. Lions",
    "Player A active for Sunday's game",
    "Player A is active despite the ankle",
    "Player A is playing Sunday.",
    "Player A is playing tonight",
    "Player A will be playing through the ankle injury",
    "Player A is playing against the Bears",
    "Player A: Playing Sunday",
    "Player A plans on playing Sunday",
    "Player A is planning to play Sunday",
    "Player A expects to play Sunday",
    "Player A is slated to play in Week 7",
    "Player A is in the lineup Sunday.",
    "Player A will be in the lineup",
    "Player A is back in the starting lineup",
    "Player A: In lineup Sunday",
    "Player A is a go for Sunday",
    "Player A is a full go",
    "Player A is available for Sunday",
    "Player A is available to play",
  ])("%s → availability/up (will_play)", (text) => {
    expect(c(text)).toBe("availability/up");
    expect(extractClaim(text)?.designation).toBe("will_play");
  });

  it.each([
    ["Player A won't be active Sunday", "out"],
    ["Player A is not active", "out"],
    ["Player A isn't active for Week 7", "out"],
    ["Player A: Not active Sunday", "out"],
    ["Player A isn't playing Sunday", "out"],
    ["Player A is not playing tonight", "out"],
    ["Player A won't be playing Sunday", "out"],
    ["Player A is not expected to be active", "out"],
    ["Player A won't be in the lineup Sunday", "out"],
    ["Player A is not in the lineup", "out"],
    ["Player A will be out of the lineup Sunday", "out"],
    ["Player A is unable to start Sunday", "out"],
    ["Player A won't be able to play", "out"],
    ["Player A will start the season on IR", "injured_reserve"],
    ["Player A to start on injured reserve", "injured_reserve"],
  ])("%s → availability/down (%s): the negated mirrors", (text, designation) => {
    expect(c(text)).toBe("availability/down");
    expect(extractClaim(text)?.designation).toBe(designation);
  });

  it.each([
    "Player A is playing well",
    "Player A is playing his best football",
    "Player A is playing for a new contract",
    "Player A is active in the passing game",
    "Player A is on the active roster",
    "Player A has been on the active roster all year",
    "Player A, an active-duty veteran",
    "Player A was active last week",
    "Player A is a go-to target",
    "Player A is available in 60% of leagues",
    "Player A is available for pickup",
    "Player A remains available on waivers",
    "Player A after playing 12 snaps in Week 4",
  ])("%s → no claim (a look-alike)", (text) => {
    expect(extractClaim(text)).toBeNull();
  });

  it("'play' as a role is a role claim, not 'he plays' (the widened will_play openers)", () => {
    expect(c("Player A is expected to play a bigger role")).toBe("role/up");
    expect(c("Player A expects to play more snaps")).toBe("role/up");
    expect(c("Player A: Expected to play Week 5")).toBe("availability/up");
  });

  it.each([
    "Player A will start Sunday.",
    "Player A will start.",
    "Player A to start Sunday",
    "Player A to start",
    "Player A is expected to start Sunday",
    "Player A is set to start",
    "Player A is starting Sunday",
    "Player A will be starting against the Bears",
    "Player A: Starting Sunday",
    "Player A gets the start Sunday",
    "Player A will get the start",
    "Player A draws the start",
    "Player A makes his first career start Sunday",
    "Player A set for second start",
    "Player A gets the starting nod",
    "Player A will start in place of Player B",
    "Player A will start for the injured Player B",
    "Player A will start at running back Sunday",
    "Player A will start in Week 7",
    "Player A will start Sunday once again",
    "Player A is healthy enough to start Sunday",
    "Player A will start Sunday. If not, Player B.",
  ])("%s → a role claim that says he plays (claimAvailability: will_play)", (text) => {
    const x = extractClaim(text);
    expect(c(text)).toBe("role/up");
    expect(x?.rule).toBe("role.will_start");
    expect(claimAvailability(x)).toBe("will_play");
  });

  it.each([
    "Player A will start practicing Wednesday",
    "Player A will start if healthy",
    "If healthy, Player A will start Sunday",
    "Player A will start Sunday if he clears the protocol",
    "Once cleared, Player A will start",
    "Player A is expected to start Sunday, pending a final test",
    "Player A is hoping to start Sunday",
    "Player A is fighting to start Sunday",
    "Player A is too banged up to start Sunday",
    "the decision to start Player A",
    "Player A earned the start last week",
    "Player A makes a strong start to the season",
    "Player A named starter",
    "Player A gets first-team reps",
    "Player A will start because he was placed on injured reserve.",
  ])("%s → still a role claim, implying nothing (not this game's start)", (text) => {
    const x = extractClaim(text);
    expect(c(text)).toBe("role/up");
    expect(claimAvailability(x)).toBeNull();
  });

  it("a start that will not happen is a role claim down, never a start", () => {
    for (const t of [
      "Player A is unlikely to start Sunday",
      "Player A is not expected to start Sunday",
      "Player A is not going to start",
      "Player A won't start Sunday",
    ]) {
      expect(c(t), t).toBe("role/down");
      expect(claimAvailability(extractClaim(t)), t).toBeNull();
    }
  });

  it("only a non-availability rule implies an availability, and only that he plays", () => {
    const implying = RULES_V1_TABLE.filter((r) => r.implies !== null);
    expect(implying.map((r) => r.id)).toEqual(["role.will_start"]);
    for (const r of implying) {
      expect(r.type).not.toBe("availability");
      expect(r.direction).toBe("up");
      expect(r.implies !== null && DESIGNATIONS.includes(r.implies)).toBe(true);
      expect(r.implies === null ? null : availabilityClass(r.implies)).toBe("plays");
    }
    // the table's own order: the coming game's start is read before the role.starter it refines
    expect(RULE_IDS.indexOf("role.will_start")).toBe(RULE_IDS.indexOf("role.starter") - 1);
    // an availability claim's own designation; a start's will_play; nothing for any other claim
    expect(claimAvailability(extractClaim("Player A: Ruled out"))).toBe("out");
    expect(claimAvailability(extractClaim("Player A: Questionable for Week 5"))).toBe(
      "questionable",
    );
    expect(claimAvailability(extractClaim("Player A signs with Bills"))).toBeNull();
    expect(claimAvailability(extractClaim("Player A has ankle sprain"))).toBeNull();
    expect(claimAvailability(null)).toBeNull();
  });

  it("property: every 'he plays' wording, about any subject, at any game time, reads as will_play", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Player A", "PLAYER A", "Player A (ankle)", "He", "Player A Jr."),
        fc.constantFrom(
          "is active",
          "will be active",
          "is expected to be active",
          "is playing",
          "will be playing",
          "is in the lineup",
          "will be back in the lineup",
          "is a go",
          "will play",
          "is expected to play",
        ),
        fc.constantFrom(
          "",
          " Sunday",
          " tonight",
          " in Week 7",
          " against the Bears",
          " this week",
        ),
        fc.constantFrom("", ".", ", per the team.", "; the team confirmed it"),
        (who, says, when, end) => {
          const text = `${who} ${says}${when}${end}`;
          expect(c(text), text).toBe("availability/up");
          expect(claimAvailability(extractClaim(text)), text).toBe("will_play");
        },
      ),
      { numRuns: 400 },
    );
  });

  it("property: every start of the coming game, about any subject, implies he plays", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Player A", "PLAYER A", "Player A (ankle)", "He"),
        fc.constantFrom(
          "will start",
          "is expected to start",
          "is set to start",
          "is starting",
          "will be starting",
          "to start",
          "gets the start",
          "will get the start",
        ),
        fc.constantFrom(" Sunday", " tonight", " in Week 7", " against the Bears", " this week"),
        fc.constantFrom("", ".", ", per the team."),
        (who, says, when, end) => {
          const text = `${who} ${says}${when}${end}`;
          expect(c(text), text).toBe("role/up");
          expect(claimAvailability(extractClaim(text)), text).toBe("will_play");
        },
      ),
      { numRuns: 300 },
    );
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
