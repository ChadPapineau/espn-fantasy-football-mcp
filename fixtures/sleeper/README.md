# fixtures/sleeper — Sleeper trending captures

Used by `tests/sources/sleeper/**` (plan 10 §3.2 "Sleeper trending (secondary)", B1; tables.ts
`DS_TRENDING`). Served to the source through an injected `HttpGet`; no test touches the network.

| File | Request | Fetched | Bytes | Entries |
|---|---|---|---|---|
| `trending-add.json` | `GET https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=50` | 2026-10-06 19:54 UTC | 1 793 | 50 (6 defences, by team code) |
| `trending-drop.json` | `GET https://api.sleeper.app/v1/players/nfl/trending/drop?lookback_hours=24&limit=50` | 2026-10-06 19:54 UTC | 1 808 | 50 (5 defences) |

Committed **byte for byte** as received: `[{ "count": <int>, "player_id": "<Sleeper id>" }, …]`,
count descending. A person's id is digits; a defence's is its team code (`"JAX"`, `"WAS"`). The
response carried `cache-control: public, s-maxage=600` (a 10-minute CDN cache, research 04 §D) and
answered `200` with no redirect. The file holds public, anonymous aggregate counts only — no user,
league or account data.

Licensing: Sleeper's API is "free to use for non-commercial purposes" (research 04 §E); the source
carries `license: "non-commercial"` and is a **secondary** signal — ESPN's own
`ownership.percentChange` is the primary market signal for an ESPN league (research 04 #13).
