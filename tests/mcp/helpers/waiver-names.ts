// waiver-names.ts — changelog §R16, R16-6's rule over one espn_analyze_waivers answer (plan 07 E5):
// every id in claim_list, marginal or scramble_list is named, by its candidate row or — where the
// character budget cut that row — by one data.truncated_names entry, and truncated_names names
// nothing else (no unlisted id, no id that kept its row, no id twice, never an empty name).

/** The parts of an E5 answer the rule reads. */
export interface WaiverNames {
  readonly candidates: readonly { readonly player_id: number; readonly name: string }[];
  readonly claim_list: readonly number[];
  readonly marginal: readonly number[];
  readonly scramble_list: readonly number[];
  readonly truncated_names: readonly { readonly player_id: number; readonly name: string }[];
}

/** The ids the lists carry, each once, in list order (claim_list, marginal, scramble_list). */
export function listedIds(d: Omit<WaiverNames, "candidates" | "truncated_names">): number[] {
  return [...new Set([...d.claim_list, ...d.marginal, ...d.scramble_list])];
}

/** The listed ids whose candidate row the answer does not carry, in list order. */
export function rowlessListedIds(d: Omit<WaiverNames, "truncated_names">): number[] {
  const rows = new Set(d.candidates.map((c) => c.player_id));
  return listedIds(d).filter((id) => !rows.has(id));
}

/** The violations of R16-6's rule in one answer (empty = every listed player is named once). */
export function waiverNameProblems(d: WaiverNames): string[] {
  // the field is always present (R16-6): an answer without it fails here, not on a TypeError
  const field: unknown = d.truncated_names;
  if (!Array.isArray(field)) return ["data.truncated_names is missing"];
  const names = d.truncated_names;
  const rows = new Set(d.candidates.map((c) => c.player_id));
  const listed = new Set(listedIds(d));
  const seen = new Map<number, number>();
  for (const t of names) seen.set(t.player_id, (seen.get(t.player_id) ?? 0) + 1);
  const out: string[] = [];
  for (const id of listed)
    if (!rows.has(id) && !seen.has(id)) out.push(`${String(id)}: listed, with no row and no name`);
  for (const [id, n] of seen) {
    if (n > 1) out.push(`${String(id)}: named ${String(n)} times`);
    if (!listed.has(id)) out.push(`${String(id)}: named, but no list carries it`);
    if (rows.has(id)) out.push(`${String(id)}: named, but its row was kept`);
  }
  for (const t of names)
    if (typeof t.name !== "string" || t.name.length === 0)
      out.push(`${String(t.player_id)}: an entry without a name`);
  return out;
}
