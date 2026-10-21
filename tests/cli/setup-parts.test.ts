// setup-parts.test.ts — the pieces under `eff setup`: the terminal prompt (queued lines, hidden
// input never echoed, timeout, closed input, y/N), the one-shot setup page (plan 03 §2.2: 127.0.0.1
// only, exact Host, Origin/Referer, token, 120 s timeout, SIGINT, the busy-port message with the
// lsof owner, no external resources in the form), and the keychain self-test's launchd plumbing
// (plan 03 §2.1 step 4: a digest report, never the value; the agent booted out afterwards).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEspnS2 } from "../../scripts/ci/secret-fixtures.mjs";
import { selftestDigest } from "../../src/auth/selftest.js";
import {
  BURST_QUIET_MS,
  DISCARDED_NOTE,
  MAX_QUEUED_LINES,
  PENDING_NOTE,
  TYPED_AHEAD_NOTE,
  createTerminalPrompt,
} from "../../src/cli/prompt.js";
import {
  candidatePorts,
  formHtml,
  portBusyMessage,
  portOwner,
  runSetupPage,
  sameOrigin,
} from "../../src/cli/setup-page.js";
import {
  createLaunchdReader,
  createSelftestRunner,
  parseReport,
  selftestPlist,
  selftestRead,
} from "../../src/cli/selftest-agent.js";
import {
  Capture,
  FakeKeyring,
  fakeExec,
  fakePackage,
  makeIo,
  sandbox,
  type Sandbox,
} from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

describe("terminal prompt", () => {
  it("queues lines that arrive early; a hidden answer is never written back", async () => {
    sb = sandbox();
    const stdin = new PassThrough();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    stdin.write("first\nsecret-value-xyz\n");
    expect(await p.ask("Q1: ", { hidden: false, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: "first",
    });
    expect(await p.ask("Q2: ", { hidden: true, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: "secret-value-xyz",
    });
    p.close();
    expect(out.text).toBe("Q1: Q2: \n");
  });
  it("waits for a late line, times out, and reports closed input; confirm reads y/yes only", async () => {
    sb = sandbox();
    const stdin = new PassThrough();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    const late = p.ask("Q: ", { hidden: true, timeoutMs: 1000 });
    setTimeout(() => stdin.write("later\n"), 20);
    expect(await late).toEqual({ kind: "answer", value: "later" });
    expect(await p.ask("T: ", { hidden: true, timeoutMs: 20 })).toEqual({ kind: "timeout" });
    stdin.write("YES\n");
    expect(await p.confirm("Go?")).toBe(true);
    stdin.write("nah\n");
    expect(await p.confirm("Go?")).toBe(false);
    const pending = p.ask("C: ", { hidden: false, timeoutMs: 1000 });
    stdin.end();
    expect(await pending).toEqual({ kind: "closed" });
    expect(await p.ask("again: ", { hidden: false, timeoutMs: 1000 })).toEqual({ kind: "closed" });
    expect(await p.confirm("Go?", 10)).toBe(false);
    p.close();
    expect(out.text).not.toContain("later");
  });
});

/** A stdin that says it is a terminal (readline then echoes through its output and sets raw mode). */
class FakeTty extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawCalls: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawCalls.push(mode);
    return this;
  }
}

/** Resolves once `out` has printed `text` (the question is on screen). */
function printed(out: Capture, text: string): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (out.text.includes(text)) {
        out.off("data", check);
        resolve();
      }
    };
    out.on("data", check);
    check();
  });
}

/** Lets the readline pass over every buffered chunk run (data events are async). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/** How many times `out` has printed `text`. */
const times = (out: Capture, text: string): number => out.text.split(text).length - 1;

/**
 * Resolves once `out` has printed `text` `n` times: a visible question asked while keys were still
 * arriving is printed only after the input has been quiet for BURST_QUIET_MS.
 */
function printedTimes(out: Capture, text: string, n: number): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (times(out, text) >= n) {
        out.off("data", check);
        resolve();
      }
    };
    out.on("data", check);
    check();
  });
}

const SWID = "{00000000-0000-4000-8000-000000000001}";
// a fake value in the cookie alphabet, generated (never a real cookie; never a literal the scanner sees)
const S2 = fakeEspnS2("cli-prompt-tty", 98);

/** True when any 8-character run of the hidden value reached the screen. */
function shows(out: Capture, value: string): boolean {
  for (let i = 0; i + 8 <= value.length; i++)
    if (out.text.includes(value.slice(i, i + 8))) return true;
  return false;
}

