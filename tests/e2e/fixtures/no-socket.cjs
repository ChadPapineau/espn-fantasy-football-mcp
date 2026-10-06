// no-socket.cjs — the end-to-end preload (plan 05 §4.2; plan 10 A15a "serve opens no socket"): any
// fetch, outgoing TCP/TLS connection, HTTP(S) request or DNS lookup ends the process with exit 98 and
// a marker on stderr, so a test proves the built server made no network call at all in fixture mode.
const deny = (what) => () => {
  process.stderr.write(`EFF-E2E: a network call was attempted (${what})\n`);
  process.exit(98);
};
globalThis.fetch = deny("fetch");
const net = process.getBuiltinModule("node:net");
net.Socket.prototype.connect = deny("net.Socket.connect");
net.connect = deny("net.connect");
net.createConnection = deny("net.createConnection");
process.getBuiltinModule("node:tls").connect = deny("tls.connect");
process.getBuiltinModule("node:http").request = deny("http.request");
process.getBuiltinModule("node:https").request = deny("https.request");
process.getBuiltinModule("node:dns").lookup = deny("dns.lookup");
