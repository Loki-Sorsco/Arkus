// CREATE TABLE text generated client-side from the column / index metadata of a snapshot. Documentation,
// not a migration: types are printed as introspected and nothing here is ever executed.
import { quoteId, type DbTable } from "./db-shared";

export function buildDdl(table: DbTable, engine: string | null | undefined): string {
  const q = (n: string) => quoteId(engine, n);
  const pks = table.columns.filter((c) => c.pk);
  const lines = table.columns.map((c) => {
    const parts = [`  ${q(c.name)} ${c.type || "TEXT"}`];
    if (c.nullable === false) parts.push("NOT NULL");
    if (c.default != null && c.default !== "") parts.push(`DEFAULT ${c.default}`);
    if (c.pk && pks.length === 1) parts.push("PRIMARY KEY");
    if (c.unique && !c.pk) parts.push("UNIQUE");
    if (c.references) parts.push(`REFERENCES ${q(c.references.table)} (${q(c.references.column)})`);
    return parts.join(" ");
  });
  if (pks.length > 1) lines.push(`  PRIMARY KEY (${pks.map((c) => q(c.name)).join(", ")})`);
  const out = [`CREATE TABLE ${q(table.name)} (\n${lines.join(",\n")}\n);`];
  for (const ix of table.indexes) {
    if (!ix.columns.length) continue;
    const only = ix.columns.length === 1 ? table.columns.find((c) => c.name === ix.columns[0]) : undefined;
    if (only && (only.pk || (only.unique && ix.unique))) continue; // already declared inline
    const name = ix.name || `${table.name}_${ix.columns.join("_")}_${ix.unique ? "key" : "idx"}`;
    out.push(`CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${q(name)} ON ${q(table.name)} (${ix.columns.map(q).join(", ")});`);
  }
  return `-- ${table.name} as introspected${engine ? ` (${engine})` : ""}; generated for reading, not a migration\n${out.join("\n")}\n`;
}