// Stage C finding setup-hidden-prompt-echo-burst: on a terminal the hidden value was drawn when it
// arrived in the same input chunk as an earlier line, after a line break inside it, or typed ahead.
describe("terminal prompt on a TTY: the hidden value is never drawn", () => {
  it("SWID and espn_s2 pasted in ONE burst at the SWID question: the SWID is drawn, espn_s2 is not", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    const swid = p.ask("SWID: ", { hidden: false, timeoutMs: 1000 });
    await printed(out, "SWID: ");
    stdin.write(`${SWID}\r${S2}\r`);
    expect(await swid).toEqual({ kind: "answer", value: SWID });
    await settle();
    expect(await p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: S2,
    });
    p.close();
    expect(out.text).toContain(SWID);
    expect(shows(out, S2)).toBe(false);
    // pasted at the question (the terminal was ours): nothing to clear
    expect(out.text).not.toContain(TYPED_AHEAD_NOTE);
    expect(stdin.rawCalls).toEqual([true, false]);
  });
  it("a line break inside the pasted espn_s2: neither part is drawn", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    const swid = p.ask("SWID: ", { hidden: false, timeoutMs: 1000 });
    await printed(out, "SWID: ");
    stdin.write(`${SWID}\r`);
    await swid;
    const hidden = p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 });
    await printed(out, "espn_s2: ");
    stdin.write(`${S2.slice(0, 50)}\r${S2.slice(50)}\r`);
    expect(await hidden).toEqual({ kind: "answer", value: S2.slice(0, 50) });
    await settle();
    // the tail waits in the queue, undrawn; a re-ask would take it, still undrawn
    expect(await p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: S2.slice(50),
    });
    p.close();
    expect(shows(out, S2)).toBe(false);
  });
  it("keys typed ahead while setup starts (takeTerminalNow): raw mode at once, nothing drawn, answers kept", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out, takeTerminalNow: true });
    // the terminal is taken before any question: the terminal driver no longer echoes
    expect(stdin.rawCalls).toEqual([true]);
    stdin.write(`${SWID}\r${S2}\r`);
    await settle();
    expect(out.text).toBe("");
    expect(await p.ask("SWID: ", { hidden: false, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: SWID,
    });
    expect(await p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: S2,
    });
    p.close();
    expect(shows(out, S2)).toBe(false);
    // each question's line is ended (the queued line's own line break was never drawn), and a
    // hidden answer typed before the first question says what the terminal driver may have shown
    expect(out.text).toBe(`SWID: \nespn_s2: \n${TYPED_AHEAD_NOTE}\n`);
    expect(stdin.isRaw).toBe(false);
  });
  it("type-ahead before the FIRST question without takeTerminalNow is not drawn either", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    stdin.write(`${SWID}\r${S2}\r`);
    expect(await p.ask("SWID: ", { hidden: false, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: SWID,
    });
    await settle();
    expect(await p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: S2,
    });
    p.close();
    expect(shows(out, S2)).toBe(false);
  });
  it(`at most ${String(MAX_QUEUED_LINES)} lines wait for a question; the rest are dropped, none drawn`, async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out, takeTerminalNow: true });
    stdin.write(
      Array.from({ length: MAX_QUEUED_LINES + 2 }, (_, i) => `line-${String(i)}\r`).join(""),
    );
    await settle();
    for (let i = 0; i < MAX_QUEUED_LINES; i++)
      expect(await p.ask("Q: ", { hidden: false, timeoutMs: 1000 })).toEqual({
        kind: "answer",
        value: `line-${String(i)}`,
      });
    expect(await p.ask("Q: ", { hidden: false, timeoutMs: 20 })).toEqual({ kind: "timeout" });
    p.close();
    expect(out.text).not.toContain("line-");
  });
  it("a visible answer typed after its question IS drawn; keys typed after it are not; a timeout mutes", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    const a = p.ask("Q: ", { hidden: false, timeoutMs: 1000 });
    await printed(out, "Q: ");
    stdin.write("visible-answer\r");
    expect(await a).toEqual({ kind: "answer", value: "visible-answer" });
    expect(out.text).toContain("visible-answer");
    // nothing waits now: typed keys stay undrawn until the next question
    stdin.write("typed-between");
    await settle();
    expect(out.text).not.toContain("typed-between");
    expect(await p.ask("T: ", { hidden: false, timeoutMs: 20 })).toEqual({ kind: "timeout" });
    stdin.write("after-timeout");
    await settle();
    expect(out.text).not.toContain("after-timeout");
    p.close();
  });
});

