// availability-claims.test.ts — Stage C finding evidence-availability-claims-missed, through E10's
// composition (src/domain/analytics/evidence.ts over this domain's extractor and comparator; plan 07
// E10 "structured fields win"; research 05 §6 rule 3). news-check's core output is the flag and
// `structured_disagrees`: when ESPN's injury status contradicts the text, the field wins. For a
// player ESPN lists OUT, "is active" / "is playing Sunday" / "is in the lineup" read as no claim
// (no_claim on a cold cache, quiet_role_change when his usage had moved) and "will start Sunday"
// as a role claim only (consistent, or a stats-field disagreement), so ESPN's OUT was never named —
// the one contradiction a start/sit decision hinges on. Each case below is the finding's repro (a
// pasted claim from a beat writer; cold = no usage, seeded = usage present) and failed before the
// fix; the controls held before and still do. The extractor's and comparator's own cases are in
// claims.test.ts and structured.test.ts.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeEvidence, type EvidenceRequest } from "../../../src/domain/analytics/evidence.js";
import type { UsageWeek } from "../../../src/domain/analytics/usageSignals.js";
import { fixedClock } from "../../../src/domain/clock.js";
import {
  wrapUntrusted,
  type BareText,
  type InjuryStatus,
} from "../../../src/domain/league/types.js";

const NOW = "2026-10-06T20:00:00.000Z";

function req(status: InjuryStatus | null, over: Partial<EvidenceRequest> = {}): EvidenceRequest {
  return {
    player: {
      player_id: 77,
      gsis_id: null,
      name: "Player 77" as BareText,
      position: "RB",
      injury_status: status,
      roster: "mine",
      slot_id: 2,
      lineup_locked: false,
      waiver_process_date: null,
      last_news_at: null,
    },
    texts: [],
    week: 6,
    clock: fixedClock(NOW),
    ...over,
  };
}

/** The user's pasted claim, as the finding's repro sent it. */
const pasted = (text: string): NonNullable<EvidenceRequest["claim"]> => ({
  text,
  source: "beat writer",
});

const flat: UsageWeek[] = [1, 2, 3, 4, 5].map((w) => ({
  week: w,
  snap_pct: 0.55,
  target_share: 0.15,
  rz_share: 0.1,
  xfp: 9,
  points: 8,
}));
/** A usage move with no coverage (what made "is active for Sunday" a quiet_role_change). */
const jump: UsageWeek[] = [
  ...flat.slice(0, 4),
  { week: 5, snap_pct: 0.82, target_share: 0.26, rz_share: 0.2, xfp: 15, points: 9 },
];

/** The finding's wordings, each a claim that he plays the coming game. */
const PLAYS = [
  "White is active.",
  "White is active for Sunday.",
  "White will start Sunday.",
  "White is playing Sunday.",
  "White is in the lineup Sunday.",
];

