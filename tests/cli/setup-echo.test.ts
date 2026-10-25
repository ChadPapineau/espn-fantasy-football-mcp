// setup-echo.test.ts — `eff setup` never draws espn_s2 (plan 03 §2.1 step 3: echo off, the value never
// printed; plan 02 §2.3; README "Safe credential setup"). Stage C finding
// setup-hidden-prompt-echo-burst, ruling R7-3: three fixes each closed one paste pattern and the next
// verification found another (a burst, a line break inside the value, type-ahead, an unfinished line
// an edit key redrew, a later read, a pause inside one paste). The approach changed (src/cli/prompt.ts)
// and this file holds it through setup itself — the real orchestration (src/auth/setup.ts askCookies:
// SWID, espn_s2, re-asks) over the real terminal prompt — on every paste, type-ahead, burst and
// edit-key variant the verifications produced (their pty driver's scenarios, replayed on fake time),
// plus the ruling's property: over random chunkings and timings of a SWID and espn_s2 pasted
// together, no part of espn_s2 is ever written to the terminal. In memory: test mode (a throwaway
// keychain service), no network, no file, no real credential (fake values in the cookie alphabet).
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEspnS2 } from "../../scripts/ci/secret-fixtures.mjs";
import { SETUP_TEXT, runSetup, type SetupResult } from "../../src/auth/setup.js";
import {
  DISCARDED_NOTE,
  FLUSH_QUIET_MS,
  HIDDEN_REFUSED_NOTE,
  TYPED_AHEAD_NOTE,
  createTerminalPrompt,
} from "../../src/cli/prompt.js";
import { MemoryStore, RecordingRegistrar } from "../auth/helpers.js";
import { FakeTty, Screen, shows } from "./fake-tty.js";

const SERVICE = "eff-test-echo";
const SWID = "{00000000-0000-4000-8000-000000000001}";
/** The SWID without its braces: refused (missing_braces), so setup asks for it again. */
const BAD_SWID = SWID.slice(1, -1);
const S2 = fakeEspnS2("cli-setup-echo", 266);
/** A value near the kernel's 4 KB read size (a burst the kernel splits). */
const BIG = fakeEspnS2("cli-setup-echo-big", 3_900);
const ASK_SWID = SETUP_TEXT.askSwid;
const ASK_S2 = SETUP_TEXT.askEspnS2;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** One step of a scenario: the pty driver's vocabulary. */
type Step =
  | { readonly wait: string; readonly n?: number }
  | { readonly write: string }
  | { readonly sleep: number }
  /** Answer what the screen asks, as a person would (after 400 ms of quiet output), `rounds` times. */
  | { readonly follow: number; readonly s2?: string };

const cr = (s: string): string => `${s}\r`;
/** A paste delivered `size` bytes at a time, `delay` ms apart (a slow link). */
const slow = (data: string, size: number, delay: number): Step[] => {
  const out: Step[] = [];
  for (let i = 0; i < data.length; i += size)
    out.push({ write: data.slice(i, i + size) }, { sleep: delay });
  return out;
};

