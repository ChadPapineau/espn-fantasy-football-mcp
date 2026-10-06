// fx10h-injections.test.ts — the evidence domain on the fx-10h injection variants as committed
// (fixtures/espn/fx-10h/inj-*/league/*.patch.json; research 05 §6 cases 1–4; 06 §D.0
// inj-league-name / inj-division-name; plan 10 B8). Every injected string the variants patch in is
// read from the fixture, given its provenance tag by its JSON path, and checked: league-member text
// never enters the reliability model (rule 4); ESPN outlook text becomes at most a closed-vocabulary
// claim, flagged text is capped; and on inj-ir-cleared the structured comparator names
// `injury_status` against the patched OUT (rule 3, B8).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLAIM_DIRECTIONS,
  CLAIM_TYPES,
  extractClaim,
  INJECTION_RELIABILITY_CAP,
  reliabilityOf,
  reliabilitySourceOf,
  structuredDisagreement,
} from "../../../src/domain/evidence/index.js";
import { wrapUntrusted, type UntrustedSource } from "../../../src/domain/league/types.js";

const ROOT = new URL("../../../fixtures/espn/fx-10h/", import.meta.url);
const VARIANTS = [
  "inj-outlook-system",
  "inj-teamname-json",
  "inj-ir-cleared",
  "inj-tradeblock",
  "inj-league-name",
  "inj-division-name",
] as const;

interface Op {
  readonly op: string;
  readonly path: readonly (string | number)[];
  readonly value: unknown;
}

/** Every (path, free text) a variant's patches write, outlook maps flattened. */
function injected(variant: string): { path: (string | number)[]; text: string }[] {
  const dir = new URL(`${variant}/league/`, ROOT);
  const out: { path: (string | number)[]; text: string }[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".patch.json"))) {
    for (const op of JSON.parse(readFileSync(new URL(f, dir), "utf8")) as Op[]) {
      const last = op.path[op.path.length - 1];
      if (last === "injuryStatus" || last === "lineupSlotId") continue; // structured fields, not text
      if (typeof op.value === "string") out.push({ path: [...op.path], text: op.value });
      else if (op.value !== null && typeof op.value === "object") {
        const byWeek = (op.value as { outlooksByWeek?: Record<string, string> }).outlooksByWeek;
        for (const [wk, t] of Object.entries(byWeek ?? {}))
          out.push({ path: [...op.path, "outlooksByWeek", wk], text: t });
      }
    }
  }
  return out;
}

/** The provenance tag a normaliser gives the string at a path (plan 01 §4.4 source tags). */
function tagOf(path: readonly (string | number)[]): UntrustedSource | null {
  const keys = path.filter((k): k is string => typeof k === "string");
  const last = keys[keys.length - 1];
  if (keys.includes("outlooksByWeek")) return "espn.player.outlook";
  if (last === "seasonOutlook") return "espn.player.season_outlook";
  if (keys.includes("tradeBlock")) return "espn.team.trade_block";
  if (keys.includes("divisions") && last === "name") return "espn.division.name";
  if (keys.includes("teams") && last === "name") return "espn.team.name";
  if (keys.includes("teams") && last === "abbrev") return "espn.team.abbrev";
  if (keys[0] === "settings" && last === "name") return "espn.league.name";
  return null;
}

const VOCAB = new Set<string>([...CLAIM_TYPES, ...CLAIM_DIRECTIONS]);

describe("the fx-10h injection variants through the evidence domain", () => {
  it.each(VARIANTS.map((v) => [v]))(
    "%s: every injected string is tagged, inert and weighted by rule",
    (variant) => {
      const items = injected(variant);
      expect(items.length).toBeGreaterThan(0);
      for (const { path, text } of items) {
        const tag = tagOf(path);
        expect(tag, JSON.stringify(path)).not.toBeNull();
        if (tag === null) continue;
        const source = reliabilitySourceOf(tag);
        const wrapped = wrapUntrusted(text, tag);
        const claim = extractClaim(wrapped.untrusted_text.value);
        if (claim !== null) {
          expect(VOCAB.has(claim.type)).toBe(true);
          expect(VOCAB.has(claim.direction)).toBe(true);
          expect(claim.type).not.toBe("transaction"); // no injected text ever reads as a roster move
        }
        if (tag.startsWith("espn.player.")) {
          // ESPN editorial text is scored; any flag caps it
          expect(source).not.toBeNull();
          if (source !== null && claim !== null) {
            const r = reliabilityOf(source, claim.type, {
              flags: wrapped.untrusted_text.flags ?? [],
              week: 5,
            });
            if ((wrapped.untrusted_text.flags ?? []).length > 0)
              expect(r.reliability ?? 0).toBeLessThanOrEqual(INJECTION_RELIABILITY_CAP);
          }
        } else {
          // rule 4: team, member, league and division names and trade blocks never enter the model
          expect(source, tag).toBeNull();
        }
      }
    },
  );

  it("inj-ir-cleared: the outlook is an availability claim, and structured_disagrees names injury_status", () => {
    const patch = JSON.parse(
      readFileSync(new URL("inj-ir-cleared/league/pool.patch.json", ROOT), "utf8"),
    ) as Op[];
    const status = patch.find((op) => op.path[op.path.length - 1] === "injuryStatus")?.value;
    expect(status).toBe("OUT");
    const [outlook] = injected("inj-ir-cleared").filter(
      (x) => tagOf(x.path) === "espn.player.outlook",
    );
    if (outlook === undefined) throw new Error("no outlook in the variant");
    const wrapped = wrapUntrusted(outlook.text, "espn.player.outlook");
    const claim = extractClaim(wrapped.untrusted_text.value);
    expect(claim).toMatchObject({ type: "availability", direction: "up", designation: "cleared" });
    expect(structuredDisagreement(claim, { injury_status: "OUT" })).toEqual({
      field: "injury_status",
      structured_value: "OUT",
      claim_value: "cleared",
    });
    // the source's low, cold-start reliability (research 05 §6 case 3)
    expect(reliabilityOf("espn.player.outlook", "availability").reliability).toBe(0.5);
  });

  it("inj-outlook-system: flagged, capped, and never a drop", () => {
    const [o] = injected("inj-outlook-system");
    if (o === undefined) throw new Error("no text");
    const w = wrapUntrusted(o.text, "espn.player.season_outlook");
    expect(w.untrusted_text.flags).toEqual(expect.arrayContaining(["imperative", "role_marker"]));
    const claim = extractClaim(w.untrusted_text.value);
    expect(claim?.type ?? null).not.toBe("transaction");
  });
});
