// orphan-parent.cjs — the middle process of the orphan test (plan 10 A15a "orphan → exit within
// 10 s"; plan 05 §4.2): it starts `node <dist/cli.js> serve` with the test's extra pipe (fd 4) as
// the server's stdin and its own stdout/stderr — Node destroys a child's stdin pipe when the child
// exits, so fd 4, which the test keeps open, is what keeps EOF from being the cause of the exit —
// reports the server's pid over the IPC channel, and exits when the test says so.
const { spawn } = process.getBuiltinModule("node:child_process");
const entry = process.argv[2];
if (typeof entry !== "string") process.exit(64);
const child = spawn(process.execPath, [entry, "serve"], {
  stdio: [4, "inherit", "inherit"],
  env: process.env,
});
child.unref();
process.send?.({ child: child.pid });
process.on("message", (m) => {
  if (m === "exit") process.exit(0);
});
