// news-check-claim-time.test.ts — news-check passes a claim's time only in the one form
// espn_analyze_evidence accepts (Stage C finding skills-news-check-time-format). Step 2 asks when a
// pasted claim appeared, and `claim.time` is `isoInstantSchema` (src/mcp/bounds.ts): a date-time with
// seconds and its UTC offset. The answers users give — "yesterday afternoon", a bare date — failed
// VALIDATION, and in a client that is not told the date the model could only drop the field or invent
// a timestamp. Held here against the REAL input schema the server parses (the registry's zod object,
// as tests/e2e/skills-dry-run.test.ts holds every sequence): every value of the form the Skill states
// is accepted, every form it says to leave out is refused, the Eastern-Time rule it gives matches the
// tz database for every date of a season, and the Lane 1 sequence that checks a paste passes a time
// in that form. No network, no cookie.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../../src/mcp/registry.js";
import { ROOT } from "./helpers.js";

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const body = read("skills/news-check/SKILL.md");

/** A `### N. …` step of the procedure, up to the next heading. */
function step(heading: string): string {
  const at = body.indexOf(`\n${heading}\n`);
  if (at === -1) throw new Error(`news-check no longer has "${heading}"`);
  const rest = body.slice(at + heading.length + 2);
  const next = rest.search(/\n#{2,3} /);
  return next === -1 ? rest : rest.slice(0, next);
}
const CLAIM_STEP = step("### 2. The claim");
const CHECK_STEP = step("### 4. The check");

const evidence = REGISTRY.find((e) => e.name === "espn_analyze_evidence")?.tool;
if (evidence === undefined || evidence === null)
  throw new Error("espn_analyze_evidence is not built");
const input = evidence.input;
/** Whether the tool's own input schema accepts this `claim.time` (all else valid). */
const accepted = (time: string): boolean =>
  input.safeParse({ player: { player_ids: [4428331] }, claim: { text: "a pasted claim", time } })
    .success;

/** The sentence of step 4 that says when `time` is left out. */
const LEAVE_OUT =
  CHECK_STEP.split(/(?<=\.)\s+/).find((s) => s.startsWith("Leave `time` out")) ?? "";
/** The examples step 4 gives to pass: every backticked date-time. */
const EXAMPLES = [...CHECK_STEP.matchAll(/`(\d{4}-\d{2}-\d{2}T[^`]+)`/g)].map((m) => m[1] ?? "");
/** The form step 4 states, `YYYY-MM-DDThh:mm:ss±hh:mm`. */
const FORM = /`(YYYY-MM-DDThh:mm:ss±hh:mm)`/.exec(CHECK_STEP)?.[1] ?? "";

/** America/New_York's UTC offset at an instant (`-04:00` / `-05:00`), from the tz database. */
const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  timeZoneName: "longOffset",
});
const nyOffset = (ms: number): string =>
  (NY.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "").replace(
    /^GMT/,
    "",
  );
/** The day of the month of the first Sunday of November of `year`. */
function firstSundayOfNovember(year: number): number {
  const nov1 = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  return 1 + ((7 - nov1) % 7);
}

describe("news-check passes a claim's time only as the tool accepts it (Stage C finding skills-news-check-time-format)", () => {
  it("step 4 states the one form `claim.time` takes, with an example", () => {
    expect(CHECK_STEP).toContain("`claim.time`");
    expect(FORM).toBe("YYYY-MM-DDThh:mm:ss±hh:mm");
    expect(CHECK_STEP).toMatch(/seconds and its UTC offset/);
    expect(EXAMPLES.length).toBeGreaterThan(0);
    for (const ex of EXAMPLES) expect(accepted(ex), ex).toBe(true);
  });

  it("every value of the stated form, and its `Z` variant, is accepted by the tool's own schema", () => {
    const two = (n: number): string => String(n).padStart(2, "0");
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2099-12-31T23:59:59Z") }),
        fc.constantFrom("+", "-"),
        fc.integer({ min: 0, max: 14 }),
        fc.constantFrom(0, 30, 45),
        fc.boolean(),
        (d, sign, oh, om, utc) => {
          if (Number.isNaN(d.getTime())) return;
          // the calendar fields of a real date, written in the stated form
          const local = `${String(d.getUTCFullYear())}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
          const v = utc ? `${local}Z` : `${local}${sign}${two(oh)}:${two(om)}`;
          expect(accepted(v), v).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("every form step 4 says to leave out is one the tool refuses", () => {
    expect(LEAVE_OUT).not.toBe("");
    const quoted = [...LEAVE_OUT.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(quoted).toEqual(expect.arrayContaining(["yesterday afternoon", "this morning"]));
    for (const q of quoted) expect(accepted(q), q).toBe(false);
    // "a date with no clock time", "a clock time with no zone" — and the near misses the stated
    // form rules out (no seconds; an offset without its colon)
    expect(LEAVE_OUT).toMatch(/a date with no clock time/);
    expect(LEAVE_OUT).toMatch(/a clock time with no zone/);
    for (const ex of EXAMPLES) {
      const local = ex.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "");
      expect(accepted(ex.slice(0, 10)), "date alone").toBe(false);
      expect(accepted(local), "no zone").toBe(false);
      expect(accepted(ex.replace(/:\d{2}(?=(?:Z|[+-]\d{2}:\d{2})$)/, "")), "no seconds").toBe(
        false,
      );
      expect(accepted(ex.replace(/([+-]\d{2}):(\d{2})$/, "$1$2")), "offset without colon").toBe(
        false,
      );
    }
  });

  it("the time is never worked out or filled in: left out, and said so", () => {
    expect(LEAVE_OUT).toMatch(/never work a time out from a relative day/);
    expect(LEAVE_OUT).toMatch(/never fill in a missing part/);
    expect(CHECK_STEP).toMatch(/Say in one line that the time was not passed/);
    // only when the user (or the paste) gives all three parts
    expect(CHECK_STEP).toMatch(/gives the date, the clock time and the time zone/);
  });

  it("the Eastern-Time rule step 4 gives matches the tz database on every day of seasons 2024–2035", () => {
    const rule =
      /Eastern Time is `(-\d{2}:\d{2})` until 2 a\.m\. on the first Sunday of November and `(-\d{2}:\d{2})` from then on/.exec(
        CHECK_STEP,
      );
    expect(rule, "the ET rule").not.toBeNull();
    const [, summer, winter] = rule ?? [];
    for (let season = 2024; season <= 2035; season++) {
      // 2 a.m. Eastern daylight time on the first Sunday of November is 06:00 UTC
      const switchAt = Date.UTC(season, 10, firstSundayOfNovember(season), 6);
      expect(nyOffset(switchAt - 1000), `${String(season)}: a second before 2 a.m.`).toBe(summer);
      expect(nyOffset(switchAt), `${String(season)}: 2 a.m.`).toBe(winter);
      // every day from August 1 to the end of February, at 17:00 UTC (midday in New York)
      for (
        let t = Date.UTC(season, 7, 1, 17);
        t < Date.UTC(season + 1, 2, 1, 17);
        t += 86_400_000
      ) {
        const predicted = t < switchAt ? summer : winter;
        expect(nyOffset(t), new Date(t).toISOString()).toBe(predicted);
      }
    }
    // and the Skill's own example follows its rule
    for (const ex of EXAMPLES) {
      const off = /([+-]\d{2}:\d{2})$/.exec(ex)?.[1];
      if (off === undefined) continue;
      expect(nyOffset(Date.parse(ex)), ex).toBe(off);
    }
  });

  it("step 2 asks for the source and the time without waiting for them", () => {
    expect(CLAIM_STEP).toMatch(/never wait for it: the check runs without both/);
  });

  it("the Lane 1 sequence that checks a paste passes a time in the stated form, before the fixture's clock", () => {
    const seq = JSON.parse(read("skills/news-check/evals/tool_sequence.json")) as {
      sequences: { id: string; steps: { tool: string; args: Record<string, unknown> }[] }[];
    };
    const pasted = seq.sequences.find((s) => s.id === "pasted");
    const ev = pasted?.steps.find((s) => s.tool === "espn_analyze_evidence");
    const time = (ev?.args.claim as { time?: unknown } | undefined)?.time;
    expect(typeof time).toBe("string");
    expect(String(time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(accepted(String(time))).toBe(true);
    const clock = (JSON.parse(read("fixtures/espn/fx-10h/manifest.json")) as { clock: string })
      .clock;
    expect(Date.parse(String(time))).toBeLessThan(Date.parse(clock));
    expect(nyOffset(Date.parse(String(time)))).toBe(/([+-]\d{2}:\d{2})$/.exec(String(time))?.[1]);
  });
});
