# Phase 3 — the fitted waiver DP and the exact seeding reproduction

Plan 10 §3.3: C4 (hard) and C5 (soft, with numbers).

## C4 — seeding reproduction

<!-- seeding:start -->
| league / season | teams | playoff field | divisions | rule (`By`) | regular games | records agree | (a) exact | (b) exact | deepest tiebreak used | findings |
|---|---:|---:|---:|---|---:|---|---|---|---|---|
| league-a/2023 | 10 | 4 | 1 | TOTAL_POINTS_SCORED (0) | 70 | yes | **yes** | no | points for | none |
| league-a/2024 | 10 | 4 | 1 | TOTAL_POINTS_SCORED (0) | 70 | yes | **yes** | no | points for | none |
| league-a/2025 | 12 | 4 | 1 | TOTAL_POINTS_SCORED (0) | 84 | yes | **yes** | no | points for | none |
| league-b/2023 | 10 | 4 | 1 | TOTAL_POINTS_SCORED (0) | 75 | yes | **yes** | no | points for | playoff_edited |
| league-b/2024 | 10 | 4 | 1 | TOTAL_POINTS_SCORED (0) | 75 | yes | **yes** | no | points for | none |
| league-b/2025 | 10 | 4 | 1 | TOTAL_POINTS_SCORED (0) | 75 | yes | **yes** | no | points for | playoff_edited |
| league-c/2023 | 12 | 8 | 4 | TOTAL_POINTS_SCORED (-1) | 84 | yes | **yes** | no | points for | none |
| league-c/2024 | 12 | 8 | 4 | TOTAL_POINTS_SCORED (-1) | 84 | yes | **yes** | no | win pct | none |
| league-c/2025 | 12 | 8 | 4 | TOTAL_POINTS_SCORED (-1) | 84 | yes | **yes** | no | points for | none |

Reading (a) reproduces **9 of 9** league-seasons exactly (every team's `playoffSeed`, not only the playoff field). Chains applied: `win pct → points for → head to head → division record → points against`; `division winners first → win pct → points for → head to head → division record → points against`. Reading (b) (points for alone) reproduces 0.
<!-- seeding:end -->

## C5 — the fitted waiver DP

<!-- premium:start -->
<!-- premium:end -->

<!-- waivers:start -->
<!-- waivers:end -->

<!-- clears:start -->
<!-- clears:end -->
