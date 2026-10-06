// orphan.test.ts — plan 10 A15a / plan 05 §4.2 "orphan → exit within 10 s" on the BUILT server over
// real processes: the test starts a middle process that starts `node dist/cli.js serve` on pipes the
// test holds, waits for serve.ready, then lets the middle process die. The server's stdin (the
// test's fd-4 pipe) is still open, so EOF cannot end it — only the reparenting watchdog can: the
// server must log serve.shutdown with reason "orphaned" and be gone within 10 s.
import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DIST_ENTRY, makeHome, requireDist, type E2eHome } from "./helpers.js";

const MIDDLE = path.join(import.meta.dirname, "fixtures", "orphan-parent.cjs");
const ORPHAN_DEADLINE_MS = 10_000;
const homes: E2eHome[] = [];
afterAll(() => {
  for (const h of homes) h.cleanup();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("A15a — an orphaned server exits on its own", { timeout: 60_000 }, () => {
  it("the parent dies with stdin still open: serve.shutdown reason orphaned, gone within 10 s", async () => {
    requireDist();
    const home = makeHome();
    homes.push(home);
    const middle = spawn(process.execPath, [MIDDLE, DIST_ENTRY], {
      env: home.env,
      stdio: ["pipe", "pipe", "pipe", "ipc", "pipe"],
    });
    const { stdin, stdout, stderr } = middle;
    if (stdin === null || stdout === null || stderr === null) throw new Error("no stdio pipes");
    const lines: string[] = [];
    let buf = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (d: string) => {
      buf += d;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      lines.push(...parts);
    });
    stdout.resume();
    const childPid = await new Promise<number>((resolve, reject) => {
      middle.once("message", (m: unknown) => {
        const pid = (m as { child?: unknown }).child;
        if (typeof pid === "number") resolve(pid);
        else reject(new Error("no child pid"));
      });
      middle.once("exit", () => {
        reject(new Error("the middle process exited early"));
      });
    });
    const event = (name: string): Record<string, unknown> | undefined =>
      lines
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return {};
          }
        })
        .find((r) => r.event === name);
    try {
      const readyBy = Date.now() + 10_000;
      while (event("serve.ready") === undefined && Date.now() < readyBy)
        await new Promise((r) => setTimeout(r, 25));
      expect(event("serve.ready"), lines.join("\n")).toBeDefined();
      const middleGone = new Promise((r) => middle.once("exit", r));
      middle.send("exit");
      await middleGone;
      const t0 = Date.now();
      while (alive(childPid) && Date.now() - t0 < ORPHAN_DEADLINE_MS + 2_000)
        await new Promise((r) => setTimeout(r, 50));
      const took = Date.now() - t0;
      expect(alive(childPid)).toBe(false);
      expect(took).toBeLessThan(ORPHAN_DEADLINE_MS);
      expect(event("serve.shutdown")).toMatchObject({ reason: "orphaned" });
    } finally {
      if (alive(childPid)) process.kill(childPid, "SIGKILL");
      stdin.end();
      middle.stdio[4]?.destroy();
    }
  });
});