// The same finding, the variant the first fix left open: an editor that draws must never hold a key
// it did not draw. One shared readline kept espn_s2, read muted with no line break after it, in its
// line buffer (and its undo history and kill ring), and the next VISIBLE question drew it on its
// first edit key — Backspace drew all of it but the last character, Ctrl-L all of it, Ctrl-W its last
// segment, Ctrl-_ (undo) and Ctrl-Y (yank) brought it back.
describe("terminal prompt on a TTY: a visible question draws only the keys typed at it", () => {
  /** The SWID without its braces: refused (missing_braces), so setup asks for it again. */
  const BARE_SWID = SWID.slice(1, -1);

  // every key readline redraws, deletes, inserts or restores the line with
  const EDIT_KEYS: readonly (readonly [string, string])[] = [
    ["Backspace", "\x7f"],
    ["Ctrl-H", "\x08"],
    ["Delete", "\x1b[3~"],
    ["Ctrl-W", "\x17"],
    ["Meta-Backspace", "\x1b\x7f"],
    ["Ctrl-L", "\x0c"],
    ["Ctrl-K", "\x0b"],
    ["Ctrl-A then a character", "\x01x"],
    ["Left arrow then a character", "\x1b[Dx"],
    ["Ctrl-_ (undo)", "\x1f"],
    ["Ctrl-^ (redo)", "\x1e"],
    ["Ctrl-U then Ctrl-Y (kill, yank)", "\x15\x19"],
    ["Ctrl-Y (yank)", "\x19"],
  ];

  /**
   * Asks the visible question again and types `keys` (nothing of espn_s2 may be drawn by them), then
   * clears the line and types the real SWID; returns the answer.
   */
  async function reask(
    p: ReturnType<typeof createTerminalPrompt>,
    stdin: FakeTty,
    out: Capture,
    keys: string,
  ): Promise<unknown> {
    const n = times(out, "SWID: ");
    const again = p.ask("SWID: ", { hidden: false, timeoutMs: 1000 });
    // the question is drawn once the input is quiet; the owner types at it after that
    await printedTimes(out, "SWID: ", n + 1);
    stdin.write(keys);
    await settle();
    expect(shows(out, S2)).toBe(false);
    stdin.write(`\x15${SWID}\r`);
    return again;
  }

  it.each(EDIT_KEYS)(
    "a refused SWID pasted with espn_s2 and no final line break: %s at the re-asked SWID draws none of espn_s2",
    async (_name, keys) => {
      sb = sandbox();
      const stdin = new FakeTty();
      const out = new Capture();
      const p = createTerminalPrompt({ stdin, out });
      const first = p.ask("SWID: ", { hidden: false, timeoutMs: 1000 });
      await printed(out, "SWID: ");
      // a two-line selection usually ends without a line break
      stdin.write(`${BARE_SWID}\r${S2}`);
      expect(await first).toEqual({ kind: "answer", value: BARE_SWID });
      await settle();
      expect(await reask(p, stdin, out, keys)).toEqual({ kind: "answer", value: SWID });
      // the unfinished line was dropped, unshown, and the prompt said so
      expect(out.text).toContain(DISCARDED_NOTE);
      expect(out.text).not.toContain(TYPED_AHEAD_NOTE);
      // espn_s2 is pasted again at its own (hidden) question and taken whole, never joined to the
      // dropped copy
      const hidden = p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 });
      await printed(out, "espn_s2: ");
      stdin.write(`${S2}\r`);
      expect(await hidden).toEqual({ kind: "answer", value: S2 });
      p.close();
      expect(shows(out, S2)).toBe(false);
      expect(stdin.rawCalls).toEqual([true, false]);
    },
  );

  it.each(EDIT_KEYS)(
    "the same burst typed ahead before the first question: %s at the re-asked SWID draws none of espn_s2",
    async (_name, keys) => {
      sb = sandbox();
      const stdin = new FakeTty();
      const out = new Capture();
      const p = createTerminalPrompt({ stdin, out, takeTerminalNow: true });
      stdin.write(`${BARE_SWID}\r${S2}`);
      await settle();
      expect(await p.ask("SWID: ", { hidden: false, timeoutMs: 1000 })).toEqual({
        kind: "answer",
        value: BARE_SWID,
      });
      expect(await reask(p, stdin, out, keys)).toEqual({ kind: "answer", value: SWID });
      // dropped unshown; typed before the first question, so the terminal driver may have shown it
      expect(out.text).toContain(`${DISCARDED_NOTE}\n${TYPED_AHEAD_NOTE}\nSWID: `);
      p.close();
      expect(shows(out, S2)).toBe(false);
    },
  );

  // Round 2 (the verifier): a refused SWID and espn_s2 from one paste, espn_s2 in a LATER read (a
  // second write, or the kernel splitting one write past 1 KB) — the re-asked visible question,
  // opened within microtasks of the refusal, drew all of it
  it.each([0, 2, 5, 20, 100])(
    "espn_s2 arriving %i ms after a re-asked visible question opens is never drawn, then dropped and said",
    async (gap) => {
      sb = sandbox();
      const stdin = new FakeTty();
      const out = new Capture();
      const p = createTerminalPrompt({ stdin, out });
      const first = p.ask("SWID: ", { hidden: false, timeoutMs: 1000 });
      await printed(out, "SWID: ");
      stdin.write(`${BARE_SWID}\r`);
      expect(await first).toEqual({ kind: "answer", value: BARE_SWID });
      // refused: asked again at once, as setup does
      const again = p.ask("SWID: ", { hidden: false, timeoutMs: 2000 });
      await new Promise((r) => setTimeout(r, gap));
      stdin.write(`${S2}\r`);
      await printedTimes(out, "SWID: ", 2);
      // drawn only now, after BURST_QUIET_MS of quiet: espn_s2 never reached it
      expect(shows(out, S2)).toBe(false);
      expect(out.text).toContain(`${DISCARDED_NOTE}\nSWID: `);
      stdin.write(`${SWID}\r`);
      expect(await again).toEqual({ kind: "answer", value: SWID });
      expect(out.text).toContain(SWID);
      // the dropped line answers nothing later
      expect(await p.ask("espn_s2: ", { hidden: true, timeoutMs: 50 })).toEqual({
        kind: "timeout",
      });
      p.close();
      expect(shows(out, S2)).toBe(false);
    },
  );

  it("one paste past 1 KB split by the kernel into two reads: the tail never reaches a visible question", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    const long = fakeEspnS2("cli-prompt-split", 2000);
    const first = p.ask("SWID: ", { hidden: false, timeoutMs: 1000 });
    await printed(out, "SWID: ");
    const burst = `${BARE_SWID}\r${long}\r`;
    stdin.write(burst.slice(0, 1024));
    expect(await first).toEqual({ kind: "answer", value: BARE_SWID });
    const again = p.ask("SWID: ", { hidden: false, timeoutMs: 2000 });
    stdin.write(burst.slice(1024));
    await printedTimes(out, "SWID: ", 2);
    expect(shows(out, long)).toBe(false);
    stdin.write(`${SWID}\r`);
    expect(await again).toEqual({ kind: "answer", value: SWID });
    p.close();
    expect(shows(out, long)).toBe(false);
  });

  it(`a visible question with no keys arriving draws at once; one asked mid-burst waits ${String(BURST_QUIET_MS)} ms of quiet`, async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    const a = p.ask("Q1: ", { hidden: false, timeoutMs: 1000 });
    // no key read yet: drawn now
    expect(out.text).toBe("Q1: ");
    stdin.write("one\r");
    expect(await a).toEqual({ kind: "answer", value: "one" });
    const t0 = Date.now();
    const b = p.ask("Q2: ", { hidden: false, timeoutMs: 1000 });
    expect(out.text).not.toContain("Q2: ");
    await printedTimes(out, "Q2: ", 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(BURST_QUIET_MS - 5);
    stdin.write("two\r");
    expect(await b).toEqual({ kind: "answer", value: "two" });
    p.close();
  });

  it("espn_s2 killed (Ctrl-U) while no question waits is never yanked back at a visible question", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out, takeTerminalNow: true });
    // pasted too early, then cleared: the line is empty, the kill ring of a shared editor is not
    stdin.write(`${S2}\x15`);
    await settle();
    const a = p.ask("SWID: ", { hidden: false, timeoutMs: 1000 });
    await printed(out, "SWID: ");
    stdin.write("\x19\x1f\x0c");
    await settle();
    stdin.write(`\x15${SWID}\r`);
    expect(await a).toEqual({ kind: "answer", value: SWID });
    p.close();
    expect(shows(out, S2)).toBe(false);
  });

  it("a hidden answer edited with kill keys is never yanked or undone back at a later visible question", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    const hidden = p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 });
    await printed(out, "espn_s2: ");
    // pasted, cleared with Ctrl-U (the kill ring now holds it), pasted again, killed again from the
    // start of the line (Ctrl-A, Ctrl-K), pasted a third time
    stdin.write(`${S2}\x15${S2}\x01\x0b${S2}\r`);
    expect(await hidden).toEqual({ kind: "answer", value: S2 });
    const visible = p.ask("Continue? ", { hidden: false, timeoutMs: 1000 });
    await printed(out, "Continue? ");
    // yank, yank-pop (Meta-y), undo, redo, redraw
    stdin.write("\x19\x1by\x1by\x1f\x1e\x0c");
    await settle();
    stdin.write("\x15y\r");
    expect(await visible).toEqual({ kind: "answer", value: "y" });
    p.close();
    expect(shows(out, S2)).toBe(false);
  });

  it("a hidden answer begun before the first question and finished after it says so (TYPED_AHEAD_NOTE)", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out, takeTerminalNow: true });
    // the SWID line and the first part of espn_s2 reach the terminal before the first question
    stdin.write(`${SWID}\r${S2.slice(0, 40)}`);
    await settle();
    expect(await p.ask("SWID: ", { hidden: false, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: SWID,
    });
    // a hidden question takes the unfinished line, and says it is waiting (nothing was dropped)
    expect(out.text).not.toContain(DISCARDED_NOTE);
    const hidden = p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 });
    await printed(out, "espn_s2: ");
    stdin.write(`${S2.slice(40)}\r`);
    expect(await hidden).toEqual({ kind: "answer", value: S2 });
    p.close();
    expect(out.text).toBe(`SWID: \n${PENDING_NOTE}\nespn_s2: \n${TYPED_AHEAD_NOTE}\n`);
    expect(shows(out, S2)).toBe(false);
  });

  it("two lines pasted at the SWID question with no final line break: espn_s2 waits for Enter, and says so", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    const swid = p.ask("SWID: ", { hidden: false, timeoutMs: 1000 });
    await printed(out, "SWID: ");
    stdin.write(`${SWID}\r${S2}`);
    expect(await swid).toEqual({ kind: "answer", value: SWID });
    await settle();
    const hidden = p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 });
    // pasting it again would double the value: the prompt says Enter uses what waits
    expect(out.text).toContain(`${PENDING_NOTE}\nespn_s2: `);
    stdin.write("\r");
    expect(await hidden).toEqual({ kind: "answer", value: S2 });
    // or Ctrl-U clears it, unshown, and the value is pasted again
    const n = times(out, "SWID: ");
    const again = p.ask("SWID: ", { hidden: false, timeoutMs: 1000 });
    await printedTimes(out, "SWID: ", n + 1);
    stdin.write(`${SWID}\r${S2}`);
    expect(await again).toEqual({ kind: "answer", value: SWID });
    await settle();
    const cleared = p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 });
    stdin.write(`\x15${S2}\r`);
    expect(await cleared).toEqual({ kind: "answer", value: S2 });
    p.close();
    expect(out.text).not.toContain(TYPED_AHEAD_NOTE);
    expect(shows(out, S2)).toBe(false);
  });

  it("a line typed in full after the first question carries no note", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out, takeTerminalNow: true });
    const hidden = p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 });
    await printed(out, "espn_s2: ");
    stdin.write(S2.slice(0, 40));
    await settle();
    stdin.write(`${S2.slice(40)}\r`);
    expect(await hidden).toEqual({ kind: "answer", value: S2 });
    p.close();
    expect(out.text).toBe("espn_s2: \n");
  });

  it("CR LF and LF line breaks end one line each, also when the LF of a CR LF pair arrives apart", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    const a = p.ask("SWID: ", { hidden: false, timeoutMs: 1000 });
    await printed(out, "SWID: ");
    stdin.write(`${SWID}\r`);
    stdin.write(`\n`);
    expect(await a).toEqual({ kind: "answer", value: SWID });
    await settle();
    // the LF was the second half of the line break, not an empty answer
    expect(await p.ask("espn_s2: ", { hidden: true, timeoutMs: 30 })).toEqual({ kind: "timeout" });
    const n = times(out, "SWID: ");
    const b = p.ask("SWID: ", { hidden: false, timeoutMs: 1000 });
    await printedTimes(out, "SWID: ", n + 1);
    stdin.write(`${SWID}\r\n${S2}\r\nnext\n`);
    expect(await b).toEqual({ kind: "answer", value: SWID });
    await settle();
    expect(await p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: S2,
    });
    expect(await p.ask("Q: ", { hidden: false, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: "next",
    });
    p.close();
    expect(shows(out, S2)).toBe(false);
  });

  it("a visible question edits its own line and keeps its label on a redraw", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    const a = p.ask("Q: ", { hidden: false, timeoutMs: 1000 });
    await printed(out, "Q: ");
    stdin.write("abc\x7f");
    await settle();
    // the redraw (cursor to column 1, erase down) writes the question again, then the line
    expect(out.text.slice(out.text.lastIndexOf("\x1b[0J") + 4)).toMatch(/^Q: ab/);
    stdin.write("d\r");
    expect(await a).toEqual({ kind: "answer", value: "abd" });
    p.close();
  });

  it("Ctrl-C at a visible or a hidden question, and Ctrl-D on an empty line, end the input", async () => {
    for (const [hidden, key] of [
      [false, "\x03"],
      [true, "\x03"],
      [false, "\x04"],
      [true, "\x04"],
    ] as const) {
      sb = sandbox();
      const stdin = new FakeTty();
      const out = new Capture();
      const p = createTerminalPrompt({ stdin, out });
      const a = p.ask("Q: ", { hidden, timeoutMs: 1000 });
      await printed(out, "Q: ");
      stdin.write(key);
      expect(await a).toEqual({ kind: "closed" });
      expect(await p.ask("Q: ", { hidden: false, timeoutMs: 1000 })).toEqual({ kind: "closed" });
      expect(stdin.rawCalls).toEqual([true, false]);
      p.close();
      expect(stdin.rawCalls).toEqual([true, false]);
      sb.cleanup();
    }
    sb = sandbox();
  });

  it("Ctrl-C typed while no question waits ends the input too; lines read before it still answer", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out, takeTerminalNow: true });
    stdin.write(`${SWID}\r\x03`);
    await settle();
    expect(stdin.rawCalls).toEqual([true, false]);
    expect(await p.ask("SWID: ", { hidden: false, timeoutMs: 1000 })).toEqual({
      kind: "answer",
      value: SWID,
    });
    expect(await p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 })).toEqual({
      kind: "closed",
    });
    p.close();
  });

  it("Ctrl-Z gives the terminal back before it suspends and takes it again on SIGCONT", async () => {
    sb = sandbox();
    // the stop, simulated: the terminal is cooked while the process is stopped
    const stdin = new FakeTty();
    const rawWhileStopped: boolean[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      rawWhileStopped.push(stdin.isRaw);
      return true;
    });
    try {
      const out = new Capture();
      const p = createTerminalPrompt({ stdin, out });
      const a = p.ask("Q: ", { hidden: true, timeoutMs: 1000 });
      await printed(out, "Q: ");
      stdin.write("\x1a");
      await settle();
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTSTP");
      expect(rawWhileStopped).toEqual([false]);
      // continued (kill returns): raw again at once; SIGCONT takes it again too
      expect(stdin.rawCalls).toEqual([true, false, true]);
      process.emit("SIGCONT");
      expect(stdin.rawCalls).toEqual([true, false, true, true]);
      stdin.write("after\r");
      expect(await a).toEqual({ kind: "answer", value: "after" });
      p.close();
      expect(stdin.rawCalls).toEqual([true, false, true, true, false]);
    } finally {
      kill.mockRestore();
    }
  });

  // Round 2 (the verifier): Ctrl-Z when the stop is discarded — an orphaned process group (eff as
  // the session leader, `exec eff setup`) or SIGTSTP ignored: kill returns at once, no SIGCONT ever
  // comes, and the terminal stayed cooked with ECHO on while the hidden question waited, so the
  // rest of a paste was echoed by the terminal driver
  it("Ctrl-Z whose stop is discarded: raw mode is back before the next key, nothing is echoed", async () => {
    sb = sandbox();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const stdin = new FakeTty();
      const out = new Capture();
      const p = createTerminalPrompt({ stdin, out });
      const a = p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 });
      await printed(out, "espn_s2: ");
      stdin.write(`\x1a${S2.slice(0, 30)}`);
      await settle();
      // no SIGCONT: the terminal is raw again regardless (the driver does not echo)
      expect(stdin.isRaw).toBe(true);
      expect(stdin.rawCalls).toEqual([true, false, true]);
      stdin.write(`${S2.slice(30)}\r`);
      expect(await a).toEqual({ kind: "answer", value: S2 });
      // a second Ctrl-Z adds no second SIGCONT listener
      const before = process.listenerCount("SIGCONT");
      const b = p.ask("espn_s2: ", { hidden: true, timeoutMs: 1000 });
      stdin.write("\x1a");
      await settle();
      expect(process.listenerCount("SIGCONT")).toBe(before);
      stdin.write("x\r");
      await b;
      p.close();
      expect(shows(out, S2)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  it("an input that ends (EOF) while a question waits answers closed and gives the terminal back", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    const a = p.ask("Q: ", { hidden: false, timeoutMs: 1000 });
    await printed(out, "Q: ");
    stdin.end();
    expect(await a).toEqual({ kind: "closed" });
    expect(stdin.rawCalls).toEqual([true, false]);
    p.close();
  });

  it("a prompt closed before it was ever opened never takes the terminal", async () => {
    sb = sandbox();
    const stdin = new FakeTty();
    const out = new Capture();
    const p = createTerminalPrompt({ stdin, out });
    p.close();
    expect(await p.ask("Q: ", { hidden: false, timeoutMs: 1000 })).toEqual({ kind: "closed" });
    expect(stdin.rawCalls).toEqual([]);
  });
});

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen({ host: "127.0.0.1", port }, () => {
      resolve(s);
    });
  });
}

