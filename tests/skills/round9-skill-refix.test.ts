// round9-skill-refix.test.ts — the §R17 fix round's verifier findings on the Skills stream's lines
// (changelog §R17, R17-7; the round-8 report's Next steps item 2), held by check-skills:
// V-SK-1 — weekly's lineup row the rec changes gives its change's deadline, the earliest `lock_at`
// among the players the change moves (the starter it benches included), which for one change is
// the tool's `rec.latest_execution_time` — never the incoming player's lock alone, which is later
// whenever the benched starter kicks off first; the Deadline rule's lineup clause says the same.
// V-SK-2 — trade's premise rule says what its line and the standing lines are to the trade
// readings' "say which one changes who should be buying" (references/trade-readings.md line 7):
// under both readings they are that sentence, and no other sentence says it.
// Fixture-free: the lineup facts come from the analyser on a synthetic roster; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ROUND6_FIXED,
  ROUND8_ABSENT,
  ROUND8_FIXED,
  checkSkills,
} from "../../scripts/skills/check-skills.mjs";
import { analyzeLineup, type LineupPlayer } from "../../src/domain/analytics/lineup.js";
import { bare, clockAndRng, dist, ELIGIBLE, referenceSlots } from "../domain/analytics/helpers.js";
import { ROOT, emptyDenylist, tempRepo, type TempRepo } from "./helpers.js";

let deny: ReturnType<typeof emptyDenylist>;
let repo: TempRepo;
beforeAll(() => {
  deny = emptyDenylist();
  repo = tempRepo();
});
afterAll(() => {
  repo.cleanup();
  deny.cleanup();
});
const errorsOf = (): string =>
  checkSkills({ root: repo.root, scan: false, scanEnv: deny.env }).errors.join("\n");
/** Mutate one file of the shared copy, run the check, and put the file back. */
const withEdit = (rel: string, from: string | RegExp, to: string): string => {
  const before = repo.read(rel);
  try {
    repo.edit(rel, from, to);
    return errorsOf();
  } finally {
    repo.write(rel, before);
  }
};
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const body = (skill: string) => read(`skills/${skill}/SKILL.md`);
type Fixed = Record<string, Record<string, Record<string, string>>>;
const pin = (table: unknown, skill: string, k: string): string => {
  const v = (table as Fixed)[skill]?.["SKILL.md"]?.[k];
  if (v === undefined) throw new Error(`no ${skill}.${k}`);
  return v;
};
const line = (skill: string, k: string): string => pin(ROUND8_FIXED, skill, k);
const absent = (skill: string): string[] =>
  (ROUND8_ABSENT as Record<string, Record<string, string[]> | undefined>)[skill]?.["SKILL.md"] ??
  [];
