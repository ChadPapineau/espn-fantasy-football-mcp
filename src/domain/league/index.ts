// index.ts — the pure league model (plan 01 §9 roster slots and rules; plan 07 A1 `roster`, `rules`,
// `seeding`, B1 locks and IR): slots + eligibility, roster validity + IR, pro-schedule locks and
// byes, rules + the season calendar, the seeding reading. The contract types live in ./types.ts.
// Ported from sibling @56d9068 (src/domain/league/index.ts), adapted.
export * from "./slots.js";
export * from "./roster.js";
export * from "./schedule.js";
export * from "./rules.js";
export * from "./seeding.js";
