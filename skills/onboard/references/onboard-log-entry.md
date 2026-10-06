## The onboarding log entry

Onboarding calls no analytics tool, so there is no result `rec` to copy. Log this exact entry with `espn_record_recommendation` (step 8 of the procedure), replacing only the values in angle brackets:

- `week` — `clock.current_matchup_period` from `espn_get_league` (an integer, 0 in the preseason);
- `as_of` — `meta.as_of` of the `espn_get_league` result;
- `settings_hash` — `scoring.settings_hash` from `espn_get_league`;
- `source_calls` — one item per call made in steps 2–5, in order, each with that call's `meta.request_id`.

Every other field stays as written — the server rejects a `rec` with any field missing, and a number typed in here would be a number nobody computed.

```json
{
  "kind": "onboarding",
  "week": "<clock.current_matchup_period from espn_get_league>",
  "rec": {
    "action": "Onboarding: league format restated, scoring self-check shown for the last final week, seeding reading recorded or asked",
    "subjects": [],
    "lineup": null,
    "point_estimate": 0,
    "distribution": {
      "mean": 0,
      "p10": 0,
      "p25": 0,
      "p50": 0,
      "p75": 0,
      "p90": 0,
      "p_zero": 1,
      "basis": "position_cv"
    },
    "delta_vs_next": { "value": 0, "p10": 0, "p90": 0 },
    "decision_metric": "golden_mismatch_share",
    "drivers": [],
    "assumptions": [
      {
        "text": "The scoring self-check covers the sampled players of the checked weeks only",
        "revisit_trigger": "the league's settings_hash changes or a later week shows a mismatch"
      }
    ],
    "confidence": { "role_games": 0, "inputs": [] },
    "as_of": "<meta.as_of of the espn_get_league result>",
    "latest_execution_time": null,
    "no_move": true,
    "log_id": null
  },
  "alternatives": [],
  "source_calls": [
    { "tool": "espn_get_league", "request_id": "<meta.request_id>" },
    { "tool": "espn_get_roster", "request_id": "<meta.request_id>" },
    { "tool": "espn_get_box_score", "request_id": "<meta.request_id>" }
  ],
  "settings_hash": "<scoring.settings_hash from espn_get_league>",
  "followed_hint": "unknown",
  "client_ref": "onboard-setup"
}
```

When the procedure made more calls (the standings for the team question, a second box-score week, the seeding evidence, the session probe), add one `source_calls` item for each, with its own `meta.request_id`.