/** Runs setup over a fake terminal through `steps`, then ends the input; returns what the screen shows. */
async function scenario(
  steps: readonly Step[],
  secret = S2,
  ahead: string | null = null,
): Promise<{ screen: string; result: SetupResult; stored: string | null }> {
  const stdin = new FakeTty();
  const screen = new Screen();
  const prompt = createTerminalPrompt({ stdin, out: screen, takeTerminalNow: true });
  // keys typed while setup starts: read after the terminal was taken, before the first question
  if (ahead !== null) stdin.type(ahead);
  const keychain = new MemoryStore("keychain", SERVICE);
  const network = {
    anonymousSettings: () => Promise.resolve({ error: "test_mode" }),
    anonymousBoard: () => Promise.resolve({ error: "test_mode" }),
    settingsWithCookies: () => Promise.resolve({ error: "test_mode" }),
    boardWithCookies: () => Promise.resolve({ error: "test_mode" }),
    resolveTeam: () => Promise.resolve({ kind: "error" as const, code: "test_mode" }),
  };
  // set by the run when it ends (an object: the loops below read what the callback wrote)
  const end: { result: SetupResult | null } = { result: null };
  const finished = (): boolean => end.result !== null;
  const run = runSetup(
    {
      reset: false,
      storage: null,
      serviceName: SERVICE,
      leagueId: "0",
      season: 2026,
      recordedStore: null,
      filePath: "/nonexistent/session.json",
    },
    {
      prompt,
      out: (l) => screen.write(`${l}\n`),
      now: () => new Date().toISOString(),
      stores: { keychain, file: new MemoryStore("file") },
      runSelftest: () =>
        Promise.resolve({
          outcome: "ok",
          reason: "ok",
          code: null,
          at: new Date().toISOString(),
          cleanup: "deleted",
        }),
      network,
      config: { record: () => Promise.resolve() },
      credentialState: null,
      registrar: new RecordingRegistrar(),
    },
  ).then((r) => {
    end.result = r;
    return r;
  });
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  for (const st of steps) {
    if ("wait" in st) {
      for (let t = 0; t < 10_000 && screen.count(st.wait) < (st.n ?? 1) && !finished(); t += 10)
        await tick(10);
    } else if ("write" in st) stdin.type(st.write);
    else if ("sleep" in st) await tick(st.sleep);
    else
      for (let r = 0; r < st.follow && !finished(); r++) {
        // wait for 400 ms of quiet output, then answer the question asked last
        let last = screen.text.length;
        let quiet = 0;
        for (let t = 0; t < 10_000 && quiet < 400 && !finished(); t += 50) {
          await tick(50);
          if (screen.text.length !== last) {
            last = screen.text.length;
            quiet = 0;
          } else quiet += 50;
        }
        if (finished()) break;
        const swidAt = screen.text.lastIndexOf(ASK_SWID);
        const s2At = screen.text.lastIndexOf(ASK_S2);
        stdin.type(cr(swidAt > s2At ? SWID : (st.s2 ?? secret)));
      }
  }
  // let it finish; still waiting at a question: the input ends (Ctrl-C)
  for (let t = 0; t < 30_000 && !finished(); t += 100) await tick(100);
  if (!finished()) stdin.type("\x03");
  const r = await run;
  prompt.close();
  return { screen: screen.text, result: r, stored: keychain.stored?.cookies.espn_s2 ?? null };
}

/** The leak check: no 8-character run of the secret, and no `%` (every fake value holds one; no fixed text does). */
function expectNotDrawn(screen: string, secret = S2): void {
  expect(shows(screen, secret, 8), "a run of espn_s2 reached the screen").toBe(false);
  expect(screen.includes("%"), "a cookie character reached the screen").toBe(false);
}

