// setup-parts.test.ts — the pieces under `eff setup`: the terminal prompt (queued lines, hidden
// input never echoed, timeout, closed input, y/N), the one-shot setup page (plan 03 §2.2: 127.0.0.1
// only, exact Host, Origin/Referer, token, 120 s timeout, SIGINT, the busy-port message with the
// lsof owner, no external resources in the form), and the keychain self-test's launchd plumbing
// (plan 03 §2.1 step 4: a digest report, never the value; the agent booted out afterwards).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { selftestDigest } from "../../src/auth/selftest.js";
import { createTerminalPrompt } from "../../src/cli/prompt.js";
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