async function freePort(): Promise<number> {
  const s = await listenOn(0);
  const a = s.address();
  await new Promise<void>((r) =>
    s.close(() => {
      r();
    }),
  );
  return typeof a === "object" && a !== null ? a.port : 0;
}

describe("setup page", () => {
  it("ports, messages, origin rule, form (no external resource, token in path and field)", async () => {
    sb = sandbox();
    expect(candidatePorts(null)[0]).toBe(8790);
    expect(candidatePorts(null)).toHaveLength(10);
    expect(candidatePorts(9001)).toEqual([9001]);
    expect(portBusyMessage(9001, "nc (pid 7)")).toBe(
      "Port 9001 is in use by nc (pid 7). Set EFF_SETUP_PORT to a free port or run 'eff setup' (no page needed).",
    );
    expect(portBusyMessage(null, null)).toContain("8790-8799 are all in use");
    expect(sameOrigin({ headers: { origin: "http://127.0.0.1:1" } }, "http://127.0.0.1:1")).toBe(
      true,
    );
    expect(
      sameOrigin({ headers: { referer: "http://127.0.0.1:1/setup/x" } }, "http://127.0.0.1:1"),
    ).toBe(true);
    expect(sameOrigin({ headers: {} }, "http://127.0.0.1:1")).toBe(false);
    expect(sameOrigin({ headers: { origin: "null" } }, "http://127.0.0.1:1")).toBe(false);
    const html = formHtml("abc", 'x"<y>');
    expect(html).toContain('action="/setup/abc"');
    expect(html).toContain('name="token" value="abc"');
    expect(html).toContain("x&quot;&lt;y&gt;");
    expect(html).not.toMatch(/\b(?:src|href)=/);
    const { exec } = fakeExec(() => ({ stdout: "COMMAND PID USER\nnc\u001b 77 me IPv4\n" }));
    expect(await portOwner(exec, 9)).toBe("nc? (pid 77)");
    expect(await portOwner(fakeExec(() => ({ code: 1 })).exec, 9)).toBeNull();
    expect(await portOwner(fakeExec(() => ({ stdout: "header only" })).exec, 9)).toBeNull();
  });
  it("an explicit busy port is refused with its owner (no fallback); timeout; interrupt", async () => {
    sb = sandbox();
    const busy = await listenOn(0);
    const a = busy.address();
    const port = typeof a === "object" && a !== null ? a.port : 0;
    try {
      const r = await runSetupPage({
        explicitPort: port,
        exec: fakeExec(() => ({ stdout: "COMMAND PID\nnode 12 x\n" })).exec,
        out: () => undefined,
        signal: new AbortController().signal,
      });
      expect(r).toEqual({ kind: "port_busy", port, owner: "node (pid 12)" });
    } finally {
      busy.close();
    }
    const p2 = await freePort();
    const lines: string[] = [];
    expect(
      await runSetupPage({
        explicitPort: p2,
        exec: fakeExec().exec,
        out: (l) => lines.push(l),
        signal: new AbortController().signal,
        timeoutMs: 30,
      }),
    ).toEqual({ kind: "timeout" });
    expect(lines[0]).toMatch(
      /^Open http:\/\/127\.0\.0\.1:\d+\/setup\/[0-9a-f]{64} in your browser/,
    );
    const ctl = new AbortController();
    const p3 = await freePort();
    const run = runSetupPage({
      explicitPort: p3,
      exec: fakeExec().exec,
      out: () => undefined,
      signal: ctl.signal,
      onListening: () => {
        ctl.abort();
      },
    });
    expect(await run).toEqual({ kind: "interrupted" });
    // the port is free right after
    const again = await listenOn(p3);
    again.close();
    const pre = new AbortController();
    pre.abort();
    expect(
      await runSetupPage({
        explicitPort: await freePort(),
        exec: fakeExec().exec,
        out: () => undefined,
        signal: pre.signal,
      }),
    ).toEqual({ kind: "interrupted" });
  });
  it("the default port busy: the page binds the next port of the 8790–8799 range and prints it", async () => {
    sb = sandbox();
    let held: Server | null = null;
    try {
      held = await listenOn(8790);
    } catch {
      held = null; // something else already holds 8790: the fallback is exercised all the same
    }
    const ctl = new AbortController();
    let bound = 0;
    const run = runSetupPage({
      explicitPort: null,
      exec: fakeExec().exec,
      out: () => undefined,
      signal: ctl.signal,
      onListening: (_u, port) => {
        bound = port;
        ctl.abort();
      },
    });
    const r = await run;
    held?.close();
    if (r.kind === "port_busy") return; // the whole range is taken on this machine
    expect(r).toEqual({ kind: "interrupted" });
    expect(bound).toBeGreaterThan(8790);
    expect(bound).toBeLessThanOrEqual(8799);
  });
  it("GET serves the form only with the exact Host and token path; other paths are 404", async () => {
    sb = sandbox();
    const port = await freePort();
    const ctl = new AbortController();
    let url = "";
    const run = runSetupPage({
      explicitPort: port,
      exec: fakeExec().exec,
      out: () => undefined,
      signal: ctl.signal,
      onListening: (u) => {
        url = u;
      },
    });
    while (url === "") await new Promise((r) => setTimeout(r, 5));
    // loopback only: the page under test, on 127.0.0.1
    const get = globalThis.fetch as (u: string, i?: RequestInit) => Promise<Response>;
    const ok = await get(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.text()).toContain("<form");
    expect((await get(`http://127.0.0.1:${String(port)}/setup/nope`)).status).toBe(404);
    expect((await get(`http://127.0.0.1:${String(port)}/`)).status).toBe(404);
    const big = await get(url, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${String(port)}` },
      body: "x".repeat(20_000),
    }).catch(() => null);
    expect(big === null || big.status === 404).toBe(true);
    const put = await get(url, {
      method: "PUT",
      headers: { origin: `http://127.0.0.1:${String(port)}` },
    });
    expect(put.status).toBe(404);
    ctl.abort();
    expect(await run).toEqual({ kind: "interrupted" });
  });
});

