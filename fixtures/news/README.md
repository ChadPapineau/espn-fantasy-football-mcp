# fixtures/news — RSS captures and hostile-feed inputs for the news sources

Used by `tests/sources/news/**` and `tests/domain/evidence/**` (plan 10 B1, B8; plan 07 D6). No test
touches the network: the captures are served to the sources through an injected `HttpGet`.

## `captured/` — the three feeds, fetched once each on 2026-10-06 at 19:53 UTC

| File | Feed (tables.ts `NEWS_TABLES` upstream) | Bytes fetched | Items | Shape notes |
|---|---|---|---|---|
| `rotowire.xml` | `https://www.rotowire.com/rss/news.php?sport=NFL` | 3 149 | 5 | `pubDate` on a **12-hour clock** (`Tue, 06 Oct 2026 6:12:00 AM PDT`), which the contract's `rssDateMs` alone refuses — `src/sources/news/feeds.ts` `pubDateMs` rewrites it first; `guid` like `nfl641059`; links with a doubled `//` |
| `espn.xml` | `https://www.espn.com/espn/rss/nfl/news` | 15 035 | 25 | one line; every field in CDATA; `guid isPermaLink="false"`; `EST` used in October |
| `cbs.xml` | `https://www.cbssports.com/rss/headlines/nfl/` | 36 315 | 36 (35 committed) | every field padded with layout whitespace; `&#039;` entities; two sportsbook promotions (the promo filter) |

Each was a single keyless `GET` with an honest User-Agent; all answered `200` with no redirect.

**What was changed before committing** (deterministically, by a one-off script kept outside the
repository): titles, links, guids and pubDates are **verbatim**; every item `<description>` body is
replaced by the fixed placeholder *"Fixture placeholder: the feed's description text is not
committed."* (the feeds' own text is not redistributed — only headlines are kept); `<dc:creator>`
bylines and `<enclosure>` image URLs are removed; link query strings and fragments are stripped
(none were present); one CBS item about a person's illness was removed. The layout (CDATA,
whitespace, entity style) is kept, because that is what the parser must handle.

Licensing: the feeds are RotoWire's, ESPN's and CBS's (research 04 §E `api-terms`; ESPN's RSS is a
Disney product, 04 §B.10). Headlines are kept here only as test inputs for a personal, non-commercial
tool; nothing here is served to anyone.

## `captured/holdout-*.xml` — the later fetches (20:39–21:24 UTC the same day)

Only the items that were new since the first capture: 1 from RotoWire and 5 from CBS (ESPN's one
new item was removed for privacy — it named a person's health). Same treatment as above. They back
`labelled/holdout.json`.

## UUID-shaped values are public CBS article ids, not member GUIDs

CBS Sports' feed gives every item a `<guid isPermaLink="false">` that is a bare UUID (35 in
`captured/cbs.xml`, 5 in `captured/holdout-cbs.xml`). They are CBS's public identifiers of its
articles, kept verbatim like every guid here — not ESPN member GUIDs (an ESPN member id is always a
brace-wrapped SWID GUID: research 03 §B.3) and never anyone's fantasy-league identity. The same
values recur where those items are referred to: the `guid` of each CBS item in
`labelled/items.json` and `labelled/holdout.json`, and one assertion in
`tests/sources/news/xml.test.ts`. The ESPN rules of `scripts/dev/scan-secrets.mjs` and
`.gitleaks.toml` match the brace or `SWID` forms only, so they pass these by design; the
"every GUID in the fake range" check applies to ESPN fixtures (`fixtures/espn/`), not to these
captures. The same note stands for nflverse's player ids in `../nflverse/ATTRIBUTION.md` and
`../fx10h-usage/ATTRIBUTION.md`; `tests/sources/news/fixture-ids.test.ts` holds this one (every
UUID-shaped value under `fixtures/news/` is a CBS item's guid, none brace-wrapped, none in the
fixture pseudonym range `{00000000-0000-4000-8000-0000000000NN}`).

## `labelled/` — the plan 10 B8 hand-labelled set

See [`labelled/README.md`](labelled/README.md): the labelling rules, the measured precision, and
how the sets were produced.

## Hostile inputs

The hostile feeds (entity bombs, external entities, CDATA tricks, script tags, bidi and zero-width
text, huge items, invalid UTF-8, the research 05 §6 injection texts as headlines) are built inside
the tests (`tests/sources/news/helpers.ts` `rss()`), so each case sits next to its assertion.