/** The text of a `### ` section, up to the next heading of the same or a higher level. */
const section = (text: string, heading: string): string => {
  const at = text.indexOf(`\n${heading}\n`);
  if (at < 0) return "";
  const rest = text.slice(at + heading.length + 2);
  const next = rest.search(/\n#{1,3} /);
  return next < 0 ? rest : rest.slice(0, next);
};

// --- V-SK-1: a lineup change's deadline --------------------------------------------------------

const SLOT = { QB: 0, RB: 2, WR: 4, TE: 6, FLEX: 23, DST: 16, K: 17, BE: 20 } as const;
const LONDON = "2026-10-11T13:30:00.000Z"; // Sun 9:30 AM ET
const SUNDAY = "2026-10-11T17:00:00.000Z"; // Sun 1:00 PM ET
const NIGHT = "2026-10-12T00:20:00.000Z"; // Sun 8:20 PM ET
const NOW = "2026-10-08T12:00:00.000Z";
const player = (
  id: number,
  position: string,
  mean: number,
  slot: number,
  lock = SUNDAY,
): LineupPlayer => ({
  player_id: id,
  gsis_id: null,
  name: bare(`Player ${String(id)}`),
  position,
  eligible_slot_ids: ELIGIBLE[position] ?? [SLOT.BE],
  injury_status: null,
  pro_team_id: id,
  slot_id: slot,
  locked: false,
  lock_at: lock,
  points: dist(mean, 0.15),
  p_active: 1,
  espn_projection: mean,
  percent_started: 50,
  role_games: 4,
});
/** A full starting lineup; `flexLock` is the FLEX starter's kickoff, `bench` the bench players. */
const lineup = (flexLock: string, bench: LineupPlayer[], qb = player(1, "QB", 20, SLOT.QB)) => [
  qb,
  player(2, "RB", 14, SLOT.RB),
  player(3, "RB", 13, SLOT.RB),
  player(4, "WR", 13, SLOT.WR),
  player(5, "WR", 12, SLOT.WR),
  player(6, "TE", 9, SLOT.TE),
  player(7, "RB", 4, SLOT.FLEX, flexLock), // the starter a FLEX upgrade benches
  player(8, "D/ST", 7, SLOT.DST),
  player(9, "K", 8, SLOT.K),
  ...bench,
];
const analyse = (players: LineupPlayer[]) =>
  analyzeLineup({
    roster: referenceSlots(),
    players,
    opponent: null,
    seeding_config: { mode: "espn_rule", confirmed_at: null },
    clock: clockAndRng(NOW).clock,
  });
const startsAt = (d: ReturnType<typeof analyse>, slot: string): (number | null)[] =>
  d.rec.subjects.filter((s) => s.role === "start" && s.slot === slot).map((s) => s.player_id);

describe("V-SK-1: the tool's deadline for a lineup change (src/domain/analytics/lineup.ts)", () => {
  it("a decisive FLEX swap whose benched starter kicks off first is due at his kickoff, not the incoming player's", () => {
    const d = analyse(lineup(LONDON, [player(10, "WR", 16, SLOT.BE, SUNDAY)]));
    expect(d.rec.no_move).toBe(false);
    expect(startsAt(d, "FLEX")).toEqual([10]);
    // the row the table prints is FLEX → player 10 (1:00 PM); the benched player 7 has no row
    expect(d.rec.subjects.find((s) => s.player_id === 7)?.role).toBe("sit");
    expect(d.rec.latest_execution_time).toBe(LONDON);
    expect(d.rec.latest_execution_time).not.toBe(SUNDAY);
  });

  it("the same swap with the incoming player first is due at his kickoff: the earlier of the two either way", () => {
    const d = analyse(lineup(SUNDAY, [player(10, "WR", 16, SLOT.BE, LONDON)]));
    expect(startsAt(d, "FLEX")).toEqual([10]);
    expect(d.rec.latest_execution_time).toBe(LONDON);
  });

  it("with two changes the rec's deadline is the earlier change's; the later change's own deadline is its players' earliest kickoff", () => {
    // FLEX: player 10 (1:00 PM) for player 7 (London); QB: player 11 (8:20 PM) for player 1 (1:00 PM)
    const d = analyse(
      lineup(
        LONDON,
        [player(10, "WR", 16, SLOT.BE, SUNDAY), player(11, "QB", 30, SLOT.BE, NIGHT)],
        player(1, "QB", 12, SLOT.QB, SUNDAY),
      ),
    );
    expect(startsAt(d, "FLEX")).toEqual([10]);
    expect(startsAt(d, "QB")).toEqual([11]);
    expect(d.rec.latest_execution_time).toBe(LONDON);
    // the QB change moves players 11 and 1: its deadline is 1:00 PM, neither London nor 8:20 PM, so
    // `rec.latest_execution_time` is a row's deadline only when the rec makes one change
    const qbChange = [NIGHT, SUNDAY].map((t) => Date.parse(t));
    expect(new Date(Math.min(...qbChange)).toISOString()).toBe(SUNDAY);
  });
});

describe("V-SK-1: weekly gives a changed lineup row its change's deadline", () => {
  const withdrawnRows =
    "its Deadline cell the `lock_at` of the player the rec moves into that slot";
  const withdrawnLock = "a lineup move's `lock_at` (the player's kickoff)";

  it("the row rule: the earliest lock among the players the change moves, `rec.latest_execution_time` for one change, never the incoming player's alone", () => {
    const rows = line("weekly", "lineupHeaderRows");
    for (const part of [
      '"—" on a row with no move',
      "a row the rec changes gives its change's deadline, in Eastern Time",
      "the earliest `lock_at` among the players that change moves",
      "the one it moves into the slot",
      "the starter it takes out of the lineup, who is in no row after it",
      "any starter it only shifts to another slot on the way",
      "which for a rec that makes one change is `rec.latest_execution_time`",
      "never the incoming player's `lock_at` alone",
    ])
      expect(rows, part).toContain(part);
    expect(rows).not.toContain(withdrawnRows);
  });

  it("the Deadline rule's lineup clause says the same, and both agree with the output contract's Deadline", () => {
    const w = body("weekly");
    expect(line("weekly", "lineupMoveLock")).toBe(
      "a lineup move's `lock_at` (the earliest kickoff among the players it moves, the starter it benches included)",
    );
    const rule = w.split("\n").find((l) => l.startsWith("**Every action carries its deadline.**"));
    expect(rule).toContain(
      `has a **Deadline** column: ${line("weekly", "lineupMoveLock")}, a claim's`,
    );
    // the output contract (generated from output-template.md) names the same time
    expect(section(w, "### Deadline")).toContain(
      "`rec.latest_execution_time` or the earliest `lock_at` that matters",
    );
    expect(section(w, "### This week's matchup and lineup")).toContain(
      `${line("weekly", "lineupHeader")} — ${line("weekly", "lineupHeaderRows")}. ${pin(ROUND6_FIXED, "weekly", "basisRule")}`,
    );
  });

  it("the withdrawn wordings are gone from the Skill and held absent by the check", () => {
    expect(absent("weekly")).toEqual([withdrawnRows, withdrawnLock]);
    expect(body("weekly")).not.toContain(withdrawnRows);
    expect(body("weekly")).not.toContain(withdrawnLock);
    for (const gone of [withdrawnRows, withdrawnLock])
      expect(withEdit("skills/weekly/SKILL.md", /\n$/, `\n${gone}\n`)).toContain(
        `skills/weekly/SKILL.md: text round 8's triage withdrew is still there: "${gone}"`,
      );
  });

  it("restoring the first wording in place fails the check on both counts", () => {
    const e = withEdit(
      "skills/weekly/SKILL.md",
      line("weekly", "lineupHeaderRows"),
      'one row per slot of the lineup the rec sets or keeps, its Deadline cell the `lock_at` of the player the rec moves into that slot, in Eastern Time, and "—" on a row with no move (a held coin-flip swap is no move: its fixed line below)',
    );
    expect(e).toContain(
      `skills/weekly/SKILL.md: round 8's fixed line "lineupHeaderRows" is missing`,
    );
    expect(e).toContain(`text round 8's triage withdrew is still there: "${withdrawnRows}"`);
  });
});

// --- V-SK-2: trade's premise line and the trade readings' sentence ------------------------------

describe("V-SK-2: trade's premise rule answers the trade readings' sentence", () => {
  const ask = "say which one changes who should be buying";

  it("references/trade-readings.md still asks for it (line 7), which the rule quotes word for word", () => {
    const refLines = read("skills/trade/references/trade-readings.md").split("\n");
    expect(refLines[6]).toContain(
      `\`why_they_accept\` reads the partner's standing under the reading in use; when both readings are shown, ${ask}.`,
    );
    expect(line("trade", "premiseReadings")).toBe(
      `Under both readings the standing lines, and with a premise this line after them, are the sentence references/trade-readings.md asks for ("${ask}"): no other sentence says it.`,
    );
  });

  it("it ends the premise bullet, right after the premise's only-answer sentence", () => {
    const bullet = body("trade")
      .split("\n")
      .find((l) => l.startsWith('- Under `seeding_mode: "both"`, a premise'));
    expect(bullet).toBeDefined();
    expect(
      bullet?.endsWith(`${line("trade", "premiseOnly")} ${line("trade", "premiseReadings")}`),
    ).toBe(true);
  });

  it("cutting it, or rewording it, fails the check", () => {
    const s = line("trade", "premiseReadings");
    for (const to of ["", s.replace("no other sentence", "no other sentences")])
      expect(withEdit("skills/trade/SKILL.md", s, to)).toContain(
        `skills/trade/SKILL.md: round 8's fixed line "premiseReadings" is missing: "${s}"`,
      );
  });
});
