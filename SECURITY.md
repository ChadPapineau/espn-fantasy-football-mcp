# Security policy

This repository holds the **plan** for a local, read-only-by-default MCP server for ESPN Fantasy
Football. **No server code exists yet** — the build starts only after the owner approves the plan
(see [README → Status](README.md#status)). This policy covers what is here today (documents and
configuration examples) and the code, CLI, Skills and CI workflows as they land.

> **Not affiliated with ESPN.** This project is not affiliated with, endorsed by, or supported by
> ESPN or The Walt Disney Company. It is planned to use ESPN's unofficial, undocumented fantasy
> API with the user's own session cookies. Read the
> [terms-of-use and account-risk disclosure](README.md#terms-of-use-and-account-risk) before you
> decide to use it.

## Reporting a vulnerability

**Do not open a public issue for a security problem, and never paste a cookie, a league id or
anyone's name into an issue, a pull request or a discussion.**

Use **GitHub private vulnerability reporting** for this repository: open the **Security** tab and
choose **Report a vulnerability**. The report reaches the maintainer only and becomes a private
security advisory in which the fix and the disclosure are coordinated.

> **Maintainer step (pending).** Private vulnerability reporting is a repository setting the
> maintainer switches on (*Settings → Code security → Private vulnerability reporting*); as of
> 2026-09-30 it is **off**, so the **Report a vulnerability** button is not shown yet. Until it is
> on, open an ordinary issue titled `security: please enable private vulnerability reporting`
> **with no details of the finding**; the maintainer enables the setting and follows up there.
> There is deliberately no e-mail channel: the repository is public and identifier-free by rule.

What helps in a report: the file, commit or workflow involved; the class of problem (credential
handling, prompt injection, supply chain, a security claim in the plan that does not hold); the
steps to reproduce; the impact you believe it has. Reports against the **plan's security claims**
are as welcome as reports against code. The plan states each "the model cannot…" together with the
session condition under which it is true; a claim that fails under its own stated condition is a
defect.

## What to expect

Intentions of a solo, part-time maintainer — not guarantees:

| Step | Intention |
|---|---|
| Acknowledgement | within **7 days** of the report |
| Triage and severity | within **14 days** — which class it falls into and whether it is in scope |
| Fix or mitigation | as fast as the severity warrants; credential exposure and anything on the (planned, off-by-default) write path first |
| Disclosure | coordinated through the advisory; reporters are credited unless they ask not to be |

## Scope

**In scope**

- The server, the `eff` CLI, the Skills bundle and the scripts in this repository, once they exist.
- The CI workflows, the secret-scanning rules and the dependency pins, once they exist — anything
  that gates what reaches `main` or a release.
- The security architecture **as documented** in
  [`docs/plan/02-security-architecture.md`](docs/plan/02-security-architecture.md): a claim that
  is false under the session condition it names is a valid report.
- Any real credential, cookie value, league id, member GUID, team or owner name, IP address or
  absolute local path found anywhere in this repository or its history. The repository must
  contain none — placeholders and anonymised fixtures only.

**Out of scope**

- ESPN's and Disney's own services, APIs, accounts and web properties. This project has no
  relationship with them and cannot fix them; report problems in their products to them.
- Third-party data providers (nflverse, ffopportunity, Sleeper, Open-Meteo, the US National
  Weather Service, The Odds API, RSS publishers) and their content.
- The prior-art repositories audited in
  [`docs/research/01-repo-security-audit.md`](docs/research/01-repo-security-audit.md). That audit
  records what was found in *their* code and histories without reproducing any secret value;
  contacting those owners is the maintainer's decision.
- Your own client configuration, your machine, and any other MCP server you configure beside this
  one (but see "Writes" below: what sits beside this server changes what the confirmation gate
  can promise).

## Credential-handling rules

ESPN offers no OAuth, no API key and no developer programme. Access to a private league is two
browser cookies: **`espn_s2`** and **`SWID`**. `espn_s2` is a **password-equivalent for the whole
ESPN/Disney account**, with an unknown lifetime and no revocation path that could be verified
([`docs/research/03-espn-api.md` §C](docs/research/03-espn-api.md#c-credentials-obtaining-storing-expiring-recovering)).
`SWID` is the account's member id — an identifier rather than a secret, but personal data. The
plan treats both accordingly:

- **Cookies are entered only in a terminal**, through `eff setup`, with hidden input for
  `espn_s2`. No tool accepts a cookie as an argument; there is no `authenticate` tool. **Never
  paste a cookie into a chat, an issue, a log, a screenshot or a file in this repository.**
- **Cookies are stored outside the repository**: by default in the operating system's keychain
  (macOS Keychain, through one exact-pinned, reviewed native package), or — as the fallback,
  selected once per install — in a `0600` file inside a `0700` directory under `~/.config/`.
  One store per install; the two-store state is a `doctor` failure. The file store refuses a
  directory managed by iCloud or another file provider, and refuses to read a file whose mode
  bits are too open.
- **Never in `.env`, never in the MCP client configuration, never in an environment variable.**
  `.env.example` documents non-secret settings only; no environment variable ever carries a
  cookie value.
- **Never sent anywhere but ESPN's fantasy API host.** A per-mode host allow-list refuses every
  other host, and redirects off the list are refused before they are followed, so a cookie cannot
  follow a redirect to another site.
- **Never logged and never returned.** The logger and every error constructor redact the
  `Cookie` header, the stored `espn_s2` value in both its pasted and its URL-decoded form, every
  brace-GUID (yours and every other league member's), IP addresses and the configured league id.
  Logs go to stderr only. No upstream response body is copied into a tool result.
- **A rejected cookie is never retried.** Any 401/403 on a cookie-bearing request puts the server
  in a `rejected` state that short-circuits further cookie-bearing calls and tells you the exact
  command to re-run setup; there is no retry loop that could make the account look like a bot.
- **Other members' personal data is minimised.** Member GUIDs are pseudonymised before they reach
  snapshots, the recommendation log, fixtures or logs; the client IP ESPN includes in one view is
  never stored; member-authored names are kept only inside `untrusted_text` wrappers.
- **Fixtures are anonymised** by a scrub step that aborts if a real league id, GUID, name or IP
  survives; recorded raw bodies are written outside the repository.
- **CI never holds ESPN credentials.** The repository is public; a cookie in a CI secret is a
  pattern the prior-art audit marks "do not use".

## If a cookie leaks — treat it as compromised

A leaked `espn_s2` cannot be "un-leaked" by deleting a message or rewriting git history. Assume it
works for whoever saw it until you have done all of the following:

1. **Change your ESPN/Disney account password** and use the account's **sign out everywhere**
   control. This is expected to invalidate outstanding sessions; whether it is sufficient is
   **unverified** (ESPN documents no revocation behaviour), which is exactly why prevention
   matters more than cleanup.
2. **Log out of ESPN in the browser** the cookie came from, log back in, and copy the new values.
3. **Re-run `eff setup`** (planned), which overwrites the stored values and re-checks them against
   your league; `eff setup --reset` or `eff uninstall` removes them from the keychain and the
   fallback file.
4. **Delete the copies you control** — the chat message, the screenshot, the pasted note, the
   backup of a file store.
5. If the leak is in **this repository** (or a fork), report it as described above **without
   repeating the value**. The commit still needs to be found and scrubbed, but only step 1
   protects the account.

## Writes and the confirmation gate

The planned server is **read-only by default**. The write module (lineup changes first; add/drop,
waiver claims and trades as separate later gates) is opt-in, off, and carries the plan's own
verdict **"recommended: do not build yet"**. If it is ever built, write tools are not even
registered unless, when the server starts, the operator has set `EFF_ENABLE_WRITES=true`, has typed
an acknowledgement sentence in a terminal, has a credential the local store records as validated,
and `eff setup` has recorded the operator's own team — all checked from persisted evidence, with no
network; the tool set changes only at a restart. Every roster change then goes through
`prepare → explicit human confirmation → commit`, pinned to the operator's own team.

The confirmation is one the model **cannot forge only in a session where the model has no shell or
filesystem reach as the user**. That is a property of the *session*, not of the client: Claude Code
with `Bash`, or a Claude Desktop chat with a filesystem or shell MCP server configured beside this
one, gives the model that reach. In such a session the confirmation channels are
defence-in-depth, not proof, and writes are **unsupported** — not "safe". A report showing the gate
can be bypassed *inside* a no-reach session is a high-severity finding.

## Supply chain

Exact version pins, a committed lockfile, `npm ci` only, `ignore-scripts=true`, an audit gate on
runtime dependencies (high and above), a runtime allow-list of six package names (five pure
JavaScript plus one prebuilt native keychain addon that passed a written review and is re-reviewed
on every version bump), and no third-party package spawned at run time — specified in
[`docs/plan/02-security-architecture.md` §7](docs/plan/02-security-architecture.md#7-supply-chain)
and [`docs/plan/04-repo-structure-and-ci.md` §2, §4](docs/plan/04-repo-structure-and-ci.md). A
report that a pinned dependency has a published advisory is in scope.

## Untrusted text

Team and owner names, ESPN player outlooks, news headlines and dataset text are **data, never
instructions**. The plan wraps every such field as `untrusted_text` (capped, stripped,
source-tagged). A way to make text from one of those fields act as an instruction to the server —
as opposed to persuading the model, which the server cannot fully prevent and says so — is in
scope.
