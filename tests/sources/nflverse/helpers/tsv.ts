// tsv.ts — the text encoding of the committed nflverse excerpts (fixtures/nflverse/ATTRIBUTION.md):
// a header line of column names, then one row per line, every cell a JSON literal (`null`, a number,
// a JSON string — so null and "" stay distinct and a tab or newline inside a value is escaped by
// JSON.stringify). No dependency, no parquet: the scanner and reviewers read it as plain text.

/** A column the encoder needs (its name). */
export interface NamedColumn {
  readonly name: string;
}

/** One row's line (no newline). */
export function tsvRow(values: readonly unknown[]): string {
  return values.map((v) => JSON.stringify(v ?? null)).join("\t");
}

/** A whole part: the header line + one line per row, newline-terminated. */
export function encodeTsv(
  schema: readonly NamedColumn[],
  rows: readonly (readonly unknown[])[],
): string {
  const lines = [schema.map((c) => c.name).join("\t"), ...rows.map(tsvRow)];
  return `${lines.join("\n")}\n`;
}

/** Parses a part; the header must equal `schema`'s names and every row must have every cell. */
export function decodeTsv(schema: readonly NamedColumn[], text: string): unknown[][] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const header = lines.shift();
  const names = schema.map((c) => c.name);
  if (header !== names.join("\t")) throw new Error("tsv: header does not match the schema");
  return lines.map((line, i) => {
    const cells = line.split("\t");
    if (cells.length !== names.length) throw new Error(`tsv: row ${String(i)} is ragged`);
    return cells.map((c) => JSON.parse(c) as unknown);
  });
}