describe("keychain self-test plumbing", () => {
  it("parseReport accepts only well-formed reports; selftestPlist is absolute and RunAtLoad", () => {
    sb = sandbox();
    const d = selftestDigest("v");
    expect(parseReport(JSON.stringify({ status: "read", digest: d }))).toEqual({
      status: "read",
      digest: d,
    });
    expect(parseReport(JSON.stringify({ status: "missing" }))).toEqual({ status: "missing" });
    expect(parseReport(JSON.stringify({ status: "error", code: "read_failed" }))).toEqual({
      status: "error",
      code: "read_failed",
    });
    for (const bad of [
      "{",
      "null",
      JSON.stringify({ status: "read", digest: "short" }),
      JSON.stringify({ status: "error", code: "has space" }),
      JSON.stringify({ status: "x" }),
    ])
      expect(parseReport(bad).status).toBe("error");
    const xml = selftestPlist({
      label: "l",
      node: "/n",
      entry: "/e/dist/cli.js",
      service: "eff-test-a-selftest",
      report: "/r/report.json",
    });
    expect(xml).toContain("<string>selftest-read</string>");
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(() =>
      selftestPlist({ label: "l", node: "n", entry: "/e", service: "s", report: "/r" }),
    ).toThrow(/absolute/);
  });
  it("off macOS, without a uid or a build, the reader reports an error (the file store is chosen)", async () => {
    sb = sandbox();
    const signal = new AbortController().signal;
    const t = { service: "eff-test-a-selftest", account: "selftest" };
    expect(await createLaunchdReader(makeIo(sb), sb.cacheDir)(t, signal)).toEqual({
      status: "error",
      code: "unsupported_platform",
    });
    expect(
      await createLaunchdReader(makeIo(sb, { platform: "darwin", uid: null }), sb.cacheDir)(
        t,
        signal,
      ),
    ).toEqual({ status: "error", code: "no_uid" });
    expect(
      await createLaunchdReader(
        makeIo(sb, { platform: "darwin", packageRoot: fakePackage(sb, { built: false }) }),
        sb.cacheDir,
      )(t, signal),
    ).toEqual({ status: "error", code: "not_built" });
  });
  it("on macOS: bootstraps the agent, reads its digest report, boots it out, removes the temp dir", async () => {
    sb = sandbox();
    const root = fakePackage(sb);
    const keyring = new FakeKeyring();
    let report = "";
    const { exec, calls } = fakeExec(async (c) => {
      if (c.args[0] === "bootstrap") {
        // the "agent": read the plist's --report path and run the real agent side
        const plist = readFileSync(c.args[2]!, "utf8");
        const m = /<string>([^<]+report\.json)<\/string>/.exec(plist);
        report = m?.[1] ?? "";
        const agentIo = makeIo(sb, { keyring });
        await selftestRead(agentIo, { service: "eff-test-a-selftest", report });
      }
      return {};
    });
    const io = makeIo(sb, { platform: "darwin", packageRoot: root, exec, keyring });
    const run = createSelftestRunner(io, sb.cacheDir);
    const r = await run("eff-test-a");
    expect(r.outcome).toBe("ok");
    expect(r.cleanup).toBe("deleted");
    expect(calls.map((c) => c.args[0])).toEqual(["bootstrap", "bootout"]);
    expect(existsSync(path.dirname(report))).toBe(false);
    expect(keyring.calls.some((c) => c.service === "eff-test-a-selftest")).toBe(true);
  });
  it("a bootstrap failure and a silent agent (timeout) are errors; a keyring that cannot load is write_failed", async () => {
    sb = sandbox();
    const root = fakePackage(sb);
    const t = { service: "eff-test-b-selftest", account: "selftest" };
    const failing = makeIo(sb, {
      platform: "darwin",
      packageRoot: root,
      exec: fakeExec(() => ({ code: 5 })).exec,
    });
    expect(
      await createLaunchdReader(failing, sb.cacheDir)(t, new AbortController().signal),
    ).toEqual({ status: "error", code: "bootstrap_failed" });
    const ctl = new AbortController();
    setTimeout(() => {
      ctl.abort();
    }, 50);
    const silent = makeIo(sb, { platform: "darwin", packageRoot: root, exec: fakeExec().exec });
    expect(await createLaunchdReader(silent, sb.cacheDir)(t, ctl.signal)).toEqual({
      status: "error",
      code: "timeout",
    });
    const noKeyring = makeIo(sb, { loadKeyring: () => Promise.reject(new Error("no addon")) });
    expect((await createSelftestRunner(noKeyring, sb.cacheDir)("eff-test-b")).reason).toBe(
      "write_failed",
    );
  });
  it("selftest-read writes a 0600 digest report (never the value) and refuses a missing flag or a relative path", async () => {
    sb = sandbox();
    const keyring = new FakeKeyring();
    keyring.plant("eff-test-c-selftest", "selftest", "the-throwaway");
    const dir = path.join(sb.dir, "rep");
    mkdirSync(dir, { mode: 0o700 });
    const io = makeIo(sb, { keyring });
    const report = path.join(dir, "report.json");
    expect(await selftestRead(io, { service: "eff-test-c-selftest", report })).toBe(0);
    const text = readFileSync(report, "utf8");
    expect(text).not.toContain("the-throwaway");
    expect(JSON.parse(text)).toEqual({ status: "read", digest: selftestDigest("the-throwaway") });
    expect(statSync(report).mode & 0o777).toBe(0o600);
    await expect(selftestRead(io, { service: undefined, report })).rejects.toThrow(
      /needs --service/,
    );
    await expect(selftestRead(io, { service: "x", report: "rel/r.json" })).rejects.toThrow(
      /absolute/,
    );
    // a real service name is refused by the agent side (only <allowed>-selftest/selftest)
    const r2 = path.join(dir, "r2.json");
    expect(await selftestRead(io, { service: "espn-fantasy-football-mcp", report: r2 })).toBe(0);
    expect(JSON.parse(readFileSync(r2, "utf8"))).toEqual({
      status: "error",
      code: "invalid_target",
    });
    const r3 = path.join(dir, "r3.json");
    expect(
      await selftestRead(makeIo(sb, { loadKeyring: () => Promise.reject(new Error("x")) }), {
        service: "eff-test-c-selftest",
        report: r3,
      }),
    ).toBe(0);
    expect(JSON.parse(readFileSync(r3, "utf8"))).toEqual({ status: "error", code: "unavailable" });
    writeFileSync(path.join(dir, "x"), "");
  });
});
