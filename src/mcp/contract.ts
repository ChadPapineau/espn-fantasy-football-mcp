// contract.ts — the tool contract version the Skills are stamped with (plan 09 §4 K5;
// scripts/skills/manifest.json `tool_contract`). src/mcp/registry.ts repeats it as a literal
// (`export const TOOL_CONTRACT = 1`, which scripts/skills/_lib.mjs reads by regex) and a test holds
// the two equal; this copy exists so the tools can read it without importing the registry (a cycle).
export const TOOL_CONTRACT = 1;