describe("an OUT player's 'he plays' claim names ESPN's OUT (finding evidence-availability-claims-missed)", () => {
  it.each(PLAYS)("cold cache (no usage): %s → availability_conflict on injury_status", (t) => {
    const { data } = analyzeEvidence(req("OUT", { claim: pasted(t) }));
    expect(data.flag).toBe("availability_conflict");
    expect(data.structured_disagrees).toEqual({
      field: "injury_status",
      structured_value: "OUT",
      claim_value: "will_play",
    });
    expect(data.what_would_confirm[0]).toBe(
      "ESPN's injuryStatus or the official game status changes",
    );
    // structured fields win: the recommendation follows ESPN's status, never the text (rule 5)
    expect(data.rec.action).toBe("follow the structured status (OUT): no move on any text");
    expect(data.rec).toEqual(analyzeEvidence(req("OUT")).data.rec);
  });

  it.each(PLAYS)(
    "seeded cache (usage moved, or flat): %s → availability_conflict, never quiet_role_change or a stats-only disagreement",
    (t) => {
      for (const usage of [jump, flat]) {
        const { data } = analyzeEvidence(req("OUT", { claim: pasted(t), usage }));
        expect(data.flag).toBe("availability_conflict");
        expect(data.structured_disagrees).toMatchObject({
          field: "injury_status",
          structured_value: "OUT",
        });
      }
    },
  );

  it("an IR or suspended player too, and the official report's OUT when ESPN carries none", () => {
    for (const status of ["INJURY_RESERVE", "SUSPENSION"] as const)
      for (const t of PLAYS)
        expect(
          analyzeEvidence(req(status, { claim: pasted(t), usage: jump })).data.structured_disagrees,
          `${status}: ${t}`,
        ).toEqual({ field: "injury_status", structured_value: status, claim_value: "will_play" });
    const official = {
      report_status: "Out",
      practice: [{ day: "Fri", status: "Did Not Participate" }],
      as_of: NOW,
    };
    const { data } = analyzeEvidence(
      req(null, { claim: pasted("White will start Sunday."), official }),
    );
    expect(data.flag).toBe("availability_conflict");
    expect(data.structured_disagrees).toEqual({
      field: "injury_status",
      structured_value: "OUT (official report)",
      claim_value: "will_play",
    });
  });

  it("the same claims in his news and outlooks, not only pasted", () => {
    for (const source of ["rss.rotowire.title", "rss.espn.blurb", "espn.player.outlook"] as const)
      for (const t of PLAYS) {
        const { data } = analyzeEvidence(
          req("OUT", { texts: [{ text: wrapUntrusted(t, source), time: NOW }] }),
        );
        expect(data.flag, `${source}: ${t}`).toBe("availability_conflict");
      }
  });

  it("the mirror: an ACTIVE player's 'he does not play' claim names ESPN's ACTIVE (SS-INJ-2's shape)", () => {
    for (const t of [
      "White isn't playing Sunday.",
      "White won't be active Sunday.",
      "White is not in the lineup.",
    ]) {
      const { data } = analyzeEvidence(req("ACTIVE", { claim: pasted(t), usage: flat }));
      expect(data.flag, t).toBe("availability_conflict");
      expect(data.structured_disagrees, t).toEqual({
        field: "injury_status",
        structured_value: "ACTIVE",
        claim_value: "out",
      });
    }
  });

  it("controls (held before the fix, and still hold)", () => {
    // the finding's own control: "will be available Sunday" named OUT before the fix
    expect(
      analyzeEvidence(req("OUT", { claim: pasted("White will be available Sunday.") })).data
        .structured_disagrees,
    ).toEqual({ field: "injury_status", structured_value: "OUT", claim_value: "will_play" });
    // an ACTIVE player's start with flat usage is still an unconfirmed narrative on the stats
    const narrative = analyzeEvidence(
      req("ACTIVE", { claim: pasted("White will start Sunday."), usage: flat }),
    ).data;
    expect(narrative.flag).toBe("unconfirmed_narrative");
    expect(narrative.structured_disagrees).toMatchObject({
      field: "stats",
      claim_value: "role up",
    });
    // a start that is not this game's names no status
    for (const t of ["White will start practicing Wednesday.", "White will start if healthy."])
      expect(
        analyzeEvidence(req("OUT", { claim: pasted(t) })).data.structured_disagrees,
        t,
      ).toBeNull();
  });

  it("an uncertain tag disagrees with nothing: a QUESTIONABLE player's 'is active' is consistent", () => {
    for (const status of ["QUESTIONABLE", "DAY_TO_DAY"] as const) {
      const { data } = analyzeEvidence(
        req(status, { claim: pasted("White is active for Sunday.") }),
      );
      expect(data.flag, status).toBe("consistent");
      expect(data.structured_disagrees, status).toBeNull();
    }
  });

  it("the logged claim is what the text says: an availability will_play, or a start's role up", () => {
    expect(
      analyzeEvidence(req("OUT", { claim: pasted("White is active for Sunday.") })).claims,
    ).toEqual([{ source: "user.claim", type: "availability", signal: "will_play" }]);
    // the start's implication feeds the comparator only; its logged signal is the role claim's own
    expect(
      analyzeEvidence(req("OUT", { claim: pasted("White will start Sunday.") })).claims,
    ).toEqual([{ source: "user.claim", type: "role", signal: "up" }]);
  });

  it("property: any 'he plays' wording × any OUT-class status × any usage × any roster → availability_conflict on injury_status", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...PLAYS,
          "White will be active Sunday",
          "White is expected to start Sunday",
          "White gets the start tonight",
          "White: Active for Week 7",
          "White is a go for Sunday",
          "White is back in the lineup",
        ),
        fc.constantFrom<InjuryStatus>("OUT", "INJURY_RESERVE", "SUSPENSION", "DOUBTFUL"),
        fc.constantFrom<readonly UsageWeek[]>([], flat, jump),
        fc.constantFrom<"mine" | "rival" | "none">("mine", "rival", "none"),
        (t, status, usage, roster) => {
          const base = req(status, { claim: pasted(t), usage });
          const { data } = analyzeEvidence({ ...base, player: { ...base.player, roster } });
          expect(data.flag).toBe("availability_conflict");
          expect(data.structured_disagrees).toEqual({
            field: "injury_status",
            structured_value: status,
            claim_value: "will_play",
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});