describe("every variant the verifications produced: setup never draws espn_s2", () => {
  // the finding's original modes
  const SCEN: Record<string, readonly Step[]> = {
    together: [{ wait: ASK_SWID }, { write: cr(SWID) + cr(S2) }, { follow: 3 }],
    split: [
      { wait: ASK_SWID },
      { write: cr(SWID) },
      { wait: ASK_S2 },
      { write: cr(S2.slice(0, 50)) + cr(S2.slice(50)) },
      { follow: 3 },
    ],
    separate: [{ wait: ASK_SWID }, { write: cr(SWID) }, { wait: ASK_S2 }, { write: cr(S2) }],
    // the round-2 variant: a refused SWID pasted with espn_s2 and no final line break, then the
    // keys readline redrew, undid or yanked with at the re-asked SWID question
    "badswid-s2-nobreak-editkeys": [
      { wait: ASK_SWID },
      { write: cr(BAD_SWID) + S2 },
      { wait: ASK_S2 },
      { sleep: 200 },
      { write: "\r" },
      { follow: 1 },
      { wait: ASK_SWID, n: 2 },
      { sleep: 300 },
      { write: "\x7f\x0c\x17\x1f\x1e\x19\x01\x0b\x1b[3~\x1b[D" },
      { sleep: 200 },
      { write: `\x15${cr(SWID)}` },
      { follow: 3 },
    ],
    "together-crlf": [{ wait: ASK_SWID }, { write: `${SWID}\r\n${S2}\r\n` }, { follow: 3 }],
    "together-lf": [{ wait: ASK_SWID }, { write: `${SWID}\n${S2}\n` }, { follow: 3 }],
    "badswid-together-lf": [{ wait: ASK_SWID }, { write: `${BAD_SWID}\n${S2}\n` }, { follow: 4 }],
    "a huge burst the kernel splits": [
      { wait: ASK_SWID },
      { write: (cr(BAD_SWID) + cr(BIG)).slice(0, 1024) },
      { write: (cr(BAD_SWID) + cr(BIG)).slice(1024, 4096) },
      { write: (cr(BAD_SWID) + cr(BIG)).slice(4096) },
      { follow: 4, s2: BIG },
    ],
  };
  // the round-2 variant: the refused SWID, espn_s2 a read later
  for (const gap of [0, 2, 20, 100, 200, 500])
    SCEN[`badswid-s2-later-${String(gap)}ms`] = [
      { wait: ASK_SWID },
      { write: cr(BAD_SWID) },
      { sleep: gap },
      { write: cr(S2) },
      { follow: 4 },
    ];
  // round 3: a blank line between the two (copied from a note), refused SWID
  for (const gap of [0, 100, 140, 160, 200, 400]) {
    SCEN[`badswid-blank-s2-${String(gap)}ms`] = [
      { wait: ASK_SWID },
      { write: `${cr(BAD_SWID)}\r` },
      { sleep: gap },
      { write: cr(S2) },
      { sleep: 400 },
      { write: cr(SWID) },
      { sleep: 300 },
      { write: cr(S2) },
      { follow: 3 },
    ];
    // ... answering what the screen shows after the paste (the follow driver)
    SCEN[`F-badswid-blank-s2-${String(gap)}ms`] = [
      { wait: ASK_SWID },
      { write: `${cr(BAD_SWID)}\r` },
      { sleep: gap },
      { write: cr(S2) },
      { follow: 4 },
    ];
    SCEN[`F-badswid-label-s2-${String(gap)}ms`] = [
      { wait: ASK_SWID },
      { write: cr(BAD_SWID) + cr("espn_s2:") },
      { sleep: gap },
      { write: cr(S2) },
      { follow: 4 },
    ];
    SCEN[`F-badswid-s2split-${String(gap)}ms`] = [
      { wait: ASK_SWID },
      { write: cr(BAD_SWID) + cr(S2.slice(0, 60)) },
      { sleep: gap },
      { write: cr(S2.slice(60)) },
      { follow: 4 },
    ];
    // the attempt-3 verifier's find: a pause inside one paste longer than the quiet window
    SCEN[`F-badswid-blank-pause-inside-s2-${String(gap)}ms`] = [
      { wait: ASK_SWID },
      { write: `${cr(BAD_SWID)}\r${S2.slice(0, 10)}` },
      { sleep: gap },
      { write: cr(S2.slice(10)) },
      { follow: 4 },
    ];
  }
  // a slow paste: 16 bytes at a time
  for (const delay of [125, 140, 160, 200]) {
    SCEN[`slowpaste-badswid-s2-${String(delay)}ms`] = [
      { wait: ASK_SWID },
      ...slow(cr(BAD_SWID) + cr(S2), 16, delay),
      { sleep: 400 },
      { write: cr(SWID) },
      { follow: 3 },
    ];
    SCEN[`slowpaste-badswid-blank-s2-${String(delay)}ms`] = [
      { wait: ASK_SWID },
      ...slow(`${cr(BAD_SWID)}\r${cr(S2)}`, 16, delay),
      { sleep: 400 },
      { write: cr(SWID) },
      { sleep: 300 },
      { write: cr(S2) },
      { follow: 3 },
    ];
    SCEN[`F-slowpaste16-badswid-blank-s2-${String(delay)}ms`] = [
      { wait: ASK_SWID },
      ...slow(`${cr(BAD_SWID)}\r${cr(S2)}`, 16, delay),
      { follow: 4 },
    ];
    SCEN[`F-slowpaste16-badswid-s2split-${String(delay)}ms`] = [
      { wait: ASK_SWID },
      ...slow(cr(BAD_SWID) + cr(S2.slice(0, 60)) + cr(S2.slice(60)), 16, delay),
      { follow: 4 },
    ];
    SCEN[`F-slowpaste16-goodswid-blank-s2-${String(delay)}ms`] = [
      { wait: ASK_SWID },
      ...slow(`${cr(SWID)}\r${cr(S2)}`, 16, delay),
      { follow: 4 },
    ];
  }
  // espn_s2 pasted at the SWID question by mistake (first ask and the re-ask)
  SCEN["espn_s2 at the SWID question"] = [{ wait: ASK_SWID }, { write: cr(S2) }, { follow: 4 }];
  SCEN["espn_s2 at the re-asked SWID question"] = [
    { wait: ASK_SWID },
    { write: cr(BAD_SWID) },
    { wait: ASK_S2 },
    { sleep: 300 },
    { write: cr(S2) },
    { wait: ASK_SWID, n: 2 },
    { sleep: 300 },
    { write: cr(S2) },
    { follow: 4 },
  ];

  // both lines after the process took the terminal, before the first question (the "early" mode;
  // keys typed before the process took it were echoed by the driver — no program can stop that, so
  // the scrollback note says so)
  it("early-after-raw", async () => {
    const got = await scenario([{ follow: 3 }], S2, cr(SWID) + cr(S2));
    expectNotDrawn(got.screen);
    expect(got.screen).toContain(TYPED_AHEAD_NOTE);
  }, 60_000);

  it.each(Object.entries(SCEN))(
    "%s",
    async (name, steps) => {
      const secret = name.startsWith("a huge burst") ? BIG : S2;
      const got = await scenario(steps, secret);
      expectNotDrawn(got.screen, secret);
      // a value is stored only when a hidden answer gave it whole (or nothing is): never with a line
      // break in it, never a SWID's line
      if (got.stored !== null) expect(got.stored).toMatch(/^[A-Za-z0-9%+/=._-]+$/);
    },
    60_000,
  );

  it("together: the burst's espn_s2 is dropped before the hidden question, said; the paste at it is stored", async () => {
    const got = await scenario([{ wait: ASK_SWID }, { write: cr(SWID) + cr(S2) }, { follow: 1 }]);
    expect(got.result.exitCode).toBe(0);
    expect(got.stored).toBe(S2);
    expect(got.screen).toContain(`${DISCARDED_NOTE}\n${ASK_S2}`);
    expect(got.screen).toContain(`espn_s2 ok (${String(S2.length)} chars)`);
    expectNotDrawn(got.screen);
  });

  it("typed ahead before the first question: dropped unshown, with the scrollback note; each question then takes its own paste", async () => {
    const got = await scenario([{ follow: 2 }], S2, cr(SWID) + cr(S2));
    expect(got.result.exitCode).toBe(0);
    expect(got.stored).toBe(S2);
    expect(got.screen).toContain(`${DISCARDED_NOTE}\n${TYPED_AHEAD_NOTE}\n${ASK_SWID}`);
    expectNotDrawn(got.screen);
  });

  it("a line break inside the pasted espn_s2: refused, nothing of it kept; the clean paste is stored", async () => {
    const got = await scenario(SCEN.split ?? []);
    expect(got.result.exitCode).toBe(0);
    expect(got.stored).toBe(S2);
    expect(got.screen).toContain(HIDDEN_REFUSED_NOTE);
    expectNotDrawn(got.screen);
  });

  it("separate pastes, one per question, are drawn (the SWID) and stored (both) with no note", async () => {
    const got = await scenario(SCEN.separate ?? []);
    expect(got.result.exitCode).toBe(0);
    expect(got.stored).toBe(S2);
    expect(got.screen).toContain(`${ASK_SWID}${SWID}\n`);
    expect(got.screen).not.toContain(DISCARDED_NOTE);
    expectNotDrawn(got.screen);
  });
});

