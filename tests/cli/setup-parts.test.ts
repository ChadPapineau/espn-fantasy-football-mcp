// setup-parts.test.ts — the pieces under `eff setup`: the terminal prompt (on a pipe: queued lines,
// hidden input never echoed, timeout, closed input, y/N; on a terminal: ruling R7-3's echo rule —
// tests/cli/setup-echo.test.ts holds every paste variant through setup itself), the one-shot setup
// page (plan 03 §2.2: 127.0.0.1 only, exact Host, Origin/Referer, token, 120 s timeout, SIGINT, the
// busy-port message with the lsof owner, no external resources in the form), and the keychain
// self-test's launchd plumbing (plan 03 §2.1 step 4: a digest report, never the value; the agent
// booted out afterwards).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEspnS2 } from "../../scripts/ci/secret-fixtures.mjs";
import { swidEchoShape } from "../../src/auth/format.js";
import { selftestDigest } from "../../src/auth/selftest.js";
import {
  DISCARDED_NOTE,
  FLUSH_MAX_MS,
  FLUSH_QUIET_MS,
  HIDDEN_EMPTY_NOTE,
  HIDDEN_REFUSED_NOTE,
  HIDDEN_SETTLE_MS,
  MAX_LINE_CHARS,
  NOT_SHOWN_NOTE,
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
import { FakeTty, Screen, shows } from "./fake-tty.js";
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

// Stage C finding setup-hidden-prompt-echo-burst, ruling R7-3: on a terminal the prompt keeps ECHO off
// for its whole life, draws only the characters a visible question receives (and, given a shape, only
// while the line keeps it), asks every question on a quiet input (whatever was read before is
// dropped unshown), and refuses a hidden answer with a line break in it. Fake timers: the quiet
// windows run on the test's clock; each `type` is one read, dispatched at once.
describe("terminal prompt on a TTY (ruling R7-3)", () => {
  beforeEach(() => {
    sb = sandbox();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const tick = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  const SWID = "{00000000-0000-4000-8000-000000000001}";
  const S2 = fakeEspnS2("cli-prompt-tty", 98);
  const open = (takeTerminalNow = false) => {
    const stdin = new FakeTty();
    const screen = new Screen();
    // Ctrl-C while no question waits raises SIGINT by default: recorded here instead
    const interrupts: number[] = [];
    const p = createTerminalPrompt({
      stdin,
      out: screen,
      takeTerminalNow,
      interrupt: () => interrupts.push(1),
    });
    return { stdin, screen, p, interrupts };
  };
  /** A hidden answer settles HIDDEN_SETTLE_MS after its line break. */
  const settled = async <T>(x: Promise<T>): Promise<T> => {
    await tick(HIDDEN_SETTLE_MS);
    return x;
  };

  it("echo is off at the terminal for the prompt's whole life: raw mode at once, given back on close", async () => {
    const { stdin, p } = open(true);
    expect(stdin.rawCalls).toEqual([true]);
    const a = p.ask("SWID: ", { hidden: false, timeoutMs: 60_000 });
    stdin.type(`${SWID}\r`);
    expect(await a).toEqual({ kind: "answer", value: SWID });
    // raw between questions too: no question waits, and the driver still echoes nothing
    expect(stdin.isRaw).toBe(true);
    p.close();
    expect(stdin.rawCalls).toEqual([true, false]);
  });

  it("a visible question draws the characters typed at it, one by one; Backspace and Ctrl-U erase what it drew", async () => {
    const { stdin, screen, p } = open();
    const a = p.ask("Q: ", { hidden: false, timeoutMs: 60_000 });
    expect(screen.text).toBe("Q: ");
    stdin.type("ab");
    stdin.type("c\x7f");
    expect(screen.text).toBe("Q: abc\b \b");
    stdin.type("\x15xy\x08z\r");
    expect(await a).toEqual({ kind: "answer", value: "xz" });
    expect(screen.text).toBe("Q: abc\b \b\b \b\b \bxy\b \bz\n");
    p.close();
  });

  it("a hidden answer is never drawn: the question, then its line end", async () => {
    const { stdin, screen, p } = open();
    const a = p.ask("espn_s2: ", { hidden: true, timeoutMs: 60_000 });
    stdin.type(S2.slice(0, 40));
    stdin.type(`${S2.slice(40)}\x7fz\r`);
    expect(await settled(a)).toEqual({ kind: "answer", value: `${S2.slice(0, -1)}z` });
    expect(screen.text).toBe("espn_s2: \n");
    p.close();
  });

  it("a shaped question draws only while the line keeps its shape: espn_s2 pasted at the SWID question is never drawn", async () => {
    const { stdin, screen, p } = open();
    const a = p.ask("SWID: ", { hidden: false, timeoutMs: 60_000, echo: swidEchoShape });
    stdin.type(`${S2}\r`);
    // the answer is the whole line (setup refuses it as no GUID); nothing of it was drawn, said
    expect(await a).toEqual({ kind: "answer", value: S2 });
    expect(shows(screen.text, S2, 4)).toBe(false);
    expect(screen.text).toBe(`SWID: \n${NOT_SHOWN_NOTE}\n`);
    // a SWID is drawn whole; a typo stops the drawing there, Backspace resumes it
    const b = p.ask("SWID: ", { hidden: false, timeoutMs: 60_000, echo: swidEchoShape });
    await tick(FLUSH_QUIET_MS);
    stdin.type(`  ${SWID.slice(0, 10)}Q`);
    expect(screen.text.endsWith(`SWID:   ${SWID.slice(0, 10)}`)).toBe(true);
    stdin.type(`\x7f${SWID.slice(10)}\r`);
    expect(await b).toEqual({ kind: "answer", value: `  ${SWID}` });
    expect(screen.text.endsWith(`SWID:   ${SWID}\n`)).toBe(true);
    // y/N draws a prefix of yes or no only
    const c = p.confirm("Go?");
    await tick(FLUSH_QUIET_MS);
    stdin.type("yes\r");
    expect(await c).toBe(true);
    expect(screen.text.endsWith("Go? [y/N] yes\n")).toBe(true);
    const d = p.confirm("Go?");
    await tick(FLUSH_QUIET_MS);
    stdin.type(`${S2}\r`);
    expect(await d).toBe(false);
    expect(shows(screen.text, S2, 4)).toBe(false);
    p.close();
  });

  // every key readline redraws, deletes, inserts, undoes or restores a line with: none inserts or
  // draws anything here (there is no line editor: no undo, no kill ring)
  const EDIT_KEYS: readonly (readonly [string, string])[] = [
    ["Delete", "\x1b[3~"],
    ["Ctrl-W", "\x17"],
    ["Meta-Backspace", "\x1b\x7f"],
    ["Ctrl-L", "\x0c"],
    ["Ctrl-K", "\x0b"],
    ["Ctrl-A", "\x01"],
    ["Left arrow", "\x1b[D"],
    ["an SS3 arrow", "\x1bOD"],
    ["Ctrl-_ (undo)", "\x1f"],
    ["Ctrl-^ (redo)", "\x1e"],
    ["Ctrl-Y (yank)", "\x19"],
    ["Meta-y (yank-pop)", "\x1by"],
    ["ESC ESC [ A", "\x1b\x1b[A"],
    ["a function key", "\x1b[15~"],
  ];
  it.each(EDIT_KEYS)(
    "%s at a visible question inserts nothing and draws nothing",
    async (_n, keys) => {
      const { stdin, screen, p } = open();
      const a = p.ask("SWID: ", { hidden: false, timeoutMs: 60_000, echo: swidEchoShape });
      stdin.type(keys);
      expect(screen.text).toBe("SWID: ");
      stdin.type(`${SWID}\r`);
      expect(await a).toEqual({ kind: "answer", value: SWID });
      p.close();
    },
  );

  it("a broken escape sequence ends at a control key, which counts: no sequence swallows Enter", async () => {
    const { stdin, screen, p } = open();
    const a = p.ask("Q: ", { hidden: false, timeoutMs: 60_000 });
    stdin.type("ab\x1b[12\rnext");
    expect(await a).toEqual({ kind: "answer", value: "ab" });
    expect(screen.text).toBe("Q: ab\n");
    p.close();
  });

  it("a hidden answer killed with Ctrl-U, then edit keys at a later visible question: nothing of it is drawn", async () => {
    const { stdin, screen, p } = open();
    const hidden = p.ask("espn_s2: ", { hidden: true, timeoutMs: 60_000 });
    stdin.type(`${S2}\x15${S2}\x01\x0b`);
    stdin.type(`\x15${S2}\r`);
    expect(await settled(hidden)).toEqual({ kind: "answer", value: S2 });
    const visible = p.ask("Continue? ", { hidden: false, timeoutMs: 60_000 });
    await tick(FLUSH_QUIET_MS);
    stdin.type("\x19\x1by\x1f\x1e\x0c\x1b[Dy\r");
    expect(await visible).toEqual({ kind: "answer", value: "y" });
    expect(shows(screen.text, S2, 4)).toBe(false);
    p.close();
  });

  it("keys typed ahead are discarded unshown at the first question and said (typed before it: the scrollback note)", async () => {
    const { stdin, screen, p } = open(true);
    stdin.type(`${SWID}\r${S2}\r`);
    const a = p.ask("SWID: ", { hidden: false, timeoutMs: 60_000, echo: swidEchoShape });
    // asked on a quiet input only
    expect(screen.text).toBe("");
    await tick(FLUSH_QUIET_MS);
    expect(screen.text).toBe(`${DISCARDED_NOTE}\n${TYPED_AHEAD_NOTE}\nSWID: `);
    stdin.type(`${SWID}\r`);
    expect(await a).toEqual({ kind: "answer", value: SWID });
    p.close();
    expect(shows(screen.text, S2, 4)).toBe(false);
  });

  it(`a question asked while keys still arrive waits ${String(FLUSH_QUIET_MS)} ms of quiet and drops them; ${String(FLUSH_MAX_MS)} ms at most`, async () => {
    const { stdin, screen, p } = open();
    const a = p.ask("Q1: ", { hidden: false, timeoutMs: 60_000 });
    stdin.type("one\rtwo");
    expect(await a).toEqual({ kind: "answer", value: "one" });
    const b = p.ask("Q2: ", { hidden: false, timeoutMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      await tick(FLUSH_QUIET_MS - 50);
      stdin.type("more");
      expect(screen.text).not.toContain("Q2: ");
    }
    await tick(FLUSH_QUIET_MS);
    expect(screen.text).toBe(`Q1: one\n${DISCARDED_NOTE}\nQ2: `);
    stdin.type("two\r");
    expect(await b).toEqual({ kind: "answer", value: "two" });
    // keys that never stop: the question is asked after FLUSH_MAX_MS regardless
    const c = p.ask("Q3: ", { hidden: false, timeoutMs: 60_000 });
    for (let t = 0; t < FLUSH_MAX_MS + 200; t += 100) {
      stdin.type("k");
      await tick(100);
    }
    expect(screen.text).toContain("Q3: ");
    stdin.type("\x15three\r");
    expect(await c).toEqual({ kind: "answer", value: "three" });
    p.close();
  });

  it("immediately before the hidden question every pending byte is dropped: SWID and espn_s2 pasted at the SWID question", async () => {
    const { stdin, screen, p } = open(true);
    const swid = p.ask("SWID: ", { hidden: false, timeoutMs: 60_000, echo: swidEchoShape });
    stdin.type(`${SWID}\r${S2}\r`);
    expect(await swid).toEqual({ kind: "answer", value: SWID });
    const hidden = p.ask("espn_s2: ", { hidden: true, timeoutMs: 60_000 });
    await tick(FLUSH_QUIET_MS);
    // espn_s2 from the burst was dropped (said); the hidden question takes a fresh paste only
    expect(screen.text).toBe(`SWID: ${SWID}\n${DISCARDED_NOTE}\nespn_s2: `);
    stdin.type(`${S2}\r`);
    expect(await settled(hidden)).toEqual({ kind: "answer", value: S2 });
    p.close();
    expect(shows(screen.text, S2, 4)).toBe(false);
  });

  it("a hidden answer with a line break in it is refused and asked again, nothing kept: the same read, a later read", async () => {
    const { stdin, screen, p } = open();
    const a = p.ask("espn_s2: ", { hidden: true, timeoutMs: 60_000 });
    // the line break inside the value, one read
    stdin.type(`${S2.slice(0, 50)}\r${S2.slice(50)}\r`);
    await tick(FLUSH_QUIET_MS);
    expect(screen.text).toBe(`espn_s2: \n${HIDDEN_REFUSED_NOTE}\nespn_s2: `);
    // the tail in a later read, within the settle window
    stdin.type(`${S2.slice(0, 50)}\r`);
    await tick(HIDDEN_SETTLE_MS - 50);
    stdin.type(`${S2.slice(50)}\r`);
    await tick(FLUSH_QUIET_MS);
    expect(screen.count(HIDDEN_REFUSED_NOTE)).toBe(2);
    // two answers in one read
    stdin.type(`${S2}\r${S2}\r`);
    await tick(FLUSH_QUIET_MS);
    expect(screen.count(HIDDEN_REFUSED_NOTE)).toBe(3);
    // blanks after the line break (CR LF, a second Enter) refuse nothing
    stdin.type(`${S2}\r\n`);
    stdin.type("\r");
    expect(await settled(a)).toEqual({ kind: "answer", value: S2 });
    p.close();
    expect(shows(screen.text, S2, 4)).toBe(false);
  });

  it("an empty hidden answer is refused and asked again (a late paste then meets the hidden question)", async () => {
    const { stdin, screen, p } = open();
    const a = p.ask("espn_s2: ", { hidden: true, timeoutMs: 60_000 });
    stdin.type("\r");
    await tick(HIDDEN_SETTLE_MS + FLUSH_QUIET_MS);
    expect(screen.text).toBe(`espn_s2: \n${HIDDEN_EMPTY_NOTE}\nespn_s2: `);
    stdin.type(`${S2}\r`);
    expect(await settled(a)).toEqual({ kind: "answer", value: S2 });
    p.close();
  });

  it("CR LF and LF end one line each, also when the LF of a CR LF pair arrives in a later read", async () => {
    const { stdin, p } = open();
    const a = p.ask("Q: ", { hidden: false, timeoutMs: 60_000 });
    stdin.type("one\r");
    stdin.type("\n");
    expect(await a).toEqual({ kind: "answer", value: "one" });
    await tick(FLUSH_QUIET_MS);
    const b = p.ask("Q: ", { hidden: false, timeoutMs: 60_000 });
    stdin.type("two\n");
    expect(await b).toEqual({ kind: "answer", value: "two" });
    await tick(FLUSH_QUIET_MS);
    const c = p.ask("Q: ", { hidden: false, timeoutMs: 60_000 });
    stdin.type("three\r\nlater");
    expect(await c).toEqual({ kind: "answer", value: "three" });
    p.close();
  });

  it("Ctrl-C at a visible or a hidden question, Ctrl-D on an empty line, and Ctrl-C between questions end the input", async () => {
    for (const [hidden, key] of [
      [false, "\x03"],
      [true, "\x03"],
      [false, "\x04"],
      [true, "\x04"],
    ] as const) {
      const { stdin, screen, p } = open();
      const a = p.ask("Q: ", { hidden, timeoutMs: 60_000 });
      stdin.type(key);
      expect(await a).toEqual({ kind: "closed" });
      expect(await p.ask("Q: ", { hidden: false, timeoutMs: 60_000 })).toEqual({ kind: "closed" });
      // the terminal stays raw, and what still arrives is read and dropped, until close
      expect(stdin.rawCalls).toEqual([true]);
      stdin.type(`${S2}\r`);
      expect(shows(screen.text, S2, 4)).toBe(false);
      p.close();
      expect(stdin.rawCalls).toEqual([true, false]);
    }
    // Ctrl-D on a line that holds keys is no end; Ctrl-C while no question waits is the SIGINT raw
    // mode kept the terminal driver from sending (tests/cli/setup-interrupt.test.ts): the terminal
    // is given back, then the interrupt is raised (Stage C finding setup-raw-mode-ctrl-c-ignored)
    const { stdin, p, interrupts } = open(true);
    const a = p.ask("Q: ", { hidden: false, timeoutMs: 60_000 });
    stdin.type("x\x04y\r");
    expect(await a).toEqual({ kind: "answer", value: "xy" });
    stdin.type("\x03");
    expect(interrupts).toEqual([1]);
    expect(stdin.rawCalls).toEqual([true, false]);
    expect(await p.ask("Q: ", { hidden: true, timeoutMs: 60_000 })).toEqual({ kind: "closed" });
    p.close();
    expect(stdin.rawCalls).toEqual([true, false]);
  });

  it("a timeout answers timeout and ends the line; keys typed after it are never drawn", async () => {
    const { stdin, screen, p } = open();
    const a = p.ask("Q: ", { hidden: false, timeoutMs: 1_000 });
    await tick(1_000);
    expect(await a).toEqual({ kind: "timeout" });
    stdin.type("after-timeout");
    expect(screen.text).toBe("Q: \n");
    const b = p.ask("H: ", { hidden: true, timeoutMs: 1_000 });
    await tick(FLUSH_QUIET_MS + 1_000);
    expect(await b).toEqual({ kind: "timeout" });
    expect(screen.text).not.toContain("after-timeout");
    p.close();
  });

  it("Ctrl-Z gives the terminal back before it stops and takes it again on SIGCONT; a discarded stop takes it at once", async () => {
    const rawWhileStopped: boolean[] = [];
    const { stdin, screen, p } = open();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      rawWhileStopped.push(stdin.isRaw);
      return true;
    });
    try {
      const a = p.ask("espn_s2: ", { hidden: true, timeoutMs: 60_000 });
      stdin.type(`\x1a${S2.slice(0, 30)}`);
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTSTP");
      expect(rawWhileStopped).toEqual([false]);
      // continued (kill returned): raw again at once, whether or not SIGCONT comes
      expect(stdin.rawCalls).toEqual([true, false, true]);
      // a second Ctrl-Z before any SIGCONT adds no second listener
      const pending = process.listenerCount("SIGCONT");
      stdin.type("\x1a");
      expect(process.listenerCount("SIGCONT")).toBe(pending);
      expect(stdin.rawCalls).toEqual([true, false, true, false, true]);
      process.emit("SIGCONT");
      expect(stdin.rawCalls).toEqual([true, false, true, false, true, true]);
      stdin.type(`${S2.slice(30)}\r`);
      expect(await settled(a)).toEqual({ kind: "answer", value: S2 });
      expect(shows(screen.text, S2, 4)).toBe(false);
      p.close();
      expect(stdin.isRaw).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  it("an input that ends (EOF) while a question waits answers closed; close gives the terminal back", async () => {
    const { stdin, p } = open();
    const a = p.ask("Q: ", { hidden: false, timeoutMs: 60_000 });
    stdin.eof();
    expect(await a).toEqual({ kind: "closed" });
    p.close();
    expect(stdin.rawCalls).toEqual([true, false]);
    // closing twice gives nothing back twice
    p.close();
    expect(stdin.rawCalls).toEqual([true, false]);
  });

  it("a prompt closed before it was ever opened never takes the terminal", async () => {
    const { stdin, p } = open();
    p.close();
    expect(await p.ask("Q: ", { hidden: false, timeoutMs: 60_000 })).toEqual({ kind: "closed" });
    expect(stdin.rawCalls).toEqual([]);
  });

  it("a multi-byte character split across reads is read whole; a line past MAX_LINE_CHARS is cut there", async () => {
    const { stdin, p } = open();
    const a = p.ask("Q: ", { hidden: false, timeoutMs: 60_000 });
    const e = Buffer.from("é", "utf8");
    stdin.emit("data", e.subarray(0, 1));
    stdin.emit("data", e.subarray(1));
    stdin.type("\r");
    expect(await a).toEqual({ kind: "answer", value: "é" });
    await tick(FLUSH_QUIET_MS);
    const b = p.ask("H: ", { hidden: true, timeoutMs: 60_000 });
    stdin.type(`${"x".repeat(MAX_LINE_CHARS + 10)}\r`);
    expect(await settled(b)).toEqual({ kind: "answer", value: "x".repeat(MAX_LINE_CHARS) });
    p.close();
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
    // never a login form (Stage C finding setup-page-login-form-password-manager): no password
    // field for a browser to pair with the SWID and offer to save in its synced password manager;
    // espn_s2 masked by CSS; every field opted out of autocomplete and the password managers
    expect(html).not.toMatch(/type\s*=\s*["']?password/i);
    expect(html).not.toMatch(/autocomplete="(?:username|current-password|new-password|email)"/);
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
    const visible = inputs.filter((i) => !i.includes('type="hidden"'));
    expect(visible).toHaveLength(2);
    for (const i of visible) {
      expect(i).toContain('type="text"');
      expect(i).toContain('autocomplete="off"');
      expect(i).toContain("data-1p-ignore");
      expect(i).toContain('data-lpignore="true"');
    }
    expect(visible.find((i) => i.includes('name="espn_s2"'))).toContain('class="masked"');
    expect(html).toContain(".masked{-webkit-text-security:disc");
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
