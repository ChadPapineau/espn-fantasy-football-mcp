// no-network.cjs — a preload for the CLI process tests (plan 05 §4.2): any fetch ends the process
// with exit 98 and a marker on stderr, so a test proves a subcommand made no network call.
globalThis.fetch = () => {
  process.stderr.write("EFF-PROCESS-TEST: a network call was attempted\n");
  process.exit(98);
};