// The ruling's property: a SWID (good, or refused for its braces) and espn_s2 pasted together — CR,
// LF or CR LF, with or without a blank line between, a line break inside espn_s2 or not — cut into
// random reads at random gaps (around the quiet and settle windows), then answered as a person would
// from what the screen shows: no part of espn_s2 ever reaches the screen.
describe("property (ruling R7-3): over random chunkings of SWID + espn_s2, no espn_s2 byte is ever written", () => {
  const GAPS = [0, 1, 5, 20, 60, 100, 140, 160, 200, 240, 260, 400, 800, 1500];
  it("never drawn, whatever the reads and the pauses", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(SWID, BAD_SWID, `  ${SWID}`),
        fc.constantFrom("\r", "\n", "\r\n"),
        fc.boolean(),
        fc.option(fc.integer({ min: 1, max: S2.length - 1 }), { nil: null }),
        fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 0, maxLength: 8 }),
        fc.array(fc.constantFrom(...GAPS), { minLength: 9, maxLength: 9 }),
        fc.constantFrom(0, FLUSH_QUIET_MS - 1, FLUSH_QUIET_MS + 50),
        async (swid, nl, blank, breakAt, cuts, gaps, before) => {
          const s2 = breakAt === null ? S2 : `${S2.slice(0, breakAt)}${nl}${S2.slice(breakAt)}`;
          const paste = `${swid}${nl}${blank ? nl : ""}${s2}${nl}`;
          const at = [...new Set(cuts.map((c) => c % paste.length))]
            .filter((c) => c > 0)
            .sort((a, b) => a - b);
          const reads: string[] = [];
          let from = 0;
          for (const c of [...at, paste.length]) {
            reads.push(paste.slice(from, c));
            from = c;
          }
          const steps: Step[] = [{ wait: ASK_SWID }, { sleep: before }];
          reads.forEach((r, i) => {
            steps.push({ write: r }, { sleep: gaps[i % gaps.length] ?? 0 });
          });
          steps.push({ follow: 4 });
          const got = await scenario(steps);
          // the run reached the hidden question (the property is never vacuous)
          expect(got.screen).toContain(ASK_S2);
          expectNotDrawn(got.screen);
        },
      ),
      { numRuns: 120 },
    );
  }, 600_000);
});
